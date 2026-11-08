#!/usr/bin/env python3
"""Record a session's display context without claiming work or changing workboard state."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import shlex
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

import mailbox_work
import peer_mailbox as mailbox

SCHEMA = "orchestrate.progress.v1"
STAGES = ("planning", "working", "testing", "review", "blocked", "complete")
STALE_AFTER = dt.timedelta(minutes=30)
REMIND_AFTER = dt.timedelta(minutes=5)
ROLES_PATH = Path(__file__).resolve().parents[1] / "references" / "workforce-roles.json"
ROLES_DATA = json.loads(ROLES_PATH.read_text(encoding="utf-8"))
ROLES = tuple(ROLES_DATA.keys())
ROLE_ALIASES = {alias: role_id for role_id, info in ROLES_DATA.items() for alias in (role_id, *info.get("aliases", ()))}


def caller_descends_from(owner_pid: int) -> bool | None:
    """Walk only our ancestry on Linux; use one portable ps snapshot on macOS.

    None means ancestry could not be established, not permission to update a live peer.
    """
    pid = os.getpid()
    parent = os.getppid()
    if owner_pid in (pid, parent):
        return True
    seen = {pid}
    if sys.platform == "linux":
        try:
            while parent > 1 and parent not in seen:
                if parent == owner_pid:
                    return True
                seen.add(parent)
                # comm is parenthesized and may itself contain spaces or parentheses.
                fields = Path(f"/proc/{parent}/stat").read_text().rsplit(")", 1)[1].split()
                parent = int(fields[1])
            return parent == owner_pid
        except (OSError, ValueError, IndexError):
            pass  # /proc may be unavailable; fall back to the portable process table.
    try:
        result = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, timeout=2, check=True)
        parents = dict(tuple(map(int, line.split())) for line in result.stdout.splitlines() if line.strip())
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    seen = {pid}
    parent = os.getppid()
    while parent > 1 and parent not in seen:
        if parent == owner_pid:
            return True
        seen.add(parent)
        if parent not in parents:
            return None
        parent = parents[parent]
    return parent == owner_pid


def require_owner(peer: dict[str, Any]) -> None:
    """A dead, unknown or recycled pid must not lock out a resumed session."""
    pid = peer.get("pid")
    if mailbox.pid_alive(pid) is not True:
        return
    birth = mailbox.process_started(pid) if peer.get("pidBirth") else None
    if birth is not None and birth != peer["pidBirth"]:
        return
    ancestry = caller_descends_from(pid)
    if ancestry is not True:
        detail = "; could not verify process ancestry" if ancestry is None else ""
        raise mailbox.MailboxError(f"session {peer['session']!r} is not owned by this process{detail}")


def normalize_role(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip().lower()
    if cleaned in {"", "none", "clear"}:
        return ""
    if cleaned not in ROLE_ALIASES:
        raise mailbox.MailboxError(f"progress role must be one of {', '.join(ROLES)} (or 'none' to clear)")
    return ROLE_ALIASES[cleaned]


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
            or (row.get("role") is not None and row.get("role") not in ROLES)
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
    base: Path,
    peer: dict[str, Any],
    *,
    goal: str | None,
    task: str | None,
    stage: str | None,
    role: str | None = None,
) -> dict[str, Any]:
    require_owner(peer)
    path = record_path(base, peer["session"])
    normalized_role = normalize_role(role)
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
        effective_role = previous.get("role") if normalized_role is None else (normalized_role or None)
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
            **({"role": effective_role} if effective_role else {}),
            "updatedAt": mailbox.stamp(),
        }
        mailbox.write(path, row)
    with contextlib.suppress(Exception):
        mailbox_work.renew_leases(base, peer)
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
    parser.add_argument(
        "--role",
        help="preset workforce role (e.g. planner, scout, builder, reviewer, verifier, debugger, ui-designer, sweeper)",
    )
    args = parser.parse_args()
    try:
        base = mailbox.root()
        if not args.session:
            raise mailbox.MailboxError("pass --session with your native session ID")
        peer = mailbox.load(mailbox.peer_path(base, args.session))
        if not mailbox.valid_peer(peer) or mailbox.is_run_peer(peer):
            raise mailbox.MailboxError("register this interactive session with the peer mailbox first")
        result = report(base, peer, goal=args.goal, task=args.task, stage=args.stage, role=args.role)
        out = {key: result[key] for key in ("goal", "task", "stage", "updatedAt")}
        if "role" in result:
            out["role"] = result["role"]
        print(json.dumps(out))
        return 0
    except (mailbox.MailboxError, OSError) as error:
        print(f"Orkest progress: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
