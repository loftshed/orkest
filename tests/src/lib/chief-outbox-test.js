import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  commitAckTx,
  exportLegacyChiefDeskRows,
  linkDeskItem,
  pendingAckTxs,
  putDeskItem,
} from "../../../src/lib/chief-outbox.mjs";
import {
  chiefDesk,
  commitAcknowledgement,
  listDesk,
  resumeAcknowledgements,
} from "../../../src/lib/chief.mjs";
import { openRooms, roomsDbPath } from "../../../src/lib/horde-room.mjs";
import { openOrkestSqlite } from "../../../src/lib/orkest-sqlite.mjs";

const CHIEF_BIN = fileURLToPath(new URL("../../../src/bin/chief.mjs", import.meta.url));
const CHIEF_LIB = new URL("../../../src/lib/chief-outbox.mjs", import.meta.url).href;

function profile() {
  const home = mkdtempSync(path.join(tmpdir(), "orkest-chief-outbox-"));
  const root = path.join(home, "mailbox-v1");
  mkdirSync(path.join(root, "chief"), { recursive: true });
  return { home, root };
}

function query(root, sql) {
  if (!existsSync(roomsDbPath(root))) return [];
  const db = openOrkestSqlite(roomsDbPath(root), { readOnly: true });
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Make every outbox append fail until the returned restore runs (the owner API's insert aborts). */
function failAppends(root) {
  using db = openRooms(root);
  db.exec(`CREATE TRIGGER fail_append BEFORE INSERT ON outbox_events
    BEGIN SELECT RAISE(ABORT, 'append failed'); END`);
  return () => {
    using again = openRooms(root);
    again.exec("DROP TRIGGER IF EXISTS fail_append");
  };
}

function events(root) {
  return query(
    root,
    "SELECT scope, seq, id, kind, entity, body FROM outbox_events ORDER BY cursor",
  ).map((row) => ({ ...row, body: JSON.parse(row.body) }));
}

const item = (id, extra = {}) => ({
  schema: "ork.chief.desk.v1",
  id,
  roomId: null,
  from: "sender-session",
  kind: "update",
  text: "private body text",
  at: "2026-11-19T10:00:00.000Z",
  ...extra,
});

function failDatabase(root, table) {
  const db = openOrkestSqlite(roomsDbPath(root));
  try {
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS abort_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
  } finally {
    db.close();
  }
  return () => {
    const reopened = openOrkestSqlite(roomsDbPath(root));
    try {
      reopened.exec(`DROP TRIGGER abort_${table}`);
    } finally {
      reopened.close();
    }
  };
}

describe("Chief desk canonical store", () => {
  it("is idempotent by ID, keeps desk text private and writes no journal file", () => {
    const { root } = profile();
    expect(listDesk(root)).toEqual([]);
    expect(existsSync(roomsDbPath(root))).toBe(false); // reading creates nothing
    expect(putDeskItem(root, item("a"))).toBe(true);
    expect(putDeskItem(root, item("a", { text: "replayed" }))).toBe(false);
    expect(listDesk(root)).toEqual([
      expect.objectContaining({ id: "a", text: "private body text" }),
    ]);
    expect(existsSync(path.join(root, "chief", "desk.jsonl"))).toBe(false);
    expect(linkDeskItem(root, "a", "mail-1")).toBe(true);
    expect(linkDeskItem(root, "a", "mail-2")).toBe(false);
    expect(listDesk(root)[0].mailboxId).toBe("mail-1");
  });

  it("imports a legacy desk exactly once, retains the files and never re-reads them", async () => {
    const { root } = profile();
    const journal = path.join(root, "chief", "desk.jsonl");
    const lines = [
      { v: 1, op: "put", id: "j1", item: item("j1", { roomId: "room-a", kind: "escalation" }) },
      { v: 1, op: "put", id: "j2", item: item("j2", { at: "2026-11-19T11:00:00.000Z" }) },
      { v: 1, op: "put", id: "j3", item: item("j3") },
      { v: 1, op: "ack", ids: ["j3"] },
      { v: 1, op: "link", id: "j1", messageId: "m-1" },
    ];
    writeFileSync(journal, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    mkdirSync(path.join(root, "chief", "desk"));
    writeFileSync(
      path.join(root, "chief", "desk", "old.json"),
      JSON.stringify({
        text: "legacy file",
        at: "2026-11-18T00:00:00.000Z",
        kind: "update",
        from: "x",
      }),
    );
    mkdirSync(path.join(root, "chief", "ack-transactions"));
    const tx = "a".repeat(32);
    writeFileSync(
      path.join(root, "chief", "ack-transactions", `${tx}.json`),
      JSON.stringify({
        schema: "ork.chief.ack.v1",
        id: tx,
        state: "committed",
        session: "chief-s",
        deskIds: ["j2"],
        inboxIds: ["mail-9"],
        at: "2026-11-19T12:00:00.000Z",
      }),
    );
    const before = readFileSync(journal, "utf8");

    // Before promotion: a pure projection, no database is created.
    expect(listDesk(root).map((entry) => entry.id)).toEqual(["legacy:old", "j1"]);
    expect(existsSync(roomsDbPath(root))).toBe(false);

    // First write promotes. The committed transaction's mail half is still owed.
    const ack = [];
    await resumeAcknowledgements(root, {
      runMailbox: (args) => {
        ack.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
      env: process.env,
    });
    expect(ack).toEqual([["ack", "--session", "chief-s", "mail-9"]]);
    expect(listDesk(root).map((entry) => entry.id)).toEqual(["legacy:old", "j1"]);
    expect(listDesk(root).find((entry) => entry.id === "j1")).toMatchObject({
      mailboxId: "m-1",
      roomId: "room-a",
    });
    expect(query(root, "SELECT state FROM chief_ack_txs")).toEqual([{ state: "complete" }]);

    // The old files are retained and a later stale write to them is ignored.
    writeFileSync(
      journal,
      `${before}${JSON.stringify({ v: 1, op: "put", id: "late", item: item("late") })}\n${JSON.stringify({ v: 1, op: "ack", ids: ["j1"] })}\n`,
    );
    expect(listDesk(root).map((entry) => entry.id)).toEqual(["legacy:old", "j1"]);
    putDeskItem(root, item("new"));
    expect(listDesk(root).map((entry) => entry.id)).toContain("new");
    expect(listDesk(root).map((entry) => entry.id)).not.toContain("late");
    expect(readdirSync(path.join(root, "chief", "desk"))).toEqual(["old.json"]);
    expect(query(root, "SELECT count(*) AS n FROM chief_imports")).toEqual([{ n: 1 }]);
  });

  it("rolls an acknowledgement back when any statement of its transaction fails", async () => {
    const { root } = profile();
    putDeskItem(root, item("a", { roomId: "room-x" }));
    const restore = failDatabase(root, "chief_ack_txs");
    await expect(commitAcknowledgement({ root, deskIds: ["a"] })).rejects.toThrow(/injected/u);
    expect(listDesk(root).map((entry) => entry.id)).toEqual(["a"]);
    expect(query(root, "SELECT count(*) AS n FROM chief_desk_acked")).toEqual([{ n: 0 }]);
    restore();
    await commitAcknowledgement({ root, deskIds: ["a"] });
    expect(listDesk(root)).toEqual([]);
  });

  it("rolls a put back, event included, when the outbox append fails", () => {
    const { root } = profile();
    putDeskItem(root, item("seed"));
    const restore = failDatabase(root, "chief_desk_items");
    expect(() => putDeskItem(root, item("b"))).toThrow(/injected/u);
    expect(listDesk(root).map((entry) => entry.id)).toEqual(["seed"]);
    restore();
  });

  it("rejects a stale desk acknowledgement and leaves mail and desk untouched", async () => {
    const { root } = profile();
    putDeskItem(root, item("a"));
    await commitAcknowledgement({ root, deskIds: ["a"] });
    await expect(
      chiefDesk({
        root,
        ack: true,
        snapshot: { session: null, revision: null, deskIds: ["a"], inboxIds: [] },
        peers: [],
        listRooms: () => [],
      }),
    ).rejects.toMatchObject({ code: "snapshot_stale" });
  });

  it("agrees across independent processes: one item, one acknowledgement", async () => {
    const { home, root } = profile();
    const script = `
      import { putDeskItem } from ${JSON.stringify(CHIEF_LIB)};
      const [root, n] = process.argv.slice(1);
      for (let i = 0; i < 4; i++) putDeskItem(root, { id: "shared", roomId: null, at: "t", text: "x" + n });
      putDeskItem(root, { id: "own-" + n, roomId: null, at: "t" + n, text: "y" });
    `;
    const run = (n) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", script, root, String(n)],
          {
            env: { ...process.env, ORCHESTRATE_HOME: home },
            stdio: ["ignore", "ignore", "inherit"],
          },
        );
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    await Promise.all([1, 2, 3, 4].map(run));
    const ids = listDesk(root).map((entry) => entry.id);
    expect(ids.filter((id) => id === "shared")).toHaveLength(1);
    expect(ids).toHaveLength(5);
  });

  it("serves the public CLI: desk lists and --ack acknowledges from the canonical store", () => {
    const { home, root } = profile();
    putDeskItem(root, item("cli-1"));
    const run = (...args) =>
      spawnSync(process.execPath, [CHIEF_BIN, "desk", "--json", ...args], {
        env: { ...process.env, ORCHESTRATE_HOME: home },
        encoding: "utf8",
      });
    const listed = run();
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).items.map((entry) => entry.id)).toEqual(["cli-1"]);
    const acked = run("--ack");
    expect(acked.status, acked.stderr).toBe(0);
    expect(JSON.parse(acked.stdout)).toMatchObject({ acknowledged: 1 });
    expect(JSON.parse(run().stdout).items).toEqual([]);
  });

  it("emits redacted room-bound events and nothing for unbound items", async () => {
    const { root } = profile();
    putDeskItem(root, item("bound", { roomId: "room-b", text: "secret words", from: "sess-123" }));
    putDeskItem(root, item("unbound"));
    await commitAcknowledgement({ root, deskIds: ["bound", "unbound"] });
    await commitAcknowledgement({ root, deskIds: ["bound"] });
    const emitted = events(root).filter((event) => event.scope === "room:room-b");
    expect(emitted.map((event) => [event.scope, event.kind])).toEqual([
      ["room:room-b", "chief.item"],
      ["room:room-b", "chief.ack"],
    ]);
    expect(events(root).map((event) => event.scope)).toEqual(["room:room-b", "room:room-b"]);
    expect(
      events(root).some(
        (event) =>
          event.entity === emitted[0].entity &&
          event.body.kind === undefined &&
          event.kind === "chief.ack",
      ),
    ).toBe(true);
    expect(emitted[0].body).toEqual({ state: "queued", kind: "update" });
    expect(emitted[1].body).toEqual({ state: "acked" });
    const wire = JSON.stringify(emitted);
    for (const secret of ["secret words", "sess-123", '"bound"', '"unbound"', root])
      expect(wire).not.toContain(secret);
    expect(emitted[0].entity).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("rolls canonical desk state back when the event append fails", async () => {
    const { root } = profile();
    putDeskItem(root, item("kept", { roomId: "room-k" }));
    const restore = failAppends(root);
    try {
      expect(() => putDeskItem(root, item("lost", { roomId: "room-k" }))).toThrow(/append failed/u);
      await expect(commitAcknowledgement({ root, deskIds: ["kept"] })).rejects.toThrow(
        /append failed/u,
      );
    } finally {
      restore();
    }
    expect(listDesk(root).map((entry) => entry.id)).toEqual(["kept"]);
    expect(query(root, "SELECT count(*) AS n FROM chief_ack_txs")).toEqual([{ n: 0 }]);
  });
});

it("restores active and acknowledged items and owed mailbox work from exported legacy files", () => {
  const { root } = profile();
  putDeskItem(root, item("active"));
  linkDeskItem(root, "active", "linked");
  putDeskItem(root, item("done"));
  const tx = {
    schema: "ork.chief.ack.v1",
    id: "a".repeat(32),
    state: "committed",
    at: "2026-11-19T11:00:00Z",
    session: "private",
    deskIds: ["done"],
    inboxIds: ["owed"],
  };
  commitAckTx(root, tx);
  const destination = mkdtempSync(path.join(tmpdir(), "chief-rollback-"));
  using db = openRooms(root);
  expect(exportLegacyChiefDeskRows(db, destination)).toEqual({
    promoted: true,
    items: 2,
    acknowledgements: 1,
  });
  expect(listDesk(destination)).toEqual(listDesk(root));
  expect(pendingAckTxs(destination)).toEqual(pendingAckTxs(root));
});
