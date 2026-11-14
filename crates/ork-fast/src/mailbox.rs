//! Mailbox hook fast path accelerator (<1.5 ms).
//! Handles the ~95% trivial interactive turns and delegates the ~5% slow paths to python3.

use std::ffi::CString;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::paths;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn delegate(
    fallback_script: &Path,
    harness: &str,
    event_arg: Option<&str>,
    stdin_bytes: &[u8],
) -> io::Result<()> {
    let mut cmd = Command::new("python3");
    cmd.arg("-B")
        .arg(fallback_script)
        .arg("hook")
        .arg("--harness")
        .arg(harness);
    if let Some(ev) = event_arg {
        cmd.arg("--event").arg(ev);
    }
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stdin_bytes);
    }
    let status = child.wait()?;
    std::process::exit(status.code().unwrap_or(0));
}

fn is_truthy_json(val: &serde_json::Value) -> bool {
    match val {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        serde_json::Value::String(s) => !s.is_empty(),
        serde_json::Value::Array(a) => !a.is_empty(),
        serde_json::Value::Object(o) => !o.is_empty(),
    }
}

fn check_slash_commands(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("/side")
        || lower.contains("!side")
        || lower.contains("side:")
        || lower.contains("ork side")
        || lower.contains("[orkest-side-command")
        || lower.contains("/swarm")
        || lower.contains("/horde")
        || lower.contains("[orkest-swarm")
        || lower.contains("/clear")
}

fn is_pid_live(pid: u64) -> bool {
    if pid == 0 || pid > i32::MAX as u64 {
        return false;
    }
    unsafe {
        libc::kill(pid as i32, 0) == 0
            || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

fn has_unread_mail(inbox_dir: &Path) -> bool {
    if !inbox_dir.is_dir() {
        return false;
    }
    let entries = match fs::read_dir(inbox_dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|ext| ext.to_str()) == Some("json")
            && let Ok(content) = fs::read_to_string(&p)
            && let Ok(val) = serde_json::from_str::<serde_json::Value>(&content)
            && val.is_object()
            && !val.get("readAt").is_some_and(is_truthy_json)
        {
            return true;
        }
    }
    false
}

fn extract_model_str(val: &serde_json::Value) -> Option<String> {
    let raw = if let Some(s) = val.as_str() {
        s
    } else {
        let obj = val.as_object()?;
        obj.get("id")
            .or_else(|| obj.get("model"))
            .or_else(|| obj.get("name"))
            .or_else(|| obj.get("display_name"))
            .and_then(|v| v.as_str())?
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") || trimmed.starts_with('<') {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn payload_changes_model(payload: &serde_json::Value, peer: &serde_json::Value) -> bool {
    if payload.get("modelSwitch").is_some_and(is_truthy_json) {
        return true;
    }
    for key in [
        "sessionModel",
        "session_model",
        "stepModel",
        "step_model",
        "workerModel",
        "subagentModel",
    ] {
        if payload.get(key).and_then(extract_model_str).is_some() {
            return true;
        }
    }
    if let Some(m) = payload
        .get("model")
        .or_else(|| payload.get("modelName"))
        .and_then(extract_model_str)
    {
        let peer_model = peer.get("model").and_then(|v| v.as_str());
        if peer_model != Some(m.as_str()) {
            return true;
        }
    }
    false
}

fn has_newer_colleague_file(peers_dir: &Path, peer_file: &Path) -> bool {
    let Ok(peer_mtime) = fs::metadata(peer_file).and_then(|m| m.modified()) else {
        return true;
    };
    let Ok(entries) = fs::read_dir(peers_dir) else {
        return true;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if p.file_name() == peer_file.file_name() {
            continue;
        }
        if let Ok(other_mtime) = entry.metadata().and_then(|m| m.modified())
            && other_mtime > peer_mtime
        {
            return true;
        }
    }
    false
}

struct FileLockGuard {
    fd: libc::c_int,
}

impl Drop for FileLockGuard {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

fn lock_peer(peer_file: &Path) -> io::Result<FileLockGuard> {
    if let Some(parent) = peer_file.parent() {
        fs::create_dir_all(parent)?;
    }
    let lock_path = peer_file.with_extension("lock");
    let c_path = CString::new(lock_path.as_os_str().as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_CREAT | libc::O_RDWR, 0o600) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let guard = FileLockGuard { fd };
    if unsafe { libc::flock(fd, libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(guard)
}

fn write_json_atomic(path: &Path, value: &serde_json::Value) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "peer path has no parent"))?;
    fs::create_dir_all(parent)?;
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!(".mail-{}-{seq}.tmp", std::process::id()));
    let payload =
        serde_json::to_vec(value).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let write_result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp_path)?;
        file.write_all(&payload)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }

    if let Err(err) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }
    Ok(())
}

fn update_peer_locked<F>(peer_file: &Path, mutate: F) -> bool
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> bool,
{
    let Ok(_guard) = lock_peer(peer_file) else {
        return false;
    };
    let Ok(content) = fs::read_to_string(peer_file) else {
        return false;
    };
    let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    if !paths::valid_peer(&val) {
        return false;
    }
    let Some(obj) = val.as_object_mut() else {
        return false;
    };
    if !mutate(obj) {
        return false;
    }
    write_json_atomic(peer_file, &val).is_ok()
}

pub fn run(
    harness: &str,
    event_arg: Option<&str>,
    fallback_script: Option<&Path>,
) -> io::Result<()> {
    let mut raw_stdin = Vec::new();
    io::stdin().read_to_end(&mut raw_stdin)?;

    let default_fb =
        paths::expand_home("~/.agents/skills/orchestrate/scripts/peer_mailbox.py", None);
    let fb = fallback_script.unwrap_or(&default_fb);

    if raw_stdin.is_empty() {
        return Ok(());
    }

    let payload: serde_json::Value = match serde_json::from_slice(&raw_stdin) {
        Ok(v) => v,
        Err(_) => return delegate(fb, harness, event_arg, &raw_stdin),
    };

    let detected_event = event_arg
        .map(String::from)
        .or_else(|| {
            payload
                .get("hook_event_name")
                .or_else(|| payload.get("event"))
                .or_else(|| payload.get("eventName"))
                .or_else(|| payload.get("hookEventName"))
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .or_else(|| {
            if harness == "gemini" {
                if payload.get("terminationReason").is_some() {
                    Some("Stop".to_string())
                } else if payload.get("invocationNum").is_some() {
                    Some("PreInvocation".to_string())
                } else {
                    Some("SessionStart".to_string())
                }
            } else {
                None
            }
        });

    let event = match detected_event {
        Some(ev) => ev,
        None => return Ok(()),
    };

    // Immediate plan mode suppression
    let tool_name = payload
        .get("tool_name")
        .or_else(|| payload.get("toolName"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if tool_name == "ExitPlanMode" || tool_name == "EnterPlanMode" {
        return Ok(());
    }

    // 1. Lifecycle events that always need Python:
    if matches!(
        event.as_str(),
        "SessionStart" | "SessionEnd" | "SubagentStart" | "SubagentStop"
    ) {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    // 2. Clear command or slash commands in payload:
    if payload.get("source").and_then(|v| v.as_str()) == Some("clear") {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }
    for key in &["lastUserInput", "prompt", "userMessage", "query"] {
        if let Some(txt) = payload.get(key).and_then(|v| v.as_str())
            && check_slash_commands(txt)
        {
            return delegate(fb, harness, Some(&event), &raw_stdin);
        }
    }

    // 3. Resolve session ID:
    let session_val = payload
        .get("session_id")
        .or_else(|| payload.get("conversationId"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| std::env::var("ANTIGRAVITY_CONVERSATION_ID").ok());

    let session = match session_val {
        Some(s) if !s.is_empty() => s,
        _ => return delegate(fb, harness, Some(&event), &raw_stdin),
    };

    let base = paths::cache_home(None, None).join("mailbox-v1");
    let s_key = match paths::session_key(&session) {
        Ok(k) => k,
        Err(_) => return delegate(fb, harness, Some(&event), &raw_stdin),
    };

    let peer_file = base.join("peers").join(format!("{s_key}.json"));
    if !peer_file.is_file() {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    let peer_content = match fs::read_to_string(&peer_file) {
        Ok(c) => c,
        Err(_) => return delegate(fb, harness, Some(&event), &raw_stdin),
    };
    let peer: serde_json::Value = match serde_json::from_str(&peer_content) {
        Ok(v) => v,
        Err(_) => return delegate(fb, harness, Some(&event), &raw_stdin),
    };

    if !paths::valid_peer(&peer)
        || peer.get("session").and_then(|v| v.as_str()) != Some(session.as_str())
    {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    if peer.get("isSubagent").and_then(|v| v.as_bool()) == Some(true)
        || peer.get("delegatedRun").and_then(|v| v.as_bool()) == Some(true)
        || peer.get("run").and_then(|v| v.as_str()).is_some()
    {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    if let Some(pid) = peer.get("pid").and_then(|v| v.as_u64())
        && !is_pid_live(pid)
    {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    // Check cwd
    if let Some(cwd_in) = payload.get("cwd").and_then(|v| v.as_str())
        && let Some(p_cwd) = peer.get("cwd").and_then(|v| v.as_str())
        && cwd_in != p_cwd
    {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    // Check daemon health
    let daemon_file = base.join("daemon.json");
    if daemon_file.is_file()
        && let Ok(c) = fs::read_to_string(&daemon_file)
        && let Ok(d) = serde_json::from_str::<serde_json::Value>(&c)
        && d.get("mode").and_then(|v| v.as_str()) == Some("http")
        && let Some(daemon_pid) = d.get("pid").and_then(|v| v.as_u64())
        && !is_pid_live(daemon_pid)
    {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    // Check unread inbox
    let inbox_dir = base.join("inbox").join(&s_key);
    if has_unread_mail(&inbox_dir) {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    // Check rooms for obligations (only active/open rooms referencing this session)
    if paths::has_active_room_for_session(&base, &session) {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    // Fast Path execution:
    if event == "Stop" {
        let term_reason = if harness == "gemini" {
            payload
                .get("terminationReason")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
        } else {
            None
        };
        let updated = update_peer_locked(&peer_file, |obj| {
            obj.insert(
                "state".to_string(),
                serde_json::Value::String("idle".to_string()),
            );
            obj.insert(
                "lastSeenAt".to_string(),
                serde_json::Value::String(paths::format_utc_iso_z(paths::utc_now_secs())),
            );
            if let Some(ref reason) = term_reason {
                obj.insert(
                    "lastStopReason".to_string(),
                    serde_json::Value::String(reason.clone()),
                );
            }
            true
        });
        if !updated {
            return delegate(fb, harness, Some(&event), &raw_stdin);
        }
        return Ok(());
    }

    if event == "PreInvocation" {
        let is_busy = peer.get("state").and_then(|v| v.as_str()) == Some("busy");
        let no_stop_reason = peer.get("lastStopReason").is_none_or(|v| v.is_null());
        if is_busy
            && no_stop_reason
            && !payload_changes_model(&payload, &peer)
            && !has_newer_colleague_file(&base.join("peers"), &peer_file)
        {
            let updated = update_peer_locked(&peer_file, |obj| {
                if !paths::valid_peer(&serde_json::Value::Object(obj.clone()))
                    || obj.get("state").and_then(|v| v.as_str()) != Some("busy")
                    || !obj.get("lastStopReason").is_none_or(|v| v.is_null())
                {
                    return false;
                }
                obj.insert(
                    "lastSeenAt".to_string(),
                    serde_json::Value::String(paths::format_utc_iso_z(paths::utc_now_secs())),
                );
                true
            });
            if !updated {
                return delegate(fb, harness, Some(&event), &raw_stdin);
            }
            return Ok(());
        }
    }

    // For any remaining subtlety or first turn context, delegate safely:
    delegate(fb, harness, Some(&event), &raw_stdin)
}
