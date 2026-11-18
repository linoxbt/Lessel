"use strict";
// Merge gate (spec §14.1) and human-PR minimum (§14.4). Never calls the LLM.

const repo = require("../db/repo");
const { ports } = require("../ports");
const { keyFromPr } = require("../core/keys");
const { sentence } = require("../core/policy");
const { decide, humanApprovals } = require("../services/decide");
const { shapeForGate } = require("../services/shapes");
const { normUuid } = require("../events/once");

function verdict(cfg, ok, message) {
  if (ok || cfg.enforcementMode === "enforcing") return { success: ok, message };
  return { success: true, message: `Advisory mode, would block: ${message}` };
}

async function humanPrCheck(pr, cfg) {
  const have = await humanApprovals(pr);
  const ok = have >= cfg.humanPrMinApprovals;
  return verdict(cfg, ok, `Human PR: ${have}/${cfg.humanPrMinApprovals} approvals (repository rule, not a score).`);
}

/** Merge-check payload: workspace, repository and pull request ids [verify exact shape]. */
async function mergeGate(event) {
  const cfg = await repo.getSettings();
  try {
    const ws = event.workspace?.uuid ?? event.repository?.workspace?.uuid;
    const repoUuid = event.repository?.uuid;
    const prId = event.pullrequest?.id ?? event.pullRequest?.id;
    const pr = await ports.bitbucket.getPr(ws, repoUuid, prId);

    const agent = await repo.agentForAccount("bitbucket", pr.author?.uuid);
    if (!agent) return humanPrCheck(pr, cfg);

    const key = keyFromPr(pr, cfg.projectKeys);
    if (!key) return verdict(cfg, false,
      `${agent.display_name} opened a PR with no Jira key from ${cfg.projectKeys.join(", ")}. Put the key in the branch name.`);
    const item = await repo.getItem(key);
    if (!item) return verdict(cfg, false, `${key} isn't a work item Lessel is tracking. Check the key.`);
    // The branch key is the agent's claim; it must match the work it was given, or a blocked task could be
    // merged under another item's key.
    if (item.assigned_agent_id !== agent.agent_id && item.agent_id !== agent.agent_id) {
      return verdict(cfg, false, `${key} isn't assigned to ${agent.display_name}. Use the key of the work item you were assigned.`);
    }

    const prRow = await repo.getPrRow(normUuid(repoUuid), pr.id);
    const shape = await shapeForGate(pr, prRow ?? { workspace_uuid: normUuid(ws), repo_uuid: normUuid(repoUuid) }, item, cfg);
    const d = await decide({ agent, shape, issueKey: key, pr }, cfg);
    const why = sentence(agent, shape, d);
    if (d.blocked) return verdict(cfg, false, why);
    if (d.selfMerge === "yes") return verdict(cfg, true, why);
    const have = await humanApprovals(pr);
    return verdict(cfg, have >= d.approvals, `${why} ${have}/${d.approvals} human approvals.`);
  } catch (e) {
    // Fail closed when enforcing, open when advisory, and always say why.
    console.error("mergeGate error", e);
    return verdict(cfg, false, `Lessel couldn't evaluate this PR (${e.message}). Try again in a minute.`);
  }
}

module.exports = { mergeGate, verdict, humanPrCheck };
