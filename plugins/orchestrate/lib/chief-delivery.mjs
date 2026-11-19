/**
 * @module chief-delivery
 *
 * Durable, bounded delivery state shared by every independent `ork` process that emits opted-in Chief
 * events. There is no daemon: each emitting process records the sanitized event here, then tries to take
 * the single drain lease. Only the lease holder delivers (itself, or through the one detached worker it
 * starts on the lease's behalf), so simultaneous CLIs never start more than one worker and never contact
 * a sink concurrently. Everything is one private SQLite file next to the opt-in config
 * (`<config basename>.state.sqlite`, 0600, in the already-verified 0700 config directory).
 *
 * Stored per event: id, event name, room id, PR number, original timestamp, per-sink acknowledgements,
 * drain-attempt count and a salted digest of the approved sink profile. Never stored: the source key,
 * URLs, tokens, paths, arguments, or any free-form text. The breaker and the lease live in the same file.
 *
 * Limits (all in {@link DELIVERY_LIMITS}):
 * - `pending` queued events (a further event is refused with `queue-full`, never evicting older work),
 *   `replay` delivered ids kept for duplicate suppression (oldest evicted first).
 * - A queued event is evicted after `pendingTtlMs`, or after `maxDrains` failed drain rounds.
 * - The lease lasts `leaseMs` unless renewed (and `spawnGraceMs` for a worker that is still starting), so a
 *   killed or never-started holder is recovered by the next emit.
 * - After `breakerFailures` consecutive failed events the breaker opens for `breakerMs`. A drain started
 *   while it is open delivers nothing; queued events replay when a later event starts a drain after it closes.
 * - A sink profile change (URL, token, command or arguments) discards queued events of the old profile;
 *   they are never sent to the new sinks.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";

import { migrateSchema, openOrkestSqlite, withImmediateTransaction } from "./orkest-sqlite.mjs";

/** Dedicated SQLite application id (0x4f4b4348): a file carrying any other identity is never touched. */
export const DELIVERY_APPLICATION_ID = 1_330_332_488;

export const DELIVERY_LIMITS = Object.freeze({
  pending: 32,
  replay: 256,
  maxDrains: 5,
  pendingTtlMs: 24 * 60 * 60 * 1000,
  leaseMs: 20_000,
  spawnGraceMs: 10_000,
  drainBudgetMs: 45_000,
  breakerFailures: 3,
  breakerMs: 60_000,
  busyMs: 2000,
  admissionMs: 300,
});

const SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  room_id TEXT NOT NULL,
  pr_number INTEGER,
  at TEXT NOT NULL,
  profile TEXT NOT NULL,
  state TEXT NOT NULL,
  acked TEXT NOT NULL DEFAULT '[]',
  drains INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL
) STRICT;
`;

export function deliveryStatePath(configFile) {
  const base = path.basename(configFile).replace(/\.[^.]*$/u, "") || "chief-bridge";
  return path.join(path.dirname(configFile), `${base}.state.sqlite`);
}

const rowToPayload = (row) => ({
  schema: "ork.chief.event.v1",
  id: row.id,
  event: row.event,
  at: row.at,
  roomId: row.room_id,
  ...(row.pr_number != null && { prNumber: row.pr_number }),
});

const MIGRATIONS = [(db) => db.exec(SCHEMA)];

/**
 * Refuses a pre-existing file that is not ours, before anything (WAL, chmod, DDL, rows) can change it.
 * Only a missing or completely empty database may be adopted.
 */
function assertAdoptable(file) {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!info.isFile() || (uid !== null && info.uid !== uid))
    throw new Error("delivery state must be a user-owned regular file");
  if (info.size === 0) return;
  const probe = openOrkestSqlite(file, { readOnly: true, timeout: 100 });
  try {
    const read = (sql) => Object.values(probe.prepare(sql).get())[0];
    const identity = read("PRAGMA application_id");
    const version = read("PRAGMA user_version");
    if (identity === DELIVERY_APPLICATION_ID) {
      if (version > MIGRATIONS.length) throw new Error("delivery state is from a newer version");
      return;
    }
    const objects = read("SELECT COUNT(*) FROM sqlite_master");
    if (identity === 0 && version === 0 && objects === 0) return;
    throw new Error("delivery state path holds a different database");
  } finally {
    probe.close();
  }
}

/**
 * Opens (creating if needed) the delivery state. Throws when the file is unusable, foreign or contended
 * past `admissionMs`; callers treat that as "delivery unavailable" and leave tracked state untouched.
 * With `admissionMs` every database wait in this process shares that one small budget, apart from
 * any sink deadline, so a busy file can never hold a CLI. Without it (the worker) `busyMs` applies per step.
 */
export function openDeliveryStore(file, { clock = Date.now, limits = {}, admissionMs } = {}) {
  const lim = { ...DELIVERY_LIMITS, ...limits };
  const budgetEnds = admissionMs === undefined ? null : Date.now() + admissionMs;
  assertAdoptable(file);
  const db = openOrkestSqlite(file, {
    timeout: budgetEnds === null ? lim.busyMs : Math.max(1, Math.floor(admissionMs / 6)),
    synchronous: "NORMAL",
  });
  const setBusy = (ms) => db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(ms))}`);
  try {
    const info = lstatSync(file);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isFile() || (uid !== null && info.uid !== uid) || (info.mode & 0o077) !== 0)
      throw new Error("delivery state must be a private user-owned regular file");
    migrateSchema(db, { applicationId: DELIVERY_APPLICATION_ID, migrations: MIGRATIONS });
  } catch (error) {
    db.close();
    throw error;
  }
  const now = () => Number(clock());
  const tx = (fn) => {
    if (budgetEnds === null)
      return withImmediateTransaction(db, fn, { maxRetries: 8, baseDelayMs: 10 });
    const left = budgetEnds - Date.now();
    if (left <= 0) throw new Error("delivery state is busy");
    setBusy(left);
    return withImmediateTransaction(db, fn, { maxRetries: 0 });
  };
  const getMeta = (key) => db.prepare("SELECT v FROM meta WHERE k = ?").get(key)?.v ?? null;
  const setMeta = (key, value) =>
    db
      .prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(key, String(value));

  const salt = () => {
    let value = getMeta("salt");
    if (!value) {
      value = randomBytes(16).toString("hex");
      tx(() => {
        if (!getMeta("salt")) setMeta("salt", value);
      });
      value = getMeta("salt");
    }
    return value;
  };

  /** Salted digest of the approved sinks (credentials included), so any change is a different profile. */
  const fingerprint = (cfg) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          salt(),
          cfg.webhook ? [cfg.webhook.url, cfg.webhook.bearerToken ?? null] : null,
          cfg.command ? [cfg.command.path, cfg.command.args] : null,
          [...cfg.events].toSorted((left, right) => left.localeCompare(right)),
        ]),
      )
      .digest("hex")
      .slice(0, 32);

  /** Caller already holds the write transaction. */
  const purge = (profile) => {
    const stamp = now();
    db.prepare(
      "DELETE FROM events WHERE state = 'pending' AND (profile != ? OR created_ms < ? OR drains >= ?)",
    ).run(profile, stamp - lim.pendingTtlMs, lim.maxDrains);
    db.prepare(
      `DELETE FROM events WHERE state = 'sent' AND seq NOT IN
         (SELECT seq FROM events WHERE state = 'sent' ORDER BY seq DESC LIMIT ?)`,
    ).run(lim.replay);
  };

  const pendingRows = (profile) =>
    db
      .prepare("SELECT * FROM events WHERE state = 'pending' AND profile = ? ORDER BY seq LIMIT ?")
      .all(profile, lim.pending);

  const breakerOpenUntil = () => Number(getMeta("breaker_until") ?? 0);

  const isLeaseHeldBy = (token) =>
    getMeta("lease_token") === token && Number(getMeta("lease_until") ?? 0) > now();

  return {
    limits: lim,
    fingerprint,
    newToken: () => randomBytes(12).toString("hex"),

    /**
     * Records a sanitized payload under the approved profile. A known delivered id is a duplicate; a known
     * pending id keeps its stored timestamp and acknowledgements. A full queue refuses the newcomer.
     */
    enqueue(payload, profile) {
      return tx(() => {
        purge(profile);
        const known = db.prepare("SELECT * FROM events WHERE id = ?").get(payload.id);
        if (known && known.profile === profile) {
          return {
            status: known.state === "sent" ? "duplicate" : "queued",
            payload: rowToPayload(known),
          };
        }
        if (known) db.prepare("DELETE FROM events WHERE id = ?").run(payload.id);
        const count = db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE state = 'pending' AND profile = ?")
          .get(profile).n;
        if (count >= lim.pending) return { status: "dropped", reason: "queue-full" };
        db.prepare(
          `INSERT INTO events (id, event, room_id, pr_number, at, profile, state, created_ms)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(
          payload.id,
          payload.event,
          payload.roomId,
          payload.prNumber ?? null,
          payload.at,
          profile,
          now(),
        );
        return { status: "queued", payload };
      });
    },

    /** Takes the single drain lease unless another live holder has it. `ttlMs` is the lease length. */
    acquireLease(token, ttlMs = lim.leaseMs) {
      return tx(() => {
        const holder = getMeta("lease_token");
        if (holder && holder !== token && Number(getMeta("lease_until") ?? 0) > now()) return false;
        setMeta("lease_token", token);
        setMeta("lease_until", now() + ttlMs);
        return true;
      });
    },

    /** Extends the lease; false when it was lost, in which case the caller must stop contacting sinks. */
    renewLease(token, ttlMs = lim.leaseMs) {
      return tx(() => {
        if (!isLeaseHeldBy(token)) return false;
        setMeta("lease_until", now() + ttlMs);
        return true;
      });
    },

    /** Gives the lease up unconditionally (a worker that could not start, or a finished drain). */
    abandonLease(token) {
      tx(() => {
        if (getMeta("lease_token") === token) setMeta("lease_until", 0);
      });
    },

    /** Queued work for the profile that is not in `tried`, oldest first, or [] while the breaker is open. */
    due(profile, tried = new Set()) {
      if (breakerOpenUntil() > now()) return [];
      return pendingRows(profile).filter((row) => !tried.has(row.id));
    },

    /**
     * Releases the lease only when nothing is left to do, in the same write transaction that an enqueue
     * needs, so an event recorded just before the release is seen and one recorded just after finds the
     * lease free and starts the next drain.
     */
    releaseWhenIdle(token, profile, tried) {
      return tx(() => {
        if (getMeta("lease_token") !== token) return true;
        if (breakerOpenUntil() <= now() && pendingRows(profile).some((row) => !tried.has(row.id)))
          return false;
        setMeta("lease_until", 0);
        return true;
      });
    },

    acked: (id) =>
      JSON.parse(db.prepare("SELECT acked FROM events WHERE id = ?").get(id)?.acked ?? "[]"),

    /** Persists one sink's acknowledgement at once, so a crash or restart never re-contacts that sink. */
    ack(id, sink) {
      tx(() => {
        const row = db.prepare("SELECT acked FROM events WHERE id = ?").get(id);
        if (!row) return;
        const list = new Set(JSON.parse(row.acked));
        list.add(sink);
        db.prepare("UPDATE events SET acked = ? WHERE id = ?").run(JSON.stringify([...list]), id);
      });
    },

    /** Records the outcome of one drain round for an event and feeds the breaker. */
    settle(id, isSent) {
      tx(() => {
        if (isSent) {
          db.prepare("UPDATE events SET state = 'sent' WHERE id = ?").run(id);
          setMeta("breaker_failures", 0);
          return;
        }
        db.prepare("UPDATE events SET drains = drains + 1 WHERE id = ?").run(id);
        const failures = Number(getMeta("breaker_failures") ?? 0) + 1;
        if (failures >= lim.breakerFailures) {
          setMeta("breaker_failures", 0);
          setMeta("breaker_until", now() + lim.breakerMs);
        } else setMeta("breaker_failures", failures);
      });
    },

    status(id) {
      const row = db.prepare("SELECT state, acked FROM events WHERE id = ?").get(id);
      return row ? { state: row.state, delivered: JSON.parse(row.acked) } : null;
    },

    isBreakerOpen: () => breakerOpenUntil() > now(),
    counts: () => ({
      pending: db.prepare("SELECT COUNT(*) AS n FROM events WHERE state = 'pending'").get().n,
      sent: db.prepare("SELECT COUNT(*) AS n FROM events WHERE state = 'sent'").get().n,
    }),
    close: () => db.close(),
  };
}

/**
 * Delivers queued events while this process holds the lease. `deliverRow(payload, {acked, ack, renew})`
 * returns true once every sink acknowledged (or null when `renew()` failed). Each event gets one round per drain; the lease is renewed
 * before every round and the loop ends when the lease is lost, the breaker opens or the budget is spent.
 */
export async function drainQueue(store, { token, profile, deliverRow, clock = Date.now }) {
  const tried = new Set();
  const deadline = Number(clock()) + store.limits.drainBudgetMs;
  const renew = () => store.renewLease(token);
  try {
    for (;;) {
      if (!renew()) return { lost: true, tried };
      const [row] = Number(clock()) > deadline ? [] : store.due(profile, tried);
      if (!row) {
        if (Number(clock()) > deadline || store.releaseWhenIdle(token, profile, tried)) break;
        continue;
      }
      tried.add(row.id);
      let isSent = false;
      try {
        isSent = await deliverRow(rowToPayload(row), {
          acked: new Set(store.acked(row.id)),
          ack: (sink) => store.ack(row.id, sink),
          renew,
        });
      } catch {
        isSent = false;
      }
      // null: the lease was lost mid-round, so another holder owns the outcome.
      if (isSent === null) return { lost: true, tried };
      if (store.status(row.id)) store.settle(row.id, isSent === true);
    }
  } finally {
    store.abandonLease(token);
  }
  return { lost: false, tried };
}
