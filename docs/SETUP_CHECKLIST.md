# Lessel — everything you need, and where to get it

## What "the Atlassian site" is

Your **Atlassian site** is your own Atlassian Cloud instance: the address `https://<name>.atlassian.net`,
where your Jira and Confluence live. Forge apps like Lessel don't run on their own: they're installed on a
site and run inside it. Until Lessel is installed on one, nothing can be tested for real.

Bitbucket isn't part of the site. It's a separate **workspace** on bitbucket.org, signed in with the same
Atlassian account. Lessel is installed on both.

For Codegeist, the easy route is a free **developer site**: https://go.atlassian.com/cloud-dev. It comes with
Jira, Jira Service Management and Confluence for a few users. Check while you set it up that **Rovo** is
available there; the agent connectors and MCP need it.

## Progress on lessel.atlassian.net

| Item | State |
|---|---|
| Site `https://lessel.atlassian.net` (Jira, JSM, Confluence) | Done |
| Confluence space **ENG** | Done |
| "Ledger runbook" page (id 557057) at **version 6** | Done |
| Jira **PAY** (software) and **INC** (service management) | Done |
| Link type "Problem/Incident" (Lessel's default `causedByLinkType`) | Present |
| INC incident issue type | Named **"[System] Incident"**: set `INCIDENT_ISSUE_TYPE` to that in the pipeline |
| `ledger` component in INC | Not created (the connector can't). Optional: the pipeline now opens incidents without it |
| Creating INC issues as you | Jira refuses: add yourself as an **agent** in INC (Project settings → People) before the pipeline opens incidents |
| **Lessel deployed and installed** (Jira + Confluence, development environment) | Done. Database created; Confluence events reach it |
| Links between installations (Nov 19 audit fix) | Done: Bitbucket workspace, Confluence and the agent runner are each **paired** with this site, with their own secrets. The old shared variables (`LESSEL_BRIDGE_SECRET`, `LESSEL_BRIDGE_URL`, `LESSEL_BB_PROXY_URL`) are deleted. To re-pair: Lessel settings → Links |
| Operator key (`LESSEL_OPERATOR_SECRET`, both apps) | Done. Kept only by the operator; used to pair the demo site's own installations |
| **Lessel for Bitbucket** registered, deployed, installed | Done |
| Bitbucket workspace **linoxbt**; Lessel for Bitbucket installed; Lessel reads Bitbucket through it (no token) | Done |
| Repository `linoxbt/ledger-service` (project LESSEL) with the demo code | Done. Repo uuid `a9264758-09b3-4c90-82ed-8cc7a6e5511a`, workspace uuid `39b301d2-4269-41cf-ad01-e87f4e5f6c5d` (for Lessel's `repos` setting) |
| Pipeline variables: STAGING_URL, RAILWAY_SERVICE, JIRA_BASE_URL, INCIDENT_PROJECT, INCIDENT_ISSUE_TYPE, INCIDENT_COMPONENT | Done. Secrets (RAILWAY_TOKEN, JIRA_EMAIL, JIRA_API_TOKEN) and enabling Pipelines come with the agents |
| Git with Bitbucket API tokens | Confirmed: username `x-bitbucket-api-token-auth` (the runner already uses it) |
| Agent accounts **Brook (agent)** and **Atlas (agent)** on the site | Done (active) |
| Fortytwo key (Qwen) | Done: `FORTYTWO_API_KEY` on Railway `agent-runner` and as an encrypted Forge variable in Lessel; tested against the API |
| Agent keys (Confluence and Bitbucket) for Brook and Atlas | Done: on Railway `agent-runner`; tested against Bitbucket |
| Lessel Demo Agents app (`e5771e11-…`) registered, deployed, installed in Jira | Done |
| Runner configuration (`RUNNER_CONFIG_JSON`, `FORGE_APP_ID`) | Done; runner healthy and refuses unsigned requests |
| Brook and Atlas: write access to `linoxbt/ledger-service` | Done (push tested) |
| Agents registered in Lessel (Jira, MCP and Bitbucket accounts); demo settings (repo, 72 h window, Staging) | Done via the signed link |
| Runner picks up work assigned to the agents' accounts (`RUNNER_POLL=1`) | Done: the AI agent connectors aren't offered on this site |
| **First end-to-end run** | Done: PAY-1 assigned to Brook → PR #1 (tests pass) → Lessel: "Brook is L1 on ledger/schema-migration … 0/2 human approvals" (advisory) |
| 90 PAY tickets | `tickets/tickets.csv` regenerated with the runbook link; created when the agents go live |

---

## 1. Accounts to create

| # | Account | Where | Notes |
|---|---|---|---|
| 1 | Your Atlassian account | https://id.atlassian.com/signup | You probably have this already. It owns the site and the apps |
| 2 | The Atlassian site | https://go.atlassian.com/cloud-dev | Pick the `<name>` in `<name>.atlassian.net`. You're the site admin |
| 3 | Bitbucket workspace | https://bitbucket.org → Create workspace | Sign in with account 1. Merge checks only block the Merge button on **Bitbucket Premium**, so start the Premium trial close to the demo |
| 4 | **Brook** service account | id.atlassian.com/signup, with a second email | Needs its own email. A plus-address of yours (`you+brook@…`) works with most providers. Invite it to the site (Jira, Confluence) and the Bitbucket workspace (write access to `ledger-service`) |
| 5 | **Atlas** service account | Same as 4 (`you+atlas@…`) | Same access as Brook |
| 6 | A second human account | Same as 4 (`you+redteam@…`) | Plants the hidden runbook line for the red-team step. Needs Confluence edit access to ENG |
| 7 | Fortytwo account | https://platform.fortytwo.network | Runs Qwen for the agents and for Lessel's AI features. Buy credits first |
| 8 | Railway | Already done | Project `lessel-demo` hosts staging and the runner |

A teammate who can approve PRs is useful (spec §17.2), but optional.

---

## 2. Keys and tokens

Never paste any of these into chat or commit them. Put them only where the last column says.

| Key | What it's for | Where to get it | Where it goes |
|---|---|---|---|
| `FORTYTWO_API_KEY` | Qwen for the agents (and Lessel, if you leave `ai.provider` on Qwen) | platform.fortytwo.network → API keys. Starts with `sk-ft-v1-` | Railway → `agent-runner` → Variables. For Lessel itself: `forge variables set --encrypt FORTYTWO_API_KEY …` |
| Your Atlassian API token | `forge login`, and the Teamwork Graph query script | https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token**, signed in as **you** | Only on your machine (the Forge CLI stores it) |
| `BROOK_ATLASSIAN_TOKEN` | Brook reads Confluence | Same page, signed in as **Brook** | Railway → `agent-runner` → Variables |
| `ATLAS_ATLASSIAN_TOKEN` | Atlas reads Confluence | Same page, signed in as **Atlas** | Railway → `agent-runner` → Variables |
| `BROOK_BITBUCKET_TOKEN` | Brook pushes branches and opens PRs | Same page, signed in as **Brook** → **Create API token with scopes** → app **Bitbucket**, scopes for repository read/write and pull requests read/write. (Bitbucket app passwords are being retired) | Railway → `agent-runner` → Variables |
| `ATLAS_BITBUCKET_TOKEN` | Atlas pushes branches and opens PRs | Same, signed in as **Atlas** | Railway → `agent-runner` → Variables |
| `JIRA_API_TOKEN` (+ `JIRA_EMAIL`) | The pipeline's synthetic check opens INC incidents | An API token from **your** account (or a bot account) | Bitbucket → `ledger-service` → Repository settings → Repository variables (tick **Secured**) |
| `RAILWAY_TOKEN` | The pipeline redeploys staging on Railway | Railway → project `lessel-demo` → Settings → Tokens → create a **project token** | Bitbucket repository variables (**Secured**) |
| Agent MCP logins | Agents call Lessel's `declare-context` tool | Run `npm run mcp-login -- brook` (then `atlas`) in `demo/runner` on your machine; a browser opens, sign in as that agent | Copy `demo/runner/data/secrets/mcp-*.json` to the runner's `/data/secrets/` |

---

## 3. IDs to look up

| ID | What it is | Where to find it | Where it goes |
|---|---|---|---|
| Lessel app id | Identifies the Lessel app | `forge register` in the repo root writes it into `manifest.yml` (`app.id: ari:cloud:ecosystem::app/<uuid>`) | `manifest.yml` (automatic) |
| Demo Agents app id | Identifies the agent-connector app | `forge register` in `demo/agents-app` | Railway → `agent-runner` → `FORGE_APP_ID` (just the UUID) and `forgeAppId` in `RUNNER_CONFIG_JSON` |
| Site URL | `https://<name>.atlassian.net` | Your browser's address bar | `siteUrl` in `RUNNER_CONFIG_JSON`; `JIRA_BASE_URL` in Bitbucket variables |
| Lessel MCP URL | The address agents use to call Lessel's tools | Shown once Lessel is deployed and external MCP access is turned on (Atlassian Administration → Apps → Sites → your site → Connected apps). **Not confirmed yet:** the expected shape is `https://mcp.atlassian.com/forge/<Lessel app id>` | `lesselMcpUrl` in `RUNNER_CONFIG_JSON` |
| Bitbucket workspace slug | e.g. `acme` in `bitbucket.org/acme/ledger-service` | The URL | `repo.workspace` in `RUNNER_CONFIG_JSON` |
| Repository UUID and workspace UUID | Lessel matches events by UUID | Open `https://api.bitbucket.org/2.0/repositories/<workspace>/ledger-service` while signed in: `uuid` and `workspace.uuid` (drop the `{ }`) | Lessel settings → `repos` |
| Agents' Jira accountIds | The agentConnector users Jira creates for Atlas and Brook | The runner logs them on first contact; also the end of the URL of each agent's profile in Jira (`/jira/people/<accountId>`) | Lessel settings → each agent → `jira` account |
| Agents' Bitbucket UUIDs | Who opened a PR | `https://api.bitbucket.org/2.0/user` signed in as that agent → `uuid` | Lessel settings → each agent → `bitbucket` account |
| Agents' MCP accountIds | Who called an MCP tool | The Atlassian account each agent's MCP login uses (normally the same service account; its accountId is at the end of its Jira profile URL) | Lessel settings → each agent → `mcp` account |
| Link type, severity field | How your site marks "caused by" and severity | Jira settings → Issues → Issue linking; your JSM severity field | Lessel settings: `causedByLinkType`, `severity`. The **Setup check** on the settings page tells you if they're wrong |

---

## 4. Where everything goes, in one place

**Railway → `agent-runner` → Variables**
- `FORTYTWO_API_KEY`
- `FORGE_APP_ID`
- `BROOK_BITBUCKET_TOKEN`, `ATLAS_BITBUCKET_TOKEN`
- `BROOK_ATLASSIAN_TOKEN`, `ATLAS_ATLASSIAN_TOKEN`
- `RUNNER_CONFIG_JSON`: replace the placeholders with your site URL, Lessel MCP URL, workspace slug, Demo
  Agents app id and the agents' emails (see `demo/runner/agents.example.json` for the layout)

**Bitbucket → `ledger-service` → Repository variables**
- `RAILWAY_TOKEN` (secured), `RAILWAY_SERVICE=ledger-staging`
- `STAGING_URL=https://ledger-staging-production-1c72d760.up.railway.app`
- `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (secured)
- `INCIDENT_PROJECT=INC`, `INCIDENT_COMPONENT=ledger`, and `INCIDENT_ISSUE_TYPE` if yours isn't "Incident"

**Lessel settings page** (in Jira, as an admin)
- Agents Brook and Atlas, each with its `jira`, `bitbucket` and `mcp` accounts
- `repos`: `{ "<repo uuid>": { "workspace": "<workspace uuid>", "deploys": true, "defaultService": "ledger", "mainBranch": "main" } }`
- `windowHours` 72 and `windowEnvironment` "Staging" for the demo
- `graphQueries`: the keys printed by `node scripts/register-graph-queries.js`
- Leave `enforcementMode` on advisory until Dec 15

**Lessel's own secret** (only if `ai.provider` stays "qwen"): `forge variables set --encrypt FORTYTWO_API_KEY <key>`

---

## 5. Order of operations

1. Create the site, the Bitbucket workspace, and the Brook, Atlas and red-team accounts (section 1). Invite
   them to the site and the workspace.
2. In Jira: create projects **PAY** (software) and **INC** (Service Management) with a `ledger` component.
   In Confluence: a space **ENG**.
3. Install the Forge CLI (`npm i -g @forge/cli`) and `forge login` with your API token.
4. Lessel: in the repo root, `forge register`, `forge deploy -e development`, then
   `forge install -e development` on the site **and** on the Bitbucket workspace.
5. **Week-1 check #0 (blocking):** confirm the Bitbucket merge check can read what the Jira side wrote
   (spec §5.1). If it can't, stop and tell me; the design changes.
6. Push `demo/ledger-service` to `bitbucket.org/<workspace>/ledger-service`, enable Pipelines, set the
   repository variables (section 4).
7. Demo Agents: in `demo/agents-app`, `forge register`, `forge deploy -e development`,
   `forge install -e development` on the site, and approve the connectors.
8. Get the remaining keys and IDs (sections 2 and 3) and fill in Railway (section 4). The runner redeploys on
   its own when variables change.
9. Run the MCP logins locally and copy the token files to the runner.
10. Fill in Lessel settings (section 4) and run the **Setup check** there until everything is green.
11. Create the "Ledger runbook" page in ENG and import the PAY tickets (`demo/README.md`, step 1).
12. Assign the first ticket to Brook and watch the runner's log on Railway.

The rest of the week-1 checks (spec v1.2 §21) can only be done on the live site; README.md lists them under
"Still to confirm on a live site".
