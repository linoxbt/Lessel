"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { lowerBound, ibeta } = require("../src/core/beta");
const { earnedLevel, recordFromOutcomes, emptyRecord } = require("../src/core/levels");

const near = (a, b, eps = 0.0015) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("incomplete beta matches known values", () => {
  near(ibeta(0.5, 1, 1), 0.5, 1e-9);
  near(ibeta(0.5, 2, 2), 0.5, 1e-9);
  near(ibeta(0.3, 2, 5), 0.579825, 1e-5); // scipy.special.betainc(2,5,0.3)
});

// Reference table from spec v1.2 §11.2 (computed with scipy.stats.beta.ppf)
const TABLE = [
  [0, 0, 0.535, 1], [4, 5, 0.622, 1], [5, 5, 0.787, 2], [2, 5, 0.367, 1], [1, 5, 0.260, 0],
  [6, 11, 0.451, 1], [9, 10, 0.752, 2], [8, 10, 0.658, 2], [10, 10, 0.862, 3], [10, 11, 0.768, 2],
  [11, 11, 0.871, 3], [11, 12, 0.782, 2], [12, 12, 0.879, 3], [16, 17, 0.833, 3], [16, 18, 0.778, 2],
  [19, 21, 0.804, 3],
];

for (const [c, n, lower, level] of TABLE) {
  test(`lower bound and level for ${c}/${n}`, () => {
    const lb = lowerBound(c, n);
    near(lb, lower);
    assert.equal(earnedLevel(lb, n), level);
  });
}

test("record ignores excused, pending and unscored outcomes", () => {
  const r = recordFromOutcomes(["clean", "clean", "failed", "excused", "pending", "unscored"]);
  assert.equal(r.clean, 2);
  assert.equal(r.total, 3);
});

test("empty record is L1 at the prior's lower bound", () => {
  const r = emptyRecord();
  assert.equal(r.earned_level, 1);
  near(r.lower90, 0.535);
});

test("lowerBound rejects impossible counts", () => {
  assert.throws(() => lowerBound(3, 2), RangeError);
});
