import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
} from "node:fs";
import path from "node:path";

import { openRooms, ROOMS_APPLICATION_ID } from "./horde-room.mjs";
import { backupSqlite, openOrkestSqlite, withImmediateTransaction } from "./orkest-sqlite.mjs";
import { PROJECTION_TABLES, projectionLayout } from "./projection-history.mjs";

async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function reserve(root, destination) {
  const original = realpathSync(root);
  const requested = path.resolve(destination);
  const dest = path.join(realpathSync(path.dirname(requested)), path.basename(requested));
  if (dest === original || dest.startsWith(original + path.sep))
    throw new Error("Destination inside source");
  mkdirSync(dest, { mode: 0o700 });
  const stage = path.join(dest, "incomplete");
  mkdirSync(stage, { mode: 0o700 });
  return { stage, ready: path.join(dest, "ready"), file: path.join(stage, "rooms.db") };
}

function publish(out) {
  const sync = (file) => {
    const handle = openSync(file, "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  };
  sync(out.file);
  sync(out.stage);
  renameSync(out.stage, out.ready);
  const container = path.dirname(out.ready);
  sync(container);
  sync(path.dirname(container));
}

const SUPPORTED_SCHEMA = 12;
const tables = new Set([
  ...PROJECTION_TABLES,
  "local_projection_head",
  "local_projection_changes",
  "local_projection_anchor",
  "sqlite_sequence",
]);
function rejectUnknownTables(db) {
  const rows = db.tagStore.all`SELECT name FROM sqlite_schema WHERE type='table'`;
  for (const row of rows) {
    if (!tables.has(row.name) && !row.name.startsWith("sqlite_"))
      throw new Error("Unsupported recovery table: " + row.name);
  }
}

function identity(db, min = SUPPORTED_SCHEMA) {
  const version = db.tagStore.get`PRAGMA user_version`.user_version;
  if (min === SUPPORTED_SCHEMA && version === 11)
    throw new Error(
      "Schema 12 requires a fresh private checkpoint after the notification intent layout change",
    );
  if (
    db.tagStore.get`PRAGMA application_id`.application_id !== ROOMS_APPLICATION_ID ||
    version < min ||
    version > SUPPORTED_SCHEMA
  )
    throw new Error("Unsupported recovery database");
}

function head(db) {
  const row = db.tagStore.get`SELECT seq,digest FROM local_projection_head WHERE singleton=1`;
  if (!row || !Number.isSafeInteger(row.seq) || row.seq < 0 || !/^[a-f0-9]{64}$/u.test(row.digest))
    throw new Error("Invalid recovery head");
  return row;
}

function inspect(db) {
  identity(db);
  rejectUnknownTables(db);
  if (
    db.tagStore.get`PRAGMA integrity_check`.integrity_check !== "ok" ||
    db.tagStore.get`PRAGMA foreign_key_check`
  )
    throw new Error("Recovery database failed integrity check");
  for (const table of PROJECTION_TABLES) {
    projectionLayout(db, table);
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const name = `recovery_${table}_${op}`;
      if (
        !db.tagStore
          .get`SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=${table} AND name=${name}`
      )
        throw new Error("Missing recovery capture: " + name);
    }
  }
  const journal = head(db);
  const stats = db.tagStore
    .get`SELECT count(*) AS n,coalesce(max(seq),0) AS last FROM local_projection_changes`;
  if (stats.n !== journal.seq || stats.last !== journal.seq)
    throw new Error("Incomplete recovery log");
  return {
    historySequence: journal.seq,
    historyDigest: journal.digest,
    outboxCursor: db.tagStore.get`SELECT coalesce(max(cursor),0) AS n FROM outbox_events`.n,
  };
}

export async function createProjectionCheckpoint(root, destination) {
  const file = path.join(root, "rooms.db");
  {
    using input = openOrkestSqlite(file, { readOnly: true });
    identity(input, 1);
  }
  const out = reserve(root, destination);
  {
    using db = openRooms(root);
    await backupSqlite(db, out.file);
  }
  let report;
  {
    using checkpoint = openOrkestSqlite(out.file, { readOnly: true });
    report = inspect(checkpoint);
  }
  const sha256 = await fileDigest(out.file);
  publish(out);
  return { database: path.join(out.ready, "rooms.db"), sha256, ...report };
}

function writers(db, table) {
  const { columns, keys } = projectionLayout(db, table);
  const bind = (n) => `json_extract(?, '$[${n}]')`;
  const where = keys.map((k, i) => k + " IS " + bind(i)).join(" AND ");
  return {
    columns,
    keys,
    original: db.prepare(
      `SELECT orkest_digest(json_array(${columns.join(",")})) AS hash FROM ${table} WHERE ${where}`,
    ),
    insert: db.prepare(
      `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map((_, i) => bind(i)).join(",")})`,
    ),
    update: db.prepare(
      `UPDATE ${table} SET ${columns.map((c, i) => c + "=" + bind(i)).join(",")} WHERE ${where}`,
    ),
    remove: db.prepare(`DELETE FROM ${table} WHERE ${where}`),
  };
}

function applyRow(w, row) {
  const { old_key: key, old_hash: oldHash, new_row: data } = row;
  const keyArgs = w.keys.map(() => key);
  if (key !== null && w.original.get(...keyArgs)?.hash !== oldHash)
    throw new Error("Recovery row precondition failed at " + row.seq);
  if (data !== null && JSON.parse(data).length !== w.columns.length)
    throw new Error("Invalid recovery row width");
  const dataArgs = w.columns.map(() => data);
  let result;
  if (key === null) result = w.insert.run(...dataArgs);
  else if (data === null) result = w.remove.run(...keyArgs);
  else result = w.update.run(...dataArgs, ...keyArgs);
  if (result.changes !== 1) throw new Error("Recovery row count mismatch");
}

function replay(source, dest) {
  const base = head(dest),
    end = head(source);
  if (base.seq > end.seq) throw new Error("Checkpoint is ahead of source");
  const prefix =
    base.seq === 0
      ? source.tagStore.get`SELECT digest FROM local_projection_anchor WHERE singleton=1`
      : source.tagStore.get`SELECT digest FROM local_projection_changes WHERE seq=${base.seq}`;
  if (prefix?.digest !== base.digest) throw new Error("Checkpoint belongs to another history");
  if (
    source.tagStore.get`SELECT coalesce(max(seq),0) AS n FROM local_projection_changes`.n !==
    end.seq
  )
    throw new Error("Incomplete source recovery head");
  // These are schema statements from the independently pinned checkpoint only.
  const triggers = dest.tagStore
    .all`SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY rowid`;
  for (const { name } of triggers) dest.exec('DROP TRIGGER "' + name.replaceAll('"', '""') + '"');
  const layouts = new Map(PROJECTION_TABLES.map((t) => [t, writers(dest, t)]));
  let seq = base.seq,
    digest = base.digest;
  const changes = source.tagStore
    .iterate`SELECT * FROM local_projection_changes WHERE seq>${base.seq} ORDER BY seq`;
  for (const row of changes) {
    if (row.seq !== ++seq || !layouts.has(row.tab))
      throw new Error("Invalid recovery sequence or domain");
    const verified = dest.tagStore
      .get`SELECT orkest_digest(json_array(${digest},CAST(${seq} AS INTEGER),${row.tab},hex(${row.old_key}),${row.old_hash},hex(${row.new_row}))) AS digest`;
    if (verified.digest !== row.digest) throw new Error("Invalid recovery digest at " + seq);
    applyRow(layouts.get(row.tab), row);
    dest.tagStore
      .run`INSERT INTO local_projection_changes VALUES(${seq},${row.tab},${row.old_key},${row.old_hash},${row.new_row},${row.digest})`;
    digest = row.digest;
  }
  if (seq !== end.seq || digest !== end.digest) throw new Error("Incomplete recovery tail");
  dest.tagStore.run`UPDATE local_projection_head SET seq=${seq},digest=${digest} WHERE singleton=1`;
  for (const { sql } of triggers) dest.exec(sql);
  return inspect(dest);
}

export async function rebuildProjections(root, checkpoint, expected, destination) {
  if (!/^[a-f0-9]{64}$/u.test(expected) || !lstatSync(checkpoint).isFile())
    throw new Error("A trusted checkpoint file and SHA-256 are required");
  const out = reserve(root, destination);
  copyFileSync(checkpoint, out.file, constants.COPYFILE_EXCL);
  if ((await fileDigest(out.file)) !== expected) throw new Error("Checkpoint SHA-256 mismatch");
  let report;
  {
    using source = openOrkestSqlite(path.join(root, "rooms.db"), { readOnly: true });
    source.exec("BEGIN");
    identity(source);
    rejectUnknownTables(source);
    using dest = openOrkestSqlite(out.file);
    inspect(dest);
    // Replay captures cascades and trigger effects explicitly, in source order.
    dest.exec("PRAGMA foreign_keys=OFF");
    report = withImmediateTransaction(dest, () => replay(source, dest));
    dest.exec("PRAGMA foreign_keys=ON");
    source.exec("COMMIT");
    dest.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  publish(out);
  return { database: path.join(out.ready, "rooms.db"), ...report };
}
