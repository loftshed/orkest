//! Statusline renderer matching agent_statusline.py (<1 ms cached file rendering).

use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::Command;

use crate::paths;
use crate::sha256;

const COLORS: [u32; 6] = [31, 32, 33, 34, 35, 36];
const NERD_AGENT_GLYPH: &str = "󰚩";
const NERD_TASK_GLYPH: &str = "󰓾";
const CHIEF_FOCUS_TEXT: &str = "Ork Chief — machine-wide master orchestrator";

fn is_live_chief_session(base: &Path, session: &str) -> bool {
    let raw = match fs::read_to_string(base.join("chief.json")) {
        Ok(content) => content,
        Err(_) => return false,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(val) => val,
        Err(_) => return false,
    };
    parsed.get("schema").and_then(|v| v.as_str()) == Some("ork.chief.v1")
        && parsed.get("session").and_then(|v| v.as_str()) == Some(session)
}

fn palette_color(c: u32) -> u32 {
    match c {
        31 => 203,
        32 => 114,
        33 => 221,
        34 => 111,
        35 => 176,
        36 => 80,
        _ => 203,
    }
}

pub fn delegate(fallback_script: &Path, args: &[String], stdin_bytes: &[u8]) -> io::Result<()> {
    let mut forwarded: Vec<&str> = Vec::with_capacity(args.len());
    let mut idx = 0;
    while idx < args.len() {
        let arg = args[idx].as_str();
        if arg == "--fallback-script" {
            idx += 2;
            continue;
        }
        if arg.starts_with("--fallback-script=") {
            idx += 1;
            continue;
        }
        forwarded.push(arg);
        idx += 1;
    }

    let mut child = Command::new("python3")
        .arg("-B")
        .arg(fallback_script)
        .args(&forwarded)
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

fn clean_text(val: &str) -> String {
    let printable: String = val
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let words: Vec<&str> = printable.split_whitespace().collect();
    words.join(" ").chars().take(240).collect()
}

fn strip_trailing_hex(name: &str) -> String {
    if let Some(idx) = name.rfind('-') {
        let suffix = &name[idx + 1..];
        if suffix.len() == 2 && suffix.chars().all(|c| c.is_ascii_hexdigit()) {
            return name[..idx].to_string();
        }
    }
    name.to_string()
}

fn short_display_name(name: &str, person: Option<&str>, repo: Option<&str>) -> String {
    let cleaned_name = clean_text(name);
    let cleaned_person = person.map(clean_text).unwrap_or_default();
    if !cleaned_person.is_empty()
        && (cleaned_name.is_empty()
            || cleaned_name == cleaned_person
            || cleaned_name.starts_with(&format!("{cleaned_person}-")))
    {
        return cleaned_person;
    }
    if cleaned_name.is_empty() {
        return String::new();
    }
    if cleaned_name.contains(':') {
        return strip_trailing_hex(&cleaned_name);
    }
    let cleaned_repo = repo.map(clean_text).unwrap_or_default();
    if !cleaned_repo.is_empty()
        && (cleaned_name == cleaned_repo || cleaned_name.starts_with(&format!("{cleaned_repo}-")))
    {
        return cleaned_repo;
    }
    let parts: Vec<&str> = cleaned_name.split('-').collect();
    if parts.len() >= 4
        && let Some(last) = parts.last()
        && last.len() == 2
        && last.chars().all(|c| c.is_ascii_hexdigit())
    {
        return parts[0].to_string();
    }
    strip_trailing_hex(&cleaned_name)
}

fn normalize_model_and_effort(model: &str, effort: &str) -> (String, String) {
    let mut cleaned_model = clean_text(model);
    let mut cleaned_effort = clean_text(effort);

    const EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

    if !cleaned_model.is_empty() && cleaned_model != "—" {
        let mut inferred = None;
        if let Some(idx) = cleaned_model.rfind(" (") {
            if cleaned_model.ends_with(')') {
                let candidate = &cleaned_model[idx + 2..cleaned_model.len() - 1].to_lowercase();
                if EFFORTS.contains(&candidate.as_str()) {
                    inferred = Some((idx, candidate.clone()));
                }
            }
        } else if let Some(idx) = cleaned_model.rfind(" [") {
            if cleaned_model.ends_with(']') {
                let candidate = &cleaned_model[idx + 2..cleaned_model.len() - 1].to_lowercase();
                if EFFORTS.contains(&candidate.as_str()) {
                    inferred = Some((idx, candidate.clone()));
                }
            }
        } else if let Some(idx) = cleaned_model.rfind('-') {
            let candidate = &cleaned_model[idx + 1..].to_lowercase();
            if EFFORTS.contains(&candidate.as_str()) {
                inferred = Some((idx, candidate.clone()));
            }
        }

        if let Some((idx, inf)) = inferred {
            cleaned_model = cleaned_model[..idx].trim().to_string();
            if cleaned_effort.is_empty() || cleaned_effort == "—" {
                cleaned_effort = inf;
            }
        }
    }

    let final_model = if cleaned_model.is_empty() {
        "—".to_string()
    } else {
        cleaned_model
    };
    let final_effort = if cleaned_effort.is_empty() {
        "—".to_string()
    } else {
        cleaned_effort
    };
    (final_model, final_effort)
}

fn display_width(s: &str) -> usize {
    s.chars().count()
}

fn shorten(s: &str, width: usize) -> String {
    if display_width(s) <= width {
        return s.to_string();
    }
    if width <= 1 {
        return "…".to_string();
    }
    let chars: Vec<char> = s.chars().collect();
    let truncated: String = chars[..width - 1].iter().collect();
    format!("{truncated}…")
}

fn shorten_name(s: &str, width: usize) -> String {
    if display_width(s) <= width {
        return s.to_string();
    }
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 4 || width <= 5 {
        return shorten(s, width);
    }
    let prefix: String = chars[..chars.len() - 4].iter().collect();
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    let prefix_width = width - 4;
    format!("{}{suffix}", shorten(&prefix, prefix_width))
}

fn line_parts(item: &serde_json::Value, mut width: usize, line: u32) -> Vec<(String, String)> {
    let get_str = |key: &str| -> String {
        item.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };

    let (keys, minima_limits, fixed_len): (Vec<&str>, Vec<usize>, usize) = if line == 1 {
        (
            vec!["name", "model", "effort", "repo"],
            vec![12, 5, 3, 4],
            display_width(" |  /  | repo : "),
        )
    } else if line == 2 {
        (
            vec!["stage", "goal", "task"],
            vec![4, 5, 5],
            display_width("stage :  | goal :  | task : "),
        )
    } else {
        (
            vec!["name", "model", "effort", "repo", "stage", "goal", "task"],
            vec![10, 4, 3, 3, 4, 4, 4],
            display_width(" |  /  | repo :  | stage :  | goal :  | task : "),
        )
    };

    let values: Vec<String> = keys.iter().map(|&k| get_str(k)).collect();
    let mut sizes: Vec<usize> = values.iter().map(|v| display_width(v)).collect();
    let minima: Vec<usize> = sizes
        .iter()
        .zip(&minima_limits)
        .map(|(&s, &m)| s.min(m))
        .collect();

    while sizes.iter().sum::<usize>() + fixed_len > width
        && sizes.iter().zip(&minima).any(|(&s, &m)| s > m)
    {
        let mut max_diff = 0;
        let mut best_idx = 0;
        for (i, (&s, &m)) in sizes.iter().zip(&minima).enumerate() {
            if s > m && s - m > max_diff {
                max_diff = s - m;
                best_idx = i;
            }
        }
        if max_diff == 0 {
            break;
        }
        sizes[best_idx] -= 1;
    }

    let mut parts: Vec<(String, String)> = Vec::new();
    if line == 2 {
        let stage = shorten(&values[0], sizes[0]);
        let goal = shorten(&values[1], sizes[1]);
        let task = shorten(&values[2], sizes[2]);
        parts.push(("label".to_string(), "stage : ".to_string()));
        parts.push(("stage".to_string(), stage));
        parts.push(("separator".to_string(), " | ".to_string()));
        parts.push(("label".to_string(), "goal : ".to_string()));
        parts.push(("goal".to_string(), goal));
        parts.push(("separator".to_string(), " | ".to_string()));
        parts.push(("label".to_string(), "task : ".to_string()));
        parts.push(("task".to_string(), task));
    } else {
        let name = shorten_name(&values[0], sizes[0]);
        let model = shorten(&values[1], sizes[1]);
        let effort = shorten(&values[2], sizes[2]);
        let repo = shorten(&values[3], sizes[3]);
        parts.push(("name".to_string(), name));
        parts.push(("separator".to_string(), " | ".to_string()));
        parts.push(("model".to_string(), model));
        parts.push(("separator".to_string(), " / ".to_string()));
        parts.push(("effort".to_string(), effort));
        if line == 1 {
            parts.push(("separator".to_string(), " | ".to_string()));
            parts.push(("label".to_string(), "repo : ".to_string()));
            parts.push(("repo".to_string(), repo));
        } else {
            let stage = shorten(&values[4], sizes[4]);
            let goal = shorten(&values[5], sizes[5]);
            let task = shorten(&values[6], sizes[6]);
            for (key, val) in [
                ("repo", repo),
                ("stage", stage),
                ("goal", goal),
                ("task", task),
            ] {
                parts.push(("separator".to_string(), " | ".to_string()));
                parts.push(("label".to_string(), format!("{key} : ")));
                parts.push((key.to_string(), val));
            }
        }
    }

    let mut fitted = Vec::new();
    for (k, v) in parts {
        if width == 0 {
            break;
        }
        let w = display_width(&v);
        fitted.push((k, shorten(&v, width)));
        width = width.saturating_sub(w);
    }
    fitted
}

fn stage_color(stage: &str, health: &str) -> Option<u32> {
    if health == "missing" || health == "stale" {
        return Some(221);
    }
    match stage {
        "failed" | "rejected" => Some(203),
        "blocked" | "reserved" | "reported" | "completed" | "complete" | "reported complete" => {
            Some(221)
        }
        "accepted" => Some(114),
        "supported" => Some(80),
        "stale" => Some(176),
        "running" | "active" | "claimed" | "review" => Some(117),
        _ => None,
    }
}

const VALID_STAGES: &[&str] = &[
    "planning", "working", "testing", "review", "blocked", "complete",
];
const KNOWN_ROLES: &[&str] = &[
    "planner",
    "scout",
    "researcher",
    "debugger",
    "builder",
    "ui-designer",
    "sweeper",
    "reviewer",
    "verifier",
];

fn current_hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8(buf[..end].to_vec()).ok()
}

fn repository_name(peer: &serde_json::Value) -> String {
    if let Some(repo) = peer
        .get("repository")
        .and_then(|v| v.as_str())
        .map(clean_text)
        .filter(|s| !s.is_empty())
    {
        return repo;
    }
    let raw = peer
        .get("repo")
        .or_else(|| peer.get("checkout"))
        .or_else(|| peer.get("cwd"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if raw.is_empty() {
        return "not set".to_string();
    }
    let path = Path::new(raw);
    let name_os = if path.file_name().is_some_and(|n| n == ".git") {
        path.parent().and_then(|p| p.file_name())
    } else {
        path.file_name()
    };
    let name = name_os
        .and_then(|s| s.to_str())
        .map(clean_text)
        .filter(|s| !s.is_empty());
    name.unwrap_or_else(|| "not set".to_string())
}

enum ProgressRead {
    Valid {
        goal: String,
        task: String,
        stage: String,
        role: Option<String>,
        updated_at: String,
        stale: bool,
        has_work_context: bool,
    },
    UnknownRole,
    MissingOrInvalid,
}

fn read_progress(
    base: &Path,
    s_key: &str,
    peer: &serde_json::Value,
    checkout: &str,
) -> ProgressRead {
    let prog_path = base.join("progress").join(format!("{s_key}.json"));
    let meta = match fs::metadata(&prog_path) {
        Ok(m) if m.is_file() && m.len() <= 8192 => m,
        _ => return ProgressRead::MissingOrInvalid,
    };
    let _ = meta;
    let row: serde_json::Value = match fs::read_to_string(&prog_path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
    {
        Some(v) if v.is_object() => v,
        _ => return ProgressRead::MissingOrInvalid,
    };
    if row.get("schema").and_then(|v| v.as_str()) != Some("orchestrate.progress.v1") {
        return ProgressRead::MissingOrInvalid;
    }
    if row.get("session") != peer.get("session") || row.get("harness") != peer.get("harness") {
        return ProgressRead::MissingOrInvalid;
    }
    let Some(host) = current_hostname() else {
        return ProgressRead::MissingOrInvalid;
    };
    if row.get("machine").and_then(|v| v.as_str()) != Some(host.as_str()) {
        return ProgressRead::MissingOrInvalid;
    }
    let row_acct = row.get("accountHome").filter(|v| !v.is_null());
    let peer_acct = peer.get("accountHome").filter(|v| !v.is_null());
    if row_acct != peer_acct {
        return ProgressRead::MissingOrInvalid;
    }
    if row.get("checkout").and_then(|v| v.as_str()) != Some(checkout) {
        return ProgressRead::MissingOrInvalid;
    }
    let Some(stage) = row.get("stage").and_then(|v| v.as_str()) else {
        return ProgressRead::MissingOrInvalid;
    };
    if !VALID_STAGES.contains(&stage) {
        return ProgressRead::MissingOrInvalid;
    }
    let role = match row.get("role") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(r)) => {
            if KNOWN_ROLES.contains(&r.as_str()) {
                Some(r.clone())
            } else {
                return ProgressRead::UnknownRole;
            }
        }
        _ => return ProgressRead::MissingOrInvalid,
    };
    let Some(updated_at) = row.get("updatedAt").and_then(|v| v.as_str()) else {
        return ProgressRead::MissingOrInvalid;
    };
    let Some(updated_secs) = paths::parse_iso8601_utc_secs(updated_at) else {
        return ProgressRead::MissingOrInvalid;
    };
    let age = paths::utc_now_secs() - updated_secs;
    if age < -300 {
        return ProgressRead::MissingOrInvalid;
    }
    let Some(raw_goal) = row.get("goal").and_then(|v| v.as_str()) else {
        return ProgressRead::MissingOrInvalid;
    };
    let Some(raw_task) = row.get("task").and_then(|v| v.as_str()) else {
        return ProgressRead::MissingOrInvalid;
    };
    if raw_goal.trim().is_empty()
        || raw_goal.chars().count() > 160
        || raw_task.trim().is_empty()
        || raw_task.chars().count() > 160
    {
        return ProgressRead::MissingOrInvalid;
    }
    let stale = stage != "complete" && age > 1800;
    let has_work_context = row.get("workContext").is_some_and(|v| !v.is_null());
    ProgressRead::Valid {
        goal: clean_text(raw_goal),
        task: clean_text(raw_task),
        stage: stage.to_string(),
        role,
        updated_at: updated_at.to_string(),
        stale,
        has_work_context,
    }
}

pub fn run(args: &[String], fallback_script: Option<&Path>) -> io::Result<()> {
    let mut session_opt: Option<String> = None;
    let mut harness_opt: Option<String> = None;
    let mut width_opt: Option<usize> = None;
    let mut line_opt: u32 = 0;
    let mut json_opt = false;
    let mut plain_opt = false;
    let mut tmux_opt = false;
    let mut no_color_opt = env::var("NO_COLOR").is_ok_and(|v| !v.is_empty());
    let mut terminal_pane_opt: Option<String> = None;
    let mut tmux_server_opt: Option<String> = None;

    let mut raw_stdin = Vec::new();
    let mut idx = 0;

    while idx < args.len() {
        let arg = &args[idx];
        match arg.as_str() {
            "--native-status" | "--refresh-terminal" | "--clear-terminal" | "--codex-pane"
            | "--pane-pid" => {
                if let Some(fb) = fallback_script {
                    io::stdin().read_to_end(&mut raw_stdin)?;
                    return delegate(fb, args, &raw_stdin);
                }
            }
            "--session" => {
                if idx + 1 < args.len() {
                    session_opt = Some(args[idx + 1].clone());
                    idx += 1;
                }
            }
            "--harness" => {
                if idx + 1 < args.len() {
                    harness_opt = Some(args[idx + 1].clone());
                    idx += 1;
                }
            }
            "--width" => {
                if idx + 1 < args.len() {
                    width_opt = args[idx + 1].parse().ok();
                    idx += 1;
                }
            }
            "--line" => {
                if idx + 1 < args.len() {
                    line_opt = args[idx + 1].parse().unwrap_or(0);
                    idx += 1;
                }
            }
            "--terminal-pane" => {
                if idx + 1 < args.len() {
                    terminal_pane_opt = Some(args[idx + 1].clone());
                    idx += 1;
                }
            }
            "--tmux-server" => {
                if idx + 1 < args.len() {
                    tmux_server_opt = Some(args[idx + 1].clone());
                    idx += 1;
                }
            }
            "--codex-home" => {
                if idx + 1 < args.len() {
                    idx += 1;
                }
            }
            "--json" => json_opt = true,
            "--plain" => plain_opt = true,
            "--tmux" => tmux_opt = true,
            "--no-color" => no_color_opt = true,
            "--fallback-script" => {
                if idx + 1 < args.len() {
                    idx += 1;
                }
            }
            _ => {
                if let Some(fb) = fallback_script {
                    io::stdin().read_to_end(&mut raw_stdin)?;
                    return delegate(fb, args, &raw_stdin);
                }
            }
        }
        idx += 1;
    }

    if harness_opt.as_deref() == Some("codex")
        && session_opt.is_none()
        && let Some(fb) = fallback_script
    {
        io::stdin().read_to_end(&mut raw_stdin)?;
        return delegate(fb, args, &raw_stdin);
    }

    let mut payload = serde_json::Value::Null;
    if session_opt.is_none() {
        if terminal_pane_opt.is_some() && tmux_server_opt.is_some() {
            if let Some(fb) = fallback_script {
                io::stdin().read_to_end(&mut raw_stdin)?;
                return delegate(fb, args, &raw_stdin);
            }
        } else {
            io::stdin().read_to_end(&mut raw_stdin)?;
            if !raw_stdin.is_empty()
                && let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw_stdin)
            {
                session_opt = v
                    .get("session_id")
                    .or_else(|| v.get("conversation_id"))
                    .or_else(|| v.get("conversationId"))
                    .and_then(|s| s.as_str())
                    .map(String::from);
                payload = v;
            }
        }
    }

    let emit_tmux_waiting = |line: u32| {
        if terminal_pane_opt.is_some() {
            if line == 2 {
                println!(
                    "#[align=left,nobold]Orkest: task and progress appear after the session registers"
                );
            } else {
                println!(
                    "#[align=left,bold]Orkest: agent identity appears after the session registers"
                );
            }
        } else {
            println!("Orkest: waiting for agent");
        }
    };

    let session = match session_opt {
        Some(s) if !s.is_empty() => s,
        _ => {
            if tmux_opt {
                emit_tmux_waiting(line_opt);
            }
            return Ok(());
        }
    };

    let base = paths::cache_home(None, None).join("mailbox-v1");
    let p_path = match paths::peer_path(&base, &session) {
        Ok(p) => p,
        Err(_) => {
            if tmux_opt {
                emit_tmux_waiting(line_opt);
            }
            return Ok(());
        }
    };

    let peer: serde_json::Value = match fs::read_to_string(&p_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
    {
        Some(p) => p,
        None => {
            if tmux_opt {
                emit_tmux_waiting(line_opt);
            }
            return Ok(());
        }
    };

    if !paths::valid_peer(&peer) {
        if tmux_opt {
            emit_tmux_waiting(line_opt);
        }
        return Ok(());
    }

    if let Some(ref expected_harness) = harness_opt
        && peer.get("harness").and_then(|v| v.as_str()) != Some(expected_harness.as_str())
    {
        if let Some(fb) = fallback_script {
            return delegate(fb, args, &raw_stdin);
        }
        if tmux_opt {
            emit_tmux_waiting(line_opt);
        }
        return Ok(());
    }

    let name = peer.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if name.is_empty() || name.chars().any(|c| c.is_control()) {
        if tmux_opt {
            emit_tmux_waiting(line_opt);
        }
        return Ok(());
    }

    let s_key = match paths::session_key(&session) {
        Ok(k) => k,
        Err(_) => return Ok(()),
    };

    let repo = repository_name(&peer);
    let raw_checkout = peer
        .get("checkout")
        .or_else(|| peer.get("cwd"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let checkout = if raw_checkout.is_empty() {
        String::new()
    } else {
        paths::resolve_path(Path::new(raw_checkout))
            .unwrap_or_else(|_| Path::new(raw_checkout).to_path_buf())
            .to_string_lossy()
            .into_owned()
    };

    let progress_res = read_progress(&base, &s_key, &peer, &checkout);
    if matches!(progress_res, ProgressRead::UnknownRole)
        && let Some(fb) = fallback_script
    {
        return delegate(fb, args, &raw_stdin);
    }

    // Room or workboard contexts can override goal/task/role; delegate when active.
    if let Some(fb) = fallback_script {
        let needs_room_or_work = match &progress_res {
            ProgressRead::Valid {
                has_work_context, ..
            } => *has_work_context || paths::has_active_room_for_session(&base, &session),
            ProgressRead::MissingOrInvalid | ProgressRead::UnknownRole => {
                paths::has_active_room_for_session(&base, &session)
            }
        };
        if needs_room_or_work {
            return delegate(fb, args, &raw_stdin);
        }
    }

    let (role, goal, task, stage, health, reported_at) = match progress_res {
        ProgressRead::Valid {
            goal,
            task,
            stage,
            role,
            updated_at,
            stale,
            ..
        } => {
            if stale {
                let st = if stage.is_empty() {
                    "not set (stale)".to_string()
                } else {
                    format!("{stage} (stale)")
                };
                (
                    role,
                    goal,
                    task,
                    st,
                    "stale",
                    serde_json::Value::String(updated_at),
                )
            } else {
                (
                    role,
                    goal,
                    task,
                    stage,
                    "fresh",
                    serde_json::Value::String(updated_at),
                )
            }
        }
        ProgressRead::UnknownRole | ProgressRead::MissingOrInvalid => {
            let mut focus = peer
                .get("focus")
                .and_then(|v| v.as_str())
                .map(clean_text)
                .unwrap_or_default();
            if focus == CHIEF_FOCUS_TEXT && !is_live_chief_session(&base, &session) {
                focus.clear();
            }
            (
                None,
                "not set".to_string(),
                if focus.is_empty() {
                    "not set".to_string()
                } else {
                    focus
                },
                "not set".to_string(),
                "missing",
                serde_json::Value::Null,
            )
        }
    };

    let model_val = payload.get("model");
    let mut payload_model = model_val
        .and_then(|m| {
            if m.is_string() {
                m.as_str()
            } else {
                m.get("id")
                    .or_else(|| m.get("display_name"))
                    .and_then(|v| v.as_str())
            }
        })
        .map(clean_text)
        .unwrap_or_default();
    if payload_model.eq_ignore_ascii_case("auto") {
        payload_model.clear();
    }
    let raw_model = if !payload_model.is_empty() {
        payload_model
    } else {
        peer.get("stepModel")
            .and_then(|v| v.as_str())
            .map(clean_text)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                peer.get("executionModel")
                    .and_then(|v| v.as_str())
                    .map(clean_text)
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                peer.get("sessionModel")
                    .and_then(|v| v.as_str())
                    .map(clean_text)
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                peer.get("model")
                    .and_then(|v| v.as_str())
                    .map(clean_text)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| "—".to_string())
    };

    let payload_effort = payload
        .get("effort")
        .and_then(|e| {
            if e.is_string() {
                e.as_str()
            } else {
                e.get("level").and_then(|v| v.as_str())
            }
        })
        .map(clean_text)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            model_val
                .and_then(|m| m.get("effort"))
                .and_then(|v| v.as_str())
                .map(clean_text)
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            payload
                .get("effortLevel")
                .or_else(|| payload.get("reasoning_effort"))
                .and_then(|v| v.as_str())
                .map(clean_text)
                .filter(|s| !s.is_empty())
        });
    let raw_effort = payload_effort
        .or_else(|| {
            peer.get("effort")
                .and_then(|v| v.as_str())
                .map(clean_text)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "—".to_string());

    let (model, effort) = normalize_model_and_effort(&raw_model, &raw_effort);

    let digest = sha256::sha256_digest(session.as_bytes());
    let color_idx = (digest[0] as usize) % COLORS.len();
    let color_num = COLORS[color_idx];

    let person = peer.get("person").and_then(|v| v.as_str());
    let display_name = short_display_name(name, person, Some(&repo));

    let mut item_obj = serde_json::json!({
        "name": display_name,
        "fullName": name,
        "color": color_num,
        "model": model,
        "effort": effort,
        "repo": repo,
        "repository": repo,
        "cwd": checkout,
        "goal": goal,
        "task": task,
        "stage": stage,
        "statusHealth": health,
        "reportedAt": reported_at,
    });
    if let Some(r) = role {
        item_obj["role"] = serde_json::Value::String(r);
    }

    let payload_width = payload
        .get("terminal_width")
        .and_then(|v| v.as_u64())
        .and_then(|n| usize::try_from(n).ok())
        .filter(|&w| w > 0);
    let width = width_opt.filter(|&w| w > 0).or(payload_width).unwrap_or(80);
    let clamped_width = width.clamp(32, 1000);
    let parts = line_parts(&item_obj, clamped_width, line_opt);

    let label = parts.first().map(|p| p.1.clone()).unwrap_or_default();
    let details: String = parts[1..].iter().map(|p| p.1.as_str()).collect();

    if json_opt {
        item_obj["label"] = serde_json::Value::String(label);
        item_obj["details"] = serde_json::Value::String(details);
        println!("{item_obj}");
    } else if tmux_opt {
        let nerd = env::var("ORK_GLYPHS").map_or(true, |v| v.trim().to_lowercase() == "nerd");
        let colored = !no_color_opt;
        let bg = palette_color(color_num);
        let pad_width = if nerd && colored { 7 } else { 6 };
        let swatch = if nerd && colored {
            if line_opt != 2 {
                format!(
                    "#[bg=colour{bg},fg=colour232,bold] {NERD_AGENT_GLYPH} #[bg=default,fg=default] "
                )
            } else {
                format!("#[fg=colour{bg}] {NERD_TASK_GLYPH} #[fg=default] ")
            }
        } else if colored && line_opt != 2 {
            format!("#[bg=colour{bg}]  #[bg=default] ")
        } else {
            "   ".to_string()
        };

        let mut out = format!("#[align=left,bg=default,fg=default]{swatch}");
        let inner_parts = line_parts(&item_obj, clamped_width.saturating_sub(pad_width), line_opt);
        for (k, v) in inner_parts {
            let bold = matches!(
                k.as_str(),
                "name" | "model" | "effort" | "repo" | "stage" | "task"
            );
            let weight = if bold { "bold" } else { "nobold" };
            let color = match k.as_str() {
                "name" => Some(bg),
                "model" => Some(117),
                "effort" => Some(180),
                "separator" => Some(245),
                "stage" => stage_color(&stage, health),
                _ => None,
            };
            let style = if colored {
                if let Some(col) = color {
                    format!("fg=colour{col},{weight}")
                } else {
                    format!("fg=default,{weight}")
                }
            } else {
                weight.to_string()
            };
            let escaped = v.replace('#', "##");
            out.push_str(&format!("#[{style}]{escaped}"));
        }
        out.push_str("#[fg=default,nobold]   ");
        println!("{out}");
    } else if plain_opt || no_color_opt {
        println!("{label}{details}");
    } else {
        let nerd = env::var("ORK_GLYPHS").map_or(true, |v| v.trim().to_lowercase() == "nerd");
        let bg = palette_color(color_num);
        let swatch = if nerd {
            if line_opt != 2 {
                format!("\x1b[0m\x1b[48;5;{bg};38;5;232;1m {NERD_AGENT_GLYPH} \x1b[0m ")
            } else {
                format!("\x1b[0m\x1b[38;5;{bg}m {NERD_TASK_GLYPH} \x1b[0m ")
            }
        } else if line_opt != 2 {
            format!("\x1b[0m\x1b[48;5;{bg}m  \x1b[0m ")
        } else {
            "\x1b[0m   ".to_string()
        };

        let pad_width = if nerd { 7 } else { 6 };
        let inner_parts = line_parts(&item_obj, clamped_width.saturating_sub(pad_width), line_opt);
        let mut out = swatch;
        for (k, v) in inner_parts {
            let bold = matches!(
                k.as_str(),
                "name" | "model" | "effort" | "repo" | "stage" | "task"
            );
            let weight = if bold { "1" } else { "22" };
            let color = match k.as_str() {
                "name" => Some(bg),
                "model" => Some(117),
                "effort" => Some(180),
                "separator" => Some(245),
                "stage" => stage_color(&stage, health),
                _ => None,
            };
            let fg = color.map_or("39".to_string(), |c| format!("38;5;{c}"));
            out.push_str(&format!("\x1b[{fg};{weight}m{v}\x1b[0m"));
        }
        println!("{out}");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn live_chief_session_requires_matching_schema_and_session() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("ork-fast-statusline-test-{nanos}"));
        fs::create_dir_all(&dir).unwrap();

        assert!(!is_live_chief_session(&dir, "session-1"));

        fs::write(
            dir.join("chief.json"),
            r#"{"schema":"ork.chief.v1","session":"other"}"#,
        )
        .unwrap();
        assert!(!is_live_chief_session(&dir, "session-1"));

        fs::write(
            dir.join("chief.json"),
            r#"{"schema":"wrong.v1","session":"session-1"}"#,
        )
        .unwrap();
        assert!(!is_live_chief_session(&dir, "session-1"));

        fs::write(
            dir.join("chief.json"),
            r#"{"schema":"ork.chief.v1","session":"session-1"}"#,
        )
        .unwrap();
        assert!(is_live_chief_session(&dir, "session-1"));

        let _ = fs::remove_dir_all(&dir);
    }
}
