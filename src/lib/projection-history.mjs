// Local recovery data lives outside every exportable outbox stream.
import {
  CHIEF_NOTIFICATION_INTENTS,
  CHIEF_TABLES,
  ensureFoundryTables,
  MAILBOX_CUTOVER,
  MAILBOX_RECORDS,
} from "./coordination-private-schema.mjs";

const BASE_PROJECTION_TABLES = [
  "rooms",
  "legacy_room_imports",
  "outbox_identity",
  "outbox_events",
  "outbox_views",
  "outbox_cursors",
  "outbox_snapshots",
  "outbox_staging",
  "outbox_staged_rows",
  "outbox_room_hints",
  "outbox_receipts",
  "outbox_room_commands",
  "mailbox_records",
  "mailbox_cutover",
  "chief_desk_items",
  "chief_desk_acked",
  "chief_ack_txs",
  "chief_imports",
  "foundry_states",
  "foundry_ops",
];

export const PROJECTION_TABLES = [...BASE_PROJECTION_TABLES, "chief_notification_intents"];

export function projectionLayout(db, table) {
  if (!PROJECTION_TABLES.includes(table)) throw new Error("Unknown recovery table");
  const fields = db.prepare(`PRAGMA table_info(${table})`).all();
  const keys = fields
    .filter((f) => f.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((f) => f.name);
  if (keys.length === 0 || fields.some((f) => !/^[a-z_][a-z0-9_]*$/u.test(f.name)))
    throw new Error(`Invalid recovery layout: ${table}`);
  return { columns: fields.map((f) => f.name), keys };
}

function tuple(prefix, columns) {
  return `json_array(${columns.map((c) => prefix + "." + c).join(",")})`;
}

// Hash a changed row only; a sequence and chained digest protect the transactionally committed tail.
function installCapture(db, table, layout, operation) {
  const oldKey = operation === "INSERT" ? "NULL" : tuple("OLD", layout.keys);
  const prior = operation === "INSERT" ? "NULL" : `orkest_digest(${tuple("OLD", layout.columns)})`;
  const value = operation === "DELETE" ? "NULL" : tuple("NEW", layout.columns);
  db.exec(`CREATE TRIGGER recovery_${table}_${operation} AFTER ${operation} ON ${table} BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM local_projection_head h WHERE h.singleton=1 AND (
        (h.seq=0 AND h.digest=(SELECT digest FROM local_projection_anchor WHERE singleton=1)) OR
        h.digest=(SELECT digest FROM local_projection_changes WHERE seq=h.seq))
    ) THEN RAISE(ABORT,'invalid_projection_history_head') END;
    INSERT INTO local_projection_changes(seq,tab,old_key,old_hash,new_row,digest)
    SELECT seq+1,'${table}',old_key,old_hash,new_row,
      orkest_digest(json_array(digest,seq+1,'${table}',hex(old_key),old_hash,hex(new_row)))
    FROM local_projection_head, (SELECT ${oldKey} AS old_key, ${prior} AS old_hash, ${value} AS new_row);
    SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'projection_history_append_failed') END;
    UPDATE local_projection_head SET seq=seq+1,digest=(SELECT digest FROM local_projection_changes WHERE seq=local_projection_head.seq+1);
  END`);
}

export function installProjectionHistory(db) {
  ensureFoundryTables(db);
  db.exec(CHIEF_TABLES + MAILBOX_RECORDS + MAILBOX_CUTOVER);
  db.exec(`CREATE TABLE local_projection_head(singleton INTEGER PRIMARY KEY CHECK(singleton=1),seq INTEGER NOT NULL,digest TEXT NOT NULL) STRICT;
    INSERT INTO local_projection_head VALUES(1,0,lower(hex(randomblob(32))));
    CREATE TABLE local_projection_anchor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),digest TEXT NOT NULL) STRICT;
    INSERT INTO local_projection_anchor SELECT singleton,digest FROM local_projection_head;
    CREATE TABLE local_projection_changes(seq INTEGER PRIMARY KEY, tab TEXT NOT NULL, old_key TEXT, old_hash TEXT, new_row TEXT, digest TEXT NOT NULL) STRICT`);
  for (const table of BASE_PROJECTION_TABLES) {
    const layout = projectionLayout(db, table);
    for (const op of ["INSERT", "UPDATE", "DELETE"]) installCapture(db, table, layout, op);
  }
}

// Earlier builds could have pending intents without their capture triggers. Existing
// rows become part of the first schema-12 checkpoint, and new mutations enter its tail.
export function installNotificationHistory(db) {
  db.exec(CHIEF_NOTIFICATION_INTENTS);
  const table = "chief_notification_intents";
  const layout = projectionLayout(db, table);
  if (layout.columns.join(",") !== "id,profile,event,created_ms" || layout.keys.join(",") !== "id")
    throw new Error("Unsupported notification intent layout");
  for (const op of ["INSERT", "UPDATE", "DELETE"]) installCapture(db, table, layout, op);
}
