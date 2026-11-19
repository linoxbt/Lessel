import test from "node:test";
import assert from "node:assert/strict";
import { pollOnce, adfText, buildJql, retryDecision, pollIntervalMs, moveToInProgress, MAX_ATTEMPTS, RETRY_BASE_MS } from "../src/poller.js";
import { TaskStore } from "../src/store.js";
import { STATE, setState } from "../src/a2a.js";

const cfg = { siteUrl: "https://site.atlassian.net" };
const brook = { id: "brook", name: "Brook", confluence: { email: "brook@example.com", token: "t" } };
const log = { log() {}, warn() {} };
const ok = body => ({ ok: true, status: 200, json: async () => body });

test("polling starts each assigned work item once, as the agent, with the ticket text", async () => {
  const store = new TaskStore(null);
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    return ok({ issues: [
      { id: "10001", key: "PAY-1", fields: { summary: "Add index", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Use a migration." }] }] } } },
    ] });
  };
  const started = [];
  assert.deepEqual(await pollOnce({ cfg, agent: brook, store, startWork: (task, inv) => started.push(inv), fetchFn, log }), ["PAY-1"]);
  assert.equal(started[0].issueKey, "PAY-1");
  assert.equal(started[0].description, "Use a migration.");
  assert.match(calls[0].url, /\/rest\/api\/3\/search\/jql\?jql=assignee%20%3D%20currentUser\(\)/);
  assert.equal(calls[0].auth, `Basic ${Buffer.from("brook@example.com:t").toString("base64")}`);
  assert.deepEqual(await pollOnce({ cfg, agent: brook, store, startWork: () => assert.fail("started twice"), fetchFn, log }), []);
  assert.deepEqual(await pollOnce({ cfg, agent: { ...brook, confluence: {} }, store, startWork: () => {}, fetchFn, log }), [], "no keys, no polling");
});

test("ADF to text", () => {
  assert.equal(adfText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }).trim(), "ab");
});

test("the search covers To Do and In Progress, optional projects, and every page via nextPageToken", async () => {
  assert.equal(buildJql(), 'assignee = currentUser() AND statusCategory in ("To Do", "In Progress") ORDER BY created ASC');
  assert.match(buildJql(["PAY", "OPS", "bad key)"]), / AND project in \(PAY, OPS\) ORDER BY/);

  const urls = [];
  const issue = (n, cat = "indeterminate") => ({ id: String(n), key: `PAY-${n}`, fields: { summary: `s${n}`, status: { statusCategory: { key: cat } } } });
  const fetchFn = async url => {
    urls.push(url);
    if (!url.includes("nextPageToken")) return ok({ issues: [issue(1), issue(2)], nextPageToken: "p2" });
    return ok({ issues: [issue(3)], isLast: true });
  };
  const started = await pollOnce({ cfg: { ...cfg, projectKeys: ["PAY"] }, agent: brook, store: new TaskStore(), startWork: () => {}, fetchFn, log });
  assert.deepEqual(started, ["PAY-1", "PAY-2", "PAY-3"]);
  assert.equal(urls.length, 2, "items already In Progress aren't transitioned again");
  assert.match(urls[0], /project%20in%20\(PAY\)/);
  assert.match(urls[0], /fields=summary,description,status&maxResults=50$/);
  assert.match(urls[1], /&nextPageToken=p2$/);
});

test("picking up a To Do item moves it to In Progress as the agent", async () => {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? "GET", body: opts.body, auth: opts.headers?.authorization });
    if (url.includes("/search/jql")) return ok({ issues: [{ id: "1", key: "PAY-5", fields: { summary: "x", status: { statusCategory: { key: "new" } } } }] });
    if (opts.method === "POST") return { ok: true, status: 204 };
    return ok({ transitions: [
      { id: "11", name: "To Do", to: { name: "To Do", statusCategory: { key: "new" } } },
      { id: "21", name: "Start work", to: { name: "Doing", statusCategory: { key: "indeterminate" } } },
      { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
    ] });
  };
  const order = [];
  await pollOnce({ cfg, agent: brook, store: new TaskStore(), startWork: () => order.push("start"), fetchFn, log });
  const post = calls.find(c => c.method === "POST");
  assert.match(post.url, /\/rest\/api\/3\/issue\/PAY-5\/transitions$/);
  assert.deepEqual(JSON.parse(post.body), { transition: { id: "21" } });
  assert.equal(post.auth, `Basic ${Buffer.from("brook@example.com:t").toString("base64")}`);

  // By name when the category isn't there; no matching transition changes nothing; errors don't stop the work.
  const byName = async (url, opts = {}) => opts.method === "POST" ? { ok: true } : ok({ transitions: [{ id: "7", name: "In Progress", to: {} }] });
  assert.equal(await moveToInProgress({ siteUrl: cfg.siteUrl, email: "e", token: "t", issueKey: "PAY-5", fetchFn: byName }), true);
  assert.equal(await moveToInProgress({ siteUrl: cfg.siteUrl, email: "e", token: "t", issueKey: "PAY-5", fetchFn: async () => ok({ transitions: [] }) }), false);
  const failing = async url => url.includes("/search/jql")
    ? ok({ issues: [{ id: "1", key: "PAY-6", fields: { status: { statusCategory: { key: "new" } } } }] }) : { ok: false, status: 403 };
  assert.deepEqual(await pollOnce({ cfg, agent: brook, store: new TaskStore(), startWork: () => {}, fetchFn: failing, log }), ["PAY-6"]);
});

const taskIn = (state, at, metadata = {}) => {
  const t = { id: String(Math.random()), agentId: "brook", metadata: { issueKey: "PAY-1", ...metadata } };
  setState(t, state, "x");
  t.status.timestamp = new Date(at).toISOString();
  return t;
};

test("failed attempts are retried with backoff, a few times; active, finished or canceled work isn't", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");
  assert.deepEqual(retryDecision([], now), { start: true, attempt: 1 });
  assert.equal(retryDecision([taskIn(STATE.WORKING, now)], now).why, "active");
  assert.equal(retryDecision([taskIn(STATE.FAILED, now - 1e9), taskIn(STATE.COMPLETED, now)], now).why, "done");
  assert.equal(retryDecision([taskIn(STATE.CANCELED, now - 1e9)], now).why, "canceled");

  const oneFail = [taskIn(STATE.FAILED, now - RETRY_BASE_MS + 1000)];
  assert.equal(retryDecision(oneFail, now).why, "backoff");
  assert.deepEqual(retryDecision(oneFail, now + 1000), { start: true, attempt: 2 });
  const twoFails = [taskIn(STATE.FAILED, now - 1e9), taskIn(STATE.FAILED, now - RETRY_BASE_MS)];
  assert.equal(retryDecision(twoFails, now).why, "backoff", "the wait doubles");
  assert.deepEqual(retryDecision(twoFails, now + RETRY_BASE_MS), { start: true, attempt: 3 });
  const all = Array.from({ length: MAX_ATTEMPTS }, () => taskIn(STATE.FAILED, now - 1e9));
  assert.equal(retryDecision(all, now).why, "gave up");
  assert.equal(retryDecision([taskIn(STATE.FAILED, now - 1e9, { retryable: false })], now).why, "not retryable");
});

test("a failed polled task is picked up again after the backoff, and the attempt is recorded", async () => {
  const store = new TaskStore();
  const fetchFn = async url => url.includes("/search/jql")
    ? ok({ issues: [{ id: "1", key: "PAY-1", fields: { summary: "s", status: { statusCategory: { key: "indeterminate" } } } }] }) : ok({});
  const started = [];
  const startWork = task => started.push(task);
  const t0 = Date.now();
  await pollOnce({ cfg, agent: brook, store, startWork, fetchFn, log, now: t0 });
  setState(started[0], STATE.FAILED, "boom");
  await pollOnce({ cfg, agent: brook, store, startWork, fetchFn, log, now: t0 + 1000 });
  assert.equal(started.length, 1, "not during the backoff");
  await pollOnce({ cfg, agent: brook, store, startWork, fetchFn, log, now: t0 + RETRY_BASE_MS + 5000 });
  assert.equal(started.length, 2);
  assert.equal(started[1].metadata.attempt, 2);
  assert.match(started[1].status.message.parts[0].text, /attempt 2 of 3/);
});

test("the poll interval has a sane default and a 30 second floor", () => {
  assert.equal(pollIntervalMs(undefined), 60_000);
  assert.equal(pollIntervalMs(""), 60_000);
  assert.equal(pollIntervalMs("abc"), 60_000);
  assert.equal(pollIntervalMs("0"), 30_000);
  assert.equal(pollIntervalMs("-5"), 30_000);
  assert.equal(pollIntervalMs("5"), 30_000);
  assert.equal(pollIntervalMs("120"), 120_000);
});
