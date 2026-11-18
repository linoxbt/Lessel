"use strict";
// PR notices (spec §14.2). Always uses decide(); never its own rule.

const repo = require("../db/repo");
const { ports } = require("../ports");
const { decide } = require("./decide");
const { shapeObj } = require("./shapes");
const { sentence, needWords } = require("../core/policy");

async function commentOnPr(prRow, agent, cause, cfg) {
  try {
    const pr = await ports.bitbucket.getPr(prRow.workspace_uuid, prRow.repo_uuid, prRow.pr_id);
    if (pr?.state && pr.state !== "OPEN") return false;
    const item = await repo.getItem(prRow.issue_key);
    const shape = shapeObj(prRow.shape_id ?? item.shape_id, prRow.classified_by ?? item.classified_by, cfg);
    const d = await decide({ agent, shape, issueKey: prRow.issue_key, pr }, cfg);
    const mode = cfg.enforcementMode === "enforcing" ? "" : " (Advisory mode: nothing is blocked yet.)";
    await ports.bitbucket.postPrComment(prRow.workspace_uuid, prRow.repo_uuid, prRow.pr_id,
      `**Lessel:** after ${cause.text}, ${sentence(agent, shape, d)} This PR ${needWords(d)}.${mode}`);
    return true;
  } catch (e) {
    console.warn(`PR comment failed for ${prRow.repo_uuid}#${prRow.pr_id}`, e?.message);
    return false;
  }
}

/** A shape-level decision changed for (agent, shape). Deduped by cause id + revision + new state. */
async function notifyDecisionChange(agent, shapeId, before, after, cause, cfg) {
  const eventId = `${agent.agent_id}:${shapeId}:${cause.id}:r${cause.rev ?? 0}:L${after.effective}:` +
    `${after.blocked ? "blocked" : "open"}`;
  const fresh = await repo.insertDecisionEvent({ event_id: eventId.slice(0, 255), agent_id: agent.agent_id,
    shape_id: shapeId, before, after, cause: cause.text });
  if (!fresh) return 0;
  let n = 0;
  for (const prRow of await repo.openPrsFor(agent.agent_id, shapeId)) n += await commentOnPr(prRow, agent, cause, cfg) ? 1 : 0;
  return n;
}

/** Item-level change (e.g. a source in its context was confirmed tainted): comment on its open agent PRs. */
async function notifyItems(issueKeys, cause, cfg) {
  let n = 0;
  for (const prRow of await repo.openPrsForItems(issueKeys)) {
    const eventId = `item:${prRow.issue_key}:${cause.id}:r${cause.rev ?? 0}`;
    const agent = await repo.getAgent(prRow.agent_id);
    if (!agent) continue;
    if (!(await repo.insertDecisionEvent({ event_id: eventId.slice(0, 255), agent_id: agent.agent_id,
      shape_id: prRow.shape_id ?? "", before: {}, after: {}, cause: cause.text }))) continue;
    n += await commentOnPr(prRow, agent, cause, cfg) ? 1 : 0;
  }
  return n;
}

module.exports = { notifyDecisionChange, notifyItems };
