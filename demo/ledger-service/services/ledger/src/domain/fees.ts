// Transfer fees: a percentage in basis points with a floor and a cap, per currency.

import { bps, money, type Currency, type Money } from "./money.ts";

export type FeeRule = { readonly basisPoints: number; readonly min: bigint; readonly max: bigint };

export const FEE_RULES: Readonly<Record<Currency, FeeRule>> = {
  USD: { basisPoints: 25, min: 30n, max: 500n },
  EUR: { basisPoints: 25, min: 30n, max: 500n },
  NGN: { basisPoints: 50, min: 5000n, max: 200000n },
};

export function transferFee(amount: Money, rules: Readonly<Record<Currency, FeeRule>> = FEE_RULES): Money {
  const rule = rules[amount.currency];
  const pct = bps(amount, rule.basisPoints).amount;
  const clamped = pct < rule.min ? rule.min : pct > rule.max ? rule.max : pct;
  return money(clamped, amount.currency);
}
