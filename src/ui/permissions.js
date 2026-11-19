"use strict";
// Who may see which work items. UI resolvers run as the viewing user, Rovo/MCP actions as the calling (agent)
// account: every issue key Lessel returns is checked against BROWSE_PROJECTS for that caller, once per project
// per request, and keys the caller can't browse are redacted. Account ids are never shown: they become words.

const { ports } = require("../ports");

const HIDDEN = "a work item you can't view";
const KEY_RE = /\b[A-Z][A-Z0-9_]{0,49}-\d+\b/g;
const projectOf = key => {
  const m = /^([A-Z][A-Z0-9_]*)-\d+$/.exec(String(key ?? ""));
  return m ? m[1] : null;
};

const defaults = {
  /** Can the caller browse this Jira project? Runs as the user (asUser) through the Jira adapter. */
  canBrowseProject: projectKey => ports.jira.userHas("BROWSE_PROJECTS", { projectKey }),
  /** Is the caller a Confluence admin? Used in Lessel's Confluence installation, where Jira checks don't apply. */
  async isConfluenceAdmin() {
    const api = require("@forge/api");
    const res = await api.asUser().requestConfluence(api.route`/wiki/rest/api/user/current?expand=operations`,
      { headers: { Accept: "application/json" } });
    if (!res.ok) return false;
    const body = await res.json();
    return (body?.operations ?? []).some(o => o.operation === "administer" && (!o.targetType || o.targetType === "application"));
  },
};
const port = { ...defaults };

/** Tests only: fake the permission checks. */
function setPermissionPort(overrides) { Object.assign(port, overrides); }
function resetPermissionPort() { Object.assign(port, defaults); }
const isConfluenceAdmin = async () => (await port.isConfluenceAdmin()) === true;

/**
 * One viewer per request. `open` lists project keys that aren't real Jira projects on this site (imported demo
 * history): anyone who can see the board can see them, without asking Jira.
 */
function viewer({ open = [] } = {}) {
  const openSet = new Set(open);
  const cache = new Map();
  const canBrowse = project => {
    if (!project) return Promise.resolve(false);
    if (openSet.has(project)) return Promise.resolve(true);
    if (!cache.has(project)) {
      // A failed check (unknown project, API error) hides the key: fail closed.
      cache.set(project, Promise.resolve().then(() => port.canBrowseProject(project)).then(r => r === true, () => false));
    }
    return cache.get(project);
  };
  const canView = key => canBrowse(projectOf(key));
  /** The key itself if the caller may see it, else null. */
  const key = async k => (k != null && (await canView(k)) ? k : null);
  /** The key, or the plain words for a hidden one. Anything that isn't an issue key (a commit sha) is kept. */
  const label = async k => (k == null || !projectOf(k) ? k : (await canView(k)) ? k : HIDDEN);
  /** Replace every issue key in free text that the caller can't see. */
  const text = async s => {
    if (s == null) return s;
    const str = String(s);
    const keys = [...new Set(str.match(KEY_RE) ?? [])];
    if (!keys.length) return str;
    const ok = new Map(await Promise.all(keys.map(async k => [k, await canView(k)])));
    return str.replace(KEY_RE, k => (ok.get(k) ? k : HIDDEN));
  };
  return { canView, key, label, text };
}

/** Projects of imported (demo) history: they don't exist on this site. */
const openProjects = cfg => (Array.isArray(cfg?.importedSnapshot?.projects) ? cfg.importedSnapshot.projects : []);
const isImportedKey = (cfg, key) => openProjects(cfg).includes(projectOf(key));

/**
 * Who decided a signal, in words. `byAccount` maps agent account ids to the agent's display name; any other
 * account is a person, and people are never named here.
 */
function actorWords(by, { me = null, byAccount = new Map() } = {}) {
  if (by == null || by === "") return null;
  const s = String(by);
  if (s === "lessel:expired") return "nobody (expired undecided)";
  if (s === "lessel:clean-room") return "Lessel Clean Room";
  if (s === "lessel:revert") return "Lessel (revert)";
  if (s.startsWith("lessel:")) return "Lessel";
  if (s.startsWith("link:")) return "a caused-by link (creator not available)";
  if (s === "staff") return "staff";
  if (s === "closed-account") return "a person (account closed)";
  if (me && s === me) return "you";
  if (byAccount.has(s)) return byAccount.get(s);
  return "a person";
}

/** How a decision was made, in words. `sourceTitle` names a Clean Room source by id. */
function viaWords(via, sourceTitle = id => id) {
  if (via == null || via === "") return null;
  const s = String(via);
  if (s === "button") return "Confirm cause button";
  if (s === "revert") return "revert on the main branch";
  if (s.startsWith("link:")) return "caused-by link";
  if (s.startsWith("source:")) return `bad input from ${sourceTitle(s.slice(7))}`;
  if (s.startsWith("unexcused:")) return "excusal withdrawn";
  return s;
}

module.exports = { HIDDEN, KEY_RE, projectOf, viewer, openProjects, isImportedKey, actorWords, viaWords,
  isConfluenceAdmin, setPermissionPort, resetPermissionPort };
