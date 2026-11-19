"use strict";
// Lessel's bitbucket-bridge web trigger. Every message is HMAC-signed (bridge-sign.js), and each kind of
// message must be signed by the one key allowed to send it (audit S3):
//   pair, event, merge-check            the paired Lessel for Bitbucket          (link "bitbucket")
//   confluence-pair, confluence-event   Lessel's Confluence installation         (link "confluence")
//   declare-context, ticket-fit         the demo agents' runner                  (link "runner")
//   setup, run-job, dismiss-taint,      the operator, with LESSEL_OPERATOR_SECRET, which no partner holds
//   link-create, pair-home
// Link secrets are per installation (src/services/link.js); none of them can change settings or links.
// Messages that change links or settings are accepted once per signature (replays are refused). The rest are
// safe to repeat: events are deduplicated, merge checks and ticket fit only read, and a repeated read report
// records the same read.

const { verify } = require("./bridge-sign");
const link = require("./services/link");

const header = (req, name) => {
  const v = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
const reply = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": ["application/json"] },
  body: JSON.stringify(obj) });

const OPERATOR_KINDS = new Set(["setup", "run-job", "dismiss-taint", "link-create", "pair-home"]);
const ONCE_KINDS = new Set([...OPERATOR_KINDS, "pair", "confluence-pair"]);

/** Only the fields Lessel reads, so a large push or deployment payload fits on the queue. */
function compactEvent(e = {}) {
  const pick = (o, keys) => (o ? Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])) : undefined);
  return {
    eventType: e.eventType, timestamp: e.timestamp,
    workspace: pick(e.workspace, ["uuid"]),
    repository: e.repository ? { uuid: e.repository.uuid, workspace: pick(e.repository.workspace, ["uuid"]) } : undefined,
    pullrequest: pick(e.pullrequest ?? e.pullRequest, ["id", "updated_on"]),
    push: e.push || e.changes ? { changes: (e.push?.changes ?? e.changes ?? []).slice(0, 50).map(c => ({
      new: c.new ? { type: c.new.type, name: c.new.name, target: { hash: c.new.target?.hash } } : null })) } : undefined,
    deployment: e.deployment ? {
      uuid: e.deployment.uuid,
      environment: pick(e.deployment.environment, ["uuid", "type", "environment_type"]),
      release: e.deployment.release ? { commit: pick(e.deployment.release.commit, ["hash"]) } : undefined,
      commit: pick(e.deployment.commit, ["hash"]),
      deployable: e.deployment.deployable ? { commit: pick(e.deployment.deployable.commit, ["hash"]) } : undefined,
      state: pick(e.deployment.state, ["name", "type", "completed_on"]),
      completed_on: e.deployment.completed_on,
    } : undefined,
  };
}

/** Serialise work per PR (or per repository for pushes and deployments). */
function concurrencyKey(e) {
  const repo = String(e.repository?.uuid ?? "").replace(/[^A-Za-z0-9]/g, "");
  const pr = e.pullrequest?.id;
  return (pr != null ? `bb-pr-${repo}-${pr}` : `bb-repo-${repo}`).slice(0, 100);
}

async function operator(msg) {
  const repo = require("./db/repo");
  if (msg.kind === "dismiss-taint") {
    if (!/^confluence:page:\d+$|^jira:issue:[A-Z][A-Z0-9]+-\d+$/.test(String(msg.sourceId))) return reply(400, { error: "bad sourceId" });
    // Clear a false positive (same effect and audit entry as an admin's Dismiss in Clean Room).
    await require("./services/cleanroom").dismissTaint(msg.sourceId, "lessel:operator");
    return reply(200, { dismissed: msg.sourceId });
  }
  if (msg.kind === "setup") {
    // Register agents and their accounts, and save settings (same validation as the admin page).
    for (const a of msg.agents ?? []) {
      if (!/^[a-z0-9_-]{1,64}$/.test(String(a.agent_id))) return reply(400, { error: "bad agent_id" });
      await repo.upsertAgent({ agent_id: a.agent_id, display_name: String(a.display_name ?? a.agent_id).slice(0, 128),
        kind: a.kind === "runner" ? "runner" : "connector" });
      for (const acc of a.accounts ?? []) {
        if (!["jira", "bitbucket", "mcp"].includes(acc.product)) return reply(400, { error: "bad product" });
        await repo.addAccount(acc.product, String(acc.accountId).slice(0, 128), a.agent_id);
      }
    }
    for (const [k, v] of Object.entries(msg.settings ?? {})) await repo.setSetting(k, v);
    await repo.logStaffAction({ actor: "lessel:operator", action: "setup", target: "settings",
      note: `agents: ${(msg.agents ?? []).map(a => a.agent_id).join(",") || "-"}; settings: ${Object.keys(msg.settings ?? {}).join(",") || "-"}` });
    return reply(200, { ok: true });
  }
  if (msg.kind === "run-job" && ["migrate", "hourly", "backfill"].includes(msg.type)) {
    const jobs = require("./jobs");
    await jobs.enqueue(msg.type === "hourly" ? { type: "hourly", fanOut: true } : { type: msg.type }, msg.type);
    return reply(202, { queued: msg.type });
  }
  if (msg.kind === "link-create") return reply(200, await link.createPairingCode(String(msg.target), "lessel:operator"));
  if (msg.kind === "pair-home") return reply(200, await link.pairConfluence(msg.code, "lessel:operator"));
  return reply(400, { error: "unknown kind" });
}

async function bitbucketBridge(req) {
  const body = typeof req?.body === "string" ? req.body : "";
  const sig = header(req, "x-lessel-signature");
  let msg;
  try { msg = JSON.parse(body); } catch { return reply(400, { error: "bad json" }); }
  const kind = String(msg?.kind ?? "");
  try {
    const secret = OPERATOR_KINDS.has(kind) ? process.env.LESSEL_OPERATOR_SECRET : await link.secretForKind(kind);
    if (!verify(body, sig, secret)) return reply(401, { error: "bad signature" });
    if (ONCE_KINDS.has(kind)) {
      const v1 = /v1=([0-9a-f]{64})/.exec(String(sig))?.[1];
      if (!(await require("./db/repo").claimOnce(`sig:${v1}`))) return reply(409, { error: "replayed request" });
    }

    if (OPERATOR_KINDS.has(kind)) return await operator(msg);
    if (kind === "merge-check") {
      const { mergeGate } = require("./enforce/gate");
      return reply(200, await mergeGate(msg.event ?? {}));
    }
    if (kind === "event" || kind === "confluence-event") {
      // Acknowledge at once and do the work on the queue: the sender gives up after a few seconds, and a slow
      // handler would otherwise lose or half-write the event (audit B13). The hourly catch-up re-reads PRs.
      const jobs = require("./jobs");
      if (kind === "event") {
        const event = compactEvent(msg.event);
        await jobs.enqueue({ type: "bitbucket-event", event }, concurrencyKey(event));
      } else {
        await jobs.enqueue({ type: "confluence-event", event: msg.event ?? {} }, `cf-${String(msg.event?.content?.id ?? msg.event?.page?.id ?? "x").replace(/\D/g, "").slice(0, 40)}`);
      }
      return reply(202, { queued: true });
    }
    if (kind === "pair") return reply(200, await link.completeBitbucket(msg));
    if (kind === "confluence-pair") { await link.completeConfluence(); return reply(200, { ok: true }); }
    if (kind === "declare-context" || kind === "ticket-fit") return await runnerRequest(msg);
    return reply(400, { error: "unknown kind" });
  } catch (e) {
    if (e instanceof link.LinkError || e?.name === "SettingError" || e instanceof require("./core/settings").SettingError) {
      return reply(400, { error: e.message });
    }
    console.error("bitbucketBridge", e);
    // A non-2xx makes the Bitbucket side retry events and fail the merge check closed.
    return reply(500, { error: "Lessel couldn't handle this request." });
  }
}

/**
 * The demo rig (Brook and Atlas on our runner) reports reads here. Third-party agents use the MCP tools, where
 * identity comes from the calling account; the runner's link can speak only for agents registered with the
 * "runner" kind on this site (spec exception, documented in v1.3).
 */
async function runnerRequest(msg) {
  const repo = require("./db/repo");
  const agent = await repo.getAgent(String(msg.agentId ?? ""));
  if (!agent || agent.kind !== "runner") return reply(404, { error: `unknown runner agent ${String(msg.agentId).slice(0, 40)}` });
  if (msg.kind === "ticket-fit") {
    const key = String(msg.issueKey ?? "");
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) return reply(400, { error: "bad issueKey" });
    return reply(200, { message: await require("./services/fit").ticketFit(agent, key) });
  }
  const { declareContext } = require("./services/cleanroom");
  const r = await declareContext(agent, { issueKey: msg.issueKey, sourceUrl: msg.sourceUrl,
    sourceVersion: msg.sourceVersion, readAt: msg.readAt });
  return reply(r.ok ? 200 : 409, { message: r.message });
}

module.exports = { bitbucketBridge, compactEvent };
