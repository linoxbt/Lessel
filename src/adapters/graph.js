"use strict";
// Teamwork Graph (Forge Preview). Saved Cypher queries run through customQuery (raw cypherQuery is not
// available to new apps). requestTeamworkGraph exists only on asUser(), so the graph serves user-facing
// surfaces (issue panel, evidence drawer, Dispatcher); triggers keep using events + REST.

const QUERIES = {
  // Incidents are JiraWorkItems in the graph; the edge runs incident → work item.
  incidents: {
    name: "lessel-incidents-for-work-item",
    cypher: "MATCH (inc:JiraWorkItem)-[:jsm_incident_links_jira_work_item]->(item:JiraWorkItem {ari: $id}) RETURN inc",
    paramsSchema: [{ name: "id", type: "ARI", required: true }],
  },
  // Work item → commits, plus the PRs and deployments that contain those commits (evidence drawer).
  devChain: {
    name: "lessel-dev-chain-for-work-item",
    cypher: "MATCH (item:JiraWorkItem {ari: $id})-[:jira_work_item_links_external_commit]->(commit:ExternalCommit) " +
      "OPTIONAL MATCH (pr:ExternalPullRequest)-[:external_pull_request_has_external_commit]->(commit) " +
      "OPTIONAL MATCH (deployment:ExternalDeployment)-[:external_deployment_has_external_commit]->(commit) " +
      "RETURN commit, pr, deployment",
    paramsSchema: [{ name: "id", type: "ARI", required: true }],
  },
};

const DOCUMENT = `query LesselSavedQuery($queryKey: String!, $queryParams: CypherRequestParams, $after: String) {
  customQuery(queryKey: $queryKey, queryParams: $queryParams, first: 25, after: $after) {
    edges { node { columns { key value {
      __typename
      ... on CypherQueryResultNode { id data { __typename ... on JiraWorkItem { key summary } } }
    } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

class GraphError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Work item ARI [verify format on a live site]. */
const workItemAri = (cloudId, issueId) => `ari:cloud:jira:${cloudId}:issue/${issueId}`;

/** Flatten customQuery edges into rows: { [column]: { id, type, key, summary } | null }. */
function rowsFrom(body) {
  const cq = body?.data?.customQuery;
  if (!cq) {
    const err = body?.errors?.[0];
    throw new GraphError(err?.extensions?.code ?? "UNKNOWN", err?.message ?? "Teamwork Graph returned no data");
  }
  const rows = (cq.edges ?? []).map(e => {
    const row = {};
    for (const c of e.node?.columns ?? []) {
      const v = c.value;
      row[c.key] = v && v.__typename === "CypherQueryResultNode"
        ? { id: v.id, type: v.data?.__typename ?? null, key: v.data?.key ?? null, summary: v.data?.summary ?? null }
        : null;
    }
    return row;
  });
  return { rows, pageInfo: cq.pageInfo ?? {} };
}

/** Run a saved query as the current user, following pages (25 rows each) up to maxPages. */
async function runSavedQuery(queryKey, queryParams, { maxPages = 4, request } = {}) {
  const call = request ?? ((q, v) => require("@forge/api").asUser().requestTeamworkGraph(q, v));
  const all = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await call(DOCUMENT, { queryKey, queryParams, ...(after ? { after } : {}) });
    const body = typeof res.json === "function" ? await res.json() : res;
    const { rows, pageInfo } = rowsFrom(body);
    all.push(...rows);
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }
  return all;
}

/** Incidents linked to a work item in the graph: [{ key, summary, id }]. */
async function incidentsFor({ queryKey, cloudId, issueId }, opts) {
  const rows = await runSavedQuery(queryKey, { id: workItemAri(cloudId, issueId) }, opts);
  const seen = new Map();
  for (const r of rows) if (r.inc?.key && !seen.has(r.inc.key)) seen.set(r.inc.key, { key: r.inc.key, summary: r.inc.summary, id: r.inc.id });
  return [...seen.values()];
}

/** Commits, PRs and deployments for a work item: distinct ids per kind. */
async function devChainFor({ queryKey, cloudId, issueId }, opts) {
  const rows = await runSavedQuery(queryKey, { id: workItemAri(cloudId, issueId) }, opts);
  const ids = col => [...new Set(rows.map(r => r[col]?.id).filter(Boolean))];
  return { commits: ids("commit"), prs: ids("pr"), deployments: ids("deployment") };
}

module.exports = { QUERIES, DOCUMENT, GraphError, workItemAri, rowsFrom, runSavedQuery, incidentsFor, devChainFor };
