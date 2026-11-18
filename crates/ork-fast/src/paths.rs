//! Shared runtime path discovery matching runtime_paths.py and runtime-paths.mjs.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Expand a leading `~` or `~/` using the user's home directory.
#[must_use]
pub fn expand_home(value: &str, home: Option<&Path>) -> PathBuf {
    let home_dir = home
        .map(Path::to_path_buf)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"));

    if value == "~" {
        return home_dir;
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home_dir.join(rest);
    }
    PathBuf::from(value)
}

/// Return the first non-empty value among the given environment variable names.
#[must_use]
pub fn env_first(names: &[&str], env_map: Option<&HashMap<String, String>>) -> Option<String> {
    for &name in names {
        if let Some(map) = env_map {
            if let Some(val) = map.get(name)
                && !val.is_empty()
            {
                return Some(val.clone());
            }
        } else if let Ok(val) = env::var(name)
            && !val.is_empty()
        {
            return Some(val);
        }
    }
    None
}

/// Resolve the orchestrate cache directory with agent-executor legacy fallback.
#[must_use]
pub fn cache_home(env_map: Option<&HashMap<String, String>>, home: Option<&Path>) -> PathBuf {
    if let Some(explicit) = env_first(&["ORCHESTRATE_HOME", "AGENT_EXECUTOR_HOME"], env_map) {
        return expand_home(&explicit, home);
    }
    let home_path = home
        .map(Path::to_path_buf)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"));

    let xdg = env_map
        .and_then(|m| m.get("XDG_CACHE_HOME").cloned())
        .or_else(|| env::var("XDG_CACHE_HOME").ok());

    let cache_root = if let Some(xdg_val) = xdg {
        if !xdg_val.is_empty() {
            expand_home(&xdg_val, Some(&home_path))
        } else {
            home_path.join(".cache")
        }
    } else {
        home_path.join(".cache")
    };

    let primary = cache_root.join("orchestrate");
    let legacy = cache_root.join("agent-executor");
    if primary.exists() {
        return primary;
    }
    if legacy.exists() {
        return legacy;
    }
    primary
}

/// Resolve the orchestrate config directory with agent-executor legacy fallback.
#[allow(dead_code)]
#[must_use]
pub fn config_home(env_map: Option<&HashMap<String, String>>, home: Option<&Path>) -> PathBuf {
    if let Some(explicit) = env_first(&["ORCHESTRATE_CONFIG", "AGENT_EXECUTOR_CONFIG"], env_map) {
        let path = expand_home(&explicit, home);
        return path
            .parent()
            .map_or_else(|| path.clone(), Path::to_path_buf);
    }
    let home_path = home
        .map(Path::to_path_buf)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"));

    let xdg = env_map
        .and_then(|m| m.get("XDG_CONFIG_HOME").cloned())
        .or_else(|| env::var("XDG_CONFIG_HOME").ok());

    let config_root = if let Some(xdg_val) = xdg {
        if !xdg_val.is_empty() {
            expand_home(&xdg_val, Some(&home_path))
        } else {
            home_path.join(".config")
        }
    } else {
        home_path.join(".config")
    };

    let primary = config_root.join("orchestrate");
    let legacy = config_root.join("agent-executor");
    if primary.join("config.json").exists() || primary.exists() {
        return primary;
    }
    if legacy.join("config.json").exists() || legacy.exists() {
        return legacy;
    }
    primary
}

/// Resolve the orchestrate config file with agent-executor legacy fallback.
#[allow(dead_code)]
#[must_use]
pub fn config_path(env_map: Option<&HashMap<String, String>>, home: Option<&Path>) -> PathBuf {
    if let Some(explicit) = env_first(&["ORCHESTRATE_CONFIG", "AGENT_EXECUTOR_CONFIG"], env_map) {
        return expand_home(&explicit, home);
    }
    let home_path = home
        .map(Path::to_path_buf)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"));

    let xdg = env_map
        .and_then(|m| m.get("XDG_CONFIG_HOME").cloned())
        .or_else(|| env::var("XDG_CONFIG_HOME").ok());

    let config_root = if let Some(xdg_val) = xdg {
        if !xdg_val.is_empty() {
            expand_home(&xdg_val, Some(&home_path))
        } else {
            home_path.join(".config")
        }
    } else {
        home_path.join(".config")
    };

    let primary = config_root.join("orchestrate").join("config.json");
    let legacy = config_root.join("agent-executor").join("config.json");
    if primary.exists() {
        return primary;
    }
    if legacy.exists() {
        return legacy;
    }
    primary
}

/// Resolve the binary path for `ork-fast` or return `None` if disabled or unset.
#[allow(dead_code)]
#[must_use]
pub fn ork_fast_bin(
    env_map: Option<&HashMap<String, String>>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    let disabled = env_map
        .and_then(|m| m.get("ORK_DISABLE_FAST").cloned())
        .or_else(|| env::var("ORK_DISABLE_FAST").ok());
    if disabled.as_deref() == Some("1") {
        return None;
    }

    if let Some(explicit) = env_map
        .and_then(|m| m.get("ORK_FAST_BIN").cloned())
        .or_else(|| env::var("ORK_FAST_BIN").ok())
        && !explicit.is_empty()
    {
        return Some(expand_home(&explicit, home));
    }

    Some(cache_home(env_map, home).join("bin").join("ork-fast"))
}

/// Compute the filename key for a session matching mailbox_store.py::session_key.
pub fn session_key(session: &str) -> Result<String, String> {
    if session.is_empty() || session.len() > 128 {
        return Err(format!("invalid session id length: {session}"));
    }
    let bytes = session.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() {
        return Err(format!("invalid session id start: {session}"));
    }
    for &b in bytes {
        if !b.is_ascii_alphanumeric() && b != b'_' && b != b'.' && b != b':' && b != b'-' {
            return Err(format!("invalid character in session id: {session}"));
        }
    }

    let key = session.replace(':', "%3A");
    if session == session.to_ascii_lowercase() && key.len() <= 128 {
        return Ok(key);
    }

    let hash_part = &crate::sha1::sha1_hex(session.as_bytes())[..10];
    let prefix_len = 128.min(key.len());
    Ok(format!("{}~{}", &key[..prefix_len], hash_part))
}

/// Return the path to a session's peer file in `<base>/peers/<session_key>.json`.
pub fn peer_path(base: &Path, session: &str) -> Result<PathBuf, String> {
    let key = session_key(session)?;
    Ok(base.join("peers").join(format!("{key}.json")))
}

/// Resolve a path like Python's `Path.resolve(strict=False)`, canonicalizing existing
/// ancestors and normalizing any trailing nonexistent components.
pub fn resolve_path(path: &Path) -> io::Result<PathBuf> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()?.join(path)
    };
    if let Ok(canon) = fs::canonicalize(&abs) {
        return Ok(canon);
    }
    let mut resolved = PathBuf::new();
    let mut hit_missing = false;
    for comp in abs.components() {
        match comp {
            Component::Prefix(p) => resolved.push(p.as_os_str()),
            Component::RootDir => resolved.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
                if !hit_missing && let Ok(canon) = fs::canonicalize(&resolved) {
                    resolved = canon;
                }
            }
            Component::Normal(part) => {
                resolved.push(part);
                if !hit_missing {
                    match fs::canonicalize(&resolved) {
                        Ok(canon) => resolved = canon,
                        Err(_) => hit_missing = true,
                    }
                }
            }
        }
    }
    Ok(resolved)
}

/// Current UTC time as whole seconds since the Unix epoch.
#[must_use]
pub fn utc_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + i64::from(m <= 2);
    (y, m as u32, d as u32)
}

/// Format Unix epoch seconds as `YYYY-MM-DDTHH:MM:SSZ` matching `mailbox_store.stamp()`.
#[must_use]
pub fn format_utc_iso_z(epoch_secs: i64) -> String {
    let days = epoch_secs.div_euclid(86_400);
    let secs_of_day = epoch_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(y) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Parse an ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SS[.frac][Z|+HH:MM|-HH:MM]`) into UTC epoch seconds.
#[must_use]
pub fn parse_iso8601_utc_secs(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || (b[10] != b'T' && b[10] != b't' && b[10] != b' ')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;

    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&second)
    {
        return None;
    }

    let mut rest = &s[19..];
    if let Some(after_dot) = rest.strip_prefix('.') {
        let frac_len = after_dot.bytes().take_while(|c| c.is_ascii_digit()).count();
        if frac_len == 0 {
            return None;
        }
        rest = &after_dot[frac_len..];
    }

    let tz_offset: i64 = if rest.is_empty() || rest == "Z" || rest == "z" {
        0
    } else if let Some(sign_char) = rest.chars().next()
        && (sign_char == '+' || sign_char == '-')
    {
        let sign = if sign_char == '+' { 1 } else { -1 };
        let tz = &rest[1..];
        let (tz_h, tz_m): (i64, i64) = if tz.len() == 5 && &tz[2..3] == ":" {
            (tz[0..2].parse().ok()?, tz[3..5].parse().ok()?)
        } else if tz.len() == 4 {
            (tz[0..2].parse().ok()?, tz[2..4].parse().ok()?)
        } else if tz.len() == 2 {
            (tz[0..2].parse().ok()?, 0)
        } else {
            return None;
        };
        if !(0..=23).contains(&tz_h) || !(0..=59).contains(&tz_m) {
            return None;
        }
        sign * (tz_h * 3600 + tz_m * 60)
    } else {
        return None;
    };

    let days = days_from_civil(year, i64::from(month), i64::from(day));
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - tz_offset)
}

/// Validate a peer JSON object matching `mailbox_store.py::valid_peer`.
#[must_use]
pub fn valid_peer(peer: &serde_json::Value) -> bool {
    let Some(obj) = peer.as_object() else {
        return false;
    };
    if obj.get("schema").and_then(|v| v.as_str()) != Some("agent-executor.peer.v1") {
        return false;
    }
    for field in ["session", "name", "harness", "cwd"] {
        if !obj.get(field).is_some_and(|v| v.is_string()) {
            return false;
        }
    }
    let started_ok = obj
        .get("startedAt")
        .and_then(|v| v.as_str())
        .is_some_and(|s| parse_iso8601_utc_secs(s).is_some());
    let seen_ok = obj
        .get("lastSeenAt")
        .and_then(|v| v.as_str())
        .is_some_and(|s| parse_iso8601_utc_secs(s).is_some());
    started_ok && seen_ok
}

/// Schema of `<base>/rooms-index.json`, written by `horde-room.mjs` after every room commit.
pub const ROOMS_INDEX_SCHEMA: &str = "orkest.rooms-index.v1";

fn status_is_closed(status: Option<&serde_json::Value>) -> bool {
    let status = status
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(status.as_str(), "closed" | "archived" | "completed")
}

/// `Some(answer)` from a valid rooms index, `None` when it is missing or unreadable.
fn index_has_active_session(base: &Path, session: &str) -> Option<bool> {
    let content = fs::read_to_string(base.join("rooms-index.json")).ok()?;
    let index: serde_json::Value = serde_json::from_str(&content).ok()?;
    if index.get("schema").and_then(|v| v.as_str()) != Some(ROOMS_INDEX_SCHEMA) {
        return None;
    }
    let rooms = index.get("rooms")?.as_array()?;
    for room in rooms {
        let closed = room
            .get("closed")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if closed {
            continue;
        }
        let Some(sessions) = room.get("sessions").and_then(|v| v.as_array()) else {
            // A malformed entry cannot prove the session is absent.
            return None;
        };
        if sessions.iter().any(|value| value.as_str() == Some(session)) {
            return Some(true);
        }
    }
    Some(false)
}

/// Legacy `<base>/rooms/*.json` records not yet imported into `rooms.db`.
fn legacy_room_references_session(base: &Path, session: &str) -> bool {
    let rooms_dir = base.join("rooms");
    let Ok(entries) = fs::read_dir(&rooms_dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&p) else {
            continue;
        };
        if !content.contains(session) {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content)
            && val.get("closedAt").is_none_or(serde_json::Value::is_null)
            && !status_is_closed(val.get("status"))
        {
            return true;
        }
    }
    false
}

/// Return true if a team record under `<cache>/authority-v1/*/authority.json` gives `session` a role the
/// Python hook acts on (`mailbox_hooks.succession_notice`, `handoff.find_team`): the lead of an active or
/// pending team, or the deputy of an active one, named by session or (when no session is named) by harness,
/// since the deputy's account and repository are only known to Python. A record that is unreadable or of
/// another schema is skipped, as `authority.load` refuses it there.
#[must_use]
pub fn has_active_authority_for_session(cache: &Path, session: &str, harness: &str) -> bool {
    let Ok(entries) = fs::read_dir(cache.join("authority-v1")) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(content) = fs::read_to_string(entry.path().join("authority.json")) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        if record.get("schema").and_then(|v| v.as_str()) != Some("orchestrate.authority.v1") {
            continue;
        }
        let status = record.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let lead = record
            .get("lead")
            .and_then(|v| v.get("session"))
            .and_then(|v| v.as_str());
        if lead == Some(session) && matches!(status, "active" | "pending") {
            return true;
        }
        if status != "active" {
            continue;
        }
        let Some(deputy) = record.get("deputy").and_then(|v| v.as_object()) else {
            continue;
        };
        match deputy.get("session").and_then(|v| v.as_str()) {
            Some(named) if !named.is_empty() => {
                if named == session {
                    return true;
                }
            }
            _ => {
                if deputy.get("harness").and_then(|v| v.as_str()) == Some(harness)
                    && deputy
                        .get("account")
                        .and_then(|v| v.as_str())
                        .is_some_and(|a| !a.is_empty())
                {
                    return true;
                }
            }
        }
    }
    false
}

/// Return true if an open room may reference `session`, so the hook must take the full path.
///
/// Reads the rooms index first. Unimported legacy room files still count. When `rooms.db`
/// exists without a valid index, the answer is unknown and therefore conservatively true.
#[must_use]
pub fn has_active_room_for_session(base: &Path, session: &str) -> bool {
    if legacy_room_references_session(base, session) {
        return true;
    }
    match index_has_active_session(base, session) {
        Some(found) => found,
        None => base.join("rooms.db").exists(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_key() {
        assert_eq!(session_key("session-123").unwrap(), "session-123");
        assert_eq!(session_key("session:123").unwrap(), "session%3A123");
        // Upper case gets SHA-1 trailer
        let with_upper = session_key("Session123").unwrap();
        assert!(with_upper.starts_with("Session123~"));
        assert_eq!(with_upper.len(), "Session123~".len() + 10);
    }

    #[test]
    fn test_expand_home() {
        let fake_home = Path::new("/custom/home");
        assert_eq!(expand_home("~", Some(fake_home)), fake_home);
        assert_eq!(
            expand_home("~/dir/file", Some(fake_home)),
            fake_home.join("dir/file")
        );
        assert_eq!(
            expand_home("/absolute/path", Some(fake_home)),
            PathBuf::from("/absolute/path")
        );
    }

    #[test]
    fn test_cache_and_config_paths() {
        let fake_home = Path::new("/fake/home");
        let mut map = HashMap::new();
        map.insert("ORCHESTRATE_HOME".to_string(), "~/custom-cache".to_string());
        map.insert(
            "ORCHESTRATE_CONFIG".to_string(),
            "~/custom-cfg/cfg.json".to_string(),
        );

        let cache = cache_home(Some(&map), Some(fake_home));
        assert_eq!(cache, fake_home.join("custom-cache"));

        let cfg_dir = config_home(Some(&map), Some(fake_home));
        assert_eq!(cfg_dir, fake_home.join("custom-cfg"));

        let cfg_file = config_path(Some(&map), Some(fake_home));
        assert_eq!(cfg_file, fake_home.join("custom-cfg/cfg.json"));

        let bin = ork_fast_bin(Some(&map), Some(fake_home));
        assert_eq!(bin, Some(fake_home.join("custom-cache/bin/ork-fast")));

        map.insert("ORK_DISABLE_FAST".to_string(), "1".to_string());
        assert_eq!(ork_fast_bin(Some(&map), Some(fake_home)), None);
    }

    #[test]
    fn test_iso8601_roundtrip_and_parse() {
        assert_eq!(format_utc_iso_z(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc_iso_z(1_709_209_496), "2024-02-29T12:24:56Z");
        assert_eq!(parse_iso8601_utc_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_iso8601_utc_secs("2024-02-29T12:24:56Z"),
            Some(1_709_209_496)
        );
        assert_eq!(
            parse_iso8601_utc_secs("2024-02-29T14:24:56.123456+02:00"),
            Some(1_709_209_496)
        );
        assert_eq!(parse_iso8601_utc_secs("not-a-timestamp"), None);
    }

    #[test]
    fn test_resolve_path_nonexistent_leaf() {
        let dir = env::temp_dir().join(format!("ork-fast-resolve-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let canonical_dir = fs::canonicalize(&dir).unwrap();

        let missing = dir
            .join("missing-a")
            .join("missing-b")
            .join("..")
            .join("leaf");
        assert_eq!(
            resolve_path(&missing).unwrap(),
            canonical_dir.join("missing-a").join("leaf")
        );
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn test_has_active_authority_for_session() {
        let cache = env::temp_dir().join(format!("ork-fast-authority-{}", std::process::id()));
        let _ = fs::remove_dir_all(&cache);
        assert!(!has_active_authority_for_session(&cache, "lead", "claude"));
        let write = |team: &str, record: &serde_json::Value| {
            let dir = cache.join("authority-v1").join(team);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("authority.json"), record.to_string()).unwrap();
        };
        let schema = "orchestrate.authority.v1";
        write(
            "a",
            &serde_json::json!({"schema": schema, "status": "active", "lead": {"session": "lead"},
                "deputy": {"session": "dep", "harness": "codex", "account": "codex"}}),
        );
        write(
            "b",
            &serde_json::json!({"schema": schema, "status": "pending", "lead": {"session": "next"},
                "deputy": {"session": "pending-dep"}}),
        );
        write(
            "c",
            &serde_json::json!({"schema": schema, "status": "active", "lead": {"session": "other"},
                "deputy": {"harness": "gemini", "account": "agy"}}),
        );
        write(
            "d",
            &serde_json::json!({"schema": "other", "status": "active", "lead": {"session": "wrong"}}),
        );
        fs::create_dir_all(cache.join("authority-v1").join("e")).unwrap();
        fs::write(cache.join("authority-v1/e/authority.json"), "{not json").unwrap();
        assert!(has_active_authority_for_session(&cache, "lead", "claude"));
        assert!(has_active_authority_for_session(&cache, "dep", "claude"));
        assert!(has_active_authority_for_session(&cache, "next", "claude"));
        assert!(!has_active_authority_for_session(
            &cache,
            "pending-dep",
            "claude"
        ));
        assert!(has_active_authority_for_session(&cache, "anyone", "gemini"));
        assert!(!has_active_authority_for_session(
            &cache, "anyone", "claude"
        ));
        assert!(!has_active_authority_for_session(&cache, "wrong", "claude"));
        let _ = fs::remove_dir_all(&cache);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("ork-fast-rooms-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_rooms_index_answers_for_sqlite_store() {
        let dir = scratch("index");
        fs::write(dir.join("rooms.db"), b"").unwrap();
        fs::write(
            dir.join("rooms-index.json"),
            r#"{"schema":"orkest.rooms-index.v1","rooms":[
              {"id":"open","closed":false,"sessions":["session-open"]},
              {"id":"done","closed":true,"sessions":["session-closed"]}]}"#,
        )
        .unwrap();
        assert!(has_active_room_for_session(&dir, "session-open"));
        assert!(!has_active_room_for_session(&dir, "session-closed"));
        assert!(!has_active_room_for_session(&dir, "session-other"));
        assert!(!has_active_room_for_session(&dir, "session"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_rooms_index_missing_or_invalid_is_conservative() {
        let dir = scratch("conservative");
        assert!(!has_active_room_for_session(&dir, "session-a"));
        fs::write(dir.join("rooms.db"), b"").unwrap();
        assert!(has_active_room_for_session(&dir, "session-a"));
        fs::write(
            dir.join("rooms-index.json"),
            r#"{"schema":"other","rooms":[]}"#,
        )
        .unwrap();
        assert!(has_active_room_for_session(&dir, "session-a"));
        fs::write(
            dir.join("rooms-index.json"),
            r#"{"schema":"orkest.rooms-index.v1","rooms":[{"id":"x","closed":false}]}"#,
        )
        .unwrap();
        assert!(has_active_room_for_session(&dir, "session-a"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_legacy_room_files_still_count() {
        let dir = scratch("legacy");
        fs::create_dir_all(dir.join("rooms")).unwrap();
        fs::write(
            dir.join("rooms/a.json"),
            r#"{"id":"a","conductor":{"session":{"id":"session-legacy"}}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("rooms/b.json"),
            r#"{"id":"b","closedAt":"2026-01-01T00:00:00Z","agents":[{"session":{"id":"session-closed"}}]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("rooms-index.json"),
            r#"{"schema":"orkest.rooms-index.v1","rooms":[]}"#,
        )
        .unwrap();
        assert!(has_active_room_for_session(&dir, "session-legacy"));
        assert!(!has_active_room_for_session(&dir, "session-closed"));
        let _ = fs::remove_dir_all(&dir);
    }
}
