// One work item, end to end: branch → agent → commit → push → PR → Jira comment → task status.
// Context declarations go to Lessel BEFORE the PR exists, which is what lets Clean Room excuse later.

import { STATE, setState } from "./a2a.js";
import { branchName, scrub } from "./git.js";
import { Cancelled } from "./agent.js";

/**
 * deps: { git, bitbucket, confluence, lessel, runAgent, comment(text), store, mainBranch, log, requireDeclarations }
 * requireDeclarations (default true): if any context declaration to Lessel failed, don't open the PR —
 * an undeclared read could later look like an unexcused failure, and the PR would misreport it as declared.
 */
export async function workOn(task, inv, agent, deps) {
  const { git, bitbucket, confluence, lessel, store, log = console } = deps;
  const requireDeclarations = deps.requireDeclarations ?? true;
  const update = (state, text) => { if (!task.cancelRequested) { setState(task, state, text); store.put(task); } };
  const stopped = () => !!task.cancelRequested;
  const declared = [];

  if (stopped()) return;                                   // canceled while queued
  try {
    const branch = branchName(inv.issueKey, inv.summary);
    update(STATE.WORKING, `Working on ${inv.issueKey} in branch ${branch}.`);
    await git.startBranch(branch);

    // read_page: fetch as the agent, then attest the read to Lessel with the exact version.
    const readPage = async url => {
      const page = await confluence.readPage(url);
      const readAt = new Date().toISOString();
      try {
        const ack = await lessel.declareContext({ issueKey: inv.issueKey, sourceUrl: url, sourceVersion: page.version, readAt });
        declared.push({ url, version: page.version, ack });
      } catch (e) {
        log.warn(`declare-context failed for ${inv.issueKey} ${url}: ${scrub(e.message)}`);
        declared.push({ url, version: page.version, error: scrub(e.message) });
      }
      return page;
    };

    const result = await deps.runAgent({ agent, inv, root: git.dir, readPage, shouldStop: stopped });
    if (stopped()) return;

    const changed = await git.changedFiles();
    if (result.summary?.startsWith("Cannot:") || changed.length === 0) {
      const text = result.summary?.startsWith("Cannot:") ? result.summary : `No changes were needed for ${inv.issueKey}.`;
      await deps.comment?.(`${agent.name}: ${text}`).catch(e => log.warn(`Jira comment failed: ${scrub(e.message)}`));
      update(STATE.COMPLETED, text);
      return;
    }

    const failedDeclarations = declared.filter(d => d.error);
    if (failedDeclarations.length && requireDeclarations) {
      const text = `${agent.name} didn't open a PR for ${inv.issueKey}: Lessel didn't record ${failedDeclarations.length} ` +
        `context read(s) (${failedDeclarations.map(d => `${d.url} v${d.version}`).join(", ")}). Fix the MCP login and reassign.`;
      await deps.comment?.(text).catch(e => log.warn(`Jira comment failed: ${scrub(e.message)}`));
      update(STATE.FAILED, text.slice(0, 500));
      return;
    }

    if (stopped()) return;
    const title = `${inv.issueKey} ${result.summary}`.slice(0, 200);
    const sha = await git.commitAndPush(branch, `${title}\n\nLessel-Agent: ${agent.id}`);
    if (stopped()) return;
    const tests = result.testsRun.length
      ? result.testsRun.map(t => `${t.service}: ${t.ok ? "pass" : "FAIL"}`).join(", ") : "not run";
    const reads = declared.length
      ? declared.map(d => `${d.url} v${d.version}${d.error ? " (NOT declared: Lessel call failed)" : ""}`).join("\n") : "none";
    const pr = await bitbucket.openPullRequest({ branch, destination: deps.mainBranch ?? "main", title,
      description: `${result.summary}\n\nWork item: ${inv.issueKey}\nTests: ${tests}\nContext read:\n${reads}\n\nCommit ${sha.slice(0, 12)} by ${agent.name}.` });
    const done = `${pr.existing ? "Updated" : "Opened"} PR #${pr.id}${pr.url ? `: ${pr.url}` : ""} (tests: ${tests}).`;
    await deps.comment?.(`${agent.name}: ${done}`).catch(e => log.warn(`Jira comment failed: ${scrub(e.message)}`));
    task.artifacts = [{ artifactId: `pr-${pr.id}`, name: "pull-request", parts: [{ text: pr.url ?? `PR #${pr.id}` }] }];
    update(STATE.COMPLETED, done);
  } catch (e) {
    if (e instanceof Cancelled || stopped()) return;
    const message = scrub(e.message);
    log.error(`${agent.id} failed on ${inv.issueKey}: ${message}`);
    update(STATE.FAILED, `${agent.name} couldn't finish ${inv.issueKey}: ${message}`.slice(0, 500));
  }
}

/** One job at a time per agent, in arrival order. */
export class SerialQueue {
  constructor() { this.tail = Promise.resolve(); this.size = 0; }
  push(fn) {
    this.size++;
    const done = () => { this.size--; };
    this.tail = this.tail.then(fn, fn).then(done, done);
    return this.tail;
  }
}
