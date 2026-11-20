// A legacy writer does not know about rooms.db. Park its original directories and occupy
// their exact names with regular files before making the database authoritative.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { MAILBOX_CUTOVER } from "./coordination-private-schema.mjs";
import {
  openRooms,
  ROOMS_APPLICATION_ID,
  ROOMS_SCHEMA_VERSION,
  roomsDbPath,
} from "./horde-room.mjs";
import {
  changeRecordInTransaction,
  checkRecord,
  createMailboxTables,
  recordSessionKey,
} from "./mailbox-records.mjs";
import { openOrkestSqlite, withImmediateTransaction } from "./orkest-sqlite.mjs";

const ACTIVE = "mailbox-sqlite-v1";
const PENDING = "mailbox-sqlite-pending-v1";
const BACKUP = "mailbox-legacy-v1";
const FENCE =
  "Orkest mailbox SQLite v1. Upgrade this writer; the original records are in mailbox-legacy-v1.\n";
const FRESH = "Orkest mailbox SQLite v1 fresh-root intent.\n";
const COLLECTIONS = ["peers", "inbox"];

function stat(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function regular(file) {
  // Open non-blocking so a substituted FIFO cannot hang inspection.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`unsafe_mailbox_file: ${file}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fenceAt(file, text = FENCE) {
  const info = stat(file);
  return (
    info?.isFile() && info.size === Buffer.byteLength(text) && regular(file).toString() === text
  );
}

function placeFence(file, text = FENCE) {
  const fd = openSync(
    file,
    constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(path.dirname(file));
}

export function mailboxActive(root) {
  const active = path.join(root, ACTIVE);
  if (stat(active)) {
    if (!fenceAt(active) || COLLECTIONS.some((name) => !fenceAt(path.join(root, name))))
      throw new Error("mailbox_writer_fence_broken");
    return true;
  }
  if (stat(path.join(root, PENDING))) throw new Error("mailbox_migration_pending");
  return false;
}

export function openMailboxSnapshot(root) {
  const db = openOrkestSqlite(roomsDbPath(root), { readOnly: true });
  try {
    db.exec("BEGIN");
    const version = db.tagStore.get`PRAGMA user_version`.user_version;
    if (
      db.tagStore.get`PRAGMA application_id`.application_id !== ROOMS_APPLICATION_ID ||
      version < 4 ||
      version > ROOMS_SCHEMA_VERSION
    )
      throw new Error("unrecognized_mailbox_database");
    if (!db.tagStore.get`SELECT singleton FROM mailbox_cutover WHERE singleton=1`)
      throw new Error("mailbox_cutover_missing");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function checkName(key, session) {
  const canonical = recordSessionKey(session);
  if (
    !canonical ||
    ![canonical, session.replaceAll(":", "_"), session.replaceAll(":", "%3A")].includes(key)
  )
    throw new Error("legacy_record_identity_mismatch");
  return canonical;
}

function scan(directory, visitRecord) {
  const seen = new Set();
  const hash = createHash("sha256");
  function visit(parent, parts) {
    const entries = readdirSync(parent, { withFileTypes: true }).toSorted((a, b) =>
      a.name < b.name ? -1 : Number(a.name > b.name),
    );
    for (const entry of entries) {
      const name = entry.name,
        file = path.join(parent, name),
        keys = [...parts, name];
      if (entry.isDirectory() && parts.length === 1 && parts[0] === "inbox") {
        visit(file, keys);
        continue;
      }
      if (!entry.isFile()) throw new Error(`unexpected_legacy_entry: ${file}`);
      const bytes = regular(file);
      hash.update(JSON.stringify([keys, createHash("sha256").update(bytes).digest("hex")]));
      if (name.endsWith(".lock")) continue;
      if (!name.endsWith(".json")) throw new Error(`unrecognized_legacy_file: ${file}`);
      const body = JSON.parse(bytes);
      const stem = name.slice(0, -5);
      let record;
      if (parts[0] === "peers" && parts.length === 1)
        record = { collection: "peer", owner: "", key: checkName(stem, body.session), body };
      else if (parts[0] === "inbox" && parts.length === 2)
        record = {
          collection: "inbox",
          owner: checkName(parts[1], body.to?.session),
          key: stem,
          body,
        };
      else throw new Error(`unexpected_legacy_path: ${file}`);
      checkRecord(record);
      const id = JSON.stringify([record.collection, record.owner, record.key]);
      if (seen.has(id)) throw new Error("duplicate_legacy_record_identity");
      seen.add(id);
      visitRecord?.(record, Math.trunc(stat(file).mtimeMs));
    }
  }
  for (const name of COLLECTIONS) {
    const file = path.join(directory, name),
      info = stat(file);
    if (!info) continue;
    if (!info.isDirectory()) throw new Error(`unsafe_legacy_directory: ${file}`);
    visit(file, [name]);
  }
  return hash.digest("hex");
}

function initialize(db) {
  createMailboxTables(db);
  db.exec(MAILBOX_CUTOVER);
}

export function ensureMailbox(root, { quiesced = false } = {}) {
  if (!stat(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!stat(root).isDirectory()) throw new Error("unsafe_mailbox_root");
  const pending = path.join(root, PENDING),
    backup = path.join(root, BACKUP);
  if (stat(path.join(root, ACTIVE))) {
    mailboxActive(root);
    openMailboxSnapshot(root).close();
    return { active: true, backup };
  }
  if (!quiesced && !stat(pending)) {
    // A nonempty existing root may belong to a legacy writer even if its inbox is empty.
    if (readdirSync(root).length > 0 && !stat(pending)) return { active: false };
    try {
      placeFence(pending, FRESH);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  using db = openRooms(root);
  withImmediateTransaction(db, () => {
    if (stat(path.join(root, ACTIVE))) {
      mailboxActive(root);
      return;
    }
    if (!stat(pending)) {
      if (stat(backup)) throw new Error("mailbox_backup_already_exists");
      if (!quiesced && COLLECTIONS.some((name) => stat(path.join(root, name))))
        throw new Error("legacy_writer_appeared");
      scan(root);
      placeFence(pending, quiesced ? FENCE : FRESH);
    }
    const fresh = fenceAt(pending, FRESH);
    if (!fresh && !fenceAt(pending)) throw new Error("invalid_migration_intent");
    if (!fresh && !quiesced) throw new Error("mailbox_migration_pending");
    if (!stat(backup)) mkdirSync(backup, { mode: 0o700 });
    if (!stat(backup).isDirectory()) throw new Error("unsafe_mailbox_backup");
    for (const name of COLLECTIONS) {
      const legacy = path.join(root, name);
      if (fenceAt(legacy)) continue;
      const saved = path.join(backup, name);
      const info = stat(legacy);
      if (info) {
        if (fresh || !info.isDirectory() || stat(saved))
          throw new Error(`legacy_writer_conflict: ${legacy}`);
        renameSync(legacy, saved);
        syncDirectory(backup);
      }
      placeFence(legacy);
    }
    initialize(db);
    const ready = db.tagStore.get`SELECT digest FROM mailbox_cutover WHERE singleton=1`;
    if (ready) {
      if (scan(backup) !== ready.digest) throw new Error("legacy_backup_changed");
      return;
    }
    const digest = scan(backup, (record, updatedMs) =>
      changeRecordInTransaction(db, "put", record, updatedMs),
    );
    db.tagStore.run`INSERT INTO mailbox_cutover VALUES(1,${digest})`;
  });
  try {
    placeFence(path.join(root, ACTIVE));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return { active: mailboxActive(root), backup };
}

export function auditMailbox(root) {
  if (!mailboxActive(root)) return { active: false };
  using db = openMailboxSnapshot(root);
  const ready = db.tagStore.get`SELECT digest FROM mailbox_cutover WHERE singleton=1`;
  const backup = path.join(root, BACKUP);
  if (scan(backup) !== ready?.digest) throw new Error("legacy_backup_changed");
  return { active: true, backup };
}
