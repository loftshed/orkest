//! Room lookup, task projection (`room_tasks.py`), progress records, workboard assignments/leases, and legacy task notes.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde_json::{Map, Value, json};

use crate::identity;
use crate::paths;
use crate::sha256;
use crate::sqlite;

pub const MAX_ROOMS: usize = 1024;
pub const MAX_TASK_BYTES: u64 = 4 * 1024 * 1024;
pub const WORKBOARD_SCHEMA: &str = "orchestrate.workboard.v1";
pub const WORKBOARD_MAX_ITEMS: usize = 1024;
pub const WORKBOARD_STORE_BYTES: u64 = 4 * 1024 * 1024;
pub const HELP_BOARD_IDLE_SECS: i64 = 15 * 60;
pub const DEFAULT_LEASE_TTL_SECS: i64 = 900;
pub const MIN_LEASE_TTL_SECS: i64 = 60;
pub const MAX_LEASE_TTL_SECS: i64 = 7200;

pub const PROGRESS_SCHEMA: &str = "orchestrate.progress.v1";
pub const PROGRESS_MAX_BYTES: u64 = 8192;
pub const PROGRESS_STALE_AFTER_SECS: i64 = 30 * 60;
pub const PROGRESS_REMIND_AFTER_SECS: i64 = 5 * 60;
pub const PROGRESS_STAGES: &[&str] = &[
    "planning", "working", "testing", "review", "blocked", "complete",
];

pub const TASK_NOTE_SCHEMA: &str = "orchestrate.task-note.v1";
pub const TASK_NOTE_RETENTION_SECS: i64 = 30 * 86_400;

const EMBEDDED_WORKFORCE_ROLES: &str =
    include_str!("../../../plugins/orchestrate/skills/orchestrate/references/workforce-roles.json");

static KNOWN_ROLES_CACHE: OnceLock<HashSet<String>> = OnceLock::new();

const WORKBOARD_REQUIRED_KEYS: &[&str] = &[
    "id",
    "project",
    "creator",
    "integrator",
    "owner",
    "revision",
    "state",
    "dependencies",
    "title",
    "scope",
    "acceptance",
    "createdAt",
    "updatedAt",
    "key",
    "fingerprint",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomTaskSummary {
    pub title: String,
    pub state: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkAssignment {
    pub id: String,
    pub title: String,
    pub state: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgressRecord {
    pub goal: String,
    pub task: String,
    pub stage: String,
    pub role: Option<String>,
    pub work_context: Option<String>,
    pub updated_at: String,
    pub stale: bool,
}

#[derive(Clone, Debug)]
pub struct MatchedSwarmRoom {
    pub room: Value,
    pub member_id: String,
    pub session_id: String,
    pub member: Value,
}

/// Lifecycle string matching `room_store.py::room_lifecycle`.
#[must_use]
pub fn room_lifecycle(room: &Value) -> &str {
    match room.get("lifecycle").and_then(Value::as_str) {
        Some(v @ ("active" | "archived" | "cancelled")) => v,
        _ => "active",
    }
}

/// Active room check matching `room_store.py::is_active_room`.
#[must_use]
pub fn is_active_room(room: &Value) -> bool {
    room_lifecycle(room) == "active"
}

/// Open room check matching `mailbox_hooks.py::_is_open_room`.
#[must_use]
pub fn is_open_room(room: &Value) -> bool {
    if !room.is_object() || !is_active_room(room) {
        return false;
    }
    if room.get("closedAt").is_some_and(paths::is_truthy_json) {
        return false;
    }
    let status = room
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    !matches!(
        status.as_str(),
        "archived" | "closed" | "completed" | "cancelled"
    )
}

#[must_use]
pub fn local_session_binding(room: &Value, member: &Value, host: &str) -> bool {
    let room_machine_ok = match room.get("machine").and_then(Value::as_str) {
        Some(m) if !m.is_empty() => m == host,
        _ => true,
    };
    let member_machine_ok = match member
        .get("session")
        .and_then(|s| s.get("machine"))
        .and_then(Value::as_str)
    {
        Some(m) if !m.is_empty() => m == host,
        _ => true,
    };
    room_machine_ok && member_machine_ok
}

#[must_use]
pub fn room_owner_sessions(room: &Value, member: &Value, is_conductor: bool) -> Vec<String> {
    let mut raw: Vec<&str> = Vec::new();
    if let Some(id) = member
        .get("session")
        .and_then(|s| s.get("id"))
        .and_then(Value::as_str)
    {
        raw.push(id);
    }
    if let Some(ms) = member.get("mailboxSession").and_then(Value::as_str) {
        raw.push(ms);
    }
    if (is_conductor || member.get("id").and_then(Value::as_str) == Some("conductor"))
        && let Some(ps) = room
            .get("promotion")
            .and_then(|p| p.get("session"))
            .and_then(Value::as_str)
    {
        raw.push(ps);
    }
    if let Some(prev) = member.get("previousSessions").and_then(Value::as_array) {
        for item in prev {
            if let Some(s) = item.as_str() {
                raw.push(s);
            }
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for s in raw {
        if !s.is_empty() && seen.insert(s.to_string()) {
            out.push(s.to_string());
        }
    }
    out
}

#[must_use]
pub fn room_session_peers(
    base: &Path,
    room: &Value,
    member: &Value,
    is_conductor: bool,
) -> Vec<Value> {
    let host = paths::current_hostname().unwrap_or_default();
    if !local_session_binding(room, member, &host) {
        return Vec::new();
    }
    let binding = member.get("session");
    let harness_hint = binding
        .and_then(|b| b.get("engine"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            member
                .get("engine")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        });
    let cwd_hint = binding
        .and_then(|b| b.get("cwd"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            member
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            room.get("cwd")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        });

    let mut ordered_keys: Vec<String> = Vec::new();
    let mut by_session: HashMap<String, Value> = HashMap::new();
    for sid in room_owner_sessions(room, member, is_conductor) {
        for owner in identity::session_peer_candidates(base, &sid, harness_hint, cwd_hint, false) {
            let Some(owner_sid) = owner
                .get("session")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            if owner_sid == sid {
                return vec![owner];
            }
            by_session.entry(owner_sid).or_insert_with_key(|k| {
                ordered_keys.push(k.clone());
                owner
            });
        }
    }
    ordered_keys
        .into_iter()
        .filter_map(|k| by_session.remove(&k))
        .collect()
}

#[must_use]
pub fn room_session_peer(
    base: &Path,
    room: &Value,
    member: &Value,
    is_conductor: bool,
) -> Option<Value> {
    let mut peers = room_session_peers(base, room, member, is_conductor);
    if peers.len() == 1 {
        peers.drain(..).next()
    } else {
        None
    }
}

/// Find explicit room/member bindings for `peer`, matching `agent_statusline.py::bound_rooms`.
#[must_use]
pub fn bound_rooms(base: &Path, peer: &Value) -> Vec<(Value, Value)> {
    let rooms = sqlite::list_rooms(base);
    if rooms.len() > MAX_ROOMS {
        return Vec::new();
    }
    let Some(peer_harness) = peer.get("harness").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(peer_session) = peer.get("session").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(checkout_raw) = peer
        .get("checkout")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| peer.get("cwd").and_then(Value::as_str))
    else {
        return Vec::new();
    };
    let Ok(checkout) = paths::resolve_path(Path::new(checkout_raw)) else {
        return Vec::new();
    };
    let host = paths::current_hostname().unwrap_or_default();
    let engine = if peer_harness == "gemini" {
        "agy"
    } else {
        peer_harness
    };

    let mut found = Vec::new();
    for room in rooms {
        if room.get("schema").and_then(Value::as_str) != Some("agent-executor.room.v1")
            || room.get("machine").and_then(Value::as_str) != Some(host.as_str())
        {
            continue;
        }
        let Some(room_cwd_str) = room.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        let Some(agents) = room.get("agents").and_then(Value::as_array) else {
            continue;
        };
        if agents.len() > 64 {
            continue;
        }
        let Ok(room_cwd) = paths::resolve_path(Path::new(room_cwd_str)) else {
            continue;
        };
        if room_cwd != checkout && !identity::same_project(peer, &identity::workspace(room_cwd_str))
        {
            continue;
        }

        let mut members: Vec<(&Value, bool)> = Vec::new();
        if let Some(cond) = room.get("conductor")
            && cond.is_object()
        {
            members.push((cond, true));
        }
        for agent in agents {
            if agent.is_object() {
                members.push((agent, false));
            }
        }
        for (member, is_cond) in members {
            let Some(binding) = member.get("session").and_then(Value::as_object) else {
                continue;
            };
            let Some(resolved) = room_session_peer(base, &room, member, is_cond) else {
                continue;
            };
            if resolved.get("session").and_then(Value::as_str) != Some(peer_session) {
                continue;
            }
            if binding.get("engine").and_then(Value::as_str) != Some(engine)
                || binding.get("machine").and_then(Value::as_str) != Some(host.as_str())
            {
                continue;
            }
            let Some(b_cwd_str) = binding.get("cwd").and_then(Value::as_str) else {
                continue;
            };
            let Ok(b_cwd) = paths::resolve_path(Path::new(b_cwd_str)) else {
                continue;
            };
            if b_cwd == room_cwd || b_cwd == checkout {
                found.push((room.clone(), member.clone()));
            }
        }
    }
    found
}

fn expected_room_engine(harness: Option<&str>) -> Option<&'static str> {
    match harness.unwrap_or("") {
        "gemini" | "agy" => Some("agy"),
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "opencode" => Some("opencode"),
        _ => None,
    }
}

/// Find the best matching active swarm room for a conductor or lead session.
/// Exact match to `agent_statusline_tmux.py::find_session_swarm_room`.
#[must_use]
pub fn find_session_swarm_room(
    base: &Path,
    session_id: &str,
    harness: Option<&str>,
    cwd: Option<&str>,
    only_room: Option<&str>,
) -> Option<MatchedSwarmRoom> {
    let peer = identity::session_peer(base, session_id, harness, cwd, false);
    let candidates: HashSet<String> = if let Some(ref p) = peer {
        identity::native_session_ids(Some(p), Some(base))
    } else {
        HashSet::from([session_id.to_string()])
    };
    if candidates.is_empty() {
        return None;
    }
    let expected_engine = expected_room_engine(harness);
    let resolved_cwd = cwd
        .filter(|s| !s.is_empty())
        .and_then(|s| paths::resolve_path(Path::new(s)).ok());
    let host = paths::current_hostname().unwrap_or_default();

    type RoomMatchScore = (i32, i32, i64, i32, String);
    let mut best: Option<(RoomMatchScore, MatchedSwarmRoom)> = None;
    for room in sqlite::list_rooms(base) {
        if room.get("schema").and_then(Value::as_str) != Some("agent-executor.room.v1")
            || !room.get("swarm").is_some_and(paths::is_truthy_json)
        {
            continue;
        }
        if room.get("closedAt").is_some_and(paths::is_truthy_json)
            || room.get("status").and_then(Value::as_str) == Some("closed")
        {
            continue;
        }
        if !is_active_room(&room) {
            continue;
        }
        if let Some(ref target_cwd) = resolved_cwd
            && let Some(room_cwd) = room.get("cwd").and_then(Value::as_str)
            && paths::resolve_path(Path::new(room_cwd)).ok().as_ref() != Some(target_cwd)
        {
            continue;
        }
        let Some(room_id) = room.get("id").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        if let Some(only) = only_room
            && room_id != only
        {
            continue;
        }
        if let Some(rm) = room.get("machine").and_then(Value::as_str)
            && !rm.is_empty()
            && rm != host
        {
            continue;
        }

        let peer_sid = peer
            .as_ref()
            .and_then(|p| p.get("session"))
            .and_then(Value::as_str);
        let mut matched_member: Option<(String, Value)> = None;
        let mut matched_session: Option<String> = None;
        let mut is_conductor: i32 = 0;
        let mut exact_primary: i32 = 0;

        if let Some(conductor) = room.get("conductor")
            && conductor.is_object()
        {
            if !local_session_binding(&room, conductor, &host) {
                continue;
            }
            let owners = room_session_peers(base, &room, conductor, true);
            if owners.iter().any(|owner| {
                peer_sid.is_none() || owner.get("session").and_then(Value::as_str) != peer_sid
            }) {
                continue;
            }
            let c_engine = conductor.get("engine").and_then(Value::as_str);
            for sid in room_owner_sessions(&room, conductor, true) {
                if candidates.contains(&sid)
                    && (expected_engine.is_none() || c_engine == expected_engine)
                {
                    matched_member = Some(("conductor".to_string(), conductor.clone()));
                    exact_primary = i32::from(sid == session_id);
                    matched_session = Some(sid);
                    is_conductor = 1;
                    break;
                }
            }
        }

        if matched_member.is_none()
            && let Some(agents) = room.get("agents").and_then(Value::as_array)
        {
            for agent in agents {
                if agent.get("role").and_then(Value::as_str) != Some("lead") {
                    continue;
                }
                if !local_session_binding(&room, agent, &host) {
                    continue;
                }
                let owners = room_session_peers(base, &room, agent, false);
                if owners.iter().any(|owner| {
                    peer_sid.is_none() || owner.get("session").and_then(Value::as_str) != peer_sid
                }) {
                    continue;
                }
                let a_engine = agent.get("engine").and_then(Value::as_str);
                let bound_id = agent
                    .get("session")
                    .and_then(|s| s.get("id"))
                    .and_then(Value::as_str);
                let mailbox_sid = agent.get("mailboxSession").and_then(Value::as_str);
                let mut ids: Vec<&str> = Vec::new();
                if let Some(s) = bound_id {
                    ids.push(s);
                }
                if let Some(s) = mailbox_sid {
                    ids.push(s);
                }
                if let Some(prev) = agent.get("previousSessions").and_then(Value::as_array) {
                    for item in prev {
                        if let Some(s) = item.as_str() {
                            ids.push(s);
                        }
                    }
                }
                for sid in ids {
                    if !sid.is_empty()
                        && candidates.contains(sid)
                        && (expected_engine.is_none() || a_engine == expected_engine)
                    {
                        let mid = agent
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        matched_member = Some((mid, agent.clone()));
                        exact_primary = i32::from(sid == session_id);
                        matched_session = Some(sid.to_string());
                        is_conductor = 0;
                        break;
                    }
                }
                if matched_member.is_some() {
                    break;
                }
            }
        }

        let (Some((member_id, member)), Some(member_sid)) = (matched_member, matched_session)
        else {
            continue;
        };
        let same_cwd = i32::from(
            resolved_cwd.is_some()
                && room
                    .get("cwd")
                    .and_then(Value::as_str)
                    .and_then(|c| paths::resolve_path(Path::new(c)).ok())
                    .as_ref()
                    == resolved_cwd.as_ref(),
        );
        // Scale updatedAt float cleanly to microseconds/integer bits for Eq+Ord score tuple.
        let updated_bits = match room.get("updatedAt") {
            Some(Value::Number(n)) => n.as_f64().map_or(0, |f| (f * 1000.0) as i64),
            _ => 0,
        };
        let score = (exact_primary, is_conductor, updated_bits, same_cwd, room_id);
        let replace = best
            .as_ref()
            .is_none_or(|(best_score, _)| score >= *best_score);
        if replace {
            best = Some((
                score,
                MatchedSwarmRoom {
                    room,
                    member_id,
                    session_id: member_sid,
                    member,
                },
            ));
        }
    }

    best.map(|(_, m)| m)
}

pub fn rebind_session_swarm_room(
    base: &Path,
    room_id: &str,
    member_id: &str,
    new_session_id: &str,
) -> Option<Value> {
    let payload = json!({
        "member": member_id,
        "session": new_session_id,
    });
    sqlite::invoke_room_store_bridge(base, "rebind", Some(room_id), Some(&payload))
}

pub fn update_room_metadata(
    base: &Path,
    room_id: &str,
    fields: &Map<String, Value>,
) -> Option<Value> {
    if fields.is_empty() {
        return None;
    }
    let payload = Value::Object(fields.clone());
    sqlite::invoke_room_store_bridge(base, "set-meta", Some(room_id), Some(&payload))
}

pub fn bind_room_conductor(base: &Path, room_id: &str, engine: &str, session_id: &str) -> bool {
    let Some(plugin) = paths::plugin_root() else {
        return false;
    };
    let cli = plugin.join("bin/ork.mjs");
    if !cli.is_file() {
        return false;
    }
    let cache_root = base.parent().unwrap_or(base);
    let node = paths::node_binary();
    Command::new(node)
        .arg(cli)
        .args([
            "rooms",
            "bind",
            "--room",
            room_id,
            "--member",
            "conductor",
            "--engine",
            engine,
            "--session",
            session_id,
        ])
        .env("AGENT_EXECUTOR_HOME", cache_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Project coordinator task record for room/footer displays matching `room_tasks.py::project` + `agent_statusline.py::room_task`.
#[must_use]
pub fn room_task(room: &Value, member: &Value) -> Option<RoomTaskSummary> {
    let binding = member.get("dispatch").and_then(Value::as_object)?;
    let task_dir = binding
        .get("taskDir")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let task_id = binding
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let request_id = binding
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let transport = binding.get("transport").and_then(Value::as_str)?;
    if !matches!(transport, "native" | "executor") {
        return None;
    }
    let task_path = Path::new(task_dir).join("task.json");
    if !task_path.is_absolute() {
        return None;
    }
    let meta = fs::metadata(&task_path).ok()?;
    if meta.len() > MAX_TASK_BYTES {
        return None;
    }
    let task = paths::read_json_file(&task_path)?;
    if !task.get("task_spec").is_some_and(Value::is_object) {
        return None;
    }
    if task.get("schema").and_then(Value::as_str) != Some("agent-executor.task.v1")
        || task.get("task_id").and_then(Value::as_str) != Some(task_id)
    {
        return None;
    }
    let repo = task.get("repository").and_then(Value::as_str)?;
    let expected_cwd = member
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| room.get("cwd").and_then(Value::as_str))?;
    if fs::canonicalize(repo).ok()? != fs::canonicalize(expected_cwd).ok()? {
        return None;
    }

    let runs = task.get("runs").and_then(Value::as_array)?;
    let member_engine = member.get("engine").and_then(Value::as_str)?;
    let matches: Vec<&Value> = runs
        .iter()
        .filter(|r| {
            r.is_object() && r.get("request_id").and_then(Value::as_str) == Some(request_id)
        })
        .collect();
    if matches.len() != 1 {
        return None;
    }
    let anchor = matches[0];
    let anchor_run_id = anchor
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    if let Some(bound_run_id) = binding
        .get("runId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        && anchor_run_id != bound_run_id
    {
        return None;
    }
    if anchor.get("engine").and_then(Value::as_str) != Some(member_engine)
        || anchor.get("transport").and_then(Value::as_str) != Some(transport)
    {
        return None;
    }

    let candidates: Vec<&Value> = runs
        .iter()
        .filter(|r| {
            r.is_object()
                && r.get("engine").and_then(Value::as_str) == Some(member_engine)
                && matches!(
                    r.get("transport").and_then(Value::as_str),
                    Some(t) if t == transport || t == "host_checks"
                )
        })
        .collect();

    let mut by_id: HashMap<&str, &str> = HashMap::new();
    let mut by_result: HashMap<&str, &str> = HashMap::new();
    for r in &candidates {
        let rid = r
            .get("run_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())?;
        by_id.insert(rid, rid);
        if let Some(rp) = r
            .get("result_path")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            by_result.insert(rp, rid);
        }
    }

    let mut chain: HashSet<String> = HashSet::from([anchor_run_id.to_string()]);
    loop {
        let prev_size = chain.len();
        for r in &candidates {
            let kind = r.get("kind").and_then(Value::as_str).unwrap_or("");
            if !matches!(kind, "continue" | "correction" | "verification") {
                continue;
            }
            let Some(rid) = r.get("run_id").and_then(Value::as_str) else {
                continue;
            };
            let parent_id = r
                .get("verification_of")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    r.get("parent_run_id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                });
            let result_ref = r
                .get("resume_result")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    r.get("resumed_from")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                });
            let parent_rid = parent_id
                .and_then(|id| by_id.get(id).copied())
                .or_else(|| result_ref.and_then(|rp| by_result.get(rp).copied()));
            if let Some(parent_run_id) = parent_rid
                && (chain.contains(rid) || chain.contains(parent_run_id))
            {
                chain.insert(rid.to_string());
                chain.insert(parent_run_id.to_string());
            }
        }
        if chain.len() == prev_size {
            break;
        }
    }

    let run = candidates.iter().copied().rfind(|r| {
        r.get("run_id")
            .and_then(Value::as_str)
            .is_some_and(|id| chain.contains(id))
    })?;
    let run_id = run
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;

    let decisions = task.get("decisions").and_then(Value::as_array)?;
    let verdict = decisions
        .iter()
        .rfind(|d| d.is_object() && d.get("run_id").and_then(Value::as_str) == Some(run_id))
        .and_then(|d| d.get("decision"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("pending");

    let run_status_str = run.get("status").and_then(Value::as_str);
    let mut state = match run_status_str {
        Some("reserved") => "reserved",
        Some("active") => "running",
        Some("finished") => "review",
        Some("cancelled") => "cancelled",
        _ => "unknown",
    };
    if run_status_str != Some("cancelled")
        && run.get("runner_status").is_some_and(paths::is_truthy_json)
        && run.get("runner_status").and_then(Value::as_str) != Some("completed")
    {
        state = "failed";
    }
    state = match verdict {
        "accept" => "accepted",
        "supported" => "supported",
        "reject" => "rejected",
        "takeover" => "blocked",
        _ => state,
    };

    let spec = run.get("task_spec").unwrap_or_else(|| &task["task_spec"]);
    let objective = spec
        .as_object()
        .and_then(|s| s.get("objective"))
        .and_then(Value::as_str)
        .unwrap_or("");
    Some(RoomTaskSummary {
        title: paths::clean_text(objective, 240),
        state: state.to_string(),
    })
}

/// Valid workforce roles loaded from `workforce-roles.json` (with embedded fallback).
#[must_use]
pub fn known_roles() -> &'static HashSet<String> {
    KNOWN_ROLES_CACHE.get_or_init(|| {
        let disk = paths::scripts_root()
            .and_then(|s| {
                s.parent()
                    .map(|p| p.join("references/workforce-roles.json"))
            })
            .filter(|p| p.is_file())
            .or_else(|| {
                paths::plugin_root()
                    .map(|p| p.join("skills/orchestrate/references/workforce-roles.json"))
                    .filter(|p| p.is_file())
            })
            .and_then(|p| paths::read_json_file(&p));
        let val = disk
            .or_else(|| serde_json::from_str::<Value>(EMBEDDED_WORKFORCE_ROLES).ok())
            .unwrap_or(Value::Null);
        val.as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default()
    })
}

fn progress_checkout(peer: &Value) -> Option<String> {
    let raw = peer
        .get("checkout")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| peer.get("cwd").and_then(Value::as_str))?;
    paths::resolve_path(Path::new(raw))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Resolved checkout path matching `agent_progress.py::checkout_of`.
#[must_use]
pub fn checkout_of(peer: &Value) -> String {
    progress_checkout(peer).unwrap_or_default()
}

/// Read `<base>/progress/<session_key>.json` matching `agent_progress.py::read`.
#[must_use]
pub fn read_progress(base: &Path, peer: &Value) -> Option<ProgressRecord> {
    let session = peer.get("session").and_then(Value::as_str)?;
    let harness = peer.get("harness").and_then(Value::as_str)?;
    let s_key = paths::session_key(session).ok()?;
    let path = base.join("progress").join(format!("{s_key}.json"));
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > PROGRESS_MAX_BYTES {
        return None;
    }
    let row = paths::read_json_file(&path)?;
    let obj = row.as_object()?;
    let host = paths::current_hostname()?;
    if obj.get("schema").and_then(Value::as_str) != Some(PROGRESS_SCHEMA)
        || obj.get("session").and_then(Value::as_str) != Some(session)
        || obj.get("harness").and_then(Value::as_str) != Some(harness)
        || obj.get("machine").and_then(Value::as_str) != Some(host.as_str())
    {
        return None;
    }
    let peer_account = peer.get("accountHome");
    let row_account = obj.get("accountHome").unwrap_or(&Value::Null);
    if peer_account.unwrap_or(&Value::Null) != row_account {
        return None;
    }
    if obj.get("checkout").and_then(Value::as_str) != progress_checkout(peer).as_deref() {
        return None;
    }
    let stage = obj.get("stage").and_then(Value::as_str)?;
    if !PROGRESS_STAGES.contains(&stage) {
        return None;
    }
    let role = match obj.get("role") {
        None | Some(Value::Null) => None,
        Some(Value::String(r)) if known_roles().contains(r.as_str()) => Some(r.clone()),
        _ => return None,
    };
    let updated_at = obj.get("updatedAt").and_then(Value::as_str)?;
    let updated_secs = paths::parse_iso8601_utc_secs(updated_at)?;
    let goal = obj
        .get("goal")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 160)?;
    let task = obj
        .get("task")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 160)?;
    let age_secs = paths::utc_now_secs() - updated_secs;
    if age_secs < -300 {
        return None;
    }
    let wc = obj
        .get("workContext")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(ProgressRecord {
        goal: goal.to_string(),
        task: task.to_string(),
        stage: stage.to_string(),
        role,
        work_context: wc,
        updated_at: updated_at.to_string(),
        stale: stage != "complete" && age_secs > PROGRESS_STALE_AFTER_SECS,
    })
}

fn read_workboard(path: &Path) -> Option<Value> {
    if !path.exists() {
        return Some(json!({"schema": WORKBOARD_SCHEMA, "items": []}));
    }
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > WORKBOARD_STORE_BYTES {
        return None;
    }
    let board = paths::read_json_file(path)?;
    if board.get("schema").and_then(Value::as_str) != Some(WORKBOARD_SCHEMA) {
        return None;
    }
    let items = board.get("items").and_then(Value::as_array)?;
    if items.len() > WORKBOARD_MAX_ITEMS {
        return None;
    }
    let mut ids = HashSet::with_capacity(items.len());
    for item in items {
        let obj = item.as_object()?;
        if !WORKBOARD_REQUIRED_KEYS.iter().all(|k| obj.contains_key(*k)) {
            return None;
        }
        let id = obj.get("id").and_then(Value::as_str)?;
        if !ids.insert(id) {
            return None;
        }
    }
    Some(board)
}

fn matches_session(peer: &Value, session: Option<&str>) -> bool {
    let Some(sid) = session.filter(|s| !s.is_empty()) else {
        return false;
    };
    if peer.get("session").and_then(Value::as_str) == Some(sid)
        || peer.get("clearedFrom").and_then(Value::as_str) == Some(sid)
    {
        return true;
    }
    peer.get("aliases")
        .and_then(Value::as_array)
        .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(sid)))
}

/// Active workboard assignments matching `mailbox_work.py::assigned`.
#[must_use]
pub fn workboard_assigned(base: &Path, peer: &Value) -> Vec<WorkAssignment> {
    let path = base.join("work/board.json");
    let Some(board) = read_workboard(&path) else {
        return Vec::new();
    };
    let Some(items) = board.get("items").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(owner) = item.get("owner").filter(|o| o.is_object()) else {
            continue;
        };
        let Some(state) = item.get("state").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(state, "claimed" | "blocked" | "review") {
            continue;
        }
        if !matches_session(peer, owner.get("session").and_then(Value::as_str)) {
            continue;
        }
        let Some(project) = item.get("project").filter(|p| p.is_object()) else {
            continue;
        };
        if !identity::same_project(peer, project) {
            continue;
        }
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(title) = item.get("title").and_then(Value::as_str) else {
            continue;
        };
        out.push(WorkAssignment {
            id: id.to_string(),
            title: title.to_string(),
            state: state.to_string(),
        });
    }
    out
}

/// Format a string in Python `json.dumps(s, ensure_ascii=True)` style.
pub(crate) fn py_json_quote_ascii(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c if c.is_ascii() => out.push(c),
            c => {
                use std::fmt::Write;
                let mut utf16 = [0u16; 2];
                for unit in c.encode_utf16(&mut utf16) {
                    let _ = write!(out, "\\u{:04x}", unit);
                }
            }
        }
    }
    out.push('"');
    out
}

/// Bind a progress report to active workboard IDs matching `agent_progress.py::work_context`.
/// Python uses `json.dumps(sorted(ids))`, which inserts `", "` between array elements.
#[must_use]
pub fn work_context(assignments: &[WorkAssignment]) -> Option<String> {
    if assignments.is_empty() {
        return None;
    }
    let mut ids: Vec<&str> = assignments.iter().map(|a| a.id.as_str()).collect();
    ids.sort_unstable();
    let encoded_items: Vec<String> = ids.into_iter().map(py_json_quote_ascii).collect();
    let serialized = format!("[{}]", encoded_items.join(", "));
    Some(sha256::sha256_hex(serialized.as_bytes()))
}

/// Progress reminder text matching `agent_progress.py::reminder`.
#[must_use]
pub fn progress_reminder(base: &Path, peer: &Value, starting: bool) -> String {
    if identity::is_run_peer(Some(peer))
        || peer.get("delegatedRun").is_some_and(paths::is_truthy_json)
    {
        return String::new();
    }
    let Some(session) = peer.get("session").and_then(Value::as_str) else {
        return String::new();
    };
    let row = read_progress(base, peer);
    let assignments = workboard_assigned(base, peer);
    let changed = row.as_ref().is_some_and(|r| {
        r.work_context != work_context(&assignments)
            || (!assignments.is_empty() && !assignments.iter().any(|a| a.title == r.task))
    });
    if !starting {
        if let Some(ref r) = row
            && !r.stale
            && !changed
            && r.stage != "complete"
        {
            return String::new();
        }
        if let Some(last) = peer.get("progressReminderAt").and_then(Value::as_str)
            && let Some(parsed) = paths::parse_iso8601_utc_secs(last)
            && paths::utc_now_secs() - parsed < PROGRESS_REMIND_AFTER_SECS
        {
            return String::new();
        }
    }
    let stamp = paths::format_utc_iso_z(paths::utc_now_secs());
    let _ = identity::annotate_peer(
        base,
        session,
        &[("progressReminderAt", Value::String(stamp))],
    );
    let script_path = paths::scripts_root()
        .map(|s| s.join("agent_progress.py"))
        .or_else(|| {
            paths::plugin_root().map(|p| p.join("skills/orchestrate/scripts/agent_progress.py"))
        })
        .unwrap_or_else(|| PathBuf::from("agent_progress.py"));
    let script_canon = fs::canonicalize(&script_path).unwrap_or(script_path);
    let script_str = script_canon.to_string_lossy();
    let command = paths::shlex_join(["python3", script_str.as_ref(), "--session", session]);
    let health = if changed {
        "out of date"
    } else if row.as_ref().is_some_and(|r| r.stale) {
        "stale"
    } else if row.is_some() {
        "recorded"
    } else {
        "not recorded"
    };
    format!(
        "Orkest footer progress is {health}. For substantive work, report your actual goal, task and stage with \
         {command} --goal 'overall goal' --task 'current task' --stage working. \
         Later, --stage testing (or planning, working, review, blocked, complete) preserves the other fields; \
         no extra fields confirms unchanged work. Update when the assignment or stage changes and before your final response. \
         The workboard remains authoritative for claims, blockers and acceptance. \
         Do not invent work for acknowledgments or infer completion from idle."
    )
}

fn workboard_identity(peer: &Value) -> Value {
    let session = peer.get("session").and_then(Value::as_str).unwrap_or("");
    let name: String = peer
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(session)
        .chars()
        .take(120)
        .collect();
    let harness: String = peer
        .get("harness")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .chars()
        .take(40)
        .collect();
    json!({
        "session": session,
        "name": name,
        "harness": harness,
    })
}

fn peer_has_project(me: &Value) -> bool {
    let project = identity::project_of(me);
    let obj = json!({
        "repo": project.get("repo").cloned().unwrap_or(Value::Null),
        "remotes": project.get("remotes").cloned().unwrap_or_else(|| json!([])),
    });
    identity::same_project(&obj, &obj)
}

/// Extend active claim leases for items owned by `me`, matching `mailbox_work.py::renew_leases`.
pub fn renew_workboard_leases(base: &Path, me: &Value, force: bool) -> usize {
    let path = base.join("work/board.json");
    if !path.is_file() || !peer_has_project(me) {
        return 0;
    }
    let Some(my_session) = me.get("session").and_then(Value::as_str) else {
        return 0;
    };
    if paths::session_key(my_session).is_err() {
        return 0;
    }
    let Ok(_guard) = paths::lock_for(&path) else {
        return 0;
    };
    let Some(mut board) = read_workboard(&path) else {
        return 0;
    };
    let now_secs = paths::utc_now_secs();
    let stamp = paths::format_utc_iso_z(now_secs);
    let owner_obj = workboard_identity(me);
    let mut renewed = 0usize;
    let mut dirty = false;

    if let Some(items) = board.get_mut("items").and_then(Value::as_array_mut) {
        for item in items {
            let Some(obj) = item.as_object_mut() else {
                continue;
            };
            let state_ok = matches!(
                obj.get("state").and_then(Value::as_str),
                Some("claimed" | "blocked")
            );
            if !state_ok {
                continue;
            }
            let Some(owner_sid) = obj
                .get("owner")
                .and_then(|o| o.get("session"))
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            if !matches_session(me, Some(owner_sid.as_str())) {
                continue;
            }
            let Some(proj) = obj.get("project") else {
                continue;
            };
            if !proj.is_object() || !identity::same_project(me, proj) {
                continue;
            }
            let raw_ttl = obj
                .get("leaseTtlSeconds")
                .and_then(|v| if v.is_boolean() { None } else { v.as_i64() })
                .unwrap_or(DEFAULT_LEASE_TTL_SECS);
            let ttl = raw_ttl.clamp(MIN_LEASE_TTL_SECS, MAX_LEASE_TTL_SECS);
            let owner_changed = my_session != owner_sid;
            let existing_exp = obj.get("leaseExpiresAt").and_then(Value::as_str);
            let mut needs_write = force || owner_changed || existing_exp.is_none();
            if !needs_write && let Some(exp_str) = existing_exp {
                if let Some(exp_secs) = paths::parse_iso8601_utc_secs(exp_str) {
                    let remaining = (exp_secs - now_secs) as f64;
                    if remaining <= (ttl as f64) * 0.75 {
                        needs_write = true;
                    }
                } else {
                    needs_write = true;
                }
            }
            renewed += 1;
            if needs_write {
                obj.insert("leaseTtlSeconds".to_string(), json!(ttl));
                obj.insert(
                    "leaseExpiresAt".to_string(),
                    Value::String(paths::format_utc_iso_z(now_secs + ttl)),
                );
                if owner_changed {
                    obj.insert("owner".to_string(), owner_obj.clone());
                    let rev = obj.get("revision").and_then(Value::as_i64).unwrap_or(1) + 1;
                    obj.insert("revision".to_string(), json!(rev));
                    obj.insert("updatedAt".to_string(), Value::String(stamp.clone()));
                }
                dirty = true;
            }
        }
    }
    if dirty {
        let _ = paths::write_json_atomic(&path, &board);
    }
    renewed
}

fn workboard_present(
    base: &Path,
    ident: Option<&Value>,
    project: &Value,
    presence: &mut HashMap<String, (Option<Value>, bool)>,
    alias_peers: &mut Option<Vec<Value>>,
) -> bool {
    let Some(session) = ident
        .and_then(|o| o.get("session"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    if !presence.contains_key(session) {
        let exact = paths::peer_path(base, session)
            .ok()
            .and_then(|p| paths::read_json_file(&p));
        let mut alive = exact.as_ref().is_some_and(|p| {
            paths::valid_peer(p)
                && identity::same_project(p, project)
                && identity::is_live_peer(p, None)
        });
        let mut chosen = exact;
        if !alive {
            if alias_peers.is_none() {
                let mut loaded = Vec::new();
                if let Ok(entries) = fs::read_dir(base.join("peers")) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.extension().and_then(|e| e.to_str()) == Some("json")
                            && let Some(candidate) = paths::read_json_file(&p)
                            && paths::valid_peer(&candidate)
                        {
                            loaded.push(candidate);
                        }
                    }
                }
                *alias_peers = Some(loaded);
            }
            if let Some(candidates) = alias_peers.as_ref() {
                for candidate in candidates {
                    if matches_session(candidate, Some(session))
                        && identity::same_project(candidate, project)
                        && identity::is_live_peer(candidate, None)
                    {
                        chosen = Some(candidate.clone());
                        alive = true;
                        break;
                    }
                }
            }
        }
        presence.insert(session.to_string(), (chosen, alive));
    }
    match presence.get(session) {
        Some((Some(p), true)) => identity::same_project(p, project),
        _ => false,
    }
}

/// Surface ready workboard items at a turn boundary matching `mailbox_work.py::help_board_hint`.
#[must_use]
pub fn help_board_hint(base: &Path, me: &Value, previous: Option<&Value>) -> String {
    if identity::is_run_peer(Some(me))
        || me.get("delegatedRun").is_some_and(paths::is_truthy_json)
        || !peer_has_project(me)
        || !workboard_assigned(base, me).is_empty()
    {
        return String::new();
    }
    let Some(progress) = read_progress(base, me) else {
        return String::new();
    };
    if progress.stage != "complete" {
        return String::new();
    }
    let now_secs = paths::utc_now_secs();
    let Some(prog_secs) = paths::parse_iso8601_utc_secs(&progress.updated_at) else {
        return String::new();
    };
    if now_secs - prog_secs < HELP_BOARD_IDLE_SECS {
        return String::new();
    }
    if let Some(prev) = previous
        && paths::valid_peer(prev)
    {
        if prev.get("state").and_then(Value::as_str) != Some("idle") {
            return String::new();
        }
        let Some(last_seen) = prev.get("lastSeenAt").and_then(Value::as_str) else {
            return String::new();
        };
        let Some(seen_secs) = paths::parse_iso8601_utc_secs(last_seen) else {
            return String::new();
        };
        if now_secs - seen_secs < HELP_BOARD_IDLE_SECS {
            return String::new();
        }
    }
    let Some(board) = read_workboard(&base.join("work/board.json")) else {
        return String::new();
    };
    let Some(items) = board.get("items").and_then(Value::as_array) else {
        return String::new();
    };
    let states: HashMap<&str, &str> = items
        .iter()
        .filter_map(|i| Some((i.get("id")?.as_str()?, i.get("state")?.as_str()?)))
        .collect();
    let mut presence: HashMap<String, (Option<Value>, bool)> = HashMap::new();
    let mut alias_peers: Option<Vec<Value>> = None;
    let mut ready: Vec<(&str, &str)> = Vec::new();
    for record in items {
        let Some(proj) = record.get("project") else {
            continue;
        };
        if !proj.is_object() || !identity::same_project(me, proj) {
            continue;
        }
        if record.get("state").and_then(Value::as_str) != Some("open") {
            continue;
        }
        if record.get("owner").is_some_and(paths::is_truthy_json) {
            continue;
        }
        let deps_met = record
            .get("dependencies")
            .and_then(Value::as_array)
            .is_some_and(|deps| {
                deps.iter()
                    .all(|d| d.as_str().and_then(|id| states.get(id).copied()) == Some("accepted"))
            });
        if !deps_met {
            continue;
        }
        if !workboard_present(
            base,
            record.get("integrator").filter(|v| v.is_object()),
            proj,
            &mut presence,
            &mut alias_peers,
        ) {
            continue;
        }
        if let (Some(id), Some(title)) = (
            record.get("id").and_then(Value::as_str),
            record.get("title").and_then(Value::as_str),
        ) {
            ready.push((id, title));
        }
    }
    if ready.is_empty() {
        return String::new();
    }
    let sample = ready
        .iter()
        .take(2)
        .map(|(id, title)| format!("{id} ({title})"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Help board: your recorded task is complete and this session was idle; {} ready item(s) are open \
         on the project workboard ({sample}). Inspect `mailbox board` and claim one with `mailbox work claim` only \
         if the user wants this session to pick up shared work.",
        ready.len()
    )
}

/// Legacy task note stage lookup matching `agent_statusline.py:265-276` + `mailbox_tasks.py:43-55`.
#[must_use]
pub fn legacy_task_note_stage(
    base: &Path,
    peer: &Value,
    session: &str,
    task: &str,
) -> Option<String> {
    if task.is_empty() {
        return None;
    }
    let s_key = paths::session_key(session).ok()?;
    let proj = identity::project_of(peer);
    let project_id = proj
        .get("repo")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| peer.get("cwd").and_then(Value::as_str))
        .unwrap_or("");
    let digest = sha256::sha256_hex(project_id.as_bytes());
    let dir_key = &digest[..24];
    let note_path = base
        .join("tasks")
        .join(dir_key)
        .join(format!("{s_key}.json"));
    let note = paths::read_json_file(&note_path)?;
    if note.get("schema").and_then(Value::as_str) != Some(TASK_NOTE_SCHEMA) {
        return None;
    }
    let updated_at = note.get("updatedAt").and_then(Value::as_str)?;
    let updated_secs = paths::parse_iso8601_utc_secs(updated_at)?;
    if paths::utc_now_secs() - updated_secs > TASK_NOTE_RETENTION_SECS {
        return None;
    }
    if note.get("task").and_then(Value::as_str) != Some(task) {
        return None;
    }
    if note
        .get("owner")
        .and_then(|o| o.get("session"))
        .and_then(Value::as_str)
        != Some(session)
    {
        return None;
    }
    let status = note.get("status").and_then(Value::as_str)?;
    matches!(status, "active" | "blocked" | "complete").then(|| status.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_work_context_matches_python_json_dumps_spacing_and_ascii() {
        let a = vec![
            WorkAssignment {
                id: "item-b".to_string(),
                title: "B".to_string(),
                state: "claimed".to_string(),
            },
            WorkAssignment {
                id: "item-a".to_string(),
                title: "A".to_string(),
                state: "claimed".to_string(),
            },
        ];
        // Python: hashlib.sha256(json.dumps(["item-a", "item-b"]).encode()).hexdigest()
        // Notice comma-space `["item-a", "item-b"]`!
        let expected = sha256::sha256_hex(br#"["item-a", "item-b"]"#);
        assert_eq!(work_context(&a), Some(expected));
        assert_eq!(work_context(&[]), None);
    }

    #[test]
    fn test_py_json_quote_ascii_non_ascii_and_escapes() {
        assert_eq!(py_json_quote_ascii("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(py_json_quote_ascii("☕"), r#""\u2615""#);
    }

    #[test]
    fn test_known_roles_includes_workforce_roles_and_rejects_unknown() {
        let roles = known_roles();
        assert!(roles.contains("builder"));
        assert!(roles.contains("planner"));
        assert!(roles.contains("verifier"));
        assert!(!roles.contains("unknown-made-up-role"));
    }

    #[test]
    fn test_room_task_continuation_chain_and_verdict() {
        let tmp = std::env::temp_dir().join(format!("ork-fast-room-task-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let task_dir = tmp.join("task1");
        let repo_dir = tmp.join("repo");
        fs::create_dir_all(&task_dir).unwrap();
        fs::create_dir_all(&repo_dir).unwrap();
        let task = json!({
            "schema": "agent-executor.task.v1",
            "task_id": "t1",
            "repository": repo_dir.to_string_lossy(),
            "task_spec": {"objective": "Original objective"},
            "runs": [
                {
                    "run_id": "r1",
                    "request_id": "req-1",
                    "status": "finished",
                    "runner_status": "completed",
                    "engine": "claude",
                    "transport": "native",
                    "result_path": "/tmp/r1.json"
                },
                {
                    "run_id": "r2",
                    "request_id": "req-2",
                    "status": "active",
                    "kind": "continue",
                    "parent_run_id": "r1",
                    "engine": "claude",
                    "transport": "native",
                    "task_spec": {"objective": "Continued objective"}
                }
            ],
            "decisions": [
                {"run_id": "r2", "decision": "accept"}
            ]
        });
        fs::write(task_dir.join("task.json"), task.to_string()).unwrap();

        let room = json!({"cwd": repo_dir.to_string_lossy()});
        let member = json!({
            "engine": "claude",
            "dispatch": {
                "taskDir": task_dir.to_string_lossy(),
                "taskId": "t1",
                "requestId": "req-1",
                "transport": "native"
            }
        });
        let summary = room_task(&room, &member).unwrap();
        assert_eq!(summary.title, "Continued objective");
        assert_eq!(summary.state, "accepted");
        let _ = fs::remove_dir_all(&tmp);
    }
}
