#!/usr/bin/env python3
"""Automatic quota handoff for an orchestrating session.

A Claude `StopFailure` hook (error `rate_limit` or `billing_error`) or, for other harnesses, the periodic quota
check records one exhaustion event per session and starts the handoff in a detached process. The handoff:

1. writes a note of facts only (progress record, checkout, room, team): never a model's summary;
2. stops unless monitor's fresh data says the session's pool is exhausted (a short rate limit is no handoff);
3. chooses a successor on another account in the same billing context with room now (`available`, never
   `low`, `blocked` or `credits`): a live idle peer in the same repository first, otherwise one fresh
   headless agent when auto-launch is allowed;
4. appoints a team when the session conducts a room but has none, then takes over under the standing rule,
   so the old lead is fenced at once and the successor's generation stays pending until it accepts;
5. wakes or launches the successor with the note, and leaves a notice that every live session in the
   repository shows on its next turn. Anything unknown refuses with a reason and the same notice.

At a Stop boundary, fresh low quota instead requests a checkpoint and starts a planned offer, unless the
remainder is lost at an expiring reset that no other window outlasts (quota.spend_to_zero): that is spent to
zero, and only real exhaustion hands off.
The offer keeps the current lead active until acceptance. Fresh planned successors can run in a
sibling pane, using the same guarded executor as the headless fallback.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import functools
import hashlib
import importlib.util
import inspect
import json
import os
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

SCHEMA = "orchestrate.handoff.v1"
QUOTA_ERRORS = ("rate_limit", "billing_error")
# Claude can fire StopFailure several times for one failure: one event per session in this window.
DEDUPE_SECONDS = 600
# A running handoff blocks a new event for as long as its process lives (checked by pid and start time,
# never by the clock, which jumps across a suspend).
# Monitor serves a cache and providers lag a 429 by seconds: re-read it fresh after these pauses.
RECHECK_SECONDS = (5, 15)
# A team's standing rule may ask for the lead to be quiet a while; the detached handoff waits at most this.
MAX_STANDING_WAIT = 1800
# A successor that runs out is handed over again, at most this many times from one original session.
CHAIN_LIMIT = 3
# Notices older than this are no longer shown to sessions that join later.
NOTICE_SECONDS = 24 * 3600
# An auto-appointed team takes over as soon as monitor reports the lead's pool out: its turn ended on that error.
AUTO_STANDING = {"statuses": ["blocked", "credits"], "seconds": 0}
LAUNCH_TIMEOUT = "2h"
# A launched successor's own run holds the checkout's write lease until it ends: its successor waits this long.
LEASE_WAIT_SECONDS = 900
LEASE_POLL_SECONDS = 5
# A launch that lost the lease to a short reader in the moment after the check is tried again after these.
LAUNCH_RETRY_SECONDS = (10, 30)
PANE_READY_SECONDS = 120
PANE_EXIT_GRACE_SECONDS = 15
LEASE_BUSY_EXIT = 27
STATUS_LINES = 200
CHECKPOINT_WAIT_SECONDS = 90
CHECKPOINT_POLL_SECONDS = 3
PANE_PARENT_VARS = (
    "AGENT_MAILBOX_SESSION",
    "AGENT_MAILBOX_PEER",
    "AGENT_MAILBOX_LISTENER_SESSION",
    "ORKEST_HANDOFF_SUCCESSOR",
    "ORKEST_HANDOFF_STARTUP",
    "ORKEST_RESUME_SWARM",
    "ORKEST_RESUME_TARGET",
    "ORKEST_SWARM_ROOM",
)
HARNESS_ENGINE = {"claude": "claude", "codex": "codex", "gemini": "agy", "opencode": "opencode"}
FINAL = {"handed-over", "offered", "brief-ready", "refused", "ignored", "failed", "not-exhausted", "not-low"}
WOKEN = {"scheduled", "sent"}
CHIEF_SCHEMA = "ork.chief.v1"
CHIEF_UNVERIFIED_GRACE_SECONDS = 600
MAX_PEER_AGE_SECONDS = 7 * 86_400
UNKNOWN_PID_TTL_SECONDS = 2 * 3600
SHARED_PROCESS_IDLE_TTL_SECONDS = 3 * 3600
SHARED_PROCESS_BUSY_TTL_SECONDS = 30 * 60
SHARED_PROCESS_SUBAGENT_TTL_SECONDS = 300


@functools.cache
def module(name: str) -> Any:
    spec = importlib.util.spec_from_file_location("handoff_" + name, Path(__file__).with_name(name + ".py"))
    assert spec is not None and spec.loader is not None
    value = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = value
    spec.loader.exec_module(value)
    return value


def authority() -> Any:
    return module("authority")


def succession() -> Any:
    # The instance authority itself uses, so a takeover and this choice read monitor the same way.
    return authority().module("succession")


def mailbox() -> Any:
    return succession().module("peer_mailbox")


def now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def stamp(moment: dt.datetime) -> str:
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# Storage


def root() -> Path:
    return module("runtime_paths").cache_home() / "handoffs-v1"


def session_dir(session: str) -> Path:
    return root() / mailbox().session_key(session)


def files_dir(event: dict[str, Any]) -> Path:
    directory = session_dir(event["session"])
    # A pane command can be queued before it runs. It must always read its own offer and brief.
    if event.get("kind") == "early" and re.fullmatch(r"[a-f0-9]{16}", event["id"]):
        return directory / "offers" / event["id"]
    return directory


def write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def save_event(directory: Path, event: dict[str, Any], moment: dt.datetime | None = None) -> None:
    event["updatedAt"] = stamp(moment or now())
    write_private(directory / "event.json", json.dumps(event, indent=2, sort_keys=True) + "\n")


@contextlib.contextmanager
def locked(directory: Path) -> Iterator[None]:
    """One writer per session's handoff record; held only for short reads and writes, never for launches."""
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(directory / "handoff.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


# Settings


def config_path() -> Path:
    return module("runtime_paths").config_path()


def settings() -> dict[str, Any]:
    """`handoff` from the Orkest config: on by default; auto-launch on; no accounts excluded."""
    raw = (load_json(config_path()) or {}).get("handoff")
    raw = raw if isinstance(raw, dict) else {}
    excluded = raw.get("excludeAccounts")
    threshold = raw.get("earlyPercentLeft")
    if type(threshold) not in (int, float) or not 0 <= threshold <= 100:
        threshold = succession().module("quota").LOW_USABLE_PCT
    return {
        "enabled": raw.get("enabled") is not False,
        "autoLaunch": raw.get("autoLaunch") is not False,
        "early": raw.get("early") is not False,
        "visible": raw.get("visible") is not False,
        "earlyPercentLeft": threshold,
        "excludeAccounts": sorted({a for a in excluded if isinstance(a, str)}) if isinstance(excluded, list) else [],
    }


def set_enabled(enabled: bool) -> dict[str, Any]:
    path = config_path()
    with locked(root()):  # one handoff writer at a time; the rest of the file is kept as read
        loaded = load_json(path)
        if path.exists() and loaded is None:
            raise ValueError(f"{path} is not a JSON object; fix it by hand first")
        current = loaded if loaded is not None else {}
        section = current.get("handoff") if isinstance(current.get("handoff"), dict) else {}
        current["handoff"] = {**section, "enabled": bool(enabled)}
        write_private(path, json.dumps(current, indent=2) + "\n")
    return settings()


# Recording an exhaustion (the synchronous part of a hook: a few small reads and writes)


def ignored_peer(peer: dict[str, Any] | None) -> str:
    """Why this session never hands over: only a main interactive session leads."""
    if not peer:
        return "the session has no mailbox record"
    if peer.get("isSubagent") or peer.get("agySubagentPending"):
        return "a subagent"  # agySubagentPending: an Antigravity subagent before it is labelled one
    if isinstance(peer.get("run"), str) and peer.get("role") in {"worker", "conductor"}:
        return "a run peer"  # peer_mailbox.is_run_peer, without loading it on every turn
    if peer.get("delegatedRun"):
        return "a delegated run"
    return ""


def successor_record(session: str) -> dict[str, Any] | None:
    try:
        return load_json(root() / "successors" / f"{mailbox().session_key(session)}.json")
    except ValueError:  # MailboxError: not a session ID
        return None


def as_successor(peer: dict[str, Any] | None) -> dict[str, Any] | None:
    """A fresh successor runs as a delegated run under the session ID the handoff gave it through
    ORKEST_HANDOFF_SUCCESSOR (run_agent passes it to that run alone, never to its workers)."""
    name = os.environ.get("ORKEST_HANDOFF_SUCCESSOR", "").strip()
    if not name or (peer and ignored_peer({**peer, "delegatedRun": None})):
        return None  # a subagent or run peer of the successor is not the successor
    record = successor_record(name)
    if not record:
        return None
    facts = {key: record.get(key) for key in ("harness", "model", "accountHome") if record.get(key)}
    peer_session = peer.get("session") if peer and peer.get("session") else None
    return {**facts, **(peer or {}), "peerSession": peer_session, "session": name, "delegatedRun": None}


def leads_active_team(session: str) -> bool:
    for directory in sorted((authority().cache_dir() / "authority-v1").glob("*")):
        with contextlib.suppress(OSError, ValueError):
            record = authority().load(directory)
            if record and record["lead"]["session"] == session and record.get("status") == "active":
                return True
    return False


def session_model(peer: dict[str, Any]) -> str | None:
    """The session's own model: sticky sessionModel, not a mid-turn step's, then the older `model`."""
    return peer.get("sessionModel") or peer.get("model")


def runner_gone(event: dict[str, Any]) -> bool:
    """Whether the process running this event's handoff is verifiably gone; unknown counts as running."""
    runner = event.get("runner")
    pid = runner.get("pid") if isinstance(runner, dict) else None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False  # no runner recorded: never taken as gone, or a live handoff could run twice
    return succession().pid_replaced({"pid": pid, "pidBirth": runner.get("birth")})


def record_exhaustion(
    session: str,
    harness: str,
    reason: str,
    *,
    source: str,
    peer: dict[str, Any] | None,
    cwd: str | None = None,
    transcript: str | None = None,
    details: str | None = None,
    moment: dt.datetime | None = None,
    spawn: Callable[[str, str], None] | None = None,
    checkpoint: dict[str, Any] | None = None,
    early_pool: str | None = None,
) -> dict[str, Any]:
    """Record one exhaustion event for a main session and start the handoff in the background.

    Repeats within DEDUPE_SECONDS are one event; a session that already handed over hands over again only
    once it leads a team again. Never raises for bad input: it returns what it did."""
    moment = moment or now()
    if not settings()["enabled"]:
        return {"status": "disabled"}
    if successor := as_successor(peer):
        session, peer = successor["session"], successor
        harness = successor.get("harness") or harness
    elif why := ignored_peer(peer):
        return {"status": "ignored", "reason": why}
    try:
        directory = session_dir(session)
    except ValueError as error:  # MailboxError: not a session ID
        return {"status": "ignored", "reason": str(error)}
    with locked(directory):
        previous = load_json(directory / "event.json")
        episode = None
        if previous:
            previous_status = offer_status(previous)
            was_early = previous.get("kind") == "early"
            episode = previous.get("earlyEpisode", {"pool": None} if was_early else None)
            if checkpoint is not None and episode is not None and episode["pool"] in (None, early_pool):
                return {"status": "duplicate", "event": previous["id"], "reason": "already checkpointed for low quota"}
            escalating = was_early and checkpoint is None
            if previous_status == "offered" and not escalating:
                return {"status": "duplicate", "event": previous["id"], "reason": "an offer is awaiting acceptance"}
            recorded = parse_time(previous.get("recordedAt"))
            age = (moment - recorded).total_seconds() if recorded is not None else None
            if not was_early and age is not None and age < DEDUPE_SECONDS:
                return {"status": "duplicate", "event": previous["id"]}
            if not escalating and previous.get("status") == "running" and not runner_gone(previous):
                return {"status": "duplicate", "event": previous["id"], "reason": "its handoff is still running"}
            if (previous_status in {"handed-over", "accepted"} or previous.get("takenOver")) and not leads_active_team(
                session
            ):
                # One exhaustion, one successor: the old lead stays fenced until the user re-appoints it.
                return {"status": "duplicate", "event": previous["id"], "reason": "already handed over"}
            with contextlib.suppress(OSError):
                with (directory / "history.jsonl").open("a", encoding="utf-8") as history:
                    history.write(json.dumps(previous, sort_keys=True) + "\n")
                os.chmod(directory / "history.jsonl", 0o600)
        peer = peer or {}
        peer_session = peer.get("peerSession") if isinstance(peer.get("peerSession"), str) else None
        event = {
            "schema": SCHEMA,
            "id": secrets.token_hex(8),
            "session": session,
            **({"peerSession": peer_session} if peer_session else {}),
            "name": peer.get("name"),
            "harness": harness,
            "reason": reason,
            "details": (details or "")[:500] or None,
            "source": source,
            "recordedAt": stamp(moment),
            "cwd": cwd or peer.get("cwd"),
            "checkout": peer.get("checkout") or cwd or peer.get("cwd"),
            "repo": peer.get("repo"),
            "model": session_model(peer),
            "accountHome": peer.get("accountHome"),
            "transcript": transcript,
            "status": "recorded",
            "reasons": [],
            "toldSessions": [],
            **({"kind": "early", "checkpoint": checkpoint} if checkpoint is not None else {}),
            "earlyEpisode": {"pool": early_pool} if checkpoint is not None else episode,
        }
        save_event(directory, event, moment)
    (spawn or spawn_background)(session, event["id"])
    return {"status": "recorded", "event": event["id"]}


def offer_status(event: dict[str, Any]) -> str:
    if event.get("status") != "offered" or not event.get("team"):
        return event.get("status", "unknown")
    a = authority()
    record = a.load(a.team_dir(event["team"])) or {}
    offer = record.get("offer") or {}
    if offer.get("automatic") == event["id"]:
        return "expired" if a.automatic_offer_expired(offer) else "offered"
    if any(entry.get("automatic") == event["id"] and entry["event"] == "accept" for entry in record.get("log", [])):
        return "accepted"
    return "superseded"


def wait_for_checkpoint(base: Path, event: dict[str, Any], sleep: Callable[[float], None]) -> bool:
    directory = session_dir(event["session"])
    checkpoint = event["checkpoint"]
    baseline = checkpoint["items"]
    peer_session = event.get("peerSession") or event["session"]
    for waited in range(0, CHECKPOINT_WAIT_SECONDS + 1, CHECKPOINT_POLL_SECONDS):
        current = load_json(directory / "event.json") or {}
        if current.get("id") != event["id"]:
            return False  # A real exhaustion superseded this early checkpoint request.
        peer = mailbox().load(mailbox().peer_path(base, peer_session))
        items = []
        if baseline and peer:
            items = [
                {"id": item["id"], "revision": item["checkpointRevision"], "handoff": item["handoff"]}
                for item in module("mailbox_work").checkpoint_records(base, peer)
                if item["id"] in baseline and item.get("checkpointRevision", 0) > baseline[item["id"]]
            ]
        complete = (
            len(items) == len(baseline)
            if baseline
            else progress_revision(base, peer_session) > checkpoint["progressRevision"]
        )
        if current.get("checkpointStopAt") and complete:
            event.update(checkpointStatus="checkpointed", checkpointPackets=items)
            return True
        if waited < CHECKPOINT_WAIT_SECONDS:
            sleep(CHECKPOINT_POLL_SECONDS)
    event.update(checkpointStatus="timed out", checkpointPackets=items)
    return True


def progress_revision(base: Path, session: str) -> int:
    try:
        return (base / "progress" / f"{mailbox().session_key(session)}.json").stat().st_mtime_ns
    except OSError:
        return 0


def spawn_background(session: str, event_id: str) -> None:
    """Run the handoff detached, like the auto-update check: the hook returns at once."""
    if (os.environ.get("PYTEST_CURRENT_TEST") or "unittest" in sys.modules) and os.environ.get(
        "ORKEST_TEST_HANDOFF_SPAWN"
    ) != "1":
        return
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "run", "--session", session, "--event", event_id],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def error_type(payload: dict[str, Any]) -> str | None:
    """The StopFailure error type: documented as `error`; `error_type` is accepted too."""
    for key in ("error", "error_type"):
        value = payload.get(key)
        if isinstance(value, dict):
            value = value.get("type")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def stop_failure(
    base: Path, payload: dict[str, Any], session: str, harness: str, *, spawn: Callable | None = None
) -> dict[str, Any]:
    """Claude's StopFailure: only a quota error in a main session counts. Its output is ignored by Claude."""
    reason = error_type(payload)
    if harness != "claude" or reason not in QUOTA_ERRORS:
        return {"status": "ignored", "reason": f"error {reason!r} is not a quota error"}
    if payload.get("agent_id") or payload.get("agent_type"):
        # Fired inside a subagent (or an --agent session's helper): its parent decides for itself.
        return {"status": "ignored", "reason": "a subagent"}
    peer = mailbox().load(mailbox().peer_path(base, session))
    details = payload.get("error_details") or payload.get("last_assistant_message")
    transcript = payload.get("transcript_path")
    return record_exhaustion(
        session,
        harness,
        reason,
        source="StopFailure",
        peer=peer,
        cwd=payload.get("cwd") if isinstance(payload.get("cwd"), str) else None,
        transcript=transcript if isinstance(transcript, str) else None,
        details=details if isinstance(details, str) else None,
        spawn=spawn,
    )


def below_threshold(pool: dict[str, Any], threshold: float) -> bool:
    remaining = pool.get("availableNowPct")
    return pool.get("status") in succession().USABLE and type(remaining) in (int, float) and remaining < threshold


def spending_text(spend: dict[str, Any]) -> str:
    return (
        f"spending expiring {spend['window']} quota ({spend['remainingPct']:g}% left, resets {spend['resetsAt']}) "
        "to zero; handoff only on exhaustion"
    )


def early_due(pool: dict[str, Any], threshold: float) -> bool:
    """Low enough for an early handoff. Quota that is lost at its reset anyway is spent to zero instead
    (`spendToZero`, quota.spend_to_zero); the exhaustion handoff still catches a real runout."""
    return below_threshold(pool, threshold) and not pool.get("spendToZero")


def poll(
    base: Path,
    me: dict[str, Any],
    *,
    at_stop: bool = False,
    transcript: str | None = None,
    spawn: Callable | None = None,
) -> str:
    """At Stop, ask for a low-quota checkpoint once. Preserve the periodic blocked-quota fallback."""
    options = settings()
    acting = as_successor(me) or me
    harness = acting.get("harness")
    early = at_stop and options["early"] and harness in {"claude", "codex", "gemini"}
    if not options["enabled"] or (acting is me and ignored_peer(me)):
        return ""
    early = early and not ignored_peer(me)
    waiting = False
    if early:
        directory = session_dir(acting["session"])
        previous = load_json(directory / "event.json") or {}
        recorded = parse_time(previous.get("recordedAt"))
        waiting = (
            previous.get("status") == "recorded"
            and recorded is not None
            and (now() - recorded).total_seconds() < DEDUPE_SECONDS
        ) or (previous.get("status") == "running" and not runner_gone(previous))
        waiting = previous.get("kind") == "early" and waiting
        if waiting:
            with locked(directory):
                current = load_json(directory / "event.json") or {}
                if current.get("id") == previous["id"] and current.get("status") in {"recorded", "running"}:
                    current["checkpointStopAt"] = stamp(now())
                    save_event(directory, current)
    s = succession()
    checked = s.parse_time(me.get("handoffCheckedAt"))
    late_due = harness != "claude" and (checked is None or (now() - checked).total_seconds() >= s.HOOK_CHECK_SECONDS)
    if not early and not late_due:
        return ""
    if late_due:
        mailbox().annotate(base, me["session"], handoffCheckedAt=stamp(now()))
    config = s.monitor_config()
    view = s.cached_view()
    if view is None:
        return ""
    account, _ = s.account_of(harness, acting.get("accountHome"), config, view=view)
    if account is None:
        return ""
    pool = s.pool_for(harness, session_model(acting), account, view, config)
    fresh_at_stop = early and s.pool_fresh(pool, config)
    low = early_due(pool, options["earlyPercentLeft"])
    if fresh_at_stop and pool.get("status") in s.USABLE and not low and previous:
        with locked(directory):
            current = load_json(directory / "event.json") or {}
            if current.get("id") == previous["id"] and current.get("earlyEpisode", current.get("kind") == "early"):
                current["earlyEpisode"] = None
                save_event(directory, current)
    if fresh_at_stop and low and not waiting:
        work = module("mailbox_work").checkpoint_records(base, me)
        items = {item["id"]: item.get("checkpointRevision", 0) for item in work}
        result = record_exhaustion(
            me["session"],
            me["harness"],
            "quota:low",
            source="Stop",
            peer=me,
            checkpoint={"items": items, "progressRevision": progress_revision(base, me["session"])},
            early_pool=pool["pool"],
            transcript=transcript,
            spawn=spawn,
        )
        if result["status"] == "recorded":
            items = (
                (
                    f" Use `python3 {script('peer_mailbox.py')} work checkpoint --session {me['session']}` on "
                    + ", ".join(items)
                    + " with a structured handoff packet (`files_touched`, `decisions_made`, `remaining_steps`, "
                    "`blockers`, `verification_command_run`)."
                )
                if items
                else ""
            )
            return (
                "Orkest quota handoff: checkpoint your current work and update `ork progress` now."
                + items
                + " End this checkpoint turn promptly. Keep your current authority until the successor accepts."
            )
    elif late_due and pool.get("status") == "blocked":
        record_exhaustion(me["session"], me["harness"], "quota:blocked", source="quota-poll", peer=me, spawn=spawn)
    return ""


# Facts


def git(directory: str | None, *args: str) -> str | None:
    if not directory:
        return None
    try:
        completed = subprocess.run(
            ["git", "-C", directory, *args], capture_output=True, text=True, timeout=10, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout if completed.returncode == 0 else None


def conducted_rooms(base: Path, session: str) -> list[dict[str, Any]]:
    """Rooms whose current conductor binding names this session (a session it was rebound from does not)."""
    found = []
    store, m = module("room_store"), mailbox()
    with contextlib.suppress(Exception):
        for room in store.list_rooms(base):
            if not isinstance(room, dict):
                continue
            if (
                not store.is_active_room(room)
                or room.get("closedAt")
                or str(room.get("status") or "").lower() in {"archived", "closed", "completed", "cancelled"}
            ):
                continue
            conductor = room.get("conductor")
            if not isinstance(conductor, dict) or not isinstance(conductor.get("session"), (dict, type(None))):
                continue
            if conductor.get("session") and not m.local_session_binding(room, conductor):
                continue
            if room.get("machine") and not m.local_session_binding(room, conductor):
                continue
            former = set(conductor.get("previousSessions") or []) - {(conductor.get("session") or {}).get("id")}
            if session in m.room_owner_sessions(room, conductor) and session not in former:
                found.append(room)
    return found


def room_tasks(room: dict[str, Any]) -> list[dict[str, Any]]:
    """Each room member's coordinator task, as recorded: objective, status, live runs."""
    tasks = []
    live = authority().LIVE_RUN
    for agent in room.get("agents") or []:
        dispatch = agent.get("dispatch") if isinstance(agent, dict) else None
        if not isinstance(dispatch, dict) or not isinstance(dispatch.get("taskDir"), str):
            continue
        task = load_json(Path(dispatch["taskDir"]) / "task.json") or {}
        runs = [run for run in task.get("runs") or [] if isinstance(run, dict)]
        tasks.append(
            {
                "member": agent.get("id"),
                "taskDir": dispatch["taskDir"],
                "taskId": task.get("task_id"),
                "status": task.get("status"),
                "team": (task.get("authority") or {}).get("team") if isinstance(task.get("authority"), dict) else None,
                "objective": (task.get("task_spec") or {}).get("objective"),
                "liveRuns": [
                    {key: run.get(key) for key in ("run_id", "kind", "engine", "status")}
                    for run in runs
                    if run.get("status") in live
                ],
            }
        )
    return tasks


def _is_local_peer(peer: dict[str, Any], host: str) -> bool:
    machine = peer.get("machine")
    return not (isinstance(machine, str) and machine.strip()) or machine == host


def _shared_process_ttl_seconds(state: Any, is_subagent: bool = False) -> int:
    if is_subagent:
        return SHARED_PROCESS_SUBAGENT_TTL_SECONDS
    if state == "busy":
        return SHARED_PROCESS_BUSY_TTL_SECONDS
    return SHARED_PROCESS_IDLE_TTL_SECONDS


def _is_chief_peer_live(
    peer: dict[str, Any],
    moment: dt.datetime,
    fresh_birth_fn: Callable[[int], str | None],
) -> bool:
    """Chief peer liveness aligned with chief.mjs (isPeerLive) & identity.rs: enforces 7-day heartbeat TTL."""
    m = mailbox()
    seen = parse_time(peer.get("lastSeenAt") or peer.get("startedAt"))
    if seen is None:
        return False
    pid = peer.get("pid")
    valid_pid = isinstance(pid, int) and not isinstance(pid, bool) and pid > 0
    alive = m.pid_alive(pid) if valid_pid else None
    if alive is False:
        return False
    peer_birth = peer.get("pidBirth")
    if alive and isinstance(peer_birth, str) and peer_birth.strip() and valid_pid:
        current = fresh_birth_fn(pid)
        if current is not None and current != peer_birth.strip():
            return False
    age = (moment - seen).total_seconds()
    if age > MAX_PEER_AGE_SECONDS:
        return False
    shared = peer.get("sharedProcess") is True
    is_subagent = peer.get("isSubagent") is True
    if shared and is_subagent:
        return age <= SHARED_PROCESS_SUBAGENT_TTL_SECONDS
    if alive and shared:
        return age <= _shared_process_ttl_seconds(peer.get("state"))
    return True if alive else age <= UNKNOWN_PID_TTL_SECONDS


def _is_top_level_replacement_peer(
    candidate: dict[str, Any],
    chief_session: str,
    pid: int,
    pid_birth: str | None,
    host: str,
    moment: dt.datetime,
    fresh_birth_fn: Callable[[int], str | None],
) -> bool:
    m = mailbox()
    if (
        not isinstance(candidate, dict)
        or candidate.get("session") == chief_session
        or not _is_local_peer(candidate, host)
        or candidate.get("pid") != pid
    ):
        return False
    candidate_birth = candidate.get("pidBirth")
    if (
        isinstance(candidate_birth, str)
        and candidate_birth
        and isinstance(pid_birth, str)
        and pid_birth
        and candidate_birth != pid_birth
    ):
        return False
    if (
        m.is_run_peer(candidate)
        or str(candidate.get("session") or "").startswith("run-")
        or candidate.get("isSubagent")
        or candidate.get("agySubagentPending")
        or candidate.get("delegatedRun")
        or candidate.get("parentSession")
    ):
        return False
    return (
        candidate["live"]
        if isinstance(candidate.get("live"), bool)
        else _is_chief_peer_live(candidate, moment, fresh_birth_fn)
    )


def live_chief_binding(
    base: Path,
    session: str,
    *,
    event: dict[str, Any] | None = None,
    peers: list[dict[str, Any]] | None = None,
    moment: dt.datetime | None = None,
) -> dict[str, Any] | None:
    """Return the local Chief binding in `<base>/chief.json` if `session` holds it live, else None."""
    binding = load_json(base / "chief.json")
    if not isinstance(binding, dict) or binding.get("schema") != CHIEF_SCHEMA:
        return None
    chief_session = binding.get("session")
    if not isinstance(chief_session, str) or not chief_session.strip():
        return None
    chief_session = chief_session.strip()
    my_sessions = {session}
    if event and isinstance(event.get("peerSession"), str) and event["peerSession"].strip():
        my_sessions.add(event["peerSession"].strip())
    if chief_session not in my_sessions:
        return None
    host = socket.gethostname()
    machine = binding.get("machine")
    if machine is not None and (not isinstance(machine, str) or (machine.strip() and machine != host)):
        return None
    m = mailbox()
    pid = binding.get("pid")
    valid_pid = isinstance(pid, int) and not isinstance(pid, bool) and pid > 0
    alive = m.pid_alive(pid) if valid_pid else None
    if alive is False:
        return None
    raw_birth = binding.get("pidBirth")
    pid_birth = raw_birth.strip() if isinstance(raw_birth, str) and raw_birth.strip() else None

    fresh_birth_cache: dict[int, str | None] = {}

    def fresh_birth(target_pid: int) -> str | None:
        if target_pid in fresh_birth_cache:
            return fresh_birth_cache[target_pid]
        with contextlib.suppress(AttributeError):
            m._PID_BIRTH_CACHE.pop(target_pid, None)
        val = m.process_started(target_pid)
        fresh_birth_cache[target_pid] = val
        return val

    verified_live_pid = False
    if valid_pid and alive:
        if pid_birth:
            current_birth = fresh_birth(pid)
            if current_birth and current_birth != pid_birth:
                return None
            verified_live_pid = bool(current_birth)
        else:
            verified_live_pid = True
    current_moment = moment or now()
    bound_at = parse_time(binding.get("boundAt"))
    age = (current_moment - bound_at).total_seconds() if bound_at is not None else None
    is_in_grace = age is not None and 0 <= age <= CHIEF_UNVERIFIED_GRACE_SECONDS
    if valid_pid and not verified_live_pid and not is_in_grace:
        return None
    if peers is not None:
        peer = next(
            (
                p
                for p in peers
                if isinstance(p, dict)
                and p.get("session") == chief_session
                and not m.is_run_peer(p)
                and not str(p.get("session") or "").startswith("run-")
                and _is_local_peer(p, host)
            ),
            None,
        )
    else:
        loaded = m.load(m.peer_path(base, chief_session))
        peer = (
            loaded
            if isinstance(loaded, dict)
            and loaded.get("session") == chief_session
            and not m.is_run_peer(loaded)
            and not str(loaded.get("session") or "").startswith("run-")
            and _is_local_peer(loaded, host)
            else None
        )
    if peer is not None:
        peer_pid = peer.get("pid")
        valid_peer_pid = isinstance(peer_pid, int) and not isinstance(peer_pid, bool) and peer_pid > 0
        raw_peer_birth = peer.get("pidBirth")
        peer_birth = raw_peer_birth.strip() if isinstance(raw_peer_birth, str) and raw_peer_birth.strip() else None
        if valid_pid and valid_peer_pid and pid != peer_pid:
            return None
        if pid_birth and peer_birth and pid_birth != peer_birth:
            return None
        peer_live = (
            peer["live"]
            if isinstance(peer.get("live"), bool)
            else _is_chief_peer_live(peer, current_moment, fresh_birth)
        )
        return binding if peer_live else None
    if verified_live_pid:
        if not is_in_grace:
            candidate_peers = peers if peers is not None else m.peers(base, prune_dead=False)
            if any(
                _is_top_level_replacement_peer(
                    candidate, chief_session, pid, pid_birth, host, current_moment, fresh_birth
                )
                for candidate in candidate_peers
            ):
                return None
        return binding
    if is_in_grace:
        return binding
    return None


def _chief_token(binding: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(binding, dict):
        return None
    rev = binding.get("revision")
    gen = binding.get("generation")
    return {
        "session": binding.get("session"),
        "revision": rev if isinstance(rev, int) and not isinstance(rev, bool) else None,
        "generation": gen.strip() if isinstance(gen, str) and gen.strip() else None,
    }


def _chief_token_matches(current_binding: dict[str, Any] | None, expected: dict[str, Any] | None) -> bool:
    if not isinstance(current_binding, dict) or not isinstance(expected, dict):
        return False
    if current_binding.get("session") != expected.get("session"):
        return False
    exp_rev = expected.get("revision")
    cur_rev = current_binding.get("revision")
    if exp_rev is None:
        if cur_rev is not None:
            return False
    elif cur_rev != exp_rev:
        return False
    exp_gen = expected.get("generation")
    cur_gen = current_binding.get("generation")
    cur_gen_str = cur_gen.strip() if isinstance(cur_gen, str) and cur_gen.strip() else None
    if exp_gen is None:
        return cur_gen_str is None
    return cur_gen_str == exp_gen


def chief_summary(binding: dict[str, Any]) -> dict[str, Any]:
    return {
        "session": binding.get("session"),
        "name": binding.get("name"),
        "machine": binding.get("machine"),
        "boundAt": binding.get("boundAt"),
        "cwd": binding.get("cwd"),
    }


def chief_desk_lines(chief: dict[str, Any]) -> list[str]:
    return [
        f"- Chief session: {chief.get('session') or 'unknown'} ({chief.get('name') or 'unnamed'})",
        f"- Machine: {chief.get('machine') or socket.gethostname()}",
        f"- Bound at: {chief.get('boundAt') or 'unknown'}",
        f"- Chief cwd: {chief.get('cwd') or 'unknown'}",
    ]


def build_note(
    event: dict[str, Any],
    *,
    base: Path,
    rooms: list[dict[str, Any]],
    team: dict[str, Any] | None,
    chief: dict[str, Any] | None = None,
) -> str:
    """What the successor needs, as recorded facts only: nothing here is written by a model."""
    peer_session = event.get("peerSession") or event["session"]
    progress = mailbox().load(base / "progress" / f"{mailbox().session_key(peer_session)}.json") or {}
    checkout = event.get("checkout")
    status = git(checkout, "status", "--short")
    status_lines = status.splitlines() if status is not None else None
    lines = [
        f"# Handoff note for session {event['session']}",
        "",
        "Recorded facts only, including any progress and checkpoint entries attributed to the previous lead.",
        "",
        "## Quota" if event.get("kind") == "early" else "## Exhaustion",
        "",
        f"- Session: {event['session']} ({event.get('name') or 'unnamed'}), {event['harness']}, "
        f"model {event.get('model') or 'unknown'}",
        f"- Reason: {event['reason']} (from {event['source']}) at {event['recordedAt']}",
    ]
    if event.get("details"):
        lines.append(f"- Error: {event['details']}")
    lines.append(f"- Previous transcript: {event.get('transcript') or 'unknown'}")
    lines += ["", "## Progress record", ""]
    if progress:
        for key in ("goal", "task", "stage", "role", "updatedAt"):
            if progress.get(key):
                lines.append(
                    f"- {key}: {progress[key] if isinstance(progress[key], str) else json.dumps(progress[key])}"
                )
    else:
        lines.append("- none recorded")
    if event.get("kind") == "early":
        lines += ["", "## Workboard checkpoint", "", f"- Result: {event.get('checkpointStatus', 'waiting')}"]
        for item in event.get("checkpointPackets", []):
            lines.append(
                f"- {item['id']} at revision {item['revision']}: {json.dumps(item['handoff'], sort_keys=True)}"
            )
    lines += [
        "",
        "## Checkout",
        "",
        f"- Directory: {checkout or 'unknown'}",
        f"- Repository: {event.get('repo') or 'unknown'}",
        f"- Branch: {(git(checkout, 'branch', '--show-current') or '').strip() or 'unknown or detached'}",
        f"- HEAD: {(git(checkout, 'rev-parse', 'HEAD') or '').strip() or 'unknown'}",
        "",
        "`git status --short`:",
        "",
        "```",
    ]
    if status_lines is None:
        lines.append("(git status failed: the checkout state is unknown)")
    else:
        lines += status_lines[:STATUS_LINES] or ["(clean)"]
        if len(status_lines) > STATUS_LINES:
            lines.append(f"... and {len(status_lines) - STATUS_LINES} more")
    lines.append("```")
    for room in rooms:
        conductor = room.get("conductor") or {}
        binding = conductor.get("session") if isinstance(conductor.get("session"), dict) else {}
        lines += [
            "",
            f"## Room {room.get('id')}",
            "",
            f"- Title: {room.get('title') or 'none'}",
            f"- Objective: {room.get('objective') or 'none'}",
            f"- Conductor binding: session {binding.get('id') or conductor.get('mailboxSession') or 'unknown'}"
            f", engine {binding.get('engine') or conductor.get('engine') or 'unknown'}",
        ]
        tasks = room_tasks(room)
        if not tasks:
            lines.append("- Tasks: none recorded")
        for task in tasks:
            runs = ", ".join(f"{r['run_id']} ({r['kind']}, {r['engine']}, {r['status']})" for r in task["liveRuns"])
            lines.append(
                f"- Task {task['taskId'] or 'unreadable'} for {task['member']}: {task['status'] or 'unknown'}; "
                f"{task['objective'] or 'no objective'}; live runs: {runs or 'none'} ({task['taskDir']})"
            )
    if team:
        lines += [
            "",
            f"## Team {team['team']}",
            "",
            f"- Generation {team['generation']}, {team['status']}; lead {team['lead']['session']} "
            f"({team['lead']['harness']}); deputy "
            + (
                f"{(team.get('deputy') or {}).get('session') or 'any session'} on {team['deputy'].get('pool')}"
                if team.get("deputy")
                else "none"
            ),
            f"- Registered tasks: {len(team.get('tasks') or [])}",
        ]
    if chief:
        lines += ["", "## Chief desk", "", *chief_desk_lines(chief)]
    return "\n".join(lines) + "\n"


# Choosing a successor


def tier(model: str | None) -> int | None:
    """A model's capability tier (1 fast .. 4 frontier) from its ID or route selector; None when unknown."""
    return module("execution_support").model_capability_tier(model)


def peer_tier_ok(lead_model: str | None, peer_model: str | None) -> bool:
    lead, peer = tier(lead_model), tier(peer_model)
    return lead is not None and peer is not None and peer >= lead


def launch_models(harness: str, lead: dict[str, Any], routes: dict[str, Any]) -> list[str]:
    """Models a fresh successor of this harness may run: the lead's own on its harness, otherwise the routed
    models of that engine whose tier is the lead's or higher, closest first."""
    if harness == lead["harness"]:
        return [lead["model"]] if lead.get("model") else []
    floor, engine, found = tier(lead.get("model")), HARNESS_ENGINE[harness], {}
    if floor is None:
        return []
    for role in sorted(routes):
        with contextlib.suppress(ValueError):
            for candidate in module("routes").route_candidates(role, routes):
                rank = tier(candidate["model"])
                if candidate["engine"] == engine and rank is not None and rank >= floor:
                    found.setdefault(candidate["model"], rank)
    return sorted(found, key=lambda model: (found[model], model))


def _call_allowed(
    allowed: Callable[..., bool],
    engine: str,
    config_dir: str | None,
    *,
    account_id: str,
    provider: str | None,
    billing_mode: str | None,
    tags: list[str] | tuple[str, ...] | None = None,
    account_alias: str | None = None,
    codex_home: str | None = None,
    agy_home: str | None = None,
) -> bool:
    sig = inspect.signature(allowed)
    accepts_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
    if accepts_kwargs or "strict" in sig.parameters:
        optional = {
            "account_id": account_id,
            "provider": provider,
            "billing_mode": billing_mode,
            "tags": list(tags) if tags is not None else None,
            "account_alias": account_alias,
            "codex_home": codex_home,
            "agy_home": agy_home,
            "strict": True,
        }
        kwargs = optional if accepts_kwargs else {k: v for k, v in optional.items() if k in sig.parameters}
        return bool(allowed(engine, config_dir, **kwargs))
    return bool(allowed(engine, config_dir))


def _claude_account_home_override(
    s: Any,
    entry: dict[str, Any],
    config: dict[str, Any],
    view_account: dict[str, Any] | None,
    account_home: str,
    *,
    is_default_profile: bool,
) -> str | None:
    if isinstance(view_account, dict):
        acct_env = view_account.get("accountEnv")
        if isinstance(acct_env, dict):
            raw_home = acct_env.get("HOME")
            if isinstance(raw_home, str) and raw_home.strip():
                return str(s._resolve_child_path(raw_home))
    if s._has_configured_home_override(entry, config):
        merged = s._merged_account_env(
            entry,
            config,
            strip_exact=("CLAUDECODE", "CLAUDE_CONFIG_DIR"),
            strip_prefixes=("ANTHROPIC_", "CLAUDE_CODE_"),
        )
        return str(s._env_base_home(merged))
    if is_default_profile:
        resolved_acct = Path(account_home).resolve()
        if resolved_acct.name == ".claude" and resolved_acct != (Path.home() / ".claude").resolve():
            return str(resolved_acct.parent)
    return None


def _claude_launch_binding(
    s: Any,
    entry: dict[str, Any],
    config: dict[str, Any],
    view_account: dict[str, Any] | None,
) -> tuple[bool, str | None, str | None, dict[str, str | None]]:
    """Resolve Monitor-verified Claude launch binding: (launchable, account_home, config_dir, launch_env)."""
    if s._view_account_unverified(view_account):
        return False, None, None, {}
    account_home = str(s._configured_claude_home(entry, config, view_account=view_account))

    def _build_env(cfg_dir: str | None, *, is_default_profile: bool) -> dict[str, str | None]:
        env: dict[str, str | None] = {
            "CLAUDE_CONFIG_DIR": cfg_dir,
            "ORKEST_PINNED_CLAUDE_ACCOUNT": "1",
        }
        home_override = _claude_account_home_override(
            s,
            entry,
            config,
            view_account,
            account_home,
            is_default_profile=is_default_profile,
        )
        if home_override:
            env["ORKEST_CLAUDE_ACCOUNT_HOME"] = home_override
        return env

    if isinstance(view_account, dict):
        if view_account.get("unsetClaudeConfigDir") is True:
            return True, account_home, None, _build_env(None, is_default_profile=True)
        raw_view_cfg = view_account.get("claudeConfigDir")
        if isinstance(raw_view_cfg, str) and raw_view_cfg.strip():
            cfg_str = str(s._resolve_child_path(raw_view_cfg))
            return True, account_home, cfg_str, _build_env(cfg_str, is_default_profile=False)
    if entry.get("unsetClaudeConfigDir") is True:
        return True, account_home, None, _build_env(None, is_default_profile=True)
    raw_dir = entry.get("claudeConfigDir") or entry.get("configDir")
    if not isinstance(raw_dir, str) or not raw_dir.strip():
        if s._has_configured_home_override(entry, config):
            return True, account_home, None, _build_env(None, is_default_profile=True)
        return False, None, None, {}
    resolved_cfg = s._resolve_child_path(raw_dir)
    default_cfg = (Path.home() / ".claude").resolve()
    if resolved_cfg == default_cfg:
        return True, account_home, None, _build_env(None, is_default_profile=True)
    cfg_str = str(resolved_cfg)
    return True, account_home, cfg_str, _build_env(cfg_str, is_default_profile=False)


def _non_claude_launch_binding(
    s: Any,
    harness: str,
    entry: dict[str, Any],
    config: dict[str, Any],
    view_account: dict[str, Any] | None,
) -> tuple[str | None, dict[str, str | None]]:
    """Resolve and verify (account_home, launch_env) for a non-Claude fresh launch, or (None, {}) if unverified."""
    if view_account is not None and "accountHome" in view_account and s._view_account_home(view_account) is None:
        return None, {}
    snapshot_home = s._view_account_home(view_account)
    explicit_home, effective_home = s._configured_provider_home(
        entry["provider"], entry, config, view_account=view_account
    )
    account_home = str(snapshot_home or explicit_home or effective_home)
    if not account_home:
        return None, {}
    if harness == "codex":
        return account_home, {"CODEX_HOME": account_home, "ORKEST_CODEX_ACCOUNT_HOME": account_home}
    merged_env = s._merged_account_env(entry, config)
    raw_app = merged_env.get("ANTIGRAVITY_APP_DATA_DIR")
    raw_gemini = merged_env.get("GEMINI_CLI_HOME")
    if isinstance(raw_app, str) and raw_app.strip() and not (isinstance(raw_gemini, str) and raw_gemini.strip()):
        app_data = s._resolve_child_path(raw_app)
        configured = app_data.parent if app_data.name.startswith("antigravity") else app_data
        if str(configured.resolve()) == account_home:
            return account_home, {
                "ANTIGRAVITY_APP_DATA_DIR": str(app_data),
                "GEMINI_CLI_HOME": account_home,
                "ORKEST_AGY_ACCOUNT_HOME": str(app_data),
            }
    return account_home, {
        "GEMINI_CLI_HOME": account_home,
        "ANTIGRAVITY_APP_DATA_DIR": None,
        "ORKEST_AGY_ACCOUNT_HOME": account_home,
    }


def choose_successor(
    lead: dict[str, Any],
    *,
    view: dict[str, Any] | None,
    config: dict[str, Any],
    peers: list[dict[str, Any]],
    options: dict[str, Any],
    routes: dict[str, Any] | None = None,
    deputy: dict[str, Any] | None = None,
    allowed: Callable[..., bool] | None = None,
) -> dict[str, Any]:
    """The lead's account, pool and context, and one successor: a live idle peer, else a launch; or refusals.

    A successor draws on another account than the lead, in the same billing context, on a pool monitor reports
    `available` with fresh data. `deputy` (an existing team's) narrows it to that account, harness, session and
    pool. `allowed(engine, configDir, ...)` is the repository's harness policy for a launch."""
    s = succession()
    result: dict[str, Any] = {"refusals": [], "successor": None}
    refuse = result["refusals"].append
    if view is None:
        refuse("monitor is not installed or did not answer: quota is unknown")
        return result
    malformed = [
        entry
        for entry in config.get("accounts") or []
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"]
    ]
    if malformed or not isinstance(config.get("accounts", []), list):
        refuse(f"monitor's config {s.monitor_config_path()} has an account without an id: fix it first")
        return result
    account, why = s.account_of(lead["harness"], lead.get("accountHome"), config, view=view)
    if account is None:
        refuse(why)
        return result
    pool = s.pool_for(lead["harness"], lead.get("model"), account, view, config)
    if not pool:
        refuse(f"monitor reports no pool for {lead['harness']} on account '{account}'")
        return result
    result.update(account=account, pool=pool["pool"], status=pool["status"], stale=pool["stale"], leadQuota=pool)
    context = pool["billing"]
    result["context"] = context
    if context is None:
        refuse(f"the billing context of account '{account}' is unknown: set billing or tags in monitor")
        return result
    excluded = set(options.get("excludeAccounts") or [])
    deputy = deputy or {}

    def fits(candidate: dict[str, Any], account_id: str, harness: str) -> bool:
        return (
            bool(candidate)
            and account_id != account
            and account_id not in excluded
            and candidate.get("billing") == context
            and candidate.get("status") == "available"
            and not candidate.get("stale")
            and (not options.get("requireFresh") or s.pool_fresh(candidate, config))
            and (not deputy.get("account") or deputy["account"] == account_id)
            and (not deputy.get("harness") or deputy["harness"] == harness)
            and (not deputy.get("pool") or deputy["pool"] == candidate.get("pool"))
        )

    choices = []
    for peer in peers:
        harness = peer.get("harness")
        if (
            harness not in HARNESS_ENGINE
            or peer.get("session") == lead["session"]
            or ignored_peer(peer)
            or peer.get("state") != "idle"
            or not s.same_repository(peer.get("repo"), lead.get("repo"))
            or (deputy.get("session") and peer["session"] != deputy["session"])
            # A deputy the user named is taken as named; otherwise the model must be no weaker.
            or (not deputy.get("session") and not peer_tier_ok(lead.get("model"), session_model(peer)))
        ):
            continue
        peer_account = s.account_of(harness, peer.get("accountHome"), config, view=view)[0]
        if peer_account is None:
            continue
        candidate = s.pool_for(harness, session_model(peer), peer_account, view, config)
        if not fits(candidate, peer_account, harness):
            continue
        peer_config_dir = peer.get("accountHome") if harness == "claude" else None
        if allowed is not None and not _call_allowed(
            allowed,
            HARNESS_ENGINE[harness],
            peer_config_dir,
            account_id=peer_account,
            provider=candidate.get("provider") or s.HARNESS_PROVIDER.get(harness),
            billing_mode=candidate.get("billing") or context,
            tags=candidate.get("tags"),
            account_alias=candidate.get("alias"),
            codex_home=peer.get("accountHome") if harness == "codex" else None,
            agy_home=peer.get("accountHome") if harness == "gemini" else None,
        ):
            continue
        choices.append((s.rank(candidate), peer["session"], peer, candidate, peer_account))
    if choices:
        _, _, peer, candidate, peer_account = min(choices, key=lambda item: item[:2])
        result["successor"] = {
            "kind": "peer",
            "session": peer["session"],
            "name": peer.get("name"),
            "harness": peer["harness"],
            "model": session_model(peer),
            "account": peer_account,
            "pool": candidate["pool"],
        }
        return result
    if deputy.get("session"):
        refuse(f"the named deputy {deputy['session']} is not a live idle session with room in this repository")
        return result
    if not options.get("autoLaunch"):
        refuse("no live idle session on another account fits, and auto-launch is off")
        return result
    routes = routes if routes is not None else module("routes").load_routes()
    quota = s.module("quota")
    view_accounts = {
        item["id"]: item
        for item in view.get("accounts", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    launches = []
    for entry in config.get("accounts", []):
        if entry.get("provider") not in s.HARNESS_PROVIDER.values():
            continue
        harness = next(h for h, p in s.HARNESS_PROVIDER.items() if p == entry["provider"])
        engine = HARNESS_ENGINE[harness]
        account_home = None
        launch_env: dict[str, str | None] = {}
        config_dir = None
        if harness == "claude":
            launchable, account_home, config_dir, launch_env = _claude_launch_binding(
                s, entry, config, view_accounts.get(entry["id"])
            )
            if not launchable:
                continue
        else:
            account_home, launch_env = _non_claude_launch_binding(
                s, harness, entry, config, view_accounts.get(entry["id"])
            )
            if not account_home or s.account_of(harness, account_home, config, view=view)[0] != entry["id"]:
                continue
        view_acct = view_accounts.get(entry["id"]) or {}
        entry_tags = s._normalize_tags(
            entry.get("tags"),
            entry.get("category"),
            view_acct.get("tags"),
            view_acct.get("category"),
        )
        entry_alias = entry.get("alias") or view_acct.get("alias")
        if allowed is not None and not _call_allowed(
            allowed,
            engine,
            config_dir,
            account_id=entry["id"],
            provider=entry.get("provider"),
            billing_mode=entry.get("billing") or context,
            tags=entry_tags,
            account_alias=entry_alias,
            codex_home=account_home if harness == "codex" else None,
            agy_home=account_home if harness == "gemini" else None,
        ):
            continue
        quota_sig = inspect.signature(quota.check).parameters
        quota_accepts_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in quota_sig.values())
        for model in launch_models(harness, lead, routes):
            candidate = s.pool_for(harness, model, entry["id"], view, config)
            # The runner's own quota check must land on the same account, or the launch would fail or misroute.
            quota_opts = {
                "claude_config_dir": config_dir,
                "account_id": entry["id"],
                "codex_home": account_home if harness == "codex" else None,
                "agy_home": account_home if harness == "gemini" else None,
            }
            if not quota_accepts_kwargs:
                quota_opts = {k: v for k, v in quota_opts.items() if k in quota_sig}
            routed = quota.check(engine, model, view, **quota_opts)
            if fits(candidate, entry["id"], harness) and routed.get("accountId") == entry["id"]:
                launches.append(
                    (s.rank(candidate), entry["id"], harness, model, candidate, config_dir, account_home, launch_env)
                )
                break
    if not launches:
        refuse(
            f"no pool on another {context} account is available now for a model as capable as the lead's "
            "(low, blocked and credits pools never take a handoff)"
        )
        return result
    _, account_id, harness, model, candidate, config_dir, account_home, launch_env = min(
        launches, key=lambda item: item[:2]
    )
    result["successor"] = {
        "kind": "launch",
        "harness": harness,
        "engine": HARNESS_ENGINE[harness],
        "model": model,
        "account": account_id,
        "pool": candidate["pool"],
        **(
            {
                **({"configDir": config_dir} if config_dir else {}),
                "accountHome": account_home,
                "launchEnv": launch_env,
                "unsetClaudeConfigDir": config_dir is None,
            }
            if harness == "claude"
            else {"accountHome": account_home, "launchEnv": launch_env}
        ),
    }
    return result


# The handoff (detached)


def script(name: str) -> str:
    return shlex.quote(str(Path(__file__).with_name(name).resolve()))


def team_name(room_id: str) -> str:
    name = f"room-{room_id}"
    if re.fullmatch(authority().TEAM, name):
        return name
    return "room-" + hashlib.sha256(room_id.encode()).hexdigest()[:16]


def find_team(session: str, rooms: list[dict[str, Any]]) -> dict[str, Any]:
    """The team this session leads, else the one to create for a room it conducts that no team holds, else why
    there is none (`tell`: whether the user needs to hear it). A room under another team is that team's."""
    a = authority()
    for directory in sorted((a.cache_dir() / "authority-v1").glob("*")):
        with contextlib.suppress(OSError, ValueError):
            record = a.load(directory)
            if record and record["lead"]["session"] == session:
                if record["status"] == "pending":
                    return {
                        "team": record["team"],
                        "why": f"this session's takeover of team {record['team']} was never accepted",
                        "tell": True,
                    }
                return {"team": record["team"], "record": record}
    for room in rooms:
        if not room.get("authority"):
            name = team_name(str(room.get("id")))
            try:
                record = a.load(a.team_dir(name))
            except (OSError, ValueError) as error:
                return {
                    "team": name,
                    "why": f"team {name} of room {room.get('id')} is unreadable: {error}",
                    "tell": True,
                }
            if record:
                return {"why": f"team {name} for room {room.get('id')} is led by {record['lead']['session']}"}
            return {"team": name, "create": True}
    for room in rooms:
        name = room["authority"]
        try:
            record = a.load(a.team_dir(name)) if isinstance(name, str) else None
        except (OSError, ValueError) as error:
            return {"team": name, "why": f"team {name} of room {room.get('id')} is unreadable: {error}", "tell": True}
        if not record:
            return {"team": name, "why": f"room {room.get('id')} names team {name}, which has no record", "tell": True}
    if rooms:
        return {"why": "every room this session conducts is under a team another session leads"}
    return {"why": "not a team lead or room conductor"}


def fence_plan(team: str, rooms: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """The conducted rooms a handoff of `team` fences (under no team or this one) and their tasks that are not
    under another team. Whatever another team holds is left alone."""
    mine = [room for room in rooms if room.get("authority") in (None, "", team)]
    tasks = [
        task["taskDir"]
        for room in mine
        for task in room_tasks(room)
        if task["team"] in (None, team) and task["taskId"] is not None
    ]
    return mine, tasks


def handed_by_us(record: dict[str, Any], session: str) -> bool:
    """Whether this session leads the team because an automatic handoff made it the lead, and nobody has
    appointed anyone since it accepted (an automatic designation withdrawn again does not count): then the
    same default may name its own successor."""
    previous = successor_record(session) or {}
    entries = [
        entry
        for entry in record.get("log") or []
        if entry["event"] not in {"task", "unregister", "offer-cancelled"}
        and not (entry["event"] == "offer" and entry.get("automatic"))
    ]
    events = [entry["event"] for entry in entries]
    while events[-2:] == ["designate", "withdraw"]:
        events = events[:-2]
    return (
        previous.get("team") == record["team"]
        and record.get("status") == "active"
        and not record.get("deputy")
        and bool(events)
        and events[-1] == "accept"
    )


def early_appointment(record: dict[str, Any], session: str) -> bool:
    """Recognize an untouched automatic appointment, including records from before it was tagged."""
    if record["generation"] != 1 or record.get("deputy"):
        return False
    entries = record["log"]
    if not entries or any(
        entry["event"] not in {"appoint", "designate", "withdraw", "offer", "offer-cancelled", "task", "unregister"}
        for entry in entries
    ):
        return False
    if entries[0].get("automatic"):
        return True
    # Older runs wrote the note before appointing. A note about an already appointed team names it explicitly.
    appointed = parse_time(entries[0].get("at"))
    if appointed is None or appointed.tzinfo is None:
        return False
    with contextlib.suppress(OSError), (session_dir(session) / "history.jsonl").open(encoding="utf-8") as history:
        for line in history:
            with contextlib.suppress(ValueError, OSError):
                early = json.loads(line)
                recorded = parse_time(early.get("recordedAt"))
                updated = parse_time(early.get("updatedAt"))
                if (
                    early.get("kind") == "early"
                    and early.get("team") == record["team"]
                    and early.get("generation") == 1
                    and recorded is not None
                    and updated is not None
                    and recorded <= appointed < updated + dt.timedelta(seconds=1)
                    and f"\n## Team {record['team']}\n"
                    not in (files_dir(early) / "note.md").read_text(encoding="utf-8")
                ):
                    return True
    return False


def fence(team: str, rooms: list[dict[str, Any]], *, base: Path, session: str, generation: int) -> dict[str, list]:
    """Put the planned rooms (fence_plan) and their tasks under `team`, so coordinator and rooms refuse the old
    lead once it is taken over. A task is adopted before it is registered, so one another team took meanwhile
    is refused before this team's record changes. Returns what it changed; on error the exception carries
    that as `.changed`, for release_fence()."""
    a, coordinator, store = authority(), module("coordinator"), module("room_store")
    changed: dict[str, list] = {"tasks": [], "rooms": []}
    try:
        for room in rooms:
            for task in room_tasks(room):
                directory = Path(task["taskDir"])
                if task["team"] not in (None, team) or not (directory / "task.json").is_file():
                    continue  # another team's task, or one removed since
                if coordinator.adopt_authority(directory, team):
                    changed["tasks"].append(str(directory))
                a.register_task(team, directory, session, generation)
            room_id = str(room.get("id"))
            current = store.read_room(base, room_id) or room
            named = current.get("authority")
            if named and named != team:
                raise ValueError(f"room {room_id} was put under team {named} meanwhile")
            if not named and store.set_metadata(base, room_id, authority=team) is not None:
                changed["rooms"].append(room_id)
    except Exception as error:
        error.changed = changed  # type: ignore[attr-defined] -- release_fence() undoes these
        raise
    return changed


def release_fence(
    team: str, changed: dict[str, list], *, base: Path, session: str, generation: int, unregister: bool
) -> list[str]:
    """Undo exactly what fence() changed, for a takeover that never happened; returns what could not be undone.
    `unregister`: also take the released tasks off a team that stays."""
    coordinator, store, left, released = module("coordinator"), module("room_store"), [], []
    for directory in changed.get("tasks") or []:
        try:
            coordinator.adopt_authority(Path(directory), team, release=True)
            released.append(directory)
        except Exception as error:  # noqa: BLE001 -- every task gets its try; the caller reports what is left
            left.append(f"task {directory} stays under team {team}: {error}")
    for room_id in changed.get("rooms") or []:
        try:
            if (store.read_room(base, room_id) or {}).get("authority") == team:
                store.set_metadata(base, room_id, authority=None)
        except Exception as error:  # noqa: BLE001 -- as above
            left.append(f"room {room_id} stays under team {team}: {error}")
    if unregister and released:
        try:
            authority().unregister_tasks(team, released, session, generation)
        except (authority().AuthorityError, OSError) as error:
            left.append(f"team {team} keeps tasks it no longer fences: {error}")
    return left


def chain_of(session: str) -> dict[str, Any]:
    """Where this session sits in a chain of handoffs: the original session and the handoffs so far."""
    previous = successor_record(session)
    if previous:
        return {"origin": previous["origin"], "count": previous["count"]}
    return {"origin": session, "count": 0}


def brief(
    event: dict[str, Any],
    note: str,
    team: str,
    generation: int,
    successor: dict[str, Any],
    *,
    chief: dict[str, Any] | None = None,
) -> str:
    harness = successor["harness"]
    transition = (
        f"Session {event['session']} is low on quota and offered team {team} to you as "
        f"session `{successor['session']}`. The current lead keeps authority until you accept.\n\n"
        if event.get("kind") == "early"
        else f"Session {event['session']} ran out of usage ({event['reason']}). Orkest fenced it and made you its "
        f"successor as session `{successor['session']}`. Your generation of team {team} is pending.\n\n"
    )
    chief_section = ""
    if chief:
        chief_section = (
            "\n## Chief desk\n\n"
            + "\n".join(chief_desk_lines(chief))
            + "\n\nTeam takeover does NOT transfer `chief.json`. After accepting team leadership, run "
            "`ork chief bind` in this session if it should also hold the machine-wide Chief desk.\n"
        )
    return (
        "# Continue as the lead after an automatic handoff\n\n" + transition + "First, before any other work:\n\n"
        f"1. `python3 {script('authority.py')} show --team {team} --harness {harness}` and review it.\n"
        f"2. `python3 {script('authority.py')} accept --team {team} --session {successor['session']} "
        f"--harness {harness} --expect-generation {generation} --digest DIGEST`, with the digest show printed.\n\n"
        "If accept refuses, stop and report why: never work around the fence. Once accepted, continue the work "
        "the note below records, in its checkout.\n" + chief_section + "\n" + note
    )


def chief_brief(
    event: dict[str, Any],
    chief: dict[str, Any],
    note: str,
    *,
    base: Path,
    choice: dict[str, Any],
) -> str:
    """Private handoff brief when the machine-wide Chief runs out of usage without a team."""
    peer_session = event.get("peerSession") or event["session"]
    progress = mailbox().load(base / "progress" / f"{mailbox().session_key(peer_session)}.json") or {}
    successor = choice.get("successor") or {}
    quota_event = "reached low quota" if event.get("kind") == "early" else "ran out of usage"
    lines = [
        "# Ork Chief handoff brief (no team takeover)",
        "",
        f"The machine-wide Chief session {quota_event}. Claim the desk separately with `ork chief bind`.",
        "",
        "## Chief event & binding",
        "",
        f"- Event ID: {event['id']}",
        f"- Recorded at: {event['recordedAt']}",
        f"- Reason: {event['reason']} (from {event['source']})",
        f"- Old Chief session: {chief.get('session') or event['session']} ({chief.get('name') or event.get('name') or 'unnamed'})",
        f"- Machine: {chief.get('machine') or socket.gethostname()}",
        f"- Bound at: {chief.get('boundAt') or 'unknown'}",
        f"- Working directory: {event.get('cwd') or chief.get('cwd') or 'unknown'}",
        f"- Checkout: {event.get('checkout') or event.get('cwd') or chief.get('cwd') or 'unknown'}",
        f"- Model: {event.get('model') or chief.get('model') or 'unknown'}",
        f"- Account: {choice.get('account') or 'unknown'}",
        f"- Pool: {choice.get('pool') or 'unknown'}",
        f"- Observed quota status: {choice.get('status') or 'unknown'}",
        "",
        "## Progress",
        "",
    ]
    if progress:
        for key in ("goal", "task", "stage", "role", "updatedAt"):
            if progress.get(key):
                val = progress[key] if isinstance(progress[key], str) else json.dumps(progress[key])
                lines.append(f"- {key}: {val}")
    else:
        lines.append("- none recorded")
    lines += [
        "",
        "## Recovery steps (`ork chief bind`)",
        "",
        "1. Open or switch to a session on another account with available quota"
        + (
            f" (suggested candidate: {successor.get('session') or successor.get('account')}, "
            f"pool {successor.get('pool')}, harness {successor.get('harness')})."
            if successor
            else "."
        ),
        "2. Run `ork chief bind` (or `ork chief bind --session <SESSION_ID>`) to claim `<mailboxRoot>/chief.json`.",
        "3. Run `ork chief status` and `ork chief desk` to inspect active rooms, standalone sessions, and unread desk reports.",
        "",
        note.rstrip(),
    ]
    return "\n".join(lines) + "\n"


def deliver_peer(base: Path, event: dict[str, Any], successor: dict[str, Any], text: str) -> dict[str, Any]:
    m = mailbox()
    peer_session = event.get("peerSession") or event["session"]
    sender = m.load(m.peer_path(base, peer_session)) or {}
    if not sender.get("session"):
        sender = {
            "session": peer_session,
            "harness": event.get("harness") or "claude",
            "cwd": event.get("cwd") or os.getcwd(),
            "pid": os.getpid(),
            "machine": socket.gethostname(),
        }
    result = m.send(
        base,
        sender=sender,
        to=successor["session"],
        text=text,
        scope="cross-project",
        wake=True,
        idempotency_key=f"handoff-{event['id']}",
        native_unreachable="automatic usage-exhaustion handoff",
    )
    wake = result.get("wake") or {}
    return {"message": result.get("id"), "wake": wake.get("status"), "wakeReason": wake.get("reason")}


def launch(command: list[str], env: dict[str, str]) -> dict[str, Any]:
    completed = subprocess.run(command, capture_output=True, text=True, timeout=600, env=env, check=False)
    return {"exitCode": completed.returncode, "output": (completed.stdout + completed.stderr)[-2000:]}


def launch_in_pane(
    command: list[str],
    env: dict[str, str],
    *,
    event: dict[str, Any],
    successor: dict[str, Any],
    team: str,
    generation: int,
    context: str,
) -> dict[str, Any] | None:
    """Start a native interactive harness in one sibling pane.

    None means no pane could be opened, so the caller launches headless. `headlessBecause` means the
    pane's harness never registered and was stopped, so the caller may launch headless once instead.
    """
    checkout = str(event["checkout"])
    brief_path = files_dir(event) / "brief.md"
    node = shutil.which("node")
    chief = Path(__file__).resolve().parents[1] / "lib" / "chief.mjs"
    if (
        not node
        or not chief.is_file()
        or not (
            env.get("HERDR_ENV") == "1"
            or env.get("ORCA_PANE_KEY")
            or env.get("ORCA_AGENT_PANE")
            or env.get("TMUX_PANE")
        )
    ):
        return None
    if (env.get("ORCA_PANE_KEY") or env.get("ORCA_AGENT_PANE")) and not env.get("ORCA_TERMINAL_HANDLE"):
        handle = module("orca_context").current_terminal(env)
        if handle:
            env = {**env, "ORCA_TERMINAL_HANDLE": handle}
    attempt = brief_path.parent / ("pane-" + secrets.token_hex(8))
    launcher = attempt / "launch.sh"
    request = attempt / "request.json"
    # The pane retries a busy lease itself, so the deadline covers those waits as well as startup.
    deadline = time.monotonic() + sum(LAUNCH_RETRY_SECONDS) + PANE_READY_SECONDS
    write_private(
        request,
        json.dumps(
            {
                "event": event["id"],
                "predecessor": event["session"],
                "team": team,
                "generation": generation,
                "checkout": checkout,
                "brief": str(brief_path),
                "deadline": deadline,
                "retrySeconds": list(LAUNCH_RETRY_SECONDS),
                "context": context,
                **{
                    key: successor[key]
                    for key in ("session", "engine", "harness", "model", "account", "pool", "accountHome")
                },
            }
        ),
    )
    account_vars = {
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "GEMINI_CLI_HOME",
        "ANTIGRAVITY_APP_DATA_DIR",
        "ORKEST_CLAUDE_ACCOUNT_HOME",
        "ORKEST_CODEX_ACCOUNT_HOME",
        "ORKEST_AGY_ACCOUNT_HOME",
        "ORKEST_PINNED_CLAUDE_ACCOUNT",
        "ORKEST_HANDOFF_LAUNCH",
        "ORCHESTRATE_HOME",
        "AGENT_EXECUTOR_HOME",
        "ORCHESTRATE_CONFIG",
        "AGENT_EXECUTOR_CONFIG",
        "MONITOR_CONFIG",
        "MONITOR_CACHE_DIR",
        "MONITOR_BIN",
        "PATH",
        *PANE_PARENT_VARS,
    }
    child_env = {**env, "ORCHESTRATE_HOME": str(module("runtime_paths").cache_home())}
    for var in PANE_PARENT_VARS:
        child_env.pop(var, None)
    names = sorted(
        account_vars | {key for key in os.environ.keys() | env.keys() if os.environ.get(key) != env.get(key)}
    )
    lines = ["#!/bin/sh"]
    for name in names:
        if name != "ORCA_TERMINAL_HANDLE" and re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", name):
            lines.append(f"export {name}={shlex.quote(child_env[name])}" if name in child_env else f"unset {name}")
    # Orca can give the child its own terminal handle. Never export the parent's discovered handle.
    if parent_handle := env.get("ORCA_TERMINAL_HANDLE"):
        lines.append(
            f'if [ "${{ORCA_TERMINAL_HANDLE:-}}" = {shlex.quote(parent_handle)} ]; then unset ORCA_TERMINAL_HANDLE; fi'
        )
    lines.append("exec " + shlex.join([sys.executable, str(Path(__file__).resolve()), "pane-start", str(request)]))
    write_private(launcher, "\n".join(lines) + "\n")
    launcher.chmod(0o700)
    completed = subprocess.run(
        [
            node,
            "--input-type=module",
            "-e",
            "const [module, workspace, launcher] = process.argv.slice(1);"
            "const {launchSiblingPane} = await import(module);"
            "console.log(JSON.stringify(launchSiblingPane({workspace, launcher})));",
            chief.as_uri(),
            checkout,
            str(launcher),
        ],
        capture_output=True,
        text=True,
        timeout=65,
        env=env,
        check=False,
    )
    if completed.returncode:
        # An unconfirmed split may already have launched. Never start a second successor here.
        raise ValueError("the pane launch was not confirmed")
    if not (pane := json.loads(completed.stdout)):
        return None
    # The pane stops its own harness at the deadline and reports it, so wait a little longer for that.
    while time.monotonic() < deadline + PANE_EXIT_GRACE_SECONDS:
        attempts = (load_json(attempt / "attempts.json") or {}).get("attempts", 1)
        if result := load_json(attempt / "exit.json"):
            if result.pop("readyTimeout", False):
                return {"headlessBecause": result["reason"], "pane": pane}
            return {**result, "pane": pane, "attempts": attempts}
        if ready := load_json(attempt / "ready.json"):
            return {"exitCode": 0, "pane": pane, "nativeSession": ready["session"], "attempts": attempts}
        time.sleep(0.1)
    raise ValueError("the interactive harness did not confirm startup")


def offer_current(team: str, event_id: str) -> bool:
    a = authority()
    offer = (a.load(a.team_dir(team)) or {}).get("offer") or {}
    return offer.get("automatic") == event_id and not a.automatic_offer_expired(offer)


def launch_command(event: dict[str, Any], successor: dict[str, Any], brief_path: Path) -> list[str]:
    command = [
        sys.executable,
        str(Path(__file__).with_name("run_agent.py").resolve()),
        "--cwd",
        str(event.get("checkout") or event.get("cwd")),
        "--brief",
        str(brief_path),
        "--engine",
        successor["engine"],
        "--model",
        successor["model"],
        "--transport",
        "executor",
        "--allow-path",
        ".",
        "--timeout",
        LAUNCH_TIMEOUT,
        "--detach",
    ]
    if successor.get("account"):
        command += ["--account", str(successor["account"])]
    if successor.get("configDir"):
        command += ["--claude-config-dir", successor["configDir"]]
    return command  # never --allow-credits or --ignore-quota: a successor runs on free quota only


def checkout_facts(event: dict[str, Any]) -> dict[str, Any]:
    """The checkout's root and repository, from Git when the session's record lacked them (a launch must
    start at the root, and notices are matched by repository)."""
    directory = event.get("checkout") or event.get("cwd")
    top = (git(directory, "rev-parse", "--show-toplevel") or "").strip()
    common = (git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir") or "").strip()
    facts = {}
    if top:
        facts["checkout"] = str(Path(top).resolve())
    if not event.get("repo") and common:
        facts["repo"] = str(Path(common).resolve())
    return facts


def launch_problem(checkout: str | None, *, wait: float = 0, sleep: Callable[[float], None] = time.sleep) -> str | None:
    """Why a fresh successor cannot start in this checkout now, checked just before anyone is fenced, with the
    same brief exclusive probe run_agent's detached launch makes. `wait`: how long to wait for the lease to
    come free (a launched predecessor's own run holds it until that run ends); counted in polls, not by clock."""
    if not checkout:
        return "the checkout's Git root is unknown, so no fresh successor can start there"
    support, waited = module("execution_support"), 0.0
    while True:
        try:
            with support.workspace_lease(Path(checkout), module("runtime_paths").cache_home()):
                return None
        except support.ContractError as error:
            if waited >= wait:
                return f"a fresh successor cannot start now: {error}"
        sleep(LEASE_POLL_SECONDS)
        waited += LEASE_POLL_SECONDS


def reappoint_hint(event: dict[str, Any]) -> str:
    if not event.get("team") or not event.get("generation"):
        return ""
    return (
        f"; the user can make a session the lead with python3 {script('authority.py')} appoint --team "
        f"{event['team']} --expect-generation {event['generation']} --lead-session SESSION --lead-harness HARNESS"
    )


def notice_for(event: dict[str, Any]) -> str:
    who = f"{event.get('name') or event['session']} ({event['session']})"
    show = f"python3 {script('handoff.py')} show --session {event['session']}"
    status, successor, team = event["status"], event.get("successor") or {}, event.get("team")
    reasons = "; ".join(event.get("reasons") or []) or "unknown"
    name = successor.get("name") or successor.get("session")
    if event.get("kind") == "early" and status != "brief-ready":
        if status == "offered":
            delivery = event.get("delivery") or {}
            how = "in a sibling pane" if delivery.get("pane") else "headless"
            if delivery.get("headlessBecause"):
                how = f"headless, because the visible pane failed ({delivery['headlessBecause']})"
            if successor.get("kind") == "peer":
                how = "through the mailbox"
            return (
                f"Orkest handoff: {who} reached low quota and offered team {team} to {name} {how}. "
                f"Authority changes only on acceptance. Details: {show}"
            )
        return f"Orkest handoff: {who} reached low quota. Handoff {status}: {reasons}. Details: {show}"
    if status == "brief-ready":
        brief_hint = f" Brief: {event['brief']}." if event.get("brief") else ""
        quota_event = "reached low quota" if event.get("kind") == "early" else "ran out of usage"
        return (
            f"Orkest Chief handoff: {who} {quota_event} ({event['reason']}) while holding the Chief desk. "
            f"A private Chief brief is ready (chief.json was not modified).{brief_hint} "
            f"Run `ork chief bind` in a session on another account to take over the Chief desk. Details: {show}"
        )
    if status == "handed-over":
        delivery = event.get("delivery") or {}
        if successor.get("kind") != "peer":
            how = "launched headless with the handoff note"
        elif delivery.get("wake") in WOKEN:
            how = "woken with the handoff note"
        else:
            how = (
                f"sent the handoff note but not woken ({delivery.get('wake') or 'unknown'}: "
                f"{delivery.get('wakeReason') or 'no reason given'}); it acts on its next turn, so wake it or tell "
                "the user"
            )
        chief_note = (
            " The previous lead also held the Chief desk (chief.json untouched); run `ork chief bind` to claim it separately."
            if event.get("chief")
            else ""
        )
        return (
            f"Orkest handoff: {who} ran out of usage ({event['reason']}). Team {team} is pending on {name} on "
            f"account {successor.get('account')}, {how}; the old lead is fenced until the user re-appoints it.{chief_note} "
            f"Details: {show}"
        )
    if event.get("takenOver"):
        return (
            f"Orkest handoff: {who} ran out of usage ({event['reason']}) and is fenced: team {team} was taken over "
            f"for {name}, but {reasons}. Nothing is continuing its work. Tell the user. Details: {show}"
            f"{reappoint_hint(event)}."
        )
    return (
        f"Orkest handoff: {who} ran out of usage ({event['reason']}) and was not handed over: {reasons}. Tell "
        f"the user. To continue by hand: {show}, then give that note to a session on another account"
        f"{reappoint_hint(event)}."
    )


@contextlib.contextmanager
def chief_lock(base: Path) -> Iterator[None]:
    """Exclusive flock on `<base>/chief.lock`, matching chief.mjs (never unlinked on release)."""
    lock_path = base / "chief.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        with contextlib.suppress(OSError):
            os.close(fd)


def run(session: str, event_id: str, **options: Any) -> dict[str, Any]:
    # Checkpoint requests can be superseded by exhaustion. Only one worker may alter team authority at a time.
    with locked(session_dir(session) / "worker"):
        return run_claimed(session, event_id, **options)


def run_claimed(
    session: str,
    event_id: str,
    *,
    base: Path | None = None,
    view: dict[str, Any] | None = None,
    fetch: Callable[[], dict[str, Any] | None] | None = None,
    peers: list[dict[str, Any]] | None = None,
    rooms: Callable[[Path, str], list[dict[str, Any]]] | None = None,
    launcher: Callable[[list[str], dict[str, str]], dict[str, Any]] | None = None,
    deliver: Callable[..., dict[str, Any]] | None = None,
    sleep: Callable[[float], None] | None = None,
    moment: dt.datetime | None = None,
) -> dict[str, Any]:
    """Claim the recorded event (only one process ever does) and hand over; always ends in a final status.
    `view` fixes monitor's answer (tests); otherwise `fetch` (default: a forced refresh) reads it."""
    base = base or mailbox().root()
    directory = session_dir(session)
    with locked(directory):
        event = load_json(directory / "event.json")
        if not event or event.get("id") != event_id or event.get("status") != "recorded":
            return {"status": "skipped", "reason": "the event is gone or already claimed"}
        event["status"] = "running"
        # Who runs it, so a later event can tell a live handoff from one whose process died.
        event["runner"] = {"pid": os.getpid(), "birth": mailbox().process_started(os.getpid())}
        save_event(directory, event)
    try:
        # The checkout's root and repository are kept from here on, so even a failure after the takeover
        # leaves a notice the repository's sessions are shown.
        if facts := checkout_facts(event):
            event.update(facts)
            with locked(directory):
                current = load_json(directory / "event.json") or {}
                if current.get("id") == event_id:
                    save_event(directory, {**current, **facts})
        outcome = handoff(
            event,
            base=base,
            fetch=fetch or ((lambda: view) if view is not None else refreshed_view),
            peers=peers,
            rooms=rooms,
            launcher=launcher,
            deliver=deliver,
            sleep=sleep or time.sleep,
        )
    except Exception as error:  # noqa: BLE001 -- a background handoff must always end with a reason the user sees
        outcome = {"status": "failed", "reasons": [f"{type(error).__name__}: {error}"]}
    expected_chief = outcome.pop("_expected_chief", None) if isinstance(outcome, dict) else None
    chief_strip_files = outcome.pop("_chief_strip_files", None) if isinstance(outcome, dict) else None

    def finalize_event() -> dict[str, Any]:
        with locked(directory):
            current = load_json(directory / "event.json") or {}
            finished = {**event, **current, **outcome} if current.get("id") == event_id else {**event, **outcome}
            if finished["status"] in {"handed-over", "offered", "brief-ready", "refused", "failed"}:
                finished["notice"] = notice_for(finished)
                finished["noticeAt"] = stamp(now())
            if current.get("id") == event_id:
                save_event(directory, finished)
            else:
                # A newer event replaced this one meanwhile: keep this outcome in the history, never over it.
                with contextlib.suppress(OSError), (directory / "history.jsonl").open("a", encoding="utf-8") as history:
                    history.write(json.dumps(finished, sort_keys=True) + "\n")
        return finished

    if outcome.get("status") == "brief-ready":
        with chief_lock(base):
            current_binding = load_json(base / "chief.json")
            live_now = live_chief_binding(base, session, event=event, peers=peers, moment=moment)
            still_same = bool(live_now) and _chief_token_matches(current_binding, expected_chief)
            if not still_same:
                brief_file = outcome.get("brief")
                if isinstance(brief_file, str) and brief_file:
                    with contextlib.suppress(OSError):
                        Path(brief_file).unlink()
                outcome = {
                    "team": outcome.get("team"),
                    "status": "ignored",
                    "reasons": ["session was superseded as Chief before publication"],
                }
            return finalize_event()
    if outcome.get("chief"):
        with chief_lock(base):
            current_binding = load_json(base / "chief.json")
            live_now = live_chief_binding(base, session, event=event, peers=peers, moment=moment)
            if not (bool(live_now) and _chief_token_matches(current_binding, expected_chief)):
                outcome.pop("chief", None)
                for file_path, clean_text in chief_strip_files or ():
                    with contextlib.suppress(OSError):
                        write_private(Path(file_path), clean_text)
            return finalize_event()
    return finalize_event()


def refreshed_view() -> dict[str, Any] | None:
    """monitor's view queried from the providers now: only the detached handoff waits for this."""
    quota = succession().module("quota")
    command = quota.monitor_command()
    if not command:
        return None
    try:
        completed = subprocess.run(
            [command, "json", "--refresh"],
            capture_output=True,
            text=True,
            timeout=95,
            env={**os.environ, "NO_COLOR": "1"},
            check=False,
        )
        view = json.loads(completed.stdout) if completed.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return view if isinstance(view, dict) and str(view.get("schema", "")).startswith(quota.SCHEMA_PREFIX) else None


def mark_taken_over(session: str, event_id: str, team: str, generation: int) -> None:
    """Recorded the moment the takeover lands, so no later event names a second successor for it."""
    directory = session_dir(session)
    with locked(directory):
        current = load_json(directory / "event.json")
        if current and current.get("id") == event_id:
            current.update(takenOver=True, team=team, generation=generation)
            save_event(directory, current)


def standing_wait(record: dict[str, Any], moment: dt.datetime, *, peer_session: str | None = None) -> float:
    """Seconds until the lead has been quiet as long as the team's standing rule asks (StopFailure fires at
    once); 0 when it already has or the wait is too long to hold a handoff for."""
    seconds = (record.get("standing") or {}).get("seconds") or 0
    lead = record.get("lead") or {}
    target_session = peer_session or lead.get("peerSession") or lead.get("session")
    peer = mailbox().load(mailbox().peer_path(mailbox().root(), target_session)) or {} if target_session else {}
    seen = parse_time(peer.get("lastSeenAt"))
    if not seconds or seen is None:
        return 0
    left = seconds - (moment - seen).total_seconds()
    return left + 1 if 0 < left <= MAX_STANDING_WAIT else 0


def allowed_here(
    policy: Any,
    checkout: str | None,
    engine: str,
    config_dir: str | None,
    *,
    account_id: str | None = None,
    provider: str | None = None,
    billing_mode: str | None = None,
    tags: list[str] | tuple[str, ...] | None = None,
    account_alias: str | None = None,
    codex_home: str | None = None,
    agy_home: str | None = None,
    strict: bool = False,
) -> bool:
    """The repository's harness policy for a launch; unknown is not allowed."""
    try:
        if not checkout:
            return False
        params = inspect.signature(policy.check_execution_allowed).parameters
        accepts_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
        if "strict" in params or accepts_kwargs:
            optional = {
                "account_id": account_id,
                "provider": provider,
                "billing_mode": billing_mode,
                "tags": list(tags) if tags is not None else None,
                "account_alias": account_alias,
                "codex_home": codex_home,
                "agy_home": agy_home,
                "strict": strict,
            }
            kwargs = optional if accepts_kwargs else {k: v for k, v in optional.items() if k in params}
            return bool(policy.check_execution_allowed(checkout, engine, config_dir, **kwargs)[0])
        return bool(policy.check_execution_allowed(checkout, engine, config_dir)[0])
    except Exception:  # noqa: BLE001 -- a policy that cannot be read allows nothing
        return False


def handoff(
    event: dict[str, Any],
    *,
    base: Path,
    fetch: Callable[[], dict[str, Any] | None],
    peers: list[dict[str, Any]] | None,
    rooms: Callable | None,
    launcher: Callable | None,
    deliver: Callable | None,
    sleep: Callable[[float], None],
) -> dict[str, Any]:
    """Hand the claimed event over (see the module docstring). `event` already carries checkout_facts()."""
    a, s = authority(), succession()
    options = settings()
    early = event.get("kind") == "early"
    if not options["enabled"] or (early and not options["early"]):
        return {"status": "ignored", "reasons": ["handoff is disabled"]}
    session = event["session"]
    if early and not wait_for_checkpoint(base, event, sleep):
        return {"status": "ignored", "reasons": ["superseded by quota exhaustion"]}
    conducted = (rooms or conducted_rooms)(base, session)
    found = find_team(session, conducted)
    chief = live_chief_binding(base, session, event=event, peers=peers)
    captured_chief_token = _chief_token(chief)
    chief_only = bool(chief) and bool(found.get("why")) and not found.get("tell")
    outcome: dict[str, Any] = {"team": found.get("team")}

    def refuse(*reasons: str) -> dict[str, Any]:
        return {**outcome, "status": "refused", "reasons": list(reasons)}

    if found.get("why") and not found.get("tell") and not chief:
        return {**outcome, "status": "ignored", "reasons": [found["why"]]}
    record = found.get("record")
    existing_offer = (record or {}).get("offer") or {}
    if early and existing_offer and not a.automatic_offer_expired(existing_offer):
        return refuse("the team already has an outstanding handover offer")
    replace_automatic_offer = None if early else existing_offer.get("automatic")
    note = build_note(event, base=base, rooms=conducted, team=record, chief=chief)
    note_path = files_dir(event) / "note.md"
    write_private(note_path, note)
    outcome["note"] = str(note_path)
    if not chief_only and found.get("why"):
        return refuse(found["why"])
    team = found.get("team")
    chain: dict[str, Any] = {"origin": session, "count": 0}
    reappoint = False
    appointing = False
    fenced_rooms: list[dict[str, Any]] = []
    fenced_tasks: list[str] = []
    if not chief_only:
        assert isinstance(team, str)
        chain = chain_of(session)
        outcome["chain"] = {**chain, "count": chain["count"] + 1}
        if chain["count"] >= CHAIN_LIMIT:
            return refuse(f"handed over {chain['count']} times already from session {chain['origin']}; stopping there")
        reappoint = (
            not early
            and bool(record)
            and not record.get("standing")
            and (not record.get("offer") or record["offer"].get("automatic"))
            and (handed_by_us(record, session) or early_appointment(record, session))
        )
        if record:
            outcome["generation"] = record["generation"]
            if not early and not record.get("standing") and not reappoint:
                return refuse(f"team {team} has no standing takeover rule, so only the user can approve a takeover")
        appointing = record is None or reappoint
        # What this handoff fences: the conducted rooms under no team or this one, and their tasks.
        fenced_rooms, fenced_tasks = fence_plan(team, conducted)
    config = s.monitor_config()
    lead = {
        "session": session,
        "harness": event["harness"],
        "model": event.get("model"),
        "accountHome": event.get("accountHome"),
        "repo": event.get("repo"),
    }
    policy = module("repo_policy")
    checkout = event.get("checkout")

    def choose(view: dict[str, Any] | None) -> dict[str, Any]:
        # Peers are read with each view: a session goes busy or idle while monitor is re-read.
        live_peers = (peers if peers is not None else mailbox().peers(base)) if view else []
        rest = module("handoff_rest")
        return choose_successor(
            lead,
            view=view,
            config=config,
            peers=[peer for peer in live_peers if not rest.resting(base, peer["session"], view=view, config=config)],
            options={**options, "requireFresh": early},
            deputy=None if reappoint else (record or {}).get("deputy"),
            allowed=lambda engine, config_dir, **policy_ctx: allowed_here(
                policy, checkout, engine, config_dir, **policy_ctx
            ),
        )

    def judge(choice: dict[str, Any]) -> dict[str, Any] | None:
        """A final outcome when this choice ends the handoff, else None."""
        if choice.get("status"):
            if (
                choice.get("stale")
                or choice["status"] not in (*s.EXHAUSTED, *s.USABLE)
                or (early and not s.pool_fresh(choice["leadQuota"], config))
            ):
                return refuse(
                    f"monitor's data for the pool {choice['pool']} is stale or unknown: whether it is out is unknown"
                )
            if choice["status"] not in s.EXHAUSTED and not (
                early and early_due(choice["leadQuota"], options["earlyPercentLeft"])
            ):
                # A rate limit with room left (a burst, an overload) is no exhausted pool: no handoff, no notice.
                spend = choice["leadQuota"].get("spendToZero") if early else None
                return {
                    **outcome,
                    "status": "not-low" if early else "not-exhausted",
                    "reasons": [
                        spending_text(spend)
                        if spend
                        else f"monitor reports the pool {choice['pool']} {choice['status']}"
                    ],
                }
        if record and record["lead"].get("pool") and choice.get("pool") and record["lead"]["pool"] != choice["pool"]:
            return refuse(f"the team records the lead's pool {record['lead']['pool']}, not {choice['pool']}")
        if choice["refusals"]:
            return refuse(*choice["refusals"])
        return None

    def plan(choice: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        """The successor, its deputy entry, and the record the takeover will be judged on."""
        successor = dict(choice["successor"])
        if successor["kind"] == "launch":
            successor["session"] = f"handoff-{event['id']}"
        deputy = {key: successor[key] for key in ("harness", "session", "pool", "account")}
        tasks = list(
            dict.fromkeys([*((record or {}).get("tasks") or []), *(str(Path(task).resolve()) for task in fenced_tasks)])
        )
        lead_entry = {**((record or {}).get("lead") or {})}
        if event.get("peerSession"):
            lead_entry["peerSession"] = event["peerSession"]
        if appointing:
            planned = {
                **(record or {}),
                "standing": AUTO_STANDING,
                "lead": {**lead_entry, "session": session, "pool": choice["pool"]},
                "deputy": deputy,
                "tasks": tasks,
            }
        else:
            planned = {**record, "lead": lead_entry, "tasks": tasks}
        return successor, deputy, planned

    # A 429 can come before monitor sees the pool out: re-read it fresh a few times before calling it a burst.
    for delay in (0,) if early else (0, *RECHECK_SECONDS):
        if delay:
            sleep(delay)
        view = fetch()
        choice = choose(view)
        if not choice.get("status") or (choice["status"] in s.EXHAUSTED and not choice.get("stale")):
            break
    if chief_only:
        if final := judge(choice):
            return final
        brief_path = files_dir(event) / "brief.md"
        with chief_lock(base):
            # Verify against the original captured generation so a clear/rebind during quota retries is never adopted.
            current_binding = load_json(base / "chief.json")
            current_chief = live_chief_binding(base, session, event=event, peers=peers)
            if not current_chief or not _chief_token_matches(current_binding, captured_chief_token):
                return {**outcome, "status": "ignored", "reasons": ["session is no longer the live local Chief"]}
            write_private(brief_path, chief_brief(event, current_chief, note, base=base, choice=choice))
        return {
            **outcome,
            "status": "brief-ready",
            "reasons": [],
            "brief": str(brief_path),
            "account": choice.get("account"),
            "pool": choice.get("pool"),
            "context": choice.get("context"),
            "quotaStatus": choice.get("status"),
            "chief": chief_summary(current_chief),
            "_expected_chief": captured_chief_token,
        }
    # Checked before anything changes, with the same evidence functions the takeover runs, so a takeover
    # that would refuse never leaves a team behind. The takeover re-checks under its own lock.
    waited = False
    while True:
        if final := judge(choice):
            return final
        successor, deputy, planned = plan(choice)
        if early:
            reasons, lead_status = [], None
            break
        reasons, lead_status = s.monitor_evidence(planned, view=view, config=config, moment=s.now())
        if (
            reasons
            or waited
            or not (wait := standing_wait(planned, s.now(), peer_session=event.get("peerSession") or event["session"]))
        ):
            break
        # The lead must be quiet a while first; whatever monitor and the peers said may change meanwhile.
        sleep(wait)
        waited = True
        view = fetch()
        choice = choose(view)
    if not early and not reasons:
        reasons = s.local_evidence(
            planned, lead_status=lead_status, moment=s.now(), replace_automatic_offer=replace_automatic_offer
        )
    if reasons:
        return refuse("no standing takeover: " + "; ".join(reasons))
    if successor["kind"] == "launch":
        if successor["harness"] != "claude" and not successor.get("accountHome"):
            return refuse(
                f"cannot launch {successor['harness']} successor for account '{successor.get('account')}': "
                "verified account home is unknown"
            )
        # A launched predecessor's own run holds the checkout until it ends: a successor waits for it.
        wait = LEASE_WAIT_SECONDS if not early and successor_record(session) else 0
        if problem := launch_problem(checkout, wait=wait, sleep=sleep):
            return refuse(problem)
    if early:
        # Monitor refresh can take another turn. Recheck leadership before attaching any room or task.
        current = load_json(session_dir(session) / "event.json") or {}
        if current.get("id") != event["id"]:
            return {"status": "ignored", "reasons": ["superseded by quota exhaustion"]}
        conducted = (rooms or conducted_rooms)(base, session)
        latest = find_team(session, conducted)
        if latest.get("team") != team or latest.get("why") or latest.get("record") != record:
            return refuse("leadership or the team changed while preparing the offer")
        fenced_rooms, _ = fence_plan(team, conducted)
    outcome["successor"] = successor
    repository = (record or {}).get("repository") or event.get("repo")
    created = record is None
    changed: dict[str, list] = {"tasks": [], "rooms": []}

    def undo(error_changed: dict[str, list]) -> list[str]:
        """Undo this handoff's appointment or designation and fence; returns what is left, for the notice."""
        if appointing:
            left = withdraw(team, record, error_changed, base=base, created=created and not early)
            if not left and created and not early:
                outcome.update(team=None, generation=None)
            return left
        return release_fence(
            team, error_changed, base=base, session=session, generation=record["generation"], unregister=True
        )

    if appointing:
        # No appointment step for the user: the default names the successor as deputy under a standing rule,
        # so the takeover below goes through authority's own evidence checks and compare-and-swap.
        try:
            if reappoint:
                # Naming a deputy keeps the generation, so the lead's own work at it stands until the takeover.
                record = a.designate(
                    team,
                    session,
                    record["generation"],
                    deputy=deputy,
                    standing=AUTO_STANDING,
                    lead_pool=choice["pool"],
                    expected=record,
                )
            else:
                record = a.appoint(
                    team,
                    {**a.member(session, event["harness"]), "pool": choice["pool"]},
                    deputy=None if early else deputy,
                    standing=None if early else AUTO_STANDING,
                    repository=repository,
                    expect_generation=0,
                    automatic=event["id"] if early else None,
                )
        except a.AuthorityError as error:
            return refuse(f"appointing team {team} failed: {error}")
        outcome["generation"] = record["generation"]
    try:
        changed = fence(team, fenced_rooms, base=base, session=session, generation=record["generation"])
    except Exception as error:  # noqa: BLE001 -- undo what this handoff changed and tell the user why
        left = undo(getattr(error, "changed", changed))
        return refuse(f"putting the room's tasks under team {team} failed: {error}", *left)
    try:
        if early:
            target_pool = s.pool_for(successor["harness"], successor["model"], successor["account"], view, config)
            if not all(s.pool_fresh(pool, config) for pool in (choice["leadQuota"], target_pool)):
                raise a.AuthorityError("a monitor measurement expired before the offer")
            module("handoff_rest").prepare(
                base,
                event.get("peerSession") or session,
                team,
                event["id"],
                choice["leadQuota"],
                options["earlyPercentLeft"],
            )
            taken = a.offer(team, session, record["generation"], deputy, outcome["note"], automatic=event["id"])
        else:
            taken = a.takeover(
                team,
                a.member(successor["session"], successor["harness"]),
                record["generation"],
                user_approved=False,
                standing=True,
                successor_account=successor["account"],
                successor_repository=repository,
                replace_automatic_offer=replace_automatic_offer,
            )
    except a.AuthorityError as error:
        if early:
            module("handoff_rest").release(base, event.get("peerSession") or session, event["id"])
        return refuse(str(error), *undo(changed))
    outcome.update(generation=taken["generation"])
    if not early:
        outcome["takenOver"] = True
        mark_taken_over(session, event["id"], team, taken["generation"])
    # Written at once: the takeover happened, so a successor that runs out later is a step in this chain.
    write_private(
        root() / "successors" / f"{mailbox().session_key(successor['session'])}.json",
        json.dumps(
            {
                "origin": chain["origin"],
                "count": chain["count"] + 1,
                "from": session,
                "event": event["id"],
                "team": team,
                "harness": successor["harness"],
                "model": successor.get("model"),
                "accountHome": successor.get("configDir") or successor.get("accountHome"),
            }
        )
        + "\n",
    )
    brief_path = files_dir(event) / "brief.md"
    note_without_chief = build_note(event, base=base, rooms=conducted, team=record, chief=None)
    brief_without_chief = brief(event, note_without_chief, team, taken["generation"], successor, chief=None)
    current_chief = chief
    expected_chief = captured_chief_token
    if current_chief:
        with chief_lock(base):
            current_binding = load_json(base / "chief.json")
            live_now = live_chief_binding(base, session, event=event, peers=peers)
            if not (bool(live_now) and _chief_token_matches(current_binding, expected_chief)):
                current_chief = None
                expected_chief = None
                note = note_without_chief
                write_private(note_path, note)
                write_private(brief_path, brief_without_chief)
            else:
                current_chief = live_now
                write_private(brief_path, brief(event, note, team, taken["generation"], successor, chief=current_chief))
                outcome["chief"] = chief_summary(current_chief)
                outcome["_expected_chief"] = expected_chief
                outcome["_chief_strip_files"] = [
                    (str(note_path), note_without_chief),
                    (str(brief_path), brief_without_chief),
                ]
    else:
        write_private(brief_path, brief_without_chief)
    try:
        if successor["kind"] == "peer":
            transition = (
                "is low on quota and offered you leadership" if early else "ran out of usage and you are its successor"
            )
            message = (
                f"Orkest handoff: {event['session']} {transition} for team {team} "
                f"(generation {taken['generation']}). Read {brief_path}, then run authority.py show and "
                "accept exactly as it says before any other work."
            )
            outcome["delivery"] = (deliver or deliver_peer)(base, event, successor, message)
        else:
            env = {
                key: value
                for key, value in os.environ.items()
                if key
                not in {
                    "ORKEST_HANDOFF_SUCCESSOR",
                    "ORKEST_CLAUDE_ACCOUNT_HOME",
                    "ORKEST_CODEX_ACCOUNT_HOME",
                    "ORKEST_AGY_ACCOUNT_HOME",
                }
            }
            if early:
                for variable in PANE_PARENT_VARS:
                    env.pop(variable, None)
            env["ORKEST_HANDOFF_LAUNCH"] = successor["session"]  # run_agent hands it to this run alone
            launch_env = successor.get("launchEnv")
            if successor["harness"] == "claude":
                if isinstance(launch_env, dict):
                    for key, value in launch_env.items():
                        if key == "HOME":
                            if value is not None:
                                env["ORKEST_CLAUDE_ACCOUNT_HOME"] = value
                            continue
                        if value is None:
                            env.pop(key, None)
                        else:
                            env[key] = value
                    env.setdefault("ORKEST_PINNED_CLAUDE_ACCOUNT", "1")
                elif successor.get("unsetClaudeConfigDir"):
                    env.pop("CLAUDE_CONFIG_DIR", None)
                    env["ORKEST_PINNED_CLAUDE_ACCOUNT"] = "1"
                    raw_acct_home = successor.get("accountHome")
                    if isinstance(raw_acct_home, str) and raw_acct_home.strip():
                        acct_path = Path(raw_acct_home).resolve()
                        if acct_path.name == ".claude" and acct_path != (Path.home() / ".claude").resolve():
                            env["ORKEST_CLAUDE_ACCOUNT_HOME"] = str(acct_path.parent)
                elif successor.get("configDir"):
                    env["CLAUDE_CONFIG_DIR"] = successor["configDir"]
                    env["ORKEST_PINNED_CLAUDE_ACCOUNT"] = "1"
            else:
                if not launch_env and successor.get("accountHome"):
                    if successor["harness"] == "codex":
                        launch_env = {
                            "CODEX_HOME": successor["accountHome"],
                            "ORKEST_CODEX_ACCOUNT_HOME": successor["accountHome"],
                        }
                    elif successor["harness"] == "gemini":
                        launch_env = {
                            "GEMINI_CLI_HOME": successor["accountHome"],
                            "ANTIGRAVITY_APP_DATA_DIR": None,
                            "ORKEST_AGY_ACCOUNT_HOME": successor["accountHome"],
                        }
                if not launch_env:
                    raise ValueError(f"cannot launch {successor['harness']} successor without verified account home")
                for key, value in launch_env.items():
                    if value is None:
                        env.pop(key, None)
                    else:
                        env[key] = value
            command = launch_command(event, successor, brief_path)
            delivery, headless_because = None, None
            if launcher is None and early and options["visible"]:
                # One pane at most: the pane retries a busy lease itself, and a pane that never
                # registers falls back to the headless launch below, once, in this same episode.
                delivery = launch_in_pane(
                    command,
                    env,
                    event=event,
                    successor=successor,
                    team=team,
                    generation=taken["generation"],
                    context=choice["context"],
                )
                if delivery and delivery.get("headlessBecause"):
                    if not offer_current(team, event["id"]):
                        raise ValueError("the offer changed while the visible successor started")
                    headless_because, delivery = delivery["headlessBecause"], None
                if delivery is not None:
                    outcome["delivery"] = delivery
            if delivery is None:
                # A short reader can take the lease between launch_problem() and the launch: try again then.
                for attempt, delay in enumerate((0, *LAUNCH_RETRY_SECONDS), start=1):
                    if delay:
                        sleep(delay)
                    outcome["delivery"] = {**(launcher or launch)(command, env), "attempts": attempt}
                    if outcome["delivery"].get("exitCode") != LEASE_BUSY_EXIT:
                        break
                if headless_because:
                    outcome["delivery"]["headlessBecause"] = headless_because
            code = outcome["delivery"].get("exitCode")
            if code not in (0, None):
                if early:
                    detail = outcome["delivery"].get("reason")
                    raise ValueError(
                        f"launching the successor failed (exit {code})" + (f": {detail}" if detail else "")
                    )
                return {
                    **outcome,
                    "status": "failed",
                    "reasons": [f"launching the successor failed (exit {code}), so its takeover stays pending"],
                }
    except Exception as error:  # noqa: BLE001 -- the user must hear that delivery failed
        if early:
            a.cancel_automatic_offer(team, session, taken["generation"], event["id"])
            module("handoff_rest").release(base, event.get("peerSession") or session, event["id"])
        return {**outcome, "status": "failed", "reasons": [f"delivering the handoff failed: {error}"]}
    return {**outcome, "status": "offered" if early else "handed-over", "reasons": []}


def withdraw(team: str, record: dict[str, Any], changed: dict[str, list], *, base: Path, created: bool) -> list[str]:
    """Undo an automatic appointment or designation whose takeover never happened: what fence() changed first,
    then the deputy and standing rule (the team itself when this handoff created it). Returns what could not be
    undone, for the user's notice."""
    lead, generation = record["lead"]["session"], record["generation"]
    left = release_fence(team, changed, base=base, session=lead, generation=generation, unregister=True)
    try:
        authority().withdraw(team, lead, generation, remove=created and not left)
    except (authority().AuthorityError, OSError) as error:
        left.append(f"team {team} keeps its automatic appointment: {error}")
    return left


# Telling the user


def current_notice(event: dict[str, Any]) -> str:
    """The notice rendered now, so it names the script paths of this checkout; an old or partial event keeps its saved text."""
    try:
        return notice_for(event)
    except (KeyError, TypeError):
        return event["notice"]


def notices(base: Path, me: dict[str, Any], moment: dt.datetime | None = None) -> str:
    """Handoff outcomes for this repository that this session has not shown yet, once per session, for a day
    after the outcome (viewing one does not extend it)."""
    if ignored_peer(me) or not me.get("repo") or not settings()["enabled"]:
        return ""
    moment = moment or now()
    lines = []
    paths = sorted(root().glob("*/event.json"))
    for path in paths:
        event = load_json(path)
        if (
            not event
            or not event.get("notice")
            or me["session"] in (event.get("toldSessions") or [])
            or not succession().same_repository(event.get("repo"), me["repo"])
        ):
            continue
        noticed = parse_time(event.get("noticeAt") or event.get("updatedAt"))
        if noticed is None or (moment - noticed).total_seconds() > NOTICE_SECONDS:
            continue
        with locked(path.parent):
            current = load_json(path) or {}
            if current.get("id") != event["id"] or me["session"] in (current.get("toldSessions") or []):
                continue
            current["toldSessions"] = [*(current.get("toldSessions") or []), me["session"]]
            write_private(path, json.dumps(current, indent=2, sort_keys=True) + "\n")
        lines.append(current_notice(current))
    return "\n".join(lines)


# Commands


def summary(event: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "session", "name", "reason", "source", "recordedAt", "status", "reasons", "team", "generation")
    summary = {key: event.get(key) for key in keys} | {"successor": (event.get("successor") or {}).get("session")}
    if event.get("kind") == "early":
        summary.update(kind="early", status=offer_status(event), checkpointStatus=event.get("checkpointStatus"))
        if summary["status"] == "accepted":
            summary["generation"] += 1
        if pane := (event.get("delivery") or {}).get("pane"):
            summary["pane"] = pane
    return summary


def status() -> dict[str, Any]:
    events = [event for path in sorted(root().glob("*/event.json")) if (event := load_json(path))]
    events.sort(key=lambda event: str(event.get("recordedAt")), reverse=True)
    return {"settings": settings(), "config": str(config_path()), "events": [summary(event) for event in events]}


def show(session: str) -> str:
    directory = session_dir(session)
    event = load_json(directory / "event.json")
    if event is None:
        raise ValueError(f"no handoff is recorded for session {session}")
    try:
        note = (files_dir(event) / "note.md").read_text(encoding="utf-8")
    except OSError:
        note = "(no note: the handoff stopped before writing one)\n"
    if event.get("notice"):
        event = {**event, "notice": current_notice(event)}
    return note + "\n## Event\n\n```json\n" + json.dumps(event, indent=2, sort_keys=True) + "\n```\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("status", help="settings and recent handoff events")
    show_parser = commands.add_parser("show", help="the handoff note and event of a session")
    show_parser.add_argument("--session", required=True)
    commands.add_parser("enable", help="turn automatic handoff on")
    commands.add_parser("disable", help="turn automatic handoff off")
    run_parser = commands.add_parser("run", help=argparse.SUPPRESS)
    run_parser.add_argument("--session", required=True)
    run_parser.add_argument("--event", required=True)
    pane_parser = commands.add_parser("pane-start", help=argparse.SUPPRESS)
    pane_parser.add_argument("request", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.action == "show":
            print(show(args.session), end="")
            return 0
        if args.action == "pane-start":
            return module("handoff_pane").start(args.request)
        if args.action == "status":
            output: Any = status()
        elif args.action in {"enable", "disable"}:
            output = set_enabled(args.action == "enable")
        else:
            output = summary(run(args.session, args.event))
        print(json.dumps(output, indent=2, ensure_ascii=True))
        return 0
    except (OSError, ValueError) as error:
        print(f"handoff: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
