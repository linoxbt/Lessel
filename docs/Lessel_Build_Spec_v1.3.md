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
| Installation topology (§5.1) | `[verify — blocking]` | **Answered on the live site: two apps.** Forge rejects one app with both site and workspace scopes ("Workspace scopes can not be used with site scopes"). Lessel (Jira + Confluence) holds all data; **Lessel for Bitbucket** forwards Bitbucket events and asks Lessel for the merge verdict over an HMAC-signed web trigger, and fails closed when Lessel can't answer. Lessel makes its Bitbucket REST calls through Lessel for Bitbucket's proxy web trigger (no token). Since the Nov 19 audit, each Jira installation **pairs** with its own workspace, Confluence installation and runner, each with its own secret stored in that installation (see 1b). This is design B of §5.1, with the web trigger as the link | Found by `forge deploy` |
| Installations | One | Forge lists Lessel's Jira and Confluence installs separately, and Forge SQL keeps **one database per installation**. Confluence events are forwarded to the Jira installation over the same signed link | Found when migrations created the schema twice |
| Queue consumer | `resolver` + `method` | A plain `function`: the queue's event schema v2 rejects resolver consumers. Forge SQL must be declared (`sql` module) | Found deploying |
| Demo hosting | "Your A2A server" | Railway project `lessel-demo`: ledger staging + Postgres, and the runner with a persistent volume. Both deploy from `main` and only rebuild when their own folder changes | Gives the Demo Agents app a stable HTTPS address |

## 1a. Rules tightened after the security review

Two independent reviews (one of Lessel, one of the demo runner) went through the build. Each finding was checked
against the code before it was fixed, and each fix has a regression test.

| Area | Before | Now |
|---|---|---|
| Merge check | Trusted the Jira key in the branch name | The key must name an item assigned to that agent, or the PR is blocked |
| AI-chosen shapes | Ran at the agent's earned level, with no self-merge | **Capped at L1** (and at the agent's lowest level in that service, so L0 anywhere there blocks) until a person confirms the shape. Ticket text can be written to steer the classifier |
| Confirming a shape | Any editor could set any shape on any item | Editors can only confirm the AI's choice; choosing a different shape needs a Jira admin and a shape Lessel knows. Frozen items can't change. Every change is logged |
| Attribution | A later PR on the same key could change who owned the outcome | Once the window opens, later PRs (fix-forwards, revert PRs) are recorded but can't change the author, shape or merge time |
| Revert detection | Any pushed branch or tag | Only pushes to the repo's main branch (`repos.<uuid>.mainBranch`, default `main`) |
| Deployment windows | An environment with no type could open a window | Only a deployment we can identify as `windowEnvironment` opens one |
| MCP identity | Fell back to an accountId in the payload | Taken from the invocation context only |
| Excusals | Permanent once granted | Withdrawn (back to *confirmed*) when the taint is dismissed or the range no longer covers the version read. Admins can dismiss a taint |
| Declared reads | Any `readAt` was accepted | A `readAt` before the assignment is flagged `read-before-assignment` and can't excuse |
| Record sweeps | Skipped pairs whose watermark hadn't moved | The hourly sweep recomputes every pair (including pairs that only have a record) and writes regardless of the watermark |
| Panel and sources | Any user; sources for any user | The panel needs browse permission on the item; the Clean Room sources view (it shows quotes from possibly restricted pages) is admin-only |
| Edited comments | Only new comments were scanned | Confluence: edited comments are scanned again (`avi:confluence:updated:comment`). Jira has no edited-comment event, so the ticket's description and every comment are re-scanned when an agent starts work or calls check-ticket-fit, and check-ticket-fit warns if they contain text aimed at agents |
| Page events without a version | Deduped on a fixed key, so later edits were skipped | Keyed on the page's current version |
| Duplicate events at the same moment | — (reported as a possible race) | Not a bug: every side effect is claimed with `INSERT IGNORE` before it happens, so two copies post one PR comment. A test runs the same event twice at once |
| Runner | — | Credentials never on the command line or in error text; agent file access confined to the repo with symlinks and `.git` blocked; `npm ci --ignore-scripts` as a separate user; PRs blocked without declared context; tasks scoped to their agent; FIT verification required except on localhost |

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

- **MCP caller identity:** which accountId arrives for MCP calls (the code checks `context.principal.accountId` first).
- **Payload shapes:** merge-check payload; Bitbucket and Confluence event payloads; the issue-link creator field.
- **Bitbucket APIs:** merge-base for deployment containment; brace handling in UUID paths; API-token usernames
  for git and REST.
- **Confluence APIs:** v2 version-history pagination; v1 label and restriction endpoints for quarantine.
- **Forge invocation tokens:** the JWKS URL used to verify them (the runner allows overriding it with `FORGE_JWKS_URL`).
- **Site-specific settings:** the work-item ARI format for graph parameters; your caused-by link type name; your
  JSM severity field.
- **Personal data reporting:** the weekly report runs against the real API (built; tested only with a fake).

The Setup check on the settings page tests the site-specific ones (link type, projects, severity field) live.

## 1b. Audit fixes (Nov 19)

An independent audit found one critical design flaw and several gaps. All were fixed and tested (97 Lessel
tests, 48 runner tests):

| Area | Before | Now |
|---|---|---|
| Links between installations | Partner addresses and one shared secret in app-wide Forge variables, so every installation would talk to the demo site | **Pairing per installation.** Settings → Links creates a code (bridge address + new secret); the partner pastes it. Secrets live in each installation's database or storage. Unpaired workspaces send nothing |
| Keys | One master secret, also held by the agent runner | Each message kind is accepted only from its own key: Bitbucket link (events, merge check), Confluence link (events), runner link (reads and ticket fit, runner agents only), operator key (setup, jobs, pairing; held by no partner). Changes can't be replayed |
| Events | Handled inside the web trigger call | Queued at once; an hourly catch-up re-reads open and recent PRs and deployments |
| Green build for self-merge | Any successful commit status | A successful Pipelines run on the head commit (or only configured status keys) |
| Settings | Free JSON | Validated per key; the AI endpoint and key variable are fixed in code |
| Merges | Any branch counted | Only merges into the main branch count; a PR opened while assigned stays mergeable after reassignment |
| Causes | Anyone could confirm or remove a link | Agents can't decide causes; a caused-by link must point from the work to the incident and follows the late-confirmation limit |
| Clean Room | One range per page; quarantine cleared all restrictions | Taint episodes (re-poisoning after a fix is flagged; old ranges still count); quarantine restores the page's own restrictions; restricted page titles aren't revealed to agents |
| Runner | Tests ran in the checkout with full privileges | Tests and npm run in a sandboxed copy without `.git`; git runs without hooks and with a minimal environment; deadlines, cancel, retries, per-agent branches; PRs only for finished work with passing tests |
| Screens | Spinners on failure; local times labelled UTC | Errors with Retry; UTC everywhere; keys a viewer can't browse are hidden; no account ids shown |
| Judge snapshot | Imported in the request; raw keys | Imported in the background, keys prefixed `DEMO`, no account ids |

## 4. Built beyond v1.2

- **P4:** agent start validator; Clean Room restore, quarantine and LLM stage; History tab; reminders before a
  suspected cause expires; a reassignment hint in the panel.
- **Judge snapshot export/import:** person ids become `staff`; agent account mappings stay behind; the import
  runs in the background, prefixes keys with `DEMO`, is labelled "Imported history" and starts in advisory mode.
- **Linked reads:** Confluence pages linked from an agent's work item are recorded (never excusing); a read in a
  tainted range shows "possible bad input".
- **Setup check:** configuration plus live Jira checks.
- **Personal data reporting:** a weekly trigger reports stored account ids; closed accounts become
  `closed-account` everywhere and lose their agent login.
- **Demo rig:** the ledger-service repo with a staging pipeline and a synthetic check that opens incidents; the
  A2A runner; the Demo Agents app.
- **CI on GitHub Actions:** all suites, with the end-to-end tests against MariaDB; manifests; Forge linters.
- **Documents:** PRIVACY.md, MARKETPLACE.md, JUDGES.md, DEVPOST.md, VIDEO.md.

## 5. Not built

None of these are on the build plan's critical path:
- the hierarchical model;
- GitHub and GitLab support.
