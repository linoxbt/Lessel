"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULTS } = require("../src/core/defaults");
const S = require("../src/core/shape");
const { keyFromPr, revertedSha } = require("../src/core/keys");

const rules = { servicePaths: DEFAULTS.servicePaths, classPaths: DEFAULTS.classPaths };
const L = p => `services/ledger/${p}`;

test("glob semantics", () => {
  assert.ok(S.matches("migrations/**", "migrations/001.sql"));
  assert.ok(S.matches("migrations/**", "migrations/a/b.sql"));
  assert.ok(S.matches("**/*.test.ts", "a.test.ts"));
  assert.ok(S.matches("**/*.test.ts", "src/x/a.test.ts"));
  assert.ok(!S.matches("src/domain/**", "src/domainx/a.ts"));
  assert.ok(S.matches("src/routes/**/schema.ts", "src/routes/v1/pay/schema.ts"));
  assert.ok(!S.matches("package.json", "sub/package.json"));
});

test("service: longest pattern wins, critical first for multi-service PRs", () => {
  assert.equal(S.serviceForPath(L("x.ts"), rules.servicePaths).service, "ledger");
  const svc = S.serviceForPaths([L("a.ts"), "services/checkout/b.ts"],
    { servicePaths: rules.servicePaths, criticalServices: ["checkout"] });
  assert.equal(svc, "checkout");
  assert.equal(S.serviceForPaths(["README.md"], { servicePaths: rules.servicePaths, fallback: "ledger" }), "ledger");
});

test("class: riskiest any-match class wins; unmatched files ignored", () => {
  assert.equal(S.classFromPaths([L("migrations/002.sql"), L("src/domain/ledger.ts"), L("src/other.ts")], rules),
    "schema-migration");
  assert.equal(S.classFromPaths([L("src/domain/a.ts"), L("config/app.json")], rules), "config-infra");
});

test("class: only-classes need every file to match one of them", () => {
  assert.equal(S.classFromPaths([L("package.json"), L("package-lock.json")], rules), "dependency-bump");
  assert.equal(S.classFromPaths([L("package.json"), L("docs/readme.md")], rules), "dependency-bump");
  assert.equal(S.classFromPaths([L("src/a.test.ts")], rules), "test-fix");
  assert.equal(S.classFromPaths([L("package.json"), L("src/foo.ts")], rules), null); // → LLM
  assert.equal(S.classFromPaths([], rules), null);
});

test("riskier picks the earlier class in risk order", () => {
  assert.equal(S.riskier("test-fix", "schema-migration"), "schema-migration");
  assert.equal(S.riskier(null, "docs-copy"), "docs-copy");
});

test("Jira key: branch first, then title, configured projects only", () => {
  const keys = ["PAY"];
  assert.equal(keyFromPr({ source: { branch: { name: "PAY-201-ledger-index" } }, title: "x" }, keys), "PAY-201");
  // v1.1 bug: title was never consulted because the branch name is never empty
  assert.equal(keyFromPr({ source: { branch: { name: "fix-utf-8" } }, title: "PAY-77 fix" }, keys), "PAY-77");
  // "UTF-8" looks like a key but isn't a configured project
  assert.equal(keyFromPr({ source: { branch: { name: "UTF-8-then-PAY-9" } }, title: "" }, keys), "PAY-9");
  assert.equal(keyFromPr({ source: { branch: { name: "UTF-8" } }, title: "nothing" }, keys), null);
});

test("revert detection", () => {
  assert.equal(revertedSha('Revert "x"\n\nThis reverts commit ABCDEF1234567.'), "abcdef1234567");
  assert.equal(revertedSha("normal commit"), null);
});
