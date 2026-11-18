#!/usr/bin/env python3
"""Read bound interactive swarm sessions using the shared footer's status projection."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import peer_mailbox as mailbox
import runtime_paths


def _statusline_identity(session: str, harness: str, base: Path) -> dict | None:
    fast_bin = runtime_paths.ork_fast_bin()
    if fast_bin is None:
        return None
    env = runtime_paths.set_home_env(dict(os.environ), base.parent)
    try:
        completed = subprocess.run(
            [str(fast_bin), "statusline", "--session", session, "--harness", harness, "--json"],
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    raw = (completed.stdout or "").strip()
    if completed.returncode != 0 or not raw:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) and parsed else None


def snapshot(room: dict, base: Path) -> dict:
    result = {}
    for member in [{**room.get("conductor", {}), "id": "conductor"}, *room.get("agents", [])]:
        binding = member.get("session")
        if not binding and member.get("mailboxSession"):
            binding = {"id": member["mailboxSession"], "engine": member["engine"], "machine": room.get("machine")}
        if not binding:
            continue
        harness = {"agy": "gemini"}.get(binding["engine"], binding["engine"])
        try:
            expected_cwd = Path(binding.get("cwd") or member.get("cwd") or room["cwd"]).resolve()
            peer = mailbox.room_session_peer(base, room, member)
            peer_cwd = (
                Path(peer.get("checkout") or peer["cwd"]).resolve()
                if isinstance(peer, dict) and (peer.get("checkout") or peer.get("cwd"))
                else None
            )
            if (
                not mailbox.valid_peer(peer)
                or not mailbox.is_live(peer)
                or binding.get("machine") != socket.gethostname()
                or (peer_cwd != expected_cwd and peer_cwd != Path(room["cwd"]).resolve())
            ):
                continue
            item = _statusline_identity(peer["session"], harness, base)
            if item:
                result[member["id"]] = item
        except (OSError, ValueError, mailbox.MailboxError):
            continue
    return result


if __name__ == "__main__":
    request = json.load(sys.stdin)
    print(json.dumps(snapshot(request["room"], Path(request["root"]))))
