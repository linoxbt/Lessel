// Checkout totals. Critical service: Lessel never allows agent self-merge here.

export type Item = { readonly sku: string; readonly unitMinor: number; readonly qty: number };
export type Totals = { readonly subtotal: number; readonly discount: number; readonly tax: number; readonly total: number };

export function totals(items: readonly Item[], { taxBps = 750, couponPct = 0 } = {}): Totals {
  for (const i of items) {
    if (!Number.isSafeInteger(i.unitMinor) || i.unitMinor < 0) throw new RangeError(`bad price for ${i.sku}`);
    if (!Number.isSafeInteger(i.qty) || i.qty <= 0) throw new RangeError(`bad quantity for ${i.sku}`);
  }
  if (couponPct < 0 || couponPct > 50) throw new RangeError("coupon must be 0-50%");
  const subtotal = items.reduce((s, i) => s + i.unitMinor * i.qty, 0);
  const discount = Math.round((subtotal * couponPct) / 100);
  const tax = Math.round(((subtotal - discount) * taxBps) / 10000);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}
