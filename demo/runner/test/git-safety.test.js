// Git runs in a tree the model wrote to: hooks, fsmonitor and planted config must never execute, git must not
// see the runner's secrets, and only the files the agent deliberately changed get committed.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, chmodSync, chownSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/git.js";
import { sandboxIdentity } from "../src/sandbox.js";

const tmp = p => mkdtempSync(path.join(tmpdir(), p));
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function origin() {
  const base = tmp("lessel-gitsafe-");
  const seed = path.join(base, "seed");
  mkdirSync(seed);
  writeFileSync(path.join(seed, "a.txt"), "a\n");
  writeFileSync(path.join(seed, "b.txt"), "b\n");
  sh(base, "init", "-q", "-b", "main", seed);
  sh(seed, "add", "-A");
  sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  const bare = path.join(base, "origin.git");
  sh(base, "clone", "-q", "--bare", seed, bare);
  const git = new Git({ dir: path.join(base, "work"), remoteUrl: bare, mainBranch: "main", authorName: "Brook (agent)", authorEmail: "b@x" });
  return { base, bare, git };
}

/** An executable script that leaves a marker file when it runs. */
function trap(dir, name, marker) {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho ran > ${marker}\n`);
  chmodSync(p, 0o755);
  return p;
}

test("planted hooks, hooksPath and fsmonitor never run", async () => {
  const { base, bare, git } = origin();
  await git.startBranch("lessel/brook/PAY-1");
  const marker = path.join(base, "pwned");
  const hooks = path.join(git.dir, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["pre-commit", "post-commit", "pre-push", "post-checkout", "reference-transaction"]) trap(hooks, h, marker);
  const other = path.join(base, "otherhooks");
  mkdirSync(other);
  trap(other, "pre-commit", marker);
  sh(git.dir, "config", "core.hooksPath", other);
  sh(git.dir, "config", "core.fsmonitor", trap(base, "fsmon", marker));

  writeFileSync(path.join(git.dir, "a.txt"), "changed\n");
  assert.deepEqual(await git.changedFiles(["a.txt"]), ["a.txt"]);
  await git.commitAndPush("lessel/brook/PAY-1", "PAY-1 Change a", ["a.txt"]);
  await git.startBranch("lessel/brook/PAY-1");
  assert.equal(existsSync(marker), false, "a hook or fsmonitor ran");
  assert.equal(sh(bare, "show", "lessel/brook/PAY-1:a.txt"), "changed");
});

test("git gets a minimal environment, the exact safe.directory, and credentials only for network commands", () => {
  process.env.FORTYTWO_API_KEY = "sk-should-not-reach-git";
  try {
    const g = new Git({ dir: "/data/work/brook/repo", remoteUrl: "https://bitbucket.org/w/r.git", authHeader: "Authorization: Basic eA==" });
    const local = g.env();
    assert.equal(local.FORTYTWO_API_KEY, undefined);
    assert.deepEqual(Object.keys(local).sort(),
      ["GIT_CONFIG_COUNT", "GIT_CONFIG_NOSYSTEM", "GIT_LITERAL_PATHSPECS", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "PATH"]);
    assert.notEqual(local.HOME, process.env.HOME);
    const net = g.env({ network: true });
    assert.equal(net.FORTYTWO_API_KEY, undefined);
    assert.equal(net.GIT_CONFIG_VALUE_0, "Authorization: Basic eA==");
    const args = g.baseArgs().join(" ");
    assert.match(args, /core\.hooksPath=\/dev\/null/);
    assert.match(args, /core\.fsmonitor=false/);
    assert.match(args, /safe\.directory=\/data\/work\/brook\/repo(\s|$)/);
    assert.doesNotMatch(args, /safe\.directory=\*/);
    assert.match(args, /protocol\.allow=never -c protocol\.https\.allow=always/);
  } finally { delete process.env.FORTYTWO_API_KEY; }
});

test("only the listed paths are committed: junk in the tree stays out of the PR", async () => {
  const { bare, git } = origin();
  await git.startBranch("lessel/atlas/PAY-2");
  mkdirSync(path.join(git.dir, "services/checkout"), { recursive: true });
  writeFileSync(path.join(git.dir, "services/checkout/package-lock.json"), "{}\n");   // junk an npm run left
  writeFileSync(path.join(git.dir, "b.txt"), "edited but not by the agent's tools\n");
  writeFileSync(path.join(git.dir, "new*.txt"), "new\n");                              // a glob-looking name
  writeFileSync(path.join(git.dir, "a.txt"), "agent\n");
  const changed = await git.changedFiles(["a.txt", "new*.txt", "not-changed.txt"]);
  assert.deepEqual(changed.sort(), ["a.txt", "new*.txt"]);
  await git.commitAndPush("lessel/atlas/PAY-2", "PAY-2 x", changed);
  const files = sh(bare, "show", "--name-only", "--format=", "lessel/atlas/PAY-2").split("\n").sort();
  assert.deepEqual(files, ["a.txt", "new*.txt"]);
  await assert.rejects(git.commitAndPush("lessel/atlas/PAY-2", "x", []), /nothing to commit/);
});

test("a checkout whose .git isn't entirely the runner's is thrown away and cloned again", { skip: !sandboxIdentity() }, async () => {
  const { base, git } = origin();
  await git.startBranch("lessel/brook/PAY-3");
  const box = sandboxIdentity();
  const planted = trap(path.join(git.dir, ".git", "hooks"), "post-checkout", path.join(base, "pwned"));
  chownSync(path.join(git.dir, ".git", "config"), box.uid, box.gid);   // as an older runner left it
  await git.startBranch("lessel/brook/PAY-3");
  assert.equal(existsSync(planted), false, "the old .git was replaced");
  assert.equal(statSync(path.join(git.dir, ".git", "config")).uid, process.getuid());
  assert.equal(existsSync(path.join(base, "pwned")), false);
});
