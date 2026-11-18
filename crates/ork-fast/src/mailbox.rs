//! Native peer mailbox hook handler (`ork-fast mailbox-hook`).
//! Handles the fast path (<1 ms) and full turn lifecycle natively without Python fallback.

use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

use serde_json::{Value, json};

use crate::{
    identity, mailbox_lifecycle, mailbox_swarm, mailbox_transcript, paths, rooms_work, sqlite,
    terminal,
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
        || lower.contains("!side")
        || lower.contains("side:")
        || lower.contains("ork side")
        || lower.contains("[orkest-side-command")
        || lower.contains("/swarm")
        || lower.contains("/horde")
        || lower.contains("[orkest-swarm")
        || lower.contains("/clear")
}

fn has_unread_mail(inbox_dir: &Path) -> bool {
    if !inbox_dir.is_dir() {
        return false;
    }
    let Ok(entries) = fs::read_dir(inbox_dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|ext| ext.to_str()) == Some("json")
            && let Some(val) = paths::read_json_file(&p)
            && paths::valid_message(&val)
            && !val.get("readAt").is_some_and(paths::is_truthy_json)
        {
            return true;
        }
    }
    false
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

fn update_peer_locked<F>(peer_file: &Path, mutate: F) -> bool
where
    F: FnOnce(&mut serde_json::Map<String, Value>) -> bool,
{
    let Ok(_guard) = paths::lock_for(peer_file) else {
        return false;
    };
    let Some(mut val) = paths::read_json_file(peer_file) else {
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
    paths::write_json_atomic(peer_file, &val).is_ok()
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

/// Fast path returning `Some(())` when a trivial `Stop` or busy mid-turn `PreInvocation`
/// completes safely via atomic lock update without extra lookups or git invocations.
fn try_fast_path(
    base: &Path,
    harness: &str,
    gemini: bool,
    event: &str,
    session: &str,
    cwd: &str,
    payload: &Value,
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
    let s_key = paths::session_key(session).ok()?;
    let peer_file = base.join("peers").join(format!("{s_key}.json"));
    let peer = paths::read_json_file(&peer_file)?;
    if !paths::valid_peer(&peer) || peer.get("session").and_then(Value::as_str) != Some(session) {
        return None;
    }
    if peer.get("isSubagent").and_then(Value::as_bool) == Some(true)
        || peer.get("agySubagentPending").and_then(Value::as_bool) == Some(true)
        || peer.get("delegatedRun").is_some_and(paths::is_truthy_json)
        || peer.get("run").and_then(Value::as_str).is_some()
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
    // Check HTTP daemon mode file: stdio/absent allows fast path.
    let mode_path = identity::daemon_base(base).join("mode.json");
    if mode_path.exists() {
        return None;
    }
    let inbox_dir = base.join("inbox").join(&s_key);
    if has_unread_mail(&inbox_dir) {
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
        let checked_recently = peer
            .get("handoffCheckedAt")
            .and_then(Value::as_str)
            .and_then(paths::parse_iso8601_utc_secs)
            .is_some_and(|t| (now_secs - t) < mailbox_lifecycle::HOOK_CHECK_SECONDS);
        if !checked_recently {
            return None;
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
        let updated = update_peer_locked(&peer_file, |obj| {
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

    // PreInvocation fast path: non-gemini mid-turn busy session with unchanged roster & model.
    if !gemini
        && peer.get("state").and_then(Value::as_str) == Some("busy")
        && peer.get("lastStopReason").is_none_or(Value::is_null)
        && !payload_changes_model(payload, &peer)
    {
        let others = identity::colleagues(base, &peer);
        let (mates, _) = mailbox_lifecycle::split_channels(&peer, &others);
        let seen = mailbox_lifecycle::roster_key(&peer, &mates);
        if seen != seen_colleagues_vec(&peer) {
            return None;
        }
        if !others.is_empty()
            && !identity::is_run_peer(Some(&peer))
            && peer.get("name").and_then(Value::as_str)
                != peer.get("announcedName").and_then(Value::as_str)
        {
            return None;
        }
        let updated = update_peer_locked(&peer_file, |obj| {
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
        .unwrap_or_else(|| identity::detect_harness(&payload));

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

    let base = paths::cache_home(None, None).join("mailbox-v1");
    if let Some(canonical) =
        identity::session_peer(&base, &session, Some(&harness), Some(&cwd), false)
        && let Some(canon_sid) = canonical.get("session").and_then(Value::as_str)
    {
        session = canon_sid.to_string();
    }

    match event.as_str() {
        "SessionEnd" => {
            let parent_to_refresh = paths::peer_path(&base, &session)
                .ok()
                .and_then(|p| paths::read_json_file(&p))
                .filter(|p| p.get("isSubagent").is_some_and(paths::is_truthy_json))
                .and_then(|p| {
                    p.get("parentSession")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .filter(|s| !s.is_empty());
            let reason = payload.get("reason").and_then(Value::as_str).unwrap_or("");
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
            mailbox_lifecycle::handle_stop_failure(&base, &payload, &session, &harness);
            return Ok(());
        }
        "SubagentStart" => {
            let out =
                mailbox_lifecycle::handle_subagent_start(&base, &payload, &session, &harness, &cwd);
            println!("{out}");
            return Ok(());
        }
        "SubagentStop" => {
            let out = mailbox_lifecycle::handle_subagent_stop(&base, &payload, &session, &harness);
            println!("{out}");
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

    if session == native_session
        && try_fast_path(&base, &harness, gemini, &event, &session, &cwd, &payload).is_some()
    {
        return Ok(());
    }

    // Full lifecycle path matching mailbox_hooks.py::hook (lines 1770-2265).
    let raw_transcript = payload
        .get("transcript_path")
        .or_else(|| payload.get("transcriptPath"))
        .and_then(Value::as_str);
    let account_home_dir = identity::account_home(&harness, raw_transcript);
    let mut effective_transcript = raw_transcript
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if gemini
        && effective_transcript.is_none()
        && let Some(candidate) =
            mailbox_transcript::default_agy_transcript(&session, account_home_dir.as_deref())
    {
        effective_transcript = Some(candidate.to_string_lossy().into_owned());
    }

    let mut runtime_model = mailbox_transcript::clean_model_value(
        payload.get("model").or_else(|| payload.get("modelName")),
    );
    if runtime_model.is_none() {
        runtime_model =
            mailbox_transcript::transcript_model(&payload, effective_transcript.as_deref());
    }
    let mut runtime_effort_val = identity::runtime_effort(&harness, &payload);
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

    let previous = paths::peer_path(&base, &session)
        .ok()
        .and_then(|p| paths::read_json_file(&p));
    let previous_valid = previous.as_ref().is_some_and(paths::valid_peer);
    let has_transcript = effective_transcript
        .as_deref()
        .is_some_and(|t| paths::expand_home(t, None).is_file());

    let mut subagent_name: Option<String> = None;
    let mut agy_pending = false;
    let (is_subagent, parent_session) = if gemini {
        let prev_is_sub = previous_valid
            && previous
                .as_ref()
                .is_some_and(|p| p.get("isSubagent").is_some_and(paths::is_truthy_json));
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
        let mut db_classified = false;
        if !is_sub || parent.is_none() {
            let (db_sub, db_parent, db_name, db_cls) =
                sqlite::agy_sqlite_subagent_info(account_home_dir.as_deref(), &session);
            db_classified = db_cls;
            if db_sub {
                is_sub = true;
                if parent.is_none() {
                    parent = db_parent;
                }
            }
            if db_name.is_some() {
                subagent_name = db_name;
            }
        }
        let (tr_sub, tr_parent, tr_classified) =
            mailbox_transcript::agy_transcript_classified(effective_transcript.as_deref());
        if tr_sub {
            is_sub = true;
            if tr_parent.is_some() {
                parent = tr_parent;
            }
        }
        let classified = is_sub || db_classified || tr_classified;
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
                parent = Some(cp);
            } else if saw_busy_cohosted || has_transcript {
                agy_pending = true;
            }
        }
        (is_sub, parent)
    } else {
        (false, None)
    };

    let (phase_handoff, active_orchestrator_model, saw_turn_boundary) = if gemini {
        mailbox_transcript::agy_transcript_phase(effective_transcript.as_deref())
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
    let suppress_toplevel =
        is_subagent || me.get("isSubagent").is_some_and(paths::is_truthy_json) || agy_pending;

    if !suppress_toplevel
        && !me.get("delegatedRun").is_some_and(paths::is_truthy_json)
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
        mailbox_lifecycle::bootstrap_repo_env(&cwd, &harness, &event);
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
            &payload,
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
        if let Ok(pp) = paths::peer_path(&base, &session)
            && let Some(reloaded) = paths::read_json_file(&pp)
        {
            me = reloaded;
        }
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
                &payload,
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
    let handoff_notice = if !is_subagent && lifecycle_turn {
        mailbox_lifecycle::handoff_turn(
            &base,
            &me,
            matches!(event.as_str(), "SessionStart" | "UserPromptSubmit")
                || (event == "PreInvocation" && !mid_turn),
        )
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

    let (identity_hint, availability_hint) =
        mailbox_lifecycle::check_http_daemon(&base, &mut me, &event, mid_turn);

    if gemini && event == "Stop" {
        if let Some(tr) = payload.get("terminationReason").and_then(Value::as_str)
            && mailbox_lifecycle::ANTIGRAVITY_NO_CONTINUE.contains(&tr)
        {
            println!("{{}}");
            return Ok(());
        }
        if phase_handoff {
            println!("{{}}");
            return Ok(());
        }
    }

    let route_hint = if event == "SessionStart" && !suppress_toplevel {
        mailbox_lifecycle::wake_route_hint(&base, &me)
    } else {
        String::new()
    };
    let swarm_toggle = if !suppress_toplevel {
        mailbox_swarm::swarm_command_context(&base, &me, &payload, &event, mid_turn)
    } else {
        String::new()
    };
    let side_notice = if !suppress_toplevel {
        mailbox_swarm::side_command_context(&base, &me, &payload, &event, mid_turn)
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
            println!(
                "{}",
                json!({"decision": "block", "reason": intercept_notice})
            );
            return Ok(());
        }
        if gemini && event == "PreInvocation" {
            identity::annotate_peer(&base, &session, &[("state", json!("idle"))]);
            println!(
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

    let delivered = mailbox_lifecycle::take(&base, &session, event == "Stop" || mid_turn, 20);
    let mut stale_wake_notice = String::new();
    if matches!(event.as_str(), "UserPromptSubmit" | "PreInvocation")
        && !mid_turn
        && delivered.is_empty()
        && let Some(notice_id) = mailbox_transcript::wake_notice_id(
            &payload,
            &session,
            me.get("accountHome").and_then(Value::as_str),
        )
    {
        let existing_mail = paths::inbox_dir(&base, &session)
            .ok()
            .and_then(|d| paths::read_json_file(&d.join(format!("{notice_id}.json"))));
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

    if event == "Stop" && !suppress_toplevel {
        mailbox_lifecycle::continuation_at_stop(&base, &me);
    }
    if event == "Stop" {
        if delivered.is_empty() {
            if gemini {
                println!("{{}}");
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
        println!(
            "{}",
            json!({
                "decision": decision,
                "reason": format!("Peer messages arrived while you worked:\n\n{context}"),
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
    if !others.is_empty()
        && !identity::is_run_peer(Some(&me))
        && !me_name.is_empty()
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
            println!("{{}}");
        } else {
            println!(
                "{}",
                json!({"injectSteps": [{"ephemeralMessage": context}]})
            );
        }
        return Ok(());
    }
    if !context.is_empty() {
        println!(
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
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use crate::paths::{fd_identity, lock_path_exclusive};
    use std::os::unix::fs::MetadataExt;

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
