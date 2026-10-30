#!/usr/bin/env python3
"""Render a harness session's recorded Orkest identity and work in one line."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import Any

import mailbox_tasks
import mailbox_work
import peer_mailbox as mailbox

COLORS = (31, 32, 33, 34, 35, 36)
TMUX_COLORS = {31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan"}
MAX_ROOMS = 1024
MAX_ROOM_BYTES = 1024 * 1024
MAX_TASK_BYTES = 4 * 1024 * 1024


def text(value: Any) -> str:
    """Turn recorded text into one safe terminal line."""
    if not isinstance(value, str):
        return ""
    return " ".join("".join(char if char.isprintable() else " " for char in value).split())[:240]


def session_from(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    for key in ("session_id", "conversation_id", "conversationId"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def bound_rooms(base: Path, peer: dict[str, Any]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Find explicit bindings to this session, never infer a room from its directory."""
    paths = list((base / "rooms").glob("*.json"))
    if len(paths) > MAX_ROOMS:
        return []
    found = []
    engine = "agy" if peer["harness"] == "gemini" else peer["harness"]
    for path in paths:
        try:
            if path.stat().st_size > MAX_ROOM_BYTES:
                continue
            room = mailbox.load(path)
            if (
                not room
                or room.get("schema") != "agent-executor.room.v1"
                or room.get("id") != path.stem
                or room.get("machine") != socket.gethostname()
                or not isinstance(room.get("cwd"), str)
                or not isinstance(room.get("agents"), list)
                or len(room["agents"]) > 64
            ):
                continue
            cwd = Path(room["cwd"]).resolve()
            checkout = Path(peer.get("checkout") or peer["cwd"]).resolve()
            if cwd != checkout and not mailbox.same_project(peer, mailbox.workspace(str(cwd))):
                continue
            for member in [room.get("conductor"), *room["agents"]]:
                if not isinstance(member, dict) or not isinstance(member.get("session"), dict):
                    continue
                binding = member["session"]
                if (
                    binding.get("id") == peer["session"]
                    and binding.get("engine") == engine
                    and binding.get("machine") == socket.gethostname()
                    and isinstance(binding.get("cwd"), str)
                    and Path(binding["cwd"]).resolve() == cwd
                ):
                    found.append((room, member))
        except (OSError, RuntimeError, TypeError, ValueError):
            continue
    return found


def room_task(room: dict[str, Any], member: dict[str, Any]) -> dict[str, str] | None:
    """Project the explicitly bound coordinator run using its recorded identity and verdict."""
    binding = member.get("dispatch")
    if (
        not isinstance(binding, dict)
        or not all(isinstance(binding.get(key), str) and binding[key] for key in ("taskDir", "taskId", "requestId"))
        or binding.get("transport") not in {"native", "executor"}
    ):
        return None
    try:
        path = Path(binding["taskDir"]) / "task.json"
        if not path.is_absolute() or path.stat().st_size > MAX_TASK_BYTES:
            return None
        task = mailbox.load(path)
        if (
            not task
            or task.get("schema") != "agent-executor.task.v1"
            or task.get("task_id") != binding.get("taskId")
            or not isinstance(task.get("repository"), str)
            or Path(task["repository"]).resolve() != Path(room["cwd"]).resolve()
            or not isinstance(task.get("task_spec"), dict)
            or not isinstance(task.get("runs"), list)
            or not isinstance(task.get("decisions"), list)
        ):
            return None
        runs = [
            run for run in task["runs"] if isinstance(run, dict) and run.get("request_id") == binding.get("requestId")
        ]
        if len(runs) != 1:
            return None
        run = runs[0]
        if (
            not isinstance(run.get("run_id"), str)
            or not run["run_id"]
            or (binding.get("runId") and run.get("run_id") != binding["runId"])
            or run.get("engine") != member.get("engine")
            or run.get("transport") != binding.get("transport")
        ):
            return None
        stages = {"reserved": "reserved", "active": "running", "finished": "review", "cancelled": "cancelled"}
        stage = stages.get(run.get("status"), "unknown")
        if run.get("runner_status") and run["runner_status"] != "completed":
            stage = "failed"
        decisions = [d for d in task["decisions"] if isinstance(d, dict) and d.get("run_id") == run.get("run_id")]
        if decisions:
            stage = {"accept": "completed", "supported": "completed", "reject": "rejected", "takeover": "blocked"}.get(
                decisions[-1].get("decision"), stage
            )
        return {"title": text(task["task_spec"].get("objective")), "state": stage}
    except (OSError, RuntimeError, TypeError, ValueError):
        return None


def codex_settings(peer: dict[str, Any]) -> tuple[str, str]:
    """Read only this session's recorded runtime settings; tolerate absent or changed databases."""
    account = peer.get("accountHome")
    if peer["harness"] != "codex" or not isinstance(account, str) or not Path(account).is_absolute():
        return "", ""
    databases = list(Path(account).glob("state_*.sqlite"))
    if len(databases) > 8:
        return "", ""
    found = set()
    for path in databases:
        try:
            with contextlib.closing(
                sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=0.05)
            ) as connection:
                row = connection.execute(
                    "SELECT model, reasoning_effort FROM threads WHERE id = ?", (peer["session"],)
                ).fetchone()
                if row:
                    found.add((text(row[0]), text(row[1])))
        except (OSError, sqlite3.Error, ValueError):
            continue
    return found.pop() if len(found) == 1 else ("", "")


def identity(session: str, harness: str | None = None, payload: Any = None) -> dict[str, Any] | None:
    base = mailbox.root()
    try:
        peer = mailbox.load(mailbox.peer_path(base, session))
    except mailbox.MailboxError:
        return None
    if not mailbox.valid_peer(peer) or peer["session"] != session or (harness and peer["harness"] != harness):
        return None
    name = peer["name"]
    if not name or not all(character.isprintable() for character in name):
        return None

    payload = payload if isinstance(payload, dict) else {}
    model_input = payload.get("model")
    model = (
        text(model_input.get("id") or model_input.get("display_name"))
        if isinstance(model_input, dict)
        else text(model_input)
    )
    if model.lower() == "auto":
        model = ""
    effort_input = payload.get("effort")
    effort = text(effort_input.get("level")) if isinstance(effort_input, dict) else text(effort_input)
    if not effort and isinstance(model_input, dict):
        effort = text(model_input.get("effort"))
    effort = effort or text(payload.get("effortLevel") or payload.get("reasoning_effort"))
    recorded_model, recorded_effort = codex_settings(peer)

    rooms = bound_rooms(base, peer)
    goal = "multiple rooms" if len(rooms) > 1 else ""
    if len(rooms) == 1:
        room = rooms[0][0]
        if room.get("title") != room.get("id"):
            goal = text(room.get("title"))
    try:
        assignments = mailbox_work.assigned(base, peer)
    except (OSError, mailbox.MailboxError, TypeError, ValueError):
        assignments = []
    for room, member in rooms:
        if coordinator_task := room_task(room, member):
            assignments.append(coordinator_task)
    if len(assignments) > 1:
        task, stage = "multiple tasks", "varies"
    elif assignments:
        task, stage = text(assignments[0].get("title")), text(assignments[0].get("state"))
    else:
        task, stage = text(peer.get("focus")), ""
        try:
            note = mailbox.load(mailbox_tasks.path_for(base, peer))
            if (
                mailbox_tasks.fresh(note)
                and note.get("task") == task
                and isinstance(note.get("owner"), dict)
                and note["owner"].get("session") == session
                and note.get("status") in {"active", "blocked", "complete"}
            ):
                stage = note["status"]
        except (OSError, mailbox.MailboxError, TypeError, ValueError):
            pass
    return {
        "name": name,
        "color": COLORS[hashlib.sha256(session.encode()).digest()[0] % len(COLORS)],
        "model": model or recorded_model or text(peer.get("model")) or "—",
        "effort": effort or recorded_effort or text(peer.get("effort")) or "—",
        "goal": goal or "—",
        "task": task or "—",
        "stage": stage or "—",
    }


def pane_session(pane_pid: int, harness: str) -> str | None:
    """Match a pane to exactly one live peer by process ancestry; never choose an ambiguous peer."""
    try:
        output = subprocess.run(
            ["ps", "-axo", "pid=,ppid="], capture_output=True, text=True, timeout=2, check=True
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    parents = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) == 2 and all(field.isdigit() for field in fields):
            parents[int(fields[0])] = int(fields[1])

    def in_pane(pid: int) -> bool:
        seen = set()
        while pid in parents and pid not in seen:
            if pid == pane_pid:
                return True
            seen.add(pid)
            pid = parents[pid]
        return False

    sessions = []
    for path in (mailbox.root() / "peers").glob("*.json"):
        peer = mailbox.load(path)
        if (
            mailbox.valid_peer(peer)
            and peer["harness"] == harness
            and isinstance(peer.get("pid"), int)
            and in_pane(peer["pid"])
            and mailbox.is_live(peer)
        ):
            sessions.append(peer["session"])
    return sessions[0] if len(sessions) == 1 else None


def display_width(value: str) -> int:
    return sum(
        0 if unicodedata.combining(char) else 2 if unicodedata.east_asian_width(char) in "WF" else 1 for char in value
    )


def shorten(value: str, width: int) -> str:
    if display_width(value) <= width:
        return value
    result = ""
    for char in value:
        if display_width(result + char) > width - 1:
            break
        result += char
    return result + "…"


def shorten_name(value: str, width: int) -> str:
    if display_width(value) <= width:
        return value
    # Keep the session's distinguishing suffix when a narrow terminal truncates its name.
    suffix = value[-4:]
    if display_width(suffix) >= width - 1:
        return shorten(value, width)
    return shorten(value, width - display_width(suffix)) + suffix


def format_line(item: dict[str, Any], width: int) -> tuple[str, str]:
    values = [item[key] for key in ("name", "model", "effort", "stage", "goal", "task")]
    sizes = [display_width(value) for value in values]
    minima = [min(size, minimum) for size, minimum in zip(sizes, (12, 5, 3, 4, 5, 5), strict=True)]
    # Reserve room for all labels, then share the remaining width across the six values.
    fixed = display_width("[] / | stage: | goal: | task:")
    while sum(sizes) + fixed > width and any(size > minimum for size, minimum in zip(sizes, minima, strict=True)):
        index = max(range(len(sizes)), key=lambda i: sizes[i] - minima[i])
        sizes[index] -= 1
    name = shorten_name(values[0], sizes[0])
    model, effort, stage, goal, task = [shorten(value, size) for value, size in zip(values[1:], sizes[1:], strict=True)]
    label = f"[{name}]"
    details = f" {model}/{effort} | stage:{stage} | goal:{goal} | task:{task}"
    if display_width(label + details) > width:
        if display_width(label) >= width:
            return shorten(label, width), ""
        details = shorten(details, width - display_width(label))
    return label, details


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--session", help="session ID, instead of reading the harness JSON from stdin")
    source.add_argument("--pane-pid", type=int, help="find an unambiguous peer in this tmux pane")
    parser.add_argument("--harness", choices=("claude", "codex", "gemini", "opencode"))
    parser.add_argument("--width", type=int, help="maximum terminal width")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true", help="emit fields and formatted line as JSON")
    output.add_argument("--plain", action="store_true", help="omit ANSI colors")
    output.add_argument("--tmux", action="store_true", help="emit a tmux-formatted line")
    args = parser.parse_args()
    if args.pane_pid is not None and not args.harness:
        parser.error("--pane-pid requires --harness")
    payload = {}
    session = pane_session(args.pane_pid, args.harness) if args.pane_pid is not None else args.session
    if args.pane_pid is None and not session:
        try:
            payload = json.load(sys.stdin)
            session = session_from(payload)
        except (ValueError, OSError):
            return 0
    if not session or not (item := identity(session, args.harness, payload)):
        if args.tmux:
            print("Orkest: waiting for agent")
        return 0
    payload_width = payload.get("terminal_width") if isinstance(payload, dict) else None
    width = (
        args.width
        or (payload_width if type(payload_width) is int else None)
        or shutil.get_terminal_size((80, 24)).columns
    )
    label, details = format_line(item, max(32, min(width, 1000)))
    if args.json:
        print(json.dumps({**item, "label": label, "details": details}))
    elif args.tmux:
        label, details = label.replace("#", "##"), details.replace("#", "##")
        print(
            label + details
            if os.environ.get("NO_COLOR")
            else f"#[fg={TMUX_COLORS[item['color']]}]{label}#[default]{details}"
        )
    elif args.plain or os.environ.get("NO_COLOR"):
        print(label + details)
    else:
        print(f"\033[{item['color']}m{label}\033[0m{details}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
