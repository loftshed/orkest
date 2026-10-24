"""Read-only agent and work summaries, with bounded local change waits and no subscriptions."""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from pathlib import Path
from typing import Any

import mailbox_work as work
import peer_mailbox as mailbox


def short(value: Any, maximum: int = 160) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= maximum else text[: maximum - 1] + "…"


def _matches(identity: dict[str, Any] | None, address: str) -> bool:
    return bool(identity and address in {identity.get("session"), identity.get("name")})


def snapshot(
    base: Path,
    me: dict[str, Any],
    *,
    agent: str | None = None,
    channel: str | None = None,
    limit: int = 10,
    offset: int = 0,
) -> dict[str, Any]:
    if type(limit) is not int or not 1 <= limit <= 50 or type(offset) is not int or offset < 0:
        raise mailbox.MailboxError("status needs limit 1-50 and a nonnegative offset")
    for label, value in (("agent", agent), ("channel", channel)):
        if value is not None and (not isinstance(value, str) or not value.strip() or len(value) > 200):
            raise mailbox.MailboxError(f"status {label} needs 1-200 characters")
    items = work.snapshot(base, me)
    agents = []
    members = set()
    for path in sorted((base / "peers").glob("*.json")):
        peer = mailbox.load(path)
        if not mailbox.valid_peer(peer) or mailbox.is_run_peer(peer) or not mailbox.same_project(me, peer):
            continue
        if agent and not _matches(peer, agent):
            continue
        if channel and channel not in peer.get("channels", []):
            continue
        members.add(peer["session"])
        agents.append(
            {
                "session": peer["session"],
                "name": short(peer.get("name"), 128),
                "harness": peer["harness"],
                "state": peer.get("state") or "unknown",
                "presence": "present" if mailbox.is_live(peer) else "not_present",
                "focus": short(peer.get("focus"), 200),
                "lastSeenAt": peer["lastSeenAt"],
            }
        )
    summaries = []
    selected_state = []
    for item in items:
        roles = [item.get(role) for role in ("owner", "integrator", "creator")]
        if agent and not any(_matches(role, agent) for role in roles):
            continue
        if channel and not any(role and role.get("session") in members for role in roles):
            continue
        selected_state.append({k: v for k, v in item.items() if k not in {"updatedAt", "createdAt", "revision"}})
        summaries.append(
            {
                "id": item["id"],
                "title": short(item["title"], 120),
                "source": item["source"],
                "updatedAt": item["updatedAt"],
                "state": item["state"],
                "owner": (item.get("owner") or {}).get("session"),
                "integrator": (item.get("integrator") or {}).get("session"),
                "next": short(item.get("next")),
                "blocker": short(item.get("blocker"), 120),
                "evidence": short(item.get("evidence")),
                "verification": short(item.get("verification")),
                "done": short(item.get("done"), 120),
                "note": short(item.get("note"), 120),
                "recoveryNeeded": item.get("recoveryNeeded"),
                "ready": item.get("ready", False),
            }
        )
    agents.sort(key=lambda row: row["session"])
    summaries.sort(key=lambda row: row["id"])
    # Heartbeats and update timestamps are deliberately absent. The cursor covers all selected rows,
    # including off-page changes; it is a comparison token, never a saved event history or authorization.
    semantic = {
        "agents": [{k: v for k, v in peer.items() if k != "lastSeenAt"} for peer in agents],
        "items": sorted(selected_state, key=lambda row: row["id"]),
        "agent": agent,
        "channel": channel,
        "project": {k: mailbox.project(me).get(k) for k in ("repo", "remotes")},
    }
    cursor = hashlib.sha256(json.dumps(semantic, sort_keys=True).encode()).hexdigest()
    rows = [("agents", row) for row in agents] + [("items", row) for row in summaries]
    result = {
        "agents": [],
        "items": [],
        "cursor": cursor,
        "status": "snapshot",
        "observedAt": mailbox.stamp(),
        "total_count": len(rows),
        "has_more": False,
        "next_offset": None,
    }
    count = 0
    for kind, row in rows[offset : offset + limit]:
        result[kind].append(row)
        # Reserve envelope bytes for pagination and timeout status before accepting another row.
        if len(json.dumps(result, ensure_ascii=True).encode()) + 128 > work.PAGE_BYTES:
            result[kind].pop()
            if not count:
                raise mailbox.MailboxError("status summary exceeds its page budget; inspect the item with board")
            break
        count += 1
    result.update(
        has_more=offset + count < len(rows), next_offset=offset + count if offset + count < len(rows) else None
    )
    return result


def observe(
    base: Path,
    me: dict[str, Any],
    *,
    since: str | None = None,
    timeout: float = 300,
    cancelled: threading.Event | None = None,
    **filters: Any,
) -> dict[str, Any]:
    """Return one meaningful change or timeout. Polling is local, bounded, and consumes no model turns."""
    if since is not None and (not isinstance(since, str) or not re.fullmatch(r"[a-f0-9]{64}", since)):
        raise mailbox.MailboxError("since must be the cursor from a prior status result")
    if isinstance(timeout, bool) or not isinstance(timeout, int | float) or not 0 < timeout <= 600:
        raise mailbox.MailboxError("status timeout needs 0-600 seconds, greater than zero")
    stop = cancelled or threading.Event()
    deadline = time.monotonic() + timeout
    while True:
        result = snapshot(base, me, **filters)
        if since is None:
            return result
        if result["cursor"] != since:
            return {**result, "status": "changed"}
        if stop.is_set():
            return {**result, "status": "cancelled"}
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {**result, "status": "timed_out"}
        stop.wait(min(2, remaining))


def render(result: dict[str, Any]) -> str:
    lines = [f"Agent status: {result['status']} at {result['observedAt']} (presence is not proof of progress)."]
    for peer in result["agents"]:
        lines.append(f"{peer['name']} [{peer['state']}, {peer['presence']}]: {peer['focus'] or 'no focus recorded'}")
    for item in result["items"]:
        lines.append(f"{item['id']} [{item['state']}] {item['title']}")
        for field in ("done", "next", "blocker", "evidence", "verification", "note", "recoveryNeeded"):
            if item.get(field):
                lines.append(f"  {field}: {item[field]}")
    if not result["agents"] and not result["items"]:
        lines.append("No matching records; this does not prove that all work is complete.")
    if result["has_more"]:
        lines.append(f"More records: offset={result['next_offset']}; pages are live snapshots.")
    lines.append("Cursor: " + result["cursor"])
    return "\n".join(lines)
