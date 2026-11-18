"use strict";
// Task shapes: service / change class (spec §9).

const RISK_ORDER = ["schema-migration", "config-infra", "api-contract", "business-logic",
  "refactor", "dependency-bump", "test-fix", "docs-copy"];
const ONLY = new Set(["dependency-bump", "test-fix", "docs-copy"]);
const CLASSES = [...RISK_ORDER];

const globCache = new Map();
/** Minimal glob: `**` spans directories, `*` stays inside one segment. `a/**` also matches `a` itself. */
function globToRegex(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      re += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const rx = new RegExp(`^${re}$`);
  globCache.set(glob, rx);
  return rx;
}
const matches = (glob, path) => globToRegex(glob).test(path);

/** Literal prefix of a glob, e.g. "services/ledger/" for "services/ledger/**". */
function literalPrefix(glob) {
  const i = glob.search(/[*?]/);
  return i === -1 ? glob : glob.slice(0, i);
}

/** Service for one path: longest matching pattern wins. Returns { service, root } or null. */
function serviceForPath(path, servicePaths) {
  let best = null;
  for (const rule of servicePaths) {
    if (!matches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length) best = rule;
  }
  return best ? { service: best.service, root: literalPrefix(best.pattern) } : null;
}

/** Service for a PR: the most critical service touched, then alphabetical (§9.1). */
function serviceForPaths(paths, { servicePaths, criticalServices = [], fallback = null }) {
  const found = new Set();
  for (const p of paths) {
    const s = serviceForPath(p, servicePaths);
    if (s) found.add(s.service);
  }
  if (!found.size) return fallback;
  const critical = new Set(criticalServices);
  return [...found].sort((a, b) => (critical.has(b) - critical.has(a)) || a.localeCompare(b))[0];
}

/** Change class for one path, matched inside its service directory (or the repo root). */
function classForPath(path, { servicePaths, classPaths }) {
  const svc = serviceForPath(path, servicePaths);
  const rel = svc && path.startsWith(svc.root) ? path.slice(svc.root.length) : path;
  for (const rule of classPaths) if (matches(rule.pattern, rel)) return rule.cls;
  return null;
}

/**
 * Risk-ordered class for a PR (§9.3):
 * 1. riskiest any-match class wins; unmatched files don't change that;
 * 2. else, if every file matched an "only" class, the riskiest of those;
 * 3. else null (LLM fallback, never inside the merge check).
 */
function classFromPaths(paths, rules) {
  const hits = paths.map(p => classForPath(p, rules));
  const matched = new Set(hits.filter(Boolean));
  const anyMatch = RISK_ORDER.find(c => matched.has(c) && !ONLY.has(c));
  if (anyMatch) return anyMatch;
  if (hits.length && hits.every(h => h && ONLY.has(h))) return RISK_ORDER.find(c => matched.has(c));
  return null;
}

/** Riskier of two classes. */
function riskier(a, b) {
  if (!a) return b;
  if (!b) return a;
  return RISK_ORDER.indexOf(a) <= RISK_ORDER.indexOf(b) ? a : b;
}

const shapeId = (service, cls) => `${service}/${cls}`;

module.exports = { RISK_ORDER, CLASSES, ONLY, globToRegex, matches, serviceForPath, serviceForPaths,
  classForPath, classFromPaths, riskier, shapeId };
