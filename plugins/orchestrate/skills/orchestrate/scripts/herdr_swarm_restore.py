#!/usr/bin/env python3
"""Restore previously open swarm displays into verified Herdr panes, without splitting."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
import time
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

import room_store
import runtime_paths
from herdr_context import canonical_endpoint, endpoint

SCHEMA = "orkest.herdr-view.v1"
VALID_LABEL_PREFIXES = ("Orkest swarm ", "Orkest Swarm", "Swarm · ")


def swarm_pane_label(base: Path, room: str) -> str:
    room_data = room_store.read_room(base / "mailbox-v1", room) or {}
    conductor = room_data.get("conductor") if isinstance(room_data.get("conductor"), dict) else {}
    progress = conductor.get("progress") if isinstance(conductor.get("progress"), dict) else {}
    candidates = (room_data.get("title"), progress.get("goal"), room_data.get("objective"))
    raw = next(
        (
            value.strip()
            for value in candidates
            if isinstance(value, str) and value.strip() and value.strip() not in {"New swarm", "not set", room}
        ),
        "",
    )
    cleaned = " ".join(raw.split())[:72].rstrip()
    return f"Swarm · {cleaned}" if cleaned else "Orkest Swarm"


def state_directory(base: Path, env: dict[str, str]) -> Path:
    server = hashlib.sha256(endpoint(env).encode()).hexdigest()[:24]
    return base / "herdr-views-v1" / server


def state_path(base: Path, room: str, env: dict[str, str]) -> Path:
    return state_directory(base, env) / (hashlib.sha256(room.encode()).hexdigest() + ".json")


@contextlib.contextmanager
def operation_lock(base: Path, env: dict[str, str]):
    directory = state_directory(base, env)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / ".operation.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def load(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def save(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data) + "\n")
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class Herdr:
    def __init__(self, binary: str, env: dict[str, str]):
        self.binary, self.env = binary, env

    def call(self, *args: str) -> dict[str, Any]:
        result = subprocess.run(
            [self.binary, *args], env=self.env, capture_output=True, text=True, timeout=15, check=False
        )
        if result.returncode:
            raise RuntimeError(f"Herdr {' '.join(args[:2])} failed: {result.stderr.strip()[:500]}")
        if not result.stdout.strip():
            return {}
        data = json.loads(result.stdout)
        if data.get("error"):
            raise RuntimeError(str(data["error"]))
        return data.get("result", data)

    def panes(self) -> list[dict[str, Any]]:
        snapshot = self.call("api", "snapshot")
        snapshot = snapshot.get("snapshot", snapshot)
        panes = snapshot.get("panes")
        if not isinstance(panes, list):
            raise RuntimeError("Herdr snapshot did not contain panes")
        return [pane for pane in panes if isinstance(pane, dict) and isinstance(pane.get("pane_id"), str)]

    def processes(self, pane: str) -> dict[str, Any]:
        result = self.call("pane", "process-info", "--pane", pane)
        return result.get("process_info", result)


def view_process(info: dict[str, Any], cli: Path, room: str) -> bool:
    for process in info.get("foreground_processes") or []:
        argv = process.get("argv") or []
        if not isinstance(argv, list) or len(argv) < 6:
            continue
        # Require the actual executable script and exact view arguments, not a shell command substring.
        if Path(str(argv[1])).resolve() != cli.resolve():
            continue
        if argv[2:] == ["horde", "--attach-room", room, "--view"]:
            return True
    return False


def _process_shell_name(process: dict[str, Any]) -> str:
    raw = str(process.get("name") or "").strip()
    if not raw:
        argv = process.get("argv")
        if isinstance(argv, list) and argv:
            raw = str(argv[0] or "").strip()
    if not raw:
        return ""
    token = raw.split()[0]
    return Path(token).name.lstrip("-")


def idle_shell(info: dict[str, Any]) -> bool:
    # Shell names recognized as interactive login/command shells on POSIX/macOS.
    shells = {"sh", "bash", "dash", "ksh", "zsh", "fish", "csh", "tcsh", "nu", "pwsh"}
    shell = info.get("shell_pid")
    processes = info.get("foreground_processes") or []
    return bool(
        isinstance(shell, int)
        and shell > 0
        and processes
        and all(
            isinstance(process, dict) and process.get("pid") == shell and _process_shell_name(process) in shells
            for process in processes
        )
        and info.get("foreground_process_group_id") == shell
    )


def prepare(base: Path, room: str, pane: str, cli: Path, env: dict[str, str], api: Herdr) -> Path:
    path = state_path(base, room, env)
    label = swarm_pane_label(base, room)
    renamed = api.call("pane", "rename", pane, label)
    renamed_pane = renamed.get("pane") if isinstance(renamed, dict) else None
    terminal_id = (
        renamed_pane.get("terminal_id")
        if isinstance(renamed_pane, dict) and renamed_pane.get("pane_id") == pane
        else None
    )
    if not isinstance(terminal_id, str) or not terminal_id:
        owned = next((item for item in api.panes() if item.get("pane_id") == pane), None)
        terminal_id = owned.get("terminal_id") if isinstance(owned, dict) else None
    if not isinstance(terminal_id, str) or not terminal_id:
        raise RuntimeError("Herdr did not confirm the new view terminal identity")
    save(
        path,
        {
            "schema": SCHEMA,
            "room": room,
            "pane": pane,
            "terminal_id": terminal_id,
            "label": label,
            "endpoint": endpoint(env),
            "host": socket.gethostname(),
            "cli": str(cli.resolve()),
        },
    )
    path.with_suffix(".closed").unlink(missing_ok=True)
    path.with_suffix(".pending").unlink(missing_ok=True)
    return path


def command(cli: Path, room: str, state: Path, base: Path, env: dict[str, str]) -> str:
    return shlex.join(
        [
            "exec",
            "env",
            f"ORKEST_HERDR_VIEW_STATE={state}",
            f"ORCHESTRATE_HOME={base}",
            shutil.which("node", path=env.get("PATH")) or "node",
            str(cli),
            "horde",
            "--attach-room",
            room,
            "--view",
        ]
    )


def locate(
    record: dict[str, Any], panes: list[dict[str, Any]], *, allow_recreated: bool = False
) -> dict[str, Any] | None:
    label = record.get("label")
    if not isinstance(label, str) or not label.startswith(VALID_LABEL_PREFIXES):
        return None
    normalized = label.strip()
    matches = [pane for pane in panes if isinstance(pane.get("label"), str) and pane["label"].strip() == normalized]
    terminal_id = record.get("terminal_id")
    if isinstance(terminal_id, str) and terminal_id:
        by_terminal = [pane for pane in matches if pane.get("terminal_id") == terminal_id]
        if len(by_terminal) == 1:
            return by_terminal[0]
        if not allow_recreated:
            return None
    if len(matches) == 1 and (allow_recreated or matches[0]["pane_id"] == record.get("pane")):
        return matches[0]
    return None


def restore(
    base: Path,
    env: dict[str, str],
    api: Herdr,
    *,
    locked: bool = False,
    only_room: str | None = None,
    allow_recreated: bool = False,
) -> list[dict[str, str]]:
    directory = state_directory(base, env)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    outcomes = []
    with contextlib.nullcontext() if locked else operation_lock(base, env):
        panes = api.panes()
        records = [(path, load(path)) for path in sorted(directory.glob("*.json"))]
        open_labels = Counter(
            str(record.get("label", "")).strip()
            for path, record in records
            if record and not path.with_suffix(".closed").exists()
        )
        for path, record in records:
            if not record or record.get("schema") != SCHEMA:
                continue
            if (
                canonical_endpoint(record.get("endpoint")) != endpoint(env)
                or record.get("host") != socket.gethostname()
            ):
                continue
            if not isinstance(record.get("cli"), str) or not isinstance(record.get("room"), str):
                continue
            if only_room is not None and record["room"] != only_room:
                continue
            if path.with_suffix(".closed").exists():
                continue
            room = record.get("room")
            unique_label = open_labels[str(record.get("label", "")).strip()] == 1
            pane = locate(record, panes, allow_recreated=allow_recreated and unique_label)
            if not record.get("terminal_id") and not unique_label:
                pane = None
            status = "missing_pane"
            if pane and not pane.get("restore_error") and isinstance(room, str):
                try:
                    info = api.processes(pane["pane_id"])
                except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                    outcomes.append({"room": room, "status": "inspection_failed"})
                    continue
                cli = Path(record["cli"])
                if view_process(info, cli, room) or idle_shell(info):
                    terminal_id = pane.get("terminal_id")
                    if terminal_id and (
                        terminal_id != record.get("terminal_id") or pane["pane_id"] != record.get("pane")
                    ):
                        record = {
                            **record,
                            "terminal_id": terminal_id,
                            "pane": pane["pane_id"],
                            "endpoint": endpoint(env),
                        }
                        save(path, record)
                if view_process(info, cli, room):
                    path.with_suffix(".pending").unlink(missing_ok=True)
                    status = "already_running"
                elif idle_shell(info) and cli.is_file():
                    # Recheck the close tombstone immediately before admitting a command.
                    if path.with_suffix(".closed").exists():
                        continue
                    pending_path = path.with_suffix(".pending")
                    pending = load(pending_path) or {}
                    if pending.get("shell_pid") == info["shell_pid"]:
                        outcomes.append({"room": room, "status": "launch_pending"})
                        continue
                    save(pending_path, {"shell_pid": info["shell_pid"]})
                    try:
                        api.call("pane", "run", pane["pane_id"], command(cli, room, path, base, env))
                    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                        outcomes.append({"room": room, "status": "launch_unknown"})
                        continue
                    status = "submitted"
                    # Input admission is not proof that the command started. Keep the pending
                    # marker on timeout, so another startup hook cannot queue the same command.
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        try:
                            current = api.processes(pane["pane_id"])
                        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                            status = "launch_unknown"
                            break
                        if view_process(current, cli, room):
                            pending_path.unlink(missing_ok=True)
                            status = "restored"
                            break
                        time.sleep(0.1)
                else:
                    status = "busy_or_unknown"
            # Never recreate an absent pane: its owner may have deliberately closed it in Herdr.
            outcomes.append({"room": str(room), "status": status})
    return outcomes


def adopt(base: Path, env: dict[str, str], api: Herdr, cli: Path) -> list[dict[str, str]]:
    with operation_lock(base, env):
        return _adopt_unlocked(base, env, api, cli)


def _adopt_unlocked(base: Path, env: dict[str, str], api: Herdr, cli: Path) -> list[dict[str, str]]:
    outcomes = []
    panes = {pane["pane_id"]: pane for pane in api.panes()}
    for room in room_store.list_rooms(base / "mailbox-v1"):
        room_id, pane_id = room.get("id"), room.get("herdrViewPaneId")
        if not isinstance(room_id, str) or pane_id not in panes:
            continue
        if room.get("herdrEndpoint") is not None and canonical_endpoint(room.get("herdrEndpoint")) != endpoint(env):
            continue
        state = state_path(base, room_id, env)
        if state.exists():
            continue
        if view_process(api.processes(pane_id), cli, room_id):
            prepare(base, room_id, pane_id, cli, env, api)
            outcomes.append({"room": room_id, "status": "adopted"})
    return outcomes


def _project_member_task(room: dict[str, Any], member: dict[str, Any]) -> tuple[str, str]:
    """Return (executing_worker, accepted_task) for a room member or peer."""
    dispatch = member.get("dispatch")
    if isinstance(dispatch, dict) and all(
        isinstance(dispatch.get(key), str) and dispatch[key] for key in ("taskDir", "taskId", "requestId")
    ):
        try:
            import room_tasks

            task_path = Path(dispatch["taskDir"]) / "task.json"
            task_data = load(task_path)
            if isinstance(task_data, dict):
                proj = room_tasks.project(str(room.get("cwd") or ""), member, task_data)
                verdict = str(proj.get("verdict") or "pending")
                run_status = str(proj.get("run", {}).get("status") or "")
                exec_dim = {
                    "active": "executing",
                    "reserved": "executing",
                    "finished": "finished",
                    "cancelled": "finished",
                }.get(run_status, "unknown")
                if verdict == "takeover":
                    exec_dim = "blocked"
                task_dim = {
                    "accept": "accepted",
                    "supported": "supported",
                    "reject": "unaccepted",
                    "takeover": "in_progress",
                }.get(verdict, "awaiting_verification" if run_status == "finished" else "in_progress")
                return exec_dim, task_dim
        except Exception:
            return "unknown", "untracked"
    status = str(member.get("status") or member.get("stage") or "").strip().lower()
    if status in {"completed", "complete", "reported complete", "stale"}:
        return "finished", "awaiting_verification"
    if status == "accepted":
        return "finished", "accepted"
    if status == "supported":
        return "finished", "supported"
    if status in {"cancelled", "canceled", "rejected", "failed"}:
        return "finished", "unaccepted"
    if status == "blocked":
        return "blocked", "in_progress"
    if status in {"running", "working", "starting", "planning", "testing", "busy"}:
        return "executing", "in_progress"
    if status in {"review"}:
        return "finished", "awaiting_verification"
    if status in {"idle", "ready", "waiting"}:
        return "idle", "untracked"
    return "none", "untracked"


def inventory(
    base: Path,
    env: dict[str, str],
    api: Herdr,
    *,
    cli: Path | None = None,
    only_room: str | None = None,
) -> dict[str, Any]:
    """Read-only reconciliation of Orkest rooms, views, and peers against passive Herdr inventory."""
    current_endpoint = endpoint(env)
    cli_path = (cli or (Path(__file__).resolve().parents[3] / "bin" / "ork.mjs")).resolve()
    panes = api.panes()
    panes_by_id = {pane["pane_id"]: pane for pane in panes if isinstance(pane.get("pane_id"), str)}
    process_cache: dict[str, dict[str, Any] | None] = {}

    def get_processes(pane_id: str) -> dict[str, Any] | None:
        if pane_id not in process_cache:
            try:
                process_cache[pane_id] = api.processes(pane_id)
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                process_cache[pane_id] = None
        return process_cache[pane_id]

    def shell_dimension(pane: dict[str, Any] | None, room_id: str | None = None) -> tuple[str, bool]:
        if not pane or pane.get("restore_error"):
            return "unavailable", False
        info = get_processes(pane["pane_id"])
        if not isinstance(info, dict):
            return "unavailable", False
        if room_id and view_process(info, cli_path, room_id):
            return "orkest_view", False
        if idle_shell(info):
            return "idle_shell", True
        return "busy_process", False

    mailbox_dir = base / "mailbox-v1"
    peers_by_session: dict[str, dict[str, Any]] = {}
    peers_dir = mailbox_dir / "peers"
    if peers_dir.is_dir():
        for peer_file in sorted(peers_dir.glob("*.json")):
            peer_doc = load(peer_file)
            if isinstance(peer_doc, dict) and isinstance(peer_doc.get("session"), str):
                peers_by_session[peer_doc["session"]] = peer_doc

    directory = state_directory(base, env)
    view_records: dict[str, tuple[Path, dict[str, Any]]] = {}
    if directory.is_dir():
        for rec_path in sorted(directory.glob("*.json")):
            rec = load(rec_path)
            if (
                isinstance(rec, dict)
                and rec.get("schema") == SCHEMA
                and canonical_endpoint(rec.get("endpoint")) == current_endpoint
                and rec.get("host") == socket.gethostname()
                and isinstance(rec.get("room"), str)
            ):
                view_records[rec["room"]] = (rec_path, rec)

    open_labels = Counter(
        str(rec.get("label", "")).strip()
        for rec_path, rec in view_records.values()
        if not rec_path.with_suffix(".closed").exists()
    )

    resources: list[dict[str, Any]] = []
    seen_peer_sessions: set[str] = set()
    rooms = room_store.list_rooms(mailbox_dir)
    rooms_by_id = {room["id"]: room for room in rooms if isinstance(room, dict) and isinstance(room.get("id"), str)}
    all_room_ids = sorted(set(rooms_by_id) | set(view_records))

    for room_id in all_room_ids:
        if only_room is not None and room_id != only_room:
            continue
        room = rooms_by_id.get(room_id) or {"id": room_id}
        room_endpoint = room.get("herdrEndpoint")
        rec_entry = view_records.get(room_id)

        # 1. Swarm View resource for this room (if recorded in herdr-views-v1 or room metadata)
        if rec_entry or room.get("herdrViewPaneId"):
            rec_path, rec = rec_entry if rec_entry else (None, None)
            closed_tombstone = bool(rec_path and rec_path.with_suffix(".closed").exists())
            recorded_pane_id = (rec.get("pane") if rec else None) or room.get("herdrViewPaneId")
            recorded_terminal_id = rec.get("terminal_id") if rec else None
            if room_endpoint and canonical_endpoint(room_endpoint) != current_endpoint and not rec:
                pane_existence = "unreachable_endpoint"
                matched_pane = None
                matching_strength = "none"
            elif rec:
                exact_pane = locate(rec, panes, allow_recreated=False)
                unique_label = open_labels[str(rec.get("label", "")).strip()] == 1
                candidate_pane = exact_pane if exact_pane else locate(rec, panes, allow_recreated=unique_label)
                matched_pane = exact_pane or candidate_pane
                if matched_pane is None:
                    pane_existence = "missing"
                    matching_strength = "none"
                else:
                    if recorded_terminal_id and matched_pane.get("terminal_id") == recorded_terminal_id:
                        matching_strength = "terminal_id"
                    elif matched_pane.get("pane_id") == recorded_pane_id:
                        matching_strength = "pane_id"
                    else:
                        matching_strength = "label_candidate"
                    if matched_pane.get("restore_error"):
                        pane_existence = "restore_error"
                    elif matched_pane.get("pane_id") != recorded_pane_id:
                        pane_existence = "moved"
                    else:
                        pane_existence = "present"
            else:
                matched_pane = panes_by_id.get(str(recorded_pane_id)) if recorded_pane_id else None
                matching_strength = "pane_id" if matched_pane else "none"
                if matched_pane is None:
                    pane_existence = "missing"
                elif matched_pane.get("restore_error"):
                    pane_existence = "restore_error"
                else:
                    pane_existence = "present"

            avail_shell, retained_idle = shell_dimension(matched_pane, room_id)
            resources.append(
                {
                    "kind": "swarm_view",
                    "room": room_id,
                    "recorded_pane_id": recorded_pane_id,
                    "current_pane_id": matched_pane.get("pane_id") if matched_pane else None,
                    "terminal_id": (matched_pane.get("terminal_id") if matched_pane else None) or recorded_terminal_id,
                    "closed": closed_tombstone,
                    "matching_strength": matching_strength,
                    "retained_idle_shell": retained_idle,
                    "dimensions": {
                        "pane_existence": pane_existence,
                        "available_shell": avail_shell,
                        "live_agent_conversation": "none",
                        "executing_worker": "executing" if avail_shell == "orkest_view" else "none",
                        "accepted_task": "untracked",
                    },
                }
            )

        # 2. Room members (conductor + agents)
        members: list[tuple[str, dict[str, Any]]] = []
        if isinstance(room.get("conductor"), dict):
            members.append(("conductor", room["conductor"]))
        for agent in room.get("agents") or []:
            if isinstance(agent, dict) and isinstance(agent.get("id"), str):
                members.append((agent["id"], agent))

        for member_id, member in members:
            session_obj = member.get("session") if isinstance(member.get("session"), dict) else {}
            session_id = (
                session_obj.get("id")
                or member.get("nativeHandle")
                or member.get("mailboxSession")
                or (member.get("id") if member_id != "conductor" else None)
            )
            peer = peers_by_session.get(session_id) if isinstance(session_id, str) else None
            if isinstance(session_id, str):
                seen_peer_sessions.add(session_id)
            member_pane_id = (
                (peer.get("herdrPaneId") if isinstance(peer, dict) else None)
                or member.get("herdrPaneId")
                or (room.get("herdrCoordinatorPaneId") if member_id == "conductor" else None)
            )
            member_endpoint = (
                (peer.get("herdrEndpoint") if isinstance(peer, dict) else None)
                or member.get("herdrEndpoint")
                or room_endpoint
            )
            matched_pane = None
            matching_strength = "none"
            if not member_pane_id:
                pane_existence = "not_bound"
            elif member_endpoint and canonical_endpoint(member_endpoint) != current_endpoint:
                pane_existence = "unreachable_endpoint"
            else:
                matched_pane = panes_by_id.get(member_pane_id)
                if matched_pane is None:
                    # Check if a pane in snapshot has the expected agent_session
                    for candidate in panes:
                        ref = candidate.get("agent_session")
                        if isinstance(ref, dict) and ref.get("kind") == "id" and ref.get("value") == session_id:
                            matched_pane = candidate
                            break
                    if matched_pane is not None:
                        pane_existence = "moved"
                        matching_strength = "terminal_id" if matched_pane.get("terminal_id") else "pane_id"
                    else:
                        pane_existence = "missing"
                else:
                    matching_strength = "terminal_id" if matched_pane.get("terminal_id") else "pane_id"
                    pane_existence = "restore_error" if matched_pane.get("restore_error") else "present"

            avail_shell, retained_idle = shell_dimension(matched_pane)
            ref = matched_pane.get("agent_session") if isinstance(matched_pane, dict) else None
            if isinstance(ref, dict) and ref.get("kind") == "id" and isinstance(ref.get("value"), str):
                live_conv = "verified_in_pane" if session_id and ref["value"] == session_id else "different_occupant"
            elif isinstance(peer, dict) and not peer.get("endedAt"):
                live_conv = "peer_alive_unbound"
            else:
                live_conv = "none"

            exec_worker, accepted_task = _project_member_task(room, member)
            if exec_worker == "none" and isinstance(peer, dict):
                peer_state = str(peer.get("state") or "").lower()
                if peer_state == "busy":
                    exec_worker = "executing"
                elif peer_state == "idle":
                    exec_worker = "idle"

            resources.append(
                {
                    "kind": "room_member",
                    "room": room_id,
                    "member": member_id,
                    "session": session_id,
                    "recorded_pane_id": member_pane_id,
                    "current_pane_id": matched_pane.get("pane_id") if matched_pane else None,
                    "terminal_id": matched_pane.get("terminal_id") if matched_pane else None,
                    "matching_strength": matching_strength,
                    "retained_idle_shell": retained_idle,
                    "dimensions": {
                        "pane_existence": pane_existence,
                        "available_shell": avail_shell,
                        "live_agent_conversation": live_conv,
                        "executing_worker": exec_worker,
                        "accepted_task": accepted_task,
                    },
                }
            )

    # 3. Standalone Herdr-bound peers not already covered by room members
    if only_room is None:
        for session_id, peer in sorted(peers_by_session.items()):
            if session_id in seen_peer_sessions:
                continue
            if peer.get("isSubagent") or peer.get("delegatedRun"):
                continue
            peer_pane_id = peer.get("herdrPaneId")
            peer_endpoint = peer.get("herdrEndpoint")
            if not peer_pane_id:
                continue
            matched_pane = None
            matching_strength = "none"
            if peer_endpoint and canonical_endpoint(peer_endpoint) != current_endpoint:
                pane_existence = "unreachable_endpoint"
            else:
                matched_pane = panes_by_id.get(peer_pane_id)
                if matched_pane is None:
                    for candidate in panes:
                        ref = candidate.get("agent_session")
                        if isinstance(ref, dict) and ref.get("kind") == "id" and ref.get("value") == session_id:
                            matched_pane = candidate
                            break
                    if matched_pane is not None:
                        pane_existence = "moved"
                        matching_strength = "terminal_id" if matched_pane.get("terminal_id") else "pane_id"
                    else:
                        pane_existence = "missing"
                else:
                    matching_strength = "terminal_id" if matched_pane.get("terminal_id") else "pane_id"
                    pane_existence = "restore_error" if matched_pane.get("restore_error") else "present"

            avail_shell, retained_idle = shell_dimension(matched_pane)
            ref = matched_pane.get("agent_session") if isinstance(matched_pane, dict) else None
            if isinstance(ref, dict) and ref.get("kind") == "id" and isinstance(ref.get("value"), str):
                live_conv = "verified_in_pane" if ref["value"] == session_id else "different_occupant"
            elif not peer.get("endedAt"):
                live_conv = "peer_alive_unbound"
            else:
                live_conv = "none"
            peer_state = str(peer.get("state") or "").lower()
            exec_worker = "executing" if peer_state == "busy" else ("idle" if peer_state == "idle" else "none")
            resources.append(
                {
                    "kind": "peer",
                    "session": session_id,
                    "recorded_pane_id": peer_pane_id,
                    "current_pane_id": matched_pane.get("pane_id") if matched_pane else None,
                    "terminal_id": matched_pane.get("terminal_id") if matched_pane else None,
                    "matching_strength": matching_strength,
                    "retained_idle_shell": retained_idle,
                    "dimensions": {
                        "pane_existence": pane_existence,
                        "available_shell": avail_shell,
                        "live_agent_conversation": live_conv,
                        "executing_worker": exec_worker,
                        "accepted_task": "untracked",
                    },
                }
            )

    return {
        "status": "ok",
        "mode": "read_only",
        "endpoint": current_endpoint,
        "pane_count": len(panes),
        "resources": resources,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--view", action="store_true")
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--adopt", action="store_true")
    parser.add_argument("--inventory", action="store_true")
    parser.add_argument("--room", help="optional room ID to scope --inventory")
    args = parser.parse_args()
    env = dict(os.environ)
    if env.get("HERDR_ENV") != "1":
        print(json.dumps({"status": "skipped", "reason": "not_inside_herdr"}))
        return 0
    binary = env.get("HERDR_BIN_PATH") or shutil.which("herdr")
    if not binary:
        print(json.dumps({"status": "skipped", "reason": "herdr_unavailable"}))
        return 0
    api = Herdr(binary, env)
    base = runtime_paths.cache_home()
    cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
    if args.inventory:
        print(json.dumps(inventory(base, env, api, cli=cli, only_room=args.room)))
        return 0
    if args.view:
        room = env.get("ORKEST_SWARM_ROOM")
        if not env.get("ORKEST_HERDR_VIEW_STATE"):
            try:
                context = json.loads(env.get("HERDR_PLUGIN_CONTEXT_JSON") or "{}")
            except ValueError:
                context = {}
            source_pane = context.get("focused_pane_id") if isinstance(context, dict) else None
            mailbox = base / "mailbox-v1"
            candidates = [
                row
                for row in room_store.list_rooms(mailbox)
                if source_pane
                and row.get("herdrCoordinatorPaneId") == source_pane
                and canonical_endpoint(row.get("herdrEndpoint")) == endpoint(env)
                and (not room or row["id"] == room)
            ]
            if len(candidates) != 1:
                print("Open the Swarm View from the room's coordinator with ork swarm open.", file=sys.stderr)
                return 2
            room = candidates[0]["id"]
            pane = (env.get("HERDR_PANE_ID") or "").strip()
            if not pane:
                print("Herdr did not supply HERDR_PANE_ID for the Swarm View plugin pane.", file=sys.stderr)
                return 2
            try:
                with operation_lock(base, env):
                    state = state_path(base, room, env)
                    current = load(state)
                    if current and locate(current, api.panes()):
                        print(f"Swarm View is already open for room {room}.", file=sys.stderr)
                        return 0
                    prepare(base, room, pane, cli, env, api)
                    room_store.set_metadata(mailbox, room, herdrViewPaneId=pane)
                    env["ORKEST_HERDR_VIEW_STATE"] = str(state)
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
                print(f"Could not initialize Swarm View in Herdr pane {pane}: {error}", file=sys.stderr)
                return 2
        if not room:
            return 2
        os.execvpe("node", ["node", str(cli), "horde", "--attach-room", room, "--view"], env)
    startup = env.get("HERDR_PLUGIN_ID") == "orkest.swarms" and env.get("HERDR_PLUGIN_EVENT") == "startup"
    outcomes = adopt(base, env, api, cli) if args.adopt else restore(base, env, api, allow_recreated=startup)
    print(json.dumps({"status": "ok", "views": outcomes}))
    return 0


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        raise SystemExit(main())
