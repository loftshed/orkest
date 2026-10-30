#!/usr/bin/env python3
"""Read bound interactive swarm sessions using the shared footer's status projection."""

from __future__ import annotations

import json
import socket
import sys
from pathlib import Path

import agent_statusline
import peer_mailbox as mailbox


def snapshot(room: dict, base: Path) -> dict:
    result = {}
    for member in [{**room.get("conductor", {}), "id": "conductor"}, *room.get("agents", [])]:
        binding = member.get("session")
        if not binding and member.get("mailboxSession"):
            binding = {"id": member["mailboxSession"], "engine": member["engine"], "machine": room.get("machine")}
        if not binding:
            continue
        session = binding["id"]
        harness = {"agy": "gemini"}.get(binding["engine"], binding["engine"])
        try:
            peer = mailbox.load(mailbox.peer_path(base, session))
            if (
                not mailbox.valid_peer(peer)
                or not mailbox.is_live(peer)
                or binding.get("machine") != socket.gethostname()
                or Path(peer.get("checkout") or peer["cwd"]).resolve() != Path(room["cwd"]).resolve()
            ):
                continue
            item = agent_statusline.identity(session, harness, base=base)
            if item:
                result[member["id"]] = item
        except (OSError, ValueError, mailbox.MailboxError):
            continue
    return result


if __name__ == "__main__":
    request = json.load(sys.stdin)
    print(json.dumps(snapshot(request["room"], Path(request["root"]))))
