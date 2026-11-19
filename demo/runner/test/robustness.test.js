// The runner finishes or fails every task: deadlines and cancels stop the model call and running commands,
// unfinished or test-failing work never becomes a PR, and tool output can't overflow the conversation.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { workOn, abortTask, DeadlineExceeded } from "../src/work.js";
import { runAgent, makeTools, capResult, trimHistory, latestTestRuns, MAX_TOOL_RESULT, Cancelled } from "../src/agent.js";
import { ChatClient } from "../src/llm.js";
import { handleRpc, STATE } from "../src/a2a.js";
import { TaskStore } from "../src/store.js";
import { deadlineMinutes } from "../src/config.js";
import { lesselClient } from "../src/server.js";
import { LesselBridge, Lessel } from "../src/lessel.js";

const agent = { id: "brook", name: "Brook" };
const inv = { issueKey: "PAY-9", summary: "thing" };
const silent = { warn() {}, error() {}, log() {} };
const done = (extra = {}) => ({ summary: "Do it", finished: true, testsRun: [], changedPaths: new Set(["a.sql"]), stopReason: "finish", ...extra });

function fakeDeps(overrides = {}) {
  const calls = [];
  return { calls, deps: {
    store: new TaskStore(),
    git: { dir: "/nowhere", startBranch: async b => calls.push(`branch ${b}`),
      changedFiles: async paths => { calls.push(`changed ${paths.join(",")}`); return paths; },
      commitAndPush: async (branch, msg, paths) => { calls.push(`push ${branch} ${paths.join(",")}`); return "abc123456789"; } },
    confluence: { readPage: async () => ({ title: "Runbook", version: 7, text: "x" }) },
    lessel: { declareContext: async () => "Recorded." },
    bitbucket: { openPullRequest: async () => { calls.push("pr"); return { id: 1, url: null }; } },
    comment: async text => { calls.push(`comment ${text}`); },
    runAgent: async () => done(),
    log: silent,
    ...overrides,
  } };
}
const pushed = calls => calls.some(c => c.startsWith("push") || c === "pr");

test("a finished task commits only what the agent changed, on its own branch", async () => {
  const task = { id: "ok1", status: {} };
  const f = fakeDeps({ runAgent: async () => done({ changedPaths: new Set(["services/ledger/a.sql", "services/ledger/package-lock.json"]),
    testsRun: [{ service: "ledger", ok: false }, { service: "ledger", ok: true }] }) });
  await workOn(task, inv, agent, f.deps);
  assert.equal(task.status.state, STATE.COMPLETED, task.status.message?.parts[0].text);
  assert.ok(f.calls.includes("branch lessel/brook/PAY-9"));
  assert.ok(f.calls.includes("push lessel/brook/PAY-9 services/ledger/a.sql,services/ledger/package-lock.json"));
});

test("work the agent didn't finish never becomes a PR: the ticket hears why and the task can be retried", async () => {
  const task = { id: "u1", status: {}, metadata: { issueKey: "PAY-9" } };
  const f = fakeDeps({ runAgent: async () => done({ finished: false, stopReason: "max_turns" }) });
  await workOn(task, inv, agent, f.deps);
  assert.equal(task.status.state, STATE.FAILED);
  assert.equal(task.metadata.retryable, true);
  assert.match(task.status.message.parts[0].text, /stopped without calling finish \(max_turns\)/);
  assert.ok(f.calls.some(c => /^comment Brook couldn't finish PAY-9/.test(c)));
  assert.ok(!pushed(f.calls), f.calls.join(" | "));
});

test("a failing latest test run blocks the PR; so does a required test run that never happened", async () => {
  let task = { id: "t1", status: {} };
  let f = fakeDeps({ runAgent: async () => done({ testsRun: [{ service: "ledger", ok: true }, { service: "checkout", ok: true }, { service: "ledger", ok: false }] }) });
  await workOn(task, inv, agent, f.deps);
  assert.equal(task.status.state, STATE.FAILED);
  assert.match(task.status.message.parts[0].text, /latest test run failed for ledger/);
  assert.ok(!pushed(f.calls));

  task = { id: "t2", status: {} };
  f = fakeDeps();
  await workOn(task, inv, { ...agent, requireTests: true }, f.deps);
  assert.match(task.status.message.parts[0].text, /didn't run the tests/);
  assert.ok(!pushed(f.calls));

  assert.deepEqual(latestTestRuns([{ service: "a", ok: false }, { service: "b", ok: true }, { service: "a", ok: true }]),
    [{ service: "a", ok: true }, { service: "b", ok: true }]);
});

test("the deadline aborts the model call and fails the task", async () => {
  const task = { id: "d1", status: {} };
  let sawSignal;
  const f = fakeDeps({ deadlineMs: 50, runAgent: ({ signal }) => new Promise((_, reject) => {
    sawSignal = signal;
    signal.addEventListener("abort", () => reject(signal.reason));
  }) });
  await workOn(task, inv, agent, f.deps);
  assert.equal(sawSignal.aborted, true);
  assert.ok(sawSignal.reason instanceof DeadlineExceeded);
  assert.equal(task.status.state, STATE.FAILED);
  assert.match(task.status.message.parts[0].text, /ran out of time/);
  assert.ok(!pushed(f.calls));
});

test("CancelTask aborts the work in flight, not just the status", async () => {
  const store = new TaskStore();
  const task = { id: "c1", agentId: "brook", contextId: "x", status: { state: STATE.WORKING }, metadata: { issueKey: "PAY-9" } };
  store.put(task);
  let sawSignal;
  const started = new Promise(r => {
    const f = fakeDeps({ store, runAgent: ({ signal }) => new Promise((_, reject) => {
      sawSignal = signal;
      r();
      signal.addEventListener("abort", () => reject(signal.reason));
    }) });
    task.f = f;
  });
  const run = workOn(task, inv, agent, task.f.deps);
  await started;
  const res = await handleRpc({ jsonrpc: "2.0", id: 1, method: "CancelTask", params: { id: "c1" } },
    { store, agentId: "brook", onCancel: t => abortTask(t.id) });
  assert.equal(res.result.status.state, STATE.CANCELED);
  await run;
  assert.equal(sawSignal.aborted, true);
  assert.ok(sawSignal.reason instanceof Cancelled);
  assert.equal(task.status.state, STATE.CANCELED);
  assert.ok(!pushed(task.f.calls));
  assert.equal(abortTask("c1"), false, "nothing left running");
});

test("the model call honours the task's abort signal and isn't retried", async () => {
  let fetches = 0;
  const fetchFn = (url, opts) => { fetches++; return new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")))); };
  const client = new ChatClient({ apiKey: "k", fetchFn, sleepFn: async () => {} });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new DeadlineExceeded("late")), 20);
  await assert.rejects(client.complete({ messages: [] }, { signal: ctrl.signal }), DeadlineExceeded);
  assert.equal(fetches, 1);
  await assert.rejects(client.complete({ messages: [] }, { signal: ctrl.signal }), DeadlineExceeded);
  assert.equal(fetches, 1, "already aborted: no request at all");
});

test("runAgent passes the signal to the model and stops when it fires", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lessel-abort-"));
  const ctrl = new AbortController();
  const seen = [];
  const client = { async complete(body, opts) {
    seen.push(opts?.signal);
    ctrl.abort(new Cancelled("canceled"));
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "a", type: "function", function: { name: "finish", arguments: "{\"summary\":\"Do it\"}" } }] } }] };
  } };
  await assert.rejects(runAgent({ agent: { id: "a" }, inv, root, readPage: null, client, signal: ctrl.signal }), Cancelled);
  assert.equal(seen[0], ctrl.signal);
});

test("tool results are capped, long files are read in pages, and old output leaves the conversation", async () => {
  assert.equal(capResult("short"), "short");
  const capped = capResult("x".repeat(MAX_TOOL_RESULT + 100));
  assert.ok(capped.length < MAX_TOOL_RESULT + 100);
  assert.match(capped, /…truncated \(100 more characters not shown\)$/);

  const root = mkdtempSync(path.join(tmpdir(), "lessel-page-"));
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
  writeFileSync(path.join(root, "big.txt"), `${lines.join("\n")}\n`);
  const tools = Object.fromEntries(makeTools({ root, readPage: null, result: { testsRun: [] } }).map(t => [t.name, t]));
  const first = await tools.read_file.run({ path: "big.txt" });
  assert.ok(first.length <= MAX_TOOL_RESULT);
  const next = Number(/start_line=(\d+)/.exec(first)[1]);
  assert.match(first, /^line 1\n/);
  const second = await tools.read_file.run({ path: "big.txt", start_line: next });
  assert.ok(second.startsWith(`line ${next}\n`), second.slice(0, 40));

  const big = "y".repeat(10_000);
  const messages = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function",
      function: { name: "write_file", arguments: JSON.stringify({ path: `f${i}.txt`, content: big }) } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: big });
  }
  trimHistory(messages, 100_000);
  const size = messages.reduce((n, m) => n + String(m.content).length + (m.tool_calls ?? []).reduce((k, c) => k + c.function.arguments.length, 0), 0);
  assert.ok(size <= 100_000, `still ${size}`);
  assert.equal(messages.length, 42, "no message is dropped (each tool call keeps its result)");
  assert.match(messages[3].content, /earlier output removed/);
  assert.deepEqual(JSON.parse(messages[2].tool_calls[0].function.arguments).path, "f0.txt");
  assert.equal(messages.at(-1).content, big, "recent output stays");
});

test("deadline config: default 20 minutes, bounded", () => {
  assert.equal(deadlineMinutes(undefined), 20);
  assert.equal(deadlineMinutes("nope"), 20);
  assert.equal(deadlineMinutes("0"), 1);
  assert.equal(deadlineMinutes("45"), 45);
  assert.equal(deadlineMinutes("10000"), 120);
});

test("the bridge client uses the runner's own secret, never the master bridge secret", () => {
  const cfg = { lesselMcpUrl: "https://mcp.example/forge/x" };
  const a = { id: "brook", mcpTokenFile: "/tmp/none.json" };
  const bridge = lesselClient(cfg, a, { LESSEL_BRIDGE_URL: "https://bridge", LESSEL_RUNNER_SECRET: "r".repeat(40) });
  assert.ok(bridge instanceof LesselBridge);
  assert.equal(bridge.secret, "r".repeat(40));
  assert.ok(lesselClient(cfg, a, { LESSEL_BRIDGE_URL: "https://bridge", LESSEL_BRIDGE_SECRET: "m".repeat(40) }) instanceof Lessel,
    "the master secret alone isn't used");
  assert.equal(typeof bridge.checkTicketFit, "undefined");
});

test("a restarted runner marks stale WORKING tasks failed and retryable", async () => {
  const { writeFileSync: w } = await import("node:fs");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "lessel-store2-")), "tasks.json");
  w(file, JSON.stringify([{ id: "t1", contextId: "c", agentId: "brook", status: { state: STATE.WORKING }, metadata: { issueKey: "PAY-1" } }]));
  const store = new TaskStore(file);
  assert.equal(store.get("t1").status.state, STATE.FAILED);
  assert.equal(store.get("t1").metadata.retryable, true);
  assert.equal(store.tasksFor("brook", "PAY-1").length, 1);
});
