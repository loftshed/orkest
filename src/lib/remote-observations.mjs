import { existsSync } from "node:fs";
import path from "node:path";

import { openOrkestSqlite } from "./orkest-sqlite.mjs";
import { PRESENCE_TTL_MS, QUOTA_TTL_MS } from "./outbox-policy.mjs";

/** Show remote observations separately from the local rooms eligible for commands. */
export function remoteObservations(root, now = Date.now()) {
  const file = path.join(root, "rooms.db");
  if (!existsSync(file)) return [];
  using db = openOrkestSqlite(file, { readOnly: true, timeout: 50 });
  if (
    !db.tagStore.get`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='outbox_views'` ||
    !db.tagStore.get`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='outbox_receipts'`
  )
    return [];
  const rows = db.tagStore.all`SELECT v.origin, v.epoch,
    COUNT(CASE WHEN v.kind='room.summary' AND json_extract(v.body,'$.removed')=0 THEN 1 END) AS rooms,
    COUNT(CASE WHEN v.kind='monitor.quota' THEN 1 END) AS accounts,
    COUNT(CASE WHEN v.kind='monitor.quota' AND (json_extract(v.body,'$.stale')=1 OR r.received_ms IS NULL OR ${now}<r.received_ms OR ${now}>=min(json_extract(v.body,'$.observedAt'),r.received_ms)+${QUOTA_TTL_MS}) THEN 1 END) AS staleAccounts,
    COUNT(CASE WHEN v.kind='peer.presence' AND json_extract(v.body,'$.present')=1 AND ${now}>=r.received_ms AND ${now}<min(json_extract(v.body,'$.observedAt'),r.received_ms)+${PRESENCE_TTL_MS} THEN 1 END) AS presentPeers,
    MAX(CASE WHEN v.kind IN ('monitor.quota','peer.presence') THEN json_extract(v.body,'$.observedAt') END) AS observedAt,
    COUNT(CASE WHEN v.kind='chief.item' AND NOT EXISTS (SELECT 1 FROM outbox_views ack WHERE ack.origin=v.origin AND ack.epoch=v.epoch AND ack.scope=v.scope AND ack.entity=v.entity AND ack.kind='chief.ack' AND ack.seq>v.seq) THEN 1 END) AS chiefItems
    FROM outbox_views v JOIN outbox_identity self ON v.origin<>self.origin LEFT JOIN outbox_receipts r ON r.origin=v.origin AND r.epoch=v.epoch AND r.scope=v.scope AND r.kind=v.kind AND r.entity=v.entity
    GROUP BY v.origin,v.epoch ORDER BY v.origin,v.epoch LIMIT 32`;
  return rows.map((row) => ({ ...row }));
}
