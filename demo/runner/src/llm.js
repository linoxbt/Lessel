// OpenAI-compatible chat client. Default endpoint: Fortytwo, https://api.fortytwo.network/v1 (model in DEFAULT_LLM).
// Any OpenAI-compatible endpoint works (DashScope, Hugging Face router, OpenRouter, a local server).
//
// Fortytwo's error envelope: { error: { code, type, param, message }, request_id }.
// Retryable: 429 rate_limit_exceeded / concurrency_limit_exceeded / capacity_exhausted (Retry-After),
// 503 admission_unavailable / server_draining. Not retryable: 401, 402, 403, 404, 400, 429 billing_limit_exceeded.

export const DEFAULT_LLM = Object.freeze({
  baseUrl: "https://api.fortytwo.network/v1",
  model: "qwen/qwen3.8-27b",
  apiKeyEnv: "FORTYTWO_API_KEY",
});

const RETRYABLE_429 = new Set(["rate_limit_exceeded", "concurrency_limit_exceeded", "capacity_exhausted"]);

export class LlmError extends Error {
  constructor(status, code, message, requestId) {
    super(`${status}${code ? ` ${code}` : ""}: ${message}${requestId ? ` (request ${requestId})` : ""}`);
    Object.assign(this, { status, code, requestId });
  }
}

export function isRetryable(status, code) {
  if (status === 429) return RETRYABLE_429.has(code) || !code;
  if (status === 503) return true;
  if (status === 502 || status === 504) return true; // upstream hiccup; the request may be charged
  return status >= 500 && status < 600;
}

// Ends early when the task is aborted, so a long Retry-After never outlives a cancel.
const sleep = (ms, signal) => new Promise(r => {
  const t = setTimeout(r, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
});

export class ChatClient {
  constructor({ baseUrl = DEFAULT_LLM.baseUrl, apiKey, model = DEFAULT_LLM.model, fetchFn = fetch,
    maxRetries = 4, timeoutMs = 10 * 60_000, sleepFn = sleep } = {}) {
    if (!apiKey) throw new Error("No API key for the model endpoint (set FORTYTWO_API_KEY or the configured apiKeyEnv).");
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model, fetchFn, maxRetries, timeoutMs, sleepFn });
  }

  /**
   * POST /chat/completions with retries. Returns the parsed response.
   * signal (optional): the task's abort signal (cancel or deadline). It ends the request at once and is never
   * retried; its reason is rethrown so the caller can tell a cancel from a deadline.
   */
  async complete(body, { signal } = {}) {
    let attempt = 0;
    const stopIfAborted = () => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new LlmError(0, "aborted", "aborted"); };
    for (;;) {
      stopIfAborted();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res, text;
      try {
        res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: this.model, ...body }),
          signal: signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal,
        });
        text = await res.text();
      } catch (e) {
        clearTimeout(timer);
        stopIfAborted();
        if (attempt++ < this.maxRetries) { await this.sleepFn(1000 * 2 ** attempt, signal); continue; }
        throw new LlmError(0, "network_error", e.message);
      }
      clearTimeout(timer);
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
      if (res.ok) {
        if (!json) throw new LlmError(res.status, "empty_response", "the endpoint returned an empty body");
        return json;
      }
      const code = json?.error?.code ?? null;
      const message = json?.error?.message ?? text?.slice(0, 300) ?? res.statusText;
      if (isRetryable(res.status, code) && attempt++ < this.maxRetries) {
        const after = Number(res.headers.get("retry-after"));
        await this.sleepFn(Math.min(300_000, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt), signal);
        continue;
      }
      throw new LlmError(res.status, code, message, json?.request_id);
    }
  }
}
