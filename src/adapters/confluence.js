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

async function getSpace(spaceId) {
  const { route } = api();
  return get(route`/wiki/api/v2/spaces/${spaceId}`);
}

/** Page id from a Confluence URL: /wiki/spaces/ENG/pages/123456/Title or ?pageId=123456. */
function pageIdFromUrl(url) {
  const s = String(url || "");
  return s.match(/\/pages\/(\d+)/)?.[1] ?? s.match(/[?&]pageId=(\d+)/)?.[1] ?? null;
}

module.exports = { getPage, updatePage, listVersions, versionAt, getSpace, pageIdFromUrl };
