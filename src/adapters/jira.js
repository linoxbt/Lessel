"use strict";
// Jira Cloud REST v3 via @forge/api.

const { readJson } = require("./http");

function api() { return require("@forge/api"); }

async function asAppGet(r) {
  const res = await api().asApp().requestJira(r, { headers: { Accept: "application/json" } });
  return readJson(res, String(r));
}

async function getIssue(keyOrId, fields = ["summary", "description", "assignee", "status", "issuetype", "project",
  "priority", "components", "created"]) {
  const { route } = api();
  return asAppGet(route`/rest/api/3/issue/${keyOrId}?fields=${fields.join(",")}&expand=changelog`);
}

async function getStatus(id) {
  const { route } = api();
  return asAppGet(route`/rest/api/3/status/${id}`);
}

async function getIssueLink(linkId) {
  const { route } = api();
  return asAppGet(route`/rest/api/3/issueLink/${linkId}`);
}

/** Enhanced JQL search (POST /rest/api/3/search/jql). */
async function searchJql(jql, fields = ["summary", "assignee", "status", "issuetype", "project"], { max = 500 } = {}) {
  const { route } = api();
  const out = [];
  let nextPageToken;
  do {
    const res = await api().asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jql, fields, maxResults: 100, nextPageToken }),
    });
    const page = await readJson(res, "search/jql");
    out.push(...(page.issues || []));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken && out.length < max);
  return out;
}

async function addComment(keyOrId, text) {
  const { route } = api();
  const res = await api().asApp().requestJira(route`/rest/api/3/issue/${keyOrId}/comment`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } }),
  });
  return readJson(res, "comment");
}

/** Permission check as the calling user (UI resolvers). */
async function userHas(permission, { issueKey, projectKey } = {}) {
  const { route } = api();
  const r = issueKey
    ? route`/rest/api/3/mypermissions?permissions=${permission}&issueKey=${issueKey}`
    : projectKey ? route`/rest/api/3/mypermissions?permissions=${permission}&projectKey=${projectKey}`
      : route`/rest/api/3/mypermissions?permissions=${permission}`;
  const res = await api().asUser().requestJira(r, { headers: { Accept: "application/json" } });
  const body = await readJson(res, "mypermissions");
  return !!body?.permissions?.[permission]?.havePermission;
}

/** Plain text from an ADF document (descriptions, comments). */
function adfText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text || "";
  return (node.content || []).map(adfText).join(node.type === "paragraph" ? "\n" : "");
}

module.exports = { getIssue, getStatus, getIssueLink, searchJql, addComment, userHas, adfText };
