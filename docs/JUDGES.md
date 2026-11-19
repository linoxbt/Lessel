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

1. Open the **Lessel** install link from the submission and install it on your Jira site (and Confluence, if
   you have it).
2. Open **Apps → Lessel settings**. The banner says "People are never scored". Migrations run on install. If
   anything fails to load, the **Jobs** section is still shown: click **Run migrations**, then **Retry**.
3. Optional, Bitbucket: Lessel for Bitbucket is a **separate** app (Forge can't hold site and workspace
   permissions in one app). Install it from its own link on your team workspace. Then, in Lessel settings →
   **Links → Bitbucket**, click **Create pairing code** and paste the code in Bitbucket → Workspace settings →
   **Lessel** → **Pair**. Each site pairs with its own workspace; nothing is shared between installations.
4. Optional, Confluence: **Links → Confluence → Create pairing code**, then paste it in Confluence → Settings →
   **Lessel**.

## 2. Load the history (2 minutes)

Our agents build their history on our demo site. So you don't have to wait weeks, we export it as a snapshot.

1. In **Lessel settings → History snapshot**, paste the contents of `lessel-snapshot.json` from the submission
   and click **Import**. The import runs in the background; the page shows its progress and says when it's
   done.
2. Imported work items get a `DEMO` prefix (`PAY-212` becomes `DEMOPAY-212`), so they can't collide with your
   own tickets. Imported pull requests and pages are marked as imported and never reach your Bitbucket or
   Confluence. The snapshot carries no account ids.
3. Open **Projects → (any project) → Lessel**. Expect an **Imported history** banner with the export date, and
   an agents × shapes grid. The levels you see are computed on your site from the imported outcomes; the exact
   numbers depend on the export date.
4. Click a cell. The evidence drawer lists each ticket, its PR (head or merge commit), the observation window,
   and every signal with who decided it and how ("a caused-by link", "Lessel (revert)", "staff"). Nothing is
   hard-coded.
5. Open the **History** tab to see level changes and their causes, and **Clean Room** for the poisoned
   runbook: the hidden quote, the tainted range and the items that read it.

Imported sites start in **advisory** mode: Lessel explains what it would block without blocking anything.

## 3. See a decision change (3 minutes)

Use an imported item: it has merged, deployed work, which is what an incident can be blamed on. (On a fresh
ticket with no merged PR there is nothing yet for a cause to change.)

1. In the evidence drawer, find an imported item with an incident signal that was confirmed. Click **Reopen
   decision** and add a note: the signal goes back to *associated*, the record is recomputed, and History
   gains a row. Reopening needs a Jira admin; every step is audited.
2. Click **Confirm cause**. If the incident's priority is High or Highest, the agent goes on **probation**
   for that shape only ("3 clean to go"), its effective level drops, and History records why. Its other
   shapes don't change.
3. Click **Dismiss** on another associated signal to see that a dismissed cause never counts.

To see a block, switch the mode to **enforcing** in settings, add the **Lessel ready-to-merge check**
validator to a workflow transition, and try that transition on an item whose agent needs more approvals than
its PR has.

## 4. The agent side (optional)

The `rovo:mcp` server exposes `get-my-scope`, `check-ticket-fit`, `explain-record`, `declare-context` and
`check-context`. Identity always comes from the calling account, never from input. With external MCP access
enabled for the app, an MCP client signed in as a mapped agent account can ask:

> use lessel check-ticket-fit for PAY-215

The **Lessel Dispatcher** Rovo agent answers "Who should take PAY-230?" using the same records.

## Expected results at a glance

| You do | You should see |
|---|---|
| Import the snapshot | "Imported history" banner, an agents × shapes grid, a Clean Room entry for the runbook |
| Reopen decision (imported item) | Back to associated, probation lifted, new revision, History row |
| Confirm cause (High priority) | Record recomputed, probation "3 clean to go" on that shape only, History row |
| Dismiss | The signal never counts; the level is unchanged |
| Switch to enforcing + Ready-to-merge | Transition refused with one plain sentence explaining why |

## What's real and what's labelled

- The history comes from real agent work on our demo site. Imported data is labelled on every board.
- Our demo agents (Brook and Atlas) pick up work assigned to their own Jira accounts. Lessel itself works the
  same for any agent: Jira's assignable agents, or any account you map in settings.
- The poisoned runbook was planted by us as a red-team test, and the video says so.
- Our demo site used a 3-day observation window, labelled on screen. The default is 14 days.
