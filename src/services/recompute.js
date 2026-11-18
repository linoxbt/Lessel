"use strict";
// Recompute outcomes, records and holds from scratch (spec §8.4, §11.3).

const repo = require("../db/repo");
const { ports } = require("../ports");
const { deriveOutcome, deriveHolds } = require("../core/outcomes");
const { recordFromOutcomes } = require("../core/levels");

/** Re-derive one item's outcome from its signals and window; writes only on change. */
async function refreshItem(issueKey, cfg) {
  const item = await repo.getItem(issueKey);
  if (!item) return null;
  const signals = await repo.signalsForItem(issueKey);
  const outcome = deriveOutcome(item, signals, ports.now());
  if (outcome !== item.outcome) {
    const patch = { outcome };
    // a late confirmation flipped a clean item
    if (item.outcome === "clean" && outcome === "failed") patch.changed_after_window = 1;
    await repo.patchItem(issueKey, patch);
    item.outcome = outcome;
  }
  return item;
}

// TIMESTAMP columns start at 1970-01-01 00:00:01 UTC, so the floor for "no inputs yet" is a safe early date.
const EPOCH = new Date("2000-01-01T00:00:00Z");
const maxTime = dates => dates.filter(Boolean).reduce((m, d) => (d > m ? d : m), EPOCH);

/** Record + holds for one (agent, shape). */
async function recompute(agentId, shapeId, cfg, { force = false } = {}) {
  cfg = cfg ?? await repo.getSettings();
  const items = await repo.itemsForAgentShape(agentId, shapeId);
  const signals = await repo.signalsForAgentShape(agentId, shapeId);
  const sigWm = signals.map(s => s.updated_at);
  const watermark = maxTime([...sigWm, ...items.map(i => i.updated_at)]);
  const rec = recordFromOutcomes(items.map(i => i.outcome), cfg.levels);
  await repo.upsertRecord({ subject_id: agentId, shape_id: shapeId, ...rec, watermark, force });
  await repo.syncHolds(agentId, shapeId, deriveHolds({ agentId, shapeId, items, signals }, cfg));
  return rec;
}

/**
 * Team baseline for a shape (§11.4). Contributors are counted in memory from Jira assignees;
 * only the count is stored.
 */
async function recomputeTeam(shapeId, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const items = await repo.teamItemsForShape(shapeId);
  const rec = recordFromOutcomes(items.map(i => i.outcome), cfg.levels);
  let contributors = 0;
  if (items.length) {
    try {
      const keys = items.map(i => i.issue_key);
      const people = new Set();
      for (let i = 0; i < keys.length; i += 50) {
        const issues = await ports.jira.searchJql(`key in (${keys.slice(i, i + 50).join(",")})`, ["assignee"]);
        for (const is of issues) if (is.fields?.assignee?.accountId) people.add(is.fields.assignee.accountId);
      }
      contributors = people.size;
    } catch (e) {
      console.warn("team contributor count failed", e?.message);
    }
  }
  await repo.upsertRecord({ subject_id: "team", shape_id: shapeId, ...rec, earned_level: null, contributors,
    watermark: maxTime(items.map(i => i.updated_at)) });
}

/** Hourly: close windows, expire suspected signals, recompute everything touched. */
async function recomputeAll(cfg) {
  cfg = cfg ?? await repo.getSettings();
  const pairs = await repo.agentShapePairs();
  for (const { agent_id, shape_id } of pairs) await recompute(agent_id, shape_id, cfg, { force: true });
  const shapes = await repo.listShapes();
  for (const s of shapes) await recomputeTeam(s.shape_id, cfg);
  return pairs.length;
}

module.exports = { refreshItem, recompute, recomputeTeam, recomputeAll };
