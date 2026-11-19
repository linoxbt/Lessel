// The runner's signed client to Lessel's bridge: same signature format Lessel verifies (src/bridge-sign.js).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { LesselBridge } from "../src/lessel.js";

const require = createRequire(import.meta.url);
const { verify } = require("../../../src/bridge-sign.js");
const SECRET = "q".repeat(40);

test("LesselBridge signs requests Lessel accepts, names the agent, and surfaces refusals", async () => {
  const seen = [];
  const fetchFn = async (url, opts) => {
    assert.ok(verify(opts.body, opts.headers["x-lessel-signature"], SECRET));
    const msg = JSON.parse(opts.body);
    seen.push(msg);
    if (msg.issueKey === "PAY-2") return { ok: false, status: 409, text: async () => JSON.stringify({ message: "Refused: Brook is not working on PAY-2." }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ message: "Recorded: Ledger runbook v6 (declared)." }) };
  };
  const b = new LesselBridge({ url: "https://x.hello.atlassian-dev.net/x1/t", secret: SECRET, agentId: "brook", fetchFn });
  assert.equal(await b.declareContext({ issueKey: "PAY-1", sourceUrl: "u", sourceVersion: 6, readAt: "2026-11-19T00:00:00Z" }),
    "Recorded: Ledger runbook v6 (declared).");
  assert.deepEqual(seen[0], { kind: "declare-context", agentId: "brook", issueKey: "PAY-1", sourceUrl: "u", sourceVersion: 6, readAt: "2026-11-19T00:00:00Z" });
  await assert.rejects(b.declareContext({ issueKey: "PAY-2", sourceUrl: "u" }), /Refused: Brook is not working on PAY-2\./);
});
