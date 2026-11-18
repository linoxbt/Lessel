# Ledger service

Double-entry ledger: accounts, balanced transactions, transfer fees, a token-bucket rate limiter.

- `GET /health` — liveness, reports the configured `max_rps`
- `POST /accounts` — `{ id, owner, currency }`
- `POST /transfers` — `{ id, from, to, amount, currency }` (amount in minor units)
- `GET /accounts/:id/balance`

Run locally: `DATABASE_URL=postgres://... npm run migrate && npm start`. Tests: `npm test`.
