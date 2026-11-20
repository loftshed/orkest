import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { withImmediateTransaction } from "./orkest-sqlite.mjs";
import {
  CHECKPOINT_LIFETIME_MS,
  isExportableScope,
  observationFreshness,
  validPayload,
} from "./outbox-policy.mjs";

export const MAX_PAGE = 512;
export const MAX_BYTES = 4 * 1024 * 1024;

export function fail(code) {
  throw Object.assign(new Error(code), { code });
}

export function identifier(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > 256 ||
    [...value].some((c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127)
  )
    fail("invalid_identifier");
  return value;
}

export function integer(value, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("invalid_range");
  return value;
}

export function installEventProjection(db) {
  db.exec(`CREATE TRIGGER IF NOT EXISTS outbox_project_event AFTER INSERT ON outbox_events BEGIN
    INSERT INTO outbox_views(origin,epoch,scope,kind,entity,seq,body)
    VALUES(NEW.origin,NEW.epoch,NEW.scope,NEW.kind,NEW.entity,NEW.seq,NEW.body)
    ON CONFLICT(origin,epoch,scope,kind,entity) DO UPDATE SET seq=excluded.seq,body=excluded.body
    WHERE excluded.seq > outbox_views.seq;
  END`);
}

export function createOutbox(db) {
  db.exec(`
    CREATE TABLE outbox_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), origin TEXT NOT NULL, epoch TEXT NOT NULL) STRICT;
    CREATE TABLE outbox_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, epoch TEXT NOT NULL,
      scope TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
      version INTEGER NOT NULL, entity TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
      UNIQUE (origin,epoch,scope,seq), UNIQUE(origin,epoch,scope,id)
    ) STRICT;
    CREATE TABLE outbox_cursors (
      peer TEXT NOT NULL, scope TEXT NOT NULL, origin TEXT NOT NULL, epoch TEXT NOT NULL,
      through INTEGER NOT NULL, PRIMARY KEY(peer,scope,origin,epoch)
    ) STRICT;
    CREATE TABLE outbox_views (
      origin TEXT NOT NULL, epoch TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
      entity TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(origin,epoch,scope,kind,entity)
    ) STRICT;
  `);
  installEventProjection(db);
  db.tagStore.run`INSERT INTO outbox_identity VALUES (1,${randomUUID()},${randomUUID()})`;
}

export function localStream(db, scope) {
  identifier(scope);
  return { ...db.tagStore.get`SELECT origin, epoch FROM outbox_identity WHERE singleton=1`, scope };
}

export function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) fail("invalid_event");
  for (const field of ["origin", "epoch", "scope", "id", "entity"]) identifier(event[field]);
  if (event.version !== 1) fail("unsupported_version");
  if (!validPayload(event)) fail("unsupported_payload");
  integer(event.seq, 1);
  if (
    Object.keys(event).length !== 9 ||
    !event.body ||
    typeof event.body !== "object" ||
    Array.isArray(event.body)
  )
    fail("invalid_event");
}

export function fromRow(row) {
  return { ...row, body: JSON.parse(row.body) };
}

export function assertOwner(db, { origin, epoch, scope, kind, entity, expectedRevision }) {
  if (kind !== "room.summary" && kind !== "foundry.transition") return;
  const owner = db.tagStore
    .get`SELECT origin,epoch,seq FROM outbox_views WHERE scope=${scope} AND kind=${kind} AND entity=${entity} LIMIT 1`;
  if (!owner) {
    if (expectedRevision !== undefined && expectedRevision !== 0) fail("revision_conflict");
    return;
  }
  const isForeignOwner = owner.origin !== origin || owner.epoch !== epoch;
  const isStaleRevision = expectedRevision !== undefined && expectedRevision !== owner.seq;
  if (!isForeignOwner && !isStaleRevision) return;
  const code = isForeignOwner ? "owner_conflict" : "revision_conflict";
  throw Object.assign(
    new Error(`${code} owner=${owner.origin} epoch=${owner.epoch} required_revision=${owner.seq}`),
    {
      code,
      owner: owner.origin,
      epoch: owner.epoch,
      requiredRevision: owner.seq,
    },
  );
}

export function persist(db, event, { replayOnly = false } = {}) {
  const { origin, epoch, scope, seq, id, kind, version, entity, body } = event;
  const prior = db.tagStore
    .get`SELECT origin,epoch,scope,seq,id,kind,version,entity,body FROM outbox_events
    WHERE origin=${origin} AND epoch=${epoch} AND scope=${scope} AND (seq=${seq} OR id=${id})`;
  if (prior) {
    if (!isDeepStrictEqual({ ...fromRow(prior) }, { ...event })) fail("content_conflict");
    return false;
  }
  if (replayOnly) return false;
  assertOwner(db, event);
  const json = JSON.stringify(body);
  db.tagStore.run`INSERT INTO outbox_events(origin,epoch,scope,seq,id,kind,version,entity,body)
    VALUES(${origin},${epoch},${scope},${seq},${id},${kind},${version},${entity},${json})`;
  return true;
}

/** Caller owns the same immediate transaction as the originating state transition. */
export function appendInTransaction(db, { scope, kind, entity, body, id = randomUUID() }) {
  if (!db.isTransaction) fail("transaction_required");
  const stream = localStream(db, scope);
  const { origin, epoch } = stream;
  const prior = db.tagStore
    .get`SELECT seq FROM outbox_events WHERE origin=${origin} AND epoch=${epoch} AND scope=${scope} AND id=${id}`;
  const seq =
    prior?.seq ??
    db.tagStore
      .get`SELECT COALESCE(MAX(seq),0)+1 AS seq FROM outbox_events WHERE origin=${origin} AND epoch=${epoch} AND scope=${scope}`
      .seq;
  const event = { ...stream, seq, id, kind, version: 1, entity, body };
  validateEvent(event);
  persist(db, event);
  return event;
}

/** Count each encoded row once. Header length includes the changing cursor and more flag. */
export function boundedAppender(page, field, maxBytes) {
  if (Buffer.byteLength(JSON.stringify(page)) > maxBytes) fail("page_too_small");
  let payloadBytes = 0;
  return (row, through, more) => {
    const extra = Buffer.byteLength(JSON.stringify(row)) + (page[field].length > 0 ? 1 : 0);
    const envelope = { ...page, [field]: [], through, more };
    if (Buffer.byteLength(JSON.stringify(envelope)) + payloadBytes + extra > maxBytes) {
      if (page[field].length === 0) fail("page_too_small");
      page.more = true;
      return false;
    }
    page[field].push(row);
    page.through = through;
    page.more = more;
    payloadBytes += extra;
    return true;
  };
}

export function readPage(db, { origin, epoch, scope, after, limit, max_bytes: maxBytes }) {
  const stream = localStream(db, scope);
  if (!isExportableScope(scope)) fail("private_scope");
  if (origin !== stream.origin) fail("stream_mismatch");
  if (epoch !== stream.epoch) fail("epoch_mismatch");
  integer(after, 0);
  integer(limit, 1, MAX_PAGE);
  integer(maxBytes, 1, MAX_BYTES);
  const tip = db.tagStore
    .get`SELECT COALESCE(MAX(seq),0) AS tip FROM outbox_events WHERE origin=${origin} AND epoch=${epoch} AND scope=${scope}`
    .tip;
  if (after < Math.max(0, tip - 4096)) {
    const active = db.tagStore
      .get`SELECT high_water FROM outbox_snapshots WHERE scope=${scope} AND created_ms>${Date.now() - CHECKPOINT_LIFETIME_MS}`;
    if (!active || after < active.high_water) fail("cursor_expired");
  }
  if (after > tip) fail("cursor_ahead");
  const page = { ...stream, after, through: after, more: after < tip, events: [] };
  const append = boundedAppender(page, "events", maxBytes);
  const rows = db.tagStore
    .iterate`SELECT origin,epoch,scope,seq,id,kind,version,entity,body FROM outbox_events
    WHERE origin=${origin} AND epoch=${epoch} AND scope=${scope} AND seq>${after} AND seq<=${tip} ORDER BY seq LIMIT ${limit}`;
  for (const row of rows) {
    const event = fromRow(row);
    if (!append(event, event.seq, event.seq < tip)) break;
  }
  return page;
}

export function readCursor(db, { peer, scope, origin, epoch }) {
  for (const value of [peer, scope, origin, epoch]) identifier(value);
  return (
    db.tagStore
      .get`SELECT through FROM outbox_cursors WHERE peer=${peer} AND scope=${scope} AND origin=${origin} AND epoch=${epoch}`
      ?.through ?? 0
  );
}

export function applyPage(db, { peer, scope, page }) {
  if (
    !page ||
    page.scope !== scope ||
    !Array.isArray(page.events) ||
    typeof page.more !== "boolean"
  )
    fail("invalid_page");
  if (page.events.length > MAX_PAGE || Buffer.byteLength(JSON.stringify(page)) > MAX_BYTES)
    fail("page_too_large");
  if (!isExportableScope(scope)) fail("private_scope");
  const { origin, epoch, after, through } = page;
  integer(after, 0);
  integer(through, after);
  if (through - after !== page.events.length || (page.more && page.events.length === 0))
    fail("sequence_gap");
  if (origin === localStream(db, scope).origin) fail("local_origin");
  return withImmediateTransaction(db, () => {
    const cursor = readCursor(db, { peer, scope, origin, epoch });
    if (after > cursor) fail("sequence_gap");
    let applied = 0;
    for (const [index, event] of page.events.entries()) {
      validateEvent(event);
      if (
        event.origin !== origin ||
        event.epoch !== epoch ||
        event.scope !== scope ||
        event.seq !== after + index + 1
      )
        fail("stream_mismatch");
      if (persist(db, event, { replayOnly: event.seq <= cursor })) applied++;
    }
    const next = Math.max(cursor, through);
    db.tagStore.run`INSERT INTO outbox_cursors VALUES(${peer},${scope},${origin},${epoch},${next})
      ON CONFLICT(peer,scope,origin,epoch) DO UPDATE SET through=excluded.through`;
    return { through: next, applied, replayed: page.events.length - applied };
  });
}

/** Read a projection as observed on one origin; imported views confer no local execution authority. */
export function readView(db, { origin, epoch, scope, kind, entity }, now = Date.now()) {
  for (const value of [origin, epoch, scope, kind, entity]) identifier(value);
  const row = db.tagStore
    .get`SELECT seq, body FROM outbox_views WHERE origin=${origin} AND epoch=${epoch}
    AND scope=${scope} AND kind=${kind} AND entity=${entity}`;
  if (!row) return null;
  const result = fromRow(row);
  if (kind === "peer.presence" || kind === "monitor.quota") {
    const receipt = db.tagStore
      .get`SELECT received_ms FROM outbox_receipts WHERE origin=${origin} AND epoch=${epoch} AND scope=${scope} AND kind=${kind} AND entity=${entity}`;
    result.freshness = observationFreshness(kind, result.body, receipt?.received_ms ?? 0, now);
  }
  return result;
}
