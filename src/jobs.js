"use strict";
// Async jobs on the lessel-jobs queue: migrations, backfill (spec §10.6), full recompute, history scans.

const repo = require("./db/repo");
const { ports } = require("./ports");
const { migrateForge } = require("./db/schema");
const { recomputeAll, recompute, recomputeTeam } = require("./services/recompute");
const { expireSuspected, remindSuspected } = require("./services/signals");
const { refreshItem } = require("./services/recompute");
const { scanHistory } = require("./services/cleanroom");
const { onPullRequest, onDeployment, onPush } = require("./events/bitbucket");
const { onAssigned, onLinkCreated } = require("./events/jira");

async function enqueue(body, concurrencyKey = null) {
  const { Queue } = require("@forge/events");
  const queue = new Queue({ key: "lessel-jobs" });
  const ev = { body };
  if (concurrencyKey) ev.concurrency = { key: concurrencyKey, limit: 1 };
  return queue.push(ev);
}

/**
 * Hourly sweep: close windows, remind and expire suspected signals, then recompute every record and hold.
 * With fanOut (the scheduled trigger), recomputes go out as one queue job per agent/shape pair, serialised
 * per pair with a concurrency key, so a large site never runs into one job's time limit.
 */
async function hourly(payload = {}) {
  const cfg = await repo.getSettings();
  for (const item of await repo.itemsPastWindow(ports.now())) await refreshItem(item.issue_key, cfg);
  const reminded = await remindSuspected(cfg);
  const expired = await expireSuspected(cfg);
  if (!payload.fanOut) return { reminded, expired, pairs: await recomputeAll(cfg) };
  const pairs = await repo.agentShapePairs();
  const shapes = await repo.listShapes();
  const events = [
    ...pairs.map(p => ({ body: { type: "recompute-pair", agentId: p.agent_id, shapeId: p.shape_id },
      concurrency: { key: `rec-${p.agent_id}-${p.shape_id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100), limit: 1 } })),
    ...shapes.map(s => ({ body: { type: "recompute-team", shapeId: s.shape_id },
      concurrency: { key: `team-${s.shape_id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100), limit: 1 } })),
  ];
  const { Queue } = require("@forge/events");
  const queue = new Queue({ key: "lessel-jobs" });
  for (let i = 0; i < events.length; i += 50) await queue.push(events.slice(i, i + 50));   // push takes up to 50
  return { reminded, expired, queued: events.length };
}

/** Rebuild history from REST (§10.6). Safe to run repeatedly: every write is idempotent. */
async function backfill() {
  const cfg = await repo.getSettings();
  const log = [];
  // 1. agent assignments
  const jiraAccounts = (await repo.accounts()).filter(a => a.product === "jira").map(a => a.account_id);
  if (jiraAccounts.length && cfg.projectKeys.length) {
    const issues = await ports.jira.searchJql(
      `project in (${cfg.projectKeys.join(",")}) AND assignee in (${jiraAccounts.map(a => `"${a}"`).join(",")})`,
      ["summary", "description", "assignee", "components"], { max: 1000 });
    for (const issue of issues) await onAssigned({ eventType: "avi:jira:assigned:issue", issue }, cfg);
    log.push(`assignments: ${issues.length}`);
  }
  // 2–4. PRs, deployments, reverts per configured repo
  for (const [repoUuid, rc] of Object.entries(cfg.repos || {})) {
    if (!rc.workspace) { log.push(`repo ${repoUuid}: no workspace configured, skipped`); continue; }
    let n = 0;
    for (const state of ["MERGED", "OPEN"]) {
      for (const pr of await ports.bitbucket.listPrs(rc.workspace, repoUuid, { state })) {
        await onPullRequest(rc.workspace, repoUuid, pr.id, cfg); n++;
      }
    }
    if (rc.deploys) {
      const deployments = (await ports.bitbucket.listDeployments(rc.workspace, repoUuid))
        .filter(d => (d.state?.name ?? d.state?.type ?? "").toUpperCase().includes("COMPLETED"))
        .sort((a, b) => new Date(a.state?.completed_on ?? 0) - new Date(b.state?.completed_on ?? 0));
      for (const d of deployments) await onDeployment(rc.workspace, repoUuid, d, cfg);
      log.push(`repo ${repoUuid}: ${deployments.length} deployments`);
    }
    await onPush(rc.workspace, repoUuid, [rc.mainBranch || "main"], cfg);
    log.push(`repo ${repoUuid}: ${n} PRs`);
  }
  // 5. issue links on tracked items
  const tracked = new Set();
  for (const { agent_id } of await repo.listAgents().then(a => a.map(x => ({ agent_id: x.agent_id })))) {
    for (const i of await repo.itemsForAgent(agent_id)) tracked.add(i.issue_key);
  }
  for (const key of tracked) {
    const issue = await ports.jira.getIssue(key, ["issuelinks"]).catch(() => null);
    for (const l of issue?.fields?.issuelinks ?? []) {
      const other = l.inwardIssue ?? l.outwardIssue;
      await onLinkCreated({ eventType: "avi:jira:created:issuelink", issueLink: {
        id: l.id, issueLinkType: l.type,
        sourceIssueId: l.outwardIssue ? issue.id : other.id,
        destinationIssueId: l.outwardIssue ? other.id : issue.id } }, cfg);
    }
  }
  log.push(`links checked on ${tracked.size} items`);
  // 6. recompute
  log.push(`recomputed ${await recomputeAll(cfg)} agent/shape pairs`);
  return log;
}

const handlers = {
  migrate: () => migrateForge(),
  backfill,
  hourly,
  "recompute-all": () => recomputeAll(),
  "recompute-pair": body => recompute(body.agentId, body.shapeId),
  "recompute-team": body => recomputeTeam(body.shapeId),
  "scan-history": body => scanHistory(body.pageId),
};

/** Consumer resolver for the lessel-jobs queue. */
function jobsResolver() {
  const Resolver = require("@forge/resolver").default;
  const resolver = new Resolver();
  resolver.define("run", async ({ payload }) => {
    const type = payload?.type;
    if (!handlers[type]) { console.warn("unknown job", type); return; }
    const out = await handlers[type](payload);
    console.log(`job ${type} done`, JSON.stringify(out)?.slice(0, 1000));
  });
  return resolver.getDefinitions();
}

module.exports = { enqueue, hourly, backfill, handlers, jobsResolver };
