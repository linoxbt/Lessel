"use strict";
// This workspace's link to one Lessel site (audit C1). Kept in Forge storage, which belongs to this installation
// alone: a pairing code from Lessel settings → Links carries that site's bridge address and a secret made for
// this workspace. Nothing here is an app-wide variable, so another workspace can never reach this site.

const { sign } = require("./bridge-sign");

const KEY = "lessel-link";
const PREFIX = "lessel1.";
const TRIGGER_URL = /^https:\/\/[a-z0-9-]+\.hello\.atlassian-dev\.net\/[A-Za-z0-9/_.-]+$/;

class LinkError extends Error {}

/** Tests can replace storage, the transport and the proxy address lookup. */
const ports = {
  storage: () => require("@forge/kvs").kvs,
  transport: (url, opts) => require("@forge/api").fetch(url, opts),
  proxyUrl: () => require("@forge/api").webTrigger.getUrl("bitbucket-proxy"),
};
const setLinkPorts = p => Object.assign(ports, p);

async function getLink() {
  const v = await ports.storage().getSecret(KEY);
  return v && TRIGGER_URL.test(v.url ?? "") && /^[0-9a-f]{64}$/.test(v.secret ?? "") ? v : null;
}

function decodeCode(code) {
  const raw = String(code ?? "").trim();
  let obj = null;
  if (raw.startsWith(PREFIX) && raw.length <= 2000) {
    try { obj = JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64url").toString("utf8")); } catch { obj = null; }
  }
  if (!obj || obj.t !== "bitbucket" || !TRIGGER_URL.test(String(obj.u)) || !/^[0-9a-f]{64}$/.test(String(obj.s))) {
    throw new LinkError("That isn't a Bitbucket pairing code. In Jira, open Lessel settings → Links → Bitbucket and create one.");
  }
  return { url: obj.u, secret: obj.s };
}

/** Workspace UUID from the installation context ("ari:cloud:bitbucket::workspace/<uuid>"). */
const workspaceOf = context => String(context?.installContext ?? context?.workspaceId ?? "").match(/workspace\/\{?([0-9a-f-]{36})\}?/i)?.[1]?.toLowerCase() ?? null;

/** Store the code's link and tell that Lessel site where this workspace's proxy is. */
async function pair(code, context) {
  const link = decodeCode(code);
  const body = JSON.stringify({ kind: "pair", proxyUrl: await ports.proxyUrl(), workspace: workspaceOf(context),
    n: require("crypto").randomBytes(8).toString("hex") });
  let ok = false;
  try {
    const res = await ports.transport(link.url, { method: "POST",
      headers: { "Content-Type": "application/json", "x-lessel-signature": sign(body, link.secret) }, body });
    ok = res.ok;
  } catch (e) {
    console.warn("pairing", e?.message);
  }
  if (!ok) throw new LinkError("Lessel didn't accept this code. It may have been replaced; create a new one and try again.");
  await ports.storage().setSecret(KEY, { ...link, linkedAt: new Date().toISOString() });
  return { linked: true };
}

async function unlink() {
  await ports.storage().deleteSecret(KEY);
  return { linked: false };
}

async function status() {
  const l = await getLink();
  return l ? { linked: true, linkedAt: l.linkedAt ?? null, site: new URL(l.url).host.split(".")[0].slice(0, 8) + "…" } : { linked: false };
}

module.exports = { getLink, pair, unlink, status, decodeCode, workspaceOf, setLinkPorts, LinkError };
