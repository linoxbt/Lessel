// Regression tests for the security review of the runner.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git, GitError, scrub, branchName } from "../src/git.js";
import { confine, makeTools } from "../src/agent.js";
import { sandboxIdentity } from "../src/sandbox.js";
import { handleRpc, STATE, ERR } from "../src/a2a.js";
import { TaskStore } from "../src/store.js";
import { workOn } from "../src/work.js";

const tmp = p => mkdtempSync(path.join(tmpdir(), p));

test("credentials never reach argv, URLs or error text", async () => {
  assert.throws(() => new Git({ dir: "/x", remoteUrl: "https://u:secret@bitbucket.org/w/r.git" }), /must not contain credentials/);
  assert.equal(scrub("fatal: https://x-bitbucket-api-token-auth:SECRET@bitbucket.org/w/r.git"), "fatal: https://***@bitbucket.org/w/r.git");
  assert.equal(scrub("Authorization: Basic c2VjcmV0"), "Authorization: Basic ***");
  const g = new Git({ dir: path.join(tmp("lessel-git-"), "wc"), remoteUrl: "https://127.0.0.1:1/w/r.git",
    authHeader: "Authorization: Basic U0VDUkVUVE9LRU4=", mainBranch: "main", authorName: "a", authorEmail: "a@x" });
  const env = g.env({ network: true });
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://127.0.0.1:1/.extraHeader", "header scoped to the remote's origin");
  assert.equal(g.env().GIT_CONFIG_COUNT, "0", "local commands get no credential");
  await assert.rejects(g.startBranch("lessel/brook/PAY-1"), e => e instanceof GitError && !/U0VDUkVUVE9LRU4|SECRET/.test(e.message));
  assert.throws(() => branchName("brook", "PAY-1; rm -rf /"), /Not a Jira issue key/);
  assert.throws(() => branchName("../x", "PAY-1"), /Not an agent id/);
  assert.equal(branchName("brook", "PAY-1"), "lessel/brook/PAY-1");
  assert.notEqual(branchName("brook", "PAY-1"), branchName("atlas", "PAY-1"), "two agents never share a branch");
});

test("confine refuses dangling symlinks, links into .git, and node_modules", async () => {
  const root = tmp("lessel-confine2-");
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, ".git", "config"), "[remote]\n");
  symlinkSync(path.join(tmpdir(), "does-not-exist-yet"), path.join(root, "dangling"));
  symlinkSync(path.join(root, ".git", "config"), path.join(root, "cfg"));
  await assert.rejects(confine(root, "dangling"), /symlinks are off limits/);
  await assert.rejects(confine(root, "cfg"), /symlinks are off limits/);
  await assert.rejects(confine(root, "services/x/node_modules/pkg/index.js"), /node_modules is off limits/);
  const tools = Object.fromEntries(makeTools({ root, readPage: null, result: { testsRun: [] } }).map(t => [t.name, t]));
  await assert.rejects(tools.write_file.run({ path: "dangling", content: "x" }), /symlinks/);
  assert.equal(existsSync(path.join(tmpdir(), "does-not-exist-yet")), false);
});

test("tests run without the runner's secrets in their environment", async () => {
  const root = tmp("lessel-sandbox-");
  mkdirSync(path.join(root, "services", "svc"), { recursive: true });
  writeFileSync(path.join(root, "services", "svc", "package.json"), JSON.stringify({
    name: "svc", version: "1.0.0", private: true,
    scripts: { test: "node -e \"console.log('SEEN=' + (process.env.FORTYTWO_API_KEY || 'none'))\"" } }));
  process.env.FORTYTWO_API_KEY = "sk-ft-v1-should-not-leak";
  // Off root there's no sandbox user and tests are refused; opt in here so the env check still runs.
  if (!sandboxIdentity()) process.env.RUNNER_ALLOW_UNSANDBOXED_TESTS = "1";
  try {
    const result = { testsRun: [] };
    const tools = Object.fromEntries(makeTools({ root, readPage: null, result }).map(t => [t.name, t]));
    const out = await tools.run_tests.run({ service: "svc" });
    assert.match(out, /^PASS/, out);
    assert.match(out, /SEEN=none/);
    assert.doesNotMatch(out, /should-not-leak/);
  } finally { delete process.env.FORTYTWO_API_KEY; }
});

const assignment = key => ({ role: "ROLE_USER", messageId: "m", parts: [{ text: "x" },
  { data: { invocationType: "ISSUE_ASSIGNMENT", issue: { id: "1", fields: { key: key, summary: "s", description: "" } } } }] });

test("tasks are scoped to their agent, and a repeated assignment doesn't start twice", async () => {
  const store = new TaskStore();
  const started = [];
  const deps = agentId => ({ store, agentId, start: t => started.push(t.id) });
  const a = await handleRpc({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: assignment("PAY-7") } }, deps("brook"));
  const again = await handleRpc({ jsonrpc: "2.0", id: 2, method: "SendMessage", params: { message: assignment("PAY-7") } }, deps("brook"));
  assert.equal(again.result.task.id, a.result.task.id);
  assert.equal(started.length, 1);
  const other = await handleRpc({ jsonrpc: "2.0", id: 3, method: "GetTask", params: { id: a.result.task.id } }, deps("atlas"));
  assert.equal(other.error.code, ERR.TASK_NOT_FOUND);
  const cancelOther = await handleRpc({ jsonrpc: "2.0", id: 4, method: "CancelTask", params: { id: a.result.task.id } }, deps("atlas"));
  assert.equal(cancelOther.error.code, ERR.TASK_NOT_FOUND);
});

test("a restart marks in-flight tasks failed instead of WORKING forever", async () => {
  const file = path.join(tmp("lessel-store-"), "tasks.json");
  writeFileSync(file, JSON.stringify([
    { id: "t1", contextId: "c", status: { state: STATE.WORKING } },
    { id: "t2", contextId: "c", status: { state: STATE.COMPLETED } },
  ]));
  const store = new TaskStore(file);
  assert.equal(store.get("t1").status.state, STATE.FAILED);
  assert.match(store.get("t1").status.message.parts[0].text, /runner restarted/);
  assert.equal(store.get("t2").status.state, STATE.COMPLETED);
});

const finished = (extra = {}) => ({ summary: "Do it", finished: true, testsRun: [], changedPaths: new Set(["a.sql"]), ...extra });

function fakeDeps(overrides = {}) {
  const calls = [];
  return { calls, deps: {
    store: new TaskStore(),
    git: { dir: "/nowhere", startBranch: async b => calls.push(`branch ${b}`), changedFiles: async () => ["a.sql"],
      commitAndPush: async () => { calls.push("push"); return "abc123456789"; } },
    confluence: { readPage: async () => ({ title: "Runbook", version: 7, text: "x" }) },
    lessel: { declareContext: async () => "Recorded." },
    bitbucket: { openPullRequest: async () => { calls.push("pr"); return { id: 1, url: null }; } },
    comment: async text => { calls.push(`comment ${text.slice(0, 40)}`); },
    runAgent: async ({ readPage }) => { await readPage("https://x/wiki/spaces/ENG/pages/1/R"); return finished(); },
    log: { warn() {}, error() {} },
    ...overrides,
  } };
}
const inv = { issueKey: "PAY-9", summary: "thing" };
const agent = { id: "brook", name: "Brook" };

test("cancel while queued does nothing; cancel mid-run opens no PR", async () => {
  let f = fakeDeps();
  await workOn({ id: "t", cancelRequested: true, status: {} }, inv, agent, f.deps);
  assert.deepEqual(f.calls, []);

  const task = { id: "t2", status: {} };
  f = fakeDeps({ runAgent: async () => { task.cancelRequested = true; return finished(); } });
  await workOn(task, inv, agent, f.deps);
  assert.ok(!f.calls.includes("push") && !f.calls.includes("pr"), f.calls.join(", "));
});

test("a failed context declaration blocks the PR and says why", async () => {
  const task = { id: "t3", status: {} };
  const f = fakeDeps({ lessel: { declareContext: async () => { throw new Error("401 unauthorized"); } } });
  await workOn(task, inv, agent, f.deps);
  assert.equal(task.status.state, STATE.FAILED);
  assert.match(task.status.message.parts[0].text, /didn't open a PR for PAY-9: Lessel didn't record 1 context read/);
  assert.ok(!f.calls.includes("pr"));
});
