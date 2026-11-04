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
import subprocess
import sys
from pathlib import Path

import peer_mailbox as mailbox


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
    return not socket and os.environ.get("HERDR_ENV") == "1" and bool(os.environ.get("HERDR_PANE_ID", "").strip())


def _room_path(base: Path, room_id: str) -> Path:
    if not re.fullmatch(r"[\w-]{1,80}", room_id, flags=re.ASCII):
        raise ValueError("Invalid swarm room ID")
    return base / "rooms" / f"{room_id}.json"


def _update_room_metadata(base: Path, room_id: str, **fields: str | None) -> dict[str, object] | None:
    try:
        path = _room_path(base, room_id)
    except ValueError:
        return None
    data = mailbox.load(path)
    if not isinstance(data, dict):
        return None
    for key, value in fields.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    with contextlib.suppress(OSError):
        mailbox.write(path, data)
    return data


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
            "stooges",
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
            if isinstance(peer, dict):
                return peer
    if not pane_id:
        return None
    best: dict[str, object] | None = None
    with contextlib.suppress(OSError):
        for path in sorted((base / "peers").glob("*.json")):
            peer = mailbox.load(path)
            if not isinstance(peer, dict) or not mailbox.valid_peer(peer):
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
    cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
    engine = {"gemini": "agy", "agy": "agy", "claude": "claude", "codex": "codex", "opencode": "opencode"}.get(
        harness or "", "codex"
    )
    if not current_room:
        target_cwd = cwd or os.getcwd()
        created = subprocess.run(
            [shutil.which("node") or "node", str(cli), "stooges", "--engine", engine, "--cwd", target_cwd, "--json"],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        if created.returncode != 0:
            return {"status": "error", "reason": created.stderr.strip() or "could not create swarm room"}
        current_room = json.loads(created.stdout)["id"]
    if session_id and current_room:
        subprocess.run(
            [
                shutil.which("node") or "node",
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
    current_room = (
        subprocess.run(
            [*tmux_cmd, "show-option", "-t", "orkest", "-v", "@orkest_room"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
        or room
        or os.environ.get("ORKEST_SWARM_ROOM", "").strip()
    )
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
    if not current_room and isinstance(peer, dict) and mailbox.valid_peer(peer):
        import agent_statusline

        bound = agent_statusline.bound_rooms(base, peer)
        if bound:
            current_room = bound[0][0]["id"]
    engine = {"gemini": "agy", "agy": "agy", "claude": "claude", "codex": "codex", "opencode": "opencode"}.get(
        harness or "", "codex"
    )
    if not current_room:
        target_cwd = cwd or os.getcwd()
        created = subprocess.run(
            [shutil.which("node") or "node", str(cli), "stooges", "--engine", engine, "--cwd", target_cwd, "--json"],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        if created.returncode != 0:
            return {"status": "error", "reason": created.stderr.strip() or "could not create swarm room"}
        current_room = json.loads(created.stdout)["id"]
    if session_id and current_room:
        subprocess.run(
            [
                shutil.which("node") or "node",
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
            "stooges",
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
                "stooges",
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
        reconnect = f"ork stooges --attach-room {room}" if room else f"tmux -L {socket} attach -t {session}"
        print(f"Session detached. Reattach with: {reconnect}")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
