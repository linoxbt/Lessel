"use strict";
// Async jobs on the lessel-jobs queue: migrations, backfill (spec §10.6), full recompute, history scans.

const repo = require("./db/repo");
const { ports } = require("./ports");
const { migrateForge } = require("./db/schema");
const { recomputeAll, recompute, recomputeTeam } = require("./services/recompute");
const { expireSuspected, remindSuspected } = require("./services/signals");
const { refreshItem } = require("./services/recompute");
const { scanHistory } = require("./services/cleanroom");
const { onPullRequest, onDeployment, onPush, onBitbucketEvent } = require("./events/bitbucket");
const { once, normUuid } = require("./events/once");
const { onAssigned, onLinkCreated } = require("./events/jira");

/**
 * Push events, keeping the per-key concurrency limit where the queue accepts it. Some sites reject events that
 * carry `concurrency` (a plain 400): then they're pushed without it. Every job is idempotent, and the hourly
 * forced sweep corrects any record two concurrent jobs might race on.
 */
let concurrencyRejected = false;
let migrated = false;
async function pushEvents(events) {
  const { Queue } = require("@forge/events");
  // Log the queue service's own error text: a bare "400 Bad Request" from the SDK says nothing.
  const client = async (path, req) => {
    const res = await require("@forge/api").__requestAtlassianAsApp(path, req);
    if (res.status === 201) return res;
    const text = await res.text().catch(() => "");
    if (res.status !== 202) console.error(`queue push ${res.status}: ${text.slice(0, 500)}`);
    return { status: res.status, statusText: res.statusText, ok: res.ok,
      text: async () => text, json: async () => JSON.parse(text) };
  };
  const queue = new Queue({ key: "lessel-jobs" }, client);
  const strip = list => list.map(({ concurrency, ...rest }) => rest);
  for (let i = 0; i < events.length; i += 50) {          // push takes up to 50
    const batch = events.slice(i, i + 50);
    if (concurrencyRejected) { await queue.push(strip(batch)); continue; }
    try {
      await queue.push(batch);
    } catch (e) {
      if (!/^400\b/.test(String(e?.message)) || !batch.some(ev => ev.concurrency)) throw e;
      console.warn("queue rejected concurrency keys; pushing without them");
      concurrencyRejected = true;
      await queue.push(strip(batch));
    }
  }
}

async function enqueue(body, concurrencyKey = null) {
  const ev = { body };
  if (concurrencyKey) ev.concurrency = { key: concurrencyKey, limit: 1 };
  await pushEvents([ev]);
  return { queued: 1 };
}

/**
 * Hourly sweep: close windows, remind and expire suspected signals, then recompute every record and hold.
 * With fanOut (the scheduled trigger), recomputes go out as one queue job per agent/shape pair, serialised
 * per pair with a concurrency key, so a large site never runs into one job's time limit.
 */
async function hourly(payload = {}) {
  const cfg = await repo.getSettings();
  await repo.pruneSeen(ports.now()).catch(e => console.warn("pruneSeen", e?.message));
  for (const item of await repo.itemsPastWindow(ports.now())) await refreshItem(item.issue_key, cfg);
  const reminded = await remindSuspected(cfg);
  const expired = await expireSuspected(cfg);
  if (!payload.fanOut) {
    const pairs = await repo.agentShapePairs();
    for (const p of pairs) await recomputePairJob({ agentId: p.agent_id, shapeId: p.shape_id });
    for (const s of await repo.listShapes()) await recomputeTeam(s.shape_id, cfg);
    return { reminded, expired, pairs: pairs.length };
  }
  const pairs = await repo.agentShapePairs();
  const shapes = await repo.listShapes();
  const events = [
    // Catch up on Bitbucket events that were lost or failed (B13), one job per repository.
    ...Object.keys(cfg.repos || {}).map(r => ({ body: { type: "reconcile-bitbucket", repoUuid: r },
      concurrency: { key: `bb-repo-${r.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 100), limit: 1 } })),
    ...pairs.map(p => ({ body: { type: "recompute-pair", agentId: p.agent_id, shapeId: p.shape_id },
      concurrency: { key: `rec-${p.agent_id}-${p.shape_id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100), limit: 1 } })),
    ...shapes.map(s => ({ body: { type: "recompute-team", shapeId: s.shape_id },
      concurrency: { key: `team-${s.shape_id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100), limit: 1 } })),
  ];
  await pushEvents(events);
  return { reminded, expired, queued: events.length };
}

/**
 * Rebuild history from REST (§10.6), in resumable steps: each step is its own queue job, so a large site never
 * runs into one job's time limit, and a failed step is retried alone. Every write is idempotent.
 */
async function backfill(payload = {}) {
  const cfg = await repo.getSettings();
  const step = payload.step ?? "start";
  if (step === "start") {
    const jobs = [{ body: { type: "backfill", step: "assignments" } },
      ...Object.keys(cfg.repos || {}).map(r => ({ body: { type: "backfill", step: "repo", repoUuid: r },
        concurrency: { key: `bb-repo-${r.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 100), limit: 1 } }))];
    await pushEvents(jobs);
    return [`queued ${jobs.length} backfill steps`];
  }
  if (step === "assignments") {
    // Items ever assigned to an agent (assignee WAS), not only those assigned now.
    const jiraAccounts = (await repo.accounts()).filter(a => a.product === "jira").map(a => a.account_id);
    if (!jiraAccounts.length || !cfg.projectKeys.length) return ["no agent accounts or projects"];
    const list = jiraAccounts.map(a => `"${a.replace(/"/g, "")}"`).join(",");
    const issues = await ports.jira.searchJql(
      `project in (${cfg.projectKeys.join(",")}) AND (assignee in (${list}) OR assignee WAS IN (${list})) ORDER BY created ASC`,
      ["summary", "description", "assignee", "components"], { max: 2000 });
    for (const issue of issues) {
      if (await repo.getItem(issue.key)) continue;
      // Assigned to an agent once, but not now: track it under the agent from the history.
      await onAssigned({ eventType: "avi:jira:assigned:issue", issue }, cfg);
      if (!(await repo.getItem(issue.key))) await trackFromHistory(issue.key, jiraAccounts, cfg);
    }
    await pushEvents([{ body: { type: "backfill", step: "links" } }]);
    return [`assignments: ${issues.length}`];
  }
  if (step === "repo") {
    const rc = cfg.repos?.[payload.repoUuid];
    if (!rc?.workspace) return [`repo ${payload.repoUuid}: no workspace configured, skipped`];
    let n = 0;
    for (const state of ["MERGED", "OPEN"]) {
      for (const pr of await ports.bitbucket.listPrs(rc.workspace, payload.repoUuid, { state, max: 200 })) {
        await onPullRequest(rc.workspace, payload.repoUuid, pr.id, cfg); n++;
      }
    }
    let d = 0;
    if (rc.deploys) {
      const deployments = (await ports.bitbucket.listDeployments(rc.workspace, payload.repoUuid, { max: 200 }))
        .filter(x => (x.state?.name ?? x.state?.type ?? "").toUpperCase().includes("COMPLETED"))
        .sort((a, b) => new Date(a.state?.completed_on ?? 0) - new Date(b.state?.completed_on ?? 0));
      for (const x of deployments) await onDeployment(rc.workspace, payload.repoUuid, x, cfg);
      d = deployments.length;
    }
    await onPush(rc.workspace, payload.repoUuid, [rc.mainBranch || "main"], cfg);
    return [`repo ${payload.repoUuid}: ${n} PRs, ${d} deployments`];
  }
  if (step === "links") {
    const tracked = new Set();
    for (const a of await repo.listAgents()) for (const i of await repo.itemsForAgent(a.agent_id)) tracked.add(i.issue_key);
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
    await pushEvents([{ body: { type: "hourly", fanOut: true } }]);
    return [`links checked on ${tracked.size} items; sweep queued`];
  }
  return [`unknown backfill step ${step}`];
}

/** An item an agent was assigned in the past: create it under that agent (from the changelog). */
async function trackFromHistory(key, agentJiraAccounts, cfg) {
  const issue = await ports.jira.getIssue(key).catch(() => null);
  const histories = issue?.changelog?.histories ?? [];
  for (const h of histories) {
    for (const it of h.items ?? []) {
      if (it.field === "assignee" && agentJiraAccounts.includes(it.to)) {
        const agent = await repo.agentForAccount("jira", it.to);
        if (!agent) continue;
        const { provisionalShape } = require("./services/shapes");
        const { adfText } = require("./adapters/jira");
        const shape = await provisionalShape({ summary: issue.fields?.summary, description: adfText(issue.fields?.description),
          components: issue.fields?.components }, cfg);
        await repo.createItem({ issue_key: key, actor_kind: "agent", assigned_agent_id: null, shape_id: shape.shape_id, classified_by: shape.classified_by });
        return true;
      }
    }
  }
  return false;
}

/**
 * Hourly catch-up for one repository: re-read open and recently merged PRs, and apply completed deployments
 * that never arrived as events. Every step is idempotent. Skipped when Bitbucket isn't linked.
 */
async function reconcileBitbucket({ repoUuid }) {
  const cfg = await repo.getSettings();
  const rc = cfg.repos?.[repoUuid];
  if (!rc?.workspace || !(await require("./services/link").bitbucketLink())) return { skipped: true };
  let prs = 0, deploys = 0;
  for (const state of ["OPEN", "MERGED"]) {
    for (const pr of await ports.bitbucket.listPrs(rc.workspace, repoUuid, { state, max: 20 })) {
      await onPullRequest(rc.workspace, repoUuid, pr.id, cfg); prs++;
    }
  }
  if (rc.deploys) {
    const done = (await ports.bitbucket.listDeployments(rc.workspace, repoUuid, { max: 20 }))
      .filter(d => (d.state?.name ?? d.state?.type ?? "").toUpperCase().includes("COMPLETED"))
      .sort((a, b) => new Date(a.state?.completed_on ?? 0) - new Date(b.state?.completed_on ?? 0));
    for (const d of done) {
      await once(`bb:deploy:${normUuid(repoUuid)}:${d.uuid}`, () => onDeployment(rc.workspace, repoUuid, d, cfg));
      deploys++;
    }
  }
  return { prs, deploys };
}

/**
 * Sweep recompute of one pair. Promotions and lifted probations happen here (time passes, windows close), so a
 * changed decision is logged to History and announced on open PRs like any other change (audit M7).
 */
async function recomputePairJob({ agentId, shapeId }) {
  const cfg = await repo.getSettings();
  const agent = await repo.getAgent(agentId);
  if (!agent) return recompute(agentId, shapeId, cfg, { force: true });
  const { shapeSummary } = require("./services/decide");
  const { notifyDecisionChange } = require("./services/notify");
  const before = await shapeSummary(agent, shapeId, cfg);
  const rec = await recompute(agentId, shapeId, cfg, { force: true });
  const after = await shapeSummary(agent, shapeId, cfg);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const hour = ports.now().toISOString().slice(0, 13);
    await notifyDecisionChange(agent, shapeId, before, after, { id: `sweep:${hour}`, rev: 0,
      text: "Lessel's hourly review of closed observation windows" }, cfg);
  }
  return rec;
}

const handlers = {
  migrate: () => migrateForge(),
  backfill,
  hourly,
  "recompute-all": () => recomputeAll(),
  "recompute-pair": recomputePairJob,
  "reconcile-bitbucket": reconcileBitbucket,
  "bitbucket-event": body => onBitbucketEvent(body.event ?? {}),
  "confluence-event": body => require("./events/confluence").onConfluenceEvent(body.event ?? {}),
  "recompute-team": body => recomputeTeam(body.shapeId),
  "scan-history": body => scanHistory(body.pageId),
  "privacy-report": () => require("./services/privacy").reportPersonalData(),
  "import-snapshot": body => require("./services/snapshot").runImportJob(body),
};

/** Consumer for the lessel-jobs queue (event schema v2: a plain function that gets the pushed event). */
async function consume(event) {
  const payload = event?.body ?? {};
  const type = payload.type;
  if (!handlers[type]) { console.warn("unknown job", type); return; }
  // Make sure the tables exist (once per function start): a lost install event must not leave Lessel without them.
  if (type !== "migrate" && !migrated) { await migrateForge(); migrated = true; }
  const out = await handlers[type](payload);
  console.log(`job ${type} done`, JSON.stringify(out)?.slice(0, 1000));
}

module.exports = { enqueue, pushEvents, hourly, backfill, handlers, consume, reconcileBitbucket, recomputePairJob };
