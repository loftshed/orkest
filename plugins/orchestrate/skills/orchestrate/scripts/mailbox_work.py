"""Bounded, project-scoped coordination agreements for independently opened agents.

Claims do not lock files or verify user permission. Read at work boundaries; this board never wakes
agents. Expired claim leases allow explicit reclaim or recovery; an absent integrator needs an external
recovery decision.
"""

from __future__ import annotations

import datetime as dt
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
HELP_BOARD_IDLE_SECONDS = 15 * 60
DEFAULT_LEASE_TTL_SECONDS = 900
MIN_LEASE_TTL_SECONDS = 60
MAX_LEASE_TTL_SECONDS = 7200
HANDOFF_LIST_FIELDS = ("files_touched", "decisions_made", "remaining_steps", "blockers")
HANDOFF_TEXT_FIELD = "verification_command_run"
HANDOFF_MAX_LIST_ITEMS = 10
HANDOFF_MAX_ITEM_CHARS = 120
HANDOFF_MAX_CMD_CHARS = 240
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
    "reclaim",
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


def _matches_session(peer: dict[str, Any] | None, session: str | None) -> bool:
    if not isinstance(peer, dict) or not session:
        return False
    if peer.get("session") == session or peer.get("clearedFrom") == session:
        return True
    aliases = peer.get("aliases")
    return isinstance(aliases, list) and session in aliases


def _normalize_lease_ttl(lease_ttl: Any) -> int:
    if lease_ttl is None:
        return DEFAULT_LEASE_TTL_SECONDS
    if isinstance(lease_ttl, bool) or not isinstance(lease_ttl, int):
        raise mailbox.MailboxError("work lease_ttl must be an integer number of seconds")
    return max(MIN_LEASE_TTL_SECONDS, min(MAX_LEASE_TTL_SECONDS, lease_ttl))


def _lease_expiry(ttl_seconds: int) -> str:
    return mailbox.stamp(mailbox.now() + dt.timedelta(seconds=ttl_seconds))


def _lease_expired(record: dict[str, Any]) -> bool:
    if record.get("state") not in {"claimed", "blocked"} or not record.get("owner"):
        return False
    expires_at = record.get("leaseExpiresAt")
    if not expires_at or not mailbox.valid_stamp(expires_at):
        return False
    return mailbox.now() >= mailbox.parse_stamp(expires_at)


def _normalize_handoff(handoff: Any, existing: dict[str, Any] | None = None) -> dict[str, Any]:
    if not isinstance(handoff, dict):
        raise mailbox.MailboxError("work handoff must be a JSON object")
    allowed = set(HANDOFF_LIST_FIELDS) | {HANDOFF_TEXT_FIELD}
    unknown = set(handoff.keys()) - allowed
    if unknown:
        raise mailbox.MailboxError(
            "work handoff allows only files_touched, decisions_made, remaining_steps, blockers, verification_command_run"
        )
    merged: dict[str, Any] = {
        "files_touched": [],
        "decisions_made": [],
        "remaining_steps": [],
        "blockers": [],
        "verification_command_run": "",
    }
    if isinstance(existing, dict):
        for field in HANDOFF_LIST_FIELDS:
            if isinstance(existing.get(field), list):
                merged[field] = list(existing[field])
        if isinstance(existing.get(HANDOFF_TEXT_FIELD), str):
            merged[HANDOFF_TEXT_FIELD] = existing[HANDOFF_TEXT_FIELD]
    for field in HANDOFF_LIST_FIELDS:
        if field in handoff and handoff[field] is not None:
            raw_list = handoff[field]
            if not isinstance(raw_list, list) or len(raw_list) > HANDOFF_MAX_LIST_ITEMS:
                raise mailbox.MailboxError(
                    f"work handoff {field} must be a list of at most {HANDOFF_MAX_LIST_ITEMS} strings"
                )
            cleaned_list: list[str] = []
            for entry in raw_list:
                if not isinstance(entry, str):
                    raise mailbox.MailboxError(f"work handoff {field} entries must be strings")
                cleaned = " ".join(entry.split())
                if not cleaned or len(cleaned) > HANDOFF_MAX_ITEM_CHARS:
                    raise mailbox.MailboxError(
                        f"work handoff {field} entries need 1-{HANDOFF_MAX_ITEM_CHARS} characters"
                    )
                cleaned_list.append(cleaned)
            merged[field] = cleaned_list
    if HANDOFF_TEXT_FIELD in handoff and handoff[HANDOFF_TEXT_FIELD] is not None:
        raw_cmd = handoff[HANDOFF_TEXT_FIELD]
        if not isinstance(raw_cmd, str):
            raise mailbox.MailboxError(f"work handoff {HANDOFF_TEXT_FIELD} must be text")
        cleaned_cmd = " ".join(raw_cmd.split())
        if len(cleaned_cmd) > HANDOFF_MAX_CMD_CHARS:
            raise mailbox.MailboxError(f"work handoff {HANDOFF_TEXT_FIELD} needs 0-{HANDOFF_MAX_CMD_CHARS} characters")
        merged[HANDOFF_TEXT_FIELD] = cleaned_cmd
    return merged


def _present(
    base: Path,
    identity: dict[str, str] | None,
    project: dict[str, Any],
    presence: dict[str, tuple[dict[str, Any] | None, bool]] | None = None,
    alias_peers: list[dict[str, Any]] | None = None,
) -> bool:
    if not identity:
        return False
    presence = {} if presence is None else presence
    session = identity["session"]
    if session not in presence:
        peer = mailbox.load(mailbox.peer_path(base, session))
        alive = bool(mailbox.valid_peer(peer) and mailbox.same_project(peer, project) and mailbox.is_live(peer))
        if not alive:
            if alias_peers is None:
                peers_dir = base / "peers"
                alias_peers = (
                    [
                        candidate
                        for candidate_path in peers_dir.glob("*.json")
                        if mailbox.valid_peer(candidate := mailbox.load(candidate_path))
                    ]
                    if peers_dir.is_dir()
                    else []
                )
            for candidate in alias_peers:
                if (
                    _matches_session(candidate, session)
                    and mailbox.same_project(candidate, project)
                    and mailbox.is_live(candidate)
                ):
                    peer, alive = candidate, True
                    break
        presence[session] = (peer, alive)
    peer, alive = presence[session]
    return bool(alive and mailbox.same_project(peer, project))


def _states(board: dict[str, Any]) -> dict[str, str]:
    return {record["id"]: record["state"] for record in board["items"]}


def _view(
    base: Path,
    states: dict[str, str],
    record: dict[str, Any],
    presence: dict[str, tuple[dict[str, Any] | None, bool]] | None = None,
    alias_peers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    unmet = [item for item in record["dependencies"] if states.get(item) != "accepted"]
    owner_present = _present(base, record["owner"], record["project"], presence, alias_peers)
    integrator_present = _present(base, record["integrator"], record["project"], presence, alias_peers)
    lease_expired = _lease_expired(record)
    recovery = None
    if record["state"] != "accepted":
        if not integrator_present:
            recovery = "integrator_absent"
        elif record["owner"] and not owner_present:
            recovery = "owner_absent"
        elif record["owner"] and lease_expired:
            recovery = "lease_expired"
    return {
        "leaseTtlSeconds": None,
        "leaseExpiresAt": None,
        "handoff": None,
        **{key: value for key, value in record.items() if key not in {"project", "key", "fingerprint"}},
        "source": "interactive",
        "readOnly": False,
        "ready": record["state"] == "open" and not unmet and integrator_present,
        "unmetDependencies": unmet,
        "ownerPresent": owner_present,
        "integratorPresent": integrator_present,
        "leaseExpired": lease_expired,
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
    states = _states(board)
    presence: dict[str, tuple[dict[str, Any] | None, bool]] = {}
    peers_dir = base / "peers"
    alias_peers = (
        [
            candidate
            for candidate_path in peers_dir.glob("*.json")
            if mailbox.valid_peer(candidate := mailbox.load(candidate_path))
        ]
        if peers_dir.is_dir() and selected
        else []
    )
    records = [_view(base, states, record, presence, alias_peers) for record in selected]
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
        {"id": item["id"], "title": item["title"], "state": item["state"]}
        for item in board["items"]
        if isinstance(item["owner"], dict)
        and _matches_session(me, item["owner"].get("session"))
        and item["state"] in {"claimed", "blocked", "review"}
        and isinstance(item["project"], dict)
        and mailbox.same_project(me, item["project"])
    ]


def renew_leases(base: Path, me: dict[str, Any], *, force: bool = True) -> int:
    """Extend active claim leases for items owned by this session (or its /clear predecessor)."""
    path = base / "work" / "board.json"
    if not path.exists():
        return 0
    try:
        _project(me)
    except mailbox.MailboxError:
        return 0
    renewed = 0
    dirty = False
    with mailbox.locked(path):
        board = _read(path)
        stamp = mailbox.stamp()
        current_now = mailbox.now()
        for record in board["items"]:
            if (
                record.get("state") in {"claimed", "blocked"}
                and isinstance(record.get("owner"), dict)
                and _matches_session(me, record["owner"].get("session"))
                and isinstance(record.get("project"), dict)
                and mailbox.same_project(me, record["project"])
            ):
                ttl = _normalize_lease_ttl(record.get("leaseTtlSeconds"))
                owner_changed = me["session"] != record["owner"].get("session")
                existing_exp = record.get("leaseExpiresAt")
                needs_write = force or owner_changed or not isinstance(existing_exp, str)
                if not needs_write and isinstance(existing_exp, str):
                    try:
                        remaining = (dt.datetime.fromisoformat(existing_exp) - current_now).total_seconds()
                        needs_write = remaining <= ttl * 0.75
                    except ValueError:
                        needs_write = True
                renewed += 1
                if needs_write:
                    record["leaseTtlSeconds"] = ttl
                    record["leaseExpiresAt"] = _lease_expiry(ttl)
                    if owner_changed:
                        record["owner"] = _identity(me)
                        record["revision"] = int(record.get("revision") or 1) + 1
                        record["updatedAt"] = stamp
                    dirty = True
        if dirty:
            mailbox.write(path, board)
    return renewed


def shares_active_work(base: Path, first: dict[str, Any], second: dict[str, Any]) -> bool:
    """Whether two peers are paired on an active workboard item (creator, integrator, owner or transfer)."""
    try:
        board = _read(base / "work" / "board.json")
    except mailbox.MailboxError:
        return False
    pair = {first.get("session"), second.get("session")} - {None}
    if len(pair) < 2:
        return False
    for item in board["items"]:
        if item.get("state") == "accepted":
            continue
        project = item.get("project")
        if not isinstance(project, dict) or not (
            mailbox.same_project(first, project) or mailbox.same_project(second, project)
        ):
            continue
        participants = {
            role.get("session")
            for key in ("creator", "integrator", "owner", "transfer")
            if isinstance(role := item.get(key), dict)
        } - {None}
        if any(_matches_session(first, s) for s in participants) and any(
            _matches_session(second, s) for s in participants
        ):
            return True
    return False


def help_board_hint(base: Path, me: dict[str, Any], *, previous: dict[str, Any] | None = None) -> str:
    """Surface ready workboard items at a turn boundary only when this session's own task is complete and it
    has been idle for at least HELP_BOARD_IDLE_SECONDS."""
    if mailbox.is_run_peer(me) or me.get("delegatedRun"):
        return ""
    try:
        _project(me)
        if assigned(base, me):
            return ""
        import agent_progress

        progress = agent_progress.read(base, me)
        if not progress or progress.get("stage") != "complete":
            return ""
        now = mailbox.now()
        if (now - mailbox.parse_stamp(progress["updatedAt"])).total_seconds() < HELP_BOARD_IDLE_SECONDS:
            return ""
        if mailbox.valid_peer(previous):
            if previous.get("state") != "idle":
                return ""
            if (now - mailbox.parse_stamp(previous["lastSeenAt"])).total_seconds() < HELP_BOARD_IDLE_SECONDS:
                return ""
        board = _read(base / "work" / "board.json")
    except (mailbox.MailboxError, OSError, ValueError):
        return ""
    states = _states(board)
    presence: dict[str, tuple[dict[str, Any] | None, bool]] = {}
    ready = [
        view
        for record in board["items"]
        if mailbox.same_project(me, record["project"])
        and (view := _view(base, states, record, presence))["ready"]
        and not view.get("owner")
    ]
    if not ready:
        return ""
    sample = ", ".join(f"{item['id']} ({item['title']})" for item in ready[:2])
    return (
        f"Help board: your recorded task is complete and this session was idle; {len(ready)} ready item(s) are open "
        f"on the project workboard ({sample}). Inspect `mailbox board` and claim one with `mailbox work claim` only "
        "if the user wants this session to pick up shared work."
    )


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
        "leaseTtlSeconds": None,
        "leaseExpiresAt": None,
        "handoff": None,
        "transfer": None,
        "recovery": None,
        "createdAt": mailbox.stamp(),
        "updatedAt": mailbox.stamp(),
    }
    board["items"].append(record)
    return record, False


def _require(record: dict[str, Any], me: dict[str, Any], role: str) -> None:
    holder = record.get(role)
    if not holder or not _matches_session(me, holder.get("session")):
        raise mailbox.MailboxError(f"only this work item's current {role} can perform that action")
    if me["session"] != holder["session"]:
        record[role] = _identity(me)


def _transition(
    base: Path,
    board: dict[str, Any],
    me: dict[str, Any],
    record: dict[str, Any],
    action: str,
    revision: Any,
    details: dict[str, str],
    successor: Any,
    *,
    handoff: dict[str, Any] | None = None,
    lease_ttl: int | None = None,
    presence: dict[str, Any] | None = None,
) -> None:
    presence = {} if presence is None else presence
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
    if action in {"claim", "reclaim"}:
        states = _states(board)
        if _view(base, states, record, presence)["unmetDependencies"]:
            raise mailbox.MailboxError("work dependencies have not been accepted")
        if not _present(base, record["integrator"], record["project"], presence):
            raise mailbox.MailboxError("work integrator is absent; integrator reassignment is not supported")
        ttl = _normalize_lease_ttl(lease_ttl)
        if record["state"] == "open" and not record["owner"]:
            record.update(
                owner=_identity(me),
                state="claimed",
                blocker="",
                leaseTtlSeconds=ttl,
                leaseExpiresAt=_lease_expiry(ttl),
            )
        elif record["state"] in {"claimed", "blocked"} and record["owner"]:
            owner_present = _present(base, record["owner"], record["project"], presence)
            expired = _lease_expired(record)
            if owner_present and not expired:
                raise mailbox.MailboxError("work is already claimed")
            record["recovery"] = {
                "previousOwner": record["owner"],
                "reason": "lease_expired" if expired else "owner_absent",
                "revision": record["revision"],
                "at": mailbox.stamp(),
            }
            record.update(
                owner=_identity(me),
                state="claimed",
                blocker="",
                leaseTtlSeconds=ttl,
                leaseExpiresAt=_lease_expiry(ttl),
            )
        else:
            raise mailbox.MailboxError("work is already claimed")
    elif action == "checkpoint":
        if record["state"] not in {"claimed", "blocked"}:
            raise mailbox.MailboxError("checkpoint needs claimed or blocked work; submit freezes review evidence")
        record.update(details)
        if handoff is not None:
            record["handoff"] = _normalize_handoff(handoff, record.get("handoff"))
        ttl = _normalize_lease_ttl(lease_ttl if lease_ttl is not None else record.get("leaseTtlSeconds"))
        record["leaseTtlSeconds"] = ttl
        record["leaseExpiresAt"] = _lease_expiry(ttl)
        record["state"] = "blocked" if record["blocker"] else "claimed"
    elif action == "submit":
        if record["state"] not in {"claimed", "blocked"}:
            raise mailbox.MailboxError("submit needs claimed or blocked work")
        for field in ("evidence", "verification"):
            _text(field, details.get(field), required=True)
        if handoff is not None:
            record["handoff"] = _normalize_handoff(handoff, record.get("handoff"))
        record.update(details, state="review", blocker="", leaseExpiresAt=None)
    elif action in {"accept", "request_changes"}:
        if record["state"] != "review":
            raise mailbox.MailboxError("acceptance needs submitted work in review")
        if action == "request_changes":
            _text("note", details.get("note"), required=True)
        record.update(details, state="accepted" if action == "accept" else "claimed")
        if action == "accept":
            record["transfer"] = None
            record["leaseTtlSeconds"] = None
            record["leaseExpiresAt"] = None
        else:
            ttl = _normalize_lease_ttl(record.get("leaseTtlSeconds"))
            record["leaseTtlSeconds"] = ttl
            record["leaseExpiresAt"] = _lease_expiry(ttl)
    elif action == "release":
        if handoff is not None:
            record["handoff"] = _normalize_handoff(handoff, record.get("handoff"))
        record.update(details, owner=None, state="open", blocker="", leaseTtlSeconds=None, leaseExpiresAt=None)
    elif action == "recover":
        _text("note", details.get("note"), required=True)
        if not record["owner"] or (
            _present(base, record["owner"], record["project"], presence) and not _lease_expired(record)
        ):
            raise mailbox.MailboxError("recovery needs an absent owner; absence alone does not prove execution stopped")
        record["recovery"] = {
            "previousOwner": record["owner"],
            "revision": record["revision"],
            "note": details["note"],
            "at": mailbox.stamp(),
        }
        record.update(details, owner=None, state="open", blocker="", leaseTtlSeconds=None, leaseExpiresAt=None)
    elif action == "offer_transfer":
        if not isinstance(successor, str) or not successor.strip():
            raise mailbox.MailboxError("offer_transfer needs an existing project peer as successor")
        identity = _peer(base, me, successor)
        if identity["session"] == record["integrator"]["session"]:
            raise mailbox.MailboxError("the successor is already this item's integrator")
        record.update(details, transfer=identity)
    elif action == "accept_transfer":
        if not record["transfer"] or not _matches_session(me, record["transfer"].get("session")):
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
    handoff: dict[str, Any] | None = None,
    lease_ttl: int | None = None,
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
        "reclaim": set(),
        "checkpoint": {"next", "blocker", "evidence", "verification"},
        "submit": {"next", "evidence", "verification"},
        "accept": {"note"},
        "request_changes": {"note"},
        "release": {"note"},
        "recover": {"note"},
        "offer_transfer": {"note"},
        "accept_transfer": set(),
    }
    if (
        details.keys() - allowed[action]
        or (successor is not None and action != "offer_transfer")
        or (handoff is not None and action not in {"checkpoint", "submit", "release"})
        or (lease_ttl is not None and action not in {"claim", "reclaim", "checkpoint"})
    ):
        raise mailbox.MailboxError(f"fields do not apply to work action {action}")
    if action == "create":
        if item is not None or revision is not None:
            raise mailbox.MailboxError("create does not take item or revision")
    elif any(value is not None for value in (key, title, scope, acceptance, dependencies, integrator)):
        raise mailbox.MailboxError("work title, scope, acceptance and dependencies are immutable; roles use transfer")
    path = base / "work" / "board.json"
    with mailbox.locked(path):
        board = _read(path)
        presence: dict[str, Any] = {}
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
            _transition(
                base,
                board,
                me,
                record,
                action,
                revision,
                details,
                successor,
                handoff=handoff,
                lease_ttl=lease_ttl,
                presence=presence,
            )
        states = _states(board)
        result = {"item": _view(base, states, record, presence), "replayed": replayed}
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
