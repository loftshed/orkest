//! Read-only SQLite helpers via bundled rusqlite (rooms.db, Codex state_*.sqlite, Antigravity summaries).

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::paths;

pub const ROOMS_APPLICATION_ID: i64 = 1_330_793_298;
pub const ROOMS_SCHEMA_VERSION: i64 = 2;

/// Reject symlinks on the database or its WAL/SHM sidecar files (matching `orkest-sqlite.mjs`).
#[must_use]
pub fn db_has_symlink(db_path: &Path) -> bool {
    let db_str = db_path.to_string_lossy();
    let wal_path = PathBuf::from(format!("{db_str}-wal"));
    let shm_path = PathBuf::from(format!("{db_str}-shm"));
    for candidate in [db_path, &wal_path, &shm_path] {
        if let Ok(meta) = fs::symlink_metadata(candidate)
            && meta.file_type().is_symlink()
        {
            return true;
        }
    }
    false
}

fn open_readonly(db_path: &Path, timeout_ms: u64) -> Option<Connection> {
    if db_has_symlink(db_path) {
        return None;
    }
    let canon = fs::canonicalize(db_path).ok()?;
    let meta = fs::symlink_metadata(&canon).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return None;
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(&canon, flags).ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(timeout_ms));
    Some(conn)
}

fn clean_sqlite_cell(val: Option<String>) -> String {
    let Some(s) = val else {
        return String::new();
    };
    let printable: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    printable
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

fn codex_db_files(account_home: &Path) -> Vec<(PathBuf, u128)> {
    let Ok(entries) = fs::read_dir(account_home) else {
        return Vec::new();
    };
    let mut dbs = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("state_") && name.ends_with(".sqlite") && p.is_file() {
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            dbs.push((p, mtime));
        }
    }
    dbs
}

/// Read `(model, reasoning_effort)` from `<account_home>/state_*.sqlite` for `statusline` (requires <=8 DBs and unambiguous result).
#[must_use]
pub fn codex_thread_settings_unique(account_home: &Path, session: &str) -> (String, String) {
    let dbs = codex_db_files(account_home);
    if dbs.len() > 8 {
        return (String::new(), String::new());
    }
    let mut found: BTreeSet<(String, String)> = BTreeSet::new();
    for (db_path, _) in dbs {
        let Some(conn) = open_readonly(&db_path, 50) else {
            continue;
        };
        if let Ok(mut stmt) =
            conn.prepare("SELECT model, reasoning_effort FROM threads WHERE id = ?1")
            && let Ok(pair) = stmt.query_row([session], |row| {
                let model: Option<String> = row.get(0).ok().flatten();
                let effort: Option<String> = row.get(1).ok().flatten();
                Ok((clean_sqlite_cell(model), clean_sqlite_cell(effort)))
            })
        {
            found.insert(pair);
        }
    }
    if found.len() == 1 {
        found.into_iter().next().unwrap_or_default()
    } else {
        (String::new(), String::new())
    }
}

/// Read `(model, reasoning_effort)` from newest 8 `<account_home>/state_*.sqlite` for mailbox hooks.
#[must_use]
pub fn codex_thread_settings_newest(
    account_home: &Path,
    session: &str,
) -> (Option<String>, Option<String>) {
    let mut dbs = codex_db_files(account_home);
    dbs.sort_by_key(|a| std::cmp::Reverse(a.1));
    dbs.truncate(8);
    for (db_path, _) in dbs {
        let Some(conn) = open_readonly(&db_path, 50) else {
            continue;
        };
        if let Ok(mut stmt) =
            conn.prepare("SELECT model, reasoning_effort FROM threads WHERE id = ?1")
            && let Ok((m, e)) = stmt.query_row([session], |row| {
                let model: Option<String> = row.get(0).ok().flatten();
                let effort: Option<String> = row.get(1).ok().flatten();
                Ok((
                    model
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty()),
                    effort
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty()),
                ))
            })
            && (m.is_some() || e.is_some())
        {
            return (m, e);
        }
    }
    (None, None)
}

fn has_legacy_room_files(base: &Path) -> bool {
    let dir = base.join("rooms");
    match fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == ErrorKind::NotFound => return false,
        Err(_) => return true,
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => return true,
        Ok(_) => {}
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        return true;
    };
    for entry_res in entries {
        let Ok(entry) = entry_res else {
            return true;
        };
        if entry.path().extension().and_then(|x| x.to_str()) == Some("json") {
            return true;
        }
    }
    false
}

fn query_rooms_db(base: &Path, room_id: Option<&str>) -> Option<Vec<Value>> {
    if env::var("ORKEST_ROOM_STORE_BRIDGE").as_deref() == Ok("1") {
        return None;
    }
    if has_legacy_room_files(base) {
        return None;
    }
    let db = base.join("rooms.db");
    match fs::symlink_metadata(&db) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
        Ok(meta) if meta.file_type().is_symlink() => return None,
        Ok(_) => {}
    }
    let conn = open_readonly(&db, 5000)?;
    let app_id: i64 = conn
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .ok()?;
    let user_ver: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .ok()?;
    if app_id != ROOMS_APPLICATION_ID || user_ver != ROOMS_SCHEMA_VERSION {
        return None;
    }
    let mut rooms = Vec::new();
    if let Some(id) = room_id {
        let mut stmt = conn.prepare("SELECT data FROM rooms WHERE id = ?1").ok()?;
        let mut rows = stmt.query([id]).ok()?;
        loop {
            match rows.next() {
                Ok(Some(row)) => {
                    let text: String = row.get(0).ok()?;
                    let parsed: Value = serde_json::from_str(&text).ok()?;
                    rooms.push(parsed);
                }
                Ok(None) => break,
                Err(_) => return None,
            }
        }
    } else {
        let mut stmt = conn
            .prepare("SELECT data FROM rooms ORDER BY updated_at DESC, id ASC")
            .ok()?;
        let mut rows = stmt.query([]).ok()?;
        loop {
            match rows.next() {
                Ok(Some(row)) => {
                    let text: String = row.get(0).ok()?;
                    let parsed: Value = serde_json::from_str(&text).ok()?;
                    rooms.push(parsed);
                }
                Ok(None) => break,
                Err(_) => return None,
            }
        }
    }
    Some(rooms)
}

fn room_store_bridge_path() -> Option<PathBuf> {
    if let Some(scripts) = paths::scripts_root() {
        let resolved = fs::canonicalize(&scripts).unwrap_or(scripts);
        if let Some(candidate) = resolved.parent().map(|p| p.join("bin/room-store.mjs"))
            && candidate.is_file()
        {
            return Some(candidate);
        }
        if let Some(candidate) = resolved
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.join("bin/room-store.mjs"))
            && candidate.is_file()
        {
            return Some(candidate);
        }
    }
    let candidate = paths::plugin_root()?.join("bin/room-store.mjs");
    candidate.is_file().then_some(candidate)
}

/// Invoke `node <plugin>/bin/room-store.mjs <command> --root <base> [room_id]`.
pub fn invoke_room_store_bridge(
    base: &Path,
    command: &str,
    room_id: Option<&str>,
    stdin_payload: Option<&Value>,
) -> Option<Value> {
    let bridge = room_store_bridge_path()?;
    let node = paths::node_binary();
    let mut cmd = Command::new(node);
    cmd.arg(bridge).arg(command).arg("--root").arg(base);
    if let Some(id) = room_id {
        if !paths::valid_room_id(id) {
            return None;
        }
        cmd.arg(id);
    }
    if stdin_payload.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    if let Some(payload) = stdin_payload
        && let Some(mut stdin) = child.stdin.take()
    {
        let _ = serde_json::to_writer(&mut stdin, payload);
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// List all room records under `<base>`, returning `(rooms, complete)` where `complete` is
/// `false` if SQLite query/row iteration failed or the fallback could only partially read legacy files.
#[must_use]
pub fn list_rooms_checked(base: &Path) -> (Vec<Value>, bool) {
    if let Some(rooms) = query_rooms_db(base, None) {
        return (rooms, true);
    }
    if let Some(Value::Array(arr)) = invoke_room_store_bridge(base, "list", None, None) {
        return (arr, true);
    }
    // Last-resort fallback if bridge script or node is unavailable in an isolated unit test:
    // read valid JSON room files directly from `<base>/rooms/*.json`.
    let mut complete = matches!(
        fs::symlink_metadata(base.join("rooms.db")),
        Err(ref e) if e.kind() == ErrorKind::NotFound
    );
    let mut legacy = Vec::new();
    let rooms_dir = base.join("rooms");
    match fs::symlink_metadata(&rooms_dir) {
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => complete = false,
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => complete = false,
        Ok(_) => match fs::read_dir(&rooms_dir) {
            Err(_) => complete = false,
            Ok(entries) => {
                for entry_res in entries {
                    let Ok(entry) = entry_res else {
                        complete = false;
                        continue;
                    };
                    let p = entry.path();
                    if p.extension().and_then(|e| e.to_str()) == Some("json") {
                        let is_reg = fs::symlink_metadata(&p)
                            .is_ok_and(|m| !m.file_type().is_symlink() && m.is_file());
                        if is_reg
                            && let Some(val) = paths::read_json_file(&p)
                            && val.is_object()
                        {
                            legacy.push(val);
                        } else {
                            complete = false;
                        }
                    }
                }
            }
        },
    }
    (legacy, complete)
}

/// List all room records under `<base>`, preferring direct read-only SQLite access.
#[must_use]
pub fn list_rooms(base: &Path) -> Vec<Value> {
    list_rooms_checked(base).0
}

/// Read a single room record by ID from `<base>`.
#[must_use]
pub fn read_room(base: &Path, room_id: &str) -> Option<Value> {
    if !paths::valid_room_id(room_id) {
        return None;
    }
    if let Some(mut rooms) = query_rooms_db(base, Some(room_id)) {
        return rooms.drain(..).next();
    }
    if let Some(val) = invoke_room_store_bridge(base, "get", Some(room_id), None) {
        return if val.is_object() { Some(val) } else { None };
    }
    paths::read_json_file(&base.join("rooms").join(format!("{room_id}.json")))
        .filter(Value::is_object)
}

/// Result of querying Antigravity's `conversation_summaries.db` for subagent linkage.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgySqliteSubagentState {
    pub is_subagent: bool,
    pub parent_session: Option<String>,
    pub agent_name: Option<String>,
    pub classified: bool,
    pub db_available: bool,
}

fn is_missing_row_or_table(err: &rusqlite::Error) -> bool {
    match err {
        rusqlite::Error::QueryReturnedNoRows => true,
        rusqlite::Error::SqliteFailure(_, Some(msg)) => msg.contains("no such table"),
        _ => false,
    }
}

/// Read Antigravity's `conversation_summaries.db` for subagent parent linkage with DB availability.
#[must_use]
pub fn agy_sqlite_subagent_state(account: Option<&str>, session: &str) -> AgySqliteSubagentState {
    if session.trim().is_empty() {
        return AgySqliteSubagentState::default();
    }
    let home = account
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or_else(
            || paths::expand_home("~/.gemini", None),
            |s| paths::expand_home(s, None),
        );
    let db_path = [
        home.join("antigravity-cli/conversation_summaries.db"),
        home.join("conversation_summaries.db"),
    ]
    .into_iter()
    .find(|p| p.is_file());
    let Some(db) = db_path else {
        return AgySqliteSubagentState::default();
    };
    let Some(conn) = open_readonly(&db, 50) else {
        return AgySqliteSubagentState::default();
    };

    let summary_res: Result<(Option<String>, i64, Option<String>), rusqlite::Error> = conn
        .query_row(
            "SELECT parent_conversation_id, nesting_depth, agent_name FROM conversation_summaries WHERE conversation_id = ?1",
            [session],
            |row| {
                let p: Option<String> = row.get(0).ok().flatten();
                let d: i64 = row.get(1).ok().unwrap_or(0);
                let a: Option<String> = row.get(2).ok().flatten();
                Ok((p, d, a))
            },
        );

    let query_parent_table = || -> Result<Option<String>, rusqlite::Error> {
        conn.query_row(
            "SELECT parent_id FROM conversation_parents WHERE conversation_id = ?1",
            [session],
            |row| {
                row.get::<_, Option<String>>(0)
                    .map(Option::unwrap_or_default)
            },
        )
        .map(|s| {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
    };

    match summary_res {
        Ok((parent_raw, depth, name_raw)) => {
            let agent_name = name_raw
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let parent_id = parent_raw
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if parent_id.is_some() || depth > 0 {
                return AgySqliteSubagentState {
                    is_subagent: true,
                    parent_session: parent_id,
                    agent_name,
                    classified: true,
                    db_available: true,
                };
            }
            match query_parent_table() {
                Ok(Some(p_id)) => AgySqliteSubagentState {
                    is_subagent: true,
                    parent_session: Some(p_id),
                    agent_name,
                    classified: true,
                    db_available: true,
                },
                Ok(None) => AgySqliteSubagentState {
                    is_subagent: false,
                    parent_session: None,
                    agent_name: None,
                    classified: true,
                    db_available: true,
                },
                Err(ref err) if is_missing_row_or_table(err) => AgySqliteSubagentState {
                    is_subagent: false,
                    parent_session: None,
                    agent_name: None,
                    classified: true,
                    db_available: true,
                },
                Err(_) => AgySqliteSubagentState::default(),
            }
        }
        Err(ref err) if is_missing_row_or_table(err) => match query_parent_table() {
            Ok(Some(p_id)) => AgySqliteSubagentState {
                is_subagent: true,
                parent_session: Some(p_id),
                agent_name: None,
                classified: true,
                db_available: true,
            },
            Ok(None) => AgySqliteSubagentState {
                is_subagent: false,
                parent_session: None,
                agent_name: None,
                classified: false,
                db_available: true,
            },
            Err(ref parent_err) if is_missing_row_or_table(parent_err) => AgySqliteSubagentState {
                is_subagent: false,
                parent_session: None,
                agent_name: None,
                classified: false,
                db_available: true,
            },
            Err(_) => AgySqliteSubagentState::default(),
        },
        Err(_) => AgySqliteSubagentState::default(),
    }
}

/// Read Antigravity's `conversation_summaries.db` for subagent parent linkage.
/// Returns `(is_subagent, parent_session, agent_name, classified)`.
#[cfg(test)]
#[must_use]
pub fn agy_sqlite_subagent_info(
    account: Option<&str>,
    session: &str,
) -> (bool, Option<String>, Option<String>, bool) {
    let state = agy_sqlite_subagent_state(account, session);
    (
        state.is_subagent,
        state.parent_session,
        state.agent_name,
        state.classified,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn make_exclusive_test_dir(prefix: &str) -> PathBuf {
        let root = env::temp_dir();
        let pid = std::process::id();
        let base_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0u64, |d| d.as_nanos() as u64);
        for attempt in 0..64u64 {
            let tag = base_nanos
                .wrapping_add(attempt)
                .wrapping_mul(6_364_136_223_846_793_005);
            let dir = root.join(format!("{prefix}-{pid}-{tag:016x}"));
            match fs::create_dir(&dir) {
                Ok(()) => return dir,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(e) => panic!("failed to create test dir {}: {e}", dir.display()),
            }
        }
        panic!("exhausted test dir creation attempts");
    }

    #[test]
    fn test_codex_settings_and_rooms_db_and_agy_db() {
        let dir = make_exclusive_test_dir("ork-fast-sqlite");

        // 1. Codex state_1.sqlite
        let codex_db = dir.join("state_1.sqlite");
        {
            let conn = Connection::open(&codex_db).unwrap();
            conn.execute(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT, reasoning_effort TEXT)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO threads (id, model, reasoning_effort) VALUES ('s-1', 'gpt-5.4', 'high')",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            codex_thread_settings_unique(&dir, "s-1"),
            ("gpt-5.4".to_string(), "high".to_string())
        );
        assert_eq!(
            codex_thread_settings_newest(&dir, "s-1"),
            (Some("gpt-5.4".to_string()), Some("high".to_string()))
        );

        // 2. rooms.db
        let base = dir.join("mailbox-v1");
        fs::create_dir_all(&base).unwrap();
        {
            let conn = Connection::open(base.join("rooms.db")).unwrap();
            conn.pragma_update(None, "application_id", ROOMS_APPLICATION_ID)
                .unwrap();
            conn.pragma_update(None, "user_version", ROOMS_SCHEMA_VERSION)
                .unwrap();
            conn.execute(
                "CREATE TABLE rooms (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO rooms (id, cwd, updated_at, data) VALUES ('r1', '/tmp', 100, '{\"id\":\"r1\",\"title\":\"Alpha\"}')",
                [],
            )
            .unwrap();
        }
        assert_eq!(list_rooms(&base).len(), 1);
        assert_eq!(read_room(&base, "r1").unwrap()["title"], "Alpha");
        assert!(read_room(&base, "missing").is_none());

        // 3. Antigravity conversation_summaries.db
        let gemini_home = dir.join("gemini-home");
        fs::create_dir_all(gemini_home.join("antigravity-cli")).unwrap();
        {
            let conn =
                Connection::open(gemini_home.join("antigravity-cli/conversation_summaries.db"))
                    .unwrap();
            conn.execute(
                "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT)",
                [],
            )
            .unwrap();
            conn.execute(
                "CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO conversation_summaries VALUES ('sub-1', 'parent-1', 1, 'research')",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            agy_sqlite_subagent_info(Some(gemini_home.to_str().unwrap()), "sub-1"),
            (
                true,
                Some("parent-1".to_string()),
                Some("research".to_string()),
                true
            )
        );
        assert_eq!(
            agy_sqlite_subagent_state(Some(gemini_home.to_str().unwrap()), "sub-1"),
            AgySqliteSubagentState {
                is_subagent: true,
                parent_session: Some("parent-1".to_string()),
                agent_name: Some("research".to_string()),
                classified: true,
                db_available: true,
            }
        );
        assert_eq!(
            agy_sqlite_subagent_state(Some(gemini_home.to_str().unwrap()), "missing-session"),
            AgySqliteSubagentState {
                is_subagent: false,
                parent_session: None,
                agent_name: None,
                classified: false,
                db_available: true,
            }
        );
        {
            let conn =
                Connection::open(gemini_home.join("antigravity-cli/conversation_summaries.db"))
                    .unwrap();
            conn.execute(
                "INSERT INTO conversation_summaries VALUES ('top-1', NULL, 0, NULL)",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            agy_sqlite_subagent_state(Some(gemini_home.to_str().unwrap()), "top-1"),
            AgySqliteSubagentState {
                is_subagent: false,
                parent_session: None,
                agent_name: None,
                classified: true,
                db_available: true,
            }
        );

        let missing_home = dir.join("missing-gemini-home");
        assert_eq!(
            agy_sqlite_subagent_state(Some(missing_home.to_str().unwrap()), "sub-1"),
            AgySqliteSubagentState::default()
        );
        fs::create_dir_all(missing_home.join("antigravity-cli")).unwrap();
        fs::write(
            missing_home.join("antigravity-cli/conversation_summaries.db"),
            "not-sqlite",
        )
        .unwrap();
        assert_eq!(
            agy_sqlite_subagent_state(Some(missing_home.to_str().unwrap()), "sub-1"),
            AgySqliteSubagentState::default()
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_list_rooms_checked_completeness_on_partial_or_corrupt_stores() {
        let _lock = crate::mailbox_lifecycle::tests::TEST_ENV_LOCK
            .lock()
            .unwrap();
        let mut env = crate::mailbox_lifecycle::tests::EnvGuard::new();
        env.set("ORKEST_NODE_BIN", "/nonexistent/node");

        let dir = make_exclusive_test_dir("ork-fast-sqlite-checked");
        let empty_base = dir.join("empty");
        fs::create_dir_all(&empty_base).unwrap();
        assert_eq!(list_rooms_checked(&empty_base), (Vec::new(), true));

        // Partial rooms.db (1 valid row + 1 corrupt JSON row) must fail rather than returning partial Some.
        let partial_db_base = dir.join("partial-db");
        fs::create_dir_all(&partial_db_base).unwrap();
        {
            let conn = Connection::open(partial_db_base.join("rooms.db")).unwrap();
            conn.pragma_update(None, "application_id", ROOMS_APPLICATION_ID)
                .unwrap();
            conn.pragma_update(None, "user_version", ROOMS_SCHEMA_VERSION)
                .unwrap();
            conn.execute(
                "CREATE TABLE rooms (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO rooms (id, cwd, updated_at, data) VALUES ('r1', '/tmp', 100, '{\"id\":\"r1\"}')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO rooms (id, cwd, updated_at, data) VALUES ('r2', '/tmp', 99, '{corrupt')",
                [],
            )
            .unwrap();
        }
        assert!(query_rooms_db(&partial_db_base, None).is_none());
        let (rooms, complete) = list_rooms_checked(&partial_db_base);
        assert!(rooms.is_empty());
        assert!(!complete);

        // Partial legacy rooms dir (1 valid + 1 corrupt json) returns nonempty list with complete = false.
        let partial_legacy = dir.join("partial-legacy");
        fs::create_dir_all(partial_legacy.join("rooms")).unwrap();
        fs::write(
            partial_legacy.join("rooms/r1.json"),
            r#"{"id":"r1","title":"Valid"}"#,
        )
        .unwrap();
        fs::write(partial_legacy.join("rooms/r2.json"), "{corrupt").unwrap();
        let (rooms, complete) = list_rooms_checked(&partial_legacy);
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms[0]["id"], "r1");
        assert!(!complete);

        // Clean legacy rooms dir returns complete = true.
        fs::remove_file(partial_legacy.join("rooms/r2.json")).unwrap();
        let (rooms, complete) = list_rooms_checked(&partial_legacy);
        assert_eq!(rooms.len(), 1);
        assert!(complete);

        // Non-dir/symlinked legacy rooms dir alongside valid rooms.db forces complete = false.
        let symlink_rooms_base = dir.join("symlink-rooms");
        fs::create_dir_all(&symlink_rooms_base).unwrap();
        {
            let conn = Connection::open(symlink_rooms_base.join("rooms.db")).unwrap();
            conn.pragma_update(None, "application_id", ROOMS_APPLICATION_ID)
                .unwrap();
            conn.pragma_update(None, "user_version", ROOMS_SCHEMA_VERSION)
                .unwrap();
            conn.execute(
                "CREATE TABLE rooms (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL)",
                [],
            )
            .unwrap();
        }
        fs::write(symlink_rooms_base.join("rooms"), "not-a-dir").unwrap();
        assert!(has_legacy_room_files(&symlink_rooms_base));
        assert!(query_rooms_db(&symlink_rooms_base, None).is_none());
        let (_, complete) = list_rooms_checked(&symlink_rooms_base);
        assert!(!complete);

        let _ = fs::remove_dir_all(&dir);
    }
}
