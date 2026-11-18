"use strict";
// Lessel's end of the Bitbucket link: a web trigger, called with
//   { kind: "event", event }            Bitbucket product events, from Lessel for Bitbucket
//   { kind: "merge-check", event }      the Bitbucket merge check, from Lessel for Bitbucket
//   { kind: "confluence-event", event } Confluence events, from Lessel's own Confluence installation
//   { kind: "run-job", type }           operator hook: "migrate" or "hourly"
// Requests must be signed with LESSEL_BRIDGE_SECRET (see bridge-sign.js); anything else gets 401.

const { verify } = require("./bridge-sign");

const header = (req, name) => {
  const v = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
const reply = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": ["application/json"] },
  body: JSON.stringify(obj) });

async function bitbucketBridge(req) {
  const body = typeof req?.body === "string" ? req.body : "";
  if (!verify(body, header(req, "x-lessel-signature"), process.env.LESSEL_BRIDGE_SECRET)) {
    return reply(401, { error: "bad signature" });
  }
  let msg;
  try { msg = JSON.parse(body); } catch { return reply(400, { error: "bad json" }); }
  try {
    if (msg.kind === "merge-check") {
      const { mergeGate } = require("./enforce/gate");
      return reply(200, await mergeGate(msg.event ?? {}));
    }
    if (msg.kind === "event") {
      const { onBitbucketEvent } = require("./events/bitbucket");
      await onBitbucketEvent(msg.event ?? {});
      return reply(200, { ok: true });
    }
    if (msg.kind === "confluence-event") {
      const { onConfluenceEvent } = require("./events/confluence");
      await onConfluenceEvent(msg.event ?? {});
      return reply(200, { ok: true });
    }
    if (msg.kind === "run-job" && ["migrate", "hourly"].includes(msg.type)) {
      // Operator hook (same secret as merge verdicts): queue a migration or a sweep without waiting for a trigger.
      const jobs = require("./jobs");
      await jobs.enqueue(msg.type === "hourly" ? { type: "hourly", fanOut: true } : { type: "migrate" }, msg.type);
      return reply(202, { queued: msg.type });
    }
    return reply(400, { error: "unknown kind" });
  } catch (e) {
    console.error("bitbucketBridge", e);
    // A non-2xx makes the Bitbucket side retry events and fail the merge check closed.
    return reply(500, { error: "Lessel couldn't handle this request." });
  }
}

module.exports = { bitbucketBridge };
