# Lessel

**Earned autonomy for AI agents in Jira.** A Forge app for Codegeist 2026 (track: Apps for Software Teams;
bonus target: Best Teamwork Graph integration).

An AI agent earns autonomy through real work. Lessel watches what happens after that work ships. When the agent
causes a confirmed failure, its permissions change automatically. When the failure came from poisoned context,
Lessel excuses the agent and goes after the source instead.

The full design is in [`docs/Lessel_Build_Spec_v1.2.md`](docs/Lessel_Build_Spec_v1.2.md) (PDF alongside), with
the as-built changes in [`docs/Lessel_Build_Spec_v1.3.md`](docs/Lessel_Build_Spec_v1.3.md). Section
numbers below (§) refer to it. Submission material: [judge guide](docs/JUDGES.md),
[Devpost write-up](docs/DEVPOST.md), [video plan](docs/VIDEO.md), [Marketplace draft](docs/MARKETPLACE.md),
[data handling](docs/PRIVACY.md).

## Status

The P1 core, P2 Clean Room, P3 actions and the Teamwork Graph integration are built and tested locally. The
demo rig (ledger-service repo, A2A runner, Demo Agents app) is in [`demo/`](demo/README.md). Nothing has been
deployed yet: deploying needs your Atlassian login.

| Area | State |
|---|---|
| Trust model, levels, derived holds, `decide()` / `sentence()` | Built, unit-tested against the spec's reference table |
| Shape classifier (risk-ordered path map + Forge LLM fallback) | Built, tested |
| Forge SQL schema, repository, watermark-guarded recompute | Built, tested against MariaDB |
| Jira / Bitbucket / Confluence event handlers, write-after dedupe | Built, tested end to end with fake APIs |
| Signal lifecycle: confirm, dismiss, reopen (audited), expiry, link deletion | Built, tested |
| Merge gate, Ready-to-merge validator, advisory/enforcing mode | Built, tested |
| PR notices keyed by signal revision (rehearsals post fresh comments) | Built, tested |
| Clean Room: scan, version history, confirm taint, mark fixed, declare-before-merge excusal, blast radius | Built, tested |
| Rovo actions / MCP tools (caller-bound identity), Dispatcher agent + skill | Built, tested |
| UI Kit board (grid, evidence drawer, Clean Room tab), issue panel, settings page | Built, bundles; not yet seen on a live site |
| Backfill and hourly jobs on the `lessel-jobs` queue | Built; backfill not yet run against real data |
| Teamwork Graph (§10.5): saved Cypher queries; incidents linked in the graph become associated signals when the panel opens; commit → PR → deployment counts in the panel | Built, tested with a fake graph; queries register with `scripts/register-graph-queries.js` |
| P4: agent start validator, Clean Room restore (republish last clean version), History tab | Built, tested |
| Judge snapshot export/import (no person ids; "Imported history" banner) | Built, round-trip tested |
| P4: Clean Room LLM stage (Qwen via Fortytwo, or Forge LLMs), quote-grounded and advisory | Built, tested with a fake Qwen |
| P4: page quarantine (label, footer comment, optional read restriction; lifted on fix/restore), reminders before a suspected cause expires, reassignment hint in the panel | Built, tested |
| Personal data reporting: weekly report of stored account ids; closed accounts erased everywhere | Built, tested with a fake reporting API |
| Security review fixes: assignment-checked merge gate, AI-shape cap, frozen attribution, main-only reverts, re-scan of edited comments | Built, tested |
| Setup check on the settings page (config + live Jira checks) | Built, tested |
| CI (GitHub Actions: tests with MariaDB, runner, ledger-service, manifests, bundles, Forge linters) | Added |

## Layout

```
manifest.yml              Forge manifest (validated against the @forge/manifest schema + Forge's linters)
src/index.js              Function entry points
src/core/                 Pure logic: beta.js, levels.js, shape.js, keys.js, outcomes.js, policy.js, cleanroom.js, taint.js
src/db/                   driver.js (@forge/sql), schema.js (migrations), repo.js (all SQL)
src/adapters/             Bitbucket, Jira, Confluence REST and Forge LLM
src/services/             decide, recompute, signals, notify, shapes, cleanroom
src/events/               Product event handlers
src/enforce/              Merge gate and workflow validator
src/mcp/actions.js        Rovo actions / MCP tools
src/ui/resolver.js        UI resolver
src/frontend/             UI Kit screens (board, panel, admin)
src/jobs.js               Queue consumer: migrate, backfill, hourly, recompute-all, scan-history
skills/route-work/        Rovo skill for the Dispatcher
test/                     Unit tests + end-to-end demo test (test/demo.int.test.js)
```

## Run the tests

```bash
npm install
npm test                      # unit tests always; the end-to-end test needs a MySQL-compatible database
```

The end-to-end test runs the whole demo loop (history → incident link → Confirm cause → probation → PR comment →
blocked merge → rehearsal, plus the Clean Room excusal) against a real MySQL-compatible database with fake
Atlassian APIs. It looks for `mysql://lessel:lessel@localhost/lessel_test`, or `LESSEL_TEST_DB`, and skips
itself if there's no database. MariaDB works:

```bash
sudo apt-get install -y mariadb-server && sudo service mariadb start
sudo mysql -e "CREATE DATABASE lessel_test; CREATE USER 'lessel'@'localhost' IDENTIFIED BY 'lessel';
  GRANT ALL ON lessel_test.* TO 'lessel'@'localhost';"
```

Checks that don't need a login:

```bash
npm run check:manifest        # manifest vs the bundled Forge schema
npm i -g @forge/cli           # once
npm run lint:offline          # Forge's own client-side linters (scopes, endpoints, handlers, modules)
```

## Deploy (needs your Atlassian account)

1. `npm i -g @forge/cli`, then `forge login` with an Atlassian API token.
2. `forge register` to replace the placeholder app id in `manifest.yml`.
3. `forge lint`, then `forge deploy -e development`.
4. `forge install -e development` on your Jira site (Jira + Confluence), and on the Bitbucket **team** workspace.
   **Do week-1 check #0 now** (§5.1): confirm that the merge check reads what the Jira side writes. If it
   doesn't, tell me and we switch to design B or C.
5. Migrations run on install (lifecycle trigger). The settings page also has a **Run migrations** button.
6. In **Lessel settings** (Jira admin):
   - Add Brook and Atlas, and map each agent's Jira, Bitbucket and MCP accounts.
   - Set `repos` to `{ "<repo uuid without braces>": { "workspace": "<workspace uuid>", "deploys": true,
     "defaultService": "ledger", "mainBranch": "main" } }`.
   - Demo site: `windowHours` 72 and `windowEnvironment` "Staging" (both are labelled on screen).
   - Check `projectKeys`, `incidentProjects`, `causedByLinkType` and `severity` against your site.
   - Leave `enforcementMode` on **advisory** while history builds. Switch to enforcing on Dec 15.
7. Bitbucket: set native minimum approvals on gated branches to 0, make the Lessel check **Required** (Premium),
   and turn on "reset approvals when the source branch changes" (§14.4).
8. Jira: add the **Lessel ready-to-merge check** validator to your Ready to merge transition.
9. Enable external MCP access for the app (Atlassian Administration → Apps → Sites → your site → Connected apps),
   then connect each agent's MCP client with its own account (§15.2).
10. Register the Teamwork Graph queries and paste the printed keys into the `graphQueries` setting:
    `ATLASSIAN_SITE=… ATLASSIAN_EMAIL=… ATLASSIAN_API_TOKEN=… node scripts/register-graph-queries.js`.
11. Run **Backfill history** once agents have done some work.

## Confirmed while building

- Every OAuth scope in the manifest exists in Forge's scope list. Forge's linter maps every trigger event in the
  manifest to a scope, so it recognises all the event names.
- Rovo `action` supports `actionVerb` + `inputs`. The Forge `llm` module only offers `model: [claude]`, which is
  why Qwen goes through egress instead. `scheduledTrigger` intervals are
  `fiveMinute | hour | day | week`. `nodejs22.x` is a valid runtime.
- The Forge queue supports per-key concurrency (`{ key, limit }`), so jobs can be serialised per key.
- `TIMESTAMP` columns reject 1970-01-01 00:00:00, so the recompute watermark floor is 2000-01-01. The end-to-end
  test caught this.

- **Teamwork Graph is user-only.** `requestTeamworkGraph` exists only on `asUser()` in `@forge/api`, so
  triggers can't query the graph. That settles the spec's open question about calling it from triggers. As the
  spec's fallback says, resolution stays on events + REST, and the graph powers the panel (incident pickup and
  the dev chain).
- **Saved queries only.** New apps can't send raw Cypher; queries are saved with `/gateway/api/twg/cypher-queries`
  and run through `customQuery` (25 rows a page). In the graph, incidents are `JiraWorkItem`s, linked by
  `jsm_incident_links_jira_work_item`.
- **A test-only change** inside `src/domain` was classified as business-logic. Test-file rules now come first.

## Still to confirm on a live site

Each one is marked `[verify]` in the code. The full list is in the spec appendix.

- Exact payload shapes of Bitbucket and Confluence events, and of the merge-check event.
- Which accountId arrives on MCP-invoked actions (`callerAccountId` in `src/mcp/actions.js` tries
  `context.principal.accountId` first).
- Whether the issue-link created event carries the creator's accountId (otherwise `link:<id>` is recorded).
- The Bitbucket merge-base endpoint for deployment containment.
- Confluence v2 version-history pagination.
- The work-item ARI format for graph parameters (`ari:cloud:jira:<cloudId>:issue/<issueId>`), and whether Basic
  auth with an API token is accepted for registering saved queries.

## AI providers

Lessel's in-app AI covers two features. Both are advisory, and neither ever runs in the merge check:
- the change-class fallback when the path map has no answer;
- the Clean Room LLM stage.

Setting `ai.provider` chooses who runs it:

| `ai.provider` | Model | Notes |
|---|---|---|
| `qwen` (default) | `qwen/qwen3.8-27b` on Fortytwo (`https://api.fortytwo.network/v1`) | `forge variables set --encrypt FORTYTWO_API_KEY sk-ft-v1-…`. The manifest declares this egress host with `inScopeEUD: true`, because ticket and page text is sent there. **Declaring it removes "Runs on Atlassian" eligibility.** |
| `forge` | Forge LLMs (Atlassian-hosted) | No outside calls. To get Runs on Atlassian back, also delete the `external.fetch` entry from `manifest.yml`. |

If the provider fails, Lessel falls back to a safe default ("refactor", or no LLM finding). It never silently
switches to the other provider.

The LLM stage (`ai.llmScan`) has three settings:
- `suspect` (default): explains pages the deterministic filters already flagged.
- `all`: also reviews every in-scope page, and can flag a page the filters missed. It only counts when the
  model quotes the page verbatim, and a human still confirms every taint.
- `off`: no LLM stage.

The demo agents (`demo/runner`) also use Qwen on Fortytwo.

## Deviations from the spec

- **UI Kit instead of Custom UI.** No separate React builds. Resources point at `src/frontend/*.jsx`.
- **`prs.workspace_uuid` column.** PR comments need the workspace, so it's stored with the PR.
- **Migrations use `@forge/sql`'s `migrationRunner`.** It keeps its own record of what has run, so there's no
  `schema_version` table.
- **Jira issues as Clean Room sources** can be marked suspect, but they're versionless, so only Confluence pages
  have tainted version ranges.
