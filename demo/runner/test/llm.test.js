// The real ChatClient and agent loop against a local server that speaks Fortytwo's documented format.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatClient, LlmError, DEFAULT_LLM, isRetryable } from "../src/llm.js";
import { runAgent } from "../src/agent.js";

/** Start a fake endpoint. handler(body, n) → { status, body, headers }. */
async function fakeFortytwo(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ path: req.url, auth: req.headers.authorization, body });
    const out = await handler(body, seen.length);
    res.writeHead(out.status ?? 200, { "content-type": "application/json", ...(out.headers ?? {}) });
    res.end(JSON.stringify(out.body));
  });
  await new Promise(r => server.listen(0, r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() };
}

const toolCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const reply = (message, finish = "stop") => ({ body: { id: "x", object: "chat.completion", model: DEFAULT_LLM.model,
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } });
const ftError = (status, code, headers) => ({ status, headers, body: { error: { code, type: "error", param: null, message: code }, request_id: "req_1" } });

test("defaults point at Qwen on Fortytwo", () => {
  assert.equal(DEFAULT_LLM.baseUrl, "https://api.fortytwo.network/v1");
  assert.equal(DEFAULT_LLM.model, "qwen/qwen3.8-27b");
  assert.equal(DEFAULT_LLM.apiKeyEnv, "FORTYTWO_API_KEY");
  assert.throws(() => new ChatClient({ apiKey: "" }), /No API key/);
});

test("retries rate limits and capacity errors (honouring Retry-After), not auth, quota or billing limits", async () => {
  assert.equal(isRetryable(429, "rate_limit_exceeded"), true);
  assert.equal(isRetryable(429, "capacity_exhausted"), true);
  assert.equal(isRetryable(429, "billing_limit_exceeded"), false);
  assert.equal(isRetryable(503, "server_draining"), true);
  assert.equal(isRetryable(401, "invalid_api_key"), false);
  assert.equal(isRetryable(402, "insufficient_quota"), false);

  const waits = [];
  const ft = await fakeFortytwo((body, n) => n === 1 ? ftError(429, "rate_limit_exceeded", { "retry-after": "3" }) : reply({ content: "ok" }));
  try {
    const c = new ChatClient({ baseUrl: ft.url, apiKey: "sk-ft-v1-test", sleepFn: async ms => waits.push(ms) });
    const res = await c.complete({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.choices[0].message.content, "ok");
    assert.deepEqual(waits, [3000]);
    assert.equal(ft.seen[0].path, "/v1/chat/completions");
    assert.equal(ft.seen[0].auth, "Bearer sk-ft-v1-test");
    assert.equal(ft.seen[0].body.model, "qwen/qwen3.8-27b");
  } finally { ft.close(); }

  const bad = await fakeFortytwo(() => ftError(402, "insufficient_quota"));
  try {
    const c = new ChatClient({ baseUrl: bad.url, apiKey: "k", sleepFn: async () => {} });
    await assert.rejects(c.complete({ messages: [] }), e => e instanceof LlmError && e.status === 402 && e.code === "insufficient_quota" && /req_1/.test(e.message));
    assert.equal(bad.seen.length, 1, "no retry on 402");
  } finally { bad.close(); }
});

test("agent loop over HTTP: parallel tool calls, bad JSON and bad arguments come back as tool errors", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lessel-qwen-"));
  writeFileSync(path.join(root, "README.md"), "hello\n");
  const ft = await fakeFortytwo((body, n) => {
    if (n === 1) return reply({ content: null, tool_calls: [
      toolCall("a", "read_file", { path: "README.md" }),
      toolCall("b", "write_file", "{not json"),
      toolCall("c", "write_file", { path: "x.txt" }),          // missing content
    ] }, "tool_calls");
    if (n === 2) return reply({ content: null, tool_calls: [toolCall("d", "write_file", { path: "notes/x.txt", content: "fixed\n" })] }, "tool_calls");
    if (n === 3) return reply({ content: null, tool_calls: [toolCall("e", "finish", { summary: "Add notes file" })] }, "tool_calls");
    return reply({ content: "unexpected extra turn" });
  });
  try {
    const client = new ChatClient({ baseUrl: ft.url, apiKey: "k", sleepFn: async () => {} });
    const agent = { id: "atlas", persona: "fast", effort: "low" };
    const out = await runAgent({ agent, inv: { issueKey: "PAY-1", summary: "notes", description: "" }, root, readPage: null, client });
    assert.equal(out.summary, "Add notes file");
    assert.equal(out.stopReason, "finish");
    assert.equal(out.turns, 3);
    assert.equal(readFileSync(path.join(root, "notes/x.txt"), "utf8"), "fixed\n");

    const second = ft.seen[1].body.messages;
    const toolMsgs = second.filter(m => m.role === "tool");
    assert.deepEqual(toolMsgs.map(m => m.tool_call_id), ["a", "b", "c"]);
    assert.equal(toolMsgs[0].content, "hello\n");
    assert.match(toolMsgs[1].content, /weren't valid JSON/);
    assert.match(toolMsgs[2].content, /invalid arguments for write_file: content/);
    assert.equal(second.find(m => m.role === "assistant").tool_calls.length, 3, "assistant tool_calls echoed back");
    assert.equal(ft.seen[0].body.reasoning_effort, "low");
    assert.equal(ft.seen[0].body.parallel_tool_calls, true);
  } finally { ft.close(); }
});
