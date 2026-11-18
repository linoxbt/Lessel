// Generates tickets.csv: the 90 agent tickets from spec v1.2 §17.3, ready for Jira's CSV import.
// Usage: node tickets/generate.mjs [--runbook-url https://<site>.atlassian.net/wiki/spaces/ENG/pages/<id>/Ledger+runbook]
// Jira assigns its own keys on import; the "Agent" column tells you whom to assign each ticket to.

import { writeFileSync } from "node:fs";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const RUNBOOK = arg("--runbook-url", "https://YOUR-SITE.atlassian.net/wiki/spaces/ENG/pages/RUNBOOK_ID/Ledger+runbook");

const TASKS = {
  "schema-migration": [
    ["Add index on entries(account_id)", "Balance queries scan entries. Add a migration creating an index on entries(account_id). Keep it additive."],
    ["Add created_by column to transactions", "Add a nullable created_by TEXT column to transactions via a new migration. Don't backfill."],
    ["Add check constraint on entries.currency", "Add a CHECK constraint so entries.currency is one of USD, EUR, NGN. New migration only."],
    ["Add idempotency_keys table", "Create an idempotency_keys(key TEXT PRIMARY KEY, transaction_id TEXT, created_at TIMESTAMPTZ) table."],
    ["Add account status column", "Add accounts.status TEXT NOT NULL DEFAULT 'active' with a CHECK (active, frozen, closed)."],
    ["Add composite index for transaction lookups", "Add an index on entries(transaction_id, account_id) in a new migration."],
    ["Add holds table", "Create holds(id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), amount_minor BIGINT, currency CHAR(3), expires_at TIMESTAMPTZ)."],
    ["Add external_ref to transactions", "Add a nullable external_ref TEXT column with a unique partial index where it's not null."],
    ["Add audit_log table", "Create audit_log(id BIGSERIAL PRIMARY KEY, actor TEXT, action TEXT, target TEXT, at TIMESTAMPTZ DEFAULT now())."],
    ["Add currency to accounts index", "Add an index on accounts(owner, currency)."],
  ],
  "dependency-bump": [
    ["Bump pg to the latest 8.x", "Update pg in services/ledger to the latest 8.x release and refresh the lockfile. No code changes."],
    ["Refresh lockfile", "Run npm install in services/ledger to refresh package-lock.json against current semver ranges."],
    ["Pin Node engine to 22.18+", "Set engines.node to >=22.18 in services/ledger/package.json and refresh the lockfile."],
    ["Add npm audit fix for transitive deps", "Apply non-breaking audit fixes in services/ledger (package.json + lockfile only)."],
  ],
  "business-logic": [
    ["Reject transfers between different currencies", "POST /transfers must reject a transfer when the two accounts hold different currencies. Domain logic in src/domain."],
    ["Lower USD fee floor to 25 cents", "Change the USD minimum fee from 30 to 25 minor units in src/domain/fees.ts, with tests."],
    ["Add NGN fee cap of 1,500 NGN", "Cap NGN transfer fees at 150000 minor units. Update src/domain/fees.ts and tests."],
    ["Add memo length limit", "Transfers with a memo longer than 140 characters must be rejected in the domain layer."],
    ["Support EUR fee waiver for internal accounts", "Transfers between accounts whose ids start with 'int_' pay no fee in EUR."],
    ["Add reversal transaction helper", "Add reverse(tx) in src/domain/ledger.ts that produces the exact opposite transaction, with tests."],
    ["Round fees half to even for EUR", "EUR fees round half to even instead of half away from zero. Domain change with tests."],
    ["Add daily transfer limit per account", "Add a pure function that checks a per-account daily limit given today's transfers."],
  ],
  "config-infra": [
    ["Raise ledger rate limit for batch jobs", `Raise the ledger rate limit in services/ledger/config/limits.json for nightly batch jobs. Follow the rate-limit section of the Ledger runbook: ${RUNBOOK}`],
    ["Tune burst size", `Adjust burst in services/ledger/config/limits.json per the Ledger runbook guidance: ${RUNBOOK}`],
    ["Add default currency to app config", "Add defaultCurrency to services/ledger/config/app.json if missing and document it."],
    ["Lower rate limit for staging", `Staging needs a lower rate limit. Change services/ledger/config/limits.json following the Ledger runbook: ${RUNBOOK}`],
  ],
  "test-fix": [
    ["Cover fee rounding edge cases", "Add tests for fee rounding at exact half values in services/ledger/src/domain/*.test.ts."],
    ["Cover schema errors for accounts", "Add tests for invalid account ids and owners in services/ledger/src/routes/schema.test.ts."],
    ["Cover rate limiter refill", "Add a test that the bucket refills over time at max_rps."],
    ["Cover multi-currency balances", "Add a balances() test with USD and EUR transactions mixed."],
  ],
};
const CHECKOUT = [
  ["Cap coupons at 40%", "services/checkout: reject coupons above 40%. Domain change with tests."],
  ["Round tax half to even", "services/checkout: tax rounds half to even. Domain change with tests."],
  ["Reject more than 100 items", "services/checkout: reject carts with more than 100 total items."],
  ["Free shipping threshold", "services/checkout: add a free-shipping flag when subtotal is over 5000 minor units."],
];

// spec v1.2 §17.3
const PLAN = [
  ["ledger", "schema-migration", { Brook: 19, Atlas: 11 }],
  ["ledger", "dependency-bump", { Atlas: 12, Brook: 6 }],
  ["ledger", "business-logic", { Brook: 12, Atlas: 6 }],
  ["ledger", "config-infra", { Atlas: 4, Brook: 4 }],
  ["ledger", "test-fix", { Atlas: 4, Brook: 4 }],
  ["checkout", "business-logic", { Atlas: 4, Brook: 4 }],
];

const rows = [];
for (const [service, cls, split] of PLAN) {
  const pool = service === "checkout" ? CHECKOUT : TASKS[cls];
  let n = 0;
  for (const [agent, count] of Object.entries(split)) {
    for (let i = 0; i < count; i++, n++) {
      const [summary, desc] = pool[n % pool.length];
      const round = Math.floor(n / pool.length);
      rows.push({
        summary: round ? `${summary} (${round + 1})` : summary,
        description: `${desc}${round ? ` Variant ${round + 1}: pick a different column, limit or test case than earlier tickets with this title.` : ""}\n\nService: ${service}. Expected change class: ${cls}.`,
        agent, service, cls,
      });
    }
  }
}

const esc = v => `"${String(v).replace(/"/g, '""')}"`;
const header = ["Summary", "Description", "Issue Type", "Component", "Labels", "Agent"];
const csv = [header.join(","), ...rows.map(r => [r.summary, r.description, "Task", r.service, `lessel-${r.cls}`, r.agent].map(esc).join(","))].join("\n");
writeFileSync(new URL("./tickets.csv", import.meta.url), csv + "\n");
console.log(`Wrote ${rows.length} tickets to tickets/tickets.csv`);
