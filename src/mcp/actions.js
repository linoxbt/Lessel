"use strict";
// Rovo actions, also exposed as MCP tools (spec §15). Agent-bound tools take identity from the caller only.

const repo = require("../db/repo");
const { sentence, decideCore, needWords } = require("../core/policy");
const { decide } = require("../services/decide");
const { shapeObj } = require("../services/shapes");
const { declareContext: declare, checkContext: check } = require("../services/cleanroom");
const { recordFromOutcomes } = require("../core/levels");

class Refusal extends Error {}

/** Caller accountId: Forge passes it in the invocation context [verify which account for MCP calls]. */
function callerAccountId(payload, context) {
  return context?.principal?.accountId ?? context?.accountId ?? payload?.context?.accountId ?? payload?.accountId ?? null;
}

async function callerAgent(payload, context) {
  const accountId = callerAccountId(payload, context);
  if (!accountId) throw new Refusal("No caller identity on this call.");
  const agent = await repo.agentForAccount(["mcp", "jira"], accountId);
  if (!agent) throw new Refusal("This account is not registered as an agent in Lessel.");
  return agent;
}

const input = (payload, name) => payload?.[name] ?? payload?.inputs?.[name];

function wrap(fn) {
  return async (payload, context) => {
    try {
      return await fn(payload, context);
    } catch (e) {
      if (e instanceof Refusal) return `Refused: ${e.message}`;
      console.error(e);
      return `Lessel error: ${e.message}`;
    }
  };
}

async function shapesForAgent(agent) {
  const records = (await repo.allRecords()).filter(r => r.subject_id === agent.agent_id);
  return records.map(r => r.shape_id);
}

const getMyScope = wrap(async (payload, context) => {
  const agent = await callerAgent(payload, context);
  const cfg = await repo.getSettings();
  const lines = [`${agent.display_name}${agent.suspended ? " (suspended)" : ""}. Enforcement mode: ${cfg.enforcementMode}.`];
  for (const shapeId of await shapesForAgent(agent)) {
    const holds = await repo.activeHolds(agent.agent_id, shapeId);
    const d = decideCore({ agent, shape: shapeObj(shapeId, "path", cfg), rec: await repo.getRecord(agent.agent_id, shapeId), holds }, cfg);
    let line = `- ${shapeId}: ${d.effective === d.earned ? `L${d.earned}` : `earned L${d.earned}, effective L${d.effective}`}` +
      ` (${d.rec.clean}/${d.rec.total} clean)`;
    if (input(payload, "includeHolds") && holds.length) line += `; holds: ${holds.map(h => `${h.kind} (${h.reason})`).join("; ")}`;
    lines.push(line);
  }
  if (lines.length === 1) lines.push("No confirmed outcomes yet: every shape starts at L1.");
  return lines.join("\n");
});

const checkTicketFit = wrap(async (payload, context) => {
  const agent = await callerAgent(payload, context);
  const key = input(payload, "issueKey");
  const item = await repo.getItem(key);
  if (!item) return `${key} isn't tracked by Lessel yet. It starts when the item is assigned to an agent.`;
  const cfg = await repo.getSettings();
  const shape = shapeObj(item.shape_id, item.classified_by, cfg);
  const d = await decide({ agent, shape, issueKey: key }, cfg);
  const fit = d.blocked ? "Blocked." : `Allowed: ${needWords(d)}${d.selfMerge === "if-green" ? " (or self-merge once the build is green)" : ""}.`;
  return `${sentence(agent, shape, d)} ${fit} Enforcement mode: ${cfg.enforcementMode}.`;
});

const explainRecord = wrap(async (payload) => {
  const name = String(input(payload, "agent") || "").trim().toLowerCase();
  const agents = await repo.listAgents();
  const agent = agents.find(a => a.display_name.toLowerCase() === name || a.agent_id === name);
  if (!agent) return `No agent called ${input(payload, "agent")}. Known agents: ${agents.map(a => a.display_name).join(", ") || "none"}.`;
  const wanted = input(payload, "shape");
  const items = (await repo.itemsForAgent(agent.agent_id)).filter(i => i.agent_id === agent.agent_id && (!wanted || i.shape_id === wanted));
  const out = [];
  const byShape = new Map();
  for (const i of items) { if (!byShape.has(i.shape_id)) byShape.set(i.shape_id, []); byShape.get(i.shape_id).push(i); }
  for (const [shapeId, list] of byShape) {
    const rec = recordFromOutcomes(list.filter(i => i.shape_state === "frozen").map(i => i.outcome));
    out.push(`${agent.display_name} on ${shapeId}: L${rec.earned_level} (${rec.clean}/${rec.total} confirmed clean, lower bound ${Math.round(rec.lower90 * 100)}%).`);
    for (const i of list.slice(0, 10)) {
      const sigs = await repo.signalsForItem(i.issue_key);
      const s = sigs.map(x => `${x.kind} ${x.ref ?? ""} ${x.causality}${x.confirmed_via?.startsWith("source:") ? ` (bad input: ${x.confirmed_via.slice(7)})` : ""}`.replace(/\s+/g, " ").trim());
      out.push(`  - ${i.issue_key}: ${i.outcome}${s.length ? ` — ${s.join("; ")}` : ""}`);
    }
  }
  return out.length ? out.join("\n") : `${agent.display_name} has no outcomes${wanted ? ` on ${wanted}` : ""} yet.`;
});

const declareContext = wrap(async (payload, context) => {
  const agent = await callerAgent(payload, context);
  const r = await declare(agent, { issueKey: input(payload, "issueKey"), sourceUrl: input(payload, "sourceUrl"),
    sourceVersion: input(payload, "sourceVersion"), readAt: input(payload, "readAt") });
  return r.message;
});

const checkContext = wrap(async (payload, context) => {
  const agent = await callerAgent(payload, context);
  const cfg = await repo.getSettings();
  const levels = [];
  for (const shapeId of await shapesForAgent(agent)) {
    const d = decideCore({ agent, shape: { shape_id: shapeId }, rec: await repo.getRecord(agent.agent_id, shapeId),
      holds: await repo.activeHolds(agent.agent_id, shapeId) }, cfg);
    levels.push(d.effective);
  }
  const level = levels.length ? Math.min(...levels) : 1; // most conservative across the caller's shapes
  const r = await check(level, input(payload, "sourceUrl"));
  return `${r.verdict}: ${r.reason}`;
});

/** Dispatcher: rank eligible agents and the team for an item. */
const rankAssignees = wrap(async (payload) => {
  const key = input(payload, "issueKey");
  const cfg = await repo.getSettings();
  const item = await repo.getItem(key);
  const shapeId = item?.shape_id;
  if (!shapeId) return `${key} has no shape yet. Assign it to an agent or open a PR so Lessel can classify it.`;
  const shape = shapeObj(shapeId, item.classified_by, cfg);
  const rows = [];
  for (const agent of await repo.listAgents()) {
    const d = await decide({ agent, shape, issueKey: null }, cfg);
    rows.push({ agent, d, line: sentence(agent, shape, d) });
  }
  rows.sort((a, b) => (a.d.blocked - b.d.blocked) || (b.d.effective - a.d.effective) || (b.d.rec.lower90 - a.d.rec.lower90));
  const team = await repo.getRecord("team", shapeId);
  const { minN, minContributors } = cfg.teamBaseline;
  const teamLine = team && team.total >= minN && (team.contributors ?? 0) >= minContributors
    ? `The team: ${team.clean} of ${team.total} clean on ${shapeId}, lower bound ${Math.round(team.lower90 * 100)}%.`
    : `The team: not enough history on ${shapeId} (n = ${team?.total ?? 0} of ${minN}${(team?.contributors ?? 0) < minContributors ? `, fewer than ${minContributors} contributors` : ""}).`;
  return [`Shape of ${key}: ${shapeId}.`, ...rows.slice(0, 3).map((r, i) => `${i + 1}. ${r.line}`), teamLine].join("\n");
});

module.exports = { getMyScope, checkTicketFit, explainRecord, declareContext, checkContext, rankAssignees, callerAccountId };
