"use strict";
// Event dedupe (spec §8.3): the key is written AFTER an idempotent handler succeeds.

const repo = require("../db/repo");

async function once(eventKey, handler) {
  if (!eventKey) return handler();
  if (await repo.seen(eventKey)) return { skipped: true };
  const out = await handler();          // a throw leaves the key unwritten so a retry can run it
  await repo.markSeen(eventKey);
  return out;
}

const normUuid = u => String(u ?? "").replace(/[{}]/g, "").toLowerCase();

module.exports = { once, normUuid };
