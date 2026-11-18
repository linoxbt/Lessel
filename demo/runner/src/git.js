// Git in a per-agent working copy. Credentials never appear in argv, the remote URL or error messages:
// they're passed as an http.extraHeader through git's environment config (GIT_CONFIG_COUNT/KEY/VALUE).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync } from "node:fs";

const run = promisify(execFile);

/** Remove credentials from text: user:pass@ in URLs and Authorization header values. */
export function scrub(text) {
  return String(text ?? "")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/(Authorization:\s*(?:Basic|Bearer)\s+)[A-Za-z0-9+/=._-]+/gi, "$1***");
}

export class GitError extends Error {}

export class Git {
  /**
   * @param {object} o
   * @param {string} o.remoteUrl   plain URL (no credentials)
   * @param {string} [o.authHeader] e.g. "Authorization: Basic <base64>" — sent only to the remote's host
   */
  constructor({ dir, remoteUrl, mainBranch = "main", authorName, authorEmail, authHeader = null }) {
    if (/\/\/[^/]*@/.test(String(remoteUrl))) throw new Error("remoteUrl must not contain credentials");
    Object.assign(this, { dir, remoteUrl, mainBranch, authorName, authorEmail, authHeader });
  }

  env() {
    const cfg = [["safe.directory", "*"]];   // the checkout may be owned by the sandbox user (see agent.js)
    if (this.authHeader && /^https:\/\//.test(this.remoteUrl)) {
      const origin = new URL(this.remoteUrl).origin;
      cfg.push([`http.${origin}/.extraHeader`, this.authHeader]);
    }
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: String(cfg.length) };
    cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
    return env;
  }

  async exec(args, cwd) {
    try {
      const { stdout } = await run("git", args, { cwd, maxBuffer: 20 * 1024 * 1024, env: this.env() });
      return stdout.trim();
    } catch (e) {
      throw new GitError(scrub(`git ${args[0]} failed: ${(e.stderr || e.message || "").toString().trim()}`).slice(0, 400));
    }
  }

  git(...args) { return this.exec(args, this.dir); }

  /** Fresh branch from the latest main (or the existing remote branch). Removes everything untracked. */
  async startBranch(branch) {
    if (!existsSync(`${this.dir}/.git`)) {
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

  async changedFiles() {
    const out = await this.git("status", "--porcelain");
    return out ? out.split("\n").map(l => l.slice(3)) : [];
  }

  async commitAndPush(branch, message) {
    await this.git("add", "-A");
    await this.git("-c", `user.name=${this.authorName}`, "-c", `user.email=${this.authorEmail}`, "commit", "-m", message);
    await this.git("push", "-u", "origin", branch);
    return this.git("rev-parse", "HEAD");
  }
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export function branchName(issueKey, summary) {
  if (!ISSUE_KEY.test(String(issueKey))) throw new GitError(`Not a Jira issue key: ${String(issueKey).slice(0, 40)}`);
  const slug = String(summary || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return slug ? `${issueKey}-${slug}` : issueKey;
}
