# Lessel — data handling

This describes what Lessel stores, where it goes, and what it never does. It is written for admins and for the
Marketplace privacy and security questionnaire.

## What Lessel stores (Forge SQL, inside your Atlassian installation)

| Data | Why | Contains person identifiers? |
|---|---|---|
| Agents and their mapped accounts (Jira, Bitbucket, MCP) | Identity: which account is which agent | Agent service accounts only |
| Work items: key, shape, merge/deploy times, outcome | Outcomes per agent and shape | No. Human work is stored as `actor_kind = 'team'` with no person id |
| PRs and commit hashes | Linking work to code, revert detection | No (the PR author is stored only when it's a mapped agent) |
| Signals: incident/bug/revert/reopen, causality, revision | Confirmed causes | `decided_by` holds the account id of the staff member who confirmed or dismissed. This is an audit of staff actions, never aggregated or ranked |
| Records and holds | Earned levels and probation | No |
| Decision events | Level changes and why | No |
| Staff actions | Audit trail: confirm, dismiss, reopen, taint, settings | Account id of the admin or staff member who acted |
| Clean Room sources, findings (short quotes), context reads | Taint detection and excusal | Agent ids only |
| Settings | Configuration | No |

**Never stored:**
- per-person metrics, scores, rankings or exports;
- issue descriptions, comments or page bodies (only the short flagged quotes Clean Room needs);
- credentials.

The team baseline stores only aggregate counts and a contributor *count*. Assignees are read in memory to count
them and are not kept.

## Where data goes

| Destination | When | What |
|---|---|---|
| Atlassian (Jira, Confluence, Bitbucket, Teamwork Graph) | Always | Standard product APIs through Forge, under the app's scopes |
| Lessel's own paired installations (Forge web triggers, `*.hello.atlassian-dev.net`) | Only after an admin pairs them | Bitbucket events and merge checks from Lessel for Bitbucket; Bitbucket REST calls through it; Confluence events from Lessel's Confluence installation. Each pair has its own secret, kept in that installation; every request is signed. These stay inside Atlassian's Forge platform |
| **Fortytwo** (`api.fortytwo.network`), running Qwen | Only when `ai.provider = "qwen"` (the default) | For the change-class fallback: a ticket's summary, description (first 4,000 characters) and changed file paths. For the Clean Room LLM stage: a page's title and text (first 20,000 characters). Declared in the manifest as egress with `inScopeEUD: true` |
| Forge LLMs (Atlassian-hosted) | Only when `ai.provider = "forge"` | The same two inputs; the data doesn't leave Atlassian |

With `ai.provider = "forge"` and the Fortytwo egress entry removed from `manifest.yml`, no ticket or page text
leaves Atlassian. (The web-trigger egress between Lessel's own installations remains; Runs on Atlassian
eligibility needs that checked separately.) Fortytwo's own data handling is described on their site. Lessel
sends `store: false`-compatible requests and no account identifiers.

## What the AI is allowed to decide

Nothing on its own:
- **Change-class fallback.** It only runs when the path map can't classify a change, and never in the merge
  check. An LLM-classified shape caps the agent at L1 (no self-merge) until a person confirms the shape.
- **Clean Room LLM stage.** It's advisory. A quote counts only if it appears verbatim in the page, and only a
  person can confirm a taint.

## Retention and deletion

- Data lives in the Forge SQL database of the Jira installation that holds it (one per site), for as long as
  the app is installed. Nothing is shared between customers: links to Bitbucket and Confluence are made per
  site, by pairing. Uninstalling the
  app removes it per Forge's storage lifecycle.
- History snapshots for judges replace person account ids with `staff`, exclude the staff audit log, and leave
  out the agents' account mappings, so no account ids leave the site.
- Account ids appear only in `signals.decided_by`, `sources.confirmed_by`, `staff_actions.actor` and the agents'
  Jira/MCP logins. Lessel stores no names, emails or avatars.
- **Personal data reporting.** Once a week Lessel reports those account ids through Forge's personal data
  reporting API (`privacy.reportPersonalData`). For an account Atlassian reports as closed, it replaces the id
  with `closed-account` in all three columns and removes it as an agent login. It logs only the number of
  accounts erased, never the ids. There is no profile data to refresh for accounts reported as updated.
