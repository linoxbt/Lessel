"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../src/adapters/graph");

const node = (id, data) => ({ __typename: "CypherQueryResultNode", id, data });
const page = (rows, next = null) => ({ data: { customQuery: {
  edges: rows.map(cols => ({ node: { columns: Object.entries(cols).map(([key, value]) => ({ key, value })) } })),
  pageInfo: { hasNextPage: !!next, endCursor: next },
} } });

test("saved queries use the documented relationship identifiers and $id parameter", () => {
  assert.match(G.QUERIES.incidents.cypher, /\[:jsm_incident_links_jira_work_item\]->\(item:JiraWorkItem \{ari: \$id\}\)/);
  assert.match(G.QUERIES.devChain.cypher, /jira_work_item_links_external_commit/);
  assert.match(G.QUERIES.devChain.cypher, /external_pull_request_has_external_commit/);
  assert.match(G.QUERIES.devChain.cypher, /external_deployment_has_external_commit/);
  assert.match(G.DOCUMENT, /customQuery\(queryKey: \$queryKey, queryParams: \$queryParams, first: 25, after: \$after\)/);
  assert.equal(G.workItemAri("c1", "10001"), "ari:cloud:jira:c1:issue/10001");
});

test("incidentsFor follows pages and de-duplicates", async () => {
  const calls = [];
  const request = async (doc, vars) => {
    calls.push(vars);
    return vars.after
      ? page([{ inc: node("ari:2", { __typename: "JiraWorkItem", key: "INC-43", summary: "b" }) }])
      : page([{ inc: node("ari:1", { __typename: "JiraWorkItem", key: "INC-42", summary: "a" }) },
        { inc: node("ari:1", { __typename: "JiraWorkItem", key: "INC-42", summary: "a" }) }], "cursor-1");
  };
  const out = await G.incidentsFor({ queryKey: "qk", cloudId: "c1", issueId: "7" }, { request });
  assert.deepEqual(out.map(i => i.key), ["INC-42", "INC-43"]);
  assert.deepEqual(calls[0], { queryKey: "qk", queryParams: { id: "ari:cloud:jira:c1:issue/7" } });
  assert.equal(calls[1].after, "cursor-1");
});

test("devChainFor counts distinct commits, PRs and deployments; OPTIONAL MATCH nulls are fine", async () => {
  const request = async () => page([
    { commit: node("c1", { __typename: "ExternalCommit" }), pr: node("p1", { __typename: "ExternalPullRequest" }), deployment: null },
    { commit: node("c2", { __typename: "ExternalCommit" }), pr: node("p1", { __typename: "ExternalPullRequest" }), deployment: node("d1", { __typename: "ExternalDeployment" }) },
  ]);
  assert.deepEqual(await G.devChainFor({ queryKey: "q", cloudId: "c", issueId: "1" }, { request }),
    { commits: ["c1", "c2"], prs: ["p1"], deployments: ["d1"] });
});

test("errors arrive as HTTP 200 with customQuery null", async () => {
  const request = async () => ({ data: { customQuery: null }, errors: [{ message: "not yet", extensions: { code: "QUERY_NOT_FOUND" } }] });
  await assert.rejects(G.incidentsFor({ queryKey: "q", cloudId: "c", issueId: "1" }, { request }), e => e.code === "QUERY_NOT_FOUND");
});
