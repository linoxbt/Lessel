import test from "node:test";
import assert from "node:assert/strict";
import { handleRpc, readInvocation, STATE, ERR } from "../src/a2a.js";
import { TaskStore } from "../src/store.js";

const assignment = {
  role: "ROLE_USER", messageId: "m1",
  parts: [
    { text: "You have been assigned PAY-201." },
    { data: { userAccountId: "u1", agentAccountId: "agent-brook", invocationType: "ISSUE_ASSIGNMENT",
      issue: { id: "10001", fields: { key: "PAY-201", summary: "Add index", description: "Add an index on entries(account_id)." } } } },
  ],
};

function deps() {
  const started = [];
  return { store: new TaskStore(), start: (task, inv) => started.push({ task, inv }), started };
}

test("reads Jira's data part", () => {
  const inv = readInvocation(assignment);
  assert.equal(inv.kind, "work");
  assert.equal(inv.issueKey, "PAY-201");
  assert.equal(inv.invocationType, "ISSUE_ASSIGNMENT");
  assert.equal(inv.agentAccountId, "agent-brook");
  assert.equal(readInvocation({ parts: [{ text: "hi" }] }).kind, "chat");
});

test("SendMessage returns a WORKING task wrapped in {task} and starts work", async () => {
  const d = deps();
  const r = await handleRpc({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: assignment } }, d);
  assert.equal(r.id, 1);
  assert.equal(r.result.task.status.state, STATE.WORKING);
  assert.equal(r.result.task.status.message.role, "ROLE_AGENT");
  assert.deepEqual(Object.keys(r.result.task.status.message.parts[0]), ["text"]);
  assert.equal(d.started.length, 1);

  const g = await handleRpc({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: r.result.task.id } }, d);
  assert.equal(g.result.id, r.result.task.id, "GetTask returns the task directly");

  const c = await handleRpc({ jsonrpc: "2.0", id: 3, method: "CancelTask", params: { id: r.result.task.id } }, d);
  assert.equal(c.result.status.state, STATE.CANCELED);
  const c2 = await handleRpc({ jsonrpc: "2.0", id: 4, method: "CancelTask", params: { id: r.result.task.id } }, d);
  assert.equal(c2.error.code, ERR.TASK_NOT_CANCELABLE);
});

test("chat messages complete immediately without starting work", async () => {
  const d = deps();
  const r = await handleRpc({ jsonrpc: "2.0", id: 1, method: "SendMessage",
    params: { message: { role: "ROLE_USER", messageId: "x", contextId: "ctx", parts: [{ text: "hello" }] } } }, d);
  assert.equal(r.result.task.status.state, STATE.COMPLETED);
  assert.equal(r.result.task.contextId, "ctx");
  assert.equal(d.started.length, 0);
});

test("errors: unknown task, unknown method, streaming, bad request, 0.3 aliases", async () => {
  const d = deps();
  assert.equal((await handleRpc({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "nope" } }, d)).error.code, ERR.TASK_NOT_FOUND);
  assert.equal((await handleRpc({ jsonrpc: "2.0", id: 1, method: "Nope" }, d)).error.code, ERR.METHOD_NOT_FOUND);
  assert.equal((await handleRpc({ jsonrpc: "2.0", id: 1, method: "SendStreamingMessage", params: {} }, d)).error.code, ERR.UNSUPPORTED);
  assert.equal((await handleRpc({ id: 1 }, d)).error.code, ERR.INVALID_REQUEST);
  const r = await handleRpc({ jsonrpc: "2.0", id: 9, method: "message/send", params: { message: assignment } }, d);
  assert.equal(r.result.task.status.state, STATE.WORKING);
});
