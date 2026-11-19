// Second way to receive work, for sites where Jira's AI agent connectors aren't available: every agent
// checks Jira (as its own Atlassian account) for work items assigned to it and starts each one. It moves the
// item to In Progress when it picks it up, and retries failed attempts with backoff (a few times, not forever).
// Same pipeline as an A2A assignment; the Jira comment is posted as the agent instead of the app.

import { randomUUID } from "node:crypto";
import { STATE, TERMINAL, setState } from "./a2a.js";

const basic = (email, token) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

export const MAX_ATTEMPTS = 3;
export const RETRY_BASE_MS = 5 * 60_000;      // wait 5 min after the first failure, 10 after the second
export const PAGE_SIZE = 50;
export const MAX_PAGES = 5;                    // at most 250 work items per agent per round
export const MIN_POLL_SECONDS = 30;
export const DEFAULT_POLL_SECONDS = 60;

/** JQL for the agent's open work, optionally limited to some projects (projectKeys in the runner config). */
export function buildJql(projectKeys = []) {
  const keys = (projectKeys ?? []).filter(k => PROJECT_KEY.test(String(k)));
  return 'assignee = currentUser() AND statusCategory in ("To Do", "In Progress")' +
    `${keys.length ? ` AND project in (${keys.join(", ")})` : ""} ORDER BY created ASC`;
}
export const DEFAULT_JQL = buildJql();

/** RUNNER_POLL_SECONDS → milliseconds: a missing or bad value means the default, and never faster than 30 s. */
export function pollIntervalMs(raw) {
  const n = Number(raw);
  if (raw == null || String(raw).trim() === "" || !Number.isFinite(n)) return DEFAULT_POLL_SECONDS * 1000;
  return Math.max(MIN_POLL_SECONDS, n) * 1000;
}

/** Plain text from Atlassian Document Format. */
export function adfText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  const inner = (node.content ?? []).map(adfText).join(node.type === "doc" ? "\n" : "");
  return ["paragraph", "heading", "listItem", "codeBlock"].includes(node.type) ? `${inner}\n` : inner;
}

/** Comment on a work item as the agent itself. */
export async function commentAsAgent({ siteUrl, email, token, issueKey, text, fetchFn = fetch }) {
  const res = await fetchFn(`${siteUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: "POST",
    headers: { authorization: basic(email, token), "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } }),
  });
  if (!res.ok) throw new Error(`Jira comment ${res.status}`);
  return true;
}

/**
 * Move a work item to In Progress as the agent: the transition into the "indeterminate" status category, or one
 * named In Progress. Returns false (and changes nothing) when the workflow has no such transition.
 */
export async function moveToInProgress({ siteUrl, email, token, issueKey, fetchFn = fetch }) {
  const url = `${siteUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`;
  const headers = { authorization: basic(email, token), accept: "application/json" };
  const res = await fetchFn(url, { headers });
  if (!res.ok) throw new Error(`Jira transitions ${res.status}`);
  const { transitions = [] } = await res.json();
  const t = transitions.find(x => x.to?.statusCategory?.key === "indeterminate")
    ?? transitions.find(x => /^in progress$/i.test(x.name ?? "") || /^in progress$/i.test(x.to?.name ?? ""));
  if (!t) return false;
  const post = await fetchFn(url, { method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ transition: { id: t.id } }) });
  if (!post.ok) throw new Error(`Jira transition ${post.status}`);
  return true;
}

/**
 * Whether to start this work item now, given the tasks this agent already has for it.
 * Skip while one is queued or running, once one completed, or after a person canceled one. Failed attempts are
 * retried with exponential backoff, up to MAX_ATTEMPTS in all. Returns { start, attempt } or { start: false, why }.
 */
export function retryDecision(tasks, now = Date.now()) {
  if (tasks.some(t => !TERMINAL.has(t.status?.state))) return { start: false, why: "active" };
  if (tasks.some(t => t.status?.state === STATE.COMPLETED)) return { start: false, why: "done" };
  if (tasks.some(t => t.status?.state === STATE.CANCELED || t.status?.state === STATE.REJECTED)) return { start: false, why: "canceled" };
  const failures = tasks.filter(t => t.status?.state === STATE.FAILED);
  if (failures.some(t => t.metadata?.retryable === false)) return { start: false, why: "not retryable" };
  if (failures.length >= MAX_ATTEMPTS) return { start: false, why: "gave up" };
  if (failures.length) {
    const last = Math.max(...failures.map(t => Date.parse(t.status?.timestamp) || 0));
    if (now < last + RETRY_BASE_MS * 2 ** (failures.length - 1)) return { start: false, why: "backoff" };
  }
  return { start: true, attempt: failures.length + 1 };
}

/** Every page of the search (up to MAX_PAGES), via the nextPageToken of /rest/api/3/search/jql. */
async function searchAll({ siteUrl, auth, jql, fetchFn, log, agentName }) {
  const issues = [];
  let token = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${siteUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,description,status` +
      `&maxResults=${PAGE_SIZE}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ""}`;
    const res = await fetchFn(url, { headers: { authorization: auth, accept: "application/json" } });
    if (!res.ok) { log.warn(`${agentName}: Jira search answered ${res.status}`); break; }
    const body = await res.json();
    issues.push(...(body.issues ?? []));
    token = body.nextPageToken ?? null;
    if (!token || body.isLast) break;
  }
  return issues;
}

/**
 * One polling round for one agent. Returns the issue keys it started.
 * startWork(task, inv) runs the usual pipeline; it must not throw.
 */
export async function pollOnce({ cfg, agent, store, startWork, jql = buildJql(cfg.projectKeys), fetchFn = fetch, log = console, now = Date.now() }) {
  const { email, token } = agent.confluence;
  if (!email || !token || !cfg.siteUrl) return [];
  const issues = await searchAll({ siteUrl: cfg.siteUrl, auth: basic(email, token), jql, fetchFn, log, agentName: agent.name });
  const started = [];
  for (const issue of issues) {
    const decision = retryDecision(store.tasksFor(agent.id, issue.key), now);
    if (!decision.start) continue;
    const task = { id: randomUUID(), contextId: randomUUID(), agentId: agent.id };
    setState(task, STATE.WORKING, `Picked up ${issue.key}${decision.attempt > 1 ? ` (attempt ${decision.attempt} of ${MAX_ATTEMPTS})` : ""}.`);
    task.metadata = { issueKey: issue.key, invocationType: "POLLED_ASSIGNMENT", attempt: decision.attempt };
    store.put(task);
    if (issue.fields?.status?.statusCategory?.key !== "indeterminate") {
      // So the ticket shows it's being worked on (and people see the agent took it). Not fatal if it fails.
      await moveToInProgress({ siteUrl: cfg.siteUrl, email, token, issueKey: issue.key, fetchFn })
        .catch(e => log.warn(`${agent.name}: couldn't move ${issue.key} to In Progress: ${e.message}`));
    }
    const inv = { kind: "work", invocationType: "POLLED_ASSIGNMENT", issueId: issue.id, issueKey: issue.key,
      summary: issue.fields?.summary ?? "", description: adfText(issue.fields?.description).trim(), text: "" };
    log.log(`${agent.name} picked up ${issue.key} (assigned in Jira, attempt ${decision.attempt})`);
    startWork(task, inv);
    started.push(issue.key);
  }
  return started;
}

/** Poll every agent on an interval. Returns a stop function. */
export function startPolling({ cfg, store, startWork, intervalMs = DEFAULT_POLL_SECONDS * 1000, jql, fetchFn = fetch, log = console }) {
  let running = false;
  const round = async () => {
    if (running) return;
    running = true;
    try {
      for (const agent of Object.values(cfg.agents)) {
        await pollOnce({ cfg, agent, store, startWork: (task, inv) => startWork(agent, task, inv), jql, fetchFn, log })
          .catch(e => log.warn(`${agent.name}: polling failed: ${e.message}`));
      }
    } finally { running = false; }
  };
  const timer = setInterval(round, Math.max(MIN_POLL_SECONDS * 1000, intervalMs));
  round();
  return () => clearInterval(timer);
}
