"use strict";
// Clean Room service (spec §13): scan, confirm taint, mark fixed, declare-context, blast radius.

const crypto = require("crypto");
const repo = require("../db/repo");
const { ports } = require("../ports");
const { scan, isSuspect, stripTags } = require("../core/taint");
const { checkDeclaration, inTaintedRange, rangeText, contextGate } = require("../core/cleanroom");
const { UserError, reexcuseForSource } = require("./signals");
const { notifyItems } = require("./notify");
const { pageIdFromUrl } = require("../adapters/confluence");
const { adfText } = require("../adapters/jira");

/** Stable source id from a URL. Confluence pages are versioned; Jira items are scanned but versionless. */
function sourceRef(url) {
  const pageId = pageIdFromUrl(url);
  if (pageId) return { source_id: `confluence:page:${pageId}`, kind: "confluence", pageId };
  const key = String(url || "").match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/)?.[1];
  if (key) return { source_id: `jira:issue:${key}`, kind: "jira", key };
  return { source_id: `url:${crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 40)}`, kind: "url" };
}

/** Scan one Confluence page version (current if null). Only spaces in Clean Room scope. */
async function scanConfluencePage(pageId, version, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const page = await ports.confluence.getPage(pageId, version);
  if (!page) return null;
  if (page.spaceId != null && cfg.cleanRoom.confluenceSpaces.length) {
    const space = await ports.confluence.getSpace(page.spaceId).catch(() => null);
    if (space?.key && !cfg.cleanRoom.confluenceSpaces.includes(space.key)) return null;
  }
  const v = page.version?.number ?? version;
  const source_id = `confluence:page:${pageId}`;
  const url = page._links?.base && page._links?.webui ? `${page._links.base}${page._links.webui}` : `confluence:${pageId}`;
  const src = await repo.upsertSource({ source_id, url, title: page.title });
  const storage = page.body?.storage?.value ?? "";
  const findings = scan(storage, { allowedDomains: cfg.cleanRoom.allowedDomains });
  for (const f of findings) await repo.addFinding({ source_id, version: v, ...f });
  let suspect = isSuspect(findings);

  // LLM stage (P4): advisory. On suspect pages it explains; with llmScan "all" it can also flag a page the
  // deterministic filters missed, but only with a verbatim quote, and a human still confirms every taint.
  const mode = cfg.ai?.llmScan ?? "suspect";
  if (mode === "all" || (mode === "suspect" && suspect)) {
    const review = await ports.llm.reviewForInjection({ title: page.title, text: stripTags(storage) }, cfg);
    if (review && review.verdict !== "benign") {
      const quote = review.quote ? `“${review.quote}” — ${review.reason}` : review.reason;
      await repo.addFinding({ source_id, version: v, filter: `llm-${review.verdict}`, offset: 0, quote: quote || review.verdict });
      findings.push({ filter: `llm-${review.verdict}`, offset: 0, quote });
      if (review.verdict === "injection" && review.quote) suspect = true;
    }
  }

  if (suspect && (src.state === "unscanned" || src.state === "clean" || src.state === "restored")) {
    await repo.patchSource(source_id, { state: "suspect", rationale: `v${v}: ${[...new Set(findings.map(f => f.filter))].join(", ")}` });
  } else if (!suspect && src.state === "unscanned") {
    await repo.patchSource(source_id, { state: "clean" });
  }
  return { source_id, version: v, findings, suspect };
}

/** Scan every version (when Clean Room is enabled after the fact, or before confirming). */
async function scanHistory(pageId, cfg) {
  const versions = await ports.confluence.listVersions(pageId);
  const flagged = [];
  for (const { number } of versions) {
    const r = await scanConfluencePage(pageId, number, cfg);
    if (r?.suspect) flagged.push(number);
  }
  return { versions: versions.map(v => v.number), flagged, suggestedFrom: flagged[0] ?? null };
}

/** Scan Jira text (description/comment). Jira sources are versionless: they can be suspect, not range-tainted. */
async function scanJiraText(issueKey, text, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const findings = scan(text, { allowedDomains: cfg.cleanRoom.allowedDomains });
  if (!isSuspect(findings)) return null;
  const source_id = `jira:issue:${issueKey}`;
  const src = await repo.upsertSource({ source_id, url: `jira:${issueKey}`, title: issueKey });
  for (const f of findings) await repo.addFinding({ source_id, version: 0, ...f });
  if (src.state === "unscanned" || src.state === "clean") {
    await repo.patchSource(source_id, { state: "suspect", rationale: [...new Set(findings.map(f => f.filter))].join(", ") });
  }
  return { source_id, findings };
}

/**
 * Re-scan a ticket's description and every comment at the moment an agent is about to use it. Jira has no
 * event for an edited comment, so a comment that was clean when posted could carry instructions now.
 * Best-effort: returns the ticket's source row, or null if nothing was ever flagged or Jira can't be read.
 */
async function rescanTicket(issueKey, cfg) {
  cfg = cfg ?? await repo.getSettings();
  if (!cfg.cleanRoom.jiraProjects.includes(String(issueKey).split("-")[0])) return null;
  try {
    const issue = await ports.jira.getIssue(issueKey, ["description"]);
    const texts = [adfText(issue?.fields?.description), ...(await ports.jira.listComments(issueKey)).map(c => c.text)];
    for (const text of texts) if (text) await scanJiraText(issueKey, text, cfg);
  } catch (e) {
    console.warn(`rescanTicket ${issueKey}`, e?.message);
  }
  return repo.getSource(`jira:issue:${issueKey}`);
}

async function blastRadius(sourceId) {
  const src = await repo.getSource(sourceId);
  if (!src) return { source: null, items: [] };
  const reads = (await repo.readsForSource(sourceId)).filter(r => inTaintedRange(r.source_version, r.source));
  const byItem = new Map();
  for (const r of reads) {
    if (!byItem.has(r.issue_key)) byItem.set(r.issue_key, { issue_key: r.issue_key, agent_id: r.agent_id, versions: new Set(), late: false });
    byItem.get(r.issue_key).versions.add(r.source_version);
  }
  const items = [];
  for (const it of byItem.values()) {
    const item = await repo.getItem(it.issue_key);
    const prs = await repo.prsForItem(it.issue_key);
    items.push({ issue_key: it.issue_key, agent_id: it.agent_id, versions: [...it.versions].sort((a, b) => a - b),
      outcome: item?.outcome ?? "unknown", prs: prs.map(p => ({ pr_id: p.pr_id, state: p.state })) });
  }
  return { source: src, range: src.tainted_from_version ? rangeText(src) : null, items };
}

async function confirmTaint(sourceId, actor, fromVersion, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const src = await repo.getSource(sourceId);
  if (!src) throw new UserError("Unknown source.");
  const from = Number(fromVersion);
  if (!Number.isInteger(from) || from < 1) throw new UserError("Give the first tainted version.");
  await repo.patchSource(sourceId, { state: "confirmed", tainted_from_version: from, confirmed_by: actor, confirmed_at: ports.now() });
  await repo.logStaffAction({ actor, action: "taint-confirm", target: sourceId, note: `from v${from}` });
  await reexcuseForSource(sourceId, cfg);
  const br = await blastRadius(sourceId);
  await notifyItems(br.items.map(i => i.issue_key), { id: `taint:${sourceId}:${from}`, rev: 0,
    text: `${src.title || src.url} was confirmed tainted from v${from}` }, cfg);
  return br;
}

async function markFixed(sourceId, actor, cleanFromVersion, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const src = await repo.getSource(sourceId);
  if (!src || src.tainted_from_version == null) throw new UserError("Confirm the taint before marking it fixed.");
  const v = Number(cleanFromVersion);
  if (!Number.isInteger(v) || v <= src.tainted_from_version) throw new UserError(`The clean version must be after v${src.tainted_from_version}.`);
  if (src.state === "quarantined") await liftQuarantine(sourceId, cfg);
  await repo.patchSource(sourceId, { clean_from_version: v, ...(src.state === "quarantined" ? { state: "confirmed" } : {}) });
  await repo.logStaffAction({ actor, action: "mark-fixed", target: sourceId, note: `clean from v${v}` });
  await reexcuseForSource(sourceId, cfg);
  return blastRadius(sourceId);
}

/**
 * P4 restore: publish the last clean version (the one before tainted_from_version) as a new version,
 * then mark the source clean from that new version. Confluence pages only.
 */
async function restoreClean(sourceId, actor, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const src = await repo.getSource(sourceId);
  if (!src || src.tainted_from_version == null) throw new UserError("Confirm the taint before restoring.");
  const pageId = String(sourceId).match(/^confluence:page:(\d+)$/)?.[1];
  if (!pageId) throw new UserError("Only Confluence pages can be restored.");
  const cleanVersion = src.tainted_from_version - 1;
  if (cleanVersion < 1) throw new UserError("There is no clean version before the taint.");
  const [clean, current] = await Promise.all([ports.confluence.getPage(pageId, cleanVersion), ports.confluence.getPage(pageId, null)]);
  const nextVersion = (current?.version?.number ?? 0) + 1;
  await ports.confluence.updatePage(pageId, { title: current?.title ?? clean.title, storage: clean.body?.storage?.value ?? "",
    nextVersion, message: `Lessel Clean Room: restored v${cleanVersion} (tainted from v${src.tainted_from_version})` });
  if (src.state === "quarantined") await liftQuarantine(sourceId, cfg);
  await repo.patchSource(sourceId, { state: "restored", clean_from_version: nextVersion });
  await repo.logStaffAction({ actor, action: "restore", target: sourceId, note: `v${cleanVersion} republished as v${nextVersion}` });
  await reexcuseForSource(sourceId, cfg);
  const br = await blastRadius(sourceId);
  await notifyItems(br.items.map(i => i.issue_key), { id: `restore:${sourceId}:${nextVersion}`, rev: 0,
    text: `${src.title || src.url} was restored to its last clean content as v${nextVersion}` }, cfg);
  return br;
}

const confluencePageId = sourceId => String(sourceId).match(/^confluence:page:(\d+)$/)?.[1] ?? null;

/**
 * P4 quarantine: label the page, leave a footer comment saying which versions are tainted, and (if a
 * quarantine group is configured) restrict reading to that group so agents can't load it. Lifted by
 * Mark fixed or Restore.
 */
async function quarantine(sourceId, actor, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const src = await repo.getSource(sourceId);
  if (!src || !["confirmed", "restored"].includes(src.state)) throw new UserError("Only a confirmed tainted page can be quarantined.");
  const pageId = confluencePageId(sourceId);
  if (!pageId) throw new UserError("Only Confluence pages can be quarantined.");
  const { quarantineLabel, quarantineGroup } = cfg.cleanRoom;
  await ports.confluence.addLabel(pageId, quarantineLabel);
  await ports.confluence.addFooterComment(pageId,
    `<p><strong>Lessel Clean Room:</strong> versions in the range ${rangeText(src)} contain instructions aimed at AI agents. ` +
    `This page is quarantined until it's fixed. Agents must not use it.</p>`);
  if (quarantineGroup) await ports.confluence.restrictRead(pageId, quarantineGroup);
  await repo.patchSource(sourceId, { state: "quarantined" });
  await repo.logStaffAction({ actor, action: "quarantine", target: sourceId, note: quarantineGroup ? `read restricted to ${quarantineGroup}` : "label + comment" });
  return blastRadius(sourceId);
}

/** Undo quarantine markers; called when a fix or restore makes the page safe again. */
async function liftQuarantine(sourceId, cfg) {
  const pageId = confluencePageId(sourceId);
  if (!pageId) return;
  try {
    await ports.confluence.removeLabel(pageId, cfg.cleanRoom.quarantineLabel);
    if (cfg.cleanRoom.quarantineGroup) await ports.confluence.clearRestrictions(pageId);
    await ports.confluence.addFooterComment(pageId, "<p><strong>Lessel Clean Room:</strong> quarantine lifted; the current version is clean.</p>");
  } catch (e) {
    console.warn(`Couldn't fully lift quarantine on ${sourceId}: ${e.message}`);
  }
}

/** "Not tainted": clears the range, lifts any quarantine and withdraws excusals that relied on it. */
async function dismissTaint(sourceId, actor, cfg) {
  cfg = cfg ?? await repo.getSettings();
  const src = await repo.getSource(sourceId);
  if (!src) throw new UserError("Unknown source.");
  if (src.state === "quarantined") await liftQuarantine(sourceId, cfg);
  await repo.patchSource(sourceId, { state: "clean", rationale: null, tainted_from_version: null, clean_from_version: null });
  await repo.logStaffAction({ actor, action: "taint-dismiss", target: sourceId });
  await reexcuseForSource(sourceId, cfg);
}

/** declare-context (spec §13.2). `agent` comes from the caller identity, never from input. */
async function declareContext(agent, { issueKey, sourceUrl, sourceVersion, readAt }) {
  const item = await repo.getItem(issueKey);
  const prs = item ? await repo.prsForItem(issueKey) : [];
  const working = item && (item.assigned_agent_id === agent.agent_id || item.agent_id === agent.agent_id ||
    prs.some(p => p.agent_id === agent.agent_id));
  if (!working) return { ok: false, message: `Refused: ${agent.display_name} is not working on ${issueKey}.` };

  const now = ports.now();
  const ref = sourceRef(sourceUrl);
  let title = null;
  let versionAtRead = null;
  const declared = sourceVersion == null || sourceVersion === "" ? null : Number(sourceVersion);
  const readAtDate = readAt ? new Date(readAt) : null;
  if (readAtDate && Number.isNaN(readAtDate.getTime())) return { ok: false, message: "readAt must be an ISO-8601 time." };
  if (ref.kind === "confluence") {
    const at = readAtDate && readAtDate < now ? readAtDate : now;
    versionAtRead = await ports.confluence.versionAt(ref.pageId, at).catch(() => null);
    const page = await ports.confluence.getPage(ref.pageId, null).catch(() => null);
    title = page?.title ?? null;
  }
  const { basis, version, flag } = checkDeclaration({ sourceVersion: declared, readAt: readAtDate, now, versionAtRead,
    notBefore: item.assigned_at });
  const src = await repo.upsertSource({ source_id: ref.source_id, url: sourceUrl, title });
  const read_at = readAtDate && readAtDate <= now ? readAtDate : now;
  const read_id = crypto.createHash("sha256")
    .update([issueKey, ref.source_id, version, read_at.toISOString(), now.toISOString()].join("|")).digest("hex");
  await repo.insertRead({ read_id, issue_key: issueKey, agent_id: agent.agent_id, source_id: ref.source_id,
    source_version: version, version_basis: basis, method: "attested", flag, read_at, recorded_at: now });

  const late = item.merged_at && now > item.merged_at;
  const parts = [`Recorded: ${src.title || sourceUrl}${version != null ? ` v${version}` : ""} (${basis}).`];
  if (flag) parts.push(`Flag: ${flag}; this read can't excuse a failure.`);
  if (late) parts.push("Declared after merge; this read can't excuse a failure.");
  parts.push(`Source state: ${src.state}.`);
  if (inTaintedRange(version, src)) parts.push(`Warning: v${version} is inside the tainted range ${rangeText(src)}.`);
  return { ok: true, message: parts.join(" "), basis, version, flag, sourceState: src.state };
}

/** check-context for the caller (spec §13.5). */
async function checkContext(level, sourceUrl) {
  const ref = sourceRef(sourceUrl);
  const src = (await repo.getSource(ref.source_id)) ?? { source_id: ref.source_id, url: sourceUrl, title: sourceUrl, state: "unscanned" };
  let version = null;
  if (ref.kind === "confluence") version = (await ports.confluence.getPage(ref.pageId, null).catch(() => null))?.version?.number ?? null;
  return { ...contextGate(src, level, version), sourceState: src.state, version };
}

module.exports = { sourceRef, scanConfluencePage, scanHistory, scanJiraText, rescanTicket, blastRadius, confirmTaint, markFixed,
  restoreClean, quarantine, dismissTaint, declareContext, checkContext };
