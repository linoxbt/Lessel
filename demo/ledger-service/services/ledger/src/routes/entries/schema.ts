import { CURRENCIES, type Currency } from "../../domain/money.ts";
import { SchemaError } from "../accounts/schema.ts";

export type TransferRequest = { id: string; from: string; to: string; amount: bigint; currency: Currency; memo?: string };

export function parseTransfer(body: unknown): TransferRequest {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object") throw new SchemaError("body must be an object");
  for (const k of ["id", "from", "to"]) if (typeof b[k] !== "string" || !(b[k] as string)) throw new SchemaError(`${k} is required`);
  if (typeof b.amount !== "number" || !Number.isSafeInteger(b.amount) || b.amount <= 0) throw new SchemaError("amount must be a positive integer in minor units");
  if (typeof b.currency !== "string" || !CURRENCIES.includes(b.currency as Currency)) throw new SchemaError("unknown currency");
  if (b.memo !== undefined && typeof b.memo !== "string") throw new SchemaError("memo must be a string");
  return { id: b.id as string, from: b.from as string, to: b.to as string, amount: BigInt(b.amount), currency: b.currency as Currency, memo: b.memo as string | undefined };
}
