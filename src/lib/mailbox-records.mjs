// Private mailbox records and their local notification projections share the room WAL transaction.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { MAILBOX_RECORDS } from "./coordination-private-schema.mjs";
import { withImmediateTransaction } from "./orkest-sqlite.mjs";
import { appendInTransaction } from "./outbox.mjs";

export function createMailboxTables(db) {
  db.exec(MAILBOX_RECORDS);
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._%~-]{0,381}$/u;
const MESSAGE_ID = /^[a-f0-9]+-[a-f0-9]{6}$/u;

function address({ collection, owner, key }, isList = false) {
  if (collection !== "peer" && collection !== "inbox") throw new Error("invalid_collection");
  if (collection === "peer" ? owner !== "" : !isKey(owner)) throw new Error("invalid_owner");
  if (
    !isList &&
    !(collection === "peer" ? isKey(key) : typeof key === "string" && MESSAGE_ID.test(key))
  )
    throw new Error("invalid_record_key");
}

function isKey(key) {
  return typeof key === "string" && SAFE_KEY.test(key);
}

export function recordSessionKey(session) {
  if (typeof session !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(session))
    return null;
  const key = session.replaceAll(":", "%3A");
  if (session === session.toLowerCase() && key.length <= 128) return key;
  return `${key.slice(0, 128)}~${createHash("sha1").update(session).digest("hex").slice(0, 10)}`;
}

export function checkRecord({ collection, owner, key, body }) {
  address({ collection, owner, key });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_body");
  if (collection === "peer") {
    if (body.schema !== "agent-executor.peer.v1" || recordSessionKey(body.session) !== key)
      throw new Error("peer_identity_mismatch");
  } else if (
    body.schema !== "agent-executor.mail.v1" ||
    body.id !== key ||
    recordSessionKey(body.to?.session) !== owner
  )
    throw new Error("message_identity_mismatch");
}

export function getRecord(db, req) {
  address(req);
  const { collection, owner, key } = req;
  const row = db.tagStore
    .get`SELECT body FROM mailbox_records WHERE collection=${collection} AND owner=${owner} AND key=${key}`;
  return row ? JSON.parse(row.body) : null;
}

export function listRecords(db, req) {
  address(req, true);
  const { collection, owner } = req;
  return db.tagStore
    .all`SELECT key,body,updated_ms FROM mailbox_records WHERE collection=${collection} AND owner=${owner} ORDER BY key`.map(
    (row) => ({ ...row, body: JSON.parse(row.body) }),
  );
}

export function inboxOwners(db) {
  return db.tagStore
    .all`SELECT DISTINCT owner FROM mailbox_records WHERE collection='inbox' ORDER BY owner`.map(
    (row) => row.owner,
  );
}

export function changeRecordInTransaction(db, op, req, updatedMs = Date.now()) {
  const { collection, owner, key } = req;
  const prior = getRecord(db, req);
  let body = req.body;
  if (op === "put") {
    checkRecord(req);
    if (collection === "inbox" && prior) {
      // Retrying an original send must never make an acknowledged message unread.
      const previousRead = prior.readAt;
      if (!isDeepStrictEqual({ ...prior, readAt: null }, { ...body, readAt: null }))
        throw new Error("message_content_conflict");
      if (previousRead) body = { ...body, readAt: previousRead };
    }
    if (isDeepStrictEqual(prior, body)) return prior;
    const value = JSON.stringify(body);
    db.tagStore
      .run`INSERT INTO mailbox_records(collection,owner,key,body,updated_ms) VALUES(${collection},${owner},${key},${value},${updatedMs})
      ON CONFLICT(collection,owner,key) DO UPDATE SET body=excluded.body,updated_ms=excluded.updated_ms`;
  } else if (op === "delete") {
    if (!prior || (req.expected !== undefined && !isDeepStrictEqual(req.expected, prior)))
      return false;
    db.tagStore
      .run`DELETE FROM mailbox_records WHERE collection=${collection} AND owner=${owner} AND key=${key}`;
  } else throw new Error("invalid_record_operation");
  const entity = createHash("sha256")
    .update(JSON.stringify([collection, owner, key]))
    .digest("hex");
  let state = "removed";
  if (op === "put") state = body.readAt ? "read" : "unread";
  appendInTransaction(db, {
    scope: "mailbox-local",
    kind: `mailbox.${collection}`,
    entity,
    body: collection === "peer" ? { present: op === "put" } : { state },
  });
  const scope = process.env.ORKEST_PRESENCE_SCOPE?.trim();
  if (
    collection === "peer" &&
    scope &&
    (op === "delete" || !prior || prior.lastSeenAt !== body.lastSeenAt)
  ) {
    const lastSeen = Date.parse(body?.lastSeenAt);
    if (op === "delete" || Number.isFinite(lastSeen)) {
      const observedAt = op === "delete" ? updatedMs : Math.min(lastSeen, updatedMs);
      appendInTransaction(db, {
        scope,
        kind: "peer.presence",
        entity,
        body: { present: op === "put", observedAt },
      });
    }
  }
  return op !== "put" || body;
}

export function changeRecord(db, op, req) {
  return withImmediateTransaction(db, () => changeRecordInTransaction(db, op, req));
}
