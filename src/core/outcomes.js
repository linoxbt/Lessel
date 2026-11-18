"use strict";
// Outcome rules (spec §10) and derived holds (spec §11.3). Pure functions over plain rows.

const { DEFAULTS } = require("./defaults");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const t = v => (v == null ? null : new Date(v).getTime());

/** Item outcome from its signals and window. */
function deriveOutcome(item, signals, now = Date.now()) {
  if (item.actor_kind === "mixed") return "unscored";
  const states = signals.map(s => s.causality);
  if (states.includes("confirmed")) return "failed";
  if (states.includes("excused")) return "excused";
  const end = t(item.window_ends);
  if (end == null || t(now) < end) return "pending";
  if (states.includes("suspected")) return "pending";
  return "clean";
}

/** Window end for an item once it has a window start (deploy, or merge if the repo doesn't deploy). */
function windowEnds(startedAt, cfg = DEFAULTS) {
  return new Date(t(startedAt) + cfg.windowHours * HOUR);
}

/** True when an undecided suspected signal should expire to dismissed (§10.4). */
function suspectedExpired(signal, item, now = Date.now(), cfg = DEFAULTS) {
  if (signal.causality !== "suspected") return false;
  const end = t(item.window_ends);
  return end != null && t(now) > end + cfg.suspectedExpiryHours * HOUR;
}

/** A cause can be confirmed up to lateConfirmDays after the window started (§10.4). */
function canConfirm(item, now = Date.now(), cfg = DEFAULTS) {
  const start = t(item.deployed_at) ?? t(item.merged_at);
  if (start == null) return true;
  return t(now) <= start + cfg.lateConfirmDays * DAY;
}

/** Initial causality of an incident link (§10.3). */
function incidentCausality({ item, incidentCreatedAt, incidentService, shapeService, viaCausedByLink }, cfg = DEFAULTS) {
  if (viaCausedByLink && cfg.linkConfirms) return "confirmed";
  const dep = t(item.deployed_at);
  const at = t(incidentCreatedAt);
  if (dep != null && at != null && at >= dep && at - dep <= cfg.suspectWindowHours * HOUR &&
      incidentService && incidentService === shapeService) return "suspected";
  return "associated";
}

/** Severity 1..4 from issue fields (§10.3). */
function severityOf(fields, cfg = DEFAULTS) {
  const { field, map, missing } = cfg.severity;
  const raw = fields?.[field];
  const name = raw && typeof raw === "object" ? (raw.name ?? raw.value) : raw;
  return map[name] ?? missing;
}

/**
 * Holds for one (agent, shape), derived from scratch (§11.3).
 * items:   items scored to (agent, shape): { issue_key, outcome, merged_at }
 * signals: signals on those items: { signal_id, issue_key, kind, ref, severity, causality, decided_at }
 */
function deriveHolds({ agentId, shapeId, items, signals }, cfg = DEFAULTS) {
  const holds = [];
  for (const s of signals) {
    if (s.kind !== "incident" || s.causality !== "confirmed") continue;
    if (s.severity == null || s.severity > cfg.probationMaxSeverity) continue;
    const at = t(s.decided_at);
    const cleanAfter = items.filter(i => i.outcome === "clean" && t(i.merged_at) > at).length;
    if (cleanAfter >= cfg.probationClean) continue;
    holds.push({
      hold_id: `probation:${agentId}:${shapeId}:${s.signal_id}`,
      agent_id: agentId, shape_id: shapeId, kind: "probation",
      cause_signal_id: s.signal_id, cause_ref: s.ref,
      clean_needed: cfg.probationClean - cleanAfter,
      reason: `Confirmed sev ${s.severity} incident ${s.ref}.`,
    });
  }
  for (const s of signals) {
    if (s.causality !== "suspected") continue;
    holds.push({
      hold_id: `review:${agentId}:${shapeId}:${s.signal_id}`,
      agent_id: agentId, shape_id: shapeId, kind: "review",
      cause_signal_id: s.signal_id, cause_ref: s.ref ?? s.issue_key, clean_needed: null,
      reason: `Open suspected ${s.kind} on ${s.issue_key}.`,
    });
  }
  return holds;
}

module.exports = { deriveOutcome, windowEnds, suspectedExpired, canConfirm, incidentCausality, severityOf,
  deriveHolds, HOUR, DAY };
