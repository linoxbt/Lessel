// End to end through the real HTTP server, real git (local bare repo) and the real tool runner,
// with a scripted fake Claude client and fake Bitbucket/Confluence/Lessel/Jira.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "../src/server.js";
import { TaskStore } from "../src/store.js";
import { Git } from "../src/git.js";
import { runAgent, confine, makeTools } from "../src/agent.js";
import { STATE } from "../src/a2a.js";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function bareRepo() {
  const base = mkdtempSync(path.join(tmpdir(), "lessel-runner-"));
  const seed = path.join(base, "seed");
  mkdirSync(path.join(seed, "services/ledger/migrations"), { recursive: true });
  writeFileSync(path.join(seed, "services/ledger/migrations/0001_accounts.sql"), "CREATE TABLE accounts (id TEXT);\n");
  sh(base, "init", "-q", "-b", "main", seed);
  sh(seed, "add", "-A");
  sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  const bare = path.join(base, "origin.git");
  sh(base, "clone", "-q", "--bare", seed, bare);
  return { base, bare };
}

/** Fake OpenAI-compatible client: one scripted tool call per turn, then a plain reply. */
function scriptedClient(script, seen) {
  let i = 0;
  return { async complete(body) {
    seen.requests.push(structuredClone(body));
    if (i > 0) seen.results.push(body.messages.at(-1).content);   // tool result of the previous call
    const step = script[i++];
    if (!step) return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }] };
    const [name, input] = step;
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: `call_${i}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } }] };
  } };
}

test("assignment → declare-context (before PR) → commit with trailer → PR → Jira comment → COMPLETED", async () => {
  const { base, bare } = bareRepo();
  const order = [];
  const seen = { results: [], requests: [] };
  const runbook = "https://site.atlassian.net/wiki/spaces/ENG/pages/9001/Ledger+runbook";
  const script = [
    ["read_page", { url: runbook }],
    ["write_file", { path: "services/ledger/migrations/0003_entries_account_idx.sql", content: "CREATE INDEX IF NOT EXISTS entries_account_idx ON entries(account_id);\n" }],
    ["finish", { summary: "Add index on entries(account_id)" }],
  ];
  const agent = { id: "brook", name: "Brook", route: "/a2a/brook", persona: "careful", effort: "high",
    git: { authorName: "Brook (agent)", authorEmail: "brook@agents.invalid" }, workdir: path.join(base, "work") };
  const cfg = { agents: { brook: agent }, repo: { mainBranch: "main" } };
  const store = new TaskStore();

  const server = createServer(cfg, {
    store,
    verify: async auth => { if (auth !== "Bearer good") throw new Error("bad"); return { cloudId: "c1" }; },
    depsFor: () => ({
      git: new Git({ dir: agent.workdir, remoteUrl: bare, mainBranch: "main", ...agent.git }),
      confluence: { readPage: async url => { order.push(`read ${url}`); return { title: "Ledger runbook", version: 7, text: "Keep migrations additive." }; } },
      lessel: { declareContext: async args => { order.push(`declare v${args.sourceVersion}`); return "Recorded."; } },
      bitbucket: { openPullRequest: async pr => { order.push(`pr ${pr.title}`); seen.pr = pr; return { id: 42, url: "https://bitbucket.org/x/pr/42" }; } },
      comment: async text => { order.push("comment"); seen.comment = text; return true; },
      runAgent: args => runAgent({ ...args, client: scriptedClient(script, seen) }),
      mainBranch: "main",
    }),
  });
  await new Promise(r => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/a2a/brook`;
  const rpc = (body, auth = "Bearer good") => fetch(url, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });

  try {
    assert.equal((await rpc({}, "Bearer bad")).status, 401);

    const send = await (await rpc({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", messageId: "m",
      parts: [{ text: "assigned" }, { data: { invocationType: "ISSUE_ASSIGNMENT", agentAccountId: "acc-brook",
        issue: { id: "1", fields: { key: "PAY-201", summary: "Add index on entries", description: `See ${runbook}` } } } }] } } })).json();
    assert.equal(send.result.task.status.state, STATE.WORKING);

    let task;
    for (let i = 0; i < 100; i++) {
      task = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: send.result.task.id } })).json()).result;
      if (task.status.state !== STATE.WORKING) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(task.status.state, STATE.COMPLETED, task.status.message?.parts?.[0]?.text);
    assert.match(task.status.message.parts[0].text, /^Opened PR #42/);

    assert.deepEqual(order, [`read ${runbook}`, "declare v7", "pr PAY-201 Add index on entries(account_id)", "comment"]);
    assert.match(seen.pr.description, /Context read \(declared to Lessel\):\n.*Ledger\+runbook v7/);
    const first = seen.requests[0];
    assert.equal(first.reasoning_effort, "high");
    assert.equal(first.tool_choice, "auto");
    assert.deepEqual(first.tools.map(t => t.function.name), ["list_files", "read_file", "write_file", "run_tests", "read_page", "finish"]);
    assert.equal(first.tools[2].function.parameters.required.join(","), "path,content");
    assert.equal(first.messages[0].role, "system");
    assert.match(first.messages[1].content, /^Jira work item PAY-201: Add index on entries/);
    // tool results flow back as role "tool" messages tied to the call id
    const toolMsg = seen.requests[1].messages.at(-1);
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.tool_call_id, "call_1");
    assert.match(toolMsg.content, /^Ledger runbook \(version 7\)/);
    assert.equal(seen.requests.length, 3, "finish ends the loop without another model call");

    const branch = "PAY-201-add-index-on-entries";
    const log = sh(bare, "log", "-1", "--format=%an%n%B", branch);
    assert.match(log, /^Brook \(agent\)\nPAY-201 Add index on entries\(account_id\)\n\nLessel-Agent: brook/);
    assert.equal(sh(bare, "show", `${branch}:services/ledger/migrations/0003_entries_account_idx.sql`),
      "CREATE INDEX IF NOT EXISTS entries_account_idx ON entries(account_id);");
  } finally {
    server.close();
  }
});

test("tools refuse paths outside the repo, into .git, or through symlinks", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lessel-confine-"));
  mkdirSync(path.join(root, "a"));
  symlinkSync(tmpdir(), path.join(root, "escape"));
  assert.equal(await confine(root, "a/b.txt"), path.join(root, "a/b.txt"));
  await assert.rejects(confine(root, "../x"), /escapes/);
  await assert.rejects(confine(root, "/etc/passwd"), /escapes/);
  await assert.rejects(confine(root, ".git/config"), /off limits/);
  await assert.rejects(confine(root, "escape/x"), /escapes/);
  const tools = Object.fromEntries(makeTools({ root, readPage: null, result: { testsRun: [] } }).map(t => [t.name, t]));
  assert.match(await tools.run_tests.run({ service: "nope" }), /No service called nope/);
});
