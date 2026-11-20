//! Peer and inbox records for one mailbox root, on either store.
//!
//! An active root (`mailbox-sqlite-v1`, with `peers` and `inbox` replaced by writer-fence
//! files) keeps its records in `rooms.db` (`mailbox_records`): reads go straight to SQLite,
//! bounded by the operation deadline. Peer updates and existing-message acknowledgements commit natively; other
//! writes go through `bin/mailbox-records.mjs`. Both commit the record and its outbox in one
//! transaction. A root with neither marker keeps the legacy `peers/<key>.json` and
//! `inbox/<key>/<id>.json` files. A pending migration, a broken fence or a recreated legacy
//! directory fails closed: nothing here then reads or writes the legacy files.

use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::{paths, sqlite};

mod transition;

/// The committed private marker that switches a root to the SQLite store.
pub const MARKER: &str = "mailbox-sqlite-v1";
/// Present while a migration is parking the legacy directories.
pub const PENDING: &str = "mailbox-sqlite-pending-v1";
/// The exact content of the active marker and of the `peers` and `inbox` fence files.
pub const FENCE: &str = "Orkest mailbox SQLite v1. Upgrade this writer; the original records are in mailbox-legacy-v1.\n";
const FENCED: [&str; 2] = ["peers", "inbox"];
/// Record locks on an active root (the legacy names are fence files there).
const LOCK_DIR: &str = "mailbox-locks";
/// The oldest rooms schema that carries `mailbox_records`. A schema newer than this build
/// knows ([`sqlite::ROOMS_SCHEMA_VERSION`]) fails closed, and the reads name every column
/// they use, so a changed table shape fails closed too.
const MIN_RECORDS_SCHEMA: i64 = 4;
const BRIDGE_NAME: &str = "mailbox-records.mjs";
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(10);
const READ_BUSY_MS: u64 = 2000;
const MAX_KEY_BYTES: usize = 256;

/// Which store holds a root's records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// No marker: the legacy JSON files.
    Legacy,
    /// The marker and both writer fences are intact: `rooms.db`.
    Sqlite,
    /// A pending migration, a broken marker or fence, or a recreated legacy directory.
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// The marker is unusable, or `rooms.db` is not an Orkest store.
    Invalid,
    /// The store could not be opened or read.
    Unavailable,
    /// The operation deadline passed.
    Deadline,
    /// A legacy record directory does not exist.
    Missing,
    /// A key or owner is not a valid record name.
    BadKey,
    /// The bridge failed, timed out, or answered with the wrong shape.
    Bridge(String),
}

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Collection {
    Peer,
    Inbox,
}

impl Collection {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Peer => "peer",
            Self::Inbox => "inbox",
        }
    }
}

/// One record: its key (the legacy file stem) and its body, `None` when it does not parse.
#[derive(Debug, Clone)]
pub struct Record {
    pub key: String,
    pub body: Option<Value>,
    /// `false` when a legacy file exists but could not be read (an incomplete scan).
    pub readable: bool,
}

/// Every peer record of a root, ordered like the legacy sorted `peers/*.json` paths.
#[derive(Debug, Clone, Default)]
pub struct PeerListing {
    pub records: Vec<Record>,
}

impl PeerListing {
    #[must_use]
    pub fn has_key(&self, key: &str) -> bool {
        self.records.iter().any(|r| r.key == key)
    }

    /// Whether this record is the one its own session resolves to, or no record does.
    #[must_use]
    pub fn is_canonical(&self, key: &str, session: &str) -> bool {
        match paths::session_key(session) {
            Ok(canon) => canon == key || !self.has_key(&canon),
            Err(_) => false,
        }
    }

    /// Parsed bodies, in order, skipping unreadable records.
    pub fn bodies(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.records
            .iter()
            .filter_map(|r| r.body.as_ref().map(|b| (r.key.as_str(), b)))
    }
}

/// Whether `path` is this user's regular fence file with exactly [`FENCE`] in it.
fn is_fence(path: &Path) -> bool {
    use std::os::unix::fs::OpenOptionsExt;
    let Ok(mut file) = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    else {
        return false;
    };
    let Ok(meta) = file.metadata() else {
        return false;
    };
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.len() != FENCE.len() as u64
    {
        return false;
    }
    let mut text = String::new();
    file.read_to_string(&mut text).is_ok() && text == FENCE
}

#[must_use]
pub fn backend(base: &Path) -> Backend {
    match fs::symlink_metadata(base.join(MARKER)) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => return Backend::Invalid,
        Ok(_) => {
            let fenced = FENCED.iter().all(|name| is_fence(&base.join(name)));
            return if is_fence(&base.join(MARKER)) && fenced {
                Backend::Sqlite
            } else {
                Backend::Invalid
            };
        }
    }
    match fs::symlink_metadata(base.join(PENDING)) {
        Err(e) if e.kind() == ErrorKind::NotFound => Backend::Legacy,
        _ => Backend::Invalid,
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key != "."
        && key != ".."
        && !key.ends_with(".json")
        && !key.chars().any(|c| c == '/' || c == '\\' || c.is_control())
}

fn owner_for(collection: Collection, owner: &str) -> StoreResult<&str> {
    match collection {
        Collection::Peer if owner.is_empty() => Ok(owner),
        Collection::Inbox if valid_key(owner) => Ok(owner),
        _ => Err(StoreError::BadKey),
    }
}

fn legacy_dir(base: &Path, collection: Collection, owner: &str) -> PathBuf {
    match collection {
        Collection::Peer => base.join("peers"),
        Collection::Inbox => base.join("inbox").join(owner),
    }
}

/// A legacy record's file.
fn lock_target(base: &Path, collection: Collection, owner: &str, key: &str) -> PathBuf {
    legacy_dir(base, collection, owner).join(format!("{key}.json"))
}

/// The lock that serializes a record's read-modify-write: `<key>.lock` beside the legacy
/// file, or under `mailbox-locks/` once the legacy names are fence files.
fn record_lock(
    base: &Path,
    collection: Collection,
    owner: &str,
    key: &str,
) -> io::Result<paths::FileLockGuard> {
    if !valid_key(key) || owner_for(collection, owner).is_err() {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "invalid record key",
        ));
    }
    let target = match backend(base) {
        Backend::Legacy => lock_target(base, collection, owner, key),
        Backend::Sqlite => {
            let mut dir = base.join(LOCK_DIR).join(collection.as_str());
            if !owner.is_empty() {
                dir = dir.join(owner);
            }
            dir.join(format!("{key}.json"))
        }
        Backend::Invalid => {
            return Err(io::Error::new(
                ErrorKind::PermissionDenied,
                "mailbox store fenced",
            ));
        }
    };
    paths::lock_for(&target)
}

// -------------------------------------------------------------------------
// SQLite reads
// -------------------------------------------------------------------------

fn open_store(base: &Path) -> StoreResult<rusqlite::Connection> {
    if sqlite::deadline_expired() {
        return Err(StoreError::Deadline);
    }
    let db = base.join("rooms.db");
    match fs::symlink_metadata(&db) {
        Ok(meta) if meta.file_type().is_file() => {}
        Ok(_) => return Err(StoreError::Invalid),
        Err(_) => return Err(StoreError::Unavailable),
    }
    let conn = sqlite::open_readonly(&db, sqlite::busy_budget_ms(READ_BUSY_MS))
        .ok_or(StoreError::Unavailable)?;
    let pragma = |name: &str| -> StoreResult<i64> {
        conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0))
            .map_err(|_| StoreError::Unavailable)
    };
    let (app_id, version) = (pragma("application_id")?, pragma("user_version")?);
    if app_id != sqlite::ROOMS_APPLICATION_ID
        || !(MIN_RECORDS_SCHEMA..=sqlite::ROOMS_SCHEMA_VERSION).contains(&version)
    {
        return Err(StoreError::Invalid);
    }
    // The cutover row commits with the imported records; without it the store is not ready.
    let ready: Option<i64> = conn
        .query_row(
            "SELECT singleton FROM mailbox_cutover WHERE singleton = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|_| StoreError::Invalid)?;
    if ready != Some(1) {
        return Err(StoreError::Invalid);
    }
    Ok(conn)
}

fn parse_body(text: Option<String>) -> Option<Value> {
    text.and_then(|t| serde_json::from_str::<Value>(&t).ok())
}

fn sql_get(
    base: &Path,
    collection: Collection,
    owner: &str,
    key: &str,
) -> StoreResult<Option<Option<Value>>> {
    let conn = open_store(base)?;
    let mut stmt = conn
        .prepare(
            "SELECT body FROM mailbox_records WHERE collection = ?1 AND owner = ?2 AND key = ?3",
        )
        .map_err(|_| StoreError::Unavailable)?;
    let mut rows = stmt
        .query([collection.as_str(), owner, key])
        .map_err(|_| StoreError::Unavailable)?;
    match rows.next() {
        Ok(Some(row)) => {
            let text: Option<String> = row.get(0).map_err(|_| StoreError::Unavailable)?;
            Ok(Some(parse_body(text)))
        }
        Ok(None) => Ok(None),
        Err(_) => Err(StoreError::Unavailable),
    }
}

/// `(owner, record)` rows of one collection, for one owner or all of them.
fn sql_list(
    base: &Path,
    collection: Collection,
    owner: Option<&str>,
) -> StoreResult<Vec<(String, Record)>> {
    let conn = open_store(base)?;
    let (sql, args): (&str, Vec<&str>) = match owner {
        Some(o) => (
            "SELECT owner, key, body FROM mailbox_records WHERE collection = ?1 AND owner = ?2",
            vec![collection.as_str(), o],
        ),
        None => (
            "SELECT owner, key, body FROM mailbox_records WHERE collection = ?1",
            vec![collection.as_str()],
        ),
    };
    let mut stmt = conn.prepare(sql).map_err(|_| StoreError::Unavailable)?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(args))
        .map_err(|_| StoreError::Unavailable)?;
    let mut out = Vec::new();
    loop {
        if sqlite::deadline_expired() {
            return Err(StoreError::Deadline);
        }
        match rows.next() {
            Ok(Some(row)) => {
                let owner: String = row.get(0).map_err(|_| StoreError::Unavailable)?;
                let key: String = row.get(1).map_err(|_| StoreError::Unavailable)?;
                let text: Option<String> = row.get(2).map_err(|_| StoreError::Unavailable)?;
                out.push((
                    owner,
                    Record {
                        key,
                        body: parse_body(text),
                        readable: true,
                    },
                ));
            }
            Ok(None) => break,
            Err(_) => return Err(StoreError::Unavailable),
        }
    }
    out.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| format!("{}.json", a.1.key).cmp(&format!("{}.json", b.1.key)))
    });
    Ok(out)
}

// -------------------------------------------------------------------------
// Bridge writes
// -------------------------------------------------------------------------

#[cfg(test)]
pub(crate) type TestBridge = fn(&Path, &str, &Value) -> StoreResult<Value>;

#[cfg(test)]
thread_local! {
    static TEST_BRIDGE: std::cell::Cell<Option<TestBridge>> = const { std::cell::Cell::new(None) };
    static TEST_BRIDGE_PATH: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Route this thread's bridge calls to `bridge` until the guard drops.
#[cfg(test)]
pub(crate) struct TestBridgeGuard(Option<TestBridge>);

#[cfg(test)]
impl Drop for TestBridgeGuard {
    fn drop(&mut self) {
        TEST_BRIDGE.with(|b| b.set(self.0));
    }
}

#[cfg(test)]
#[must_use]
pub(crate) fn set_test_bridge(bridge: Option<TestBridge>) -> TestBridgeGuard {
    TestBridgeGuard(TEST_BRIDGE.with(|b| b.replace(bridge)))
}

fn bridge_path() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(p) = TEST_BRIDGE_PATH.with(|b| b.borrow().clone()) {
        return Some(p);
    }
    sqlite::plugin_bin_path(BRIDGE_NAME)
}

fn bridge_timeout() -> StoreResult<Duration> {
    if sqlite::deadline_expired() {
        return Err(StoreError::Deadline);
    }
    let left = Duration::from_millis(sqlite::busy_budget_ms(u64::MAX));
    Ok(BRIDGE_TIMEOUT.min(left))
}

/// `node bin/mailbox-records.mjs <operation> <root>`, JSON request in, JSON response out.
pub fn bridge(base: &Path, operation: &str, request: &Value) -> StoreResult<Value> {
    let timeout = bridge_timeout()?;
    #[cfg(test)]
    if let Some(f) = TEST_BRIDGE.with(std::cell::Cell::get) {
        return f(base, operation, request);
    }
    let script = bridge_path().ok_or_else(|| StoreError::Bridge("missing".into()))?;
    let payload = serde_json::to_vec(request).map_err(|_| StoreError::Bridge("encode".into()))?;
    let mut child = Command::new(paths::node_binary())
        .arg(script)
        .arg(operation)
        .arg(base)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| StoreError::Bridge("spawn".into()))?;
    let stdin = child.stdin.take();
    let writer = std::thread::spawn(move || {
        if let Some(mut s) = stdin {
            let _ = s.write_all(&payload);
        }
    });
    let mut stdout_pipe = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(s) = stdout_pipe.as_mut() {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    });
    let mut stderr_pipe = child.stderr.take();
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(s) = stderr_pipe.as_mut() {
            let _ = s.take(4096).read_to_end(&mut buf);
        }
        buf
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(2));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let _ = writer.join();
    let stdout = reader.join().unwrap_or_default();
    let _ = err_reader.join();
    let Some(status) = status else {
        return Err(StoreError::Bridge("timeout".into()));
    };
    if !status.success() {
        return Err(StoreError::Bridge(format!("exit {:?}", status.code())));
    }
    serde_json::from_slice(&stdout).map_err(|_| StoreError::Bridge("response".into()))
}

fn bridge_put(
    base: &Path,
    collection: Collection,
    owner: &str,
    key: &str,
    body: &Value,
) -> StoreResult<Value> {
    if !body.is_object() {
        return Err(StoreError::Bridge("body".into()));
    }
    let stored = bridge(
        base,
        "put",
        &json!({"collection": collection.as_str(), "owner": owner, "key": key, "body": body}),
    )?;
    if stored.is_object() {
        Ok(stored)
    } else {
        Err(StoreError::Bridge("response".into()))
    }
}

fn bridge_delete(base: &Path, collection: Collection, owner: &str, key: &str) -> StoreResult<bool> {
    bridge(
        base,
        "delete",
        &json!({"collection": collection.as_str(), "owner": owner, "key": key}),
    )?
    .as_bool()
    .ok_or_else(|| StoreError::Bridge("response".into()))
}

// -------------------------------------------------------------------------
// Generic record operations
// -------------------------------------------------------------------------

fn active(base: &Path) -> StoreResult<bool> {
    match backend(base) {
        Backend::Legacy => Ok(false),
        Backend::Sqlite => Ok(true),
        Backend::Invalid => Err(StoreError::Invalid),
    }
}

fn read_legacy_file(path: &Path) -> StoreResult<Option<Option<Value>>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(serde_json::from_str(&text).ok())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err(StoreError::Unavailable),
    }
}

/// `Ok(None)`: no record. `Ok(Some(None))`: a record whose body does not parse.
pub fn get_raw(
    base: &Path,
    collection: Collection,
    owner: &str,
    key: &str,
) -> StoreResult<Option<Option<Value>>> {
    let owner = owner_for(collection, owner)?;
    if !valid_key(key) {
        return Err(StoreError::BadKey);
    }
    if active(base)? {
        sql_get(base, collection, owner, key)
    } else {
        read_legacy_file(&lock_target(base, collection, owner, key))
    }
}

/// A record's parsed body, `None` for a missing, unreadable or unparseable record.
#[must_use]
pub fn get(base: &Path, collection: Collection, owner: &str, key: &str) -> Option<Value> {
    get_raw(base, collection, owner, key)
        .ok()
        .flatten()
        .flatten()
}

/// The records of one owner, ordered like the legacy sorted file paths.
pub fn list(base: &Path, collection: Collection, owner: &str) -> StoreResult<Vec<Record>> {
    let owner = owner_for(collection, owner)?;
    if active(base)? {
        return Ok(sql_list(base, collection, Some(owner))?
            .into_iter()
            .map(|(_, r)| r)
            .collect());
    }
    let dir = legacy_dir(base, collection, owner);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == ErrorKind::NotFound => return Err(StoreError::Missing),
        Err(_) => return Err(StoreError::Unavailable),
    };
    let mut files: Vec<PathBuf> = Vec::new();
    let mut entry_failed = false;
    for entry in entries {
        let Ok(entry) = entry else {
            entry_failed = true;
            continue;
        };
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("json") {
            files.push(p);
        }
    }
    files.sort();
    // An entry the directory scan could not return marks the listing incomplete, as an
    // unreadable record with no key.
    let mut out = Vec::new();
    if entry_failed {
        out.push(Record {
            key: String::new(),
            body: None,
            readable: false,
        });
    }
    for p in files {
        if sqlite::deadline_expired() {
            return Err(StoreError::Deadline);
        }
        let Some(key) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let (body, readable) = match fs::read_to_string(&p) {
            Ok(text) => (serde_json::from_str(&text).ok(), true),
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(_) => (None, false),
        };
        out.push(Record {
            key: key.to_string(),
            body,
            readable,
        });
    }
    Ok(out)
}

/// Store a record: an atomic file replace, or one bridge transaction.
pub fn put(
    base: &Path,
    collection: Collection,
    owner: &str,
    key: &str,
    body: &Value,
) -> StoreResult<()> {
    let owner = owner_for(collection, owner)?;
    if !valid_key(key) {
        return Err(StoreError::BadKey);
    }
    if active(base)? {
        if transition::put(base, collection, owner, key, body)? {
            return Ok(());
        }
        bridge_put(base, collection, owner, key, body).map(|_| ())
    } else {
        paths::write_json_atomic(&lock_target(base, collection, owner, key), body)
            .map_err(|_| StoreError::Unavailable)
    }
}

/// Remove a record, reporting whether one existed.
pub fn delete(base: &Path, collection: Collection, owner: &str, key: &str) -> StoreResult<bool> {
    let owner = owner_for(collection, owner)?;
    if !valid_key(key) {
        return Err(StoreError::BadKey);
    }
    if active(base)? {
        bridge_delete(base, collection, owner, key)
    } else {
        match fs::remove_file(lock_target(base, collection, owner, key)) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
            Err(_) => Err(StoreError::Unavailable),
        }
    }
}

// -------------------------------------------------------------------------
// Peers
// -------------------------------------------------------------------------

/// Hold a peer's record lock across its read-modify-write.
pub fn lock_peer(base: &Path, session: &str) -> io::Result<paths::FileLockGuard> {
    let key =
        paths::session_key(session).map_err(|e| io::Error::new(ErrorKind::InvalidInput, e))?;
    record_lock(base, Collection::Peer, "", &key)
}

/// A session's peer record (`mailbox.load(peer_path(...))`).
#[must_use]
pub fn read_peer(base: &Path, session: &str) -> Option<Value> {
    let key = paths::session_key(session).ok()?;
    get(base, Collection::Peer, "", &key)
}

/// Like [`read_peer`], but tells a missing record from an unreadable one.
pub fn read_peer_checked(base: &Path, session: &str) -> StoreResult<Option<Option<Value>>> {
    let key = paths::session_key(session).map_err(|_| StoreError::BadKey)?;
    get_raw(base, Collection::Peer, "", &key)
}

pub fn list_peers(base: &Path) -> StoreResult<PeerListing> {
    list(base, Collection::Peer, "").map(|records| PeerListing { records })
}

pub fn write_peer(base: &Path, session: &str, peer: &Value) -> StoreResult<()> {
    let key = paths::session_key(session).map_err(|_| StoreError::BadKey)?;
    put(base, Collection::Peer, "", &key, peer)
}

pub fn delete_peer(base: &Path, session: &str) -> StoreResult<bool> {
    let key = paths::session_key(session).map_err(|_| StoreError::BadKey)?;
    delete(base, Collection::Peer, "", &key)
}

/// Read, mutate and store a valid peer under its lock; `mutate` returns whether to write.
pub fn update_peer<F>(base: &Path, session: &str, mutate: F) -> Option<Value>
where
    F: FnOnce(&mut serde_json::Map<String, Value>) -> bool,
{
    let _guard = lock_peer(base, session).ok()?;
    let mut peer = read_peer(base, session)?;
    if !paths::valid_peer(&peer) {
        return None;
    }
    if !mutate(peer.as_object_mut()?) {
        return None;
    }
    write_peer(base, session, &peer).ok()?;
    Some(peer)
}

// -------------------------------------------------------------------------
// Inboxes
// -------------------------------------------------------------------------

pub fn lock_message(base: &Path, session: &str, id: &str) -> io::Result<paths::FileLockGuard> {
    let owner =
        paths::session_key(session).map_err(|e| io::Error::new(ErrorKind::InvalidInput, e))?;
    record_lock(base, Collection::Inbox, &owner, id)
}

pub fn read_message_checked(
    base: &Path,
    session: &str,
    id: &str,
) -> StoreResult<Option<Option<Value>>> {
    let owner = paths::session_key(session).map_err(|_| StoreError::BadKey)?;
    get_raw(base, Collection::Inbox, &owner, id)
}

#[must_use]
pub fn read_message(base: &Path, session: &str, id: &str) -> Option<Value> {
    let owner = paths::session_key(session).ok()?;
    get(base, Collection::Inbox, &owner, id)
}

/// A session's inbox records, ordered like the legacy sorted file paths.
pub fn list_messages(base: &Path, session: &str) -> StoreResult<Vec<Record>> {
    let owner = paths::session_key(session).map_err(|_| StoreError::BadKey)?;
    list(base, Collection::Inbox, &owner)
}

pub fn write_message(base: &Path, session: &str, id: &str, msg: &Value) -> StoreResult<()> {
    let owner = paths::session_key(session).map_err(|_| StoreError::BadKey)?;
    put(base, Collection::Inbox, &owner, id, msg)
}

pub fn delete_message(base: &Path, session: &str, id: &str) -> StoreResult<bool> {
    let owner = paths::session_key(session).map_err(|_| StoreError::BadKey)?;
    delete(base, Collection::Inbox, &owner, id)
}

/// Every inbox record of every recipient (`inbox/*/*.json`), unreadable ones skipped.
pub fn all_messages(base: &Path) -> StoreResult<Vec<Value>> {
    if active(base)? {
        return Ok(sql_list(base, Collection::Inbox, None)?
            .into_iter()
            .filter_map(|(_, r)| r.body)
            .collect());
    }
    let mut out = Vec::new();
    let Ok(session_dirs) = fs::read_dir(base.join("inbox")) else {
        return Ok(out);
    };
    for s_entry in session_dirs.flatten() {
        let s_path = s_entry.path();
        if !s_path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(s_path) else {
            continue;
        };
        for f_entry in files.flatten() {
            let p = f_entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("json")
                && let Some(msg) = paths::read_json_file(&p)
            {
                out.push(msg);
            }
        }
    }
    Ok(out)
}

/// Unread messages in a session's inbox; `valid` also requires the mail schema.
#[must_use]
pub fn count_unread(base: &Path, session: &str, valid: bool, stop_at_first: bool) -> usize {
    let Ok(records) = list_messages(base, session) else {
        return 0;
    };
    let mut n = 0;
    for msg in records.iter().filter_map(|r| r.body.as_ref()) {
        let shaped = if valid {
            paths::valid_message(msg)
        } else {
            msg.is_object()
        };
        if shaped && !msg.get("readAt").is_some_and(paths::is_truthy_json) {
            n += 1;
            if stop_at_first {
                break;
            }
        }
    }
    n
}

#[must_use]
pub fn has_unread(base: &Path, session: &str) -> bool {
    count_unread(base, session, true, true) > 0
}

// -------------------------------------------------------------------------
// Entry-point activation
// -------------------------------------------------------------------------

fn dir_has_entries(dir: &Path, json_only: bool) -> bool {
    match fs::read_dir(dir) {
        Err(e) if e.kind() == ErrorKind::NotFound => false,
        Err(_) => true,
        Ok(entries) => entries.into_iter().any(|e| match e {
            Err(_) => true,
            Ok(entry) => {
                !json_only || entry.path().extension().and_then(|x| x.to_str()) == Some("json")
            }
        }),
    }
}

/// Whether a root is missing or an empty directory: the only roots `ensure` activates.
#[must_use]
pub fn is_new_root(base: &Path) -> bool {
    match fs::symlink_metadata(base) {
        Err(e) => e.kind() == ErrorKind::NotFound,
        Ok(meta) => meta.is_dir() && !dir_has_entries(base, false),
    }
}

/// At a public entrypoint, let the bridge activate a genuinely empty, new root, or finish a
/// fresh-root activation that was interrupted.
///
/// A root with legacy records keeps its legacy store until an explicit migration, and a
/// new root whose bridge cannot answer keeps today's behaviour.
pub fn ensure_at_entrypoint(base: &Path) -> Backend {
    let current = backend(base);
    let interrupted = current == Backend::Invalid
        && fs::symlink_metadata(base.join(MARKER)).is_err()
        && fs::symlink_metadata(base.join(PENDING)).is_ok();
    if current == Backend::Sqlite
        || !(interrupted || (current == Backend::Legacy && is_new_root(base)))
    {
        return current;
    }
    let _ = bridge(base, "ensure", &json!({}));
    backend(base)
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A stand-in for `bin/mailbox-records.mjs` that writes `mailbox_records` directly.

    use super::*;
    use rusqlite::Connection;

    /// Create an active SQLite root as the bridge's cutover leaves it: `rooms.db` with
    /// `mailbox_records` and the cutover row, the `peers`/`inbox` fences, then the marker.
    pub fn activate(base: &Path) {
        fs::create_dir_all(base).unwrap();
        let conn = Connection::open(base.join("rooms.db")).unwrap();
        conn.execute_batch(&format!(
            "PRAGMA journal_mode=WAL; PRAGMA application_id={}; PRAGMA user_version={};
             CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, cwd TEXT NOT NULL,
               updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS mailbox_records(collection TEXT NOT NULL, owner TEXT NOT NULL,
               key TEXT NOT NULL, body TEXT NOT NULL, updated_ms INTEGER NOT NULL,
               PRIMARY KEY(collection, owner, key));
             CREATE TABLE IF NOT EXISTS mailbox_cutover(singleton INTEGER PRIMARY KEY, digest TEXT NOT NULL);
             INSERT OR IGNORE INTO mailbox_cutover VALUES (1, 'test');",
            sqlite::ROOMS_APPLICATION_ID,
            9 // The bridge test fixture models the pre-trigger mailbox schema.
        ))
        .unwrap();
        for name in [FENCED[0], FENCED[1], MARKER] {
            fs::write(base.join(name), FENCE).unwrap();
        }
    }

    fn field<'a>(req: &'a Value, name: &str) -> StoreResult<&'a str> {
        req.get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| StoreError::Bridge(format!("missing {name}")))
    }

    fn is_message_id(key: &str) -> bool {
        key.split_once('-').is_some_and(|(a, b)| {
            !a.is_empty()
                && b.len() == 6
                && a.bytes()
                    .chain(b.bytes())
                    .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
        })
    }

    /// `checkRecord` from `lib/mailbox-records.mjs`: the bridge refuses mismatched identities.
    fn check_record(c: &str, o: &str, k: &str, body: &Value) -> StoreResult<()> {
        let bad = |m: &str| Err(StoreError::Bridge(m.into()));
        let key_of = |v: Option<&Value>| {
            v.and_then(Value::as_str)
                .and_then(|s| paths::session_key(s).ok())
        };
        match c {
            "peer" if o.is_empty() => {
                if body.get("schema").and_then(Value::as_str) != Some("agent-executor.peer.v1")
                    || key_of(body.get("session")).as_deref() != Some(k)
                {
                    return bad("peer_identity_mismatch");
                }
            }
            "inbox" if !o.is_empty() && is_message_id(k) => {
                if body.get("schema").and_then(Value::as_str) != Some("agent-executor.mail.v1")
                    || body.get("id").and_then(Value::as_str) != Some(k)
                    || key_of(body.get("to").and_then(|t| t.get("session"))).as_deref() != Some(o)
                {
                    return bad("message_identity_mismatch");
                }
            }
            _ => return bad("invalid_record_key"),
        }
        Ok(())
    }

    /// The bridge contract, committed straight to `rooms.db`.
    pub fn sqlite_bridge(base: &Path, op: &str, req: &Value) -> StoreResult<Value> {
        let conn = Connection::open(base.join("rooms.db"))
            .map_err(|e| StoreError::Bridge(e.to_string()))?;
        let err = |e: rusqlite::Error| StoreError::Bridge(e.to_string());
        match op {
            "ensure" => Ok(json!({"active": backend(base) == Backend::Sqlite})),
            "put" => {
                let (c, o, k) = (
                    field(req, "collection")?,
                    field(req, "owner")?,
                    field(req, "key")?,
                );
                let mut body = req
                    .get("body")
                    .filter(|b| b.is_object())
                    .cloned()
                    .ok_or_else(|| StoreError::Bridge("invalid_body".into()))?;
                check_record(c, o, k, &body)?;
                let prior: Option<Value> = conn
                    .query_row(
                        "SELECT body FROM mailbox_records WHERE collection=?1 AND owner=?2 AND key=?3",
                        rusqlite::params![c, o, k],
                        |r| r.get::<_, String>(0),
                    )
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok());
                if c == "inbox"
                    && let Some(prior) = prior
                {
                    let unread = |v: &Value| {
                        let mut v = v.clone();
                        v["readAt"] = Value::Null;
                        v
                    };
                    if unread(&prior) != unread(&body) {
                        return Err(StoreError::Bridge("message_content_conflict".into()));
                    }
                    if prior.get("readAt").is_some_and(paths::is_truthy_json) {
                        body["readAt"] = prior["readAt"].clone();
                    }
                }
                conn.execute(
                    "INSERT INTO mailbox_records VALUES (?1, ?2, ?3, ?4, 1)
                     ON CONFLICT(collection, owner, key) DO UPDATE SET body = excluded.body,
                       updated_ms = updated_ms + 1",
                    rusqlite::params![c, o, k, body.to_string()],
                )
                .map_err(err)?;
                Ok(body)
            }
            "delete" => {
                let (c, o, k) = (
                    field(req, "collection")?,
                    field(req, "owner")?,
                    field(req, "key")?,
                );
                let n = conn
                    .execute(
                        "DELETE FROM mailbox_records WHERE collection=?1 AND owner=?2 AND key=?3",
                        rusqlite::params![c, o, k],
                    )
                    .map_err(err)?;
                Ok(Value::Bool(n > 0))
            }
            other => Err(StoreError::Bridge(format!("unsupported {other}"))),
        }
    }

    /// A bridge that refuses every write, as a crashed or missing Node bridge would.
    pub fn failing_bridge(_: &Path, _: &str, _: &Value) -> StoreResult<Value> {
        Err(StoreError::Bridge("down".into()))
    }

    /// Insert a raw row, bypassing validation (a corrupt or foreign writer).
    pub fn insert_raw(base: &Path, collection: &str, owner: &str, key: &str, body: &str) {
        let conn = Connection::open(base.join("rooms.db")).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO mailbox_records VALUES (?1, ?2, ?3, ?4, 1)",
            rusqlite::params![collection, owner, key, body],
        )
        .unwrap();
    }

    pub fn row_count(base: &Path, collection: &str) -> i64 {
        let conn = Connection::open(base.join("rooms.db")).unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM mailbox_records WHERE collection = ?1",
            [collection],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Route bridge spawns on this thread to a script path (for the real spawn path).
    pub fn set_bridge_path(path: Option<PathBuf>) {
        TEST_BRIDGE_PATH.with(|b| *b.borrow_mut() = path);
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::{identity, mailbox_lifecycle};
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A disposable `<cache>/mailbox-v1` root under the crate's (SSD) target directory;
    /// the whole cache, including files written beside the root, is removed on drop.
    struct Root(PathBuf, PathBuf);

    impl Root {
        fn new(name: &str) -> Self {
            let cache = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/mailbox-records-tests")
                .join(format!(
                    "{name}-{}-{}",
                    std::process::id(),
                    SEQ.fetch_add(1, Ordering::Relaxed)
                ));
            let _ = fs::remove_dir_all(&cache);
            let base = cache.join("mailbox-v1");
            fs::create_dir_all(&base).unwrap();
            Self(base, cache)
        }
        fn active(name: &str) -> Self {
            let root = Self::new(name);
            activate(&root.0);
            root
        }
    }

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.1);
        }
    }

    fn peer(session: &str, cwd: &str) -> Value {
        let now = paths::format_utc_iso_z(paths::utc_now_secs());
        json!({
            "schema": "agent-executor.peer.v1", "session": session, "name": format!("{session}-name"),
            "harness": "codex", "cwd": cwd, "repo": format!("{cwd}/.git"), "remotes": ["test-remote"],
            "pid": i64::from(std::process::id()),
            "state": "idle", "startedAt": now, "lastSeenAt": now,
        })
    }

    fn mail(id: &str, from: &str, to: &str, cwd: &str) -> Value {
        json!({
            "schema": "agent-executor.mail.v1", "id": id,
            "from": {"session": from, "name": from, "harness": "codex", "cwd": cwd,
                     "repo": format!("{cwd}/.git"), "remotes": ["test-remote"]},
            "to": {"session": to, "name": to}, "text": "hello", "replyTo": null,
            "sentAt": paths::format_utc_iso_z(paths::utc_now_secs()), "readAt": null,
        })
    }

    fn refuse_bridge(_: &Path, op: &str, _: &Value) -> StoreResult<Value> {
        panic!("bridge must not be called for {op}");
    }

    #[test]
    fn backend_requires_exact_fences_and_fails_closed_when_pending_or_recreated() {
        let legacy = Root::new("legacy");
        assert_eq!(backend(&legacy.0), Backend::Legacy);

        let pending = Root::new("pending");
        fs::write(pending.0.join(PENDING), "intent\n").unwrap();
        assert_eq!(backend(&pending.0), Backend::Invalid);

        let active = Root::active("active");
        assert_eq!(backend(&active.0), Backend::Sqlite);

        // A legacy writer recreating `peers/` as a directory breaks the fence.
        fs::remove_file(active.0.join("peers")).unwrap();
        fs::create_dir(active.0.join("peers")).unwrap();
        assert_eq!(backend(&active.0), Backend::Invalid);

        let wrong = Root::active("wrong");
        fs::write(wrong.0.join(MARKER), "something else").unwrap();
        assert_eq!(backend(&wrong.0), Backend::Invalid);

        let link = Root::active("link");
        fs::remove_file(link.0.join(MARKER)).unwrap();
        fs::write(link.0.join("elsewhere"), FENCE).unwrap();
        std::os::unix::fs::symlink(link.0.join("elsewhere"), link.0.join(MARKER)).unwrap();
        assert_eq!(backend(&link.0), Backend::Invalid);
    }

    #[test]
    fn active_reads_are_native_and_deadline_bounded_without_the_bridge() {
        let root = Root::active("reads");
        let _bridge = set_test_bridge(Some(refuse_bridge));
        let p = peer("Mixed:Case", "/w");
        let key = paths::session_key("Mixed:Case").unwrap();
        insert_raw(&root.0, "peer", "", &key, &p.to_string());
        insert_raw(&root.0, "peer", "", "garbled", "{not json");
        let owner = paths::session_key("dest").unwrap();
        let m = mail("abc1-0a0b0c", "Mixed:Case", "dest", "/w");
        insert_raw(&root.0, "inbox", &owner, "abc1-0a0b0c", &m.to_string());

        assert_eq!(read_peer(&root.0, "Mixed:Case"), Some(p.clone()));
        let listing = list_peers(&root.0).unwrap();
        assert_eq!(listing.records.len(), 2);
        assert_eq!(listing.bodies().count(), 1);
        assert!(listing.is_canonical(&key, "Mixed:Case"));
        assert!(has_unread(&root.0, "dest"));
        assert_eq!(read_message(&root.0, "dest", "abc1-0a0b0c"), Some(m));
        assert_eq!(all_messages(&root.0).unwrap().len(), 1);
        // No legacy file is ever consulted or created.
        assert!(root.0.join("peers").is_file());
        assert!(!root.0.join("mailbox-locks").exists());

        let _expired = sqlite::set_operation_deadline(Instant::now());
        assert_eq!(list_peers(&root.0).unwrap_err(), StoreError::Deadline);
        assert_eq!(read_peer(&root.0, "Mixed:Case"), None);
        assert_eq!(
            write_peer(&root.0, "Mixed:Case", &p).unwrap_err(),
            StoreError::Deadline
        );
    }

    #[test]
    fn active_store_without_cutover_or_with_unknown_schema_fails_closed() {
        let root = Root::active("cutover");
        let conn = rusqlite::Connection::open(root.0.join("rooms.db")).unwrap();
        conn.execute("DELETE FROM mailbox_cutover", []).unwrap();
        assert_eq!(list_peers(&root.0).unwrap_err(), StoreError::Invalid);

        let old = Root::active("old-schema");
        let conn = rusqlite::Connection::open(old.0.join("rooms.db")).unwrap();
        conn.pragma_update(None, "user_version", MIN_RECORDS_SCHEMA - 1)
            .unwrap();
        assert_eq!(list_peers(&old.0).unwrap_err(), StoreError::Invalid);

        // A rooms schema this build does not know yet fails closed.
        let later = Root::active("later-schema");
        let conn = rusqlite::Connection::open(later.0.join("rooms.db")).unwrap();
        conn.pragma_update(None, "user_version", sqlite::ROOMS_SCHEMA_VERSION + 1)
            .unwrap();
        assert_eq!(list_peers(&later.0).unwrap_err(), StoreError::Invalid);

        let foreign = Root::active("foreign");
        let conn = rusqlite::Connection::open(foreign.0.join("rooms.db")).unwrap();
        conn.pragma_update(None, "application_id", 7).unwrap();
        assert_eq!(list_peers(&foreign.0).unwrap_err(), StoreError::Invalid);

        let reshaped = Root::active("reshaped");
        let conn = rusqlite::Connection::open(reshaped.0.join("rooms.db")).unwrap();
        conn.execute_batch("DROP TABLE mailbox_records; CREATE TABLE mailbox_records(x TEXT);")
            .unwrap();
        assert!(list_peers(&reshaped.0).is_err());

        let missing = Root::active("no-db");
        fs::remove_file(missing.0.join("rooms.db")).unwrap();
        assert_eq!(
            read_peer_checked(&missing.0, "s").unwrap_err(),
            StoreError::Unavailable
        );
    }

    #[test]
    fn identical_committed_peer_needs_no_writer_but_a_changed_heartbeat_does() {
        let root = Root::active("unchanged-peer");
        let mut record = peer("alpha", "/w");
        insert_raw(&root.0, "peer", "", "alpha", &record.to_string());
        let _bridge = set_test_bridge(Some(failing_bridge));
        assert!(write_peer(&root.0, "alpha", &record).is_ok());
        record["lastSeenAt"] = json!("2000-01-01T00:00:00Z");
        assert!(write_peer(&root.0, "alpha", &record).is_err());
        assert_ne!(read_peer(&root.0, "alpha").unwrap(), record);
    }

    #[test]
    fn writes_commit_through_the_bridge_and_never_fall_back_to_legacy_files() {
        let root = Root::active("writes");
        {
            let _bridge = set_test_bridge(Some(sqlite_bridge));
            write_peer(&root.0, "alpha", &peer("alpha", "/w")).unwrap();
            assert_eq!(row_count(&root.0, "peer"), 1);
            // The bridge refuses a body filed under another session's key.
            assert!(write_peer(&root.0, "beta", &peer("alpha", "/w")).is_err());
            let updated = update_peer(&root.0, "alpha", |obj| {
                obj.insert("state".into(), json!("busy"));
                true
            })
            .unwrap();
            assert_eq!(read_peer(&root.0, "alpha"), Some(updated));
            assert!(root.0.join("mailbox-locks/peer/alpha.lock").is_file());
            assert!(delete_peer(&root.0, "alpha").unwrap());
            assert!(!delete_peer(&root.0, "alpha").unwrap());
        }
        let _bridge = set_test_bridge(Some(failing_bridge));
        assert!(write_peer(&root.0, "alpha", &peer("alpha", "/w")).is_err());
        assert!(identity::annotate_peer(&root.0, "alpha", &[("x", json!(1))]).is_none());
        assert!(root.0.join("peers").is_file() && root.0.join("inbox").is_file());
        assert_eq!(row_count(&root.0, "peer"), 0);
    }

    #[test]
    fn fenced_root_neither_reads_nor_writes_legacy_records() {
        let root = Root::active("fenced");
        fs::remove_file(root.0.join("inbox")).unwrap();
        let legacy_dir = root.0.join("inbox/dest");
        fs::create_dir_all(&legacy_dir).unwrap();
        let m = mail("abc1-0a0b0c", "x", "dest", "/w");
        paths::write_json_atomic(&legacy_dir.join("abc1-0a0b0c.json"), &m).unwrap();
        let _bridge = set_test_bridge(Some(refuse_bridge));

        assert_eq!(backend(&root.0), Backend::Invalid);
        assert!(!has_unread(&root.0, "dest"));
        let (found, incomplete) = mailbox_lifecycle::messages_checked(&root.0, "dest", true);
        assert!(found.is_empty() && incomplete);
        assert_eq!(
            mailbox_lifecycle::mark_one(&root.0, "dest", "abc1-0a0b0c"),
            None
        );
        mailbox_lifecycle::notify(&root.0, &json!({"session": "dest"}), "hi", None, "project");
        identity::unregister_peer(&root.0, "dest");
        // The stray legacy message is untouched and still unread.
        assert_eq!(
            paths::read_json_file(&legacy_dir.join("abc1-0a0b0c.json")),
            Some(m)
        );
        assert_eq!(fs::read_dir(&legacy_dir).unwrap().count(), 1);
    }

    #[test]
    fn acknowledgements_are_durable_and_visible_to_a_fresh_reader() {
        let root = Root::active("ack");
        let _bridge = set_test_bridge(Some(sqlite_bridge));
        write_peer(&root.0, "dest", &peer("dest", "/w")).unwrap();
        write_peer(&root.0, "src", &peer("src", "/w")).unwrap();
        let m = mail("abc1-0a0b0c", "src", "dest", "/w");
        write_message(&root.0, "dest", "abc1-0a0b0c", &m).unwrap();

        let incoming = mailbox_lifecycle::incoming(&root.0, "dest", "project");
        assert_eq!(incoming.len(), 1);
        assert_eq!(
            mailbox_lifecycle::mark_one(&root.0, "dest", "abc1-0a0b0c"),
            Some(true)
        );
        assert_eq!(
            mailbox_lifecycle::mark_one(&root.0, "dest", "abc1-0a0b0c"),
            Some(false)
        );
        // A retried original send cannot make the acknowledged message unread again.
        write_message(&root.0, "dest", "abc1-0a0b0c", &m).unwrap();

        // A fresh connection (as a new hook process opens) sees the committed readAt.
        let conn = rusqlite::Connection::open(root.0.join("rooms.db")).unwrap();
        let body: String = conn
            .query_row(
                "SELECT body FROM mailbox_records WHERE collection='inbox' AND key='abc1-0a0b0c'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let stored: Value = serde_json::from_str(&body).unwrap();
        assert!(stored["readAt"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(!has_unread(&root.0, "dest"));
        assert!(mailbox_lifecycle::take(&root.0, "dest", false, 5).is_empty());

        let notice = mailbox_lifecycle::render_all(std::slice::from_ref(&stored), None);
        assert!(notice.contains("abc1-0a0b0c"));
        assert_eq!(
            mailbox_lifecycle::replied_to(&root.0, "src"),
            std::collections::HashSet::new()
        );
    }

    #[test]
    fn notices_registration_and_session_end_round_trip_through_the_store() {
        let root = Root::active("notice");
        let _bridge = set_test_bridge(Some(sqlite_bridge));
        let me = peer("dest", "/w");
        write_peer(&root.0, "dest", &me).unwrap();
        mailbox_lifecycle::notify(&root.0, &me, "system notice", None, "cross-project");
        let (found, incomplete) = mailbox_lifecycle::messages_checked(&root.0, "dest", true);
        assert!(!incomplete);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["kind"], json!("notice"));
        let taken = mailbox_lifecycle::take(&root.0, "dest", false, 5);
        assert_eq!(taken.len(), 1);
        assert!(!has_unread(&root.0, "dest"));

        let live = identity::peers_live(&root.0, false);
        assert_eq!(live.len(), 1);
        assert!(mailbox_lifecycle::live_session(&root.0, Some("dest")));
        identity::attest_native_sessions(&root.0, "dest", &["dest"]).unwrap();
        assert_eq!(
            read_peer(&root.0, "dest").unwrap()["nativeSession"],
            json!("dest")
        );

        mailbox_lifecycle::end_session(&root.0, "dest", "exit", None);
        assert!(read_peer(&root.0, "dest").is_none());
        assert!(identity::peers_live(&root.0, false).is_empty());
        assert!(root.0.join("peers").is_file());
    }

    #[test]
    fn entrypoint_activates_only_new_roots() {
        let _bridge = set_test_bridge(Some(|base: &Path, op: &str, _: &Value| {
            assert_eq!(op, "ensure");
            activate(base);
            Ok(json!({"active": true}))
        }));
        let fresh = Root::new("fresh");
        assert_eq!(ensure_at_entrypoint(&fresh.0), Backend::Sqlite);

        let populated = Root::new("populated");
        fs::create_dir_all(populated.0.join("peers")).unwrap();
        fs::write(populated.0.join("peers/a.json"), "{}").unwrap();
        assert_eq!(ensure_at_entrypoint(&populated.0), Backend::Legacy);
        assert!(!populated.0.join(MARKER).exists());

        let _down = set_test_bridge(Some(failing_bridge));
        let offline = Root::new("offline");
        assert_eq!(ensure_at_entrypoint(&offline.0), Backend::Legacy);
        let stuck = Root::new("stuck");
        fs::write(stuck.0.join(PENDING), "intent\n").unwrap();
        assert_eq!(ensure_at_entrypoint(&stuck.0), Backend::Invalid);
    }

    #[test]
    fn legacy_roots_keep_their_files() {
        let root = Root::new("legacy-files");
        write_peer(&root.0, "alpha", &peer("alpha", "/w")).unwrap();
        assert!(root.0.join("peers/alpha.json").is_file());
        let m = mail("abc1-0a0b0c", "alpha", "alpha", "/w");
        write_message(&root.0, "alpha", "abc1-0a0b0c", &m).unwrap();
        assert!(root.0.join("inbox/alpha/abc1-0a0b0c.json").is_file());
        assert_eq!(
            mailbox_lifecycle::mark_one(&root.0, "alpha", "abc1-0a0b0c"),
            Some(true)
        );
        assert!(root.0.join("inbox/alpha/abc1-0a0b0c.lock").is_file());
        assert!(!root.0.join("rooms.db").exists() && !root.0.join(MARKER).exists());
    }

    /// End-to-end against the real `bin/mailbox-records.mjs`, opt-in because it needs the
    /// lead's bridge: `ORK_FAST_MAILBOX_BRIDGE=/path/to/mailbox-records.mjs cargo test`.
    #[test]
    fn real_bridge_round_trip_when_configured() {
        let Some(script) = std::env::var_os("ORK_FAST_MAILBOX_BRIDGE").map(PathBuf::from) else {
            return;
        };
        set_bridge_path(Some(script));
        let _bridge = set_test_bridge(None);
        let root = Root::new("real");
        let base = root.0.clone();
        fs::remove_dir(&base).unwrap();
        assert_eq!(ensure_at_entrypoint(&base), Backend::Sqlite);
        assert!(is_fence(&base.join("peers")) && is_fence(&base.join("inbox")));

        write_peer(&base, "dest", &peer("dest", "/w")).unwrap();
        write_peer(&base, "Src:One", &peer("Src:One", "/w")).unwrap();
        assert!(write_peer(&base, "other", &peer("dest", "/w")).is_err());
        let id = paths::message_id();
        write_message(&base, "dest", &id, &mail(&id, "Src:One", "dest", "/w")).unwrap();
        assert!(has_unread(&base, "dest"));
        assert_eq!(mailbox_lifecycle::take(&base, "dest", false, 5).len(), 1);
        assert!(!has_unread(&base, "dest"));
        assert!(read_message(&base, "dest", &id).unwrap()["readAt"].is_string());
        mailbox_lifecycle::notify(&base, &peer("dest", "/w"), "notice", None, "cross-project");
        assert!(has_unread(&base, "dest"));
        assert_eq!(list_peers(&base).unwrap().records.len(), 2);
        identity::unregister_peer(&base, "Src:One");
        assert!(read_peer(&base, "Src:One").is_none());
        let outbox: i64 = rusqlite::Connection::open(base.join("rooms.db"))
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM outbox_events WHERE scope='mailbox-local'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            outbox >= 6,
            "each committed change carries an outbox event: {outbox}"
        );
        set_bridge_path(None);
    }
}
