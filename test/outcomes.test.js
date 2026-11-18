"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const O = require("../src/core/outcomes");

const day = O.DAY;
const T0 = Date.parse("2026-12-01T00:00:00Z");
const item = { actor_kind: "agent", deployed_at: new Date(T0), window_ends: new Date(T0 + 3 * day) };

test("outcome: failed beats everything, pending inside window, clean after", () => {
  assert.equal(O.deriveOutcome(item, [{ causality: "confirmed" }], T0 + day), "failed");
  assert.equal(O.deriveOutcome(item, [], T0 + day), "pending");
  assert.equal(O.deriveOutcome(item, [], T0 + 4 * day), "clean");
  assert.equal(O.deriveOutcome(item, [{ causality: "associated" }, { causality: "dismissed" }], T0 + 4 * day), "clean");
  assert.equal(O.deriveOutcome(item, [{ causality: "suspected" }], T0 + 4 * day), "pending");
  assert.equal(O.deriveOutcome(item, [{ causality: "excused" }], T0 + 4 * day), "excused");
  assert.equal(O.deriveOutcome({ ...item, actor_kind: "mixed" }, [], T0 + 4 * day), "unscored");
  assert.equal(O.deriveOutcome({ actor_kind: "agent", window_ends: null }, [], T0), "pending");
});

test("suspected signals expire after the window plus the expiry", () => {
  const s = { causality: "suspected" };
  const cfg = { ...require("../src/core/defaults").DEFAULTS, suspectedExpiryHours: 24 };
  assert.equal(O.suspectedExpired(s, item, T0 + 3.5 * day, cfg), false);
  assert.equal(O.suspectedExpired(s, item, T0 + 4.1 * day, cfg), true);
  assert.equal(O.suspectedExpired({ causality: "associated" }, item, T0 + 10 * day, cfg), false);
});

test("late confirmation allowed for 90 days", () => {
  assert.equal(O.canConfirm(item, T0 + 89 * day), true);
  assert.equal(O.canConfirm(item, T0 + 91 * day), false);
});

test("incident causality", () => {
  const base = { item, shapeService: "ledger" };
  assert.equal(O.incidentCausality({ ...base, viaCausedByLink: true }), "confirmed");
  assert.equal(O.incidentCausality({ ...base, incidentCreatedAt: T0 + 3600e3, incidentService: "ledger" }), "suspected");
  assert.equal(O.incidentCausality({ ...base, incidentCreatedAt: T0 + 3600e3, incidentService: null }), "associated");
  assert.equal(O.incidentCausality({ ...base, incidentCreatedAt: T0 + 2 * day, incidentService: "ledger" }), "associated");
});

test("severity mapping", () => {
  assert.equal(O.severityOf({ priority: { name: "High" } }), 2);
  assert.equal(O.severityOf({}), 3);
});

test("probation is derived: clears after 3 clean merged after the confirmation", () => {
  const sig = { signal_id: "incident:INC-42:PAY-201", issue_key: "PAY-201", kind: "incident", ref: "INC-42",
    severity: 1, causality: "confirmed", decided_at: new Date(T0) };
  const before = { outcome: "clean", merged_at: new Date(T0 - day) };   // doesn't count: merged before
  const after = n => Array.from({ length: n }, (_, i) => ({ outcome: "clean", merged_at: new Date(T0 + (i + 1) * day) }));
  const h = items => O.deriveHolds({ agentId: "brook", shapeId: "s", items, signals: [sig] });
  assert.equal(h([before, before, before])[0].clean_needed, 3);
  assert.equal(h([...after(2)])[0].clean_needed, 1);
  assert.equal(h(after(3)).length, 0);
  // dismissing the incident lifts probation (v1.1 kept it)
  assert.equal(O.deriveHolds({ agentId: "brook", shapeId: "s", items: [], signals: [{ ...sig, causality: "dismissed" }] }).length, 0);
  // sev 3 never puts an agent on probation
  assert.equal(O.deriveHolds({ agentId: "brook", shapeId: "s", items: [], signals: [{ ...sig, severity: 3 }] }).length, 0);
});

test("review hold while a suspected signal is open", () => {
  const holds = O.deriveHolds({ agentId: "a", shapeId: "s", items: [],
    signals: [{ signal_id: "reopen:PAY-1:9", issue_key: "PAY-1", kind: "reopen", causality: "suspected" }] });
  assert.equal(holds.length, 1);
  assert.equal(holds[0].kind, "review");
});
