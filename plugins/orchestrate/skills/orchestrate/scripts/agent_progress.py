#!/usr/bin/env python3
"""Record a session's display context without claiming work or changing workboard state."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shlex
import socket
import sys
from pathlib import Path
from typing import Any

import mailbox_work
import peer_mailbox as mailbox

SCHEMA = "orchestrate.progress.v1"
STAGES = ("planning", "working", "testing", "review", "blocked", "complete")
STALE_AFTER = dt.timedelta(minutes=30)
REMIND_AFTER = dt.timedelta(minutes=5)


def record_path(base: Path, session: str) -> Path:
    return base / "progress" / f"{mailbox.session_key(session)}.json"


def work_context(assignments: list[dict[str, Any]]) -> str | None:
    """Bind a report to the active work identities, including an empty assignment set."""
    if not assignments:
        return None
    return hashlib.sha256(json.dumps(sorted(item["id"] for item in assignments)).encode()).hexdigest()


def read(base: Path, peer: dict[str, Any]) -> dict[str, Any] | None:
    """Ignore malformed records and context from another checkout, account or harness."""
    try:
        path = record_path(base, peer["session"])
        if not path.exists() or path.stat().st_size > 8192:
            return None
        row = mailbox.load(path)
        if (
            not isinstance(row, dict)
            or row.get("schema") != SCHEMA
            or row.get("session") != peer["session"]
            or row.get("harness") != peer["harness"]
            or row.get("machine") != socket.gethostname()
            or row.get("accountHome") != peer.get("accountHome")
            or row.get("checkout") != str(Path(peer.get("checkout") or peer["cwd"]).resolve())
            or row.get("stage") not in STAGES
            or not mailbox.valid_stamp(row.get("updatedAt"))
            or any(
                not isinstance(row.get(key), str) or not row[key].strip() or len(row[key]) > 160
                for key in ("goal", "task")
            )
        ):
            return None
        age = mailbox.now() - mailbox.parse_stamp(row["updatedAt"])
        if age < -dt.timedelta(minutes=5):
            return None
        return {**row, "stale": row["stage"] != "complete" and age > STALE_AFTER}
    except (OSError, TypeError, ValueError, RuntimeError):
        return None


def report(
    base: Path, peer: dict[str, Any], *, goal: str | None, task: str | None, stage: str | None
) -> dict[str, Any]:
    path = record_path(base, peer["session"])
    with mailbox.locked(path):
        previous = read(base, peer) or {}
        context = work_context(mailbox_work.assigned(base, peer))
        if previous.get("workContext") != context:
            previous = {}  # Changed assignments require fresh context, even when their titles match.
        if task is not None and task != previous.get("task") and stage is None:
            raise mailbox.MailboxError("changing the task requires --stage so the previous task's phase is not reused")
        fields = {
            key: value if value is not None else previous.get(key)
            for key, value in (("goal", goal), ("task", task), ("stage", stage))
        }
        for key in ("goal", "task"):
            value = fields[key]
            if not isinstance(value, str) or not value.strip() or len(value) > 160:
                raise mailbox.MailboxError(
                    f"progress {key} requires 1-160 characters; supply all fields on the first update"
                )
            fields[key] = " ".join(value.split())
        if fields["stage"] not in STAGES:
            raise mailbox.MailboxError("progress stage must be planning, working, testing, review, blocked or complete")
        row = {
            "schema": SCHEMA,
            "session": peer["session"],
            "harness": peer["harness"],
            "machine": socket.gethostname(),
            "accountHome": peer.get("accountHome"),
            "checkout": str(Path(peer.get("checkout") or peer["cwd"]).resolve()),
            "workContext": context,
            **fields,
            "updatedAt": mailbox.stamp(),
        }
        mailbox.write(path, row)
    return row


def reminder(base: Path, peer: dict[str, Any], *, starting: bool = False) -> str:
    """Remind at turn boundaries, never wake an idle agent or extend its turn."""
    if mailbox.is_run_peer(peer) or peer.get("delegatedRun"):
        return ""
    row = read(base, peer)
    assignments = mailbox_work.assigned(base, peer)
    changed = bool(
        row
        and (
            row.get("workContext") != work_context(assignments)
            or (assignments and not any(item["title"] == row["task"] for item in assignments))
        )
    )
    if not starting:
        if row and not row["stale"] and not changed and row["stage"] != "complete":
            return ""
        last = peer.get("progressReminderAt")
        if mailbox.valid_stamp(last) and mailbox.now() - mailbox.parse_stamp(last) < REMIND_AFTER:
            return ""
    mailbox.annotate(base, peer["session"], progressReminderAt=mailbox.stamp())
    command = shlex.join(["python3", str(Path(__file__).resolve()), "--session", peer["session"]])
    health = "out of date" if changed else "stale" if row and row["stale"] else "recorded" if row else "not recorded"
    return (
        f"Orkest footer progress is {health}. For substantive work, report your actual goal, task and stage with "
        f"{command} --goal 'overall goal' --task 'current task' --stage working. "
        "Later, --stage testing (or planning, working, review, blocked, complete) preserves the other fields; "
        "no extra fields confirms unchanged work. Update when the assignment or stage changes and before your final response. "
        "The workboard remains authoritative for claims, blockers and acceptance. "
        "Do not invent work for acknowledgments or infer completion from idle."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--session",
        default=next(
            (
                os.environ[key]
                for key in (
                    "AGENT_MAILBOX_SESSION",
                    "CODEX_THREAD_ID",
                    "CLAUDE_CODE_SESSION_ID",
                    "ANTIGRAVITY_CONVERSATION_ID",
                    "OPENCODE_SESSION_ID",
                )
                if os.environ.get(key)
            ),
            None,
        ),
    )
    parser.add_argument("--goal")
    parser.add_argument("--task")
    parser.add_argument("--stage", choices=STAGES)
    args = parser.parse_args()
    try:
        base = mailbox.root()
        if not args.session:
            raise mailbox.MailboxError("pass --session with your native session ID")
        peer = mailbox.load(mailbox.peer_path(base, args.session))
        if not mailbox.valid_peer(peer) or mailbox.is_run_peer(peer):
            raise mailbox.MailboxError("register this interactive session with the peer mailbox first")
        result = report(base, peer, goal=args.goal, task=args.task, stage=args.stage)
        print(json.dumps({key: result[key] for key in ("goal", "task", "stage", "updatedAt")}))
        return 0
    except (mailbox.MailboxError, OSError) as error:
        print(f"Orkest progress: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
