#!/usr/bin/env python3
"""Launch a terminal harness with an Orkest status line in a private tmux session."""

from __future__ import annotations

import argparse
import hashlib
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


def main(arguments: list[str]) -> int:
    if not arguments or arguments == ["--help"]:
        print("Usage: ork label -- codex|claude|plaude|agy|opencode [arguments]")
        return 0 if arguments else 2
    room = None
    cwd = None
    attach = False
    if arguments[:1] in (["--room"], ["--attach-room"]):
        parser = argparse.ArgumentParser(description="Open an Orkest coordinator and swarm view")
        source = parser.add_mutually_exclusive_group(required=True)
        source.add_argument("--room")
        source.add_argument("--attach-room")
        parser.add_argument("--cwd")
        parser.add_argument("command", nargs=argparse.REMAINDER)
        args = parser.parse_args(arguments)
        room, cwd, attach = args.room or args.attach_room, args.cwd, bool(args.attach_room)
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
    pane = "#{@orkest_coordinator_pane}" if room else "#{pane_id}"
    status = f"#({invocation} {source} {pane} --width #{{client_width}} --tmux)"
    options = (
        ("@orkest_coordinator_pane", coordinator_pane),
        ("status-position", "bottom"),
        ("status-interval", "3"),
        ("status-style", "fg=default,bg=default"),
        ("status-format[0]", status),
    )
    for name, value in options:
        result = subprocess.run([*base, "set-option", "-t", session, name, value], env=environment, check=False)
        if result.returncode:
            print(f"Label setup failed. Reattach with: tmux -L {socket} attach -t {session}", file=sys.stderr)
            return result.returncode

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
