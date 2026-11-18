"use strict";
// Signal lifecycle: confirm, dismiss, reopen, expire, excuse (spec §10.4, §13.3).

const repo = require("../db/repo");
const { ports } = require("../ports");
const { refreshItem, recompute, recomputeTeam } = require("./recompute");
const { shapeSummary } = require("./decide");
const { notifyDecisionChange } = require("./notify");
const { canConfirm, suspectedExpired } = require("../core/outcomes");
const { excusingReads } = require("../core/cleanroom");

class UserError extends Error {}

/** After any signal change on an item: refresh outcome, recompute, notify if the decision changed. */
async function afterItemChange(issueKey, cause, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const item = await refreshItem(issueKey, cfg);
  if (!item) return;
  if (item.actor_kind === "team") { await recomputeTeam(item.shape_id, cfg); return; }
  if (item.actor_kind !== "agent" || !item.agent_id) return;
  const agent = await repo.getAgent(item.agent_id);
  if (!agent) return;
  const before = await shapeSummary(agent, item.shape_id, cfg);
  await recompute(agent.agent_id, item.shape_id, cfg);
  const after = await shapeSummary(agent, item.shape_id, cfg);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await notifyDecisionChange(agent, item.shape_id, before, after, cause, cfg);
  }
}

function describe(sig, issueKey) {
  switch (sig.kind) {
    case "incident": return `${sig.ref} was confirmed as caused by ${issueKey}`;
    case "bug": return `bug ${sig.ref} was confirmed as caused by ${issueKey}`;
    case "revert": return `${issueKey} was reverted (${String(sig.ref).slice(0, 10)})`;
    case "reopen": return `${issueKey} was reopened`;
    default: return `a signal on ${issueKey} changed`;
  }
}

/** Clean Room: a confirmed failure with a timely tainted read becomes excused. Returns the source id or null. */
async function maybeExcuse(signalId) {
  const sig = await repo.getSignal(signalId);
  if (!sig || sig.causality !== "confirmed") return null;
  const item = await repo.getItem(sig.issue_key);
  if (!item) return null;
  const hits = excusingReads(await repo.readsForItem(sig.issue_key), item);
  if (!hits.length) return null;
  const src = hits[0].source;
  await repo.setCausality(signalId, "excused", { by: "lessel:clean-room", via: `source:${src.source_id}`, from: ["confirmed"] });
  return src;
}

async function confirmCause(signalId, actor, { via = "button", cfg } = {}) {
  cfg = cfg ?? await repo.getSettings();
  const sig = await repo.getSignal(signalId);
  if (!sig) throw new UserError("Unknown signal.");
  const item = await repo.getItem(sig.issue_key);
  if (item && !canConfirm(item, ports.now(), cfg)) throw new UserError(`Too late: causes can be confirmed up to ${cfg.lateConfirmDays} days after deployment.`);
  const ok = await repo.setCausality(signalId, "confirmed", { by: actor, via, from: ["associated", "suspected", "dismissed"] });
  if (!ok) throw new UserError(`This signal is already ${sig.causality}.`);
  await repo.logStaffAction({ actor, action: "confirm", target: signalId, rev: sig.rev + 1 });
  const src = await maybeExcuse(signalId);
  const fresh = await repo.getSignal(signalId);
  const text = src ? `${describe(sig, sig.issue_key)} but excused: bad input from ${src.title || src.url}` : describe(sig, sig.issue_key);
  await afterItemChange(sig.issue_key, { id: signalId, rev: fresh.rev, text }, cfg);
  return fresh;
}

async function dismissCause(signalId, actor, { cfg } = {}) {
  const sig = await repo.getSignal(signalId);
  if (!sig) throw new UserError("Unknown signal.");
  const ok = await repo.setCausality(signalId, "dismissed", { by: actor, from: ["associated", "suspected"] });
  if (!ok) throw new UserError(`This signal is ${sig.causality}; an admin can reopen the decision.`);
  await repo.logStaffAction({ actor, action: "dismiss", target: signalId, rev: sig.rev + 1 });
  const fresh = await repo.getSignal(signalId);
  await afterItemChange(sig.issue_key, { id: signalId, rev: fresh.rev, text: `${sig.ref ?? sig.kind} was dismissed as a cause of ${sig.issue_key}` }, cfg);
  return fresh;
}

/** Admin: put a decided signal back to associated (audited, note required). Also how rehearsals reset. */
async function reopenDecision(signalId, actor, note, { cfg } = {}) {
  if (!note || !String(note).trim()) throw new UserError("A note is required to reopen a decision.");
  const sig = await repo.getSignal(signalId);
  if (!sig) throw new UserError("Unknown signal.");
  const ok = await repo.setCausality(signalId, "associated", { by: actor, from: ["confirmed", "dismissed", "excused"] });
  if (!ok) throw new UserError(`This signal is ${sig.causality}; nothing to reopen.`);
  await repo.logStaffAction({ actor, action: "reopen", target: signalId, note: String(note).slice(0, 500), rev: sig.rev + 1 });
  const fresh = await repo.getSignal(signalId);
  await afterItemChange(sig.issue_key, { id: signalId, rev: fresh.rev, text: `the decision on ${sig.ref ?? sig.kind} was reopened` }, cfg);
  return fresh;
}

/** Caused-by link deleted: undo a confirmation that came from it. */
async function revertLinkConfirmation(linkId, cfg) {
  for (const sig of await repo.signalsByVia(`link:${linkId}`)) {
    if (sig.causality !== "confirmed" && sig.causality !== "excused") continue;
    await repo.setCausality(sig.signal_id, "associated", { by: `link:${linkId}`, via: null });
    const fresh = await repo.getSignal(sig.signal_id);
    await afterItemChange(sig.issue_key, { id: sig.signal_id, rev: fresh.rev, text: `the caused-by link for ${sig.ref} was removed` }, cfg);
  }
}

/** Hourly: suspected signals nobody decided expire to dismissed. */
async function expireSuspected(cfg) {
  cfg = cfg ?? await repo.getSettings();
  let n = 0;
  for (const sig of await repo.openSuspected()) {
    const item = await repo.getItem(sig.issue_key);
    if (!item || !suspectedExpired(sig, item, ports.now(), cfg)) continue;
    if (await repo.setCausality(sig.signal_id, "dismissed", { by: "lessel:expired", from: ["suspected"] })) {
      n++;
      const fresh = await repo.getSignal(sig.signal_id);
      await afterItemChange(sig.issue_key, { id: sig.signal_id, rev: fresh.rev, text: `the suspected ${sig.kind} on ${sig.issue_key} expired undecided` }, cfg);
    }
  }
  return n;
}

/** Hourly: comment on the work item once, shortly before an undecided suspected signal expires. */
async function remindSuspected(cfg) {
  cfg = cfg ?? await repo.getSettings();
  const now = ports.now().getTime();
  let n = 0;
  for (const sig of await repo.openSuspected()) {
    const item = await repo.getItem(sig.issue_key);
    if (!item?.window_ends) continue;
    const expiresAt = item.window_ends.getTime() + cfg.suspectedExpiryHours * 3600e3;
    if (now < expiresAt - cfg.suspectedReminderHours * 3600e3 || now >= expiresAt) continue;
    const fresh = await repo.insertDecisionEvent({ event_id: `remind:${sig.signal_id}:r${sig.rev}`.slice(0, 255),
      agent_id: item.agent_id ?? "team", shape_id: item.shape_id, before: {}, after: {}, cause: `reminder for ${sig.signal_id}` });
    if (!fresh) continue;
    const when = new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ");
    try {
      await ports.jira.addComment(sig.issue_key, `Lessel: ${sig.kind} ${sig.ref ?? ""} is suspected of being caused by this work item. ` +
        `Confirm or dismiss it in the Lessel panel by ${when} UTC, or it expires as dismissed.`.replace(/\s+/g, " "));
      n++;
    } catch (e) {
      console.warn(`Reminder comment failed on ${sig.issue_key}: ${e.message}`);
    }
  }
  return n;
}

/** Re-check excusal for confirmed signals on items that read a source (after a taint is confirmed or its range changes). */
async function reexcuseForSource(sourceId, cfg) {
  const reads = await repo.readsForSource(sourceId);
  const keys = [...new Set(reads.map(r => r.issue_key))];
  for (const key of keys) {
    const item = await repo.getItem(key);
    for (const sig of await repo.signalsForItem(key)) {
      if (sig.causality === "confirmed") {
        const src = await maybeExcuse(sig.signal_id);
        if (src) {
          const fresh = await repo.getSignal(sig.signal_id);
          await afterItemChange(key, { id: sig.signal_id, rev: fresh.rev, text: `${describe(sig, key)} but excused: bad input from ${src.title || src.url}` }, cfg);
        }
      } else if (sig.causality === "excused" && item) {
        // The range narrowed or the taint was dismissed: if no timely tainted read remains, the failure counts again.
        if (excusingReads(await repo.readsForItem(key), item).length) continue;
        if (await repo.setCausality(sig.signal_id, "confirmed", { by: "lessel:clean-room", via: `unexcused:${sourceId}`, from: ["excused"] })) {
          const fresh = await repo.getSignal(sig.signal_id);
          await afterItemChange(key, { id: sig.signal_id, rev: fresh.rev,
            text: `${describe(sig, key)}: the excusal was withdrawn because the source is no longer tainted at the version read` }, cfg);
        }
      }
    }
  }
  return keys;
}

module.exports = { UserError, afterItemChange, maybeExcuse, confirmCause, dismissCause, reopenDecision,
  revertLinkConfirmation, expireSuspected, remindSuspected, reexcuseForSource, describe };
