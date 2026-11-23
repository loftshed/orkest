//! Swarm coordinator/lead context, `/side` and `/swarm`/`/horde` turn-start intercepts, and advisor digest.

use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde_json::Value;

use crate::identity;
use crate::mailbox_records;
use crate::mailbox_transcript;
use crate::paths;
use crate::rooms_work;
use crate::sha256;
use crate::sqlite;

const ACTIVE_MEMBER_STATUSES: &[&str] = &[
    "running", "active", "working", "planning", "testing", "claimed", "reserved", "spawned",
];

fn in_isolated_test_mode() -> bool {
    env::var_os("PYTEST_CURRENT_TEST").is_some_and(|v| !v.is_empty())
        || env::var("ORKEST_TEST_MODE").as_deref() == Ok("1")
}

/// Active Herdr integration check matching `mailbox_hooks.py::_herdr_active`.
#[must_use]
pub fn herdr_active() -> bool {
    if env::var("HERDR_ENV").as_deref() != Ok("1") {
        return false;
    }
    !(in_isolated_test_mode() && env::var("ORKEST_TEST_ALLOW_HERDR").as_deref() != Ok("1"))
}

fn is_suppressed_peer(me: &Value) -> bool {
    me.get("isSubagent").is_some_and(paths::is_truthy_json)
        || me.get("delegatedRun").is_some_and(paths::is_truthy_json)
        || identity::is_run_peer(Some(me))
}

/// Return `ORKEST_SWARM_ROOM` iff it names an active unclosed room (`_active_env_swarm_room`).
#[must_use]
pub fn active_env_swarm_room(base: &Path) -> Option<String> {
    let room_id = env::var("ORKEST_SWARM_ROOM").ok()?;
    let trimmed = room_id.trim();
    if trimmed.is_empty() || !paths::valid_room_id(trimmed) {
        return None;
    }
    let room = sqlite::read_room(base, trimmed)?;
    rooms_work::is_open_room(&room).then(|| trimmed.to_string())
}

fn strip_user_request_tags(prompt: &str) -> String {
    prompt
        .replace("<USER_REQUEST>", "")
        .replace("</USER_REQUEST>", "")
        .trim()
        .to_string()
}

fn extract_tag_content(text: &str, prefix: &str, optional_colon: bool) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let idx = lower.find(&prefix.to_ascii_lowercase())?;
    let after = &text[idx + prefix.len()..];
    let after_colon = if optional_colon {
        if let Some(stripped) = after.strip_prefix(':') {
            stripped
        } else if after.starts_with(']') {
            ""
        } else {
            return None;
        }
    } else {
        after.strip_prefix(':')?
    };
    let end = after.find(']')?;
    if optional_colon && after_colon.is_empty() {
        return Some(String::new());
    }
    let inner_end = after_colon.find(']')?;
    let _ = end;
    Some(after_colon[..inner_end].trim().to_string())
}

fn match_side_args(cleaned: &str) -> Option<String> {
    if let Some(tag) = extract_tag_content(cleaned, "[orkest-side-command", false) {
        return Some(tag);
    }
    let trimmed = cleaned.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["/orchestrate:side", "/side"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let orig_rest = &trimmed[prefix.len()..];
            if rest.is_empty() {
                return Some(String::new());
            }
            if orig_rest.chars().next().is_some_and(char::is_whitespace) {
                return Some(orig_rest.trim().to_string());
            }
        }
    }
    for prefix in ["!side", "side:"] {
        if lower.starts_with(prefix) {
            let orig_rest = &trimmed[prefix.len()..];
            if prefix == "!side" && !orig_rest.chars().next().is_some_and(char::is_whitespace) {
                continue;
            }
            if prefix == "side:" && !orig_rest.chars().next().is_some_and(char::is_whitespace) {
                continue;
            }
            let body = orig_rest.trim();
            if !body.is_empty() {
                return Some(body.to_string());
            }
        }
    }
    None
}

fn match_swarm_arg(cleaned: &str) -> Option<String> {
    let trimmed = cleaned.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in [
        "/orchestrate:swarm",
        "/orchestrate:horde",
        "/swarm",
        "/horde",
    ] {
        if let Some(rest_l) = lower.strip_prefix(prefix) {
            let orig_rest = &trimmed[prefix.len()..];
            if rest_l.is_empty() {
                return Some(String::new());
            }
            if orig_rest.chars().next().is_some_and(char::is_whitespace) {
                return Some(orig_rest.trim().to_string());
            }
        }
    }
    extract_tag_content(trimmed, "[orkest-swarm-command", true)
}

fn shell_split_lenient(raw: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let mut has_token = false;

    for ch in raw.chars() {
        if escaped {
            cur.push(ch);
            escaped = false;
            has_token = true;
            continue;
        }
        if ch == '\\' && !in_single {
            escaped = true;
            has_token = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            has_token = true;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            has_token = true;
            continue;
        }
        if !in_single && !in_double && ch.is_whitespace() {
            if has_token {
                tokens.push(std::mem::take(&mut cur));
                has_token = false;
            }
            continue;
        }
        cur.push(ch);
        has_token = true;
    }
    if in_single || in_double || escaped {
        return vec![raw.to_string()];
    }
    if has_token {
        tokens.push(cur);
    }
    tokens
}

/// Intercept `/side`, `[orkest-side-command: ...]`, `!side`, or `side:` on turn start.
#[must_use]
pub fn side_command_context(
    base: &Path,
    me: &Value,
    payload: &Value,
    event: &str,
    mid_turn: bool,
) -> String {
    if is_suppressed_peer(me) {
        return String::new();
    }
    if !(event == "UserPromptSubmit" || (event == "PreInvocation" && !mid_turn)) {
        return String::new();
    }
    let Some(session) = me.get("session").and_then(Value::as_str) else {
        return String::new();
    };
    let Some(harness) = me.get("harness").and_then(Value::as_str) else {
        return String::new();
    };
    let account = me.get("accountHome").and_then(Value::as_str);
    let Some(prompt) = mailbox_transcript::latest_user_prompt(payload, session, account) else {
        return String::new();
    };
    let cleaned = strip_user_request_tags(&prompt);
    let Some(raw_args) = match_side_args(&cleaned) else {
        return String::new();
    };
    if raw_args.is_empty() {
        return "[orkest-side-dispatched] Usage: `/side [--later|--issue|--investigate] <idea>`. \
                Let the user know in one short line and do not call any tools."
            .to_string();
    }
    let Some(runtime) = paths::runtime_root() else {
        return String::new();
    };
    let side_script = runtime.join("src/lib/side.mjs");
    if !side_script.is_file() {
        return String::new();
    }
    let parsed_tokens = shell_split_lenient(&raw_args);
    let has_room_flag = parsed_tokens.iter().any(|t| t == "--room");
    let cwd = me
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".to_string())
        });

    let node = paths::node_binary();
    let mut cmd = Command::new(node);
    cmd.arg(side_script);
    cmd.args(&parsed_tokens);
    cmd.args([
        "--session",
        session,
        "--harness",
        harness,
        "--cwd",
        &cwd,
        "--json",
    ]);
    if !has_room_flag && let Some(room_env) = active_env_swarm_room(base) {
        cmd.args(["--room", &room_env]);
    }
    cmd.current_dir(&cwd)
        .env("ORCHESTRATE_MAILBOX_DIR", base)
        .stdin(std::process::Stdio::null());
    let Some(out) = paths::run_output_with_timeout(&mut cmd, Duration::from_secs(15)) else {
        return String::new();
    };
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if stdout.is_empty() {
        return String::new();
    }
    let Ok(data) = serde_json::from_str::<Value>(&stdout) else {
        return String::new();
    };
    if !data.is_object() {
        return String::new();
    }
    let direct_return = (event == "UserPromptSubmit" && harness != "gemini")
        || (event == "PreInvocation" && !mid_turn);
    if data.get("status").and_then(Value::as_str) == Some("error") {
        let err_msg = data
            .get("error")
            .map(|v| match v {
                Value::String(s) => s.clone(),
                Value::Null => "None".to_string(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "None".to_string());
        if direct_return {
            return format!("Side mission error: {err_msg}");
        }
        return format!(
            "[orkest-side-dispatched] Side mission error: {err_msg}. Report this in one line and do not call any tools."
        );
    }
    let summary = data
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if summary.is_empty() {
        return String::new();
    }
    if direct_return {
        summary.to_string()
    } else {
        format!(
            "[orkest-side-dispatched] {summary} Confirm this to the user in one short line and do not call any tools."
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn toggle_swarm_view_cli(
    action: &str,
    socket: Option<&str>,
    room: Option<&str>,
    session_id: &str,
    harness: &str,
    cwd: Option<&str>,
    base: &Path,
    respect_closed: bool,
) -> Option<Value> {
    let script = paths::scripts_root()?.join("agent_statusline_tmux.py");
    if !script.is_file() {
        return None;
    }
    let cache_root = base.parent().unwrap_or(base);
    let mut cmd = Command::new(paths::python_binary());
    cmd.arg("-B").arg(script).args([
        "--toggle-swarm",
        action,
        "--session",
        session_id,
        "--harness",
        harness,
        "--json",
    ]);
    if let Some(s) = socket.filter(|s| !s.is_empty()) {
        cmd.args(["--socket", s]);
    }
    if let Some(r) = room.filter(|s| !s.is_empty()) {
        cmd.args(["--room", r]);
    }
    if let Some(c) = cwd.filter(|s| !s.is_empty()) {
        cmd.args(["--cwd", c]);
    }
    if respect_closed {
        cmd.arg("--respect-closed");
    }
    cmd.env("AGENT_EXECUTOR_HOME", cache_root)
        .env("ORCHESTRATE_HOME", cache_root)
        .stdin(std::process::Stdio::null());
    let out = paths::run_output_with_timeout(&mut cmd, Duration::from_secs(10))?;
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<Value>(text.trim())
        .ok()
        .filter(Value::is_object)
}

/// Toggle or open the Orkest Swarm View split pane when `/swarm` or `/horde` is submitted.
#[must_use]
pub fn swarm_command_context(
    base: &Path,
    me: &Value,
    payload: &Value,
    event: &str,
    mid_turn: bool,
) -> String {
    if is_suppressed_peer(me) {
        return String::new();
    }
    if !(event == "UserPromptSubmit" || (event == "PreInvocation" && !mid_turn)) {
        return String::new();
    }
    let Some(session) = me.get("session").and_then(Value::as_str) else {
        return String::new();
    };
    let Some(harness) = me.get("harness").and_then(Value::as_str) else {
        return String::new();
    };
    let account = me.get("accountHome").and_then(Value::as_str);
    let Some(prompt) = mailbox_transcript::latest_user_prompt(payload, session, account) else {
        return String::new();
    };
    let cleaned = strip_user_request_tags(&prompt);
    let Some(raw_arg) = match_swarm_arg(&cleaned) else {
        return String::new();
    };
    let lower_arg = raw_arg.to_ascii_lowercase();
    let (action, goal) = if matches!(lower_arg.as_str(), "" | "toggle" | "open" | "close") {
        (
            if lower_arg.is_empty() {
                "toggle"
            } else {
                lower_arg.as_str()
            },
            String::new(),
        )
    } else {
        ("open", raw_arg)
    };
    let socket = if env::var("HERDR_ENV").as_deref() == Ok("1") {
        None
    } else {
        me.get("terminalServer").and_then(Value::as_str)
    };
    let cwd = me.get("cwd").and_then(Value::as_str);
    let Some(outcome) =
        toggle_swarm_view_cli(action, socket, None, session, harness, cwd, base, false)
    else {
        return String::new();
    };
    let status = outcome
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unavailable")
        .replace('_', " ");
    let room = outcome
        .get("room")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let room_note = room.map_or_else(String::new, |r| format!(" (room {r})"));
    if matches!(
        outcome.get("status").and_then(Value::as_str),
        Some("opened" | "closed" | "already_open" | "already_closed")
    ) {
        if !goal.is_empty() {
            return format!(
                "[orkest-swarm-goal] Orkest Swarm View pane is now {status}{room_note}. \
                 Proceed with the user's swarm objective: {goal}"
            );
        }
        return format!("Orkest Swarm View pane is now {status}{room_note}.");
    }
    let reason = outcome
        .get("reason")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("no enclosing Orkest tmux terminal");
    if !goal.is_empty() {
        format!(
            "[orkest-swarm-goal] Orkest Swarm View pane could not be opened automatically ({reason}). \
             Proceed with the user's swarm objective: {goal}"
        )
    } else {
        format!(
            "Orkest Swarm View pane could not be toggled automatically ({reason}). \
             Use Ctrl+Option+S in Herdr or an Orkest-wrapped terminal session."
        )
    }
}

fn auto_recover_task_cli(task_dir: &Path) -> Option<Value> {
    let script = paths::scripts_root()?.join("coordinator.py");
    if !script.is_file() {
        return None;
    }
    let mut cmd = Command::new(paths::python_binary());
    cmd.arg("-B")
        .arg(script)
        .args(["recover", "--task-dir"])
        .arg(task_dir)
        .stdin(std::process::Stdio::null());
    let _ = paths::run_output_with_timeout(&mut cmd, Duration::from_secs(3));
    paths::read_json_file(&task_dir.join("task.json"))
}

fn swarm_next_advisor(
    base: &Path,
    me: &mut Value,
    mut room: Value,
    room_id: &str,
    member_id: &str,
) -> String {
    let Some(my_session) = me
        .get("session")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return String::new();
    };
    if let Some(fresh) = sqlite::read_room(base, room_id) {
        room = fresh;
    }
    if member_id == "conductor"
        && me.get("continuationRoom").and_then(Value::as_str) != Some(room_id)
    {
        let _ = identity::annotate_peer(
            base,
            &my_session,
            &[("continuationRoom", Value::String(room_id.to_string()))],
        );
    }

    let raw_agents: Vec<&Value> = room
        .get("agents")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter(|a| a.is_object()).collect())
        .unwrap_or_default();
    let agents: Vec<&Value> = if member_id != "conductor" {
        let scoped: Vec<&Value> = raw_agents
            .iter()
            .copied()
            .filter(|a| a.get("parent").and_then(Value::as_str) == Some(member_id))
            .collect();
        if scoped.is_empty() {
            raw_agents
        } else {
            scoped
        }
    } else {
        raw_agents
    };

    let mut respond_items = Vec::new();
    let mut expired_lease_items = Vec::new();
    let mut review_items = Vec::new();
    let mut failed_items = Vec::new();
    let mut smelt_items = Vec::new();
    let mut queued_items = Vec::new();
    let mut advisor_lines = Vec::new();

    for agent in agents {
        let agent_id = agent
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("worker");
        let status_lower = agent
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let dispatch = agent.get("dispatch").and_then(Value::as_object);
        let task_dir_raw = dispatch
            .and_then(|d| d.get("taskDir"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut task_data: Option<Value> = None;
        if !task_dir_raw.trim().is_empty() {
            let task_dir = paths::expand_home(task_dir_raw, None);
            let task_file = task_dir.join("task.json");
            if let Some(loaded) = paths::read_json_file(&task_file)
                && loaded.is_object()
            {
                let needs_recover =
                    loaded
                        .get("runs")
                        .and_then(Value::as_array)
                        .is_some_and(|runs| {
                            runs.iter().any(|r| {
                                r.is_object()
                                    && matches!(
                                        r.get("status").and_then(Value::as_str),
                                        Some("dispatching" | "uncertain" | "active" | "reserved")
                                    )
                                    && r.get("result_path")
                                        .and_then(Value::as_str)
                                        .is_some_and(|rp| Path::new(rp).is_file())
                            })
                        });
                task_data = if needs_recover {
                    auto_recover_task_cli(&task_dir).or(Some(loaded))
                } else {
                    Some(loaded)
                };
            }
        }

        if let Some(ref td) = task_data {
            let runs: Vec<&Value> = td
                .get("runs")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter(|r| r.is_object()).collect())
                .unwrap_or_default();
            let decided_run_ids: HashSet<String> = td
                .get("decisions")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|d| {
                            if d.get("run_id").is_some_and(paths::is_truthy_json)
                                && d.get("decision").is_some_and(paths::is_truthy_json)
                            {
                                d.get("run_id").and_then(Value::as_str).map(str::to_string)
                            } else {
                                None
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            for run in &runs {
                let run_id = run.get("run_id").and_then(Value::as_str).unwrap_or("");
                if let Some(c_peer) = run
                    .get("mailbox")
                    .and_then(|m| m.get("conductor"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    && paths::session_key(c_peer).is_ok()
                {
                    let unread = mailbox_records::count_unread(base, c_peer, false, false);
                    if unread > 0 {
                        respond_items.push(format!("respond:{agent_id}:{run_id}:{unread}"));
                        advisor_lines.push(format!(
                            "- [respond] {agent_id} ({run_id}) has {unread} unread worker message(s) waiting."
                        ));
                    }
                }
            }
            if let Some(&latest_run) = runs.last() {
                let run_id = latest_run
                    .get("run_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let run_status = latest_run
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let runner_status = latest_run.get("runner_status");
                if run_status == "finished" && !decided_run_ids.contains(run_id) {
                    if runner_status.is_none()
                        || runner_status.is_some_and(Value::is_null)
                        || runner_status.and_then(Value::as_str) == Some("completed")
                    {
                        review_items.push(format!("review:{agent_id}:{run_id}"));
                        advisor_lines.push(format!(
                            "- [review] {agent_id} finished run {run_id}; review with `coordinator.py review --task-dir {task_dir_raw} --run-id {run_id} --decision accept`."
                        ));
                    } else {
                        let rs = runner_status.and_then(Value::as_str).unwrap_or("unknown");
                        failed_items.push(format!("failed:{agent_id}:{run_id}:{rs}"));
                        advisor_lines.push(format!(
                            "- [failed] {agent_id} run {run_id} ended with {rs}; inspect artifacts in {task_dir_raw}."
                        ));
                    }
                } else if run_status == "uncertain" && !decided_run_ids.contains(run_id) {
                    failed_items.push(format!("failed:{agent_id}:{run_id}:uncertain"));
                    advisor_lines.push(format!(
                        "- [failed] {agent_id} run {run_id} is uncertain; run `coordinator.py recover --task-dir {task_dir_raw}`."
                    ));
                }
            }
        }

        if let Some(dispatch_err) = agent
            .get("dispatchError")
            .filter(|v| paths::is_truthy_json(v))
        {
            let err_str = match dispatch_err {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            failed_items.push(format!("failed:{agent_id}:dispatch_error"));
            advisor_lines.push(format!("- [failed] {agent_id} dispatch error: {err_str}"));
        }
        if let Some(wt) = agent.get("worktree").and_then(Value::as_object)
            && let Some(branch) = wt
                .get("branch")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            && matches!(status_lower.as_str(), "completed" | "complete" | "done")
        {
            smelt_items.push(format!("smelt:{agent_id}:{branch}"));
            advisor_lines.push(format!(
                "- [smelt] {agent_id} worktree branch `{branch}` is ready to smelt (`ork smelter run`)."
            ));
        }
        if status_lower == "queued"
            && dispatch.is_none()
            && !agent.get("session").is_some_and(paths::is_truthy_json)
        {
            queued_items.push(format!("dispatch_queued:{agent_id}"));
            advisor_lines.push(format!(
                "- [dispatch_queued] {agent_id} is queued and ready to dispatch."
            ));
        }
    }

    let board_val = paths::read_json_file(&base.join("work/board.json"))
        .or_else(|| paths::read_json_file(&base.join("workboard.json")));
    if let Some(items) = board_val
        .as_ref()
        .and_then(|b| b.get("items"))
        .and_then(Value::as_array)
    {
        let now_secs = paths::utc_now_secs();
        for item in items {
            let item_state = item
                .get("state")
                .or_else(|| item.get("status"))
                .and_then(Value::as_str);
            if !matches!(item_state, Some("claimed" | "blocked"))
                || !item.get("owner").is_some_and(paths::is_truthy_json)
            {
                continue;
            }
            let lease_raw = item
                .get("leaseExpiresAt")
                .and_then(Value::as_str)
                .or_else(|| {
                    item.get("lease")
                        .and_then(|l| l.get("expiresAt"))
                        .and_then(Value::as_str)
                });
            if let Some(exp_secs) = lease_raw.and_then(paths::parse_iso8601_utc_secs)
                && exp_secs <= now_secs
            {
                let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");
                expired_lease_items.push(format!("expired_leases:{item_id}"));
                advisor_lines.push(format!(
                    "- [expired_leases] Workboard item {item_id} has an expired claim lease."
                ));
            }
        }
    }

    let mut all_actions = Vec::new();
    all_actions.extend(respond_items.iter().cloned());
    all_actions.extend(expired_lease_items.iter().cloned());
    all_actions.extend(review_items);
    all_actions.extend(failed_items.iter().cloned());
    all_actions.extend(smelt_items);
    all_actions.extend(queued_items);

    if all_actions.is_empty() {
        if (me.get("swarmNextDigest").is_some_and(|v| !v.is_null())
            || me.get("swarmNextTurns").is_some_and(paths::is_truthy_json))
            && let Some(updated) = identity::annotate_peer(
                base,
                &my_session,
                &[
                    ("swarmNextDigest", Value::Null),
                    ("swarmNextTurns", serde_json::json!(0)),
                ],
            )
        {
            *me = updated;
        }
        return String::new();
    }

    let joined = all_actions.join("|");
    let digest = sha256::sha256_hex(joined.as_bytes())[..16].to_string();
    let has_blocker =
        !respond_items.is_empty() || !expired_lease_items.is_empty() || !failed_items.is_empty();
    let prev_digest = me.get("swarmNextDigest").and_then(Value::as_str);
    let turns_since = me
        .get("swarmNextTurns")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + 1;

    if prev_digest == Some(digest.as_str()) {
        if has_blocker && turns_since >= 5 {
            if let Some(updated) = identity::annotate_peer(
                base,
                &my_session,
                &[
                    ("swarmNextDigest", Value::String(digest.clone())),
                    ("swarmNextTurns", serde_json::json!(0)),
                ],
            ) {
                *me = updated;
            }
        } else {
            if let Some(updated) = identity::annotate_peer(
                base,
                &my_session,
                &[("swarmNextTurns", serde_json::json!(turns_since))],
            ) {
                *me = updated;
            }
            return String::new();
        }
    } else if let Some(updated) = identity::annotate_peer(
        base,
        &my_session,
        &[
            ("swarmNextDigest", Value::String(digest.clone())),
            ("swarmNextTurns", serde_json::json!(0)),
        ],
    ) {
        *me = updated;
    }

    let top: Vec<&str> = advisor_lines.iter().take(2).map(String::as_str).collect();
    format!(
        "Swarm next step (room {room_id}, digest {digest}):\n{}",
        top.join("\n")
    )
}

fn format_swarm_reconnection_summary(room: &Value, room_id: &str, member_id: &str) -> String {
    let title = room
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(room_id)
        .trim();
    let role_label = if member_id == "conductor" {
        "root swarm coordinator (conductor)".to_string()
    } else {
        format!("subswarm lead ({member_id})")
    };
    let mut objective = room
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let agents: Vec<&Value> = room
        .get("agents")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter(|a| a.is_object()).collect())
        .unwrap_or_default();
    if member_id != "conductor" {
        for agent in &agents {
            if agent.get("id").and_then(Value::as_str) == Some(member_id)
                && let Some(obj) = agent.get("objective").and_then(Value::as_str)
                && !obj.trim().is_empty()
            {
                objective = obj.trim().to_string();
                break;
            }
        }
    }
    let mut active = 0usize;
    let mut completed = 0usize;
    let mut blocked = 0usize;
    for agent in &agents {
        let st = agent
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if ACTIVE_MEMBER_STATUSES.contains(&st.as_str()) {
            active += 1;
        } else if matches!(st.as_str(), "completed" | "complete" | "done" | "merged") {
            completed += 1;
        } else if matches!(st.as_str(), "blocked" | "failed" | "rejected" | "error") {
            blocked += 1;
        }
    }
    let title_part = if !title.is_empty() && title != room_id {
        format!(" ({title})")
    } else {
        String::new()
    };
    let obj_part = if !objective.is_empty() {
        format!(" Objective: {objective}.")
    } else {
        String::new()
    };
    let total = agents.len();
    format!(
        "Reconnected to swarm room {room_id}{title_part} as {role_label}.{obj_part} \
         Horde members: {total} total ({active} active, {completed} completed, {blocked} blocked/failed). \
         Run `ork rooms show --room {room_id}` to inspect your swarm or `/swarm` to toggle the Swarm View."
    )
}

fn deliver_swarm_brief_or_summary(
    base: &Path,
    me: &mut Value,
    room: &Value,
    room_id: &str,
    member_id: &str,
    instance_key: &str,
    allow_brief: bool,
) -> String {
    let has_state = room.get("objective").is_some_and(paths::is_truthy_json)
        || room.get("agents").is_some_and(paths::is_truthy_json);
    let already_reconnected =
        me.get("swarmAutoReconnected").and_then(Value::as_str) == Some(instance_key);
    let my_session = me
        .get("session")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if allow_brief && me.get("swarmBriefed").and_then(Value::as_str) != Some(room_id) {
        let brief_file = base
            .join("swarm-briefs")
            .join(room_id)
            .join(format!("{member_id}.md"));
        if brief_file.is_file()
            && let Ok(content) = fs::read_to_string(&brief_file)
        {
            let brief_text = content
                .replace("YOUR_ACTUAL_SESSION_ID", &my_session)
                .trim()
                .to_string();
            if !brief_text.is_empty() {
                if let Some(updated) = identity::annotate_peer(
                    base,
                    &my_session,
                    &[
                        ("swarmBriefed", Value::String(room_id.to_string())),
                        (
                            "swarmAutoReconnected",
                            Value::String(instance_key.to_string()),
                        ),
                    ],
                ) {
                    *me = updated;
                }
                if has_state && !already_reconnected {
                    return format!(
                        "{brief_text}\n\n{}",
                        format_swarm_reconnection_summary(room, room_id, member_id)
                    );
                }
                return brief_text;
            }
        }
    }
    if has_state && !already_reconnected {
        if let Some(updated) = identity::annotate_peer(
            base,
            &my_session,
            &[(
                "swarmAutoReconnected",
                Value::String(instance_key.to_string()),
            )],
        ) {
            *me = updated;
        }
        return format_swarm_reconnection_summary(room, room_id, member_id);
    }
    String::new()
}

fn record_native_swarm_identity(base: &Path, me: &mut Value) {
    if me.get("isSubagent").is_some_and(paths::is_truthy_json)
        || me.get("delegatedRun").is_some_and(paths::is_truthy_json)
        || identity::is_run_peer(Some(me))
    {
        return;
    }
    let harness = me.get("harness").and_then(Value::as_str).unwrap_or("");
    let env_key = match harness {
        "claude" => "CLAUDE_CODE_SESSION_ID",
        "codex" => "CODEX_THREAD_ID",
        "gemini" => "ANTIGRAVITY_CONVERSATION_ID",
        "opencode" => "OPENCODE_SESSION_ID",
        _ => return,
    };
    let Ok(native) = env::var(env_key) else {
        return;
    };
    if native.is_empty() {
        return;
    }
    let my_session = me.get("session").and_then(Value::as_str).unwrap_or("");
    let my_cwd = me.get("cwd").and_then(Value::as_str);
    if let Some(owner) = identity::session_peer(base, &native, Some(harness), my_cwd, false)
        && owner.get("session").and_then(Value::as_str) != Some(my_session)
    {
        return;
    }
    if let Some(updated) = identity::attest_native_sessions(base, my_session, &[&native]) {
        *me = updated;
    }
}

/// The room the resumed (or forked-from) session already belongs to, if any.
///
/// A resume hint only recovers an existing membership. It never creates a room and never
/// promotes a session that is not already a member or the conductor of an open room.
fn resumed_swarm_membership(
    base: &Path,
    session: &str,
    harness: &str,
    cwd: &str,
) -> Option<rooms_work::MatchedSwarmRoom> {
    let target = env::var("ORKEST_RESUME_TARGET").ok()?;
    if target.is_empty() || target == session {
        return None;
    }
    rooms_work::find_session_swarm_room(base, &target, Some(harness), Some(cwd), None)
}

/// Move a known room's conductor binding to the resumed session. Showing the view is a
/// separate decision: it follows the saved open intent, checked when the view restores.
fn rebind_resumed_conductor(base: &Path, room: &str, session: &str, cwd: &str) -> Option<String> {
    let cache_root = base.parent().unwrap_or(base);
    let cli = paths::runtime_root()?.join("src/bin/ork.mjs");
    if !cli.is_file() {
        return None;
    }
    let mut cmd = Command::new(paths::node_binary());
    cmd.arg(cli)
        .args([
            "hall",
            "promote",
            "--room",
            room,
            "--session",
            session,
            "--cwd",
            cwd,
        ])
        .env("ORKEST_SWARM_ROOM", room)
        .env("AGENT_EXECUTOR_HOME", cache_root)
        .env("ORCHESTRATE_HOME", cache_root)
        .stdin(std::process::Stdio::null());
    let out = paths::run_output_with_timeout(&mut cmd, Duration::from_secs(10))?;
    if !out.status.success() {
        return None;
    }
    Some(room.to_string())
}

fn instance_key_for(me: &Value, room_id: &str) -> String {
    let host_ref = me
        .get("terminalServer")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            me.get("herdrPaneId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .map(str::to_string)
        .or_else(|| {
            me.get("pid")
                .and_then(|v| if v.is_boolean() { None } else { v.as_i64() })
                .map(|p| p.to_string())
        })
        .unwrap_or_default();
    format!("{room_id}:{host_ref}")
}

/// Try once to restore a view whose open intent was saved. Returns whether an attempt ran,
/// whatever its outcome: the caller records it, so a failing restore does not open and close
/// a pane on every prompt. A failure is not the user's choice, so it never writes `.closed`.
fn restore_known_swarm_view(base: &Path, me: &Value, room: &str, instance_key: &str) -> bool {
    if me.get("swarmAutoReconnected").and_then(Value::as_str) == Some(instance_key) {
        return false;
    }
    let socket = if herdr_active() {
        None
    } else {
        let socket = me
            .get("terminalServer")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| env::var("ORKEST_TERMINAL_SERVER").ok())
            .filter(|value| !value.is_empty());
        if socket.is_none() {
            return false;
        }
        socket
    };
    let session = me.get("session").and_then(Value::as_str).unwrap_or("");
    let harness = me.get("harness").and_then(Value::as_str).unwrap_or("");
    let cwd = me.get("cwd").and_then(Value::as_str);
    let _ = toggle_swarm_view_cli(
        "open",
        socket.as_deref(),
        Some(room),
        session,
        harness,
        cwd,
        base,
        true,
    );
    true
}

fn remember_swarm_restore(base: &Path, me: &mut Value, instance_key: &str) {
    if me.get("swarmAutoReconnected").and_then(Value::as_str) != Some(instance_key)
        && let Some(session) = me.get("session").and_then(Value::as_str)
        && let Some(updated) = identity::annotate_peer(
            base,
            session,
            &[(
                "swarmAutoReconnected",
                Value::String(instance_key.to_string()),
            )],
        )
    {
        *me = updated;
    }
}

/// Auto-bind root swarm coordinator or reconnect resumed coordinator/lead (`mailbox_hooks.py::swarm_coordinator_context`).
#[must_use]
pub fn swarm_coordinator_context(
    base: &Path,
    me: &mut Value,
    event: &str,
    mid_turn: bool,
) -> String {
    if me.get("isSubagent").is_some_and(paths::is_truthy_json)
        || me
            .get("agySubagentPending")
            .is_some_and(paths::is_truthy_json)
        || me.get("delegatedRun").is_some_and(paths::is_truthy_json)
        || identity::is_run_peer(Some(me))
    {
        return String::new();
    }
    let is_turn_start = matches!(event, "SessionStart" | "UserPromptSubmit")
        || (event == "PreInvocation" && !mid_turn);
    record_native_swarm_identity(base, me);

    let my_session = me
        .get("session")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let my_harness = me
        .get("harness")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let my_cwd = me
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let native_resume = env::var("ORKEST_RESUME_SWARM").as_deref() == Ok("1");
    let mut resumed_member = None;
    let room_id = if !native_resume {
        active_env_swarm_room(base)
    } else if is_turn_start {
        // A resume hint can recover a known binding. It cannot assign an unbound room
        // or create a new one.
        match resumed_swarm_membership(base, &my_session, &my_harness, &my_cwd) {
            Some(matched) if matched.member_id.is_empty() || matched.member_id == "conductor" => {
                matched
                    .room
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|room| rebind_resumed_conductor(base, room, &my_session, &my_cwd))
            }
            other => {
                resumed_member = other;
                None
            }
        }
    } else {
        None
    }
    .unwrap_or_default();
    if room_id.is_empty() {
        if !is_turn_start {
            return String::new();
        }
        let Some(matched) = resumed_member.or_else(|| {
            rooms_work::find_session_swarm_room(
                base,
                &my_session,
                Some(&my_harness),
                Some(&my_cwd),
                None,
            )
        }) else {
            return String::new();
        };
        let Some(m_room_id) = matched
            .room
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return String::new();
        };
        let member_id = if matched.member_id.is_empty() {
            "conductor".to_string()
        } else {
            matched.member_id
        };
        let mut room = matched.room;
        if matched.session_id != my_session {
            let Some(rebound) =
                rooms_work::rebind_session_swarm_room(base, &m_room_id, &member_id, &my_session)
            else {
                return String::new();
            };
            room = rebound;
        }
        let item_key = instance_key_for(me, &m_room_id);
        let restore_attempted = restore_known_swarm_view(base, me, &m_room_id, &item_key);
        let delivered = deliver_swarm_brief_or_summary(
            base,
            me,
            &room,
            &m_room_id,
            &member_id,
            &item_key,
            is_turn_start,
        );
        if restore_attempted {
            remember_swarm_restore(base, me, &item_key);
        }
        if !delivered.is_empty() {
            return delivered;
        }
        return if is_turn_start {
            swarm_next_advisor(base, me, room, &m_room_id, &member_id)
        } else {
            String::new()
        };
    }

    if !paths::valid_room_id(&room_id) {
        return String::new();
    }
    let Some(loaded_room) = sqlite::read_room(base, &room_id) else {
        return String::new();
    };
    if !rooms_work::is_open_room(&loaded_room)
        || !loaded_room.get("swarm").is_some_and(paths::is_truthy_json)
    {
        return String::new();
    }
    let mut room = loaded_room;
    let host = paths::current_hostname().unwrap_or_default();
    let conductor = room
        .get("conductor")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if !rooms_work::local_session_binding(&room, &conductor, &host) {
        return String::new();
    }
    let engine = if my_harness == "gemini" {
        "agy"
    } else {
        my_harness.as_str()
    };
    let candidate_ids = identity::native_session_ids(Some(me), Some(base));
    let mut bound_session = conductor
        .get("session")
        .and_then(|s| s.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let engine_matches = conductor.get("engine").and_then(Value::as_str) == Some(engine);
    let bound_in_candidates = bound_session
        .as_deref()
        .is_none_or(|b| b.is_empty() || candidate_ids.contains(b));
    if !engine_matches || !bound_in_candidates {
        if let Some(agents) = room.get("agents").and_then(Value::as_array).cloned() {
            for agent in agents {
                if !agent.is_object()
                    || agent.get("role").and_then(Value::as_str) != Some("lead")
                    || agent.get("engine").and_then(Value::as_str) != Some(engine)
                {
                    continue;
                }
                let lead_sid = agent
                    .get("session")
                    .and_then(|s| s.get("id"))
                    .and_then(Value::as_str);
                let owner = rooms_work::room_session_peer(base, &room, &agent, false);
                if let (Some(leader_sid), Some(own)) = (lead_sid, owner)
                    && candidate_ids.contains(leader_sid)
                    && own.get("session").and_then(Value::as_str) == Some(my_session.as_str())
                {
                    let member_id = agent
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if leader_sid != my_session && !member_id.is_empty() {
                        let Some(rebound) = rooms_work::rebind_session_swarm_room(
                            base,
                            &room_id,
                            &member_id,
                            &my_session,
                        ) else {
                            return String::new();
                        };
                        room = rebound;
                    }
                    let item_key = instance_key_for(me, &room_id);
                    if is_turn_start {
                        let delivered = deliver_swarm_brief_or_summary(
                            base, me, &room, &room_id, &member_id, &item_key, true,
                        );
                        if !delivered.is_empty() {
                            return delivered;
                        }
                    }
                    return if is_turn_start {
                        swarm_next_advisor(base, me, room, &room_id, &member_id)
                    } else {
                        String::new()
                    };
                }
            }
        }
        return String::new();
    }

    if bound_session.as_deref().is_some_and(|s| !s.is_empty()) {
        let Some(owner) = rooms_work::room_session_peer(base, &room, &conductor, true) else {
            return String::new();
        };
        if owner.get("session").and_then(Value::as_str) != Some(my_session.as_str()) {
            return String::new();
        }
    }
    if let Some(ref b) = bound_session
        && !b.is_empty()
        && b != &my_session
        && candidate_ids.contains(b)
    {
        let Some(rebound) =
            rooms_work::rebind_session_swarm_room(base, &room_id, "conductor", &my_session)
        else {
            return String::new();
        };
        room = rebound;
        bound_session = Some(my_session.clone());
    }
    let was_already_bound = bound_session.as_deref().is_some_and(|s| !s.is_empty());
    if !was_already_bound {
        rooms_work::bind_room_conductor(base, &room_id, engine, &my_session);
        if let Some(rebound) = sqlite::read_room(base, &room_id) {
            room = rebound;
            bound_session = room
                .get("conductor")
                .and_then(|c| c.get("session"))
                .and_then(|s| s.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if bound_session
            .as_deref()
            .is_some_and(|b| !b.is_empty() && b != my_session)
        {
            return String::new();
        }
    }

    let item_key = instance_key_for(me, &room_id);
    let is_prompt_turn = event == "UserPromptSubmit" || (event == "PreInvocation" && !mid_turn);
    let cli_launched_with_brief = !was_already_bound
        && room
            .get("objective")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty());
    if cli_launched_with_brief
        && me.get("swarmBriefed").and_then(Value::as_str) != Some(room_id.as_str())
        && let Some(updated) = identity::annotate_peer(
            base,
            &my_session,
            &[
                ("swarmBriefed", Value::String(room_id.clone())),
                ("swarmAutoReconnected", Value::String(item_key.clone())),
            ],
        )
    {
        *me = updated;
    }

    if is_prompt_turn || (was_already_bound && is_turn_start) {
        let restore_attempted =
            was_already_bound && restore_known_swarm_view(base, me, &room_id, &item_key);
        let allow_brief = (is_prompt_turn || native_resume) && !cli_launched_with_brief;
        let delivered = deliver_swarm_brief_or_summary(
            base,
            me,
            &room,
            &room_id,
            "conductor",
            &item_key,
            allow_brief,
        );
        if restore_attempted {
            remember_swarm_restore(base, me, &item_key);
        }
        if !delivered.is_empty() {
            return delivered;
        }
    }

    if is_turn_start {
        swarm_next_advisor(base, me, room, &room_id, "conductor")
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mailbox_lifecycle::tests::{EnvGuard, TEST_ENV_LOCK, TestDir, make_peer, save_peer};
    use serde_json::json;

    #[test]
    fn native_resume_hint_cannot_create_a_room_or_claim_an_inherited_room() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let directory = TestDir::new("ork-swarm-resume-intent");
        let base = directory.path.join("mailbox-v1");
        let cwd = directory.path.to_str().unwrap();
        let mut env = EnvGuard::new();
        env.set("HERDR_ENV", "0");
        env.set("ORKEST_RESUME_SWARM", "1");
        env.set("ORKEST_RESUME_TARGET", "ordinary-session");
        env.set("ORKEST_SWARM_ROOM", "existing-room");
        env.remove("CLAUDE_CODE_SESSION_ID");
        let room = json!({
            "schema": "agent-executor.room.v1",
            "id": "existing-room",
            "cwd": cwd,
            "updatedAt": 1000,
            "swarm": {"maxAgents": 4},
            "conductor": {"engine": "claude", "role": "lead"},
            "objective": "Existing swarm work",
            "agents": [],
        });
        paths::write_json_atomic(&base.join("rooms/existing-room.json"), &room).unwrap();

        let mut ordinary = make_peer("ordinary-session", "claude", cwd);
        save_peer(&base, &ordinary);
        assert_eq!(
            swarm_coordinator_context(&base, &mut ordinary, "SessionStart", false),
            ""
        );
        assert_eq!(sqlite::list_rooms(&base), vec![room]);
        assert!(!base.join("swarm-briefs").exists());
    }

    #[test]
    fn resume_finds_the_known_coordinator_whether_or_not_its_view_was_left_open() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let directory = TestDir::new("ork-swarm-resume-membership");
        let base = directory.path.join("mailbox-v1");
        let cwd = directory.path.to_str().unwrap();
        let mut env = EnvGuard::new();
        env.set("HERDR_ENV", "0");
        env.remove("ORKEST_SWARM_ROOM");
        env.remove("CLAUDE_CODE_SESSION_ID");
        let host = paths::current_hostname().unwrap();
        let room = json!({
            "schema": "agent-executor.room.v1",
            "id": "existing-room",
            "machine": host,
            "cwd": cwd,
            "updatedAt": 1000,
            "swarm": {"maxAgents": 4},
            "conductor": {
                "engine": "claude",
                "role": "lead",
                "session": {"id": "original-session", "engine": "claude", "machine": host, "cwd": cwd},
            },
            "objective": "Existing swarm work",
            "agents": [],
            // The view was closed: no saved open intent anywhere.
            "tmuxViewOpen": false,
        });
        paths::write_json_atomic(&base.join("rooms/existing-room.json"), &room).unwrap();

        env.set("ORKEST_RESUME_TARGET", "original-session");
        let matched = resumed_swarm_membership(&base, "forked-session", "claude", cwd).unwrap();
        assert_eq!(matched.room["id"], "existing-room");
        assert_eq!(matched.member_id, "conductor");

        // A session resuming itself, or resuming a conversation no room knows, has no membership.
        assert!(resumed_swarm_membership(&base, "original-session", "claude", cwd).is_none());
        env.set("ORKEST_RESUME_TARGET", "ordinary-session");
        assert!(resumed_swarm_membership(&base, "forked-session", "claude", cwd).is_none());
        assert_eq!(sqlite::list_rooms(&base), vec![room]);
    }

    #[test]
    fn test_match_side_and_swarm_commands() {
        assert_eq!(
            match_side_args("/side check ci"),
            Some("check ci".to_string())
        );
        assert_eq!(match_side_args("/orchestrate:side   "), Some(String::new()));
        assert_eq!(
            match_side_args("!side quick fix"),
            Some("quick fix".to_string())
        );
        assert_eq!(
            match_side_args("side: audit logs"),
            Some("audit logs".to_string())
        );
        assert_eq!(
            match_side_args("hello [orkest-side-command: --later fix]"),
            Some("--later fix".to_string())
        );

        assert_eq!(match_swarm_arg("/swarm"), Some(String::new()));
        assert_eq!(match_swarm_arg("/horde close"), Some("close".to_string()));
        assert_eq!(
            match_swarm_arg("/orchestrate:swarm ship PR 231"),
            Some("ship PR 231".to_string())
        );
        assert_eq!(
            match_swarm_arg("[orkest-swarm-command]"),
            Some(String::new())
        );
    }

    #[test]
    fn test_shell_split_lenient() {
        assert_eq!(
            shell_split_lenient("--investigate \"hello world\" 'two words'"),
            vec!["--investigate", "hello world", "two words"]
        );
    }
}
