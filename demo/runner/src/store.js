// Task store: in memory, mirrored to a JSON file so tasks survive a restart (Jira keeps polling GetTask).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export class TaskStore {
  constructor(file = null) {
    this.file = file;
    this.tasks = new Map();
    this.timer = null;
    if (file) {
      try {
        for (const t of JSON.parse(readFileSync(file, "utf8"))) this.tasks.set(t.id, t);
      } catch { /* first run */ }
    }
  }
  get(id) { return this.tasks.get(id) ?? null; }
  put(task) {
    this.tasks.set(task.id, task);
    this.persistSoon();
    return task;
  }
  persistSoon() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, 200);
  }
  persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const recent = [...this.tasks.values()].slice(-500);
    writeFileSync(`${this.file}.tmp`, JSON.stringify(recent));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
