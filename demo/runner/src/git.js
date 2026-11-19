// Git in a per-agent working copy. Credentials never appear in argv, the remote URL or error messages:
// they're passed as an http.extraHeader through git's environment config (GIT_CONFIG_COUNT/KEY/VALUE), and only
// to the commands that talk to the remote.
//
// The working tree holds files the model wrote, so every git command runs with hooks and fsmonitor switched
// off, only the remote's protocol allowed, safe.directory set to this exact checkout, and an environment that
// holds nothing but what git needs (never the runner's secrets).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync, mkdtempSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const NETWORK = new Set(["clone", "fetch", "ls-remote", "push"]);
// Proxy and CA settings some hosts need to reach the remote. Not secrets, and only passed to network commands.
const NETWORK_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO"];

/** Remove credentials from text: user:pass@ in URLs and Authorization header values. */
export function scrub(text) {
  return String(text ?? "")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/(Authorization:\s*(?:Basic|Bearer)\s+)[A-Za-z0-9+/=._-]+/gi, "$1***");
}

export class GitError extends Error {}

let gitHome;
/** An empty HOME, so no ~/.gitconfig (ours or anyone's) is read. */
function emptyHome() {
  if (!gitHome || !existsSync(gitHome)) gitHome = mkdtempSync(path.join(os.tmpdir(), "lessel-git-home-"));
  return gitHome;
}

export class Git {
  /**
   * @param {object} o
   * @param {string} o.remoteUrl   plain URL (no credentials)
   * @param {string} [o.authHeader] e.g. "Authorization: Basic <base64>" — sent only to the remote's host
   */
  constructor({ dir, remoteUrl, mainBranch = "main", authorName, authorEmail, authHeader = null }) {
    if (/\/\/[^/]*@/.test(String(remoteUrl))) throw new Error("remoteUrl must not contain credentials");
    Object.assign(this, { dir: path.resolve(dir), remoteUrl, mainBranch, authorName, authorEmail, authHeader });
  }

  /** Only the remote's protocol: https for Bitbucket, file for a local path (tests). */
  protocol() {
    const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(String(this.remoteUrl));
    return m ? m[1].toLowerCase() : "file";
  }

  /** Options in front of every command. They're on the command line, so the repo's own config can't undo them. */
  baseArgs() {
    return ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", `safe.directory=${this.dir}`,
      "-c", "protocol.allow=never", "-c", `protocol.${this.protocol()}.allow=always`, "-c", "credential.helper="];
  }

  /** The whole environment git gets. The auth header only when the command talks to the remote. */
  env({ network = false } = {}) {
    const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: emptyHome(),
      LANG: process.env.LANG ?? "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
      GIT_LITERAL_PATHSPECS: "1" };   // file names the model chose are names, never glob patterns
    const cfg = [];
    if (network) {
      for (const k of NETWORK_ENV) if (process.env[k]) env[k] = process.env[k];
      if (this.authHeader && /^https:\/\//.test(this.remoteUrl)) {
        cfg.push([`http.${new URL(this.remoteUrl).origin}/.extraHeader`, this.authHeader]);
      }
    }
    env.GIT_CONFIG_COUNT = String(cfg.length);
    cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
    return env;
  }

  async exec(args, cwd, { raw = false } = {}) {
    try {
      const { stdout } = await run("git", [...this.baseArgs(), ...args],
        { cwd, maxBuffer: 20 * 1024 * 1024, timeout: 180_000, env: this.env({ network: NETWORK.has(args[0]) }) });
      return raw ? stdout : stdout.trim();
    } catch (e) {
      throw new GitError(scrub(`git ${args[0]} failed: ${(e.stderr || e.message || "").toString().trim()}`).slice(0, 400));
    }
  }

  git(...args) { return this.exec(args, this.dir); }

  /**
   * A checkout we can trust has a .git owned entirely by the runner. Anything else (for example a checkout an
   * older version of the runner chowned to the sandbox user) may hold planted hooks or config: start over.
   */
  async trusted() {
    const me = typeof process.getuid === "function" ? process.getuid() : null;
    if (me == null) return true;
    const gitDir = path.join(this.dir, ".git");
    const st = await lstat(gitDir).catch(() => null);
    if (!st?.isDirectory() || st.uid !== me) return false;
    for (const entry of await readdir(gitDir, { recursive: true })) {
      if ((await lstat(path.join(gitDir, entry))).uid !== me) return false;
    }
    return true;
  }

  /** Fresh branch from the latest main (or the existing remote branch). Removes everything untracked. */
  async startBranch(branch) {
    if (existsSync(this.dir) && !(existsSync(path.join(this.dir, ".git")) && await this.trusted())) {
      await rm(this.dir, { recursive: true, force: true });
    }
    if (!existsSync(path.join(this.dir, ".git"))) {
      mkdirSync(this.dir, { recursive: true });
      await this.exec(["clone", this.remoteUrl, this.dir], undefined);
    }
    await this.git("remote", "set-url", "origin", this.remoteUrl);
    await this.git("fetch", "origin", "--prune");
    await this.git("reset", "--hard");
    await this.git("clean", "-ffdx");
    const remoteHas = await this.git("ls-remote", "--heads", "origin", `refs/heads/${branch}`);
    await this.git("checkout", "-B", branch, remoteHas ? `origin/${branch}` : `origin/${this.mainBranch}`);
  }

  /** Which of `paths` (repo-relative) differ from HEAD, including new files. Nothing else in the tree counts. */
  async changedFiles(paths) {
    const list = [...new Set(paths ?? [])];
    if (!list.length) return [];
    const out = await this.exec(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...list], this.dir, { raw: true });
    const tokens = out.split("\0").filter(Boolean);
    const changed = [];
    for (let i = 0; i < tokens.length; i++) {
      const status = tokens[i].slice(0, 2);
      changed.push(tokens[i].slice(3));
      if (status[0] === "R" || status[0] === "C") i++;   // the rename's source path follows
    }
    return changed;
  }

  /** Commit exactly `paths` (never `add -A`: the tree may hold files nobody meant to ship) and push. */
  async commitAndPush(branch, message, paths) {
    const list = [...new Set(paths ?? [])];
    if (!list.length) throw new GitError("nothing to commit");
    await this.git("add", "--all", "--", ...list);
    await this.git("-c", `user.name=${this.authorName}`, "-c", `user.email=${this.authorEmail}`, "commit", "-m", message);
    await this.git("push", "-u", "origin", branch);
    return this.git("rev-parse", "HEAD");
  }
}

/** Git for read-only local commands in a checkout (no remote, no credentials), with the same safeguards. */
export function localGit(dir) {
  return new Git({ dir, remoteUrl: "" });
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/** One branch per agent and work item, so two agents on the same ticket never share a branch or a PR. */
export function branchName(agentId, issueKey) {
  if (!AGENT_ID.test(String(agentId))) throw new GitError(`Not an agent id: ${String(agentId).slice(0, 40)}`);
  if (!ISSUE_KEY.test(String(issueKey))) throw new GitError(`Not a Jira issue key: ${String(issueKey).slice(0, 40)}`);
  return `lessel/${agentId}/${issueKey}`;
}
