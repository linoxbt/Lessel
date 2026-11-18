"use strict";
// Product adapters behind one object so services can be tested with fakes.

const ports = {
  get bitbucket() { return this._bitbucket ?? (this._bitbucket = require("./adapters/bitbucket")); },
  get jira() { return this._jira ?? (this._jira = require("./adapters/jira")); },
  get confluence() { return this._confluence ?? (this._confluence = require("./adapters/confluence")); },
  get graph() { return this._graph ?? (this._graph = require("./adapters/graph")); },
  get llm() { return this._llm ?? (this._llm = require("./adapters/llm")); },
  get privacy() { return this._privacy ?? (this._privacy = { reportPersonalData: a => require("@forge/api").privacy.reportPersonalData(a) }); },
  now: () => new Date(),
};

/** Tests only: override some adapters. */
function setPorts(overrides) {
  for (const [k, v] of Object.entries(overrides)) {
    if (k === "now") ports.now = v; else ports[`_${k}`] = v;
  }
}
function resetPorts() {
  for (const k of ["_bitbucket", "_jira", "_confluence", "_llm", "_graph", "_privacy"]) delete ports[k];
  ports.now = () => new Date();
}

module.exports = { ports, setPorts, resetPorts };
