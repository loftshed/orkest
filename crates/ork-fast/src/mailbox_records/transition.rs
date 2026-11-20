//! Peer mutations and inbox acknowledgements share the WAL event projection with the JS writer.
use super::{Collection, READ_BUSY_MS, StoreError, StoreResult, sql_get};
use crate::{paths, sha256, sqlite};
use rusqlite::{OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::path::Path;

fn append(
    tx: &Transaction<'_>,
    scope: &str,
    kind: &str,
    entity: &str,
    body: &Value,
) -> rusqlite::Result<()> {
    let count = tx.execute(
        "INSERT INTO outbox_events(origin,epoch,scope,seq,id,kind,version,entity,body)
         SELECT origin,epoch,?1,1+COALESCE((SELECT MAX(seq) FROM outbox_events e WHERE
          e.origin=i.origin AND e.epoch=i.epoch AND e.scope=?1),0),lower(hex(randomblob(16))),?2,1,?3,?4
         FROM outbox_identity i WHERE singleton=1",
        params![scope,kind,entity,body.to_string()],
    )?;
    if count != 1 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

fn identity_matches(value: &Value, expected: &str) -> bool {
    value
        .as_str()
        .and_then(|session| paths::session_key(session).ok())
        .as_deref()
        == Some(expected)
}

struct Event {
    kind: &'static str,
    body: Value,
    presence: Option<(String, i64)>,
}

fn event_for(collection: Collection, prior: Option<&Value>, next: &Value) -> Option<Event> {
    if collection == Collection::Inbox {
        let mut prior = prior?.clone();
        // Other puts (including retries of previously acknowledged sends) use the general writer.
        if !prior.is_object() || prior.get("readAt").is_some_and(paths::is_truthy_json) {
            return None;
        }
        prior["readAt"] = next.get("readAt")?.clone();
        return (prior == *next).then(|| Event {
            kind: "mailbox.inbox",
            body: json!({"state":"read"}),
            presence: None,
        });
    }
    let mut event = Event {
        kind: "mailbox.peer",
        body: json!({"present":true}),
        presence: None,
    };
    if prior.and_then(|v| v.get("lastSeenAt")) == next.get("lastSeenAt") {
        return Some(event);
    }
    let scope = std::env::var("ORKEST_PRESENCE_SCOPE").unwrap_or_default();
    if scope.is_empty() {
        return Some(event);
    }
    // The general writer handles scopes and timestamp formats outside the native subset.
    if scope.len() > 256
        || scope.starts_with("local:")
        || matches!(scope.as_str(), "mailbox-local" | "rooms-local")
        || !scope
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":._-".contains(&b))
    {
        return None;
    }
    let stamp = next["lastSeenAt"].as_str()?;
    let seconds = paths::parse_iso8601_utc_secs(stamp)?;
    if seconds <= 0 || paths::format_utc_iso_z(seconds) != stamp {
        return None;
    }
    event.presence = Some((scope, seconds * 1000));
    Some(event)
}

pub(super) fn put(
    base: &Path,
    collection: Collection,
    owner: &str,
    key: &str,
    next: &Value,
) -> StoreResult<bool> {
    let eligible = match collection {
        Collection::Peer => paths::valid_peer(next) && identity_matches(&next["session"], key),
        Collection::Inbox => {
            paths::valid_message(next)
                && next["id"].as_str() == Some(key)
                && identity_matches(&next["to"]["session"], owner)
                && next["readAt"].as_str().is_some_and(|s| !s.is_empty())
        }
    };
    if !eligible {
        return Ok(false);
    }
    let existing = sql_get(base, collection, owner, key)?;
    if matches!(existing, Some(None)) {
        return Err(StoreError::Invalid);
    }
    let prior = existing.flatten();
    if prior.as_ref() == Some(next) {
        return Ok(true);
    }
    let Some(event) = event_for(collection, prior.as_ref(), next) else {
        return Ok(false);
    };
    commit(
        base,
        collection.as_str(),
        owner,
        key,
        prior.as_ref(),
        next,
        event,
    )
}

fn commit(
    base: &Path,
    collection: &str,
    owner: &str,
    key: &str,
    prior: Option<&Value>,
    next: &Value,
    event: Event,
) -> StoreResult<bool> {
    if sqlite::deadline_expired() {
        return Err(StoreError::Deadline);
    }
    let mut conn = sqlite::open_existing(
        &base.join("rooms.db"),
        sqlite::busy_budget_ms(READ_BUSY_MS),
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )
    .ok_or(StoreError::Unavailable)?;
    // FULL matches the general SQLite writer. Never create a store or promote one here.
    conn.create_scalar_function(
        "orkest_digest",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC
            | rusqlite::functions::FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| Ok(sha256::sha256_hex(ctx.get_raw(0).as_str()?.as_bytes())),
    )
    .map_err(|_| StoreError::Unavailable)?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|_| StoreError::Unavailable)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| StoreError::Unavailable)?;
    let (app, version): (i64, i64) = tx
        .query_row(
            "SELECT application_id,user_version FROM pragma_application_id,pragma_user_version",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| StoreError::Unavailable)?;
    if app != sqlite::ROOMS_APPLICATION_ID || version > sqlite::ROOMS_SCHEMA_VERSION {
        return Err(StoreError::Invalid);
    }
    if version < 10 {
        return Ok(false);
    }
    let ready: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM mailbox_cutover WHERE singleton=1) AND
            EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='outbox_project_event')",
        [], |row| row.get(0),
    ).map_err(|_| StoreError::Invalid)?;
    if !ready {
        return Err(StoreError::Invalid);
    }
    let stored: Option<String> = tx
        .query_row(
            "SELECT body FROM mailbox_records WHERE collection=?1 AND owner=?2 AND key=?3",
            [collection, owner, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| StoreError::Unavailable)?;
    let stored = stored
        .map(|s| serde_json::from_str::<Value>(&s))
        .transpose()
        .map_err(|_| StoreError::Invalid)?;
    if stored.as_ref() != prior {
        return Err(StoreError::Unavailable);
    }
    let now: i64 = tx
        .query_row(
            "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)",
            [],
            |row| row.get(0),
        )
        .map_err(|_| StoreError::Unavailable)?;
    let count = tx.execute(
        "INSERT INTO mailbox_records(collection,owner,key,body,updated_ms) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(collection,owner,key) DO UPDATE SET body=excluded.body,updated_ms=excluded.updated_ms",
        params![collection,owner,key,next.to_string(),now],
    ).map_err(|_|StoreError::Unavailable)?;
    if count != 1 {
        return Err(StoreError::Unavailable);
    }
    let entity = sha256::sha256_hex(json!([collection, owner, key]).to_string().as_bytes());
    append(&tx, "mailbox-local", event.kind, &entity, &event.body)
        .map_err(|_| StoreError::Unavailable)?;
    if let Some((scope, observed_at)) = event.presence {
        append(
            &tx,
            &scope,
            "peer.presence",
            &entity,
            &json!({"present":true,"observedAt":now.min(observed_at)}),
        )
        .map_err(|_| StoreError::Unavailable)?;
    }
    if sqlite::deadline_expired() {
        return Err(StoreError::Deadline);
    }
    tx.commit().map_err(|_| StoreError::Unavailable)?;
    Ok(true)
}
