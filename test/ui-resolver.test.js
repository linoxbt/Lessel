"use strict";
// UI resolvers and MCP actions: permission filtering, plain words instead of account ids, UTC times, the queued
// snapshot import (namespaced keys, imported repos), actions on imported items, settings, accounts and links.

const test = require("node:test");
const assert = require("node:assert/strict");
const { connectDb, resetSchema, makeWorld, teardown } = require("./helpers/world");

const repo = require("../src/db/repo");
const J = require("../src/events/jira");
const B = require("../src/events/bitbucket");
const jobs = require("../src/jobs");
const actions = require("../src/mcp/actions");
const snapshot = require("../src/services/snapshot");
const perms = require("../src/ui/permissions");
const ui = require("../src/ui/resolver");
const { ports } = require("../src/ports");

const { DEFINITIONS } = ui;
let pool, w;
let prSeq = 0;
const MIG = ["services/ledger/migrations/0001.sql"];
const BROOK = { jira: "j-brook", bb: "u-brook", mcp: "m-brook" };
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const bbEvent = (eventType, extra) => ({ eventType, workspace: { uuid: "ws" }, repository: { uuid: "r1" }, ...extra });

async function ticket(key) {
  const i = w.issue(key);
  i.fields.assignee = { accountId: BROOK.jira };
  await J.onJiraEvent({ eventType: "avi:jira:assigned:issue", issue: i, changelog: { id: `assign-${key}` } });
  const id = ++prSeq;
  const p = w.pr({ id, key, author: BROOK.bb, paths: MIG });
  await B.onBitbucketEvent(bbEvent("avi:bitbucket:created:pullrequest", { pullrequest: { id, updated_on: p.updated_on } }));
  const m = w.merge(id);
  await B.onBitbucketEvent(bbEvent("avi:bitbucket:fulfilled:pullrequest", { pullrequest: { id, updated_on: m.updated_on } }));
  const head = w.mainLine.at(-1);
  await B.onBitbucketEvent(bbEvent("avi:bitbucket:completed:deployment", { deployment: { uuid: `d-${head}`,
    environment: { environment_type: { name: "Production" } }, release: { commit: { hash: head } },
    state: { completed_on: new Date(w.clock.t).toISOString() } } }));
}
async function linkIncident(incKey, workKey) {
  const inc = w.issue(incKey, { project: { key: "INC" }, issuetype: { name: "Incident" }, priority: { name: "High" } });
  const work = w.issues.get(workKey);
  const id = String(w.links.size + 500);
  // Jira semantics: source <outward> destination, so "PAY-104 causes INC-9".
  const link = { id, sourceIssueId: work.id, destinationIssueId: inc.id, issueLinkType: { name: "Problem/Incident" } };
  w.links.set(id, link);
  await J.onJiraEvent({ eventType: "avi:jira:created:issuelink", issueLink: link, atlassianId: "oncall-1" });
}
const browse = projects => perms.setPermissionPort({ canBrowseProject: async p => projects.includes(p) });
const ctx = { accountId: "u-viewer" };

test.before(async () => {
  pool = await connectDb();
  if (!pool && process.env.LESSEL_REQUIRE_DB) throw new Error("LESSEL_REQUIRE_DB is set but no test database is reachable");
});
test.after(async () => { perms.resetPermissionPort(); teardown(); await pool?.end(); });
test.afterEach(() => perms.resetPermissionPort());

test("board, evidence, history and panel: keys the viewer can't browse are redacted, people are words, times are UTC", async (t) => {
  if (!pool) return t.skip("no test database");
  await resetSchema(pool);
  w = makeWorld();
  await repo.setSetting("windowHours", 72);
  await repo.setSetting("repos", { r1: { deploys: true, workspace: "ws", defaultService: "ledger" } });
  await repo.upsertAgent({ agent_id: "brook", display_name: "Brook" });
  await repo.addAccount("jira", BROOK.jira, "brook");
  await repo.addAccount("bitbucket", BROOK.bb, "brook");
  await repo.addAccount("mcp", BROOK.mcp, "brook");
  for (let n = 1; n <= 4; n++) await ticket(`PAY-${100 + n}`);
  w.advance(80);
  await jobs.hourly();
  await linkIncident("INC-9", "PAY-104");
  assert.equal((await repo.getSignal("incident:INC-9:PAY-104")).decided_by, "oncall-1");

  // The viewer can browse PAY but not INC.
  browse(["PAY"]);
  const board = await DEFINITIONS.getBoard({ context: ctx });
  const cell = board.cells.find(c => c.agentId === "brook");
  assert.ok(cell.probation);
  assert.ok(!/INC-9/.test(cell.sentence) && cell.sentence.includes(perms.HIDDEN), cell.sentence);

  const ev = await DEFINITIONS.getEvidence({ payload: { agentId: "brook", shapeId: cell.shapeId }, context: ctx });
  const failed = ev.items.find(i => i.issueKey === "PAY-104");
  assert.equal(failed.outcome, "failed");
  assert.deepEqual([failed.signals[0].ref, failed.signals[0].decidedBy, failed.signals[0].via],
    [perms.HIDDEN, "a person", "caused-by link"]);
  assert.match(failed.windowStart, ISO);
  assert.match(failed.windowEnds, ISO);
  assert.match(failed.prs[0].mergeCommit, /^deadbeef/);
  assert.ok(ev.decisions.length && ev.decisions.every(d => ISO.test(d.at) && !/INC-9/.test(d.cause)));
  assert.equal(ev.windowNote, "Observation window: 3 days (demo setting)");

  const hist = await DEFINITIONS.getHistory({ context: ctx });
  assert.ok(hist.length && hist.every(h => ISO.test(h.at)));
  assert.ok(hist.some(h => h.cause.includes(`${perms.HIDDEN} was confirmed as caused by PAY-104`)), JSON.stringify(hist));

  const panel = await DEFINITIONS.getPanel({ payload: { issueKey: "PAY-104" }, context: ctx });
  assert.equal(panel.signals[0].ref, perms.HIDDEN);
  assert.ok(!/INC-9/.test(panel.decision.sentence));

  // Whoever decided sees "you"; nothing anywhere carries the account id.
  const mine = await DEFINITIONS.getEvidence({ payload: { agentId: "brook", shapeId: cell.shapeId }, context: { accountId: "oncall-1" } });
  assert.equal(mine.items.find(i => i.issueKey === "PAY-104").signals[0].decidedBy, "you");
  for (const out of [board, ev, hist, panel]) assert.ok(!JSON.stringify(out).includes("oncall-1"));

  // A viewer who can't browse PAY sees outcomes but no keys.
  browse([]);
  const blind = await DEFINITIONS.getEvidence({ payload: { agentId: "brook", shapeId: cell.shapeId }, context: ctx });
  assert.ok(blind.items.length === 4 && blind.items.every(i => i.hidden && i.issueKey === null && !i.signals.length));
  assert.ok(!JSON.stringify(blind).includes("PAY-"));

  // MCP: same filtering as the calling account.
  browse(["PAY"]);
  const explain = await actions.explainRecord({ agent: "brook" }, { principal: { accountId: BROOK.mcp } });
  assert.match(explain, /PAY-104: failed/);
  assert.ok(!explain.includes("INC-9"));
  browse([]);
  assert.match(await actions.rankAssignees({ issueKey: "PAY-104" }, {}), /^Refused: You can't view PAY-104/);
  assert.match(await actions.checkTicketFit({ issueKey: "PAY-104" }, { principal: { accountId: BROOK.mcp } }), /^Refused: You can't view/);
  const explainBlind = await actions.explainRecord({ agent: "brook" }, {});
  assert.ok(!explainBlind.includes("PAY-") && explainBlind.includes(perms.HIDDEN));
});

test("suspected countdown and possible bad input on the panel", async (t) => {
  if (!pool) return t.skip("no test database");
  const cfg = await repo.getSettings();
  // PAY-201: deployed, window open; a suspected reopen and a confirmed revert.
  await ticket("PAY-201");
  const item = await repo.getItem("PAY-201");
  await repo.insertSignal({ signal_id: "reopen:PAY-201:1", issue_key: "PAY-201", kind: "reopen", ref: "PAY-201", causality: "suspected" });
  let p = await DEFINITIONS.getPanel({ payload: { issueKey: "PAY-201" }, context: ctx });
  const s = p.signals.find(x => x.id === "reopen:PAY-201:1");
  const hoursLeft = (item.window_ends.getTime() + cfg.suspectedExpiryHours * 3600e3 - w.clock.t) / 3600e3;
  assert.equal(s.expiresInHours, Math.ceil(hoursLeft));
  assert.match(s.expiresAt, ISO);
  assert.equal(s.windowOpen, true);
  assert.equal(p.possibleBadInput, false);

  // An inferred read of a tainted page version, plus a confirmed failure: a person should look.
  await repo.upsertSource({ source_id: "confluence:page:77", url: "https://x/wiki/77", title: "Runbook" });
  await repo.patchSource("confluence:page:77", { state: "confirmed", tainted_from_version: 2 });
  await repo.insertRead({ read_id: "r-77", issue_key: "PAY-201", agent_id: "brook", source_id: "confluence:page:77",
    source_version: 2, version_basis: "inferred", method: "attested", read_at: new Date(w.clock.t), recorded_at: new Date(w.clock.t) });
  await repo.insertSignal({ signal_id: "revert:feed", issue_key: "PAY-201", kind: "revert", ref: "feedface", causality: "confirmed",
    confirmed_via: "revert", decided_by: "lessel:revert" });
  p = await DEFINITIONS.getPanel({ payload: { issueKey: "PAY-201" }, context: ctx });
  assert.equal(p.possibleBadInput, true);
  assert.equal(p.signals.find(x => x.id === "revert:feed").ref, "feedface");
});

test("settings: a rejected save surfaces its reason; removing an account is audited without its id", async (t) => {
  if (!pool) return t.skip("no test database");
  await assert.rejects(DEFINITIONS.saveSetting({ payload: { key: "notASetting", value: 1 }, context: ctx }), /Unknown setting/);
  await DEFINITIONS.removeAccount({ payload: { product: "bitbucket", accountId: "{U-BROOK}" }, context: { accountId: "admin-1" } });
  assert.ok(!(await repo.accounts()).some(a => a.product === "bitbucket"));
  const log = await repo.staffActionsFor("brook");
  assert.equal(log.at(-1).action, "remove-account");
  assert.ok(!JSON.stringify(log).includes("u-brook"));
  await assert.rejects(DEFINITIONS.removeAccount({ payload: { product: "bitbucket", accountId: "nobody" }, context: ctx }), /isn't mapped/);
  ports.jira.userHas = async p => p !== "ADMINISTER";
  await assert.rejects(DEFINITIONS.removeAccount({ payload: { product: "jira", accountId: BROOK.jira }, context: ctx }), /Only Jira admins/);
  ports.jira.userHas = async () => true;
});

test("snapshot: export has no account ids; import is queued, namespaced, and imported items can be decided by admins", async (t) => {
  if (!pool) return t.skip("no test database");
  const snap = await snapshot.exportSnapshot();
  const text = JSON.stringify(snap);
  assert.ok(!("agent_accounts" in snap.tables));
  for (const id of ["j-brook", "m-brook", "oncall-1", "admin-1"]) assert.ok(!text.includes(id), `export contains ${id}`);
  const before = (await repo.allRecords()).map(r => [r.subject_id, r.shape_id, r.clean, r.total, r.earned_level]);

  await resetSchema(pool);
  const queued = [];
  const enqueue = jobs.enqueue;
  jobs.enqueue = async (body, key) => { queued.push({ body, key }); return { queued: 1 }; };
  try {
    await assert.rejects(DEFINITIONS.importSnapshot({ payload: { json: "{nope" }, context: ctx }), /isn't valid JSON/);
    await assert.rejects(DEFINITIONS.importSnapshot({ payload: { json: text, keyPrefix: "x1" }, context: ctx }), /2 to 8 letters/);
    const st = await DEFINITIONS.importSnapshot({ payload: { json: text }, context: { accountId: "admin-1" } });
    assert.equal(st.state, "queued");
    assert.ok(st.chunks > 1, "a real snapshot spans several rows");
    assert.ok(!JSON.stringify(st).includes("admin-1"), "the actor isn't stored in the status");
    assert.equal(queued.length, 1);
    assert.deepEqual([queued[0].key, queued[0].body.type], ["import-snapshot", "import-snapshot"]);
    // Staged rows aren't settings.
    const view = await DEFINITIONS.getSettings({ context: ctx });
    assert.ok(!Object.keys(view.settings).some(k => k.startsWith("~")));
    await assert.rejects(DEFINITIONS.importSnapshot({ payload: { json: text }, context: ctx }), /already in progress/);

    await jobs.handlers["import-snapshot"](queued[0].body);
  } finally {
    jobs.enqueue = enqueue;
  }
  const done = await DEFINITIONS.importStatus({ context: ctx });
  assert.equal(done.state, "done", done.error);
  assert.match(done.finishedAt, ISO);
  assert.equal(done.imported.work_items, snap.counts.work_items);
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM settings WHERE setting_key LIKE '~snapshot:c%'");
  assert.equal(Number(n), 0, "staged rows are dropped");

  const after = (await repo.allRecords()).map(r => [r.subject_id, r.shape_id, r.clean, r.total, r.earned_level]);
  assert.deepEqual(after, before, "recomputing namespaced history gives the same records");
  assert.equal(await repo.getItem("PAY-104"), null);
  assert.equal((await repo.getItem("DEMOPAY-104")).repo_uuid, "imported:r1");
  assert.ok((await repo.prsForItem("DEMOPAY-104")).every(p => p.repo_uuid === "imported:r1" && p.workspace_uuid === "imported:ws"));
  const sig = await repo.getSignal("incident:DEMOINC-9:DEMOPAY-104");
  assert.deepEqual([sig.ref, sig.decided_by, sig.causality], ["DEMOINC-9", "staff", "confirmed"]);
  const cfg = await repo.getSettings();
  assert.deepEqual(cfg.importedSnapshot.projects, ["DEMOINC", "DEMOPAY"]);
  assert.equal(cfg.importedSnapshot.keyPrefix, "DEMO");
  assert.equal((await repo.staffActionsFor("snapshot"))[0].actor, "admin-1");

  // Imported projects aren't Jira projects here: visible without a Jira check, decided by admins only.
  browse([]);
  const board = await DEFINITIONS.getBoard({ context: ctx });
  assert.match(board.importedNote, /^Imported history: .* Imported work item keys start with DEMO/);
  const shapeId = board.cells[0].shapeId;
  const ev = await DEFINITIONS.getEvidence({ payload: { agentId: "brook", shapeId }, context: ctx });
  const item = ev.items.find(i => i.issueKey === "DEMOPAY-104");
  assert.ok(item.imported && item.signals[0].ref === "DEMOINC-9");
  assert.ok(item.prs.every(p => p.imported));
  const payload = { signalId: sig.signal_id, view: "evidence", agentId: "brook", shapeId };
  let r = await DEFINITIONS.reopenDecision({ payload: { ...payload, note: "rehearsal" }, context: ctx });
  assert.equal(r.items.find(i => i.issueKey === "DEMOPAY-104").signals[0].causality, "associated");
  ports.jira.userHas = async p => p !== "ADMINISTER";
  await assert.rejects(DEFINITIONS.confirmCause({ payload, context: ctx }), /Only Jira admins/);
  ports.jira.userHas = async () => true;
  r = await DEFINITIONS.confirmCause({ payload, context: ctx });
  const s = r.items.find(i => i.issueKey === "DEMOPAY-104").signals[0];
  assert.deepEqual([s.causality, s.decidedBy], ["confirmed", "you"]);

  // A site with history refuses a second import before staging anything.
  await assert.rejects(DEFINITIONS.importSnapshot({ payload: { json: text }, context: ctx }), /already has history/);
});

test("links: admin-only Jira resolvers; Confluence pairing needs a Confluence admin", async (t) => {
  if (!pool) return t.skip("no test database");
  const calls = [];
  const state = { bitbucket: { linked: false }, confluence: { linked: false } };
  const fake = {
    status: async () => structuredClone(state),
    createPairingCode: async (target, actor) => { calls.push(["code", target, actor]); state[target].pending = true; return { code: "PAIR-123" }; },
    unlink: async (target, actor) => { calls.push(["unlink", target, actor]); state[target] = { linked: false }; return { ok: true }; },
    pairConfluence: async (code, actor) => {
      calls.push(["pair", code, actor]);
      if (code !== "PAIR-123") throw new Error("That pairing code isn't valid.");
      return { ok: true };
    },
    confluenceStatus: async () => ({ linked: calls.some(c => c[0] === "pair" && c[1] === "PAIR-123"), linkedAt: "2026-11-19T10:00:00.000Z" }),
  };
  ui.setLinkService(fake);
  try {
    const r = await DEFINITIONS.createPairingCode({ payload: { target: "confluence" }, context: { accountId: "admin-1" } });
    assert.deepEqual([r.code, r.status.confluence.pending], ["PAIR-123", true]);
    await assert.rejects(DEFINITIONS.createPairingCode({ payload: { target: "github" }, context: ctx }), /Unknown link target/);
    assert.deepEqual(await DEFINITIONS.unlink({ payload: { target: "confluence" }, context: { accountId: "admin-1" } }),
      { bitbucket: { linked: false }, confluence: { linked: false } });
    ports.jira.userHas = async () => false;
    await assert.rejects(DEFINITIONS.linkStatus({ context: ctx }), /Only Jira admins/);
    await assert.rejects(DEFINITIONS.unlink({ payload: { target: "bitbucket" }, context: ctx }), /Only Jira admins/);
    ports.jira.userHas = async () => true;

    perms.setPermissionPort({ isConfluenceAdmin: async () => false });
    await assert.rejects(DEFINITIONS.confluenceLinkStatus({ context: ctx }), /Only Confluence admins/);
    await assert.rejects(DEFINITIONS.pairConfluence({ payload: { code: "PAIR-123" }, context: ctx }), /Only Confluence admins/);
    perms.setPermissionPort({ isConfluenceAdmin: async () => true });
    await assert.rejects(DEFINITIONS.pairConfluence({ payload: { code: "  " }, context: ctx }), /Paste the pairing code/);
    await assert.rejects(DEFINITIONS.pairConfluence({ payload: { code: "WRONG" }, context: ctx }), /isn't valid/);
    const st = await DEFINITIONS.pairConfluence({ payload: { code: " PAIR-123 " }, context: { accountId: "c-admin" } });
    assert.equal(st.linked, true);
    assert.deepEqual(calls.at(-1), ["pair", "PAIR-123", "c-admin"]);
  } finally {
    ui.setLinkService(null);
  }
});
