---
name: route-work
description: >-
  Recommend which eligible AI agent, or the team, should take a Jira work item,
  based on Lessel's record for that kind of task. Use when someone asks who
  should take a ticket, which agent to assign, or whether an agent can be
  trusted with a type of work.
allowed-tools: rank-assignees explain-record
---

# Route work

1. Get the work item key. Call `rank-assignees`.
2. Show up to three candidates. For each: name, earned level, effective level if different,
   confirmed clean/total, lower bound, and any eligibility block in plain words.
3. Include "the team" when its baseline is shown. If it isn't, say "the team: not enough
   history" with the numbers rank-assignees returns. Never name individual people.
4. If the best agent is blocked or on probation, say so and recommend the next candidate.
5. If asked why, call `explain-record` and summarise the last five outcomes by key,
   including any excused outcome and the source blamed.
