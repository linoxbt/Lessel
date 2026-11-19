"use strict";
// Posts a signed message to Lessel's bitbucket-bridge web trigger. Used by Lessel's Confluence installation to
// hand Confluence events to the Jira installation: Forge SQL is one database per installation, and Lessel's
// data lives in the Jira one. The address and secret come from this installation's own pairing (link "home",
// made on the Confluence settings page), never from an app-wide variable.

const { sign } = require("./bridge-sign");

let transport = (url, opts) => require("@forge/api").fetch(url, opts);
const setTransport = fn => { transport = fn; };

/** Returns the parsed answer, or null when this Confluence installation isn't paired with a Jira one yet. */
async function postToBridge(message) {
  const home = await require("./services/link").homeLink();
  if (!home) { console.warn("Confluence event dropped: this installation isn't paired with Lessel in Jira yet."); return null; }
  const body = JSON.stringify(message);
  const res = await transport(home.url, { method: "POST",
    headers: { "Content-Type": "application/json", "x-lessel-signature": sign(body, home.secret) }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Lessel bridge answered ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** True when this invocation runs in the Confluence installation (not the Jira one, which holds the data). */
const inConfluenceInstall = context => /:confluence::/.test(String(context?.installContext ?? ""));

module.exports = { postToBridge, setTransport, inConfluenceInstall };
