// Applies migrations/NNNN_*.sql in order, once each.

import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const dir = new URL("../migrations/", import.meta.url);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
for (const name of readdirSync(dir).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort()) {
  if (done.has(name)) continue;
  await client.query("BEGIN");
  await client.query(readFileSync(new URL(name, dir), "utf8"));
  await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
  await client.query("COMMIT");
  console.log(`applied ${name}`);
}
await client.query("INSERT INTO accounts (id, owner, currency) VALUES ('fees', 'ledger', 'USD') ON CONFLICT DO NOTHING");
await client.end();
