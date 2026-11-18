CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  memo        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entries (
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  line_no        INT  NOT NULL,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  amount_minor   BIGINT NOT NULL,
  currency       CHAR(3) NOT NULL,
  PRIMARY KEY (transaction_id, line_no)
);
