import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { putDeskItem } from "../../../src/lib/chief-outbox.mjs";
import { readPeers } from "../../../src/lib/chief.mjs";
import { resolveFoundryStatePath, writeFoundryState } from "../../../src/lib/foundry.mjs";
import { mailboxRoot, openRooms } from "../../../src/lib/horde-room.mjs";
import { auditMailbox, ensureMailbox } from "../../../src/lib/mailbox-migration.mjs";
import { changeRecord, getRecord, recordSessionKey } from "../../../src/lib/mailbox-records.mjs";
import { openOrkestSqlite } from "../../../src/lib/orkest-sqlite.mjs";
import { exportLegacyRoot } from "../../../src/lib/outbox-export.mjs";
import { localStream, readPage } from "../../../src/lib/outbox.mjs";

const cli = fileURLToPath(new URL("../../../src/bin/mailbox-records.mjs", import.meta.url));
function temp() {
  return mkdtempSync(path.join(tmpdir(), "ork-mailbox-cutover-"));
}
function call(root, op, req = {}) {
  return JSON.parse(
    execFileSync(process.execPath, [cli, op, root], {
      input: JSON.stringify(req),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}
function fixtures(root) {
  const session = "Some:Worker";
  const peer = {
    schema: "agent-executor.peer.v1",
    session,
    name: "worker",
    cwd: root,
    harness: "codex",
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  const msg = {
    schema: "agent-executor.mail.v1",
    id: "abcd-abcdef",
    from: { session: "sender" },
    to: { session },
    text: "private message",
    sentAt: peer.lastSeenAt,
    readAt: null,
  };
  const key = recordSessionKey(session);
  mkdirSync(path.join(root, "peers"));
  mkdirSync(path.join(root, "inbox", key), { recursive: true });
  const peerPath = path.join(root, "peers", key + ".json"),
    messagePath = path.join(root, "inbox", key, msg.id + ".json");
  writeFileSync(peerPath, JSON.stringify(peer));
  writeFileSync(messagePath, JSON.stringify(msg));
  return { peer, msg, key, peerPath, messagePath };
}

test("explicit cutover keeps original inodes, fences an old writer, and atomically folds ack retries", () => {
  const root = temp(),
    { peer, msg, key, peerPath } = fixtures(root);
  const inode = statSync(peerPath).ino,
    contents = readFileSync(peerPath);
  const anchor = path.join(root, "original-link");
  linkSync(peerPath, anchor);
  expect(call(root, "ensure")).toEqual({ active: false });
  expect(existsSync(path.join(root, "rooms.db"))).toBe(false);
  expect(() => call(root, "migrate")).toThrow();
  const backup = call(root, "migrate", { quiesced: true }).backup;
  expect(statSync(path.join(backup, "peers", key + ".json")).ino).toBe(inode);
  expect(readFileSync(anchor)).toEqual(contents);
  expect(() => writeFileSync(peerPath, "legacy late writer")).toThrow(/ENOTDIR/);
  expect(readPeers(root).map((item) => item.session)).toContain(peer.session);
  const req = { collection: "inbox", owner: key, key: msg.id };
  expect(call(root, "get", req)).toEqual(msg);
  const ack = { ...msg, readAt: peer.startedAt };
  expect(call(root, "put", { ...req, body: ack })).toEqual(ack);
  expect(call(root, "put", { ...req, body: msg })).toEqual(ack);
  expect(() => call(root, "put", { ...req, body: { ...ack, text: "conflict" } })).toThrow();
  using db = openRooms(root);
  const events = db.tagStore
    .all`SELECT kind,entity,body FROM outbox_events WHERE scope='mailbox-local' ORDER BY seq`;
  expect(events).toHaveLength(3);
  const entity = createHash("sha256")
    .update(JSON.stringify(["inbox", key, msg.id]))
    .digest("hex");
  expect(events.at(-1)).toMatchObject({ kind: "mailbox.inbox", entity, body: '{"state":"read"}' });
  expect(JSON.stringify(events)).not.toContain(msg.text);
  expect(() =>
    readPage(db, { ...localStream(db, "mailbox-local"), after: 0, limit: 2, max_bytes: 4096 }),
  ).toThrow();
  // Force the outbox half to fail. The domain row must not become visible.
  db.exec(
    "CREATE TEMP TRIGGER fail_append BEFORE INSERT ON outbox_events BEGIN SELECT RAISE(ABORT,'fixture_fault'); END",
  );
  expect(() => changeRecord(db, "delete", req)).toThrow(/fixture_fault/);
  expect(getRecord(db, req)).toEqual(ack);
  expect(auditMailbox(root).active).toBe(true);
  writeFileSync(anchor, '{"changed":true}');
  expect(() => auditMailbox(root)).toThrow();
});

test("interrupted migration resumes from retained directories; a recreated legacy path blocks it", () => {
  const root = temp(),
    { peer, key } = fixtures(root),
    template = temp();
  ensureMailbox(template, { quiesced: true });
  const fence = readFileSync(path.join(template, "mailbox-sqlite-pending-v1"));
  writeFileSync(path.join(root, "mailbox-sqlite-pending-v1"), fence, { mode: 0o600 });
  const backup = path.join(root, "mailbox-legacy-v1");
  mkdirSync(backup, { mode: 0o700 });
  renameSync(path.join(root, "peers"), path.join(backup, "peers"));
  mkdirSync(path.join(root, "peers"));
  expect(() => ensureMailbox(root, { quiesced: true })).toThrow(/legacy_writer_conflict/);
  renameSync(path.join(root, "peers"), path.join(root, "late-writer-evidence"));
  expect(ensureMailbox(root, { quiesced: true }).active).toBe(true);
  expect(call(root, "get", { collection: "peer", owner: "", key })).toEqual(peer);
  expect(call(root, "migrate", { quiesced: true }).active).toBe(true);
});

test("rejects ambiguous or symlinked legacy source before fencing it", () => {
  const root = temp(),
    { peer, peerPath } = fixtures(root);
  const alias = path.join(root, "peers", peer.session.replaceAll(":", "_") + ".json");
  writeFileSync(alias, JSON.stringify(peer));
  expect(() => ensureMailbox(root, { quiesced: true })).toThrow(/duplicate_legacy/);
  expect(statSync(peerPath).isFile()).toBe(true);
  expect(existsSync(path.join(root, "mailbox-sqlite-pending-v1"))).toBe(false);
  renameSync(alias, path.join(root, "retained-original"));
  symlinkSync(peerPath, alias);
  expect(() => ensureMailbox(root, { quiesced: true })).toThrow(/unexpected_legacy_entry/);
});

test("simultaneous first opens converge on a single fenced identity; nonempty preexisting roots remain legacy", async () => {
  const root = temp();
  const processes = Array.from(
    { length: 4 },
    () =>
      new Promise((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [cli, "ensure", root],
          { encoding: "utf8" },
          (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))),
        );
        child.stdin.end("{}");
      }),
  );
  const results = await Promise.all(processes);
  expect(results.every((r) => r.active)).toBe(true);
  const existing = temp();
  writeFileSync(path.join(existing, "unrelated-preserved"), "untouched");
  expect(call(existing, "ensure")).toEqual({ active: false });
  expect(existsSync(path.join(existing, "rooms.db"))).toBe(false);
});

test("opted-in registration publishes just redacted presence, heartbeat and offline transitions", () => {
  const root = temp();
  ensureMailbox(root);
  const previous = process.env.ORKEST_PRESENCE_SCOPE;
  process.env.ORKEST_PRESENCE_SCOPE = "project-test";
  try {
    using db = openRooms(root);
    const key = "private-id",
      req = { collection: "peer", owner: "", key };
    const body = {
      schema: "agent-executor.peer.v1",
      session: key,
      lastSeenAt: "2020-01-02T00:00:00Z",
      name: "private name",
      cwd: root,
    };
    changeRecord(db, "put", { ...req, body });
    changeRecord(db, "put", { ...req, body: { ...body, name: "private label two" } });
    const next = { ...body, lastSeenAt: "2020-01-03T00:00:00Z" };
    changeRecord(db, "put", { ...req, body: next });
    changeRecord(db, "delete", req);
    const rows = db.tagStore
      .all`SELECT entity,body FROM outbox_events WHERE kind='peer.presence' ORDER BY seq`;
    expect(rows.map((row) => JSON.parse(row.body))).toEqual([
      { present: true, observedAt: Date.parse(body.lastSeenAt) },
      { present: true, observedAt: Date.parse(next.lastSeenAt) },
      { present: false, observedAt: expect.any(Number) },
    ]);
    expect(rows.every((row) => /^[0-9a-f]{64}$/u.test(row.entity))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(key);
    process.env.ORKEST_PRESENCE_SCOPE = "mailbox-local";
    expect(() => changeRecord(db, "put", { ...req, body })).toThrow();
    expect(getRecord(db, req)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.ORKEST_PRESENCE_SCOPE;
    else process.env.ORKEST_PRESENCE_SCOPE = previous;
  }
});

test("legacy export projects new peer metadata, acknowledgements and removals without changing originals", () => {
  const root = temp();
  const { peer, msg, key, messagePath } = fixtures(root);
  const original = readFileSync(messagePath);
  const backup = call(root, "migrate", { quiesced: true }).backup;
  const inbox = { collection: "inbox", owner: key };
  const read = { ...msg, readAt: peer.startedAt };
  const unread = { ...msg, id: "beef-123456", clientId: "after-cutover" };
  call(root, "put", { collection: "peer", owner: "", key, body: { ...peer, name: "updated" } });
  call(root, "put", { ...inbox, key: msg.id, body: read });
  call(root, "put", { ...inbox, key: unread.id, body: unread });
  const removed = { ...msg, id: "cafe-123456" };
  call(root, "put", { ...inbox, key: removed.id, body: removed });
  call(root, "delete", { ...inbox, key: removed.id });
  const destination = path.join(temp(), "mailbox-v1");
  expect(call(root, "export", { destination })).toEqual({
    destination,
    peers: 1,
    messages: 2,
    unread: 1,
  });
  const messageDir = path.join(destination, "inbox", key);
  const readFile = path.join(messageDir, msg.id + ".json");
  expect(JSON.parse(readFileSync(readFile))).toEqual(read);
  const unreadFile = path.join(messageDir, unread.id + ".json");
  expect(JSON.parse(readFileSync(unreadFile))).toEqual(unread);
  expect(existsSync(path.join(messageDir, removed.id + ".json"))).toBe(false);
  const peerFile = path.join(destination, "peers", key + ".json");
  expect(JSON.parse(readFileSync(peerFile)).name).toBe("updated");
  expect(statSync(peerFile).mode & 0o777).toBe(0o600);
  expect(() => call(root, "export", { destination })).toThrow(/EEXIST/u);
  expect(() => call(root, "export", { destination: path.join(root, "copy") })).toThrow(
    /inside_source/u,
  );
  expect(readFileSync(path.join(backup, "inbox", key, msg.id + ".json"))).toEqual(original);
});

test("newer and missing databases fail closed across read, write, activation and rollback", () => {
  const root = temp();
  const { peer, key } = fixtures(root);
  call(root, "migrate", { quiesced: true });
  const req = { collection: "peer", owner: "", key, body: peer };
  const destination = path.join(temp(), "export");
  const ops = [
    ["ensure", {}],
    ["get", req],
    ["put", req],
    ["export", { destination }],
  ];
  {
    using db = openRooms(root);
    db.exec("PRAGMA user_version=2147483647");
  }
  for (const [op, request] of ops)
    expect(() => call(root, op, request)).toThrow(/unrecognized_mailbox_database/u);
  const file = path.join(root, "rooms.db");
  renameSync(file, file + ".held");
  for (const [op, request] of ops) expect(() => call(root, op, request)).toThrow();
  expect(existsSync(file)).toBe(false);
  expect(existsSync(destination)).toBe(false);
});

test("publishes room, mailbox, Chief and Foundry rollback at one committed cursor", () => {
  const env = { ORCHESTRATE_HOME: temp() };
  const root = mailboxRoot(env);
  mkdirSync(root, { recursive: true });
  const { key, msg } = fixtures(root);
  ensureMailbox(root, { quiesced: true });
  putDeskItem(root, {
    schema: "ork.chief.desk.v1",
    id: "one",
    roomId: null,
    from: "sender",
    kind: "update",
    text: "retained",
    at: "2026-11-19T10:00:00.000Z",
  });
  const worktree = temp();
  mkdirSync(path.dirname(resolveFoundryStatePath(worktree)), { recursive: true });
  writeFoundryState(worktree, { status: "verified" }, { env });
  const container = path.join(temp(), "combined");
  const report = exportLegacyRoot(root, container);
  expect(report).toMatchObject({
    mailbox: { promoted: true, peers: 1, messages: 1, unread: 1 },
    chief: { promoted: true, items: 1 },
    foundry: { states: 1 },
  });
  const restoredMessage = path.join(report.root, "inbox", key, msg.id + ".json");
  expect(JSON.parse(readFileSync(restoredMessage))).toEqual(msg);
  expect(readFileSync(path.join(report.root, "chief", "desk.jsonl"), "utf8")).toContain("retained");
  const manifest = JSON.parse(readFileSync(path.join(report.root, report.foundry.manifest)));
  expect(manifest.entries[0].destination).toBe(resolveFoundryStatePath(worktree));
  using snapshot = openOrkestSqlite(path.join(report.root, "post-cutover.sqlite"), {
    readOnly: true,
  });
  expect(snapshot.tagStore.get`SELECT MAX(cursor) AS n FROM outbox_events`.n).toBe(report.cursor);
  expect(() => exportLegacyRoot(root, container)).toThrow(/EEXIST/);
});

test("retains linked file contents before migration and withholds incomplete exports", () => {
  const root = temp();
  openRooms(root).close();
  mkdirSync(path.join(root, "peers"));
  writeFileSync(path.join(root, "peers", "a.json"), "{}");
  linkSync(path.join(root, "peers", "a.json"), path.join(root, "peers", "b.json"));
  const published = exportLegacyRoot(root, path.join(temp(), "export"));
  expect(published.mailbox).toEqual({ promoted: false, files: 2 });
  expect(statSync(path.join(published.root, "peers", "a.json")).ino).toBe(
    statSync(path.join(published.root, "peers", "b.json")).ino,
  );
  symlinkSync(path.join(root, "peers", "a.json"), path.join(root, "peers", "c.json"));
  const invalid = path.join(temp(), "invalid");
  expect(() => exportLegacyRoot(root, invalid)).toThrow(/Unsupported retained entry/);
  expect(existsSync(path.join(invalid, "ready"))).toBe(false);
  expect(readFileSync(path.join(root, "peers", "c.json"), "utf8")).toBe("{}");
});

test.each([false, true])(
  "rollback retains channel operations, task state and wake receipts (promoted=%s)",
  (promoted) => {
    const root = temp();
    openRooms(root).close();
    if (promoted) ensureMailbox(root, { quiesced: true });
    const files = [
      "channels/team/note.json",
      "channel-ops/session/input.json",
      "tasks/project/session.json",
      "wakes/session/pending.json",
      "chief/missions/work/brief.md",
      "work/board.json",
    ];
    for (const name of [
      ...files,
      "wakes/session/agy-control.json",
      "mailbox-daemon-v1/token.txt",
      "mailbox-daemon-v1/pid",
    ]) {
      const target = path.join(root, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, name);
    }
    const result = exportLegacyRoot(root, path.join(temp(), "export"));
    for (const name of files) expect(readFileSync(path.join(result.root, name), "utf8")).toBe(name);
    expect(existsSync(path.join(result.root, "wakes/session/agy-control.json"))).toBe(false);
    expect(existsSync(path.join(result.root, "mailbox-daemon-v1"))).toBe(false);
    symlinkSync(path.join(root, "work/board.json"), path.join(root, "tasks/unsafe"));
    const incomplete = path.join(temp(), "export");
    expect(() => exportLegacyRoot(root, incomplete)).toThrow(/Unsupported retained entry/);
    expect(existsSync(path.join(incomplete, "ready"))).toBe(false);
  },
);
