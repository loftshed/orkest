import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  auditLegacyRooms,
  deleteRoom,
  openRooms,
  updateRawRoom,
} from "../../../src/lib/horde-room.mjs";
import { publishQuota, quotaObservation } from "../../../src/lib/monitor/publish-quota.mjs";
import { withImmediateTransaction } from "../../../src/lib/orkest-sqlite.mjs";
import {
  applyCheckpoint,
  readCheckpoint,
  readCheckpointProgress,
} from "../../../src/lib/outbox-checkpoint.mjs";
import { PRESENCE_TTL_MS, QUOTA_TTL_MS } from "../../../src/lib/outbox-policy.mjs";
import {
  appendInTransaction,
  applyPage,
  localStream,
  readCursor,
  readPage,
  readView,
} from "../../../src/lib/outbox.mjs";
import { remoteObservations } from "../../../src/lib/remote-observations.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const temporary = [];
afterEach(() => retainFixtures(temporary.splice(0)));

function root() {
  const dir = mkdtempSync(path.join(tmpdir(), "ork-outbox-"));
  temporary.push(dir);
  return dir;
}
const bounds = { limit: 128, max_bytes: 65_536 };
function quota(id, pct = 75) {
  return {
    id,
    provider: "codex",
    ok: true,
    fetchedAt: 12_345,
    accountHome: "/private/account",
    windows: [
      { id: "5h", remainingPct: pct, windowMins: 300, resetsAt: null, privateValue: "private" },
    ],
  };
}

describe("scoped event store", () => {
  it("captures the private room record and safe summary in the successful command, including tombstones", async () => {
    const dir = root();
    await updateRawRoom(
      "unit",
      () => ({ id: "unit", cwd: "/private/checkout", agents: [], extra: "private" }),
      { root: dir, create: true },
    );
    using db = openRooms(dir);
    const stream = localStream(db, "room:unit");
    expect(
      readView(db, { ...stream, scope: "rooms-local", kind: "room.record", entity: "unit" }).body
        .room.extra,
    ).toBe("private");
    expect(() => readPage(db, { ...stream, scope: "rooms-local", after: 0, ...bounds })).toThrow(
      "private_scope",
    );
    expect(deleteRoom("unit", dir, { wrong: true })).toBe(false);
    expect(deleteRoom("unit", dir)).toBe(true);
    const page = readPage(db, { ...stream, after: 0, ...bounds });
    expect(page.events.map((e) => e.body.removed)).toEqual([false, true]);
    expect(JSON.stringify(page)).not.toContain("private");
    expect(readView(db, { ...stream, kind: "room.summary", entity: "unit" }).body.removed).toBe(
      true,
    );
  });

  it("rejects a malformed batch without acknowledging a prefix, deduplicates retries and rejects divergent owners", async () => {
    const a = root(),
      b = root();
    await updateRawRoom("unit", () => ({ id: "unit", agents: [] }), { root: a, create: true });
    await updateRawRoom("unit", (room) => ({ ...room, agents: [{}] }), { root: a });
    using db = openRooms(a);
    using remote = openRooms(b);
    const stream = localStream(db, "room:unit");
    const cursor = { ...stream, peer: "trusted-a" };
    const page = readPage(db, { ...stream, after: 0, ...bounds });
    const bad = structuredClone(page);
    bad.events[1].version++;
    const intake = (arg) =>
      applyPage(remote, { peer: cursor.peer, scope: stream.scope, page: arg });
    expect(() => intake(bad)).toThrow("unsupported_version");
    expect(readCursor(remote, cursor)).toBe(0);
    expect(readView(remote, { ...stream, kind: "room.summary", entity: "unit" })).toBeNull();
    expect(intake(page)).toEqual({ through: 2, applied: 2, replayed: 0 });
    expect(intake(page)).toEqual({ through: 2, applied: 0, replayed: 2 });
    bad.events[1].version = 1;
    bad.events[1].body.members = 48;
    expect(() => intake(bad)).toThrow("content_conflict");
    await expect(
      updateRawRoom("unit", () => ({ id: "unit", agents: [] }), { root: b, create: true }),
    ).rejects.toThrow("owner_conflict");
    expect(readCursor(remote, cursor)).toBe(2);
  });

  it("resumes an interrupted checkpoint, retains later tail and publishes validated Monitor fields", () => {
    const a = root();
    publishQuota([quota("one"), quota("two")], "project", a);
    publishQuota([quota("one"), quota("two")], "project", a);
    using db = openRooms(a);
    using remote = openRooms(root());
    const stream = localStream(db, "project");
    const key = { ...stream, peer: "producer" };
    const chunk = { ...stream, limit: 1, max_bytes: 4096 };
    const first = readCheckpoint(db, chunk);
    expect(first).toMatchObject({ after: 0, through: 1, more: true, high_water: 2 });
    const apply = (page) => applyCheckpoint(remote, { ...key, page });
    expect(apply(first).complete).toBe(false);
    expect(readCheckpointProgress(remote, key)).toEqual({
      checkpoint: first.checkpoint,
      through: 1,
    });
    expect(readCursor(remote, key)).toBe(0);
    expect(readView(remote, { ...stream, kind: "monitor.quota", entity: "one" })).toBeNull();
    publishQuota([quota("one", 23)], "project", a);
    const end = readCheckpoint(db, { ...chunk, checkpoint: first.checkpoint, after: 1 });
    expect(apply(end)).toMatchObject({ complete: true, high_water: 2 });
    expect(readCheckpointProgress(remote, key)).toBeNull();
    const tail = readPage(db, { ...stream, after: 2, ...bounds });
    expect(applyPage(remote, { ...key, page: tail }).through).toBe(3);
    expect(
      readView(remote, { ...stream, kind: "monitor.quota", entity: "one" }).body.limits[0]
        .remainingPct,
    ).toBe(23);
    expect(JSON.stringify(tail)).not.toContain("private");
    expect(quotaObservation({ ...quota("bad"), fetchedAt: null }, "project")).toBeNull();
  });

  it("keeps a pinned checkpoint and its tail available while another process appends past retention", () => {
    const dir = root();
    publishQuota([quota("one"), quota("two")], "project", dir);
    using db = openRooms(dir);
    using remote = openRooms(root());
    const stream = localStream(db, "project");
    const request = { ...stream, limit: 1, max_bytes: 4096 };
    const first = readCheckpoint(db, request);
    const intake = { ...stream, peer: "producer" };
    applyCheckpoint(remote, { ...intake, page: first });
    const sample = quotaObservation(quota("one", 12), "project");
    const writer = `
      import {openRooms} from "./src/lib/horde-room.mjs";
      import {withImmediateTransaction} from "./src/lib/orkest-sqlite.mjs";
      import {appendInTransaction} from "./src/lib/outbox.mjs";
      using db=openRooms(process.argv[1]);
      const sample=JSON.parse(process.argv[2]);
      withImmediateTransaction(db,()=>{for(let i=0;i<4100;i++)appendInTransaction(db,{...sample,id:String(i)});});
    `;
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", writer, dir, JSON.stringify(sample)],
      { timeout: 10_000 },
    );
    const last = readCheckpoint(db, {
      ...request,
      checkpoint: first.checkpoint,
      after: first.through,
    });
    expect(applyCheckpoint(remote, { ...intake, page: last }).high_water).toBe(2);
    expect(readPage(db, { ...stream, ...bounds, after: 2 }).events[0].seq).toBe(3);
    const stale = { ...intake, peer: "abandoned" };
    applyCheckpoint(remote, { ...stale, page: first });
    remote.tagStore.run`UPDATE outbox_staging SET touched_ms=0 WHERE peer='abandoned'`;
    expect(readCheckpointProgress(remote, stale)).toBeNull();
    expect(remote.tagStore.get`SELECT COUNT(*) AS n FROM outbox_staged_rows`.n).toBe(0);
    expect(readCursor(remote, stale)).toBe(0);
    db.tagStore.run`UPDATE outbox_snapshots SET created_ms=0`;
    expect(() => readPage(db, { ...stream, ...bounds, after: 2 })).toThrow("cursor_expired");
    expect(() =>
      readCheckpoint(db, { ...request, checkpoint: first.checkpoint, after: 1 }),
    ).toThrow("checkpoint_expired");
  });

  it("expires observations on a disconnected receiver and never refreshes their age on duplicate intake", () => {
    const source = root(),
      receiver = root();
    using db = openRooms(source);
    using remote = openRooms(receiver);
    const now = Date.now();
    const entity = "5".repeat(64);
    const scope = "project";
    const stream = localStream(db, scope);
    withImmediateTransaction(db, () => {
      appendInTransaction(db, {
        scope,
        kind: "peer.presence",
        entity,
        body: { present: true, observedAt: now + 60_000 },
      });
      appendInTransaction(db, quotaObservation({ ...quota("one"), fetchedAt: now }, scope));
    });
    const peer = "producer";
    const page = readPage(db, { ...stream, after: 0, ...bounds });
    applyPage(remote, { peer, scope, page });
    const query = { ...stream, entity, kind: "peer.presence" };
    const received = readView(remote, query).freshness.receivedAt;
    expect(remoteObservations(receiver, received + 1)[0]).toMatchObject({
      presentPeers: 1,
      staleAccounts: 0,
    });
    expect(readView(remote, query, received + PRESENCE_TTL_MS).freshness.present).toBe(false);
    expect(remoteObservations(receiver, received + QUOTA_TTL_MS)[0]).toMatchObject({
      presentPeers: 0,
      staleAccounts: 1,
    });
    expect(applyPage(remote, { peer, scope, page }).applied).toBe(0);
    expect(readView(remote, query).freshness.receivedAt).toBe(received);
    expect(readCursor(remote, { peer, ...stream })).toBe(2);
  });

  it("returns the original room result on a duplicate operation after another update", () => {
    const dir = root();
    const room = (command, id, data, revision) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "src/bin/room-store.mjs",
            command,
            "unit",
            "--root",
            dir,
            "--operation-id",
            id,
            "--expected-revision",
            String(revision),
          ],
          {
            input: data === null ? "" : JSON.stringify(data),
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        ),
      );
    const data = { id: "unit", agents: [] };
    const created = room("put", "create", data, 0);
    expect(room("set-meta", "title", { title: "new" }, 1).title).toBe("new");
    expect(room("put", "create", data, 0)).toEqual(created);
    expect(() => room("set-meta", "title", { title: "different" }, 1)).toThrow("content_conflict");
    expect(room("delete", "delete", null, 2)).toBe(true);
    expect(room("delete", "delete", null, 2)).toBe(true);
    using db = openRooms(dir);
    expect(readPage(db, { ...localStream(db, "room:unit"), after: 0, ...bounds }).through).toBe(3);
  });

  it("preserves linked legacy inputs and never follows them for archival or permission changes", () => {
    const dir = root(),
      legacy = path.join(dir, "rooms");
    mkdirSync(legacy);
    const original = path.join(dir, "held");
    writeFileSync(original, JSON.stringify({ id: "shared", agents: [] }), { mode: 0o640 });
    const shared = path.join(legacy, "shared.json"),
      alias = path.join(legacy, "alias.json");
    linkSync(original, shared);
    symlinkSync(original, alias);
    expect(auditLegacyRooms(dir)).toEqual({
      candidates: 2,
      readable: 1,
      unsupported: 1,
      sharedFiles: 1,
    });
    using db = openRooms(dir);
    expect(db.tagStore.get`SELECT id FROM rooms`.id).toBe("shared");
    expect(statSync(shared).ino).toBe(statSync(original).ino);
    expect(statSync(original).mode & 0o777).toBe(0o640);
    expect(readlinkSync(alias)).toBe(original);
  });

  it("requires a checkpoint below retention and accepts bounded pages with per-origin positions", () => {
    using db = openRooms(root());
    const stream = localStream(db, "project");
    const sample = quotaObservation(quota("one"), "project");
    withImmediateTransaction(db, () => {
      for (let i = 0; i < 4098; i++) appendInTransaction(db, { ...sample, id: String(i) });
    });
    expect(() => readPage(db, { ...stream, after: 0, ...bounds })).toThrow("cursor_expired");
    expect(() => readPage(db, { ...stream, after: 4096, limit: 1, max_bytes: 16 })).toThrow(
      "page_too_small",
    );
    expect(() => readPage(db, { ...stream, epoch: "new-epoch", after: 4096, ...bounds })).toThrow(
      "epoch_mismatch",
    );
    expect(readCheckpoint(db, { ...stream, ...bounds })).toMatchObject({
      high_water: 4098,
      more: false,
      through: 1,
    });
    expect(() => readCheckpoint(db, { ...stream, ...bounds, checkpoint: "gone" })).toThrow(
      "checkpoint_expired",
    );
  });
});
