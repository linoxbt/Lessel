"use strict";
// Posts a signed message to Lessel's bitbucket-bridge web trigger. Used by Lessel's Confluence installation to
// hand Confluence events to the Jira installation: Forge SQL is one database per installation, and Lessel's
// data lives in the Jira one.

const { sign } = require("./bridge-sign");

let transport = (url, opts) => require("@forge/api").fetch(url, opts);
const setTransport = fn => { transport = fn; };

async function postToBridge(message) {
  const url = process.env.LESSEL_BRIDGE_URL, secret = process.env.LESSEL_BRIDGE_SECRET;
  if (!url || !secret) throw new Error("LESSEL_BRIDGE_URL and LESSEL_BRIDGE_SECRET must be set.");
  const body = JSON.stringify(message);
  const res = await transport(url, { method: "POST",
    headers: { "Content-Type": "application/json", "x-lessel-signature": sign(body, secret) }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Lessel bridge answered ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** True when this invocation runs in the Confluence installation (not the Jira one, which holds the data). */
const inConfluenceInstall = context => /:confluence::/.test(String(context?.installContext ?? ""));

module.exports = { postToBridge, setTransport, inConfluenceInstall };
