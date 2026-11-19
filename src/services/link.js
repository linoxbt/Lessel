"use strict";
// Per-installation links (audit C1). A web trigger address belongs to one installation, while Forge variables
// are app-wide: an address or secret kept in a variable would send every installation's traffic to one site.
// So each Jira installation of Lessel pairs with its own partners and keeps a separate secret for each, in its
// own database:
//   bitbucket   Lessel for Bitbucket in one workspace (events and merge checks in; Bitbucket REST out)
//   confluence  Lessel's Confluence installation on the same site (Confluence events in)
//   runner      the demo agents' runner (declared reads and ticket-fit only)
// A pairing code carries this installation's bridge address and the new secret. The partner stores both and
// answers with a signed "pair" message, which completes the link. Lessel's Confluence installation keeps its
// side of the link as target "home".

const crypto = require("crypto");
const repo = require("../db/repo");
const { sign } = require("../bridge-sign");
const { toDate } = require("../db/driver");

class LinkError extends Error {}

const TARGETS = ["bitbucket", "confluence", "runner"];
const PREFIX = "lessel1.";
// Forge web trigger addresses (the only partner addresses Lessel will call or hand out).
const TRIGGER_URL = /^https:\/\/[a-z0-9-]+\.hello\.atlassian-dev\.net\/[A-Za-z0-9/_.-]+$/;

let webTriggerUrl = key => require("@forge/api").webTrigger.getUrl(key);
let transport = (url, opts) => require("@forge/api").fetch(url, opts);
/** Tests only. */
function setLinkPorts(p = {}) {
  if (p.webTriggerUrl) webTriggerUrl = p.webTriggerUrl;
  if (p.transport) transport = p.transport;
}

const encode = obj => PREFIX + Buffer.from(JSON.stringify(obj)).toString("base64url");

/** { t: target, u: bridge address, s: secret } from a pairing code, or throws LinkError. */
function decodeCode(code) {
  const raw = String(code ?? "").trim();
  if (!raw.startsWith(PREFIX) || raw.length > 2000) throw new LinkError("That isn't a Lessel pairing code.");
  let obj;
  try { obj = JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64url").toString("utf8")); } catch { obj = null; }
  if (!obj || !TARGETS.includes(obj.t) || typeof obj.u !== "string" || !TRIGGER_URL.test(obj.u) ||
      typeof obj.s !== "string" || !/^[0-9a-f]{64}$/.test(obj.s)) {
    throw new LinkError("That pairing code is damaged. Create a new one in Lessel settings → Links.");
  }
  return obj;
}

/** Admin: a new pairing code for `target`. Replaces any earlier link to that target. */
async function createPairingCode(target, actor) {
  if (!TARGETS.includes(target)) throw new LinkError(`Unknown link ${String(target).slice(0, 20)}.`);
  const secret = crypto.randomBytes(32).toString("hex");
  const url = await webTriggerUrl("bitbucket-bridge");
  // The runner has nothing to call back: its link is live as soon as the code exists.
  await repo.putLink({ target, secret, state: target === "runner" ? "linked" : "pending",
    partner_name: target === "runner" ? "demo runner" : null });
  await repo.logStaffAction({ actor, action: "link-code", target: `link:${target}`, note: "new pairing code; any earlier link replaced" });
  return { code: encode({ t: target, u: url, s: secret }) };
}

async function unlink(target, actor) {
  if (!TARGETS.includes(target) && target !== "home") throw new LinkError(`Unknown link ${String(target).slice(0, 20)}.`);
  await repo.deleteLink(target);
  await repo.logStaffAction({ actor, action: "unlink", target: `link:${target}` });
  return { ok: true };
}

async function status() {
  const rows = await repo.listLinks();
  const one = t => {
    const r = rows.find(x => x.target === t);
    if (!r) return { linked: false };
    const at = toDate(r.linked_at);
    return { linked: r.state === "linked", pending: r.state === "pending",
      ...(r.partner_name ? { workspace: r.partner_name } : {}), ...(at ? { linkedAt: at.toISOString() } : {}) };
  };
  return { bitbucket: one("bitbucket"), confluence: one("confluence"), runner: one("runner") };
}

// ---------- the bridge's side (Jira installation) ----------

// Which link signs which message. Operator messages use LESSEL_OPERATOR_SECRET instead (see bridge.js).
const CHANNEL = {
  pair: { target: "bitbucket", states: ["pending", "linked"] },
  event: { target: "bitbucket", states: ["linked"] },
  "merge-check": { target: "bitbucket", states: ["linked"] },
  "confluence-pair": { target: "confluence", states: ["pending", "linked"] },
  "confluence-event": { target: "confluence", states: ["linked"] },
  "declare-context": { target: "runner", states: ["linked"] },
  "ticket-fit": { target: "runner", states: ["linked"] },
};

/** The secret that must have signed a message of this kind, or null. */
async function secretForKind(kind) {
  const ch = CHANNEL[kind];
  if (!ch) return null;
  const row = await repo.getLink(ch.target);
  return row && ch.states.includes(row.state) ? row.secret : null;
}

/** Lessel for Bitbucket answered a pairing code with its proxy address and workspace. */
async function completeBitbucket({ proxyUrl, workspace }) {
  if (typeof proxyUrl !== "string" || !TRIGGER_URL.test(proxyUrl)) throw new LinkError("bad proxy address");
  await repo.completeLink("bitbucket", { partner_url: proxyUrl, partner_name: String(workspace ?? "").slice(0, 128) || null });
  return { ok: true };
}
const completeConfluence = () => repo.completeLink("confluence", { partner_name: "Confluence" });

/** { url, secret } for Bitbucket REST through the paired Lessel for Bitbucket, or null. */
async function bitbucketLink() {
  const row = await repo.getLink("bitbucket");
  return row?.state === "linked" && row.partner_url ? { url: row.partner_url, secret: row.secret } : null;
}

// ---------- Lessel's Confluence installation ----------

/** Confluence settings page: store the code's address and secret, and prove them to the Jira installation. */
async function pairConfluence(code, actor) {
  const { t, u, s } = decodeCode(code);
  if (t !== "confluence") throw new LinkError("That code is for another link. In Jira, open Lessel settings → Links → Confluence.");
  const body = JSON.stringify({ kind: "confluence-pair", n: crypto.randomBytes(8).toString("hex") });
  let ok = false;
  try {
    const res = await transport(u, { method: "POST", headers: { "Content-Type": "application/json", "x-lessel-signature": sign(body, s) }, body });
    ok = res.ok;
  } catch (e) {
    console.warn("confluence pairing", e?.message);
  }
  if (!ok) throw new LinkError("Lessel in Jira didn't accept this code. It may have been replaced; create a new one and try again.");
  await repo.putLink({ target: "home", secret: s, state: "linked", partner_url: u, partner_name: "Jira" });
  await repo.logStaffAction({ actor, action: "pair", target: "link:home" });
  return { ok: true };
}

async function confluenceStatus() {
  const row = await repo.getLink("home");
  const at = toDate(row?.linked_at);
  return row?.state === "linked" ? { linked: true, ...(at ? { linkedAt: at.toISOString() } : {}) } : { linked: false };
}

/** { url, secret } of the Jira installation this Confluence installation forwards to, or null. */
async function homeLink() {
  const row = await repo.getLink("home");
  return row?.state === "linked" && row.partner_url ? { url: row.partner_url, secret: row.secret } : null;
}

module.exports = { LinkError, TARGETS, TRIGGER_URL, setLinkPorts, decodeCode, createPairingCode, unlink, status,
  secretForKind, completeBitbucket, completeConfluence, bitbucketLink, pairConfluence, confluenceStatus, homeLink };
