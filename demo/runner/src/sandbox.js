// Running code the model wrote (tests, npm) without handing it the runner.
//
// Every run happens in a throwaway copy of the working tree WITHOUT .git (so nothing it does can plant hooks or
// git config that the runner later executes with its own privileges), as the unprivileged lessel-sandbox user,
// with an environment that holds no secrets, in its own process group that is killed when the run ends.
// The real checkout is never chowned or touched; only files the caller names are copied back, and only if
// they are plain files.

import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, cp, rm, lstat, readFile, mkdir, writeFile, chown, lchown, readdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX_USER = "lessel-sandbox";
export const MAX_OUTPUT = 64 * 1024;          // kept per run (the tail); the tool result is capped again later
const MAX_COPY_BACK = 5 * 1024 * 1024;

let sandbox;
/** { uid, gid } of the sandbox user, created on first use when the runner is root; null when unavailable. */
export function sandboxIdentity() {
  if (sandbox !== undefined) return sandbox;
  sandbox = null;
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return sandbox;
  try {
    try { execFileSync("id", ["-u", SANDBOX_USER], { stdio: "ignore" }); }
    catch { execFileSync("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", SANDBOX_USER], { stdio: "ignore" }); }
    const uid = Number(execFileSync("id", ["-u", SANDBOX_USER]).toString().trim());
    const gid = Number(execFileSync("id", ["-g", SANDBOX_USER]).toString().trim());
    if (!uid || !gid) throw new Error("the sandbox user resolved to root");
    sandbox = { uid, gid };
  } catch (e) {
    console.warn(`Couldn't set up the sandbox user: ${e.message}. Tests will be refused.`);
  }
  return sandbox;
}

/** The whole environment a sandboxed process gets. Nothing from the runner's env except PATH and LANG. */
export function sandboxEnv(home) {
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: "test", CI: "1" };
}

export class SandboxUnavailable extends Error {}

/** Fail closed: no sandbox user means no running model-written code, unless a developer opts in locally. */
export function resolveBox(box) {
  if (box) return box;
  if (process.env.RUNNER_ALLOW_UNSANDBOXED_TESTS === "1") return null;
  throw new SandboxUnavailable("Refusing to run: no sandbox user is available (the runner must run as root to " +
    "create lessel-sandbox). For local development only, set RUNNER_ALLOW_UNSANDBOXED_TESTS=1.");
}

/** Copy the checkout without .git (anywhere in the tree) and node_modules. Symlinks stay as they are, relative. */
async function copyTree(root, dest) {
  await cp(root, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: false,
    filter: src => !["node_modules", ".git"].includes(path.basename(src)) || src === root });
}

/** Keep the last `max` characters of a growing output. */
function tailBuffer(max = MAX_OUTPUT) {
  let text = "", dropped = false;
  return {
    push(chunk) { text += chunk; if (text.length > max) { text = text.slice(-max); dropped = true; } },
    get value() { return (dropped ? "…(earlier output truncated)\n" : "") + text; },
  };
}

/**
 * Run one command in its own process group; kill the whole group when it ends, times out or is aborted
 * (test runners love to leave servers and watchers behind). Resolves { code, output, timedOut, aborted }.
 */
export function runGroup(cmd, args, { cwd, env, uid, gid, timeoutMs = 300_000, signal } = {}) {
  return new Promise(resolve => {
    const out = tailBuffer();
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
        ...(uid != null ? { uid, gid } : {}) });
    } catch (e) {
      resolve({ code: null, output: `Couldn't start ${cmd}: ${e.message}`, timedOut: false, aborted: false });
      return;
    }
    let timedOut = false, aborted = false, done = false;
    const killGroup = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const onAbort = () => { aborted = true; killGroup(); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", d => out.push(d.toString()));
    child.stderr.on("data", d => out.push(d.toString()));
    const finish = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      killGroup();                          // leftovers in the group die with the run
      resolve({ code, output: out.value, timedOut, aborted });
    };
    child.on("error", e => { out.push(`\n${e.message}`); finish(null); });
    child.on("close", code => finish(code));
  });
}

/** Read a file the sandbox produced, refusing anything that isn't a plain file of sane size. */
async function readPlainFile(file) {
  const st = await lstat(file);
  if (!st.isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
  if (st.size > MAX_COPY_BACK) throw new Error(`${path.basename(file)} is too large`);
  return readFile(file);
}

/**
 * Run steps ([cmd, args] pairs, stopping at the first failure) in a sandboxed copy of `root`, in `subdir`.
 * copyBack: repo-relative paths to copy from the sandbox copy into the real tree afterwards (only when every
 * step succeeded), through confine() so the destination can't be a symlink or leave the repo.
 * Returns { ok, steps: [{ cmd, code, output, timedOut, aborted }], copied: [paths] }.
 */
export async function runSandboxed({ root, subdir = ".", steps, copyBack = [], confine, box, timeoutMs, signal }) {
  const identity = resolveBox(box === undefined ? sandboxIdentity() : box);
  const base = await mkdtemp(path.join(os.tmpdir(), "lessel-run-"));
  const work = path.join(base, "repo"), home = path.join(base, "home");
  const results = [];
  try {
    await copyTree(root, work);
    mkdirSync(home, { recursive: true });
    if (identity) await chownTree(base, identity);
    const cwd = path.join(work, subdir);
    for (const [cmd, args] of steps) {
      if (signal?.aborted) break;
      const r = await runGroup(cmd, args, { cwd, env: sandboxEnv(home), uid: identity?.uid, gid: identity?.gid, timeoutMs, signal });
      results.push({ cmd: [cmd, ...args].join(" "), ...r });
      if (r.code !== 0) break;
    }
    const ok = results.length === steps.length && results.every(r => r.code === 0);
    const copied = [];
    if (ok) {
      for (const rel of copyBack) {
        const content = await readPlainFile(path.join(work, rel));
        const dest = await confine(root, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, content);
        copied.push(rel);
      }
    }
    return { ok, steps: results, copied };
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

/** chown -R without following symlinks (a tracked link to /etc/shadow must not change owner). */
async function chownTree(dir, { uid, gid }) {
  await chown(dir, uid, gid);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) { await lchown(p, uid, gid); continue; }
    if (entry.isDirectory()) await chownTree(p, { uid, gid });
    else await chown(p, uid, gid);
  }
}
