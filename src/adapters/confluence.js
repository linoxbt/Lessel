"use strict";
// Confluence Cloud REST v2 via @forge/api.

const { readJson } = require("./http");

function api() { return require("@forge/api"); }

async function get(r) {
  const res = await api().asApp().requestConfluence(r, { headers: { Accept: "application/json" } });
  return readJson(res, String(r));
}

/** Page at a version (or current), with storage body. */
async function getPage(pageId, version = null) {
  const { route } = api();
  return version == null
    ? get(route`/wiki/api/v2/pages/${pageId}?body-format=storage`)
    : get(route`/wiki/api/v2/pages/${pageId}?body-format=storage&version=${version}`);
}

/** All versions, oldest first: [{ number, createdAt }]. */
async function listVersions(pageId) {
  const { route, routeFromAbsolute } = api();
  const out = [];
  let page = await get(route`/wiki/api/v2/pages/${pageId}/versions?limit=50`);
  for (let i = 0; page && i < 20; i++) {
    out.push(...(page.results || []).map(v => ({ number: v.number, createdAt: v.createdAt })));
    const next = page._links?.next;
    if (!next) break;
    page = await get(routeFromAbsolute(`/wiki${next.startsWith("/wiki") ? next.slice(5) : next}`));
  }
  return out.sort((a, b) => a.number - b.number);
}

/** Version current at time `at` (null if the page didn't exist yet or history is unavailable). [verify] */
async function versionAt(pageId, at) {
  const versions = await listVersions(pageId);
  const t = new Date(at).getTime();
  let best = null;
  for (const v of versions) if (new Date(v.createdAt).getTime() <= t) best = v.number;
  return best;
}

/** Publish a new version of a page with the given storage body (used by Clean Room restore). */
async function updatePage(pageId, { title, storage, nextVersion, message }) {
  const { route } = api();
  const res = await api().asApp().requestConfluence(route`/wiki/api/v2/pages/${pageId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ id: String(pageId), status: "current", title,
      body: { representation: "storage", value: storage }, version: { number: nextVersion, message } }),
  });
  return readJson(res, "update page");
}

/** Quarantine helpers [verify v1 label/restriction endpoints on a live site]. */
async function addLabel(pageId, name) {
  const { route } = api();
  const res = await api().asApp().requestConfluence(route`/wiki/rest/api/content/${pageId}/label`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify([{ prefix: "global", name }]),
  });
  return readJson(res, "add label");
}
async function removeLabel(pageId, name) {
  const { route } = api();
  const res = await api().asApp().requestConfluence(route`/wiki/rest/api/content/${pageId}/label/${name}`, { method: "DELETE" });
  if (res.status === 404) return null;
  return readJson(res, "remove label");
}
async function addFooterComment(pageId, storage) {
  const { route } = api();
  const res = await api().asApp().requestConfluence(route`/wiki/api/v2/footer-comments`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ pageId: String(pageId), body: { representation: "storage", value: storage } }),
  });
  return readJson(res, "footer comment");
}
/** The page's read and update restrictions: { read: { users, groups }, update: { users, groups } }. */
async function getRestrictions(pageId) {
  const { route } = api();
  const body = await get(route`/wiki/rest/api/content/${pageId}/restriction?expand=restrictions.user,restrictions.group`);
  const out = { read: { users: [], groups: [] }, update: { users: [], groups: [] } };
  for (const r of body?.results ?? []) {
    if (!out[r.operation]) continue;
    out[r.operation].users = (r.restrictions?.user?.results ?? []).map(u => u.accountId).filter(Boolean);
    out[r.operation].groups = (r.restrictions?.group?.results ?? []).map(g => g.name).filter(Boolean);
  }
  return out;
}
/** Replace the page's read and update restrictions with exactly these (empty lists mean unrestricted). */
async function setRestrictions(pageId, { read = { users: [], groups: [] }, update = { users: [], groups: [] } }) {
  const { route } = api();
  const op = (operation, r) => ({ operation, restrictions: {
    user: (r?.users ?? []).map(accountId => ({ type: "known", accountId })),
    group: (r?.groups ?? []).map(name => ({ type: "group", name })) } });
  const res = await api().asApp().requestConfluence(route`/wiki/rest/api/content/${pageId}/restriction`, {
    method: "PUT", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify([op("read", read), op("update", update)]),
  });
  return readJson(res, "set restrictions");
}
/** Can this account do `operation` ("read" | "update") on the page? */
async function canUser(pageId, accountId, operation = "read") {
  const { route } = api();
  const res = await api().asApp().requestConfluence(route`/wiki/rest/api/content/${pageId}/permission/check`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ subject: { type: "user", identifier: accountId }, operation }),
  });
  if (res.status === 404) return false;
  return !!(await readJson(res, "permission check"))?.hasPermission;
}

async function getSpace(spaceId) {
  const { route } = api();
  return get(route`/wiki/api/v2/spaces/${spaceId}`);
}

/** Page id from a Confluence URL: /wiki/spaces/ENG/pages/123456/Title or ?pageId=123456. */
function pageIdFromUrl(url) {
  const s = String(url || "");
  return s.match(/\/pages\/(\d+)/)?.[1] ?? s.match(/[?&]pageId=(\d+)/)?.[1] ?? tinyLinkPageId(s);
}

/** Confluence short links (/wiki/x/<code>) are the page id as little-endian bytes in URL-safe base64. */
function tinyLinkPageId(s) {
  const code = s.match(/\/x\/([A-Za-z0-9_-]+)/)?.[1];
  if (!code) return null;
  const bytes = Buffer.from(code.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!bytes.length || bytes.length > 7) return null;
  let id = 0;
  for (let i = bytes.length - 1; i >= 0; i--) id = id * 256 + bytes[i];
  return id > 0 ? String(id) : null;
}

module.exports = { getPage, updatePage, listVersions, versionAt, getSpace, pageIdFromUrl,
  addLabel, removeLabel, addFooterComment, getRestrictions, setRestrictions, canUser };
