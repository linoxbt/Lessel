// Second way to receive work, for sites where Jira's AI agent connectors aren't available: every agent
// checks Jira (as its own Atlassian account) for work items assigned to it, and starts each one once.
// Same pipeline as an A2A assignment; the Jira comment is posted as the agent instead of the app.

import { randomUUID } from "node:crypto";
import { STATE, setState } from "./a2a.js";

const basic = (email, token) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
export const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory = "To Do" ORDER BY created ASC';

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

/** True when any task (running or finished) already exists for this agent and work item. */
const seenBefore = (store, agentId, issueKey) =>
  [...store.tasks.values()].some(t => t.agentId === agentId && t.metadata?.issueKey === issueKey);

/**
 * One polling round for one agent. Returns the issue keys it started.
 * startWork(task, inv) runs the usual pipeline; it must not throw.
 */
export async function pollOnce({ cfg, agent, store, startWork, jql = DEFAULT_JQL, fetchFn = fetch, log = console }) {
  const { email, token } = agent.confluence;
  if (!email || !token || !cfg.siteUrl) return [];
  const url = `${cfg.siteUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,description&maxResults=10`;
  const res = await fetchFn(url, { headers: { authorization: basic(email, token), accept: "application/json" } });
  if (!res.ok) { log.warn(`${agent.name}: Jira search answered ${res.status}`); return []; }
  const started = [];
  for (const issue of (await res.json()).issues ?? []) {
    if (seenBefore(store, agent.id, issue.key)) continue;
    const task = { id: randomUUID(), contextId: randomUUID(), agentId: agent.id };
    setState(task, STATE.WORKING, `Picked up ${issue.key}.`);
    task.metadata = { issueKey: issue.key, invocationType: "POLLED_ASSIGNMENT" };
    store.put(task);
    const inv = { kind: "work", invocationType: "POLLED_ASSIGNMENT", issueId: issue.id, issueKey: issue.key,
      summary: issue.fields?.summary ?? "", description: adfText(issue.fields?.description).trim(), text: "" };
    log.log(`${agent.name} picked up ${issue.key} (assigned in Jira)`);
    startWork(task, inv);
    started.push(issue.key);
  }
  return started;
}

/** Poll every agent on an interval. Returns a stop function. */
export function startPolling({ cfg, store, startWork, intervalMs = 60_000, jql = DEFAULT_JQL, fetchFn = fetch, log = console }) {
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
  const timer = setInterval(round, intervalMs);
  round();
  return () => clearInterval(timer);
}
