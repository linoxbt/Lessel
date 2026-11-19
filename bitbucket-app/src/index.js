"use strict";
// Lessel for Bitbucket. Forge apps can't hold site scopes (Jira, Confluence) and workspace scopes (Bitbucket)
// together, so this workspace app is Lessel's Bitbucket half: it forwards Bitbucket product events to Lessel's
// web trigger and asks Lessel for the merge-check verdict. All decisions and data live in Lessel.
//
// Each workspace is paired with one Lessel site (Workspace settings → Lessel, with a code from Lessel settings
// → Links). The site's address and the secret live in this installation's storage (src/link.js), never in an
// app-wide variable. The only Forge variable is LESSEL_OPERATOR_SECRET, which lets the operator of the demo
// site pair its own workspace without the settings page.

const { sign, verify } = require("./bridge-sign");
const link = require("./link");

const TIMEOUT_MS = 8000;

/** Tests can replace the transport. */
let transport = (url, opts) => require("@forge/api").fetch(url, opts);
const setTransport = fn => { transport = fn; };

/** Signed POST to the paired Lessel site. Returns null when this workspace isn't paired. */
async function post(message) {
  const l = await link.getLink();
  if (!l) return null;
  const body = JSON.stringify(message);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await transport(l.url, { method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-lessel-signature": sign(body, l.secret) }, body });
    const text = await res.text();
    if (!res.ok) throw new Error(`Lessel answered ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/** Bitbucket product events: forward as-is. A throw lets Forge retry. Unpaired workspaces send nothing. */
async function onEvent(event) {
  const out = await post({ kind: "event", event });
  if (out === null) console.log("event not sent: this workspace isn't paired with a Lessel site");
}

/**
 * Merge check: Lessel decides. If Lessel can't be reached, fail closed. An unpaired workspace has no Lessel
 * policy at all, so the check passes and says so.
 */
async function mergeCheck(event) {
  try {
    const verdict = await post({ kind: "merge-check", event });
    if (verdict === null) return { success: true, message: "Lessel isn't paired with a Jira site for this workspace; no decision applied." };
    if (typeof verdict?.success !== "boolean") throw new Error("no verdict in Lessel's answer");
    return { success: verdict.success, message: String(verdict.message ?? "").slice(0, 1000) };
  } catch (e) {
    console.error("mergeCheck", e);
    // Details stay in the log; the PR shows a plain reason.
    return { success: false, message: "Lessel couldn't be reached. Try again in a minute." };
  }
}

// ---------- Bitbucket REST on Lessel's behalf ----------
// Lessel (the site app) has no Bitbucket permissions. It sends signed requests to this app's bitbucket-proxy web
// trigger, which makes the call with this app's own Bitbucket access. Only the reads Lessel needs and posting a
// PR comment are allowed.

const REPO = String.raw`/2\.0/repositories/[^/?#%\\]+/[^/?#%\\]+`;
const ENC = String.raw`(?:%7[Bb][A-Za-z0-9-]{1,64}%7[Dd])`;   // an encoded {uuid}
const SEG = String.raw`(?:${ENC}|[A-Za-z0-9_.-]+)`;
const ALLOWED = {
  GET: new RegExp(`^/2\\.0/repositories/${SEG}/${SEG}/(?:pullrequests(?:/\\d+(?:/(?:diffstat|commits))?)?|commits?/[A-Za-z0-9_./-]+` +
    `|merge-base/[0-9a-f]{7,40}\\.\\.[0-9a-f]{7,40}|deployments/?|environments/${SEG}|pipelines/)(?:\\?[A-Za-z0-9_=&.%-]*)?$`),
  POST: new RegExp(`^/2\\.0/repositories/${SEG}/${SEG}/pullrequests/\\d+/comments$`),
};

/** Path rules beyond the allowlist: no traversal, no encoded separators or dots (encoded braces only). */
function pathAllowed(method, path) {
  if (typeof path !== "string" || !ALLOWED[method].test(path)) return false;
  const withoutMergeBase = path.replace(/merge-base\/[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}/, "merge-base/x");
  if (withoutMergeBase.includes("..") || path.includes("\\")) return false;
  const encoded = path.match(/%[0-9a-fA-F]{2}/g) ?? [];
  return encoded.every(e => ["%7B", "%7D", "%7b", "%7d", "%3D", "%3d"].includes(e));
}

let bitbucketRequest = (path, opts) => {
  const api = require("@forge/api");
  return api.asApp().requestBitbucket(api.assumeTrustedRoute(path), opts);
};
const setBitbucketRequest = fn => { bitbucketRequest = fn; };

const header = (req, name) => { const v = req?.headers?.[name]; return Array.isArray(v) ? v[0] : v; };
const reply = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": ["application/json"] }, body: JSON.stringify(obj) });

async function bitbucketProxy(req, context) {
  const body = typeof req?.body === "string" ? req.body : "";
  let msg;
  try { msg = JSON.parse(body); } catch { return reply(400, { error: "bad json" }); }

  // Operator pairing (the demo site's own workspace): signed with LESSEL_OPERATOR_SECRET.
  if (msg?.kind === "operator-pair") {
    if (!verify(body, header(req, "x-lessel-signature"), process.env.LESSEL_OPERATOR_SECRET)) return reply(401, { error: "bad signature" });
    try { return reply(200, await link.pair(msg.code, context)); } catch (e) { return reply(400, { error: e.message }); }
  }

  const l = await link.getLink();
  if (!l || !verify(body, header(req, "x-lessel-signature"), l.secret)) return reply(401, { error: "bad signature" });
  const method = msg.method === "POST" ? "POST" : "GET";
  if (!pathAllowed(method, msg.path)) return reply(403, { error: `not allowed: ${method} ${String(msg.path).slice(0, 120)}` });
  const res = await bitbucketRequest(msg.path, { method, headers: { Accept: "application/json",
    ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, ...(method === "POST" ? { body: JSON.stringify(msg.body ?? {}) } : {}) });
  return reply(200, { status: res.status, body: await res.text() });
}

// ---------- settings page ----------
let resolverDef = null;
function settingsResolver(req, ctx) {
  if (!resolverDef) {
    const Resolver = require("@forge/resolver").default;
    const r = new Resolver();
    r.define("status", () => link.status());
    r.define("pair", async ({ payload, context }) => {
      try { await link.pair(payload?.code, context); } catch (e) { throw new Error(e.message); }
      return link.status();
    });
    r.define("unlink", async () => { await link.unlink(); return link.status(); });
    resolverDef = r.getDefinitions();
  }
  return resolverDef(req, ctx);
}

module.exports = { onEvent, mergeCheck, post, setTransport, bitbucketProxy, setBitbucketRequest, ALLOWED, pathAllowed, settingsResolver };
