"use strict";
// Thin SQL driver. In Forge it's @forge/sql; tests swap in a MySQL/MariaDB connection.

let driver = null;

function forgeDriver() {
  const { sql } = require("@forge/sql");
  return {
    async query(text, params = []) {
      const res = await sql.prepare(text).bindParams(...params).execute();
      return res.rows;
    },
    async exec(text, params = []) {
      const res = await sql.prepare(text).bindParams(...params).execute();
      return { affectedRows: res.rows?.affectedRows ?? 0 };
    },
    async ddl(text) {
      return sql.executeDDL(text);
    },
  };
}

function getDriver() {
  if (!driver) driver = forgeDriver();
  return driver;
}

/** Tests only. */
function setDriver(d) { driver = d; }

const query = (text, params) => getDriver().query(text, params);
const exec = (text, params) => getDriver().exec(text, params);
const one = async (text, params) => (await query(text, params))[0] ?? null;

/** UTC 'YYYY-MM-DD HH:MM:SS.mmm' for TIMESTAMP(3) columns. */
function ts(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/** Read a DB timestamp (string without zone, stored as UTC) back into a Date. */
function toDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const s = String(v);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
}

module.exports = { getDriver, setDriver, query, exec, one, ts, toDate };
