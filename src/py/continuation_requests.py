"""Durable, deduplicated continuation requests for authorized room work.

A request asks the owning coordinator to take its next turn: room work is queued when its turn
stopped, or a worker became terminal. It names the room, task, authority generation and input
revision; its key is derived from those alone, so a Stop, a completion and a reconciliation pass for
the same inputs fold into one request. Notifications are hints delivered through the existing mailbox
and wake path (`wake_recovery` retries the wake). The request is not a scheduler and never invokes a
model: the host reserves it, re-checking pause, cancellation, lease and authority, and then uses the
existing coordinator dispatch.

States: requested -> reserved -> awaiting_attachment -> running -> awaiting_acceptance -> completed,
with paused, exhausted, recovery_needed, superseded and cancelled as stops. A reserved request that
never shows a run is recovery work, never evidence that nothing started.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import peer_mailbox as mailbox
import room_store

SCHEMA = "orkest.continuation-requests.v1"
REQUEST_SCHEMA = "orkest.continuation-request.v1"
REASONS = ("stop", "worker_terminal", "reconcile")
STATES = (
    "requested",
    "reserved",
    "awaiting_attachment",
    "running",
    "awaiting_acceptance",
    "paused",
    "exhausted",
    "recovery_needed",
    "superseded",
    "cancelled",
    "completed",
)
OPEN_STATES = frozenset({"requested", "reserved", "awaiting_attachment", "running", "awaiting_acceptance"})
TERMINAL_STATES = frozenset({"exhausted", "superseded", "cancelled", "completed"})
LABELS = {
    "requested": "awaiting coordinator turn",
    "reserved": "reserved",
    "awaiting_attachment": "awaiting attachment",
    "running": "running",
    "awaiting_acceptance": "awaiting acceptance",
    "paused": "paused",
    "exhausted": "exhausted",
    "recovery_needed": "recovery needed",
    "superseded": "superseded",
    "cancelled": "cancelled",
    "completed": "completed",
}
# Seconds between delivery hints once the previous one was read; the last value repeats.
BACKOFF = (0, 60, 300)
MAX_DELIVERIES = 3
# A reservation that shows no run after this needs an operator: the launch outcome is unknown.
RESERVATION_TTL = dt.timedelta(minutes=10)
# Finished requests stay visible for a week; open, paused and recovery-needed ones are never dropped.
RETAIN_TERMINAL = dt.timedelta(days=7)
# Hosts whose wake and launch adapters are qualified for continuation; others get a manual resume path.
QUALIFIED_HOSTS_ENV = "ORKEST_CONTINUATION_HOSTS"
DISABLE_ENV = "ORKEST_CONTINUATION"


def store_path(base: Path) -> Path:
    return base / "continuations" / "requests.json"


def enabled() -> bool:
    """New requests can be switched off; existing requests and reservations are never dropped."""
    return os.environ.get(DISABLE_ENV, "1").strip().lower() not in {"0", "false", "off", "no"}


def qualified_hosts() -> frozenset[str]:
    raw = os.environ.get(QUALIFIED_HOSTS_ENV, "")
    return frozenset(part.strip() for part in raw.split(",") if part.strip())


def input_revision(task_spec: Any, *extra: Any) -> str:
    encoded = json.dumps([task_spec, *extra], sort_keys=True, default=str).encode()
    return hashlib.sha256(encoded).hexdigest()[:16]


def request_key(
    room: str | None, task_dir: str | None, generation: Any, revision: str, run_id: str | None = None
) -> str:
    material_parts: list[Any] = [room, task_dir, generation, revision]
    if run_id is not None:
        material_parts.append(run_id)
    material = json.dumps(material_parts, sort_keys=True)
    return "cont-" + hashlib.sha256(material.encode()).hexdigest()[:24]


def _team_authority(base: Path, room: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(room, dict):
        return None
    team = room.get("authority")
    if not isinstance(team, str) or not team:
        return None
    import authority

    if not re.fullmatch(authority.TEAM, team):
        return None
    with contextlib.suppress(authority.AuthorityError, OSError, ValueError):
        local_dir = base.parent / "authority-v1" / team
        if (local_dir / "authority.json").is_file():
            return authority.load(local_dir)
        return authority.load(authority.team_dir(team))
    return None


def _queued_members(room: dict[str, Any]) -> list[str]:
    return sorted(
        member["id"]
        for member in room.get("agents") or []
        if isinstance(member, dict)
        and member.get("status") == "queued"
        and not member.get("dispatch")
        and not member.get("paused")
        and member.get("role") != "lead"
        and isinstance(member.get("id"), str)
    )


def _empty() -> dict[str, Any]:
    return {"schema": SCHEMA, "requests": {}}


def _read(path: Path) -> dict[str, Any]:
    data = mailbox.load(path)
    if not isinstance(data, dict) or data.get("schema") != SCHEMA or not isinstance(data.get("requests"), dict):
        return _empty()
    return data


def load_all(base: Path) -> dict[str, dict[str, Any]]:
    return _read(store_path(base))["requests"]


@contextlib.contextmanager
def _store(base: Path):
    path = store_path(base)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with mailbox.locked(path):
        data = _read(path)
        before = json.dumps(data, sort_keys=True)
        yield data["requests"]
        if json.dumps(data, sort_keys=True) != before:
            mailbox.write(path, data)


def _now(moment: dt.datetime | None) -> dt.datetime:
    return moment or mailbox.now()


def _parse(value: Any) -> dt.datetime | None:
    try:
        return mailbox.parse_stamp(value)
    except (AttributeError, TypeError, ValueError):
        pass
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.UTC)


def request(
    base: Path,
    *,
    room: str | None,
    reason: str,
    revision: str,
    task_dir: str | None = None,
    task_id: str | None = None,
    member: str | None = None,
    generation: Any = None,
    run_id: str | None = None,
    owner: dict[str, Any] | None = None,
    deadline: str | None = None,
    moment: dt.datetime | None = None,
) -> tuple[dict[str, Any] | None, bool]:
    """Create or join the request for these inputs. Returns (request, created); None when disabled."""
    if reason not in REASONS:
        raise ValueError(f"continuation reason must be one of {', '.join(REASONS)}")
    if not room and not task_dir:
        raise ValueError("a continuation request needs a room or a task")
    key = request_key(room, task_dir, generation, revision, run_id=run_id)
    stamp = mailbox.stamp(_now(moment))
    with _store(base) as requests:
        existing = requests.get(key)
        if existing is not None:
            if reason not in existing["reasons"]:
                existing["reasons"].append(reason)
                existing["updated_at"] = stamp
            if owner and not existing.get("owner"):
                existing["owner"] = owner
            return dict(existing), False
        if not enabled():
            return None, False
        # A newer input revision supersedes an unreserved request for the same task; a reserved one is
        # left for recovery, since its launch may already be under way.
        for other in requests.values():
            if (
                other["key"] != key
                and other.get("room") == room
                and other.get("task_dir") == task_dir
                and other["status"] == "requested"
            ):
                other.update(status="superseded", stop_reason="a newer input revision replaced it", updated_at=stamp)
        created = {
            "schema": REQUEST_SCHEMA,
            "key": key,
            "room": room,
            "member": member,
            "task_dir": task_dir,
            "task_id": task_id,
            "run_id": run_id,
            "authority_generation": generation,
            "input_revision": revision,
            "reasons": [reason],
            "status": "requested",
            "owner": owner,
            "deadline": deadline,
            "deliveries": 0,
            "next_attempt_at": stamp,
            "last_attempt_at": None,
            "stop_reason": None,
            "created_at": stamp,
            "updated_at": stamp,
        }
        requests[key] = created
        return dict(created), True


def _room_stop(base: Path, entry: dict[str, Any]) -> tuple[str, str] | None:
    """Authoritative stop for a request: (state, reason), or None when work may proceed."""
    if entry.get("room"):
        room = room_store.read_room(base, entry["room"])
        if not isinstance(room, dict):
            return "recovery_needed", "the owning room is missing"
        lifecycle = room_store.room_lifecycle(room)
        if lifecycle == "cancelled":
            return "cancelled", "the room was cancelled"
        if lifecycle == "archived":
            return "paused", "the room is archived; new dispatch is closed"
        auth = _team_authority(base, room)
        if isinstance(auth, dict):
            if auth.get("status") == "withdrawn":
                return "cancelled", "team authority was withdrawn"
            if (
                entry.get("authority_generation") is not None
                and auth.get("generation") is not None
                and auth.get("generation") != entry["authority_generation"]
            ):
                return "superseded", "the team authority generation changed"
        members = {member.get("id"): member for member in room.get("agents") or [] if isinstance(member, dict)}
        current: str | None = entry.get("member")
        if (room.get("conductor") or {}).get("paused"):
            return "paused", "the room's coordinator branch is paused"
        seen: set[str] = set()
        while current and current != "conductor" and current not in seen:
            seen.add(current)
            node = members.get(current)
            if not node:
                break
            if node.get("paused"):
                return "paused", f"branch {current} is paused"
            current = node.get("parent")
    if entry.get("task_dir"):
        task = mailbox.load(Path(entry["task_dir"]) / "task.json")
        if not isinstance(task, dict):
            return "recovery_needed", "the task record is unreadable"
        if task.get("status") == "accepted":
            return "completed", "the task was accepted"
        if task.get("status") not in {None, "active"}:
            return "cancelled", f"the task is {task.get('status')}"
        if entry.get("authority_generation") is not None:
            current_generation = (task.get("authority") or {}).get("generation")
            if current_generation is not None and current_generation != entry["authority_generation"]:
                return "superseded", "the task's authority generation changed"
        deadline = _parse(task.get("deadline"))
        if deadline and mailbox.now() >= deadline:
            return "exhausted", "the task deadline passed"
        revision = input_revision(task.get("task_spec"))
        if entry.get("input_revision") and revision != entry["input_revision"]:
            return "superseded", "the task's inputs changed; issue a request for the new revision"
    return None


def _active_room_owners(room: dict[str, Any]) -> list[str]:
    conductor = room.get("conductor") or {}
    if not isinstance(conductor, dict):
        return []
    current_id = (conductor.get("session") or {}).get("id") if isinstance(conductor.get("session"), dict) else None
    former = set(conductor.get("previousSessions") or []) - {current_id}
    return [sid for sid in mailbox.room_owner_sessions(room, conductor) if sid not in former]


def reserve(
    base: Path,
    key: str,
    session: str,
    *,
    check: Callable[[Path, dict[str, Any]], tuple[str, str] | None] | None = None,
    moment: dt.datetime | None = None,
) -> dict[str, Any]:
    """Reserve once for the host that will act. Re-reads pause, cancellation and inputs under the lock."""
    check = check or _room_stop
    stamp = mailbox.stamp(_now(moment))
    with _store(base) as requests:
        entry = requests.get(key)
        if entry is None:
            raise ValueError("unknown continuation request")
        if entry["status"] != "requested":
            if entry.get("reserved_by") == session and entry["status"] in OPEN_STATES:
                return dict(entry)
            raise ValueError(f"continuation request is {entry['status']}; it cannot be reserved again")
        room = room_store.read_room(base, entry["room"]) if entry.get("room") else None
        auth = _team_authority(base, room)
        if isinstance(auth, dict) and auth.get("status") == "active":
            lead_session = (auth.get("lead") or {}).get("session")
            if isinstance(lead_session, str) and lead_session and session != lead_session:
                raise ValueError("session is not the current owner/lead for this continuation request")
        else:
            allowed_owners = _active_room_owners(room) if isinstance(room, dict) else []
            if not allowed_owners and isinstance(entry.get("owner"), dict):
                owner_session = entry["owner"].get("session")
                if isinstance(owner_session, str) and owner_session:
                    allowed_owners = [owner_session]
            if allowed_owners and session not in allowed_owners:
                raise ValueError("session is not the current owner/lead for this continuation request")
        stop = check(base, entry)
        if stop:
            entry.update(status=stop[0], stop_reason=stop[1], updated_at=stamp)
            return dict(entry)
        entry.update(status="reserved", reserved_by=session, reserved_at=stamp, updated_at=stamp)
        return dict(entry)


def bind(base: Path, key: str, session: str, request_id: str, *, moment: dt.datetime | None = None) -> dict[str, Any]:
    """Record the coordinator dispatch request ID this reservation launched (or will retry)."""
    stamp = mailbox.stamp(_now(moment))
    with _store(base) as requests:
        entry = requests.get(key)
        if entry is None or entry.get("reserved_by") != session:
            raise ValueError("bind needs this session's reservation")
        if entry.get("request_id") not in (None, request_id):
            raise ValueError("this reservation already belongs to another dispatch request")
        entry.update(request_id=request_id, updated_at=stamp)
        return dict(entry)


def cancel(base: Path, key: str, reason: str, *, moment: dt.datetime | None = None) -> dict[str, Any]:
    stamp = mailbox.stamp(_now(moment))
    with _store(base) as requests:
        entry = requests.get(key)
        if entry is None:
            raise ValueError("unknown continuation request")
        if entry["status"] not in TERMINAL_STATES:
            entry.update(status="cancelled", stop_reason=reason, updated_at=stamp)
        return dict(entry)


def _run_state(base: Path, entry: dict[str, Any]) -> tuple[str, str | None] | None:
    """Progress of a reserved request from its task record, by the dispatch request it bound."""
    if not entry.get("task_dir"):
        if not entry.get("room"):
            return None
        room = room_store.read_room(base, entry["room"])
        if not isinstance(room, dict) or not room_store.is_active_room(room):
            return "cancelled", "the room is no longer active"
        queued = _queued_members(room)
        if not queued:
            return "completed", None
        if input_revision(queued) != entry.get("input_revision"):
            if any(
                isinstance(member, dict) and member.get("role") != "lead" and member.get("dispatch")
                for member in room.get("agents") or []
            ):
                return "completed", None
            return "superseded", "queued members changed"
        return None
    task = mailbox.load(Path(entry["task_dir"]) / "task.json")
    if not isinstance(task, dict):
        return "recovery_needed", "the task record is unreadable"
    if task.get("status") == "accepted":
        return "completed", None
    runs = [run for run in task.get("runs") or [] if isinstance(run, dict)]
    if entry.get("request_id"):
        runs = [run for run in runs if run.get("request_id") == entry["request_id"]]
    elif (reserved := _parse(entry.get("reserved_at"))) is not None:
        runs = [run for run in runs if (at := _parse(run.get("reserved_at"))) is not None and at >= reserved]
    if not runs:
        return None
    run = runs[-1]
    status = run.get("status")
    if status == "uncertain":
        return "recovery_needed", run.get("recovery") or "the launch outcome is uncertain"
    if status == "reserved" or (run.get("transport") == "native" and not run.get("native_handle")):
        return "awaiting_attachment", None
    if status in {"dispatching", "active"}:
        return "running", None
    if status == "cancelled":
        return "cancelled", "the run was cancelled"
    if status == "finished":
        decided = any(decision.get("run_id") == run.get("run_id") for decision in task.get("decisions") or [])
        return ("completed", None) if decided else ("awaiting_acceptance", None)
    return None


def reconcile(base: Path, *, moment: dt.datetime | None = None) -> list[dict[str, Any]]:
    """Advance open requests from authoritative records; never launch or replay accepted work."""
    moment = _now(moment)
    stamp = mailbox.stamp(moment)
    outcomes = []
    with _store(base) as requests:
        for key in [
            key
            for key, entry in requests.items()
            if entry["status"] in TERMINAL_STATES
            and (updated := _parse(entry.get("updated_at"))) is not None
            and moment - updated > RETAIN_TERMINAL
        ]:
            del requests[key]
        for entry in requests.values():
            status = entry["status"]
            if status in TERMINAL_STATES or status == "recovery_needed":
                continue
            if status in {"requested", "paused"}:
                stop = _room_stop(base, entry)
                if stop and stop[0] != status:
                    entry.update(status=stop[0], stop_reason=stop[1], updated_at=stamp)
                    outcomes.append({"key": entry["key"], "status": stop[0], "reason": stop[1]})
                elif not stop and status == "paused":
                    # A cleared pause allows the request again; it never launches by itself.
                    entry.update(status="requested", stop_reason=None, next_attempt_at=stamp, updated_at=stamp)
                    outcomes.append({"key": entry["key"], "status": "requested"})
                continue
            if not entry.get("task_dir"):
                stop = _room_stop(base, entry)
                if stop:
                    if stop[0] != status:
                        entry.update(status=stop[0], stop_reason=stop[1], updated_at=stamp)
                        outcomes.append({"key": entry["key"], "status": stop[0], "reason": stop[1]})
                    continue
            progress = _run_state(base, entry)
            if progress is None:
                reserved = _parse(entry.get("reserved_at"))
                if status == "reserved" and reserved and moment - reserved > RESERVATION_TTL:
                    entry.update(
                        status="recovery_needed",
                        stop_reason="reserved without an observed run; resolve the launch outcome before retrying",
                        updated_at=stamp,
                    )
                    outcomes.append({"key": entry["key"], "status": "recovery_needed"})
                continue
            new_status, reason = progress
            if new_status != status:
                entry.update(status=new_status, updated_at=stamp)
                if reason:
                    entry["stop_reason"] = reason
                outcomes.append({"key": entry["key"], "status": new_status})
    return outcomes


def _live_peer(base: Path, session: str | None) -> dict[str, Any] | None:
    if not isinstance(session, str) or not session:
        return None
    peer = mailbox.load(mailbox.peer_path(base, session))
    if mailbox.valid_peer(peer) and not mailbox.is_run_peer(peer) and mailbox.is_live(peer):
        return peer
    return None


def _owner_peer(base: Path, entry: dict[str, Any]) -> dict[str, Any] | None:
    room = room_store.read_room(base, entry["room"]) if entry.get("room") else None
    auth = _team_authority(base, room)
    if isinstance(auth, dict) and auth.get("status") == "active":
        lead_session = (auth.get("lead") or {}).get("session")
        if isinstance(lead_session, str) and lead_session:
            return _live_peer(base, lead_session)
    sessions: list[str] = []
    if isinstance(room, dict):
        sessions.extend(_active_room_owners(room) or mailbox.room_owner_sessions(room, room.get("conductor") or {}))
    if isinstance(entry.get("owner"), dict) and isinstance(entry["owner"].get("session"), str):
        sessions.append(entry["owner"]["session"])
    for session in dict.fromkeys(sessions):
        if peer := _live_peer(base, session):
            return peer
    return None


def notice_text(entry: dict[str, Any]) -> str:
    target = f"room {entry['room']}" if entry.get("room") else "your task"
    task = f", task {entry['task_dir']}" if entry.get("task_dir") else ""
    return (
        f"[orkest-continuation] Authorized work in {target}{task} is waiting for your turn "
        f"({', '.join(entry['reasons'])}). Reserve it once with "
        f"`continuation_requests.py reserve --key {entry['key']} --session <your session>`, then run the "
        "existing next action (`ork next step` or `ork rooms dispatch`). Do not launch a replacement for an "
        "uncertain reservation."
    )


def deliver_due(
    base: Path,
    *,
    moment: dt.datetime | None = None,
    notify: Callable[..., dict[str, Any]] | None = None,
    wake: Callable[..., dict[str, Any]] | None = None,
    hosts: frozenset[str] | None = None,
) -> list[dict[str, Any]]:
    """Send one hint per due request through the mailbox; the existing wake path asks the host to act."""
    from handoff_rest import resting

    moment = _now(moment)
    stamp = mailbox.stamp(moment)
    hosts = qualified_hosts() if hosts is None else hosts
    notify = notify or mailbox.notify
    wake = wake or mailbox.delivery_wake
    outcomes = []
    sends: list[tuple[str, dict[str, Any], str]] = []
    with _store(base) as requests:
        for entry in requests.values():
            if entry["status"] != "requested":
                continue
            due = _parse(entry.get("next_attempt_at"))
            if due and moment < due:
                continue
            stop = _room_stop(base, entry)
            if stop:
                entry.update(status=stop[0], stop_reason=stop[1], updated_at=stamp)
                outcomes.append({"key": entry["key"], "status": stop[0], "reason": stop[1]})
                continue
            peer = _owner_peer(base, entry)
            if peer is None:
                entry.update(availability="no live owner", updated_at=stamp)
                continue
            if resting(base, peer["session"]):
                continue
            harness = "agy" if peer.get("harness") == "gemini" else peer.get("harness")
            if harness not in hosts:
                manual = (
                    f"ork rooms show --room {entry['room']}"
                    if entry.get("room")
                    else f"ork next step --task-dir {entry['task_dir']}"
                )
                if entry.get("availability") != "unavailable":
                    entry.update(
                        availability="unavailable",
                        manual_resume=manual,
                        stop_reason=f"continuation is not enabled for {harness}; resume manually",
                        updated_at=stamp,
                    )
                    outcomes.append({"key": entry["key"], "status": "requested", "availability": "unavailable"})
                continue
            message_id = (entry.get("delivery") or {}).get("message_id")
            if message_id and mailbox.load(mailbox.inbox_dir(base, peer["session"]) / f"{message_id}.json"):
                unread = any(message["id"] == message_id for message in mailbox.incoming(base, peer["session"]))
                if unread:
                    continue  # wake_recovery retries the wake for unread mail; no second hint.
            if entry["deliveries"] >= MAX_DELIVERIES:
                entry.update(
                    status="exhausted",
                    stop_reason=f"the owner read {MAX_DELIVERIES} hints without reserving",
                    updated_at=stamp,
                )
                outcomes.append({"key": entry["key"], "status": "exhausted"})
                continue
            # Claimed and counted before the send, so a crash mid-send cannot repeat it without bound.
            deliveries = entry["deliveries"] + 1
            entry.update(
                deliveries=deliveries,
                availability="enabled",
                last_attempt_at=stamp,
                next_attempt_at=mailbox.stamp(
                    moment + dt.timedelta(seconds=BACKOFF[min(deliveries, len(BACKOFF) - 1)])
                ),
                updated_at=stamp,
            )
            sends.append((entry["key"], peer, notice_text(entry)))
    # The notice and its wake are external effects: they run outside the store lock.
    for key, peer, text in sends:
        message = notify(base, peer, text, continuation=key)
        result = wake(base, peer, message["id"], "cross-project")
        with _store(base) as requests:
            if key in requests:
                requests[key]["delivery"] = {
                    "message_id": message["id"],
                    "session": peer["session"],
                    "wake": result.get("status"),
                }
        outcomes.append({"key": key, "status": "delivered", "wake": result.get("status")})
    return outcomes


def pass_once(base: Path, *, moment: dt.datetime | None = None) -> list[dict[str, Any]]:
    """One reconciliation and delivery pass, for the daemon's reconciler loop."""
    if not store_path(base).exists():
        return []
    return [*reconcile(base, moment=moment), *deliver_due(base, moment=moment)]


def for_room(base: Path, room: str) -> list[dict[str, Any]]:
    return [
        {**entry, "label": LABELS.get(entry["status"], entry["status"])}
        for entry in load_all(base).values()
        if entry.get("room") == room
    ]


def _room_for_task(base: Path, task_dir: str) -> tuple[dict[str, Any], str] | None:
    inactive_match: tuple[dict[str, Any], str] | None = None
    with contextlib.suppress(OSError, ValueError):
        for room in room_store.list_rooms(base):
            for member in room.get("agents") or []:
                if isinstance(member, dict) and (member.get("dispatch") or {}).get("taskDir") == task_dir:
                    match = (room, member["id"])
                    if room_store.is_active_room(room):
                        return match
                    if inactive_match is None:
                        inactive_match = match
    return inactive_match


def request_for_terminal(base: Path, directory: Path, state: dict[str, Any], run: dict[str, Any]) -> dict | None:
    """A worker became terminal: ask its room's coordinator for a turn to review it."""
    task_dir = str(directory)
    found = _room_for_task(base, task_dir)
    # Only a room names the coordinator that owns the turn; archived rooms take no new continuation.
    if not found or not room_store.is_active_room(found[0]):
        return None
    room_dict, member = found[0], found[1]
    generation = run.get("generation")
    if generation is None:
        auth = _team_authority(base, room_dict)
        if isinstance(auth, dict):
            generation = auth.get("generation")
    created, _ = request(
        base,
        room=room_dict.get("id"),
        member=member,
        task_dir=task_dir,
        task_id=state.get("task_id"),
        generation=generation,
        run_id=run.get("run_id"),
        revision=input_revision(state.get("task_spec")),
        reason="worker_terminal",
        deadline=state.get("deadline"),
    )
    return created


def request_at_stop(base: Path, me: dict[str, Any], room: dict[str, Any]) -> list[dict[str, Any]]:
    """The coordinator's turn stopped with authorized work left in its active room."""
    from handoff_rest import resting

    if (
        not room_store.is_active_room(room)
        or (room.get("conductor") or {}).get("paused")
        or resting(base, me["session"])
    ):
        return []
    owner = {"session": me.get("session"), "harness": me.get("harness")}
    auth = _team_authority(base, room)
    team_generation = auth.get("generation") if isinstance(auth, dict) else None
    created = []
    queued = _queued_members(room)
    if queued:
        entry, _ = request(
            base,
            room=room["id"],
            generation=team_generation,
            revision=input_revision(queued),
            reason="stop",
            owner=owner,
        )
        if entry:
            created.append(entry)
    for member in room.get("agents") or []:
        dispatch = member.get("dispatch") if isinstance(member, dict) else None
        if not isinstance(dispatch, dict) or not isinstance(dispatch.get("taskDir"), str):
            continue
        task = mailbox.load(Path(dispatch["taskDir"]) / "task.json")
        if not isinstance(task, dict) or task.get("status") != "active":
            continue
        runs = [run for run in task.get("runs") or [] if isinstance(run, dict)]
        decided = {decision.get("run_id") for decision in task.get("decisions") or []}
        if runs and runs[-1].get("status") == "finished" and runs[-1].get("run_id") not in decided:
            latest_run = runs[-1]
            generation = latest_run.get("generation")
            if generation is None:
                generation = team_generation
            entry, _ = request(
                base,
                room=room["id"],
                member=member["id"],
                task_dir=dispatch["taskDir"],
                task_id=task.get("task_id"),
                generation=generation,
                run_id=latest_run.get("run_id"),
                revision=input_revision(task.get("task_spec")),
                reason="stop",
                owner=owner,
                deadline=task.get("deadline"),
            )
            if entry:
                created.append(entry)
    return created


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="show requests (read-only)")
    listing.add_argument("--room")
    reserve_cmd = commands.add_parser("reserve", help="reserve one request for this host")
    reserve_cmd.add_argument("--key", required=True)
    reserve_cmd.add_argument("--session", required=True)
    bind_cmd = commands.add_parser("bind", help="record the dispatch request ID a reservation used")
    bind_cmd.add_argument("--key", required=True)
    bind_cmd.add_argument("--session", required=True)
    bind_cmd.add_argument("--request-id", required=True)
    cancel_cmd = commands.add_parser("cancel", help="stop one request without launching anything")
    cancel_cmd.add_argument("--key", required=True)
    cancel_cmd.add_argument("--reason", required=True)
    commands.add_parser("reconcile", help="advance requests from task and room records")
    args = parser.parse_args(argv)
    base = mailbox.root()
    try:
        if args.command == "list":
            requests = for_room(base, args.room) if args.room else list(load_all(base).values())
            result: Any = {"schema": SCHEMA, "requests": requests}
        elif args.command == "reserve":
            result = reserve(base, args.key, args.session)
        elif args.command == "bind":
            result = bind(base, args.key, args.session, args.request_id)
        elif args.command == "cancel":
            result = cancel(base, args.key, args.reason)
        else:
            result = reconcile(base)
    except (ValueError, OSError, mailbox.MailboxError) as error:
        print(f"continuation: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
