"use strict";
// Settings validation (one rule per key) and merging with the defaults. A setting that fails here is never
// stored: a bad value would otherwise surface much later, as a crash in an event handler.

const { DEFAULTS } = require("./defaults");
const { CLASSES } = require("./shape");

class SettingError extends Error {}

const isObj = v => v != null && typeof v === "object" && !Array.isArray(v);
const fail = (key, msg) => { throw new SettingError(`${key}: ${msg}`); };

function int(key, v, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) fail(key, `must be a whole number from ${min} to ${max}.`);
  return v;
}
function str(key, v, { max = 128, re = null, nullable = false } = {}) {
  if (v == null && nullable) return null;
  if (typeof v !== "string" || !v.trim() || v.length > max) fail(key, `must be a non-empty text of at most ${max} characters.`);
  if (re && !re.test(v)) fail(key, `“${v.slice(0, 40)}” isn't in the expected form.`);
  return v;
}
function list(key, v, item, { max = 50 } = {}) {
  if (!Array.isArray(v) || v.length > max) fail(key, `must be a list of at most ${max} entries.`);
  return v.map((x, i) => item(`${key}[${i}]`, x));
}
function onlyKeys(key, v, allowed) {
  if (!isObj(v)) fail(key, "must be an object.");
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(key, `unknown field “${k}” (allowed: ${allowed.join(", ")}).`);
  return v;
}
const fraction = (key, v) => { if (typeof v !== "number" || v < 0 || v > 1) fail(key, "must be a number from 0 to 1."); return v; };
const PROJECT = /^[A-Z][A-Z0-9_]{0,19}$/;
const NAME = /^[^\u0000-\u001f]{1,128}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const PATTERN = /^[A-Za-z0-9_./*{},@-]{1,200}$/;

const levelRule = (key, v) => {
  onlyKeys(key, v, ["lower", "n"]);
  return { lower: fraction(`${key}.lower`, v.lower), n: int(`${key}.n`, v.n, 1, 1000) };
};

/** Normalised value, or throws SettingError with a message an admin can act on. */
const RULES = {
  enforcementMode: (k, v) => (["advisory", "enforcing"].includes(v) ? v : fail(k, "must be \"advisory\" or \"enforcing\".")),
  approvalsByLevel: (k, v) => {
    onlyKeys(k, v, ["1", "2", "3"]);
    return Object.fromEntries(["1", "2", "3"].map(l => [l, int(`${k}.${l}`, v[l] ?? DEFAULTS.approvalsByLevel[l], 0, 10)]));
  },
  humanPrMinApprovals: (k, v) => int(k, v, 0, 10),
  levels: (k, v) => {
    onlyKeys(k, v, ["L3", "L2", "L0"]);
    const out = Object.fromEntries(["L3", "L2", "L0"].map(l => [l, levelRule(`${k}.${l}`, v[l] ?? DEFAULTS.levels[l])]));
    if (!(out.L3.lower >= out.L2.lower && out.L2.lower >= out.L0.lower)) fail(k, "thresholds must satisfy L3 ≥ L2 ≥ L0.");
    return out;
  },
  probationClean: (k, v) => int(k, v, 1, 50),
  probationMaxSeverity: (k, v) => int(k, v, 1, 5),
  windowHours: (k, v) => int(k, v, 1, 24 * 90),
  windowEnvironment: (k, v) => str(k, v, { max: 64, re: NAME }),
  suspectedExpiryHours: (k, v) => int(k, v, 1, 24 * 90),
  suspectedReminderHours: (k, v) => int(k, v, 1, 24 * 30),
  lateConfirmDays: (k, v) => int(k, v, 1, 365),
  suspectWindowHours: (k, v) => int(k, v, 1, 24 * 30),
  linkConfirms: (k, v) => (typeof v === "boolean" ? v : fail(k, "must be true or false.")),
  causedByLinkType: (k, v) => str(k, v, { re: NAME }),
  incidentProjects: (k, v) => list(k, v, (kk, x) => str(kk, x, { re: PROJECT })),
  bugIssueTypes: (k, v) => list(k, v, (kk, x) => str(kk, x, { re: NAME })),
  projectKeys: (k, v) => list(k, v, (kk, x) => str(kk, x, { re: PROJECT })),
  criticalServices: (k, v) => list(k, v, (kk, x) => str(kk, x, { max: 64, re: NAME })),
  severity: (k, v) => {
    onlyKeys(k, v, ["field", "map", "missing"]);
    const map = v.map ?? DEFAULTS.severity.map;
    if (!isObj(map)) fail(`${k}.map`, "must map values to severities 1–5.");
    return {
      field: str(`${k}.field`, v.field ?? DEFAULTS.severity.field, { max: 64, re: /^(?:[a-z][A-Za-z]*|customfield_\d+)$/ }),
      map: Object.fromEntries(Object.entries(map).map(([n, s]) => [str(`${k}.map`, n, { re: NAME }), int(`${k}.map.${n}`, s, 1, 5)])),
      missing: int(`${k}.missing`, v.missing ?? DEFAULTS.severity.missing, 1, 5),
    };
  },
  teamBaseline: (k, v) => {
    onlyKeys(k, v, ["minN", "minContributors"]);
    // People are never scored: a baseline needs at least three contributors (spec §11.4).
    return { minN: int(`${k}.minN`, v.minN ?? DEFAULTS.teamBaseline.minN, 1, 1000),
      minContributors: int(`${k}.minContributors`, v.minContributors ?? DEFAULTS.teamBaseline.minContributors, 3, 1000) };
  },
  repos: (k, v) => {
    if (!isObj(v)) fail(k, "must map repository UUIDs to their settings.");
    const out = {};
    for (const [uuid, rc] of Object.entries(v)) {
      const id = String(uuid).replace(/[{}]/g, "").toLowerCase();
      if (!/^[a-z0-9_-]{1,64}$/.test(id)) fail(k, `“${String(uuid).slice(0, 40)}” isn't a repository UUID.`);
      onlyKeys(`${k}.${id}`, rc, ["workspace", "deploys", "defaultService", "mainBranch"]);
      out[id] = {
        workspace: str(`${k}.${id}.workspace`, String(rc.workspace ?? "").replace(/[{}]/g, "").toLowerCase(), { max: 64, re: /^[a-z0-9_-]+$/ }),
        deploys: rc.deploys === undefined ? true : (typeof rc.deploys === "boolean" ? rc.deploys : fail(`${k}.${id}.deploys`, "must be true or false.")),
        ...(rc.defaultService != null ? { defaultService: str(`${k}.${id}.defaultService`, rc.defaultService, { max: 64, re: NAME }) } : {}),
        mainBranch: str(`${k}.${id}.mainBranch`, rc.mainBranch ?? "main", { max: 255, re: /^[^\s~^:?*[\\]+$/ }),
      };
    }
    return out;
  },
  servicePaths: (k, v) => list(k, v, (kk, x) => {
    onlyKeys(kk, x, ["pattern", "service"]);
    return { pattern: str(`${kk}.pattern`, x.pattern, { max: 200, re: PATTERN }), service: str(`${kk}.service`, x.service, { max: 64, re: NAME }) };
  }, { max: 200 }),
  classPaths: (k, v) => list(k, v, (kk, x) => {
    onlyKeys(kk, x, ["pattern", "cls"]);
    if (!CLASSES.includes(x.cls)) fail(`${kk}.cls`, `must be one of ${CLASSES.join(", ")}.`);
    return { pattern: str(`${kk}.pattern`, x.pattern, { max: 200, re: PATTERN }), cls: x.cls };
  }, { max: 200 }),
  graphQueries: (k, v) => {
    onlyKeys(k, v, ["incidents", "devChain"]);
    return { incidents: str(`${k}.incidents`, v.incidents ?? null, { max: 200, nullable: true }),
      devChain: str(`${k}.devChain`, v.devChain ?? null, { max: 200, nullable: true }) };
  },
  build: (k, v) => {
    onlyKeys(k, v, ["source", "statusKeys"]);
    const source = v.source ?? "pipelines";
    if (!["pipelines", "statuses"].includes(source)) fail(`${k}.source`, "must be \"pipelines\" or \"statuses\".");
    const statusKeys = list(`${k}.statusKeys`, v.statusKeys ?? [], (kk, x) => str(kk, x, { max: 128 }), { max: 20 });
    if (source === "statuses" && !statusKeys.length) fail(`${k}.statusKeys`, "list the build status keys that count when source is \"statuses\".");
    return { source, statusKeys };
  },
  importedSnapshot: (k, v) => (v === null || isObj(v) ? v : fail(k, "must be an object or null.")),
  ai: (k, v) => {
    // The endpoint and the name of the key variable are fixed in code: a setting must never be able to send
    // a secret to another host (audit S2).
    onlyKeys(k, v, ["provider", "llmScan", "qwen"]);
    const out = { provider: v.provider ?? DEFAULTS.ai.provider, llmScan: v.llmScan ?? DEFAULTS.ai.llmScan };
    if (!["qwen", "forge"].includes(out.provider)) fail(`${k}.provider`, "must be \"qwen\" or \"forge\".");
    if (!["suspect", "all", "off"].includes(out.llmScan)) fail(`${k}.llmScan`, "must be \"suspect\", \"all\" or \"off\".");
    if (v.qwen !== undefined) {
      // baseUrl and apiKeyEnv are accepted for older exports but never stored or used.
      onlyKeys(`${k}.qwen`, v.qwen, ["model", "reasoningEffort", "baseUrl", "apiKeyEnv"]);
      out.qwen = {
        ...(v.qwen.model !== undefined ? { model: str(`${k}.qwen.model`, v.qwen.model, { max: 100, re: /^[A-Za-z0-9._/:-]+$/ }) } : {}),
        ...(v.qwen.reasoningEffort !== undefined ? { reasoningEffort: ["low", "medium", "high"].includes(v.qwen.reasoningEffort)
          ? v.qwen.reasoningEffort : fail(`${k}.qwen.reasoningEffort`, "must be low, medium or high.") } : {}),
      };
    }
    return out;
  },
  cleanRoom: (k, v) => {
    onlyKeys(k, v, ["quarantineLabel", "quarantineGroup", "confluenceSpaces", "jiraProjects", "allowedDomains"]);
    const d = DEFAULTS.cleanRoom;
    return {
      quarantineLabel: str(`${k}.quarantineLabel`, v.quarantineLabel ?? d.quarantineLabel, { max: 64, re: /^[a-z0-9_-]+$/ }),
      quarantineGroup: str(`${k}.quarantineGroup`, v.quarantineGroup ?? d.quarantineGroup, { re: NAME, nullable: true }),
      confluenceSpaces: list(`${k}.confluenceSpaces`, v.confluenceSpaces ?? d.confluenceSpaces, (kk, x) => str(kk, x, { max: 255, re: /^[A-Za-z0-9~_-]+$/ })),
      jiraProjects: list(`${k}.jiraProjects`, v.jiraProjects ?? d.jiraProjects, (kk, x) => str(kk, x, { re: PROJECT })),
      allowedDomains: list(`${k}.allowedDomains`, v.allowedDomains ?? d.allowedDomains, (kk, x) => str(kk, String(x).toLowerCase(), { max: 253, re: HOST })),
    };
  },
};

/** Validate and normalise one setting. */
function validateSetting(key, value) {
  if (typeof key !== "string" || !Object.hasOwn(DEFAULTS, key) || !Object.hasOwn(RULES, key)) throw new SettingError(`Unknown setting ${String(key).slice(0, 64)}.`);
  const out = RULES[key](key, value);
  if (JSON.stringify(out).length > 4000) throw new SettingError(`${key}: the value is too large (4,000 characters at most).`);
  return out;
}

/** Defaults with stored overrides, merged per field for nested objects (lists and maps replace). */
function mergeSetting(def, stored) {
  if (!isObj(def) || !isObj(stored)) return stored;
  const out = { ...def };
  for (const [k, v] of Object.entries(stored)) out[k] = isObj(def[k]) && isObj(v) && !MAP_LIKE.has(k) ? mergeSetting(def[k], v) : v;
  return out;
}
// Objects that are maps of user keys: a stored value replaces the default instead of adding to it.
const MAP_LIKE = new Set(["map"]);

module.exports = { validateSetting, mergeSetting, SettingError, RULES };
