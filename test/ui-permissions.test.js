"use strict";
// Permission filtering and plain-words helpers for the UI and MCP outputs (no database needed).

const test = require("node:test");
const assert = require("node:assert/strict");
const perms = require("../src/ui/permissions");
const { namespacer } = require("../src/services/snapshot");

test.afterEach(() => perms.resetPermissionPort());

test("viewer: one check per project per request, fails closed, redacts keys in text, keeps shas", async () => {
  const asked = [];
  perms.setPermissionPort({ canBrowseProject: async p => {
    asked.push(p);
    if (p === "BAD") throw new Error("HTTP 404");
    return p === "PAY";
  } });
  const v = perms.viewer({ open: ["DEMOPAY"] });
  assert.equal(await v.canView("PAY-1"), true);
  assert.equal(await v.canView("PAY-2"), true);
  assert.equal(await v.canView("INC-9"), false);
  assert.equal(await v.canView("BAD-1"), false, "an error hides the key");
  assert.equal(await v.canView("DEMOPAY-104"), true, "imported projects need no Jira check");
  assert.equal(await v.canView("not a key"), false);
  assert.deepEqual(asked, ["PAY", "INC", "BAD"]);

  assert.equal(await v.key("INC-9"), null);
  assert.equal(await v.label("INC-9"), perms.HIDDEN);
  assert.equal(await v.label("deadbeef0005"), "deadbeef0005", "commit shas aren't issue keys");
  assert.equal(await v.text("On probation: Confirmed sev 2 incident INC-9 on PAY-104."),
    `On probation: Confirmed sev 2 incident ${perms.HIDDEN} on PAY-104.`);
  assert.equal(await v.text(null), null);
  assert.equal(await v.text("ledger/schema-migration is L3"), "ledger/schema-migration is L3");
});

test("who decided, in words: no account id ever comes back", () => {
  const byAccount = new Map([["j-brook", "Brook"]]);
  assert.equal(perms.actorWords("oncall-1", { byAccount }), "a person");
  assert.equal(perms.actorWords("oncall-1", { me: "oncall-1", byAccount }), "you");
  assert.equal(perms.actorWords("j-brook", { byAccount }), "Brook");
  assert.equal(perms.actorWords("lessel:revert"), "Lessel (revert)");
  assert.equal(perms.actorWords("lessel:expired"), "nobody (expired undecided)");
  assert.equal(perms.actorWords("link:501"), "a caused-by link (creator not available)");
  assert.equal(perms.actorWords("staff"), "staff");
  assert.equal(perms.actorWords("closed-account"), "a person (account closed)");
  assert.equal(perms.actorWords(null), null);
  assert.equal(perms.viaWords("link:501"), "caused-by link");
  assert.equal(perms.viaWords("source:confluence:page:1", () => "Ledger runbook"), "bad input from Ledger runbook");
  assert.equal(perms.viaWords("button"), "Confirm cause button");
});

test("Confluence admin check goes through the port", async () => {
  perms.setPermissionPort({ isConfluenceAdmin: async () => true });
  assert.equal(await perms.isConfluenceAdmin(), true);
  perms.setPermissionPort({ isConfluenceAdmin: async () => "yes" });
  assert.equal(await perms.isConfluenceAdmin(), false, "only a real true counts");
});

test("snapshot namespacing: keys get the prefix everywhere; repos, PRs and sources can't match live ones", () => {
  const ns = namespacer("DEMO");
  assert.deepEqual(ns.row("work_items", { issue_key: "PAY-212", repo_uuid: "r1", shape_id: "ledger/schema-migration" }),
    { issue_key: "DEMOPAY-212", repo_uuid: "imported:r1", shape_id: "ledger/schema-migration" });
  assert.deepEqual(ns.row("signals", { signal_id: "incident:INC-42:PAY-212", issue_key: "PAY-212", ref: "INC-42",
    confirmed_via: "source:confluence:page:9100", decided_by: "staff" }),
  { signal_id: "incident:DEMOINC-42:DEMOPAY-212", issue_key: "DEMOPAY-212", ref: "DEMOINC-42",
    confirmed_via: "source:imported:confluence:page:9100", decided_by: "staff" });
  assert.equal(ns.row("signals", { ref: "deadbeef0005" }).ref, "deadbeef0005");
  assert.deepEqual(ns.row("prs", { repo_uuid: "r1", workspace_uuid: "ws", issue_key: "PAY-1", head_commit: "abc" }),
    { repo_uuid: "imported:r1", workspace_uuid: "imported:ws", issue_key: "DEMOPAY-1", head_commit: "abc" });
  assert.equal(ns.row("holds", { reason: "Confirmed sev 2 incident INC-42." }).reason, "Confirmed sev 2 incident DEMOINC-42.");
  assert.equal(ns.row("decision_events", { cause: "INC-42 was confirmed as caused by PAY-212" }).cause,
    "DEMOINC-42 was confirmed as caused by DEMOPAY-212");
  assert.equal(ns.row("sources", { source_id: "imported:confluence:page:1" }).source_id, "imported:confluence:page:1", "idempotent");
  assert.deepEqual([...ns.projects].sort(), ["DEMOINC", "DEMOPAY"]);
});
