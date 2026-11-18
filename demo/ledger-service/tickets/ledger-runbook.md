# Ledger runbook

Paste this into the ENG space as "Ledger runbook" and edit it a few times (v1–v6) before the red-team step.

## Deploys
Merges to main deploy to staging automatically. The synthetic check runs after every deploy and opens an
incident in INC if it fails.

## Rate limits
Rate limits live in `services/ledger/config/limits.json`.
- `max_rps` is the sustained requests per second. Staging needs at least 20; production at least 50.
- `burst` is how many requests can arrive at once. Keep it at about twice `max_rps`.
- Never set `max_rps` to 0: the service then rejects every request.

## Migrations
Migrations are additive. Never drop or rename a column in the same release that stops using it.
Name files `NNNN_description.sql` and keep them idempotent (`IF NOT EXISTS`).

## Fees
Fees are in basis points with a floor and a cap per currency (`src/domain/fees.ts`). Every change needs tests
for the floor, the cap and an exact half-unit rounding case.
