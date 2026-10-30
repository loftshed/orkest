"""Bounded, project-scoped coordination agreements for independently opened agents.

Claims do not lease files or verify user permission. Read at work boundaries; this board never wakes
agents or automatically reassigns work. An absent integrator needs an external recovery decision.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import peer_mailbox as mailbox

SCHEMA = "orchestrate.workboard.v1"
MAX_ITEMS = 1024
STORE_BYTES = 4 * 1024 * 1024
PAGE_BYTES = 12 * 1024
LIMITS = {
    "title": 120,
    "scope": 240,
    "acceptance": 240,
    "next": 240,
    "blocker": 160,
    "evidence": 240,
    "verification": 240,
    "note": 240,
}
ACTIONS = (
    "create",
    "claim",
    "checkpoint",
    "submit",
    "accept",
    "request_changes",
    "release",
    "recover",
    "offer_transfer",
    "accept_transfer",
)
STATES = ("open", "claimed", "blocked", "review", "accepted")


def _size(value: Any) -> int:
    # ASCII escaping also bounds the daemon's JSON representation of multibyte text.
    return len(json.dumps(value, ensure_ascii=True).encode("utf-8"))


def _text(field: str, value: Any, *, required: bool = False) -> str:
    if not isinstance(value, str):
        raise mailbox.MailboxError(f"work {field} must be text")
    value = " ".join(value.split())
    if (required and not value) or len(value) > LIMITS[field]:
        raise mailbox.MailboxError(f"work {field} needs {'1-' if required else '0-'}{LIMITS[field]} characters")
    return value


def _identity(peer: dict[str, Any]) -> dict[str, str]:
    mailbox.session_key(peer["session"])
    return {
        "session": peer["session"],
        "name": str(peer.get("name") or peer["session"])[:120],
        "harness": str(peer.get("harness") or "unknown")[:40],
    }


def _project(me: dict[str, Any]) -> dict[str, Any]:
    project = mailbox.project(me)
    result = {"repo": project.get("repo"), "remotes": project.get("remotes", [])}
    if not mailbox.same_project(result, result):
        raise mailbox.MailboxError("the workboard needs a Git project identity")
    return result


def _read(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema": SCHEMA, "items": []}
    if path.stat().st_size > STORE_BYTES:
        raise mailbox.MailboxError("workboard exceeds its 4 MiB capacity; inspect storage before continuing")
    board = mailbox.load(path)
    if not board or board.get("schema") != SCHEMA or not isinstance(board.get("items"), list):
        raise mailbox.MailboxError("workboard is unreadable; inspect storage before retrying")
    items = board["items"]
    required = {
        "id",
        "project",
        "creator",
        "integrator",
        "owner",
        "revision",
        "state",
        "dependencies",
        "title",
        "scope",
        "acceptance",
        "createdAt",
        "updatedAt",
        "key",
        "fingerprint",
    }
    if (
        len(items) > MAX_ITEMS
        or any(not isinstance(i, dict) or not required <= i.keys() for i in items)
        or len({i["id"] for i in items}) != len(items)
    ):
        raise mailbox.MailboxError("workboard records are invalid; inspect storage before retrying")
    return board


def _find(board: dict[str, Any], me: dict[str, Any], item: Any) -> dict[str, Any]:
    for record in board["items"]:
        if record["id"] == item and mailbox.same_project(me, record["project"]):
            return record
    raise mailbox.MailboxError("work item not found in this project")


def _external(item: Any) -> bool:
    return isinstance(item, str) and item.startswith(("coordinator-", "legacy-"))


def _present(
    base: Path,
    identity: dict[str, str] | None,
    project: dict[str, Any],
    presence: dict[str, tuple[dict[str, Any] | None, bool]] | None = None,
) -> bool:
    if not identity:
        return False
    presence = {} if presence is None else presence
    session = identity["session"]
    if session not in presence:
        peer = mailbox.load(mailbox.peer_path(base, session))
        presence[session] = (peer, bool(mailbox.valid_peer(peer) and mailbox.is_live(peer)))
    peer, alive = presence[session]
    return bool(alive and mailbox.same_project(peer, project))


def _view(
    base: Path,
    board: dict[str, Any],
    record: dict[str, Any],
    presence: dict[str, tuple[dict[str, Any] | None, bool]] | None = None,
) -> dict[str, Any]:
    states = {i["id"]: i["state"] for i in board["items"]}
    unmet = [item for item in record["dependencies"] if states.get(item) != "accepted"]
    owner_present = _present(base, record["owner"], record["project"], presence)
    integrator_present = _present(base, record["integrator"], record["project"], presence)
    recovery = None
    if record["state"] != "accepted":
        if not integrator_present:
            recovery = "integrator_absent"
        elif record["owner"] and not owner_present:
            recovery = "owner_absent"
    return {
        **{key: value for key, value in record.items() if key not in {"project", "key", "fingerprint"}},
        "source": "interactive",
        "readOnly": False,
        "ready": record["state"] == "open" and not unmet and integrator_present,
        "unmetDependencies": unmet,
        "ownerPresent": owner_present,
        "integratorPresent": integrator_present,
        "recoveryNeeded": recovery,
    }


def snapshot(base: Path, me: dict[str, Any], *, item: str | None = None) -> list[dict[str, Any]]:
    """Read existing work sources once; no read changes ownership or persistence."""
    _project(me)
    path = base / "work" / "board.json"
    with mailbox.locked(path):
        board = _read(path)
        selected = (
            []
            if _external(item)
            else [_find(board, me, item)]
            if item is not None
            else [i for i in board["items"] if mailbox.same_project(me, i["project"])]
        )
    presence: dict[str, tuple[dict[str, Any] | None, bool]] = {}
    records = [_view(base, board, record, presence) for record in selected]
    # Other sources have their own writers. Never hold our lock while reading their snapshots.
    if item is None or _external(item):
        import mailbox_work_sources

        records.extend(mailbox_work_sources.records(base, me, item=item))
    if item is not None and not records:
        raise mailbox.MailboxError("work item not found in this project")
    records.sort(key=lambda i: (str(i.get("updatedAt") or ""), i["id"]), reverse=True)
    return records


def assigned(base: Path, me: dict[str, Any]) -> list[dict[str, Any]]:
    """Read this session's active assignments without locks or presence side effects.

    Writers replace the complete board atomically. This small projection is suitable for a
    frequently refreshed display; the workboard remains the authority for transitions.
    """
    board = _read(base / "work" / "board.json")
    return [
        {"title": item["title"], "state": item["state"]}
        for item in board["items"]
        if isinstance(item["owner"], dict)
        and item["owner"].get("session") == me["session"]
        and item["state"] in {"claimed", "blocked", "review"}
        and isinstance(item["project"], dict)
        and mailbox.same_project(me, item["project"])
    ]


def listing(
    base: Path, me: dict[str, Any], *, item: str | None = None, limit: int = 10, offset: int = 0
) -> dict[str, Any]:
    """Read a bounded page of work from the shared snapshot."""
    if type(limit) is not int or not 1 <= limit <= 50 or type(offset) is not int or offset < 0:
        raise mailbox.MailboxError("work needs limit 1-50 and a nonnegative offset")
    records = snapshot(base, me, item=item)
    page: list[dict[str, Any]] = []
    for record in records[offset : offset + limit]:
        candidate = [*page, record]
        if _size({"items": candidate, "has_more": True, "next_offset": len(records)}) > PAGE_BYTES:
            if not page:
                raise mailbox.MailboxError("work item exceeds the response limit; inspect storage")
            break
        page = candidate
    more = offset + len(page) < len(records)
    return {"items": page, "has_more": more, "next_offset": offset + len(page) if more else None}


def _peer(base: Path, me: dict[str, Any], address: str) -> dict[str, str]:
    peer = mailbox.resolve(base, address, sender=me)
    if mailbox.is_run_peer(peer) or not mailbox.same_project(me, peer):
        raise mailbox.MailboxError("work roles need an interactive peer in this project")
    return _identity(peer)


def _create(
    base: Path,
    board: dict[str, Any],
    me: dict[str, Any],
    *,
    key: Any,
    fields: dict[str, Any],
    dependencies: Any,
    integrator: Any,
) -> tuple[dict[str, Any], bool]:
    if not isinstance(key, str) or not re.fullmatch(mailbox.CLIENT_ID, key):
        raise mailbox.MailboxError("work create key needs 1-80 letters, digits, underscores or hyphens")
    fields = {name: _text(name, value, required=True) for name, value in fields.items()}
    dependencies = [] if dependencies is None else dependencies
    if (
        not isinstance(dependencies, list)
        or len(dependencies) > 16
        or any(not isinstance(i, str) for i in dependencies)
        or len(set(dependencies)) != len(dependencies)
    ):
        raise mailbox.MailboxError("work dependencies need at most 16 distinct existing item IDs")
    if integrator is not None and (not isinstance(integrator, str) or not integrator.strip()):
        raise mailbox.MailboxError("work integrator must name an existing project peer")
    if any(_external(dependency) for dependency in dependencies):
        raise mailbox.MailboxError(
            "cross-source dependencies are not supported; dependencies need interactive work IDs"
        )
    fingerprint = hashlib.sha256(
        json.dumps({**fields, "dependencies": sorted(dependencies), "integrator": integrator}, sort_keys=True).encode()
    ).hexdigest()
    for old in board["items"]:
        if (
            old["key"] == key
            and old["creator"]["session"] == me["session"]
            and mailbox.same_project(me, old["project"])
        ):
            if old["fingerprint"] != fingerprint:
                raise mailbox.MailboxError("work create key was already used with different fields; use a new key")
            return old, True
    if len(board["items"]) >= MAX_ITEMS:
        raise mailbox.MailboxError(
            "workboard capacity is 1024 items across projects; no records are pruned automatically"
        )
    for dependency in dependencies:
        _find(board, me, dependency)
    identity = _identity(me)
    record = {
        "id": mailbox.message_id(),
        "project": _project(me),
        "key": key,
        "fingerprint": fingerprint,
        **fields,
        "dependencies": list(dependencies),
        "creator": identity,
        "integrator": _peer(base, me, integrator) if integrator is not None else identity,
        "owner": None,
        "revision": 1,
        "state": "open",
        "next": "",
        "blocker": "",
        "evidence": "",
        "verification": "",
        "note": "",
        "transfer": None,
        "recovery": None,
        "createdAt": mailbox.stamp(),
        "updatedAt": mailbox.stamp(),
    }
    board["items"].append(record)
    return record, False


def _require(record: dict[str, Any], me: dict[str, Any], role: str) -> None:
    if not record.get(role) or record[role]["session"] != me["session"]:
        raise mailbox.MailboxError(f"only this work item's current {role} can perform that action")


def _transition(
    base: Path,
    board: dict[str, Any],
    me: dict[str, Any],
    record: dict[str, Any],
    action: str,
    revision: Any,
    details: dict[str, str],
    successor: Any,
) -> None:
    if type(revision) is not int or revision != record["revision"]:
        raise mailbox.MailboxError(
            f"work revision conflict: current revision {record['revision']}, state {record['state']}; read the item again"
        )
    if record["state"] == "accepted":
        raise mailbox.MailboxError("accepted work is terminal; create follow-up work")
    if action in {"checkpoint", "submit", "release"}:
        _require(record, me, "owner")
    if action in {"accept", "request_changes", "recover", "offer_transfer"}:
        _require(record, me, "integrator")
    if action == "claim":
        if record["state"] != "open" or record["owner"]:
            raise mailbox.MailboxError("work is already claimed")
        if _view(base, board, record)["unmetDependencies"]:
            raise mailbox.MailboxError("work dependencies have not been accepted")
        if not _present(base, record["integrator"], record["project"]):
            raise mailbox.MailboxError("work integrator is absent; integrator reassignment is not supported")
        record.update(owner=_identity(me), state="claimed", blocker="")
    elif action == "checkpoint":
        if record["state"] not in {"claimed", "blocked"}:
            raise mailbox.MailboxError("checkpoint needs claimed or blocked work; submit freezes review evidence")
        record.update(details)
        record["state"] = "blocked" if record["blocker"] else "claimed"
    elif action == "submit":
        if record["state"] not in {"claimed", "blocked"}:
            raise mailbox.MailboxError("submit needs claimed or blocked work")
        for field in ("evidence", "verification"):
            _text(field, details.get(field), required=True)
        record.update(details, state="review", blocker="")
    elif action in {"accept", "request_changes"}:
        if record["state"] != "review":
            raise mailbox.MailboxError("acceptance needs submitted work in review")
        if action == "request_changes":
            _text("note", details.get("note"), required=True)
        record.update(details, state="accepted" if action == "accept" else "claimed")
        if action == "accept":
            record["transfer"] = None
    elif action == "release":
        record.update(details, owner=None, state="open", blocker="")
    elif action == "recover":
        _text("note", details.get("note"), required=True)
        if not record["owner"] or _present(base, record["owner"], record["project"]):
            raise mailbox.MailboxError("recovery needs an absent owner; absence alone does not prove execution stopped")
        record["recovery"] = {
            "previousOwner": record["owner"],
            "revision": record["revision"],
            "note": details["note"],
            "at": mailbox.stamp(),
        }
        record.update(details, owner=None, state="open", blocker="")
    elif action == "offer_transfer":
        if not isinstance(successor, str) or not successor.strip():
            raise mailbox.MailboxError("offer_transfer needs an existing project peer as successor")
        identity = _peer(base, me, successor)
        if identity["session"] == record["integrator"]["session"]:
            raise mailbox.MailboxError("the successor is already this item's integrator")
        record.update(details, transfer=identity)
    elif action == "accept_transfer":
        if not record["transfer"] or record["transfer"]["session"] != me["session"]:
            raise mailbox.MailboxError("no integrator handoff is offered to this session")
        record.update(integrator=_identity(me), transfer=None)
    record.update(revision=record["revision"] + 1, updatedAt=mailbox.stamp())


def mutate(
    base: Path,
    me: dict[str, Any],
    *,
    action: str,
    item: str | None = None,
    revision: int | None = None,
    key: str | None = None,
    title: str | None = None,
    scope: str | None = None,
    acceptance: str | None = None,
    dependencies: list[str] | None = None,
    integrator: str | None = None,
    next_step: str | None = None,
    blocker: str | None = None,
    evidence: str | None = None,
    verification: str | None = None,
    note: str | None = None,
    successor: str | None = None,
) -> dict[str, Any]:
    """Apply one revision-checked agreement. Errors never persist a partial transition."""
    if action not in ACTIONS:
        raise mailbox.MailboxError("unknown work action")
    if mailbox.is_run_peer(me):
        raise mailbox.MailboxError("run sessions report work to their conductor")
    if _external(item):
        raise mailbox.MailboxError(
            "read the board for this source's route; coordinator work uses its existing review/acceptance; "
            "legacy cards are read-only"
        )
    _project(me)
    details = {
        name: _text(name, value)
        for name, value in {
            "next": next_step,
            "blocker": blocker,
            "evidence": evidence,
            "verification": verification,
            "note": note,
        }.items()
        if value is not None
    }
    allowed = {
        "create": set(),
        "claim": set(),
        "checkpoint": {"next", "blocker", "evidence", "verification"},
        "submit": {"next", "evidence", "verification"},
        "accept": {"note"},
        "request_changes": {"note"},
        "release": {"note"},
        "recover": {"note"},
        "offer_transfer": {"note"},
        "accept_transfer": set(),
    }
    if details.keys() - allowed[action] or (successor is not None and action != "offer_transfer"):
        raise mailbox.MailboxError(f"fields do not apply to work action {action}")
    if action == "create":
        if item is not None or revision is not None:
            raise mailbox.MailboxError("create does not take item or revision")
    elif any(value is not None for value in (key, title, scope, acceptance, dependencies, integrator)):
        raise mailbox.MailboxError("work title, scope, acceptance and dependencies are immutable; roles use transfer")
    path = base / "work" / "board.json"
    with mailbox.locked(path):
        board = _read(path)
        if action == "create":
            record, replayed = _create(
                base,
                board,
                me,
                key=key,
                fields={"title": title, "scope": scope, "acceptance": acceptance},
                dependencies=dependencies,
                integrator=integrator,
            )
        else:
            record, replayed = _find(board, me, item), False
            _transition(base, board, me, record, action, revision, details, successor)
        result = {"item": _view(base, board, record), "replayed": replayed}
        # A later disappearance lengthens these derived fields without a write. Reserve that space now.
        bounded = {
            **result["item"],
            "ready": False,
            "ownerPresent": False,
            "integratorPresent": False,
            "recoveryNeeded": "integrator_absent",
        }
        if _size({"items": [bounded], "has_more": True, "next_offset": MAX_ITEMS}) > PAGE_BYTES:
            raise mailbox.MailboxError(
                "work item exceeds 12 KiB response capacity; shorten text and reference artifacts"
            )
        if not replayed:
            if _size(board) > STORE_BYTES:
                raise mailbox.MailboxError("workboard capacity is 4 MiB; no records are pruned automatically")
            mailbox.write(path, board)
        return result
