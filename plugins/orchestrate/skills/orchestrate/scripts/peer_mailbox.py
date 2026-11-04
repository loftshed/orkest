# cspell:words herdr
"""Project-scoped peer mailbox: agent sessions in any harness exchange messages within one project.

Store: `<agent-executor cache>/mailbox-v1/`, local files only. `peers/<session>.json` is presence,
`inbox/<session>/<id>.json` one message each. Ids sort in delivery order. No model or provider calls.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import importlib.util
import math
import os
import re
import shlex
import subprocess  # noqa: F401 -- re-exported for callers/tests patching peer_mailbox.subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from functools import cache
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import mailbox_cli  # noqa: E402
from mailbox_cli import (  # noqa: E402, F401
    build_parser,
    caller,
    render_work,
    session_arg,
    table,
)
from mailbox_hooks import (  # noqa: E402, F401
    _MODEL_SET_STDOUT,
    _SWARM_SLASH_CMD,
    _SWARM_TAG_CMD,
    _TRANSCRIPT_TAIL_BYTES,
    _WAKE_NOTICE_ID,
    ANTIGRAVITY_NO_CONTINUE,
    CLEAR_PAIRING,
    MAILBOX_SENDER,
    OPEN_REQUEST_WINDOW,
    _end_session,
    adopt_cleared,
    end_session,
    hook,
    latest_user_prompt,
    offer_cleared_lead,
    succession_module,
    succession_notice,
    swarm_command_context,
    swarm_coordinator_context,
    transcript_model,
    wake_notice_id,
)
from mailbox_store import (  # noqa: E402, F401
    _PID_BIRTH_CACHE,
    _PID_BIRTH_TTL,
    _WORKSPACE_CACHE,
    ACCOUNT_HOMES,
    CHANNEL,
    CLIENT_ID,
    HARNESS_PROCESSES,
    HARNESSES,
    MAIL_SCHEMA,
    MARTIAN_NAMES,
    MAX_AGE,
    MAX_BYTES,
    MAX_RUN_BYTES,
    MAX_RUN_MESSAGES,
    MESSAGE_ID,
    NAME_RULE,
    NATIVE_HARNESS_TOOLS,
    NATIVE_MESSAGING,
    NOTICE,
    PEER_SCHEMA,
    RULE,
    RUN_FIELDS,
    RUN_ID,
    SCOPES,
    SESSION_ID,
    SHARED_PROCESS_BUSY_TTL,
    SHARED_PROCESS_IDLE_TTL,
    STATES,
    UNKNOWN_PID_TTL,
    MailboxError,
    _runtime_paths,
    account_home,
    account_label,
    account_route,
    base_dir,
    check_deadline,
    check_scope,
    claude_native_name,
    claude_session,
    claude_session_dirs,
    detect_harness,
    display_label,
    display_name,
    harness_fields,
    harness_name,
    harness_pid,
    inbox_dir,
    is_live,
    legacy_session_keys,
    load,
    locked,
    message_id,
    migrate_legacy_session,
    model_fields,
    model_name,
    model_slug,
    native_route,
    now,
    other_account,
    owns,
    parse_stamp,
    peer_name,
    peer_path,
    pick_martian,
    pid_alive,
    process_started,
    project,
    readable_name,
    register_facade,
    remote_identity,
    repository_name,
    root,
    run_deadline,
    runtime_effort,
    same_project,
    session_key,
    session_tag,
    short_agent_name,
    stamp,
    valid_message,
    valid_peer,
    valid_stamp,
    workspace,
    write,
)


@cache
def feedback_module() -> Any:
    path = Path(__file__).with_name("mailbox_feedback.py")
    spec = importlib.util.spec_from_file_location("agent_executor_mailbox_feedback", path)
    if spec is None or spec.loader is None:
        raise MailboxError("cannot load mailbox feedback")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def record_failure(base: Path, peer: dict[str, Any], operation: str, scope: str, error: Exception) -> None:
    """Record only a fixed error code, never the exception text or the rejected request."""
    code = (
        error.code
        if isinstance(error, MailboxError)
        else "storage_error"
        if isinstance(error, OSError)
        else "invalid_request"
    )
    category = (
        "routing" if code in {"peer_unavailable", "ambiguous_peer", "native_required", "self_address"} else "delivery"
    )
    scope = scope if scope in SCOPES else "project"
    feedback_module().observe(base, peer, code=code, category=category, operation=operation, scope=scope)


def feedback_request(base: Path, peer: dict[str, Any]) -> str:
    """Ask for the agent's needs once after a real failure, without contacting anyone else."""
    if not valid_peer(peer) or peer.get("feedbackRequested"):
        return ""
    with contextlib.suppress(OSError, ValueError):
        if feedback_module().directory(base) is not None:
            path = peer_path(base, peer["session"])
            with locked(path):
                current = load(path)
                if valid_peer(current) and not current.get("feedbackRequested"):
                    current["feedbackRequested"] = True
                    write(path, current)
                    return feedback_module().REQUEST
    return ""


def is_run_peer(peer: dict[str, Any] | None) -> bool:
    return bool(peer and isinstance(peer.get("run"), str) and peer.get("role") in {"worker", "conductor"})


def run_traffic(items: list[dict[str, Any]], run: str) -> list[dict[str, Any]]:
    """Messages of this run, leaving out anything an ordinary session of the same name received."""
    return [item for item in items if item.get("run") == run]


def alias_event(base: Path, event_id: str, run: str) -> None:
    """Record that a continuation event (from steering) belongs to an existing run."""
    write(base / "aliases" / f"{run_id_for(event_id)}.json", {"run": run})


def aliased_run(base: Path, event_id: str) -> str | None:
    alias = load(base / "aliases" / f"{run_id_for(event_id)}.json")
    run = alias.get("run") if alias else None
    return run if isinstance(run, str) and re.fullmatch(RUN_ID, run) else None


def run_id_for(name: str) -> str:
    """A valid run id for a job or event name, unchanged when it already is one."""
    if re.fullmatch(RUN_ID, name):
        return name
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip("-")[:60] or "run"
    return f"{stem}-{hashlib.sha1(name.encode()).hexdigest()[:8]}"


def is_run_record(peer: dict[str, Any] | None) -> bool:
    """A run peer with every field the run code reads."""
    if not (is_run_peer(peer) and all(isinstance(peer.get(field), str) for field in RUN_FIELDS)):
        return False
    if not re.fullmatch(RUN_ID, peer["run"]):
        return False  # the run id becomes a lock-file name
    try:
        session_key(peer["session"])
        session_key(peer["counterpart"])
    except MailboxError:
        return False
    return True


def run_peers(base: Path, run: str) -> dict[str, dict[str, Any]]:
    """The run's records, read from the two session ids open_run gives them rather than a scan of every peer."""
    found = {}
    if not re.fullmatch(RUN_ID, run):
        return found
    for role in ("conductor", "worker"):
        path = peer_path(base, f"run-{run}-{role}")
        peer = load(path)
        if is_run_record(peer) and peer["run"] == run and peer["role"] == role and owns(base, path, peer):
            found[role] = peer
    return found


def run_info(base: Path, run: str) -> dict[str, str] | None:
    found = run_peers(base, run)
    if not {"worker", "conductor"}.issubset(found):
        return None
    return {
        "run": run,
        "worker": found["worker"]["session"],
        "conductor": found["conductor"]["session"],
    }


def final_result(peer: dict[str, Any]) -> tuple[dict[str, Any], Path] | None:
    """The run's finished result and its file, following steers; None while there is none."""
    path = Path(peer["resultPath"])
    seen: set[Path] = set()
    while path.is_file() and path not in seen:
        seen.add(path)
        result = load(path)
        if result is None:
            return None
        steered = result.get("steered_to")
        continuation = steered.get("result_path") if isinstance(steered, dict) else None
        if isinstance(continuation, str) and continuation:
            path = Path(continuation)
            continue
        return (result, path) if result.get("finished_at") else None
    return None


def run_status(base: Path, run: str) -> str | None:
    """Return the terminal result status, following steers, or deadline_expired."""
    found = run_peers(base, run)
    peer = found.get("worker") or found.get("conductor")
    if not peer:
        raise MailboxError(f"no mailbox run {run!r}")
    if finished := final_result(peer):
        status = finished[0].get("status")
        return status if isinstance(status, str) and status else "finished"
    deadline = run_deadline(peer)
    if deadline is None or now() >= deadline:
        return "deadline_expired"
    return None


def run_closed_at(base: Path, run: str) -> dt.datetime | None:
    found = run_peers(base, run)
    peer = found.get("worker") or found.get("conductor")
    if not peer:
        return None
    if finished := final_result(peer):
        result, path = finished
        try:
            return parse_stamp(str(result["finished_at"]))
        except ValueError:
            return dt.datetime.fromtimestamp(path.stat().st_mtime, dt.UTC)
    deadline = run_deadline(peer)
    if deadline is None:
        # Retention runs from the last write, not from a made-up deadline in the past.
        stamps = []
        for item in found.values():
            with contextlib.suppress(OSError):
                stamps.append(peer_path(base, item["session"]).stat().st_mtime)
        return dt.datetime.fromtimestamp(max(stamps), dt.UTC) if stamps else now()
    return deadline if now() >= deadline else None


def open_run(
    base: Path,
    run_id: str,
    *,
    worker_harness: str,
    repository: str | Path,
    result_path: str | Path,
    deadline: str,
    worker_pid: int | None,
) -> dict[str, str]:
    """Open dedicated worker/conductor peers for one bounded run."""
    if not re.fullmatch(RUN_ID, run_id):
        raise MailboxError("run id must be 1-80 letters, digits, periods, underscores, or hyphens")
    if worker_harness == "agy":
        worker_harness = "gemini"
    if worker_harness not in HARNESSES:
        raise MailboxError(f"unknown worker harness {worker_harness!r}")
    check_deadline(deadline)
    repo = str(Path(repository).expanduser().resolve())
    result = str(Path(result_path).expanduser().resolve())
    sessions = {role: f"run-{run_id}-{role}" for role in ("conductor", "worker")}
    lock_path = base / "locks" / f"run-{run_id}.lock"
    with locked(lock_path):
        for session in sessions.values():
            with locked(peer_path(base, session)):
                migrate_legacy_session(base, session)
        found = run_peers(base, run_id)
        if any(peer.get("repository") != repo or peer.get("resultPath") != result for peer in found.values()):
            raise MailboxError(f"mailbox run {run_id!r} already belongs to another result")
        info = run_info(base, run_id)
        if info is not None:
            _update_run_deadline_locked(base, run_id, deadline)
            return info
        # Nothing yet, or an earlier open stopped after one peer: write the pair (again).

        conductor_harness = detect_harness()
        values = {
            "conductor": (conductor_harness, None),
            "worker": (worker_harness, worker_pid),
        }
        for role, session in sessions.items():
            harness, pid = values[role]
            moment = stamp()
            path = peer_path(base, session)
            # One write with the run fields, so the peer is never briefly an ordinary, reachable session.
            with locked(path):
                existing = load(path)
                if existing and not is_run_peer(existing) and is_live(existing):
                    raise MailboxError(f"session {session!r} belongs to a live ordinary peer")
                write(
                    path,
                    {
                        "schema": PEER_SCHEMA,
                        "session": session,
                        "harness": harness,
                        "cwd": repo,
                        "pid": pid,
                        "startedAt": (load(path) or {}).get("startedAt") or moment,
                        "lastSeenAt": moment,
                        "state": "waiting",
                        "name": peer_name(harness, repo, session),
                        "role": role,
                        "run": run_id,
                        "counterpart": sessions["worker" if role == "conductor" else "conductor"],
                        "repository": repo,
                        "resultPath": result,
                        "deadline": deadline,
                    },
                )
    return {"run": run_id, **sessions}


def _update_run_deadline_locked(base: Path, run: str, deadline: str) -> None:
    check_deadline(deadline)
    found = run_peers(base, run)
    if len(found) != 2:
        raise MailboxError(f"no complete mailbox run {run!r}")
    for peer in (found["worker"], found["conductor"]):
        path = peer_path(base, peer["session"])
        with locked(path):
            current = load(path)
            if not is_run_peer(current) or current.get("run") != run:
                raise MailboxError(f"mailbox run {run!r} changed while updating its deadline")
            current["deadline"] = deadline
            write(path, current)


def set_run_deadline(base: Path, run: str, deadline: str) -> None:
    if not re.fullmatch(RUN_ID, run):
        raise MailboxError("invalid run id")
    with run_lock(base, run):
        _update_run_deadline_locked(base, run, deadline)


def run_inbox(base: Path, run: str, role: str) -> list[dict[str, Any]]:
    peer = run_peers(base, run).get(role)
    if not peer:
        raise MailboxError(f"mailbox run {run!r} has no {role} session")
    return run_traffic(messages(base, peer["session"]), run)[:20]


def run_history(base: Path, run: str) -> dict[str, Any]:
    found = run_peers(base, run)  # read once: a prune may remove the run while the history is collected
    return {
        "run": run,
        "mailbox": found.get("conductor", {}).get("session"),
        "messages": sorted(run_messages(base, run, found), key=lambda item: item["id"]),
    }


def run_question(base: Path, session: str, identifier: str) -> dict[str, Any] | None:
    for message in messages(base, session, unread_only=False):
        if identifier in (message.get("id"), message.get("clientId")) and message.get("kind") == "question":
            return message
    return None


def find_run_question(base: Path, run: str, identifier: str, *, sender: str) -> dict[str, Any] | None:
    return next(
        (
            message
            for message in run_messages(base, run)
            if identifier in (message.get("id"), message.get("clientId"))
            and message.get("kind") == "question"
            and message.get("from", {}).get("session") == sender
        ),
        None,
    )


def run_messages(base: Path, run: str, found: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    found = run_peers(base, run) if found is None else found
    if len(found) != 2:
        raise MailboxError(f"no complete mailbox run {run!r}")
    history = []
    for peer in found.values():
        history.extend(run_traffic(messages(base, peer["session"], unread_only=False), run))
    return history


def run_ack(base: Path, session: str, identifiers: list[str]) -> list[str]:
    peer = load(peer_path(base, session))
    inbox = messages(base, session, unread_only=False)
    if is_run_peer(peer):
        inbox = run_traffic(inbox, peer["run"])
    found = []
    for identifier in identifiers:
        match = next(
            (message for message in inbox if identifier in (message.get("id"), message.get("clientId"))),
            None,
        )
        if not match:
            raise MailboxError(f"no message {identifier} in this inbox")
        mark_read(base, session, [match["id"]])
        found.append(identifier)
    return found


def run_lock(base: Path, run: str):
    """Held by every run send and by the runner while it publishes the run's result."""
    return locked(base / "locks" / f"run-{run}.lock")


def scoped_peers(
    base: Path, me: dict[str, Any], *, scope: str = "project", include_runs: bool = False
) -> list[dict[str, Any]]:
    check_scope(scope)
    return [
        peer
        for peer in peers(base, include_runs=include_runs)
        if scope == "cross-project" or peer["session"] == me.get("session") or same_project(me, peer)
    ]


def colleagues(base: Path, me: dict[str, Any]) -> list[dict[str, Any]]:
    """Other live sessions in this project, including worktrees and separate clones."""
    return [peer for peer in scoped_peers(base, me) if peer["session"] != me["session"]]


def describe_colleagues(rows: list[dict[str, Any]], me: dict[str, Any], elsewhere: dict[str, int] | None = None) -> str:
    """The roster: these sessions in full, and other teams (`elsewhere`, sessions per channel) as counts."""
    import mailbox_channels

    others = ", ".join(
        f"{count} in {name}" if name else f"{count} without a channel"
        for name, count in sorted((elsewhere or {}).items(), key=lambda item: (not item[0], item[0]))
    )
    teams = (
        f"Other sessions also work in this project ({others}); they are not listed here. The peer mailbox "
        "`peers` tool lists everyone with their channels."
        if others
        else ""
    )
    if not rows:
        return teams
    lines = [
        "Other agent sessions are working in this project right now. Check their `focus`, `board` scope, and "
        "`git status` silently first—do not message or wake a peer working on an unrelated task just to check in "
        "or claim files; only if you actually need to edit the same files or branch in the same checkout, reach out "
        f"in a friendly, relaxed way to agree on a split first ({RULE}). Say what you are working on with the peer "
        f"mailbox `focus` tool so they can see it too. {NAME_RULE} (for example `{rows[0]['name']}`)."
    ]
    for peer in rows:
        checkout = peer.get("checkout") or peer["cwd"]
        worktree = Path(checkout).name
        if any(
            (p.get("checkout") or p["cwd"]) != checkout and Path(p.get("checkout") or p["cwd"]).name == worktree
            for p in rows
        ):
            worktree = checkout
        where = "same checkout" if peer.get("checkout") == me.get("checkout") else f"worktree {worktree}"
        role = ", a delegated run worker" if peer.get("delegatedRun") else ""
        route = native_route(peer, me.get("harness"), me.get("accountHome"))
        native_hint = (
            f" [same harness: use {route['nativeTool']} with native address {route['nativeAddress']}]"
            if route["nativeTool"]
            else f" [{cross_account}]"
            if (cross_account := account_route(peer, me.get("harness"), me.get("accountHome")))
            else ""
        )
        channels = mailbox_channels.memberships(peer)
        tags = f" in channel {', '.join(channels)}" if channels else ""
        line = (
            f"- {display_label(peer)} [id: {peer['session']}] "
            f"({peer['harness']}, {peer['state']}{role}{tags}) repo {repository_name(peer)} "
            f"on {peer.get('branch', '?')}, {where}{native_hint}"
        )
        lines.append(line)
    if teams:
        lines.append(teams)
    return "\n".join(lines)


def set_focus(
    base: Path,
    session: str,
    text: str,
    *,
    model: str | None = None,
    harness_label: str | None = None,
    channels: list[str] | None = None,
    task_details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One line on what this session is working on, shown to every agent in the same project. `channels` also
    joins those channels; focus text alone never changes membership."""
    import mailbox_tasks

    details = mailbox_tasks.validate(task_details or {})
    if not text.strip():
        raise MailboxError("task focus cannot be empty")
    peer = load(peer_path(base, session))
    if valid_peer(peer) and not is_run_peer(peer):
        peer = annotate(
            base,
            session,
            focus=" ".join(text.split())[:200],
            **(model_fields(model) if model is not None else {}),
            **(harness_fields(harness_label) if harness_label is not None else {}),
        )
    if not valid_peer(peer) or is_run_peer(peer):  # also when the session ended in between
        raise MailboxError("register this session before setting its focus")
    if channels:
        import mailbox_channels

        peer = mailbox_channels.update(base, session, join=channels)
    if task_details:
        mailbox_tasks.save(base, peer, **details)
    return peer


def register(
    base: Path,
    *,
    session: str,
    harness: str,
    cwd: str,
    pid: int | None = None,
    state: str | None = None,
    cwd_source: str | None = None,
    model: str | None = None,
    model_source: str = "declared",
    account: str | None = None,
    effort: str | None = None,
) -> dict[str, Any]:
    """Create or refresh presence. A known pid, name, account and effort survive later refreshes that lack them.
    Claude's session metadata names its account; otherwise `account` is the caller's own account_home().
    The name is martian-model-effort-repo-tag; native addresses remain available for harness messaging."""
    if harness not in HARNESSES:
        raise MailboxError(f"unknown harness {harness!r}")
    if state is not None and state not in STATES:
        raise MailboxError(f"unknown state {state!r}")
    path = peer_path(base, session)
    with locked(path):
        migrate_legacy_session(base, session)
        peer = load(path) or {}
        first = not peer
        previous_pid = peer.get("pid")
        moment = stamp()
        if peer.get("harness") not in (None, harness, "unknown") and harness == "unknown":
            harness = peer["harness"]
        if first:
            import mailbox_channels

            # The launcher's assignment applies once: a later refresh never undoes an explicit leave.
            if assigned := mailbox_channels.launch_channels():
                peer["channels"] = assigned
        peer.update(
            schema=PEER_SCHEMA,
            session=session,
            harness=harness,
            cwd=cwd or peer.get("cwd") or "",
            pid=pid or peer.get("pid"),
            startedAt=peer["startedAt"] if valid_stamp(peer.get("startedAt")) else moment,
            lastSeenAt=moment,
            state=state or peer.get("state") or "idle",
        )
        if model is not None:
            peer.update(model_fields(model, model_source))
        if cwd_source:
            peer["cwdSource"] = cwd_source
        if not is_run_peer(peer):
            for key in ("repo", "checkout", "branch", "remotes"):
                peer.pop(key, None)
            peer.update(workspace(peer["cwd"]))
        fallback_name = peer_name(peer["harness"], peer.get("checkout") or peer["cwd"], session)
        native_name, profile, name_source = (
            claude_session(session, peer.get("pid")) if peer["harness"] == "claude" else (None, None, None)
        )
        if profile or account:
            peer["accountHome"] = profile or account
        if native_name:
            peer["nativeName"] = native_name
            peer["nativeNameSource"] = name_source or "derived"
        if effort:
            peer["effort"] = effort
        previous_name = peer.get("name")
        if is_run_peer(peer):
            peer["name"] = (
                peer.get("nativeName") if peer["harness"] == "claude" and peer.get("nativeName") else fallback_name
            )
        elif (
            peer.get("nativeName")
            and peer.get("nativeNameSource") != "derived"
            and peer["nativeName"].split("-", 1)[0] in MARTIAN_NAMES
        ):
            peer["name"] = peer["nativeName"]  # chosen at launch, e.g. claude --name "$(ork name)"
            peer["person"] = peer["nativeName"].split("-", 1)[0]
        else:
            # Keep the stored field for older clients, but migrate human names on the next refresh.
            if peer.get("person") not in MARTIAN_NAMES:
                if isinstance(peer.get("person"), str):
                    old_short_name = readable_name(peer["person"], repository_name(peer), None, None)
                    peer["aliases"] = [*peer.get("aliases", []), old_short_name][-8:]
                peer["person"] = pick_martian(session, taken_persons(base, session))
            peer["name"] = readable_name(
                peer["person"],
                repository_name(peer),
                peer.get("model"),
                peer.get("effort"),
                session_tag(session, peer.get("nativeName"), peer.get("nativeNameSource")),
            )
        repo = repository_name(peer)
        person = peer.get("person") or (peer["name"].split("-", 1)[0] if peer.get("name") else "agent")
        peer["shortName"] = short_agent_name(person, repo, session)
        if previous_name and previous_name != peer["name"]:
            # Earlier names keep resolving, so mail addressed before a model or effort change still arrives.
            peer["aliases"] = [*(alias for alias in peer.get("aliases", []) if alias != previous_name), previous_name][
                -8:
            ]
        if pid and (pid != previous_pid or not peer.get("pidBirth")):
            peer["pidBirth"] = process_started(pid)
        cohosted = co_hosted(base, peer)
        if cohosted:
            peer["sharedProcess"] = True
        else:
            peer.pop("sharedProcess", None)
        write(path, peer)
        if harness == "gemini":
            persist_agy_control(base, session, peer.get("pid"))
    # After this session's own lock is released: two sessions of one process may register at once.
    for other in cohosted:
        if not other.get("sharedProcess"):
            annotate(base, other["session"], sharedProcess=True)
    return peer


def co_hosted(base: Path, peer: dict[str, Any]) -> list[dict[str, Any]]:
    """Other ordinary sessions recorded on this one's process, as when one daemon hosts many conversations.
    A finished conversation of such a process never registers again, so it is marked from here."""
    pid, birth = peer.get("pid"), peer.get("pidBirth")
    if not isinstance(pid, int) or not birth or is_run_peer(peer):
        return []
    return [
        other
        for path in (base / "peers").glob("*.json")
        if valid_peer(other := load(path))
        and other["session"] != peer["session"]
        and not is_run_peer(other)
        and other.get("pid") == pid
        and other.get("pidBirth") == birth
        and owns(base, path, other)
    ]


def persist_agy_control(base: Path, session: str, pid: int | None) -> None:
    """Keep the Antigravity language-server endpoint and token in an owner-only file, never in the peer record."""
    import mailbox_wake

    address = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
    token = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")
    # Only a shell that names this very conversation may record its endpoint: an unset id proves nothing.
    if not address or not token or os.environ.get("ANTIGRAVITY_CONVERSATION_ID") != session:
        return
    if not re.fullmatch(mailbox_wake.LOOPBACK_ADDRESS, address):
        return  # the token must never be sent off this machine
    path = base / "wakes" / session_key(session) / "agy-control.json"
    write(path, {"lsAddress": address, "csrfToken": token, "pid": pid, "updatedAt": stamp()})
    path.chmod(0o600)


def check_attach_shell(session: str | None, harness: str | None) -> None:
    """Refuse an Antigravity attachment from a shell that does not belong to that conversation, before the
    command registers the session, so a rejected attempt leaves no record behind."""
    if harness == "gemini" and (not session or os.environ.get("ANTIGRAVITY_CONVERSATION_ID") != session):
        raise MailboxError("this shell does not belong to that Antigravity conversation; nothing was recorded")


def attach_wake_route(base: Path, me: dict[str, Any]) -> dict[str, Any]:
    """Record this session's own wake route from the runtime that holds it, then report its health.
    Antigravity puts its control endpoint only in the agent's tool shell, so neither its hooks nor the
    mailbox daemon can learn it; the agent attaches it once, from that shell."""
    import mailbox_wake

    if me.get("harness") == "gemini" and not (me.get("listener") or {}).get("adapter"):
        address = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
        token = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")
        if not address or not token:
            raise MailboxError(
                "run this from the Antigravity agent's own tool shell; its control endpoint is not set here"
            )
        if os.environ.get("ANTIGRAVITY_CONVERSATION_ID") != me["session"]:
            raise MailboxError("this shell does not belong to that Antigravity conversation; nothing was recorded")
        if not re.fullmatch(mailbox_wake.LOOPBACK_ADDRESS, address):
            raise MailboxError("the Antigravity control endpoint is not loopback; nothing was recorded")
        persist_agy_control(base, me["session"], me.get("pid"))
    return {"session": me["session"], "name": me.get("name"), **mailbox_wake.wake_health(me, base=base)}


def wake_route_hint(base: Path, me: dict[str, Any]) -> str:
    """An Antigravity conversation with no recorded wake route is told once how to attach one."""
    import mailbox_wake

    if me.get("harness") != "gemini" or (me.get("listener") or {}).get("adapter"):
        return ""
    if mailbox_wake.agy_route(base, me["session"])[0] is not None:
        return ""
    command = shlex.join(
        [
            "python3",
            str(Path(__file__).with_name("run_agent.py")),
            "mailbox",
            "attach-wake-route",
            "--session",
            me["session"],
            "--harness",
            "gemini",
        ]
    )
    return f"Peers cannot wake this conversation while it is idle yet. Run this once from your own shell: {command}"


def drop_if_dead(path: Path, moment: dt.datetime) -> bool:
    """Remove a stale interactive peer, re-checked under the lock register takes."""
    import mailbox_presence

    with locked(path):
        peer = load(path)
        if is_run_record(peer) or (valid_peer(peer) and is_live(peer, moment)):
            return False
        if valid_peer(peer):
            mailbox_presence.record(path.parent.parent, peer)
        path.unlink(missing_ok=True)
    mailbox_presence.deliver(path.parent.parent)
    return True


def unregister(base: Path, session: str) -> None:
    peer_path(base, session).unlink(missing_ok=True)


def peers(base: Path, *, prune_dead: bool = True, include_runs: bool = False) -> list[dict[str, Any]]:
    found = []
    moment = now()
    for path in sorted((base / "peers").glob("*.json")):
        peer = load(path)
        if not peer or peer.get("schema") != PEER_SCHEMA:
            continue
        try:
            canonical = peer_path(base, str(peer.get("session")))
        except MailboxError:
            continue
        if canonical != path and canonical.exists():
            continue  # a pre-%3A record of a session that has registered again
        if is_run_peer(peer):
            if include_runs and is_run_record(peer):
                found.append(peer)
            continue
        if not valid_peer(peer):
            if prune_dead:
                drop_if_dead(path, moment)
            continue
        if is_live(peer, moment):
            found.append(peer)
        elif prune_dead and not drop_if_dead(path, moment):
            # The session refreshed itself after the read above.
            fresh = load(path)
            if valid_peer(fresh) and not is_run_peer(fresh) and is_live(fresh, moment):
                found.append(fresh)
    return sorted(found, key=lambda peer: (str(peer.get("name")), str(peer.get("startedAt"))))


def taken_persons(base: Path, session: str) -> set[str]:
    """Martian names that other live peers already carry, stored under the legacy person field."""
    moment = now()
    return {
        peer["person"]
        for path in (base / "peers").glob("*.json")
        if valid_peer(peer := load(path))
        and peer["session"] != session
        and isinstance(peer.get("person"), str)
        and is_live(peer, moment)
    }


def _peer_aliases(peer: dict[str, Any]) -> set[str]:
    aliases = {peer["name"], peer["session"]}
    aliases.update(alias for alias in peer.get("aliases", []) if isinstance(alias, str))
    if isinstance(peer.get("person"), str):
        # person-repo stays the same across model and effort changes: the stable address.
        aliases.add(readable_name(peer["person"], repository_name(peer), None, None))
    if peer.get("nativeName"):
        aliases.add(str(peer["nativeName"]))
    with contextlib.suppress(Exception):
        aliases.add(peer_name(peer["harness"], peer.get("checkout") or peer["cwd"], peer["session"]))
    return aliases


def resolve(base: Path, address: str, *, sender: dict[str, Any], scope: str = "project") -> dict[str, Any]:
    """A name, a session id, or a unique session-id prefix of at least six characters."""
    moment = now()
    ended = [
        peer
        for path in (base / "peers").glob("*.json")
        if valid_peer(peer := load(path))
        and not is_run_peer(peer)
        and not is_live(peer, moment)
        and (scope == "cross-project" or peer["session"] == sender.get("session") or same_project(sender, peer))
        and (address in _peer_aliases(peer) or (len(address) >= 6 and peer["session"].startswith(address)))
    ]
    live = scoped_peers(base, sender, scope=scope)
    # A live session's current name wins over another live session's earlier name or alias.
    exact = [peer for peer in live if peer["name"] == address] or [
        peer for peer in live if address in _peer_aliases(peer)
    ]
    if not exact and len(address) >= 6:
        exact = [peer for peer in live if peer["session"].startswith(address)]
    if not exact:
        names = ", ".join(peer["name"] for peer in live) or "none"
        boundary = "in this project" if scope == "project" else "on this machine"
        detail = f" (session ended; live peers: {names})" if ended else f"; live peers: {names}"
        raise MailboxError(f"no live peer named {address!r} {boundary}{detail}", "peer_unavailable")
    if len(exact) > 1:
        options = ", ".join(f"{peer['name']} [{peer['session'][:8]}]" for peer in exact)
        raise MailboxError(f"{address!r} is ambiguous; address one by session prefix: {options}", "ambiguous_peer")
    return exact[0]


def sender_address(peer: dict[str, Any]) -> dict[str, Any]:
    address = {key: peer.get(key) for key in ("session", "name", "harness", "cwd")}
    address.update({key: value for key, value in project(peer).items() if key in {"repo", "remotes"}})
    return address


def run_send(
    base: Path,
    *,
    sender: dict[str, Any],
    to: str,
    text: str,
    kind: str | None,
    client_id: str | None,
    reply_to: str | None,
) -> dict[str, Any]:
    if kind not in {"question", "reply", "update"}:
        raise MailboxError("run messages require kind question, reply, or update")
    if client_id is not None and not re.fullmatch(CLIENT_ID, client_id):
        raise MailboxError("message ID must be 1-80 letters, digits, underscores, or hyphens")
    if not text.strip() or len(text.encode()) > MAX_RUN_BYTES:
        raise MailboxError("run message must be nonempty and at most 16 KiB")
    if (kind == "reply") != bool(reply_to):
        raise MailboxError("a reply requires --reply-to; other kinds cannot reply")
    if reply_to and not re.fullmatch(CLIENT_ID, reply_to):
        raise MailboxError("invalid reply-to message ID")
    run = sender["run"]
    pair = run_peers(base, run)
    if pair.get(sender["role"], {}).get("session") != sender["session"] or len(pair) != 2:
        raise MailboxError("run session is not registered")
    target = pair["worker" if sender["role"] == "conductor" else "conductor"]
    if to not in {target["session"], target["name"]}:
        raise MailboxError("run sessions may message only their counterpart")
    if target["counterpart"] != sender["session"]:
        raise MailboxError("run sessions may message only their counterpart")

    payload = {
        "schema": MAIL_SCHEMA,
        "from": sender_address(sender),
        "to": {"session": target["session"], "name": target["name"]},
        "text": text,
        "replyTo": reply_to,
        "kind": kind,
        "run": run,
    }
    if client_id is not None:
        payload["clientId"] = client_id
    with run_lock(base, run):
        all_messages = run_messages(base, run)
        existing = None
        if client_id is not None:
            existing = next(
                (
                    message
                    for message in messages(base, target["session"], unread_only=False)
                    if message.get("from", {}).get("session") == sender["session"]
                    and message.get("clientId") == client_id
                ),
                None,
            )
        if existing:
            if any(existing.get(key) != value for key, value in payload.items() if key != "schema"):
                raise MailboxError("message ID already used with different content")
            question = run_question(base, sender["session"], reply_to or "") if kind == "reply" else None
            if question and not question.get("readAt"):
                mark_read(base, sender["session"], [question["id"]])
            return existing
        ended = run_status(base, run)
        if ended:
            raise MailboxError("run is closed: " + ended)
        if len(all_messages) >= MAX_RUN_MESSAGES:
            raise MailboxError("run message limit reached; report the unresolved work")
        if kind == "reply":
            question = run_question(base, sender["session"], reply_to or "")
            if (
                not question
                or question.get("from", {}).get("session") != sender["counterpart"]
                or question.get("to", {}).get("session") != sender["session"]
            ):
                raise MailboxError("reply must address a question sent to this sender")
            question_ids = {question["id"]}
            if question.get("clientId") is not None:
                question_ids.add(question["clientId"])
            if any(
                message.get("replyTo") in question_ids
                and message.get("kind") == "reply"
                and message.get("from", {}).get("session") == sender["session"]
                for message in all_messages
            ):
                raise MailboxError("question already has a reply")
        payload.update(id=message_id(), sentAt=stamp(), readAt=None)
        write(inbox_dir(base, target["session"]) / f"{payload['id']}.json", payload)
        if kind == "reply":
            mark_read(base, sender["session"], [question["id"]])
    return payload


def expire_send_operation(
    base: Path, operation: Path, entry: dict[str, Any], moment: dt.datetime | None = None
) -> bool:
    moment = moment or now()
    if entry.get("schema") == "agent-executor.send-operation.expired.v1":
        return True
    message = entry.get("message")
    if entry.get("schema") != "agent-executor.send-operation.v1" or not valid_message(message):
        return False
    if moment - parse_stamp(message["sentAt"]) <= MAX_AGE:
        return False
    payload = entry.get("payload")
    caller_info = payload.get("caller") if isinstance(payload, dict) else None
    session = caller_info.get("session") if isinstance(caller_info, dict) else None
    if not isinstance(session, str) or not re.fullmatch(SESSION_ID, session):
        return False
    # Expired keys cannot recreate pruned messages. Active callers retain a small body-free tombstone.
    peer = load(peer_path(base, session))
    if valid_peer(peer) and is_live(peer):
        write(
            operation,
            {
                "schema": "agent-executor.send-operation.expired.v1",
                "session": session,
                "expiredAt": stamp(moment),
                "messageId": message["id"],
            },
        )
    else:
        operation.unlink(missing_ok=True)
    return True


def prune_send_journals(base: Path) -> None:
    for operation in (base / "journal").glob("*/*.json"):
        with locked(operation):
            entry = load(operation)
            if not entry:
                continue
            if entry.get("schema") == "agent-executor.send-operation.expired.v1":
                session = entry.get("session")
                if not isinstance(session, str) or not re.fullmatch(SESSION_ID, session):
                    continue
                peer = load(peer_path(base, session))
                if not valid_peer(peer) or not is_live(peer):
                    operation.unlink(missing_ok=True)
            else:
                expire_send_operation(base, operation, entry)


def send(
    base: Path,
    *,
    sender: dict[str, Any],
    to: str,
    text: str,
    reply_to: str | None = None,
    kind: str | None = None,
    client_id: str | None = None,
    scope: str = "project",
    wake: bool = False,
    idempotency_key: str | None = None,
    native_unreachable: str | None = None,
    channel: str | None = None,
    post_id: str | None = None,
) -> dict[str, Any]:
    """Deliver to a live peer. `native_unreachable` says why native tools could not reach a peer of the
    sender's own harness and account; it lifts the native-only refusal and is recorded on the message.
    `channel` and `post_id` mark one recipient's copy of a channel post (see mailbox_channels.post)."""
    check_scope(scope)
    if native_unreachable is not None and (
        not isinstance(native_unreachable, str) or not native_unreachable.strip() or len(native_unreachable) > 200
    ):
        raise MailboxError("nativeUnreachable must say in at most 200 characters what native messaging failed to do")
    if is_run_peer(sender):
        return run_send(
            base,
            sender=sender,
            to=to,
            text=text,
            kind=kind,
            client_id=client_id or idempotency_key,
            reply_to=reply_to,
        )
    if not text.strip():
        raise MailboxError("message text is empty")
    if len(text.encode()) > MAX_BYTES:
        raise MailboxError(f"message is over {MAX_BYTES // 1024} KiB; send a path to a file instead")
    if reply_to is not None and not re.fullmatch(MESSAGE_ID, reply_to):
        raise MailboxError(f"invalid replyTo id: {reply_to!r}")
    reply_to = thread_id(base, sender["session"], reply_to)
    if idempotency_key is not None and (
        not isinstance(idempotency_key, str) or not re.fullmatch(CLIENT_ID, idempotency_key)
    ):
        raise MailboxError("idempotencyKey must be 1-80 letters, digits, underscores or hyphens")
    if idempotency_key:
        previous_path = (
            base
            / "journal"
            / session_key(sender["session"])
            / (hashlib.sha256(idempotency_key.encode()).hexdigest() + ".json")
        )
        if previous_path.exists():
            with locked(previous_path):
                previous = load(previous_path)
                if previous and expire_send_operation(base, previous_path, previous):
                    raise MailboxError(
                        "idempotencyKey replay window expired after seven days; do not retry the old delivery"
                    )
    try:
        target = resolve(base, to, sender=sender, scope=scope)
    except MailboxError as failure:
        if not idempotency_key or failure.code != "peer_unavailable":
            raise
        operation = (
            base
            / "journal"
            / session_key(sender["session"])
            / (hashlib.sha256(idempotency_key.encode()).hexdigest() + ".json")
        )
        entry = load(operation)
        snapshot = entry.get("target") if entry else None
        if not isinstance(snapshot, dict):
            raise
        address = to.strip()
        matches = address in {snapshot.get("session"), snapshot.get("name")} or (
            len(address) >= 6 and snapshot.get("session", "").startswith(address)
        )
        if not matches or (scope == "project" and not same_project(sender, snapshot)):
            raise
        # A committed operation remains replayable when its recipient has since left.
        # The full caller/delivery fingerprint is checked again under the operation lock below.
        target = snapshot
    if target["session"] == sender["session"]:
        raise MailboxError("that address is this session", "self_address")
    native = NATIVE_MESSAGING.get(sender.get("harness"))
    # Another account of the same harness is out of native reach, so the mailbox carries that traffic. Channel
    # posts always do: no native tool has channels, so the user exempted them from native-first.
    native_only = (
        not channel and native and target["harness"] == sender.get("harness") and not other_account(sender, target)
    )
    if native_only and not native_unreachable:
        route = native_route(target, sender.get("harness"), sender.get("accountHome"))
        native_addr = route["nativeAddress"] or target["name"]
        raise MailboxError(
            f"{target['name']} is a {target['harness']} session of your account too; message it with {native} "
            f"(native address: {native_addr}; session: {target['session']}), not the mailbox. "
            "Only if your native tools cannot find or reach it, resend with nativeUnreachable "
            "(CLI: --native-unreachable) saying what you tried",
            "native_required",
        )
    if native_only:
        # Fixed code only: the reason travels with the message, never into feedback.
        feedback_module().observe(
            base, sender, code="native_unreachable_override", category="routing", operation="send", scope=scope
        )

    quiet_unrelated = not channel and unrelated_task(base, sender, target, reply_to=reply_to, scope=scope)
    message = {
        "schema": MAIL_SCHEMA,
        "id": message_id(),
        "from": sender_address(sender),
        "to": {"session": target["session"], "name": target["name"]},
        "text": text,
        "replyTo": reply_to,
        "sentAt": stamp(),
        "readAt": None,
        "scope": scope,
    }
    if native_only:
        message["nativeUnreachable"] = " ".join(native_unreachable.split())
    if channel:
        # `wake` records whether the post asked for activation: only such posts may extend a turn at Stop.
        message.update(channel=channel, postId=post_id, wake=bool(wake))
    elif quiet_unrelated:
        message.update(unrelatedTask=True, wake=False)
    if idempotency_key is None:
        write(inbox_dir(base, target["session"]) / f"{message['id']}.json", message)
        result = delivery_result(message, target)
        if wake:
            if quiet_unrelated:
                result["wake"] = unrelated_wake_result()
                remember_wake(base, target, message["id"], result["wake"])
            else:
                result["wake"] = delivery_wake(base, target, message["id"], scope)
        return result
    if not isinstance(idempotency_key, str) or not re.fullmatch(CLIENT_ID, idempotency_key):
        raise MailboxError("idempotencyKey must be 1-80 letters, digits, underscores or hyphens")
    payload = {
        "to": target["session"],
        "text": text,
        "replyTo": reply_to,
        "scope": scope,
        "wake": wake,
        "caller": {key: sender.get(key) for key in ("session", "harness", "cwd", "repo", "remotes", "run")},
        **({"channel": channel, "postId": post_id} if channel else {}),
    }
    operation = (
        base
        / "journal"
        / session_key(sender["session"])
        / (hashlib.sha256(idempotency_key.encode()).hexdigest() + ".json")
    )
    with locked(operation):
        entry = load(operation)
        if operation.exists() and entry is None:
            raise MailboxError("send recovery journal is unreadable; inspect storage before retrying")
        if entry:
            if expire_send_operation(base, operation, entry):
                raise MailboxError(
                    "idempotencyKey replay window expired after seven days; do not retry the old delivery"
                )
            if entry.get("schema") != "agent-executor.send-operation.v1" or entry.get("payload") != payload:
                raise MailboxError("idempotencyKey was already used for different delivery or caller context")
            if entry.get("response"):
                return entry["response"]
            if not valid_message(entry.get("message")):
                raise MailboxError("send recovery journal is invalid; inspect storage before retrying")
            message = entry["message"]
        else:
            entry = {
                "schema": "agent-executor.send-operation.v1",
                "payload": payload,
                "message": message,
                "wakeAttempted": False,
                "target": target,
            }
            # Allocate and fsync the operation/message identity before any delivery or external activation.
            write(operation, entry)
        path = inbox_dir(base, target["session"]) / f"{message['id']}.json"
        stored = load(path)
        if path.exists():
            if not valid_message(stored) or any(
                stored.get(key) != value for key, value in message.items() if key != "readAt"
            ):
                raise MailboxError(
                    "send recovery conflicts with the persisted delivery; inspect storage before retrying"
                )
        else:
            write(path, message)
        result = delivery_result(message, target)
        if wake:
            if message.get("unrelatedTask"):
                result["wake"] = unrelated_wake_result()
                remember_wake(base, target, message["id"], result["wake"])
            elif entry.get("wakeAttempted"):
                result["wake"] = {
                    "status": "uncertain",
                    "phase": "unknown",
                    "reason": "delivery recovered; the earlier activation outcome is unknown, so recovery retries it",
                }
                remember_wake(base, target, message["id"], result["wake"])
            else:
                entry["wakeAttempted"] = True
                write(operation, entry)
                result["wake"] = delivery_wake(base, target, message["id"], scope)
        entry["response"] = result
        write(operation, entry)
        return result


def unrelated_wake_result() -> dict[str, str]:
    return {
        "status": "queued",
        "phase": "not-sent",
        "reason": "recipient is working on an unrelated task; message queued quietly for its next turn boundary",
    }


def shares_swarm_room(base: Path, first: dict[str, Any], second: dict[str, Any]) -> bool:
    """Whether two peers are bound to the same Orkest room."""
    pair = {first.get("session"), second.get("session")} - {None}
    if len(pair) < 2:
        return False
    with contextlib.suppress(OSError):
        for path in (base / "rooms").glob("*.json"):
            room = load(path)
            if not isinstance(room, dict) or not isinstance(room.get("agents"), list):
                continue
            members = {
                binding.get("id")
                for member in [room.get("conductor"), *room["agents"]]
                if isinstance(member, dict) and isinstance(binding := member.get("session"), dict)
            }
            if pair <= members:
                return True
    return False


def unrelated_task(
    base: Path,
    sender: dict[str, Any],
    target: dict[str, Any],
    *,
    reply_to: str | None = None,
    scope: str = "project",
) -> bool:
    """Whether `target` is working on a separate task with no shared channel, workboard item, or active thread."""
    if scope == "cross-project" or is_run_peer(sender) or is_run_peer(target) or reply_to is not None:
        return False
    if any(
        message.get("from", {}).get("session") == target.get("session")
        for message in iter_messages(base, sender["session"], unread_only=False)
    ) or any(
        message.get("from", {}).get("session") == sender.get("session") and message.get("readAt")
        for message in iter_messages(base, target["session"], unread_only=False)
    ):
        return False
    if shares_swarm_room(base, sender, target):
        return False
    import mailbox_channels
    import mailbox_work

    sender_channels = set(mailbox_channels.memberships(sender))
    target_channels = set(mailbox_channels.memberships(target))
    if sender_channels & target_channels:
        return False
    if mailbox_work.shares_active_work(base, sender, target):
        return False
    if sender_channels or target_channels:
        return True
    sender_focus = str(sender.get("focus") or "").strip()
    target_focus = str(target.get("focus") or "").strip()
    if sender_focus and target_focus:
        return sender_focus.lower() != target_focus.lower()
    if mailbox_work.assigned(base, target):
        return True
    with contextlib.suppress(MailboxError, OSError, ValueError, AttributeError):
        import agent_progress

        target_progress = agent_progress.read(base, target)
        if target_progress and target_progress.get("stage") in {"planning", "working", "testing", "review", "blocked"}:
            sender_progress = agent_progress.read(base, sender)
            if sender_progress and (
                sender_progress.get("task", "").strip().lower() == target_progress.get("task", "").strip().lower()
                or sender_progress.get("goal", "").strip().lower() == target_progress.get("goal", "").strip().lower()
            ):
                return False
            return not (
                sender_focus
                and sender_focus.lower()
                in {
                    target_progress.get("task", "").strip().lower(),
                    target_progress.get("goal", "").strip().lower(),
                }
            )
    return bool(target_focus and not sender_focus)


def delivery_result(message: dict[str, Any], target: dict[str, Any]) -> dict[str, Any]:
    return {"id": message["id"], "to": target["name"], "toState": target["state"], "toHarness": target["harness"]}


def delivery_wake(base: Path, target: dict[str, Any], identifier: str, scope: str) -> dict[str, Any]:
    check_scope(scope)
    import mailbox_wake

    result = mailbox_wake.wake(target, identifier, base=base)
    remember_wake(base, target, identifier, result)
    return result


def remember_wake(base: Path, target: dict[str, Any], identifier: str, result: dict[str, Any]) -> None:
    """Keep a wake-requesting message's intent so the daemon can retry it; never fail the send over it."""
    with contextlib.suppress(OSError, ValueError, MailboxError):
        import wake_recovery

        wake_recovery.record_intent(base, target, identifier, result)


def _message_file_state(path: Path) -> tuple[int, int, int, int, int] | None:
    try:
        info = path.stat()
        return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns
    except OSError:
        return None


def iter_messages(
    base: Path,
    session: str,
    *,
    unread_only: bool = True,
    read_cache: dict[Path, tuple[int, int, int, int, int]] | None = None,
) -> Iterator[dict[str, Any]]:
    for path in sorted(inbox_dir(base, session).glob("*.json")):
        state = None
        if read_cache is not None and unread_only:
            state = _message_file_state(path)
            if state is not None and read_cache.get(path) == state:
                continue
            read_cache.pop(path, None)
        message = load(path)
        if not valid_message(message) or message["id"] != path.stem:
            continue
        if unread_only and message.get("readAt"):
            # Cache only a stable, acknowledged file; a replacement must be read again.
            if (
                read_cache is not None
                and state is not None
                and state == _message_file_state(path)
                and len(read_cache) < 8192
            ):
                read_cache[path] = state
        else:
            yield message


def messages(base: Path, session: str, *, unread_only: bool = True) -> list[dict[str, Any]]:
    return list(iter_messages(base, session, unread_only=unread_only))


def allowed_message(peer: dict[str, Any], message: dict[str, Any], scope: str) -> bool:
    if is_run_peer(peer):
        return message.get("run") == peer["run"]
    explicitly_addressed = (
        message.get("scope") == "cross-project" and message.get("to", {}).get("session") == peer["session"]
    )
    return not message.get("run") and (
        explicitly_addressed or scope == "cross-project" or same_project(peer, message["from"])
    )


def iter_incoming(
    base: Path,
    session: str,
    *,
    unread_only: bool = True,
    scope: str = "project",
    operation: str = "inbox",
    read_cache: dict[Path, tuple[int, int, int, int, int]] | None = None,
) -> Iterator[dict[str, Any]]:
    """Include explicitly addressed cross-project mail without widening peer discovery."""
    check_scope(scope)
    peer = load(peer_path(base, session))
    if not valid_peer(peer):
        return
    for message in iter_messages(base, session, unread_only=unread_only, read_cache=read_cache):
        if allowed_message(peer, message, scope):
            yield message
        elif not is_run_peer(peer):
            feedback_module().observe(
                base,
                peer,
                code="context_filtered",
                category="context",
                operation=operation,
                scope=scope,
                message_ids=[message["id"]],
                repeat=False,
            )


def incoming(
    base: Path, session: str, *, unread_only: bool = True, scope: str = "project", operation: str = "inbox"
) -> list[dict[str, Any]]:
    return list(iter_incoming(base, session, unread_only=unread_only, scope=scope, operation=operation))


def bounded_messages(
    rows: Iterator[dict[str, Any]], *, limit: int, offset: int = 0, max_bytes: int | None = None
) -> tuple[list[dict[str, Any]], bool]:
    page: list[dict[str, Any]] = []
    size = 0
    for index, message in enumerate(rows):
        if index < offset:
            continue
        cost = len(message["text"].encode("utf-8"))
        if len(page) >= limit or (page and max_bytes is not None and size + cost > max_bytes):
            return page, True
        # Always deliver a single oversized body intact. A budget must never consume hidden/truncated mail.
        page.append(message)
        size += cost
    return page, False


def message_page(
    base: Path, session: str, *, limit: int = 20, offset: int = 0, max_bytes: int | None = None, scope: str = "project"
) -> tuple[list[dict[str, Any]], bool]:
    return bounded_messages(iter_incoming(base, session, scope=scope), limit=limit, offset=offset, max_bytes=max_bytes)


def mark_one(base: Path, session: str, identifier: str) -> bool | None:
    """Mark a message read under its lock: True if this call did, False if it already was, None if absent."""
    path = inbox_dir(base, session) / f"{identifier}.json"
    with locked(path):
        message = load(path)
        if not valid_message(message):
            return None
        if message.get("readAt"):
            return False
        message["readAt"] = stamp()
        write(path, message)
        return True


def mark_read(base: Path, session: str, ids: list[str]) -> list[str]:
    for identifier in ids:
        if not re.fullmatch(MESSAGE_ID, identifier):
            raise MailboxError(f"invalid message id: {identifier!r}")
        if mark_one(base, session, identifier) is None:
            raise MailboxError(f"no message {identifier} in this inbox")
    return list(ids)


def claim(base: Path, session: str, found: list[dict[str, Any]], *, scope: str = "project") -> list[dict[str, Any]]:
    """Mark messages read and keep only those this call was first to mark, so each reader gets its own."""
    check_scope(scope)
    peer = load(peer_path(base, session))
    if not valid_peer(peer):
        return []
    return [
        message for message in found if allowed_message(peer, message, scope) and mark_one(base, session, message["id"])
    ]


def take(
    base: Path,
    session: str,
    *,
    mark: bool = True,
    limit: int = 20,
    scope: str = "project",
    eligible: Callable[[dict[str, Any]], bool] | None = None,
) -> list[dict[str, Any]]:
    """Unread mail, claimed. `eligible` picks which mail to claim; the rest stays unread for a later read."""

    def unread_now() -> list[dict[str, Any]]:
        found = incoming(base, session, scope=scope)
        return [message for message in found if eligible(message)] if eligible else found

    if not mark:
        return unread_now()[:limit]
    taken: list[dict[str, Any]] = []
    while len(taken) < limit:  # every pass claims a message, here or in a competing reader, so this ends
        # Re-read after each claim: a concurrent reader may have taken part of the last snapshot.
        unread = unread_now()[: limit - len(taken)]
        if not unread:
            break
        taken += claim(base, session, unread, scope=scope)
    return taken


def thread_id(base: Path, session: str, reply_to: str | None) -> str | None:
    """A reply to a channel post threads on its postId, whichever member's copy it names, so the poster's
    wait(replyTo=postId) and channel history agree with it."""
    if reply_to is None or not re.fullmatch(MESSAGE_ID, reply_to):
        return reply_to
    for path in sorted((base / "inbox").glob(f"*/{reply_to}.json")):
        message = load(path)
        if not valid_message(message) or not isinstance(message.get("postId"), str):
            continue
        if session in {message["from"].get("session"), message["to"].get("session")}:
            return message["postId"]
    return reply_to


def reply_target_status(base: Path, session: str, reply_to: str) -> dict[str, Any] | None:
    """Recipient liveness and read status for a sent message ID when a reply wait times out."""
    peer = load(peer_path(base, session))
    if is_run_peer(peer):
        question = find_run_question(base, peer["run"], reply_to, sender=session)
        if not question:
            return None
        target_session = str(peer.get("counterpart") or "")
        target = load(peer_path(base, target_session)) if re.fullmatch(SESSION_ID, target_session) else None
        return {
            "name": (target or {}).get("name") or target_session,
            "session": target_session,
            "state": "closed" if run_status(base, peer["run"]) else (target or {}).get("state") or "idle",
            "messageRead": bool(question.get("readAt")),
        }
    if not re.fullmatch(MESSAGE_ID, reply_to):
        return None
    for path in sorted((base / "inbox").glob(f"*/{reply_to}.json")):
        message = load(path)
        if not valid_message(message) or message["from"].get("session") != session:
            continue
        target_session = str(message["to"].get("session") or "")
        target_name = str(message["to"].get("name") or target_session)
        target = load(peer_path(base, target_session)) if re.fullmatch(SESSION_ID, target_session) else None
        if valid_peer(target) and is_live(target):
            state = str(target.get("state") or "idle")
            target_name = str(target.get("name") or target_name)
        else:
            state = "offline"
        return {
            "name": target_name,
            "session": target_session,
            "state": state,
            "messageRead": bool(message.get("readAt")),
        }
    return None


def wait(
    base: Path,
    session: str,
    *,
    timeout: float,
    reply_to: str | None = None,
    mark: bool = True,
    poll: float = 0.25,
    cancelled: threading.Event | None = None,
    scope: str = "project",
    limit: int = 20,
    max_bytes: int | None = None,
) -> dict[str, Any]:
    check_scope(scope)
    if not math.isfinite(timeout) or timeout <= 0:
        raise MailboxError("timeout must be a finite number of seconds greater than zero")
    until = time.monotonic() + timeout
    peer = load(peer_path(base, session))
    run_peer = peer if is_run_peer(peer) else None
    question_ids = {reply_to, thread_id(base, session, reply_to)} if reply_to else set()
    if run_peer and reply_to:
        question = find_run_question(base, run_peer["run"], reply_to, sender=session)
        if not question:
            raise MailboxError("wait requires a question sent by this recipient")
        question_ids = {question["id"], question.get("clientId")} - {None}
    read_cache: dict[Path, tuple[int, int, int, int, int]] = {}
    while True:
        # A run reply stays replayable after acknowledgement.
        rows = iter_incoming(
            base, session, unread_only=not (run_peer and reply_to), scope=scope, operation="wait", read_cache=read_cache
        )
        if run_peer:
            rows = (message for message in rows if message.get("run") == run_peer["run"])
        if reply_to:
            rows = (
                message
                for message in rows
                if message.get("replyTo") in question_ids and (not run_peer or message.get("kind") == "reply")
            )
        unread, more = bounded_messages(rows, limit=limit, max_bytes=max_bytes)
        if unread:
            if mark and not run_peer:
                unread = claim(base, session, unread, scope=scope)
                if not unread:
                    continue  # another reader took them first; keep waiting
            result = {"status": "messages", "messages": unread, "has_more": more}
            if run_peer:
                result.update(mailbox=session, run_status=run_status(base, run_peer["run"]))
            return result
        if run_peer:
            ended = run_status(base, run_peer["run"])
            if ended:
                return {"status": "closed", "reason": ended, "mailbox": session}
        remaining = until - time.monotonic()
        if remaining <= 0:
            timeout_result: dict[str, Any] = {"status": "timed_out", "messages": []}
            if reply_to:
                target_status = reply_target_status(base, session, reply_to)
                if target_status is not None:
                    timeout_result["recipient"] = target_status
                feedback_module().observe(
                    base,
                    peer or {"session": session},
                    code="reply_timeout",
                    category="delivery",
                    operation="wait",
                    scope=scope,
                    measurements={"waitSeconds": round(timeout, 2)},
                )
            return timeout_result
        if cancelled is not None:
            if cancelled.wait(min(poll, remaining)):
                return {"status": "cancelled", "messages": []}
        else:
            time.sleep(min(poll, remaining))


def prune(base: Path) -> dict[str, int]:
    removed = {"peers": 0, "messages": 0}
    moment = now()
    run_sessions: set[str] = set()
    for path in (base / "peers").glob("*.json"):
        peer = load(path)
        if not is_run_record(peer):
            continue
        run = peer["run"]
        run_sessions.add(peer["session"])
        # Under the run's lock, so a reopen or a send cannot land between the decision and the delete.
        with run_lock(base, run):
            closed_at = run_closed_at(base, run)
            expired = (
                [item["session"] for item in run_peers(base, run).values()]
                if (closed_at and moment - closed_at > MAX_AGE)
                else []
            )
            for session in expired:
                peer_path(base, session).unlink(missing_ok=True)
                inbox = inbox_dir(base, session)
                if inbox.exists():
                    for message_path in inbox.glob("*.json"):
                        message_path.unlink(missing_ok=True)
                        removed["messages"] += 1
                    with contextlib.suppress(OSError):
                        inbox.rmdir()
                removed["peers"] += 1
    for path in [
        *(base / "aliases").glob("*.json"),
        *(base / "delegations").glob("*.json"),
        # Channel posts follow mail retention; history shows where they stop.
        *(base / "channels").glob("*/*.json"),
    ]:
        with contextlib.suppress(OSError):
            if time.time() - path.stat().st_mtime > MAX_AGE.total_seconds():
                path.unlink()
    for path in (base / "peers").glob("*.json"):
        if drop_if_dead(path, now()):
            removed["peers"] += 1
    cutoff = now() - MAX_AGE
    for path in (base / "inbox").glob("*/*.json"):
        if path.parent.name in {session_key(session) for session in run_sessions}:
            continue
        message = load(path)
        try:
            expired = not message or parse_stamp(str(message.get("sentAt"))) < cutoff
        except ValueError:
            expired = True
        if expired:
            path.unlink(missing_ok=True)
            path.with_suffix(".lock").unlink(missing_ok=True)
            removed["messages"] += 1
    for lock_file in [*(base / "peers").glob("*.lock"), *(base / "inbox").glob("*/*.lock")]:
        if not lock_file.with_suffix(".json").exists():
            lock_file.unlink(missing_ok=True)
    for inbox_sub in (base / "inbox").glob("*"):
        if (
            inbox_sub.is_dir()
            and not (base / "peers" / f"{inbox_sub.name}.json").exists()
            and not any(inbox_sub.glob("*.json"))
        ):
            for lock_file in inbox_sub.glob("*.lock"):
                lock_file.unlink(missing_ok=True)
            with contextlib.suppress(OSError):
                inbox_sub.rmdir()
    for wake_sub in (base / "wakes").glob("*"):
        with contextlib.suppress(OSError):
            if (
                wake_sub.is_dir()
                and not (base / "peers" / f"{wake_sub.name}.json").exists()
                and time.time() - wake_sub.stat().st_mtime > MAX_AGE.total_seconds()
            ):
                for item in wake_sub.glob("*"):
                    item.unlink(missing_ok=True)
                wake_sub.rmdir()
    for lock_file in (base / "locks").glob("*.lock"):
        with contextlib.suppress(OSError):
            if time.time() - lock_file.stat().st_mtime > MAX_AGE.total_seconds():
                lock_file.unlink(missing_ok=True)
    prune_send_journals(base)
    import mailbox_channels

    mailbox_channels.prune_operations(base)
    import mailbox_tasks

    mailbox_tasks.prune(base)
    return removed


def escape(value: Any) -> str:
    return str(value).replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def render(message: dict[str, Any], recipient: str | None = None) -> str:
    """One message in its wrapper. `recipient` carries the reader's own name, so a session sees it on every message;
    it is not called `to`, which a reply could copy into send(to=...)."""
    sender = message["from"]
    addressed = message.get("to") if isinstance(message.get("to"), dict) else {}
    attributes = f'id="{escape(message["id"])}" from="{escape(sender.get("name"))}" '
    if recipient := recipient or addressed.get("name"):
        attributes += f'recipient="{escape(recipient)}" '
    attributes += f'harness="{escape(sender.get("harness"))}" cwd="{escape(sender.get("cwd"))}" sent="{escape(message["sentAt"])}"'
    if message.get("replyTo"):
        attributes += f' reply-to="{escape(message["replyTo"])}"'
    if message.get("channel"):
        attributes += f' channel="{escape(message["channel"])}" post="{escape(message.get("postId"))}"'
    # A peer cannot close the wrapper early and pose as the harness or the user.
    body = re.sub(r"</?\s*peer-message", lambda match: match.group(0).replace("<", "&lt;"), message["text"])
    return f"<peer-message {attributes}>\n{body}\n</peer-message>"


def render_all(found: list[dict[str, Any]], recipient: str | None = None) -> str:
    if not found:
        return ""
    blocks = "\n\n".join(render(message, recipient) for message in found)
    hint = (
        "Reply only when an answer or action is needed, using send(to=sender, replyTo=id). "
        "Keep a relaxed, friendly, natural teammate tone—no stiff formality needed, and feel free to credit "
        "helpful context or findings inside your substantive response—while using wake=false for FYI or progress "
        "updates; do not send standalone acknowledgement-only replies. "
        "A completion that unblocks work may need a wake. Use your native way of messaging within your harness "
        "and account."
    )
    if any(message.get("channel") for message in found):
        hint += (
            " A message with a channel went to that channel's members: answer the group with "
            "send(channel=<that channel>, replyTo=id), or only its sender with send(to=sender, replyTo=id); channel "
            "posts always go through the peer mailbox."
        )
    return f"{blocks}\n\n{NOTICE}\n{hint}"


def notify(
    base: Path | None,
    to: dict[str, Any],
    text: str,
    reply_to: str | None = None,
    *,
    sender: dict[str, Any] | None = None,
    scope: str = "cross-project",
    message: dict[str, Any] | None = None,
    deliver: bool = True,
    **extra: Any,
) -> dict[str, Any]:
    """A notice from the mailbox itself to one live session, delivered with its next mail."""
    msg = message or {
        "schema": MAIL_SCHEMA,
        "id": message_id(),
        "from": {**(sender_address(sender) if sender else {}), **MAILBOX_SENDER},
        "to": {"session": to["session"], "name": to.get("name")},
        "text": text,
        "replyTo": reply_to,
        "sentAt": stamp(),
        "readAt": None,
        "scope": scope,
        "kind": "notice",
        **extra,
    }
    if deliver and base is not None:
        destination = inbox_dir(base, to["session"]) / f"{msg['id']}.json"
        with locked(destination):
            if not destination.exists():
                write(destination, msg)
    return msg


def notify_senders(base: Path, found: list[dict[str, Any]], text: Any) -> None:
    """One notice per live sender of `found`, written by text(sender, its message ids)."""
    by_sender: dict[str, list[str]] = {}
    for message in found:
        sender = message["from"].get("session")
        if sender and sender != MAILBOX_SENDER["session"]:
            by_sender.setdefault(sender, []).append(message["id"])
    for sender, ids in by_sender.items():
        peer = load(peer_path(base, sender)) if re.fullmatch(SESSION_ID, sender) else None
        if valid_peer(peer) and not is_run_peer(peer) and is_live(peer):
            notify(base, peer, text(peer, ids), reply_to=ids[-1])


def replied_to(base: Path, session: str) -> set[str]:
    """IDs of the messages `session` replied to, from one pass over the retained mail."""
    return {
        message["replyTo"]
        for path in (base / "inbox").glob("*/*.json")
        if (message := load(path))
        and isinstance(message.get("replyTo"), str)
        and (message.get("from") or {}).get("session") == session
    }


def live_session(base: Path, session: str | None) -> bool:
    peer = load(peer_path(base, session)) if isinstance(session, str) and re.fullmatch(SESSION_ID, session) else None
    return valid_peer(peer) and is_live(peer)


def delegate(base: Path, session: str, run: str) -> None:
    """Record that a natively dispatched worker's own session works for this run."""
    try:
        key = session_key(session)
    except MailboxError:
        return  # a handle that is not a session id never shows up in presence anyway
    write(base / "delegations" / f"{key}.json", {"run": run})
    with contextlib.suppress(MailboxError):
        peer = load(peer_path(base, session))
        if valid_peer(peer):
            mark_delegated(base, peer)


def mark_delegated(base: Path, me: dict[str, Any]) -> dict[str, Any]:
    """Label a session the runner launched (it inherits AGENT_MAILBOX_SESSION): its conductor coordinates for it."""
    run_session = os.environ.get("AGENT_MAILBOX_SESSION", "")
    if not run_session.startswith("run-"):
        # A native worker inherits no environment; the coordinator recorded its handle instead.
        delegation = load(base / "delegations" / f"{session_key(me['session'])}.json")
        run_session = f"run-{delegation['run']}-worker" if delegation and isinstance(delegation.get("run"), str) else ""
    try:
        record = load(peer_path(base, run_session)) if run_session.startswith("run-") else None
    except MailboxError:
        record = None
    # Only while that run is open: a session resumed on its own later is an ordinary colleague again.
    run = record["run"] if is_run_record(record) and run_status(base, record["run"]) is None else None
    if me.get("delegatedRun") != run:
        return annotate(base, me["session"], delegatedRun=run)
    return me


def annotate(base: Path, session: str, **fields: Any) -> dict[str, Any]:
    """Set extra fields on this session's own record, under the lock register takes."""
    path = peer_path(base, session)
    with locked(path):
        peer = load(path)
        if valid_peer(peer):
            peer.update(fields)
            write(path, peer)
        return peer or {}


def refresh(
    base: Path,
    *,
    session: str,
    harness: str,
    cwd: str,
    pid: int | None,
    source: str,
    state: str | None = None,
    account: str | None = None,
    effort: str | None = None,
) -> dict[str, Any]:
    """Register a CLI or MCP call. A live session's hooks own its directory: a tool call may run elsewhere."""
    known = load(peer_path(base, session))
    hooked = valid_peer(known) and known.get("cwdSource") == "hook" and is_live(known)
    me = register(
        base,
        session=session,
        harness=harness,
        cwd=known["cwd"] if hooked else cwd,
        pid=pid,
        state=state,
        cwd_source="hook" if hooked else source,
        account=account,
        effort=effort,
    )
    return mark_delegated(base, me)


def run_instructions(run_id: str, *, transport: str = "executor") -> str:
    """Worker-facing run messaging commands; paths are absolute for detached execution."""
    if transport == "native":
        return (
            "# Native communication\n\n"
            "Use the current host's native parent-worker agent/thread tools for questions, updates, and replies. "
            "The recorded run mailbox is a fallback only if native messaging cannot reach the recipient. "
            "Do not launch another CLI or a replacement agent to communicate."
        )
    runner = Path(__file__).with_name("run_agent.py").resolve()
    command = shlex.join([sys.executable, str(runner), "mailbox"])
    session = shlex.quote(f"run-{run_id}-worker")
    counterpart = shlex.quote(f"run-{run_id}-conductor")
    return f"""
# Live run messages

This run uses dedicated mailbox sessions. Runner-launched workers also receive `AGENT_MAILBOX_SESSION` and
`AGENT_MAILBOX_PEER`; these commands name the sessions explicitly so they also work for native dispatch.
The mailbox is cooperative, friendly messaging within the original task scope—talk like relaxed, supportive
teammates (no stiff formality needed) when asking questions or sharing discoveries, while folding any appreciation
into substantive messages rather than sending standalone acknowledgements.

- Ask and wait for the matching answer:
  `{command} ask --session {session} --to {counterpart} --id question-1 --text 'Need version?' --timeout 300`
  Keep the same ID on retries. A timeout is not an answer or permission.
- Send a useful discovery without stopping:
  `{command} send --session {session} --to {counterpart} --kind update --id update-1 --text 'Finding'`
- Read incoming messages at meaningful checkpoints and before your final report:
  `{command} inbox --session {session}`
- Reply to a conductor question with `--kind reply --reply-to QUESTION_ID`.
  Acknowledge other messages after acting:
  `{command} ack --session {session} MESSAGE_ID`
- Inspect the conversation with `{command} history --session {session}`.

Do not repeatedly poll. Continue independent work when possible; otherwise report BLOCKED with the unanswered
question. Messages are seen at tool/checkpoint boundaries, not injected into an active response. Do not launch
other agents yourself; route requests for peer help through the conductor.

If mailbox communication causes a real problem, report it once using:
`{command} feedback --session {session} --category delivery --intent 'What you intended' --problem 'What went wrong' --needed 'What would have helped'`
Choose the category that fits. Omit task contents, source code, paths and secrets. Reporting writes only to
the configured diagnostic collector; it sends no message and does not expand your editing scope. Do not
poll, retry unchanged, or contact another agent just to collect feedback.
""".strip()


def main(argv: list[str] | None = None) -> int:
    return mailbox_cli.main(argv)


sys.modules.setdefault("peer_mailbox", sys.modules[__name__])
register_facade(sys.modules[__name__])


if __name__ == "__main__":
    raise SystemExit(main())
