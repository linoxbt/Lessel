"use strict";
// History snapshot for judges (spec §17.5): export real history from the demo site, import it on a fresh
// site, clearly labelled as imported. No account id leaves the site: staff decisions export as "staff", the
// staff audit log isn't exported, and neither are the agents' account mappings (agent ids and names only).
//
// Import runs on the job queue (a UI resolver has a short time limit): the resolver stages the pasted text in
// the settings table, in chunks under "~snapshot:" keys, and the job reads it back, imports and recomputes.
// Imported work-item keys are namespaced (PAY-212 → DEMOPAY-212) so they can't collide with the site's own
// tickets, and imported repositories, PRs and Confluence sources get an "imported:" id that can never match a
// live Bitbucket repo or Confluence page.

const { query, exec, ts, toDate } = require("../db/driver");
const repo = require("../db/repo");
const { DEFAULTS } = require("../core/defaults");

const FORMAT = "lessel-snapshot/1";

// Tables in dependency-free order. Not exported: events_seen (site-specific), staff_actions (person ids),
// agent_accounts (account ids; a judge maps their own accounts).
const TABLES = ["agents", "shapes", "work_items", "prs", "pr_commits", "signals", "records",
  "holds", "decision_events", "sources", "scan_findings", "context_reads"];

// Settings that are site-specific or secret-adjacent stay behind.
const SKIP_SETTINGS = new Set(["repos", "graphQueries", "importedSnapshot"]);

/** System decisions keep their actor; people become "staff". */
const anonymize = v => (v == null || /^(lessel:|link:)/.test(String(v)) ? v : "staff");

function scrub(table, row) {
  const r = { ...row };
  for (const [k, v] of Object.entries(r)) if (v instanceof Date) r[k] = ts(v);
  if (table === "signals") r.decided_by = anonymize(r.decided_by);
  if (table === "sources") r.confirmed_by = r.confirmed_by == null ? null : "staff";
  return r;
}

async function exportSnapshot() {
  const tables = {};
  for (const t of TABLES) tables[t] = (await query(`SELECT * FROM ${t}`, [])).map(r => scrub(t, r));
  const cfg = await repo.getSettings();
  const settings = Object.fromEntries(Object.entries(cfg).filter(([k]) => k in DEFAULTS && !SKIP_SETTINGS.has(k)));
  return {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    settings,
    tables,
  };
}

// ---------- namespacing imported rows ----------

const DEFAULT_PREFIX = "DEMO";
const KEY_RE = /\b([A-Z][A-Z0-9_]*)-(\d+)\b/g;
const IMPORTED = "imported:";

/** Columns that hold issue keys (alone or inside text), repo/workspace ids, and Clean Room source ids. */
const KEY_COLUMNS = {
  work_items: ["issue_key"],
  prs: ["issue_key"],
  signals: ["signal_id", "issue_key", "ref"],
  holds: ["hold_id", "cause_signal_id", "cause_ref", "reason"],
  decision_events: ["event_id", "cause"],
  context_reads: ["issue_key"],
};
const REPO_COLUMNS = { work_items: ["repo_uuid"], prs: ["repo_uuid", "workspace_uuid"], pr_commits: ["repo_uuid"] };
const SOURCE_COLUMNS = { sources: ["source_id"], scan_findings: ["source_id", "finding_id"], context_reads: ["source_id"] };
const MAX_LEN = { issue_key: 32, repo_uuid: 64, workspace_uuid: 64, source_id: 128, cause: 512, reason: 512 };

function namespacer(prefix) {
  const projects = new Set();
  const key = s => (s == null ? s : String(s).replace(KEY_RE, (m, project, n) => {
    if (project.startsWith(prefix)) return m;          // already namespaced
    projects.add(prefix + project);
    return `${prefix}${project}-${n}`;
  }));
  const tag = v => (v == null || String(v).startsWith(IMPORTED) ? v : IMPORTED + v);
  const via = v => (v == null ? v : String(v).replace(/^(source:|unexcused:)(?!imported:)/, `$1${IMPORTED}`));
  const clamp = (col, v) => (typeof v === "string" ? v.slice(0, MAX_LEN[col] ?? 255) : v);

  function row(table, input) {
    const r = { ...input };
    for (const c of KEY_COLUMNS[table] ?? []) if (c in r) r[c] = clamp(c, key(r[c]));
    for (const c of REPO_COLUMNS[table] ?? []) if (c in r) r[c] = clamp(c, tag(r[c]));
    for (const c of SOURCE_COLUMNS[table] ?? []) if (c in r) r[c] = clamp(c, tag(r[c]));
    if (table === "signals" && "confirmed_via" in r) r.confirmed_via = clamp("confirmed_via", via(r.confirmed_via));
    return r;
  }
  return { row, key, projects };
}

function checkPrefix(prefix) {
  const p = String(prefix ?? DEFAULT_PREFIX).trim().toUpperCase();
  if (!/^[A-Z]{2,8}$/.test(p)) throw new Error("The key prefix must be 2 to 8 letters, e.g. DEMO.");
  return p;
}

async function siteHasHistory() {
  const existing = await query("SELECT COUNT(*) AS n FROM work_items", []);
  return Number(existing[0]?.n ?? existing[0]?.N ?? 0) > 0;
}

/**
 * Import into an empty site. Refuses if any work items already exist (no silent merging of histories).
 * Issue keys get `keyPrefix` in front of their project key; repos, PRs and sources become "imported:<id>".
 */
async function importSnapshot(snapshot, { actor = "staff", keyPrefix = DEFAULT_PREFIX } = {}) {
  if (!snapshot || snapshot.format !== FORMAT) throw new Error(`Not a ${FORMAT} file.`);
  const prefix = checkPrefix(keyPrefix);
  if (await siteHasHistory()) throw new Error("This site already has history. Import only into a fresh install.");
  const ns = namespacer(prefix);
  const imported = {};
  for (const t of TABLES) {
    const rows = snapshot.tables?.[t] ?? [];
    imported[t] = 0;
    for (const raw of rows) {
      const row = ns.row(t, raw);
      const cols = Object.keys(row).filter(c => /^[a-z_0-9]+$/.test(c));
      if (!cols.length) continue;
      const r = await exec(`INSERT IGNORE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        cols.map(c => row[c]));
      imported[t] += r.affectedRows;
    }
  }
  for (const [k, v] of Object.entries(snapshot.settings ?? {})) {
    // A setting that doesn't validate here (an older export) is skipped; the site keeps its default.
    if (Object.hasOwn(DEFAULTS, k) && !SKIP_SETTINGS.has(k)) await repo.setSetting(k, v).catch(e => console.warn(`snapshot setting ${k} skipped: ${e.message}`));
  }
  // Imported history never enforces on its own: a judge switches to enforcing to see live gating.
  await repo.setSetting("enforcementMode", "advisory");
  await repo.setSetting("importedSnapshot", { exportedAt: snapshot.exportedAt, importedAt: new Date().toISOString(),
    workItems: imported.work_items, keyPrefix: prefix, projects: [...ns.projects].sort().slice(0, 50) });
  await repo.logStaffAction({ actor, action: "import", target: "snapshot", note: `exported ${snapshot.exportedAt}` });
  return imported;
}

// ---------- staged import (queue) ----------

const STAGE = "~snapshot:";
const STATUS_KEY = `${STAGE}status`;
const CHUNK_JSON_MAX = 4000;   // settings.value_json is VARCHAR(4096)
const STALE_MS = 30 * 60e3;    // an import still "in progress" after this long died with its job: allow a new one

async function putRaw(key, value) {
  await exec(`INSERT INTO settings (setting_key, value_json) VALUES (?, ?)
    ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = CURRENT_TIMESTAMP(3)`, [key, JSON.stringify(value)]);
}
async function getRaw(key) {
  const rows = await query("SELECT value_json FROM settings WHERE setting_key = ?", [key]);
  if (!rows.length) return null;
  try { return JSON.parse(rows[0].value_json); } catch { return null; }
}
const clearChunks = () => exec(`DELETE FROM settings WHERE setting_key LIKE ? AND setting_key <> ?`, [`${STAGE}c%`, STATUS_KEY]);

/** Split text so that every JSON-encoded piece fits a settings row. */
function chunk(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let n = Math.min(3000, text.length - i);
    while (n > 1 && JSON.stringify(text.slice(i, i + n)).length > CHUNK_JSON_MAX) n = Math.floor(n / 2);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

async function setStatus(patch) {
  const cur = (await getRaw(STATUS_KEY)) ?? {};
  const next = { ...cur, ...patch };
  await putRaw(STATUS_KEY, next);
  return next;
}

/** Current import status: { state: none | queued | running | done | failed, ... }. */
async function importStatus() {
  const s = await getRaw(STATUS_KEY);
  return s ?? { state: "none" };
}

/**
 * Resolver side: check the text quickly, stage it, and return the job body to enqueue. Throws a plain-words
 * Error for anything a person can fix (bad JSON, wrong format, a site that already has history).
 */
async function stageImport(json, { actor = "staff", keyPrefix = DEFAULT_PREFIX } = {}) {
  const text = String(json ?? "");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("That isn't valid JSON."); }
  if (!parsed || parsed.format !== FORMAT) throw new Error(`Not a ${FORMAT} file.`);
  const prefix = checkPrefix(keyPrefix);
  const cur = await importStatus();
  const busySince = Date.parse(cur.startedAt ?? cur.queuedAt ?? "") || 0;
  if ((cur.state === "queued" || cur.state === "running") && Date.now() - busySince < STALE_MS) {
    throw new Error("An import is already in progress.");
  }
  if (await siteHasHistory()) throw new Error("This site already has history. Import only into a fresh install.");
  await clearChunks();
  const pieces = chunk(text);
  const width = String(pieces.length).length;
  // Multi-row inserts keep the resolver well inside its time limit even for large snapshots.
  for (let i = 0; i < pieces.length; i += 25) {
    const batch = pieces.slice(i, i + 25);
    await exec(`INSERT INTO settings (setting_key, value_json) VALUES ${batch.map(() => "(?, ?)").join(", ")}
      ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
    batch.flatMap((p, j) => [`${STAGE}c${String(i + j).padStart(width, "0")}`, JSON.stringify(p)]));
  }
  const uploadId = `${Date.now().toString(36)}-${pieces.length}`;
  // The actor (an account id) travels in the job body only, so it isn't stored outside the staff audit log.
  const status = { state: "queued", uploadId, chunks: pieces.length, keyPrefix: prefix,
    exportedAt: parsed.exportedAt ?? null, queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    imported: null, error: null };
  await putRaw(STATUS_KEY, status);
  return { type: "import-snapshot", uploadId, actor };
}

/** Job side: read the staged text back, import it, recompute, record the outcome, and drop the staged rows. */
async function runImportJob(body = {}) {
  const status = await importStatus();
  if (status.uploadId !== body.uploadId) return { skipped: "stale upload" };
  if (status.state === "done" || status.state === "failed") return { skipped: status.state };
  await setStatus({ state: "running", startedAt: new Date().toISOString() });
  try {
    const rows = await query("SELECT setting_key, value_json FROM settings WHERE setting_key LIKE ? AND setting_key <> ?",
      [`${STAGE}c%`, STATUS_KEY]);
    rows.sort((a, b) => (a.setting_key < b.setting_key ? -1 : a.setting_key > b.setting_key ? 1 : 0));
    if (rows.length !== status.chunks) throw new Error("The staged snapshot is incomplete. Paste it again.");
    const text = rows.map(r => JSON.parse(r.value_json)).join("");
    const imported = await importSnapshot(JSON.parse(text), { actor: body.actor ?? "staff", keyPrefix: status.keyPrefix });
    await require("./recompute").recomputeAll();
    return await setStatus({ state: "done", imported, finishedAt: new Date().toISOString() });
  } catch (e) {
    console.error("snapshot import failed", e);
    return await setStatus({ state: "failed", error: e.message, finishedAt: new Date().toISOString() });
  } finally {
    await clearChunks();
  }
}

/** The job couldn't be queued: drop the staged text and say why. */
async function abortStaged(message) {
  await clearChunks();
  return setStatus({ state: "failed", error: message, finishedAt: new Date().toISOString() });
}

/** Status for the admin page, with times as ISO UTC. */
async function importStatusView() {
  const s = await importStatus();
  const iso = v => (v ? toDate(v)?.toISOString() ?? null : null);
  return { ...s, queuedAt: iso(s.queuedAt), startedAt: iso(s.startedAt), finishedAt: iso(s.finishedAt) };
}

module.exports = { FORMAT, TABLES, DEFAULT_PREFIX, STAGE, exportSnapshot, importSnapshot, anonymize, namespacer,
  stageImport, runImportJob, abortStaged, importStatus, importStatusView };
