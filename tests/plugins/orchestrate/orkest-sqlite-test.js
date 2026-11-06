import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertSqliteRuntime,
  backupSqlite,
  isSqliteBusyError,
  migrateSchema,
  openOrkestSqlite,
  resolveCanonicalDbPath,
  withImmediateTransaction,
} from "../../../plugins/orchestrate/lib/orkest-sqlite.mjs";

const execFileAsync = promisify(execFile);
const nodeExecutable = process.execPath;
const sqliteModuleUrl = pathToFileURL(
  path.resolve("plugins/orchestrate/lib/orkest-sqlite.mjs"),
).href;

const temporaryDirectory = { path: "" };

function pragma(db, sql, property) {
  using statement = db.prepare(sql);
  return statement.get()[property];
}

beforeEach(async () => {
  temporaryDirectory.path = await mkdtemp(path.join(tmpdir(), "orkest-sqlite-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(temporaryDirectory.path, { force: true, recursive: true });
  temporaryDirectory.path = "";
});

describe("Orkest SQLite runtime", () => {
  it("accepts the required Node and SQLite versions and rejects older or unparseable versions", () => {
    expect(assertSqliteRuntime).not.toThrow();

    vi.stubGlobal("process", { versions: { node: "26.12.99", sqlite: "3.54.0" } });
    expect(assertSqliteRuntime).toThrow("requires Node.js >= 26.13.0");

    vi.stubGlobal("process", { versions: { node: "26.13.0", sqlite: "3.51.2" } });
    expect(assertSqliteRuntime).toThrow("requires SQLite >= 3.51.3");

    vi.stubGlobal("process", { versions: { node: "26.13", sqlite: "3.54.0" } });
    expect(assertSqliteRuntime).toThrow("Cannot verify Node.js version");
  });

  it("recognizes SQLITE_BUSY by its numeric primary and extended result codes", () => {
    expect(isSqliteBusyError({ code: "ERR_SQLITE_ERROR", errcode: 5 })).toBe(true);
    expect(isSqliteBusyError({ code: "ERR_SQLITE_ERROR", errcode: 517 })).toBe(true);
    expect(isSqliteBusyError({ code: "SQLITE_BUSY", errcode: "5" })).toBe(false);
    expect(isSqliteBusyError({ errcode: 6 })).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
  });

  it("canonicalizes symlinked parents and creates missing writable parents", async () => {
    const aliasPath = path.join(temporaryDirectory.path, "alias");
    await symlink(temporaryDirectory.path, aliasPath, "dir");
    const actualParent = path.join(temporaryDirectory.path, "nested");
    const canonical = await realpath(temporaryDirectory.path);

    expect(
      resolveCanonicalDbPath(path.join(aliasPath, "nested", "store.sqlite"), {
        createDir: true,
      }),
    ).toBe(path.join(canonical, "nested", "store.sqlite"));
    expect(
      resolveCanonicalDbPath(path.join(actualParent, "store.sqlite"), { createDir: false }),
    ).toBe(path.join(canonical, "nested", "store.sqlite"));
  });
});

describe("Orkest SQLite connections", () => {
  it("uses WAL, FULL synchronous mode, a bounded journal, and in-memory temp storage by default", () => {
    using db = openOrkestSqlite(path.join(temporaryDirectory.path, "full.sqlite"));

    expect(pragma(db, "PRAGMA journal_mode", "journal_mode")).toBe("wal");
    expect(pragma(db, "PRAGMA synchronous", "synchronous")).toBe(2);
    expect(pragma(db, "PRAGMA journal_size_limit", "journal_size_limit")).toBe(67_108_864);
    expect(pragma(db, "PRAGMA temp_store", "temp_store")).toBe(2);
  });

  it("allows NORMAL synchronous mode for rebuildable caches", () => {
    using db = openOrkestSqlite(path.join(temporaryDirectory.path, "cache.sqlite"), {
      synchronous: "NORMAL",
    });

    expect(pragma(db, "PRAGMA synchronous", "synchronous")).toBe(1);
  });

  it("provides cached tagged queries and enforces STRICT and JSON constraints", () => {
    using db = openOrkestSqlite(path.join(temporaryDirectory.path, "strict.sqlite"));
    db.exec(
      "CREATE TABLE strict_numbers (value INTEGER) STRICT; CREATE TABLE json_documents (data TEXT CHECK (json_valid(data))) STRICT;",
    );

    expect(db.tagStore).toBe(db.tagStore);
    expect(db.createTagStore(4)).toBeDefined();
    db.tagStore.run`INSERT INTO json_documents (data) VALUES (${JSON.stringify({ ok: true })})`;
    expect(db.tagStore.get`SELECT data FROM json_documents`).toMatchObject({
      data: '{"ok":true}',
    });

    using insert = db.prepare("INSERT INTO strict_numbers (value) VALUES (?)");
    let sqliteError;
    try {
      insert.run(1.25);
    } catch (error) {
      sqliteError = error;
    }
    expect(sqliteError).toMatchObject({ errcode: 3091 });
    expect(sqliteError.code).toBe("ERR_SQLITE_ERROR");
  });

  it("disposes both Database and Statement resources with using", () => {
    let database;
    let statement;
    {
      using db = openOrkestSqlite(path.join(temporaryDirectory.path, "dispose.sqlite"));
      using query = db.prepare("SELECT 1 AS value");
      database = db;
      statement = query;

      expect(query.get()).toMatchObject({ value: 1 });
      expect(typeof db[Symbol.dispose]).toBe("function");
      expect(typeof query[Symbol.dispose]).toBe("function");
    }

    expect(database.isOpen).toBe(false);
    expect(() => statement.get()).toThrow();
  });
});

describe("Orkest SQLite transactions and migrations", () => {
  it("retries busy BEGIN IMMEDIATE with bounded jitter and does not retry the callback", () => {
    const busyError = Object.assign(new Error("database is locked"), { errcode: 261 });
    const statements = [];
    let beginFailures = 2;
    let isTransaction = false;
    const db = {
      exec(sql) {
        statements.push(sql);
        if (sql === "BEGIN IMMEDIATE" && beginFailures > 0) {
          beginFailures--;
          throw busyError;
        }
        if (sql === "BEGIN IMMEDIATE") isTransaction = true;
        else if (sql === "COMMIT" || sql === "ROLLBACK") isTransaction = false;
      },
      get isTransaction() {
        return isTransaction;
      },
    };
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const callback = vi.fn(() => "committed");

    expect(withImmediateTransaction(db, callback, { baseDelayMs: 4, maxRetries: 2 })).toBe(
      "committed",
    );
    expect(callback).toHaveBeenCalledOnce();
    expect(statements).toEqual(["BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "COMMIT"]);
    expect(wait).toHaveBeenCalledTimes(2);

    const callbackError = Object.assign(new Error("callback failed"), { errcode: 5 });
    statements.length = 0;
    expect(() =>
      withImmediateTransaction(db, () => {
        throw callbackError;
      }),
    ).toThrow(callbackError);
    expect(statements).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("rolls back callback failures without retaining their writes", () => {
    using db = openOrkestSqlite(path.join(temporaryDirectory.path, "rollback.sqlite"));
    db.exec(
      "CREATE TABLE values_table (value INTEGER NOT NULL) STRICT; INSERT INTO values_table VALUES (1);",
    );
    using update = db.prepare("UPDATE values_table SET value = 2");

    expect(() =>
      withImmediateTransaction(db, () => {
        update.run();
        throw new Error("stop transaction");
      }),
    ).toThrow("stop transaction");
    expect(pragma(db, "PRAGMA user_version", "user_version")).toBe(0);
    using select = db.prepare("SELECT value FROM values_table");
    expect(select.get()).toMatchObject({ value: 1 });
    expect(db.isTransaction).toBe(false);
  });

  it("applies ordered migrations once and refuses mismatched or unknown schemas", () => {
    using db = openOrkestSqlite(path.join(temporaryDirectory.path, "migrations.sqlite"));
    const createTable = vi.fn((database) =>
      database.exec("CREATE TABLE records (value TEXT NOT NULL) STRICT"),
    );
    const addIndex = vi.fn((database) =>
      database.exec("CREATE INDEX records_value ON records(value)"),
    );
    const migrations = [createTable, addIndex];

    migrateSchema(db, { migrations });
    migrateSchema(db, { migrations });
    expect(createTable).toHaveBeenCalledOnce();
    expect(addIndex).toHaveBeenCalledOnce();
    expect(pragma(db, "PRAGMA application_id", "application_id")).toBe(1_330_793_299);
    expect(pragma(db, "PRAGMA user_version", "user_version")).toBe(2);

    expect(() => migrateSchema(db, { migrations: [createTable] })).toThrow(
      "schema version 2 is newer than this runtime supports (1)",
    );

    db.exec("PRAGMA application_id = 42");
    expect(() => migrateSchema(db, { migrations })).toThrow(
      `SQLite application_id mismatch: expected 1330793299, found 42`,
    );
  });
});

describe("Orkest SQLite backup and process concurrency", () => {
  it("backs up a live database to a canonical destination", async () => {
    using source = openOrkestSqlite(path.join(temporaryDirectory.path, "source.sqlite"));
    source.exec(
      "CREATE TABLE snapshot (value TEXT NOT NULL) STRICT; INSERT INTO snapshot VALUES ('preserved');",
    );
    const destination = path.join(temporaryDirectory.path, "backups", "snapshot.sqlite");

    await backupSqlite(source, destination);

    using copy = openOrkestSqlite(destination, { readOnly: true });
    using select = copy.prepare("SELECT value FROM snapshot");
    expect(select.get()).toMatchObject({
      value: "preserved",
    });
  });

  it("keeps all updates from six concurrent Node processes", async () => {
    const databasePath = path.join(temporaryDirectory.path, "concurrent.sqlite");
    using db = openOrkestSqlite(databasePath);
    db.exec(
      "CREATE TABLE counter (value INTEGER NOT NULL) STRICT; INSERT INTO counter VALUES (0);",
    );

    const workerSource = `
      import { openOrkestSqlite, withImmediateTransaction } from ${JSON.stringify(sqliteModuleUrl)};
      const [databasePath, count] = process.argv.slice(1);
      using db = openOrkestSqlite(databasePath, { timeout: 250 });
      using update = db.prepare("UPDATE counter SET value = value + 1");
      for (let index = 0; index < Number(count); index++) {
        withImmediateTransaction(db, () => update.run(), { baseDelayMs: 5, maxRetries: 8 });
      }
    `;
    const processCount = 6;
    const updatesPerProcess = 20;
    await Promise.all(
      Array.from({ length: processCount }, () =>
        execFileAsync(nodeExecutable, [
          "--input-type=module",
          "-e",
          workerSource,
          databasePath,
          String(updatesPerProcess),
        ]),
      ),
    );

    using select = db.prepare("SELECT value FROM counter");
    expect(select.get()).toMatchObject({
      value: processCount * updatesPerProcess,
    });
  });
});
