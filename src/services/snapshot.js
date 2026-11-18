"use strict";
// History snapshot for judges (spec §17.5): export real history from the demo site, import it on a fresh
// site, clearly labelled as imported. Person account ids never leave the site: staff decisions export as
// "staff", and the staff audit log isn't exported at all.

const { query, exec, ts } = require("../db/driver");
const repo = require("../db/repo");
const { DEFAULTS } = require("../core/defaults");

const FORMAT = "lessel-snapshot/1";

// Tables in dependency-free order. Not exported: events_seen (site-specific), staff_actions (person ids).
const TABLES = ["agents", "agent_accounts", "shapes", "work_items", "prs", "pr_commits", "signals", "records",
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

/** Import into an empty site. Refuses if any work items already exist (no silent merging of histories). */
async function importSnapshot(snapshot, { actor = "staff" } = {}) {
  if (!snapshot || snapshot.format !== FORMAT) throw new Error(`Not a ${FORMAT} file.`);
  const existing = await query("SELECT COUNT(*) AS n FROM work_items", []);
  if (Number(existing[0]?.n ?? existing[0]?.N ?? 0) > 0) throw new Error("This site already has history. Import only into a fresh install.");
  const imported = {};
  for (const t of TABLES) {
    const rows = snapshot.tables?.[t] ?? [];
    imported[t] = 0;
    for (const row of rows) {
      const cols = Object.keys(row).filter(c => /^[a-z_0-9]+$/.test(c));
      if (!cols.length) continue;
      const r = await exec(`INSERT IGNORE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        cols.map(c => row[c]));
      imported[t] += r.affectedRows;
    }
  }
  for (const [k, v] of Object.entries(snapshot.settings ?? {})) {
    if (k in DEFAULTS && !SKIP_SETTINGS.has(k)) await repo.setSetting(k, v);
  }
  // Imported history never enforces on its own: a judge switches to enforcing to see live gating.
  await repo.setSetting("enforcementMode", "advisory");
  await repo.setSetting("importedSnapshot", { exportedAt: snapshot.exportedAt, importedAt: new Date().toISOString(),
    workItems: imported.work_items });
  await repo.logStaffAction({ actor, action: "import", target: "snapshot", note: `exported ${snapshot.exportedAt}` });
  return imported;
}

module.exports = { FORMAT, TABLES, exportSnapshot, importSnapshot, anonymize };
