"use strict";
// Shared helpers for product REST calls through @forge/api.

class ApiError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}: ${String(body).slice(0, 300)}`);
    this.status = status;
  }
}

async function readJson(res, url) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, url, text);
  return text ? JSON.parse(text) : null;
}

/** Bitbucket-style pagination: follow `next` absolute URLs. */
async function paged(first, fetchAbsolute, { max = 20 } = {}) {
  const out = [];
  let page = await first();
  for (let i = 0; page && i < max; i++) {
    out.push(...(page.values || page.results || []));
    const next = page.next || page._links?.next;
    if (!next) break;
    page = await fetchAbsolute(next);
  }
  return out;
}

module.exports = { ApiError, readJson, paged };
