"use strict";
// Forge function entry points (manifest `function` handlers).

const { onJiraEvent } = require("./events/jira");
const { onConfluenceEvent } = require("./events/confluence");
const { bitbucketBridge } = require("./bridge");
const { validateReadyToMerge, validateAgentStart } = require("./enforce/validators");
const actions = require("./mcp/actions");
const jobs = require("./jobs");
const { uiResolver } = require("./ui/resolver");

/** Scheduled trigger: hand the sweep to the queue so it gets the longer async runtime. */
async function resolveOutcomes() {
  await jobs.enqueue({ type: "hourly", fanOut: true }, "hourly");
  return { statusCode: 204 };
}

/** Weekly: report stored accountIds to Atlassian and erase closed accounts (Forge personal data reporting). */
async function reportPersonalData() {
  await jobs.enqueue({ type: "privacy-report" }, "privacy-report");
  return { statusCode: 204 };
}

/** App installed or upgraded: run migrations. */
async function onLifecycle() {
  await jobs.enqueue({ type: "migrate" }, "migrate");
}

module.exports = {
  onJiraEvent,
  onConfluenceEvent,
  onLifecycle,
  resolveOutcomes,
  reportPersonalData,
  jobs: jobs.consume,
  bitbucketBridge,
  validateReadyToMerge,
  validateAgentStart,
  uiResolver,
  rankAssignees: actions.rankAssignees,
  explainRecord: actions.explainRecord,
  getMyScope: actions.getMyScope,
  checkTicketFit: actions.checkTicketFit,
  declareContext: actions.declareContext,
  checkContext: actions.checkContext,
};
