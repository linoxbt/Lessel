// Money as integer minor units (cents). Never floats.

export type Currency = "USD" | "EUR" | "NGN";
export type Money = { readonly amount: bigint; readonly currency: Currency };

export const CURRENCIES: readonly Currency[] = ["USD", "EUR", "NGN"];

export function money(amount: bigint | number, currency: Currency): Money {
  if (typeof amount === "number" && !Number.isInteger(amount)) throw new RangeError("amount must be in minor units");
  if (!CURRENCIES.includes(currency)) throw new RangeError(`unknown currency ${currency}`);
  return { amount: BigInt(amount), currency };
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new TypeError(`currency mismatch: ${a.currency} vs ${b.currency}`);
}

/** Basis points (1/100 of a percent), rounded half away from zero to the minor unit. */
export function bps(m: Money, basisPoints: number): Money {
  const raw = m.amount * BigInt(basisPoints);
  const q = raw / 10000n;
  const r = raw % 10000n;
  const abs = r < 0n ? -r : r;
  const rounded = abs * 2n >= 10000n ? q + (raw < 0n ? -1n : 1n) : q;
  return { amount: rounded, currency: m.currency };
}

export const format = (m: Money): string => {
  const sign = m.amount < 0n ? "-" : "";
  const abs = m.amount < 0n ? -m.amount : m.amount;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")} ${m.currency}`;
};
