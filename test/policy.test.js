"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decideCore, sentence, needWords, needsBuildCheck } = require("../src/core/policy");
const { recordFromOutcomes } = require("../src/core/levels");
const { deriveHolds } = require("../src/core/outcomes");

const brook = { agent_id: "brook", display_name: "Brook", suspended: 0 };
const shape = { shape_id: "ledger/schema-migration", critical: 0, classified_by: "path" };
const rec = (c, n) => recordFromOutcomes([...Array(c).fill("clean"), ...Array(n - c).fill("failed")]);

test("L3 with green build may self-merge; without a PR it's if-green", () => {
  const noPr = decideCore({ agent: brook, shape, rec: rec(16, 17) });
  assert.equal(noPr.selfMerge, "if-green");
  assert.equal(noPr.approvals, 1);
  assert.ok(needsBuildCheck(noPr));
  const green = decideCore({ agent: brook, shape, rec: rec(16, 17), buildGreen: true });
  assert.equal(green.selfMerge, "yes");
  assert.equal(green.approvals, 0);
  assert.match(sentence(brook, shape, green), /^Brook is L3 on ledger\/schema-migration \(16 of 17 clean, lower bound 83%\)\. It may self-merge\.$/);
});

test("demo turn: confirmed INC-42 → earned L2, effective L1, 2 approvals", () => {
  const items = [{ issue_key: "PAY-201", outcome: "failed", merged_at: "2026-12-15T10:00:00Z" }];
  const signals = [{ signal_id: "incident:INC-42:PAY-201", issue_key: "PAY-201", kind: "incident", ref: "INC-42",
    severity: 2, causality: "confirmed", decided_at: "2026-12-17T10:00:00Z" }];
  const holds = deriveHolds({ agentId: "brook", shapeId: shape.shape_id, items, signals });
  const d = decideCore({ agent: brook, shape, rec: rec(16, 18), holds });
  assert.equal(d.earned, 2);
  assert.equal(d.effective, 1);
  assert.equal(d.approvals, 2);
  assert.equal(needWords(d), "needs 2 human approvals");
  assert.equal(sentence(brook, shape, d),
    "Brook is earned L2, effective L1 on ledger/schema-migration (16 of 18 clean, lower bound 78%). " +
    "Probation after INC-42: 3 clean to go.");
});

test("blocked decisions never print 'Lundefined' (v1.1 bug)", () => {
  const ctx = { state: "blocked", reason: "Context: Ledger runbook v8 is inside the tainted range v7–v8." };
  const d = decideCore({ agent: brook, shape: { ...shape, shape_id: "ledger/business-logic" }, rec: rec(11, 11), ctx });
  const s = sentence(brook, { shape_id: "ledger/business-logic" }, d);
  assert.ok(!s.includes("undefined"));
  assert.equal(s, "Brook is L3 on ledger/business-logic (11 of 11 clean, lower bound 87%). " +
    "Context: Ledger runbook v8 is inside the tainted range v7–v8. This task is blocked.");
  const susp = decideCore({ agent: { ...brook, suspended: 1 }, shape, rec: rec(16, 17) });
  assert.ok(susp.blocked);
  assert.ok(!sentence(brook, shape, susp).includes("undefined"));
});

test("no history → L1, 2 approvals, honest sentence", () => {
  const d = decideCore({ agent: brook, shape, rec: null });
  assert.equal(d.effective, 1);
  assert.equal(d.approvals, 2);
  assert.match(sentence(brook, shape, d), /no confirmed outcomes yet/);
});

test("L0 is blocked", () => {
  const d = decideCore({ agent: brook, shape, rec: rec(1, 5) });
  assert.ok(d.blocked);
  assert.match(sentence(brook, shape, d), /L0: suggest only\. This task is blocked\.$/);
});

test("self-merge withheld at L3 for critical, review, warn and fallback shapes, with reasons", () => {
  const cases = [
    [{ shape: { ...shape, critical: 1 } }, /critical service/],
    [{ holds: [{ kind: "review" }] }, /suspected signal/],
    [{ ctx: { state: "warn", reason: "Context: Runbook is under taint review." } }, /under taint review/],
    [{ shape: { ...shape, fallback: true } }, /shape not confirmed/],
  ];
  for (const [extra, re] of cases) {
    const d = decideCore({ agent: brook, shape, rec: rec(16, 17), buildGreen: true, ...extra });
    assert.equal(d.selfMerge, "no");
    assert.equal(d.approvals, 1);
    assert.match(d.reasons.join(" "), re);
  }
});

test("approvals come from settings", () => {
  const cfg = { ...require("../src/core/defaults").DEFAULTS, approvalsByLevel: { 1: 1, 2: 1, 3: 1 } };
  assert.equal(decideCore({ agent: brook, shape, rec: null }, cfg).approvals, 1);
});

test("AI-chosen shapes are capped at L1 and at the agent's lowest level in that service", () => {
  const llm = { ...shape, classified_by: "llm" };
  const d = decideCore({ agent: brook, shape: llm, rec: rec(16, 17), serviceFloor: 3 });
  assert.equal(d.effective, 1);
  assert.equal(d.approvals, 2);
  assert.match(d.reasons.join(" "), /Shape chosen by the AI: limited to L1 until a person confirms it\./);
  const blocked = decideCore({ agent: brook, shape: llm, rec: rec(16, 17), serviceFloor: 0 });
  assert.equal(blocked.blocked, true, "an agent at L0 somewhere in the service is blocked on an unconfirmed AI shape");
  const confirmed = decideCore({ agent: brook, shape: { ...shape, classified_by: "manual" }, rec: rec(16, 17), serviceFloor: 0 });
  assert.equal(confirmed.effective, 3);
});
