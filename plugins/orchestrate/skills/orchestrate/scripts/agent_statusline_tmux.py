#!/usr/bin/env python3
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
    """Open, close, or toggle the live Swarm View split pane in an Orkest tmux session."""
    if action not in ("toggle", "open", "close"):
        raise ValueError(f"Unsupported swarm view action: {action}")
    tmux = shutil.which("tmux")
    if not tmux:
        return {"status": "unavailable", "reason": "tmux is not installed on PATH"}
    base = base or mailbox.root()
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
    command = arguments[1:] if arguments[:1] == ["--"] else arguments
    if not command or command == ["--help"]:
        print("Usage: ork label -- codex|claude|plaude|agy|opencode [arguments]")
        return 0 if command else 2
    harness = {"codex": "codex", "claude": "claude", "plaude": "claude", "agy": "gemini", "opencode": "opencode"}.get(
        Path(command[0]).name
    )
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
