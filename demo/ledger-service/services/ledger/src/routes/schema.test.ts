import test from "node:test";
import assert from "node:assert/strict";
import { parseNewAccount, SchemaError } from "./accounts/schema.ts";
import { parseTransfer } from "./entries/schema.ts";

test("account schema", () => {
  assert.deepEqual(parseNewAccount({ id: "acct_1", owner: " Ada ", currency: "USD" }), { id: "acct_1", owner: "Ada", currency: "USD" });
  assert.throws(() => parseNewAccount({ id: "A", owner: "x", currency: "USD" }), SchemaError);
  assert.throws(() => parseNewAccount({ id: "acct_2", owner: "x", currency: "GBP" }), SchemaError);
});

test("transfer schema", () => {
  assert.equal(parseTransfer({ id: "t", from: "a", to: "b", amount: 100, currency: "EUR" }).amount, 100n);
  assert.throws(() => parseTransfer({ id: "t", from: "a", to: "b", amount: 1.5, currency: "EUR" }), SchemaError);
  assert.throws(() => parseTransfer({ id: "t", from: "a", to: "b", amount: -1, currency: "EUR" }), SchemaError);
});
