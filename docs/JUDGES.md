# Lessel — guide for Codegeist judges

Lessel gives AI agents commit rights the way you'd give them to a new engineer. Agents earn them on evidence,
scoped to the work they've proven, and lose them when that work is confirmed to have hurt production. When a
failure came from poisoned context, Lessel excuses the agent and goes after the source.

This guide gets you from install to a live block in about 10 minutes.

## What you need

- A Jira Cloud site with Jira Software (and ideally Confluence). Admin rights let you open Lessel settings.
- Optional: a Bitbucket Cloud **team** workspace, to see the merge check. Personal workspaces can't run Forge
  apps. A failing check only disables the Merge button on Bitbucket Premium. Without Premium, the Jira
  Ready-to-merge validator is the block you'll see.

## 1. Install (2 minutes)

1. Open the install link from the submission and install Lessel on your Jira site.
2. Optional: install it on your Bitbucket team workspace from the same link.
3. Open **Apps → Lessel settings**. The banner says "People are never scored". Migrations run on install; if
   the page says tables are missing, click **Run migrations**.

## 2. Load the real history (2 minutes)

Our agents built their history on our demo site over several weeks. To let you see that history without
waiting weeks yourself, we export it as a snapshot.

1. In **Lessel settings → History snapshot**, paste the contents of `lessel-snapshot.json` from the submission
   and click **Import pasted snapshot**.
2. Open **Projects → (any project) → Lessel**. Expect an **Imported history** banner with the export date, and
   an agents × shapes grid:
   - **Brook** at L3 on `ledger/schema-migration`, with something like 16 of 17 clean.
   - **Atlas** at L1 on the same shape.
   - The team column says "not enough history" if we had no human tickets. We never score people.
3. Click a cell. The evidence drawer lists each ticket, its PR, deployment and signals, with who decided
   each cause and how ("by link", "revert", or "staff"). Nothing is hard-coded.
4. Open the **History** tab to see every level change and its cause. Open **Clean Room** to see the poisoned
   runbook: the hidden quote, the tainted range v7–v8, and the items that read it.

Imported sites start in **advisory** mode: Lessel explains what it would block without blocking anything.

## 3. See a live decision change (5 minutes)

You don't need our agents for this. Any Jira work item works.

1. In settings, add an agent:
   - Click **Add agent** with `brook` / `Brook`.
   - Map **your own** Jira account as Brook's `jira` account, so you can act as the agent.
2. Create a work item in a project listed in `projectKeys` (default `PAY`; change it in settings) and assign
   it to yourself. The Lessel panel on the issue shows Brook's decision for the item's shape.
3. Create an issue in a project listed in `incidentProjects` (default `INC`) and link it to the work item. The
   panel shows the incident as **associated**. Nothing changes yet, because a link isn't proof.
4. Click **Confirm cause**. The record is recomputed. If the incident is High or Highest priority, the panel
   now shows probation. The History tab gains a row, and any open agent PR gets a comment.
5. Click **Reopen decision** (admin, with a note) to undo it. The rehearsal loop is audited.

To see a block, switch the mode to **enforcing** in settings. Add the **Lessel ready-to-merge check**
validator to a transition in your workflow, then try that transition on an item whose agent needs more
approvals than its PR has.

## 4. The agent side (optional)

The `rovo:mcp` server exposes `get-my-scope`, `check-ticket-fit`, `explain-record`, `declare-context` and
`check-context`. Identity always comes from the calling account, never from input. With external MCP access
enabled for the app, an MCP client signed in as a mapped agent account can ask:

> use lessel check-ticket-fit for PAY-215

The **Lessel Dispatcher** Rovo agent answers "Who should take PAY-230?" using the same records.

## Expected results at a glance

| You do | You should see |
|---|---|
| Import the snapshot | "Imported history" banner, Brook L3 / Atlas L1 on schema migrations, Clean Room entry for the runbook |
| Link an incident | Signal "associated"; level unchanged |
| Confirm cause (High priority) | Earned level recomputed, probation "3 clean to go", History row, PR comment if a PR is open |
| Reopen decision | Back to associated, probation lifted, new revision |
| Switch to enforcing + Ready-to-merge | Transition refused with one plain sentence explaining why |

## What's real and what's labelled

- The history comes from real agent work on our demo site. Imported data is labelled on every board.
- The poisoned runbook was planted by us as a red-team test, and the video says so.
- Our demo site used a 3-day observation window, labelled on screen. The default is 14 days.
