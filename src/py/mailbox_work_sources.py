"""Read-through workboard sources. The index stores pointers, never copied task state."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mailbox_tasks as tasks  # noqa: E402 -- also loaded by the coordinator's bundled-module loader
import peer_mailbox as mailbox  # noqa: E402

SCHEMA = "orchestrate.work-sources.v1"
TASK_SCHEMA = "agent-executor.task.v1"
MAX_SOURCES = 1024
INDEX_BYTES = 1024 * 1024
TASK_BYTES = 4 * 1024 * 1024


def _index(base: Path) -> Path:
    return base / "work" / "coordinator-index.json"


def _read_index(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema": SCHEMA, "sources": {}}
    if path.stat().st_size > INDEX_BYTES:
        raise mailbox.MailboxError("coordinator work index exceeds its 1 MiB limit")
    value = mailbox.load(path)
    if (
        not value
        or value.get("schema") != SCHEMA
        or not isinstance(value.get("sources"), dict)
        or len(value["sources"]) > MAX_SOURCES
    ):
        raise mailbox.MailboxError("coordinator work index is unreadable; inspect it before retrying")
    for identifier, source in value["sources"].items():
        if (
            not isinstance(source, dict)
            or source.get("task_id") != identifier
            or not isinstance(source.get("directory"), str)
            or not isinstance(source.get("repository"), str)
            or not isinstance(source.get("project"), dict)
        ):
            raise mailbox.MailboxError("coordinator work index has an invalid source")
    return value


def register_coordinator(base: Path, directory: Path, state: dict[str, Any]) -> None:
    """Idempotently index an existing task; its task.json remains the only source of task state."""
    identifier, repository = state.get("task_id"), state.get("repository")
    if (
        state.get("schema") != TASK_SCHEMA
        or not isinstance(identifier, str)
        or not identifier
        or len(identifier) > 80
        or not isinstance(repository, str)
        or not Path(repository).is_absolute()
    ):
        raise mailbox.MailboxError("cannot index a coordinator task with invalid identity")
    directory = directory.resolve()
    project = mailbox.workspace(repository)
    project = {"repo": project.get("repo"), "remotes": project.get("remotes", [])}
    if not mailbox.same_project(project, project):
        raise mailbox.MailboxError("cannot index a coordinator task without a Git project")
    source = {"task_id": identifier, "directory": str(directory), "repository": repository, "project": project}
    path = _index(base)
    with mailbox.locked(path):
        index = _read_index(path)
        old = index["sources"].get(identifier)
        if old:
            if old["directory"] != source["directory"] or old["repository"] != repository:
                raise mailbox.MailboxError("coordinator task identity is already indexed at another location")
            if old == source:
                return
        elif len(index["sources"]) >= MAX_SOURCES:
            raise mailbox.MailboxError("coordinator work index is full (1024 pointers); no tasks were removed")
        index["sources"][identifier] = source
        if len(json.dumps(index).encode()) > INDEX_BYTES:
            raise mailbox.MailboxError("coordinator work index is full (1 MiB); no tasks were removed")
        mailbox.write(path, index)


def _short(value: Any, length: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= length else text[: length - 1] + "…"


def _coordinator(source: dict[str, Any]) -> dict[str, Any]:
    directory = Path(source["directory"])
    task_path = directory / "task.json"
    row = {
        "id": "coordinator-" + source["task_id"],
        "source": "coordinator",
        "readOnly": True,
        "title": "Coordinator task " + source["task_id"],
        "state": "unavailable",
        "updatedAt": "",
        "owner": None,
        "integrator": None,
        "ready": False,
        "recoveryNeeded": "source_unavailable",
        "next": "Read the coordinator action before changing this task.",
        "evidence": "",
        "blocker": "",
        "done": "",
        "checkout": source["repository"],
        "route": {
            "kind": "coordinator",
            "command": [
                sys.executable,
                str(Path(__file__).with_name("coordinator.py")),
                "next",
                "--task-dir",
                str(directory),
            ],
        },
    }
    try:
        if task_path.stat().st_size > TASK_BYTES:
            raise ValueError("oversized task")
        state = mailbox.load(task_path)
        if (
            not state
            or state.get("schema") != TASK_SCHEMA
            or state.get("task_id") != source["task_id"]
            or state.get("repository") != source["repository"]
            or not isinstance(state.get("status"), str)
            or not isinstance(state.get("task_spec"), dict)
        ):
            raise ValueError("changed task identity")
        row.update(
            title=_short(state["task_spec"].get("objective") or row["title"], 120),
            state=_short(state["status"], 40),
            updatedAt=_short(state.get("updated_at") or state.get("created_at"), 64),
            recoveryNeeded=None,
        )
    except (OSError, ValueError, TypeError):
        row.update(
            blocker="Task source is missing, oversized or has changed identity; reconcile its recorded location."
        )
        row["route"]["command"] = []
        row["next"] = "Reconcile the recorded source location and identity before running a coordinator command."
    return row


def _bounded(row: dict[str, Any], *, original: Path | None = None) -> dict[str, Any]:
    """A legal old card or long source path must not prevent paging to the rest of the board."""
    if len(json.dumps(row, ensure_ascii=True).encode()) <= 10 * 1024:
        return row
    result = dict(row)
    for field in ("title", "next", "evidence", "done", "blocker", "checkout"):
        if field in result:
            result[field] = _short(result[field], 80)
    result["route"] = {"kind": row["source"], "command": []}
    result["next"] = (
        "Oversized legacy summary; read the original card through the route before resuming."
        if row["source"] == "legacy-note"
        else "Source location exceeds the display limit; reconcile its full indexed path before running commands."
    )
    if original is not None:
        command = [sys.executable, "-m", "json.tool", str(original)]
        if len(json.dumps(command, ensure_ascii=True).encode()) < 2048:
            result["route"]["command"] = command
        else:
            result["next"] = "Legacy summary and path exceed the display limit; inspect the legacy task store."
    return result


def records(base: Path, me: dict[str, Any], *, item: str | None = None) -> list[dict[str, Any]]:
    """Project-filter pointers before opening task files; never crawl arbitrary task directories."""
    path = _index(base)
    with mailbox.locked(path):
        sources = list(_read_index(path)["sources"].values())
    result = []
    for source in sources:
        identifier = "coordinator-" + source["task_id"]
        if (item is None or item == identifier) and mailbox.same_project(me, source["project"]):
            result.append(_bounded(_coordinator(source)))
    # Existing session cards are compatibility-only, not another place to claim or accept work.
    for path in sorted((base / "tasks").glob("*/*.json")):
        identifier = "legacy-" + hashlib.sha256(str(path.relative_to(base)).encode()).hexdigest()[:24]
        if item is not None and item != identifier:
            continue
        note = mailbox.load(path)
        if not tasks.fresh(note) or not isinstance(note.get("owner"), dict):
            continue
        if not mailbox.same_project(me, note["owner"]):
            continue
        owner = {key: str(note["owner"].get(key) or "unknown") for key in ("session", "name", "harness")}
        present = mailbox.load(mailbox.peer_path(base, owner["session"]))
        alive = bool(mailbox.valid_peer(present) and mailbox.same_project(me, present) and mailbox.is_live(present))
        result.append(
            _bounded(
                {
                    "id": identifier,
                    "source": "legacy-note",
                    "readOnly": True,
                    "title": _short(note.get("task"), 200),
                    "state": note.get("status", "active"),
                    "updatedAt": note["updatedAt"],
                    "owner": owner,
                    "integrator": None,
                    "ready": False,
                    "recoveryNeeded": None if alive or note.get("status") == "complete" else "owner_absent",
                    "next": _short(note.get("next"), 240),
                    "evidence": _short(note.get("refs"), 240),
                    "done": _short(note.get("done"), 160),
                    "blocker": _short(note.get("blocker"), 160),
                    "checkout": note.get("checkout") or "",
                    "route": {"kind": "legacy-note", "command": []},
                },
                original=path,
            )
        )
    return result
