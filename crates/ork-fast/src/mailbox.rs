//! Native peer mailbox hook handler (`ork-fast mailbox-hook`).
//! Handles the fast path (<1 ms) and full turn lifecycle natively without Python fallback.

use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

use serde_json::{Value, json};

use crate::{
    identity, mailbox_lifecycle, mailbox_records, mailbox_swarm, mailbox_transcript, paths,
    rooms_work, sqlite, terminal,
};

fn is_valid_terminal_server(s: &str) -> bool {
    let Some(hex) = s.strip_prefix("orkest-label-") else {
        return false;
    };
    hex.len() == 12 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn check_slash_or_side_keywords(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("/side")
        || lower.contains("$side")
        || lower.contains("!side")
        || lower.contains("side:")
        || lower.contains("ork side")
        || lower.contains("[orkest-side-command")
        || lower.contains("/swarm")
        || lower.contains("/horde")
        || lower.contains("$swarm")
        || lower.contains("$horde")
        || lower.contains("[orkest-swarm")
        || lower.contains("/clear")
}

fn extract_model_str(val: &Value) -> Option<String> {
    let raw = if let Some(s) = val.as_str() {
        s
    } else {
        let obj = val.as_object()?;
        obj.get("id")
            .or_else(|| obj.get("model"))
            .or_else(|| obj.get("name"))
            .or_else(|| obj.get("display_name"))
            .and_then(Value::as_str)?
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") || trimmed.starts_with('<') {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn payload_changes_model(payload: &Value, peer: &Value) -> bool {
    if payload
        .get("modelSwitch")
        .is_some_and(paths::is_truthy_json)
    {
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
    let peer_model = peer.get("model").and_then(Value::as_str);
    if let Some(m) = payload
        .get("model")
        .or_else(|| payload.get("modelName"))
        .and_then(extract_model_str)
    {
        if peer_model != Some(m.as_str()) {
            return true;
        }
    } else if let Some(tm) = mailbox_transcript::transcript_model(payload, None)
        && peer_model != Some(tm.as_str())
    {
        return true;
    }
    false
}

fn update_peer_locked<F>(base: &Path, session: &str, mutate: F) -> bool
where
    F: FnOnce(&mut serde_json::Map<String, Value>) -> bool,
{
    mailbox_records::update_peer(base, session, mutate).is_some()
}

fn seen_colleagues_vec(peer: &Value) -> Vec<String> {
    peer.get("seenColleagues")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn is_eligible_for_name_announcement(peer: &Value) -> bool {
    let has_name = peer
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    has_name
        && !identity::is_run_peer(Some(peer))
        && !peer.get("isSubagent").is_some_and(paths::is_truthy_json)
        && !peer
            .get("agySubagentPending")
            .is_some_and(paths::is_truthy_json)
        && !peer.get("delegatedRun").is_some_and(paths::is_truthy_json)
}

/// Fast path returning `Some(())` when a trivial `Stop` or busy mid-turn `PreInvocation`
/// completes safely via atomic lock update without extra lookups or git invocations.
#[allow(clippy::too_many_arguments)]
fn try_fast_path_with_probe(
    base: &Path,
    harness: &str,
    gemini: bool,
    event: &str,
    session: &str,
    cwd: &str,
    payload: &Value,
    probe_cache: &mut Option<mailbox_lifecycle::HttpProbeOutcome>,
) -> Option<()> {
    if !matches!(event, "Stop" | "PreInvocation") {
        return None;
    }
    if payload.get("source").and_then(Value::as_str) == Some("clear") {
        return None;
    }
    for key in ["lastUserInput", "prompt", "userMessage", "query"] {
        if let Some(txt) = payload.get(key).and_then(Value::as_str)
            && check_slash_or_side_keywords(txt)
        {
            return None;
        }
    }
    let peer = mailbox_records::read_peer(base, session)?;
    if !paths::valid_peer(&peer) || peer.get("session").and_then(Value::as_str) != Some(session) {
        return None;
    }
    if peer.get("isSubagent").is_some_and(paths::is_truthy_json)
        || peer
            .get("agySubagentPending")
            .is_some_and(paths::is_truthy_json)
        || (gemini && peer.get("sharedProcess").is_some_and(paths::is_truthy_json))
        || peer.get("delegatedRun").is_some_and(paths::is_truthy_json)
        || peer.get("run").and_then(Value::as_str).is_some()
        || peer
            .get("pendingChiefTransfer")
            .is_some_and(paths::is_truthy_json)
        || env::var_os("ORKEST_HANDOFF_SUCCESSOR").is_some_and(|v| !v.is_empty())
    {
        return None;
    }
    if let Some(pid) = peer.get("pid").and_then(Value::as_i64)
        && !identity::is_pid_live(pid)
    {
        return None;
    }
    if peer.get("cwd").and_then(Value::as_str) != Some(cwd) {
        return None;
    }
    let daemon_mode = mailbox_lifecycle::classify_daemon_mode(base);
    if daemon_mode == mailbox_lifecycle::DaemonMode::NeedsFullCheck {
        return None;
    }
    if mailbox_records::has_unread(base, session) {
        return None;
    }
    if paths::has_active_room_for_session(base, session) {
        return None;
    }
    let cache = base.parent().unwrap_or(base);
    let peer_harness = peer
        .get("harness")
        .and_then(Value::as_str)
        .unwrap_or(harness);
    if paths::has_active_authority_for_session(cache, session, peer_harness) {
        return None;
    }
    if peer_harness != "claude" {
        let now_secs = paths::utc_now_secs();
        if mailbox_lifecycle::is_handoff_poll_eligible(base, &peer, now_secs) {
            let checked_recently = peer
                .get("handoffCheckedAt")
                .and_then(Value::as_str)
                .and_then(paths::parse_iso8601_utc_secs)
                .is_some_and(|t| (now_secs - t) < mailbox_lifecycle::HOOK_CHECK_SECONDS);
            if !checked_recently {
                return None;
            }
        }
    }

    if payload_changes_model(payload, &peer) {
        return None;
    }

    if event == "Stop" {
        let term_reason = if gemini {
            payload
                .get("terminationReason")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        } else {
            None
        };
        let updated = update_peer_locked(base, session, |obj| {
            obj.insert("state".to_string(), Value::String("idle".to_string()));
            obj.insert(
                "lastSeenAt".to_string(),
                Value::String(paths::format_utc_iso_z(paths::utc_now_secs())),
            );
            if let Some(ref reason) = term_reason {
                obj.insert("lastStopReason".to_string(), Value::String(reason.clone()));
            }
            true
        });
        if !updated {
            return None;
        }
        if gemini {
            println!("{{}}");
        }
        return Some(());
    }

    // PreInvocation fast path: non-gemini mid-turn busy session with unchanged roster, model, and HTTP health.
    if !gemini
        && peer.get("state").and_then(Value::as_str) == Some("busy")
        && peer.get("lastStopReason").is_none_or(Value::is_null)
        && !payload_changes_model(payload, &peer)
    {
        if daemon_mode == mailbox_lifecycle::DaemonMode::Http
            && (peer.get("httpIdentityAnnounced").and_then(Value::as_bool) != Some(true)
                || !peer
                    .get("httpAvailabilityIssue")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .is_empty())
        {
            return None;
        }
        let others = identity::colleagues(base, &peer);
        let (mates, _) = mailbox_lifecycle::split_channels(&peer, &others);
        let seen = mailbox_lifecycle::roster_key(&peer, &mates);
        if seen != seen_colleagues_vec(&peer) {
            return None;
        }
        if is_eligible_for_name_announcement(&peer)
            && peer.get("name").and_then(Value::as_str)
                != peer.get("announcedName").and_then(Value::as_str)
        {
            return None;
        }
        if daemon_mode == mailbox_lifecycle::DaemonMode::Http {
            let outcome =
                *probe_cache.get_or_insert_with(|| mailbox_lifecycle::probe_http_daemon(base));
            if outcome != mailbox_lifecycle::HttpProbeOutcome::CurrentHttp {
                return None;
            }
        }
        let updated = update_peer_locked(base, session, |obj| {
            if obj.get("state").and_then(Value::as_str) != Some("busy")
                || !obj.get("lastStopReason").is_none_or(Value::is_null)
            {
                return false;
            }
            obj.insert(
                "lastSeenAt".to_string(),
                Value::String(paths::format_utc_iso_z(paths::utc_now_secs())),
            );
            true
        });
        if updated {
            return Some(());
        }
    }
    None
}

#[allow(dead_code)]
fn try_fast_path(
    base: &Path,
    harness: &str,
    gemini: bool,
    event: &str,
    session: &str,
    cwd: &str,
    payload: &Value,
) -> Option<()> {
    try_fast_path_with_probe(
        base, harness, gemini, event, session, cwd, payload, &mut None,
    )
}

fn is_adopted_historical_session(canonical: &Value, raw_session: &str, canon_sid: &str) -> bool {
    if raw_session == canon_sid {
        return false;
    }
    let in_adopted = canonical
        .get("adoptedNativeIds")
        .and_then(Value::as_array)
        .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(raw_session)));
    let is_cleared_from = canonical.get("clearedFrom").and_then(Value::as_str) == Some(raw_session);
    in_adopted || is_cleared_from
}

/// Entrypoint for `ork-fast mailbox-hook` (`--fallback-script` accepted as a no-op flag).
pub fn run(
    harness_arg: Option<&str>,
    event_arg: Option<&str>,
    _fallback_script: Option<&Path>,
) -> io::Result<()> {
    let mut raw_stdin = Vec::new();
    if io::stdin().read_to_end(&mut raw_stdin).is_err() || raw_stdin.is_empty() {
        return Ok(());
    }
    let payload: Value = match serde_json::from_slice::<Value>(&raw_stdin) {
        Ok(v) if v.is_object() => v,
        _ => return Ok(()),
    };
    let base = paths::cache_home(None, None).join("mailbox-v1");
    if mailbox_records::ensure_at_entrypoint(&base) == mailbox_records::Backend::Invalid {
        // Never fall back to the legacy files of a root that is migrating or fenced.
        eprintln!(
            "orkest mailbox: the mailbox store is mid-migration or its writer fence is broken; \
             skipping this hook until the migration finishes or the fence is repaired."
        );
        return Ok(());
    }
    run_on_base(&base, harness_arg, event_arg, &payload, &mut io::stdout())
}

fn run_on_base(
    base: &Path,
    harness_arg: Option<&str>,
    event_arg: Option<&str>,
    payload: &Value,
    out_stream: &mut dyn Write,
) -> io::Result<()> {
    let tool_name = payload
        .get("tool_name")
        .or_else(|| payload.get("toolName"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if tool_name == "ExitPlanMode" || tool_name == "EnterPlanMode" {
        return Ok(());
    }

    let harness = harness_arg
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| identity::detect_harness(payload));

    let event = event_arg
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            payload
                .get("hook_event_name")
                .or_else(|| payload.get("event"))
                .or_else(|| payload.get("eventName"))
                .or_else(|| payload.get("hookEventName"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
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
    let Some(event) = event else {
        return Ok(());
    };

    let session_raw = payload
        .get("session_id")
        .or_else(|| payload.get("conversationId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            env::var("ANTIGRAVITY_CONVERSATION_ID")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    let Some(native_session) = session_raw else {
        return Ok(());
    };
    let mut session = native_session.clone();
    let gemini = harness == "gemini";

    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            payload
                .get("workspacePaths")
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".to_string())
        });

    let base = base.to_path_buf();
    let mut resolved_canonical: Option<Value> = None;
    if let Some(canonical) =
        identity::session_peer(&base, &session, Some(&harness), Some(&cwd), false)
        && let Some(canon_sid) = canonical.get("session").and_then(Value::as_str)
    {
        session = canon_sid.to_string();
        resolved_canonical = Some(canonical);
    }
    let historical_adopted = resolved_canonical.as_ref().is_some_and(|canonical| {
        is_adopted_historical_session(canonical, &native_session, &session)
    });

    match event.as_str() {
        "SessionEnd" => {
            let reason = payload.get("reason").and_then(Value::as_str).unwrap_or("");
            if reason == "clear"
                && let Some(ref canonical) = resolved_canonical
                && is_adopted_historical_session(canonical, &native_session, &session)
            {
                return Ok(());
            }
            let parent_to_refresh = mailbox_records::read_peer(&base, &session)
                .filter(|p| p.get("isSubagent").is_some_and(paths::is_truthy_json))
                .and_then(|p| {
                    p.get("parentSession")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .filter(|s| !s.is_empty());
            mailbox_lifecycle::end_session(
                &base,
                &session,
                reason,
                identity::harness_pid(&harness),
            );
            if let Some(parent) = parent_to_refresh {
                let _ = terminal::refresh_parent_pane(&base, Some(&parent));
            }
            return Ok(());
        }
        "StopFailure" => {
            mailbox_lifecycle::handle_stop_failure(&base, payload, &session, &harness);
            return Ok(());
        }
        "SubagentStart" => {
            let out =
                mailbox_lifecycle::handle_subagent_start(&base, payload, &session, &harness, &cwd);
            let _ = writeln!(out_stream, "{out}");
            return Ok(());
        }
        "SubagentStop" => {
            let out = mailbox_lifecycle::handle_subagent_stop(&base, payload, &session, &harness);
            let _ = writeln!(out_stream, "{out}");
            return Ok(());
        }
        _ => {}
    }

    let state = match event.as_str() {
        "SessionStart" => "idle",
        "UserPromptSubmit" => "busy",
        "PreInvocation" => "busy",
        "Stop" => "idle",
        _ => return Ok(()),
    };

    let mut http_probe_cache: Option<mailbox_lifecycle::HttpProbeOutcome> = None;
    if session == native_session
        && !historical_adopted
        && try_fast_path_with_probe(
            &base,
            &harness,
            gemini,
            &event,
            &session,
            &cwd,
            payload,
            &mut http_probe_cache,
        )
        .is_some()
    {
        if gemini && event == "Stop" {
            // try_fast_path_with_probe already wrote "{}" to stdout; keep exact parity.
        }
        return Ok(());
    }

    // Full lifecycle path matching mailbox_hooks.py::hook (lines 1770-2265).
    let raw_transcript = payload
        .get("transcript_path")
        .or_else(|| payload.get("transcriptPath"))
        .and_then(Value::as_str);
    let account_home_dir = identity::account_home(&harness, raw_transcript);
    let explicit_transcript = raw_transcript.map(str::trim).filter(|s| !s.is_empty());
    let transcript_file = if let Some(raw_path) = explicit_transcript {
        mailbox_transcript::open_explicit_transcript(raw_path)
    } else if gemini {
        mailbox_transcript::open_default_agy_transcript(&session, account_home_dir.as_deref())
    } else {
        None
    };

    let mut runtime_model = mailbox_transcript::clean_model_value(
        payload.get("model").or_else(|| payload.get("modelName")),
    );
    if runtime_model.is_none()
        && let Some(ref tf) = transcript_file
    {
        runtime_model = mailbox_transcript::transcript_model_from_file(tf);
    }
    let mut runtime_effort_val = identity::runtime_effort(&harness, payload);
    if harness == "codex" && (runtime_model.is_none() || runtime_effort_val.is_none()) {
        let (db_model, db_effort) =
            mailbox_lifecycle::codex_sqlite_settings(account_home_dir.as_deref(), &session);
        if runtime_model.is_none() {
            runtime_model = db_model;
        }
        if runtime_effort_val.is_none() {
            runtime_effort_val = db_effort;
        }
    }

    let previous = mailbox_records::read_peer(&base, &session);
    let previous_valid = previous.as_ref().is_some_and(paths::valid_peer);
    let has_transcript = transcript_file.is_some();

    let mut subagent_name: Option<String> = None;
    let mut subagent_source: Option<String> = None;
    let mut parent_session_source: Option<String> = None;
    let mut decisive_toplevel = false;
    let mut agy_pending = false;
    let (is_subagent, parent_session) = if gemini {
        let valid_source = |key: &str| -> Option<String> {
            if !previous_valid {
                return None;
            }
            previous
                .as_ref()
                .and_then(|p| p.get(key))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| matches!(*s, "sqlite" | "transcript" | "cohosted"))
                .map(str::to_string)
        };
        let prev_is_sub = previous_valid
            && previous
                .as_ref()
                .is_some_and(|p| p.get("isSubagent").is_some_and(paths::is_truthy_json));
        let prev_source = valid_source("subagentSource");
        let mut is_sub = prev_is_sub;
        let mut parent = if prev_is_sub {
            previous
                .as_ref()
                .and_then(|p| p.get("parentSession"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        } else {
            None
        };
        if prev_is_sub {
            subagent_source = prev_source.clone();
            if parent.is_some() {
                parent_session_source =
                    valid_source("parentSessionSource").or_else(|| prev_source.clone());
            }
        }
        let db_state = sqlite::agy_sqlite_subagent_state(account_home_dir.as_deref(), &session);
        if db_state.is_subagent {
            is_sub = true;
            subagent_source = Some("sqlite".to_string());
            if let Some(db_parent) = db_state.parent_session {
                parent = Some(db_parent);
                parent_session_source = Some("sqlite".to_string());
            }
        }
        if db_state.agent_name.is_some() {
            subagent_name = db_state.agent_name;
        }
        let (tr_sub, tr_parent, tr_classified) = transcript_file.as_ref().map_or(
            (false, None, false),
            mailbox_transcript::agy_transcript_classified_from_file,
        );
        let prev_sqlite_confirmed = prev_source.as_deref() == Some("sqlite");
        let db_cleared = db_state.db_available && db_state.classified && !db_state.is_subagent;
        if tr_sub {
            is_sub = true;
            if subagent_source.as_deref() != Some("sqlite") {
                subagent_source = Some("transcript".to_string());
            }
            if let Some(tp) = tr_parent
                && parent_session_source.as_deref() != Some("sqlite")
                && (parent.is_none() || parent_session_source.as_deref() == Some("cohosted"))
            {
                parent = Some(tp);
                parent_session_source = Some("transcript".to_string());
            }
        } else if db_cleared || (!db_state.is_subagent && tr_classified && !prev_sqlite_confirmed) {
            decisive_toplevel = true;
            is_sub = false;
            parent = None;
            subagent_name = None;
            subagent_source = None;
            parent_session_source = None;
        }
        let classified = is_sub || db_state.classified || tr_classified;
        if !classified {
            let (cohosted_parent, saw_busy_cohosted) =
                mailbox_transcript::agy_cohosted_active_parent(
                    &base,
                    &session,
                    identity::harness_pid(&harness),
                    account_home_dir.as_deref(),
                );
            if let Some(cp) = cohosted_parent {
                is_sub = true;
                if parent.is_none() {
                    parent = Some(cp);
                    parent_session_source = Some("cohosted".to_string());
                }
                if subagent_source.is_none() {
                    subagent_source = Some("cohosted".to_string());
                }
            } else if saw_busy_cohosted || has_transcript {
                agy_pending = true;
            }
        }
        (is_sub, parent)
    } else {
        (false, None)
    };

    let (phase_handoff, active_orchestrator_model, saw_turn_boundary) = if gemini {
        transcript_file.as_ref().map_or(
            (false, None, false),
            mailbox_transcript::agy_transcript_phase_from_file,
        )
    } else {
        (false, None, false)
    };

    let prev_session_model = if previous_valid {
        previous
            .as_ref()
            .and_then(|p| {
                p.get("sessionModel")
                    .filter(|v| paths::is_truthy_json(v))
                    .or_else(|| p.get("model"))
            })
            .and_then(Value::as_str)
            .map(str::to_string)
    } else {
        None
    };
    let explicit_session_model = mailbox_transcript::clean_model_value(
        payload
            .get("sessionModel")
            .or_else(|| payload.get("session_model")),
    );
    let explicit_step_model = mailbox_transcript::clean_model_value(
        payload
            .get("stepModel")
            .or_else(|| payload.get("step_model"))
            .or_else(|| payload.get("workerModel"))
            .or_else(|| payload.get("subagentModel")),
    );
    let mut primary_model = explicit_session_model
        .clone()
        .or_else(|| runtime_model.clone());
    let mut execution_model: Option<String> = None;

    if gemini {
        if let Some(ref orch) = active_orchestrator_model
            && (primary_model.is_none()
                || mailbox_transcript::agy_is_worker_model(primary_model.as_deref()))
        {
            if primary_model.as_deref() != Some(orch.as_str()) {
                execution_model = primary_model.clone();
            }
            primary_model = Some(orch.clone());
        } else if (!has_transcript || !saw_turn_boundary)
            && previous_valid
            && mailbox_transcript::agy_is_orchestrator_model(prev_session_model.as_deref())
            && mailbox_transcript::agy_is_worker_model(primary_model.as_deref())
        {
            execution_model = primary_model.clone();
            primary_model = prev_session_model.clone();
        }
    }
    if let Some(ref esm) = explicit_step_model {
        execution_model = Some(esm.clone());
        if let Some(ref prev_sm) = prev_session_model
            && matches!(event.as_str(), "PreInvocation" | "Stop")
            && explicit_session_model.is_none()
        {
            primary_model = Some(prev_sm.clone());
        }
    } else if !gemini
        && event == "PreInvocation"
        && previous_valid
        && let Some(ref prev_sm) = prev_session_model
        && let Some(ref pm) = primary_model
        && pm != prev_sm
        && explicit_session_model.is_none()
        && !payload
            .get("modelSwitch")
            .is_some_and(paths::is_truthy_json)
    {
        execution_model = Some(pm.clone());
        primary_model = Some(prev_sm.clone());
    }

    let session_model = primary_model.or(prev_session_model);
    let step_model = execution_model
        .clone()
        .or(runtime_model)
        .or_else(|| session_model.clone());
    if execution_model.is_some() && execution_model == session_model {
        execution_model = None;
    }

    let mid_turn = event == "PreInvocation"
        && previous_valid
        && previous
            .as_ref()
            .is_some_and(|p| p.get("state").and_then(Value::as_str) == Some("busy"));

    let mut me = match identity::register_peer(
        &base,
        identity::RegisterArgs {
            session: &session,
            harness: &harness,
            cwd: &cwd,
            pid: identity::harness_pid(&harness),
            state: Some(state),
            cwd_source: Some("hook"),
            model: session_model.as_deref(),
            model_source: "runtime",
            session_model: session_model.as_deref(),
            step_model: step_model.as_deref(),
            account: account_home_dir.as_deref(),
            effort: runtime_effort_val.as_deref(),
        },
    ) {
        Some(p) => p,
        None => return Ok(()),
    };

    let current_session_model = me
        .get("sessionModel")
        .filter(|v| paths::is_truthy_json(v))
        .or_else(|| me.get("model"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(ref em) = execution_model
        && Some(em.as_str()) != current_session_model.as_deref()
    {
        if me.get("executionModel").and_then(Value::as_str) != Some(em.as_str())
            && let Some(upd) =
                identity::annotate_peer(&base, &session, &[("executionModel", json!(em))])
        {
            me = upd;
        }
    } else if me.get("executionModel").is_some_and(|v| !v.is_null())
        && let Some(upd) =
            identity::annotate_peer(&base, &session, &[("executionModel", Value::Null)])
    {
        me = upd;
    }

    me = identity::mark_delegated(&base, me);
    if gemini
        && !is_subagent
        && decisive_toplevel
        && (me.get("isSubagent").is_some()
            || me.get("parentSession").is_some()
            || me.get("subagentSource").is_some()
            || me.get("parentSessionSource").is_some())
        && paths::session_key(&session).is_ok()
    {
        update_peer_locked(&base, &session, |obj| {
            let removed_sub = obj.remove("isSubagent").is_some();
            let removed_parent = obj.remove("parentSession").is_some();
            let removed_source = obj.remove("subagentSource").is_some();
            let removed_parent_source = obj.remove("parentSessionSource").is_some();
            removed_sub || removed_parent || removed_source || removed_parent_source
        });
        if let Some(reloaded) = mailbox_records::read_peer(&base, &session) {
            me = reloaded;
        }
    }
    let suppress_toplevel =
        is_subagent || me.get("isSubagent").is_some_and(paths::is_truthy_json) || agy_pending;

    if !suppress_toplevel
        && matches!(
            event.as_str(),
            "SessionStart" | "UserPromptSubmit" | "PreInvocation"
        )
    {
        mailbox_lifecycle::confirm_handoff_pane_start(&base, &session);
    }

    if !suppress_toplevel
        && !me.get("delegatedRun").is_some_and(paths::is_truthy_json)
        && !historical_adopted
        && !is_adopted_historical_session(&me, &native_session, &session)
        && let Some(attested) =
            identity::attest_native_sessions(&base, &session, &[native_session.as_str()])
    {
        me = attested;
    }

    if agy_pending && !is_subagent {
        if me.get("agySubagentPending") != Some(&Value::Bool(true))
            && let Some(upd) =
                identity::annotate_peer(&base, &session, &[("agySubagentPending", json!(true))])
        {
            me = upd;
        }
    } else if me.get("agySubagentPending").is_some_and(|v| !v.is_null())
        && let Some(upd) =
            identity::annotate_peer(&base, &session, &[("agySubagentPending", Value::Null)])
    {
        me = upd;
    }

    if is_subagent {
        let mut updates: Vec<(&str, Value)> = vec![("isSubagent", json!(true))];
        if let Some(ref ps) = parent_session {
            updates.push(("parentSession", json!(ps)));
        }
        if let Some(ref src) = subagent_source {
            updates.push(("subagentSource", json!(src)));
        }
        if let Some(ref psrc) = parent_session_source {
            updates.push(("parentSessionSource", json!(psrc)));
        }
        if let Some(ref sn) = subagent_name
            && !me.get("focus").is_some_and(paths::is_truthy_json)
        {
            let truncated: String = sn.chars().take(60).collect();
            updates.push(("focus", json!(format!("native {truncated}"))));
        }
        for key in [
            "terminalServer",
            "herdrPaneId",
            "herdrWorkspaceId",
            "herdrEndpoint",
            "herdrBinary",
            "agySubagentPending",
            "nativeSession",
            "nativeSessions",
            "nativeSessionAttestation",
        ] {
            let in_me = me.get(key).is_some_and(|v| !v.is_null());
            let in_prev = previous_valid
                && previous
                    .as_ref()
                    .and_then(|p| p.get(key))
                    .is_some_and(|v| !v.is_null());
            if in_me || in_prev {
                updates.push((key, Value::Null));
            }
        }
        let changed = updates.iter().any(|(k, v)| me.get(*k) != Some(v));
        if changed && let Some(upd) = identity::annotate_peer(&base, &session, &updates) {
            me = upd;
        }
    }

    if !suppress_toplevel && !me.get("delegatedRun").is_some_and(paths::is_truthy_json) {
        let terminal_server = env::var("ORKEST_TERMINAL_SERVER")
            .ok()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if is_valid_terminal_server(&terminal_server)
            && me.get("terminalServer").and_then(Value::as_str) != Some(terminal_server.as_str())
            && let Some(upd) = identity::annotate_peer(
                &base,
                &session,
                &[("terminalServer", json!(terminal_server))],
            )
        {
            me = upd;
        }
        if mailbox_swarm::herdr_active() && harness != "codex" {
            if me.get("terminalServer").is_some_and(|v| !v.is_null())
                && let Some(upd) =
                    identity::annotate_peer(&base, &session, &[("terminalServer", Value::Null)])
            {
                me = upd;
            }
            let herdr_pane = env::var("HERDR_PANE_ID")
                .ok()
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            let herdr_workspace = env::var("HERDR_WORKSPACE_ID")
                .ok()
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            let herdr_binary = env::var("HERDR_BIN_PATH")
                .ok()
                .filter(|s| !s.is_empty())
                .or_else(|| paths::find_in_path("herdr").map(|p| p.to_string_lossy().into_owned()));
            let endpoint = terminal::herdr_endpoint();
            let mut herdr_fields: Vec<(&str, Value)> = Vec::new();
            if !herdr_pane.is_empty()
                && me.get("herdrPaneId").and_then(Value::as_str) != Some(herdr_pane.as_str())
            {
                herdr_fields.push(("herdrPaneId", json!(herdr_pane)));
            }
            if !herdr_workspace.is_empty()
                && me.get("herdrWorkspaceId").and_then(Value::as_str)
                    != Some(herdr_workspace.as_str())
            {
                herdr_fields.push(("herdrWorkspaceId", json!(herdr_workspace)));
            }
            if !herdr_pane.is_empty()
                && me.get("herdrEndpoint").and_then(Value::as_str) != Some(endpoint.as_str())
            {
                herdr_fields.push(("herdrEndpoint", json!(endpoint)));
            }
            if !herdr_pane.is_empty()
                && let Some(ref hb) = herdr_binary
                && me.get("herdrBinary").and_then(Value::as_str) != Some(hb.as_str())
            {
                herdr_fields.push(("herdrBinary", json!(hb)));
            }
            if !herdr_fields.is_empty()
                && let Some(upd) = identity::annotate_peer(&base, &session, &herdr_fields)
            {
                me = upd;
            }
        } else if harness != "codex" || !terminal_server.is_empty() {
            let stale: Vec<(&str, Value)> = [
                "herdrPaneId",
                "herdrWorkspaceId",
                "herdrEndpoint",
                "herdrBinary",
                "herdrSyncedTitle",
                "herdrSyncedTarget",
                "herdrSyncedAt",
            ]
            .into_iter()
            .filter(|k| me.get(*k).is_some_and(|v| !v.is_null()))
            .map(|k| (k, Value::Null))
            .collect();
            if !stale.is_empty()
                && let Some(upd) = identity::annotate_peer(&base, &session, &stale)
            {
                me = upd;
            }
        }
    }

    if (event == "SessionStart" || (gemini && event == "PreInvocation" && previous.is_none()))
        && (!me.get("delegatedRun").is_some_and(paths::is_truthy_json)
            || (harness == "claude" && event == "SessionStart"))
    {
        mailbox_lifecycle::bootstrap_repo_env(&base, &session, &cwd, &harness, &event);
    }
    if event == "SessionStart" && !suppress_toplevel {
        mailbox_lifecycle::maybe_trigger_auto_update(&base, &me, &event);
    }

    if gemini
        && event == "Stop"
        && let Some(reason) = payload
            .get("terminationReason")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    {
        if let Some(upd) =
            identity::annotate_peer(&base, &session, &[("lastStopReason", json!(reason))])
        {
            me = upd;
        }
    } else if me.get("lastStopReason").is_some_and(paths::is_truthy_json)
        && matches!(
            event.as_str(),
            "SessionStart" | "UserPromptSubmit" | "PreInvocation"
        )
        && let Some(upd) =
            identity::annotate_peer(&base, &session, &[("lastStopReason", Value::Null)])
    {
        me = upd;
    }

    if gemini && (is_subagent || me.get("isSubagent").is_some_and(paths::is_truthy_json)) {
        mailbox_lifecycle::sync_agy_subagent_progress(
            &base,
            &me,
            &event,
            payload,
            subagent_name.as_deref(),
        );
    }

    let mut cleared_notice = String::new();
    if event == "SessionStart"
        && payload.get("source").and_then(Value::as_str) == Some("clear")
        && !me.get("delegatedRun").is_some_and(paths::is_truthy_json)
        && !suppress_toplevel
    {
        cleared_notice = mailbox_lifecycle::adopt_cleared(&base, &mut me);
        if let Some(reloaded) = mailbox_records::read_peer(&base, &session) {
            me = reloaded;
        }
    } else if matches!(
        event.as_str(),
        "SessionStart" | "UserPromptSubmit" | "PreInvocation" | "Stop"
    ) && !me.get("delegatedRun").is_some_and(paths::is_truthy_json)
        && !suppress_toplevel
    {
        mailbox_lifecycle::retry_pending_chief_transfer(&base, &mut me);
    }

    if !suppress_toplevel && !me.get("delegatedRun").is_some_and(paths::is_truthy_json) {
        let allow_herdr = !mailbox_lifecycle::in_isolated_test_mode()
            || env::var("ORKEST_TEST_ALLOW_HERDR").as_deref() == Ok("1");
        let shared_codex = harness == "codex"
            && allow_herdr
            && (terminal::discovery_available()
                || me.get("herdrPaneId").is_some_and(paths::is_truthy_json));
        if !mid_turn
            && (mailbox_swarm::herdr_active()
                || shared_codex
                || terminal::has_terminal_or_orca_context(Some(&harness)))
        {
            terminal::bind_terminal(
                &base,
                session.clone(),
                Some(&harness),
                payload,
                event == "SessionStart",
            );
        }
    } else if (is_subagent || me.get("isSubagent").is_some_and(paths::is_truthy_json)) && !mid_turn
    {
        let target_parent = parent_session.as_deref().or_else(|| {
            me.get("parentSession")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        });
        if target_parent.is_some() {
            let _ = terminal::refresh_parent_pane(&base, target_parent);
        }
    }

    let lifecycle_turn = matches!(
        event.as_str(),
        "SessionStart" | "UserPromptSubmit" | "PreInvocation" | "Stop"
    );
    if !suppress_toplevel && lifecycle_turn {
        let _ = rooms_work::renew_workboard_leases(&base, &me, false);
    }

    let team_notice = if lifecycle_turn {
        mailbox_lifecycle::succession_notice(&base, &me)
    } else {
        String::new()
    };
    let stop_can_continue = event == "Stop"
        && !phase_handoff
        && !(gemini
            && payload
                .get("terminationReason")
                .and_then(Value::as_str)
                .is_some_and(|reason| {
                    mailbox_lifecycle::ANTIGRAVITY_NO_CONTINUE.contains(&reason)
                }));
    let handoff_notice = if !is_subagent && lifecycle_turn {
        if event == "Stop" {
            mailbox_lifecycle::handoff_on_event(
                &base,
                &me,
                false,
                stop_can_continue,
                payload
                    .get("transcript_path")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            )
        } else {
            mailbox_lifecycle::handoff_turn(
                &base,
                &me,
                matches!(event.as_str(), "SessionStart" | "UserPromptSubmit")
                    || (event == "PreInvocation" && !mid_turn),
            )
        }
    } else {
        String::new()
    };

    if (matches!(event.as_str(), "SessionStart" | "UserPromptSubmit")
        || (event == "PreInvocation" && !mid_turn))
        && let Ok(s_key) = paths::session_key(&session)
    {
        let wake_dir = base.join("wakes").join(s_key);
        for marker in ["agy-wake.json", "claude-wake.json"] {
            let _ = fs::remove_file(wake_dir.join(marker));
        }
    }

    let (identity_hint, availability_hint) = mailbox_lifecycle::check_http_daemon_with_probe(
        &base,
        &mut me,
        &event,
        mid_turn,
        &mut http_probe_cache,
    );

    if gemini && event == "Stop" {
        if let Some(tr) = payload.get("terminationReason").and_then(Value::as_str)
            && mailbox_lifecycle::ANTIGRAVITY_NO_CONTINUE.contains(&tr)
        {
            let _ = writeln!(out_stream, "{{}}");
            return Ok(());
        }
        if phase_handoff {
            let _ = writeln!(out_stream, "{{}}");
            return Ok(());
        }
    }

    let route_hint = if event == "SessionStart" && !suppress_toplevel {
        mailbox_lifecycle::wake_route_hint(&base, &me)
    } else {
        String::new()
    };
    let swarm_toggle = if !suppress_toplevel {
        mailbox_swarm::swarm_command_context(&base, &me, payload, &event, mid_turn)
    } else {
        String::new()
    };
    let side_notice = if !suppress_toplevel {
        mailbox_swarm::side_command_context(&base, &me, payload, &event, mid_turn)
    } else {
        String::new()
    };
    let is_swarm_goal = swarm_toggle.starts_with("[orkest-swarm-goal] ");
    let intercept_notice = if !side_notice.is_empty() {
        side_notice.as_str()
    } else if !is_swarm_goal {
        swarm_toggle.as_str()
    } else {
        ""
    };
    if !intercept_notice.is_empty() && !mid_turn {
        if event == "UserPromptSubmit" && !gemini {
            identity::annotate_peer(&base, &session, &[("state", json!("idle"))]);
            let _ = writeln!(
                out_stream,
                "{}",
                json!({"decision": "block", "reason": intercept_notice})
            );
            return Ok(());
        }
        if gemini && event == "PreInvocation" {
            identity::annotate_peer(&base, &session, &[("state", json!("idle"))]);
            let _ = writeln!(
                out_stream,
                "{}",
                json!({
                    "injectSteps": [{
                        "systemMessage": {
                            "systemMessage": "",
                            "metadata": {"user_markdown": intercept_notice},
                        }
                    }],
                    "terminationBehavior": "terminate",
                })
            );
            return Ok(());
        }
    }

    let turn_start_context = matches!(event.as_str(), "SessionStart" | "UserPromptSubmit")
        || (gemini && event == "PreInvocation" && !mid_turn);
    let swarm_brief = if !suppress_toplevel && turn_start_context {
        mailbox_swarm::swarm_coordinator_context(&base, &mut me, &event, mid_turn)
    } else {
        String::new()
    };
    let mut progress_hint = String::new();
    let mut help_hint = String::new();
    if !suppress_toplevel && turn_start_context {
        progress_hint = rooms_work::progress_reminder(&base, &me, event == "SessionStart");
        help_hint = rooms_work::help_board_hint(&base, &me, previous.as_ref());
    }

    let resting = event == "Stop" && mailbox_lifecycle::handoff_resting_at_stop(&base, &session);
    let delivered = if resting {
        Vec::new()
    } else {
        mailbox_lifecycle::take(&base, &session, event == "Stop" || mid_turn, 20)
    };
    let mut stale_wake_notice = String::new();
    if matches!(event.as_str(), "UserPromptSubmit" | "PreInvocation")
        && !mid_turn
        && delivered.is_empty()
        && let Some(notice_id) = mailbox_transcript::wake_notice_id(
            payload,
            &session,
            me.get("accountHome").and_then(Value::as_str),
        )
    {
        let existing_mail = mailbox_records::read_message(&base, &session, &notice_id);
        if let Some(read_at) = existing_mail
            .as_ref()
            .and_then(|m| m.get("readAt"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            stale_wake_notice = format!(
                "Mailbox notification ({notice_id}) was already delivered and marked read in an earlier turn \
                 (at {read_at}); no unread peer messages remain. Do not call inbox or ack—finish immediately."
            );
        } else {
            stale_wake_notice = format!(
                "Mailbox notification ({notice_id}) has no unread messages waiting in your inbox. \
                 Do not call inbox or ack—finish immediately."
            );
        }
    }

    let me_name = me
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut context = mailbox_lifecycle::render_all(&delivered, Some(&me_name));
    let update_notice = if event == "SessionStart" && !suppress_toplevel {
        mailbox_lifecycle::update_notice(&base, &me)
    } else {
        String::new()
    };

    let hint_parts: Vec<&str> = [
        side_notice.as_str(),
        swarm_toggle.as_str(),
        swarm_brief.as_str(),
        cleared_notice.as_str(),
        update_notice.as_str(),
        team_notice.as_str(),
        handoff_notice.as_str(),
        identity_hint.as_str(),
        availability_hint.as_str(),
        route_hint.as_str(),
        progress_hint.as_str(),
        help_hint.as_str(),
        stale_wake_notice.as_str(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect();
    if !hint_parts.is_empty() {
        let hint = hint_parts.join("\n");
        context = if context.is_empty() {
            hint
        } else {
            format!("{hint}\n\n{context}")
        };
    }

    if event == "Stop" && !suppress_toplevel && !resting && handoff_notice.is_empty() {
        mailbox_lifecycle::continuation_at_stop(&base, &me);
    }
    if event == "Stop" {
        if delivered.is_empty() && handoff_notice.is_empty() {
            if gemini {
                let _ = writeln!(out_stream, "{{}}");
            }
            return Ok(());
        }
        let msg_ids: Vec<String> = delivered
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let msg_bytes: usize = delivered
            .iter()
            .filter_map(|m| m.get("text").and_then(Value::as_str))
            .map(str::len)
            .sum();
        mailbox_lifecycle::feedback_observe(
            &base,
            &me,
            "turn_extended",
            "interruption",
            "hook",
            "project",
            &msg_ids,
            Some(json!({
                "messageCount": delivered.len(),
                "messageBytes": msg_bytes,
            })),
        );
        identity::annotate_peer(&base, &session, &[("state", json!("busy"))]);
        let decision = if gemini { "continue" } else { "block" };
        let _ = writeln!(
            out_stream,
            "{}",
            json!({
                "decision": decision,
                "reason": if delivered.is_empty() {
                    handoff_notice
                } else {
                    format!("Peer messages arrived while you worked:\n\n{context}")
                },
            })
        );
        return Ok(());
    }

    let others = if me.get("delegatedRun").is_some_and(paths::is_truthy_json) {
        Vec::new()
    } else {
        identity::colleagues(&base, &me)
    };
    let (mates, elsewhere) = mailbox_lifecycle::split_channels(&me, &others);
    let seen = mailbox_lifecycle::roster_key(&me, &mates);
    let mut rule_shown = false;
    if event == "SessionStart" || seen != seen_colleagues_vec(&me) {
        let mut notice = mailbox_lifecycle::describe_colleagues(&mates, &me, &elsewhere);
        rule_shown = !mates.is_empty() && !notice.is_empty();
        if notice.is_empty()
            && elsewhere.is_empty()
            && me.get("seenColleagues").is_some_and(paths::is_truthy_json)
            && !me.get("delegatedRun").is_some_and(paths::is_truthy_json)
        {
            notice =
                "The other agent sessions in this project have ended; none is working here now."
                    .to_string();
        }
        if event == "SessionStart" {
            let joining = mailbox_lifecycle::join_hint(&me, &others);
            if !joining.is_empty() {
                notice = if notice.is_empty() {
                    joining
                } else {
                    format!("{notice}\n{joining}")
                };
            }
        }
        if !notice.is_empty() {
            context = if context.is_empty() {
                notice
            } else {
                format!("{notice}\n\n{context}")
            };
        }
        identity::annotate_peer(&base, &session, &[("seenColleagues", json!(seen))]);
    }
    if is_eligible_for_name_announcement(&me)
        && (event == "SessionStart"
            || Some(me_name.as_str()) != me.get("announcedName").and_then(Value::as_str))
    {
        let rule = if rule_shown {
            String::new()
        } else {
            format!(" {}.", mailbox_lifecycle::NAME_RULE)
        };
        let announcement = format!(
            "Your agent name is {me_name}; use it when you introduce yourself or sign a message.{rule}"
        );
        context = if context.is_empty() {
            announcement
        } else {
            format!("{announcement}\n\n{context}")
        };
        identity::annotate_peer(&base, &session, &[("announcedName", json!(me_name))]);
    }

    if gemini {
        if context.is_empty() {
            let _ = writeln!(out_stream, "{{}}");
        } else {
            let _ = writeln!(
                out_stream,
                "{}",
                json!({"injectSteps": [{"ephemeralMessage": context}]})
            );
        }
        return Ok(());
    }
    if !context.is_empty() {
        let _ = writeln!(
            out_stream,
            "{}",
            json!({
                "hookSpecificOutput": {
                    "hookEventName": event,
                    "additionalContext": context,
                }
            })
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::net::{Ipv4Addr, TcpListener};
    use std::os::unix::fs::MetadataExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::Duration;

    use serde_json::{Value, json};

    use super::*;
    use crate::mailbox_lifecycle::tests::{
        EnvGuard, TestDir, install_counting_python, lock_test_env, make_peer, save_peer,
        spawn_count, write_private_file,
    };
    use crate::paths::{fd_identity, lock_path_exclusive};
    use crate::sha256;

    #[test]
    fn keyword_check_sends_codex_skill_forms_to_the_full_hook() {
        for prompt in [
            "$swarm",
            "$horde close",
            "$side fix the flaky test",
            "/swarm",
        ] {
            assert!(check_slash_or_side_keywords(prompt), "{prompt}");
        }
        assert!(!check_slash_or_side_keywords("just keep going"));
    }

    #[test]
    fn test_lock_retries_after_pruner_unlinks_inode() {
        let td = TestDir::new("ork-fast-lock");
        let dir = &td.path;
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
        thread::sleep(Duration::from_millis(100));
        fs::remove_file(&lock_path).unwrap();
        // Create the replacement while the original inode is still held, so the filesystem
        // cannot recycle its number and make two different lock files look identical.
        fs::File::create_new(&lock_path).unwrap();
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
    }

    #[test]
    fn test_lock_sets_cloexec_and_recreates_missing_parent() {
        let td = TestDir::new("ork-fast-cloexec");
        let dir = &td.path;
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
    }

    fn setup_scripts_tree(dir: &Path) -> PathBuf {
        let scripts = dir.join("fake-checkout/src/py");
        let lib = dir.join("fake-checkout/src/lib");
        fs::create_dir_all(&scripts).unwrap();
        fs::create_dir_all(&lib).unwrap();
        fs::write(scripts.join("mailbox_daemon.py"), "# stub\n").unwrap();
        fs::write(lib.join("chief.mjs"), "// stub\n").unwrap();
        scripts
    }

    #[test]
    fn test_try_fast_path_http_mode_and_single_probe_guarantee() {
        let _lock = lock_test_env();
        let td = TestDir::new("ork-mailbox-http-fast");
        let cache_dir = td.path.join("orchestrate");
        let base = cache_dir.join("mailbox-v1");
        fs::create_dir_all(&base).unwrap();
        let cwd = td.path.join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let cwd_str = cwd.to_string_lossy().into_owned();
        let scripts = setup_scripts_tree(&td.path);
        let count_file = td.path.join("py-count");
        let fake_bin = install_counting_python(&td.path, &count_file, "[\"\", \"\"]");

        let mut env = EnvGuard::new();
        env.set("ORKEST_SCRIPTS_DIR", &scripts);
        env.set("ORCHESTRATE_HOME", &cache_dir);
        let old_path = env::var("PATH").unwrap_or_default();
        env.set("PATH", format!("{}:{old_path}", fake_bin.display()));

        let db = identity::daemon_base(&base);
        write_private_file(&db.join("mode.json"), br#"{"mode":"http"}"#);
        let token = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        write_private_file(&db.join("token.txt"), token.as_bytes());
        let rev = mailbox_lifecycle::current_runtime_revision(&base).unwrap();
        let store_id = sha256::sha256_hex(base.to_string_lossy().as_bytes());

        // Listener counts every incoming TCP connection.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/mcp");
        write_private_file(
            &db.join("state.json"),
            serde_json::to_string(&json!({
                "pid": 777,
                "instance": "inst-fast",
                "url": url,
                "storeId": store_id,
                "runtimeRevision": rev,
            }))
            .unwrap()
            .as_bytes(),
        );
        let accept_count = Arc::new(AtomicUsize::new(0));
        let stop_server = Arc::new(AtomicUsize::new(0));
        let return_status = Arc::new(AtomicUsize::new(200));
        let ac_clone = Arc::clone(&accept_count);
        let ss_clone = Arc::clone(&stop_server);
        let rs_clone = Arc::clone(&return_status);
        let body = serde_json::to_string(&json!({
            "pid": 777,
            "instance": "inst-fast",
            "url": url,
            "storeId": store_id,
            "runtimeRevision": rev,
            "activeWaits": 0,
        }))
        .unwrap();
        listener.set_nonblocking(true).unwrap();
        let srv_handle = thread::spawn(move || {
            while ss_clone.load(Ordering::Relaxed) == 0 {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        ac_clone.fetch_add(1, Ordering::Relaxed);
                        let mut buf = [0u8; 1024];
                        let _ = stream.read(&mut buf);
                        let code = rs_clone.load(Ordering::Relaxed);
                        let resp = if code == 200 {
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                        } else {
                            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_string()
                        };
                        let _ = stream.write_all(resp.as_bytes());
                    }
                    Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });

        let mut peer = make_peer("http-fast-1", "codex", &cwd_str);
        let peer_name = peer["name"].clone();
        peer.as_object_mut()
            .unwrap()
            .insert("state".to_string(), json!("busy"));
        peer.as_object_mut()
            .unwrap()
            .insert("announcedName".to_string(), peer_name);
        peer.as_object_mut()
            .unwrap()
            .insert("seenColleagues".to_string(), json!([]));
        save_peer(&base, &peer);

        // 1. Unannounced HTTP PreInvocation returns None with 0 TCP connections.
        let mut probe_cache = None;
        assert!(
            try_fast_path_with_probe(
                &base,
                "codex",
                false,
                "PreInvocation",
                "http-fast-1",
                &cwd_str,
                &json!({}),
                &mut probe_cache,
            )
            .is_none()
        );
        assert_eq!(accept_count.load(Ordering::Relaxed), 0);
        assert!(probe_cache.is_none());

        // 2. Announced HTTP PreInvocation probes /health once and succeeds on fast path.
        peer.as_object_mut()
            .unwrap()
            .insert("httpIdentityAnnounced".to_string(), json!(true));
        save_peer(&base, &peer);
        let mut probe_cache = None;
        assert!(
            try_fast_path_with_probe(
                &base,
                "codex",
                false,
                "PreInvocation",
                "http-fast-1",
                &cwd_str,
                &json!({}),
                &mut probe_cache,
            )
            .is_some()
        );
        assert_eq!(accept_count.load(Ordering::Relaxed), 1);
        assert_eq!(
            probe_cache,
            Some(mailbox_lifecycle::HttpProbeOutcome::CurrentHttp)
        );
        assert_eq!(spawn_count(&count_file), 0);

        // 3. HTTP Stop succeeds on fast path with ZERO extra TCP connections and ZERO Python spawns.
        let mut stop_probe = None;
        assert!(
            try_fast_path_with_probe(
                &base,
                "codex",
                false,
                "Stop",
                "http-fast-1",
                &cwd_str,
                &json!({}),
                &mut stop_probe,
            )
            .is_some()
        );
        assert_eq!(accept_count.load(Ordering::Relaxed), 1);
        assert!(stop_probe.is_none());

        // 4. Failed probe in try_fast_path_with_probe caches NeedsFullCheck so check_http_daemon_with_probe does NOT probe a second time!
        peer.as_object_mut()
            .unwrap()
            .insert("state".to_string(), json!("busy"));
        save_peer(&base, &peer);
        return_status.store(401, Ordering::Relaxed);
        let mut shared_probe = None;
        assert!(
            try_fast_path_with_probe(
                &base,
                "codex",
                false,
                "PreInvocation",
                "http-fast-1",
                &cwd_str,
                &json!({}),
                &mut shared_probe,
            )
            .is_none()
        );
        assert_eq!(accept_count.load(Ordering::Relaxed), 2);
        assert_eq!(
            shared_probe,
            Some(mailbox_lifecycle::HttpProbeOutcome::NeedsFullCheck)
        );
        let _ = mailbox_lifecycle::check_http_daemon_with_probe(
            &base,
            &mut peer,
            "PreInvocation",
            true,
            &mut shared_probe,
        );
        assert_eq!(
            accept_count.load(Ordering::Relaxed),
            2,
            "HTTP probe must never run twice in the same hook invocation"
        );
        assert_eq!(spawn_count(&count_file), 1);

        stop_server.store(1, Ordering::Relaxed);
        srv_handle.join().unwrap();
    }

    #[test]
    fn test_try_fast_path_quota_gate_and_gemini_classification_guard() {
        let _lock = lock_test_env();
        let td = TestDir::new("ork-fast-quota-gemini");
        let base = td.path.join("cache/mailbox-v1");
        fs::create_dir_all(&base).unwrap();
        let cwd = td.path.join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let cwd_str = cwd.to_string_lossy().into_owned();

        // Solo non-lead codex with missing handoffCheckedAt takes fast path.
        let mut solo = make_peer("solo-fast", "codex", &cwd_str);
        let solo_name = solo["name"].clone();
        solo.as_object_mut()
            .unwrap()
            .insert("state".to_string(), json!("busy"));
        solo.as_object_mut()
            .unwrap()
            .insert("announcedName".to_string(), solo_name);
        solo.as_object_mut()
            .unwrap()
            .insert("seenColleagues".to_string(), json!([]));
        save_peer(&base, &solo);
        assert!(
            try_fast_path(
                &base,
                "codex",
                false,
                "PreInvocation",
                "solo-fast",
                &cwd_str,
                &json!({})
            )
            .is_some()
        );

        // Live Chief with missing handoffCheckedAt falls off fast path to check quota.
        let now_iso = paths::format_utc_iso_z(paths::utc_now_secs());
        fs::write(
            base.join("chief.json"),
            serde_json::to_string(&json!({
                "schema": "ork.chief.v1",
                "session": "solo-fast",
                "pid": i64::from(std::process::id()),
                "boundAt": now_iso,
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(
            try_fast_path(
                &base,
                "codex",
                false,
                "PreInvocation",
                "solo-fast",
                &cwd_str,
                &json!({})
            )
            .is_none()
        );
        fs::remove_file(base.join("chief.json")).unwrap();

        // Gemini Stop on solo top-level peer takes fast path; pending or co-hosted unclassified must NOT.
        let mut gem = make_peer("gem-1", "gemini", &cwd_str);
        save_peer(&base, &gem);
        assert!(
            try_fast_path(&base, "gemini", true, "Stop", "gem-1", &cwd_str, &json!({})).is_some()
        );

        gem.as_object_mut()
            .unwrap()
            .insert("agySubagentPending".to_string(), json!(true));
        save_peer(&base, &gem);
        assert!(
            try_fast_path(&base, "gemini", true, "Stop", "gem-1", &cwd_str, &json!({})).is_none()
        );

        gem.as_object_mut().unwrap().remove("agySubagentPending");
        gem.as_object_mut()
            .unwrap()
            .insert("sharedProcess".to_string(), json!(true));
        save_peer(&base, &gem);
        assert!(
            try_fast_path(&base, "gemini", true, "Stop", "gem-1", &cwd_str, &json!({})).is_none()
        );
    }

    #[test]
    fn test_solo_martian_name_announcement_and_fast_path_re_announce() {
        let _lock = lock_test_env();
        let td = TestDir::new("ork-solo-announce");
        let cache_dir = td.path.join("orchestrate");
        let base = cache_dir.join("mailbox-v1");
        fs::create_dir_all(&base).unwrap();
        let cwd = td.path.join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let cwd_str = cwd.to_string_lossy().into_owned();
        let mut env = EnvGuard::new();
        env.remove("ORKEST_RESUME_SWARM");
        env.set("ORKEST_TEST_MODE", "1");
        env.set("ORKEST_TEST_HARNESS_PID", std::process::id().to_string());
        env.set("ORCHESTRATE_HOME", &cache_dir);

        // Predicate checks.
        let solo_peer = make_peer("p1", "codex", &cwd_str);
        assert!(is_eligible_for_name_announcement(&solo_peer));
        let mut run_peer = solo_peer.clone();
        run_peer
            .as_object_mut()
            .unwrap()
            .insert("run".to_string(), json!("run-1"));
        assert!(!is_eligible_for_name_announcement(&run_peer));
        let mut sub_peer = solo_peer.clone();
        sub_peer
            .as_object_mut()
            .unwrap()
            .insert("isSubagent".to_string(), json!(true));
        assert!(!is_eligible_for_name_announcement(&sub_peer));
        let mut pending_peer = solo_peer.clone();
        pending_peer
            .as_object_mut()
            .unwrap()
            .insert("agySubagentPending".to_string(), json!(true));
        assert!(!is_eligible_for_name_announcement(&pending_peer));
        let mut delegated_peer = solo_peer.clone();
        delegated_peer
            .as_object_mut()
            .unwrap()
            .insert("delegatedRun".to_string(), json!(true));
        assert!(!is_eligible_for_name_announcement(&delegated_peer));

        // 1. Solo SessionStart announces Martian name and sets announcedName.
        let mut out_start = Vec::new();
        run_on_base(
            &base,
            Some("codex"),
            Some("SessionStart"),
            &json!({"session_id": "solo-ann-1", "cwd": cwd_str}),
            &mut out_start,
        )
        .unwrap();
        let start_json: Value = serde_json::from_slice(&out_start).unwrap();
        let start_ctx = start_json["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        let pp = paths::peer_path(&base, "solo-ann-1").unwrap();
        let registered = paths::read_json_file(&pp).unwrap();
        let assigned_name = registered["name"].as_str().unwrap().to_string();
        assert!(start_ctx.contains(&format!("Your agent name is {assigned_name};")));
        assert!(start_ctx.contains(mailbox_lifecycle::NAME_RULE));
        assert_eq!(registered["announcedName"], assigned_name);

        // 2. Solo Stop stays quiet.
        let mut out_stop = Vec::new();
        run_on_base(
            &base,
            Some("codex"),
            Some("Stop"),
            &json!({"session_id": "solo-ann-1", "cwd": cwd_str}),
            &mut out_stop,
        )
        .unwrap();
        assert!(out_stop.is_empty());

        // 3. Mid-turn busy PreInvocation takes fast path when announcedName matches name.
        update_peer_locked(&base, "solo-ann-1", |obj| {
            obj.insert("state".to_string(), json!("busy"));
            true
        });
        assert!(
            try_fast_path(
                &base,
                "codex",
                false,
                "PreInvocation",
                "solo-ann-1",
                &cwd_str,
                &json!({}),
            )
            .is_some()
        );

        // 4. If name != announcedName (e.g., stale announcedName or model rename), fast path yields and full path re-announces.
        update_peer_locked(&base, "solo-ann-1", |obj| {
            obj.insert("announcedName".to_string(), json!("codex-stale-martian"));
            true
        });
        assert!(
            try_fast_path(
                &base,
                "codex",
                false,
                "PreInvocation",
                "solo-ann-1",
                &cwd_str,
                &json!({}),
            )
            .is_none()
        );
        let mut out_re = Vec::new();
        run_on_base(
            &base,
            Some("codex"),
            Some("PreInvocation"),
            &json!({"session_id": "solo-ann-1", "cwd": cwd_str, "model": "gpt-5.4"}),
            &mut out_re,
        )
        .unwrap();
        let re_json: Value = serde_json::from_slice(&out_re).unwrap();
        let re_ctx = re_json["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        let after = paths::read_json_file(&pp).unwrap();
        let final_name = after["name"].as_str().unwrap();
        assert_ne!(final_name, assigned_name);
        assert!(re_ctx.contains(&format!("Your agent name is {final_name};")));
        assert_eq!(after["announcedName"], final_name);
    }

    #[test]
    fn test_mixed_agy_transcript_clears_sticky_inferred_child_unless_sqlite_confirmed() {
        let _lock = lock_test_env();
        let td = TestDir::new("ork-agy-mixed-tr");
        let cache_dir = td.path.join("orchestrate");
        let base = cache_dir.join("mailbox-v1");
        fs::create_dir_all(&base).unwrap();
        let cwd = td.path.join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let cwd_str = cwd.to_string_lossy().into_owned();
        let agy_home = td.path.join("agy-home");
        fs::create_dir_all(agy_home.join("antigravity-cli")).unwrap();
        let mut env = EnvGuard::new();
        env.set("ORKEST_TEST_MODE", "1");
        env.set("ORKEST_TEST_HARNESS_PID", std::process::id().to_string());
        env.set("ORCHESTRATE_HOME", &cache_dir);
        env.set("GEMINI_CLI_HOME", &agy_home);

        // 1. Mixed transcript without SQLite confirmation: hook 1 infers child from SYSTEM_MESSAGE sender=;
        // appending USER_INPUT on hook 2 must clear isSubagent and parentSession.
        let transcript = td.path.join("mixed.jsonl");
        fs::write(
            &transcript,
            concat!(
                r#"{"type":"SYSTEM_MESSAGE","content":"<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-01T00:00:00Z sender=parent-agy-1 content=hi\n</SYSTEM_MESSAGE>"}"#,
                "\n",
            ),
        )
        .unwrap();

        let mut out1 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-mixed-1",
                "cwd": cwd_str,
                "transcript_path": transcript,
            }),
            &mut out1,
        )
        .unwrap();
        let pp = paths::peer_path(&base, "agy-mixed-1").unwrap();
        let after1 = paths::read_json_file(&pp).unwrap();
        assert_eq!(after1["isSubagent"], json!(true));
        assert_eq!(after1["parentSession"], json!("parent-agy-1"));

        let mut tf = fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        writeln!(
            tf,
            r#"{{"type":"USER_INPUT","source":"USER_EXPLICIT","content":"now top level"}}"#
        )
        .unwrap();
        drop(tf);

        let mut out2 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-mixed-1",
                "cwd": cwd_str,
                "transcript_path": transcript,
            }),
            &mut out2,
        )
        .unwrap();
        let after2 = paths::read_json_file(&pp).unwrap();
        assert!(after2.get("isSubagent").is_none(), "after2={after2}");
        assert!(after2.get("parentSession").is_none(), "after2={after2}");

        // 2. When SQLite confirms subagent parentage, USER_INPUT in transcript must preserve SQLite parentage.
        let db_path = agy_home.join("antigravity-cli/conversation_summaries.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, nesting_depth, agent_name) VALUES ('agy-sql-child', 'sqlite-parent-1', 1, 'Explorer')",
            [],
        )
        .unwrap();
        drop(conn);

        let mut out3 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-sql-child",
                "cwd": cwd_str,
                "transcript_path": transcript,
            }),
            &mut out3,
        )
        .unwrap();
        let child_pp = paths::peer_path(&base, "agy-sql-child").unwrap();
        let child_saved = paths::read_json_file(&child_pp).unwrap();
        assert_eq!(child_saved["isSubagent"], json!(true));
        assert_eq!(child_saved["parentSession"], json!("sqlite-parent-1"));
    }

    #[test]
    fn test_ordinary_hook_retries_pending_chief_transfer_without_replaying_mail() {
        let _lock = lock_test_env();
        let td = TestDir::new("ork-chief-hook-retry");
        let cache_dir = td.path.join("orchestrate");
        let base = cache_dir.join("mailbox-v1");
        fs::create_dir_all(base.join("cleared")).unwrap();
        let cwd = td.path.join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let cwd_str = cwd.to_string_lossy().into_owned();
        let my_pid = i64::from(std::process::id());
        let my_birth = identity::process_started_fresh(my_pid);
        let now_iso = paths::format_utc_iso_z(paths::utc_now_secs());
        let host = paths::current_hostname().unwrap_or_default();

        let mut env = EnvGuard::new();
        env.set("ORKEST_TEST_MODE", "1");
        env.set("ORKEST_TEST_HARNESS_PID", my_pid.to_string());
        env.set("ORCHESTRATE_HOME", &cache_dir);

        let mut old_chief = make_peer("chief-old", "codex", &cwd_str);
        old_chief
            .as_object_mut()
            .unwrap()
            .insert("clearedAt".to_string(), json!(now_iso));
        old_chief
            .as_object_mut()
            .unwrap()
            .insert("clearedPid".to_string(), json!(my_pid));
        old_chief
            .as_object_mut()
            .unwrap()
            .insert("machine".to_string(), json!(host));
        if let Some(ref b) = my_birth {
            old_chief
                .as_object_mut()
                .unwrap()
                .insert("pidBirth".to_string(), json!(b));
        }
        let stash_path = base.join("cleared/chief-old.json");
        paths::write_json_atomic(&stash_path, &old_chief).unwrap();

        let chief_path = base.join("chief.json");
        let chief_backup = base.join("chief.json.bak");
        paths::write_json_atomic(
            &chief_backup,
            &json!({
                "schema": "ork.chief.v1",
                "session": "chief-old",
                "machine": host,
                "pid": my_pid,
                "pidBirth": my_birth,
                "boundAt": "2026-01-01T00:00:00Z",
                "revision": 4,
            }),
        )
        .unwrap();
        // Replace chief.json with directory -> transient error on SessionStart clear hook.
        fs::create_dir(&chief_path).unwrap();

        let mut out_clear = Vec::new();
        run_on_base(
            &base,
            Some("codex"),
            Some("SessionStart"),
            &json!({"session_id": "chief-succ", "cwd": cwd_str, "source": "clear"}),
            &mut out_clear,
        )
        .unwrap();
        assert!(stash_path.exists());
        let succ_pp = paths::peer_path(&base, "chief-succ").unwrap();
        let after_clear = paths::read_json_file(&succ_pp).unwrap();
        assert_eq!(after_clear["pendingChiefTransfer"], json!(true));
        assert!(after_clear.get("awaitingClear").is_none_or(Value::is_null));

        // Fast path must refuse while pendingChiefTransfer is set so Stop/PreInvocation also retry.
        update_peer_locked(&base, "chief-succ", |obj| {
            obj.insert("state".to_string(), json!("idle"));
            true
        });
        assert!(
            try_fast_path(
                &base,
                "codex",
                false,
                "Stop",
                "chief-succ",
                &cwd_str,
                &json!({}),
            )
            .is_none()
        );

        // Restore chief.json; ordinary UserPromptSubmit hook must complete the transfer and clear marker.
        fs::remove_dir(&chief_path).unwrap();
        fs::rename(&chief_backup, &chief_path).unwrap();
        let mut out_prompt = Vec::new();
        run_on_base(
            &base,
            Some("codex"),
            Some("UserPromptSubmit"),
            &json!({"session_id": "chief-succ", "cwd": cwd_str}),
            &mut out_prompt,
        )
        .unwrap();
        let final_chief = paths::read_json_file(&chief_path).unwrap();
        assert_eq!(final_chief["session"], "chief-succ");
        assert_eq!(final_chief["revision"], json!(5));
        assert!(!stash_path.exists());
        let after_prompt = paths::read_json_file(&succ_pp).unwrap();
        assert!(
            after_prompt
                .get("pendingChiefTransfer")
                .is_none_or(Value::is_null)
        );
    }

    #[test]
    fn test_agy_sqlite_provenance_conflict_unavailable_and_legacy_parent_session() {
        let _lock = lock_test_env();
        let td = TestDir::new("ork-agy-provenance");
        let cache_dir = td.path.join("orchestrate");
        let base = cache_dir.join("mailbox-v1");
        fs::create_dir_all(&base).unwrap();
        let cwd = td.path.join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let cwd_str = cwd.to_string_lossy().into_owned();
        let agy_home = td.path.join("agy-home");
        fs::create_dir_all(agy_home.join("antigravity-cli")).unwrap();
        let mut env = EnvGuard::new();
        env.set("ORKEST_TEST_MODE", "1");
        env.set("ORKEST_TEST_HARNESS_PID", std::process::id().to_string());
        env.set("ORCHESTRATE_HOME", &cache_dir);
        env.set("GEMINI_CLI_HOME", &agy_home);

        // 1. Conflicting SQLite vs transcript parent: SQLite parent must win and subagentSource = "sqlite".
        let db_path = agy_home.join("antigravity-cli/conversation_summaries.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute(
                "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, nesting_depth, agent_name) VALUES ('agy-conflict-1', 'sqlite-parent-1', 1, 'Explorer')",
                [],
            )
            .unwrap();
        }
        let conflict_tr = td.path.join("conflict.jsonl");
        fs::write(
            &conflict_tr,
            concat!(
                r#"{"type":"SYSTEM_MESSAGE","content":"<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-01T00:00:00Z sender=transcript-parent-2 content=hi\n</SYSTEM_MESSAGE>"}"#,
                "\n",
            ),
        )
        .unwrap();
        let mut out1 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-conflict-1",
                "cwd": cwd_str,
                "transcript_path": conflict_tr,
            }),
            &mut out1,
        )
        .unwrap();
        let conflict_pp = paths::peer_path(&base, "agy-conflict-1").unwrap();
        let saved1 = paths::read_json_file(&conflict_pp).unwrap();
        assert_eq!(saved1["isSubagent"], json!(true));
        assert_eq!(saved1["parentSession"], json!("sqlite-parent-1"));
        assert_eq!(saved1["subagentSource"], json!("sqlite"));

        // 2. Second hook with DB unavailable after SQLite confirmation (even with USER_INPUT in transcript):
        // must preserve isSubagent, parentSession, and subagentSource = "sqlite".
        let db_bak = agy_home.join("antigravity-cli/conversation_summaries.db.bak");
        fs::rename(&db_path, &db_bak).unwrap();
        let mut tf = fs::OpenOptions::new()
            .append(true)
            .open(&conflict_tr)
            .unwrap();
        writeln!(
            tf,
            r#"{{"type":"USER_INPUT","source":"USER_EXPLICIT","content":"follow-up"}}"#
        )
        .unwrap();
        drop(tf);

        let mut out2 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-conflict-1",
                "cwd": cwd_str,
                "transcript_path": conflict_tr,
            }),
            &mut out2,
        )
        .unwrap();
        let saved2 = paths::read_json_file(&conflict_pp).unwrap();
        assert_eq!(saved2["isSubagent"], json!(true));
        assert_eq!(saved2["parentSession"], json!("sqlite-parent-1"));
        assert_eq!(saved2["subagentSource"], json!("sqlite"));

        // When DB returns and itself clears the row to top-level (depth=0, parent=NULL), demotion occurs.
        fs::rename(&db_bak, &db_path).unwrap();
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE conversation_summaries SET parent_conversation_id = NULL, nesting_depth = 0 WHERE conversation_id = 'agy-conflict-1'",
                [],
            )
            .unwrap();
        }
        let mut out2b = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-conflict-1",
                "cwd": cwd_str,
                "transcript_path": conflict_tr,
            }),
            &mut out2b,
        )
        .unwrap();
        let saved2b = paths::read_json_file(&conflict_pp).unwrap();
        assert!(saved2b.get("isSubagent").is_none());
        assert!(saved2b.get("parentSession").is_none());
        assert!(saved2b.get("subagentSource").is_none());

        // 3. Inconclusive hook (no transcript, no DB row) preserves legacy parentSession-only record.
        let legacy_pp = paths::peer_path(&base, "agy-legacy-parent").unwrap();
        paths::write_json_atomic(
            &legacy_pp,
            &json!({
                "schema": "agent-executor.peer.v1",
                "session": "agy-legacy-parent",
                "name": "gemini-legacy-hawk",
                "harness": "gemini",
                "cwd": cwd_str,
                "pid": std::process::id(),
                "startedAt": "2026-01-01T00:00:00Z",
                "lastSeenAt": "2026-01-01T00:00:00Z",
                "parentSession": "legacy-parent-0",
            }),
        )
        .unwrap();
        let empty_tr = td.path.join("empty.jsonl");
        fs::write(&empty_tr, "").unwrap();
        let mut out3 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-legacy-parent",
                "cwd": cwd_str,
                "transcript_path": empty_tr,
            }),
            &mut out3,
        )
        .unwrap();
        let saved3 = paths::read_json_file(&legacy_pp).unwrap();
        assert_eq!(saved3["parentSession"], json!("legacy-parent-0"));
    }

    #[test]
    fn test_duplicate_session_end_clear_for_adopted_predecessor_native_id_preserves_successor() {
        let _lock = lock_test_env();
        let td = TestDir::new("ork-dup-clear-hook");
        let cache_dir = td.path.join("orchestrate");
        let base = cache_dir.join("mailbox-v1");
        fs::create_dir_all(&base).unwrap();
        let cwd = td.path.join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let cwd_str = cwd.to_string_lossy().into_owned();
        let my_pid = std::process::id().to_string();

        let mut env = EnvGuard::new();
        env.set("ORKEST_TEST_MODE", "1");
        env.set("ORKEST_TEST_HARNESS_PID", &my_pid);
        env.set("ORCHESTRATE_HOME", &cache_dir);

        // 1. Register predecessor with canonical session "old-canon" and native ID "old-native".
        let mut old_peer = make_peer("old-canon", "claude", &cwd_str);
        old_peer
            .as_object_mut()
            .unwrap()
            .insert("focus".to_string(), json!("Carry me safely"));
        save_peer(&base, &old_peer);
        identity::attest_native_sessions(&base, "old-canon", &["old-native"]).unwrap();

        // 2. First SessionEnd(clear) for "old-native" resolves to "old-canon", stashes, and unregisters it.
        let mut out_end1 = Vec::new();
        run_on_base(
            &base,
            Some("claude"),
            Some("SessionEnd"),
            &json!({"session_id": "old-native", "cwd": cwd_str, "reason": "clear"}),
            &mut out_end1,
        )
        .unwrap();
        assert!(!paths::peer_path(&base, "old-canon").unwrap().exists());
        assert!(base.join("cleared/old-canon.json").exists());

        // 3. Successor starts with SessionStart(clear) and adopts predecessor's stash + native IDs.
        let mut out_start = Vec::new();
        run_on_base(
            &base,
            Some("claude"),
            Some("SessionStart"),
            &json!({"session_id": "succ-native", "cwd": cwd_str, "source": "clear"}),
            &mut out_start,
        )
        .unwrap();
        let succ_pp = paths::peer_path(&base, "succ-native").unwrap();
        let succ_saved = paths::read_json_file(&succ_pp).unwrap();
        assert_eq!(succ_saved["clearedFrom"], json!("old-canon"));
        assert_eq!(succ_saved["focus"], json!("Carry me safely"));
        assert_eq!(succ_saved["nativeSession"], json!("succ-native"));
        let adopted_ids: Vec<String> = succ_saved["adoptedNativeIds"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        assert!(adopted_ids.contains(&"old-native".to_string()));
        assert!(adopted_ids.contains(&"old-canon".to_string()));
        assert!(!adopted_ids.contains(&"succ-native".to_string()));

        // 4. Delayed late Stop for predecessor's native ID ("old-native") and canonical ID
        //    ("old-canon") resolves to successor, but must NOT promote historical IDs back into nativeSession.
        for late_id in ["old-native", "old-canon"] {
            let mut out_stop = Vec::new();
            run_on_base(
                &base,
                Some("claude"),
                Some("Stop"),
                &json!({"session_id": late_id, "cwd": cwd_str}),
                &mut out_stop,
            )
            .unwrap();
            assert!(
                succ_pp.exists(),
                "late Stop for {late_id} must not unregister successor"
            );
            let after_stop = paths::read_json_file(&succ_pp).unwrap();
            assert_eq!(
                after_stop["nativeSession"],
                json!("succ-native"),
                "late Stop for {late_id} must not overwrite active nativeSession"
            );
            assert_eq!(after_stop["clearedFrom"], json!("old-canon"));
        }

        // 5. Delayed duplicate SessionEnd(clear) for predecessor's native ID ("old-native") AND canonical ID
        //    ("old-canon") resolves via session_peer to live successor, but must be ignored!
        for dup_id in ["old-native", "old-canon"] {
            let mut out_dup = Vec::new();
            run_on_base(
                &base,
                Some("claude"),
                Some("SessionEnd"),
                &json!({"session_id": dup_id, "cwd": cwd_str, "reason": "clear"}),
                &mut out_dup,
            )
            .unwrap();
            assert!(
                succ_pp.exists(),
                "live successor must NOT be unregistered by duplicate clear for {dup_id}"
            );
            let after_dup = paths::read_json_file(&succ_pp).unwrap();
            assert_eq!(after_dup["clearedFrom"], json!("old-canon"));
            assert_eq!(after_dup["focus"], json!("Carry me safely"));
            assert_eq!(after_dup["nativeSession"], json!("succ-native"));
        }

        // 6. Real SessionEnd(clear) for successor's own active native ID ("succ-native") DOES unregister it.
        let mut out_real_end = Vec::new();
        run_on_base(
            &base,
            Some("claude"),
            Some("SessionEnd"),
            &json!({"session_id": "succ-native", "cwd": cwd_str, "reason": "clear"}),
            &mut out_real_end,
        )
        .unwrap();
        assert!(!succ_pp.exists());
        assert!(base.join("cleared/succ-native.json").exists());
    }

    #[test]
    fn test_agy_transcript_sender_supersedes_cohosted_inference() {
        let _lock = lock_test_env();
        let td = TestDir::new("ork-agy-cohosted-supersede");
        let cache_dir = td.path.join("orchestrate");
        let base = cache_dir.join("mailbox-v1");
        fs::create_dir_all(&base).unwrap();
        let cwd = td.path.join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let cwd_str = cwd.to_string_lossy().into_owned();
        let agy_home = td.path.join("agy-home");
        fs::create_dir_all(agy_home.join("antigravity-cli")).unwrap();
        let my_pid = i64::from(std::process::id());

        let mut env = EnvGuard::new();
        env.set("ORKEST_TEST_MODE", "1");
        env.set("ORKEST_TEST_HARNESS_PID", my_pid.to_string());
        env.set("ORCHESTRATE_HOME", &cache_dir);
        env.set("GEMINI_CLI_HOME", &agy_home);

        // Set up an active co-hosted parent A on the same PID.
        let mut parent_a = make_peer("parent-a", "gemini", &cwd_str);
        let obj = parent_a.as_object_mut().unwrap();
        obj.insert("pid".to_string(), json!(my_pid));
        obj.insert("state".to_string(), json!("busy"));
        obj.insert(
            "lastSeenAt".to_string(),
            json!(paths::format_utc_iso_z(paths::utc_now_secs())),
        );
        obj.insert(
            "accountHome".to_string(),
            json!(agy_home.to_string_lossy().into_owned()),
        );
        save_peer(&base, &parent_a);
        let parent_logs = agy_home.join("antigravity-cli/brain/parent-a/.system_generated/logs");
        fs::create_dir_all(&parent_logs).unwrap();
        fs::write(
            parent_logs.join("transcript.jsonl"),
            concat!(
                r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","content":"delegate"}"#,
                "\n",
                r#"{"type":"PLANNER_RESPONSE","tool_calls":[{"name":"invoke_subagent"}]}"#,
                "\n",
            ),
        )
        .unwrap();

        // Hook 1: no DB row and no transcript -> infers cohosted parent A.
        let tr_path = td.path.join("child.jsonl");
        let mut out1 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-cohost-child",
                "cwd": cwd_str,
                "transcript_path": tr_path,
            }),
            &mut out1,
        )
        .unwrap();
        let child_pp = paths::peer_path(&base, "agy-cohost-child").unwrap();
        let saved1 = paths::read_json_file(&child_pp).unwrap();
        assert_eq!(saved1["isSubagent"], json!(true));
        assert_eq!(saved1["parentSession"], json!("parent-a"));
        assert_eq!(saved1["subagentSource"], json!("cohosted"));

        // Hook 2: transcript appears identifying parent B -> supersedes cohosted parent A.
        fs::write(
            &tr_path,
            concat!(
                r#"{"type":"SYSTEM_MESSAGE","content":"<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-01T00:00:00Z sender=parent-b content=go\n</SYSTEM_MESSAGE>"}"#,
                "\n",
            ),
        )
        .unwrap();
        let mut out2 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-cohost-child",
                "cwd": cwd_str,
                "transcript_path": tr_path,
            }),
            &mut out2,
        )
        .unwrap();
        let saved2 = paths::read_json_file(&child_pp).unwrap();
        assert_eq!(saved2["isSubagent"], json!(true));
        assert_eq!(saved2["parentSession"], json!("parent-b"));
        assert_eq!(saved2["subagentSource"], json!("transcript"));
        assert_eq!(saved2["parentSessionSource"], json!("transcript"));
    }

    #[test]
    fn test_agy_depth_only_sqlite_allows_transcript_to_supersede_cohosted_parent() {
        let _lock = lock_test_env();
        let td = TestDir::new("ork-agy-depth-only-sqlite");
        let cache_dir = td.path.join("orchestrate");
        let base = cache_dir.join("mailbox-v1");
        fs::create_dir_all(&base).unwrap();
        let cwd = td.path.join("proj");
        fs::create_dir_all(&cwd).unwrap();
        let cwd_str = cwd.to_string_lossy().into_owned();
        let agy_home = td.path.join("agy-home");
        fs::create_dir_all(agy_home.join("antigravity-cli")).unwrap();
        let my_pid = i64::from(std::process::id());

        let mut env = EnvGuard::new();
        env.set("ORKEST_TEST_MODE", "1");
        env.set("ORKEST_TEST_HARNESS_PID", my_pid.to_string());
        env.set("ORCHESTRATE_HOME", &cache_dir);
        env.set("GEMINI_CLI_HOME", &agy_home);

        // Set up active cohosted parent A on the same PID.
        let mut parent_a = make_peer("parent-a", "gemini", &cwd_str);
        let obj = parent_a.as_object_mut().unwrap();
        obj.insert("pid".to_string(), json!(my_pid));
        obj.insert("state".to_string(), json!("busy"));
        obj.insert(
            "lastSeenAt".to_string(),
            json!(paths::format_utc_iso_z(paths::utc_now_secs())),
        );
        obj.insert(
            "accountHome".to_string(),
            json!(agy_home.to_string_lossy().into_owned()),
        );
        save_peer(&base, &parent_a);
        let parent_logs = agy_home.join("antigravity-cli/brain/parent-a/.system_generated/logs");
        fs::create_dir_all(&parent_logs).unwrap();
        fs::write(
            parent_logs.join("transcript.jsonl"),
            concat!(
                r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","content":"delegate"}"#,
                "\n",
                r#"{"type":"PLANNER_RESPONSE","tool_calls":[{"name":"invoke_subagent"}]}"#,
                "\n",
            ),
        )
        .unwrap();

        // Hook 1: no DB row and no transcript -> infers cohosted parent A.
        let tr_path = td.path.join("depth-only-child.jsonl");
        let mut out1 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-depth-only-child",
                "cwd": cwd_str,
                "transcript_path": tr_path,
            }),
            &mut out1,
        )
        .unwrap();
        let child_pp = paths::peer_path(&base, "agy-depth-only-child").unwrap();
        let saved1 = paths::read_json_file(&child_pp).unwrap();
        assert_eq!(saved1["isSubagent"], json!(true));
        assert_eq!(saved1["parentSession"], json!("parent-a"));
        assert_eq!(saved1["subagentSource"], json!("cohosted"));
        assert_eq!(saved1["parentSessionSource"], json!("cohosted"));

        // Hook 2: depth-only SQLite row (nesting_depth=1, parent_conversation_id=NULL) + transcript
        // identifying parent B -> subagentSource becomes "sqlite" while transcript parent B supersedes
        // prior cohosted parent A and records parentSessionSource = "transcript".
        let db_path = agy_home.join("antigravity-cli/conversation_summaries.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute(
                "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, nesting_depth, agent_name) VALUES ('agy-depth-only-child', NULL, 1, 'Explorer')",
                [],
            )
            .unwrap();
        }
        fs::write(
            &tr_path,
            concat!(
                r#"{"type":"SYSTEM_MESSAGE","content":"<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-01T00:00:00Z sender=parent-b content=go\n</SYSTEM_MESSAGE>"}"#,
                "\n",
            ),
        )
        .unwrap();
        let mut out2 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-depth-only-child",
                "cwd": cwd_str,
                "transcript_path": tr_path,
            }),
            &mut out2,
        )
        .unwrap();
        let saved2 = paths::read_json_file(&child_pp).unwrap();
        assert_eq!(saved2["isSubagent"], json!(true));
        assert_eq!(saved2["parentSession"], json!("parent-b"));
        assert_eq!(saved2["subagentSource"], json!("sqlite"));
        assert_eq!(saved2["parentSessionSource"], json!("transcript"));

        // Hook 3: concrete SQLite parent_conversation_id appears -> overrides transcript parent B.
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE conversation_summaries SET parent_conversation_id = 'sqlite-parent-c' WHERE conversation_id = 'agy-depth-only-child'",
                [],
            )
            .unwrap();
        }
        let mut out3 = Vec::new();
        run_on_base(
            &base,
            Some("gemini"),
            Some("PreInvocation"),
            &json!({
                "session_id": "agy-depth-only-child",
                "cwd": cwd_str,
                "transcript_path": tr_path,
            }),
            &mut out3,
        )
        .unwrap();
        let saved3 = paths::read_json_file(&child_pp).unwrap();
        assert_eq!(saved3["isSubagent"], json!(true));
        assert_eq!(saved3["parentSession"], json!("sqlite-parent-c"));
        assert_eq!(saved3["subagentSource"], json!("sqlite"));
        assert_eq!(saved3["parentSessionSource"], json!("sqlite"));
    }
}
