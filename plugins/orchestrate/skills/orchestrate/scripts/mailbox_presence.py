"""One durable notice when an interactive peer disappears; no wakes or ownership changes."""

from __future__ import annotations

import hashlib
import sys
import threading
from pathlib import Path
from typing import Any

import mailbox_channels as channels
import mailbox_tasks as tasks
import peer_mailbox as mailbox

CHECK_SECONDS = 15.0


def identity(peer: dict[str, Any]) -> dict[str, Any]:
    return {key: peer.get(key) for key in ("session", "startedAt", "lastSeenAt", "pid", "pidBirth")}


def reason(peer: dict[str, Any]) -> str:
    """Silence alone never establishes that a process exited, especially for shared hosts."""
    if mailbox.pid_alive(peer.get("pid")) is False:
        return "its recorded process exited; the cause is unknown"
    if peer.get("pidBirth") and isinstance(peer.get("pid"), int):
        birth = mailbox.process_started(peer["pid"])
        if birth and birth != peer["pidBirth"]:
            return "its recorded process exited and its process ID was reused"
    return "its presence expired; a process exit is not confirmed"


def checkpoint(base: Path, peer: dict[str, Any]) -> dict[str, Any] | None:
    note = mailbox.load(tasks.path_for(base, peer))
    return note if tasks.fresh(note) and note.get("status") != "complete" else None


def requests(base: Path, peer: dict[str, Any]) -> dict[str, list[str]]:
    """Unread direct mail, plus recent requests read but never answered. No channel chatter or notices."""
    answered = mailbox.replied_to(base, peer["session"])
    result: dict[str, list[str]] = {}
    for message in mailbox.messages(base, peer["session"], unread_only=False):
        sender = message["from"]["session"]
        if sender in (peer["session"], mailbox.MAILBOX_SENDER["session"]) or message.get("channel"):
            continue
        if message.get("kind") in {"reply", "update", "notice"} or message["id"] in answered:
            continue
        age = mailbox.now() - mailbox.parse_stamp(message["sentAt"])
        if age > mailbox.MAX_AGE or (message.get("readAt") and age > mailbox.OPEN_REQUEST_WINDOW):
            continue
        result.setdefault(sender, []).append(message["id"])
    return result


def record(base: Path, peer: dict[str, Any]) -> None:
    """Called under the peer lock, before deleting presence. Freeze recipients and notification IDs."""
    observed = identity(peer)
    key = hashlib.sha256(repr(observed).encode()).hexdigest()
    path = base / "presence-events" / f"{key}.json"
    with mailbox.locked(base / "presence-events" / "store"):
        if path.exists():
            return
        note = checkpoint(base, peer)
        waiting = requests(base, peer)
        memberships = set(channels.memberships(peer))
        deliveries = []
        explanation = reason(peer)
        for recipient_path in sorted((base / "peers").glob("*.json")):
            recipient = mailbox.load(recipient_path)
            if (
                not mailbox.valid_peer(recipient)
                or mailbox.is_run_peer(recipient)
                or recipient["session"] == peer["session"]
                or not mailbox.is_live(recipient)
            ):
                continue
            same_project = mailbox.same_project(peer, recipient)
            related = same_project and (
                bool(memberships.intersection(channels.memberships(recipient)))
                if memberships
                else not channels.memberships(recipient)
                and (peer.get("checkout") or peer["cwd"]) == (recipient.get("checkout") or recipient["cwd"])
            )
            pending = waiting.get(recipient["session"], [])
            if not pending and not (note and related):
                continue
            text = f"{peer['name']} is no longer present: {explanation}."
            if pending:
                text += f" {len(pending)} request(s) may be unfinished; receipt alone does not confirm completion."
            if note and same_project:
                text += f" Last saved task: {note['task']}."
                if note.get("next"):
                    text += f" Next: {note['next']}."
                text += f" Read mailbox tasks for session {peer['session']} and verify the checkout before continuing."
            text += " This notice does not transfer ownership."
            deliveries.append(
                {
                    "schema": mailbox.MAIL_SCHEMA,
                    "id": mailbox.message_id(),
                    "from": {
                        **(mailbox.sender_address(peer) if same_project else {}),
                        **mailbox.MAILBOX_SENDER,
                    },
                    "to": {"session": recipient["session"], "name": recipient["name"]},
                    "text": text,
                    "replyTo": pending[-1] if pending else None,
                    "sentAt": mailbox.stamp(),
                    "readAt": None,
                    "scope": "project" if same_project else "cross-project",
                    "kind": "notice",
                    "presenceNotice": True,
                    "wake": False,
                }
            )
        mailbox.write(path, {"source": observed, "observedAt": mailbox.stamp(), "deliveries": deliveries})


def deliver(base: Path) -> None:
    """Replay interrupted deliveries without resurrecting acknowledged mail. Retain receipts for seven days."""
    with mailbox.locked(base / "presence-events" / "store"):
        for path in sorted((base / "presence-events").glob("*.json")):
            event = mailbox.load(path)
            if not event or not mailbox.valid_stamp(event.get("observedAt")):
                continue
            if mailbox.now() - mailbox.parse_stamp(event["observedAt"]) > mailbox.MAX_AGE:
                path.unlink(missing_ok=True)
                continue
            if not event.get("deliveries"):
                continue
            source = event["source"]
            current = mailbox.load(mailbox.peer_path(base, source["session"]))
            if mailbox.valid_peer(current) and (identity(current) != source or mailbox.is_live(current)):
                event["deliveries"] = []  # it resumed before delivery; do not announce a stale absence
            else:
                for message in event["deliveries"]:
                    target = mailbox.load(mailbox.peer_path(base, message["to"]["session"]))
                    if (
                        not mailbox.valid_peer(target)
                        or not mailbox.is_live(target)
                        or not mailbox.allowed_message(target, message, "project")
                    ):
                        continue
                    destination = mailbox.inbox_dir(base, target["session"]) / f"{message['id']}.json"
                    with mailbox.locked(destination):
                        if not destination.exists():
                            mailbox.write(destination, message)
                event["deliveries"] = []
            mailbox.write(path, event)


def reconcile(base: Path) -> None:
    for path in sorted((base / "peers").glob("*.json")):
        mailbox.drop_if_dead(path, mailbox.now())
    deliver(base)


def run(base: Path, stopping: threading.Event) -> None:
    while not stopping.wait(CHECK_SECONDS):
        try:
            reconcile(base)
        except Exception as error:  # noqa: BLE001 -- one failed storage operation must not stop monitoring
            print(f"mailbox presence: {error}", file=sys.stderr, flush=True)
