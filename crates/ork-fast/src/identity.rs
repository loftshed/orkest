//! Peer identity, Git workspace correlation, native-session HMAC attestation, Martian naming, and presence.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde_json::{Value, json};

use crate::mailbox_records;
use crate::paths;
use crate::sha1;
use crate::sha256;

pub const PEER_SCHEMA: &str = "agent-executor.peer.v1";
pub const CHIEF_SCHEMA: &str = "ork.chief.v1";
pub const MAX_AGE_SECS: i64 = 7 * 86_400;
pub const UNKNOWN_PID_TTL_SECS: i64 = 2 * 3600;
pub const SHARED_PROCESS_IDLE_TTL_SECS: i64 = 3 * 3600;
pub const SHARED_PROCESS_BUSY_TTL_SECS: i64 = 30 * 60;
pub const SHARED_PROCESS_SUBAGENT_TTL_SECS: i64 = 300;
pub const CHIEF_UNVERIFIED_GRACE_SECS: i64 = 600;

// cspell:disable
const LEGACY_MARTIAN_NAMES: &[&str] = &[
    "blipzor", "blorbo", "blorkin", "boinglo", "borkle", "chomzog", "dorbix", "drazzle", "dribnax",
    "fizzgob", "flibnax", "floomp", "fnordel", "frongle", "glimzo", "gloobix", "glorpax",
    "gooblek", "gribble", "gribnox", "klonko", "klorgis", "krimble", "mibzot", "miffkin",
    "mooflek", "morblo", "nibblex", "nibnorb", "nozzik", "pifflet", "plonko", "ploomix", "quibble",
    "quibblex", "quobble", "quonk", "skitter", "skronk", "snoobix", "snorfle", "splimzo",
    "sproing", "squibble", "throggle", "troobax", "tumblex", "vlimbo", "vobnix", "vorgle",
    "wibblox", "womblek", "wubbit", "xibzog", "yobnax", "zibber", "zibnorb", "zimblex", "zorblo",
    "zorpnik", "zuzzlek", "zwibble",
];
const ALIEN_ONSETS: &[&str] = &[
    "bl", "br", "ch", "cr", "dr", "fl", "fr", "gl", "gr", "kl", "kr", "m", "n", "pl", "pr", "qu",
    "sk", "skr", "sl", "sm", "sn", "spl", "spr", "squ", "st", "str", "th", "thr", "tr", "vr", "z",
    "zw",
];
const ALIEN_VOWELS: &[&str] = &["a", "e", "i", "o", "u", "oo", "or", "ar"];
const ALIEN_CODAS: &[&str] = &[
    "b", "d", "f", "g", "k", "l", "m", "mp", "n", "nk", "p", "rk", "t", "x", "z", "zk",
];
const ALIEN_SUFFIXES: &[&str] = &[
    "", "", "ax", "ek", "el", "ik", "ix", "le", "lo", "nak", "ok", "or", "ox", "oz", "ug", "ul",
];
// cspell:enable

#[derive(Clone, Debug)]
struct CachedWorkspace {
    has_dot_git: bool,
    common_dir: PathBuf,
    git_dir: PathBuf,
    config_bytes: Vec<u8>,
    head_bytes: Vec<u8>,
    value: Value,
}

static WORKSPACE_CACHE: OnceLock<Mutex<HashMap<String, CachedWorkspace>>> = OnceLock::new();
static PID_BIRTH_CACHE: OnceLock<Mutex<HashMap<i64, String>>> = OnceLock::new();

#[must_use]
pub fn is_run_peer(peer: Option<&Value>) -> bool {
    let Some(obj) = peer.and_then(Value::as_object) else {
        return false;
    };
    obj.get("run")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
        || obj
            .get("session")
            .and_then(Value::as_str)
            .is_some_and(|s| s.starts_with("run-"))
}

#[must_use]
pub fn is_run_record(peer: Option<&Value>) -> bool {
    let Some(obj) = peer.and_then(Value::as_object) else {
        return false;
    };
    if !paths::valid_peer(peer.unwrap()) {
        return false;
    }
    let Some(run) = obj.get("run").and_then(Value::as_str) else {
        return false;
    };
    let Some(role) = obj.get("role").and_then(Value::as_str) else {
        return false;
    };
    let Some(session) = obj.get("session").and_then(Value::as_str) else {
        return false;
    };
    session == format!("run-{run}-{role}")
}

#[must_use]
pub fn run_status(base: &Path, run: &str) -> Option<String> {
    let rec = mailbox_records::read_peer(base, &format!("run-{run}-worker"))?;
    if let Some(res_path) = rec.get("resultPath").and_then(Value::as_str)
        && let Some(res_json) = paths::read_json_file(Path::new(res_path))
        && res_json.is_object()
    {
        return res_json
            .get("status")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .or_else(|| Some("completed".to_string()));
    }
    None
}

#[must_use]
pub fn is_pid_live(pid: i64) -> bool {
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return false;
    }
    unsafe {
        libc::kill(pid as libc::c_int, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

#[must_use]
pub fn pid_alive_opt(peer: &Value) -> Option<bool> {
    let val = peer.get("pid")?;
    if val.is_boolean() {
        return None;
    }
    let pid = val.as_i64()?;
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return None;
    }
    Some(is_pid_live(pid))
}

/// Query `ps` for the process start timestamp without using `PID_BIRTH_CACHE`.
#[must_use]
pub fn process_started_fresh(pid: i64) -> Option<String> {
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return None;
    }
    let output = Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    let started = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!started.is_empty()).then_some(started)
}

#[must_use]
pub fn process_started(pid: i64) -> Option<String> {
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return None;
    }
    let cache = PID_BIRTH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock()
        && let Some(cached) = map.get(&pid)
        && is_pid_live(pid)
    {
        return Some(cached.clone());
    }
    let started = process_started_fresh(pid)?;
    if let Ok(mut map) = cache.lock() {
        if map.len() >= 256 {
            map.clear();
        }
        map.insert(pid, started.clone());
    }
    Some(started)
}

/// Inspect process tree upward up to 6 levels to locate the enclosing harness PID (`mailbox_store.harness_pid`).
#[must_use]
pub fn harness_pid(harness: &str) -> Option<i64> {
    if env::var("ORKEST_TEST_MODE").as_deref() == Ok("1")
        && let Ok(val) = env::var("ORKEST_TEST_HARNESS_PID")
    {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            if trimmed.eq_ignore_ascii_case("none") {
                return None;
            }
            if let Ok(parsed) = trimmed.parse::<i64>() {
                return Some(parsed);
            }
        }
    }
    if harness == "claude"
        && let Ok(val) = env::var("CLAUDE_PID")
        && !val.is_empty()
        && val.bytes().all(|b| b.is_ascii_digit())
        && let Ok(parsed) = val.parse::<i64>()
    {
        return Some(parsed);
    }
    let start = i64::from(unsafe { libc::getppid() });
    let names: &[&str] = match harness {
        "gemini" => &["agy", "antigravity", "gemini"],
        other => {
            let mut pid = start;
            for _ in 0..6 {
                let out = Command::new("ps")
                    .args(["-o", "ppid=,comm=", "-p", &pid.to_string()])
                    .output()
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default();
                if out.is_empty() {
                    break;
                }
                let mut split = out.trim_start().splitn(2, char::is_whitespace);
                let parent_str = split.next().unwrap_or("").trim();
                let cmd_str = split.next().unwrap_or("").trim();
                let base_name = Path::new(cmd_str)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if base_name.contains(other) {
                    return Some(pid);
                }
                let Ok(ppid) = parent_str.parse::<i64>() else {
                    break;
                };
                if ppid <= 1 {
                    break;
                }
                pid = ppid;
            }
            return Some(start);
        }
    };
    let mut pid = start;
    for _ in 0..6 {
        let out = Command::new("ps")
            .args(["-o", "ppid=,comm=", "-p", &pid.to_string()])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        if out.is_empty() {
            break;
        }
        let mut split = out.trim_start().splitn(2, char::is_whitespace);
        let parent_str = split.next().unwrap_or("").trim();
        let cmd_str = split.next().unwrap_or("").trim();
        let base_name = Path::new(cmd_str)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if names.iter().any(|n| base_name.contains(n)) {
            return Some(pid);
        }
        let Ok(ppid) = parent_str.parse::<i64>() else {
            break;
        };
        if ppid <= 1 {
            break;
        }
        pid = ppid;
    }
    Some(start)
}

fn is_live_peer_with_options<F>(
    peer: &Value,
    now_secs: Option<i64>,
    enforce_max_age_for_non_shared: bool,
    mut birth_fn: F,
) -> bool
where
    F: FnMut(i64) -> Option<String>,
{
    let now = now_secs.unwrap_or_else(paths::utc_now_secs);
    let seen_str = peer
        .get("lastSeenAt")
        .or_else(|| peer.get("startedAt"))
        .and_then(Value::as_str);
    let Some(seen) = seen_str.and_then(paths::parse_iso8601_utc_secs) else {
        return false;
    };
    let alive = pid_alive_opt(peer);
    if alive == Some(false) {
        return false;
    }
    let shared = peer.get("sharedProcess").and_then(Value::as_bool) == Some(true);
    let is_subagent = peer.get("isSubagent").and_then(Value::as_bool) == Some(true);
    if alive == Some(true)
        && let Some(birth) = peer.get("pidBirth").and_then(Value::as_str)
        && !birth.is_empty()
        && let Some(pid) = peer.get("pid").and_then(Value::as_i64)
        && let Some(current) = birth_fn(pid)
    {
        if current != birth {
            return false;
        }
        if !shared && !enforce_max_age_for_non_shared {
            return true;
        }
    }
    if now - seen > MAX_AGE_SECS {
        return false;
    }
    if shared && is_subagent {
        return now - seen <= SHARED_PROCESS_SUBAGENT_TTL_SECS;
    }
    if alive == Some(true) && shared {
        let ttl = match peer.get("state").and_then(Value::as_str) {
            Some("busy") => SHARED_PROCESS_BUSY_TTL_SECS,
            Some("waiting") => SHARED_PROCESS_IDLE_TTL_SECS,
            _ => SHARED_PROCESS_IDLE_TTL_SECS,
        };
        return now - seen <= ttl;
    }
    match alive {
        Some(b) => b,
        None => now - seen <= UNKNOWN_PID_TTL_SECS,
    }
}

fn is_live_peer_with<F>(peer: &Value, now_secs: Option<i64>, birth_fn: F) -> bool
where
    F: FnMut(i64) -> Option<String>,
{
    is_live_peer_with_options(peer, now_secs, false, birth_fn)
}

fn is_chief_peer_live_with<F>(peer: &Value, now_secs: Option<i64>, birth_fn: F) -> bool
where
    F: FnMut(i64) -> Option<String>,
{
    is_live_peer_with_options(peer, now_secs, true, birth_fn)
}

#[must_use]
pub fn is_live_peer(peer: &Value, now_secs: Option<i64>) -> bool {
    is_live_peer_with(peer, now_secs, process_started)
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            )
        {
            out.push(((h << 4) | l) as u8);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Normalize a Git remote URL matching `mailbox_store.remote_identity`.
#[must_use]
pub fn remote_identity(url_raw: &str, checkout: &str) -> Option<String> {
    if url_raw.is_empty() {
        return None;
    }
    let normalized_url: String;
    let url = if !url_raw.contains("://") {
        // SCP syntax: [user@]host:path (no leading slash before colon, no @ in host)
        let bytes = url_raw.as_bytes();
        if let Some(colon_pos) = bytes.iter().position(|&b| b == b':') {
            let prefix = &url_raw[..colon_pos];
            let suffix = &url_raw[colon_pos + 1..];
            let valid_scp = !suffix.is_empty()
                && !prefix.contains('/')
                && !prefix.chars().any(char::is_whitespace);
            if valid_scp {
                let host = prefix.rsplit_once('@').map_or(prefix, |(_, h)| h);
                if !host.is_empty() && !host.contains('/') {
                    normalized_url = format!("ssh://{host}/{suffix}");
                    normalized_url.as_str()
                } else {
                    let candidate = Path::new(checkout).join(paths::expand_home(url_raw, None));
                    let resolved = paths::resolve_path(&candidate).unwrap_or(candidate);
                    return Some(sha256::sha256_hex(
                        format!("file:{}", resolved.to_string_lossy()).as_bytes(),
                    ));
                }
            } else {
                let candidate = Path::new(checkout).join(paths::expand_home(url_raw, None));
                let resolved = paths::resolve_path(&candidate).unwrap_or(candidate);
                return Some(sha256::sha256_hex(
                    format!("file:{}", resolved.to_string_lossy()).as_bytes(),
                ));
            }
        } else {
            let candidate = Path::new(checkout).join(paths::expand_home(url_raw, None));
            let resolved = paths::resolve_path(&candidate).unwrap_or(candidate);
            return Some(sha256::sha256_hex(
                format!("file:{}", resolved.to_string_lossy()).as_bytes(),
            ));
        }
    } else {
        url_raw
    };

    let (scheme, after_scheme) = url.split_once("://")?;
    let scheme_lower = scheme.to_ascii_lowercase();
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    let path_and_rest = &after_scheme[authority_end..];
    let path_only = path_and_rest.split(['?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, hp)| hp);

    if scheme_lower == "file" {
        if host_port.is_empty() || host_port.eq_ignore_ascii_case("localhost") {
            let decoded = percent_decode(path_only);
            let expanded = paths::expand_home(&decoded, None);
            let resolved = paths::resolve_path(&expanded).unwrap_or(expanded);
            return Some(sha256::sha256_hex(
                format!("file:{}", resolved.to_string_lossy()).as_bytes(),
            ));
        }
        return None;
    }

    let default_port: u16 = match scheme_lower.as_str() {
        "ssh" => 22,
        "git" => 9418,
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    if host_port.is_empty() {
        return None;
    }
    let (host, port_opt): (&str, Option<u16>) = if let Some(rest) = host_port.strip_prefix('[') {
        if let Some((h, tail)) = rest.split_once(']') {
            let p = tail.strip_prefix(':').and_then(|s| s.parse::<u16>().ok());
            (h, p)
        } else {
            return None;
        }
    } else if let Some((h, p_str)) = host_port.rsplit_once(':') {
        let port = p_str.parse::<u16>().ok()?;
        (h, Some(port))
    } else {
        (host_port, None)
    };
    if host.is_empty() {
        return None;
    }
    let mut host_out = host.to_ascii_lowercase();
    if let Some(p) = port_opt
        && p != default_port
    {
        host_out.push(':');
        host_out.push_str(&p.to_string());
    }

    let decoded_path = percent_decode(path_only);
    let mut trimmed_path = decoded_path.trim_matches('/');
    if let Some(stripped) = trimmed_path.strip_suffix(".git") {
        trimmed_path = stripped;
    }
    if trimmed_path.is_empty() {
        return None;
    }
    Some(sha256::sha256_hex(
        format!("remote:{host_out}/{trimmed_path}").as_bytes(),
    ))
}

/// Inspect Git `repo`, `checkout`, `branch`, and `remotes` matching `mailbox_store.workspace()`.
#[must_use]
pub fn workspace(cwd: &str) -> Value {
    if cwd.is_empty() || !Path::new(cwd).is_dir() {
        return json!({});
    }
    let resolved_cwd = paths::resolve_path(Path::new(cwd))
        .unwrap_or_else(|_| PathBuf::from(cwd))
        .to_string_lossy()
        .into_owned();
    let has_dot_git = Path::new(&resolved_cwd).join(".git").exists();

    let cache = WORKSPACE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock()
        && let Some(entry) = map.get(&resolved_cwd)
        && entry.has_dot_git == has_dot_git
        && entry
            .value
            .get("checkout")
            .and_then(Value::as_str)
            .is_some_and(|c| Path::new(c).is_dir())
        && fs::read(entry.common_dir.join("config")).ok().as_deref()
            == Some(entry.config_bytes.as_slice())
        && fs::read(entry.git_dir.join("HEAD")).ok().as_deref() == Some(entry.head_bytes.as_slice())
    {
        return entry.value.clone();
    }

    let Ok(rev_out) = Command::new("git")
        .args([
            "-C",
            cwd,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--show-toplevel",
            "--git-dir",
        ])
        .output()
    else {
        return json!({});
    };
    if !rev_out.status.success() {
        return json!({});
    }
    let rev_text = String::from_utf8_lossy(&rev_out.stdout);
    let lines: Vec<&str> = rev_text.lines().collect();
    if lines.len() < 2 {
        return json!({});
    }

    let branch = Command::new("git")
        .args(["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(detached)".to_string());

    let mut remotes = BTreeSet::new();
    if let Ok(cfg_out) = Command::new("git")
        .args([
            "-C",
            cwd,
            "config",
            "--null",
            "--get-regexp",
            r"^remote\..*\.url$",
        ])
        .output()
    {
        for entry in cfg_out.stdout.split(|&b| b == 0) {
            let entry_str = String::from_utf8_lossy(entry);
            if let Some((_, url)) = entry_str.split_once('\n')
                && let Some(id) = remote_identity(url, lines[1])
            {
                remotes.insert(id);
            }
        }
    }

    let common_path =
        paths::resolve_path(Path::new(lines[0])).unwrap_or_else(|_| PathBuf::from(lines[0]));
    let checkout_path =
        paths::resolve_path(Path::new(lines[1])).unwrap_or_else(|_| PathBuf::from(lines[1]));
    let git_dir_path = if lines.len() >= 3 {
        paths::resolve_path(Path::new(lines[2])).unwrap_or_else(|_| common_path.clone())
    } else {
        common_path.clone()
    };

    let ws = json!({
        "repo": common_path.to_string_lossy(),
        "checkout": checkout_path.to_string_lossy(),
        "branch": branch,
        "remotes": remotes.into_iter().collect::<Vec<_>>(),
    });

    if let (Ok(cfg_bytes), Ok(head_bytes)) = (
        fs::read(common_path.join("config")),
        fs::read(git_dir_path.join("HEAD")),
    ) && let Ok(mut map) = cache.lock()
    {
        if map.len() >= 128 {
            map.clear();
        }
        map.insert(
            resolved_cwd,
            CachedWorkspace {
                has_dot_git,
                common_dir: common_path,
                git_dir: git_dir_path,
                config_bytes: cfg_bytes,
                head_bytes,
                value: ws.clone(),
            },
        );
    }

    ws
}

#[must_use]
pub fn project_of(peer: &Value) -> Value {
    if peer.get("remotes").is_some_and(Value::is_array) {
        return peer.clone();
    }
    match peer.get("cwd").and_then(Value::as_str) {
        Some(cwd) => workspace(cwd),
        None => json!({}),
    }
}

#[must_use]
pub fn same_project(left: &Value, right: &Value) -> bool {
    let l = project_of(left);
    let r = project_of(right);
    if let Some(lr) = l.get("repo").and_then(Value::as_str)
        && !lr.is_empty()
        && Some(lr) == r.get("repo").and_then(Value::as_str)
    {
        return true;
    }
    let l_rem: HashSet<&str> = l
        .get("remotes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let r_rem: HashSet<&str> = r
        .get("remotes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    !l_rem.is_disjoint(&r_rem)
}

#[must_use]
pub fn repository_name(peer: &Value) -> String {
    let raw = peer
        .get("repo")
        .or_else(|| peer.get("checkout"))
        .or_else(|| peer.get("cwd"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let p = Path::new(raw);
    if p.file_name().is_some_and(|n| n == ".git") {
        p.parent()
            .and_then(|parent| parent.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string()
    } else {
        p.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string()
    }
}

#[must_use]
pub fn detect_harness(payload: &Value) -> String {
    let transcript = payload
        .get("transcript_path")
        .or_else(|| payload.get("transcriptPath"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if transcript.contains("/antigravity") || transcript.contains("/.gemini/") {
        return "gemini".to_string();
    }
    if transcript.contains("/.codex/") {
        return "codex".to_string();
    }
    if transcript.contains("/.claude") {
        return "claude".to_string();
    }
    let has_env = |name: &str| env::var(name).is_ok_and(|v| !v.is_empty());
    if has_env("CODEX_THREAD_ID") || has_env("CODEX_SANDBOX") {
        return "codex".to_string();
    }
    if has_env("CLAUDECODE") || has_env("CLAUDE_CODE_ENTRYPOINT") {
        return "claude".to_string();
    }
    if has_env("OPENCODE") || has_env("OPENCODE_SESSION") || has_env("OPENCODE_SESSION_ID") {
        return "opencode".to_string();
    }
    for name in [
        "GEMINI_CLI",
        "ANTIGRAVITY",
        "ANTIGRAVITY_AGENT",
        "ANTIGRAVITY_CONVERSATION_ID",
        "ANTIGRAVITY_LS_ADDRESS",
    ] {
        if has_env(name) {
            return "gemini".to_string();
        }
    }
    if has_env("CODEX_HOME") {
        return "codex".to_string();
    }
    if payload.get("conversationId").is_some() {
        return "gemini".to_string();
    }
    "unknown".to_string()
}

#[must_use]
pub fn account_home(harness: &str, transcript: Option<&str>) -> Option<String> {
    let (var_name, default_dir) = match harness {
        "claude" => ("CLAUDE_CONFIG_DIR", ".claude"),
        "codex" => ("CODEX_HOME", ".codex"),
        "gemini" => ("GEMINI_CLI_HOME", ".gemini"),
        _ => return None,
    };
    let mut configured = env::var(var_name)
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| paths::expand_home(&s, None));
    if configured.is_none()
        && harness == "gemini"
        && let Ok(app_data) = env::var("ANTIGRAVITY_APP_DATA_DIR")
        && !app_data.is_empty()
    {
        let p = paths::expand_home(&app_data, None);
        let is_antigravity = p
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("antigravity"));
        configured = Some(if is_antigravity {
            p.parent().map_or_else(|| p.clone(), Path::to_path_buf)
        } else {
            p
        });
    }

    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    let home_resolved = paths::resolve_path(&home).unwrap_or_else(|_| home.clone());

    if let Some(t) = transcript.filter(|s| !s.is_empty()) {
        let p = paths::expand_home(t, None);
        let p_resolved = paths::resolve_path(&p).unwrap_or_else(|_| p.clone());
        let candidates = [&p, &p_resolved];
        if let Some(ref cfg) = configured {
            let cfg_resolved = paths::resolve_path(cfg).unwrap_or_else(|_| cfg.clone());
            for candidate in candidates {
                if candidate.starts_with(cfg) || candidate.starts_with(&cfg_resolved) {
                    return Some(cfg_resolved.to_string_lossy().into_owned());
                }
            }
        }
        let default_prefix = format!("{default_dir}-");
        for candidate in candidates {
            for parent in candidate.ancestors().skip(1) {
                let Some(grand) = parent.parent() else {
                    continue;
                };
                if grand == home || grand == home_resolved {
                    let name = parent.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name == default_dir || name.starts_with(&default_prefix) {
                        let resolved_parent =
                            paths::resolve_path(parent).unwrap_or_else(|_| parent.to_path_buf());
                        return Some(resolved_parent.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    let fallback = configured.unwrap_or_else(|| home.join(default_dir));
    Some(
        paths::resolve_path(&fallback)
            .unwrap_or(fallback)
            .to_string_lossy()
            .into_owned(),
    )
}

fn daemon_state_file_is_private(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    !meta.file_type().is_symlink()
        && meta.is_file()
        && meta.uid() == unsafe { libc::getuid() }
        && (meta.mode() & 0o077) == 0
}

fn ensure_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink()
                || !meta.is_dir()
                || meta.uid() != unsafe { libc::getuid() }
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "daemon directory must be owned by current user and cannot be a symlink",
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path)?;
        }
        Err(e) => return Err(e),
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "daemon directory must be owned by current user and cannot be a symlink",
        ));
    }
    Ok(())
}

#[must_use]
pub fn daemon_base(base: &Path) -> PathBuf {
    let resolved = paths::resolve_path(base).unwrap_or_else(|_| base.to_path_buf());
    let suffix = if base.file_name().and_then(|n| n.to_str()) == Some("mailbox-v1") {
        "v1".to_string()
    } else {
        let digest = sha256::sha256_hex(resolved.to_string_lossy().as_bytes());
        digest[..12].to_string()
    };
    base.parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
        .join(format!("mailbox-daemon-{suffix}"))
}

#[must_use]
pub fn read_token(base: &Path) -> Option<String> {
    let path = daemon_base(base).join("token.txt");
    if !daemon_state_file_is_private(&path) {
        return None;
    }
    let val = fs::read_to_string(&path).ok()?.trim().to_string();
    let valid = (32..=100).contains(&val.len())
        && val
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid { Some(val) } else { None }
}

fn encode_base64_url_unpadded(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = if chunk.len() > 1 {
            u32::from(chunk[1])
        } else {
            0
        };
        let b2 = if chunk.len() > 2 {
            u32::from(chunk[2])
        } else {
            0
        };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3f) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3f) as usize] as char);
        }
    }
    out
}

pub fn generate_token(base: &Path) -> Option<String> {
    let dir = daemon_base(base);
    ensure_private_dir(&dir).ok()?;
    let token_path = dir.join("token.txt");
    let _guard = paths::lock_for(&token_path).ok()?;
    if let Some(existing) = read_token(base) {
        return Some(existing);
    }
    if fs::symlink_metadata(&token_path).is_ok() {
        return None;
    }
    let token = encode_base64_url_unpadded(&paths::random_bytes(32));
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp_path = dir.join(format!(".token-{}.tmp", std::process::id()));
    let res = (|| -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp_path)?;
        writeln!(f, "{token}")?;
        f.sync_all()?;
        Ok(())
    })();
    if res.is_err() || fs::rename(&tmp_path, &token_path).is_err() {
        let _ = fs::remove_file(&tmp_path);
        return None;
    }
    Some(token)
}

#[must_use]
pub fn identity_message(peer: &Value) -> Vec<u8> {
    let str_or_null = |key: &str| -> Value {
        match peer.get(key).and_then(Value::as_str) {
            Some(s) => Value::String(s.to_string()),
            None => Value::Null,
        }
    };
    let native_sessions = peer.get("nativeSessions").cloned().unwrap_or(Value::Null);
    let arr = json!([
        "orkest.native-identity.v1",
        str_or_null("session"),
        str_or_null("harness"),
        str_or_null("machine"),
        str_or_null("cwd"),
        str_or_null("checkout"),
        str_or_null("accountHome"),
        str_or_null("nativeSession"),
        native_sessions,
    ]);
    serde_json::to_string(&arr).unwrap_or_default().into_bytes()
}

#[must_use]
pub fn verified_native_ids(base: &Path, peer: &Value) -> Vec<String> {
    let Some(sig) = peer.get("nativeSessionAttestation").and_then(Value::as_str) else {
        return Vec::new();
    };
    if sig.len() != 64 || !sig.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Vec::new();
    }
    let Some(token) = read_token(base) else {
        return Vec::new();
    };
    let expected = sha256::hmac_sha256_hex(token.as_bytes(), &identity_message(peer));
    if !sha256::ct_eq(sig.as_bytes(), expected.as_bytes()) {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Some(ns) = peer.get("nativeSession").and_then(Value::as_str)
        && paths::valid_session_id(ns)
    {
        out.push(ns.to_string());
    }
    if let Some(arr) = peer.get("nativeSessions").and_then(Value::as_array) {
        for item in arr {
            if let Some(s) = item.as_str()
                && paths::valid_session_id(s)
            {
                out.push(s.to_string());
            }
        }
    }
    out
}

#[must_use]
pub fn sign_native_ids(base: &Path, peer: &Value) -> Option<String> {
    let token = generate_token(base)?;
    Some(sha256::hmac_sha256_hex(
        token.as_bytes(),
        &identity_message(peer),
    ))
}

#[must_use]
pub fn native_session_ids(peer: Option<&Value>, base: Option<&Path>) -> HashSet<String> {
    let Some(p) = peer.filter(|v| v.is_object()) else {
        return HashSet::new();
    };
    let mut set = HashSet::new();
    if let Some(s) = p.get("session").and_then(Value::as_str)
        && paths::valid_session_id(s)
    {
        set.insert(s.to_string());
    }
    if let Some(b) = base {
        for id in verified_native_ids(b, p) {
            set.insert(id);
        }
    }
    set
}

pub fn attest_native_sessions(base: &Path, session: &str, observed: &[&str]) -> Option<Value> {
    if observed.is_empty() || observed.iter().any(|s| !paths::valid_session_id(s)) {
        return None;
    }
    let _guard = mailbox_records::lock_peer(base, session).ok()?;
    let mut peer = mailbox_records::read_peer(base, session)?;
    if !paths::valid_peer(&peer) {
        return Some(peer);
    }
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for v in verified_native_ids(base, &peer)
        .into_iter()
        .chain(observed.iter().map(|s| (*s).to_string()))
    {
        if seen.insert(v.clone()) {
            ids.push(v);
        }
    }
    if ids.len() > 32 {
        let start = ids.len() - 32;
        ids.drain(..start);
    }
    if let Some(obj) = peer.as_object_mut() {
        obj.insert(
            "nativeSession".to_string(),
            Value::String((*observed.last()?).to_string()),
        );
        obj.insert(
            "nativeSessions".to_string(),
            Value::Array(ids.into_iter().map(Value::String).collect()),
        );
    }
    let sig = sign_native_ids(base, &peer);
    if let Some(obj) = peer.as_object_mut() {
        obj.insert(
            "nativeSessionAttestation".to_string(),
            sig.map_or(Value::Null, Value::String),
        );
    }
    mailbox_records::write_peer(base, session, &peer).ok()?;
    Some(peer)
}

/// Resolve an exact mailbox key first, then unique live native-identity owner (`peer_mailbox.session_peer`).
#[must_use]
pub fn session_peer(
    base: &Path,
    session: &str,
    harness: Option<&str>,
    cwd: Option<&str>,
    allow_inactive_exact: bool,
) -> Option<Value> {
    let matches = session_peer_candidates(base, session, harness, cwd, allow_inactive_exact);
    if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    }
}

#[must_use]
pub fn session_peer_candidates(
    base: &Path,
    session: &str,
    harness: Option<&str>,
    cwd: Option<&str>,
    allow_inactive_exact: bool,
) -> Vec<Value> {
    let norm_harness = harness.map(|h| if h == "agy" { "gemini" } else { h });
    let host = paths::current_hostname();
    let resolved_cwd = cwd.and_then(|c| {
        if c.is_empty() {
            None
        } else {
            Some(paths::resolve_path(Path::new(c)).unwrap_or_else(|_| PathBuf::from(c)))
        }
    });

    let eligible = |peer: &Value, is_alias: bool| -> bool {
        if !paths::valid_peer(peer) {
            return false;
        }
        if !((allow_inactive_exact && !is_alias) || is_live_peer(peer, None)) {
            return false;
        }
        let peer_machine = peer.get("machine").and_then(Value::as_str);
        if let (Some(h), Some(pm)) = (host.as_deref(), peer_machine)
            && pm != h
        {
            return false;
        }
        if let Some(eh) = norm_harness
            && peer.get("harness").and_then(Value::as_str) != Some(eh)
        {
            return false;
        }
        if let Some(ref target_cwd) = resolved_cwd {
            let raw_p = peer
                .get("checkout")
                .or_else(|| peer.get("cwd"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let peer_cwd =
                paths::resolve_path(Path::new(raw_p)).unwrap_or_else(|_| PathBuf::from(raw_p));
            if &peer_cwd != target_cwd {
                return false;
            }
        }
        !(is_alias
            && (peer.get("isSubagent").and_then(Value::as_bool) == Some(true)
                || peer.get("delegatedRun").is_some_and(paths::is_truthy_json)
                || peer.get("run").is_some_and(paths::is_truthy_json)
                || peer
                    .get("session")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.starts_with("run-"))))
    };

    if paths::session_key(session).is_err() {
        return Vec::new();
    }
    if let Some(direct) = mailbox_records::read_peer(base, session)
        && eligible(&direct, false)
        && direct.get("session").and_then(Value::as_str) == Some(session)
    {
        return vec![direct];
    }

    let mut matches = Vec::new();
    match mailbox_records::list_peers(base) {
        Err(mailbox_records::StoreError::Deadline) => return Vec::new(),
        Err(_) => {}
        Ok(listing) => {
            for (_, peer) in listing.bodies() {
                if crate::sqlite::deadline_expired() {
                    return Vec::new();
                }
                if eligible(peer, true)
                    && native_session_ids(Some(peer), Some(base)).contains(session)
                {
                    matches.push(peer.clone());
                }
            }
        }
    }
    matches
}

#[must_use]
pub fn generate_martian(seed: &str, step: usize) -> String {
    let key = if step == 0 {
        seed.to_string()
    } else {
        format!("{seed}:{step}")
    };
    let digest = sha256::sha256_digest(key.as_bytes());
    let onset = ALIEN_ONSETS[usize::from(digest[0]) % ALIEN_ONSETS.len()];
    let vowel = ALIEN_VOWELS[usize::from(digest[1]) % ALIEN_VOWELS.len()];
    let coda_idx = usize::from(digest[2]) % ALIEN_CODAS.len();
    let mut coda = ALIEN_CODAS[coda_idx];
    if vowel.ends_with('r') && coda.starts_with('r') {
        coda = ALIEN_CODAS[(coda_idx + 1) % ALIEN_CODAS.len()];
    }
    let suffix = ALIEN_SUFFIXES[usize::from(digest[3]) % ALIEN_SUFFIXES.len()];
    format!("{onset}{vowel}{coda}{suffix}")
}

#[must_use]
pub fn is_martian_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if LEGACY_MARTIAN_NAMES.contains(&name) {
        return true;
    }
    for onset in ALIEN_ONSETS {
        let Some(after_onset) = name.strip_prefix(onset) else {
            continue;
        };
        for vowel in ALIEN_VOWELS {
            let Some(after_vowel) = after_onset.strip_prefix(vowel) else {
                continue;
            };
            for coda in ALIEN_CODAS {
                if vowel.ends_with('r') && coda.starts_with('r') {
                    continue;
                }
                let Some(rest) = after_vowel.strip_prefix(coda) else {
                    continue;
                };
                if ALIEN_SUFFIXES.contains(&rest) {
                    return true;
                }
            }
        }
    }
    false
}

#[must_use]
pub fn pick_martian(seed: &str, taken: &HashSet<String>) -> String {
    for step in 0..256 {
        let candidate = generate_martian(seed, step);
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    generate_martian(seed, 0)
}

#[must_use]
pub fn taken_persons(base: &Path, exclude_session: &str) -> HashSet<String> {
    let now = paths::utc_now_secs();
    let mut taken = HashSet::new();
    if let Ok(listing) = mailbox_records::list_peers(base) {
        for (_, peer) in listing.bodies() {
            if paths::valid_peer(peer)
                && peer.get("session").and_then(Value::as_str) != Some(exclude_session)
                && let Some(person) = peer.get("person").and_then(Value::as_str)
                && is_live_peer(peer, Some(now))
            {
                taken.insert(person.to_string());
            }
        }
    }
    taken
}

fn slug_sanitize(raw: &str, allow_dots: bool) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_dash = false;
    for ch in raw.chars() {
        let keep = ch.is_ascii_lowercase() || ch.is_ascii_digit() || (allow_dots && ch == '.');
        if keep {
            out.push(ch);
            in_dash = false;
        } else if !in_dash {
            out.push('-');
            in_dash = true;
        }
    }
    let trim_chars: &[char] = if allow_dots { &['-', '.'] } else { &['-'] };
    out.trim_matches(trim_chars).to_string()
}

#[must_use]
pub fn model_slug(model: Option<&str>) -> String {
    let Some(m) = model.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let mut slug = m
        .to_ascii_lowercase()
        .split('[')
        .next()
        .unwrap_or("")
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string();
    if let Some(rest) = slug.strip_prefix("claude-") {
        slug = rest.to_string();
    } else if let Some(rest) = slug.strip_prefix("anthropic-") {
        slug = rest.to_string();
    }
    // Strip trailing `-YYYYMMDD`
    if slug.len() > 9 {
        let tail = &slug[slug.len() - 9..];
        if tail.starts_with('-') && tail[1..].bytes().all(|b| b.is_ascii_digit()) {
            slug.truncate(slug.len() - 9);
        }
    }
    // Convert trailing `-(d+)-(d+)$` to `-$1.$2`
    if let Some(last_dash) = slug.rfind('-') {
        let minor = &slug[last_dash + 1..];
        let before_minor = &slug[..last_dash];
        if !minor.is_empty()
            && minor.bytes().all(|b| b.is_ascii_digit())
            && let Some(prev_dash) = before_minor.rfind('-')
        {
            let major = &before_minor[prev_dash + 1..];
            if !major.is_empty() && major.bytes().all(|b| b.is_ascii_digit()) {
                slug = format!("{}-{major}.{minor}", &before_minor[..prev_dash]);
            }
        }
    }
    slug_sanitize(&slug, true)
}

#[must_use]
pub fn session_tag(
    session: &str,
    native_name: Option<&str>,
    native_source: Option<&str>,
) -> String {
    if native_source == Some("derived")
        && let Some(nn) = native_name
        && nn.len() >= 3
        && let Some(idx) = nn.rfind('-')
    {
        let tail = &nn[idx + 1..];
        if tail.len() == 2 && tail.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return tail.to_string();
        }
    }
    let lower = session.to_ascii_lowercase();
    if lower.len() >= 2 {
        let tail = &lower[lower.len() - 2..];
        if tail.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return tail.to_string();
        }
    }
    sha1::sha1_hex(session.as_bytes())[..2].to_string()
}

#[must_use]
pub fn readable_name(
    person: &str,
    repo: &str,
    model: Option<&str>,
    effort: Option<&str>,
    tag: &str,
) -> String {
    let slug = model_slug(model);
    let mut level: String = effort
        .unwrap_or("")
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect();
    if !level.is_empty() && slug.ends_with(&format!("-{level}")) {
        level.clear();
    }
    let repo_clean = slug_sanitize(&repo.to_ascii_lowercase(), true);
    let mut parts = Vec::new();
    for part in [person, &slug, &level, &repo_clean, tag] {
        if !part.is_empty() {
            parts.push(part);
        }
    }
    parts.join("-").chars().take(128).collect()
}

fn slug_underscores(raw: &str) -> String {
    let mut out = String::new();
    let mut in_dash = false;
    for ch in raw.to_ascii_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
            out.push(ch);
            in_dash = false;
        } else if !in_dash {
            out.push('-');
            in_dash = true;
        }
    }
    out.trim_matches(['-', '_']).to_string()
}

#[must_use]
pub fn short_agent_name(person: &str, repo_slug: &str, session_id: &str) -> String {
    let tag = session_tag(session_id, None, None);
    let suffix = format!("-{tag}");
    let max_len = 32usize;

    let mut clean_person = slug_underscores(if person.is_empty() { "" } else { person });
    if clean_person
        .chars()
        .next()
        .is_none_or(|c| !c.is_ascii_lowercase())
    {
        let prefixed = if clean_person.is_empty() {
            "agent".to_string()
        } else {
            format!("a-{clean_person}")
        };
        clean_person = slug_underscores(&prefixed);
    }
    let mut clean_repo = slug_underscores(repo_slug);
    let avail = max_len - suffix.len();
    if !clean_repo.is_empty() {
        if clean_person.len() > 20 {
            clean_person = clean_person[..20].trim_end_matches(['-', '_']).to_string();
        }
        let repo_budget = avail.saturating_sub(clean_person.len() + 1);
        if repo_budget > 0 && clean_repo.len() > repo_budget {
            clean_repo = clean_repo[..repo_budget]
                .trim_end_matches(['-', '_'])
                .to_string();
        }
        if !clean_repo.is_empty() && repo_budget > 0 {
            return format!("{clean_person}-{clean_repo}{suffix}");
        }
    }
    let truncated_person =
        clean_person[..clean_person.len().min(avail)].trim_end_matches(['-', '_']);
    format!("{truncated_person}{suffix}")
}

#[must_use]
pub fn runtime_effort(harness: &str, payload: &Value) -> Option<String> {
    for key in [
        "effort",
        "effortLevel",
        "reasoning_effort",
        "reasoningEffort",
    ] {
        if let Some(s) = payload.get(key).and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    if harness == "claude"
        && let Ok(val) = env::var("CLAUDE_EFFORT")
        && !val.trim().is_empty()
    {
        return Some(val.trim().to_string());
    }
    None
}

/// Discover Claude Code's native session metadata `(nativeName, accountHome, nameSource)`.
#[must_use]
pub fn claude_session(
    session: &str,
    pid: Option<i64>,
) -> (Option<String>, Option<String>, Option<String>) {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    let mut dirs = Vec::new();
    if let Ok(cfg) = env::var("CLAUDE_CONFIG_DIR")
        && !cfg.is_empty()
    {
        dirs.push(paths::expand_home(&cfg, None).join("sessions"));
    }
    dirs.push(home.join(".claude/sessions"));
    if let Ok(entries) = fs::read_dir(&home) {
        let mut profiles: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(".claude-"))
            })
            .collect();
        profiles.sort();
        for prof in profiles {
            dirs.push(prof.join("sessions"));
        }
    }

    let mut seen_dirs = HashSet::new();
    for sessions_dir in dirs {
        if !sessions_dir.is_dir() || !seen_dirs.insert(sessions_dir.clone()) {
            continue;
        }
        let mut candidates = Vec::new();
        if let Some(p) = pid {
            candidates.push(sessions_dir.join(format!("{p}.json")));
        }
        if let Ok(entries) = fs::read_dir(&sessions_dir) {
            let mut rest: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
                .collect();
            rest.sort();
            candidates.extend(rest);
        }
        let mut seen_files = HashSet::new();
        for path in candidates {
            if !seen_files.insert(path.clone()) || !path.is_file() {
                continue;
            }
            let Some(rec) = paths::read_json_file(&path) else {
                continue;
            };
            if rec.get("sessionId").and_then(Value::as_str) != Some(session) {
                continue;
            }
            if let Some(r_pid) = rec.get("pid").and_then(Value::as_i64)
                && !is_pid_live(r_pid)
            {
                continue;
            }
            let native_name = rec
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| paths::valid_session_id(s))
                .map(str::to_string);
            let profile = sessions_dir
                .parent()
                .and_then(|p| paths::resolve_path(p).ok())
                .map(|p| p.to_string_lossy().into_owned());
            let name_source = rec
                .get("nameSource")
                .and_then(Value::as_str)
                .map(str::to_string);
            return (native_name, profile, name_source);
        }
    }
    (None, None, None)
}

#[must_use]
pub fn launch_channels() -> Vec<String> {
    let raw = env::var("AGENT_MAILBOX_CHANNELS").unwrap_or_default();
    let reserved = ["all", "worktree"];
    let mut set = BTreeSet::new();
    for item in raw.split(',') {
        let c = item.trim();
        let valid = !c.is_empty()
            && c.len() <= 40
            && !reserved.contains(&c)
            && c.bytes()
                .next()
                .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && c.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
        if valid {
            set.insert(c.to_string());
        }
    }
    set.into_iter().collect()
}

pub fn migrate_legacy_session(base: &Path, session: &str) {
    let Ok(canonical_key) = paths::session_key(session) else {
        return;
    };
    let mut legacy_keys = BTreeSet::new();
    let k1 = session.replace(':', "_");
    let k2 = session.replace(':', "%3A");
    if k1 != canonical_key {
        legacy_keys.insert(k1);
    }
    if k2 != canonical_key {
        legacy_keys.insert(k2);
    }
    match mailbox_records::backend(base) {
        mailbox_records::Backend::Legacy => {}
        // The cutover already filed every legacy key spelling under its canonical key.
        mailbox_records::Backend::Sqlite | mailbox_records::Backend::Invalid => return,
    }
    for legacy in legacy_keys {
        let legacy_peer = base.join("peers").join(format!("{legacy}.json"));
        if let Some(old) = paths::read_json_file(&legacy_peer)
            && old.get("session").and_then(Value::as_str) == Some(session)
        {
            if let Ok(canon_peer) = paths::peer_path(base, session)
                && !canon_peer.exists()
            {
                let _ = paths::write_json_atomic(&canon_peer, &old);
            }
            let _ = fs::remove_file(&legacy_peer);
        }
        let legacy_inbox = base.join("inbox").join(&legacy);
        if legacy_inbox.is_dir() {
            if let Ok(entries) = fs::read_dir(&legacy_inbox)
                && let Ok(target_dir) = paths::inbox_dir(base, session)
            {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().and_then(|e| e.to_str()) == Some("json")
                        && let Some(msg) = paths::read_json_file(&p)
                        && msg
                            .get("to")
                            .and_then(|t| t.get("session"))
                            .and_then(Value::as_str)
                            == Some(session)
                    {
                        let _ = fs::create_dir_all(&target_dir);
                        if let Some(fname) = p.file_name() {
                            let _ = fs::rename(&p, target_dir.join(fname));
                        }
                    }
                }
            }
            let _ = fs::remove_dir(&legacy_inbox);
        }
    }
}

fn co_hosted(base: &Path, peer: &Value) -> Vec<Value> {
    let Some(pid) = peer.get("pid").and_then(Value::as_i64) else {
        return Vec::new();
    };
    let Some(birth) = peer.get("pidBirth").and_then(Value::as_str) else {
        return Vec::new();
    };
    if birth.is_empty() || is_run_peer(Some(peer)) {
        return Vec::new();
    }
    let Some(my_session) = peer.get("session").and_then(Value::as_str) else {
        return Vec::new();
    };
    let now = paths::utc_now_secs();
    let mut found = Vec::new();
    if let Ok(listing) = mailbox_records::list_peers(base) {
        for (key, other) in listing.bodies() {
            if paths::valid_peer(other)
                && let Some(other_sid) = other.get("session").and_then(Value::as_str)
                && other_sid != my_session
                && !is_run_peer(Some(other))
                && other.get("pid").and_then(Value::as_i64) == Some(pid)
                && other.get("pidBirth").and_then(Value::as_str) == Some(birth)
                && paths::session_key(other_sid).ok().as_deref() == Some(key)
                && is_live_peer(other, Some(now))
            {
                found.push(other.clone());
            }
        }
    }
    found
}

fn persist_agy_control(base: &Path, session: &str, pid: Option<i64>) {
    let Ok(address) = env::var("ANTIGRAVITY_LS_ADDRESS") else {
        return;
    };
    let Ok(token) = env::var("ANTIGRAVITY_CSRF_TOKEN") else {
        return;
    };
    if address.is_empty()
        || token.is_empty()
        || env::var("ANTIGRAVITY_CONVERSATION_ID").ok().as_deref() != Some(session)
    {
        return;
    }
    // LOOPBACK_ADDRESS check: ^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$
    let Some((host, port_s)) = address.rsplit_once(':') else {
        return;
    };
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]")
        || port_s.is_empty()
        || port_s.len() > 5
        || !port_s.bytes().all(|b| b.is_ascii_digit())
    {
        return;
    }
    let Ok(s_key) = paths::session_key(session) else {
        return;
    };
    let path = base.join("wakes").join(s_key).join("agy-control.json");
    let data = json!({
        "lsAddress": address,
        "csrfToken": token,
        "pid": pid,
        "updatedAt": paths::format_utc_iso_z(paths::utc_now_secs()),
    });
    let _ = paths::write_json_atomic(&path, &data);
}

pub fn annotate_peer(base: &Path, session: &str, updates: &[(&str, Value)]) -> Option<Value> {
    let _guard = mailbox_records::lock_peer(base, session).ok()?;
    let mut peer = mailbox_records::read_peer(base, session)?;
    if paths::valid_peer(&peer)
        && let Some(obj) = peer.as_object_mut()
    {
        for (k, v) in updates {
            obj.insert((*k).to_string(), v.clone());
        }
        mailbox_records::write_peer(base, session, &peer).ok()?;
    }
    Some(peer)
}

#[derive(Default)]
pub struct RegisterArgs<'a> {
    pub session: &'a str,
    pub harness: &'a str,
    pub cwd: &'a str,
    pub pid: Option<i64>,
    pub state: Option<&'a str>,
    pub cwd_source: Option<&'a str>,
    pub model: Option<&'a str>,
    pub model_source: &'a str,
    pub session_model: Option<&'a str>,
    pub step_model: Option<&'a str>,
    pub account: Option<&'a str>,
    pub effort: Option<&'a str>,
}

pub fn register_peer(base: &Path, args: RegisterArgs<'_>) -> Option<Value> {
    let _guard = mailbox_records::lock_peer(base, args.session).ok()?;
    migrate_legacy_session(base, args.session);
    let mut peer = match mailbox_records::read_peer_checked(base, args.session) {
        Ok(found) => found.flatten().unwrap_or_else(|| json!({})),
        // Never treat an unreadable active store as a first registration.
        Err(_) if mailbox_records::backend(base) != mailbox_records::Backend::Legacy => {
            return None;
        }
        Err(_) => json!({}),
    };
    let had_verified = !verified_native_ids(base, &peer).is_empty();
    let prev_identity = had_verified.then(|| identity_message(&peer));
    let obj = peer.as_object_mut()?;
    let first = obj.is_empty();
    let prev_pid = obj.get("pid").and_then(Value::as_i64);
    let moment = paths::format_utc_iso_z(paths::utc_now_secs());

    let mut eff_harness = args.harness.to_string();
    if eff_harness == "unknown"
        && let Some(existing_h) = obj.get("harness").and_then(Value::as_str)
        && existing_h != "unknown"
    {
        eff_harness = existing_h.to_string();
    }

    if first {
        let assigned = launch_channels();
        if !assigned.is_empty() {
            obj.insert(
                "channels".to_string(),
                Value::Array(assigned.into_iter().map(Value::String).collect()),
            );
        }
    }

    obj.insert("schema".to_string(), Value::String(PEER_SCHEMA.to_string()));
    obj.insert(
        "session".to_string(),
        Value::String(args.session.to_string()),
    );
    obj.insert("harness".to_string(), Value::String(eff_harness.clone()));

    let eff_cwd = if !args.cwd.is_empty() {
        args.cwd.to_string()
    } else {
        obj.get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    obj.insert("cwd".to_string(), Value::String(eff_cwd.clone()));

    let eff_pid = args.pid.or(prev_pid);
    if let Some(p) = eff_pid {
        obj.insert("pid".to_string(), json!(p));
    } else {
        obj.insert("pid".to_string(), Value::Null);
    }

    let started_at = obj
        .get("startedAt")
        .and_then(Value::as_str)
        .filter(|s| paths::parse_iso8601_utc_secs(s).is_some())
        .map_or_else(|| moment.clone(), str::to_string);
    obj.insert("startedAt".to_string(), Value::String(started_at));
    obj.insert("lastSeenAt".to_string(), Value::String(moment));

    let eff_state = args
        .state
        .or_else(|| obj.get("state").and_then(Value::as_str))
        .unwrap_or("idle")
        .to_string();
    obj.insert("state".to_string(), Value::String(eff_state));

    let sticky_model = args.session_model.or(args.model);
    if let Some(m) = sticky_model {
        let cleaned = paths::clean_text(m, 200);
        if !cleaned.is_empty() {
            obj.insert("model".to_string(), Value::String(cleaned.clone()));
            obj.insert("sessionModel".to_string(), Value::String(cleaned));
            obj.insert(
                "modelSource".to_string(),
                Value::String(args.model_source.to_string()),
            );
        }
    } else if let Some(m) = obj.get("model").cloned()
        && !obj.contains_key("sessionModel")
    {
        obj.insert("sessionModel".to_string(), m);
    }

    if let Some(sm) = args.step_model {
        let cleaned = paths::clean_text(sm, 200);
        if !cleaned.is_empty() {
            obj.insert("stepModel".to_string(), Value::String(cleaned));
            obj.insert(
                "stepModelSource".to_string(),
                Value::String(args.model_source.to_string()),
            );
        }
    } else if sticky_model.is_some()
        && !obj.contains_key("executionModel")
        && let Some(sm) = obj.get("sessionModel").cloned()
    {
        obj.insert("stepModel".to_string(), sm);
    }

    if let Some(src) = args.cwd_source {
        obj.insert("cwdSource".to_string(), Value::String(src.to_string()));
    }

    let is_run = is_run_peer(Some(&Value::Object(obj.clone())));
    if !is_run {
        for key in ["repo", "checkout", "branch", "remotes"] {
            obj.remove(key);
        }
        if let Value::Object(ws_map) = workspace(&eff_cwd) {
            for (k, v) in ws_map {
                obj.insert(k, v);
            }
        }
    }

    let repo = repository_name(&Value::Object(obj.clone()));
    let (native_name, profile, name_source) = if eff_harness == "claude" {
        claude_session(args.session, eff_pid)
    } else {
        (None, None, None)
    };
    if let Some(acct) = profile.or_else(|| args.account.map(str::to_string)) {
        obj.insert("accountHome".to_string(), Value::String(acct));
    }
    if let Some(nn) = native_name {
        obj.insert("nativeName".to_string(), Value::String(nn));
        obj.insert(
            "nativeNameSource".to_string(),
            Value::String(name_source.unwrap_or_else(|| "derived".to_string())),
        );
    }
    if let Some(ef) = args.effort
        && !ef.is_empty()
    {
        obj.insert("effort".to_string(), Value::String(ef.to_string()));
    }

    let prev_name = obj.get("name").and_then(Value::as_str).map(str::to_string);
    let current_val = Value::Object(obj.clone());
    let fallback_stem_raw = obj
        .get("checkout")
        .or_else(|| obj.get("cwd"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let fallback_stem: String = Path::new(fallback_stem_raw)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("root")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let stem = if fallback_stem.is_empty() {
        "root"
    } else {
        &fallback_stem
    };
    let tail_h = &sha1::sha1_hex(args.session.as_bytes())[..2];
    let fallback_name = if eff_harness == "claude" {
        format!("{stem}-{tail_h}")
    } else {
        format!("{eff_harness}:{stem}-{tail_h}")
    };

    let nn_str = obj
        .get("nativeName")
        .and_then(Value::as_str)
        .map(str::to_string);
    let ns_str = obj
        .get("nativeNameSource")
        .and_then(Value::as_str)
        .map(str::to_string);

    let assigned_name = if is_run {
        if eff_harness == "claude"
            && let Some(ref nn) = nn_str
        {
            nn.clone()
        } else {
            fallback_name
        }
    } else if let Some(ref nn) = nn_str
        && ns_str.as_deref() != Some("derived")
        && is_martian_name(nn.split('-').next().unwrap_or(""))
    {
        let person = nn.split('-').next().unwrap_or("").to_string();
        obj.insert("person".to_string(), Value::String(person));
        nn.clone()
    } else {
        let cur_person = obj
            .get("person")
            .and_then(Value::as_str)
            .map(str::to_string);
        if cur_person.as_deref().is_none_or(|p| !is_martian_name(p)) {
            if let Some(old_p) = cur_person {
                let old_short = readable_name(&old_p, &repo, None, None, "");
                let mut aliases: Vec<String> = obj
                    .get("aliases")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect();
                aliases.push(old_short);
                if aliases.len() > 8 {
                    aliases.drain(..aliases.len() - 8);
                }
                obj.insert(
                    "aliases".to_string(),
                    Value::Array(aliases.into_iter().map(Value::String).collect()),
                );
            }
            let taken = taken_persons(base, args.session);
            let person = pick_martian(args.session, &taken);
            obj.insert("person".to_string(), Value::String(person));
        }
        let person = obj.get("person").and_then(Value::as_str).unwrap_or("agent");
        let model_for_name = obj
            .get("sessionModel")
            .or_else(|| obj.get("model"))
            .and_then(Value::as_str);
        let effort_for_name = obj.get("effort").and_then(Value::as_str);
        let tag = session_tag(args.session, nn_str.as_deref(), ns_str.as_deref());
        readable_name(person, &repo, model_for_name, effort_for_name, &tag)
    };
    obj.insert("name".to_string(), Value::String(assigned_name.clone()));

    let person_for_short = obj
        .get("person")
        .and_then(Value::as_str)
        .unwrap_or(&eff_harness);
    obj.insert(
        "shortName".to_string(),
        Value::String(short_agent_name(person_for_short, &repo, args.session)),
    );

    if let Some(pn) = prev_name
        && pn != assigned_name
    {
        let mut aliases: Vec<String> = obj
            .get("aliases")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_string))
            .filter(|a| a != &pn)
            .collect();
        aliases.push(pn);
        if aliases.len() > 8 {
            aliases.drain(..aliases.len() - 8);
        }
        obj.insert(
            "aliases".to_string(),
            Value::Array(aliases.into_iter().map(Value::String).collect()),
        );
    }

    if let Some(pid) = eff_pid
        && (Some(pid) != prev_pid || !obj.contains_key("pidBirth"))
        && let Some(birth) = process_started(pid)
    {
        obj.insert("pidBirth".to_string(), Value::String(birth));
    }

    drop(current_val);
    let snapshot = Value::Object(obj.clone());
    let cohosted = co_hosted(base, &snapshot);
    if cohosted.is_empty() {
        obj.remove("sharedProcess");
    } else {
        obj.insert("sharedProcess".to_string(), Value::Bool(true));
    }

    if let Some(prev_msg) = prev_identity {
        let updated_val = Value::Object(obj.clone());
        if prev_msg != identity_message(&updated_val)
            && let Some(sig) = sign_native_ids(base, &updated_val)
        {
            obj.insert("nativeSessionAttestation".to_string(), Value::String(sig));
        }
    }

    let final_peer = Value::Object(obj.clone());
    mailbox_records::write_peer(base, args.session, &final_peer).ok()?;
    if args.harness == "gemini" {
        persist_agy_control(base, args.session, eff_pid);
    }
    drop(_guard);

    for other in cohosted {
        if other.get("sharedProcess").and_then(Value::as_bool) != Some(true)
            && let Some(other_sid) = other.get("session").and_then(Value::as_str)
        {
            annotate_peer(base, other_sid, &[("sharedProcess", Value::Bool(true))]);
        }
    }

    Some(final_peer)
}

pub fn mark_delegated(base: &Path, me: Value) -> Value {
    let env_run = env::var("AGENT_MAILBOX_SESSION").unwrap_or_default();
    let run_session = if env_run.starts_with("run-") {
        env_run
    } else {
        let s_key = me
            .get("session")
            .and_then(Value::as_str)
            .and_then(|s| paths::session_key(s).ok())
            .unwrap_or_default();
        let delegation = if s_key.is_empty() {
            None
        } else {
            paths::read_json_file(&base.join("delegations").join(format!("{s_key}.json")))
        };
        delegation
            .as_ref()
            .and_then(|d| d.get("run"))
            .and_then(Value::as_str)
            .map_or_else(String::new, |r| format!("run-{r}-worker"))
    };
    let record = if run_session.starts_with("run-") {
        mailbox_records::read_peer(base, &run_session)
    } else {
        None
    };
    let active_run = record
        .as_ref()
        .filter(|r| is_run_record(Some(r)))
        .and_then(|r| r.get("run").and_then(Value::as_str))
        .filter(|r| run_status(base, r).is_none())
        .map(str::to_string);

    let desired = active_run.map_or(Value::Null, Value::String);
    if me.get("delegatedRun") != Some(&desired)
        && let Some(sid) = me.get("session").and_then(Value::as_str)
        && let Some(updated) = annotate_peer(base, sid, &[("delegatedRun", desired)])
    {
        return updated;
    }
    me
}

fn peers_live_at(base: &Path, include_runs: bool, now: i64) -> Vec<Value> {
    let mut found = Vec::new();
    let Ok(listing) = mailbox_records::list_peers(base) else {
        return found;
    };
    for (key, peer) in listing.bodies() {
        if peer.get("schema").and_then(Value::as_str) != Some(PEER_SCHEMA) {
            continue;
        }
        let Some(sid) = peer.get("session").and_then(Value::as_str) else {
            continue;
        };
        if !listing.is_canonical(key, sid) {
            continue;
        }
        if is_run_peer(Some(peer)) {
            if include_runs && is_run_record(Some(peer)) {
                found.push(peer.clone());
            }
            continue;
        }
        if paths::valid_peer(peer) && is_live_peer(peer, Some(now)) {
            found.push(peer.clone());
        }
    }
    found.sort_by(|a, b| {
        let an = a.get("name").and_then(Value::as_str).unwrap_or("");
        let bn = b.get("name").and_then(Value::as_str).unwrap_or("");
        an.cmp(bn).then_with(|| {
            let as_ = a.get("startedAt").and_then(Value::as_str).unwrap_or("");
            let bs_ = b.get("startedAt").and_then(Value::as_str).unwrap_or("");
            as_.cmp(bs_)
        })
    });
    found
}

#[must_use]
pub fn peers_live(base: &Path, include_runs: bool) -> Vec<Value> {
    peers_live_at(base, include_runs, paths::utc_now_secs())
}

fn positive_pid(val: &Value) -> Option<i64> {
    let p = val.get("pid")?;
    if p.is_boolean() {
        return None;
    }
    let pid = p.as_i64()?;
    (pid > 0 && pid <= i64::from(i32::MAX)).then_some(pid)
}

fn within_bound_grace(binding: &Value, now: i64) -> bool {
    let Some(bound_at) = binding
        .get("boundAt")
        .and_then(Value::as_str)
        .and_then(paths::parse_iso8601_utc_secs)
    else {
        return false;
    };
    let age = now - bound_at;
    (0..=CHIEF_UNVERIFIED_GRACE_SECS).contains(&age)
}

fn is_top_level_replacement_peer<F>(
    p: &Value,
    chief_session: &str,
    chief_pid: i64,
    chief_birth: Option<&str>,
    now: i64,
    is_local_peer: &dyn Fn(&Value) -> bool,
    fresh_birth_fn: &mut F,
) -> bool
where
    F: FnMut(i64) -> Option<String>,
{
    if !paths::valid_peer(p)
        || is_run_peer(Some(p))
        || p.get("session").and_then(Value::as_str) == Some(chief_session)
        || !is_local_peer(p)
        || positive_pid(p) != Some(chief_pid)
        || p.get("isSubagent").is_some_and(paths::is_truthy_json)
        || p.get("agySubagentPending")
            .is_some_and(paths::is_truthy_json)
        || p.get("delegatedRun").is_some_and(paths::is_truthy_json)
        || p.get("parentSession").is_some_and(paths::is_truthy_json)
    {
        return false;
    }
    if let Some(bb) = chief_birth
        && let Some(pb) = p
            .get("pidBirth")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        && bb != pb
    {
        return false;
    }
    is_chief_peer_live_with(p, Some(now), fresh_birth_fn)
}

fn is_live_chief_binding_with<F>(
    base: &Path,
    expected_session: Option<&str>,
    peers: Option<&[Value]>,
    now_secs: Option<i64>,
    mut fresh_birth_fn: F,
) -> bool
where
    F: FnMut(i64) -> Option<String>,
{
    let now = now_secs.unwrap_or_else(paths::utc_now_secs);
    let Ok(Some(binding)) = paths::read_chief_json_bounded(base) else {
        return false;
    };
    if binding.get("schema").and_then(Value::as_str) != Some(CHIEF_SCHEMA) {
        return false;
    }
    let Some(session) = binding
        .get("session")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    if let Some(exp) = expected_session
        && session != exp
    {
        return false;
    }
    let host = paths::current_hostname();
    if let Some(machine) = binding
        .get("machine")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        && host.as_deref() != Some(machine)
    {
        return false;
    }

    let binding_pid = positive_pid(&binding);
    let binding_birth = binding
        .get("pidBirth")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut cached_fresh_birth: Option<(i64, Option<String>)> = None;
    let mut lookup_fresh_birth = |pid: i64| -> Option<String> {
        if let Some((cached_pid, ref val)) = cached_fresh_birth
            && cached_pid == pid
        {
            return val.clone();
        }
        let val = fresh_birth_fn(pid);
        cached_fresh_birth = Some((pid, val.clone()));
        val
    };

    let mut verified_live_pid = false;
    if let Some(pid) = binding_pid {
        if !is_pid_live(pid) {
            return false;
        }
        if let Some(birth) = binding_birth {
            match lookup_fresh_birth(pid) {
                Some(current) if current != birth => return false,
                Some(_) => verified_live_pid = true,
                None => verified_live_pid = false,
            }
        } else {
            verified_live_pid = true;
        }
    }

    let is_in_grace = within_bound_grace(&binding, now);
    if binding_pid.is_some() && !verified_live_pid && !is_in_grace {
        return false;
    }

    let is_local_peer = |p: &Value| -> bool {
        match p
            .get("machine")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            Some(pm) => host.as_deref() == Some(pm),
            None => true,
        }
    };

    let exact_peer: Option<Value> = if let Some(slice) = peers {
        slice
            .iter()
            .find(|p| {
                paths::valid_peer(p)
                    && !is_run_peer(Some(p))
                    && p.get("session").and_then(Value::as_str) == Some(session)
                    && is_local_peer(p)
            })
            .cloned()
    } else {
        mailbox_records::read_peer(base, session).filter(|p| {
            paths::valid_peer(p)
                && !is_run_peer(Some(p))
                && p.get("session").and_then(Value::as_str) == Some(session)
                && is_local_peer(p)
        })
    };

    if let Some(peer) = exact_peer {
        let peer_pid = positive_pid(&peer);
        let peer_birth = peer
            .get("pidBirth")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let (Some(bp), Some(pp)) = (binding_pid, peer_pid)
            && bp != pp
        {
            return false;
        }
        if let (Some(bb), Some(pb)) = (binding_birth, peer_birth)
            && bb != pb
        {
            return false;
        }
        return is_chief_peer_live_with(&peer, Some(now), &mut lookup_fresh_birth);
    }

    if verified_live_pid {
        if is_in_grace {
            return true;
        }
        let pid = binding_pid.unwrap_or_default();
        let has_replacement = if let Some(slice) = peers {
            slice.iter().any(|p| {
                is_top_level_replacement_peer(
                    p,
                    session,
                    pid,
                    binding_birth,
                    now,
                    &is_local_peer,
                    &mut lookup_fresh_birth,
                )
            })
        } else if let Ok(listing) = mailbox_records::list_peers(base) {
            let mut found = false;
            for (key, peer) in listing.bodies() {
                let Some(sid) = peer.get("session").and_then(Value::as_str) else {
                    continue;
                };
                if !listing.is_canonical(key, sid) {
                    continue;
                }
                if is_top_level_replacement_peer(
                    peer,
                    session,
                    pid,
                    binding_birth,
                    now,
                    &is_local_peer,
                    &mut lookup_fresh_birth,
                ) {
                    found = true;
                    break;
                }
            }
            found
        } else {
            false
        };
        return !has_replacement;
    }

    is_in_grace
}

/// Validate whether `<base>/chief.json` currently represents a live local Chief binding.
#[must_use]
pub fn is_live_chief_binding(
    base: &Path,
    expected_session: Option<&str>,
    peers: Option<&[Value]>,
    now_secs: Option<i64>,
) -> bool {
    is_live_chief_binding_with(
        base,
        expected_session,
        peers,
        now_secs,
        process_started_fresh,
    )
}

#[must_use]
pub fn colleagues(base: &Path, me: &Value) -> Vec<Value> {
    let my_sid = me.get("session").and_then(Value::as_str);
    let my_nonempty_sid = my_sid.filter(|s| !s.is_empty());
    peers_live(base, false)
        .into_iter()
        .filter(|peer| {
            let sid = peer.get("session").and_then(Value::as_str);
            let parent_matches_me = my_nonempty_sid
                .is_some_and(|ms| peer.get("parentSession").and_then(Value::as_str) == Some(ms));
            sid != my_sid
                && same_project(me, peer)
                && peer.get("isSubagent").and_then(Value::as_bool) != Some(true)
                && peer.get("agySubagentPending").and_then(Value::as_bool) != Some(true)
                && !parent_matches_me
        })
        .collect()
}

/// Remove a peer under its flock (`mailbox_store.unregister`).
pub fn unregister_peer(base: &Path, session: &str) {
    let Ok(_guard) = mailbox_records::lock_peer(base, session) else {
        return;
    };
    let _ = mailbox_records::delete_peer(base, session);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_martian_roundtrip_and_short_name() {
        for step in 0..10 {
            let name = generate_martian("seed-session-1234", step);
            assert!(
                is_martian_name(&name),
                "generated name {name} must validate"
            );
        }
        assert!(is_martian_name("blorbo"));
        assert!(!is_martian_name("notamartianname99"));
        let short = short_agent_name("blorbo", "orkest", "abcdef12");
        assert!(short.starts_with("blorbo-orkest-12"));
        assert!(short.len() <= 32);
    }

    #[test]
    fn test_remote_identity_matches_python() {
        let scp = remote_identity("git@github.com:loftshed/orkest.git", "/tmp");
        let https = remote_identity("https://github.com/loftshed/orkest.git", "/tmp");
        assert_eq!(scp, https);
        assert_eq!(model_slug(Some("claude-opus-5-5[1m]")), "opus-5.5");
    }

    #[test]
    fn test_native_identity_hmac_attestation() {
        let dir = env::temp_dir().join(format!("ork-fast-id-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let base = dir.join("mailbox-v1");
        fs::create_dir_all(base.join("peers")).unwrap();
        let peer_file = paths::peer_path(&base, "session-1").unwrap();
        let peer = json!({
            "schema": PEER_SCHEMA,
            "session": "session-1",
            "name": "blorbo",
            "harness": "claude",
            "machine": paths::current_hostname().unwrap_or_default(),
            "cwd": "/tmp",
            "checkout": "/tmp",
            "startedAt": "2026-01-01T00:00:00Z",
            "lastSeenAt": paths::format_utc_iso_z(paths::utc_now_secs()),
        });
        paths::write_json_atomic(&peer_file, &peer).unwrap();
        let attested = attest_native_sessions(&base, "session-1", &["native-abc"]).unwrap();
        let verified = verified_native_ids(&base, &attested);
        assert!(verified.contains(&"native-abc".to_string()));
        let found = session_peer(&base, "native-abc", Some("claude"), Some("/tmp"), false);
        assert_eq!(found.unwrap()["session"], "session-1");
        let _ = fs::remove_dir_all(&dir);
    }

    fn test_temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let raw = env::temp_dir().join(format!("ork-fast-{label}-{}-{nanos}", std::process::id()));
        let _ = fs::remove_dir_all(&raw);
        fs::create_dir_all(&raw).unwrap();
        fs::canonicalize(&raw).unwrap_or(raw)
    }

    fn make_peer_doc(session: &str, name: &str, repo: &str, seen_secs: i64, pid: i64) -> Value {
        json!({
            "schema": PEER_SCHEMA,
            "session": session,
            "name": name,
            "harness": "gemini",
            "machine": paths::current_hostname().unwrap_or_default(),
            "cwd": repo,
            "checkout": repo,
            "repo": repo,
            "remotes": [],
            "state": "busy",
            "pid": pid,
            "startedAt": paths::format_utc_iso_z(seen_secs),
            "lastSeenAt": paths::format_utc_iso_z(seen_secs),
        })
    }

    #[test]
    fn test_colleagues_excludes_children_pending_and_unrelated_projects() {
        let dir = test_temp_dir("colleagues");
        let base = dir.join("mailbox-v1");
        fs::create_dir_all(base.join("peers")).unwrap();
        let now = paths::utc_now_secs();
        let pid = i64::from(std::process::id());
        let repo_a = dir.join("repo-a");
        let repo_b = dir.join("repo-b");
        fs::create_dir_all(&repo_a).unwrap();
        fs::create_dir_all(&repo_b).unwrap();
        let repo_a_str = repo_a.to_string_lossy().into_owned();
        let repo_b_str = repo_b.to_string_lossy().into_owned();

        let me = make_peer_doc("parent-1", "alpha", &repo_a_str, now, pid);
        let main_colleague = json!({
            "schema": PEER_SCHEMA,
            "session": "colleague-main",
            "name": "bravo",
            "harness": "gemini",
            "machine": paths::current_hostname().unwrap_or_default(),
            "cwd": repo_a_str,
            "checkout": repo_a_str,
            "repo": repo_a_str,
            "remotes": [],
            "state": "idle",
            "sharedProcess": true,
            "pid": pid,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        let confirmed_child = json!({
            "schema": PEER_SCHEMA,
            "session": "child-confirmed",
            "name": "charlie",
            "harness": "gemini",
            "machine": paths::current_hostname().unwrap_or_default(),
            "cwd": repo_a_str,
            "checkout": repo_a_str,
            "repo": repo_a_str,
            "remotes": [],
            "state": "busy",
            "isSubagent": true,
            "parentSession": "parent-1",
            "pid": pid,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        let pending_child = json!({
            "schema": PEER_SCHEMA,
            "session": "child-pending",
            "name": "delta",
            "harness": "gemini",
            "machine": paths::current_hostname().unwrap_or_default(),
            "cwd": repo_a_str,
            "checkout": repo_a_str,
            "repo": repo_a_str,
            "remotes": [],
            "state": "busy",
            "agySubagentPending": true,
            "pid": pid,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        let parent_matched_child = json!({
            "schema": PEER_SCHEMA,
            "session": "child-parent-match",
            "name": "echo",
            "harness": "gemini",
            "machine": paths::current_hostname().unwrap_or_default(),
            "cwd": repo_a_str,
            "checkout": repo_a_str,
            "repo": repo_a_str,
            "remotes": [],
            "state": "busy",
            "parentSession": "parent-1",
            "pid": pid,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        let other_project = make_peer_doc("other-proj", "foxtrot", &repo_b_str, now, pid);

        for doc in [
            &me,
            &main_colleague,
            &confirmed_child,
            &pending_child,
            &parent_matched_child,
            &other_project,
        ] {
            let sid = doc["session"].as_str().unwrap();
            let p = paths::peer_path(&base, sid).unwrap();
            paths::write_json_atomic(&p, doc).unwrap();
        }

        let found = colleagues(&base, &me);
        let found_sids: Vec<&str> = found
            .iter()
            .filter_map(|p| p.get("session").and_then(Value::as_str))
            .collect();
        assert_eq!(found_sids, vec!["colleague-main"]);

        // Missing self session must not match missing parentSession on a colleague.
        let mut me_missing_sid = me.clone();
        me_missing_sid.as_object_mut().unwrap().remove("session");
        let found_without_self = colleagues(&base, &me_missing_sid);
        let found_without_self_sids: Vec<&str> = found_without_self
            .iter()
            .filter_map(|p| p.get("session").and_then(Value::as_str))
            .collect();
        assert!(found_without_self_sids.contains(&"colleague-main"));
        assert!(!found_without_self_sids.contains(&"child-confirmed"));
        assert!(!found_without_self_sids.contains(&"child-pending"));
        assert!(!found_without_self_sids.contains(&"other-proj"));

        // Direct addressing and peers_live still see the child.
        assert_eq!(
            session_peer(&base, "child-confirmed", Some("gemini"), None, false).unwrap()["session"],
            "child-confirmed"
        );
        assert!(
            peers_live(&base, false)
                .iter()
                .any(|p| p["session"] == "child-confirmed")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_is_live_peer_shared_subagent_and_normal_ttl_boundaries() {
        let now = 1_800_000_000_i64;
        let pid = i64::from(std::process::id());
        let birth = process_started_fresh(pid).unwrap();

        let shared_sub = |age: i64, state: &str| {
            json!({
                "schema": PEER_SCHEMA,
                "session": "sub-1",
                "name": "sub",
                "harness": "gemini",
                "cwd": "/tmp",
                "state": state,
                "sharedProcess": true,
                "isSubagent": true,
                "pid": pid,
                "pidBirth": birth,
                "startedAt": paths::format_utc_iso_z(now - age),
                "lastSeenAt": paths::format_utc_iso_z(now - age),
            })
        };
        assert!(is_live_peer(&shared_sub(300, "busy"), Some(now)));
        assert!(!is_live_peer(&shared_sub(301, "busy"), Some(now)));
        assert!(is_live_peer(&shared_sub(300, "idle"), Some(now)));
        assert!(!is_live_peer(&shared_sub(301, "idle"), Some(now)));
        assert!(is_live_peer(&shared_sub(300, "waiting"), Some(now)));
        assert!(!is_live_peer(&shared_sub(301, "waiting"), Some(now)));

        // Unknown/invalid PID shared subagent must also expire at 300s (never 2h UNKNOWN_PID_TTL_SECS).
        for (state, bad_pid) in [
            ("busy", Value::Null),
            ("idle", json!("not-a-pid")),
            ("waiting", json!(false)),
        ] {
            let make_unknown_sub = |age: i64| {
                let mut doc = json!({
                    "schema": PEER_SCHEMA,
                    "session": "sub-unknown-pid",
                    "name": "sub",
                    "harness": "gemini",
                    "cwd": "/tmp",
                    "state": state,
                    "sharedProcess": true,
                    "isSubagent": true,
                    "startedAt": paths::format_utc_iso_z(now - age),
                    "lastSeenAt": paths::format_utc_iso_z(now - age),
                });
                if !bad_pid.is_null() {
                    doc["pid"] = bad_pid.clone();
                }
                doc
            };
            assert!(
                is_live_peer(&make_unknown_sub(300), Some(now)),
                "state={state}"
            );
            assert!(
                !is_live_peer(&make_unknown_sub(301), Some(now)),
                "state={state}"
            );
        }

        let shared_main = |age: i64, state: &str| {
            json!({
                "schema": PEER_SCHEMA,
                "session": "main-1",
                "name": "main",
                "harness": "gemini",
                "cwd": "/tmp",
                "state": state,
                "sharedProcess": true,
                "pid": pid,
                "pidBirth": birth,
                "startedAt": paths::format_utc_iso_z(now - age),
                "lastSeenAt": paths::format_utc_iso_z(now - age),
            })
        };
        assert!(is_live_peer(&shared_main(1800, "busy"), Some(now)));
        assert!(!is_live_peer(&shared_main(1801, "busy"), Some(now)));
        assert!(is_live_peer(&shared_main(10_800, "idle"), Some(now)));
        assert!(!is_live_peer(&shared_main(10_801, "idle"), Some(now)));
        assert!(is_live_peer(&shared_main(10_800, "waiting"), Some(now)));
        assert!(!is_live_peer(&shared_main(10_801, "waiting"), Some(now)));

        // Dead PID and recycled PID (mismatched pidBirth) must return false.
        let mut child = Command::new("true").spawn().unwrap();
        let dead_pid = i64::from(child.id());
        let _ = child.wait();
        let dead_peer = make_peer_doc("dead-1", "dead", "/tmp", now, dead_pid);
        assert!(!is_live_peer(&dead_peer, Some(now)));
        let mut dead_shared_sub = shared_sub(0, "busy");
        dead_shared_sub["pid"] = json!(dead_pid);
        dead_shared_sub.as_object_mut().unwrap().remove("pidBirth");
        assert!(!is_live_peer(&dead_shared_sub, Some(now)));

        let recycled_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "recycled-1",
            "name": "recycled",
            "harness": "gemini",
            "cwd": "/tmp",
            "state": "busy",
            "pid": pid,
            "pidBirth": "Thu Jan  1 00:00:00 1970",
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        assert!(!is_live_peer(&recycled_peer, Some(now)));
        let mut recycled_shared_sub = shared_sub(0, "busy");
        recycled_shared_sub["pidBirth"] = json!("Thu Jan  1 00:00:00 1970");
        assert!(!is_live_peer(&recycled_shared_sub, Some(now)));
    }

    #[test]
    fn test_is_live_chief_binding_cases() {
        let dir = test_temp_dir("chief-liveness");
        let base = dir.join("mailbox-v1");
        fs::create_dir_all(base.join("peers")).unwrap();
        let now = 1_800_000_000_i64;
        let pid = i64::from(std::process::id());
        let birth = process_started_fresh(pid).unwrap();
        let host = paths::current_hostname().unwrap_or_default();

        let mut dead_child = Command::new("true").spawn().unwrap();
        let dead_pid = i64::from(dead_child.id());
        let _ = dead_child.wait();

        let write_chief = |doc: &Value| {
            paths::write_json_atomic(&base.join("chief.json"), doc).unwrap();
        };

        // 1. Missing chief.json -> false
        assert!(!is_live_chief_binding(&base, None, Some(&[]), Some(now)));

        // 2. boundAt grace boundaries: 599, 600 -> true; 601, missing, future -> false
        for (age, expected) in [(599, true), (600, true), (601, false), (-1, false)] {
            write_chief(&json!({
                "schema": CHIEF_SCHEMA,
                "session": "chief-1",
                "boundAt": paths::format_utc_iso_z(now - age),
            }));
            assert_eq!(
                is_live_chief_binding(&base, Some("chief-1"), Some(&[]), Some(now)),
                expected,
                "age={age}"
            );
        }
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
        }));
        assert!(!is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(&[]),
            Some(now)
        ));

        // 3. Wrong machine -> false
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": "wrong-remote-host",
            "pid": pid,
            "boundAt": paths::format_utc_iso_z(now),
        }));
        assert!(!is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(&[]),
            Some(now)
        ));

        // 4. Dead or recycled PID -> false even if stale peer record looks live
        let stale_live_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "chief-1",
            "name": "chief",
            "harness": "claude",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": dead_pid,
            "boundAt": paths::format_utc_iso_z(now),
        }));
        assert!(!is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(std::slice::from_ref(&stale_live_peer)),
            Some(now)
        ));

        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": pid,
            "pidBirth": "Thu Jan  1 00:00:00 1970",
            "boundAt": paths::format_utc_iso_z(now),
        }));
        assert!(!is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(std::slice::from_ref(&stale_live_peer)),
            Some(now)
        ));

        // 5. Same-PID top-level replacement: allowed within 600s grace, rejected after 600s
        let replacement_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "other-top-level",
            "name": "other",
            "harness": "claude",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "pid": pid,
            "pidBirth": birth,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": pid,
            "pidBirth": birth,
            "boundAt": paths::format_utc_iso_z(now - 600),
        }));
        assert!(is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(std::slice::from_ref(&replacement_peer)),
            Some(now)
        ));
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": pid,
            "pidBirth": birth,
            "boundAt": paths::format_utc_iso_z(now - 601),
        }));
        assert!(!is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(std::slice::from_ref(&replacement_peer)),
            Some(now)
        ));

        // 6. Children, delegatedRun, and run peers do NOT count as replacement evidence,
        //    whereas a top-level sharedProcess peer DOES invalidate Chief past 600s grace.
        let shared_child_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "child-on-same-pid",
            "name": "child",
            "harness": "gemini",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "sharedProcess": true,
            "isSubagent": true,
            "pid": pid,
            "pidBirth": birth,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        let pending_child_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "pending-child-same-pid",
            "name": "pending",
            "harness": "gemini",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "sharedProcess": true,
            "agySubagentPending": true,
            "pid": pid,
            "pidBirth": birth,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        let parent_session_only_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "child-parent-only",
            "name": "child-parent",
            "harness": "gemini",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "parentSession": "chief-1",
            "pid": pid,
            "pidBirth": birth,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        let delegated_run_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "delegated-same-pid",
            "name": "delegated",
            "harness": "claude",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "delegatedRun": "run-r1",
            "pid": pid,
            "pidBirth": birth,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        let run_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "run-r1-worker",
            "run": "r1",
            "role": "worker",
            "name": "worker",
            "harness": "claude",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "pid": pid,
            "pidBirth": birth,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        assert!(is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(&[
                shared_child_peer,
                pending_child_peer,
                parent_session_only_peer,
                delegated_run_peer,
                run_peer,
            ]),
            Some(now)
        ));

        let shared_top_level_replacement = json!({
            "schema": PEER_SCHEMA,
            "session": "chief-cleared-new",
            "name": "new-top-level",
            "harness": "gemini",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "sharedProcess": true,
            "pid": pid,
            "pidBirth": birth,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        assert!(!is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(&[shared_top_level_replacement]),
            Some(now)
        ));

        // 7. Contradictory exact peer PID vs binding PID -> false
        let conflicting_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "chief-1",
            "name": "chief",
            "harness": "claude",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "pid": pid + 999,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        assert!(!is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(&[conflicting_peer]),
            Some(now)
        ));

        // 8. When binding has pidBirth and fresh ps lookup is unavailable (None), do NOT treat as
        //    perpetually verified: bounded 600s grace applies. Legacy no-pidBirth stays verified.
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": pid,
            "pidBirth": birth,
            "boundAt": paths::format_utc_iso_z(now - 600),
        }));
        assert!(is_live_chief_binding_with(
            &base,
            Some("chief-1"),
            Some(&[]),
            Some(now),
            |_| None
        ));
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": pid,
            "pidBirth": birth,
            "boundAt": paths::format_utc_iso_z(now - 601),
        }));
        assert!(!is_live_chief_binding_with(
            &base,
            Some("chief-1"),
            Some(&[]),
            Some(now),
            |_| None
        ));
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": pid,
            "boundAt": paths::format_utc_iso_z(now - 601),
        }));
        assert!(is_live_chief_binding_with(
            &base,
            Some("chief-1"),
            Some(&[]),
            Some(now),
            |_| None
        ));

        // 8b. Exact peer (lastSeen 1 day old) must NOT bypass expired grace when fresh birth lookup returns None.
        let one_day_ago = paths::format_utc_iso_z(now - 86_400);
        let old_exact_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "chief-1",
            "name": "chief",
            "harness": "claude",
            "machine": host,
            "cwd": "/tmp",
            "state": "idle",
            "pid": pid,
            "pidBirth": birth,
            "startedAt": one_day_ago,
            "lastSeenAt": one_day_ago,
        });
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": pid,
            "pidBirth": birth,
            "boundAt": paths::format_utc_iso_z(now - 601),
        }));
        assert!(!is_live_chief_binding_with(
            &base,
            Some("chief-1"),
            Some(std::slice::from_ref(&old_exact_peer)),
            Some(now),
            |_| None
        ));
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": pid,
            "pidBirth": birth,
            "generation": "gen-1",
            "boundAt": paths::format_utc_iso_z(now - 600),
        }));
        assert!(is_live_chief_binding_with(
            &base,
            Some("chief-1"),
            Some(&[old_exact_peer]),
            Some(now),
            |_| None
        ));

        // 9. Poisoned PID_BIRTH_CACHE must never overturn fresh birth checks on exact peer or replacement.
        let mut sleeper = Command::new("sleep").arg("30").spawn().unwrap();
        let sleeper_pid = i64::from(sleeper.id());
        let sleeper_birth = process_started_fresh(sleeper_pid).unwrap();
        {
            let cache = PID_BIRTH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
            let mut map = cache.lock().unwrap();
            map.insert(sleeper_pid, "Thu Jan  1 00:00:00 1970".to_string());
        }
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": sleeper_pid,
            "pidBirth": sleeper_birth,
            "boundAt": paths::format_utc_iso_z(now - 601),
        }));
        let exact_sleeper_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "chief-1",
            "name": "chief",
            "harness": "claude",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "pid": sleeper_pid,
            "pidBirth": sleeper_birth,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        assert!(is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(&[exact_sleeper_peer]),
            Some(now)
        ));
        let replacement_sleeper_peer = json!({
            "schema": PEER_SCHEMA,
            "session": "new-top-sleeper",
            "name": "other",
            "harness": "claude",
            "machine": host,
            "cwd": "/tmp",
            "state": "busy",
            "sharedProcess": true,
            "pid": sleeper_pid,
            "pidBirth": sleeper_birth,
            "startedAt": paths::format_utc_iso_z(now),
            "lastSeenAt": paths::format_utc_iso_z(now),
        });
        assert!(!is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(&[replacement_sleeper_peer]),
            Some(now)
        ));
        if let Some(cache) = PID_BIRTH_CACHE.get()
            && let Ok(mut map) = cache.lock()
        {
            map.remove(&sleeper_pid);
        }
        let _ = sleeper.kill();
        let _ = sleeper.wait();

        // 10. Non-shared exact peer with verified live PID + matching pidBirth MUST still enforce
        //     7-day (604_800s) Chief heartbeat max-age (parity with chief.mjs & handoff.py),
        //     while is_live_peer keeps non-shared mail reachability past 7 days.
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": pid,
            "pidBirth": birth,
            "boundAt": paths::format_utc_iso_z(now - 8 * 86_400),
        }));
        let make_non_shared_exact_peer = |age: i64| {
            json!({
                "schema": PEER_SCHEMA,
                "session": "chief-1",
                "name": "chief",
                "harness": "claude",
                "machine": host,
                "cwd": "/tmp",
                "state": "idle",
                "sharedProcess": false,
                "pid": pid,
                "pidBirth": birth,
                "startedAt": paths::format_utc_iso_z(now - age),
                "lastSeenAt": paths::format_utc_iso_z(now - age),
            })
        };
        let aged_8d_peer = make_non_shared_exact_peer(8 * 86_400);
        assert!(is_live_peer(&aged_8d_peer, Some(now)));
        assert!(!is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(std::slice::from_ref(&aged_8d_peer)),
            Some(now)
        ));
        assert!(is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(&[make_non_shared_exact_peer(MAX_AGE_SECS)]),
            Some(now)
        ));
        assert!(!is_live_chief_binding(
            &base,
            Some("chief-1"),
            Some(&[make_non_shared_exact_peer(MAX_AGE_SECS + 1)]),
            Some(now)
        ));

        // Fresh exact peer must also NOT bypass unverified-PID expired grace.
        let fresh_exact_peer = make_non_shared_exact_peer(0);
        write_chief(&json!({
            "schema": CHIEF_SCHEMA,
            "session": "chief-1",
            "machine": host,
            "pid": pid,
            "pidBirth": birth,
            "boundAt": paths::format_utc_iso_z(now - 601),
        }));
        assert!(!is_live_chief_binding_with(
            &base,
            Some("chief-1"),
            Some(&[fresh_exact_peer]),
            Some(now),
            |_| None
        ));

        let _ = fs::remove_dir_all(&dir);
    }
}
