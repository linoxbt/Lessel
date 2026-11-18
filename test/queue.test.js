"use strict";
// Queue pushes fall back to no concurrency keys when the queue rejects them (seen live: a bare 400).
const test = require("node:test");
const assert = require("node:assert/strict");

test("enqueue drops concurrency keys after the queue rejects them, and keeps working", async () => {
  const p = require.resolve("@forge/events");
  const saved = require.cache[p];
  const pushed = [];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { Queue: class {
    async push(evs) {
      const list = Array.isArray(evs) ? evs : [evs];
      if (list.some(e => e.concurrency)) throw new Error("400 Bad Request");
      pushed.push(...list);
      return { jobId: "j" };
    }
  } } };
  try {
    const jobs = require("../src/jobs");
    await jobs.enqueue({ type: "migrate" }, "migrate");
    await jobs.pushEvents([{ body: { type: "recompute-pair" }, concurrency: { key: "k", limit: 1 } }]);
    assert.deepEqual(pushed, [{ body: { type: "migrate" } }, { body: { type: "recompute-pair" } }]);
  } finally {
    if (saved) require.cache[p] = saved; else delete require.cache[p];
  }
});
