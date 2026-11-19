// Task store: in memory, mirrored to a JSON file so tasks survive a restart (Jira keeps polling GetTask).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const TERMINAL = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED", "TASK_STATE_FAILED"]);
const MAX_TASKS = 1000;

export class TaskStore {
  constructor(file = null) {
    this.file = file;
    this.tasks = new Map();
    this.timer = null;
    if (file) {
      try {
        for (const t of JSON.parse(readFileSync(file, "utf8"))) {
          // Work in flight died with the old process: say so instead of reporting WORKING forever.
          if (!TERMINAL.has(t.status?.state)) {
            t.status = { state: "TASK_STATE_FAILED", timestamp: new Date().toISOString(),
              message: { role: "ROLE_AGENT", parts: [{ text: "The runner restarted before this finished. Reassign the work item to retry." }],
                messageId: `restart-${t.id}`, taskId: t.id, contextId: t.contextId } };
            t.metadata = { ...(t.metadata ?? {}), retryable: true };   // the poller may pick it up again
          }
          this.tasks.set(t.id, t);
        }
      } catch { /* first run */ }
    }
  }
  get(id) { return this.tasks.get(id) ?? null; }
  put(task) {
    this.tasks.set(task.id, task);
    if (this.tasks.size > MAX_TASKS) {
      for (const [id, t] of this.tasks) {
        if (this.tasks.size <= MAX_TASKS) break;
        if (TERMINAL.has(t.status?.state)) this.tasks.delete(id);
      }
    }
    this.persistSoon();
    return task;
  }
  /** A non-terminal task for the same agent and work item, if any (dedupes repeated assignments). */
  findActive(agentId, issueKey) {
    for (const t of this.tasks.values()) {
      if (t.agentId === agentId && t.metadata?.issueKey === issueKey && !TERMINAL.has(t.status?.state)) return t;
    }
    return null;
  }
  /** Every task for this agent and work item, oldest first (the poller's retry bookkeeping). */
  tasksFor(agentId, issueKey) {
    return [...this.tasks.values()].filter(t => t.agentId === agentId && t.metadata?.issueKey === issueKey);
  }
  persistSoon() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, 200);
  }
  persist() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const recent = [...this.tasks.values()].slice(-500);
      writeFileSync(`${this.file}.tmp`, JSON.stringify(recent));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      console.error(`Couldn't save tasks: ${e.message}`);
    }
  }
}
