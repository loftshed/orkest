#!/usr/bin/env python3
"""Launch a harness directly in Herdr or with an Orkest status line in private tmux."""

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
import room_store
from herdr_context import verified_agent

_RESUME_VALUE_FLAGS = frozenset({"--resume", "-r", "--session-id", "--conversation", "--session", "-s", "-c"})
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
            if flag in {"-s", "-c"} and prog == "codex":
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
    only_room: str | None = None,
) -> dict[str, object] | None:
    """Find a conductor/lead room using attested native identities; legacy display aliases are ignored."""
    peer = mailbox.session_peer(base, session_id, harness=harness, cwd=cwd)
    candidates = mailbox.native_session_ids(peer) if peer else {session_id}
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
        for room in room_store.list_rooms(base):
            if not isinstance(room, dict) or room.get("schema") != "agent-executor.room.v1" or not room.get("swarm"):
                continue
            if room.get("closedAt") or room.get("status") == "closed":
                continue
            if resolved_cwd and isinstance(room.get("cwd"), str) and Path(room["cwd"]).resolve() != resolved_cwd:
                continue
            if only_room is not None and room.get("id") != only_room:
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
                if not mailbox.local_session_binding(room, conductor):
                    continue
                owner_ids = mailbox.room_owner_sessions(room, conductor)
                # A dead historical ID never outranks a room's current live owner.
                if any(
                    not peer or owner["session"] != peer["session"]
                    for owner in mailbox.room_session_peers(base, room, conductor)
                ):
                    continue
                for sid in owner_ids:
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
                    if not mailbox.local_session_binding(room, agent) or any(
                        not peer or owner["session"] != peer["session"]
                        for owner in mailbox.room_session_peers(base, room, agent)
                    ):
                        continue
                    for sid in (bound_id, mailbox_sid, *(agent.get("previousSessions") or [])):
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
    with contextlib.suppress(OSError, ValueError):
        return room_store.rebind(base, room_id, member_id, new_session_id)
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
            peer = mailbox.session_peer(base, session_id)
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


def _resolve_herdr_context() -> tuple[str, str | None, str | None]:
    """Return (pane_id, workspace_id, focused_cwd) from Herdr env or HERDR_PLUGIN_CONTEXT_JSON."""
    ctx: dict[str, object] = {}
    raw_ctx = os.environ.get("HERDR_PLUGIN_CONTEXT_JSON", "").strip()
    if raw_ctx:
        with contextlib.suppress(ValueError, TypeError):
            parsed = json.loads(raw_ctx)
            if isinstance(parsed, dict):
                ctx = parsed
    pane_id = (
        os.environ.get("HERDR_PANE_ID", "").strip()
        or str(ctx.get("focused_pane_id") or "").strip()
        or os.environ.get("HERDR_ACTIVE_PANE_ID", "").strip()
    )
    workspace_id = (
        os.environ.get("HERDR_WORKSPACE_ID", "").strip()
        or str(ctx.get("workspace_id") or "").strip()
        or os.environ.get("HERDR_ACTIVE_WORKSPACE_ID", "").strip()
        or None
    )
    worktree = ctx.get("worktree")
    worktree_path = (
        worktree if isinstance(worktree, str) else (worktree.get("path") if isinstance(worktree, dict) else None)
    )
    focused_cwd = (
        str(ctx.get("focused_pane_cwd") or "").strip()
        or os.environ.get("HERDR_ACTIVE_PANE_CWD", "").strip()
        or (str(worktree_path).strip() if isinstance(worktree_path, str) else "")
        or str(ctx.get("workspace_cwd") or "").strip()
        or None
    )
    return pane_id, workspace_id, focused_cwd


def _room_path(base: Path, room_id: str) -> Path:
    if not re.fullmatch(r"[\w-]{1,80}", room_id, flags=re.ASCII):
        raise ValueError("Invalid swarm room ID")
    return base / "rooms" / f"{room_id}.json"


def _room_lock_owner(owner_file: Path) -> dict | None:
    try:
        value = json.loads(owner_file.read_text(encoding="utf-8"))
        owner = {"pid": value} if isinstance(value, int) else value
        if isinstance(owner, dict) and type(owner.get("pid")) is int and owner["pid"] > 0:
            return owner
    except (OSError, ValueError):
        pass
    return None


def _room_lock_owner_live(owner: dict) -> bool:
    # Unknown liveness or birth must not turn an old live lock into a stale one.
    if mailbox.pid_alive(owner["pid"]) is False:
        return False
    birth = mailbox.process_started(owner["pid"]) if owner.get("pidBirth") else None
    return not birth or birth == owner["pidBirth"]


def _reap_room_lock(lock_dir: Path) -> None:
    owner_file = lock_dir / "owner"
    # A dead reaper may have left the owner under its retirement name.
    for retired in lock_dir.glob("owner.*.retired"):
        match = re.fullmatch(r"owner\.(\d+)\.[\da-f-]+\.retired", retired.name)
        if match and mailbox.pid_alive(int(match[1])) is False:
            with contextlib.suppress(FileExistsError, FileNotFoundError):
                owner_file.hardlink_to(retired)
                retired.unlink()
    owner = _room_lock_owner(owner_file)
    if owner is not None:
        if _room_lock_owner_live(owner):
            return
    elif time.time() - lock_dir.stat().st_mtime <= 15.0:
        return
    retired = lock_dir / f"owner.{os.getpid()}.{secrets.token_hex(16)}.retired"
    previous = lock_dir.stat()
    try:
        # Claim only the owner file. Recursive deletion could remove a new holder.
        owner_file.rename(retired)
    except FileNotFoundError:
        with contextlib.suppress(OSError):
            lock_dir.rmdir()
        return
    owner = _room_lock_owner(retired)
    current = lock_dir.stat()
    if (
        (current.st_dev, current.st_ino) != (previous.st_dev, previous.st_ino)
        or (owner is not None and _room_lock_owner_live(owner))
        or (owner is None and time.time() - previous.st_mtime <= 15.0)
    ):
        retired.rename(owner_file)
        return
    retired.unlink()
    with contextlib.suppress(OSError):
        lock_dir.rmdir()


@contextlib.contextmanager
def _node_room_lock(path: Path):
    """Share Node's mkdir/JSON owner protocol, including live legacy PID records."""
    lock_dir = Path(f"{path}.lock")
    lock_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    owner_file = lock_dir / "owner"
    deadline = time.monotonic() + 3.0
    token = secrets.token_hex(16)
    owner = {"pid": os.getpid(), "token": token, "pidBirth": mailbox.process_started(os.getpid())}
    while True:
        try:
            lock_dir.mkdir(mode=0o700)
        except FileExistsError:
            with contextlib.suppress(OSError):
                _reap_room_lock(lock_dir)
            if time.monotonic() >= deadline:
                raise OSError(f"Room is locked: {path}") from None
            time.sleep(0.025)
            continue
        try:
            owner_file.write_text(json.dumps(owner) + "\n", encoding="utf-8")
        except OSError:
            with contextlib.suppress(OSError):
                lock_dir.rmdir()
            raise
        break
    try:
        yield
    finally:
        current = _room_lock_owner(owner_file)
        if current is not None and current.get("token") == token:
            with contextlib.suppress(OSError):
                owner_file.unlink()
                lock_dir.rmdir()


def _update_room_metadata(base: Path, room_id: str, **fields: str | None) -> dict[str, object] | None:
    with contextlib.suppress(OSError, ValueError):
        return room_store.set_metadata(base, room_id, **fields)
    return None


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
    import herdr_swarm_restore as restoration

    api = restoration.Herdr(herdr, environment)
    with restoration.operation_lock(base.parent, environment):
        state_path = restoration.state_path(base.parent, room, environment)
        record = restoration.load(state_path)
        if record:
            if (
                record.get("schema") != restoration.SCHEMA
                or record.get("host") != stdlib_socket.gethostname()
                or record.get("endpoint") != restoration.endpoint(environment)
                or record.get("room") != room
            ):
                return None
            try:
                owned = restoration.locate(record, api.panes())
                if owned:
                    state_path.with_suffix(".closed").unlink(missing_ok=True)
                    outcomes = restoration.restore(base.parent, environment, api, locked=True, only_room=room)
                    outcome = outcomes[0]["status"] if outcomes else "missing_pane"
                    if outcome in {"already_running", "restored", "submitted"}:
                        return owned["pane_id"]
                    if outcome == "launch_pending":
                        print(
                            "Swarm view previous launch is unconfirmed; close the swarm view and open it again to retry.",
                            file=sys.stderr,
                        )
                    return None
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                return None
        return _open_herdr_swarm_view_unlocked(
            herdr,
            room=room,
            cwd=cwd,
            coordinator_pane=coordinator_pane,
            workspace_id=workspace_id,
            environment=environment,
            base=base,
        )


def _previous_herdr_view(
    api: object,
    *,
    room: str,
    cwd: str | None,
    coordinator_pane: str,
    workspace_id: str | None,
    environment: dict[str, str],
    base: Path,
) -> tuple[Path, str, str] | None:
    """Find a previous room display attached to this coordinator."""
    import herdr_swarm_restore as restoration

    panes = api.panes()
    coordinator = next((pane for pane in panes if pane["pane_id"] == coordinator_pane), None)
    if not coordinator:
        return None
    cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
    candidates = []
    for path in sorted(restoration.state_directory(base.parent, environment).glob("*.json")):
        record = restoration.load(path)
        if not record or record.get("schema") != restoration.SCHEMA or record.get("room") == room:
            continue
        if (
            record.get("endpoint") != restoration.endpoint(environment)
            or record.get("host") != stdlib_socket.gethostname()
            or record.get("cli") != str(cli.resolve())
            or path.with_suffix(".closed").exists()
        ):
            continue
        old_room_id = record.get("room")
        if not isinstance(old_room_id, str):
            continue
        old_room = room_store.read_room(base, old_room_id)
        if not old_room or old_room.get("herdrCoordinatorPaneId") != coordinator_pane:
            continue
        if old_room.get("herdrWorkspaceId") and old_room["herdrWorkspaceId"] != workspace_id:
            continue
        if cwd and Path(str(old_room.get("cwd", ""))).resolve() != Path(cwd).resolve():
            continue
        owned = restoration.locate(record, panes)
        if not owned:
            continue
        if coordinator.get("tab_id") and owned.get("tab_id") and coordinator["tab_id"] != owned["tab_id"]:
            continue
        if not restoration.view_process(api.processes(owned["pane_id"]), cli, old_room_id):
            continue
        candidates.append((path, owned["pane_id"], old_room_id))
    if len(candidates) > 1:
        raise ValueError("several room views match this coordinator")
    return next(iter(candidates), None)


def _open_herdr_swarm_view_unlocked(
    herdr: str,
    *,
    room: str,
    cwd: str | None,
    coordinator_pane: str,
    workspace_id: str | None,
    environment: dict[str, str],
    base: Path,
    is_coordinator: bool = True,
) -> str | None:
    import herdr_swarm_restore as restoration

    api = restoration.Herdr(herdr, environment)
    cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
    state = restoration.state_path(base.parent, room, environment)
    try:
        previous = None
        if is_coordinator:
            previous = _previous_herdr_view(
                api,
                room=room,
                cwd=cwd,
                coordinator_pane=coordinator_pane,
                workspace_id=workspace_id,
                environment=environment,
                base=base,
            )
        opened = api.call(
            "plugin",
            "pane",
            "open",
            "--plugin",
            "orkest.swarms",
            "--entrypoint",
            "room",
            "--target-pane",
            coordinator_pane,
            "--direction",
            "right",
            "--no-focus",
            "--cwd",
            cwd or os.getcwd(),
            "--env",
            f"ORKEST_SWARM_ROOM={room}",
            "--env",
            f"ORKEST_HERDR_VIEW_STATE={state}",
            "--env",
            f"ORCHESTRATE_HOME={base.parent}",
        )
        plugin_pane = opened["plugin_pane"]
        if plugin_pane["plugin_id"] != "orkest.swarms" or plugin_pane["entrypoint"] != "room":
            return None
        view_pane_id = plugin_pane["pane"]["pane_id"]
    except (KeyError, TypeError, OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Herdr could not open the room view: {error}", file=sys.stderr)
        return None
    try:
        restoration.prepare(base.parent, room, view_pane_id, cli, environment, api)
        deadline = time.monotonic() + 8
        while not restoration.view_process(api.processes(view_pane_id), cli, room):
            if time.monotonic() >= deadline:
                raise RuntimeError("room view did not start")
            time.sleep(0.1)
        if previous:
            old_state, old_pane, old_room = previous
            if restoration.view_process(api.processes(old_pane), cli, old_room):
                api.call("pane", "close", old_pane)
            old_state.with_suffix(".closed").touch(mode=0o600)
            _update_room_metadata(base, old_room, herdrViewPaneId=None)
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Herdr room view setup failed: {error}", file=sys.stderr)
        try:
            api.call("plugin", "pane", "close", view_pane_id)
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as rollback_error:
            print(f"Check Herdr pane {view_pane_id} for room {room}: {rollback_error}", file=sys.stderr)
        else:
            if state.exists():
                state.with_suffix(".closed").touch(mode=0o600)
        return None
    _update_room_metadata(
        base,
        room,
        herdrViewPaneId=view_pane_id,
        herdrEndpoint=restoration.endpoint(environment),
        **({"herdrCoordinatorPaneId": coordinator_pane} if is_coordinator else {}),
        **({"herdrWorkspaceId": workspace_id} if is_coordinator and workspace_id else {}),
    )
    return view_pane_id


def _find_herdr_peer(
    base: Path, session_id: str | None, pane_id: str, *, endpoint: str | None = None
) -> dict[str, object] | None:
    if session_id:
        with contextlib.suppress(Exception):
            peer = mailbox.session_peer(base, session_id)
            if (
                isinstance(peer, dict)
                and mailbox.is_live(peer)
                and not peer.get("isSubagent")
                and not peer.get("delegatedRun")
                and not peer.get("run")
                and not peer["session"].startswith("run-")
                and (endpoint is None or peer.get("herdrEndpoint") == endpoint)
            ):
                return peer
    if not pane_id:
        return None
    best: dict[str, object] | None = None
    with contextlib.suppress(OSError):
        for path in sorted((base / "peers").glob("*.json")):
            peer = mailbox.load(path)
            if not isinstance(peer, dict) or not mailbox.valid_peer(peer):
                continue
            if (
                not mailbox.is_live(peer)
                or peer.get("isSubagent")
                or peer.get("delegatedRun")
                or peer.get("run")
                or peer["session"].startswith("run-")
            ):
                continue
            if peer.get("herdrPaneId") != pane_id:
                continue
            if endpoint is not None and peer.get("herdrEndpoint") != endpoint:
                continue
            if best is None or str(peer.get("lastSeenAt", "")) >= str(best.get("lastSeenAt", "")):
                best = peer
    return best


def _find_herdr_room(base: Path, pane_id: str, *, endpoint: str | None = None) -> str:
    if not pane_id:
        return ""
    best_id = ""
    best_updated = -1
    with contextlib.suppress(OSError):
        for room in room_store.list_rooms(base):
            if not isinstance(room, dict) or (
                room.get("herdrCoordinatorPaneId") != pane_id and room.get("herdrViewPaneId") != pane_id
            ):
                continue
            if endpoint is not None and room.get("herdrEndpoint") != endpoint:
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
                existing = room_store.read_room(base, current_room)
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
    import herdr_swarm_restore as restoration

    with restoration.operation_lock(base.parent, dict(os.environ)):
        return _toggle_herdr_swarm_view_unlocked(
            action,
            herdr=herdr,
            room=room,
            session_id=session_id,
            harness=harness,
            cwd=cwd,
            base=base,
        )


def _toggle_herdr_swarm_view_unlocked(
    action: str,
    *,
    herdr: str,
    room: str | None = None,
    session_id: str | None = None,
    harness: str | None = None,
    cwd: str | None = None,
    base: Path,
) -> dict[str, str]:
    coordinator_pane, workspace_id, context_cwd = _resolve_herdr_context()
    import herdr_swarm_restore as restoration

    current_endpoint = restoration.endpoint(dict(os.environ))
    if not cwd and context_cwd:
        cwd = context_cwd
    if not session_id and coordinator_pane:
        api = restoration.Herdr(herdr, dict(os.environ))
        with contextlib.suppress(OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
            pane = api.call("pane", "current", "--pane", coordinator_pane).get("pane") or {}
            ref = pane.get("agent_session") or {}
            if ref.get("kind") == "id" and isinstance(ref.get("value"), str):
                session_id = ref["value"]
                harness = harness or {"agy": "gemini"}.get(ref.get("agent"), ref.get("agent"))
    peer = _find_herdr_peer(base, session_id, coordinator_pane, endpoint=current_endpoint)
    if peer and session_id and peer.get("session") != session_id and session_id not in mailbox.native_session_ids(peer):
        peer = None
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
    # Pane IDs survive new conversations; they cannot identify a known session's room.
    if not current_room and coordinator_pane and not session_id:
        current_room = _find_herdr_room(base, coordinator_pane, endpoint=current_endpoint)
    if action == "close" and not current_room:
        return {"status": "already_closed", "backend": "herdr"}
    if current_room:
        with contextlib.suppress(ValueError):
            existing_room = room_store.read_room(base, current_room)
            if isinstance(existing_room, dict) and existing_room.get("herdrEndpoint") not in (None, current_endpoint):
                return {
                    "status": "error",
                    "reason": "swarm room belongs to another Herdr server",
                    "room": current_room,
                    "backend": "herdr",
                }
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
        room_data = room_store.read_room(base, current_room)
    recorded_view_pane = (
        room_data.get("herdrViewPaneId")
        if isinstance(room_data, dict) and isinstance(room_data.get("herdrViewPaneId"), str)
        else None
    )
    recorded_coord_pane = (
        room_data.get("herdrCoordinatorPaneId")
        if isinstance(room_data, dict) and isinstance(room_data.get("herdrCoordinatorPaneId"), str)
        else None
    )
    if recorded_view_pane == coordinator_pane:
        if recorded_coord_pane and recorded_coord_pane != coordinator_pane:
            coordinator_pane = recorded_coord_pane
        else:
            recorded_view_pane = None
    effective_workspace = workspace_id or (
        room_data.get("herdrWorkspaceId")
        if isinstance(room_data, dict) and isinstance(room_data.get("herdrWorkspaceId"), str)
        else None
    )
    state_path = restoration.state_path(base.parent, current_room, environment)
    record = restoration.load(state_path)
    if record:
        if (
            record.get("schema") != restoration.SCHEMA
            or record.get("endpoint") != restoration.endpoint(environment)
            or record.get("host") != stdlib_socket.gethostname()
            or record.get("room") != current_room
        ):
            return {
                "status": "error",
                "reason": "swarm pane ownership record does not match",
                "room": current_room,
                "backend": "herdr",
            }
        api = restoration.Herdr(herdr, environment)
        try:
            owned = restoration.locate(record, api.panes())
            recorded_view_pane = owned["pane_id"] if owned else None
            if owned:
                info = api.processes(owned["pane_id"])
                cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
                if not restoration.view_process(info, cli, current_room) and not restoration.idle_shell(info):
                    return {
                        "status": "error",
                        "reason": "swarm pane is busy or ownership is unknown",
                        "room": current_room,
                        "backend": "herdr",
                    }
                if (
                    action == "open" or (action == "toggle" and state_path.with_suffix(".closed").exists())
                ) and restoration.idle_shell(info):
                    state_path.with_suffix(".closed").unlink(missing_ok=True)
                    outcomes = restoration.restore(base.parent, environment, api, locked=True, only_room=current_room)
                    outcome = outcomes[0]["status"] if outcomes else "missing_pane"
                    status = "error"
                    if outcome == "restored":
                        status = "opened"
                    elif outcome == "submitted":
                        status = "starting"
                    if outcome == "launch_pending":
                        return {
                            "status": "error",
                            "reason": "previous launch is unconfirmed; close the swarm view and open it again to retry",
                            "room": current_room,
                            "backend": "herdr",
                        }
                    return {"status": status, "room": current_room, "backend": "herdr", "pane": recorded_view_pane}
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
            return {
                "status": "error",
                "reason": "could not verify the swarm pane",
                "room": current_room,
                "backend": "herdr",
            }
    elif recorded_view_pane:
        try:
            api = restoration.Herdr(herdr, environment)
            cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
            if not restoration.view_process(api.processes(recorded_view_pane), cli, current_room):
                recorded_view_pane = None
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
            return {
                "status": "error",
                "reason": "could not verify the swarm pane",
                "room": current_room,
                "backend": "herdr",
            }
    if recorded_view_pane and action in ("toggle", "close"):
        closed = subprocess.run(
            [herdr, "pane", "close", recorded_view_pane],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        if closed.returncode != 0:
            closed = subprocess.run(
                [herdr, "plugin", "pane", "close", recorded_view_pane],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
        if closed.returncode != 0:
            return {
                "status": "error",
                "reason": "could not close the swarm pane",
                "room": current_room,
                "backend": "herdr",
            }
        if record:
            state_path.with_suffix(".closed").touch(mode=0o600)
        _update_room_metadata(base, current_room, herdrViewPaneId=None)
        return {"status": "closed", "room": current_room, "backend": "herdr", "pane": recorded_view_pane}
    if not recorded_view_pane and action == "close":
        if record:
            state_path.with_suffix(".closed").touch(mode=0o600)
        if isinstance(room_data, dict) and room_data.get("herdrViewPaneId"):
            _update_room_metadata(base, current_room, herdrViewPaneId=None)
        return {"status": "already_closed", "room": current_room, "backend": "herdr"}
    if recorded_view_pane and action == "open":
        return {"status": "already_open", "room": current_room, "backend": "herdr", "pane": recorded_view_pane}
    pane_id = _open_herdr_swarm_view_unlocked(
        herdr,
        room=current_room,
        cwd=cwd,
        coordinator_pane=coordinator_pane,
        workspace_id=effective_workspace,
        environment=environment,
        base=base,
        is_coordinator=not recorded_coord_pane or recorded_coord_pane == coordinator_pane,
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
    if os.environ.get("HERDR_ENV") == "1":
        herdr = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
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
        return {"status": "unavailable", "reason": "Herdr is not installed on PATH", "backend": "herdr"}
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
            peer = mailbox.session_peer(base, session_id)
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
    resume_swarm = False
    resumed_session = None
    if arguments[:1] in (["--room"], ["--attach-room"], ["--resume-swarm"], ["--cwd"]):
        parser = argparse.ArgumentParser(description="Open an Orkest coordinator and swarm view")
        source = parser.add_mutually_exclusive_group()
        source.add_argument("--room")
        source.add_argument("--resume-swarm", action="store_true")
        source.add_argument("--attach-room")
        parser.add_argument("--cwd")
        parser.add_argument("--lines", type=int, choices=(1, 2), default=lines)
        parser.add_argument("command", nargs=argparse.REMAINDER)
        args = parser.parse_args(arguments)
        room, cwd, attach, lines = args.room or args.attach_room, args.cwd, bool(args.attach_room), args.lines
        resume_swarm = args.resume_swarm
        arguments = args.command
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("ork label needs an interactive terminal", file=sys.stderr)
        return 2
    herdr_active = os.environ.get("HERDR_ENV") == "1"
    if attach and herdr_active and room:
        herdr = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
        room_data = None
        with contextlib.suppress(ValueError):
            room_data = room_store.read_room(mailbox.root(), room)
        coord_pane = (
            room_data.get("herdrCoordinatorPaneId")
            if isinstance(room_data, dict) and isinstance(room_data.get("herdrCoordinatorPaneId"), str)
            else None
        )
        import herdr_swarm_restore as restoration

        room_endpoint = room_data.get("herdrEndpoint") if isinstance(room_data, dict) else None
        conductor = room_data.get("conductor") if isinstance(room_data, dict) else None
        binding = conductor.get("session") if isinstance(conductor, dict) else None
        coordinator_session = binding.get("id") if isinstance(binding, dict) else None
        if (
            herdr
            and coord_pane
            and room_endpoint in (None, restoration.endpoint(dict(os.environ)))
            and isinstance(coordinator_session, str)
        ):
            agent = verified_agent(herdr, coord_pane, {coordinator_session})
            if agent:
                return subprocess.run([herdr, "agent", "focus", agent["pane_id"]], check=False).returncode
        print("This swarm has no live coordinator terminal. Use --view to inspect its recorded work.", file=sys.stderr)
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
        resumed_session = extract_resumed_session_id(command)
        resume_swarm = (
            resume_swarm
            or bool(resumed_session)
            or any(
                flag in command[1:]
                for flag in ("--resume", "--continue", "-r", "resume", *(() if harness == "codex" else ("-c",)))
            )
        )
        if not room and resumed_session:
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
                member = (
                    matched.get("conductor")
                    if matched.get("_matchedMemberId") == "conductor"
                    else next(
                        (
                            agent
                            for agent in matched.get("agents", [])
                            if agent.get("id") == matched.get("_matchedMemberId")
                        ),
                        None,
                    )
                )
                # This lookup precedes registration of a new process. Even an
                # exact resume target is unavailable while its owner is live.
                if member and not mailbox.room_session_peers(base_dir, matched, member):
                    room = matched["id"]
        if resume_swarm and room:
            base_dir = mailbox.root()
            selected = room_store.read_room(base_dir, room)
            if isinstance(selected, dict) and (
                not mailbox.local_session_binding(selected, selected.get("conductor") or {})
                or mailbox.room_session_peers(base_dir, selected, selected.get("conductor") or {})
            ):
                room = None
        if herdr_active:
            import herdr_swarm_restore as restoration

            environment = dict(os.environ)
            environment.pop("TMUX", None)
            environment.pop("TMUX_PANE", None)
            environment.pop("ORKEST_TERMINAL_SERVER", None)
            environment.pop("HERDR_AGENT", None)
            environment["ORKEST_TERMINAL_HARNESS"] = harness
            if resume_swarm:
                environment.pop("ORKEST_SWARM_ROOM", None)
                environment["ORKEST_RESUME_SWARM"] = "1"
                if resumed_session:
                    environment["ORKEST_RESUME_TARGET"] = resumed_session
            if room:
                environment["ORKEST_SWARM_ROOM"] = room
                coordinator_pane = os.environ.get("HERDR_PANE_ID", "").strip()
                workspace_id = os.environ.get("HERDR_WORKSPACE_ID", "").strip() or None
                base_dir = mailbox.root()
                _update_room_metadata(
                    base_dir,
                    room,
                    herdrCoordinatorPaneId=coordinator_pane,
                    herdrEndpoint=restoration.endpoint(environment),
                    **({"herdrWorkspaceId": workspace_id} if workspace_id else {}),
                )
                herdr = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
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
            try:
                if cwd:
                    os.chdir(cwd)
                os.execvpe(command[0], command, environment)
            except OSError as error:
                print(f"Could not launch {command[0]} in Herdr: {error}", file=sys.stderr)
                return 2
        if Path(command[0]).name == "codex":
            # The private tmux footer identifies this conversation even when Codex shares a daemon.
            command = [command[0], "-c", 'tui.terminal_title=["session-id"]', *command[1:]]
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
    if resume_swarm:
        environment.pop("ORKEST_SWARM_ROOM", None)
        environment["ORKEST_RESUME_SWARM"] = "1"
        if resumed_session:
            environment["ORKEST_RESUME_TARGET"] = resumed_session
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
    toggle_args = ["--room", room] if herdr_active and room else ["--socket", socket]
    toggle_cmd = shlex.join([sys.executable, str(Path(__file__).resolve()), "--toggle-swarm", "toggle", *toggle_args])
    subprocess.run([*base, "bind-key", "-n", "M-s", "run-shell", "-b", toggle_cmd], env=environment, check=False)
    subprocess.run([*base, "bind-key", "-n", "C-M-s", "run-shell", "-b", toggle_cmd], env=environment, check=False)
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
    if herdr_active:
        # Set this only after the first client attaches: setting it on the
        # detached new session would destroy the session before launch.
        subprocess.run(
            [*base, "set-hook", "-t", session, "client-attached", "set-option -t orkest destroy-unattached on"],
            env=environment,
            check=False,
        )

    if room:
        subprocess.run([*base, "set-option", "-t", session, "@orkest_room", room], env=environment, check=True)
        if not herdr_active:
            cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
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
