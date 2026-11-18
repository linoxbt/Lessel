"use strict";
// Default settings (spec §12.2). Stored overrides live in the `settings` table, one JSON value per key.

const DEFAULTS = Object.freeze({
  enforcementMode: "advisory",                 // advisory | enforcing
  approvalsByLevel: { 1: 2, 2: 1, 3: 1 },
  humanPrMinApprovals: 1,
  levels: {
    L3: { lower: 0.80, n: 10 },
    L2: { lower: 0.65, n: 5 },
    L0: { lower: 0.35, n: 5 },
  },
  probationClean: 3,
  probationMaxSeverity: 2,
  windowHours: 336,                            // 14 days; demo site uses 72, labelled
  windowEnvironment: "Production",             // Bitbucket deployment environment type
  suspectedExpiryHours: 168,
  lateConfirmDays: 90,
  suspectWindowHours: 24,                      // incident within 24 h of deploy on same service → suspected
  linkConfirms: true,
  causedByLinkType: "Problem/Incident",        // admin-configured link type name [verify on site]
  incidentProjects: ["INC"],
  bugIssueTypes: ["Bug"],
  severity: {
    field: "priority",
    map: { Highest: 1, High: 2, Medium: 3, Low: 4, Lowest: 4 },
    missing: 3,
  },
  teamBaseline: { minN: 10, minContributors: 3 },
  projectKeys: ["PAY"],
  repos: {},                                   // { [repoUuid]: { deploys: true, defaultService: "ledger" } }
  servicePaths: [                              // longest pattern wins
    { pattern: "services/ledger/**", service: "ledger" },
    { pattern: "services/checkout/**", service: "checkout" },
  ],
  criticalServices: ["checkout"],
  classPaths: [                                // matched against the path inside the service directory;
                                               // first match wins per file, so test files come first
    { pattern: "**/*.test.ts", cls: "test-fix" },
    { pattern: "**/*.test.js", cls: "test-fix" },
    { pattern: "migrations/**", cls: "schema-migration" },
    { pattern: "prisma/schema.prisma", cls: "schema-migration" },
    { pattern: "bitbucket-pipelines.yml", cls: "config-infra" },
    { pattern: "config/**", cls: "config-infra" },
    { pattern: "infra/**", cls: "config-infra" },
    { pattern: "openapi/**", cls: "api-contract" },
    { pattern: "src/routes/**/schema.ts", cls: "api-contract" },
    { pattern: "src/domain/**", cls: "business-logic" },
    { pattern: "package.json", cls: "dependency-bump" },
    { pattern: "package-lock.json", cls: "dependency-bump" },
    { pattern: "yarn.lock", cls: "dependency-bump" },
    { pattern: "pnpm-lock.yaml", cls: "dependency-bump" },
    { pattern: "docs/**", cls: "docs-copy" },
    { pattern: "src/ui/strings/**", cls: "docs-copy" },
  ],
  graphQueries: { incidents: null, devChain: null },
  importedSnapshot: null,                     // set when history was imported for judges (shown on every board)  // queryKeys from scripts/register-graph-queries.js
  cleanRoom: {
    confluenceSpaces: ["ENG"],
    jiraProjects: ["PAY"],
    allowedDomains: ["atlassian.net", "atlassian.com", "bitbucket.org"],
  },
});

module.exports = { DEFAULTS };
