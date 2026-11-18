// Lessel's MCP server (rovo:mcp, served at https://mcp.atlassian.com/forge/<lessel app id>), called as the
// agent's own Atlassian account so Lessel binds the declaration to the caller. OAuth tokens come from
// `npm run mcp-login -- <agent>` and refresh automatically.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** File-backed OAuth client provider (tokens, client registration, PKCE verifier). */
export class FileOAuthProvider {
  constructor(file, { redirectUrl = "http://localhost:33418/callback", onRedirect = null } = {}) {
    this.file = file;
    this._redirectUrl = redirectUrl;
    this.onRedirect = onRedirect;
  }
  load() { try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { return {}; } }
  save(patch) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ ...this.load(), ...patch }, null, 2), { mode: 0o600 });
  }
  get redirectUrl() { return this._redirectUrl; }
  get clientMetadata() {
    return { client_name: "Lessel demo runner", redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() { return this.load().client; }
  saveClientInformation(client) { this.save({ client }); }
  tokens() { return this.load().tokens; }
  saveTokens(tokens) { this.save({ tokens }); }
  saveCodeVerifier(codeVerifier) { this.save({ codeVerifier }); }
  codeVerifier() { return this.load().codeVerifier; }
  redirectToAuthorization(url) {
    if (this.onRedirect) return this.onRedirect(url);
    throw new Error(`Not logged in to Lessel's MCP server. Run: npm run mcp-login -- <agent>`);
  }
  invalidateCredentials(scope) {
    const s = this.load();
    if (scope === "all") { this.save({ client: undefined, tokens: undefined, codeVerifier: undefined }); return; }
    if (scope === "tokens") s.tokens = undefined;
    if (scope === "client") s.client = undefined;
    if (scope === "verifier") s.codeVerifier = undefined;
    this.save(s);
  }
}

export class Lessel {
  constructor({ url, tokenFile }) { this.url = url; this.tokenFile = tokenFile; this.client = null; this.tools = null; }

  async connect() {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), { authProvider: new FileOAuthProvider(this.tokenFile) });
    const client = new Client({ name: "lessel-demo-runner", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    this.tools = (await client.listTools()).tools.map(t => t.name);
    return client;
  }

  /** Forge MCP tool names may carry a prefix; match on the action key. */
  async toolName(key) {
    await this.connect();
    const name = this.tools.find(n => n === key || n.endsWith(key) || n.endsWith(key.replace(/-/g, "_")));
    if (!name) throw new Error(`Lessel MCP has no ${key} tool (has: ${this.tools.join(", ")})`);
    return name;
  }

  async call(key, args) {
    const client = await this.connect();
    const res = await client.callTool({ name: await this.toolName(key), arguments: args });
    const text = (res.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
    if (res.isError) throw new Error(text || `${key} failed`);
    return text;
  }

  declareContext({ issueKey, sourceUrl, sourceVersion, readAt }) {
    return this.call("declare-context", { issueKey, sourceUrl, sourceVersion, readAt });
  }
  checkTicketFit(issueKey) { return this.call("check-ticket-fit", { issueKey }); }
}
