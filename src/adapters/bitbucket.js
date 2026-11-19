"use strict";
// Bitbucket Cloud REST 2.0. Forge doesn't let one app hold both site scopes (Jira, Confluence) and workspace scopes
// (Bitbucket), so Lessel makes its Bitbucket calls in one of two ways:
//  - through Lessel for Bitbucket (default): a signed request to its bitbucket-proxy web trigger
//    (LESSEL_BB_PROXY_URL), which calls Bitbucket with that app's own access. No token needed;
//  - or directly with a scoped API token, if BITBUCKET_EMAIL and BITBUCKET_API_TOKEN are set.
// Bitbucket events and the merge check reach Lessel through the same app (see src/bridge.js).

const { readJson, paged } = require("./http");

const BASE = "https://api.bitbucket.org";

/** Bitbucket accepts {uuid} in place of slugs. Payload UUIDs may or may not carry braces. */
const braced = uuid => (String(uuid).startsWith("{") ? String(uuid) : `{${uuid}}`);

/** Path template that URL-encodes every interpolated value (braces become %7B…%7D, which Bitbucket accepts). */
const route = (strings, ...vals) => strings.reduce((s, str, i) => s + str + (i < vals.length ? encodeURIComponent(String(vals[i])) : ""), "");

const hasToken = () => !!(process.env.BITBUCKET_EMAIL && process.env.BITBUCKET_API_TOKEN);
function authHeader() {
  return `Basic ${Buffer.from(`${process.env.BITBUCKET_EMAIL}:${process.env.BITBUCKET_API_TOKEN}`).toString("base64")}`;
}

/** Tests can replace the transport. */
let transport = (url, opts) => require("@forge/api").fetch(url, opts);
const setTransport = fn => { transport = fn; };

/** Returns a fetch-like response for `path` (and an optional JSON body for POST). */
async function send(path, opts = {}) {
  if (hasToken()) {
    return transport(`${BASE}${path}`, { ...opts, headers: { Accept: "application/json", ...(opts.headers ?? {}), Authorization: authHeader() } });
  }
  const url = process.env.LESSEL_BB_PROXY_URL, secret = process.env.LESSEL_BRIDGE_SECRET;
  if (!url || !secret) throw new Error("Bitbucket isn't connected: set LESSEL_BB_PROXY_URL (Lessel for Bitbucket's bitbucket-proxy web trigger), or BITBUCKET_EMAIL and BITBUCKET_API_TOKEN.");
  const { sign } = require("../bridge-sign");
  const body = JSON.stringify({ method: opts.method ?? "GET", path, ...(opts.body ? { body: JSON.parse(opts.body) } : {}) });
  const res = await transport(url, { method: "POST", headers: { "Content-Type": "application/json", "x-lessel-signature": sign(body, secret) }, body });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, text: async () => text };
  const inner = JSON.parse(text);   // { status, body } from Bitbucket
  return { ok: inner.status >= 200 && inner.status < 300, status: inner.status, text: async () => inner.body ?? "" };
}
async function get(path) { return readJson(await send(path), path); }
async function getAbsolute(url) {
  const u = new URL(url);
  if (u.origin !== BASE) throw new Error(`Refusing to follow a pagination link to ${u.origin}`);
  return get(`${u.pathname}${u.search}`);
}

function repoPath(ws, repo) { return [braced(ws), braced(repo)]; }

async function getPr(ws, repo, id) {
  const [w, r] = repoPath(ws, repo);
  return get(route`/2.0/repositories/${w}/${r}/pullrequests/${id}`);
}

/** Changed paths and size for a PR. */
async function prDiffstat(ws, repo, id) {
  const [w, r] = repoPath(ws, repo);
  const values = await paged(() => get(route`/2.0/repositories/${w}/${r}/pullrequests/${id}/diffstat`), getAbsolute);
  const paths = values.map(v => v.new?.path || v.old?.path).filter(Boolean);
  const lines = values.reduce((n, v) => n + (v.lines_added || 0) + (v.lines_removed || 0), 0);
  return { paths, lines };
}

async function prCommits(ws, repo, id) {
  const [w, r] = repoPath(ws, repo);
  const values = await paged(() => get(route`/2.0/repositories/${w}/${r}/pullrequests/${id}/commits`), getAbsolute);
  return values.map(c => c.hash);
}

async function commitStatuses(ws, repo, sha) {
  const [w, r] = repoPath(ws, repo);
  return paged(() => get(route`/2.0/repositories/${w}/${r}/commit/${sha}/statuses`), getAbsolute);
}

async function getCommit(ws, repo, sha) {
  const [w, r] = repoPath(ws, repo);
  return get(route`/2.0/repositories/${w}/${r}/commit/${sha}`);
}

/** Commits reachable from `include` (e.g. the main branch), newest first. Used for push + backfill. */
async function commitsOn(ws, repo, branch, { max = 5 } = {}) {
  const [w, r] = repoPath(ws, repo);
  return paged(() => get(route`/2.0/repositories/${w}/${r}/commits/${branch}`), getAbsolute, { max });
}

/** Is `ancestor` contained in `head`? Uses the merge-base endpoint [verify]. */
async function isAncestor(ws, repo, ancestor, head) {
  if (!ancestor || !head) return false;
  if (head.startsWith(ancestor) || ancestor.startsWith(head)) return true;
  const [w, r] = repoPath(ws, repo);
  const res = await get(`${route`/2.0/repositories/${w}/${r}/merge-base/`}${encodeURIComponent(ancestor)}..${encodeURIComponent(head)}`);
  return !!res?.hash && (res.hash.startsWith(ancestor) || ancestor.startsWith(res.hash));
}

async function postPrComment(ws, repo, id, raw) {
  const [w, r] = repoPath(ws, repo);
  const res = await send(route`/2.0/repositories/${w}/${r}/pullrequests/${id}/comments`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: { raw } }),
  });
  return readJson(res, "pr comment");
}

async function listPrs(ws, repo, { state = "MERGED", max = 20 } = {}) {
  const [w, r] = repoPath(ws, repo);
  return paged(() => get(`${route`/2.0/repositories/${w}/${r}/pullrequests`}?state=${encodeURIComponent(state)}&pagelen=50`), getAbsolute, { max });
}

async function listDeployments(ws, repo, { max = 20 } = {}) {
  const [w, r] = repoPath(ws, repo);
  return paged(() => get(`${route`/2.0/repositories/${w}/${r}/deployments/`}?pagelen=100`), getAbsolute, { max });
}

async function getEnvironment(ws, repo, envUuid) {
  const [w, r] = repoPath(ws, repo);
  return get(route`/2.0/repositories/${w}/${r}/environments/${braced(envUuid)}`);
}

module.exports = { setTransport, route, braced, getPr, prDiffstat, prCommits, commitStatuses, getCommit, commitsOn, isAncestor,
  postPrComment, listPrs, listDeployments, getEnvironment };
