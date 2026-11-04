#!/usr/bin/env python3
# cspell:words herdr
"""Launch a terminal harness with an Orkest status line in a private tmux session."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import socket as stdlib_socket
import subprocess
import sys
import time
from pathlib import Path

import peer_mailbox as mailbox

_RESUME_VALUE_FLAGS = frozenset({"--resume", "-r", "--session-id", "--conversation", "--session", "-s"})
_NON_SESSION_FLAG_VALUES = frozenset({"last", "help", "read-only", "workspace-write", "danger-full-access"})


def extract_resumed_session_id(command: list[str]) -> str | None:
    """Extract an explicit session/conversation ID from CLI resume arguments across all harnesses."""
    if not command:
        return None
    prog = Path(command[0]).name.lower()
    tokens = list(command[1:])
    idx = 0
    saw_resume_subcommand = False
    while idx < len(tokens):
        token = tokens[idx]
        if token == "--":
            break
        for flag in _RESUME_VALUE_FLAGS:
            if flag == "-s" and prog == "codex":
                continue
            if token == flag:
                if idx + 1 < len(tokens):
                    candidate = tokens[idx + 1].strip()
                    if (
                        not candidate.startswith("-")
                        and candidate.lower() not in _NON_SESSION_FLAG_VALUES
                        and re.fullmatch(r"[\w-]{1,80}", candidate, flags=re.ASCII)
                    ):
                        return candidate
                break
            if token.startswith(f"{flag}="):
                candidate = token.split("=", 1)[1].strip()
                if (
                    candidate
                    and not candidate.startswith("-")
                    and candidate.lower() not in _NON_SESSION_FLAG_VALUES
                    and re.fullmatch(r"[\w-]{1,80}", candidate, flags=re.ASCII)
                ):
                    return candidate
                break
        if token == "resume" and not saw_resume_subcommand:
            saw_resume_subcommand = True
            if idx + 1 < len(tokens):
                candidate = tokens[idx + 1].strip()
                if (
                    not candidate.startswith("-")
                    and candidate.lower() not in _NON_SESSION_FLAG_VALUES
                    and re.fullmatch(r"[\w-]{1,80}", candidate, flags=re.ASCII)
                ):
                    return candidate
        idx += 1
    return None


def find_session_swarm_room(
    base: Path,
    session_id: str,
    *,
    harness: str | None = None,
    cwd: str | None = None,
    aliases: list[str] | tuple[str, ...] | None = None,
) -> dict[str, object] | None:
    """Find the most recently updated swarm room where this session (or its alias) was in control (conductor or lead)."""
    candidates = {
        item.strip()
        for item in [session_id, *(aliases or ())]
        if isinstance(item, str) and item.strip() and re.fullmatch(r"[\w-]{1,80}", item.strip(), flags=re.ASCII)
    }
    if not candidates:
        return None
    expected_engine = {"gemini": "agy", "agy": "agy", "claude": "claude", "codex": "codex", "opencode": "opencode"}.get(
        harness or ""
    )
    resolved_cwd: Path | None = None
    if cwd:
        with contextlib.suppress(OSError):
            resolved_cwd = Path(cwd).resolve()
    host = stdlib_socket.gethostname()
    best_room: dict[str, object] | None = None
    best_score: tuple[int, int, float, int, str] = (-1, -1, -1.0, -1, "")
    with contextlib.suppress(OSError):
        for path in sorted((base / "rooms").glob("*.json")):
            room = mailbox.load(path)
            if (
                not isinstance(room, dict)
                or room.get("schema") != "agent-executor.room.v1"
                or room.get("id") != path.stem
                or not room.get("swarm")
            ):
                continue
            room_machine = room.get("machine")
            if isinstance(room_machine, str) and room_machine and room_machine != host:
                continue
            matched_member: str | None = None
            matched_session: str | None = None
            is_conductor = 0
            exact_primary = 0
            conductor = room.get("conductor")
            if isinstance(conductor, dict):
                c_engine = conductor.get("engine")
                c_session = conductor.get("session")
                bound_id = c_session.get("id") if isinstance(c_session, dict) else None
                mailbox_sid = (
                    conductor.get("mailboxSession") if isinstance(conductor.get("mailboxSession"), str) else None
                )
                for sid in (bound_id, mailbox_sid):
                    if (
                        isinstance(sid, str)
                        and sid in candidates
                        and (not expected_engine or c_engine == expected_engine)
                    ):
                        matched_member = "conductor"
                        matched_session = sid
                        is_conductor = 1
                        exact_primary = 1 if sid == session_id else 0
                        break
            if not matched_member and isinstance(room.get("agents"), list):
                for agent in room["agents"]:
                    if not isinstance(agent, dict) or agent.get("role") != "lead":
                        continue
                    a_engine = agent.get("engine")
                    a_session = agent.get("session")
                    bound_id = a_session.get("id") if isinstance(a_session, dict) else None
                    mailbox_sid = agent.get("mailboxSession") if isinstance(agent.get("mailboxSession"), str) else None
                    for sid in (bound_id, mailbox_sid):
                        if (
                            isinstance(sid, str)
                            and sid in candidates
                            and (not expected_engine or a_engine == expected_engine)
                        ):
                            matched_member = str(agent.get("id") or "")
                            matched_session = sid
                            is_conductor = 0
                            exact_primary = 1 if sid == session_id else 0
                            break
                    if matched_member:
                        break
            if not matched_member or not matched_session:
                continue
            same_cwd = 0
            if resolved_cwd and isinstance(room.get("cwd"), str):
                with contextlib.suppress(OSError):
                    if Path(room["cwd"]).resolve() == resolved_cwd:
                        same_cwd = 1
            updated_raw = room.get("updatedAt")
            updated_at = float(updated_raw) if isinstance(updated_raw, int | float) else 0.0
            room_id = str(room["id"])
            score = (exact_primary, is_conductor, updated_at, same_cwd, room_id)
            if score >= best_score:
                best_score = score
                best_room = {
                    **room,
                    "_matchedMemberId": matched_member,
                    "_matchedSessionId": matched_session,
                }
    return best_room


def rebind_session_swarm_room(
    base: Path,
    room_id: str,
    member_id: str,
    new_session_id: str,
) -> dict[str, object] | None:
    """Update a swarm coordinator or lead member's bound session ID after a `/clear` handover."""
    try:
        target = _room_path(base, room_id)
    except ValueError:
        return None
    with contextlib.suppress(OSError), mailbox.locked(target), _node_room_lock(target):
        data = mailbox.load(target)
        if not isinstance(data, dict):
            return None
        member = data.get("conductor") if member_id == "conductor" else None
        if member is None and isinstance(data.get("agents"), list):
            for agent in data["agents"]:
                if isinstance(agent, dict) and agent.get("id") == member_id:
                    member = agent
                    break
        if not isinstance(member, dict):
            return None
        session_obj = member.get("session")
        if isinstance(session_obj, dict):
            old_id = session_obj.get("id")
            if isinstance(old_id, str) and old_id and old_id != new_session_id:
                prev = member.get("previousSessions")
                history = [item for item in prev if isinstance(item, str)] if isinstance(prev, list) else []
                if old_id not in history:
                    history.append(old_id)
                member["previousSessions"] = history[-16:]
            session_obj["id"] = new_session_id
        data["updatedAt"] = int(time.time() * 1000)
        mailbox.write(target, data)
        return data
    return None


def swarm_socket(room: str) -> str:
    if not re.fullmatch(r"[\w-]{1,80}", room, flags=re.ASCII):
        raise ValueError("Invalid swarm room ID")
    key = str(mailbox.root().resolve()) + "/" + room
    return "orkest-label-" + hashlib.sha256(key.encode()).hexdigest()[:12]


def _discover_socket(
    *,
    socket: str | None = None,
    room: str | None = None,
    session_id: str | None = None,
    base: Path | None = None,
) -> str | None:
    tmux = shutil.which("tmux")
    if not tmux:
        return None
    base = base or mailbox.root()
    candidates: list[str] = []
    for candidate in (socket, os.environ.get("ORKEST_TERMINAL_SERVER", "").strip()):
        if candidate and re.fullmatch(r"orkest-label-[0-9a-f]{12}", candidate) and candidate not in candidates:
            candidates.append(candidate)
    if session_id:
        with contextlib.suppress(Exception):
            peer = mailbox.load(mailbox.peer_path(base, session_id))
            recorded = peer.get("terminalServer") if isinstance(peer, dict) else None
            if (
                isinstance(recorded, str)
                and re.fullmatch(r"orkest-label-[0-9a-f]{12}", recorded)
                and recorded not in candidates
            ):
                candidates.append(recorded)
    env_room = room or os.environ.get("ORKEST_SWARM_ROOM", "").strip()
    if not env_room and session_id:
        matched = find_session_swarm_room(base, session_id)
        if isinstance(matched, dict) and isinstance(matched.get("id"), str):
            env_room = matched["id"]
    if env_room and re.fullmatch(r"[\w-]{1,80}", env_room, flags=re.ASCII):
        with contextlib.suppress(ValueError):
            room_sock = swarm_socket(env_room)
            if room_sock not in candidates:
                candidates.append(room_sock)
    for candidate in candidates:
        probe = subprocess.run(
            [tmux, "-L", candidate, "has-session", "-t", "orkest"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if probe.returncode == 0:
            return candidate
    if (
        (os.environ.get("PYTEST_CURRENT_TEST") or "unittest" in sys.modules)
        and os.environ.get("ORKEST_TEST_ALLOW_TMUX") != "1"
        and not socket
        and not os.environ.get("ORKEST_TERMINAL_SERVER", "").strip()
    ):
        return None
    if session_id:
        uid = os.getuid()
        for root_dir in (Path(f"/tmp/tmux-{uid}"), Path(f"/private/tmp/tmux-{uid}")):
            if not root_dir.is_dir():
                continue
            for entry in sorted(root_dir.glob("orkest-label-*")):
                if not re.fullmatch(r"orkest-label-[0-9a-f]{12}", entry.name):
                    continue
                panes = subprocess.run(
                    [
                        tmux,
                        "-L",
                        entry.name,
                        "list-panes",
                        "-t",
                        "orkest",
                        "-F",
                        "#{@orkest_session}\t#{pane_title}",
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                if panes.returncode == 0 and session_id in panes.stdout:
                    return entry.name
    return None


def _herdr_active(socket: str | None = None) -> bool:
    if socket or os.environ.get("HERDR_ENV") != "1" or not bool(os.environ.get("HERDR_PANE_ID", "").strip()):
        return False
    if (os.environ.get("PYTEST_CURRENT_TEST") or "unittest" in sys.modules) and os.environ.get(
        "ORKEST_TEST_ALLOW_HERDR"
    ) != "1":
        herdr_bin = shutil.which("herdr") or ""
        if not any(marker in herdr_bin for marker in ("/tmp/", "/var/folders/", "pytest")):
            return False
    return True


def _room_path(base: Path, room_id: str) -> Path:
    if not re.fullmatch(r"[\w-]{1,80}", room_id, flags=re.ASCII):
        raise ValueError("Invalid swarm room ID")
    return base / "rooms" / f"{room_id}.json"


@contextlib.contextmanager
def _node_room_lock(path: Path):
    lock_dir = Path(f"{path}.lock")
    lock_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    owner_file = lock_dir / "owner"
    deadline = time.monotonic() + 3.0
    acquired = False
    while True:
        try:
            lock_dir.mkdir(mode=0o700)
            acquired = True
            with contextlib.suppress(OSError):
                owner_file.write_text(f"{os.getpid()}\n", encoding="utf-8")
            break
        except FileExistsError:
            stale = False
            with contextlib.suppress(OSError, ValueError):
                owner_pid = int(owner_file.read_text(encoding="utf-8").strip())
                if owner_pid > 0 and mailbox.pid_alive(owner_pid) is False:
                    stale = True
            if not stale:
                with contextlib.suppress(OSError):
                    if time.time() - lock_dir.stat().st_mtime > 15.0:
                        stale = True
            if stale:
                stale_dir = lock_dir.with_name(f"{lock_dir.name}.stale.{os.getpid()}.{time.monotonic_ns()}")
                with contextlib.suppress(OSError):
                    os.replace(lock_dir, stale_dir)
                    (stale_dir / "owner").unlink(missing_ok=True)
                    stale_dir.rmdir()
                continue
            if time.monotonic() >= deadline:
                raise OSError(f"Room is locked: {path}") from None
            time.sleep(0.025)
    try:
        yield
    finally:
        if acquired:
            with contextlib.suppress(OSError):
                owner_file.unlink(missing_ok=True)
                lock_dir.rmdir()


def _update_room_metadata(base: Path, room_id: str, **fields: str | None) -> dict[str, object] | None:
    try:
        path = _room_path(base, room_id)
    except ValueError:
        return None
    with contextlib.suppress(OSError), mailbox.locked(path), _node_room_lock(path):
        data = mailbox.load(path)
        if not isinstance(data, dict):
            return None
        for key, value in fields.items():
            if value is None:
                data.pop(key, None)
            else:
                data[key] = value
        mailbox.write(path, data)
        return data
    return None


def _extract_herdr_pane_id(raw_stdout: str) -> str | None:
    try:
        data = json.loads(raw_stdout)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    result = data.get("result")
    if isinstance(result, dict):
        pane = result.get("pane")
        if isinstance(pane, dict) and isinstance(pane.get("pane_id"), str) and pane["pane_id"]:
            return pane["pane_id"]
        if isinstance(result.get("pane_id"), str) and result["pane_id"]:
            return result["pane_id"]
    pane = data.get("pane")
    if isinstance(pane, dict) and isinstance(pane.get("pane_id"), str) and pane["pane_id"]:
        return pane["pane_id"]
    if isinstance(data.get("pane_id"), str) and data["pane_id"]:
        return data["pane_id"]
    return None


def _herdr_pane_live(
    herdr: str,
    pane_id: str,
    *,
    workspace_id: str | None = None,
    env: dict[str, str] | None = None,
) -> bool:
    if not isinstance(pane_id, str) or not pane_id.strip():
        return False
    list_cmd = [herdr, "pane", "list", *(["--workspace", workspace_id] if workspace_id else [])]
    listed = subprocess.run(list_cmd, env=env, capture_output=True, text=True, check=False)
    if listed.returncode == 0 and listed.stdout.strip():
        try:
            payload = json.loads(listed.stdout)
        except ValueError:
            payload = None
        panes = None
        if isinstance(payload, list):
            panes = payload
        elif isinstance(payload, dict):
            result = payload.get("result")
            if isinstance(result, dict) and isinstance(result.get("panes"), list):
                panes = result["panes"]
            elif isinstance(result, list):
                panes = result
            elif isinstance(payload.get("panes"), list):
                panes = payload["panes"]
        if isinstance(panes, list):
            ids = {
                item if isinstance(item, str) else (item.get("pane_id") or item.get("id"))
                for item in panes
                if isinstance(item, str | dict)
            }
            return pane_id in ids
    current = subprocess.run(
        [herdr, "pane", "current", "--pane", pane_id],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return current.returncode == 0


def _open_herdr_swarm_view(
    herdr: str,
    *,
    room: str,
    cwd: str | None,
    coordinator_pane: str,
    workspace_id: str | None,
    environment: dict[str, str],
    base: Path,
) -> str | None:
    target_cwd = cwd or os.getcwd()
    split = subprocess.run(
        [
            herdr,
            "pane",
            "split",
            "--current",
            "--direction",
            "right",
            "--cwd",
            target_cwd,
            "--no-focus",
        ],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    if split.returncode != 0:
        return None
    view_pane_id = _extract_herdr_pane_id(split.stdout)
    if not view_pane_id:
        return None
    cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
    view_cmd = shlex.join(
        [
            shutil.which("node") or "node",
            str(cli),
            "horde",
            "--attach-room",
            room,
            "--view",
        ]
    )
    run_proc = subprocess.run(
        [herdr, "pane", "run", view_pane_id, view_cmd],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    if run_proc.returncode != 0:
        return None
    _update_room_metadata(
        base,
        room,
        herdrViewPaneId=view_pane_id,
        herdrCoordinatorPaneId=coordinator_pane,
        **({"herdrWorkspaceId": workspace_id} if workspace_id else {}),
    )
    return view_pane_id


def _find_herdr_peer(base: Path, session_id: str | None, pane_id: str) -> dict[str, object] | None:
    if session_id:
        with contextlib.suppress(Exception):
            peer = mailbox.load(mailbox.peer_path(base, session_id))
            if isinstance(peer, dict) and not peer.get("isSubagent") and not peer.get("delegatedRun"):
                return peer
    if not pane_id:
        return None
    best: dict[str, object] | None = None
    with contextlib.suppress(OSError):
        for path in sorted((base / "peers").glob("*.json")):
            peer = mailbox.load(path)
            if not isinstance(peer, dict) or not mailbox.valid_peer(peer):
                continue
            if peer.get("isSubagent") or peer.get("delegatedRun"):
                continue
            if peer.get("herdrPaneId") != pane_id:
                continue
            if best is None or str(peer.get("lastSeenAt", "")) >= str(best.get("lastSeenAt", "")):
                best = peer
    return best


def _find_herdr_room(base: Path, pane_id: str) -> str:
    if not pane_id:
        return ""
    best_id = ""
    best_updated = -1
    with contextlib.suppress(OSError):
        for path in sorted((base / "rooms").glob("*.json")):
            room = mailbox.load(path)
            if not isinstance(room, dict) or room.get("herdrCoordinatorPaneId") != pane_id:
                continue
            room_id = room.get("id")
            if not isinstance(room_id, str) or not room_id:
                continue
            updated = room.get("updatedAt")
            score = updated if isinstance(updated, int | float) else 0
            if score >= best_updated:
                best_updated = score
                best_id = room_id
    return best_id


def _ensure_bound_room(
    *,
    current_room: str,
    session_id: str | None,
    harness: str | None,
    cwd: str | None,
    environment: dict[str, str],
    base: Path | None = None,
) -> tuple[str | None, str | None]:
    cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
    node = shutil.which("node") or "node"
    engine = {"gemini": "agy", "agy": "agy", "claude": "claude", "codex": "codex", "opencode": "opencode"}.get(
        harness or "", "codex"
    )
    if not current_room:
        target_cwd = cwd or os.getcwd()
        created = subprocess.run(
            [node, str(cli), "horde", "--engine", engine, "--cwd", target_cwd, "--json"],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        if created.returncode != 0:
            return None, created.stderr.strip() or "could not create swarm room"
        current_room = json.loads(created.stdout)["id"]
    if session_id and current_room:
        already_bound = False
        if base is not None:
            with contextlib.suppress(ValueError):
                existing = mailbox.load(_room_path(base, current_room))
                if isinstance(existing, dict):
                    conductor = existing.get("conductor")
                    if isinstance(conductor, dict) and isinstance(conductor.get("session"), dict):
                        already_bound = bool(conductor["session"].get("id"))
                    if not already_bound and isinstance(existing.get("agents"), list):
                        for agent in existing["agents"]:
                            if (
                                isinstance(agent, dict)
                                and isinstance(agent.get("session"), dict)
                                and agent["session"].get("id") == session_id
                            ):
                                already_bound = True
                                break
        if not already_bound:
            subprocess.run(
                [
                    node,
                    str(cli),
                    "rooms",
                    "bind",
                    "--room",
                    current_room,
                    "--member",
                    "conductor",
                    "--engine",
                    engine,
                    "--session",
                    session_id,
                ],
                env=environment,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
    return current_room, None


def _toggle_herdr_swarm_view(
    action: str,
    *,
    herdr: str,
    room: str | None = None,
    session_id: str | None = None,
    harness: str | None = None,
    cwd: str | None = None,
    base: Path,
) -> dict[str, str]:
    coordinator_pane = os.environ.get("HERDR_PANE_ID", "").strip()
    workspace_id = os.environ.get("HERDR_WORKSPACE_ID", "").strip() or None
    peer = _find_herdr_peer(base, session_id, coordinator_pane)
    if isinstance(peer, dict):
        if not session_id and isinstance(peer.get("session"), str):
            session_id = peer["session"]
        if not harness and isinstance(peer.get("harness"), str):
            harness = peer["harness"]
        if not cwd and isinstance(peer.get("cwd"), str):
            cwd = peer["cwd"]
    if not harness:
        harness = os.environ.get("ORKEST_TERMINAL_HARNESS", "").strip() or None
    current_room = (room or os.environ.get("ORKEST_SWARM_ROOM", "")).strip()
    if not current_room and session_id:
        aliases = peer.get("aliases") if isinstance(peer, dict) and isinstance(peer.get("aliases"), list) else None
        matched = find_session_swarm_room(base, session_id, harness=harness, cwd=cwd, aliases=aliases)
        if isinstance(matched, dict) and isinstance(matched.get("id"), str):
            current_room = matched["id"]
    if not current_room and isinstance(peer, dict) and mailbox.valid_peer(peer):
        import agent_statusline

        bound = agent_statusline.bound_rooms(base, peer)
        if bound:
            current_room = bound[0][0]["id"]
    if not current_room and coordinator_pane:
        current_room = _find_herdr_room(base, coordinator_pane)
    environment = dict(os.environ)
    environment.pop("TMUX", None)
    environment.pop("TMUX_PANE", None)
    environment["AGENT_EXECUTOR_HOME"] = str(base.parent)
    resolved_room, room_error = _ensure_bound_room(
        current_room=current_room,
        session_id=session_id,
        harness=harness,
        cwd=cwd,
        environment=environment,
        base=base,
    )
    if not resolved_room:
        return {"status": "error", "reason": room_error or "could not create swarm room"}
    current_room = resolved_room
    room_data = None
    with contextlib.suppress(ValueError):
        room_data = mailbox.load(_room_path(base, current_room))
    recorded_view_pane = (
        room_data.get("herdrViewPaneId")
        if isinstance(room_data, dict) and isinstance(room_data.get("herdrViewPaneId"), str)
        else None
    )
    if recorded_view_pane == coordinator_pane:
        recorded_view_pane = None
    effective_workspace = workspace_id or (
        room_data.get("herdrWorkspaceId")
        if isinstance(room_data, dict) and isinstance(room_data.get("herdrWorkspaceId"), str)
        else None
    )
    view_live = bool(
        recorded_view_pane
        and _herdr_pane_live(herdr, recorded_view_pane, workspace_id=effective_workspace, env=environment)
    )
    if view_live and recorded_view_pane and action in ("toggle", "close"):
        closed = subprocess.run(
            [herdr, "pane", "close", "--pane", recorded_view_pane],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        if closed.returncode != 0:
            subprocess.run(
                [herdr, "pane", "close", recorded_view_pane],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
        _update_room_metadata(base, current_room, herdrViewPaneId=None)
        return {"status": "closed", "room": current_room, "backend": "herdr", "pane": recorded_view_pane}
    if not view_live and action == "close":
        if recorded_view_pane:
            _update_room_metadata(base, current_room, herdrViewPaneId=None)
        return {"status": "already_closed", "room": current_room, "backend": "herdr"}
    if view_live and recorded_view_pane and action == "open":
        return {"status": "already_open", "room": current_room, "backend": "herdr", "pane": recorded_view_pane}
    pane_id = _open_herdr_swarm_view(
        herdr,
        room=current_room,
        cwd=cwd,
        coordinator_pane=coordinator_pane,
        workspace_id=effective_workspace,
        environment=environment,
        base=base,
    )
    if not pane_id:
        return {
            "status": "error",
            "reason": "could not split Herdr pane for swarm view",
            "room": current_room,
            "backend": "herdr",
        }
    return {"status": "opened", "room": current_room, "backend": "herdr", "pane": pane_id}


def toggle_swarm_view(
    action: str = "toggle",
    *,
    socket: str | None = None,
    room: str | None = None,
    session_id: str | None = None,
    harness: str | None = None,
    cwd: str | None = None,
    base: Path | None = None,
) -> dict[str, str]:
    """Open, close, or toggle the live Swarm View split pane in an Orkest tmux or Herdr session."""
    if action not in ("toggle", "open", "close"):
        raise ValueError(f"Unsupported swarm view action: {action}")
    base = base or mailbox.root()
    if _herdr_active(socket):
        herdr = shutil.which("herdr")
        if herdr:
            return _toggle_herdr_swarm_view(
                action,
                herdr=herdr,
                room=room,
                session_id=session_id,
                harness=harness,
                cwd=cwd,
                base=base,
            )
    tmux = shutil.which("tmux")
    if not tmux:
        return {"status": "unavailable", "reason": "tmux is not installed on PATH"}
    resolved_socket = _discover_socket(socket=socket, room=room, session_id=session_id, base=base)
    if not resolved_socket:
        return {"status": "unavailable", "reason": "no active Orkest tmux session found for this terminal"}
    tmux_cmd = [tmux, "-L", resolved_socket]
    coordinator_pane = (
        subprocess.run(
            [*tmux_cmd, "show-option", "-t", "orkest", "-v", "@orkest_coordinator_pane"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
        or "%0"
    )
    tmux_room = subprocess.run(
        [*tmux_cmd, "show-option", "-t", "orkest", "-v", "@orkest_room"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    current_room = (room or "").strip() or tmux_room or os.environ.get("ORKEST_SWARM_ROOM", "").strip()
    panes_out = subprocess.run(
        [*tmux_cmd, "list-panes", "-t", "orkest", "-F", "#{pane_id}"],
        capture_output=True,
        text=True,
        check=False,
    )
    panes = [line.strip() for line in panes_out.stdout.splitlines() if line.strip()]
    view_panes = [pane for pane in panes if pane != coordinator_pane]
    if view_panes and action in ("toggle", "close"):
        for pane in view_panes:
            subprocess.run([*tmux_cmd, "kill-pane", "-t", pane], check=False)
        subprocess.run([*tmux_cmd, "select-pane", "-t", coordinator_pane], check=False)
        return {"status": "closed", "room": current_room, "socket": resolved_socket}
    if not view_panes and action == "close":
        return {"status": "already_closed", "room": current_room, "socket": resolved_socket}
    if view_panes and action == "open":
        return {"status": "already_open", "room": current_room, "socket": resolved_socket}

    cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
    environment = dict(os.environ)
    environment.pop("TMUX", None)
    environment.pop("TMUX_PANE", None)
    environment["AGENT_EXECUTOR_HOME"] = str(base.parent)
    if not session_id or not cwd:
        info = subprocess.run(
            [
                *tmux_cmd,
                "display-message",
                "-p",
                "-t",
                coordinator_pane,
                "#{@orkest_session}\t#{pane_title}\t#{pane_current_path}",
            ],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.rstrip("\n")
        parts = info.split("\t")
        if not session_id and parts and parts[0]:
            session_id = parts[0]
        elif not session_id and len(parts) > 1 and re.fullmatch(r"[\w-]{8,80}", parts[1]):
            session_id = parts[1]
        if not cwd and len(parts) > 2 and parts[2]:
            cwd = parts[2]
    peer = None
    if session_id:
        with contextlib.suppress(Exception):
            peer = mailbox.load(mailbox.peer_path(base, session_id))
        if isinstance(peer, dict) and not harness:
            harness = peer.get("harness")
        if isinstance(peer, dict) and not cwd:
            cwd = peer.get("cwd")
    if not current_room and session_id:
        aliases = peer.get("aliases") if isinstance(peer, dict) and isinstance(peer.get("aliases"), list) else None
        matched = find_session_swarm_room(base, session_id, harness=harness, cwd=cwd, aliases=aliases)
        if isinstance(matched, dict) and isinstance(matched.get("id"), str):
            current_room = matched["id"]
    if not current_room and isinstance(peer, dict) and mailbox.valid_peer(peer):
        import agent_statusline

        bound = agent_statusline.bound_rooms(base, peer)
        if bound:
            current_room = bound[0][0]["id"]
    resolved_room, room_error = _ensure_bound_room(
        current_room=current_room,
        session_id=session_id,
        harness=harness,
        cwd=cwd,
        environment=environment,
        base=base,
    )
    if not resolved_room:
        return {"status": "error", "reason": room_error or "could not create swarm room"}
    current_room = resolved_room
    subprocess.run(
        [*tmux_cmd, "set-option", "-t", "orkest", "@orkest_room", current_room], env=environment, check=False
    )
    width_out = subprocess.run(
        [*tmux_cmd, "display-message", "-p", "-t", coordinator_pane, "#{window_width}"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    columns = int(width_out) if width_out.isdigit() else 120
    split = subprocess.run(
        [
            *tmux_cmd,
            "split-window",
            "-t",
            coordinator_pane,
            "-d",
            *(["-h", "-l", "40%"] if columns >= 120 else ["-v", "-l", "40%"]),
            "--",
            shutil.which("node") or "node",
            str(cli),
            "horde",
            "--attach-room",
            current_room,
            "--view",
        ],
        env=environment,
        check=False,
    )
    if split.returncode != 0:
        return {"status": "error", "reason": "could not split tmux window for swarm view", "room": current_room}
    subprocess.run([*tmux_cmd, "bind-key", "Tab", "select-pane", "-t", ":.+"], env=environment, check=False)
    subprocess.run([*tmux_cmd, "select-pane", "-t", coordinator_pane], env=environment, check=False)
    return {"status": "opened", "room": current_room, "socket": resolved_socket}


def main(arguments: list[str]) -> int:
    if not arguments or arguments == ["--help"]:
        print("Usage: ork label -- codex|claude|plaude|agy|opencode [arguments]")
        return 0 if arguments else 2
    if arguments[:1] == ["--toggle-swarm"]:
        parser = argparse.ArgumentParser(description="Open, close, or toggle the Orkest Swarm View split pane")
        parser.add_argument("--toggle-swarm", nargs="?", const="toggle", default="toggle")
        parser.add_argument("--socket")
        parser.add_argument("--room")
        parser.add_argument("--session")
        parser.add_argument("--harness")
        parser.add_argument("--cwd")
        parser.add_argument("--json", action="store_true")
        args = parser.parse_args(arguments)
        action = args.toggle_swarm if args.toggle_swarm in ("toggle", "open", "close") else "toggle"
        outcome = toggle_swarm_view(
            action,
            socket=args.socket,
            room=args.room,
            session_id=args.session,
            harness=args.harness,
            cwd=args.cwd,
        )
        if args.json:
            print(json.dumps(outcome))
        elif outcome["status"] in ("opened", "closed", "already_open", "already_closed"):
            label = outcome["status"].replace("_", " ")
            room_suffix = f" (room {outcome['room']})" if outcome.get("room") else ""
            print(f"Swarm view {label}{room_suffix}.")
        else:
            print(f"Swarm view {outcome['status']}: {outcome.get('reason', 'unknown error')}", file=sys.stderr)
            return 1
        return 0
    room = None
    cwd = None
    attach = False
    lines = 2
    while arguments and arguments[0] == "--lines":
        if len(arguments) > 1 and arguments[1] in ("1", "2"):
            lines = int(arguments[1])
            arguments = arguments[2:]
        else:
            break
    if arguments[:1] in (["--room"], ["--attach-room"]):
        parser = argparse.ArgumentParser(description="Open an Orkest coordinator and swarm view")
        source = parser.add_mutually_exclusive_group(required=True)
        source.add_argument("--room")
        source.add_argument("--attach-room")
        parser.add_argument("--cwd")
        parser.add_argument("--lines", type=int, choices=(1, 2), default=lines)
        parser.add_argument("command", nargs=argparse.REMAINDER)
        args = parser.parse_args(arguments)
        room, cwd, attach, lines = args.room or args.attach_room, args.cwd, bool(args.attach_room), args.lines
        arguments = args.command
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("ork label needs an interactive terminal", file=sys.stderr)
        return 2
    if attach and _herdr_active() and room:
        herdr = shutil.which("herdr")
        room_data = None
        with contextlib.suppress(ValueError):
            room_data = mailbox.load(_room_path(mailbox.root(), room))
        coord_pane = (
            room_data.get("herdrCoordinatorPaneId")
            if isinstance(room_data, dict) and isinstance(room_data.get("herdrCoordinatorPaneId"), str)
            else None
        )
        workspace_id = os.environ.get("HERDR_WORKSPACE_ID", "").strip() or (
            room_data.get("herdrWorkspaceId")
            if isinstance(room_data, dict) and isinstance(room_data.get("herdrWorkspaceId"), str)
            else None
        )
        if herdr and coord_pane and _herdr_pane_live(herdr, coord_pane, workspace_id=workspace_id):
            return subprocess.run([herdr, "pane", "focus", "--pane", coord_pane], check=False).returncode
        if not shutil.which("tmux"):
            print(
                "This swarm has no live coordinator terminal. Use --view to inspect its recorded work.", file=sys.stderr
            )
            return 2
    if not attach:
        command = arguments[1:] if arguments[:1] == ["--"] else arguments
        if not command or command == ["--help"]:
            print("Usage: ork label -- codex|claude|plaude|agy|opencode [arguments]")
            return 0 if command else 2
        harness = {
            "codex": "codex",
            "claude": "claude",
            "plaude": "claude",
            "agy": "gemini",
            "opencode": "opencode",
        }.get(Path(command[0]).name)
        if not harness:
            print("ork label supports codex, claude, plaude, agy and opencode", file=sys.stderr)
            return 2
        if not shutil.which(command[0]):
            print(f"{command[0]} is not installed on PATH", file=sys.stderr)
            return 2
        if not room:
            resumed_session = extract_resumed_session_id(command)
            if resumed_session:
                base_dir = mailbox.root()
                peer_data = None
                with contextlib.suppress(Exception):
                    peer_data = mailbox.load(mailbox.peer_path(base_dir, resumed_session))
                aliases = (
                    peer_data.get("aliases")
                    if isinstance(peer_data, dict) and isinstance(peer_data.get("aliases"), list)
                    else None
                )
                matched = find_session_swarm_room(base_dir, resumed_session, harness=harness, cwd=cwd, aliases=aliases)
                if isinstance(matched, dict) and isinstance(matched.get("id"), str):
                    room = matched["id"]
        if Path(command[0]).name == "codex":
            # The TUI knows the visible conversation even when agents share a daemon.
            # This changes only the private pane title, not Codex's thread name or status line.
            command = [command[0], "-c", 'tui.terminal_title=["session-id"]', *command[1:]]
        if _herdr_active():
            environment = dict(os.environ)
            environment["ORKEST_TERMINAL_HARNESS"] = harness
            if room:
                environment["ORKEST_SWARM_ROOM"] = room
                coordinator_pane = os.environ.get("HERDR_PANE_ID", "").strip()
                workspace_id = os.environ.get("HERDR_WORKSPACE_ID", "").strip() or None
                base_dir = mailbox.root()
                _update_room_metadata(
                    base_dir,
                    room,
                    herdrCoordinatorPaneId=coordinator_pane,
                    **({"herdrWorkspaceId": workspace_id} if workspace_id else {}),
                )
                herdr = shutil.which("herdr")
                if herdr:
                    view_pane = _open_herdr_swarm_view(
                        herdr,
                        room=room,
                        cwd=cwd,
                        coordinator_pane=coordinator_pane,
                        workspace_id=workspace_id,
                        environment=environment,
                        base=base_dir,
                    )
                    if not view_pane:
                        print(
                            "Swarm view could not open; the coordinator terminal is still available.",
                            file=sys.stderr,
                        )
            return subprocess.run(command, env=environment, cwd=cwd or None, check=False).returncode
    tmux = shutil.which("tmux")
    if not tmux:
        print("ork label needs tmux on PATH", file=sys.stderr)
        return 2
    socket = swarm_socket(room) if room else f"orkest-label-{secrets.token_hex(6)}"
    session = "orkest"
    base = [tmux, "-L", socket]
    if attach:
        owner = subprocess.run(
            [*base, "show-option", "-t", session, "-v", "@orkest_room"], capture_output=True, text=True, check=False
        )
        pane = subprocess.run(
            [*base, "show-option", "-t", session, "-v", "@orkest_coordinator_pane"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
        live = ""
        if re.fullmatch(r"%\d+", pane):
            live = subprocess.run(
                [*base, "display-message", "-p", "-t", pane, "#{pane_id}:#{pane_dead}"],
                capture_output=True,
                text=True,
                check=False,
            ).stdout.strip()
        if owner.returncode or owner.stdout.strip() != room or live != f"{pane}:0":
            print(
                "This swarm has no live coordinator terminal. Use --view to inspect its recorded work.", file=sys.stderr
            )
            return 2
        environment = dict(os.environ)
        environment.pop("TMUX", None)
        environment.pop("TMUX_PANE", None)
        return subprocess.run([*base, "attach-session", "-t", session], env=environment, check=False).returncode
    environment = dict(os.environ)
    # A private server must not inherit the enclosing tmux client's socket.
    environment.pop("TMUX", None)
    environment.pop("TMUX_PANE", None)
    if room:
        existing_session = subprocess.run(
            [*base, "has-session", "-t", session],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if existing_session.returncode == 0:
            existing_pane = subprocess.run(
                [*base, "show-option", "-t", session, "-v", "@orkest_coordinator_pane"],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            ).stdout.strip()
            existing_live = ""
            if re.fullmatch(r"%\d+", existing_pane):
                existing_live = subprocess.run(
                    [*base, "display-message", "-p", "-t", existing_pane, "#{pane_id}:#{pane_dead}"],
                    env=environment,
                    capture_output=True,
                    text=True,
                    check=False,
                ).stdout.strip()
            if existing_live == f"{existing_pane}:0":
                socket = f"orkest-label-{secrets.token_hex(6)}"
                base = [tmux, "-L", socket]
            else:
                subprocess.run(
                    [*base, "kill-session", "-t", session],
                    env=environment,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
    environment["ORKEST_TERMINAL_SERVER"] = socket
    environment["ORKEST_TERMINAL_HARNESS"] = harness
    if room:
        environment["ORKEST_SWARM_ROOM"] = room
    columns, rows = shutil.get_terminal_size((80, 24))
    create = subprocess.run(
        [
            *base,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-s",
            session,
            "-x",
            str(columns),
            "-y",
            str(rows),
            *(["-c", cwd] if cwd else []),
            "--",
            *command,
        ],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    if create.returncode:
        print(create.stderr.strip(), file=sys.stderr)
        return create.returncode
    coordinator_pane = create.stdout.strip()

    script = Path(__file__).with_name("agent_statusline.py")
    renderer = [sys.executable, str(script), "--tmux-server", socket, "--harness", harness]
    if harness == "codex":
        renderer.extend(
            [
                "--codex-home",
                str(Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()),
            ]
        )
    invocation = shlex.join(renderer).replace("#", "##")
    source = "--codex-pane" if harness == "codex" else "--terminal-pane"
    # A literal %0 in a status format is parsed by strftime. Expand it from an option instead.
    pane = "#{@orkest_coordinator_pane}"
    status = f"#({invocation} {source} {pane} --width #{{client_width}} --tmux)"
    status_0 = f"#({invocation} {source} {pane} --width #{{client_width}} --tmux --line 1)"
    status_1 = f"#({invocation} {source} {pane} --width #{{client_width}} --tmux --line 2)"
    options = (
        ("@orkest_coordinator_pane", coordinator_pane),
        *([("status", "2")] if lines == 2 else []),
        ("status-position", "bottom"),
        ("status-interval", "3"),
        ("status-style", "fg=default,bg=default"),
        ("status-format[0]", status_0 if lines == 2 else status),
        *([("status-format[1]", status_1)] if lines == 2 else []),
    )
    for name, value in options:
        result = subprocess.run([*base, "set-option", "-t", session, name, value], env=environment, check=False)
        if result.returncode:
            print(f"Label setup failed. Reattach with: tmux -L {socket} attach -t {session}", file=sys.stderr)
            return result.returncode
    toggle_cmd = shlex.join(
        [sys.executable, str(Path(__file__).resolve()), "--toggle-swarm", "toggle", "--socket", socket]
    )
    subprocess.run([*base, "bind-key", "-n", "M-s", "run-shell", "-b", toggle_cmd], env=environment, check=False)
    subprocess.run(
        [
            *base,
            "set-hook",
            "-t",
            session,
            "pane-exited",
            f"if-shell -F '#{{==:#{{hook_pane}},{coordinator_pane}}}' 'kill-session -t {session}'",
        ],
        env=environment,
        check=False,
    )

    if room:
        cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
        subprocess.run([*base, "set-option", "-t", session, "@orkest_room", room], env=environment, check=True)
        split = subprocess.run(
            [
                *base,
                "split-window",
                "-t",
                coordinator_pane,
                "-d",
                *(["-h", "-l", "40%"] if columns >= 120 else ["-v", "-l", "40%"]),
                "--",
                shutil.which("node") or "node",
                str(cli),
                "horde",
                "--attach-room",
                room,
                "--view",
            ],
            env=environment,
            check=False,
        )
        if split.returncode:
            print("Swarm view could not open; the coordinator terminal is still available.", file=sys.stderr)
        subprocess.run([*base, "bind-key", "Tab", "select-pane", "-t", ":.+"], env=environment, check=True)
        subprocess.run([*base, "select-pane", "-t", coordinator_pane], env=environment, check=False)

    result = subprocess.run([*base, "attach-session", "-t", session], env=environment, check=False)
    still_running = subprocess.run(
        [*base, "has-session", "-t", session], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    if still_running.returncode == 0:
        reconnect = f"ork horde --attach-room {room}" if room else f"tmux -L {socket} attach -t {session}"
        print(f"Session detached. Reattach with: {reconnect}")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
