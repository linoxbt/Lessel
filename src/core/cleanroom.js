"use strict";
// Clean Room rules (spec §13): version-aware ranges, declaration checks, excusal, context status.

const TAINTED_STATES = new Set(["confirmed", "quarantined", "restored"]);
const t = v => (v == null ? null : new Date(v).getTime());

/** Closed taint episodes of a source: [[from, cleanFrom], ...] (stored as JSON). */
function pastRanges(source) {
  if (!source?.past_ranges) return [];
  try {
    const list = typeof source.past_ranges === "string" ? JSON.parse(source.past_ranges) : source.past_ranges;
    return Array.isArray(list) ? list.filter(r => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1])) : [];
  } catch { return []; }
}

/**
 * Is `version` of `source` inside a tainted range? The current episode counts while the source is in a tainted
 * state; closed episodes (a page fixed, then poisoned again) were confirmed by a person and always count.
 */
function inTaintedRange(version, source) {
  if (version == null) return false;
  if (pastRanges(source).some(([from, clean]) => version >= from && version < clean)) return true;
  if (!TAINTED_STATES.has(source.state)) return false;
  if (source.tainted_from_version == null) return false;
  if (version < source.tainted_from_version) return false;
  return source.clean_from_version == null || version < source.clean_from_version;
}

const oneRange = (from, clean) => (clean == null ? `v${from} onwards` : `v${from}–v${clean - 1}`);
const rangeText = s => [...pastRanges(s).map(([f, c]) => oneRange(f, c)),
  ...(s.tainted_from_version != null ? [oneRange(s.tainted_from_version, s.clean_from_version)] : [])].join(", ") || "none";

/**
 * Consistency checks for a declaration (§13.2). Returns the basis, version and flag to store.
 * versionAtRead: the page version current at readAt (or at `now` when no readAt), null if unknown.
 */
function checkDeclaration({ sourceVersion, readAt, now, versionAtRead, notBefore = null }) {
  let basis = sourceVersion != null ? "declared" : readAt ? "resolved" : "inferred";
  let flag = null;
  if (readAt && t(readAt) > t(now)) { flag = "read-in-future"; basis = "inferred"; }
  // A read can't predate the work it supposedly informed (back-dating to claim an old, tainted version).
  if (readAt && notBefore && t(readAt) < t(notBefore)) { flag = flag ?? "read-before-assignment"; basis = "inferred"; }
  if (versionAtRead == null) { flag = flag ?? "unknown-version"; basis = "inferred"; }
  let version = sourceVersion ?? versionAtRead ?? null;
  if (sourceVersion != null && versionAtRead != null && sourceVersion > versionAtRead) {
    flag = flag ?? "version-after-read"; basis = "inferred";
  }
  return { basis, version, flag };
}

/**
 * Reads that excuse a confirmed failure (§13.3).
 * rows: context_reads joined with their source ({ ...read, source: {...} })
 * item: { agent_id, merged_at }
 */
function excusingReads(rows, item) {
  return rows.filter(r =>
    r.agent_id === item.agent_id &&
    r.method === "attested" &&
    r.flag == null &&
    (r.version_basis === "declared" || r.version_basis === "resolved") &&
    item.merged_at != null && t(r.recorded_at) <= t(item.merged_at) &&
    inTaintedRange(r.source_version, r.source));
}

/** Any read (late, inferred or flagged) inside a tainted range: a human should look. */
function possibleBadInput(rows) {
  return rows.some(r => inTaintedRange(r.source_version, r.source));
}

/** Context status for a work item (§13.4): blocked > warn > clean. */
function contextStatus(rows) {
  let warn = null;
  for (const r of rows) {
    const s = r.source;
    const title = s.title || s.url || s.source_id;
    if (inTaintedRange(r.source_version, s)) {
      if (r.version_basis !== "inferred" && r.flag == null)
        return { state: "blocked", source_id: s.source_id,
          reason: `Context: ${title} v${r.source_version} is inside the tainted range ${rangeText(s)}.` };
      warn = warn ?? { state: "warn", source_id: s.source_id,
        reason: `Context: ${title} may have been read at a tainted version.` };
    } else if (s.state === "suspect") {
      warn = warn ?? { state: "warn", source_id: s.source_id, reason: `Context: ${title} is under taint review.` };
    }
  }
  return warn ?? { state: "clean", reason: null };
}

/** check-context answer for one source and the caller's effective level (§13.5). */
function contextGate(source, level, version = null) {
  const title = source.title || source.url;
  if (source.state === "suspect") return { verdict: "blocked", reason: `${title} is under taint review.` };
  if (TAINTED_STATES.has(source.state)) {
    if (version != null && !inTaintedRange(version, source)) return { verdict: "safe", reason: `v${version} is outside the tainted range ${rangeText(source)}.` };
    if (source.clean_from_version != null && version == null)
      return { verdict: "warn", reason: `${title} was tainted (${rangeText(source)}); use v${source.clean_from_version} or later.` };
    return { verdict: "blocked", reason: `${title} is tainted (${rangeText(source)}).` };
  }
  if (source.state === "unscanned") {
    return level >= 2 ? { verdict: "warn", reason: `${title} hasn't been scanned yet.` }
      : { verdict: "blocked", reason: `At L${level} you may only use scanned, clean sources; ${title} hasn't been scanned.` };
  }
  if (version != null && inTaintedRange(version, source)) return { verdict: "blocked", reason: `${title} v${version} was tainted (${rangeText(source)}).` };
  return { verdict: "safe", reason: `${title} is clean.` };
}

module.exports = { TAINTED_STATES, pastRanges, inTaintedRange, rangeText, checkDeclaration, excusingReads, possibleBadInput,
  contextStatus, contextGate };
