"use strict";
// Signing for the link between Lessel (Jira/Confluence site) and Lessel for Bitbucket (workspace).
// Forge doesn't let one app hold both site and workspace scopes, so the Bitbucket app forwards events and
// merge-check requests to Lessel's web trigger. Each pair of partners shares a secret made at pairing (stored per
// installation); every request carries `x-lessel-signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`
// over `${t}.${body}`. Kept identical in bitbucket-app/src/bridge-sign.js (a test checks).

const crypto = require("crypto");

const MAX_SKEW_SECONDS = 300;

function sign(body, secret, now = Date.now()) {
  const t = Math.floor(now / 1000);
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/** True when `header` is a fresh, valid signature of `body`. */
function verify(body, header, secret, now = Date.now()) {
  if (!secret || secret.length < 32 || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map(p => p.split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > MAX_SKEW_SECONDS || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(parts.v1, "hex"));
}

module.exports = { sign, verify, MAX_SKEW_SECONDS };
