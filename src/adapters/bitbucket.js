"use strict";
// Bitbucket Cloud REST 2.0 via @forge/api asApp(). Workspace and repo are UUIDs; route`` encodes the braces.

const { readJson, paged } = require("./http");

function api() { return require("@forge/api"); }

/** Bitbucket accepts {uuid} in place of slugs. Payload UUIDs may or may not carry braces [verify]. */
const braced = uuid => (String(uuid).startsWith("{") ? String(uuid) : `{${uuid}}`);

async function get(r) {
  const res = await api().asApp().requestBitbucket(r);
  return readJson(res, String(r));
}
async function getAbsolute(url) {
  const { routeFromAbsolute } = api();
  return get(routeFromAbsolute(url));
}

function repoPath(ws, repo) { return [braced(ws), braced(repo)]; }

async function getPr(ws, repo, id) {
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  return get(route`/2.0/repositories/${w}/${r}/pullrequests/${id}`);
}

/** Changed paths and size for a PR. */
async function prDiffstat(ws, repo, id) {
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  const values = await paged(() => get(route`/2.0/repositories/${w}/${r}/pullrequests/${id}/diffstat`), getAbsolute);
  const paths = values.map(v => v.new?.path || v.old?.path).filter(Boolean);
  const lines = values.reduce((n, v) => n + (v.lines_added || 0) + (v.lines_removed || 0), 0);
  return { paths, lines };
}

async function prCommits(ws, repo, id) {
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  const values = await paged(() => get(route`/2.0/repositories/${w}/${r}/pullrequests/${id}/commits`), getAbsolute);
  return values.map(c => c.hash);
}

async function commitStatuses(ws, repo, sha) {
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  return paged(() => get(route`/2.0/repositories/${w}/${r}/commit/${sha}/statuses`), getAbsolute);
}

async function getCommit(ws, repo, sha) {
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  return get(route`/2.0/repositories/${w}/${r}/commit/${sha}`);
}

/** Commits reachable from `include` (e.g. the main branch), newest first. Used for push + backfill. */
async function commitsOn(ws, repo, branch, { max = 5 } = {}) {
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  return paged(() => get(route`/2.0/repositories/${w}/${r}/commits/${branch}`), getAbsolute, { max });
}

/** Is `ancestor` contained in `head`? Uses the merge-base endpoint [verify]. */
async function isAncestor(ws, repo, ancestor, head) {
  if (!ancestor || !head) return false;
  if (head.startsWith(ancestor) || ancestor.startsWith(head)) return true;
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  const res = await get(route`/2.0/repositories/${w}/${r}/merge-base/${`${ancestor}..${head}`}`);
  return !!res?.hash && (res.hash.startsWith(ancestor) || ancestor.startsWith(res.hash));
}

async function postPrComment(ws, repo, id, raw) {
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  const res = await api().asApp().requestBitbucket(route`/2.0/repositories/${w}/${r}/pullrequests/${id}/comments`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ content: { raw } }),
  });
  return readJson(res, "pr comment");
}

async function listPrs(ws, repo, { state = "MERGED", max = 20 } = {}) {
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  return paged(() => get(route`/2.0/repositories/${w}/${r}/pullrequests?state=${state}&pagelen=50`), getAbsolute, { max });
}

async function listDeployments(ws, repo, { max = 20 } = {}) {
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  return paged(() => get(route`/2.0/repositories/${w}/${r}/deployments/?pagelen=100`), getAbsolute, { max });
}

async function getEnvironment(ws, repo, envUuid) {
  const { route } = api(); const [w, r] = repoPath(ws, repo);
  return get(route`/2.0/repositories/${w}/${r}/environments/${braced(envUuid)}`);
}

module.exports = { braced, getPr, prDiffstat, prCommits, commitStatuses, getCommit, commitsOn, isAncestor,
  postPrComment, listPrs, listDeployments, getEnvironment };
