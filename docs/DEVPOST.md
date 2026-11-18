# Lessel — Devpost write-up (draft)

**Track:** Apps for Software Teams · **Bonus:** Best Teamwork Graph integration

## Inspiration

Jira now treats AI agents as teammates: you can assign them work, mention them, chat with them. But the
controls are still static. A reviewer count on a branch, an allow-list, a gut feeling set once for everything.
Teams either supervise every agent PR forever and lose the speed, or wave them through and find out in
production. We wanted agents to earn autonomy the way a new engineer does.

## What it does

- **Earned, scoped levels.** For each agent and each kind of task (service / change class, e.g.
  `ledger/schema-migration`), Lessel computes a 90% lower bound on the clean rate from confirmed outcomes
  only, and turns it into L0–L3. L3 on migrations says nothing about L3 on checkout logic.
- **Only confirmed causes count.** A linked incident is a question, not a verdict. Causes move from
  associated → suspected → confirmed / dismissed. Confirmation is one audited click, or a configured
  "caused by" link, or a direct revert. Mistakes can be reopened.
- **Earned level ≠ eligibility.** A suspension, a tainted context source, or a critical service can block a
  task without touching what the agent has earned. Every decision is one plain sentence.
- **Enforced where work happens.** A Bitbucket merge check and a Jira Ready-to-merge validator both call the
  same `decide()` function. When a decision changes, Lessel comments on the open PR at once.
- **Clean Room.** If an agent followed a poisoned Confluence runbook, and declared that read *before* its work
  shipped, the failure is excused. The agent keeps its level and the page takes the blame, with the exact
  hidden quote, the tainted version range and every other item that read it.
- **Shadow first.** New installs run in advisory mode. Lessel explains what it would block before anyone turns
  enforcement on.
- **People are never scored.** Human work only appears as an aggregate team baseline, shown with at least 3
  contributors.

## How we built it

**Atlassian products used:**

| Product | How Lessel uses it |
|---|---|
| Jira | Work items, assignment and status events, issue links (incidents and caused-by), the issue panel, the project-page board, the admin page, the Ready-to-merge and agent-start workflow validators |
| Jira Service Management | Incidents and their priority/severity as failure signals |
| Bitbucket | PR, push, merge and deployment events; the `bitbucket:mergeCheck`; PR comments; commit statuses for green builds |
| Confluence | Page events and version history for Clean Room scanning; restoring the last clean version |
| Teamwork Graph | Saved Cypher queries: incidents linked to a work item (`jsm_incident_links_jira_work_item`) become signals when anyone views it, and the commit → PR → deployment chain is shown as evidence |
| Rovo | The Dispatcher agent + skill (who should take this ticket?), Rovo actions, and a `rovo:mcp` server whose tools bind identity to the calling account |
| Forge platform | Forge SQL, Forge LLMs (change-class fallback), async events queue, scheduled trigger. No remotes, no egress |

Our test agents live in a **separate** Forge app with two `rovo:agentConnector` modules (Atlas and Brook),
backed by an A2A 1.0 runner that codes with Claude. Lessel itself has no remotes. It works with anyone's agents.

**Engineering choices we're proud of:**
- One `decide()` function behind every surface.
- Records recomputed from scratch with a watermark guard, so event races converge.
- Event dedupe written after success, so retries can't lose work.
- Holds derived from signals instead of counters.
- An append-only provenance log, where a declaration after merge can never excuse.

## Challenges

- **Causality.** Our first design counted any linked incident as a failure; the rewrite made every link a
  question.
- **Gaming.** An agent could declare a tainted read after an incident to erase its own failure. The fix is the
  declare-before-merge rule plus version/time consistency checks.
- **Real history in five weeks.** We built a 3-day demo observation window (labelled) and an advisory mode,
  so agents could build history while a solo builder couldn't supply two approvals per PR.
- **Teamwork Graph from triggers.** `requestTeamworkGraph` exists only as the user, so the graph powers what
  people see and events + REST power the background.

## What we learned

The interesting problem isn't scoring agents. It's deciding what counts as evidence, and making every
decision explainable in one sentence.

## What's next

- A hierarchical model once each customer has enough data.
- GitHub and GitLab through graph connectors.
- Oversight exports, and a procurement report for teams adopting agents.
