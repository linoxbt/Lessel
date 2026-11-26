// One work item, end to end: branch → agent → commit → push → PR → Jira comment → task status.
// Context declarations go to Lessel BEFORE the PR exists, which is what lets Clean Room excuse later.
//
// A PR is only opened for finished work: the agent must have called finish, and the latest test run of every
// service it tested must have passed. Anything else fails the task (retryable) and says why on the ticket.

import { STATE, setState } from "./a2a.js";
import { branchName, scrub } from "./git.js";
import { Cancelled, latestTestRuns } from "./agent.js";

export const DEFAULT_DEADLINE_MS = 20 * 60_000;

export class DeadlineExceeded extends Error {}

// Abort controllers of the tasks in flight, so CancelTask can stop the model call and running commands.
const running = new Map();

/** Abort a task in flight (cancel). Returns true when it was running here. */
export function abortTask(taskId, reason = new Cancelled("canceled")) {
  const ctrl = running.get(taskId);
  if (!ctrl) return false;
  ctrl.abort(reason);
  return true;
}

/**
 * deps: { git, bitbucket, confluence, lessel, runAgent, comment(text), store, mainBranch, log, requireDeclarations,
 *         deadlineMs }
 * requireDeclarations (default true): if any context declaration to Lessel failed, don't open the PR —
 * an undeclared read could later look like an unexcused failure, and the PR would misreport it as declared.
 * deadlineMs (default 20 minutes): the whole task, model calls and tests included, is aborted after this.
 */
export async function workOn(task, inv, agent, deps) {
  const { git, bitbucket, confluence, lessel, store, log = console } = deps;
  const requireDeclarations = deps.requireDeclarations ?? true;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const ctrl = new AbortController();
  const stopped = () => !!task.cancelRequested;
  const update = (state, text) => { if (!stopped()) { setState(task, state, text); store.put(task); } };
  const say = text => deps.comment?.(text)?.catch?.(e => log.warn(`Jira comment failed: ${scrub(e.message)}`));
  /** Failed, but worth another attempt (the poller retries with backoff). */
  const fail = async text => {
    await say(text);
    task.metadata = { ...(task.metadata ?? {}), retryable: true };
    update(STATE.FAILED, text.slice(0, 500));
  };
  const declared = [];

  if (stopped()) return;                                   // canceled while queued
  running.set(task.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(new DeadlineExceeded(`ran out of time after ${Math.round(deadlineMs / 60_000)} min`)), deadlineMs);
  try {
    const branch = branchName(agent.id, inv.issueKey);
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

    const result = await deps.runAgent({ agent, inv, root: git.dir, readPage, shouldStop: stopped, signal: ctrl.signal });
    if (stopped()) return;
    if (ctrl.signal.aborted) throw ctrl.signal.reason;

    if (!result.finished) {
      return await fail(`${agent.name} couldn't finish ${inv.issueKey}: it stopped without calling finish ` +
        `(${result.stopReason ?? "unknown"}), so no pull request was opened. It will try again later.`);
    }
    if (result.summary?.startsWith("Cannot:")) {
      await say(`${agent.name}: ${result.summary}`);
      update(STATE.COMPLETED, result.summary);
      return;
    }
    const failing = latestTestRuns(result.testsRun).filter(t => !t.ok);
    if (failing.length) {
      return await fail(`${agent.name} couldn't finish ${inv.issueKey}: the latest test run failed for ` +
        `${failing.map(t => t.service).join(", ")}, so no pull request was opened. It will try again later.`);
    }
    if (agent.requireTests && !result.testsRun.length) {
      return await fail(`${agent.name} couldn't finish ${inv.issueKey}: it didn't run the tests, ` +
        "so no pull request was opened. It will try again later.");
    }

    // Only what the agent deliberately changed (write_file, update_dependency) is committed.
    const changed = await git.changedFiles([...(result.changedPaths ?? [])]);
    if (changed.length === 0) {
      const text = `No changes were needed for ${inv.issueKey}.`;
      await say(`${agent.name}: ${text}`);
      update(STATE.COMPLETED, text);
      return;
    }

    const failedDeclarations = declared.filter(d => d.error);
    if (failedDeclarations.length && requireDeclarations) {
      const text = `${agent.name} didn't open a PR for ${inv.issueKey}: Lessel didn't record ${failedDeclarations.length} ` +
        `context read(s) (${failedDeclarations.map(d => `${d.url} v${d.version}`).join(", ")}). Fix the MCP login and reassign.`;
      await fail(text);
      return;
    }

    if (stopped()) return;
    const title = `${inv.issueKey}: ${prTitle(result.summary, inv.summary)}`;
    const sha = await git.commitAndPush(branch, `${title}\n\nLessel-Agent: ${agent.id}`, changed);
    if (stopped()) return;
    const tests = result.testsRun.length
      ? latestTestRuns(result.testsRun).map(t => `${t.service}: ${t.ok ? "pass" : "FAIL"}`).join(", ") : "not run";
    const reads = declared.length
      ? declared.map(d => `${d.url} v${d.version}${d.error ? " (NOT declared: Lessel call failed)" : ""}`).join("\n") : "none";
    const pr = await bitbucket.openPullRequest({ branch, destination: deps.mainBranch ?? "main", title,
      description: `${result.summary}\n\nWork item: ${inv.issueKey}\nTests: ${tests}\nContext read:\n${reads}\n\nCommit ${sha.slice(0, 12)} by ${agent.name}.` });
    const done = `${pr.existing ? "Updated" : "Opened"} PR #${pr.id}${pr.url ? `: ${pr.url}` : ""} (tests: ${tests}).`;
    await say(`${agent.name}: ${done}`);
    task.artifacts = [{ artifactId: `pr-${pr.id}`, name: "pull-request", parts: [{ text: pr.url ?? `PR #${pr.id}` }] }];
    update(STATE.COMPLETED, done);
  } catch (e) {
    if (e instanceof Cancelled || stopped()) return;
    if (e instanceof DeadlineExceeded || ctrl.signal.reason instanceof DeadlineExceeded) {
      log.error(`${agent.id} ran out of time on ${inv.issueKey}`);
      await fail(`${agent.name} couldn't finish ${inv.issueKey}: it ${ctrl.signal.reason.message}. It will try again later.`);
      return;
    }
    const message = scrub(e.message);
    log.error(`${agent.id} failed on ${inv.issueKey}: ${message}`);
    task.metadata = { ...(task.metadata ?? {}), retryable: true };
    update(STATE.FAILED, `${agent.name} couldn't finish ${inv.issueKey}: ${message}`.slice(0, 500));
  } finally {
    clearTimeout(timer);
    running.delete(task.id);
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

/**
 * A short PR title. The model's own summary is used when it reads like a title (one line, no markdown, at most
 * 90 characters, no report about tests); otherwise the work item's summary is (a model once titled a PR with a
 * paragraph about which tests passed).
 */
export function prTitle(modelSummary, ticketSummary = "") {
  const line = String(modelSummary ?? "").split("\n")[0].replace(/[`*#>]/g, "").replace(/\s+/g, " ").trim().replace(/[.:]$/, "");
  const fallback = String(ticketSummary ?? "").replace(/\s+/g, " ").trim().slice(0, 90) || "Changes";
  const looksLikeTitle = line.length >= 8 && line.length <= 90 && !/\b(tests?|passed|failed|I |I'm|I've)\b/i.test(line) && (line.match(/[.!?](\s|$)/g) ?? []).length === 0;
  return looksLikeTitle ? line : fallback;
}

