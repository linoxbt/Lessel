"use strict";
// Data access. Every function is one or a few statements; logic lives in src/core and src/services.

const { query, exec, one, ts, toDate } = require("./driver");
const { DEFAULTS } = require("../core/defaults");

const NOW = "CURRENT_TIMESTAMP(3)";
// Business times (decided_at, observed_at) follow the app clock so tests and replays are consistent.
const nowTs = () => ts(require("../ports").ports.now());

// ---------- settings ----------
async function getSettings() {
  const rows = await query("SELECT setting_key, value_json FROM settings", []);
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  for (const r of rows) {
    try { cfg[r.setting_key] = JSON.parse(r.value_json); } catch { /* keep default */ }
  }
  return cfg;
}
async function setSetting(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
  await exec(`INSERT INTO settings (setting_key, value_json) VALUES (?, ?)
    ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = ${NOW}`, [key, JSON.stringify(value)]);
}

// ---------- events ----------
const seen = async key => !!(await one("SELECT 1 AS x FROM events_seen WHERE event_key = ?", [key]));
const markSeen = key => exec("INSERT IGNORE INTO events_seen (event_key) VALUES (?)", [key]);

// ---------- agents ----------
// Bitbucket UUIDs arrive with or without braces and in mixed case; store and compare one form.
const normAccount = (product, id) => (product === "bitbucket" ? String(id ?? "").replace(/[{}]/g, "").toLowerCase() : id);
const listAgents = () => query("SELECT * FROM agents ORDER BY display_name", []);
const getAgent = id => one("SELECT * FROM agents WHERE agent_id = ?", [id]);
async function upsertAgent({ agent_id, display_name, kind = "connector", trailer_value = null }) {
  await exec(`INSERT INTO agents (agent_id, display_name, kind, trailer_value) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), kind = VALUES(kind),
      trailer_value = VALUES(trailer_value)`, [agent_id, display_name, kind, trailer_value]);
}
const setSuspended = (id, on) => exec("UPDATE agents SET suspended = ? WHERE agent_id = ?", [on ? 1 : 0, id]);
async function addAccount(product, accountId, agentId) {
  await exec(`INSERT INTO agent_accounts (product, account_id, agent_id) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE agent_id = VALUES(agent_id)`, [product, normAccount(product, accountId), agentId]);
}
const removeAccount = (product, accountId) =>
  exec("DELETE FROM agent_accounts WHERE product = ? AND account_id = ?", [product, normAccount(product, accountId)]);
const accounts = () => query("SELECT * FROM agent_accounts ORDER BY agent_id, product", []);
async function agentForAccount(products, accountId) {
  if (!accountId) return null;
  const list = Array.isArray(products) ? products : [products];
  const ids = [...new Set(list.map(p => normAccount(p, accountId)))];
  return one(`SELECT a.* FROM agent_accounts x JOIN agents a ON a.agent_id = x.agent_id
    WHERE x.account_id IN (${ids.map(() => "?").join(",")}) AND x.product IN (${list.map(() => "?").join(",")}) LIMIT 1`,
  [...ids, ...list]);
}
async function agentBitbucketAccounts() {
  const rows = await query("SELECT account_id FROM agent_accounts WHERE product = 'bitbucket'", []);
  return new Set(rows.map(r => r.account_id));
}

// ---------- shapes ----------
async function upsertShape({ shape_id, service, change_class, critical }) {
  await exec(`INSERT INTO shapes (shape_id, service, change_class, critical) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE critical = VALUES(critical)`, [shape_id, service, change_class, critical ? 1 : 0]);
}
const getShape = id => one("SELECT * FROM shapes WHERE shape_id = ?", [id]);
const listShapes = () => query("SELECT * FROM shapes ORDER BY shape_id", []);

// ---------- work items ----------
function itemRow(r) {
  if (!r) return r;
  for (const k of ["assigned_at", "merged_at", "deployed_at", "window_ends", "updated_at"]) r[k] = toDate(r[k]);
  return r;
}
const getItem = async key => itemRow(await one("SELECT * FROM work_items WHERE issue_key = ?", [key]));
async function createItem({ issue_key, actor_kind, assigned_agent_id = null, shape_id, classified_by, repo_uuid = null }) {
  await exec(`INSERT IGNORE INTO work_items
    (issue_key, actor_kind, assigned_agent_id, shape_id, shape_state, classified_by, repo_uuid, assigned_at)
    VALUES (?, ?, ?, ?, 'provisional', ?, ?, ${NOW})`,
  [issue_key, actor_kind, assigned_agent_id, shape_id, classified_by, repo_uuid]);
}
/** Only fields in `allowed` can be patched; every patch bumps updated_at (recompute watermark). */
const ITEM_FIELDS = new Set(["actor_kind", "assigned_agent_id", "agent_id", "repo_uuid", "shape_id", "shape_state",
  "classified_by", "size_lines", "merged_at", "deployed_at", "window_ends", "outcome", "changed_after_window"]);
async function patchItem(key, patch) {
  const cols = Object.keys(patch).filter(k => ITEM_FIELDS.has(k));
  if (!cols.length) return;
  const vals = cols.map(k => (patch[k] instanceof Date ? ts(patch[k]) : patch[k]));
  await exec(`UPDATE work_items SET ${cols.map(c => `${c} = ?`).join(", ")}, updated_at = ${NOW} WHERE issue_key = ?`,
    [...vals, key]);
}
const itemsForAgentShape = async (agentId, shapeId) =>
  (await query(`SELECT * FROM work_items WHERE agent_id = ? AND shape_id = ? AND actor_kind = 'agent'
    AND shape_state = 'frozen'`, [agentId, shapeId])).map(itemRow);
const teamItemsForShape = async shapeId =>
  (await query(`SELECT * FROM work_items WHERE actor_kind = 'team' AND shape_id = ? AND shape_state = 'frozen'`,
    [shapeId])).map(itemRow);
const itemsPastWindow = async now =>
  (await query(`SELECT * FROM work_items WHERE outcome = 'pending' AND window_ends IS NOT NULL AND window_ends <= ?`,
    [ts(now)])).map(itemRow);
const mergedUndeployed = async repoUuid =>
  (await query(`SELECT * FROM work_items WHERE repo_uuid = ? AND merged_at IS NOT NULL AND deployed_at IS NULL`,
    [repoUuid])).map(itemRow);
const agentShapePairs = () => query(`SELECT DISTINCT agent_id, shape_id FROM work_items
  WHERE actor_kind = 'agent' AND agent_id IS NOT NULL AND shape_state = 'frozen'`, []);
const itemsForAgent = async agentId => (await query(
  "SELECT * FROM work_items WHERE agent_id = ? OR assigned_agent_id = ? ORDER BY assigned_at DESC LIMIT 200",
  [agentId, agentId])).map(itemRow);

// ---------- PRs ----------
async function upsertPr(pr) {
  await exec(`INSERT INTO prs (repo_uuid, pr_id, workspace_uuid, issue_key, agent_id, state, head_commit,
      merge_commit, shape_id, shape_head, classified_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE workspace_uuid = VALUES(workspace_uuid), issue_key = VALUES(issue_key),
      agent_id = VALUES(agent_id), state = VALUES(state), head_commit = VALUES(head_commit),
      merge_commit = COALESCE(VALUES(merge_commit), merge_commit),
      shape_id = COALESCE(VALUES(shape_id), shape_id), shape_head = COALESCE(VALUES(shape_head), shape_head),
      classified_by = COALESCE(VALUES(classified_by), classified_by), updated_at = ${NOW}`,
  [pr.repo_uuid, pr.pr_id, pr.workspace_uuid ?? null, pr.issue_key, pr.agent_id ?? null, pr.state,
    pr.head_commit ?? null, pr.merge_commit ?? null, pr.shape_id ?? null, pr.shape_head ?? null,
    pr.classified_by ?? null]);
}
const getPrRow = (repo, id) => one("SELECT * FROM prs WHERE repo_uuid = ? AND pr_id = ?", [repo, id]);
const prsForItem = key => query("SELECT * FROM prs WHERE issue_key = ? ORDER BY pr_id", [key]);
const openPrsFor = (agentId, shapeId) => query(`SELECT p.* FROM prs p JOIN work_items w ON w.issue_key = p.issue_key
  WHERE p.state = 'open' AND p.agent_id = ? AND COALESCE(p.shape_id, w.shape_id) = ?`, [agentId, shapeId]);
const openPrsForItems = keys => keys.length
  ? query(`SELECT * FROM prs WHERE state = 'open' AND agent_id IS NOT NULL AND issue_key IN (${keys.map(() => "?").join(",")})`, keys)
  : [];
async function addPrCommits(repo, prId, shas) {
  for (const sha of shas) await exec("INSERT IGNORE INTO pr_commits (repo_uuid, pr_id, sha) VALUES (?, ?, ?)", [repo, prId, sha]);
}
/** PR whose merge commit or one of its commits matches a (possibly abbreviated) sha. */
async function prForCommit(repo, sha) {
  const like = `${sha}%`;
  return (await one(`SELECT p.* FROM prs p WHERE p.repo_uuid = ? AND p.state = 'merged' AND p.merge_commit LIKE ?`, [repo, like]))
    ?? one(`SELECT p.* FROM pr_commits c JOIN prs p ON p.repo_uuid = c.repo_uuid AND p.pr_id = c.pr_id
      WHERE c.repo_uuid = ? AND c.sha LIKE ? AND p.state = 'merged' LIMIT 1`, [repo, like]);
}

// ---------- signals ----------
function sigRow(r) { if (r) { r.decided_at = toDate(r.decided_at); r.observed_at = toDate(r.observed_at); r.updated_at = toDate(r.updated_at); } return r; }
const getSignal = async id => sigRow(await one("SELECT * FROM signals WHERE signal_id = ?", [id]));
/** Insert a signal if new. Returns true if inserted. Existing signals keep their causality. */
async function insertSignal(s) {
  const r = await exec(`INSERT IGNORE INTO signals (signal_id, issue_key, kind, ref, severity, causality, confirmed_via,
      decided_by, decided_at, rev, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [s.signal_id, s.issue_key, s.kind, s.ref ?? null, s.severity ?? null, s.causality, s.confirmed_via ?? null,
    s.decided_by ?? null, s.decided_by ? nowTs() : null, s.decided_by ? 1 : 0, nowTs()]);
  return r.affectedRows > 0;
}
/** Change causality; bumps rev. `from` guards against overwriting a concurrent decision. */
async function setCausality(id, causality, { by = null, via = null, from = null } = {}) {
  const r = await exec(`UPDATE signals SET causality = ?, decided_by = ?, confirmed_via = ?, decided_at = ?,
      rev = rev + 1, updated_at = ${NOW} WHERE signal_id = ? ${from ? "AND causality IN (" + from.map(() => "?").join(",") + ")" : ""}`,
  [causality, by, via, nowTs(), id, ...(from ?? [])]);
  return r.affectedRows > 0;
}
const setSeverity = (id, sev) => exec(`UPDATE signals SET severity = ?, updated_at = ${NOW} WHERE signal_id = ?`, [sev, id]);
const signalsForItem = async key => (await query("SELECT * FROM signals WHERE issue_key = ? ORDER BY observed_at", [key])).map(sigRow);
const signalsForAgentShape = async (agentId, shapeId) => (await query(`SELECT s.* FROM signals s
  JOIN work_items w ON w.issue_key = s.issue_key WHERE w.agent_id = ? AND w.shape_id = ?`, [agentId, shapeId])).map(sigRow);
const signalsByVia = async via => (await query("SELECT * FROM signals WHERE confirmed_via = ?", [via])).map(sigRow);
const openSuspected = async () => (await query("SELECT * FROM signals WHERE causality = 'suspected'", [])).map(sigRow);

// ---------- records ----------
async function maxSignalUpdate(agentId, shapeId) {
  const r = await one(`SELECT MAX(s.updated_at) AS wm FROM signals s JOIN work_items w ON w.issue_key = s.issue_key
    WHERE w.agent_id = ? AND w.shape_id = ?`, [agentId, shapeId]);
  return toDate(r?.wm);
}
/** Watermark-guarded upsert (§8.4). Assignment order matters: watermark last. */
async function upsertRecord({ subject_id, shape_id, clean, total, lower90, earned_level, contributors = null, watermark }) {
  await exec(`INSERT INTO records (subject_id, shape_id, clean, total, lower90, earned_level, contributors, watermark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      clean        = IF(VALUES(watermark) >= watermark, VALUES(clean), clean),
      total        = IF(VALUES(watermark) >= watermark, VALUES(total), total),
      lower90      = IF(VALUES(watermark) >= watermark, VALUES(lower90), lower90),
      earned_level = IF(VALUES(watermark) >= watermark, VALUES(earned_level), earned_level),
      contributors = IF(VALUES(watermark) >= watermark, VALUES(contributors), contributors),
      computed_at  = IF(VALUES(watermark) >= watermark, ${NOW}, computed_at),
      watermark    = GREATEST(watermark, VALUES(watermark))`,
  [subject_id, shape_id, clean, total, lower90, earned_level, contributors, ts(watermark)]);
}
const getRecord = (subject, shape) => one("SELECT * FROM records WHERE subject_id = ? AND shape_id = ?", [subject, shape]);
const allRecords = () => query("SELECT * FROM records ORDER BY subject_id, shape_id", []);

// ---------- holds ----------
const activeHolds = (agentId, shapeId) => query(`SELECT * FROM holds WHERE agent_id = ? AND shape_id = ?
  AND cleared_at IS NULL ORDER BY kind`, [agentId, shapeId]);
const allActiveHolds = () => query("SELECT * FROM holds WHERE cleared_at IS NULL", []);
/** Make the cache match the derived set: upsert active ones, clear the rest. */
async function syncHolds(agentId, shapeId, derived) {
  const ids = derived.map(h => h.hold_id);
  for (const h of derived) {
    await exec(`INSERT INTO holds (hold_id, agent_id, shape_id, kind, cause_signal_id, cause_ref, reason, clean_needed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE reason = VALUES(reason), clean_needed = VALUES(clean_needed),
        cause_ref = VALUES(cause_ref), cleared_at = NULL`,
    [h.hold_id, agentId, shapeId, h.kind, h.cause_signal_id, h.cause_ref ?? null, h.reason, h.clean_needed]);
  }
  await exec(`UPDATE holds SET cleared_at = ${NOW} WHERE agent_id = ? AND shape_id = ? AND cleared_at IS NULL
    ${ids.length ? `AND hold_id NOT IN (${ids.map(() => "?").join(",")})` : ""}`, [agentId, shapeId, ...ids]);
}

// ---------- decision events / staff actions ----------
async function insertDecisionEvent({ event_id, agent_id, shape_id, before, after, cause }) {
  const r = await exec(`INSERT IGNORE INTO decision_events (event_id, agent_id, shape_id, before_json, after_json, cause)
    VALUES (?, ?, ?, ?, ?, ?)`, [event_id, agent_id, shape_id, JSON.stringify(before).slice(0, 1024),
    JSON.stringify(after).slice(0, 1024), String(cause).slice(0, 512)]);
  return r.affectedRows > 0;
}
const decisionEventsFor = (agentId, shapeId) => query(`SELECT * FROM decision_events WHERE agent_id = ? AND shape_id = ?
  ORDER BY at DESC LIMIT 20`, [agentId, shapeId]);
const recentDecisionEvents = (limit = 100) => query(`SELECT * FROM decision_events ORDER BY at DESC LIMIT ${Number(limit) | 0}`, []);
async function logStaffAction({ actor, action, target, note = null, rev = Date.now() }) {
  await exec(`INSERT IGNORE INTO staff_actions (action_id, actor, action, target, note) VALUES (?, ?, ?, ?, ?)`,
    [`${action}:${target}:${rev}`.slice(0, 255), actor, action, target, note]);
}
const staffActionsFor = target => query("SELECT * FROM staff_actions WHERE target = ? ORDER BY at", [target]);

// ---------- Clean Room ----------
async function upsertSource({ source_id, url, title = null }) {
  await exec(`INSERT INTO sources (source_id, url, title) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE url = VALUES(url), title = COALESCE(VALUES(title), title)`, [source_id, url, title]);
  return one("SELECT * FROM sources WHERE source_id = ?", [source_id]);
}
const getSource = id => one("SELECT * FROM sources WHERE source_id = ?", [id]);
const listSources = () => query(`SELECT * FROM sources WHERE state <> 'clean' AND state <> 'unscanned' ORDER BY source_id`, []);
const SOURCE_FIELDS = new Set(["state", "rationale", "tainted_from_version", "clean_from_version", "confirmed_by", "confirmed_at", "title"]);
async function patchSource(id, patch) {
  const cols = Object.keys(patch).filter(k => SOURCE_FIELDS.has(k));
  if (!cols.length) return;
  await exec(`UPDATE sources SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE source_id = ?`,
    [...cols.map(c => (patch[c] instanceof Date ? ts(patch[c]) : patch[c])), id]);
}
async function addFinding({ source_id, version, filter, offset, quote }) {
  await exec(`INSERT IGNORE INTO scan_findings (finding_id, source_id, version, filter, quote) VALUES (?, ?, ?, ?, ?)`,
    [`${source_id}:${version}:${filter}:${offset}`.slice(0, 255), source_id, version, filter, quote.slice(0, 1024)]);
}
const findingsFor = id => query("SELECT * FROM scan_findings WHERE source_id = ? ORDER BY version, filter", [id]);
async function insertRead(r) {
  await exec(`INSERT IGNORE INTO context_reads (read_id, issue_key, agent_id, source_id, source_version, version_basis,
      method, flag, read_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [r.read_id, r.issue_key, r.agent_id, r.source_id, r.source_version, r.version_basis, r.method, r.flag ?? null,
    ts(r.read_at), ts(r.recorded_at)]);
}
function joinRead(r) {
  return {
    read_id: r.read_id, issue_key: r.issue_key, agent_id: r.agent_id, source_version: r.source_version,
    version_basis: r.version_basis, method: r.method, flag: r.flag, read_at: toDate(r.read_at),
    recorded_at: toDate(r.recorded_at),
    source: { source_id: r.source_id, url: r.url, title: r.title, state: r.state,
      tainted_from_version: r.tainted_from_version, clean_from_version: r.clean_from_version },
  };
}
const READ_JOIN = `SELECT r.*, s.url, s.title, s.state, s.tainted_from_version, s.clean_from_version
  FROM context_reads r JOIN sources s ON s.source_id = r.source_id`;
const readsForItem = async key => (await query(`${READ_JOIN} WHERE r.issue_key = ? ORDER BY r.recorded_at`, [key])).map(joinRead);
const readsForSource = async id => (await query(`${READ_JOIN} WHERE r.source_id = ? ORDER BY r.recorded_at`, [id])).map(joinRead);

module.exports = {
  normAccount, getSettings, setSetting, seen, markSeen,
  listAgents, getAgent, upsertAgent, setSuspended, addAccount, removeAccount, accounts, agentForAccount, agentBitbucketAccounts,
  upsertShape, getShape, listShapes,
  getItem, createItem, patchItem, itemsForAgentShape, teamItemsForShape, itemsPastWindow, mergedUndeployed, agentShapePairs, itemsForAgent,
  upsertPr, getPrRow, prsForItem, openPrsFor, openPrsForItems, addPrCommits, prForCommit,
  getSignal, insertSignal, setCausality, setSeverity, signalsForItem, signalsForAgentShape, signalsByVia, openSuspected,
  maxSignalUpdate, upsertRecord, getRecord, allRecords,
  activeHolds, allActiveHolds, syncHolds,
  insertDecisionEvent, decisionEventsFor, recentDecisionEvents, logStaffAction, staffActionsFor,
  upsertSource, getSource, listSources, patchSource, addFinding, findingsFor, insertRead, readsForItem, readsForSource,
};
