import { chmodSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

import { ROOMS_APPLICATION_ID, ROOMS_SCHEMA_VERSION } from "./horde-room.mjs";
import { openOrkestSqlite, withImmediateTransaction } from "./orkest-sqlite.mjs";

/** The caller holds the schema migration's write lock. A second connection sees the last commit. */
export function backupLegacyRooms(db) {
  const source = db.location();
  using previous = openOrkestSqlite(source, { readOnly: true });
  const { user_version: version } = previous.tagStore.get`PRAGMA user_version`;
  if (version < 1 || version > 2) return;
  const dest = mkdtempSync(path.join(path.dirname(source), "rooms-before-outbox-"));
  copyDatabase(previous, path.join(dest, "rooms.db"));
}

function copyDatabase(source, file) {
  using statement = source.prepare("VACUUM INTO ?");
  statement.run(file);
  chmodSync(file, 0o600);
}

export function auditRooms(root) {
  const file = path.join(root, "rooms.db");
  if (!existsSync(file)) return { version: 0, rooms: 0, events: 0 };
  using db = openOrkestSqlite(file, { readOnly: true });
  const version = db.tagStore.get`PRAGMA user_version`.user_version;
  const appId = db.tagStore.get`PRAGMA application_id`.application_id;
  if (appId !== 1_330_793_298) throw new Error("Unrecognized rooms database");
  const rooms = db.tagStore.get`SELECT COUNT(*) AS n FROM rooms`.n;
  const events = version >= 3 ? db.tagStore.get`SELECT COUNT(*) AS n FROM outbox_events`.n : 0;
  return { version, rooms, events };
}

/** Export a new, runnable v2 room data root and an independent full-fidelity snapshot at the same cursor. */
export function exportRoomsV2(root, dest, exportDomains = () => ({})) {
  const file = path.join(root, "rooms.db");
  if (!existsSync(file)) throw new Error("No rooms database");
  mkdirSync(dest, { mode: 0o700 });
  using db = openOrkestSqlite(file);
  return withImmediateTransaction(db, () => {
    const version = db.tagStore.get`PRAGMA user_version`.user_version;
    if (
      version < 3 ||
      version > ROOMS_SCHEMA_VERSION ||
      db.tagStore.get`PRAGMA application_id`.application_id !== ROOMS_APPLICATION_ID
    )
      throw new Error("No outbox database");
    using reader = openOrkestSqlite(file, { readOnly: true });
    copyDatabase(reader, path.join(dest, "post-cutover.sqlite"));
    using target = openOrkestSqlite(path.join(dest, "rooms.db"));
    withImmediateTransaction(target, () => {
      const schema = db.tagStore
        .all`SELECT sql FROM sqlite_schema WHERE tbl_name IN ('rooms','legacy_room_imports') AND sql IS NOT NULL AND name NOT IN ('outbox_guard_insert','outbox_guard_update','outbox_guard_delete') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`;
      for (const row of schema) target.exec(row.sql);
      const rooms = db.tagStore.iterate`SELECT id,cwd,updated_at,revision,data FROM rooms`;
      for (const row of rooms)
        target.tagStore
          .run`INSERT INTO rooms(id,cwd,updated_at,revision,data) VALUES(${row.id},${row.cwd},${row.updated_at},${row.revision},${row.data})`;
      const imports = db.tagStore.iterate`SELECT file,digest FROM legacy_room_imports`;
      for (const row of imports)
        target.tagStore.run`INSERT INTO legacy_room_imports VALUES(${row.file},${row.digest})`;
      target.exec("PRAGMA application_id=1330793298; PRAGMA user_version=2");
    });
    return {
      ...exportDomains(db, dest),
      rooms: target.tagStore.get`SELECT COUNT(*) AS n FROM rooms`.n,
      cursor: db.tagStore.get`SELECT COALESCE(MAX(cursor),0) AS n FROM outbox_events`.n,
    };
  });
}
