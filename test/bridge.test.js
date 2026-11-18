"use strict";
// The Lessel ↔ Lessel for Bitbucket link, and the token-based Bitbucket adapter.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { sign, verify } = require("../src/bridge-sign");

const SECRET = "s".repeat(40);

test("both apps ship the same signing code", () => {
  const a = fs.readFileSync(path.join(__dirname, "../src/bridge-sign.js"), "utf8");
  const b = fs.readFileSync(path.join(__dirname, "../bitbucket-app/src/bridge-sign.js"), "utf8");
  assert.equal(a, b);
});

test("signatures: fresh and exact only", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const h = sign('{"a":1}', SECRET, now);
  assert.equal(verify('{"a":1}', h, SECRET, now), true);
  assert.equal(verify('{"a":2}', h, SECRET, now), false, "body changed");
  assert.equal(verify('{"a":1}', h, "t".repeat(40), now), false, "other secret");
  assert.equal(verify('{"a":1}', h, SECRET, now + 301e3), false, "too old");
  assert.equal(verify('{"a":1}', "t=1,v1=zz", SECRET, now), false);
  assert.equal(verify('{"a":1}', h, "short", now), false, "weak secret refused");
  assert.equal(verify('{"a":1}', undefined, SECRET, now), false);
});

function withModule(rel, exportsObj, fn) {
  const p = require.resolve(rel);
  const saved = require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return Promise.resolve(fn()).finally(() => { if (saved) require.cache[p] = saved; else delete require.cache[p]; });
}

test("bridge: unsigned requests get 401; signed ones reach the gate and the event handler", async () => {
  process.env.LESSEL_BRIDGE_SECRET = SECRET;
  const { bitbucketBridge } = require("../src/bridge");
  const req = (obj, sig) => {
    const body = JSON.stringify(obj);
    return { body, headers: { "x-lessel-signature": [sig === undefined ? sign(body, SECRET) : sig] } };
  };
  assert.equal((await bitbucketBridge(req({ kind: "event", event: {} }, "t=1,v1=00"))).statusCode, 401);
  assert.equal((await bitbucketBridge({ body: "{}", headers: {} })).statusCode, 401);

  const seen = [];
  await withModule("../src/enforce/gate", { mergeGate: async e => { seen.push(["gate", e.pullrequest.id]); return { success: false, message: "Brook is L1. 0/2 human approvals." }; } }, async () => {
    await withModule("../src/events/bitbucket", { onBitbucketEvent: async e => { seen.push(["event", e.eventType]); } }, async () => {
      const g = await bitbucketBridge(req({ kind: "merge-check", event: { pullrequest: { id: 7 } } }));
      assert.equal(g.statusCode, 200);
      assert.deepEqual(JSON.parse(g.body), { success: false, message: "Brook is L1. 0/2 human approvals." });
      const ev = await bitbucketBridge(req({ kind: "event", event: { eventType: "avi:bitbucket:push:repository" } }));
      assert.equal(ev.statusCode, 200);
      assert.equal((await bitbucketBridge(req({ kind: "nope" }))).statusCode, 400);
      assert.equal((await bitbucketBridge(req({ kind: "run-job", type: "backfill" }))).statusCode, 400, "only migrate and hourly");
      await withModule("../src/jobs", { enqueue: async b => { seen.push(["job", b.type]); } }, async () => {
        assert.equal((await bitbucketBridge(req({ kind: "run-job", type: "migrate" }))).statusCode, 202);
      });
    });
  });
  assert.deepEqual(seen, [["gate", 7], ["event", "avi:bitbucket:push:repository"], ["job", "migrate"]]);
  delete process.env.LESSEL_BRIDGE_SECRET;
});

test("Lessel for Bitbucket: forwards signed requests, and fails the merge check closed", async () => {
  const app = require("../bitbucket-app/src/index");
  process.env.LESSEL_BRIDGE_URL = "https://abc.hello.atlassian-dev.net/x1/t";
  process.env.LESSEL_BRIDGE_SECRET = SECRET;
  const calls = [];
  app.setTransport(async (url, opts) => {
    calls.push({ url, opts });
    assert.ok(verify(opts.body, opts.headers["x-lessel-signature"], SECRET));
    const msg = JSON.parse(opts.body);
    const body = msg.kind === "merge-check" ? { success: true, message: "Brook is L3. It may self-merge." } : { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  assert.deepEqual(await app.mergeCheck({ pullrequest: { id: 1 } }), { success: true, message: "Brook is L3. It may self-merge." });
  await app.onEvent({ eventType: "avi:bitbucket:created:pullrequest" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, process.env.LESSEL_BRIDGE_URL);

  app.setTransport(async () => ({ ok: false, status: 500, text: async () => '{"error":"x"}' }));
  const closed = await app.mergeCheck({ pullrequest: { id: 1 } });
  assert.equal(closed.success, false);
  assert.match(closed.message, /^Lessel couldn't be reached \(Lessel answered 500/);
  await assert.rejects(app.onEvent({}), /Lessel answered 500/, "events throw so Forge can retry");

  delete process.env.LESSEL_BRIDGE_URL;
  assert.equal((await app.mergeCheck({})).success, false, "unconfigured fails closed");
  delete process.env.LESSEL_BRIDGE_SECRET;
});

test("Bitbucket adapter: token auth, encoded UUIDs, no pagination off-site", async () => {
  const bb = require("../src/adapters/bitbucket");
  const calls = [];
  bb.setTransport(async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    if (url.includes("/diffstat") && !url.includes("page=2")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ values: [{ new: { path: "a.js" }, lines_added: 3 }],
        next: "https://api.bitbucket.org/2.0/repositories/%7Bw%7D/%7Br%7D/pullrequests/5/diffstat?page=2" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ values: [{ old: { path: "b.js" }, lines_removed: 2 }] }) };
  });
  await assert.rejects(bb.getPr("w", "r", 5), /BITBUCKET_EMAIL and BITBUCKET_API_TOKEN/);
  process.env.BITBUCKET_EMAIL = "bot@example.com";
  process.env.BITBUCKET_API_TOKEN = "tok";
  const ds = await bb.prDiffstat("w", "{r}", 5);
  assert.deepEqual(ds, { paths: ["a.js", "b.js"], lines: 5 });
  assert.equal(calls[0].url, "https://api.bitbucket.org/2.0/repositories/%7Bw%7D/%7Br%7D/pullrequests/5/diffstat");
  assert.equal(calls[0].auth, `Basic ${Buffer.from("bot@example.com:tok").toString("base64")}`);

  bb.setTransport(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ values: [], next: "https://evil.example.com/x" }) }));
  await assert.rejects(bb.listPrs("w", "r"), /Refusing to follow a pagination link/);
  delete process.env.BITBUCKET_EMAIL; delete process.env.BITBUCKET_API_TOKEN;
});
