---
title: "Lessel — Build Spec v1.3 (as-built addendum)"
---

<p class="kicker">CODEGEIST 2026 · BUILD SPEC v1.3 · AS-BUILT ADDENDUM · NOV 18, 2026</p>

# Lessel — what changed since v1.2

v1.3 doesn't replace v1.2. It records what we learned while building it and the decisions that changed. Read
v1.2 for the design, and this page for where the build differs. Section numbers (§) refer to v1.2.

## 1. Decisions changed

| Area | v1.2 | As built (v1.3) | Why |
|---|---|---|---|
| AI provider (Lessel) | Forge LLMs only | `ai.provider`: **Qwen** (`qwen/qwen3.8-27b` on Fortytwo, default) or **Forge LLMs** | Owner decision to build the AI around Qwen. The Forge `llm` module only offers Claude, so Qwen goes through declared egress (`api.fortytwo.network`, `inScopeEUD: true`). **Lessel is no longer eligible for Runs on Atlassian** unless the egress entry is removed and the provider set to `forge` |
| AI provider (demo agents) | Claude (spec didn't fix one) | Qwen on Fortytwo through an OpenAI-compatible client; any compatible endpoint is configurable | Owner decision; no Anthropic dependency remains |
| AI scope | Change-class fallback; P4 LLM scan stage | Both built. The scan stage is advisory: a quote counts only if it appears verbatim in the page, and a human still confirms every taint (§13.1) | Model output must not change state on its own |
| UI | Custom UI with three React builds | UI Kit (`render: native`) | No separate build pipeline |
| Migrations | Own `schema_version` table | `@forge/sql` `migrationRunner`, run on install/upgrade and from settings | Built into the SDK |
| Holds | Derived (v1.2) | Derived, as in v1.2. Probation "new clean" means merged strictly after the confirmation | Confirmed in tests |
| Shape rules | Risk-ordered classes | Same, plus: **test-file rules match first per file**, so a test-only change inside `src/domain` is `test-fix` | A real misclassification found while wiring the demo repo |
| Teamwork Graph | Graph sweep from triggers if `asApp()` works | **`requestTeamworkGraph` is `asUser()` only** (confirmed in `@forge/api` types). Saved Cypher queries via `customQuery`; incidents found in the graph become *associated* signals when someone opens the issue panel; the dev chain shows in the panel | Raw `cypherQuery` isn't available to new apps, and triggers can't use the graph |
| Demo hosting | "Your A2A server" | Railway project `lessel-demo`: ledger staging + Postgres, and the runner with a persistent volume. Both deploy from `main` and only rebuild when their own folder changes | Gives the Demo Agents app a stable HTTPS address |

## 2. `[verify]` items resolved during the build

| Item (v1.2 appendix) | Answer | Source |
|---|---|---|
| OAuth scope names (Bitbucket PR comments, statuses, Confluence, graph) | All exist; Forge's linter maps each endpoint we call to its scope, and the manifest passes | `@forge/manifest` scope list; offline Forge lint |
| Bitbucket and Jira trigger event names | Recognised by Forge's linter (each maps to a scope) | offline Forge lint |
| `consumer` manifest syntax, `nodejs22.x`, `scheduledTrigger` intervals, `action` with `actionVerb` + `inputs`, `rovo:mcp`, `rovo:skill` | Valid against the bundled manifest schema | `@forge/manifest` schema |
| Per-key serialisation for jobs | The Forge queue supports `concurrency: { key, limit }` | `@forge/events` types |
| Teamwork Graph `asApp()` from triggers | Not available: `asUser()` only | `@forge/api` types |
| Graph relationship identifiers | `jsm_incident_links_jira_work_item`, `jira_work_item_links_external_commit`, `external_pull_request_has_external_commit`, `external_deployment_has_external_commit`; incidents are `JiraWorkItem`s | Teamwork Graph docs |
| A2A wire format for agent connectors | A2A **1.0**: `SendMessage` / `GetTask` / `CancelTask`, parts `{text}` / `{data}`, roles `ROLE_USER` / `ROLE_AGENT`, states `TASK_STATE_*`; must report WORKING first; 55 s sync limit, Jira polls `GetTask` up to 60 min for work items | Atlassian "Integrate remote agents with Jira" guide and its sample app |
| Agent connector invocation data | `invocationType` (`ISSUE_ASSIGNMENT`, `ISSUE_COMMENT_MENTION`, …), `issue.fields.key/summary/description` (plain text), `agentAccountId`, `userAccountId` | same |
| FIT checks | Issuer `forge/invocation-token`, audience `ari:cloud:ecosystem::app/<id>`, `x-forge-oauth-system` for callbacks | same |
| Egress format | `external.fetch.backend: [{ address, inScopeEUD }]`; plain strings are deprecated | Forge linter |
| Quarantine scopes | `write:confluence-content` (labels, restrictions), `write:comment:confluence` (footer comments) | Forge linter |
| `TIMESTAMP` lower bound | 1970-01-01 00:00:00 is rejected, so the watermark floor is 2000-01-01 | end-to-end test |

## 3. Still to confirm on a live site

- **[blocking] Installation topology (§5.1):** does the merge check read what the Jira side writes?
- **MCP caller identity:** which accountId arrives for MCP calls (the code checks `context.principal.accountId` first).
- **Payload shapes:** merge-check payload; Bitbucket and Confluence event payloads; the issue-link creator field.
- **Bitbucket APIs:** merge-base for deployment containment; brace handling in UUID paths; API-token usernames
  for git and REST.
- **Confluence APIs:** v2 version-history pagination; v1 label and restriction endpoints for quarantine.
- **Forge invocation tokens:** the JWKS URL used to verify them (the runner allows overriding it with `FORGE_JWKS_URL`).
- **Site-specific settings:** the work-item ARI format for graph parameters; your caused-by link type name; your
  JSM severity field.
- **Policy:** whether storing confirmer accountIds requires the personal-data reporting API.

The Setup check on the settings page tests the site-specific ones (link type, projects, severity field) live.

## 4. Built beyond v1.2

- **P4:** agent start validator; Clean Room restore, quarantine and LLM stage; History tab; reminders before a
  suspected cause expires; a reassignment hint in the panel.
- **Judge snapshot export/import:** person ids become `staff`; the import is labelled "Imported history" and
  starts in advisory mode.
- **Setup check:** configuration plus live Jira checks.
- **Demo rig:** the ledger-service repo with a staging pipeline and a synthetic check that opens incidents; the
  A2A runner; the Demo Agents app.
- **CI on GitHub Actions:** all suites, with the end-to-end tests against MariaDB; manifests; Forge linters.
- **Documents:** PRIVACY.md, MARKETPLACE.md, JUDGES.md, DEVPOST.md, VIDEO.md.

## 5. Not built

None of these are on the build plan's critical path:
- the hierarchical model;
- GitHub and GitLab support;
- the per-person data reporting handler, pending the policy check above.
