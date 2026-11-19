import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  isSqliteBusyError,
  migrateSchema,
  openOrkestSqlite,
  withImmediateTransaction,
} from "./orkest-sqlite.mjs";
import { cacheHome } from "./runtime-paths.mjs";

// 0x4F4B5054 (ASCII, big endian)
export const PORTS_APPLICATION_ID = 1_330_335_828;
export const PORTS_DB_NAME = "worktree-ports.sqlite";
const DEFAULT_RANGE_START = 31_000;
const DEFAULT_RANGE_END = 49_151;
const DEFAULT_BUDGET_MS = 5000;
const MAX_NAMES = 16;
const PORT_NAME = /^[A-Z][A-Z0-9_]{0,31}$/u;
const FENCE_DIR = "worktree-port-fences";

const PORTS_TABLE_SQL = `CREATE TABLE ports (
  repo_key TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  slot TEXT NOT NULL,
  slug TEXT NOT NULL,
  port INTEGER NOT NULL UNIQUE CHECK(port BETWEEN 1024 AND 49151),
  allocated_at INTEGER NOT NULL,
  PRIMARY KEY(repo_key, worktree_path, slot)
) STRICT;`;

const EXPECTED_COLUMNS = [
  ["repo_key", "TEXT", 1, 1],
  ["worktree_path", "TEXT", 1, 2],
  ["slot", "TEXT", 1, 3],
  ["slug", "TEXT", 1, 0],
  ["port", "INTEGER", 1, 0],
  ["allocated_at", "INTEGER", 1, 0],
];

function portsError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function classify(error) {
  if (error?.code?.startsWith?.("ORK_PORTS_")) return error;
  if (isSqliteBusyError(error)) {
    return portsError("ORK_PORTS_BUSY", "The worktree port database is busy; retry shortly", error);
  }
  const message = String(error?.message ?? error);
  if (/not a database|malformed|corrupt|disk image/iu.test(message)) {
    return portsError(
      "ORK_PORTS_DB_CORRUPT",
      `Worktree port database is corrupt: ${message}`,
      error,
    );
  }
  if (/application_id|schema version|incompatible/iu.test(message)) {
    return portsError("ORK_PORTS_DB_INCOMPATIBLE", message, error);
  }
  return error;
}

export function worktreePortsDbPath(env = process.env) {
  return path.join(cacheHome(env), PORTS_DB_NAME);
}

/** Canonical durable identity: real repository path plus the real (or parent-resolved) worktree path. */
export function worktreePortKey(repoRoot, worktreePath) {
  const repoKey = realpathSync(path.resolve(repoRoot));
  const resolved = path.resolve(worktreePath);
  let canonical;
  try {
    canonical = realpathSync(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    canonical = path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
  }
  return { repoKey, worktreePath: canonical };
}

function resolveKey({ repoRoot, worktreePath, key }) {
  if (key) {
    if (
      typeof key.repoKey !== "string" ||
      typeof key.worktreePath !== "string" ||
      !path.isAbsolute(key.repoKey) ||
      !path.isAbsolute(key.worktreePath)
    ) {
      throw portsError(
        "ORK_PORTS_INVALID",
        "A persisted port key needs absolute repoKey and worktreePath",
      );
    }
    return { repoKey: key.repoKey, worktreePath: key.worktreePath };
  }
  return worktreePortKey(repoRoot, worktreePath);
}

function assertSchema(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ports'")
    .all();
  if (tables.length !== 1) {
    throw portsError("ORK_PORTS_DB_INCOMPATIBLE", "Port database has no ports table");
  }
  const columns = db.prepare("PRAGMA table_info(ports)").all();
  const isMatches =
    columns.length === EXPECTED_COLUMNS.length &&
    EXPECTED_COLUMNS.every(
      ([name, type, notNull, pk], index) =>
        columns[index].name === name &&
        columns[index].type === type &&
        columns[index].notnull === notNull &&
        columns[index].pk === pk,
    );
  if (!isMatches) {
    throw portsError(
      "ORK_PORTS_DB_INCOMPATIBLE",
      "Port database ports table has an unexpected shape",
    );
  }
}

const MIGRATIONS = [
  (db) => {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ports'").all();
    if (existing.length > 0) {
      throw portsError(
        "ORK_PORTS_DB_INCOMPATIBLE",
        "Database already contains an unrelated ports table; refusing to overwrite it",
      );
    }
    db.exec(PORTS_TABLE_SQL);
  },
];

/** Inspect identity read-only so a foreign or newer database is never switched to WAL or migrated. */
function assertOwnStore(dbPath) {
  const info = lstatSync(dbPath);
  if (!info.isFile() || info.uid !== process.getuid()) {
    throw portsError(
      "ORK_PORTS_DB_INCOMPATIBLE",
      `${dbPath} is not a regular file you own; leaving it untouched`,
    );
  }
}

function peekIdentity(dbPath) {
  if (!existsSync(dbPath)) return;
  assertOwnStore(dbPath);
  const probe = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const appId = probe.prepare("PRAGMA application_id").get().application_id;
    const version = probe.prepare("PRAGMA user_version").get().user_version;
    const isForeignPorts =
      appId === 0 &&
      probe.prepare("SELECT name FROM sqlite_master WHERE name = 'ports'").all().length > 0;
    if (
      (appId !== 0 && appId !== PORTS_APPLICATION_ID) ||
      version > MIGRATIONS.length ||
      (appId === 0 && version !== 0) ||
      isForeignPorts
    ) {
      throw portsError(
        "ORK_PORTS_DB_INCOMPATIBLE",
        `Port database has application_id ${appId} and schema version ${version}; expected ${PORTS_APPLICATION_ID} v${MIGRATIONS.length}`,
      );
    }
    if (version === MIGRATIONS.length) assertSchema(probe);
  } finally {
    probe.close();
  }
}

function openWritable(env, timeout = 5000) {
  const dbPath = worktreePortsDbPath(env);
  let db;
  try {
    peekIdentity(dbPath);
    db = openOrkestSqlite(dbPath, { timeout });
    migrateSchema(db, { applicationId: PORTS_APPLICATION_ID, migrations: MIGRATIONS });
    assertSchema(db);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* Already failing. */
    }
    throw classify(error);
  }
}

/** Open read-only without creating anything; null when no database exists yet. */
function openReadable(env) {
  const dbPath = worktreePortsDbPath(env);
  if (!existsSync(dbPath)) return null;
  let db;
  try {
    assertOwnStore(dbPath);
    db = openOrkestSqlite(dbPath, { readOnly: true });
    const appId = db.prepare("PRAGMA application_id").get().application_id;
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (appId === 0 && version === 0) {
      const foreign = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ports'").all();
      if (foreign.length > 0) {
        throw portsError(
          "ORK_PORTS_DB_INCOMPATIBLE",
          "Database contains an unrelated ports table; refusing to read it",
        );
      }
      db.close();
      return null;
    }
    if (appId !== PORTS_APPLICATION_ID || version !== MIGRATIONS.length) {
      throw portsError(
        "ORK_PORTS_DB_INCOMPATIBLE",
        `Port database has application_id ${appId} and schema version ${version}; expected ${PORTS_APPLICATION_ID} v${MIGRATIONS.length}`,
      );
    }
    assertSchema(db);
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* Already failing. */
    }
    throw classify(error);
  }
}

function validateAllocation({ names, rangeStart, rangeEnd }) {
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_NAMES) {
    throw portsError("ORK_PORTS_INVALID", `names must list 1-${MAX_NAMES} port names`);
  }
  if (new Set(names).size !== names.length || names.some((n) => !PORT_NAME.test(n ?? ""))) {
    throw portsError("ORK_PORTS_INVALID", "Port names must be unique upper-case identifiers");
  }
  for (const value of [rangeStart, rangeEnd]) {
    if (!Number.isSafeInteger(value) || value < 1024 || value > 49_151) {
      throw portsError("ORK_PORTS_INVALID", "Port range must lie within 1024..49151");
    }
  }
  if (rangeStart > rangeEnd || rangeEnd - rangeStart + 1 < names.length) {
    throw portsError("ORK_PORTS_INVALID", "Port range is empty or smaller than the name list");
  }
}

function startOffset(key, slot, size) {
  const digest = createHash("sha256")
    .update(`${key.repoKey}\0${key.worktreePath}\0${slot}`)
    .digest();
  return digest.readUInt32BE(0) % size;
}

function listenOnce(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    // The probe only reserves the port. Drop any connection immediately so close() can drain.
    server.on("connection", (socket) => socket.destroy());
    server.once("error", (error) => {
      server.close();
      resolve({ error });
    });
    server.listen({ port, host, exclusive: true }, () => resolve({ server }));
  });
}

/**
 * Probe a loopback port and keep the sockets open. IPv6 loopback is best effort because hosts
 * without it must still allocate.
 */
async function holdPort(port) {
  const v4 = await listenOnce(port, "127.0.0.1");
  if (!v4.server) return null;
  const v6 = await listenOnce(port, "::1");
  if (!v6.server && !["EADDRNOTAVAIL", "EAFNOSUPPORT", "EINVAL"].includes(v6.error?.code)) {
    v4.server.close();
    return null;
  }
  return { port, servers: [v4.server, v6.server].filter(Boolean) };
}

const CLOSE_GRACE_MS = 1000;

function closeServer(server) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CLOSE_GRACE_MS);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function closeHeld(held) {
  return Promise.all(held.flatMap((entry) => entry.servers.map((server) => closeServer(server))));
}

function fencePath(key, env) {
  const id = createHash("sha256").update(`${key.repoKey}\0${key.worktreePath}`).digest("hex");
  return path.join(cacheHome(env), FENCE_DIR, `${id}.json`);
}

function fenceDirectory(env, { create }) {
  const directory = path.join(cacheHome(env), FENCE_DIR);
  if (create) {
    mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  let info;
  try {
    info = lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  // A foreign or loosely-permitted directory is reported, never repaired or written into.
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid()) {
    throw portsError("ORK_PORTS_FENCE_UNSAFE", `${directory} must be a real directory you own`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw portsError(
      "ORK_PORTS_FENCE_UNSAFE",
      `${directory} must not be group or world accessible`,
    );
  }
  return directory;
}

function isOwnPrivateFile(info) {
  return info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0;
}

/**
 * Block (re)allocation for a canonical identity while a quarantine move is unfinished. The marker
 * is installed while holding the database write lock, and allocation re-checks it inside its own
 * write transaction, so a commit either happens before the fence (and the release that follows
 * removes it) or sees the fence and rolls back.
 */
export function fenceWorktreePorts({
  repoRoot,
  worktreePath,
  key,
  env = process.env,
  reason = "",
}) {
  const resolved = resolveKey({ repoRoot, worktreePath, key });
  const db = openWritable(env);
  try {
    return withImmediateTransaction(db, () => {
      const directory = fenceDirectory(env, { create: true });
      const file = fencePath(resolved, env);
      let existing = null;
      try {
        existing = lstatSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (existing) {
        if (!isOwnPrivateFile(existing)) {
          throw portsError("ORK_PORTS_FENCE_UNSAFE", `${file} is not a private file you own`);
        }
        return { fenced: true, path: file };
      }
      const temporary = path.join(
        directory,
        `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
      );
      const fd = openSync(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, `${JSON.stringify({ ...resolved, reason: String(reason).slice(0, 200) })}\n`);
      } finally {
        closeSync(fd);
      }
      try {
        // A hard link never replaces an existing name, so a foreign entry cannot be clobbered.
        linkSync(temporary, file);
      } finally {
        unlinkSync(temporary);
      }
      return { fenced: true, path: file };
    });
  } catch (error) {
    throw classify(error);
  } finally {
    db.close();
  }
}

export function clearWorktreePortFence({ repoRoot, worktreePath, key, env = process.env }) {
  const resolved = resolveKey({ repoRoot, worktreePath, key });
  const file = fencePath(resolved, env);
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return { unfenced: false };
    throw error;
  }
  if (!isOwnPrivateFile(info)) {
    throw portsError("ORK_PORTS_FENCE_UNSAFE", `${file} is not a private file you own`);
  }
  const db = openWritable(env);
  try {
    return withImmediateTransaction(db, () => {
      // Rename rather than delete so the record survives for inspection.
      const done = path.join(
        path.dirname(file),
        `${path.basename(file, ".json")}.released-${Date.now()}-${randomBytes(3).toString("hex")}`,
      );
      renameSync(file, done);
      return { unfenced: true };
    });
  } catch (error) {
    throw classify(error);
  } finally {
    db.close();
  }
}

/** Any entry at the fence name counts as a fence, including a foreign one: fail closed. */
export function isWorktreeFenced({ repoRoot, worktreePath, key, env = process.env }) {
  const resolved = resolveKey({ repoRoot, worktreePath, key });
  try {
    lstatSync(fencePath(resolved, env));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Fence files left in the cache, for diagnostics. */
export function listPortFences(env = process.env) {
  const dir = path.join(cacheHome(env), FENCE_DIR);
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Probe the deterministic candidate order for one slot and return the first port held open. */
async function reserveSlot({ key, slot, taken, rangeStart, size, deadline }) {
  const offset = startOffset(key, slot, size);
  for (let step = 0; step < size; step += 1) {
    if (Date.now() >= deadline) {
      throw portsError("ORK_PORTS_BUSY", "Timed out probing for free loopback ports");
    }
    const port = rangeStart + ((offset + step) % size);
    if (taken.has(port)) continue;
    const hold = await holdPort(port);
    if (!hold) continue;
    taken.add(port);
    return hold;
  }
  throw portsError(
    "ORK_PORTS_EXHAUSTED",
    `No free port left in ${rangeStart}..${rangeStart + size - 1} for ${slot}`,
  );
}

/**
 * Allocate (or idempotently reuse) one loopback port per slot for a worktree.
 * Returns `{ SLOT: port }`. Failures throw an error whose `code` starts with ORK_PORTS_ and leave
 * no rows behind.
 */
export async function allocateWorktreePorts({
  repoRoot,
  worktreePath,
  slug = "",
  names,
  rangeStart = DEFAULT_RANGE_START,
  rangeEnd = DEFAULT_RANGE_END,
  env = process.env,
  budgetMs = DEFAULT_BUDGET_MS,
  busyTimeoutMs = 5000,
  afterReserve,
  key: persistedKey,
} = {}) {
  validateAllocation({ names, rangeStart, rangeEnd });
  const key = resolveKey({ repoRoot, worktreePath, key: persistedKey });
  if (isWorktreeFenced({ key, env })) {
    throw portsError(
      "ORK_PORTS_FENCED",
      `Ports for ${key.worktreePath} are fenced while a quarantine is unfinished`,
    );
  }
  const deadline = Date.now() + budgetMs;
  const size = rangeEnd - rangeStart + 1;
  const db = openWritable(env, busyTimeoutMs);
  try {
    let lastCollision = null;
    while (Date.now() < deadline) {
      const rows = db
        .prepare("SELECT slot, port FROM ports WHERE repo_key = ? AND worktree_path = ?")
        .all(key.repoKey, key.worktreePath);
      const have = new Map(rows.map((row) => [row.slot, row.port]));
      const missing = names.filter((name) => !have.has(name));
      if (missing.length === 0) return Object.fromEntries(names.map((n) => [n, have.get(n)]));

      const taken = new Set(
        db
          .prepare("SELECT port FROM ports WHERE port BETWEEN ? AND ?")
          .all(rangeStart, rangeEnd)
          .map((row) => row.port),
      );
      const held = [];
      try {
        const chosen = new Map();
        for (const slot of missing) {
          const hold = await reserveSlot({ key, slot, taken, rangeStart, size, deadline });
          held.push(hold);
          chosen.set(slot, hold.port);
        }
        // Test seam: runs after the probe sockets are held and before the write transaction.
        if (typeof afterReserve === "function") await afterReserve();
        try {
          const result = withImmediateTransaction(
            db,
            () => {
              if (isWorktreeFenced({ key, env })) {
                throw portsError(
                  "ORK_PORTS_FENCED",
                  `Ports for ${key.worktreePath} were fenced while allocating`,
                );
              }
              const current = new Map(
                db
                  .prepare("SELECT slot, port FROM ports WHERE repo_key = ? AND worktree_path = ?")
                  .all(key.repoKey, key.worktreePath)
                  .map((row) => [row.slot, row.port]),
              );
              const insert = db.prepare(
                "INSERT INTO ports (repo_key, worktree_path, slot, slug, port, allocated_at) VALUES (?, ?, ?, ?, ?, ?)",
              );
              const out = {};
              for (const name of names) {
                if (current.has(name)) {
                  out[name] = current.get(name);
                  continue;
                }
                insert.run(
                  key.repoKey,
                  key.worktreePath,
                  name,
                  String(slug),
                  chosen.get(name),
                  Date.now(),
                );
                out[name] = chosen.get(name);
              }
              return out;
            },
            { maxRetries: 1, baseDelayMs: 10 },
          );
          return result;
        } catch (error) {
          if (/UNIQUE|constraint/iu.test(String(error?.message))) {
            lastCollision = error;
            continue;
          }
          throw error;
        }
      } finally {
        await closeHeld(held);
      }
    }
    throw portsError(
      "ORK_PORTS_BUSY",
      `Could not reserve ports within ${budgetMs} ms${lastCollision ? " (repeated collisions)" : ""}`,
      lastCollision,
    );
  } catch (error) {
    throw classify(error);
  } finally {
    db.close();
  }
}

/** Ports for one worktree, ordered by name. A missing database reads as empty and is not created. */
export function listWorktreePorts({
  repoRoot,
  worktreePath,
  key: persistedKey,
  env = process.env,
} = {}) {
  const key = resolveKey({ repoRoot, worktreePath, key: persistedKey });
  const db = openReadable(env);
  if (!db) return [];
  try {
    return db
      .prepare(
        "SELECT slot AS name, port FROM ports WHERE repo_key = ? AND worktree_path = ? ORDER BY slot",
      )
      .all(key.repoKey, key.worktreePath)
      .map((row) => ({ name: row.name, port: row.port }));
  } catch (error) {
    throw classify(error);
  } finally {
    db.close();
  }
}

/** Release exactly one canonical identity. Safe to repeat; a missing database releases nothing. */
export function releaseWorktreePorts({
  repoRoot,
  worktreePath,
  key: persistedKey,
  env = process.env,
} = {}) {
  if (!existsSync(worktreePortsDbPath(env))) return { released: 0 };
  const key = resolveKey({ repoRoot, worktreePath, key: persistedKey });
  const probe = openReadable(env);
  if (!probe) return { released: 0 };
  probe.close();
  const db = openWritable(env);
  try {
    return withImmediateTransaction(db, () => {
      const result = db
        .prepare("DELETE FROM ports WHERE repo_key = ? AND worktree_path = ?")
        .run(key.repoKey, key.worktreePath);
      return { released: Number(result.changes) };
    });
  } catch (error) {
    throw classify(error);
  } finally {
    db.close();
  }
}
