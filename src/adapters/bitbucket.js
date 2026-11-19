"use strict";
// Bitbucket Cloud REST 2.0. Forge doesn't let one app hold both site scopes (Jira, Confluence) and workspace scopes
// (Bitbucket), so Lessel makes its Bitbucket calls through Lessel for Bitbucket: a signed request to that app's
// bitbucket-proxy web trigger, which calls Bitbucket with its own access. The proxy's address and the secret
// come from this installation's link (src/services/link.js), made by pairing in Lessel settings, so one
// site can only ever reach the workspace it was paired with. Events and the merge check come the other way
// (src/bridge.js).

const { readJson, paged } = require("./http");

const BASE = "https://api.bitbucket.org";

/** Bitbucket accepts {uuid} in place of slugs. Payload UUIDs may or may not carry braces. */
const braced = uuid => (String(uuid).startsWith("{") ? String(uuid) : `{${uuid}}`);

/** Path template that URL-encodes every interpolated value (braces become %7B…%7D, which Bitbucket accepts). */
const route = (strings, ...vals) => strings.reduce((s, str, i) => s + str + (i < vals.length ? encodeURIComponent(String(vals[i])) : ""), "");

/** Tests can replace the transport. */
let transport = (url, opts) => require("@forge/api").fetch(url, opts);
const setTransport = fn => { transport = fn; };

/** Returns a fetch-like response for `path` (and an optional JSON body for POST). */
/** Tests can replace how the link is looked up. */
let linkFor = () => require("../services/link").bitbucketLink();
const setLinkLookup = fn => { linkFor = fn; };

async function send(path, opts = {}) {
  const link = await linkFor();
  if (!link) throw new Error("Bitbucket isn't linked to this site yet: pair it in Lessel settings → Links.");
  const { url, secret } = link;
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
  if (!/^[0-9a-f]{7,40}$/i.test(ancestor) || !/^[0-9a-f]{7,40}$/i.test(head)) throw new Error("merge-base needs commit hashes");
  const [w, r] = repoPath(ws, repo);
  // Bitbucket's revspec is "<a>..<b>"; the proxy allows ".." only in exactly this form.
  const res = await get(`${route`/2.0/repositories/${w}/${r}/merge-base/`}${ancestor.toLowerCase()}..${head.toLowerCase()}`);
  return !!res?.hash && (res.hash.startsWith(ancestor) || ancestor.startsWith(res.hash));
}

/** Pipelines runs for a commit, newest first (the latest 50 runs of the repository are searched). */
async function pipelinesForCommit(ws, repo, sha) {
  const [w, r] = repoPath(ws, repo);
  const page = await get(`${route`/2.0/repositories/${w}/${r}/pipelines/`}?sort=-created_on&pagelen=50`);
  const s = String(sha).toLowerCase();
  return (page?.values ?? []).filter(p => {
    const h = String(p.target?.commit?.hash ?? "").toLowerCase();
    return h && (h.startsWith(s) || s.startsWith(h));
  });
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

module.exports = { setTransport, setLinkLookup, pipelinesForCommit, route, braced, getPr, prDiffstat, prCommits, commitStatuses, getCommit, commitsOn, isAncestor,
  postPrComment, listPrs, listDeployments, getEnvironment };
