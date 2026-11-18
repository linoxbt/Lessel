// Double-entry postings. Every transaction's lines sum to zero per currency.

import { add, money, type Currency, type Money } from "./money.ts";

export type Line = { readonly accountId: string; readonly amount: Money };
export type Transaction = { readonly id: string; readonly lines: readonly Line[]; readonly memo?: string };

export class LedgerError extends Error {}

export function validate(tx: Transaction): void {
  if (!tx.id) throw new LedgerError("transaction needs an id");
  if (tx.lines.length < 2) throw new LedgerError("a transaction needs at least two lines");
  const totals = new Map<Currency, Money>();
  for (const line of tx.lines) {
    if (!line.accountId) throw new LedgerError("every line needs an account");
    if (line.amount.amount === 0n) throw new LedgerError("zero-amount lines are not allowed");
    const prev = totals.get(line.amount.currency) ?? money(0, line.amount.currency);
    totals.set(line.amount.currency, add(prev, line.amount));
  }
  for (const [currency, total] of totals) {
    if (total.amount !== 0n) throw new LedgerError(`transaction ${tx.id} does not balance in ${currency}`);
  }
}

/** Balances per account and currency after applying transactions in order. */
export function balances(txs: readonly Transaction[]): Map<string, Money> {
  const out = new Map<string, Money>();
  for (const tx of txs) {
    validate(tx);
    for (const line of tx.lines) {
      const key = `${line.accountId}:${line.amount.currency}`;
      const prev = out.get(key) ?? money(0, line.amount.currency);
      out.set(key, add(prev, line.amount));
    }
  }
  return out;
}

/** A simple transfer between two accounts. */
export function transfer(id: string, from: string, to: string, amount: Money, memo?: string): Transaction {
  if (amount.amount <= 0n) throw new LedgerError("transfer amount must be positive");
  if (from === to) throw new LedgerError("cannot transfer to the same account");
  return { id, memo, lines: [
    { accountId: from, amount: { ...amount, amount: -amount.amount } },
    { accountId: to, amount },
  ] };
}
