# Lessel — Marketplace listing (draft)

**Name:** Lessel — earned autonomy for AI agents
**Tagline:** Give AI agents commit rights the way you'd give them to a new engineer: earned on evidence,
scoped to the work they've proven.
**Category:** Code review / Software development · **Hosting:** Forge

## Summary (short description)

Lessel tracks what happens to AI agents' work after it ships, and turns confirmed outcomes into per-task
autonomy levels. Those levels are enforced by a Bitbucket merge check and a Jira workflow validator.

## Highlights

1. **Earned, scoped levels.** L0–L3 per agent and per kind of task, from confirmed outcomes only, with the
   numbers shown.
2. **One sentence per decision.** "Brook is earned L2, effective L1 on ledger/schema-migration (16 of 18
   clean). Probation after INC-42: 3 clean to go. This PR needs 2 human approvals."
3. **Clean Room.** Poisoned docs don't punish agents: failures traced to tainted input are excused, and the
   page is flagged, quarantined or restored.

## Description

**Agents in your workforce.** AI agents now take Jira work items and open pull requests. Lessel decides how
much each agent can do on its own, and keeps that decision honest:

- **Only confirmed causes count.** Linked incidents start as questions. On-call confirms with one audited
  click, or a caused-by link does it.
- **Earned level vs eligibility.** Suspensions, tainted context and critical services block a task without
  rewriting an agent's record.
- **Shadow mode first.** Lessel explains what it would block before you enforce anything.
- **Built on Teamwork Graph.** Incidents linked in the graph become signals, and each work item's commit → PR →
  deployment chain is shown as evidence.
- **Rovo and MCP.** Ask the Dispatcher who should take a ticket. Agents check their own scope through Lessel's
  MCP server, bound to their own account.
- **People are never scored.**

## Screenshots to capture

1. Board grid with an evidence drawer open.
2. Issue panel at "associated → Confirm cause".
3. A PR comment after a decision change.
4. Clean Room with the hidden quote and the blast radius.
5. Setup check.

## Requirements

- Jira Cloud.
- Optional: Bitbucket Cloud team workspace (Premium to make the merge check Required); Confluence for Clean Room.
- AI: Qwen via Fortytwo (needs `FORTYTWO_API_KEY`) or Atlassian-hosted Forge LLMs.

## Security and privacy answers

See [PRIVACY.md](PRIVACY.md).
- **Egress:** `api.fortytwo.network` only, only for the AI features, and declared as in-scope end-user data.
- **No remotes.** The demo agents live in a separate app.
- **No person scoring.**
- **Admin-only settings.** Confirming a cause needs edit permission on the issue.

## Pricing to test (not validated)

Free for up to 2 agent identities, then a per-agent monthly price.
