//! Mailbox hook fast path accelerator (<1.5 ms).
//! Handles the ~95% trivial interactive turns and delegates the ~5% slow paths to python3.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::IntoRawFd;
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

pub(crate) struct FileLockGuard {
    fd: libc::c_int,
}

impl Drop for FileLockGuard {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

/// Lock acquisition retries when a pruner unlinked the lock path between open and flock.
const LOCK_ACQUIRE_ATTEMPTS: usize = 64;

/// Device and inode of an open descriptor, without taking ownership of it.
fn fd_identity(fd: libc::c_int) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::io::FromRawFd;
    let file = std::mem::ManuallyDrop::new(unsafe { fs::File::from_raw_fd(fd) });
    let meta = file.metadata().ok()?;
    Some((meta.dev(), meta.ino()))
}

/// True when the locked descriptor is still the inode at `lock_path` (same check as `mailbox_store.acquire_lock`).
fn same_inode(fd: libc::c_int, lock_path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(current) = fs::metadata(lock_path) else {
        return false;
    };
    fd_identity(fd) == Some((current.dev(), current.ino()))
}

pub(crate) fn lock_path_exclusive(lock_path: &Path) -> io::Result<FileLockGuard> {
    for _ in 0..LOCK_ACQUIRE_ATTEMPTS {
        let file = match OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC)
            .open(lock_path)
        {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                if let Some(parent) = lock_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                continue;
            }
            Err(err) => return Err(err),
        };
        let fd = file.into_raw_fd();
        let guard = FileLockGuard { fd };
        loop {
            if unsafe { libc::flock(fd, libc::LOCK_EX) } == 0 {
                break;
            }
            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::Interrupted {
                return Err(err);
            }
        }
        // A pruner may have unlinked this inode while we waited; locking it would not exclude a
        // process that opens the new file at the same path.
        if same_inode(fd, lock_path) {
            // Touch the lock so idle-lock reaping sees recent use.
            unsafe {
                libc::futimens(fd, std::ptr::null());
            }
            return Ok(guard);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::WouldBlock,
        "could not acquire a stable peer lock",
    ))
}

fn lock_peer(peer_file: &Path) -> io::Result<FileLockGuard> {
    if let Some(parent) = peer_file.parent() {
        fs::create_dir_all(parent)?;
    }
    lock_path_exclusive(&peer_file.with_extension("lock"))
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

    // StopFailure starts an automatic handoff (handoff.py): always Python, before any fast exit.
    if event == "StopFailure" {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

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

    let cache = paths::cache_home(None, None);
    let base = cache.join("mailbox-v1");
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
        || peer.get("agySubagentPending").and_then(|v| v.as_bool()) == Some(true)
        // peer_mailbox.mark_delegated records the run ID; Python tests it for truth, as here.
        || peer.get("delegatedRun").is_some_and(is_truthy_json)
        || peer.get("run").and_then(|v| v.as_str()).is_some()
        // A fresh successor an automatic handoff launched: Python runs its quota check (handoff.poll).
        || std::env::var_os("ORKEST_HANDOFF_SUCCESSOR").is_some_and(|v| !v.is_empty())
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

    // A team's lead or deputy: Python gives succession advice and runs the handoff quota check.
    let peer_harness = peer
        .get("harness")
        .and_then(|v| v.as_str())
        .unwrap_or(harness);
    if paths::has_active_authority_for_session(&cache, &session, peer_harness) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn test_lock_retries_after_pruner_unlinks_inode() {
        let dir = std::env::temp_dir().join(format!("ork-fast-lock-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let lock_path = dir.join("peer.lock");
        let first = lock_path_exclusive(&lock_path).unwrap();
        let orphan = fs::metadata(&lock_path).unwrap().ino();

        let (sender, receiver) = mpsc::channel();
        let waiter_path = lock_path.clone();
        let waiter = thread::spawn(move || {
            let guard = lock_path_exclusive(&waiter_path).unwrap();
            sender.send(fd_identity(guard.fd).unwrap().1).unwrap();
            drop(guard);
        });
        // Let the waiter open the original inode and block in flock, then unlink it as a pruner would.
        thread::sleep(Duration::from_millis(100));
        fs::remove_file(&lock_path).unwrap();
        drop(first);

        let locked_inode = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        waiter.join().unwrap();
        let current = fs::metadata(&lock_path).unwrap().ino();
        assert_eq!(
            locked_inode, current,
            "the waiter must hold the inode now at the path"
        );
        assert_ne!(
            locked_inode, orphan,
            "the waiter must not stay on the unlinked inode"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_lock_sets_cloexec_and_recreates_missing_parent() {
        let dir = std::env::temp_dir().join(format!("ork-fast-cloexec-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let lock_path = dir.join("nested").join("peer.lock");
        let guard = lock_path_exclusive(&lock_path).unwrap();
        let flags = unsafe { libc::fcntl(guard.fd, libc::F_GETFD) };
        assert_ne!(flags, -1);
        assert_ne!(
            flags & libc::FD_CLOEXEC,
            0,
            "lock file descriptor must have O_CLOEXEC set"
        );
        drop(guard);
        let _ = fs::remove_dir_all(&dir);
    }
}
