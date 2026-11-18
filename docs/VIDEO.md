# Video plan (under 5 minutes; target 3)

Fill the `{placeholders}` from the board on **Mon Dec 14** (spec v1.2 §17.3). Record **Dec 17–18**. Use English
and no copyrighted music. Disclose:
- the planted runbook;
- the 3-day demo window;
- advisory-mode history, if that's how it was collected;
- any replayed confirmation.

| Time | Shot | Say | Must be on screen |
|---|---|---|---|
| 0:00 | Jira board with Atlas and Brook assigned work | "Two AI agents work in this Jira. Which one would you let merge a database migration with one reviewer?" | Agent avatars on real tickets |
| 0:15 | Lessel board | "Almost four weeks of real history." | Window note (3 days, demo setting); Brook {L3} {16 of 17}; Atlas {L1} {6 of 11} |
| 0:30 | Evidence drawer on Brook's cell | "Every number comes from tickets, PRs and deployments. Nothing's hard-coded." | Ticket → PR → deploy → signals, with who confirmed |
| 0:40 | Rovo Dispatcher: "Who should take PAY-230?" | "It recommends Brook, with evidence, and never names people." | Team line: baseline or "not enough history" |
| 1:00 | PAY-230 PR in Bitbucket | "The merge check passes: one human approval." | Lessel check message |
| 1:10 | INC-42 linked to PAY-201; Lessel panel | "A link isn't proof." Then click Confirm cause | "associated" → Confirm cause |
| 1:30 | PR comment lands; click Merge | "Earned L2, effective L1, probation: three clean to go. It now needs two approvals." | Comment text; blocked Merge (Premium) or refused Ready-to-merge transition |
| 1:55 | Board | "Scoped: every other Brook cell is unchanged." | Striped cell; {L3} on ledger/business-logic |
| 2:05 | Clean Room tab | "INC-43 was caused by Atlas's PAY-188, but Atlas declared reading runbook v7 before merging, and v7 was poisoned." | Hidden quote; range v7–v8, clean from v9; "excused"; blast radius |
| 2:35 | Claude Code as Brook: `check-ticket-fit PAY-215` | "Earned versus eligible." | "…inside the tainted range v7–v8. This task is blocked." |
| 2:55 | Board | "Agents earn trust in your codebase. They lose it for confirmed failures, never for someone else's poison." | Logo / name |

## Disclosure card (end of video or in captions)

> The poisoned runbook edit was planted by us as a red-team test. The demo site uses a 3-day observation
> window (default 14). {History was collected in advisory mode.} {INC-42's confirmation is a replay of a real
> event, reopened and confirmed again.}

## Before recording

- Rehearse the 1:10–1:30 loop twice. Use **Reopen decision** between runs, so each run posts a fresh PR comment.
- Switch to **enforcing** on Dec 15.
- Export the snapshot after recording, for the judges.
