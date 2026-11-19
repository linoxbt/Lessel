"use strict";
// Lessel for Bitbucket. Forge apps can't hold site scopes (Jira, Confluence) and workspace scopes (Bitbucket)
// together, so this workspace app is Lessel's Bitbucket half: it forwards Bitbucket product events to Lessel's
// web trigger and asks Lessel for the merge-check verdict. All decisions and data live in Lessel.
//
// Forge variables (set with `forge variables set --encrypt`):
//   LESSEL_BRIDGE_URL     Lessel's bitbucket-bridge web trigger URL (`forge webtrigger` in the Lessel app)
//   LESSEL_BRIDGE_SECRET  shared secret, the same value as in Lessel (at least 32 characters)

const { sign } = require("./bridge-sign");

const TIMEOUT_MS = 8000;

/** Tests can replace the transport. */
let transport = (url, opts) => require("@forge/api").fetch(url, opts);
const setTransport = fn => { transport = fn; };

async function post(message) {
  const url = process.env.LESSEL_BRIDGE_URL, secret = process.env.LESSEL_BRIDGE_SECRET;
  if (!url || !secret) throw new Error("Lessel for Bitbucket isn't connected: set LESSEL_BRIDGE_URL and LESSEL_BRIDGE_SECRET.");
  const body = JSON.stringify(message);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await transport(url, { method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-lessel-signature": sign(body, secret) }, body });
    const text = await res.text();
    if (!res.ok) throw new Error(`Lessel answered ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Bitbucket product events: forward as-is. A throw lets Forge retry. */
async function onEvent(event) {
  await post({ kind: "event", event });
}

/** Merge check: Lessel decides. If Lessel can't be reached, fail closed and say why. */
async function mergeCheck(event) {
  try {
    const verdict = await post({ kind: "merge-check", event });
    if (typeof verdict?.success !== "boolean") throw new Error("no verdict in Lessel's answer");
    return { success: verdict.success, message: String(verdict.message ?? "").slice(0, 1000) };
  } catch (e) {
    console.error("mergeCheck", e);
    return { success: false, message: `Lessel couldn't be reached (${e.message}). Try again in a minute.` };
  }
}

// ---------- Bitbucket REST on Lessel's behalf ----------
// Lessel (the site app) has no Bitbucket permissions. It sends signed requests to this app's bitbucket-proxy web
// trigger, which makes the call with this app's own Bitbucket access. Only the reads Lessel needs and posting a
// PR comment are allowed.
const { verify } = require("./bridge-sign");

const REPO = String.raw`/2\.0/repositories/[^/?#]+/[^/?#]+`;
const ALLOWED = {
  GET: new RegExp(`^${REPO}/(?:pullrequests(?:/\\d+(?:/(?:diffstat|commits))?)?|commits?/[^?#]+|merge-base/[^?#]+|deployments/?|environments/[^/?#]+)(?:\\?[^#]*)?$`),
  POST: new RegExp(`^${REPO}/pullrequests/\\d+/comments$`),
};

let bitbucketRequest = (path, opts) => {
  const api = require("@forge/api");
  return api.asApp().requestBitbucket(api.assumeTrustedRoute(path), opts);
};
const setBitbucketRequest = fn => { bitbucketRequest = fn; };

const header = (req, name) => { const v = req?.headers?.[name]; return Array.isArray(v) ? v[0] : v; };
const reply = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": ["application/json"] }, body: JSON.stringify(obj) });

async function bitbucketProxy(req) {
  const body = typeof req?.body === "string" ? req.body : "";
  if (!verify(body, header(req, "x-lessel-signature"), process.env.LESSEL_BRIDGE_SECRET)) return reply(401, { error: "bad signature" });
  let msg;
  try { msg = JSON.parse(body); } catch { return reply(400, { error: "bad json" }); }
  const method = msg.method === "POST" ? "POST" : "GET";
  if (typeof msg.path !== "string" || !ALLOWED[method].test(msg.path) || msg.path.includes("..")) {
    return reply(403, { error: `not allowed: ${method} ${String(msg.path).slice(0, 120)}` });
  }
  const res = await bitbucketRequest(msg.path, { method, headers: { Accept: "application/json",
    ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, ...(method === "POST" ? { body: JSON.stringify(msg.body ?? {}) } : {}) });
  return reply(200, { status: res.status, body: await res.text() });
}

module.exports = { onEvent, mergeCheck, post, setTransport, bitbucketProxy, setBitbucketRequest, ALLOWED };
