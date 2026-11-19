// Code the model writes (tests, npm) must not be able to take over the runner: it runs in a copy of the tree
// without .git, as the sandbox user when there is one, with no secrets, and dies with its process group.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTools } from "../src/agent.js";
import { sandboxIdentity, sandboxEnv, runGroup } from "../src/sandbox.js";

const tmp = p => mkdtempSync(path.join(tmpdir(), p));
const isRoot = process.getuid?.() === 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A checkout with one service whose `npm test` runs t.js. */
function repoWithService(testJs, { gitInit = true } = {}) {
  const root = tmp("lessel-sbx-");
  const svc = path.join(root, "services", "svc");
  mkdirSync(svc, { recursive: true });
  writeFileSync(path.join(svc, "package.json"), JSON.stringify({ name: "svc", version: "1.0.0", private: true, scripts: { test: "node t.js" } }));
  writeFileSync(path.join(svc, "t.js"), testJs);
  if (gitInit) execFileSync("git", ["init", "-q", root]);
  return root;
}
const toolsFor = (root, extra = {}) => {
  const result = { testsRun: [] };
  return { result, tools: Object.fromEntries(makeTools({ root, readPage: null, result, ...extra }).map(t => [t.name, t])) };
};
// Off root (a developer laptop), there's no sandbox user: opt in to unsandboxed runs for these tests only.
const box = sandboxIdentity() ?? undefined;
if (!box) process.env.RUNNER_ALLOW_UNSANDBOXED_TESTS = "1";

test("the sandbox environment holds no secrets", () => {
  process.env.SOME_SECRET_TOKEN = "nope";
  try {
    const env = sandboxEnv("/tmp/h");
    assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "LANG", "NODE_ENV", "PATH"]);
    assert.equal(env.NODE_ENV, "test");
  } finally { delete process.env.SOME_SECRET_TOKEN; }
});

test("tests run in a copy without .git: they can't plant hooks or touch the real tree", async () => {
  const root = repoWithService(`
    const fs = require("fs");
    console.log("GIT=" + fs.existsSync("../../.git"));
    console.log("UID=" + process.getuid());
    fs.writeFileSync("../../planted.txt", "x");
    fs.mkdirSync("../../.git/hooks", { recursive: true });
    fs.writeFileSync("../../.git/hooks/pre-commit", "#!/bin/sh\\necho pwned\\n");
  `);
  const { tools, result } = toolsFor(root);
  const out = await tools.run_tests.run({ service: "svc" });
  assert.match(out, /^PASS/, out);
  assert.match(out, /GIT=false/);
  if (box) assert.match(out, new RegExp(`UID=${box.uid}\\b`), "runs as the sandbox user");
  assert.equal(existsSync(path.join(root, "planted.txt")), false);
  assert.equal(existsSync(path.join(root, ".git/hooks/pre-commit")), false);
  assert.equal(existsSync(path.join(root, "services/svc/package-lock.json")), false, "npm install leaves no junk lockfile");
  assert.deepEqual(result.testsRun, [{ service: "svc", ok: true }]);
});

test("without a sandbox user, tests are refused (fail closed) unless explicitly allowed", async () => {
  const root = repoWithService(`require("fs").writeFileSync(process.argv[1] + ".ran", "x")`);
  const saved = process.env.RUNNER_ALLOW_UNSANDBOXED_TESTS;
  delete process.env.RUNNER_ALLOW_UNSANDBOXED_TESTS;
  try {
    const { tools, result } = toolsFor(root, { box: null });
    const out = await tools.run_tests.run({ service: "svc" });
    assert.match(out, /^FAIL\nRefusing to run: no sandbox user/);
    assert.deepEqual(result.testsRun, [{ service: "svc", ok: false }], "a refused run counts as failing");
    assert.match(await tools.update_dependency.run({ service: "svc", name: "left-pad", version: "1.3.0" }), /Refusing to run/);

    process.env.RUNNER_ALLOW_UNSANDBOXED_TESTS = "1";
    assert.match(await toolsFor(root, { box: null }).tools.run_tests.run({ service: "svc" }), /^PASS/);
  } finally {
    if (saved === undefined) delete process.env.RUNNER_ALLOW_UNSANDBOXED_TESTS; else process.env.RUNNER_ALLOW_UNSANDBOXED_TESTS = saved;
  }
});

test("leftover processes die with the run's process group; timeouts and aborts kill the group", async () => {
  const markers = tmp("lessel-markers-");
  chmodSync(markers, 0o777);
  const marker = path.join(markers, "survived");
  const root = repoWithService(`
    require("child_process").spawn("sh", ["-c", "sleep 1; echo x > ${marker}"], { stdio: "ignore" }).unref();
    console.log("spawned");
  `);
  const out = await toolsFor(root).tools.run_tests.run({ service: "svc" });
  assert.match(out, /^PASS/, out);
  await sleep(1500);
  assert.equal(existsSync(marker), false, "the background child was killed");

  const slow = await runGroup("sh", ["-c", "sleep 30"], { env: sandboxEnv(tmpdir()), timeoutMs: 200 });
  assert.equal(slow.timedOut, true);

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  const t0 = Date.now();
  const aborted = await runGroup("sh", ["-c", "sleep 30"], { env: sandboxEnv(tmpdir()), signal: ctrl.signal });
  assert.equal(aborted.aborted, true);
  assert.ok(Date.now() - t0 < 5000);
});

/** A stand-in for npm that writes package.json, a lockfile and some junk, as `npm install --package-lock-only` would. */
function fakeNpm(body) {
  const dir = tmp("lessel-fakenpm-");
  chmodSync(dir, 0o755);
  const bin = path.join(dir, "npm");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("update_dependency validates its input and copies back only package.json and package-lock.json", async () => {
  const root = repoWithService("");
  const npmBin = fakeNpm([
    `echo '{"name":"svc","dependencies":{"pg":"^8.16.3"}}' > package.json`,
    `printf '%s ' "$@" > package-lock.json`,
    "echo junk > junk.txt",
    "echo x > ../../evil.txt",
  ].join("\n"));
  const { tools, result } = toolsFor(root, { npmBin });
  const out = await tools.update_dependency.run({ service: "svc", name: "pg", version: "8.16.3" });
  assert.match(out, /^Updated pg to 8\.16\.3/, out);
  assert.match(readFileSync(path.join(root, "services/svc/package.json"), "utf8"), /"pg":"\^8\.16\.3"/);
  assert.equal(readFileSync(path.join(root, "services/svc/package-lock.json"), "utf8").trim(),
    "install pg@8.16.3 --package-lock-only --ignore-scripts --no-audit --no-fund");
  assert.equal(existsSync(path.join(root, "services/svc/junk.txt")), false);
  assert.equal(existsSync(path.join(root, "evil.txt")), false);
  assert.deepEqual([...result.changedPaths].sort(), ["services/svc/package-lock.json", "services/svc/package.json"]);

  const schema = tools.update_dependency.schema;
  for (const bad of [{ name: "--registry=http://evil", version: "1.0.0" }, { name: "pg", version: "latest" },
    { name: "pg; rm -rf /", version: "1.0.0" }, { name: "pg", version: "1.0.0 --foo" }, { name: "../pg", version: "1.0.0" }]) {
    assert.equal(schema.safeParse({ service: "svc", ...bad }).success, false, JSON.stringify(bad));
  }
  assert.equal(schema.safeParse({ service: "svc", name: "@types/node", version: "^22.1.0" }).success, true);
});

test("update_dependency refuses a lockfile the sandbox turned into a symlink", async () => {
  const root = repoWithService("");
  const npmBin = fakeNpm("ln -sf /etc/hostname package-lock.json");
  const { tools, result } = toolsFor(root, { npmBin });
  const out = await tools.update_dependency.run({ service: "svc", name: "pg", version: "8.16.3" }).catch(e => `Error: ${e.message}`);
  assert.match(out, /not a regular file/);
  assert.equal(existsSync(path.join(root, "services/svc/package-lock.json")), false);
  assert.equal(result.changedPaths.size, 0);
});

test("a tracked symlink in the tree isn't followed when the copy is handed to the sandbox user", { skip: !box }, async () => {
  const root = repoWithService("console.log('ok')");
  const target = path.join(tmp("lessel-target-"), "secret");
  writeFileSync(target, "s");
  chmodSync(target, 0o600);
  symlinkSync(target, path.join(root, "services/svc/link"));
  const out = await toolsFor(root).tools.run_tests.run({ service: "svc" });
  assert.match(out, /^PASS/, out);
  const { statSync } = await import("node:fs");
  assert.equal(statSync(target).uid, 0, "the link's target still belongs to root");
});
