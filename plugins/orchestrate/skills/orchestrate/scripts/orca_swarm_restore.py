#!/usr/bin/env python3
"""Open, close, toggle, or restore the Orkest Swarm View as a split beside an Orca IDE terminal."""

from __future__ import annotations

import argparse
import contextlib
import datetime
import json
import os
import shlex
import shutil
import socket as stdlib_socket
import subprocess
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import orca_context
import peer_mailbox as mailbox
import room_store

ORK = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
CHIEF_VIEW_KEY = "__chief__"


def view_command(
    room: str | None,
    state: Path,
    env: Mapping[str, str] | None = None,
    *,
    chief: bool = False,
) -> str:
    source = os.environ if env is None else env
    node = shutil.which("node", path=source.get("PATH")) or "node"
    env_vars = [f"ORKEST_ORCA_VIEW_STATE={state}"]
    if chief:
        env_vars.append("ORKEST_CHIEF_VIEW=1")
    room_id = room.strip() if isinstance(room, str) else ""
    args = ["exec", "env", *env_vars, node, str(ORK), "horde"]
    if room_id:
        args.extend(["--attach-room", room_id])
    args.append("--view")
    if chief:
        args.append("--chief")
    return shlex.join(args)


def _stamp() -> str:
    return datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _peer_stamp(peer: Mapping[str, Any]) -> str:
    for key in ("updatedAt", "lastSeenAt", "startedAt"):
        value = peer.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _peer_for_terminal(base: Path, terminal: str, environment: str | None = None) -> dict[str, Any] | None:
    env_name = os.environ.get("ORCA_ENVIRONMENT", "").strip() if environment is None else environment.strip()
    peers_dir = base / "peers"
    if not peers_dir.is_dir():
        return None
    matches = []
    for path in sorted(peers_dir.glob("*.json")):
        peer = mailbox.load(path)
        if (
            not isinstance(peer, dict)
            or not mailbox.valid_peer(peer)
            or mailbox.is_run_peer(peer)
            or not mailbox.is_live(peer)
            or peer.get("orcaTerminalHandle") != terminal
            or peer.get("isSubagent")
            or peer.get("delegatedRun")
            or str(peer.get("session") or "").startswith("run-")
        ):
            continue
        peer_env = str(peer.get("orcaEnvironment") or "").strip()
        if peer_env != env_name:
            continue
        matches.append(peer)
    if not matches:
        return None
    matches.sort(key=lambda peer: (_peer_stamp(peer), str(peer.get("session") or "")), reverse=True)
    return matches[0]


def _is_closed_room(row: Mapping[str, Any]) -> bool:
    if not room_store.is_active_room(row):
        return True
    if row.get("closedAt") or row.get("archivedAt") or row.get("cancelledAt"):
        return True
    status = str(row.get("status") or "").lower()
    return status in {"archived", "cancelled", "closed", "completed"}


def _room_for_terminal(base: Path, terminal: str, environment: str | None = None) -> str:
    env_name = os.environ.get("ORCA_ENVIRONMENT", "").strip() if environment is None else environment.strip()
    host = stdlib_socket.gethostname()
    with contextlib.suppress(OSError, ValueError):
        rooms = []
        for row in room_store.list_rooms(base):
            if not isinstance(row, dict) or _is_closed_room(row):
                continue
            if row.get("orcaCoordinatorTerminalId") != terminal and row.get("orcaViewTerminalId") != terminal:
                continue
            if row.get("machine") and row.get("machine") != host:
                continue
            room_env = str(row.get("orcaEnvironment") or "").strip()
            if room_env and room_env != env_name:
                continue
            if isinstance(row.get("id"), str):
                rooms.append(row)
        if not rooms:
            return ""
        rooms.sort(key=lambda row: (float(row.get("updatedAt") or 0), float(row.get("createdAt") or 0)), reverse=True)
        return rooms[0]["id"]
    return ""


def _resolve_room(
    base: Path,
    terminal: str,
    *,
    room: str | None,
    session_id: str | None,
    harness: str | None,
    cwd: str | None,
    environment: str | None = None,
) -> tuple[str, str | None, str | None, str | None]:
    import agent_statusline_tmux as statusline

    peer = None if session_id else _peer_for_terminal(base, terminal, environment=environment)
    if isinstance(peer, dict):
        session_id = peer["session"]
        harness = harness or peer.get("harness")
        cwd = cwd or peer.get("cwd")
    current = (room or os.environ.get("ORKEST_SWARM_ROOM", "")).strip()
    if not current and session_id:
        matched = statusline.find_session_swarm_room(base, session_id, harness=harness, cwd=cwd)
        if isinstance(matched, dict) and isinstance(matched.get("id"), str):
            current = matched["id"]
    if not current and not session_id:
        current = _room_for_terminal(base, terminal, environment=environment)
    return current, session_id, harness, cwd


def toggle(
    action: str = "toggle",
    *,
    base: Path,
    room: str | None = None,
    session_id: str | None = None,
    harness: str | None = None,
    cwd: str | None = None,
    respect_closed: bool = False,
    chief: bool = False,
    env: Mapping[str, str] | None = None,
    run: Callable[..., Any] = subprocess.run,
) -> dict[str, Any]:
    """Toggle the Swarm View split beside the current Orca terminal. `base` is the mailbox root."""
    environment = dict(os.environ if env is None else env)
    if action not in ("toggle", "open", "close"):
        raise ValueError(f"Unsupported swarm view action: {action}")
    context = orca_context.pane_context(environment)
    if not context:
        return {"status": "unavailable", "reason": "not inside an Orca terminal", "backend": "orca"}
    binary = orca_context.resolve_cli(environment)
    if not binary:
        return {
            "status": "unavailable",
            "reason": "Orca CLI not found; set ORCA_CLI_COMMAND (the Linux /usr/bin/orca screen reader is never used)",
            "backend": "orca",
        }
    cache = base.parent
    source = orca_context.current_terminal(environment, cache)
    if not source:
        return {"status": "error", "reason": "Orca did not provide ORCA_TERMINAL_HANDLE", "backend": "orca"}
    current, session_id, harness, cwd = _resolve_room(
        base,
        source,
        room=room,
        session_id=session_id,
        harness=harness,
        cwd=cwd,
        environment=context["environment"],
    )
    import agent_statusline_tmux as statusline

    is_chief = (
        bool(chief) or environment.get("ORKEST_CHIEF_VIEW") == "1" or statusline._is_chief_session(base, session_id)
    )
    if not current and not is_chief:
        if action == "close":
            return {"status": "already_closed", "backend": "orca"}
        resolved, error = statusline._ensure_bound_room(
            current_room=current,
            session_id=session_id,
            harness=harness,
            cwd=cwd,
            environment={**environment, "AGENT_EXECUTOR_HOME": str(cache)},
            base=base,
        )
        if not resolved:
            return {"status": "error", "reason": error or "could not create swarm room", "backend": "orca"}
        current = resolved
    api = orca_context.OrcaCli(binary, environment, run=run)
    state = orca_context.view_path(current or CHIEF_VIEW_KEY, cache)
    record = orca_context.load(state)
    if record and (record.get("schema") != orca_context.VIEW_SCHEMA or (record.get("room") or "") != current):
        return {"status": "error", "reason": "swarm view record does not match", "room": current, "backend": "orca"}
    try:
        live = api.terminals()
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
        return {"status": "error", "reason": "could not list Orca terminals", "room": current, "backend": "orca"}
    view = record.get("terminalId") if record else None
    is_open = bool(record and not record.get("closed") and view in live)
    if action == "close" or (action == "toggle" and is_open):
        if is_open and isinstance(view, str):
            try:
                api.close(view)
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                return {
                    "status": "error",
                    "reason": "could not close the swarm view",
                    "room": current,
                    "backend": "orca",
                }
        if record and not record.get("closed"):
            orca_context.save(state, {**record, "closed": True, "closedAt": _stamp()})
        if current:
            statusline._update_room_metadata(base, current, orcaViewTerminalId=None)
        return {
            "status": "closed" if is_open else "already_closed",
            "room": current,
            "backend": "orca",
            **({"chief": True} if is_chief else {}),
            **({"pane": view} if is_open and isinstance(view, str) else {}),
        }
    if is_open and isinstance(view, str):
        return {
            "status": "already_open",
            "room": current,
            "backend": "orca",
            "pane": view,
            **({"chief": True} if is_chief else {}),
        }
    if action == "open" and respect_closed and record and record.get("closed"):
        return {
            "status": "already_closed",
            "room": current,
            "backend": "orca",
            **({"chief": True} if is_chief else {}),
        }
    try:
        handle = api.split(source, view_command(current, state, environment, chief=is_chief))
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as failure:
        return {
            "status": "error",
            "reason": f"could not split the Orca pane: {failure}",
            "room": current,
            "backend": "orca",
        }
    title = orca_context.view_title(current) if current else f"{orca_context.VIEW_TITLE_PREFIX} · Chief"
    with contextlib.suppress(OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
        api.rename(handle, title)
    entry = orca_context.registry(cache).get(source) or {}
    workspace = entry.get("workspaceId") or context["worktreeId"] or None
    orca_context.save(
        state,
        {
            "schema": orca_context.VIEW_SCHEMA,
            "room": current,
            "workspaceId": workspace,
            "terminalId": handle,
            "sourceTerminalId": source,
            "title": title,
            "environment": context["environment"],
            "method": "cli-split",
            "chief": is_chief,
            "openedAt": _stamp(),
            "closed": False,
        },
    )
    if current:
        room_data = None
        with contextlib.suppress(OSError, ValueError):
            room_data = room_store.read_room(base, current)
        coordinator = room_data.get("orcaCoordinatorTerminalId") if isinstance(room_data, dict) else None
        statusline._update_room_metadata(
            base,
            current,
            orcaViewTerminalId=handle,
            **({"orcaCoordinatorTerminalId": source} if not coordinator else {}),
            **({"orcaWorkspaceId": workspace} if workspace and not coordinator else {}),
        )
    return {
        "status": "opened",
        "room": current,
        "backend": "orca",
        "pane": handle,
        **({"chief": True} if is_chief else {}),
    }


def restore(
    cache: Path, env: Mapping[str, str] | None = None, *, run: Callable[..., Any] = subprocess.run
) -> list[dict[str, Any]]:
    """Reopen recorded views whose terminal is gone, beside their recorded source terminal."""
    environment = dict(os.environ if env is None else env)
    binary = orca_context.resolve_cli(environment)
    if not binary:
        return [{"status": "orca_cli_unavailable"}]
    api = orca_context.OrcaCli(binary, environment, run=run)
    current_environment = (orca_context.pane_context(environment) or {}).get("environment", "")
    outcomes = []
    live: set[str] | None = None
    for path in sorted(orca_context.views_directory(cache).glob("*.json")):
        record = orca_context.load(path)
        if not record or record.get("schema") != orca_context.VIEW_SCHEMA or record.get("closed"):
            continue
        is_chief = bool(record.get("chief"))
        raw_room = record.get("room")
        room = raw_room.strip() if isinstance(raw_room, str) else ""
        if (not room and not is_chief) or (record.get("environment") or "") != current_environment:
            continue
        if live is None:
            try:
                live = api.terminals()
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                return [{"status": "inspection_failed"}]
        if record.get("terminalId") in live:
            outcomes.append({"room": room, "status": "already_present", **({"chief": True} if is_chief else {})})
            continue
        source = record.get("sourceTerminalId")
        if not isinstance(source, str) or source not in live:
            outcomes.append({"room": room, "status": "missing_source", **({"chief": True} if is_chief else {})})
            continue
        try:
            handle = api.split(source, view_command(room, path, environment, chief=is_chief))
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
            outcomes.append({"room": room, "status": "launch_unknown", **({"chief": True} if is_chief else {})})
            continue
        fallback_title = orca_context.view_title(room) if room else f"{orca_context.VIEW_TITLE_PREFIX} · Chief"
        with contextlib.suppress(OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
            api.rename(handle, record.get("title") or fallback_title)
        orca_context.save(path, {**record, "terminalId": handle, "restoredAt": _stamp()})
        outcomes.append({"room": room, "status": "restored", **({"chief": True} if is_chief else {})})
    return outcomes


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toggle-swarm", nargs="?", const="toggle", choices=("toggle", "open", "close"))
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--room")
    parser.add_argument("--session")
    parser.add_argument("--harness")
    parser.add_argument("--cwd")
    parser.add_argument("--chief", action="store_true")
    args = parser.parse_args(arguments)
    import runtime_paths

    cache = runtime_paths.cache_home()
    if args.restore:
        print(json.dumps({"status": "ok", "views": restore(cache)}))
        return 0
    outcome = toggle(
        args.toggle_swarm or "toggle",
        base=cache / "mailbox-v1",
        room=args.room,
        session_id=args.session,
        harness=args.harness,
        cwd=args.cwd,
        chief=args.chief,
    )
    print(json.dumps(outcome))
    return 0 if outcome["status"] in ("opened", "closed", "already_open", "already_closed") else 1


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        raise SystemExit(main(sys.argv[1:]))
