import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { exportLegacyFoundryStates, foundryStateKey } from "../../../src/lib/foundry-outbox.mjs";
import {
  FoundryStateError,
  loadFoundryState,
  readFoundryState,
  resolveFoundryStatePath,
  writeFoundryState,
} from "../../../src/lib/foundry.mjs";
import {
  mailboxRoot,
  openRooms,
  roomsDbPath,
  updateRawRoom,
} from "../../../src/lib/horde-room.mjs";
import { openOrkestSqlite } from "../../../src/lib/orkest-sqlite.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

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

/** Every committed event in a profile's shared outbox, oldest first. */
function readEvents(root) {
  using db = openRooms(root);
  return db
    .prepare("SELECT scope, seq, id, kind, entity, body FROM outbox_events ORDER BY cursor")
    .all()
    .map((row) => ({ ...row, body: JSON.parse(row.body) }));
}

const emitted = () => readEvents(root).filter((event) => event.kind === "foundry.transition");
const realHome = process.env.ORCHESTRATE_HOME;
const home = mkdtempSync(path.join(tmpdir(), "orkest-foundry-outbox-"));
const root = mailboxRoot({ ORCHESTRATE_HOME: home });
const temporary = [];
beforeAll(() => {
  process.env.ORCHESTRATE_HOME = home;
});
afterEach(() => retainFixtures(temporary.splice(0)));
afterAll(async () => {
  if (realHome === undefined) delete process.env.ORCHESTRATE_HOME;
  else process.env.ORCHESTRATE_HOME = realHome;
  await retainFixtures([home]);
});

function worktree() {
  const raw = mkdtempSync(path.join(tmpdir(), "orkest-foundry-wt-"));
  temporary.push(raw);
  const dir = realpathSync(raw);
  const file = resolveFoundryStatePath(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  return { dir, file };
}

function sql(query, ...params) {
  const db = openOrkestSqlite(roomsDbPath(root), { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

function writeWithDatabase(statement, fn) {
  const db = openOrkestSqlite(roomsDbPath(root));
  try {
    db.exec(statement);
    return fn();
  } finally {
    db.close();
  }
}

describe("Foundry canonical state in the shared WAL store", () => {
  it("reads never create the database, and writes never create a state file", () => {
    const f = worktree();
    const fresh = path.join(home, "fresh");
    const env = { ORCHESTRATE_HOME: fresh };
    expect(loadFoundryState(f.dir, { env }).kind).toBe("missing");
    expect(existsSync(fresh)).toBe(false);
    writeFoundryState(f.dir, { status: "launching", attemptCount: 1 });
    expect(readFoundryState(f.dir)).toMatchObject({ status: "launching", attemptCount: 1 });
    expect(existsSync(f.file)).toBe(false);
    expect(sql("SELECT revision FROM foundry_states")).toContainEqual({ revision: 1 });
  });

  it("imports a legacy state exactly once and never re-reads the retained file", () => {
    const f = worktree();
    const legacy = JSON.stringify({ attemptCount: 3, status: "verified", note: "old" });
    writeFileSync(f.file, legacy);
    expect(readFoundryState(f.dir)).toMatchObject({ attemptCount: 3 }); // read-only projection
    expect(sql("SELECT key FROM foundry_states WHERE key = ?", foundryStateKey(f.file))).toEqual(
      [],
    );

    const merged = writeFoundryState(f.dir, { status: "merged" });
    expect(merged).toMatchObject({ attemptCount: 3, note: "old", status: "merged" });

    // A rolled-back or stale writer touching the legacy file afterwards changes nothing.
    writeFileSync(f.file, JSON.stringify({ attemptCount: 99, status: "stale" }));
    expect(readFoundryState(f.dir)).toMatchObject({ attemptCount: 3, status: "merged" });
    writeFoundryState(f.dir, { reviewed: true });
    expect(readFoundryState(f.dir)).toMatchObject({ attemptCount: 3, reviewed: true });
    expect(readFileSync(f.file, "utf8")).toContain('"attemptCount":99');
  });

  it("imports an empty legacy object without inventing fields or events", () => {
    const f = worktree();
    writeFileSync(f.file, "{}");
    expect(loadFoundryState(f.dir)).toMatchObject({ kind: "ok", state: {} });
    const before = emitted().length;
    const state = writeFoundryState(f.dir, {}, { owningRoomId: "room-empty" });
    expect(state).toMatchObject({ attemptCount: 1, schema: "ork.foundry.state.v2" });
    expect(
      emitted()
        .slice(before)
        .map((event) => event.body.status),
    ).toEqual(["other"]);
  });

  it("keeps corrupt and unsupported legacy files closed and creates no canonical row", () => {
    for (const bytes of ['{"attemptCount":1,', '{"schema":"future"}']) {
      const f = worktree();
      writeFileSync(f.file, bytes);
      const rows = sql("SELECT count(*) AS n FROM foundry_states")[0].n;
      expect(() => writeFoundryState(f.dir, { status: "verified" })).toThrow(FoundryStateError);
      expect(sql("SELECT count(*) AS n FROM foundry_states")[0].n).toBe(rows);
      expect(readFileSync(f.file, "utf8")).toBe(bytes);
      expect(["corrupt", "unsupported"]).toContain(loadFoundryState(f.dir).kind);
    }
  });

  it("honours exclusive creation against both canonical rows and legacy files", () => {
    const first = worktree();
    writeFoundryState(first.dir, { status: "launching" }, { exclusive: true });
    expect(() => writeFoundryState(first.dir, { status: "x" }, { exclusive: true })).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    const second = worktree();
    writeFileSync(second.file, "{}");
    expect(() => writeFoundryState(second.dir, { status: "x" }, { exclusive: true })).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });

  it("rolls the state back when a later statement in the transaction fails", () => {
    const f = worktree();
    writeFoundryState(f.dir, { status: "running", attemptCount: 1 });
    writeWithDatabase(
      "CREATE TRIGGER IF NOT EXISTS foundry_test_abort BEFORE INSERT ON foundry_ops BEGIN SELECT RAISE(ABORT, 'injected'); END",
      () => {
        expect(() =>
          writeFoundryState(f.dir, { status: "failed" }, { operationId: "op-1" }),
        ).toThrow(/injected/u);
      },
    );
    expect(readFoundryState(f.dir).status).toBe("running");
    writeWithDatabase("DROP TRIGGER foundry_test_abort", () => {});
    const retried = writeFoundryState(f.dir, { status: "failed" }, { operationId: "op-1" });
    expect(retried.status).toBe("failed");
  });

  it("replays a retried operation without a second revision or event", () => {
    const f = worktree();
    writeFoundryState(f.dir, { status: "launching" }, { operationId: "a", owningRoomId: "room-r" });
    const count = () =>
      sql("SELECT revision FROM foundry_states ORDER BY revision DESC")[0].revision;
    const events = readEvents(root).length;
    const revision = sql("SELECT max(revision) AS r FROM foundry_states")[0].r;
    writeFoundryState(f.dir, { status: "launching" }, { operationId: "a", owningRoomId: "room-r" });
    expect(count()).toBe(revision);
    expect(readEvents(root)).toHaveLength(events);
  });

  it("returns the original command result after a later write and rejects conflicting reuse", () => {
    const f = worktree();
    const options = { owningRoomId: "room-retry", operationId: "first", expectedRevision: 0 };
    const first = writeFoundryState(f.dir, { status: "running", attemptCount: 1 }, options);
    writeFoundryState(f.dir, { status: "verified" }, { owningRoomId: "room-retry" });
    expect(writeFoundryState(f.dir, { attemptCount: 1, status: "running" }, options)).toEqual(
      first,
    );
    expect(() => writeFoundryState(f.dir, { status: "abandoned" }, options)).toThrow(
      /content_conflict/u,
    );
    expect(readFoundryState(f.dir).status).toBe("verified");
    expect(emitted().filter((event) => event.scope === "room:room-retry")).toHaveLength(2);
  });

  it("preserves revision-only receipts on upgrade and supports newly issued commands", () => {
    const f = worktree();
    const isolated = path.join(home, "revision-only");
    const key = foundryStateKey(f.file);
    {
      using db = openOrkestSqlite(roomsDbPath(isolated));
      db.exec(
        "CREATE TABLE foundry_ops(key TEXT, op TEXT, revision INTEGER, PRIMARY KEY(key,op)) STRICT",
      );
      db.tagStore.run`INSERT INTO foundry_ops VALUES(${key},'old',1)`;
    }
    const patch = { status: "verified" };
    expect(() => writeFoundryState(f.dir, patch, { root: isolated, operationId: "old" })).toThrow(
      /legacy_operation_receipt_unavailable/u,
    );
    const options = { root: isolated, operationId: "new" };
    const saved = writeFoundryState(f.dir, patch, options);
    expect(writeFoundryState(f.dir, patch, options)).toEqual(saved);
    expect(() => writeFoundryState(f.dir, patch, { root: isolated, operationId: "old" })).toThrow(
      /legacy_operation_receipt_unavailable/u,
    );
  });

  it("starts empty for a recreated worktree at the same path", () => {
    const f = worktree();
    writeFoundryState(f.dir, { status: "verified", attemptCount: 5 });
    renameSync(f.dir, f.dir + "-prior");
    temporary.push(f.dir + "-prior");
    mkdirSync(path.dirname(f.file), { recursive: true });
    expect(loadFoundryState(f.dir).kind).toBe("missing");
    expect(writeFoundryState(f.dir, { status: "launching" }).attemptCount).toBe(1);
  });

  it("serializes independent processes without losing updates", async () => {
    const f = worktree();
    const script = `
      import { writeFoundryState } from ${JSON.stringify(
        new URL("../../../src/lib/foundry.mjs", import.meta.url).href,
      )};
      const [dir, id] = process.argv.slice(1);
      for (let i = 0; i < 5; i++) writeFoundryState(dir, { ["k" + id + i]: i }, { operationId: id + ":" + i });
    `;
    const run = (id) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, f.dir, id], {
          env: { ...process.env, ORCHESTRATE_HOME: home },
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    await Promise.all(["a", "b", "c", "d"].map(run));
    const state = readFoundryState(f.dir);
    expect(Object.keys(state).filter((key) => /^k[a-d]\d$/u.test(key))).toHaveLength(20);
    expect(sql("SELECT count(*) AS n FROM foundry_ops")[0].n).toBeGreaterThanOrEqual(20);
  });

  it("commits a redacted, ordered transition event with the state", () => {
    const f = worktree();
    const options = { owningRoomId: "room-evt" };
    writeFoundryState(
      f.dir,
      { status: "launching", secret: "token-123", branch: "feature/x" },
      options,
    );
    writeFoundryState(f.dir, { status: "launching", evidence: "same transition" }, options);
    writeFoundryState(f.dir, { status: "verified" }, options);
    const events = emitted().filter((event) => event.scope === "room:room-evt");
    expect(events.map((event) => event.kind)).toEqual(["foundry.transition", "foundry.transition"]);
    expect(readEvents(root).filter((event) => event.scope === "room:room-evt")).toHaveLength(2);
    const stored = readEvents(root).filter((event) => event.scope === "room:room-evt");
    expect(stored.map((event) => event.seq)).toEqual([1, 2]);
    expect(stored[1].body).toEqual(events[1].body);
    expect(events[1].body).toMatchObject({
      status: "verified",
      attempt: 1,
      attemptStatus: null,
      pr: null,
    });
    const wire = JSON.stringify(events);
    for (const secret of [f.dir, "token-123", "feature/x", "same transition", path.basename(f.dir)])
      expect(wire).not.toContain(secret);
    expect(events[0].entity).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("exports nothing for state that is not bound to a room", () => {
    const f = worktree();
    const before = emitted().length;
    writeFoundryState(f.dir, { status: "launching" });
    writeFoundryState(f.dir, { status: "verified" }, { owningRoomId: "not a room id!" });
    expect(emitted()).toHaveLength(before);
  });
});

describe("Foundry export boundary", () => {
  it("maps anything outside the product lifecycle list to other", () => {
    const f = worktree();
    writeFoundryState(f.dir, { status: "feature/secret-branch" }, { owningRoomId: "room-s" });
    writeFoundryState(f.dir, { status: "verified" }, { owningRoomId: "room-s" });
    const bodies = emitted()
      .filter((e) => e.scope === "room:room-s")
      .map((e) => e.body);
    expect(bodies.map((body) => body.status)).toEqual(["other", "verified"]);
    expect(JSON.stringify(bodies)).not.toContain("secret");
    for (const body of bodies)
      expect(Object.keys(body).toSorted((a, b) => a.localeCompare(b))).toEqual([
        "attempt",
        "attemptStatus",
        "pr",
        "revision",
        "status",
      ]);
  });

  it("rolls the canonical state back when the event append fails", () => {
    const f = worktree();
    writeFoundryState(f.dir, { status: "running", attemptCount: 1 });
    const restore = failAppends(root);
    try {
      expect(() =>
        writeFoundryState(f.dir, { status: "verified" }, { owningRoomId: "room-r" }),
      ).toThrow(/append failed/u);
    } finally {
      restore();
    }
    expect(readFoundryState(f.dir)).toMatchObject({ status: "running" });
    expect(
      sql("SELECT max(revision) AS r FROM foundry_states WHERE state LIKE '%running%'")[0].r,
    ).toBe(1);
  });

  it("rejects a stale transition revision before it changes either private or shared state", () => {
    const f = worktree();
    const options = { owningRoomId: "room-cas" };
    writeFoundryState(f.dir, { status: "running" }, { ...options, expectedRevision: 0 });
    const event = emitted().find((entry) => entry.scope === "room:room-cas");
    const stale = { ...options, expectedRevision: 0, operationId: "retry" };
    expect(() => writeFoundryState(f.dir, { operatorNote: "stale" }, stale)).toThrow(
      expect.objectContaining({ code: "revision_conflict", requiredRevision: event.seq }),
    );
    expect(readFoundryState(f.dir)).not.toHaveProperty("operatorNote");
    expect(
      writeFoundryState(
        f.dir,
        { status: "verified" },
        {
          ...stale,
          expectedRevision: event.seq,
        },
      ).status,
    ).toBe("verified");
  });

  it("rolls back privately on a foreign owner and applies the retried operation once", () => {
    const f = worktree();
    const options = { owningRoomId: "room-f", operationId: "op-foreign" };
    writeFoundryState(f.dir, { status: "running", attemptCount: 1 });
    const entity = foundryStateKey(resolveFoundryStatePath(f.dir));
    writeWithDatabase(
      `INSERT INTO outbox_views VALUES('foreign-origin','foreign-epoch','room:room-f','foundry.transition','${entity}',7,'{}')`,
      () => {},
    );
    const events = () => emitted().filter((event) => event.scope === "room:room-f").length;
    expect(() => writeFoundryState(f.dir, { operatorNote: "foreign" }, options)).toThrow(
      expect.objectContaining({
        code: "owner_conflict",
        owner: "foreign-origin",
        requiredRevision: 7,
      }),
    );
    expect(() => writeFoundryState(f.dir, { status: "verified" }, options)).toThrow(
      /owner_conflict/u,
    );
    expect(readFoundryState(f.dir)).toMatchObject({ status: "running" });
    expect(sql(`SELECT count(*) AS n FROM foundry_ops WHERE key='${entity}'`)[0].n).toBe(0);
    expect(events()).toBe(0);

    writeWithDatabase("DELETE FROM outbox_views WHERE origin='foreign-origin'", () => {});
    writeFoundryState(f.dir, { status: "verified" }, options);
    writeFoundryState(f.dir, { status: "verified" }, options);
    expect(readFoundryState(f.dir)).toMatchObject({ status: "verified" });
    expect(events()).toBe(1);
    expect(sql(`SELECT count(*) AS n FROM foundry_ops WHERE key='${entity}'`)[0].n).toBe(1);
  });

  it("refuses a local checkout claiming work in a room owned by a paired host", () => {
    const f = worktree();
    const isolated = path.join(home, "remote-room");
    {
      using db = openRooms(isolated);
      db.exec(
        "INSERT INTO outbox_views VALUES('other','epoch','room:project','room.summary','project',11,'{}')",
      );
    }
    expect(() =>
      writeFoundryState(
        f.dir,
        { status: "running" },
        { root: isolated, owningRoomId: "project", expectedRevision: 0 },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "owner_conflict",
        owner: "other",
        epoch: "epoch",
        requiredRevision: 11,
      }),
    );
    expect(readFoundryState(f.dir, { root: isolated })).toBeNull();
    expect(readEvents(isolated)).toHaveLength(0);
  });

  it("derives the owning room from the confirmed integration marker, not from the caller", async () => {
    const f = worktree();
    const gitDir = path.dirname(path.dirname(f.file));
    const marker = { roomId: "room-m", memberId: "m1", integrationId: "i1", commit: "abc" };
    writeFileSync(path.join(gitDir, "orkest.json"), JSON.stringify(marker));
    const before = emitted().length;
    writeFoundryState(f.dir, { status: "launching" }); // the marker names a room nobody confirms
    expect(emitted()).toHaveLength(before);

    const agents = (integration) => [{ id: "m1", integration }];
    await updateRawRoom(
      "room-m",
      () => ({ id: "room-m", agents: agents({ integrationId: "other", commit: "abc" }) }),
      { root, create: true },
    );
    writeFoundryState(f.dir, { status: "running" });
    expect(emitted()).toHaveLength(before); // integration does not match: still unbound

    await updateRawRoom(
      "room-m",
      (room) => ({ ...room, agents: agents({ integrationId: "i1", commit: "abc" }) }),
      { root },
    );
    writeFoundryState(f.dir, { status: "verified" });
    expect(
      emitted()
        .slice(before)
        .map((event) => event.scope),
    ).toEqual(["room:room-m"]);
  });
});

describe("Foundry write path through the public command", () => {
  it("lets the ork CLI read state written by this process", () => {
    const f = worktree();
    writeFoundryState(f.dir, { status: "verified", attemptCount: 2 });
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readFoundryState } from ${JSON.stringify(new URL("../../../src/lib/foundry.mjs", import.meta.url).href)};
         process.stdout.write(JSON.stringify(readFoundryState(process.argv[1])));`,
        f.dir,
      ],
      { env: { ...process.env, ORCHESTRATE_HOME: home }, encoding: "utf8" },
    );
    expect(JSON.parse(out)).toMatchObject({ status: "verified", attemptCount: 2 });
  });
});

it("stages canonical Foundry state with its original admin destination without modifying the worktree", () => {
  const fixture = worktree();
  const state = writeFoundryState(fixture.dir, { status: "verified" });
  const destination = mkdtempSync(path.join(tmpdir(), "foundry-rollback-"));
  temporary.push(destination);
  using db = openRooms(root);
  const { manifest } = exportLegacyFoundryStates(db, destination);
  const { entries } = JSON.parse(readFileSync(path.join(destination, manifest), "utf8"));
  const entry = entries.find((row) => row.destination === fixture.file);
  expect(entry.revision).toBe(1);
  const copy = JSON.parse(
    readFileSync(path.join(destination, "foundry-rollback", entry.file), "utf8"),
  );
  expect(copy).toEqual(state);
  expect(existsSync(fixture.file)).toBe(false);
});
