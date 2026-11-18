"use strict";
// Jira product events (spec §8.3, §10.3). Payload field names follow the Forge Jira events reference [verify].

const repo = require("../db/repo");
const { ports } = require("../ports");
const { adfText } = require("../adapters/jira");
const { once } = require("./once");
const { provisionalShape } = require("../services/shapes");
const { afterItemChange, maybeExcuse, revertLinkConfirmation } = require("../services/signals");
const { scanJiraText } = require("../services/cleanroom");
const { incidentCausality, severityOf } = require("../core/outcomes");

const projectOf = key => String(key || "").split("-")[0];

async function onAssigned(event, cfg) {
  const issue = event.issue;
  if (!issue?.key || !cfg.projectKeys.includes(projectOf(issue.key))) return;
  const full = issue.fields?.summary !== undefined ? issue : await ports.jira.getIssue(issue.key);
  const assignee = full.fields?.assignee?.accountId ?? null;
  const agent = await repo.agentForAccount("jira", assignee);
  const item = await repo.getItem(issue.key);
  if (agent) {
    if (!item) {
      const shape = await provisionalShape({ summary: full.fields?.summary,
        description: adfText(full.fields?.description), components: full.fields?.components }, cfg);
      await repo.createItem({ issue_key: issue.key, actor_kind: "agent", assigned_agent_id: agent.agent_id,
        shape_id: shape.shape_id, classified_by: shape.classified_by });
    } else if (item.assigned_agent_id !== agent.agent_id) {
      await repo.patchItem(issue.key, { assigned_agent_id: agent.agent_id });
    }
  } else if (item?.assigned_agent_id) {
    await repo.patchItem(issue.key, { assigned_agent_id: null });
  }
  if (event.eventType === "avi:jira:created:issue" && cfg.cleanRoom.jiraProjects.includes(projectOf(issue.key))) {
    await scanJiraText(issue.key, adfText(full.fields?.description), cfg);
  }
}

async function onUpdated(event, cfg) {
  const issue = event.issue;
  const items = event.changelog?.items ?? [];
  if (!issue?.key) return;
  const assigneeChanged = items.some(i => i.field === "assignee" || i.fieldId === "assignee");
  if (assigneeChanged) await onAssigned({ ...event, issue: { key: issue.key } }, cfg);

  const statusChange = items.find(i => i.field === "status" || i.fieldId === "status");
  if (statusChange) {
    const item = await repo.getItem(issue.key);
    const inWindow = item?.window_ends && (item.deployed_at || item.merged_at) && ports.now() <= item.window_ends;
    if (inWindow) {
      const [from, to] = await Promise.all([ports.jira.getStatus(statusChange.from), ports.jira.getStatus(statusChange.to)]);
      if (from?.statusCategory?.key === "done" && to?.statusCategory?.key !== "done") {
        const signal_id = `reopen:${issue.key}:${event.changelog.id}`;
        if (await repo.insertSignal({ signal_id, issue_key: issue.key, kind: "reopen", ref: issue.key, causality: "suspected" })) {
          await afterItemChange(issue.key, { id: signal_id, rev: 0, text: `${issue.key} was reopened inside its window` }, cfg);
        }
      }
    }
  }
  const descChanged = items.some(i => i.field === "description" || i.fieldId === "description");
  if (descChanged && cfg.cleanRoom.jiraProjects.includes(projectOf(issue.key))) {
    const full = await ports.jira.getIssue(issue.key, ["description"]);
    await scanJiraText(issue.key, adfText(full.fields?.description), cfg);
  }
}

/** Issue link created: incident/bug ↔ work item (§10.3). */
async function onLinkCreated(event, cfg) {
  const link = event.issueLink?.sourceIssueId ? event.issueLink : await ports.jira.getIssueLink(event.issueLink?.id ?? event.id);
  if (!link) return;
  const linkId = String(link.id ?? event.issueLink?.id);
  const ids = [link.sourceIssueId ?? link.outwardIssue?.id, link.destinationIssueId ?? link.inwardIssue?.id].filter(Boolean);
  const issues = await Promise.all(ids.map(id => ports.jira.getIssue(String(id))));
  const workIdx = await (async () => {
    for (let i = 0; i < issues.length; i++) if (issues[i] && await repo.getItem(issues[i].key)) return i;
    return -1;
  })();
  if (workIdx === -1) return;
  const work = issues[workIdx];
  const other = issues[1 - workIdx];
  if (!other) return;
  const type = link.type ?? link.issueLinkType ?? {};
  const causedBy = [type.name, type.inward, type.outward, type.inwardName, type.outwardName].includes(cfg.causedByLinkType);
  return recordLinkedIssue({ work, other, causedBy, linkId, actor: event.atlassianId ?? null, via: "link" }, cfg);
}

/**
 * Record an incident or bug linked to a tracked work item (§10.3). Used by issue-link events and by the
 * Teamwork Graph sync (via "graph": never confirms, only associates). Returns the signal id or null.
 */
async function recordLinkedIssue({ work, other, causedBy = false, linkId = null, actor = null, via = "link" }, cfg) {
  const otherProject = other.fields?.project?.key ?? projectOf(other.key);
  const otherType = other.fields?.issuetype?.name;
  const kind = cfg.incidentProjects.includes(otherProject) ? "incident" : cfg.bugIssueTypes.includes(otherType) ? "bug" : null;
  if (!kind) return null;
  const item = await repo.getItem(work.key);
  if (!item) return null;
  const confirms = causedBy && via === "link";
  const shapeService = item.shape_id.split("/")[0];
  const incidentService = (other.fields?.components ?? []).map(c => c.name).find(n => n === shapeService) ?? null;
  const causality = kind === "incident"
    ? incidentCausality({ item, incidentCreatedAt: other.fields?.created, incidentService, shapeService, viaCausedByLink: confirms }, cfg)
    : (confirms && cfg.linkConfirms ? "confirmed" : "associated");
  const signal_id = `${kind}:${other.key}:${work.key}`;
  const decidedBy = causality === "confirmed" ? (actor ?? `link:${linkId}`) : null;
  const confirmedVia = causality === "confirmed" ? `link:${linkId}` : null;
  const severity = kind === "incident" ? severityOf(other.fields, cfg) : null;

  const inserted = await repo.insertSignal({ signal_id, issue_key: work.key, kind, ref: other.key, severity,
    causality, confirmed_via: confirmedVia, decided_by: decidedBy });
  if (!inserted && causality === "confirmed") {
    // an existing associated/suspected signal is upgraded by a caused-by link
    await repo.setCausality(signal_id, "confirmed", { by: decidedBy, via: confirmedVia, from: ["associated", "suspected"] });
  }
  if (!inserted && causality !== "confirmed") return signal_id; // already known: nothing changed
  if (severity != null) await repo.setSeverity(signal_id, severity);
  const how = via === "graph" ? " (found in Teamwork Graph)" : "";
  let text = kind === "incident" ? `${other.key} was linked to ${work.key}${how}` : `bug ${other.key} was linked to ${work.key}${how}`;
  const sig = await repo.getSignal(signal_id);
  if (sig.causality === "confirmed") {
    const src = await maybeExcuse(signal_id);
    text = `${other.key} was confirmed as caused by ${work.key} (caused-by link)` +
      (src ? ` but excused: bad input from ${src.title || src.url}` : "");
  }
  const fresh = await repo.getSignal(signal_id);
  await afterItemChange(work.key, { id: signal_id, rev: fresh.rev, text }, cfg);
  return signal_id;
}

async function onComment(event, cfg) {
  const key = event.issue?.key;
  if (!key || !cfg.cleanRoom.jiraProjects.includes(projectOf(key))) return;
  await scanJiraText(key, adfText(event.comment?.body), cfg);
}

function eventKey(event) {
  const id = event.issue?.id ?? event.issue?.key;
  switch (event.eventType) {
    case "avi:jira:created:issue": return `jira:create:${id}`;
    case "avi:jira:assigned:issue": return `jira:assign:${id}:${event.changelog?.id ?? event.timestamp ?? ""}`;
    case "avi:jira:updated:issue": return event.changelog?.id ? `jira:chg:${id}:${event.changelog.id}` : null;
    case "avi:jira:created:issuelink": return `jira:link:${event.issueLink?.id ?? event.id}`;
    case "avi:jira:deleted:issuelink": return `jira:unlink:${event.issueLink?.id ?? event.id}`;
    case "avi:jira:commented:issue": return `jira:comment:${event.comment?.id}`;
    default: return null;
  }
}

async function onJiraEvent(event) {
  const cfg = await repo.getSettings();
  return once(eventKey(event), async () => {
    switch (event.eventType) {
      case "avi:jira:created:issue":
      case "avi:jira:assigned:issue": return onAssigned(event, cfg);
      case "avi:jira:updated:issue": return onUpdated(event, cfg);
      case "avi:jira:created:issuelink": return onLinkCreated(event, cfg);
      case "avi:jira:deleted:issuelink": return revertLinkConfirmation(String(event.issueLink?.id ?? event.id), cfg);
      case "avi:jira:commented:issue": return onComment(event, cfg);
      default: return null;
    }
  });
}

module.exports = { onJiraEvent, onLinkCreated, recordLinkedIssue, onAssigned, onUpdated, eventKey };
