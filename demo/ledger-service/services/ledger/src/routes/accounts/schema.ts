import { CURRENCIES, type Currency } from "../../domain/money.ts";

export type NewAccount = { id: string; owner: string; currency: Currency };

const ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export function parseNewAccount(body: unknown): NewAccount {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object") throw new SchemaError("body must be an object");
  if (typeof b.id !== "string" || !ID.test(b.id)) throw new SchemaError("id must be 3-64 lowercase letters, digits, - or _");
  if (typeof b.owner !== "string" || !b.owner.trim()) throw new SchemaError("owner is required");
  if (typeof b.currency !== "string" || !CURRENCIES.includes(b.currency as Currency)) throw new SchemaError(`currency must be one of ${CURRENCIES.join(", ")}`);
  return { id: b.id, owner: b.owner.trim(), currency: b.currency as Currency };
}

export class SchemaError extends Error {}
