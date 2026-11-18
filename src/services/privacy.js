"use strict";
// Forge personal data reporting. Lessel stores Atlassian accountIds only as "who decided this" (signal
// confirmations, staff actions, taint confirmations) and as agent logins. It stores no names, emails or
// avatars. Each week it reports the ids it holds; for a closed account it replaces the id with
// "closed-account" everywhere and removes it as an agent login. Nothing else needs updating, because Lessel
// keeps no profile data that could go stale.

const repo = require("../db/repo");
const { ports } = require("../ports");

async function reportPersonalData() {
  const accounts = await repo.storedAccounts();
  if (!accounts.length) return { reported: 0, closed: 0 };
  const updates = await ports.privacy.reportPersonalData(accounts);   // the SDK batches 90 per request
  const closed = (updates ?? []).filter(u => u.status === "closed").map(u => u.accountId);
  for (const id of closed) await repo.eraseAccount(id);
  // Log the count only: logging the ids would store them again.
  if (closed.length) await repo.logStaffAction({ actor: "lessel:privacy", action: "erase-accounts", target: "accounts",
    note: `${closed.length} closed account${closed.length === 1 ? "" : "s"} erased` });
  return { reported: accounts.length, closed: closed.length };
}

module.exports = { reportPersonalData };
