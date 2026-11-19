"use strict";
// Lessel's end of the Bitbucket link: a web trigger, called with
//   { kind: "event", event }            Bitbucket product events, from Lessel for Bitbucket
//   { kind: "merge-check", event }      the Bitbucket merge check, from Lessel for Bitbucket
//   { kind: "confluence-event", event } Confluence events, from Lessel's own Confluence installation
//   { kind: "declare-context" | "ticket-fit", agentId, … }  reads reported by our demo agents' runner
//   { kind: "setup", agents, settings } operator hook: register agents and accounts, save settings
//   { kind: "run-job", type }           operator hook: "migrate" or "hourly"
//   { kind: "dismiss-taint", sourceId } operator hook: clear a false positive, as an admin's Dismiss would
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
    if (msg.kind === "dismiss-taint" && /^confluence:page:\d+$|^jira:issue:[A-Z][A-Z0-9]+-\d+$/.test(String(msg.sourceId))) {
      // Operator hook: clear a false positive (same effect and audit entry as an admin's Dismiss in Clean Room).
      await require("./services/cleanroom").dismissTaint(msg.sourceId, "lessel:operator");
      return reply(200, { dismissed: msg.sourceId });
    }
    if (msg.kind === "declare-context" || msg.kind === "ticket-fit") {
      // The demo rig (Brook and Atlas on our A2A runner) reports reads here, signed with the shared secret.
      // Third-party agents use the MCP tools, where identity comes from the calling account.
      const repo = require("./db/repo");
      const agent = await repo.getAgent(String(msg.agentId ?? ""));
      if (!agent) return reply(404, { error: `unknown agent ${String(msg.agentId).slice(0, 40)}` });
      if (msg.kind === "ticket-fit") {
        const { shapeObj } = require("./services/shapes");
        const { decide } = require("./services/decide");
        const { sentence } = require("./core/policy");
        const item = await repo.getItem(String(msg.issueKey));
        if (!item) return reply(200, { message: `${msg.issueKey} isn't tracked by Lessel yet.` });
        const cfg = await repo.getSettings();
        const shape = shapeObj(item.shape_id, item.classified_by, cfg);
        return reply(200, { message: sentence(agent, shape, await decide({ agent, shape, issueKey: item.issue_key }, cfg)) });
      }
      const { declareContext } = require("./services/cleanroom");
      const r = await declareContext(agent, { issueKey: msg.issueKey, sourceUrl: msg.sourceUrl,
        sourceVersion: msg.sourceVersion, readAt: msg.readAt });
      return reply(r.ok ? 200 : 409, { message: r.message });
    }
    if (msg.kind === "setup") {
      // Operator hook: register agents and their accounts, and save settings (same checks as the admin page).
      const repo = require("./db/repo");
      for (const a of msg.agents ?? []) {
        await repo.upsertAgent({ agent_id: a.agent_id, display_name: a.display_name });
        for (const acc of a.accounts ?? []) await repo.addAccount(acc.product, acc.accountId, a.agent_id);
      }
      for (const [k, v] of Object.entries(msg.settings ?? {})) await repo.setSetting(k, v);
      await repo.logStaffAction({ actor: "lessel:operator", action: "setup", target: "settings",
        note: `agents: ${(msg.agents ?? []).map(a => a.agent_id).join(",") || "-"}; settings: ${Object.keys(msg.settings ?? {}).join(",") || "-"}` });
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
