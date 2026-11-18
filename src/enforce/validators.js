"use strict";
// Jira Ready-to-merge validator (spec §14.3). Input/return shape per jira:workflowValidator [verify].

const repo = require("../db/repo");
const { ports } = require("../ports");
const { sentence } = require("../core/policy");
const { decide, humanApprovals } = require("../services/decide");
const { shapeObj } = require("../services/shapes");

async function validateReadyToMerge(args) {
  const key = args?.issue?.key;
  if (!key) return { result: true };
  const cfg = await repo.getSettings();
  try {
    const prRow = (await repo.prsForItem(key)).find(p => p.state === "open" && p.agent_id);
    if (!prRow) return { result: true };
    const agent = await repo.getAgent(prRow.agent_id);
    const item = await repo.getItem(key);
    const shape = shapeObj(prRow.shape_id ?? item.shape_id, prRow.classified_by ?? item.classified_by, cfg);
    const pr = await ports.bitbucket.getPr(prRow.workspace_uuid, prRow.repo_uuid, prRow.pr_id);
    const d = await decide({ agent, shape, issueKey: key, pr }, cfg);
    const have = d.blocked ? 0 : await humanApprovals(pr);
    const ok = !d.blocked && (d.selfMerge === "yes" || have >= d.approvals);
    if (ok || cfg.enforcementMode !== "enforcing") return { result: true };
    return { result: false, errorMessage: d.blocked
      ? `Lessel: ${sentence(agent, shape, d)}`
      : `Lessel: ${sentence(agent, shape, d)} Needs ${d.approvals} human approvals on the PR; has ${have}.` };
  } catch (e) {
    console.error("validateReadyToMerge error", e);
    return cfg.enforcementMode === "enforcing"
      ? { result: false, errorMessage: `Lessel couldn't check this item (${e.message}). Try again.` }
      : { result: true };
  }
}

/**
 * Start validator (P4): blocks an agent from starting work it isn't eligible for, e.g. it's suspended,
 * at L0 for the item's shape, or the item's context is tainted. People are never blocked by this.
 */
async function validateAgentStart(args) {
  const key = args?.issue?.key;
  if (!key) return { result: true };
  const cfg = await repo.getSettings();
  try {
    const item = await repo.getItem(key);
    const agentId = item?.assigned_agent_id;
    if (!agentId) return { result: true };
    const agent = await repo.getAgent(agentId);
    if (!agent) return { result: true };
    const shape = shapeObj(item.shape_id, item.classified_by, cfg);
    const d = await decide({ agent, shape, issueKey: key }, cfg);
    if (!d.blocked || cfg.enforcementMode !== "enforcing") return { result: true };
    return { result: false, errorMessage: `Lessel: ${sentence(agent, shape, d)} Assign it to someone else or resolve the block first.` };
  } catch (e) {
    console.error("validateAgentStart error", e);
    return { result: true }; // starting work is never blocked by Lessel's own failure
  }
}

module.exports = { validateReadyToMerge, validateAgentStart };
