/** Bridge the domain commit and the independent, leased delivery queue across crashes. */
import {
  BRIDGE_LIMITS,
  chiefEventId,
  chiefNotificationProfile,
  loadChiefBridgeConfig,
  spawnChiefDelivery,
} from "./chief-bridge.mjs";
import { DELIVERY_LIMITS } from "./chief-delivery.mjs";
import { openRooms } from "./horde-room.mjs";

export function recordChiefIntents(db, events, env) {
  if (events.length === 0) return;
  const cfg = loadChiefBridgeConfig(env);
  if (!cfg) return;
  const profile = chiefNotificationProfile(cfg, env);
  for (const event of events) {
    if (!cfg.events.has(event.event)) continue;
    const id = chiefEventId(event);
    const now = Date.now();
    db.tagStore
      .run`DELETE FROM chief_notification_intents WHERE created_ms < ${now - DELIVERY_LIMITS.pendingTtlMs}`;
    db.tagStore.run`INSERT INTO chief_notification_intents(id,profile,event,created_ms)
      VALUES(${id},${profile},${JSON.stringify(event)},${now}) ON CONFLICT(id) DO NOTHING`;
  }
}

// Only called by explicit reconciliation or after a domain write, never by read-only status.
export async function reconcileChiefIntents(root, env) {
  try {
    const cfg = loadChiefBridgeConfig(env);
    if (!cfg) return;
    const profile = chiefNotificationProfile(cfg, env);
    using db = openRooms(root);
    if (!db.tagStore.get`SELECT 1 FROM sqlite_schema WHERE name='chief_notification_intents'`) {
      // A previous release may already have admitted work to the separate delivery queue.
      await spawnChiefDelivery([], { env, expectedProfile: profile, resumePending: true });
      return;
    }
    const cutoff = Date.now() - DELIVERY_LIMITS.pendingTtlMs;
    db.tagStore.run`DELETE FROM chief_notification_intents WHERE created_ms < ${cutoff}`;
    const rows = db.tagStore
      .all`SELECT event FROM chief_notification_intents WHERE profile=${profile} ORDER BY created_ms,rowid LIMIT ${BRIDGE_LIMITS.pending}`;

    await spawnChiefDelivery(
      rows.map(({ event }) => JSON.parse(event)),
      {
        env,
        expectedProfile: profile,
        resumePending: true,
        onAdmitted(ids) {
          for (const id of ids)
            db.tagStore
              .run`DELETE FROM chief_notification_intents WHERE id=${id} AND profile=${profile}`;
        },
      },
    );
  } catch {
    // A committed intent remains available to the next reconciliation.
  }
}
