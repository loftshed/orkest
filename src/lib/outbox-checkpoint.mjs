import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { withImmediateTransaction } from "./orkest-sqlite.mjs";
import { CHECKPOINT_LIFETIME_MS, isExportableScope } from "./outbox-policy.mjs";
import {
  boundedAppender,
  fail,
  fromRow,
  identifier,
  integer,
  localStream,
  MAX_BYTES,
  MAX_PAGE,
  persist,
  readCursor,
  validateEvent,
} from "./outbox.mjs";

export function sweepExpiredStaging(db) {
  const expiredBefore = Date.now() - CHECKPOINT_LIFETIME_MS;
  if (db.tagStore.get`SELECT 1 FROM outbox_staging WHERE touched_ms<=${expiredBefore} LIMIT 1`) {
    db.tagStore.run`DELETE FROM outbox_staging WHERE touched_ms<=${expiredBefore}`;
  }
}

export function createCheckpointTables(db) {
  db.exec(`
    CREATE INDEX outbox_entity_history ON outbox_events(origin,epoch,scope,kind,entity,seq);
    CREATE TABLE outbox_snapshots(scope TEXT PRIMARY KEY, checkpoint TEXT NOT NULL, high_water INTEGER NOT NULL, created_ms INTEGER NOT NULL) STRICT;
    CREATE TABLE outbox_staging (
      peer TEXT NOT NULL, scope TEXT NOT NULL, origin TEXT NOT NULL, epoch TEXT NOT NULL,
      checkpoint TEXT NOT NULL, high_water INTEGER NOT NULL, through INTEGER NOT NULL,
      PRIMARY KEY(peer,scope,origin,epoch)
    ) STRICT;
    CREATE TABLE outbox_staged_rows (
      peer TEXT NOT NULL, scope TEXT NOT NULL, origin TEXT NOT NULL, epoch TEXT NOT NULL,
      position INTEGER NOT NULL, event TEXT NOT NULL,
      PRIMARY KEY(peer,scope,origin,epoch,position),
      FOREIGN KEY(peer,scope,origin,epoch) REFERENCES outbox_staging ON DELETE CASCADE
    ) STRICT;
  `);
}

/** Immutable event history pins the view at high_water even while new commands commit. */
export function readCheckpoint(
  db,
  { scope, origin, epoch, checkpoint = null, after = 0, limit, max_bytes: maxBytes },
) {
  const stream = localStream(db, scope);
  if (!isExportableScope(scope)) fail("private_scope");
  if (origin !== stream.origin) fail("stream_mismatch");
  if (epoch !== stream.epoch) fail("epoch_mismatch");
  integer(after, 0);
  integer(limit, 1, MAX_PAGE);
  integer(maxBytes, 1, MAX_BYTES);
  if (checkpoint === null && after !== 0) fail("sequence_gap");
  const now = Date.now();
  const generation = withImmediateTransaction(db, () => {
    const high_water = db.tagStore
      .get`SELECT COALESCE(MAX(seq),0) AS tip FROM outbox_events WHERE origin=${origin} AND epoch=${epoch} AND scope=${scope}`
      .tip;
    const saved = db.tagStore
      .get`SELECT checkpoint,high_water,created_ms FROM outbox_snapshots WHERE scope=${scope}`;
    if (
      saved &&
      now - saved.created_ms < CHECKPOINT_LIFETIME_MS &&
      (checkpoint === null || checkpoint === saved.checkpoint)
    )
      return saved;
    if (checkpoint !== null) fail("checkpoint_expired");
    const id = randomUUID();
    db.tagStore.run`INSERT INTO outbox_snapshots VALUES(${scope},${id},${high_water},${now})
      ON CONFLICT(scope) DO UPDATE SET checkpoint=excluded.checkpoint,high_water=excluded.high_water,created_ms=excluded.created_ms`;
    return { checkpoint: id, high_water };
  });
  const { high_water } = generation;
  const page = {
    ...stream,
    checkpoint: generation.checkpoint,
    high_water,
    after,
    through: after,
    more: false,
    rows: [],
  };
  const rows = db.tagStore
    .iterate`SELECT e.origin,e.epoch,e.scope,e.seq,e.id,e.kind,e.version,e.entity,e.body FROM outbox_events e
    WHERE e.origin=${origin} AND e.epoch=${epoch} AND e.scope=${scope} AND e.seq<=${high_water}
    AND NOT EXISTS (SELECT 1 FROM outbox_events newer WHERE newer.origin=e.origin AND newer.epoch=e.epoch AND newer.scope=e.scope
      AND newer.kind=e.kind AND newer.entity=e.entity AND newer.seq>e.seq AND newer.seq<=${high_water})
    ORDER BY e.seq LIMIT ${limit + 1} OFFSET ${after}`;
  const append = boundedAppender(page, "rows", maxBytes);
  for (const row of rows) {
    if (page.rows.length === limit) {
      page.more = true;
      break;
    }
    if (!append(fromRow(row), page.through + 1, false)) break;
  }
  if (after > 0 && page.rows.length === 0) fail("sequence_gap");
  return page;
}

export function readCheckpointProgress(db, { peer, scope, origin, epoch }) {
  for (const v of [peer, scope, origin, epoch]) identifier(v);
  sweepExpiredStaging(db);
  return (
    db.tagStore
      .get`SELECT checkpoint,through FROM outbox_staging WHERE peer=${peer} AND scope=${scope} AND origin=${origin} AND epoch=${epoch}` ??
    null
  );
}

export function applyCheckpoint(db, { peer, scope, page }) {
  if (!page || page.scope !== scope || !Array.isArray(page.rows) || typeof page.more !== "boolean")
    fail("invalid_page");
  if (!isExportableScope(scope)) fail("private_scope");
  const { origin, epoch, checkpoint, high_water, after, through } = page;
  for (const v of [peer, scope, origin, epoch, checkpoint]) identifier(v);
  integer(high_water, 0);
  integer(after, 0);
  integer(through, after, high_water);
  if (through - after !== page.rows.length || (page.more && page.rows.length === 0))
    fail("sequence_gap");
  if (page.rows.length > MAX_PAGE || Buffer.byteLength(JSON.stringify(page)) > MAX_BYTES)
    fail("page_too_large");
  if (origin === localStream(db, scope).origin) fail("local_origin");
  for (const event of page.rows) {
    validateEvent(event);
    if (
      event.origin !== origin ||
      event.scope !== scope ||
      event.epoch !== epoch ||
      event.seq > high_water
    )
      fail("stream_mismatch");
  }
  return withImmediateTransaction(db, () => {
    const cursor = readCursor(db, { peer, scope, origin, epoch });
    if (high_water <= cursor) {
      for (const event of page.rows) persist(db, event, { replayOnly: true });
      db.tagStore
        .run`DELETE FROM outbox_staging WHERE peer=${peer} AND scope=${scope} AND origin=${origin} AND epoch=${epoch} AND high_water<=${cursor}`;
      return { through, high_water: cursor, complete: true };
    }
    sweepExpiredStaging(db);
    let staging = db.tagStore
      .get`SELECT checkpoint,high_water,through FROM outbox_staging WHERE peer=${peer} AND scope=${scope} AND origin=${origin} AND epoch=${epoch}`;
    if (!staging || staging.checkpoint !== checkpoint) {
      if (after !== 0 || (staging && staging.high_water > high_water)) fail("checkpoint_expired");
      db.tagStore
        .run`DELETE FROM outbox_staging WHERE peer=${peer} AND scope=${scope} AND origin=${origin} AND epoch=${epoch}`;
      db.tagStore
        .run`INSERT INTO outbox_staging VALUES(${peer},${scope},${origin},${epoch},${checkpoint},${high_water},0,${Date.now()})`;
      staging = { checkpoint, high_water, through: 0 };
    }
    if (high_water !== staging.high_water || after > staging.through) fail("sequence_gap");
    for (const [index, event] of page.rows.entries()) {
      const position = after + index + 1;
      if (position <= staging.through) {
        const prior = db.tagStore
          .get`SELECT event FROM outbox_staged_rows WHERE peer=${peer} AND scope=${scope} AND origin=${origin} AND epoch=${epoch} AND position=${position}`;
        if (!prior || !isDeepStrictEqual(JSON.parse(prior.event), event)) fail("content_conflict");
      } else {
        db.tagStore
          .run`INSERT INTO outbox_staged_rows VALUES(${peer},${scope},${origin},${epoch},${position},${JSON.stringify(event)})`;
      }
    }
    const received = Math.max(staging.through, through);
    db.tagStore
      .run`UPDATE outbox_staging SET through=${received},touched_ms=${Date.now()} WHERE peer=${peer} AND scope=${scope} AND origin=${origin} AND epoch=${epoch}`;
    if (page.more) return { through: received, high_water, complete: false };
    if (received !== through) fail("sequence_gap");
    let last = 0;
    const rows = db.tagStore
      .iterate`SELECT event FROM outbox_staged_rows WHERE peer=${peer} AND scope=${scope} AND origin=${origin} AND epoch=${epoch} ORDER BY position`;
    for (const row of rows) {
      const event = JSON.parse(row.event);
      if (event.seq <= last) fail("sequence_gap");
      last = event.seq;
      persist(db, event);
    }
    if (last !== high_water) fail("sequence_gap");
    db.tagStore
      .run`INSERT INTO outbox_cursors VALUES(${peer},${scope},${origin},${epoch},${high_water})
      ON CONFLICT(peer,scope,origin,epoch) DO UPDATE SET through=excluded.through`;
    db.tagStore
      .run`DELETE FROM outbox_staging WHERE peer=${peer} AND scope=${scope} AND origin=${origin} AND epoch=${epoch}`;
    return { through, high_water, complete: true };
  });
}
