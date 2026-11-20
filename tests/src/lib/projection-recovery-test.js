import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import {
  commitAckTx,
  linkDeskItem,
  pendingAckTxs,
  putDeskItem,
  readDesk,
} from "../../../src/lib/chief-outbox.mjs";
import {
  readFoundryState,
  resolveFoundryStatePath,
  writeFoundryState,
} from "../../../src/lib/foundry.mjs";
import { deleteRoom, openRooms, readRawRoom, updateRawRoom } from "../../../src/lib/horde-room.mjs";
import { ensureMailbox } from "../../../src/lib/mailbox-migration.mjs";
import { changeRecord, getRecord } from "../../../src/lib/mailbox-records.mjs";
import { backupSqlite, openOrkestSqlite } from "../../../src/lib/orkest-sqlite.mjs";
import { PROJECTION_TABLES } from "../../../src/lib/projection-history.mjs";
import {
  createProjectionCheckpoint,
  rebuildProjections,
} from "../../../src/lib/projection-recovery.mjs";

function snapshot(db) {
  return Object.fromEntries(
    PROJECTION_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]),
  );
}

it("recovers private mailbox and Chief identities, room revisions and native hints from checkpoint plus committed tail", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recovery-"));
  const source = path.join(dir, "mailbox-v1");
  ensureMailbox(source);
  const room = (id) => ({
    id,
    title: "Private room " + id,
    agents: [{ session: { id: "native-worker" } }],
  });
  await updateRawRoom("old", () => room("old"), { root: source, create: true });
  const checkpoint = await createProjectionCheckpoint(source, path.join(dir, "checkpoint"));
  await updateRawRoom("active", () => room("active"), { root: source, create: true });
  await updateRawRoom("active", (r) => ({ ...r, title: "Renamed private room" }), { root: source });
  expect(deleteRoom("old", source)).toBe(true);
  const now = "2026-11-19T20:00:00Z";
  const item = {
    schema: "ork.chief.desk.v1",
    id: "private-ticket",
    roomId: "active",
    from: "private-sender",
    kind: "update",
    text: "private text",
    at: now,
  };
  putDeskItem(source, item);
  putDeskItem(source, { ...item, id: "private-open", text: "still open" });
  const msg = {
    schema: "agent-executor.mail.v1",
    id: "abc-123abc",
    sentAt: now,
    readAt: null,
    to: { session: "native-worker" },
    from: { session: "private-sender" },
    text: "private message",
  };
  const address = { collection: "inbox", owner: "native-worker", key: msg.id };
  {
    using db = openRooms(source);
    changeRecord(db, "put", { ...address, body: msg });
    changeRecord(db, "put", { ...address, key: "def-456def", body: { ...msg, id: "def-456def" } });
    changeRecord(db, "put", { ...address, body: { ...msg, readAt: now } });
  }
  linkDeskItem(source, item.id, msg.id);
  commitAckTx(source, {
    id: "a".repeat(32),
    deskIds: [item.id],
    inboxIds: [msg.id],
    session: "private-owner",
    at: now,
  });
  const worktree = path.join(dir, "worktree");
  mkdirSync(worktree);
  mkdirSync(path.dirname(resolveFoundryStatePath(worktree)), { recursive: true });
  const foundry = writeFoundryState(
    worktree,
    { status: "verified" },
    { root: source, owningRoomId: "active", operationId: "review-operation" },
  );
  const later = writeFoundryState(
    worktree,
    { status: "completed" },
    { root: source, owningRoomId: "active" },
  );
  const damaged = path.join(dir, "damaged");
  mkdirSync(damaged);
  let expected;
  {
    using original = openRooms(source);
    original.tagStore
      .run`INSERT INTO chief_notification_intents VALUES('pending','private-profile','private-event',1)`;
    original.tagStore
      .run`INSERT INTO chief_notification_intents VALUES('completed','private-profile','delivered',2)`;
    original.tagStore.run`DELETE FROM chief_notification_intents WHERE id='completed'`;
    expected = snapshot(original);
    await backupSqlite(original, path.join(damaged, "rooms.db"));
  }
  {
    using d = openOrkestSqlite(path.join(damaged, "rooms.db"));
    for (const t of [
      "rooms",
      "mailbox_records",
      "chief_desk_items",
      "chief_desk_acked",
      "chief_ack_txs",
      "chief_notification_intents",
      "outbox_views",
      "outbox_room_hints",
      "foundry_states",
      "foundry_ops",
    ])
      d.exec("DROP TABLE " + t);
  }
  const target = await rebuildProjections(
    damaged,
    checkpoint.database,
    checkpoint.sha256,
    path.join(dir, "rebuilt"),
  );
  const rebuilt = path.dirname(target.database);
  for (const marker of ["peers", "inbox", "mailbox-sqlite-v1"])
    copyFileSync(path.join(source, marker), path.join(rebuilt, marker));
  {
    using actual = openRooms(rebuilt);
    expect(snapshot(actual)).toEqual(expected);
    expect(actual.tagStore.all`SELECT id FROM chief_notification_intents`).toEqual([
      { id: "pending" },
    ]);
    expect(
      actual.tagStore.get`SELECT 1 FROM outbox_events WHERE body LIKE '%private-event%'`,
    ).toBeUndefined();
    expect(getRecord(actual, address).readAt).toBe(now);
    expect(getRecord(actual, { ...address, key: "def-456def" }).readAt).toBe(null);
    expect(
      actual.tagStore.get`SELECT room FROM outbox_room_hints WHERE session='native-worker'`.room,
    ).toBe("active");
    expect(
      JSON.stringify(
        actual.tagStore.all`SELECT entity,body FROM outbox_events WHERE scope LIKE 'room:%'`,
      ),
    ).not.toMatch(/private-ticket|private message|private-sender|Renamed private/);
  }
  expect(readDesk(rebuilt)).toEqual(readDesk(source));
  expect(readFoundryState(worktree, { root: rebuilt })).toEqual(later);
  expect(
    writeFoundryState(
      worktree,
      { status: "verified" },
      { root: rebuilt, owningRoomId: "active", operationId: "review-operation" },
    ),
  ).toEqual(foundry);
  expect(readFoundryState(worktree, { root: rebuilt })).toEqual(later);
  expect(pendingAckTxs(rebuilt)).toEqual(pendingAckTxs(source));
  expect(readRawRoom("active", rebuilt).title).toBe("Renamed private room");
  expect(() => readRawRoom("old", rebuilt)).toThrow(/Room not found/);
  expect(target.historySequence).toBeGreaterThan(checkpoint.historySequence);
  expect(target.outboxCursor).toBeGreaterThan(checkpoint.outboxCursor);
  await expect(
    rebuildProjections(damaged, checkpoint.database, "0".repeat(64), path.join(dir, "bad-hash")),
  ).rejects.toThrow(/SHA-256/);
  {
    using d = openOrkestSqlite(path.join(damaged, "rooms.db"));
    d.tagStore
      .run`UPDATE local_projection_changes SET new_row='[]' WHERE seq=${checkpoint.historySequence + 1}`;
  }
  await expect(
    rebuildProjections(damaged, checkpoint.database, checkpoint.sha256, path.join(dir, "bad-tail")),
  ).rejects.toThrow(/digest/);
  expect(existsSync(path.join(dir, "bad-tail", "ready"))).toBe(false);
});

it("rejects a different history, a missing tail entry and a future schema", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recovery-integrity-"));
  const source = path.join(dir, "source"),
    other = path.join(dir, "other");
  openRooms(source).close();
  openRooms(other).close();
  const cp = await createProjectionCheckpoint(source, path.join(dir, "baseline"));
  await expect(
    rebuildProjections(other, cp.database, cp.sha256, path.join(dir, "unrelated")),
  ).rejects.toThrow(/another history/);
  await updateRawRoom("missing", () => ({ id: "missing", agents: [] }), {
    create: true,
    root: source,
  });
  using corrupt = openOrkestSqlite(path.join(source, "rooms.db"));
  corrupt.exec("DELETE FROM local_projection_changes WHERE seq=1");
  await expect(
    rebuildProjections(source, cp.database, cp.sha256, path.join(dir, "gap")),
  ).rejects.toThrow(/sequence/);
  corrupt.exec(
    "DELETE FROM local_projection_changes WHERE seq=(SELECT max(seq) FROM local_projection_changes)",
  );
  await expect(
    updateRawRoom("missing", (r) => ({ ...r, title: "later" }), { root: source }),
  ).rejects.toThrow(/history_head/);
  corrupt.exec("PRAGMA user_version=999");
  await expect(
    rebuildProjections(source, cp.database, cp.sha256, path.join(dir, "future")),
  ).rejects.toThrow(/Unsupported/);
  for (const name of ["unrelated", "gap", "future"])
    expect(existsSync(path.join(dir, name, "ready"))).toBe(false);
});
