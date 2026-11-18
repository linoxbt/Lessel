import test from "node:test";
import assert from "node:assert/strict";
import { money, bps, format } from "./money.ts";
import { balances, transfer, validate, LedgerError } from "./ledger.ts";
import { transferFee } from "./fees.ts";

test("money rounds basis points half away from zero", () => {
  assert.equal(bps(money(1000, "USD"), 25).amount, 3n);   // 2.5 → 3
  assert.equal(bps(money(-1000, "USD"), 25).amount, -3n);
  assert.equal(format(money(-12345, "EUR")), "-123.45 EUR");
});

test("transfers balance and move money", () => {
  const b = balances([transfer("t1", "alice", "bob", money(500, "USD")), transfer("t2", "bob", "carol", money(200, "USD"))]);
  assert.equal(b.get("alice:USD")?.amount, -500n);
  assert.equal(b.get("bob:USD")?.amount, 300n);
  assert.equal(b.get("carol:USD")?.amount, 200n);
});

test("unbalanced and degenerate transactions are rejected", () => {
  assert.throws(() => validate({ id: "x", lines: [{ accountId: "a", amount: money(1, "USD") }, { accountId: "b", amount: money(-2, "USD") }] }), LedgerError);
  assert.throws(() => transfer("y", "a", "a", money(1, "USD")), LedgerError);
  assert.throws(() => transfer("z", "a", "b", money(0, "USD")), LedgerError);
});

test("fees respect floor and cap", () => {
  assert.equal(transferFee(money(1000, "USD")).amount, 30n);      // floor
  assert.equal(transferFee(money(100000, "USD")).amount, 250n);   // 0.25%
  assert.equal(transferFee(money(10000000, "USD")).amount, 500n); // cap
});
