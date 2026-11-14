//! Shared runtime path discovery matching runtime_paths.py and runtime-paths.mjs.

use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

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
}
