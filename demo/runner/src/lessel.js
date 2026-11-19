// Lessel's MCP server (rovo:mcp, served at https://mcp.atlassian.com/forge/<lessel app id>), called as the
// agent's own Atlassian account so Lessel binds the declaration to the caller. OAuth tokens come from
// `npm run mcp-login -- <agent>` and refresh automatically.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac } from "node:crypto";
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
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ ...this.load(), ...patch }, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);   // also tightens files copied in with looser modes
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
}

/**
 * The same call through Lessel's signed web trigger (LESSEL_BRIDGE_URL + LESSEL_RUNNER_SECRET), for the demo
 * rig: no per-agent MCP sign-in. The runner names the agent; Lessel trusts it because only holders of the runner
 * secret can call. That secret is not Lessel's master bridge secret: Lessel accepts it only for the runner's
 * message kinds (declare-context, ticket-fit). Third-party agents use the MCP server, where identity comes from
 * the caller.
 *
 * Signature: header x-lessel-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">.
 */
export class LesselBridge {
  constructor({ url, secret, agentId, fetchFn = fetch }) { Object.assign(this, { url, secret, agentId, fetchFn }); }

  sign(body) {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac("sha256", this.secret).update(`${t}.${body}`).digest("hex")}`;
  }

  async send(kind, args) {
    const body = JSON.stringify({ kind, agentId: this.agentId, ...args });
    const res = await this.fetchFn(this.url, { method: "POST", body,
      headers: { "content-type": "application/json", "x-lessel-signature": this.sign(body) } });
    const text = await res.text();
    let msg = null;
    try { msg = JSON.parse(text).message ?? JSON.parse(text).error; } catch { /* not JSON */ }
    if (!res.ok) throw new Error(msg || `Lessel answered ${res.status}`);
    return msg ?? "";
  }

  declareContext({ issueKey, sourceUrl, sourceVersion, readAt }) { return this.send("declare-context", { issueKey, sourceUrl, sourceVersion, readAt }); }
}

