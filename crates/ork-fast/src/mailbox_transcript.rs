//! Native JSONL transcript parsing, Antigravity turn/model/plan-mode detection, and subagent classification.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::identity;
use crate::paths;

pub const TRANSCRIPT_TAIL_BYTES: usize = 256 * 1024;

#[must_use]
pub fn default_agy_transcript(session: &str, account: Option<&str>) -> Option<PathBuf> {
    if session.trim().is_empty() {
        return None;
    }
    let home = account
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or_else(
            || paths::expand_home("~/.gemini", None),
            |s| paths::expand_home(s, None),
        );
    let candidate = home
        .join("antigravity-cli/brain")
        .join(session)
        .join(".system_generated/logs/transcript.jsonl");
    candidate.is_file().then_some(candidate)
}

#[must_use]
pub fn transcript_tail_entries(transcript_path: Option<&str>, max_bytes: usize) -> Vec<Value> {
    let Some(raw) = transcript_path.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let path = paths::expand_home(raw, None);
    let Ok(mut file) = File::open(&path) else {
        return Vec::new();
    };
    let Ok(size) = file.seek(SeekFrom::End(0)) else {
        return Vec::new();
    };
    let offset = size.saturating_sub(max_bytes as u64);
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let chunk = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = chunk.lines().collect();
    if offset > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let mut entries = Vec::new();
    for line in lines {
        if let Ok(val) = serde_json::from_str::<Value>(line)
            && val.is_object()
        {
            entries.push(val);
        }
    }
    entries
}

#[must_use]
pub fn agy_is_orchestrator_model(model: Option<&str>) -> bool {
    model.is_some_and(|m| m.trim().to_ascii_lowercase().contains("orchestrator"))
}

#[must_use]
pub fn agy_is_worker_model(model: Option<&str>) -> bool {
    let Some(m) = model else {
        return false;
    };
    let lower = m.trim().to_ascii_lowercase();
    (lower.contains("hydrogen") || lower.contains("-worker-")) && !lower.contains("orchestrator")
}

#[must_use]
pub fn entry_has_tool_call(entry: &Value, name: &str) -> bool {
    entry
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|calls| {
            calls
                .iter()
                .any(|c| c.get("name").and_then(Value::as_str) == Some(name))
        })
}

#[must_use]
pub fn clean_model_value(val: Option<&Value>) -> Option<String> {
    let v = val?;
    let s = if let Some(obj) = v.as_object() {
        obj.get("id")
            .and_then(Value::as_str)
            .filter(|x| !x.trim().is_empty())
            .or_else(|| {
                obj.get("model")
                    .and_then(Value::as_str)
                    .filter(|x| !x.trim().is_empty())
            })
            .or_else(|| {
                obj.get("name")
                    .and_then(Value::as_str)
                    .filter(|x| !x.trim().is_empty())
            })?
    } else {
        v.as_str()?
    };
    let stripped = s.trim();
    if stripped.is_empty() || stripped.eq_ignore_ascii_case("auto") || stripped.starts_with('<') {
        None
    } else {
        Some(stripped.to_string())
    }
}

fn agy_settings_model(entry: &Value) -> Option<String> {
    if entry.get("type").and_then(Value::as_str) != Some("USER_SETTINGS_CHANGE") {
        return None;
    }
    let model_keys = [
        "model",
        "modelName",
        "modelId",
        "requestedModel",
        "selectedModel",
    ];
    for key in model_keys {
        if let Some(found) = clean_model_value(entry.get(key)) {
            return Some(found);
        }
    }
    for container_key in ["settings", "userSettings", "userConfig", "config"] {
        if let Some(container) = entry.get(container_key).and_then(Value::as_object) {
            for key in model_keys {
                if let Some(found) = clean_model_value(container.get(key)) {
                    return Some(found);
                }
            }
            if let Some(planner) = container.get("plannerConfig").and_then(Value::as_object)
                && let Some(found) = clean_model_value(planner.get("planModel"))
            {
                return Some(found);
            }
        }
    }
    None
}

/// Infer `(phase_handoff, active_orchestrator_model, saw_turn_boundary)` within the current Antigravity turn.
#[must_use]
pub fn agy_transcript_phase_from_entries(entries: &[Value]) -> (bool, Option<String>, bool) {
    let mut phase_handoff = false;
    let mut checked_substantive = false;
    let mut saw_turn_boundary = false;
    let mut active_orchestrator_model: Option<String> = None;

    for entry in entries.iter().rev() {
        if entry.get("isSidechain").is_some_and(paths::is_truthy_json) {
            continue;
        }
        let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
        let source = entry.get("source").and_then(Value::as_str).unwrap_or("");
        if matches!(kind, "USER_INPUT" | "USER_SETTINGS_CHANGE") || source == "USER_EXPLICIT" {
            saw_turn_boundary = true;
            break;
        }
        if !checked_substantive && !matches!(kind, "GENERIC" | "EPHEMERAL_MESSAGE") {
            checked_substantive = true;
            phase_handoff = kind == "PLANNER_RESPONSE"
                && (entry_has_tool_call(entry, "exit_plan_mode")
                    || entry_has_tool_call(entry, "enter_plan_mode"));
        }
        if active_orchestrator_model.is_none()
            && kind == "PLANNER_RESPONSE"
            && entry_has_tool_call(entry, "exit_plan_mode")
        {
            let m = entry.get("model").and_then(Value::as_str);
            if agy_is_orchestrator_model(m)
                && let Some(ms) = m
            {
                active_orchestrator_model = Some(ms.trim().to_string());
            }
        }
        if checked_substantive && active_orchestrator_model.is_some() && saw_turn_boundary {
            break;
        }
    }
    (phase_handoff, active_orchestrator_model, saw_turn_boundary)
}

#[must_use]
pub fn agy_transcript_phase(transcript_path: Option<&str>) -> (bool, Option<String>, bool) {
    let entries = transcript_tail_entries(transcript_path, TRANSCRIPT_TAIL_BYTES);
    agy_transcript_phase_from_entries(&entries)
}

#[must_use]
pub fn latest_user_prompt(payload: &Value, session: &str, account: Option<&str>) -> Option<String> {
    for key in ["lastUserInput", "prompt", "userMessage", "query"] {
        if let Some(val) = payload.get(key).and_then(Value::as_str)
            && !val.trim().is_empty()
        {
            return Some(val.to_string());
        }
    }
    let raw_path = payload
        .get("transcript_path")
        .or_else(|| payload.get("transcriptPath"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(|s| paths::expand_home(s, None))
        .or_else(|| default_agy_transcript(session, account))?;
    let path_str = raw_path.to_string_lossy();
    for entry in transcript_tail_entries(Some(path_str.as_ref()), 16384)
        .into_iter()
        .rev()
    {
        let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(kind, "USER_INPUT" | "user") {
            let content = entry.get("content").and_then(Value::as_str).or_else(|| {
                entry
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_str)
            });
            return content.map(str::to_string);
        }
        if matches!(kind, "SYSTEM_MESSAGE" | "PLANNER_RESPONSE" | "assistant") {
            return None;
        }
    }
    None
}

#[must_use]
pub fn wake_notice_id(payload: &Value, session: &str, account: Option<&str>) -> Option<String> {
    let prompt = latest_user_prompt(payload, session, account)?;
    let needle = "Local peer mailbox notification (";
    let start = prompt.find(needle)? + needle.len();
    let rest = &prompt[start..];
    let end = rest.find(')')?;
    let candidate = &rest[..end];
    if !candidate.is_empty()
        && candidate
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        Some(candidate.to_string())
    } else {
        None
    }
}

fn parse_set_model_stdout(content: &str) -> Option<String> {
    let marker = "<local-command-stdout>Set model to ";
    let idx = content.find(marker)?;
    let rest = &content[idx + marker.len()..];
    let chosen = if let Some(inner) = rest.strip_prefix('`') {
        inner.split('`').next()?
    } else {
        rest.split(['\n', '<', '(']).next()?
    };
    let trimmed = chosen.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[must_use]
pub fn transcript_model(payload: &Value, transcript_path: Option<&str>) -> Option<String> {
    let raw_path = transcript_path.or_else(|| {
        payload
            .get("transcript_path")
            .or_else(|| payload.get("transcriptPath"))
            .and_then(Value::as_str)
    });
    let entries = transcript_tail_entries(raw_path, TRANSCRIPT_TAIL_BYTES);
    if entries.is_empty() {
        return None;
    }
    let (_, active_orchestrator_model, _) = agy_transcript_phase_from_entries(&entries);
    let mut fallback_worker_model: Option<String> = None;

    for entry in entries.iter().rev() {
        if entry.get("isSidechain").is_some_and(paths::is_truthy_json) {
            continue;
        }
        let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
        let source = entry.get("source").and_then(Value::as_str).unwrap_or("");
        if let Some(sm) = agy_settings_model(entry) {
            return Some(sm);
        }
        if matches!(kind, "USER_INPUT" | "USER_SETTINGS_CHANGE") || source == "USER_EXPLICIT" {
            if let Some(fw) = fallback_worker_model {
                return Some(fw);
            }
            continue;
        }
        if kind == "PLANNER_RESPONSE"
            && let Some(model) = clean_model_value(entry.get("model"))
        {
            if let Some(ref active) = active_orchestrator_model
                && agy_is_worker_model(Some(&model))
            {
                return Some(active.clone());
            }
            if agy_is_worker_model(Some(&model)) {
                if fallback_worker_model.is_none() {
                    fallback_worker_model = Some(model);
                }
                continue;
            }
            if let Some(fw) = fallback_worker_model {
                if entry_has_tool_call(entry, "exit_plan_mode")
                    && agy_is_orchestrator_model(Some(&model))
                {
                    return Some(model);
                }
                return Some(fw);
            }
            return Some(model);
        }
        let Some(message) = entry.get("message").and_then(Value::as_object) else {
            continue;
        };
        if kind == "assistant"
            && let Some(m) = message.get("model").and_then(Value::as_str)
        {
            let trimmed = m.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('<') {
                return Some(trimmed.to_string());
            }
        }
        if kind == "user"
            && let Some(content) = message.get("content").and_then(Value::as_str)
            && content.contains("<local-command-stdout>Set model to ")
            && let Some(chosen) = parse_set_model_stdout(content)
        {
            return Some(chosen);
        }
    }
    fallback_worker_model
}

fn parse_agy_subagent_sender(content: &str) -> Option<String> {
    let idx = content.find("<SYSTEM_MESSAGE>")?;
    let after = content[idx + "<SYSTEM_MESSAGE>".len()..].trim_start();
    let msg_line = after.strip_prefix("[Message]")?.lines().next()?;
    let mut search = msg_line;
    while let Some(pos) = search.find("sender=") {
        let word_boundary = pos == 0
            || !search.as_bytes()[pos - 1].is_ascii_alphanumeric()
                && search.as_bytes()[pos - 1] != b'_';
        let rest = &search[pos + "sender=".len()..];
        if word_boundary {
            let id: String = rest
                .chars()
                .take_while(|&c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
                .collect();
            if !id.is_empty() {
                return Some(id);
            }
        }
        search = rest;
    }
    None
}

/// Classify Antigravity session from opening 16 lines: `(is_subagent, parent, classified)`.
#[must_use]
pub fn agy_transcript_classified(transcript_path: Option<&str>) -> (bool, Option<String>, bool) {
    let Some(raw) = transcript_path.map(str::trim).filter(|s| !s.is_empty()) else {
        return (false, None, false);
    };
    let path = paths::expand_home(raw, None);
    let Ok(file) = File::open(&path) else {
        return (false, None, false);
    };
    let reader = BufReader::new(file);
    let mut sender_uuid: Option<String> = None;
    for line in reader.lines().take(16).flatten() {
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !entry.is_object() {
            continue;
        }
        if entry.get("source").and_then(Value::as_str) == Some("USER_EXPLICIT")
            || entry.get("type").and_then(Value::as_str) == Some("USER_INPUT")
        {
            return (false, None, true);
        }
        if sender_uuid.is_none()
            && entry.get("type").and_then(Value::as_str) == Some("SYSTEM_MESSAGE")
        {
            let content = entry.get("content").and_then(Value::as_str).or_else(|| {
                entry
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_str)
            });
            if let Some(text) = content
                && let Some(sid) = parse_agy_subagent_sender(text)
            {
                sender_uuid = Some(sid);
            }
        }
    }
    if let Some(sid) = sender_uuid {
        (true, Some(sid), true)
    } else {
        (false, None, false)
    }
}

/// Check busy co-hosted Gemini peers on the same PID for an active subagent launch in current turn.
#[must_use]
pub fn agy_cohosted_active_parent(
    base: &Path,
    session: &str,
    pid: Option<i64>,
    account: Option<&str>,
) -> (Option<String>, bool) {
    let Some(pid_val) = pid.filter(|&p| p > 0) else {
        return (None, false);
    };
    let Ok(entries) = fs::read_dir(base.join("peers")) else {
        return (None, false);
    };
    let now_secs = paths::utc_now_secs();
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(other) = paths::read_json_file(&p) else {
            continue;
        };
        if !paths::valid_peer(&other) {
            continue;
        }
        if other.get("session").and_then(Value::as_str) == Some(session)
            || other.get("harness").and_then(Value::as_str) != Some("gemini")
            || other.get("isSubagent").is_some_and(paths::is_truthy_json)
            || other
                .get("agySubagentPending")
                .is_some_and(paths::is_truthy_json)
            || other.get("delegatedRun").is_some_and(paths::is_truthy_json)
            || identity::is_run_peer(Some(&other))
            || other
                .get("pid")
                .and_then(|v| if v.is_boolean() { None } else { v.as_i64() })
                != Some(pid_val)
            || other.get("state").and_then(Value::as_str) != Some("busy")
            || other
                .get("lastStopReason")
                .is_some_and(paths::is_truthy_json)
            || !identity::is_live_peer(&other, Some(now_secs))
        {
            continue;
        }
        candidates.push(other);
    }
    if candidates.is_empty() {
        return (None, false);
    }
    candidates.sort_by(|a, b| {
        let sa = a.get("lastSeenAt").and_then(Value::as_str).unwrap_or("");
        let sb = b.get("lastSeenAt").and_then(Value::as_str).unwrap_or("");
        sb.cmp(sa)
    });
    let default_home = account
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or_else(
            || paths::expand_home("~/.gemini", None),
            |s| paths::expand_home(s, None),
        );
    for other in candidates {
        let Some(other_sid) = other.get("session").and_then(Value::as_str) else {
            continue;
        };
        let other_home = other
            .get("accountHome")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(|| default_home.clone(), |s| paths::expand_home(s, None));
        let t_path = other_home
            .join("antigravity-cli/brain")
            .join(other_sid)
            .join(".system_generated/logs/transcript.jsonl");
        let t_str = t_path.to_string_lossy();
        for entry in transcript_tail_entries(Some(t_str.as_ref()), 65536)
            .into_iter()
            .rev()
        {
            if entry.get("isSidechain").is_some_and(paths::is_truthy_json) {
                continue;
            }
            if entry.get("type").and_then(Value::as_str) == Some("USER_INPUT")
                || entry.get("source").and_then(Value::as_str) == Some("USER_EXPLICIT")
            {
                break;
            }
            if entry.get("type").and_then(Value::as_str) == Some("PLANNER_RESPONSE")
                && (entry_has_tool_call(&entry, "invoke_subagent")
                    || entry_has_tool_call(&entry, "swarm")
                    || entry_has_tool_call(&entry, "run_workflow"))
            {
                return (Some(other_sid.to_string()), true);
            }
        }
    }
    (None, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_agy_phase_and_transcript_model_and_subagent_classification() {
        let entries = vec![
            json!({"type": "USER_INPUT", "content": "hi"}),
            json!({"type": "PLANNER_RESPONSE", "model": "claude-orchestrator", "tool_calls": [{"name": "exit_plan_mode"}]}),
            json!({"type": "PLANNER_RESPONSE", "model": "hydrogen-worker-fast"}),
        ];
        let (phase_handoff, active_orch, boundary) = agy_transcript_phase_from_entries(&entries);
        assert!(!phase_handoff);
        assert_eq!(active_orch.as_deref(), Some("claude-orchestrator"));
        assert!(boundary);

        assert_eq!(
            parse_set_model_stdout(
                "<local-command-stdout>Set model to `opus-4-6`</local-command-stdout>"
            ),
            Some("opus-4-6".to_string())
        );
        assert_eq!(
            parse_agy_subagent_sender(
                "<SYSTEM_MESSAGE>\n[Message] foo=1 sender=parent-uuid-123\nhello"
            ),
            Some("parent-uuid-123".to_string())
        );
    }
}
