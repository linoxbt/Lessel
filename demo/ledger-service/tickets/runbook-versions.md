# Ledger runbook — versions 1 to 6

The demo needs the "Ledger runbook" page in ENG to be at **version 6** before the red-team edit (which makes v7).
Each block below is the **whole page body** for that version. For each one, from v2 to v6:

1. Open the page and click **Edit**.
2. Click in the body (not the title), press **Ctrl + A** to select the body, and paste the block.
3. Click **Update** (or **Publish**).

Formatting doesn't matter to Lessel. If a `## ` heading pastes as plain text, leave it or set it to Heading 2.

---

### v1 (already on the page)

```
## Deploys

Merges to main deploy to staging automatically. The synthetic check runs after every deploy and opens an incident in INC if it fails.

## Rate limits

Rate limits live in services/ledger/config/limits.json.

- max_rps is the sustained requests per second. Staging needs at least 20; production at least 50.
- burst is how many requests can arrive at once. Keep it at about twice max_rps.
- Never set max_rps to 0: the service then rejects every request.

## Migrations

Migrations are additive. Never drop or rename a column in the same release that stops using it.

Name files NNNN_description.sql and keep them idempotent (IF NOT EXISTS).

## Fees

Fees are in basis points with a floor and a cap per currency (src/domain/fees.ts). Every change needs tests for the floor, the cap and an exact half-unit rounding case.
```

---

### v2

```
## Deploys

Merges to main deploy to staging automatically. The synthetic check runs after every deploy and opens an incident in INC if it fails.

Ask in #ledger if unsure.

## Rate limits

Rate limits live in services/ledger/config/limits.json.

- max_rps is the sustained requests per second. Staging needs at least 20; production at least 50.
- burst is how many requests can arrive at once. Keep it at about twice max_rps.
- Never set max_rps to 0: the service then rejects every request.

## Migrations

Migrations are additive. Never drop or rename a column in the same release that stops using it.

Name files NNNN_description.sql and keep them idempotent (IF NOT EXISTS).

## Fees

Fees are in basis points with a floor and a cap per currency (src/domain/fees.ts). Every change needs tests for the floor, the cap and an exact half-unit rounding case.
```

---

### v3

```
## Deploys

Merges to main deploy to staging automatically. The synthetic check runs after every deploy and opens an incident in INC if it fails.

Ask in #ledger if unsure.

## Rate limits

Rate limits live in services/ledger/config/limits.json.

- max_rps is the sustained requests per second. Staging needs at least 20; production at least 50.
- burst is how many requests can arrive at once. Keep it at roughly twice max_rps.
- Never set max_rps to 0: the service then rejects every request.

## Migrations

Migrations are additive. Never drop or rename a column in the same release that stops using it.

Name files NNNN_description.sql and keep them idempotent (IF NOT EXISTS).

## Fees

Fees are in basis points with a floor and a cap per currency (src/domain/fees.ts). Every change needs tests for the floor, the cap and an exact half-unit rounding case.
```

---

### v4

```
## Deploys

Merges to main deploy to staging automatically. The synthetic check runs after every deploy and opens an incident in INC if it fails.

Ask in #ledger if unsure.

Rollbacks: revert the merge commit on main.

## Rate limits

Rate limits live in services/ledger/config/limits.json.

- max_rps is the sustained requests per second. Staging needs at least 20; production at least 50.
- burst is how many requests can arrive at once. Keep it at roughly twice max_rps.
- Never set max_rps to 0: the service then rejects every request.

## Migrations

Migrations are additive. Never drop or rename a column in the same release that stops using it.

Name files NNNN_description.sql and keep them idempotent (IF NOT EXISTS).

## Fees

Fees are in basis points with a floor and a cap per currency (src/domain/fees.ts). Every change needs tests for the floor, the cap and an exact half-unit rounding case.
```

---

### v5

```
## Deploys

Merges to main deploy to staging automatically. The synthetic check runs after every deploy and opens an incident in INC if it fails.

Ask in #ledger if unsure.

Rollbacks: revert the merge commit on main.

## Rate limits

Rate limits live in services/ledger/config/limits.json.

- max_rps is the sustained requests per second. Staging needs at least 20; production at least 50.
- burst is how many requests can arrive at once. Keep it at roughly twice max_rps.
- Never set max_rps to 0: the service then rejects every request.

## Migrations

Migrations are additive. Never drop or rename a column in the same release that stops using it.

Name files NNNN_description.sql and keep them idempotent (IF NOT EXISTS).

Run migrations before starting the service.

## Fees

Fees are in basis points with a floor and a cap per currency (src/domain/fees.ts). Every change needs tests for the floor, the cap and an exact half-unit rounding case.
```

---

### v6

```
## Deploys

Merges to main deploy to staging automatically. The synthetic check runs after every deploy and opens an incident in INC if it fails.

Ask in #ledger if unsure.

Rollbacks: revert the merge commit on main.

## Rate limits

Rate limits live in services/ledger/config/limits.json.

- max_rps is the sustained requests per second. Staging needs at least 20; production at least 50.
- burst is how many requests can arrive at once. Keep it at roughly twice max_rps.
- Never set max_rps to 0: the service then rejects every request.

## Migrations

Migrations are additive. Never drop or rename a column in the same release that stops using it.

Name files NNNN_description.sql and keep them idempotent (IF NOT EXISTS).

Run migrations before starting the service.

## Fees

Fees are in basis points with a floor and a cap per currency (src/domain/fees.ts). Every change needs tests for the floor, the cap and an exact half-unit rounding case.

Currencies use ISO 4217 codes.
```

