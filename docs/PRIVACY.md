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
| **Fortytwo** (`api.fortytwo.network`), running Qwen | Only when `ai.provider = "qwen"` (the default) | For the change-class fallback: a ticket's summary, description (first 4,000 characters) and changed file paths. For the Clean Room LLM stage: a page's title and text (first 20,000 characters). Declared in the manifest as egress with `inScopeEUD: true` |
| Forge LLMs (Atlassian-hosted) | Only when `ai.provider = "forge"` | The same two inputs; the data doesn't leave Atlassian |

With `ai.provider = "forge"` and the egress entry removed from `manifest.yml`, nothing leaves Atlassian, and
the app is eligible for Runs on Atlassian. Fortytwo's own data handling is described on their site. Lessel
sends `store: false`-compatible requests and no account identifiers.

## What the AI is allowed to decide

Nothing on its own:
- **Change-class fallback.** It only runs when the path map can't classify a change, and never in the merge
  check. An LLM-classified shape never allows self-merge until a person confirms the shape.
- **Clean Room LLM stage.** It's advisory. A quote counts only if it appears verbatim in the page, and only a
  person can confirm a taint.

## Retention and deletion

- Data lives in the installation's Forge SQL database for as long as the app is installed. Uninstalling the
  app removes it per Forge's storage lifecycle.
- History snapshots for judges replace person account ids with `staff` and exclude the staff audit log.
- Account ids appear only in `signals.decided_by`, `sources.confirmed_by` and `staff_actions`. **[verify]**
  whether Forge apps storing account ids must implement the personal data reporting API, and if so, add the
  report/erase handler for those three columns.
