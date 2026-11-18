"use strict";
// Bitbucket product events (spec §8.3, §9.5, §10.2). Payloads carry ids; details come from REST [verify payloads].

const repo = require("../db/repo");
const { ports } = require("../ports");
const { adfText } = require("../adapters/jira");
const { once, normUuid } = require("./once");
const { keyFromPr, revertedSha } = require("../core/keys");
const { riskier } = require("../core/shape");
const { windowEnds } = require("../core/outcomes");
const { finalShapeForPaths, provisionalShape } = require("../services/shapes");
const { afterItemChange, maybeExcuse } = require("../services/signals");

const repoCfg = (cfg, repoUuid) => cfg.repos?.[normUuid(repoUuid)] ?? {};
const prState = s => ({ OPEN: "open", MERGED: "merged", DECLINED: "declined", SUPERSEDED: "declined" }[s] ?? "open");

/** Riskiest shape among an item's PRs (open or merged). */
function riskiestShape(prs, fallback) {
  let cls = null, service = null, by = null;
  for (const p of prs) {
    if (!p.shape_id) continue;
    const [s, c] = p.shape_id.split("/");
    const r = riskier(cls, c);
    if (r !== cls) { cls = r; service = s; by = p.classified_by; }
  }
  return cls ? { shape_id: `${service}/${cls}`, classified_by: by } : fallback;
}

/** Who gets the outcome (§9.5): author of the merged PRs; mixed if several. */
function attribution(mergedPrs) {
  const authors = new Set(mergedPrs.map(p => p.agent_id ?? "human"));
  if (authors.size !== 1) return { actor_kind: "mixed", agent_id: null };
  const [a] = authors;
  return a === "human" ? { actor_kind: "team", agent_id: null } : { actor_kind: "agent", agent_id: a };
}

async function ensureItem(key, agent, cfg, repoUuid) {
  let item = await repo.getItem(key);
  if (item) return item;
  const issue = await ports.jira.getIssue(key).catch(() => null);
  if (!issue) return null;
  const shape = await provisionalShape({ summary: issue.fields?.summary, description: adfText(issue.fields?.description),
    components: issue.fields?.components }, cfg);
  await repo.createItem({ issue_key: key, actor_kind: agent ? "agent" : "team", assigned_agent_id: null,
    shape_id: shape.shape_id, classified_by: shape.classified_by, repo_uuid: normUuid(repoUuid) });
  return repo.getItem(key);
}

async function onPullRequest(ws, repoUuid, prId, cfg) {
  const pr = await ports.bitbucket.getPr(ws, repoUuid, prId);
  const key = keyFromPr(pr, cfg.projectKeys);
  if (!key) return null;
  const agent = await repo.agentForAccount("bitbucket", pr.author?.uuid);
  const item = await ensureItem(key, agent, cfg, repoUuid);
  if (!item) return null;
  const rc = repoCfg(cfg, repoUuid);

  const issue = await ports.jira.getIssue(key, ["summary", "description"]).catch(() => null);
  const { paths, lines } = await ports.bitbucket.prDiffstat(ws, repoUuid, prId);
  const shape = await finalShapeForPaths({ paths, summary: issue?.fields?.summary,
    description: adfText(issue?.fields?.description), repoDefaultService: rc.defaultService }, cfg);
  const state = prState(pr.state);
  await repo.upsertPr({ repo_uuid: normUuid(repoUuid), pr_id: pr.id, workspace_uuid: normUuid(ws), issue_key: key,
    agent_id: agent?.agent_id ?? null, state, head_commit: pr.source?.commit?.hash ?? null,
    merge_commit: pr.merge_commit?.hash ?? null, shape_id: shape.shape_id, shape_head: pr.source?.commit?.hash ?? null,
    classified_by: shape.classified_by });

  const prs = await repo.prsForItem(key);
  const patch = { repo_uuid: normUuid(repoUuid), size_lines: lines };
  if (item.shape_state !== "frozen") Object.assign(patch, riskiestShape(prs, {}), { shape_state: "final" });

  if (state === "merged") {
    await repo.addPrCommits(normUuid(repoUuid), pr.id, await ports.bitbucket.prCommits(ws, repoUuid, prId).catch(() => []));
    const merged = prs.filter(p => p.state === "merged");
    Object.assign(patch, attribution(merged));
    if (!item.merged_at) patch.merged_at = new Date(pr.updated_on ?? ports.now());
    if (!rc.deploys && !item.window_ends) {
      // repo doesn't deploy: the window opens at merge and the shape freezes (§10.2)
      patch.window_ends = windowEnds(patch.merged_at ?? item.merged_at, cfg);
      patch.shape_state = "frozen";
      Object.assign(patch, riskiestShape(merged, { shape_id: item.shape_id, classified_by: item.classified_by }));
    }
  }
  await repo.patchItem(key, patch);
  if (state === "merged") await afterItemChange(key, { id: `merge:${normUuid(repoUuid)}:${pr.id}`, rev: 0, text: `${key} was merged` }, cfg);
  return { key, state, shape };
}

/** Push: detect "This reverts commit <sha>" for agent PR commits. */
async function onPush(ws, repoUuid, heads, cfg) {
  const found = [];
  for (const head of heads) {
    const commits = await ports.bitbucket.commitsOn(ws, repoUuid, head, { max: 1 });
    for (const c of commits) {
      const sha = revertedSha(c.message);
      if (!sha) continue;
      const prRow = await repo.prForCommit(normUuid(repoUuid), sha);
      if (!prRow) continue;
      const signal_id = `revert:${sha}`;
      if (await repo.insertSignal({ signal_id, issue_key: prRow.issue_key, kind: "revert", ref: c.hash,
        causality: "confirmed", confirmed_via: "revert", decided_by: "lessel:revert" })) {
        const src = await maybeExcuse(signal_id);
        const fresh = await repo.getSignal(signal_id);
        await afterItemChange(prRow.issue_key, { id: signal_id, rev: fresh.rev,
          text: `${prRow.issue_key} was reverted${src ? ` but excused: bad input from ${src.title || src.url}` : ""}` }, cfg);
        found.push(prRow.issue_key);
      }
    }
  }
  return found;
}

/** Deployment completed: open windows for merged items contained in the deployed commit (§10.2). */
async function onDeployment(ws, repoUuid, deployment, cfg) {
  const envUuid = deployment?.environment?.uuid;
  let envType = deployment?.environment?.environment_type?.name ?? deployment?.environment?.type;
  if (!envType && envUuid) envType = (await ports.bitbucket.getEnvironment(ws, repoUuid, envUuid).catch(() => null))?.environment_type?.name;
  if (envType && envType.toLowerCase() !== String(cfg.windowEnvironment).toLowerCase()) return [];
  const commit = deployment?.release?.commit?.hash ?? deployment?.commit?.hash ?? deployment?.deployable?.commit?.hash;
  if (!commit) return [];
  const at = new Date(deployment?.state?.completed_on ?? deployment?.completed_on ?? ports.now());
  const opened = [];
  for (const item of await repo.mergedUndeployed(normUuid(repoUuid))) {
    const merged = (await repo.prsForItem(item.issue_key)).filter(p => p.state === "merged" && p.merge_commit);
    let contained = false;
    for (const p of merged) {
      if (await ports.bitbucket.isAncestor(ws, repoUuid, p.merge_commit, commit).catch(() => false)) { contained = true; break; }
    }
    if (!contained) continue;
    await repo.patchItem(item.issue_key, { deployed_at: at, window_ends: windowEnds(at, cfg), shape_state: "frozen",
      ...riskiestShape(merged, { shape_id: item.shape_id, classified_by: item.classified_by }) });
    await afterItemChange(item.issue_key, { id: `deploy:${item.issue_key}`, rev: 0, text: `${item.issue_key} was deployed` }, cfg);
    opened.push(item.issue_key);
  }
  return opened;
}

function ids(event) {
  return {
    ws: event.workspace?.uuid ?? event.repository?.workspace?.uuid,
    repoUuid: event.repository?.uuid,
    prId: event.pullrequest?.id ?? event.pullRequest?.id,
  };
}

function eventKey(event) {
  const { repoUuid, prId } = ids(event);
  const r = normUuid(repoUuid);
  switch (event.eventType) {
    case "avi:bitbucket:created:pullrequest":
    case "avi:bitbucket:updated:pullrequest":
    case "avi:bitbucket:fulfilled:pullrequest":
      return `bb:pr:${r}:${prId}:${event.eventType.split(":")[2]}:${event.pullrequest?.updated_on ?? event.timestamp ?? ""}`;
    case "avi:bitbucket:push:repository":
      return `bb:push:${r}:${(event.push?.changes ?? event.changes ?? []).map(c => c.new?.target?.hash).join(",")}`;
    case "avi:bitbucket:completed:deployment":
      return `bb:deploy:${r}:${event.deployment?.uuid}`;
    default: return null;
  }
}

async function onBitbucketEvent(event) {
  const cfg = await repo.getSettings();
  const { ws, repoUuid, prId } = ids(event);
  return once(eventKey(event), async () => {
    switch (event.eventType) {
      case "avi:bitbucket:created:pullrequest":
      case "avi:bitbucket:updated:pullrequest":
      case "avi:bitbucket:fulfilled:pullrequest":
        return onPullRequest(ws, repoUuid, prId, cfg);
      case "avi:bitbucket:push:repository": {
        const heads = (event.push?.changes ?? event.changes ?? []).map(c => c.new?.target?.hash).filter(Boolean);
        return onPush(ws, repoUuid, heads, cfg);
      }
      case "avi:bitbucket:completed:deployment":
        return onDeployment(ws, repoUuid, event.deployment, cfg);
      default:
        return null; // reviewer-status changes: the merge check re-runs on its own
    }
  });
}

module.exports = { onBitbucketEvent, onPullRequest, onPush, onDeployment, attribution, riskiestShape, eventKey };
