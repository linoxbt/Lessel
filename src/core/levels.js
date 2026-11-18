"use strict";
const { lowerBound } = require("./beta");
const { DEFAULTS } = require("./defaults");

/** Earned level from the lower bound and sample size (spec §11.1). */
function earnedLevel(lower, n, levels = DEFAULTS.levels) {
  if (lower >= levels.L3.lower && n >= levels.L3.n) return 3;
  if (lower >= levels.L2.lower && n >= levels.L2.n) return 2;
  if (lower < levels.L0.lower && n >= levels.L0.n) return 0;
  return 1;
}

/** Record for (subject, shape) from scored outcomes. Excused, pending and unscored are not counted. */
function recordFromOutcomes(outcomes, levels = DEFAULTS.levels) {
  const clean = outcomes.filter(o => o === "clean").length;
  const total = clean + outcomes.filter(o => o === "failed").length;
  const lower90 = lowerBound(clean, total);
  return { clean, total, lower90, earned_level: earnedLevel(lower90, total, levels) };
}

function emptyRecord() {
  return { clean: 0, total: 0, lower90: lowerBound(0, 0), earned_level: 1 };
}

module.exports = { earnedLevel, recordFromOutcomes, emptyRecord };
