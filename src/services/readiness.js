"use strict";
// Setup check for the settings page: configuration plus a few live Jira checks, each with one plain sentence.
// Status: ok | warn | fail | manual (can't be checked from the app) | info.

const repo = require("../db/repo");
const { ports } = require("../ports");
const { DEFAULTS } = require("../core/defaults");

const item = (id, title, status, detail) => ({ id, title, status, detail });

async function live(fn, fallback) {
  try { return await fn(); } catch (e) { return fallback(e); }
}

async function readiness() {
  const cfg = await repo.getSettings();
  const out = [];

  // Agents and their three accounts
  const agents = await repo.listAgents();
  const accounts = await repo.accounts();
  if (!agents.length) out.push(item("agents", "Agents", "fail", "No agents yet. Add Atlas and Brook and map their accounts."));
  for (const a of agents) {
    const has = p => accounts.some(x => x.agent_id === a.agent_id && x.product === p);
    const missing = ["jira", "bitbucket", "mcp"].filter(p => !has(p));
    out.push(item(`agent:${a.agent_id}`, `${a.display_name}'s accounts`,
      missing.length === 0 ? "ok" : missing.includes("jira") || missing.includes("bitbucket") ? "fail" : "warn",
      missing.length ? `Missing ${missing.join(", ")} account${missing.length > 1 ? "s" : ""}.` : "Jira, Bitbucket and MCP accounts mapped."));
  }

  // Projects (live)
  for (const [setting, label] of [["projectKeys", "Tracked projects"], ["incidentProjects", "Incident projects"]]) {
    const keys = cfg[setting] ?? [];
    if (!keys.length) { out.push(item(setting, label, "fail", `${setting} is empty.`)); continue; }
    const missing = [];
    for (const k of keys) if (!(await live(() => ports.jira.getProject(k), () => ({ unknown: true })))) missing.push(k);
    out.push(item(setting, label, missing.length ? "fail" : "ok",
      missing.length ? `Not found on this site: ${missing.join(", ")}.` : `${keys.join(", ")} found.`));
  }

  // Caused-by link type (live)
  const linkTypes = await live(() => ports.jira.listLinkTypes(), () => null);
  if (linkTypes === null) out.push(item("linkType", "Caused-by link type", "warn", "Couldn't read link types from Jira."));
  else {
    const want = cfg.causedByLinkType;
    const found = linkTypes.some(l => [l.name, l.inward, l.outward].includes(want));
    out.push(item("linkType", "Caused-by link type", found ? "ok" : "fail",
      found ? `"${want}" exists.` : `No link type named "${want}". Set causedByLinkType to one of: ${linkTypes.map(l => l.name).join(", ")}.`));
  }

  // Severity field (live when it's a custom field)
  const field = cfg.severity?.field ?? "priority";
  if (field === "priority") out.push(item("severity", "Severity source", "ok", "Using Priority."));
  else {
    const fields = await live(() => ports.jira.listFields(), () => null);
    const found = fields?.some(f => f.id === field || f.key === field);
    out.push(item("severity", "Severity source", fields === null ? "warn" : found ? "ok" : "fail",
      fields === null ? "Couldn't read fields from Jira." : found ? `Field ${field} exists.` : `No field ${field} on this site.`));
  }

  // Repos
  const repos = Object.entries(cfg.repos ?? {});
  out.push(item("repos", "Repositories", repos.length ? (repos.every(([, r]) => r.workspace) ? "ok" : "warn") : "warn",
    repos.length ? `${repos.length} configured${repos.some(([, r]) => !r.workspace) ? "; some have no workspace (backfill skips them)" : ""}.`
      : "No repos configured: windows open at merge, and backfill has nothing to read."));

  // AI provider
  const ai = { ...DEFAULTS.ai, ...(cfg.ai ?? {}) };
  if (ai.provider === "qwen") {
    const env = ai.qwen?.apiKeyEnv ?? "FORTYTWO_API_KEY";
    out.push(item("ai", "AI provider", process.env[env] ? "ok" : "warn",
      process.env[env] ? `Qwen (${ai.qwen.model}) via ${ai.qwen.baseUrl}.` : `Qwen is selected but ${env} isn't set: run forge variables set --encrypt ${env} ...`));
  } else {
    out.push(item("ai", "AI provider", "ok", "Forge LLMs (Atlassian-hosted)."));
  }

  // Teamwork Graph, Clean Room scope
  const gq = cfg.graphQueries ?? {};
  out.push(item("graph", "Teamwork Graph queries", gq.incidents && gq.devChain ? "ok" : "warn",
    gq.incidents && gq.devChain ? "Both saved queries registered." : "Run scripts/register-graph-queries.js and save the keys in graphQueries."));
  out.push(item("cleanRoom", "Clean Room scope", cfg.cleanRoom?.confluenceSpaces?.length ? "ok" : "warn",
    cfg.cleanRoom?.confluenceSpaces?.length ? `Scanning ${cfg.cleanRoom.confluenceSpaces.join(", ")}.` : "No Confluence spaces in scope."));

  // Mode and window (information)
  out.push(item("mode", "Enforcement mode", "info",
    cfg.enforcementMode === "enforcing" ? "Enforcing: decisions block merges." : "Advisory: nothing is blocked yet."));
  out.push(item("window", "Observation window", "info",
    cfg.windowHours === DEFAULTS.windowHours ? "14 days (default)." : `${cfg.windowHours / 24} days (labelled on screen as a demo setting).`));
  if (cfg.importedSnapshot) out.push(item("snapshot", "Imported history", "info", `Snapshot exported ${cfg.importedSnapshot.exportedAt.slice(0, 10)}.`));

  // Things only a human can check
  out.push(item("bitbucket", "Bitbucket branch rules", "manual",
    "On gated branches: native minimum approvals 0, Lessel check Required (Premium), reset approvals on source change."));
  out.push(item("validators", "Jira validators", "manual",
    "Add \"Lessel ready-to-merge check\" (and optionally \"Lessel agent start check\") to your workflow transitions."));
  out.push(item("mcp", "External MCP access", "manual",
    "Enable it for Lessel in Atlassian Administration → Apps → Sites → Connected apps."));

  return out;
}

module.exports = { readiness };
