// Git in a per-agent working copy. Credentials go in the remote URL, never in logs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync } from "node:fs";

const run = promisify(execFile);

export class Git {
  constructor({ dir, remoteUrl, mainBranch = "main", authorName, authorEmail }) {
    Object.assign(this, { dir, remoteUrl, mainBranch, authorName, authorEmail });
  }
  async git(...args) {
    const { stdout } = await run("git", args, { cwd: this.dir, maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim();
  }
  /** Fresh branch from the latest main. */
  async startBranch(branch) {
    if (!existsSync(`${this.dir}/.git`)) {
      mkdirSync(this.dir, { recursive: true });
      await run("git", ["clone", this.remoteUrl, this.dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    }
    await this.git("remote", "set-url", "origin", this.remoteUrl);
    await this.git("fetch", "origin", "--prune");
    await this.git("reset", "--hard");
    await this.git("clean", "-fdx", "-e", "node_modules");
    const remoteHas = await this.git("ls-remote", "--heads", "origin", branch);
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

export function branchName(issueKey, summary) {
  const slug = String(summary || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return slug ? `${issueKey}-${slug}` : issueKey;
}
