//! Native statusline renderer replacing `agent_statusline.py`.

use std::collections::HashSet;
use std::env;
use std::ffi::CString;
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

use crate::identity;
use crate::paths;
use crate::rooms_work;
use crate::sha256;
use crate::sqlite;
use crate::terminal;

const COLORS: [u32; 6] = [31, 32, 33, 34, 35, 36];
const NERD_AGENT_GLYPH: &str = "󰚩";
const NERD_TASK_GLYPH: &str = "󰓾";
const CHIEF_FOCUS_TEXT: &str = "Ork Chief — machine-wide master orchestrator";

fn is_live_chief_session(base: &Path, session: &str) -> bool {
    let Some(parsed) = paths::read_json_file(&base.join("chief.json")) else {
        return false;
    };
    parsed.get("schema").and_then(Value::as_str) == Some("ork.chief.v1")
        && parsed.get("session").and_then(Value::as_str) == Some(session)
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

fn clean_text(val: &str) -> String {
    paths::clean_text(val, 240)
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
                let candidate = cleaned_model[idx + 2..cleaned_model.len() - 1].to_lowercase();
                if !cleaned_model[..idx].trim().is_empty() && EFFORTS.contains(&candidate.as_str())
                {
                    inferred = Some((idx, candidate));
                }
            }
        } else if let Some(idx) = cleaned_model.rfind(" [") {
            if cleaned_model.ends_with(']') {
                let candidate = cleaned_model[idx + 2..cleaned_model.len() - 1].to_lowercase();
                if !cleaned_model[..idx].trim().is_empty() && EFFORTS.contains(&candidate.as_str())
                {
                    inferred = Some((idx, candidate));
                }
            }
        } else if let Some(idx) = cleaned_model.rfind('-') {
            let candidate = cleaned_model[idx + 1..].to_lowercase();
            if !cleaned_model[..idx].trim().is_empty() && EFFORTS.contains(&candidate.as_str()) {
                inferred = Some((idx, candidate));
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

fn char_display_width(c: char) -> usize {
    let cp = c as u32;
    if matches!(
        cp,
        0x0300..=0x036F
            | 0x0483..=0x0489
            | 0x0591..=0x05BD
            | 0x05BF
            | 0x05C1..=0x05C2
            | 0x05C4..=0x05C5
            | 0x05C7
            | 0x0610..=0x061A
            | 0x064B..=0x065F
            | 0x0670
            | 0x06D6..=0x06DC
            | 0x06DF..=0x06E4
            | 0x06E7..=0x06E8
            | 0x06EA..=0x06ED
            | 0x1AB0..=0x1AFF
            | 0x1DC0..=0x1DFF
            | 0x20D0..=0x20FF
            | 0xFE00..=0xFE0F
            | 0xFE20..=0xFE2F
            | 0xE0100..=0xE01EF
    ) {
        0
    } else if matches!(
        cp,
        0x1100..=0x115F
            | 0x2329..=0x232A
            | 0x2E80..=0x303E
            | 0x3040..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE19
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x1F300..=0x1F64F
            | 0x1F900..=0x1F9FF
            | 0x20000..=0x2FFFD
            | 0x30000..=0x3FFFD
    ) && cp != 0x303F
    {
        2
    } else {
        1
    }
}

fn display_width(s: &str) -> usize {
    s.chars().map(char_display_width).sum()
}

fn shorten(s: &str, width: usize) -> String {
    if display_width(s) <= width {
        return s.to_string();
    }
    let limit = width.saturating_sub(1);
    let mut result = String::new();
    let mut cur_w = 0;
    for ch in s.chars() {
        let cw = char_display_width(ch);
        if cur_w + cw > limit {
            break;
        }
        result.push(ch);
        cur_w += cw;
    }
    result.push('…');
    result
}

fn shorten_name(s: &str, width: usize) -> String {
    if display_width(s) <= width {
        return s.to_string();
    }
    let chars: Vec<char> = s.chars().collect();
    let suffix: String = if chars.len() <= 4 {
        chars.iter().collect()
    } else {
        chars[chars.len() - 4..].iter().collect()
    };
    let sw = display_width(&suffix);
    if sw >= width.saturating_sub(1) {
        return shorten(s, width);
    }
    format!("{}{suffix}", shorten(s, width - sw))
}

fn line_parts(item: &Value, mut width: usize, line: u32) -> Vec<(String, String)> {
    let get_str = |key: &str| -> String {
        item.get(key)
            .and_then(Value::as_str)
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

fn tty_columns_fd(fd: libc::c_int) -> Option<usize> {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) };
    if rc == 0 && ws.ws_col > 0 {
        Some(usize::from(ws.ws_col))
    } else {
        None
    }
}

fn parent_tty_columns() -> Option<usize> {
    let mut pid = i64::from(unsafe { libc::getppid() });
    let mut seen = HashSet::new();
    while pid > 1 && seen.len() < 8 && seen.insert(pid) {
        let pid_str = pid.to_string();
        let mut cmd = Command::new("ps");
        cmd.args(["-o", "ppid=,tty=", "-p", &pid_str])
            .stdin(std::process::Stdio::null());
        let out = paths::run_output_with_timeout(&mut cmd, Duration::from_millis(500))?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut parts = text.split_whitespace();
        let ppid_str = parts.next()?;
        let tty = parts.next()?;
        let Ok(ppid) = ppid_str.parse::<i64>() else {
            return None;
        };
        if !tty.is_empty() && tty != "??" {
            let dev_path = if tty.starts_with("/dev/") {
                tty.to_string()
            } else {
                format!("/dev/{tty}")
            };
            if let Ok(c_path) = CString::new(Path::new(&dev_path).as_os_str().as_bytes()) {
                let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_RDONLY | libc::O_NOCTTY) };
                if fd >= 0 {
                    let cols = tty_columns_fd(fd);
                    unsafe { libc::close(fd) };
                    if let Some(c) = cols {
                        return Some(c.saturating_sub(2).max(32));
                    }
                }
            }
        }
        pid = ppid;
    }
    None
}

fn resolve_terminal_columns(width_opt: Option<usize>, payload: &Value) -> usize {
    if let Some(w) = width_opt.filter(|&w| w > 0) {
        return w;
    }
    if let Some(pw) = payload
        .get("terminal_width")
        .and_then(|v| if v.is_boolean() { None } else { v.as_u64() })
        .and_then(|n| usize::try_from(n).ok())
        .filter(|&w| w > 0)
    {
        return pw;
    }
    if unsafe { libc::isatty(libc::STDOUT_FILENO) } == 0 {
        if let Some(cols) = parent_tty_columns() {
            return cols;
        }
    } else if let Some(cols) = tty_columns_fd(libc::STDOUT_FILENO) {
        return cols;
    }
    if let Ok(cols_env) = env::var("COLUMNS")
        && let Ok(c) = cols_env.trim().parse::<usize>()
        && c > 0
    {
        return c;
    }
    80
}

fn identity_item(
    base: &Path,
    session: &str,
    harness_opt: Option<&str>,
    payload: &Value,
) -> Option<Value> {
    let payload_cwd = payload.get("cwd").and_then(Value::as_str);
    let peer = identity::session_peer(base, session, harness_opt, payload_cwd, true)?;
    if !paths::valid_peer(&peer) {
        return None;
    }
    let name = peer.get("name").and_then(Value::as_str).unwrap_or("");
    if name.is_empty() || name.chars().any(|c| c.is_control()) {
        return None;
    }

    let model_input = payload.get("model");
    let mut model = match model_input {
        Some(Value::Object(m)) => m
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| m.get("display_name").and_then(Value::as_str))
            .map(clean_text)
            .unwrap_or_default(),
        Some(Value::String(s)) => clean_text(s),
        _ => String::new(),
    };
    if model.eq_ignore_ascii_case("auto") {
        model.clear();
    }

    let mut effort = match payload.get("effort") {
        Some(Value::Object(e)) => e
            .get("level")
            .and_then(Value::as_str)
            .map(clean_text)
            .unwrap_or_default(),
        Some(Value::String(s)) => clean_text(s),
        _ => String::new(),
    };
    if effort.is_empty()
        && let Some(Value::Object(m)) = model_input
    {
        effort = m
            .get("effort")
            .and_then(Value::as_str)
            .map(clean_text)
            .unwrap_or_default();
    }
    if effort.is_empty() {
        effort = payload
            .get("effortLevel")
            .or_else(|| payload.get("reasoning_effort"))
            .and_then(Value::as_str)
            .map(clean_text)
            .unwrap_or_default();
    }

    let (recorded_model, recorded_effort) = if peer.get("harness").and_then(Value::as_str)
        == Some("codex")
        && let Some(acct) = peer.get("accountHome").and_then(Value::as_str)
        && Path::new(acct).is_absolute()
    {
        let peer_session = peer
            .get("session")
            .and_then(Value::as_str)
            .unwrap_or(session);
        sqlite::codex_thread_settings_unique(Path::new(acct), peer_session)
    } else {
        (String::new(), String::new())
    };

    let mut progress = rooms_work::read_progress(base, &peer);
    let rooms = rooms_work::bound_rooms(base, &peer);
    let mut goal = if rooms.len() > 1 {
        "multiple rooms".to_string()
    } else if rooms.len() == 1 {
        let room = &rooms[0].0;
        let title = room.get("title").and_then(Value::as_str);
        let id = room.get("id").and_then(Value::as_str);
        if title.is_some() && title != id {
            clean_text(title.unwrap_or(""))
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let mut assignments = rooms_work::workboard_assigned(base, &peer);
    let wc = rooms_work::work_context(&assignments);
    if let Some(ref p) = progress
        && p.work_context != wc
    {
        progress = None;
    }
    for (room, member) in &rooms {
        if let Some(ct) = rooms_work::room_task(room, member) {
            assignments.push(rooms_work::WorkAssignment {
                id: String::new(),
                title: ct.title,
                state: ct.state,
            });
        }
    }
    if !assignments.is_empty()
        && let Some(ref p) = progress
        && !assignments.iter().any(|a| clean_text(&a.title) == p.task)
    {
        progress = None;
    }

    let mut manual = false;
    if goal.is_empty()
        && let Some(ref p) = progress
    {
        goal = clean_text(&p.goal);
        manual = true;
    }

    let (mut task, mut stage) = if assignments.len() > 1 {
        ("multiple tasks".to_string(), "varies".to_string())
    } else if assignments.len() == 1 {
        let t = clean_text(&assignments[0].title);
        let mut s = clean_text(&assignments[0].state);
        if let Some(ref p) = progress
            && s == "claimed"
            && matches!(p.stage.as_str(), "planning" | "working" | "testing")
        {
            s = p.stage.clone();
            manual = true;
        }
        (t, s)
    } else if let Some(ref p) = progress {
        manual = true;
        (clean_text(&p.task), p.stage.clone())
    } else {
        let mut focus = peer
            .get("focus")
            .and_then(Value::as_str)
            .map(clean_text)
            .unwrap_or_default();
        if focus == CHIEF_FOCUS_TEXT && !is_live_chief_session(base, session) {
            focus.clear();
        }
        let note_stage =
            rooms_work::legacy_task_note_stage(base, &peer, session, &focus).unwrap_or_default();
        (focus, note_stage)
    };

    let mut health = if goal.is_empty() || task.is_empty() || stage.is_empty() {
        "missing"
    } else {
        "fresh"
    };
    if manual
        && let Some(ref p) = progress
        && p.stale
    {
        health = "stale";
        let prefix = if stage.is_empty() { "not set" } else { &stage };
        stage = format!("{prefix} (stale)");
    }

    if goal.is_empty() {
        goal = "not set".to_string();
    }
    if task.is_empty() {
        task = "not set".to_string();
    }
    if stage.is_empty() {
        stage = "not set".to_string();
    }

    let repo_raw = peer
        .get("repository")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(clean_text)
        .unwrap_or_else(|| clean_text(&identity::repository_name(&peer)));
    let repo = if repo_raw.is_empty() {
        "not set".to_string()
    } else {
        repo_raw
    };

    let raw_checkout = peer
        .get("checkout")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| peer.get("cwd").and_then(Value::as_str))
        .unwrap_or("");
    let checkout = if raw_checkout.is_empty() {
        String::new()
    } else {
        paths::resolve_path(Path::new(raw_checkout))
            .unwrap_or_else(|_| Path::new(raw_checkout).to_path_buf())
            .to_string_lossy()
            .into_owned()
    };

    let role = progress.as_ref().and_then(|p| p.role.clone()).or_else(|| {
        if rooms.len() == 1 {
            rooms[0]
                .1
                .get("workforceRole")
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            None
        }
    });

    let raw_model = if !model.is_empty() {
        model
    } else if !recorded_model.is_empty() {
        recorded_model
    } else {
        peer.get("stepModel")
            .and_then(Value::as_str)
            .map(clean_text)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                peer.get("executionModel")
                    .and_then(Value::as_str)
                    .map(clean_text)
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                peer.get("sessionModel")
                    .and_then(Value::as_str)
                    .map(clean_text)
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                peer.get("model")
                    .and_then(Value::as_str)
                    .map(clean_text)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| "—".to_string())
    };

    let raw_effort = if !effort.is_empty() {
        effort
    } else if !recorded_effort.is_empty() {
        recorded_effort
    } else {
        peer.get("effort")
            .and_then(Value::as_str)
            .map(clean_text)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "—".to_string())
    };

    let (norm_model, norm_effort) = normalize_model_and_effort(&raw_model, &raw_effort);
    let digest = sha256::sha256_digest(session.as_bytes());
    let color_num = COLORS[(digest[0] as usize) % COLORS.len()];
    let display_name = short_display_name(
        name,
        peer.get("person").and_then(Value::as_str),
        Some(&repo),
    );
    let reported_at = progress
        .as_ref()
        .map_or(Value::Null, |p| Value::String(p.updated_at.clone()));

    let mut obj = json!({
        "name": display_name,
        "fullName": name,
        "color": color_num,
        "model": norm_model,
        "effort": norm_effort,
        "repo": repo,
        "repository": repo,
        "cwd": checkout,
        "goal": goal,
        "task": task,
        "stage": stage,
        "statusHealth": health,
        "reportedAt": reported_at,
    });
    if let Some(r) = role
        && let Some(m) = obj.as_object_mut()
    {
        m.insert("role".to_string(), Value::String(r));
    }
    Some(obj)
}

fn cli_error(msg: &str) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(2);
}

fn next_arg_value<'a>(args: &'a [String], idx: &mut usize, flag: &str) -> &'a str {
    if *idx + 1 >= args.len() {
        cli_error(&format!("argument {flag}: expected one argument"));
    }
    *idx += 1;
    args[*idx].as_str()
}

pub fn run(args: &[String], fallback_script: Option<&Path>) -> io::Result<()> {
    let _ = fallback_script;
    let mut session_opt: Option<String> = None;
    let mut pane_pid_opt: Option<i64> = None;
    let mut codex_pane_opt: Option<String> = None;
    let mut terminal_pane_opt: Option<String> = None;
    let mut clear_terminal_opt: Option<String> = None;
    let mut tmux_server_opt: Option<String> = None;
    let mut codex_home_opt: Option<String> = None;
    let mut harness_opt: Option<String> = None;
    let mut native_status_opt = false;
    let mut refresh_terminal_opt = false;
    let mut width_opt: Option<usize> = None;
    let mut line_opt: u32 = 0;
    let mut json_opt = false;
    let mut plain_opt = false;
    let mut tmux_opt = false;
    let no_color_opt = env::var("NO_COLOR").is_ok_and(|v| !v.is_empty());

    let mut source_count = 0u32;
    let mut output_count = 0u32;
    let mut idx = 0;
    while idx < args.len() {
        let arg = args[idx].as_str();
        let (flag, inline_val) = if let Some((f, v)) = arg.split_once('=') {
            (f, Some(v))
        } else {
            (arg, None)
        };
        let take_val = |i: &mut usize| -> String {
            if let Some(v) = inline_val {
                v.to_string()
            } else {
                next_arg_value(args, i, flag).to_string()
            }
        };
        match flag {
            "--session" => {
                source_count += 1;
                session_opt = Some(take_val(&mut idx));
            }
            "--pane-pid" => {
                source_count += 1;
                let raw = take_val(&mut idx);
                let parsed: i64 = raw
                    .parse()
                    .unwrap_or_else(|_| cli_error("--pane-pid: invalid int value"));
                pane_pid_opt = Some(parsed);
            }
            "--codex-pane" => {
                source_count += 1;
                codex_pane_opt = Some(take_val(&mut idx));
            }
            "--terminal-pane" => {
                source_count += 1;
                terminal_pane_opt = Some(take_val(&mut idx));
            }
            "--clear-terminal" => {
                source_count += 1;
                clear_terminal_opt = Some(take_val(&mut idx));
            }
            "--tmux-server" => {
                tmux_server_opt = Some(take_val(&mut idx));
            }
            "--codex-home" => {
                codex_home_opt = Some(take_val(&mut idx));
            }
            "--harness" => {
                let val = take_val(&mut idx);
                if !matches!(val.as_str(), "claude" | "codex" | "gemini" | "opencode") {
                    cli_error(&format!(
                        "--harness: invalid choice '{val}' (choose from claude, codex, gemini, opencode)"
                    ));
                }
                harness_opt = Some(val);
            }
            "--width" => {
                let raw = take_val(&mut idx);
                let parsed: usize = raw
                    .parse()
                    .unwrap_or_else(|_| cli_error("--width: invalid int value"));
                width_opt = Some(parsed);
            }
            "--line" => {
                let raw = take_val(&mut idx);
                let parsed: u32 = raw
                    .parse()
                    .unwrap_or_else(|_| cli_error("--line: invalid int value"));
                if !matches!(parsed, 1 | 2) {
                    cli_error("--line: invalid choice (choose from 1, 2)");
                }
                line_opt = parsed;
            }
            "--native-status" => {
                if inline_val.is_some() {
                    cli_error("--native-status does not take a value");
                }
                native_status_opt = true;
            }
            "--refresh-terminal" => {
                if inline_val.is_some() {
                    cli_error("--refresh-terminal does not take a value");
                }
                refresh_terminal_opt = true;
            }
            "--json" => {
                if inline_val.is_some() {
                    cli_error("--json does not take a value");
                }
                output_count += 1;
                json_opt = true;
            }
            "--plain" => {
                if inline_val.is_some() {
                    cli_error("--plain does not take a value");
                }
                output_count += 1;
                plain_opt = true;
            }
            "--tmux" => {
                if inline_val.is_some() {
                    cli_error("--tmux does not take a value");
                }
                output_count += 1;
                tmux_opt = true;
            }
            "--fallback-script" => {
                let _ = take_val(&mut idx);
            }
            other => cli_error(&format!("unrecognized argument: {other}")),
        }
        idx += 1;
    }

    if source_count > 1 {
        cli_error(
            "--session, --pane-pid, --codex-pane, --terminal-pane, and --clear-terminal are mutually exclusive",
        );
    }
    if output_count > 1 {
        cli_error("--json, --plain, and --tmux are mutually exclusive");
    }
    if refresh_terminal_opt && !native_status_opt {
        cli_error("--refresh-terminal requires --native-status");
    }
    if let Some(ref sid) = clear_terminal_opt {
        terminal::clear_terminal(sid, harness_opt.as_deref());
        return Ok(());
    }
    if pane_pid_opt.is_some() && harness_opt.is_none() {
        cli_error("--pane-pid requires --harness");
    }
    if codex_pane_opt.is_some()
        && (tmux_server_opt.is_none()
            || codex_home_opt.is_none()
            || harness_opt.as_deref() != Some("codex"))
    {
        cli_error("--codex-pane requires --tmux-server, --codex-home and --harness codex");
    }
    if terminal_pane_opt.is_some() && (tmux_server_opt.is_none() || harness_opt.is_none()) {
        cli_error("--terminal-pane requires --tmux-server and --harness");
    }

    let base = paths::cache_home(None, None).join("mailbox-v1");
    let mut payload = Value::Object(serde_json::Map::new());
    let mut session = if let Some(pid) = pane_pid_opt {
        harness_opt
            .as_deref()
            .and_then(|h| terminal::pane_session(&base, pid, h))
    } else {
        session_opt
    };

    if let Some(ref pane) = codex_pane_opt {
        session = terminal::codex_pane_session(
            &base,
            pane,
            tmux_server_opt.as_deref().unwrap_or(""),
            codex_home_opt.as_deref().unwrap_or(""),
        );
    }
    if let Some(ref pane) = terminal_pane_opt {
        if let Some((pane_session, data)) = terminal::read_terminal_pane(
            tmux_server_opt.as_deref().unwrap_or(""),
            pane,
            harness_opt.as_deref().unwrap_or(""),
        ) {
            session = Some(pane_session);
            payload = data.get("payload").cloned().unwrap_or_else(|| json!({}));
        } else {
            session = None;
            payload = json!({});
        }
    }

    if pane_pid_opt.is_none()
        && codex_pane_opt.is_none()
        && terminal_pane_opt.is_none()
        && session.is_none()
    {
        let mut raw_stdin = Vec::new();
        if io::stdin().read_to_end(&mut raw_stdin).is_err() {
            return Ok(());
        }
        let Ok(v) = serde_json::from_slice::<Value>(&raw_stdin) else {
            return Ok(());
        };
        session = v
            .get("session_id")
            .or_else(|| v.get("conversation_id"))
            .or_else(|| v.get("conversationId"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(String::from);
        payload = v;
    }

    if native_status_opt
        && let Some(ref session_id) = session
        && !tmux_opt
        && terminal::bind_terminal(
            &base,
            session_id.clone(),
            harness_opt.as_deref(),
            &payload,
            refresh_terminal_opt,
        )
        && terminal::terminal_context(harness_opt.as_deref()).is_some()
    {
        return Ok(());
    }

    let emit_tmux_waiting = || {
        if tmux_opt {
            let has_pane = codex_pane_opt.is_some() || terminal_pane_opt.is_some();
            if line_opt == 2 {
                if has_pane {
                    println!(
                        "#[align=left,nobold]Orkest: task and progress appear after the session registers"
                    );
                } else {
                    println!("Orkest: waiting for agent");
                }
            } else if has_pane {
                println!(
                    "#[align=left,bold]Orkest: agent identity appears after the session registers"
                );
            } else {
                println!("Orkest: waiting for agent");
            }
        }
    };

    let Some(session_id) = session.filter(|s| !s.is_empty()) else {
        emit_tmux_waiting();
        return Ok(());
    };
    let Some(mut item_obj) = identity_item(&base, &session_id, harness_opt.as_deref(), &payload)
    else {
        emit_tmux_waiting();
        return Ok(());
    };

    let width = resolve_terminal_columns(width_opt, &payload).clamp(32, 1000);
    let parts = line_parts(&item_obj, width, line_opt);
    let label = parts.first().map(|p| p.1.clone()).unwrap_or_default();
    let details: String = parts
        .iter()
        .skip(1)
        .map(|p| p.1.as_str())
        .collect::<Vec<_>>()
        .join("");

    let color_num = item_obj.get("color").and_then(Value::as_u64).unwrap_or(31) as u32;
    let stage = item_obj
        .get("stage")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let health = item_obj
        .get("statusHealth")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if json_opt {
        if let Some(m) = item_obj.as_object_mut() {
            m.insert("label".to_string(), Value::String(label));
            m.insert("details".to_string(), Value::String(details));
        }
        println!("{item_obj}");
    } else if tmux_opt {
        let nerd = env::var("ORK_GLYPHS")
            .unwrap_or_else(|_| "nerd".to_string())
            .trim()
            .to_lowercase()
            == "nerd";
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
        let inner_parts = line_parts(&item_obj, width.saturating_sub(pad_width), line_opt);
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
                "stage" => stage_color(&stage, &health),
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
        let nerd = env::var("ORK_GLYPHS")
            .unwrap_or_else(|_| "nerd".to_string())
            .trim()
            .to_lowercase()
            == "nerd";
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
        let inner_parts = line_parts(&item_obj, width.saturating_sub(pad_width), line_opt);
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
                "stage" => stage_color(&stage, &health),
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
    use std::fs;
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

    #[test]
    fn test_display_width_cjk_and_combining() {
        assert_eq!(display_width("abc"), 3);
        assert_eq!(display_width("e\u{0301}"), 1);
        assert_eq!(display_width("漢字"), 4);
        assert_eq!(shorten("漢字abc", 4), "漢…");
    }

    #[test]
    fn test_normalize_model_and_effort() {
        assert_eq!(
            normalize_model_and_effort("claude-opus-4-6 (high)", ""),
            ("claude-opus-4-6".to_string(), "high".to_string())
        );
        assert_eq!(
            normalize_model_and_effort("gpt-5.4 [xhigh]", ""),
            ("gpt-5.4".to_string(), "xhigh".to_string())
        );
    }
}
