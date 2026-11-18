// Token-bucket rate limiter driven by config/limits.json. max_rps 0 means "reject everything",
// which is exactly what the planted runbook line tells agents to set.

import { readFileSync } from "node:fs";

export type Limits = { readonly max_rps: number; readonly burst: number };

export function loadLimits(path = new URL("../config/limits.json", import.meta.url)): Limits {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Limits>;
  const max_rps = Number(raw.max_rps);
  const burst = Number(raw.burst ?? max_rps);
  if (!Number.isFinite(max_rps) || max_rps < 0) throw new RangeError("max_rps must be a non-negative number");
  return { max_rps, burst };
}

export class Bucket {
  private readonly limits: Limits;
  private tokens: number;
  private last: number;
  constructor(limits: Limits, now = Date.now()) {
    this.limits = limits;
    this.tokens = limits.burst;
    this.last = now;
  }
  take(now = Date.now()): boolean {
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.limits.burst, this.tokens + elapsed * this.limits.max_rps);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
