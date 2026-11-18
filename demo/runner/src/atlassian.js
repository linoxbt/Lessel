// REST calls the agents make as themselves: read Confluence, open Bitbucket PRs, comment on Jira.

async function json(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const basic = (user, token) => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

/** Confluence page id from a URL (/pages/<id>/... or ?pageId=<id>). */
export function pageIdFromUrl(url) {
  const s = String(url || "");
  return s.match(/\/pages\/(\d+)/)?.[1] ?? s.match(/[?&]pageId=(\d+)/)?.[1] ?? null;
}

/** Storage format to text. Hidden spans keep their text: that's what an agent reading the raw page sees. */
export function storageToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|h\d|li|tr|pre)>/gi, "\n")
    .replace(/<!--([\s\S]*?)-->/g, " $1 ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export class Confluence {
  constructor({ baseUrl, email, token, fetchFn = fetch }) { Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ""), email, token, fetchFn }); }
  async readPage(url) {
    const id = pageIdFromUrl(url);
    if (!id) throw new Error(`Not a Confluence page URL: ${url}`);
    const res = await this.fetchFn(`${this.baseUrl}/wiki/api/v2/pages/${id}?body-format=storage`, {
      headers: { authorization: basic(this.email, this.token), accept: "application/json" } });
    const page = await json(res, "Confluence page");
    return { id, title: page.title, version: page.version?.number ?? null, text: storageToText(page.body?.storage?.value) };
  }
}

export class Bitbucket {
  // API tokens: REST uses Basic <atlassian email>:<token>; git uses x-bitbucket-api-token-auth:<token> [verify].
  constructor({ workspace, slug, email, token, fetchFn = fetch, apiBase = "https://api.bitbucket.org/2.0" }) {
    Object.assign(this, { workspace, slug, email, token, fetchFn, apiBase });
  }
  cloneUrl() {
    return `https://x-bitbucket-api-token-auth:${encodeURIComponent(this.token)}@bitbucket.org/${this.workspace}/${this.slug}.git`;
  }
  async openPullRequest({ branch, destination, title, description }) {
    const res = await this.fetchFn(`${this.apiBase}/repositories/${this.workspace}/${this.slug}/pullrequests`, {
      method: "POST",
      headers: { authorization: basic(this.email, this.token), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title, description, close_source_branch: true,
        source: { branch: { name: branch } }, destination: { branch: { name: destination } } }),
    });
    const pr = await json(res, "Bitbucket PR");
    return { id: pr.id, url: pr.links?.html?.href ?? null };
  }
}

/** Comment on the work item with the app system token Jira forwarded (x-forge-oauth-system). */
export async function commentOnIssue({ jiraBase, systemToken, issueKey, text, fetchFn = fetch }) {
  if (!jiraBase || !systemToken) return false;
  const res = await fetchFn(`${jiraBase}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: "POST",
    headers: { authorization: `Bearer ${systemToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } }),
  });
  await json(res, "Jira comment");
  return true;
}
