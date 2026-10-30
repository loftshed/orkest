#!/usr/bin/env python3
"""Launch a terminal harness with an Orkest status line in a private tmux session."""

from __future__ import annotations

import os
import secrets
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


def main(arguments: list[str]) -> int:
    command = arguments[1:] if arguments[:1] == ["--"] else arguments
    if not command or command == ["--help"]:
        print("Usage: ork label -- codex [arguments]")
        return 0 if command else 2
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("ork label needs an interactive terminal", file=sys.stderr)
        return 2
    tmux = shutil.which("tmux")
    if not tmux:
        print("ork label needs tmux on PATH", file=sys.stderr)
        return 2
    socket = f"orkest-label-{secrets.token_hex(6)}"
    session = "orkest"
    environment = dict(os.environ)
    # A private server must not inherit the enclosing tmux client's socket.
    environment.pop("TMUX", None)
    environment.pop("TMUX_PANE", None)
    base = [tmux, "-L", socket]
    columns, rows = shutil.get_terminal_size((80, 24))
    create = subprocess.run(
        [
            *base,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            session,
            "-x",
            str(columns),
            "-y",
            str(rows),
            "--",
            *command,
        ],
        env=environment,
        check=False,
    )
    if create.returncode:
        return create.returncode

    script = Path(__file__).with_name("agent_statusline.py")
    invocation = shlex.join([sys.executable, str(script)]).replace("#", "##")
    status = f"#({invocation} --pane-pid #{{pane_pid}} --width #{{client_width}} --harness codex --tmux)"
    options = (
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

    result = subprocess.run([*base, "attach-session", "-t", session], env=environment, check=False)
    still_running = subprocess.run(
        [*base, "has-session", "-t", session], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    if still_running.returncode == 0:
        print(f"Session detached. Reattach with: tmux -L {socket} attach -t {session}")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
