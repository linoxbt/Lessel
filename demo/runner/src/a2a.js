// A2A 1.0 over JSON-RPC 2.0, as Jira's agent connector speaks it:
// methods SendMessage / GetTask / CancelTask (SendStreamingMessage and SubscribeToTask only when
// the manifest sets streaming: true, which ours doesn't); parts are {text} / {data};
// roles ROLE_USER / ROLE_AGENT; states TASK_STATE_*. A task must report WORKING before anything else.

import { randomUUID } from "node:crypto";

export const STATE = {
  SUBMITTED: "TASK_STATE_SUBMITTED",
  WORKING: "TASK_STATE_WORKING",
  INPUT_REQUIRED: "TASK_STATE_INPUT_REQUIRED",
  COMPLETED: "TASK_STATE_COMPLETED",
  CANCELED: "TASK_STATE_CANCELED",
  REJECTED: "TASK_STATE_REJECTED",
  FAILED: "TASK_STATE_FAILED",
};
export const TERMINAL = new Set([STATE.COMPLETED, STATE.CANCELED, STATE.REJECTED, STATE.FAILED]);

export const ERR = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  TASK_NOT_FOUND: -32001, TASK_NOT_CANCELABLE: -32002, UNSUPPORTED: -32004,
};

// Older (0.3-style) names, accepted as aliases so a protocol bump doesn't break the demo.
const ALIASES = { "message/send": "SendMessage", "tasks/get": "GetTask", "tasks/cancel": "CancelTask",
  "message/stream": "SendStreamingMessage", "tasks/resubscribe": "SubscribeToTask" };

export class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function agentMessage(task, text) {
  return { role: "ROLE_AGENT", parts: [{ text }], messageId: randomUUID(), taskId: task.id, contextId: task.contextId };
}

export function setState(task, state, text) {
  task.status = { state, timestamp: new Date().toISOString(), ...(text ? { message: agentMessage(task, text) } : {}) };
  return task;
}

/** Text and data parts from a message, tolerant of {kind:"text"} style too. */
export function readParts(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const text = parts.map(p => p.text ?? (p.kind === "text" ? p.text : null)).filter(t => typeof t === "string").join("\n");
  const data = parts.map(p => p.data ?? null).find(d => d && typeof d === "object") ?? null;
  return { text, data };
}

/** What Jira asked for: a work-item invocation (assignment, mention, ...) or a chat message. */
export function readInvocation(message) {
  const { text, data } = readParts(message);
  if (!data) return { kind: "chat", text };
  const issue = data.issue ?? {};
  return {
    kind: "work",
    text,
    invocationType: data.invocationType ?? "UNKNOWN",
    issueId: issue.id ?? null,
    issueKey: issue.fields?.key ?? issue.key ?? null,
    summary: issue.fields?.summary ?? "",
    description: issue.fields?.description ?? "",
    comment: data.comment?.body ?? null,
    userAccountId: data.userAccountId ?? null,
    agentAccountId: data.agentAccountId ?? null,
    automationPrompt: data.automation?.prompt ?? null,
  };
}

/**
 * Handle one JSON-RPC request for one agent.
 * deps: { store, start(task, invocation), onCancel(task) }  — start() kicks off async work and must not throw;
 * onCancel() stops work in flight (the model call and any running command), not just the reported state.
 */
export async function handleRpc(body, deps) {
  if (!body || typeof body !== "object" || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id ?? null, ERR.INVALID_REQUEST, "Invalid JSON-RPC request");
  }
  const method = ALIASES[body.method] ?? body.method;
  try {
    switch (method) {
      case "SendMessage": return rpcResult(body.id, { task: await sendMessage(body.params, deps) });
      case "GetTask": return rpcResult(body.id, getTask(body.params, deps));
      case "CancelTask": return rpcResult(body.id, cancelTask(body.params, deps));
      case "SendStreamingMessage":
      case "SubscribeToTask":
        throw new RpcError(ERR.UNSUPPORTED, "Streaming is not enabled for this agent");
      default:
        throw new RpcError(ERR.METHOD_NOT_FOUND, `Unknown method ${body.method}`);
    }
  } catch (e) {
    if (e instanceof RpcError) return rpcError(body.id, e.code, e.message);
    console.error("A2A handler error", e);
    return rpcError(body.id, ERR.INTERNAL, "Internal error");
  }
}

async function sendMessage(params, { store, start, agentId = null }) {
  const message = params?.message;
  if (!message || !Array.isArray(message.parts)) throw new RpcError(ERR.INVALID_PARAMS, "params.message.parts is required");
  const inv = readInvocation(message);
  const task = { id: randomUUID(), contextId: message.contextId ?? randomUUID(), agentId };

  if (inv.kind === "chat") {
    // Chat isn't how these agents take work; answer and finish.
    setState(task, STATE.COMPLETED,
      "I work on Jira work items. Assign one to me (or @mention me on it) and I'll open a pull request.");
    store.put(task);
    return task;
  }
  if (!inv.issueKey) throw new RpcError(ERR.INVALID_PARAMS, "The data part has no issue key");
  const active = store.findActive?.(agentId, inv.issueKey);
  if (active) return active;                 // already queued or running: don't do the same work twice
  setState(task, STATE.WORKING, `Picked up ${inv.issueKey}.`);
  task.metadata = { issueKey: inv.issueKey, invocationType: inv.invocationType };
  store.put(task);
  start(task, inv);
  return task;
}

const ownTask = (store, id, agentId) => {
  const task = id ? store.get(id) : null;
  return task && (agentId == null || task.agentId == null || task.agentId === agentId) ? task : null;
};

function getTask(params, { store, agentId = null }) {
  const task = ownTask(store, params?.id, agentId);
  if (!task) throw new RpcError(ERR.TASK_NOT_FOUND, "Task not found");
  return task;
}

function cancelTask(params, { store, agentId = null, onCancel = null }) {
  const task = ownTask(store, params?.id, agentId);
  if (!task) throw new RpcError(ERR.TASK_NOT_FOUND, "Task not found");
  if (TERMINAL.has(task.status.state)) throw new RpcError(ERR.TASK_NOT_CANCELABLE, "Task is already finished");
  task.cancelRequested = true;
  setState(task, STATE.CANCELED, "Canceled.");
  store.put(task);
  onCancel?.(task);
  return task;
}

export const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
