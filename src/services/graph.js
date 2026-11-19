"use strict";
// Teamwork Graph integration (spec §10.5), run as the viewing user from the panel and evidence drawer:
// incidents the graph links to a work item become "associated" signals (never confirmed: a link isn't proof),
// and the dev chain (commits → PRs → deployments) is shown as evidence.

const repo = require("../db/repo");
const { ports } = require("../ports");
const { recordLinkedIssue } = require("../events/jira");

/** Sync graph-linked incidents into signals. Returns { incidents, added } or { error }. */
async function syncIncidents({ issueKey, cloudId }, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const queryKey = cfg.graphQueries?.incidents;
  if (!queryKey || !cloudId) return { skipped: "Teamwork Graph queries aren't registered yet." };
  // At most once per item every 10 minutes: the panel loads often, and the graph changes slowly.
  const bucket = Math.floor(ports.now().getTime() / 600e3);
  if (!(await repo.claimOnce(`graph:${issueKey}:${bucket}`))) return { skipped: "Checked Teamwork Graph in the last 10 minutes." };
  try {
    const work = await ports.jira.getIssue(issueKey, ["summary", "project"]);
    if (!work) return { incidents: [], added: [] };
    const incidents = await ports.graph.incidentsFor({ queryKey, cloudId, issueId: work.id });
    const added = [];
    for (const inc of incidents) {
      const existing = await repo.getSignal(`incident:${inc.key}:${issueKey}`);
      if (existing) continue;
      const other = await ports.jira.getIssue(inc.key);
      if (!other) continue;
      const id = await recordLinkedIssue({ work, other, via: "graph" }, cfg);
      if (id) added.push(inc.key);
    }
    return { incidents: incidents.map(i => i.key), added };
  } catch (e) {
    console.warn(`Teamwork Graph incident sync failed for ${issueKey}: ${e.code ?? ""} ${e.message}`);
    return { error: e.code ?? e.message };
  }
}

/** Dev chain counts for the evidence drawer. */
async function devChain({ issueKey, cloudId }, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const queryKey = cfg.graphQueries?.devChain;
  if (!queryKey || !cloudId) return null;
  try {
    const work = await ports.jira.getIssue(issueKey, ["summary"]);
    if (!work) return null;
    const chain = await ports.graph.devChainFor({ queryKey, cloudId, issueId: work.id });
    return { commits: chain.commits.length, prs: chain.prs.length, deployments: chain.deployments.length };
  } catch (e) {
    console.warn(`Teamwork Graph dev chain failed for ${issueKey}: ${e.code ?? ""} ${e.message}`);
    return { error: e.code ?? e.message };
  }
}

module.exports = { syncIncidents, devChain };
