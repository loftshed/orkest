//! Terminal pane binding (Herdr, Orca, private Orkest tmux), label formatting, and pane lookup.

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::identity;
use crate::paths;
use crate::rooms_work::{self, ProgressRecord};

pub const SUBAGENT_MAX_STALE_SEC: i64 = 1800;
pub const HERDR_RESYNC_TTL_SEC: f64 = 90.0;
pub const ORCA_TERMINALS_SCHEMA: &str = "orkest.orca-terminals.v1";

const ORCA_FIELDS: &[&str] = &[
    "orcaPaneKey",
    "orcaTerminalHandle",
    "orcaWorkspaceId",
    "orcaTabId",
    "orcaEnvironment",
];

const HERDR_CLEAR_FIELDS: &[&str] = &[
    "herdrPaneId",
    "herdrWorkspaceId",
    "herdrEndpoint",
    "herdrBinary",
    "herdrSyncedTitle",
    "herdrSyncedTarget",
    "herdrSyncedAt",
    "herdrTerminalId",
    "herdrDiscoveryMissAt",
];

/// Strip ANSI escape sequences (CSI/OSC) and control/format characters, collapsing whitespace.
#[must_use]
pub fn plain(value: &str) -> String {
    let mut stripped = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    for ch in chars.by_ref() {
                        if ('@'..='~').contains(&ch) {
                            break;
                        }
                    }
                    continue;
                }
                Some(']') => {
                    chars.next();
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' {
                            break;
                        }
                        if ch == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                    continue;
                }
                _ => {}
            }
        }
        if c.is_control()
            || matches!(
                c,
                '\u{00ad}'
                    | '\u{200b}'..='\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2060}'..='\u{206f}'
                    | '\u{feff}'
            )
        {
            continue;
        }
        stripped.push(c);
    }
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Collapse and bound `value` to `limit` characters, preserving trailing 4 chars (`herdr_labels.bounded`).
#[must_use]
pub fn bounded(value: &str, limit: usize) -> String {
    let clean = plain(value);
    let count = clean.chars().count();
    if count <= limit || limit <= 5 {
        return clean;
    }
    let head: String = clean.chars().take(limit - 5).collect();
    let tail: String = clean.chars().skip(count - 4).collect();
    format!("{head}…{tail}")
}

fn harness_glyph(harness: Option<&str>) -> &'static str {
    let normalized = match harness {
        Some("agy") => Some("gemini"),
        other => other,
    };
    let tier = env::var("ORK_GLYPHS")
        .unwrap_or_else(|_| "nerd".to_string())
        .trim()
        .to_ascii_lowercase();
    match (tier.as_str(), normalized) {
        ("nerd", Some("codex")) => "\u{ec81}",
        ("nerd", Some("claude")) => "\u{f2db}",
        ("nerd", Some("gemini")) => "\u{f1a0}",
        ("nerd", Some("opencode")) => "\u{f121}",
        ("ascii", Some("codex")) => "[C]",
        ("ascii", Some("claude")) => "[A]",
        ("ascii", Some("gemini")) => "[G]",
        ("ascii", Some("opencode")) => "[O]",
        ("unicode", Some("codex")) => "⚙",
        ("unicode", Some("claude")) => "✳",
        ("unicode", Some("gemini")) => "✦",
        ("unicode", Some("opencode")) => "◇",
        (_, Some("codex")) => "⚙",
        (_, Some("claude")) => "✳",
        (_, Some("gemini")) => "✦",
        (_, Some("opencode")) => "◇",
        _ => "",
    }
}

#[must_use]
pub fn display_label(peer: &Value) -> String {
    let icon = harness_glyph(peer.get("harness").and_then(Value::as_str));
    let name_raw = peer
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| peer.get("person").and_then(Value::as_str))
        .unwrap_or("");
    let cleaned_name = plain(name_raw);
    let joined = match (icon.is_empty(), cleaned_name.is_empty()) {
        (true, _) => cleaned_name,
        (false, true) => icon.to_string(),
        (false, false) => format!("{icon} {cleaned_name}"),
    };
    bounded(&joined, 80)
}

#[must_use]
pub fn work_title(progress: Option<&ProgressRecord>, structural_role: &str) -> String {
    let mut parts = Vec::new();
    let role = plain(structural_role);
    if !role.is_empty() {
        parts.push(role);
    }
    if let Some(p) = progress {
        let stage = plain(&p.stage);
        if !stage.is_empty() {
            parts.push(stage);
        }
        let task = plain(&p.task);
        if !task.is_empty() {
            parts.push(task);
        }
    }
    bounded(&parts.join(" · "), 80)
}

fn is_lower_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        if matches!(i, 8 | 13 | 18 | 23) {
            if b != b'-' {
                return false;
            }
        } else if !matches!(b, b'0'..=b'9' | b'a'..=b'f') {
            return false;
        }
    }
    true
}

fn is_uuid_prefix(s: &str, min_tail: usize, max_tail: usize) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let hex = |p: &str, exact: usize| {
        p.len() == exact && p.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    };
    hex(parts[0], 8)
        && hex(parts[1], 4)
        && hex(parts[2], 4)
        && hex(parts[3], 4)
        && (min_tail..=max_tail).contains(&parts[4].len())
        && parts[4]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[must_use]
pub fn codex_title_session(title: &str, sessions: &HashSet<String>) -> Option<String> {
    let cleaned = plain(title);
    let tail = cleaned.rsplit(" | ").next().unwrap_or(&cleaned);
    if sessions.contains(tail) {
        return Some(tail.to_string());
    }
    let prefix = tail
        .strip_suffix("...")
        .or_else(|| tail.strip_suffix('…'))?;
    if !is_uuid_prefix(prefix, 5, 5) {
        return None;
    }
    let mut matches = sessions
        .iter()
        .filter(|s| s.starts_with(prefix) && is_lower_uuid(s));
    let first = matches.next()?;
    if matches.next().is_some() {
        None
    } else {
        Some(first.clone())
    }
}

fn clean_120(val: Option<&Value>) -> String {
    val.and_then(Value::as_str)
        .map(|s| paths::clean_text(s, 120))
        .unwrap_or_default()
}

fn extract_model_and_effort(
    peer: Option<&Value>,
    payload: Option<&Value>,
) -> (String, String, String) {
    let peer_obj = peer.and_then(Value::as_object);
    let payload_obj = payload.and_then(Value::as_object);

    let raw_model_val = peer_obj
        .and_then(|p| {
            p.get("stepModel")
                .filter(|v| paths::is_truthy_json(v))
                .or_else(|| p.get("executionModel").filter(|v| paths::is_truthy_json(v)))
                .or_else(|| p.get("sessionModel").filter(|v| paths::is_truthy_json(v)))
                .or_else(|| p.get("model").filter(|v| paths::is_truthy_json(v)))
        })
        .or_else(|| payload_obj.and_then(|p| p.get("model").filter(|v| paths::is_truthy_json(v))));

    let mut raw_effort_val = peer_obj
        .and_then(|p| p.get("effort").filter(|v| paths::is_truthy_json(v)))
        .or_else(|| payload_obj.and_then(|p| p.get("effort").filter(|v| paths::is_truthy_json(v))));

    let model_text = if let Some(Value::Object(model_obj)) = raw_model_val {
        if raw_effort_val.is_none() {
            raw_effort_val = model_obj
                .get("effort")
                .filter(|v| paths::is_truthy_json(v))
                .or_else(|| model_obj.get("level").filter(|v| paths::is_truthy_json(v)));
        }
        model_obj
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| model_obj.get("id").and_then(Value::as_str))
            .unwrap_or("")
    } else {
        raw_model_val.and_then(Value::as_str).unwrap_or("")
    };

    let effort_str_raw = match raw_effort_val {
        Some(Value::Object(effort_obj)) => effort_obj
            .get("level")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| effort_obj.get("effort").and_then(Value::as_str))
            .unwrap_or(""),
        Some(Value::String(s)) => s.as_str(),
        _ => "",
    };

    let final_effort_raw = if !effort_str_raw.is_empty() {
        effort_str_raw
    } else {
        payload_obj
            .and_then(|p| p.get("effortLevel").and_then(Value::as_str))
            .filter(|s| !s.is_empty())
            .or_else(|| {
                payload_obj
                    .and_then(|p| p.get("reasoning_effort").and_then(Value::as_str))
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                peer_obj
                    .and_then(|p| p.get("effortLevel").and_then(Value::as_str))
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or("")
    };

    let mut model_str = paths::clean_text(model_text, 120);
    if model_str.eq_ignore_ascii_case("auto") {
        model_str.clear();
    }
    let mut effort_str = paths::clean_text(final_effort_raw, 120);
    if effort_str == "—" {
        effort_str.clear();
    }
    let source_str = peer_obj
        .and_then(|p| p.get("modelSource").and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .or_else(|| {
            if payload_obj
                .and_then(|p| p.get("model"))
                .is_some_and(paths::is_truthy_json)
            {
                Some("runtime")
            } else {
                None
            }
        })
        .map(|s| paths::clean_text(s, 120))
        .unwrap_or_default();

    (model_str, effort_str, source_str)
}

#[derive(Default)]
struct ChildAggregate {
    count: usize,
    summary: String,
    digest: String,
}

fn aggregate_children(base: &Path, parent_peer: &Value) -> ChildAggregate {
    let parent_session = clean_120(parent_peer.get("session"));
    let parent_account = clean_120(parent_peer.get("accountHome"));
    let parent_checkout_raw = parent_peer
        .get("checkout")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| parent_peer.get("cwd").and_then(Value::as_str));
    let Some(parent_checkout_raw) = parent_checkout_raw.filter(|s| !s.trim().is_empty()) else {
        return ChildAggregate::default();
    };
    if parent_session.is_empty() {
        return ChildAggregate::default();
    }
    let Ok(parent_checkout) = paths::resolve_path(&paths::expand_home(parent_checkout_raw, None))
    else {
        return ChildAggregate::default();
    };

    let peers_dir = base.join("peers");
    let Ok(entries) = fs::read_dir(&peers_dir) else {
        return ChildAggregate::default();
    };
    let mut paths_list: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    paths_list.sort();

    let now_secs = paths::utc_now_secs();
    let mut children: Vec<(String, String, String, String, String)> = Vec::new();
    for path in paths_list {
        let Some(peer) = paths::read_json_file(&path) else {
            continue;
        };
        if !paths::valid_peer(&peer) || !peer.get("isSubagent").is_some_and(paths::is_truthy_json) {
            continue;
        }
        if clean_120(peer.get("parentSession")) != parent_session {
            continue;
        }
        let child_account = clean_120(peer.get("accountHome"));
        if !parent_account.is_empty() && child_account != parent_account {
            continue;
        }
        let child_checkout_raw = peer
            .get("checkout")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .or_else(|| peer.get("cwd").and_then(Value::as_str));
        let Some(child_checkout_raw) = child_checkout_raw.filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        let Ok(child_checkout) = paths::resolve_path(&paths::expand_home(child_checkout_raw, None))
        else {
            continue;
        };
        if child_checkout != parent_checkout {
            continue;
        }
        if peer.get("state").and_then(Value::as_str) != Some("busy")
            || peer
                .get("lastStopReason")
                .is_some_and(paths::is_truthy_json)
        {
            continue;
        }
        if !identity::is_live_peer(&peer, Some(now_secs)) {
            continue;
        }
        let seen_stamp = peer
            .get("lastSeenAt")
            .and_then(Value::as_str)
            .or_else(|| peer.get("startedAt").and_then(Value::as_str));
        if let Some(stamp) = seen_stamp
            && let Some(ts) = paths::parse_iso8601_utc_secs(stamp)
            && now_secs - ts > SUBAGENT_MAX_STALE_SEC
        {
            continue;
        }

        let (model_str, effort_str, source_str) = extract_model_and_effort(Some(&peer), None);
        let provenance = if source_str == "runtime" && !model_str.is_empty() {
            "observed".to_string()
        } else if !model_str.is_empty() {
            "requested".to_string()
        } else {
            "unknown".to_string()
        };
        let spec = if !model_str.is_empty() && !effort_str.is_empty() {
            format!("{model_str}/{effort_str}")
        } else if !model_str.is_empty() {
            model_str.clone()
        } else if !effort_str.is_empty() {
            effort_str.clone()
        } else {
            "subagent".to_string()
        };
        children.push((
            clean_120(peer.get("session")),
            model_str,
            effort_str,
            provenance,
            spec,
        ));
    }

    if children.is_empty() {
        return ChildAggregate::default();
    }
    let count = children.len();
    let noun = if count == 1 {
        "1 child".to_string()
    } else {
        format!("{count} children")
    };
    let mut specs: Vec<String> = Vec::new();
    for (_, model, _, prov, spec) in &children {
        let label = if prov == "observed" && !model.is_empty() {
            format!("{spec} observed")
        } else {
            spec.clone()
        };
        if !specs.contains(&label) {
            specs.push(label);
        }
    }
    let mut detail = specs.iter().take(2).cloned().collect::<Vec<_>>().join(", ");
    if specs.len() > 2 {
        detail = format!("{detail}, +{}", specs.len() - 2);
    }
    let summary = if detail.is_empty() {
        noun
    } else {
        format!("{noun}: {detail}")
    };
    let digest = children
        .iter()
        .map(|(child_sid, model, effort, prov, _)| format!("{child_sid}:{model}:{effort}:{prov}"))
        .collect::<Vec<_>>()
        .join(";");
    ChildAggregate {
        count,
        summary,
        digest,
    }
}

#[must_use]
pub fn valid_tmux_server(server: &str) -> bool {
    let Some(hex) = server.strip_prefix("orkest-label-") else {
        return false;
    };
    hex.len() == 12 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[must_use]
pub fn valid_tmux_pane(pane: &str) -> bool {
    let Some(digits) = pane.strip_prefix('%') else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Private Orkest tmux context matching `agent_terminal.py::context`.
#[must_use]
pub fn terminal_context(harness: Option<&str>) -> Option<(String, String)> {
    let server = env::var("ORKEST_TERMINAL_SERVER").ok()?;
    let pane = env::var("TMUX_PANE").ok()?;
    let tmux_env = env::var("TMUX").unwrap_or_default();
    let socket_path = tmux_env.split(',').next().unwrap_or("");
    let socket_name = Path::new(socket_path)
        .file_name()
        .and_then(|n| n.to_str())?;
    let expected_harness = env::var("ORKEST_TERMINAL_HARNESS").ok();
    if !valid_tmux_server(&server)
        || !valid_tmux_pane(&pane)
        || socket_name != server
        || harness != expected_harness.as_deref()
    {
        return None;
    }
    Some((server, pane))
}

fn herdr_context(harness: Option<&str>) -> Option<(String, Option<String>)> {
    if env::var("HERDR_ENV").as_deref() != Ok("1") {
        return None;
    }
    let pane = env::var("HERDR_PANE_ID").ok()?.trim().to_string();
    if pane.is_empty() {
        return None;
    }
    let expected_harness = env::var("ORKEST_TERMINAL_HARNESS")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let (Some(exp), Some(h)) = (expected_harness.as_deref(), harness)
        && exp != h
    {
        return None;
    }
    let workspace = env::var("HERDR_WORKSPACE_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some((pane, workspace))
}

pub(crate) fn canonical_endpoint(path: Option<&str>) -> Option<String> {
    let p = path.filter(|s| !s.is_empty())?;
    paths::resolve_path(&paths::expand_home(p, None))
        .ok()
        .map(|r| r.to_string_lossy().into_owned())
}

/// Resolve the canonical Herdr socket path matching `herdr_context.py::endpoint`.
#[must_use]
pub fn herdr_endpoint() -> String {
    if let Ok(val) = env::var("HERDR_SOCKET_PATH")
        && !val.is_empty()
    {
        return paths::resolve_path(&paths::expand_home(&val, None))
            .unwrap_or_else(|_| PathBuf::from(val))
            .to_string_lossy()
            .into_owned();
    }
    let config_root = env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map_or_else(
            || paths::expand_home("~/.config", None),
            |s| paths::expand_home(&s, None),
        );
    let mut cfg = config_root.join("herdr");
    if let Ok(session_id) = env::var("HERDR_SESSION")
        && !session_id.is_empty()
    {
        cfg = cfg.join("sessions").join(session_id);
    }
    let sock = cfg.join("herdr.sock");
    paths::resolve_path(&sock)
        .unwrap_or(sock)
        .to_string_lossy()
        .into_owned()
}

/// True when the Herdr socket exists on disk.
#[must_use]
pub fn discovery_available() -> bool {
    Path::new(&herdr_endpoint()).exists()
}

/// True when private tmux or Orca terminal context matches `harness`.
#[must_use]
pub fn has_terminal_or_orca_context(harness: Option<&str>) -> bool {
    terminal_context(harness).is_some() || orca_terminal_context(harness).is_some()
}

fn orca_terminal_handle(val: Option<&str>) -> String {
    let Some(s) = val.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let bytes = s.as_bytes();
    if bytes.len() > 128
        || !bytes[0].is_ascii_alphanumeric() && bytes[0] != b'_'
        || !bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
    {
        return String::new();
    }
    s.to_string()
}

#[derive(Clone)]
struct OrcaContext {
    pane_key: String,
    terminal_handle: String,
    tab_id: String,
    worktree_id: String,
    environment: String,
}

fn orca_terminal_context(harness: Option<&str>) -> Option<OrcaContext> {
    if env::var("HERDR_ENV").as_deref() == Ok("1") {
        return None;
    }
    let pane_key = env::var("ORCA_PANE_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            env::var("ORCA_AGENT_PANE")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })?;
    let expected_harness = env::var("ORKEST_TERMINAL_HARNESS")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let (Some(exp), Some(h)) = (expected_harness.as_deref(), harness)
        && exp != h
    {
        return None;
    }
    Some(OrcaContext {
        pane_key,
        terminal_handle: orca_terminal_handle(env::var("ORCA_TERMINAL_HANDLE").ok().as_deref()),
        tab_id: env::var("ORCA_TAB_ID")
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        worktree_id: env::var("ORCA_WORKTREE_ID")
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        environment: env::var("ORCA_ENVIRONMENT")
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
    })
}

fn orca_registry(cache: &Path) -> Map<String, Value> {
    let Some(data) = paths::read_json_file(&cache.join("orca-terminals-v1.json")) else {
        return Map::new();
    };
    if data.get("schema").and_then(Value::as_str) != Some(ORCA_TERMINALS_SCHEMA) {
        return Map::new();
    }
    data.get("terminals")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn orca_lookup_terminal(pane_key: &str, reg: &Map<String, Value>) -> String {
    if pane_key.is_empty() {
        return String::new();
    }
    let mut matches = HashSet::new();
    for (key, entry) in reg {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        if obj.get("paneKey").and_then(Value::as_str) != Some(pane_key) {
            continue;
        }
        let candidate = obj
            .get("terminalId")
            .and_then(Value::as_str)
            .unwrap_or(key.as_str());
        let handle = orca_terminal_handle(Some(candidate));
        if !handle.is_empty() {
            matches.insert(handle);
        }
    }
    if matches.len() == 1 {
        matches.into_iter().next().unwrap_or_default()
    } else {
        String::new()
    }
}

pub(crate) fn resolve_structural_role(
    base: &Path,
    session: &str,
    harness: Option<&str>,
    peer_data: Option<&Value>,
    only_room: Option<&str>,
) -> (String, String, bool) {
    let owned_peer;
    let peer = if let Some(p) = peer_data {
        p
    } else if let Some(p) = identity::session_peer(base, session, harness, None, false) {
        owned_peer = p;
        &owned_peer
    } else {
        return (String::new(), String::new(), false);
    };
    let peer_cwd = peer
        .get("checkout")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| peer.get("cwd").and_then(Value::as_str));
    let Some(matched) =
        rooms_work::find_session_swarm_room(base, session, harness, peer_cwd, only_room)
    else {
        return (String::new(), String::new(), false);
    };
    let Some(room_id) = matched
        .room
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return (String::new(), String::new(), false);
    };
    let bound_cwd = matched
        .member
        .get("session")
        .and_then(|s| s.get("cwd"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            matched
                .member
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .or_else(|| matched.room.get("cwd").and_then(Value::as_str));
    if let (Some(pc), Some(bc)) = (peer_cwd, bound_cwd)
        && paths::resolve_path(Path::new(pc)).ok() != paths::resolve_path(Path::new(bc)).ok()
    {
        return (String::new(), String::new(), false);
    }
    let native_ids = identity::native_session_ids(Some(peer), Some(base));
    if native_ids.contains(&matched.session_id) {
        let is_exact_conductor = matched.member_id == "conductor";
        let structural_role = if is_exact_conductor {
            "Coordinator"
        } else {
            "Lead"
        };
        (
            room_id.to_string(),
            structural_role.to_string(),
            is_exact_conductor,
        )
    } else {
        (room_id.to_string(), String::new(), false)
    }
}

fn herdr_query_json(
    binary: &str,
    args: &[&str],
    socket_endpoint: &str,
    timeout_ms: u64,
) -> Option<Value> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .env("HERDR_SOCKET_PATH", socket_endpoint)
        .stdin(std::process::Stdio::null());
    let output = paths::run_output_with_timeout(&mut cmd, Duration::from_millis(timeout_ms))?;
    if !output.status.success() {
        return None;
    }
    let payload: Value = serde_json::from_slice(&output.stdout).ok()?;
    payload.get("result").filter(|r| r.is_object()).cloned()
}

fn verified_agent(
    binary: &str,
    mut pane: String,
    sessions: &HashSet<String>,
    socket_endpoint: &str,
) -> Option<Value> {
    if pane.is_empty() || sessions.is_empty() {
        return None;
    }
    let mut result = herdr_query_json(binary, &["agent", "get", &pane], socket_endpoint, 500)
        .filter(|r| !r.as_object().is_none_or(Map::is_empty));
    if result.is_none() {
        let current = herdr_query_json(
            binary,
            &["pane", "current", "--pane", &pane],
            socket_endpoint,
            500,
        )?;
        let canonical = current
            .get("pane")
            .and_then(|p| p.get("pane_id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && *s != pane)?;
        pane = canonical.to_string();
        result = herdr_query_json(binary, &["agent", "get", &pane], socket_endpoint, 500);
    }
    let res_val = result?;
    if res_val.get("type").and_then(Value::as_str) != Some("agent_info") {
        return None;
    }
    let mut agent = res_val.get("agent")?.as_object()?.clone();
    let agent_ref = agent.get("agent_session")?.as_object()?;
    let val = agent_ref.get("value").and_then(Value::as_str)?;
    if agent_ref.get("kind").and_then(Value::as_str) == Some("id") && sessions.contains(val) {
        agent.insert("pane_id".to_string(), Value::String(pane));
        Some(Value::Object(agent))
    } else {
        None
    }
}

fn codex_title_pane(
    base: &Path,
    session: &str,
    binary: &str,
    socket_endpoint: &str,
) -> Option<Value> {
    let peer = identity::session_peer(base, session, Some("codex"), None, false);
    let identities = identity::native_session_ids(peer.as_ref(), Some(base));
    let mut sessions = identities.clone();
    if let Ok(entries) = fs::read_dir(base.join("peers")) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("json")
                && let Some(candidate) = paths::read_json_file(&p)
                && candidate.get("harness").and_then(Value::as_str) == Some("codex")
                && candidate.get("session").is_some_and(Value::is_string)
            {
                sessions.extend(identity::native_session_ids(Some(&candidate), Some(base)));
            }
        }
    }
    let result = herdr_query_json(binary, &["pane", "list"], socket_endpoint, 500)?;
    let panes = result.get("panes").and_then(Value::as_array)?;
    let mut matches = Vec::new();
    for pane in panes {
        let Some(pane_obj) = pane.as_object() else {
            continue;
        };
        if pane_obj.get("agent").and_then(Value::as_str) != Some("codex")
            || !pane_obj.get("pane_id").is_some_and(paths::is_truthy_json)
        {
            continue;
        }
        if let Some(agent_ref) = pane_obj.get("agent_session")
            && !agent_ref.is_null()
        {
            let valid_ref = agent_ref.as_object().is_some_and(|r| {
                r.get("kind").and_then(Value::as_str) == Some("id")
                    && r.get("value")
                        .and_then(Value::as_str)
                        .is_some_and(|v| identities.contains(v))
                    && r.get("agent").and_then(Value::as_str) == Some("codex")
            });
            if !valid_ref {
                continue;
            }
        }
        let title = pane_obj
            .get("terminal_title")
            .and_then(Value::as_str)
            .unwrap_or("");
        if let Some(matched) = codex_title_session(title, &sessions)
            && identities.contains(&matched)
        {
            matches.push(pane.clone());
        }
    }
    if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    }
}

fn clear_herdr_fields(base: &Path, session: &str, peer: &Value, miss: bool) {
    let mut updates: Vec<(&str, Value)> = Vec::new();
    if let Some(obj) = peer.as_object() {
        for k in obj.keys() {
            if k.starts_with("herdr") {
                updates.push((k.as_str(), Value::Null));
            }
        }
    }
    if miss {
        let existing_miss = peer
            .get("herdrDiscoveryMissAt")
            .and_then(Value::as_f64)
            .unwrap_or_else(now_epoch_f64);
        updates.push(("herdrDiscoveryMissAt", json!(existing_miss)));
    }
    if !updates.is_empty() {
        let _ = identity::annotate_peer(base, session, &updates);
    }
}

fn now_epoch_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

#[allow(clippy::too_many_arguments)]
fn sync_herdr_pane(
    base: &Path,
    session: &str,
    harness: Option<&str>,
    peer_data: Option<&Value>,
    mut pane_id: String,
    mut workspace_id: Option<String>,
    endpoint_raw: &str,
    binary: Option<&str>,
    force: bool,
    structural_role_arg: Option<&str>,
    mut occupant: Option<Value>,
) -> bool {
    let Some(peer_data) = peer_data else {
        return false;
    };
    let owned_role: String;
    let structural_role = if let Some(sr) = structural_role_arg {
        sr
    } else {
        let only_room = env::var("ORKEST_SWARM_ROOM").ok().filter(|s| !s.is_empty());
        let (_, sr, _) = resolve_structural_role(
            base,
            session,
            harness,
            Some(peer_data),
            only_room.as_deref(),
        );
        owned_role = sr;
        &owned_role
    };
    let progress = rooms_work::read_progress(base, peer_data);
    let title = work_title(progress.as_ref(), structural_role);
    let mut display_agent = display_label(peer_data);
    let children = aggregate_children(base, peer_data);
    if children.count > 0 {
        let suffix = format!(" · {}", bounded(&children.summary, 56));
        let limit = 16usize.max(80usize.saturating_sub(suffix.chars().count()));
        display_agent = format!("{}{suffix}", bounded(&display_agent, limit));
    }
    let sync_key = format!("{title}|{display_agent}|{}", children.digest);
    let endpoint = paths::resolve_path(&paths::expand_home(endpoint_raw, None)).map_or_else(
        |_| endpoint_raw.to_string(),
        |p| p.to_string_lossy().into_owned(),
    );

    let mut target = json!({"endpoint": endpoint, "pane": pane_id});
    let previous_target = peer_data
        .get("herdrSyncedTarget")
        .and_then(Value::as_object)
        .map(|t| {
            let mut copy = t.clone();
            if let Some(ep) = t
                .get("endpoint")
                .and_then(Value::as_str)
                .and_then(|s| canonical_endpoint(Some(s)))
            {
                copy.insert("endpoint".to_string(), Value::String(ep));
            }
            Value::Object(copy)
        });
    let now_f64 = now_epoch_f64();
    let expired = match peer_data.get("herdrSyncedAt") {
        Some(Value::Number(n)) => n
            .as_f64()
            .is_none_or(|ts| !(0.0..HERDR_RESYNC_TTL_SEC).contains(&(now_f64 - ts))),
        _ => true,
    };
    let mut changed = force
        || expired
        || peer_data.get("herdrSyncedTitle").and_then(Value::as_str) != Some(sync_key.as_str())
        || previous_target.as_ref() != Some(&target);

    if occupant.is_none()
        && changed
        && let Some(bin) = binary
    {
        let native_ids = identity::native_session_ids(Some(peer_data), Some(base));
        occupant = verified_agent(bin, pane_id.clone(), &native_ids, &endpoint);
    }

    let mut terminal_id: Option<String> = None;
    if let Some(ref occ) = occupant {
        if let Some(pid) = occ.get("pane_id").and_then(Value::as_str) {
            pane_id = pid.to_string();
        }
        workspace_id = occ
            .get("workspace_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| Some(pane_id.split(':').next().unwrap_or("").to_string()));
        terminal_id = occ
            .get("terminal_id")
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    target = json!({"endpoint": endpoint, "pane": pane_id});
    let terminal_changed = terminal_id
        .as_deref()
        .is_some_and(|tid| Some(tid) != peer_data.get("herdrTerminalId").and_then(Value::as_str));
    changed = force
        || expired
        || terminal_changed
        || peer_data.get("herdrSyncedTitle").and_then(Value::as_str) != Some(sync_key.as_str())
        || previous_target.as_ref() != Some(&target);

    let mut annotations: Vec<(&str, Value)> = vec![
        ("terminalServer", Value::Null),
        ("herdrPaneId", Value::String(pane_id.clone())),
        (
            "herdrWorkspaceId",
            workspace_id.map_or(Value::Null, Value::String),
        ),
        ("herdrEndpoint", Value::String(endpoint.clone())),
        (
            "herdrBinary",
            binary.map_or(Value::Null, |b| Value::String(b.to_string())),
        ),
        ("herdrDiscoveryMissAt", Value::Null),
    ];
    if let Some(tid) = terminal_id {
        annotations.push(("herdrTerminalId", Value::String(tid)));
    }
    if !changed {
        annotations.push(("herdrSyncedTarget", target.clone()));
    }
    if changed
        && let Some(bin) = binary
        && let Some(ref occ) = occupant
    {
        let agent_ref = occ.get("agent_session").and_then(Value::as_object);
        let kind = agent_ref
            .and_then(|r| r.get("agent").and_then(Value::as_str))
            .or_else(|| occ.get("agent").and_then(Value::as_str));
        if let Some(kind_str) = kind {
            let seq = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_string();
            let mut cmd = Command::new(bin);
            cmd.args([
                "pane",
                "report-metadata",
                &pane_id,
                "--source",
                "orkest",
                "--agent",
                kind_str,
                "--display-agent",
                &display_agent,
                "--seq",
                &seq,
            ]);
            if title.is_empty() {
                cmd.arg("--clear-title");
            } else {
                cmd.args(["--title", &title]);
            }
            if let Some(src) = agent_ref
                .and_then(|r| r.get("source"))
                .and_then(Value::as_str)
                && src == "herdr:opencode"
            {
                cmd.args(["--applies-to-source", src]);
            }
            cmd.env("HERDR_SOCKET_PATH", &endpoint)
                .stdin(std::process::Stdio::null());
            if let Some(out) = paths::run_output_with_timeout(&mut cmd, Duration::from_millis(500))
                && out.status.success()
            {
                annotations.push(("herdrSyncedTitle", Value::String(sync_key)));
                annotations.push(("herdrSyncedTarget", target));
                annotations.push(("herdrSyncedAt", json!(now_epoch_f64())));
            }
        }
    }

    let peer_obj = peer_data.as_object();
    let filtered: Vec<(&str, Value)> = annotations
        .into_iter()
        .filter(|(k, v)| peer_obj.and_then(|o| o.get(*k)) != Some(v))
        .collect();
    if !filtered.is_empty() {
        let _ = identity::annotate_peer(base, session, &filtered);
    }
    true
}

fn restore_herdr_parent_agent_session(peer_data: &Value, pane_id: &str, endpoint: &str) {
    if peer_data.get("harness").and_then(Value::as_str) != Some("gemini")
        || env::var("HERDR_ENV").as_deref() != Ok("1")
        || env::var("HERDR_PANE_ID").ok().as_deref().map(str::trim) != Some(pane_id)
    {
        return;
    }
    let socket_path = env::var("HERDR_SOCKET_PATH")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| endpoint.to_string());
    if socket_path.is_empty() {
        return;
    }
    let Some(session) = peer_data.get("session").and_then(Value::as_str) else {
        return;
    };
    let seq = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let home_dir = peer_data
        .get("accountHome")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map_or_else(
            || paths::expand_home("~/.gemini", None),
            |s| paths::expand_home(s, None),
        );
    let transcript = home_dir
        .join("antigravity-cli/brain")
        .join(session)
        .join(".system_generated/logs/transcript.jsonl");
    let mut params = Map::new();
    params.insert("pane_id".to_string(), Value::String(pane_id.to_string()));
    params.insert(
        "source".to_string(),
        Value::String("herdr:antigravity_cli".to_string()),
    );
    params.insert("agent".to_string(), Value::String("agy".to_string()));
    params.insert("seq".to_string(), json!(seq));
    params.insert(
        "agent_session_id".to_string(),
        Value::String(session.to_string()),
    );
    if transcript.is_file() {
        params.insert(
            "agent_session_path".to_string(),
            Value::String(transcript.to_string_lossy().into_owned()),
        );
    }
    let req = json!({
        "id": format!("orkest:antigravity_cli:{seq}"),
        "method": "pane.report_agent_session",
        "params": Value::Object(params),
    });
    if let Ok(mut stream) = UnixStream::connect(&socket_path) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
        let line = format!("{req}\n");
        if stream.write_all(line.as_bytes()).is_ok() {
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
        }
    }
}

/// Refresh a parent session's Herdr pane metadata (`agent_terminal.py::refresh_parent_pane`).
pub fn refresh_parent_pane(base: &Path, parent_session: Option<&str>) -> bool {
    let Some(psid) = parent_session.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    if paths::session_key(psid).is_err() {
        return false;
    }
    let Some(peer_data) = identity::session_peer(base, psid, None, None, false) else {
        return false;
    };
    if peer_data
        .get("isSubagent")
        .is_some_and(paths::is_truthy_json)
        || peer_data
            .get("delegatedRun")
            .is_some_and(paths::is_truthy_json)
    {
        return false;
    }
    let pane_id = clean_120(peer_data.get("herdrPaneId"));
    let endpoint = canonical_endpoint(Some(&clean_120(peer_data.get("herdrEndpoint"))));
    let harness = clean_120(peer_data.get("harness"));
    let bin_storage = clean_120(peer_data.get("herdrBinary"));
    let binary = if !bin_storage.is_empty() {
        Some(bin_storage)
    } else if let Ok(v) = env::var("HERDR_BIN_PATH")
        && !v.is_empty()
    {
        Some(v)
    } else {
        paths::find_in_path("herdr").map(|p| p.to_string_lossy().into_owned())
    };
    let (Some(ep), Some(bin)) = (endpoint, binary) else {
        return false;
    };
    if pane_id.is_empty() || harness.is_empty() {
        return false;
    }
    restore_herdr_parent_agent_session(&peer_data, &pane_id, &ep);
    let ws = clean_120(peer_data.get("herdrWorkspaceId"));
    let ws_opt = (!ws.is_empty()).then_some(ws);
    let session = peer_data
        .get("session")
        .and_then(Value::as_str)
        .unwrap_or(psid);
    sync_herdr_pane(
        base,
        session,
        Some(&harness),
        Some(&peer_data),
        pane_id,
        ws_opt,
        &ep,
        Some(&bin),
        false,
        None,
        None,
    )
}

fn bind_orca(
    base: &Path,
    session: &str,
    harness: Option<&str>,
    peer_data: Option<&Value>,
    ctx: &OrcaContext,
) -> bool {
    let Some(peer) = peer_data else {
        return false;
    };
    if peer.get("sharedProcess").is_some_and(paths::is_truthy_json) {
        return false;
    }
    let cache = base.parent().unwrap_or(base);
    let reg = orca_registry(cache);
    let handle = if !ctx.terminal_handle.is_empty() {
        ctx.terminal_handle.clone()
    } else {
        orca_lookup_terminal(&ctx.pane_key, &reg)
    };
    let entry_ws = reg
        .get(&handle)
        .and_then(|e| e.get("workspaceId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let workspace = if !entry_ws.is_empty() {
        entry_ws
    } else {
        ctx.worktree_id.as_str()
    };

    let mut pairs: Vec<(String, Value)> = vec![
        ("terminalServer".to_string(), Value::Null),
        (
            "orcaPaneKey".to_string(),
            Value::String(ctx.pane_key.clone()),
        ),
        (
            "orcaTerminalHandle".to_string(),
            if handle.is_empty() {
                Value::Null
            } else {
                Value::String(handle.clone())
            },
        ),
        (
            "orcaWorkspaceId".to_string(),
            if workspace.is_empty() {
                Value::Null
            } else {
                Value::String(workspace.to_string())
            },
        ),
        (
            "orcaTabId".to_string(),
            if ctx.tab_id.is_empty() {
                Value::Null
            } else {
                Value::String(ctx.tab_id.clone())
            },
        ),
        (
            "orcaEnvironment".to_string(),
            if ctx.environment.is_empty() {
                Value::Null
            } else {
                Value::String(ctx.environment.clone())
            },
        ),
    ];
    if let Some(obj) = peer.as_object() {
        for (k, v) in obj {
            if k.starts_with("herdr") && !v.is_null() {
                pairs.push((k.clone(), Value::Null));
            }
        }
    }
    let peer_obj = peer.as_object();
    let updates_owned: Vec<(&str, &Value)> = pairs
        .iter()
        .filter(|(k, v)| peer_obj.and_then(|o| o.get(k)) != Some(v))
        .map(|(k, v)| (k.as_str(), v))
        .collect();
    if !updates_owned.is_empty() {
        let updates: Vec<(&str, Value)> = updates_owned
            .into_iter()
            .map(|(k, v)| (k, v.clone()))
            .collect();
        let _ = identity::annotate_peer(base, session, &updates);
    }

    let only_room = env::var("ORKEST_SWARM_ROOM").ok().filter(|s| !s.is_empty());
    let (matched_room_id, _, is_exact_conductor) =
        resolve_structural_role(base, session, harness, Some(peer), only_room.as_deref());
    if !matched_room_id.is_empty() && is_exact_conductor && !handle.is_empty() {
        let mut fields = Map::new();
        fields.insert(
            "orcaCoordinatorTerminalId".to_string(),
            Value::String(handle),
        );
        if !workspace.is_empty() {
            fields.insert(
                "orcaWorkspaceId".to_string(),
                Value::String(workspace.to_string()),
            );
        }
        if !ctx.environment.is_empty() {
            fields.insert(
                "orcaEnvironment".to_string(),
                Value::String(ctx.environment.clone()),
            );
        }
        let _ = rooms_work::update_room_metadata(base, &matched_room_id, &fields);
    }
    true
}

/// Bind visible native session to Herdr pane, Orca terminal, or private Orkest tmux pane (`agent_terminal.py::bind`).
pub fn bind_terminal(
    base: &Path,
    mut session: String,
    harness: Option<&str>,
    payload: &Value,
    force: bool,
) -> bool {
    let mut target = terminal_context(harness);
    let mut herdr = herdr_context(harness);
    if herdr.is_some() && harness != Some("codex") {
        target = None;
    }
    if paths::session_key(&session).is_err() {
        return false;
    }
    let cwd_hint = payload.get("cwd").and_then(Value::as_str);
    let mut peer_data = identity::session_peer(base, &session, harness, cwd_hint, false);
    if let Some(ref loaded) = peer_data
        && let Some(resolved_session) = loaded.get("session").and_then(Value::as_str)
    {
        session = resolved_session.to_string();
    }
    if let Some(ref peer) = peer_data
        && (peer.get("isSubagent").is_some_and(paths::is_truthy_json)
            || peer.get("delegatedRun").is_some_and(paths::is_truthy_json))
    {
        return false;
    }
    if target.is_none()
        && let Some(orca) = orca_terminal_context(harness)
    {
        return bind_orca(base, &session, harness, peer_data.as_ref(), &orca);
    }

    let endpoint = herdr_endpoint();
    let herdr_bin = env::var("HERDR_BIN_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| paths::find_in_path("herdr").map(|p| p.to_string_lossy().into_owned()));
    let mut occupant: Option<Value> = None;

    if harness == Some("codex")
        && target.is_none()
        && let Some(ref mut peer) = peer_data
    {
        if force
            && peer
                .get("herdrDiscoveryMissAt")
                .is_some_and(paths::is_truthy_json)
        {
            let _ =
                identity::annotate_peer(base, &session, &[("herdrDiscoveryMissAt", Value::Null)]);
            if let Some(obj) = peer.as_object_mut() {
                obj.insert("herdrDiscoveryMissAt".to_string(), Value::Null);
            }
        }
        if discovery_available()
            && let Some(ref bin) = herdr_bin
            && !peer
                .get("herdrDiscoveryMissAt")
                .is_some_and(paths::is_truthy_json)
        {
            occupant = codex_title_pane(base, &session, bin, &endpoint);
        }
        let Some(ref occ) = occupant else {
            clear_herdr_fields(base, &session, peer, discovery_available());
            return false;
        };
        let pane_id = occ
            .get("pane_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let ws = occ
            .get("workspace_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                let prefix = pane_id.split(':').next().unwrap_or("");
                (!prefix.is_empty()).then(|| prefix.to_string())
            });
        herdr = Some((pane_id, ws));
    } else if harness == Some("codex") {
        herdr = None;
    }

    if target.is_none() && herdr.is_none() {
        return false;
    }

    let only_room = env::var("ORKEST_SWARM_ROOM").ok().filter(|s| !s.is_empty());
    let (matched_room_id, structural_role, is_exact_conductor) = resolve_structural_role(
        base,
        &session,
        harness,
        peer_data.as_ref(),
        only_room.as_deref(),
    );

    if let Some((pane_id, ws)) = herdr {
        sync_herdr_pane(
            base,
            &session,
            harness,
            peer_data.as_ref(),
            pane_id,
            ws,
            &endpoint,
            herdr_bin.as_deref(),
            force,
            Some(&structural_role),
            occupant,
        );
        if !matched_room_id.is_empty() && is_exact_conductor {
            let stored = paths::peer_path(base, &session)
                .ok()
                .and_then(|p| paths::read_json_file(&p))
                .unwrap_or(Value::Null);
            let mut fields = Map::new();
            fields.insert(
                "herdrCoordinatorPaneId".to_string(),
                stored.get("herdrPaneId").cloned().unwrap_or(Value::Null),
            );
            fields.insert("herdrEndpoint".to_string(), Value::String(endpoint));
            if let Some(ws_val) = stored
                .get("herdrWorkspaceId")
                .filter(|v| paths::is_truthy_json(v))
            {
                fields.insert("herdrWorkspaceId".to_string(), ws_val.clone());
            }
            let _ = rooms_work::update_room_metadata(base, &matched_room_id, &fields);
        }
    } else if let Some((ref server, _)) = target {
        let mut annotations: Vec<(&str, Value)> = Vec::new();
        if peer_data
            .as_ref()
            .and_then(|p| p.get("terminalServer"))
            .and_then(Value::as_str)
            != Some(server.as_str())
        {
            annotations.push(("terminalServer", Value::String(server.clone())));
        }
        if let Some(ref peer) = peer_data {
            for &key in HERDR_CLEAR_FIELDS.iter().chain(ORCA_FIELDS.iter()) {
                if peer.get(key).is_some_and(|v| !v.is_null()) {
                    annotations.push((key, Value::Null));
                }
            }
        }
        if !annotations.is_empty() {
            let _ = identity::annotate_peer(base, &session, &annotations);
        }
    }

    let Some((server, pane)) = target else {
        return true;
    };

    let mut fields = Map::new();
    if let Some(payload_obj) = payload.as_object() {
        for key in ["model", "effort", "effortLevel", "reasoning_effort"] {
            match payload_obj.get(key) {
                Some(Value::String(s)) => {
                    fields.insert(
                        key.to_string(),
                        Value::String(s.chars().take(240).collect()),
                    );
                }
                Some(Value::Object(inner)) => {
                    let mut sub = Map::new();
                    for (ik, iv) in inner {
                        if matches!(ik.as_str(), "id" | "display_name" | "effort" | "level")
                            && let Some(s) = iv.as_str()
                        {
                            sub.insert(ik.clone(), Value::String(s.chars().take(240).collect()));
                        }
                    }
                    fields.insert(key.to_string(), Value::Object(sub));
                }
                _ => {}
            }
        }
    }
    let binding = json!({
        "session": session,
        "harness": harness,
        "payload": Value::Object(fields),
    })
    .to_string();

    let mut cmd = Command::new("tmux");
    cmd.args([
        "-L",
        &server,
        "set-option",
        "-p",
        "-t",
        &pane,
        "@orkest_identity",
        &binding,
        ";",
        "set-option",
        "-p",
        "-t",
        &pane,
        "@orkest_session",
        &session,
    ])
    .stdin(std::process::Stdio::null());
    let Some(out) = paths::run_output_with_timeout(&mut cmd, Duration::from_secs(2)) else {
        return false;
    };
    if !out.status.success() {
        return false;
    }

    if !matched_room_id.is_empty() {
        let mut show = Command::new("tmux");
        show.args([
            "-L",
            &server,
            "show-option",
            "-t",
            "orkest",
            "-v",
            "@orkest_room",
        ])
        .stdin(std::process::Stdio::null());
        let existing_empty = paths::run_output_with_timeout(&mut show, Duration::from_secs(2))
            .is_some_and(|o| String::from_utf8_lossy(&o.stdout).trim().is_empty());
        if existing_empty {
            let mut set_room = Command::new("tmux");
            set_room
                .args([
                    "-L",
                    &server,
                    "set-option",
                    "-t",
                    "orkest",
                    "@orkest_room",
                    &matched_room_id,
                ])
                .stdin(std::process::Stdio::null());
            let _ = paths::run_output_with_timeout(&mut set_room, Duration::from_secs(2));
        }
    }
    true
}

/// Read `@orkest_session` / `@orkest_identity` from private tmux pane (`agent_terminal.py::read`).
#[must_use]
pub fn read_terminal_pane(server: &str, pane: &str, harness: &str) -> Option<(String, Value)> {
    if !valid_tmux_server(server) || !valid_tmux_pane(pane) {
        return None;
    }
    let mut cmd = Command::new("tmux");
    cmd.args([
        "-L",
        server,
        "display-message",
        "-p",
        "-t",
        pane,
        "#{@orkest_session}\n#{@orkest_identity}",
    ])
    .stdin(std::process::Stdio::null());
    let out = paths::run_output_with_timeout(&mut cmd, Duration::from_secs(2))?;
    if !out.status.success() || out.stdout.len() > 8192 {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let (session, raw) = text.split_once('\n')?;
    if paths::session_key(session).is_err() {
        return None;
    }
    let data: Value = serde_json::from_str(raw).ok()?;
    if data.get("session").and_then(Value::as_str) == Some(session)
        && data.get("harness").and_then(Value::as_str) == Some(harness)
        && data.get("payload").is_some_and(Value::is_object)
    {
        Some((session.to_string(), data))
    } else {
        None
    }
}

/// Clear `@orkest_session` when pane still holds `session` (`agent_terminal.py::clear`).
pub fn clear_terminal(session: &str, harness: Option<&str>) {
    let Some((server, pane)) = terminal_context(harness) else {
        return;
    };
    if paths::session_key(session).is_err() {
        return;
    }
    let cond = format!("#{{==:#{{@orkest_session}},{session}}}");
    let unset_cmd = paths::shlex_join(["set-option", "-p", "-u", "-t", &pane, "@orkest_session"]);
    let mut cmd = Command::new("tmux");
    cmd.args([
        "-L", &server, "if-shell", "-F", "-t", &pane, &cond, &unset_cmd,
    ])
    .stdin(std::process::Stdio::null());
    let _ = paths::run_output_with_timeout(&mut cmd, Duration::from_secs(2));
}

/// Match a pane PID to a unique live peer via process ancestry (`agent_statusline.py::pane_session`).
#[must_use]
pub fn pane_session(base: &Path, pane_pid: i64, harness: &str) -> Option<String> {
    let mut cmd = Command::new("ps");
    cmd.args(["-axo", "pid=,ppid="])
        .stdin(std::process::Stdio::null());
    let out = paths::run_output_with_timeout(&mut cmd, Duration::from_secs(2))?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut parents: HashMap<i64, i64> = HashMap::new();
    for line in stdout.lines() {
        let mut fields = line.split_whitespace();
        if let (Some(pid_s), Some(ppid_s), None) = (fields.next(), fields.next(), fields.next())
            && let (Ok(pid), Ok(ppid)) = (pid_s.parse::<i64>(), ppid_s.parse::<i64>())
        {
            parents.insert(pid, ppid);
        }
    }
    let in_pane = |mut pid: i64| -> bool {
        let mut seen = HashSet::new();
        while let Some(&ppid) = parents.get(&pid) {
            if !seen.insert(pid) {
                break;
            }
            if pid == pane_pid {
                return true;
            }
            pid = ppid;
        }
        false
    };

    let entries = fs::read_dir(base.join("peers")).ok()?;
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(peer) = paths::read_json_file(&p) else {
            continue;
        };
        if !paths::valid_peer(&peer) || peer.get("harness").and_then(Value::as_str) != Some(harness)
        {
            continue;
        }
        let Some(pid) = peer
            .get("pid")
            .and_then(|v| if v.is_boolean() { None } else { v.as_i64() })
        else {
            continue;
        };
        if in_pane(pid)
            && identity::is_live_peer(&peer, None)
            && let Some(session_id) = peer.get("session").and_then(Value::as_str)
        {
            sessions.push(session_id.to_string());
        }
    }
    if sessions.len() == 1 {
        sessions.into_iter().next()
    } else {
        None
    }
}

/// Match a Codex tmux pane title against Codex peers (`agent_statusline.py::codex_pane_session`).
#[must_use]
pub fn codex_pane_session(base: &Path, pane: &str, server: &str, account: &str) -> Option<String> {
    if !valid_tmux_pane(pane) {
        return None;
    }
    let mut cmd = Command::new("tmux");
    cmd.args([
        "-L",
        server,
        "display-message",
        "-p",
        "-t",
        pane,
        "#{pane_title}",
    ])
    .stdin(std::process::Stdio::null());
    let out = paths::run_output_with_timeout(&mut cmd, Duration::from_secs(2))?;
    if !out.status.success() {
        return None;
    }
    let title = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let prefix = title
        .strip_suffix("...")
        .or_else(|| title.strip_suffix('…'))
        .unwrap_or(&title);
    if !is_uuid_prefix(prefix, 4, 12) {
        return None;
    }
    if title == prefix && prefix.len() != 36 {
        return None;
    }
    let resolved_account = paths::resolve_path(Path::new(account)).ok()?;
    let entries = fs::read_dir(base.join("peers")).ok()?;
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(peer) = paths::read_json_file(&p) else {
            continue;
        };
        if !paths::valid_peer(&peer) || peer.get("harness").and_then(Value::as_str) != Some("codex")
        {
            continue;
        }
        let Some(session_id) = peer.get("session").and_then(Value::as_str) else {
            continue;
        };
        if !session_id.starts_with(prefix) {
            continue;
        }
        let Some(peer_acc) = peer.get("accountHome").and_then(Value::as_str) else {
            continue;
        };
        if paths::resolve_path(Path::new(peer_acc)).ok().as_ref() == Some(&resolved_account) {
            sessions.push(session_id.to_string());
        }
    }
    if sessions.len() == 1 {
        sessions.into_iter().next()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plain_bounded_and_codex_title_session() {
        assert_eq!(
            plain("\x1b[31mhi\x1b[0m \x1b]0;title\x07  world"),
            "hi world"
        );
        let long = "abcdefghijklmnopqrstuvwxyz";
        assert_eq!(bounded(long, 12), "abcdefg…wxyz");

        let sid = "019d8e5f-1234-7000-8000-abcdef123456";
        let sessions = HashSet::from([sid.to_string()]);
        assert_eq!(
            codex_title_session("repo | 019d8e5f-1234-7000-8000-abcde…", &sessions),
            Some(sid.to_string())
        );
        assert_eq!(codex_title_session(sid, &sessions), Some(sid.to_string()));
    }

    #[test]
    fn test_work_title_and_display_label() {
        let prog = ProgressRecord {
            goal: "g".to_string(),
            task: "ship feature".to_string(),
            stage: "working".to_string(),
            role: None,
            work_context: None,
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            stale: false,
        };
        assert_eq!(
            work_title(Some(&prog), "Coordinator"),
            "Coordinator · working · ship feature"
        );
        let peer = json!({"harness": "claude", "name": "ziggy-repo-a1"});
        // Force ascii tier check independent of env? Test plain formatting.
        let label = display_label(&peer);
        assert!(label.contains("ziggy-repo-a1"));
    }
}
