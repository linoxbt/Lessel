"use strict";
// UI resolver for the board, issue panel and settings (spec §16), plus the Confluence link settings page.
// Every issue key returned is checked against the viewer's browse permission (see ./permissions), and account
// ids are never returned: who decided something is shown in words.

const repo = require("../db/repo");
const { toDate } = require("../db/driver");
const { ports } = require("../ports");
const { decideCore, sentence } = require("../core/policy");
const { canConfirm, HOUR } = require("../core/outcomes");
const { contextStatus, rangeText, possibleBadInput } = require("../core/cleanroom");
const { DEFAULTS } = require("../core/defaults");
const { shapeObj } = require("../services/shapes");
const { decide } = require("../services/decide");
const signals = require("../services/signals");
const cleanroom = require("../services/cleanroom");
const graph = require("../services/graph");
const snapshot = require("../services/snapshot");
const { readiness } = require("../services/readiness");
const perms = require("./permissions");

class Forbidden extends Error {}

const safeJson = s => { try { return JSON.parse(s); } catch { return {}; } };
/** DB timestamps come back as "YYYY-MM-DD HH:MM:SS" in UTC: always hand the UI an ISO string with a Z. */
const iso = v => { const d = v == null ? null : toDate(v); return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };

async function requireAdmin() {
  if (!(await ports.jira.userHas("ADMINISTER"))) throw new Forbidden("Only Jira admins can do this.");
}
async function requireEdit(issueKey, cfg) {
  cfg = cfg ?? await repo.getSettings();
  // Imported demo history has no Jira issue on this site, so nobody has edit permission on it: admins decide.
  if (perms.isImportedKey(cfg, issueKey)) return requireAdmin();
  if (!(await ports.jira.userHas("EDIT_ISSUES", { issueKey }))) throw new Forbidden(`You need edit permission on ${issueKey}.`);
}
async function requireConfluenceAdmin() {
  if (!(await perms.isConfluenceAdmin())) throw new Forbidden("Only Confluence admins can link Lessel.");
}

const fmtLevel = d => (d.effective === d.earned ? `L${d.earned}` : `L${d.earned}→L${d.effective}`);
const windowNote = cfg => (cfg.windowHours !== DEFAULTS.windowHours ? `Observation window: ${cfg.windowHours / 24} days (demo setting)` : null);

/** Per-request view of the caller: which keys they may see, and who decided things, in words. */
function caller(cfg, context = {}) {
  const v = perms.viewer({ open: perms.openProjects(cfg) });
  let names = null;
  const who = async by => {
    if (by == null) return null;
    if (!names) {
      const [accs, agents] = await Promise.all([repo.accounts(), repo.listAgents()]);
      const display = new Map(agents.map(a => [a.agent_id, a.display_name]));
      names = new Map(accs.map(x => [x.account_id, display.get(x.agent_id) ?? x.agent_id]));
    }
    return perms.actorWords(by, { me: context?.accountId, byAccount: names });
  };
  const titles = new Map();
  const how = async via => {
    const id = typeof via === "string" && via.startsWith("source:") ? via.slice(7) : null;
    if (id && !titles.has(id)) {
      const s = await repo.getSource(id);
      titles.set(id, s?.title || s?.url || "a Clean Room source");
    }
    return perms.viaWords(via, x => titles.get(x));
  };
  return { v, who, how };
}

/** One signal for the panel or the evidence drawer. */
async function signalView(s, item, c, cfg, now) {
  const end = item?.window_ends ? toDate(item.window_ends) : null;
  const expiresAt = s.causality === "suspected" && end ? new Date(end.getTime() + cfg.suspectedExpiryHours * HOUR) : null;
  return {
    id: s.signal_id, kind: s.kind, ref: await c.v.label(s.ref), severity: s.severity, causality: s.causality, rev: s.rev,
    decidedBy: await c.who(s.decided_by), via: await c.how(s.confirmed_via), decidedAt: iso(s.decided_at),
    expired: s.decided_by === "lessel:expired",
    // Suspected signals expire suspectedExpiryHours after the window closes (§10.4): the countdown.
    expiresAt: iso(expiresAt),
    expiresInHours: expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / HOUR)) : null,
    windowOpen: end ? now < end : null,
  };
}

async function board(context = {}) {
  const cfg = await repo.getSettings();
  const c = caller(cfg, context);
  const [agents, records, allHolds] = await Promise.all([repo.listAgents(), repo.allRecords(), repo.allActiveHolds()]);
  // One query for every hold instead of one per cell (Forge resolvers have a short time limit).
  const holdsByPair = new Map();
  for (const h of allHolds) {
    const k = `${h.agent_id}|${h.shape_id}`;
    if (!holdsByPair.has(k)) holdsByPair.set(k, []);
    holdsByPair.get(k).push(h);
  }
  const shapeIds = [...new Set(records.map(r => r.shape_id))].sort();
  const cells = [];
  for (const agent of agents) {
    for (const shapeId of shapeIds) {
      const rec = records.find(r => r.subject_id === agent.agent_id && r.shape_id === shapeId);
      if (!rec) continue;
      const holds = holdsByPair.get(`${agent.agent_id}|${shapeId}`) ?? [];
      const d = decideCore({ agent, shape: shapeObj(shapeId, "path", cfg), rec, holds }, cfg);
      cells.push({ agentId: agent.agent_id, shapeId, label: fmtLevel(d), earned: d.earned, effective: d.effective,
        blocked: d.blocked, probation: holds.some(h => h.kind === "probation"), review: holds.some(h => h.kind === "review"),
        clean: rec.clean, total: rec.total, lower90: rec.lower90,
        // Hold reasons name incidents and work items: redact the ones this viewer can't browse.
        sentence: await c.v.text(sentence(agent, { shape_id: shapeId }, d)) });
    }
  }
  const { minN, minContributors } = cfg.teamBaseline;
  const team = shapeIds.map(shapeId => {
    const r = records.find(x => x.subject_id === "team" && x.shape_id === shapeId);
    const shown = r && r.total >= minN && (r.contributors ?? 0) >= minContributors;
    return { shapeId, shown, text: shown ? `${r.clean}/${r.total} (${Math.round(r.lower90 * 100)}%)`
      : `not enough history (n = ${r?.total ?? 0} of ${minN})` };
  });
  const imp = cfg.importedSnapshot;
  return {
    agents: agents.map(a => ({ agentId: a.agent_id, name: a.display_name, suspended: !!a.suspended })),
    shapeIds, cells, team,
    mode: cfg.enforcementMode,
    windowNote: windowNote(cfg),
    importedNote: imp
      ? `Imported history: a snapshot of real history exported ${String(imp.exportedAt ?? "").slice(0, 10)} from the demo site. New PRs on this site are gated live.` +
        (imp.keyPrefix ? ` Imported work item keys start with ${imp.keyPrefix} (PAY-212 becomes ${imp.keyPrefix}PAY-212), so they never collide with this site's own.` : "")
      : null,
  };
}

async function evidence({ agentId, shapeId }, context = {}) {
  const cfg = await repo.getSettings();
  const c = caller(cfg, context);
  const now = ports.now();
  const items = (await repo.itemsForAgent(agentId)).filter(i => i.agent_id === agentId && i.shape_id === shapeId);
  const keys = items.map(i => i.issue_key);
  const group = rows => rows.reduce((m, r) => m.set(r.issue_key, [...(m.get(r.issue_key) ?? []), r]), new Map());
  const [prsBy, sigsBy, readsBy] = (await Promise.all([repo.prsForItems(keys), repo.signalsForItems(keys), repo.readsForItems(keys)])).map(group);
  const out = [];
  let hidden = 0;
  for (const i of items) {
    const base = { outcome: i.outcome, changedAfterWindow: !!i.changed_after_window,
      mergedAt: iso(i.merged_at), deployedAt: iso(i.deployed_at),
      // The window opens at the first qualifying deployment, or at merge for repos that don't deploy (§10.2).
      windowStart: iso(i.window_ends ? (i.deployed_at ?? i.merged_at) : null), windowEnds: iso(i.window_ends) };
    if (!(await c.v.canView(i.issue_key))) {
      out.push({ key: `hidden-${++hidden}`, issueKey: null, label: perms.HIDDEN, hidden: true, ...base,
        prs: [], signals: [], possibleBadInput: false, canConfirm: false });
      continue;
    }
    const [prs, sigs, reads] = [prsBy.get(i.issue_key) ?? [], sigsBy.get(i.issue_key) ?? [], readsBy.get(i.issue_key) ?? []];
    out.push({ key: i.issue_key, issueKey: i.issue_key, label: i.issue_key, hidden: false,
      imported: perms.isImportedKey(cfg, i.issue_key), ...base,
      prs: prs.map(p => ({ prId: p.pr_id, state: p.state, head: p.head_commit ? String(p.head_commit).slice(0, 12) : null,
        mergeCommit: p.merge_commit ? String(p.merge_commit).slice(0, 12) : null,
        imported: String(p.repo_uuid ?? "").startsWith("imported:") })),
      signals: await Promise.all(sigs.map(s => signalView(s, i, c, cfg, now))),
      // §13.3: a confirmed failure whose reads touch a tainted range without excusing it: a human should look.
      possibleBadInput: sigs.some(s => s.causality === "confirmed") && possibleBadInput(reads),
      canConfirm: canConfirm(i, now, cfg) });
  }
  const events = await repo.decisionEventsFor(agentId, shapeId);
  return { agentId, shapeId, windowNote: windowNote(cfg), items: out,
    decisions: await Promise.all(events.map(async e => ({ cause: await c.v.text(e.cause), at: iso(e.at),
      after: safeJson(e.after_json) }))) };
}

async function panel({ issueKey }, context = {}) {
  const cfg = await repo.getSettings();
  const item = await repo.getItem(issueKey);
  if (!item) return { tracked: false };
  const c = caller(cfg, context);
  // Teamwork Graph runs as the viewing user: pick up incidents linked in the graph before rendering.
  const graphSync = await graph.syncIncidents({ issueKey, cloudId: context.cloudId }, cfg);
  const agentId = item.agent_id ?? item.assigned_agent_id;
  const agent = agentId ? await repo.getAgent(agentId) : null;
  const shape = shapeObj(item.shape_id, item.classified_by, cfg);
  let decision = null;
  let recommendation = null;
  if (agent) {
    const d = await decide({ agent, shape, issueKey }, cfg);
    decision = { sentence: await c.v.text(sentence(agent, shape, d)), blocked: d.blocked, approvals: d.approvals, selfMerge: d.selfMerge };
    // P4 hint: when this agent is blocked or supervised here, name a better-qualified agent for the same shape.
    if (!item.merged_at && (d.blocked || d.effective <= 1)) recommendation = await betterAgent(agent, shape, d, cfg);
  }
  const now = ports.now();
  const sigs = await repo.signalsForItem(issueKey);
  const reads = await repo.readsForItem(issueKey);
  // Graph incident keys may sit in projects this viewer can't browse.
  const labels = keys => Promise.all((keys ?? []).map(k => c.v.label(k)));
  const graphOut = graphSync && !graphSync.skipped && !graphSync.error
    ? { incidents: await labels(graphSync.incidents), added: await labels(graphSync.added) }
    : graphSync;
  return {
    tracked: true, mode: cfg.enforcementMode, issueKey, agent: agent?.display_name ?? null,
    actorKind: item.actor_kind, outcome: item.outcome, shapeId: item.shape_id, classifiedBy: item.classified_by,
    shapeState: item.shape_state, windowStart: iso(item.window_ends ? (item.deployed_at ?? item.merged_at) : null),
    windowEnds: iso(item.window_ends), windowNote: windowNote(cfg), decision,
    canConfirm: canConfirm(item, now, cfg),
    recommendation,
    signals: await Promise.all(sigs.map(s => signalView(s, item, c, cfg, now))),
    possibleBadInput: sigs.some(s => s.causality === "confirmed") && possibleBadInput(reads),
    context: contextStatus(reads),
    reads: reads.map(r => ({ title: r.source.title || r.source.url, version: r.source_version, basis: r.version_basis,
      method: r.method, flag: r.flag, late: !!(item.merged_at && r.recorded_at > item.merged_at),
      sourceState: r.source.state, range: r.source.tainted_from_version ? rangeText(r.source) : null })),
    shapeOptions: (await repo.listShapes()).map(s => s.shape_id),
    graph: graphOut,
    devChain: await graph.devChain({ issueKey, cloudId: context.cloudId }, cfg),
  };
}

/** Another agent with a higher effective level on this shape (record + holds only; never names people). */
async function betterAgent(current, shape, d, cfg) {
  let best = null;
  for (const other of await repo.listAgents()) {
    if (other.agent_id === current.agent_id || other.suspended) continue;
    const rec = await repo.getRecord(other.agent_id, shape.shape_id);
    if (!rec) continue;
    const od = decideCore({ agent: other, shape, rec, holds: await repo.activeHolds(other.agent_id, shape.shape_id) }, cfg);
    if (od.blocked || od.effective <= (d.blocked ? 0 : d.effective)) continue;
    if (!best || od.effective > best.d.effective || (od.effective === best.d.effective && od.rec.lower90 > best.d.rec.lower90)) best = { other, d: od };
  }
  if (!best) return null;
  return `${best.other.display_name} is L${best.d.effective} on ${shape.shape_id} ` +
    `(${best.d.rec.clean} of ${best.d.rec.total} clean). Consider reassigning.`;
}

async function settingsView() {
  const all = await repo.getSettings();
  // Staged snapshot rows ("~snapshot:…") live in the settings table while an import is queued: not settings.
  const settings = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith("~")));
  return { settings, agents: await repo.listAgents(), accounts: await repo.accounts() };
}

async function sources(context = {}) {
  const cfg = await repo.getSettings();
  const c = caller(cfg, context);
  const list = await repo.listSources();
  const out = [];
  for (const s of list) {
    const br = await cleanroom.blastRadius(s.source_id);
    const items = [];
    for (const b of br.items) {
      items.push((await c.v.canView(b.issue_key)) ? b : { ...b, issue_key: perms.HIDDEN, prs: [] });
    }
    const { confirmed_by: confirmedBy, ...rest } = s;
    out.push({ ...rest, confirmedBy: await c.who(confirmedBy), confirmed_at: iso(s.confirmed_at),
      range: s.tainted_from_version ? rangeText(s) : null,
      findings: (await repo.findingsFor(s.source_id)).slice(0, 20).map(f => ({ ...f, found_at: iso(f.found_at) })),
      blastRadius: items });
  }
  return out;
}

async function history(context = {}) {
  const cfg = await repo.getSettings();
  const c = caller(cfg, context);
  const names = new Map((await repo.listAgents()).map(a => [a.agent_id, a.display_name]));
  return Promise.all((await repo.recentDecisionEvents(100)).map(async e => ({
    at: iso(e.at), agentId: e.agent_id, agent: names.get(e.agent_id) ?? e.agent_id, shapeId: e.shape_id,
    cause: await c.v.text(e.cause), before: safeJson(e.before_json), after: safeJson(e.after_json) })));
}

/** After a signal action: the view the action came from (evidence drawer or issue panel). */
function viewAfter(sig, payload, context) {
  if (payload?.view === "evidence" && payload.agentId && payload.shapeId) {
    return evidence({ agentId: payload.agentId, shapeId: payload.shapeId }, context);
  }
  return panel({ issueKey: sig.issue_key }, context);
}
async function signalFor(payload) {
  const sig = await repo.getSignal(payload?.signalId);
  if (!sig) throw new signals.UserError("Unknown signal.");
  return sig;
}

const LINK_TARGETS = new Set(["bitbucket", "confluence", "runner"]);
const linkTarget = t => { if (!LINK_TARGETS.has(t)) throw new signals.UserError("Unknown link target."); return t; };
/** Per-installation link (Bitbucket workspace, Confluence installation). Tests can swap the service. */
let linkService = null;
const link = () => linkService ?? require("../services/link");
const setLinkService = svc => { linkService = svc; };
const jobs = () => require("../jobs");

const DEFINITIONS = {
  getBoard: ({ context } = {}) => board(context),
  getEvidence: ({ payload, context }) => evidence(payload, context),
  getPanel: async ({ payload, context }) => {
    if (!(await ports.jira.userHas("BROWSE_PROJECTS", { issueKey: payload.issueKey }))) throw new Forbidden("You can't view this work item.");
    return panel(payload, context);
  },
  confirmCause: async ({ payload, context }) => {
    const sig = await signalFor(payload);
    await requireEdit(sig.issue_key);
    await signals.confirmCause(sig.signal_id, context.accountId);
    return viewAfter(sig, payload, context);
  },
  dismissCause: async ({ payload, context }) => {
    const sig = await signalFor(payload);
    await requireEdit(sig.issue_key);
    await signals.dismissCause(sig.signal_id, context.accountId);
    return viewAfter(sig, payload, context);
  },
  reopenDecision: async ({ payload, context }) => {
    await requireAdmin();
    const sig = await signalFor(payload);
    await signals.reopenDecision(sig.signal_id, context.accountId, payload.note);
    return viewAfter(sig, payload, context);
  },
  confirmShape: async ({ payload, context }) => {
    await requireEdit(payload.issueKey);
    const item = await repo.getItem(payload.issueKey);
    if (!item) throw new signals.UserError("Not tracked.");
    if (item.shape_state === "frozen") throw new signals.UserError("The shape froze when the window opened; it can't change now.");
    if (item.classified_by !== "llm") throw new signals.UserError("Only a shape chosen by the AI needs confirming.");
    const next = payload.shapeId ?? item.shape_id;
    // Confirming the AI's choice is an editor action; picking a different shape changes which record (and
    // level) applies, so it needs a Jira admin, and only shapes Lessel already knows are allowed.
    if (next !== item.shape_id) {
      await requireAdmin();
      if (!(await repo.getShape(next))) throw new signals.UserError(`Unknown shape ${next}.`);
    }
    await repo.patchItem(payload.issueKey, { shape_id: next, classified_by: "manual" });
    for (const p of await repo.prsForItem(payload.issueKey)) {
      if (p.classified_by === "llm") await repo.upsertPr({ ...p, shape_id: next, classified_by: "manual" });
    }
    await repo.logStaffAction({ actor: context.accountId, action: "set-shape", target: payload.issueKey,
      note: next === item.shape_id ? `confirmed ${next}` : `${item.shape_id} -> ${next}` });
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
  removeAccount: async ({ payload, context }) => {
    await requireAdmin();
    const id = repo.normAccount(payload.product, payload.accountId);
    const row = (await repo.accounts()).find(a => a.product === payload.product && a.account_id === id);
    if (!row) throw new signals.UserError("That account isn't mapped.");
    await repo.removeAccount(payload.product, payload.accountId);
    // The audit names the agent and the product, not the account id.
    await repo.logStaffAction({ actor: context.accountId, action: "remove-account", target: row.agent_id, note: `${row.product} account removed` });
    return settingsView();
  },
  setSuspended: async ({ payload, context }) => {
    await requireAdmin();
    await repo.setSuspended(payload.agentId, payload.suspended);
    await repo.logStaffAction({ actor: context.accountId, action: "suspend", target: payload.agentId, note: String(!!payload.suspended) });
    return settingsView();
  },
  getSources: async ({ context } = {}) => { await requireAdmin(); return sources(context); },   // quotes may come from restricted pages
  confirmTaint: async ({ payload, context }) => { await requireAdmin(); await cleanroom.confirmTaint(payload.sourceId, context.accountId, payload.fromVersion); return sources(context); },
  markFixed: async ({ payload, context }) => { await requireAdmin(); await cleanroom.markFixed(payload.sourceId, context.accountId, payload.cleanFromVersion); return sources(context); },
  quarantine: async ({ payload, context }) => { await requireAdmin(); await cleanroom.quarantine(payload.sourceId, context.accountId); return sources(context); },
  restoreClean: async ({ payload, context }) => { await requireAdmin(); await cleanroom.restoreClean(payload.sourceId, context.accountId); return sources(context); },
  getHistory: ({ context } = {}) => history(context),
  dismissTaint: async ({ payload, context }) => { await requireAdmin(); await cleanroom.dismissTaint(payload.sourceId, context.accountId); return sources(context); },
  scanHistory: async ({ payload }) => { await requireAdmin(); return jobs().enqueue({ type: "scan-history", pageId: payload.pageId }); },
  getReadiness: async () => { await requireAdmin(); return readiness(); },
  exportSnapshot: async () => { await requireAdmin(); return { json: JSON.stringify(await snapshot.exportSnapshot()) }; },
  /** Stage the pasted snapshot and import it on the job queue (a resolver call has a short time limit). */
  importSnapshot: async ({ payload, context }) => {
    await requireAdmin();
    let body;
    try {
      body = await snapshot.stageImport(payload?.json, { actor: context?.accountId ?? "staff", keyPrefix: payload?.keyPrefix || undefined });
    } catch (e) { throw new signals.UserError(e.message); }
    try {
      await jobs().enqueue(body, "import-snapshot");
    } catch (e) {
      await snapshot.abortStaged(`The import couldn't be queued: ${e.message}`);
      throw e;
    }
    return snapshot.importStatusView();
  },
  importStatus: async () => { await requireAdmin(); return snapshot.importStatusView(); },
  runJob: async ({ payload }) => {
    await requireAdmin();
    if (!["backfill", "migrate", "recompute-all"].includes(payload.type)) throw new Error("Unknown job.");
    return jobs().enqueue({ type: payload.type }, payload.type);
  },
  // Links between this (Jira) installation and Lessel's Bitbucket and Confluence installations.
  linkStatus: async () => { await requireAdmin(); return link().status(); },
  createPairingCode: async ({ payload, context }) => {
    await requireAdmin();
    const { code } = await link().createPairingCode(linkTarget(payload?.target), context.accountId);
    return { code, status: await link().status() };
  },
  unlink: async ({ payload, context }) => {
    await requireAdmin();
    await link().unlink(linkTarget(payload?.target), context.accountId);
    return link().status();
  },
  // Rendered in Lessel's Confluence installation (Confluence global settings), where Jira checks don't apply.
  confluenceLinkStatus: async () => { await requireConfluenceAdmin(); return link().confluenceStatus(); },
  pairConfluence: async ({ payload, context }) => {
    await requireConfluenceAdmin();
    const code = String(payload?.code ?? "").trim();
    if (!code) throw new signals.UserError("Paste the pairing code from Lessel's settings in Jira first.");
    await link().pairConfluence(code, context.accountId);
    return link().confluenceStatus();
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

module.exports = { uiResolver: uiResolverFactory(), DEFINITIONS, board, panel, evidence, history, sources, Forbidden,
  setLinkService };
