"use strict";
// The links between Lessel, Lessel for Bitbucket, Lessel's Confluence installation and the demo runner:
// pairing, per-channel keys, replay protection, the Bitbucket proxy, and the Bitbucket adapter.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { sign, verify } = require("../src/bridge-sign");
const { connectDb, resetSchema, teardown } = require("./helpers/world");

const SECRET = "s".repeat(40);
const LESSEL_URL = "https://aaa.hello.atlassian-dev.net/x1/bridge";
const PROXY_URL = "https://bbb.hello.atlassian-dev.net/x1/proxy";
const WS = "6f3b2a1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c";

let pool;
test.before(async () => { pool = await connectDb(); });
test.after(async () => { teardown(); await pool?.end(); });

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
  assert.equal(verify('{"a":1}', h, undefined, now), false, "no secret, no entry");
});

function withModule(rel, exportsObj, fn) {
  const p = require.resolve(rel);
  const saved = require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return Promise.resolve(fn()).finally(() => { if (saved) require.cache[p] = saved; else delete require.cache[p]; });
}

/** A fake Forge storage for the Bitbucket app (one workspace installation). */
function fakeKvs() {
  const m = new Map();
  return { async getSecret(k) { return m.get(k) ?? undefined; }, async setSecret(k, v) { m.set(k, structuredClone(v)); },
    async deleteSecret(k) { m.delete(k); }, _m: m };
}

/** Wire the two apps together in-process: HTTP calls go straight to the other side's web trigger handler. */
function wire() {
  const { bitbucketBridge } = require("../src/bridge");
  const app = require("../bitbucket-app/src/index");
  const appLink = require("../bitbucket-app/src/link");
  const link = require("../src/services/link");
  const bb = require("../src/adapters/bitbucket");
  const kvs = fakeKvs();
  const toLessel = async (url, opts) => {
    assert.equal(url, LESSEL_URL);
    const out = await bitbucketBridge({ body: opts.body, headers: { "x-lessel-signature": [opts.headers["x-lessel-signature"]] } });
    return { ok: out.statusCode < 300, status: out.statusCode, text: async () => out.body };
  };
  const toProxy = async (url, opts) => {
    assert.equal(url, PROXY_URL);
    const out = await app.bitbucketProxy({ body: opts.body, headers: { "x-lessel-signature": [opts.headers["x-lessel-signature"]] } },
      { installContext: `ari:cloud:bitbucket::workspace/${WS}` });
    return { ok: out.statusCode === 200, status: out.statusCode, text: async () => out.body };
  };
  link.setLinkPorts({ webTriggerUrl: async () => LESSEL_URL, transport: toLessel });
  appLink.setLinkPorts({ storage: () => kvs, transport: toLessel, proxyUrl: async () => PROXY_URL });
  app.setTransport(toLessel);
  bb.setTransport(toProxy);
  bb.setLinkLookup(() => link.bitbucketLink());
  return { bitbucketBridge, app, appLink, link, bb, kvs };
}

test("pairing: a code from Lessel links exactly one workspace; each kind of message needs its own key; replays are refused", async (t) => {
  if (!pool) return t.skip("no test database");
  await resetSchema(pool);
  const { bitbucketBridge, app, appLink, link, kvs } = wire();
  const call = (obj, secret) => { const body = JSON.stringify(obj); return bitbucketBridge({ body, headers: { "x-lessel-signature": [sign(body, secret)] } }); };

  // Unpaired: the workspace sends nothing, and its merge check passes without a decision.
  assert.deepEqual(await app.mergeCheck({ pullrequest: { id: 1 } }),
    { success: true, message: "Lessel isn't paired with a Jira site for this workspace; no decision applied." });
  assert.equal((await call({ kind: "event", event: {} }, SECRET)).statusCode, 401, "no link, no entry");

  const { code } = await link.createPairingCode("bitbucket", "admin-1");
  assert.match(code, /^lessel1\./);
  assert.deepEqual((await link.status()).bitbucket, { linked: false, pending: true });
  await assert.rejects(appLink.pair("lessel1.garbage", {}), /isn't a Bitbucket pairing code/);
  await appLink.pair(code, { installContext: `ari:cloud:bitbucket::workspace/{${WS}}` });
  const st = (await link.status()).bitbucket;
  assert.equal(st.linked, true);
  assert.equal(st.workspace, WS);
  assert.equal((await link.bitbucketLink()).url, PROXY_URL);
  const secret = link.decodeCode(code).s;
  assert.equal(kvs._m.get("lessel-link").secret, secret, "the workspace keeps the secret in its own storage");

  // Events: acknowledged at once and handed to the queue (B13), compacted.
  const queued = [];
  await withModule("../src/jobs", { enqueue: async (b, key) => { queued.push([b.type, key, b.event?.pullrequest?.id]); } }, async () => {
    await app.onEvent({ eventType: "avi:bitbucket:created:pullrequest", repository: { uuid: "{R-1}" }, pullrequest: { id: 7, title: "big", description: "x".repeat(5000) } });
    // The Bitbucket link can't run operator actions, nor speak for the runner.
    assert.equal((await call({ kind: "setup", settings: { windowHours: 1 } }, secret)).statusCode, 401);
    assert.equal((await call({ kind: "run-job", type: "migrate" }, secret)).statusCode, 401);
    assert.equal((await call({ kind: "declare-context", agentId: "brook" }, secret)).statusCode, 401);
    assert.equal((await call({ kind: "confluence-event", event: {} }, secret)).statusCode, 401);
  });
  assert.deepEqual(queued, [["bitbucket-event", "bb-pr-R1-7", 7]]);

  // A replayed request (same body and signature) is refused.
  const body = JSON.stringify({ kind: "pair", proxyUrl: PROXY_URL, workspace: WS });
  const req = { body, headers: { "x-lessel-signature": [sign(body, secret)] } };
  assert.equal((await bitbucketBridge(req)).statusCode, 200);
  assert.equal((await bitbucketBridge(req)).statusCode, 409);
  assert.equal((await call({ kind: "pair", proxyUrl: "https://evil.example.com/x" }, secret)).statusCode, 400, "partner addresses must be Forge web triggers");

  // Merge checks reach the gate; a failure fails closed with a plain message.
  await withModule("../src/enforce/gate", { mergeGate: async e => ({ success: false, message: `Brook is L1 on #${e.pullrequest.id}.` }) }, async () => {
    assert.deepEqual(await app.mergeCheck({ pullrequest: { id: 7 } }), { success: false, message: "Brook is L1 on #7." });
    assert.deepEqual(await app.mergeCheck({ pullrequest: { id: 7 } }), { success: false, message: "Brook is L1 on #7." }, "merge checks may repeat");
  });
  app.setTransport(async () => ({ ok: false, status: 500, text: async () => '{"error":"internal detail"}' }));
  assert.deepEqual(await app.mergeCheck({ pullrequest: { id: 1 } }), { success: false, message: "Lessel couldn't be reached. Try again in a minute." });
  await assert.rejects(app.onEvent({}), /Lessel answered 500/, "events throw so Forge can retry");

  // A new code replaces the link: the old secret stops working.
  await link.createPairingCode("bitbucket", "admin-1");
  assert.equal((await call({ kind: "event", event: {} }, secret)).statusCode, 401);
  await link.unlink("bitbucket", "admin-1");
  assert.deepEqual((await link.status()).bitbucket, { linked: false });
});

test("Bitbucket proxy: Lessel's calls go through the paired workspace only, and only what Lessel needs", async (t) => {
  if (!pool) return t.skip("no test database");
  await resetSchema(pool);
  const { app, appLink, link, bb } = wire();
  const asApp = [];
  app.setBitbucketRequest(async (p, opts) => {
    asApp.push(`${opts.method} ${p}`);
    return { status: 200, text: async () => JSON.stringify(p.endsWith("/comments") ? { id: 1 } : p.includes("merge-base") ? { hash: "abc1234def56" } : { id: 9, title: "PAY-1" }) };
  });
  await assert.rejects(bb.getPr("w", "r", 9), /isn't linked to this site yet/);
  await appLink.pair((await link.createPairingCode("bitbucket", "admin-1")).code, { installContext: `ari:cloud:bitbucket::workspace/${WS}` });

  assert.deepEqual(await bb.getPr("w", "r", 9), { id: 9, title: "PAY-1" });
  assert.deepEqual(await bb.postPrComment("w", "r", 9, "**Lessel:** hi"), { id: 1 });
  // B1: merge-base takes "<hash>..<hash>", the only ".." the proxy allows.
  assert.equal(await bb.isAncestor("w", "r", "abc1234def56", "fedcba9876543210fedcba9876543210fedcba98"), true);
  await assert.rejects(bb.isAncestor("w", "r", "main", "x..y"), /needs commit hashes/);
  assert.deepEqual(asApp, ["GET /2.0/repositories/%7Bw%7D/%7Br%7D/pullrequests/9", "POST /2.0/repositories/%7Bw%7D/%7Br%7D/pullrequests/9/comments",
    "GET /2.0/repositories/%7Bw%7D/%7Br%7D/merge-base/abc1234def56..fedcba9876543210fedcba9876543210fedcba98"]);

  const secret = (await appLink.getLink()).secret;
  const signed = obj => { const body = JSON.stringify(obj); return { body, headers: { "x-lessel-signature": [sign(body, secret)] } }; };
  const proxy = obj => app.bitbucketProxy(signed(obj), {});
  assert.equal((await proxy({ method: "POST", path: "/2.0/repositories/w/r/pullrequests/9/merge" })).statusCode, 403);
  assert.equal((await proxy({ method: "GET", path: "/2.0/user" })).statusCode, 403);
  assert.equal((await proxy({ method: "GET", path: "/2.0/repositories/w/r/commits/../../user" })).statusCode, 403, "traversal");
  assert.equal((await proxy({ method: "GET", path: "/2.0/repositories/w/r/commits/%2e%2e%2fuser" })).statusCode, 403, "encoded traversal");
  assert.equal((await proxy({ method: "GET", path: "/2.0/repositories/w/r/merge-base/main..HEAD" })).statusCode, 403, "merge-base takes hashes only");
  assert.equal((await proxy({ method: "GET", path: "/2.0/repositories/w/r/pipelines/?sort=-created_on&pagelen=50" })).statusCode, 200);
  assert.equal((await app.bitbucketProxy({ body: "{}", headers: {} }, {})).statusCode, 401);

  // Operator pairing (the demo site's own workspace) needs the operator key.
  process.env.LESSEL_OPERATOR_SECRET = "o".repeat(40);
  try {
    const code = (await link.createPairingCode("bitbucket", "admin-1")).code;
    const body = JSON.stringify({ kind: "operator-pair", code });
    assert.equal((await app.bitbucketProxy({ body, headers: { "x-lessel-signature": [sign(body, secret)] } }, {})).statusCode, 401);
    const ok = await app.bitbucketProxy({ body, headers: { "x-lessel-signature": [sign(body, process.env.LESSEL_OPERATOR_SECRET)] } },
      { installContext: `ari:cloud:bitbucket::workspace/${WS}` });
    assert.equal(ok.statusCode, 200);
    assert.equal((await link.status()).bitbucket.linked, true);
  } finally { delete process.env.LESSEL_OPERATOR_SECRET; }
});

test("Confluence installation: pairs with a code, then forwards its events to the Jira installation", async (t) => {
  if (!pool) return t.skip("no test database");
  await resetSchema(pool);
  const { link } = wire();
  const client = require("../src/bridge-client");
  const { onConfluenceEvent } = require("../src/index");
  const ev = { eventType: "avi:confluence:updated:page", content: { id: "1" } };
  const ctx = { installContext: "ari:cloud:confluence::site/abc" };

  const sent = [];
  client.setTransport(async () => { sent.push(1); return { ok: true, status: 202, text: async () => "{}" }; });
  assert.equal(await onConfluenceEvent(ev, ctx), null, "unpaired: dropped, nothing sent");
  assert.equal(sent.length, 0);

  const { code } = await link.createPairingCode("confluence", "admin-1");
  await assert.rejects(link.pairConfluence((await link.createPairingCode("runner", "admin-1")).code, "admin-c"), /for another link/);
  await link.pairConfluence(code, "admin-c");
  assert.equal((await link.status()).confluence.linked, true);
  assert.equal((await link.confluenceStatus()).linked, true);

  const { bitbucketBridge } = require("../src/bridge");
  const queued = [];
  client.setTransport(async (url, opts) => {
    assert.equal(url, LESSEL_URL);
    const out = await bitbucketBridge({ body: opts.body, headers: { "x-lessel-signature": [opts.headers["x-lessel-signature"]] } });
    return { ok: out.statusCode < 300, status: out.statusCode, text: async () => out.body };
  });
  await withModule("../src/jobs", { enqueue: async b => { queued.push(b); } }, () => onConfluenceEvent(ev, ctx));
  assert.deepEqual(queued, [{ type: "confluence-event", event: ev }]);
  assert.equal(client.inConfluenceInstall({ installContext: "ari:cloud:jira::site/abc" }), false);
});

test("Bitbucket adapter: encoded UUIDs, no pagination off-site", async () => {
  const bb = require("../src/adapters/bitbucket");
  bb.setLinkLookup(async () => ({ url: PROXY_URL, secret: SECRET }));
  const calls = [];
  bb.setTransport(async (url, opts) => {
    const { path: p } = JSON.parse(opts.body);
    calls.push(p);
    const inner = p.includes("/diffstat") && !p.includes("page=2")
      ? { values: [{ new: { path: "a.js" }, lines_added: 3 }], next: "https://api.bitbucket.org/2.0/repositories/%7Bw%7D/%7Br%7D/pullrequests/5/diffstat?page=2" }
      : { values: [{ old: { path: "b.js" }, lines_removed: 2 }] };
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 200, body: JSON.stringify(inner) }) };
  });
  assert.deepEqual(await bb.prDiffstat("w", "{r}", 5), { paths: ["a.js", "b.js"], lines: 5 });
  assert.equal(calls[0], "/2.0/repositories/%7Bw%7D/%7Br%7D/pullrequests/5/diffstat");
  bb.setTransport(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 200, body: JSON.stringify({ values: [], next: "https://evil.example.com/x" }) }) }));
  await assert.rejects(bb.listPrs("w", "r"), /Refusing to follow a pagination link/);
});
