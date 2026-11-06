import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { backup, Database } from "node:sqlite";

const minimumNodeVersion = "26.13.0";
const minimumSqliteVersion = "3.51.3";
const maximumRetryDelayMs = 1000;

function parseVersion(version, label) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version));
  if (!match) throw new Error(`Cannot verify ${label} version: ${String(version)}.`);
  return match.slice(1).map(Number);
}

function compareVersions(actual, required) {
  for (const [index, element] of actual.entries()) {
    if (element !== required[index]) return element - required[index];
  }
  return 0;
}

function assertSynchronousResult(result) {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    typeof result.then === "function"
  ) {
    throw new TypeError("SQLite transaction callbacks must be synchronous.");
  }
}

function finishTransaction(db, fn) {
  try {
    const result = fn(db);
    assertSynchronousResult(result);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "SQLite transaction failed and could not be rolled back.",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

function validateDelayOptions(maxRetries, baseDelayMs) {
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError("maxRetries must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError("baseDelayMs must be a non-negative safe integer.");
  }
}

function waitBeforeRetry(signal, baseDelayMs, attempt) {
  const upperBoundMs = Math.min(baseDelayMs * 2 ** attempt, maximumRetryDelayMs);
  const delayMs = Math.floor(Math.random() * upperBoundMs);
  if (delayMs > 0) Atomics.wait(signal, 0, 0, delayMs);
}

/** Fail clearly when a copied plugin is running on an unsupported Node or SQLite build. */
export function assertSqliteRuntime() {
  const nodeVersion = parseVersion(process.versions.node, "Node.js");
  if (compareVersions(nodeVersion, parseVersion(minimumNodeVersion, "required Node.js")) < 0) {
    throw new Error(
      `Orkest SQLite requires Node.js >= ${minimumNodeVersion}; found ${process.versions.node}.`,
    );
  }

  const sqliteVersion = parseVersion(process.versions.sqlite, "SQLite");
  if (compareVersions(sqliteVersion, parseVersion(minimumSqliteVersion, "required SQLite")) < 0) {
    throw new Error(
      `Orkest SQLite requires SQLite >= ${minimumSqliteVersion}; found ${process.versions.sqlite}.`,
    );
  }
}

/** Return the same path spelling for database paths whose parent uses a symlink alias. */
export function resolveCanonicalDbPath(rawPath, { createDir = false } = {}) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new TypeError("rawPath must be a non-empty string.");
  }

  const absolutePath = path.resolve(rawPath);
  const parentPath = path.dirname(absolutePath);
  if (createDir) mkdirSync(parentPath, { mode: 0o700, recursive: true });

  return path.join(realpathSync(parentPath), path.basename(absolutePath));
}

/** Open an Orkest database with safe defaults and a cached native tagged-query store. */
export function openOrkestSqlite(
  rawPath,
  {
    readOnly = false,
    timeout = 5000,
    synchronous = "FULL",
    journalSizeLimit = 67_108_864,
    tagStoreCapacity = 64,
  } = {},
) {
  assertSqliteRuntime();

  if (!Number.isSafeInteger(timeout) || timeout < 0) {
    throw new RangeError("timeout must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(journalSizeLimit) || journalSizeLimit < 0) {
    throw new RangeError("journalSizeLimit must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(tagStoreCapacity) || tagStoreCapacity < 1) {
    throw new RangeError("tagStoreCapacity must be a positive safe integer.");
  }

  const synchronousMode = String(synchronous).toUpperCase();
  if (synchronousMode !== "FULL" && synchronousMode !== "NORMAL") {
    throw new TypeError('synchronous must be either "FULL" or "NORMAL".');
  }

  const dbPath = resolveCanonicalDbPath(rawPath, { createDir: !readOnly });
  const db = new Database(dbPath, {
    allowBareNamedParameters: true,
    defensive: true,
    enableForeignKeyConstraints: true,
    readOnly,
    timeout,
  });

  try {
    if (!readOnly) {
      const journalMode = readPragma(db, "PRAGMA journal_mode = WAL").journal_mode;
      if (journalMode !== "wal") {
        throw new Error(`Could not enable SQLite WAL mode for ${dbPath}; received ${journalMode}.`);
      }
      db.exec(`PRAGMA synchronous = ${synchronousMode}`);
      db.exec(`PRAGMA journal_size_limit = ${journalSizeLimit}`);
      db.exec("PRAGMA temp_store = MEMORY");
    }

    const createNativeTagStore = db.createTagStore.bind(db);
    Object.defineProperty(db, "createTagStore", {
      value: (maxSize = tagStoreCapacity) => createNativeTagStore(maxSize),
    });

    let tagStore;
    Object.defineProperty(db, "tagStore", {
      get() {
        tagStore ??= db.createTagStore();
        return tagStore;
      },
    });

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function readPragma(db, sql) {
  using statement = db.prepare(sql);
  return statement.get();
}

/** Run a synchronous callback under a reserved SQLite write lock. */
export function withImmediateTransaction(db, fn, { maxRetries = 4, baseDelayMs = 20 } = {}) {
  assertSqliteRuntime();
  if (typeof fn !== "function") throw new TypeError("fn must be a function.");
  validateDelayOptions(maxRetries, baseDelayMs);

  if (typeof db?.exec !== "function")
    throw new TypeError("db must be a synchronous SQLite database.");
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      break;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= maxRetries) throw error;
      waitBeforeRetry(signal, baseDelayMs, attempt);
    }
  }

  return finishTransaction(db, fn);
}

/** Apply ordered migration callbacks atomically and guard the database identity. */
export function migrateSchema(db, { applicationId = 1_330_793_299, migrations } = {}) {
  assertSqliteRuntime();
  if (!Number.isSafeInteger(applicationId) || applicationId < 0 || applicationId > 2_147_483_647) {
    throw new RangeError("applicationId must be a non-negative 32-bit SQLite application ID.");
  }
  if (
    !Array.isArray(migrations) ||
    migrations.some((migration) => typeof migration !== "function")
  ) {
    throw new TypeError("migrations must be an ordered array of synchronous functions.");
  }

  db.exec("BEGIN EXCLUSIVE");
  return finishTransaction(db, () => {
    const storedApplicationId = readPragma(db, "PRAGMA application_id").application_id;
    if (storedApplicationId !== 0 && storedApplicationId !== applicationId) {
      throw new Error(
        `SQLite application_id mismatch: expected ${applicationId}, found ${storedApplicationId}.`,
      );
    }
    const storedUserVersion = readPragma(db, "PRAGMA user_version").user_version;
    if (!Number.isSafeInteger(storedUserVersion) || storedUserVersion < 0) {
      throw new Error(`SQLite schema version ${storedUserVersion} is invalid.`);
    }
    if (storedUserVersion > migrations.length) {
      throw new Error(
        `SQLite schema version ${storedUserVersion} is newer than this runtime supports (${migrations.length}).`,
      );
    }

    if (storedApplicationId === 0 && applicationId !== 0) {
      db.exec(`PRAGMA application_id = ${applicationId}`);
    }
    for (let index = storedUserVersion; index < migrations.length; index++) {
      const result = migrations[index](db);
      assertSynchronousResult(result);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    }
  });
}

/** Identify SQLITE_BUSY and its extended result codes from Node's numeric errcode. */
export function isSqliteBusyError(error) {
  return (
    typeof error?.errcode === "number" &&
    Number.isSafeInteger(error.errcode) &&
    (error.errcode & 255) === 5
  );
}

/** Create a consistent destination and copy a live database with SQLite's online backup API. */
export async function backupSqlite(sourceDb, destPath) {
  assertSqliteRuntime();
  const canonicalPath = resolveCanonicalDbPath(destPath, { createDir: true });
  return backup(sourceDb, canonicalPath);
}
