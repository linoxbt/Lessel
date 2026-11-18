"use strict";
// UI resolver for the board, issue panel and settings (spec §16).

const repo = require("../db/repo");
const { ports } = require("../ports");
const { decideCore, sentence } = require("../core/policy");
const { canConfirm } = require("../core/outcomes");
const { contextStatus, rangeText } = require("../core/cleanroom");
const { DEFAULTS } = require("../core/defaults");
const { shapeObj } = require("../services/shapes");
const { decide } = require("../services/decide");
const signals = require("../services/signals");
const cleanroom = require("../services/cleanroom");
const graph = require("../services/graph");
const snapshot = require("../services/snapshot");

class Forbidden extends Error {}

const safeJson = s => { try { return JSON.parse(s); } catch { return {}; } };

async function requireAdmin() {
  if (!(await ports.jira.userHas("ADMINISTER"))) throw new Forbidden("Only Jira admins can do this.");
}
async function requireEdit(issueKey) {
  if (!(await ports.jira.userHas("EDIT_ISSUES", { issueKey }))) throw new Forbidden(`You need edit permission on ${issueKey}.`);
}

const fmtLevel = d => (d.effective === d.earned ? `L${d.earned}` : `L${d.earned}→L${d.effective}`);

async function board() {
  const cfg = await repo.getSettings();
  const agents = await repo.listAgents();
  const records = await repo.allRecords();
  const shapeIds = [...new Set(records.map(r => r.shape_id))].sort();
  const cells = [];
  for (const agent of agents) {
    for (const shapeId of shapeIds) {
      const rec = records.find(r => r.subject_id === agent.agent_id && r.shape_id === shapeId);
      if (!rec) continue;
      const holds = await repo.activeHolds(agent.agent_id, shapeId);
      const d = decideCore({ agent, shape: shapeObj(shapeId, "path", cfg), rec, holds }, cfg);
      cells.push({ agentId: agent.agent_id, shapeId, label: fmtLevel(d), earned: d.earned, effective: d.effective,
        blocked: d.blocked, probation: holds.some(h => h.kind === "probation"), review: holds.some(h => h.kind === "review"),
        clean: rec.clean, total: rec.total, lower90: rec.lower90, sentence: sentence(agent, { shape_id: shapeId }, d) });
    }
  }
  const { minN, minContributors } = cfg.teamBaseline;
  const team = shapeIds.map(shapeId => {
    const r = records.find(x => x.subject_id === "team" && x.shape_id === shapeId);
    const shown = r && r.total >= minN && (r.contributors ?? 0) >= minContributors;
    return { shapeId, shown, text: shown ? `${r.clean}/${r.total} (${Math.round(r.lower90 * 100)}%)`
      : `not enough history (n = ${r?.total ?? 0} of ${minN})` };
  });
  return {
    agents: agents.map(a => ({ agentId: a.agent_id, name: a.display_name, suspended: !!a.suspended })),
    shapeIds, cells, team,
    mode: cfg.enforcementMode,
    windowNote: cfg.windowHours !== DEFAULTS.windowHours ? `Observation window: ${cfg.windowHours / 24} days (demo setting)` : null,
    importedNote: cfg.importedSnapshot
      ? `Imported history: a snapshot of real history exported ${cfg.importedSnapshot.exportedAt.slice(0, 10)} from the demo site. New PRs on this site are gated live.`
      : null,
  };
}

async function evidence({ agentId, shapeId }) {
  const items = (await repo.itemsForAgent(agentId)).filter(i => i.agent_id === agentId && i.shape_id === shapeId);
  const out = [];
  for (const i of items) {
    const prs = await repo.prsForItem(i.issue_key);
    const sigs = await repo.signalsForItem(i.issue_key);
    out.push({ issueKey: i.issue_key, outcome: i.outcome, changedAfterWindow: !!i.changed_after_window,
      mergedAt: i.merged_at, deployedAt: i.deployed_at, windowEnds: i.window_ends,
      prs: prs.map(p => ({ prId: p.pr_id, state: p.state, agentId: p.agent_id })),
      signals: sigs.map(s => ({ id: s.signal_id, kind: s.kind, ref: s.ref, causality: s.causality, rev: s.rev,
        decidedBy: s.decided_by, via: s.confirmed_via, decidedAt: s.decided_at })) });
  }
  const events = await repo.decisionEventsFor(agentId, shapeId);
  return { items: out, decisions: events.map(e => ({ cause: e.cause, at: e.at, after: JSON.parse(e.after_json) })) };
}

async function panel({ issueKey }, context = {}) {
  const cfg = await repo.getSettings();
  const item = await repo.getItem(issueKey);
  if (!item) return { tracked: false };
  // Teamwork Graph runs as the viewing user: pick up incidents linked in the graph before rendering.
  const graphSync = await graph.syncIncidents({ issueKey, cloudId: context.cloudId }, cfg);
  const agentId = item.agent_id ?? item.assigned_agent_id;
  const agent = agentId ? await repo.getAgent(agentId) : null;
  const shape = shapeObj(item.shape_id, item.classified_by, cfg);
  let decision = null;
  if (agent) {
    const d = await decide({ agent, shape, issueKey }, cfg);
    decision = { sentence: sentence(agent, shape, d), blocked: d.blocked, approvals: d.approvals, selfMerge: d.selfMerge };
  }
  const now = ports.now();
  const sigs = await repo.signalsForItem(issueKey);
  const reads = await repo.readsForItem(issueKey);
  return {
    tracked: true, mode: cfg.enforcementMode, issueKey, agent: agent?.display_name ?? null,
    actorKind: item.actor_kind, outcome: item.outcome, shapeId: item.shape_id, classifiedBy: item.classified_by,
    shapeState: item.shape_state, windowEnds: item.window_ends, decision,
    canConfirm: canConfirm(item, now, cfg),
    signals: sigs.map(s => ({ id: s.signal_id, kind: s.kind, ref: s.ref, severity: s.severity, causality: s.causality,
      rev: s.rev, decidedBy: s.decided_by, via: s.confirmed_via, decidedAt: s.decided_at })),
    context: contextStatus(reads),
    reads: reads.map(r => ({ title: r.source.title || r.source.url, version: r.source_version, basis: r.version_basis,
      method: r.method, flag: r.flag, late: !!(item.merged_at && r.recorded_at > item.merged_at),
      sourceState: r.source.state, range: r.source.tainted_from_version ? rangeText(r.source) : null })),
    shapeOptions: (await repo.listShapes()).map(s => s.shape_id),
    graph: graphSync,
    devChain: await graph.devChain({ issueKey, cloudId: context.cloudId }, cfg),
  };
}

async function settingsView() {
  return { settings: await repo.getSettings(), agents: await repo.listAgents(), accounts: await repo.accounts() };
}

async function sources() {
  const list = await repo.listSources();
  const out = [];
  for (const s of list) {
    const br = await cleanroom.blastRadius(s.source_id);
    out.push({ ...s, range: s.tainted_from_version ? rangeText(s) : null,
      findings: (await repo.findingsFor(s.source_id)).slice(0, 20), blastRadius: br.items });
  }
  return out;
}

const DEFINITIONS = {
  getBoard: () => board(),
  getEvidence: ({ payload }) => evidence(payload),
  getPanel: ({ payload, context }) => panel(payload, context),
  confirmCause: async ({ payload, context }) => {
    const sig = await repo.getSignal(payload.signalId);
    await requireEdit(sig?.issue_key);
    await signals.confirmCause(payload.signalId, context.accountId);
    return panel({ issueKey: sig.issue_key }, context);
  },
  dismissCause: async ({ payload, context }) => {
    const sig = await repo.getSignal(payload.signalId);
    await requireEdit(sig?.issue_key);
    await signals.dismissCause(payload.signalId, context.accountId);
    return panel({ issueKey: sig.issue_key }, context);
  },
  reopenDecision: async ({ payload, context }) => {
    await requireAdmin();
    const sig = await repo.getSignal(payload.signalId);
    await signals.reopenDecision(payload.signalId, context.accountId, payload.note);
    return panel({ issueKey: sig.issue_key }, context);
  },
  confirmShape: async ({ payload, context }) => {
    await requireEdit(payload.issueKey);
    const item = await repo.getItem(payload.issueKey);
    if (!item) throw new Error("Not tracked.");
    await repo.patchItem(payload.issueKey, { shape_id: payload.shapeId ?? item.shape_id, classified_by: "manual" });
    for (const p of await repo.prsForItem(payload.issueKey)) {
      await repo.upsertPr({ ...p, shape_id: payload.shapeId ?? p.shape_id, classified_by: "manual" });
    }
    await repo.logStaffAction({ actor: context.accountId, action: "set-shape", target: payload.issueKey, note: payload.shapeId ?? item.shape_id });
    return panel({ issueKey: payload.issueKey }, context);
  },
  getSettings: async () => { await requireAdmin(); return settingsView(); },
  saveSetting: async ({ payload, context }) => {
    await requireAdmin();
    await repo.setSetting(payload.key, payload.value);
    await repo.logStaffAction({ actor: context.accountId, action: "setting", target: payload.key, note: JSON.stringify(payload.value).slice(0, 500) });
    return settingsView();
  },
  saveAgent: async ({ payload }) => { await requireAdmin(); await repo.upsertAgent(payload); return settingsView(); },
  addAccount: async ({ payload }) => { await requireAdmin(); await repo.addAccount(payload.product, payload.accountId, payload.agentId); return settingsView(); },
  removeAccount: async ({ payload }) => { await requireAdmin(); await repo.removeAccount(payload.product, payload.accountId); return settingsView(); },
  setSuspended: async ({ payload, context }) => {
    await requireAdmin();
    await repo.setSuspended(payload.agentId, payload.suspended);
    await repo.logStaffAction({ actor: context.accountId, action: "suspend", target: payload.agentId, note: String(!!payload.suspended) });
    return settingsView();
  },
  getSources: async () => sources(),
  confirmTaint: async ({ payload, context }) => { await requireAdmin(); await cleanroom.confirmTaint(payload.sourceId, context.accountId, payload.fromVersion); return sources(); },
  markFixed: async ({ payload, context }) => { await requireAdmin(); await cleanroom.markFixed(payload.sourceId, context.accountId, payload.cleanFromVersion); return sources(); },
  restoreClean: async ({ payload, context }) => { await requireAdmin(); await cleanroom.restoreClean(payload.sourceId, context.accountId); return sources(); },
  getHistory: async () => (await repo.recentDecisionEvents(100)).map(e => ({
    at: e.at, agentId: e.agent_id, shapeId: e.shape_id, cause: e.cause,
    before: safeJson(e.before_json), after: safeJson(e.after_json) })),
  dismissTaint: async ({ payload, context }) => { await requireAdmin(); await cleanroom.dismissTaint(payload.sourceId, context.accountId); return sources(); },
  scanHistory: async ({ payload }) => { await requireAdmin(); return require("../jobs").enqueue({ type: "scan-history", pageId: payload.pageId }); },
  exportSnapshot: async () => { await requireAdmin(); return { json: JSON.stringify(await snapshot.exportSnapshot()) }; },
  importSnapshot: async ({ payload }) => {
    await requireAdmin();
    let parsed;
    try { parsed = JSON.parse(payload.json); } catch { throw new signals.UserError("That isn't valid JSON."); }
    const imported = await snapshot.importSnapshot(parsed);
    await require("../services/recompute").recomputeAll();
    return { imported };
  },
  runJob: async ({ payload }) => {
    await requireAdmin();
    if (!["backfill", "migrate", "recompute-all"].includes(payload.type)) throw new Error("Unknown job.");
    return require("../jobs").enqueue({ type: payload.type }, payload.type);
  },
};

/** Wrap every definition so errors come back as { error } the UI can show. */
function uiResolverFactory() {
  const Resolver = require("@forge/resolver").default;
  const resolver = new Resolver();
  for (const [name, fn] of Object.entries(DEFINITIONS)) {
    resolver.define(name, async req => {
      try { return await fn(req); } catch (e) {
        if (!(e instanceof Forbidden) && !(e instanceof signals.UserError)) console.error(name, e);
        return { error: e.message };
      }
    });
  }
  return resolver.getDefinitions();
}

module.exports = { uiResolver: uiResolverFactory(), DEFINITIONS, board, panel, evidence };
