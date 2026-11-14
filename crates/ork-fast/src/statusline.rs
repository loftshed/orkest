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
    let mut child = Command::new("python3")
        .arg("-B")
        .arg(fallback_script)
        .args(args)
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
    let joined = words.join(" ");
    if joined.len() > 240 {
        joined[..240].to_string()
    } else {
        joined
    }
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
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    let prefix_width = width - 4;
    format!("{}{suffix}", shorten(&s[..chars.len() - 4], prefix_width))
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

pub fn run(args: &[String], fallback_script: Option<&Path>) -> io::Result<()> {
    let mut session_opt: Option<String> = None;
    let mut harness_opt: Option<String> = None;
    let mut width_opt: Option<usize> = None;
    let mut line_opt: u32 = 0;
    let mut json_opt = false;
    let mut plain_opt = false;
    let mut tmux_opt = false;
    let mut no_color_opt = env::var("NO_COLOR").is_ok();
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

    let base = paths::cache_home(None, None);
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

    let name = peer.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if name.is_empty() {
        if tmux_opt {
            emit_tmux_waiting(line_opt);
        }
        return Ok(());
    }

    // Read progress file if present
    let s_key = match paths::session_key(&session) {
        Ok(k) => k,
        Err(_) => return Ok(()),
    };
    let prog_path = base.join("progress").join(format!("{s_key}.json"));
    let progress: Option<serde_json::Value> = fs::read_to_string(&prog_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok());

    let repo = peer
        .get("repository")
        .and_then(|v| v.as_str())
        .unwrap_or("not set");
    let checkout = peer
        .get("checkout")
        .or_else(|| peer.get("cwd"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let role = progress
        .as_ref()
        .and_then(|p| p.get("role"))
        .and_then(|v| v.as_str());

    let (goal, task, stage, health) = if let Some(ref p) = progress {
        let g = p.get("goal").and_then(|v| v.as_str()).unwrap_or("not set");
        let t = p.get("task").and_then(|v| v.as_str()).unwrap_or("not set");
        let st = p.get("stage").and_then(|v| v.as_str()).unwrap_or("not set");
        (g, t, st, "fresh")
    } else {
        let focus = peer.get("focus").and_then(|v| v.as_str()).unwrap_or("");
        (
            "not set",
            if focus.is_empty() { "not set" } else { focus },
            "not set",
            "missing",
        )
    };

    let raw_model = payload
        .get("model")
        .and_then(|m| {
            if m.is_string() {
                m.as_str()
            } else {
                m.get("id")
                    .or_else(|| m.get("display_name"))
                    .and_then(|v| v.as_str())
            }
        })
        .or_else(|| peer.get("stepModel").and_then(|v| v.as_str()))
        .or_else(|| peer.get("executionModel").and_then(|v| v.as_str()))
        .or_else(|| peer.get("sessionModel").and_then(|v| v.as_str()))
        .or_else(|| peer.get("model").and_then(|v| v.as_str()))
        .unwrap_or("—");

    let raw_effort = payload
        .get("effort")
        .and_then(|e| {
            if e.is_string() {
                e.as_str()
            } else {
                e.get("level").and_then(|v| v.as_str())
            }
        })
        .or_else(|| peer.get("effort").and_then(|v| v.as_str()))
        .unwrap_or("—");

    let (model, effort) = normalize_model_and_effort(raw_model, raw_effort);

    let digest = sha256::sha256_digest(session.as_bytes());
    let color_idx = (digest[0] as usize) % COLORS.len();
    let color_num = COLORS[color_idx];

    let person = peer.get("person").and_then(|v| v.as_str());
    let display_name = short_display_name(name, person, Some(repo));

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
    });
    if let Some(r) = role {
        item_obj["role"] = serde_json::Value::String(r.to_string());
    }

    let width = width_opt.unwrap_or(80);
    let parts = line_parts(&item_obj, width.clamp(32, 1000), line_opt);

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
        let pad_width = if nerd && colored {
            7
        } else if colored && line_opt != 2 {
            6
        } else {
            3
        };
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
        let inner_parts = line_parts(
            &item_obj,
            width.saturating_sub(pad_width).clamp(32, 1000),
            line_opt,
        );
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
                "stage" => stage_color(stage, health),
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
        let inner_parts = line_parts(
            &item_obj,
            width.saturating_sub(pad_width).clamp(32, 1000),
            line_opt,
        );
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
                "stage" => stage_color(stage, health),
                _ => None,
            };
            let fg = color.map_or("39".to_string(), |c| format!("38;5;{c}"));
            out.push_str(&format!("\x1b[{fg};{weight}m{v}\x1b[0m"));
        }
        println!("{out}");
    }

    Ok(())
}
