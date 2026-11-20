import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Chief desk and acknowledgement transactions: canonical private rows in the shared rooms SQLite
 * database, committed in the same immediate transaction as their redacted outbox events.
 *
 * Private tables (strict, never exported): chief_desk_items, chief_desk_acked, chief_ack_txs,
 * chief_imports. Exported wire shapes (room-bound items only; no text, sender, session or path):
 *   chief.item  entity = opaque 32-hex item key, body = { state: "queued", kind }
 *   chief.ack   entity = the same key,           body = { state: "acked" }
 * Legacy `chief/desk.jsonl`, `chief/desk/*.json` and `chief/ack-transactions/*.json` are imported
 * once, retained untouched, and never read again after promotion.
 */
import { CHIEF_TABLES } from "./coordination-private-schema.mjs";
import { emitRedacted } from "./foundry-outbox.mjs";
import { openRooms, roomsDbPath } from "./horde-room.mjs";
import { openOrkestSqlite, withImmediateTransaction } from "./orkest-sqlite.mjs";

const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const KINDS = new Set(["done", "escalation", "update", "question"]);
const JOURNAL_VERSION = 1;
const LEGACY_PREFIX = "legacy:";
const ACK_SCHEMA = "ork.chief.ack.v1";
const IMPORT_SOURCE = "legacy-desk";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function validRoomId(value) {
  return typeof value === "string" && ROOM_ID.test(value) ? value : null;
}

function itemKey(id) {
  return createHash("sha256").update(`ork.chief.item\0${id}`).digest("hex").slice(0, 32);
}

function readJson(file, maxBytes = 256 * 1024) {
  try {
    if (statSync(file).size > maxBytes) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Legacy file readers (pre-promotion projection and one-time import)

const journalPath = (root) => path.join(root, "chief", "desk.jsonl");
const legacyDeskDir = (root) => path.join(root, "chief", "desk");
const ackDir = (root) => path.join(root, "chief", "ack-transactions");

function readLegacyJournal(root) {
  const puts = new Map();
  const acked = new Set();
  const links = new Map();
  let text;
  try {
    text = readFileSync(journalPath(root), "utf8");
  } catch {
    return { puts, acked, links, text: "" };
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(record) || record.v !== JOURNAL_VERSION) continue;
    if (
      record.op === "put" &&
      typeof record.id === "string" &&
      isPlainObject(record.item) &&
      !puts.has(record.id)
    ) {
      puts.set(record.id, { ...record.item, id: record.id });
    } else if (record.op === "ack" && Array.isArray(record.ids)) {
      for (const id of record.ids) if (typeof id === "string") acked.add(id);
    } else if (record.op === "link" && isStringId(record.id) && isStringId(record.messageId)) {
      links.set(record.id, record.messageId);
    }
  }
  return { puts, acked, links, text };
}

function readLegacyDeskFiles(root) {
  let entries;
  try {
    entries = readdirSync(legacyDeskDir(root));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => {
      const file = path.join(legacyDeskDir(root), entry);
      const json = readJson(file);
      if (!isPlainObject(json) || typeof json.text !== "string") return null;
      return {
        ...json,
        id: `${LEGACY_PREFIX}${entry.slice(0, -".json".length)}`,
        file,
        roomId: null,
      };
    })
    .filter(Boolean);
}

function readLegacyAckTxs(root) {
  let entries;
  try {
    entries = readdirSync(ackDir(root));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^[0-9a-f]{32}\.json$/u.test(entry))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => readJson(path.join(ackDir(root), entry)))
    .filter(
      (record) =>
        isPlainObject(record) &&
        record.schema === ACK_SCHEMA &&
        /^[0-9a-f]{32}$/u.test(String(record.id)) &&
        ["committed", "complete"].includes(record.state),
    );
}

function hasLegacyArtifacts(root) {
  return (
    existsSync(journalPath(root)) || existsSync(legacyDeskDir(root)) || existsSync(ackDir(root))
  );
}

function withoutFile(item) {
  const copy = { ...item };
  delete copy.file;
  return copy;
}

function sortItems(items) {
  return items.sort(
    (left, right) =>
      String(left.at).localeCompare(String(right.at)) || left.id.localeCompare(right.id),
  );
}

function legacyProjection(root) {
  const { puts, acked: journalAcked, links } = readLegacyJournal(root);
  const acked = new Set(journalAcked);
  const txs = readLegacyAckTxs(root).filter((record) => record.state === "committed");
  for (const record of txs) for (const id of arrayOf(record.deskIds)) acked.add(id);
  const items = [];
  for (const record of puts.values()) {
    if (acked.has(record.id)) continue;
    items.push({
      ...record,
      roomId: validRoomId(record.roomId),
      mailboxId: links.get(record.id) ?? null,
    });
  }
  for (const legacy of readLegacyDeskFiles(root)) if (!acked.has(legacy.id)) items.push(legacy);
  return {
    items: sortItems(items),
    inboxIds: txs.flatMap((record) => arrayOf(record.inboxIds)),
    pending: txs,
  };
}

function arrayOf(value) {
  return Array.isArray(value) ? value.filter(isStringId) : [];
}

// ---------------------------------------------------------------------------
// Canonical store

/** True once the legacy desk has been promoted into the database. Never creates anything. */
function isPromoted(root) {
  if (!existsSync(roomsDbPath(root))) return false;
  const db = openOrkestSqlite(roomsDbPath(root), { readOnly: true });
  try {
    const table = db.tagStore
      .get`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='chief_imports'`;
    if (!table) return false;
    return Boolean(
      db.tagStore.get`SELECT 1 AS present FROM chief_imports WHERE source=${IMPORT_SOURCE}`,
    );
  } finally {
    db.close();
  }
}

function withReadOnly(root, fn) {
  const db = openOrkestSqlite(roomsDbPath(root), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function rowItem(row) {
  return {
    ...JSON.parse(row.data),
    id: row.id,
    roomId: validRoomId(row.room_id),
    mailboxId: row.message_id ?? null,
  };
}

function emitItem(db, id, roomId, kind) {
  if (!roomId) return;
  emitRedacted(db, {
    scope: `room:${roomId}`,
    kind: "chief.item",
    entity: itemKey(id),
    body: { state: "queued", kind: KINDS.has(kind) ? kind : "other" },
    id: `ci:${itemKey(id)}`,
  });
}

function insertItem(db, record) {
  const roomId = validRoomId(record.roomId);
  const json = JSON.stringify(record);
  const isInserted =
    db.tagStore.run`INSERT OR IGNORE INTO chief_desk_items(id, room_id, at, data)
      VALUES(${record.id}, ${roomId}, ${String(record.at ?? "")}, ${json})`.changes === 1;
  return { inserted: isInserted, roomId };
}

/** One-time, in-transaction import of the legacy desk. Retains every old file. */
function promote(db, root) {
  if (db.tagStore.get`SELECT 1 AS present FROM chief_imports WHERE source=${IMPORT_SOURCE}`) return;
  const { puts, acked, links, text } = readLegacyJournal(root);
  const txs = readLegacyAckTxs(root);
  const hidden = new Set(acked);
  for (const record of txs)
    if (record.state === "committed") for (const id of arrayOf(record.deskIds)) hidden.add(id);
  for (const id of acked)
    db.tagStore
      .run`INSERT OR IGNORE INTO chief_desk_acked(id, tx, at) VALUES(${id}, 'import:journal', '')`;
  for (const record of txs) {
    const deskIds = arrayOf(record.deskIds);
    const inboxIds = arrayOf(record.inboxIds);
    db.tagStore.run`INSERT OR IGNORE INTO chief_ack_txs(id, state, session, desk_ids, inbox_ids, at)
      VALUES(${record.id}, ${record.state}, ${typeof record.session === "string" ? record.session : null},
        ${JSON.stringify(deskIds)}, ${JSON.stringify(inboxIds)}, ${String(record.at ?? "")})`;
    if (record.state === "committed")
      for (const id of deskIds)
        db.tagStore
          .run`INSERT OR IGNORE INTO chief_desk_acked(id, tx, at) VALUES(${id}, ${record.id}, ${String(record.at ?? "")})`;
  }
  const records = [...puts.values(), ...readLegacyDeskFiles(root).map(withoutFile)];
  for (const record of records) {
    const { inserted, roomId } = insertItem(db, record);
    const messageId = links.get(record.id);
    if (messageId)
      db.tagStore
        .run`UPDATE chief_desk_items SET message_id=${messageId} WHERE id=${record.id} AND message_id IS NULL`;
    if (inserted && !hidden.has(record.id)) emitItem(db, record.id, roomId, record.kind);
  }
  const digest = createHash("sha256").update(text).update(String(records.length)).digest("hex");
  db.tagStore.run`INSERT INTO chief_imports(source, digest) VALUES(${IMPORT_SOURCE}, ${digest})`;
}

function write(root, fn) {
  using db = openRooms(root);
  return withImmediateTransaction(db, () => {
    db.exec(CHIEF_TABLES);
    promote(db, root);
    return fn(db);
  });
}

/** Active desk items, ordered. Read-only: not-yet-promoted legacy files are projected, not imported. */
export function readDesk(root) {
  if (!isPromoted(root)) return legacyProjection(root).items;
  return withReadOnly(root, (db) =>
    sortItems(
      db
        .prepare(
          `SELECT i.id, i.room_id, i.data, i.message_id FROM chief_desk_items i
           WHERE NOT EXISTS (SELECT 1 FROM chief_desk_acked a WHERE a.id = i.id)`,
        )
        .iterate()
        .map(rowItem)
        .toArray(),
    ),
  );
}

export function hasDeskItem(root, id) {
  if (!isPromoted(root))
    return (
      legacyProjection(root).items.some((item) => item.id === id) ||
      readLegacyJournal(root).puts.has(id)
    );
  return withReadOnly(root, (db) =>
    Boolean(db.tagStore.get`SELECT 1 AS present FROM chief_desk_items WHERE id=${id}`),
  );
}

/** Idempotent by ID: a retry of the same report adds nothing and emits nothing twice. */
export function putDeskItem(root, record) {
  return write(root, (db) => {
    const { inserted, roomId } = insertItem(db, record);
    if (inserted) emitItem(db, record.id, roomId, record.kind);
    return inserted;
  });
}

/** Records the mailbox message for an item once; later links never replace it. */
export function linkDeskItem(root, id, messageId) {
  return write(root, (db) => {
    const result = db.tagStore
      .run`UPDATE chief_desk_items SET message_id=${messageId} WHERE id=${id} AND message_id IS NULL`;
    return result.changes === 1;
  });
}

/**
 * Commits an acknowledgement: marks every desk ID acknowledged and records the transaction
 * (which still owns the mailbox half) together with the room-bound `chief.ack` events.
 */
export function commitAckTx(root, record) {
  return write(root, (db) => {
    db.tagStore.run`INSERT INTO chief_ack_txs(id, state, session, desk_ids, inbox_ids, at)
      VALUES(${record.id}, 'committed', ${record.session ?? null}, ${JSON.stringify(record.deskIds)},
        ${JSON.stringify(record.inboxIds)}, ${record.at})`;
    for (const id of record.deskIds) {
      const result = db.tagStore
        .run`INSERT OR IGNORE INTO chief_desk_acked(id, tx, at) VALUES(${id}, ${record.id}, ${record.at})`;
      if (result.changes !== 1) continue;
      const item = db.tagStore.get`SELECT room_id FROM chief_desk_items WHERE id=${id}`;
      const roomId = validRoomId(item?.room_id);
      if (roomId)
        emitRedacted(db, {
          scope: `room:${roomId}`,
          kind: "chief.ack",
          entity: itemKey(id),
          body: { state: "acked" },
          id: `ca:${itemKey(id)}`,
        });
    }
  });
}

function rowTx(row) {
  return {
    schema: ACK_SCHEMA,
    id: row.id,
    state: row.state,
    session: row.session,
    deskIds: JSON.parse(row.desk_ids),
    inboxIds: JSON.parse(row.inbox_ids),
    at: row.at,
  };
}

function committedTxs(root) {
  if (!isPromoted(root)) return legacyProjection(root).pending;
  return withReadOnly(root, (db) =>
    [
      ...db.prepare("SELECT * FROM chief_ack_txs WHERE state='committed' ORDER BY id").iterate(),
    ].map(rowTx),
  );
}

/** Mail IDs hidden from readers as soon as their acknowledgement committed. */
export function committedInboxIds(root) {
  return committedTxs(root).flatMap((record) => arrayOf(record.inboxIds));
}

/** Committed transactions whose backing mailbox write has not finished. */
export function pendingAckTxs(root) {
  if (!isPromoted(root) && !hasLegacyArtifacts(root)) return [];
  if (!isPromoted(root)) write(root, () => {});
  return committedTxs(root);
}

export function completeAckTx(root, id) {
  write(root, (db) => {
    db.tagStore.run`UPDATE chief_ack_txs SET state='complete' WHERE id=${id}`;
  });
}

/** Export promoted private desk and ack projections into the caller's reserved rollback root. */
export function exportLegacyChiefDeskRows(db, destinationRoot) {
  const present = db.tagStore
    .get`SELECT 1 AS n FROM sqlite_schema WHERE name='chief_imports' AND type='table'`;
  if (!present || !db.tagStore.get`SELECT 1 AS n FROM chief_imports WHERE source=${IMPORT_SOURCE}`)
    return { promoted: false, items: 0, acknowledgements: 0 };
  mkdirSync(path.join(destinationRoot, "chief"), { mode: 0o700 });
  mkdirSync(ackDir(destinationRoot), { mode: 0o700 });
  const file = openSync(journalPath(destinationRoot), "wx", 0o600);
  let items = 0;
  let acknowledgements = 0;
  const append = (record) =>
    writeFileSync(file, JSON.stringify({ v: JOURNAL_VERSION, ...record }) + "\n");
  try {
    for (const row of db.prepare("SELECT * FROM chief_desk_items ORDER BY at,id").iterate()) {
      append({ op: "put", id: row.id, item: JSON.parse(row.data) });
      if (row.message_id) append({ op: "link", id: row.id, messageId: row.message_id });
      items++;
    }
    for (const row of db.prepare("SELECT id FROM chief_desk_acked ORDER BY id").iterate())
      append({ op: "ack", ids: [row.id] });
    for (const row of db.prepare("SELECT * FROM chief_ack_txs ORDER BY id").iterate()) {
      if (!/^[0-9a-f]{32}$/u.test(row.id))
        throw new Error("Invalid legacy Chief acknowledgement ID");
      writeFileSync(
        path.join(ackDir(destinationRoot), row.id + ".json"),
        JSON.stringify(rowTx(row)) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      acknowledgements++;
    }
  } finally {
    closeSync(file);
  }
  return { promoted: true, items, acknowledgements };
}
