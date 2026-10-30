"""Bind a visible native session to its private Orkest tmux pane, without changing presence."""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any

import peer_mailbox as mailbox


def context(harness: str | None) -> tuple[str, str] | None:
    server = os.environ.get("ORKEST_TERMINAL_SERVER", "")
    pane = os.environ.get("TMUX_PANE", "")
    socket = os.environ.get("TMUX", "").split(",", 1)[0]
    if (
        not re.fullmatch(r"orkest-label-[0-9a-f]{12}", server)
        or not re.fullmatch(r"%[0-9]+", pane)
        or Path(socket).name != server
        or harness != os.environ.get("ORKEST_TERMINAL_HARNESS")
    ):
        return None
    return server, pane


def bind(session: str, harness: str | None, payload: dict[str, Any]) -> bool:
    target = context(harness)
    if not target:
        return False
    try:
        mailbox.session_key(session)
        # Only display metadata crosses into the pane; never retain the native session payload.
        fields = {}
        for key in ("model", "effort", "effortLevel", "reasoning_effort"):
            value = payload.get(key)
            if isinstance(value, str):
                fields[key] = value[:240]
            elif isinstance(value, dict):
                fields[key] = {
                    k: v[:240]
                    for k, v in value.items()
                    if k in {"id", "display_name", "effort", "level"} and isinstance(v, str)
                }
        server, pane = target
        binding = json.dumps({"session": session, "harness": harness, "payload": fields})
        subprocess.run(
            [
                "tmux",
                "-L",
                server,
                "set-option",
                "-p",
                "-t",
                pane,
                "@orkest_identity",
                binding,
                ";",
                "set-option",
                "-p",
                "-t",
                pane,
                "@orkest_session",
                session,
            ],
            capture_output=True,
            timeout=2,
            check=True,
        )
        return True
    except (mailbox.MailboxError, OSError, subprocess.SubprocessError):
        return False


def read(server: str, pane: str, harness: str) -> dict[str, Any] | None:
    if not re.fullmatch(r"orkest-label-[0-9a-f]{12}", server) or not re.fullmatch(r"%[0-9]+", pane):
        return None
    try:
        output = subprocess.run(
            ["tmux", "-L", server, "display-message", "-p", "-t", pane, "#{@orkest_session}\n#{@orkest_identity}"],
            capture_output=True,
            text=True,
            timeout=2,
            check=True,
        ).stdout
        if len(output) > 8192:
            return None
        session, raw = output.split("\n", 1)
        mailbox.session_key(session)
        data = json.loads(raw)
        if (
            isinstance(data, dict)
            and data.get("session") == session
            and data.get("harness") == harness
            and isinstance(data.get("payload"), dict)
        ):
            return data
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def clear(session: str, harness: str | None) -> None:
    target = context(harness)
    if not target:
        return
    try:
        mailbox.session_key(session)
        server, pane = target
        # The comparison and unset happen in tmux, so a late cleanup cannot clear a newer session.
        subprocess.run(
            [
                "tmux",
                "-L",
                server,
                "if-shell",
                "-F",
                "-t",
                pane,
                f"#{{==:#{{@orkest_session}},{session}}}",
                shlex.join(["set-option", "-p", "-u", "-t", pane, "@orkest_session"]),
            ],
            capture_output=True,
            timeout=2,
            check=True,
        )
    except (mailbox.MailboxError, OSError, subprocess.SubprocessError):
        pass
