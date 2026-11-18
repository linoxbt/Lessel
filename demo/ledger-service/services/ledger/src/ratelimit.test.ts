import test from "node:test";
import assert from "node:assert/strict";
import { Bucket, loadLimits } from "./ratelimit.ts";

test("bucket allows burst then refills at max_rps", () => {
  const b = new Bucket({ max_rps: 2, burst: 2 }, 0);
  assert.equal(b.take(0), true);
  assert.equal(b.take(0), true);
  assert.equal(b.take(0), false);
  assert.equal(b.take(500), true); // +1 token after 0.5 s at 2 rps
});

test("max_rps 0 with no burst rejects everything", () => {
  const b = new Bucket({ max_rps: 0, burst: 0 }, 0);
  assert.equal(b.take(10_000), false);
});

test("shipped limits are sane", () => {
  const l = loadLimits();
  assert.ok(l.max_rps > 0, "max_rps must stay above 0 in the shipped config");
});
