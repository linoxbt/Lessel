// Small HTTP API over Postgres. No framework: node:http + pg.

import http from "node:http";
import pg from "pg";
import { money } from "./domain/money.ts";
import { transfer, validate, LedgerError } from "./domain/ledger.ts";
import { transferFee } from "./domain/fees.ts";
import { parseNewAccount, SchemaError } from "./routes/accounts/schema.ts";
import { parseTransfer } from "./routes/entries/schema.ts";
import { Bucket, loadLimits } from "./ratelimit.ts";

const limits = loadLimits();
const bucket = new Bucket(limits);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const FEES_ACCOUNT = "fees";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? Number(v) : v)));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function postTransfer(body: unknown) {
  const t = parseTransfer(body);
  const amount = money(t.amount, t.currency);
  const fee = transferFee(amount);
  const tx = transfer(t.id, t.from, t.to, amount, t.memo);
  const lines = [...tx.lines,
    { accountId: t.from, amount: { ...fee, amount: -fee.amount } },
    { accountId: FEES_ACCOUNT, amount: fee }];
  validate({ ...tx, lines });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO transactions (id, memo) VALUES ($1, $2)", [t.id, t.memo ?? null]);
    for (const [i, l] of lines.entries()) {
      await client.query("INSERT INTO entries (transaction_id, line_no, account_id, amount_minor, currency) VALUES ($1, $2, $3, $4, $5)",
        [t.id, i, l.accountId, l.amount.amount.toString(), l.amount.currency]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { id: t.id, fee: Number(fee.amount) };
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, max_rps: limits.max_rps,
      commit: process.env.GIT_COMMIT ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.RENDER_GIT_COMMIT ?? null });
    if (!bucket.take()) return send(res, 429, { error: "rate limited" });
    if (req.method === "POST" && url.pathname === "/accounts") {
      const a = parseNewAccount(await readJson(req));
      await pool.query("INSERT INTO accounts (id, owner, currency) VALUES ($1, $2, $3)", [a.id, a.owner, a.currency]);
      return send(res, 201, a);
    }
    if (req.method === "POST" && url.pathname === "/transfers") return send(res, 201, await postTransfer(await readJson(req)));
    const m = url.pathname.match(/^\/accounts\/([^/]+)\/balance$/);
    if (req.method === "GET" && m) {
      const r = await pool.query("SELECT currency, COALESCE(SUM(amount_minor), 0)::bigint AS balance FROM entries WHERE account_id = $1 GROUP BY currency", [m[1]]);
      return send(res, 200, { account: m[1], balances: r.rows.map(x => ({ currency: x.currency, amount: Number(x.balance) })) });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof SchemaError || e instanceof LedgerError || e instanceof SyntaxError) return send(res, 400, { error: e.message });
    console.error(e);
    return send(res, 500, { error: "internal error" });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.log(`ledger listening on ${port} (max_rps ${limits.max_rps})`));
}
