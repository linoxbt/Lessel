import test from "node:test";
import assert from "node:assert/strict";
import { pollOnce, adfText } from "../src/poller.js";
import { TaskStore } from "../src/store.js";

const cfg = { siteUrl: "https://site.atlassian.net" };
const brook = { id: "brook", name: "Brook", confluence: { email: "brook@example.com", token: "t" } };

test("polling starts each assigned work item once, as the agent, with the ticket text", async () => {
  const store = new TaskStore(null);
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    return { ok: true, status: 200, json: async () => ({ issues: [
      { id: "10001", key: "PAY-1", fields: { summary: "Add index", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Use a migration." }] }] } } },
    ] }) };
  };
  const started = [];
  const log = { log() {}, warn() {} };
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
