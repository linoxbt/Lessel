"use strict";
// decide() core and sentence() (spec §12.3). Pure: the caller loads the record, holds and context.

const { DEFAULTS } = require("./defaults");
const { emptyRecord } = require("./levels");

const SELF_MERGE_LABEL = { yes: "may self-merge", "if-green": "may self-merge once the build is green" };

/**
 * @param {object} p
 * @param {object} p.agent   { agent_id, display_name, suspended }
 * @param {object} p.shape   { shape_id, critical, classified_by, fallback }
 * @param {object} [p.rec]   record row, or null for no history
 * @param {Array}  p.holds   active derived holds
 * @param {object} p.ctx     { state: clean|warn|blocked, reason }
 * @param {boolean|null} p.buildGreen  null when there's no PR or the build wasn't checked
 */
function decideCore({ agent, shape, rec, holds = [], ctx = { state: "clean" }, buildGreen = null }, cfg = DEFAULTS) {
  const record = rec ?? emptyRecord();
  const out = { earned: record.earned_level, effective: record.earned_level, rec: record, holds, ctx,
    reasons: [], blocked: false, approvals: null, selfMerge: "no" };

  if (agent.suspended) return { ...out, blocked: true, reasons: ["Suspended by an admin."] };
  if (ctx.state === "blocked") return { ...out, blocked: true, reasons: [ctx.reason] };

  const probation = holds.find(h => h.kind === "probation");
  if (probation) {
    out.effective = Math.min(out.effective, 1);
    out.reasons.push(`Probation after ${probation.cause_ref}: ${probation.clean_needed} clean to go.`);
  }
  if (out.effective === 0) return { ...out, blocked: true, reasons: [...out.reasons, "L0: suggest only."] };

  out.approvals = cfg.approvalsByLevel[out.effective];

  if (out.effective === 3) {
    const no = [];
    if (shape.critical) no.push("critical service");
    if (holds.some(h => h.kind === "review")) no.push("a suspected signal is open");
    if (ctx.state === "warn") no.push(ctx.reason.replace(/\.$/, ""));
    if (shape.classified_by === "llm" || shape.fallback) no.push("shape not confirmed");
    if (no.length) out.reasons.push(`No self-merge: ${no.join("; ")}.`);
    else out.selfMerge = buildGreen === true ? "yes" : "if-green";
  }
  if (out.selfMerge === "yes") out.approvals = 0;
  return out;
}

/** True when the caller should check the build before finalizing. */
const needsBuildCheck = d => !d.blocked && d.selfMerge === "if-green";

function sentence(agent, shape, d) {
  const ev = d.rec.total === 0 ? "no confirmed outcomes yet"
    : `${d.rec.clean} of ${d.rec.total} clean, lower bound ${Math.round(d.rec.lower90 * 100)}%`;
  const lvl = d.effective === d.earned ? `L${d.earned}` : `earned L${d.earned}, effective L${d.effective}`;
  const parts = [`${agent.display_name} is ${lvl} on ${shape.shape_id} (${ev}).`, ...d.reasons];
  if (d.blocked) parts.push("This task is blocked.");
  else if (SELF_MERGE_LABEL[d.selfMerge]) parts.push(`It ${SELF_MERGE_LABEL[d.selfMerge]}.`);
  return parts.join(" ");
}

/** What the PR needs, in words, for PR comments and MCP. */
function needWords(d) {
  if (d.blocked) return "is blocked";
  if (d.selfMerge === "yes") return "may self-merge";
  return `needs ${d.approvals} human approval${d.approvals === 1 ? "" : "s"}`;
}

module.exports = { decideCore, needsBuildCheck, sentence, needWords };
