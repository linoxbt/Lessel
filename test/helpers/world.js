"use strict";
// Test world: a real MySQL-compatible database (MariaDB locally) plus fake Atlassian APIs and a clock.
// Set LESSEL_TEST_DB=mysql://user:pass@host/db to point elsewhere. Tests skip if no database is reachable.

const { setDriver } = require("../../src/db/driver");
const { MIGRATIONS } = require("../../src/db/schema");
const { setPorts, resetPorts } = require("../../src/ports");

const DB_URL = process.env.LESSEL_TEST_DB || "mysql://lessel:lessel@localhost/lessel_test";

async function connectDb() {
  let mysql;
  try { mysql = require("mysql2/promise"); } catch { return null; }
  try {
    const pool = mysql.createPool({ uri: DB_URL, dateStrings: true, timezone: "Z", connectionLimit: 4 });
    pool.on("connection", c => c.query("SET time_zone = '+00:00'"));
    await pool.query("SELECT 1");
    return pool;
  } catch {
    return null;
  }
}

async function resetSchema(pool) {
  const [tables] = await pool.query("SHOW TABLES");
  for (const row of tables) await pool.query(`DROP TABLE IF EXISTS \`${Object.values(row)[0]}\``);
  for (const [, ddl] of MIGRATIONS) await pool.query(ddl);
  setDriver({
    async query(text, params = []) { const [rows] = await pool.query(text, params); return rows; },
    async exec(text, params = []) { const [res] = await pool.query(text, params); return { affectedRows: res.affectedRows }; },
    async ddl(text) { return pool.query(text); },
  });
}

const HOUR = 3600e3;

function makeWorld() {
  const clock = { t: Date.now() };
  const prs = new Map();            // `${repo}#${id}` → PR object
  const mainLine = [];              // merge commits in order, for ancestry
  const statuses = new Map();       // sha → [{state}]
  const commitsByHead = new Map();  // head sha → [{hash, message}]
  const comments = [];              // { prId, raw }
  const issues = new Map();         // key → issue
  const links = new Map();          // id → link
  const pages = new Map();          // pageId → [{ number, createdAt, title, body, spaceId }]
  let seq = 0;

  const bitbucket = {
    async getPr(ws, repo, id) { return structuredClone(prs.get(`${strip(repo)}#${id}`)); },
    async prDiffstat(ws, repo, id) { const p = prs.get(`${strip(repo)}#${id}`); return { paths: p._paths, lines: 10 * p._paths.length }; },
    async prCommits(ws, repo, id) { return prs.get(`${strip(repo)}#${id}`)._commits; },
    async commitStatuses(ws, repo, sha) { return statuses.get(sha) ?? []; },
    async postPrComment(ws, repo, id, raw) { comments.push({ prId: id, raw }); return {}; },
    async commitsOn(ws, repo, head) { return commitsByHead.get(head) ?? []; },
    async isAncestor(ws, repo, a, head) {
      const ia = mainLine.indexOf(a), ih = mainLine.indexOf(head);
      return ia !== -1 && ih !== -1 && ia <= ih;
    },
    async getEnvironment() { return { environment_type: { name: "Production" } }; },
    async listPrs() { return []; }, async listDeployments() { return []; },
  };
  const jira = {
    async getIssue(keyOrId) {
      for (const i of issues.values()) if (i.key === keyOrId || i.id === String(keyOrId)) return structuredClone(i);
      return null;
    },
    async getIssueLink(id) { return links.get(String(id)); },
    async getStatus(id) { return { id, statusCategory: { key: id === "done" ? "done" : "indeterminate" } }; },
    async searchJql() { return []; },
    async userHas() { return true; },
    async addComment() { return {}; },
  };
  const confluence = {
    async getPage(id, version) {
      const vs = pages.get(String(id)); if (!vs) return null;
      const v = version == null ? vs[vs.length - 1] : vs.find(x => x.number === Number(version));
      return v && { id, title: v.title, spaceId: v.spaceId, version: { number: v.number }, body: { storage: { value: v.body } } };
    },
    async listVersions(id) { return (pages.get(String(id)) ?? []).map(v => ({ number: v.number, createdAt: v.createdAt })); },
    async versionAt(id, at) {
      let best = null;
      for (const v of pages.get(String(id)) ?? []) if (new Date(v.createdAt) <= new Date(at)) best = v.number;
      return best;
    },
    async getSpace() { return { key: "ENG" }; },
    async updatePage(id, { title, storage, nextVersion }) {
      const vs = pages.get(String(id));
      if (nextVersion !== vs.length + 1) throw new Error(`version conflict: ${nextVersion} vs ${vs.length + 1}`);
      vs.push({ number: nextVersion, body: storage, title, spaceId: "s1", createdAt: new Date(clock.t).toISOString() });
      return { id, version: { number: nextVersion } };
    },
  };
  // Fake Qwen: flags text that tells agents to weaken safety, quoting the sentence verbatim.
  const llm = {
    async classifyClass() { return { change_class: "business-logic", confidence: 0.5 }; },
    async reviewForInjection({ text }) {
      const m = String(text).match(/[^.]*(?:max_rps to 0|copy the admin token)[^.]*\./i);
      return m ? { verdict: "injection", quote: m[0].trim(), reason: "Tells agents to weaken safety." }
        : { verdict: "benign", quote: "", reason: "" };
    },
  };

  setPorts({ bitbucket, jira, confluence, llm, now: () => new Date(clock.t) });

  const strip = u => String(u).replace(/[{}]/g, "").toLowerCase();
  const w = {
    clock, prs, comments, issues, links, pages, statuses, mainLine, commitsByHead,
    advance(hours) { clock.t += hours * HOUR; },
    issue(key, fields = {}) {
      const i = { id: String(++seq + 10000), key, fields: { summary: `Work on ${key}`, project: { key: key.split("-")[0] },
        issuetype: { name: "Task" }, created: new Date(clock.t).toISOString(), ...fields } };
      issues.set(key, i);
      return i;
    },
    pr({ repo = "r1", id, key, author, paths, title = "" }) {
      const p = { id, title, state: "OPEN", author: { uuid: author }, participants: [],
        source: { branch: { name: `${key}-work` }, commit: { hash: `head-${id}` } },
        destination: { repository: { uuid: repo, workspace: { uuid: "ws" } } },
        updated_on: new Date(clock.t).toISOString(), _paths: paths, _commits: [`c-${id}-1`, `c-${id}-2`] };
      prs.set(`${repo}#${id}`, p);
      return p;
    },
    approve(prId, uuid, repo = "r1") { prs.get(`${repo}#${prId}`).participants.push({ approved: true, user: { uuid } }); },
    green(sha) { statuses.set(sha, [{ state: "SUCCESSFUL" }]); },
    merge(prId, repo = "r1") {
      const p = prs.get(`${repo}#${prId}`);
      const hash = `deadbeef${String(prId).padStart(4, "0")}`;
      p.state = "MERGED"; p.merge_commit = { hash }; p.updated_on = new Date(clock.t).toISOString();
      mainLine.push(hash);
      return p;
    },
    page(id, versions) {
      pages.set(String(id), versions.map((body, i) => ({ number: i + 1, body, title: "Ledger runbook", spaceId: "s1",
        createdAt: new Date(clock.t - (versions.length - i) * HOUR).toISOString() })));
    },
    addPageVersion(id, body) {
      const vs = pages.get(String(id));
      vs.push({ number: vs.length + 1, body, title: "Ledger runbook", spaceId: "s1", createdAt: new Date(clock.t).toISOString() });
      return vs.length;
    },
  };
  return w;
}

function teardown() { resetPorts(); }

module.exports = { connectDb, resetSchema, makeWorld, teardown, HOUR };
