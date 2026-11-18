"use strict";
// Jira key extraction for PRs (spec §14.1): branch first, then title, configured projects only.

const KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/g;

function keysIn(text, projectKeys) {
  const allowed = projectKeys instanceof Set ? projectKeys : new Set(projectKeys);
  const out = [];
  for (const [k] of String(text || "").matchAll(KEY)) {
    if (allowed.has(k.slice(0, k.lastIndexOf("-")))) out.push(k);
  }
  return out;
}

function keyFromPr(pr, projectKeys) {
  for (const text of [pr?.source?.branch?.name, pr?.title]) {
    const [first] = keysIn(text, projectKeys);
    if (first) return first;
  }
  return null;
}

/** "This reverts commit <sha>" → sha (full or abbreviated). */
function revertedSha(message) {
  const m = String(message || "").match(/This reverts commit ([0-9a-f]{7,40})/i);
  return m ? m[1].toLowerCase() : null;
}

module.exports = { keyFromPr, keysIn, revertedSha };
