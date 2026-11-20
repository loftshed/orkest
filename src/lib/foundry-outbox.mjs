/**
 * Foundry's canonical state: one private row per worktree in the shared rooms SQLite database,
 * committed in the same immediate transaction as the redacted `foundry.transition` event.
 *
 * Private tables (strict, never exported): foundry_states, foundry_ops.
 * Exported wire shape (room-bound only, no paths, names, native IDs or content):
 *   foundry.transition  entity = opaque 32-hex key
 *   body = { revision, status, attempt, attemptStatus, pr }
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ensureFoundryTables } from "./coordination-private-schema.mjs";
import { mailboxRoot, openRooms, roomsDbPath } from "./horde-room.mjs";
import { openOrkestSqlite, withImmediateTransaction } from "./orkest-sqlite.mjs";
import { appendInTransaction, assertOwner, fail, identifier, localStream } from "./outbox.mjs";

const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
/** Product lifecycle strings only; anything else (including user-supplied text) exports as "other". */
const STATUSES = new Set([
  "abandoned",
  "completed",
  "escalated",
  "gate_failed",
  "launch_uncertain",
  "launching",
  "merged",
  "needs_human",
  "noop",
  "pr_closed",
  "pr_conflict",
  "pr_creating",
  "pr_lookup_failed",
  "pr_opened",
  "pr_unverified",
  "review_changes_requested",
  "running",
  "scope_violated",
  "stale",
  "verification_failed",
  "verified",
  "worker_failed",
]);
const ATTEMPT_STATUSES = new Set(["launching", "running", "finished", "failed", "uncertain"]);
const PR_STATES = new Set(["OPEN", "MERGED", "CLOSED", "UNKNOWN"]);

export function foundryRoot(options = {}) {
  return options.root ?? mailboxRoot(options.env ?? process.env);
}

/** Opaque, stable key for one worktree state location. It never leaves the process. */
export function foundryStateKey(statePath) {
  return createHash("sha256").update(`ork.foundry.state\0${statePath}`).digest("hex").slice(0, 32);
}

function hash(...parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

/** Canonical record for a worktree key, or null. Never creates or migrates the database. */
export function readFoundryRow(root, key, identity) {
  if (!existsSync(roomsDbPath(root))) return null;
  const db = openOrkestSqlite(roomsDbPath(root), { readOnly: true });
  try {
    const table = db.tagStore
      .get`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='foundry_states'`;
    if (!table) return null;
    const row = db.tagStore
      .get`SELECT identity, revision, state FROM foundry_states WHERE key=${key}`;
    if (!row || row.identity !== identity) return null;
    return { revision: row.revision, state: JSON.parse(row.state) };
  } finally {
    db.close();
  }
}

function transitionBody(state, revision) {
  const status = STATUSES.has(state.status) ? state.status : "other";
  const attemptStatus = ATTEMPT_STATUSES.has(state.attempt?.status) ? state.attempt.status : null;
  const attempt =
    Number.isSafeInteger(state.attemptCount) && state.attemptCount >= 0 ? state.attemptCount : 0;
  const pr = PR_STATES.has(state.pr?.state) ? state.pr.state : null;
  return { revision, status, attempt, attemptStatus, pr };
}

function isSameTransition(left, right) {
  return ["status", "attempt", "attemptStatus", "pr"].every(
    (field) => left[field] === right[field],
  );
}

/**
 * Commit one state transition atomically. `legacy` is the validated pre-promotion file state (or
 * null); it is only consulted when no canonical row exists, so a stale legacy file is never
 * re-read after promotion. `build(prior)` returns the next state and may throw to abort.
 */
export function commitFoundryState(
  root,
  {
    key,
    statePath,
    identity,
    owningRoomId,
    exclusive = false,
    legacy = null,
    operationId,
    expectedRevision,
    patch,
    build,
    onCommit,
  },
) {
  using db = openRooms(root);
  return withImmediateTransaction(db, () => {
    ensureFoundryTables(db);
    const row = db.tagStore
      .get`SELECT identity, revision, state FROM foundry_states WHERE key=${key}`;
    const isLive = row?.identity === identity;
    const scope =
      typeof owningRoomId === "string" && ROOM_ID.test(owningRoomId)
        ? `room:${owningRoomId}`
        : null;
    let requestJson;
    if (operationId !== undefined) {
      identifier(operationId);
      requestJson = JSON.stringify({
        identity,
        scope,
        exclusive,
        expectedRevision: expectedRevision ?? null,
        patch,
      });
      // Earlier prerelease profiles recorded only the revision. Preserve those rows and fail
      // closed when asked to replay a command whose request and result cannot be established.
      const seen = db.tagStore
        .get`SELECT revision, receipt FROM foundry_ops WHERE key=${key} AND op=${operationId}`;
      if (seen) {
        if (!seen.receipt) fail("legacy_operation_receipt_unavailable");
        const receipt = JSON.parse(seen.receipt);
        if (!isDeepStrictEqual(receipt.request, JSON.parse(requestJson))) fail("content_conflict");
        return { state: receipt.state, revision: seen.revision, replayed: true };
      }
    }
    if (scope) {
      const stream = localStream(db, scope);
      assertOwner(db, { ...stream, kind: "room.summary", entity: owningRoomId });
      assertOwner(db, {
        ...stream,
        kind: "foundry.transition",
        entity: key,
        expectedRevision,
      });
    } else if (expectedRevision !== undefined) {
      throw new Error("A Foundry transition revision requires a confirmed room");
    }
    const prior = isLive ? JSON.parse(row.state) : legacy;
    if (exclusive && (isLive || legacy)) {
      throw Object.assign(new Error("Foundry state already exists"), { code: "EEXIST" });
    }
    const state = build(prior);
    const revision = (row?.revision ?? 0) + 1;
    const json = JSON.stringify(state);
    db.tagStore
      .run`INSERT INTO foundry_states(key, state_path, identity, revision, state, updated_at)
      VALUES(${key}, ${statePath}, ${identity}, ${revision}, ${json}, ${state.updatedAt ?? new Date().toISOString()})
      ON CONFLICT(key) DO UPDATE SET identity=excluded.identity, revision=excluded.revision,
        state=excluded.state, updated_at=excluded.updated_at`;
    if (operationId !== undefined) {
      db.tagStore
        .run`INSERT INTO foundry_ops(key, op, revision, receipt) VALUES(${key}, ${operationId}, ${revision}, json_object('request', json(${requestJson}), 'state', json(${json})))`;
    }
    if (scope) {
      const body = transitionBody(state, revision);
      if (!prior || !isSameTransition(transitionBody(prior, 0), body)) {
        emitRedacted(db, {
          scope,
          kind: "foundry.transition",
          entity: key,
          body,
          id: `ft:${hash(key, operationId ?? `rev:${revision}`)}`,
        });
      }
    }
    onCommit?.(db, prior, state);
    return { state, revision, replayed: false };
  });
}

/** Append a redacted event through the shared owner API, inside the caller's transaction. */
export function emitRedacted(db, event) {
  return appendInTransaction(db, event);
}

/** Write staged legacy files and destinations for explicit restoration. Never touch the Git admin paths. */
export function exportLegacyFoundryStates(db, destinationRoot) {
  const present = db.tagStore
    .get`SELECT 1 AS n FROM sqlite_schema WHERE name='foundry_states' AND type='table'`;
  if (!present || !db.tagStore.get`SELECT 1 FROM foundry_states LIMIT 1`)
    return { states: 0, manifest: null };
  const directory = path.join(destinationRoot, "foundry-rollback");
  mkdirSync(directory, { mode: 0o700 });
  const entries = [];
  for (const row of db
    .prepare("SELECT key,state_path,identity,revision,state FROM foundry_states ORDER BY key")
    .iterate()) {
    if (row.key !== foundryStateKey(row.state_path) || !path.isAbsolute(row.state_path))
      throw new Error("Invalid private Foundry state destination");
    const file = row.key + ".json";
    writeFileSync(path.join(directory, file), row.state + "\n", { flag: "wx", mode: 0o600 });
    entries.push({
      file,
      destination: row.state_path,
      identity: row.identity,
      revision: row.revision,
    });
  }
  const manifest = "foundry-rollback/manifest.json";
  writeFileSync(
    path.join(destinationRoot, manifest),
    JSON.stringify({ version: 1, entries }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return { states: entries.length, manifest };
}
