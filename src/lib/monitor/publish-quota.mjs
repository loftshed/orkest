import { createHash } from "node:crypto";

import { mailboxRoot, openRooms } from "../horde-room.mjs";
import { withImmediateTransaction } from "../orkest-sqlite.mjs";
import { validPayload } from "../outbox-policy.mjs";
import { appendInTransaction } from "../outbox.mjs";

export function quotaObservation(entry, scope) {
  if (!Array.isArray(entry?.windows)) return null;
  const body = {
    provider: entry.provider,
    observedAt: entry.fetchedAt,
    stale: entry.ok === false,
    limits: entry.windows.map(({ id, remainingPct, windowMins, resetsAt }) => ({
      id,
      remainingPct,
      windowMins: windowMins ?? null,
      resetsAt: resetsAt ?? null,
    })),
  };
  const observation = { scope, kind: "monitor.quota", entity: entry.id, body };
  if (!validPayload(observation)) return null;
  const id = createHash("sha256").update(JSON.stringify(observation)).digest("hex");
  return { ...observation, id };
}

export function publishQuota(accounts, scope, root = mailboxRoot()) {
  const samples = accounts.map((entry) => quotaObservation(entry, scope)).filter(Boolean);
  if (samples.length === 0) return;
  using db = openRooms(root);
  withImmediateTransaction(db, () => {
    for (const sample of samples) appendInTransaction(db, sample);
  });
}
