"""A bounded, read-only status line for Herdr's focused pane."""

import contextlib
import json
import os
import shutil
import subprocess
import time

import agent_progress
import peer_mailbox as mailbox
from herdr_context import endpoint
from herdr_labels import codex_title_session, display_label, plain, work_title


def status() -> str:
    deadline = time.monotonic() + 0.18
    pane_id = os.environ.get("HERDR_ACTIVE_PANE_ID", "").strip()
    binary = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
    if not pane_id or not binary:
        return ""
    response = subprocess.run(
        [binary, "pane", "current", "--pane", pane_id], capture_output=True, text=True, timeout=0.1, check=False
    )
    if response.returncode:
        return ""
    pane = json.loads(response.stdout).get("result", {}).get("pane", {})
    if not pane.get("agent"):
        return ""
    base = mailbox.root()
    peers = []
    codex_sessions = set()
    for path in (base / "peers").glob("*.json"):
        if time.monotonic() >= deadline:
            return ""
        peer = mailbox.load(path)
        if mailbox.valid_peer(peer) and peer.get("harness") == "codex":
            codex_sessions.add(peer["session"])
        if (
            mailbox.valid_peer(peer)
            and not peer.get("isSubagent")
            and not peer.get("delegatedRun")
            and peer.get("herdrPaneId") == pane.get("pane_id")
            and peer.get("herdrEndpoint") == endpoint(dict(os.environ))
            and mailbox.is_live(peer)
        ):
            peers.append(peer)
    ref = pane.get("agent_session") or {}
    if ref.get("kind") == "id" and ref.get("agent") == pane.get("agent"):
        matches = [
            peer for peer in peers if peer["session"] == ref.get("value") and peer["harness"] == ref.get("agent")
        ]
    elif pane.get("agent") == "codex" and not ref:
        session = codex_title_session(pane.get("terminal_title"), codex_sessions)
        matches = [peer for peer in peers if peer["session"] == session and peer["harness"] == "codex"]
    else:
        return ""
    if len(matches) != 1 or time.monotonic() >= deadline:
        return ""
    peer = matches[0]
    title = work_title(agent_progress.read(base, peer) or {})
    return plain(" · ".join(part for part in (display_label(peer), title) if part))


def main() -> int:
    line = ""
    with contextlib.suppress(OSError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
        line = status()
    print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
