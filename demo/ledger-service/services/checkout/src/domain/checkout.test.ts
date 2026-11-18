import test from "node:test";
import assert from "node:assert/strict";
import { totals } from "./checkout.ts";

test("totals with coupon and tax", () => {
  assert.deepEqual(totals([{ sku: "a", unitMinor: 1000, qty: 2 }], { couponPct: 10 }), { subtotal: 2000, discount: 200, tax: 135, total: 1935 });
});

test("rejects bad input", () => {
  assert.throws(() => totals([{ sku: "a", unitMinor: 10, qty: 0 }]), RangeError);
  assert.throws(() => totals([], { couponPct: 80 }), RangeError);
});
