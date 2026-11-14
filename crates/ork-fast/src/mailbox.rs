//! Mailbox hook fast path accelerator (<1.5 ms).
//! Handles the ~95% trivial interactive turns and delegates the ~5% slow paths to python3.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::paths;

const ANTIGRAVITY_NO_CONTINUE: &[&str] = &[
    "USER_CANCELED",
    "ERROR",
    "MAX_INVOCATIONS",
    "MAX_FORCED_INVOCATIONS",
    "MAX_TOKEN_BUDGET_EXCEEDED",
];

pub fn delegate(
    fallback_script: &Path,
    harness: &str,
    event: Option<&str>,
    stdin_bytes: &[u8],
) -> io::Result<()> {
    let mut cmd = Command::new("python3");
    cmd.arg("-B")
        .arg(fallback_script)
        .arg("hook")
        .arg("--harness")
        .arg(harness);

    if let Some(ev) = event {
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

fn is_pid_live(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn transcript_has_plan_mode_call(path_str: &str) -> bool {
    let path = PathBuf::from(path_str);
    if !path.is_file() {
        return false;
    }
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    let file_len = meta.len();
    let read_len = 65536.min(file_len);
    let mut file = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    if file_len > read_len {
        use std::io::Seek;
        if file.seek(io::SeekFrom::Start(file_len - read_len)).is_err() {
            return false;
        }
    }
    let mut buffer = Vec::with_capacity(read_len as usize);
    if file.read_to_end(&mut buffer).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&buffer);
    for line in text.lines().rev() {
        if line.contains("exit_plan_mode") || line.contains("enter_plan_mode") {
            return true;
        }
        if line.contains("\"USER_INPUT\"") || line.contains("\"USER_EXPLICIT\"") {
            break;
        }
    }
    false
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
            && (val.get("readAt").is_none() || val.get("readAt").is_some_and(|v| v.is_null()))
        {
            return true;
        }
    }
    false
}

pub fn run(
    harness: &str,
    event_arg: Option<&str>,
    fallback_script: Option<&Path>,
) -> io::Result<()> {
    let mut raw_stdin = Vec::new();
    io::stdin().read_to_end(&mut raw_stdin)?;

    let fb = fallback_script.unwrap_or_else(|| {
        Path::new("/Users/lofstpe1/.agents/skills/orchestrate/scripts/peer_mailbox.py")
    });

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

    let base = paths::cache_home(None, None);
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

    if peer.get("isSubagent").and_then(|v| v.as_bool()) == Some(true)
        || peer.get("delegatedRun").and_then(|v| v.as_bool()) == Some(true)
    {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    if let Some(pid) = peer.get("pid").and_then(|v| v.as_u64())
        && !is_pid_live(pid as u32)
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
        && let Some(dpid) = d.get("pid").and_then(|v| v.as_u64())
        && !is_pid_live(dpid as u32)
    {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    // Check unread inbox
    let inbox_dir = base.join("inboxes").join(&s_key);
    if has_unread_mail(&inbox_dir) {
        return delegate(fb, harness, Some(&event), &raw_stdin);
    }

    // Check rooms for obligations
    let rooms_dir = base.join("rooms");
    if rooms_dir.is_dir()
        && let Ok(entries) = fs::read_dir(&rooms_dir)
    {
        let mut count = 0;
        for _ in entries.flatten() {
            count += 1;
            if count > 0 {
                return delegate(fb, harness, Some(&event), &raw_stdin);
            }
        }
    }

    // Fast Path execution:
    if event == "Stop" {
        if harness == "gemini" {
            if let Some(term) = payload.get("terminationReason").and_then(|v| v.as_str())
                && ANTIGRAVITY_NO_CONTINUE.contains(&term)
            {
                println!("{{}}");
                return Ok(());
            }

            let raw_transcript = payload
                .get("transcript_path")
                .or_else(|| payload.get("transcriptPath"))
                .and_then(|v| v.as_str());
            if let Some(t_path) = raw_transcript
                && transcript_has_plan_mode_call(t_path)
            {
                println!("{{}}");
                return Ok(());
            }
            println!("{{}}");
            return Ok(());
        }

        // Claude / Codex Stop with empty inbox
        return Ok(());
    }

    if event == "PreInvocation" {
        let is_busy = peer.get("state").and_then(|v| v.as_str()) == Some("busy");
        if is_busy {
            // Mid-turn step
            if harness == "gemini" {
                println!("{{}}");
            }
            return Ok(());
        }
    }

    // For any remaining subtlety or first turn context, delegate safely:
    delegate(fb, harness, Some(&event), &raw_stdin)
}
