"use strict";
// decide(): loads record, holds and context, then runs the pure policy (spec §12.3).

const repo = require("../db/repo");
const { ports } = require("../ports");
const { decideCore, needsBuildCheck } = require("../core/policy");
const { contextStatus } = require("../core/cleanroom");

/** Approvals from PR participants: humans only, no self-approval (spec §12.4). */
async function humanApprovals(pr) {
  const agentAccounts = await repo.agentBitbucketAccounts();
  const n = u => repo.normAccount("bitbucket", u);
  return (pr.participants || []).filter(p =>
    p.approved === true &&
    n(p.user?.uuid) !== n(pr.author?.uuid) &&
    !agentAccounts.has(n(p.user?.uuid))).length;
}

async function buildIsGreen(pr) {
  const sha = pr.source?.commit?.hash;
  const ws = pr.destination?.repository?.workspace?.uuid ?? pr.source?.repository?.workspace?.uuid;
  const rp = pr.destination?.repository?.uuid;
  if (!sha || !ws || !rp) return false;
  const list = await ports.bitbucket.commitStatuses(ws, rp, sha);
  return list.length > 0 && list.every(s => s.state === "SUCCESSFUL");
}

/**
 * @param {object} p { agent, shape, issueKey, pr? }  pr is a Bitbucket PR object (for the build check)
 */
async function decide({ agent, shape, issueKey, pr = null }, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const [rec, holds, reads] = await Promise.all([
    repo.getRecord(agent.agent_id, shape.shape_id),
    repo.activeHolds(agent.agent_id, shape.shape_id),
    issueKey ? repo.readsForItem(issueKey) : [],
  ]);
  const ctx = contextStatus(reads);
  let serviceFloor = 1;
  if (shape.classified_by === "llm") {
    const service = String(shape.shape_id).split("/")[0];
    const levels = (await repo.allRecords())
      .filter(r => r.subject_id === agent.agent_id && String(r.shape_id).startsWith(`${service}/`) && r.earned_level != null)
      .map(r => Number(r.earned_level));
    if (levels.length) serviceFloor = Math.min(...levels);
  }
  let d = decideCore({ agent, shape, rec, holds, ctx, serviceFloor }, cfg);
  if (pr && needsBuildCheck(d)) d = decideCore({ agent, shape, rec, holds, ctx, serviceFloor, buildGreen: await buildIsGreen(pr) }, cfg);
  return d;
}

/** Shape-level summary used to detect decision changes for PR notices. */
async function shapeSummary(agent, shapeId, cfg) {
  const [rec, holds] = await Promise.all([repo.getRecord(agent.agent_id, shapeId), repo.activeHolds(agent.agent_id, shapeId)]);
  const d = decideCore({ agent, shape: { shape_id: shapeId }, rec, holds }, cfg);
  return { earned: d.earned, effective: d.effective, blocked: d.blocked,
    holds: holds.map(h => `${h.kind}:${h.cause_ref}:${h.clean_needed ?? ""}`).sort().join(",") };
}

module.exports = { decide, humanApprovals, buildIsGreen, shapeSummary };
