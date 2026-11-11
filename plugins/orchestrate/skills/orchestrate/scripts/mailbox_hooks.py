"""Turn lifecycle hooks, /clear context adoption, team lead succession notices, and swarm context."""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import socket
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any

import room_store
from mailbox_store import (
    _MB,
    NAME_RULE,
    MailboxError,
    display_label,
    inbox_dir,
    locked,
    peer_path,
    session_key,
    valid_peer,
)

_TRANSCRIPT_TAIL_BYTES = 256 * 1024
_MODEL_SET_STDOUT = re.compile(r"<local-command-stdout>Set model to (?:`([^`]+)`|([^\n<(]+))")
_WAKE_NOTICE_ID = re.compile(r"Local peer mailbox notification \(([A-Za-z0-9._-]+)\)")
_SWARM_SLASH_CMD = re.compile(r"^\s*/(?:orchestrate:)?(?:swarm|horde)(?:\s+(.*?))?\s*$", re.IGNORECASE | re.DOTALL)
_SWARM_TAG_CMD = re.compile(r"\[orkest-swarm-command(?::\s*(.*?))?\]", re.IGNORECASE | re.DOTALL)
_SIDE_SLASH_CMD = re.compile(r"^\s*/(?:orchestrate:)?side(?:\s+(.*))?\s*$", re.IGNORECASE | re.DOTALL)
_SIDE_TAG_CMD = re.compile(r"\[orkest-side-command:\s*(.*?)\]", re.IGNORECASE | re.DOTALL)
_SIDE_PREFIX_CMD = re.compile(r"^\s*(?:!side\s+|side:\s*)(.+?)\s*$", re.IGNORECASE | re.DOTALL)
_AGY_SUBAGENT_SENDER = re.compile(r"<SYSTEM_MESSAGE>\s*\[Message\][^\n]*?\bsender=([A-Za-z0-9_.:-]+)")

ANTIGRAVITY_NO_CONTINUE = {
    "USER_CANCELED",
    "ERROR",
    "MAX_INVOCATIONS",
    "MAX_FORCED_INVOCATIONS",
    "MAX_TOKEN_BUDGET_EXCEEDED",
}

# A /clear ends one session and starts another in the same harness process; pair them within this window.
CLEAR_PAIRING = dt.timedelta(minutes=10)
# Requests a cleared session had read but not answered within this window travel to its successor.
OPEN_REQUEST_WINDOW = dt.timedelta(hours=24)
MAILBOX_SENDER = {"session": "mailbox", "name": "mailbox", "harness": "unknown"}


def latest_user_prompt(payload: dict[str, Any], session: str, account: str | None = None) -> str | None:
    """Return the user's latest prompt text from the hook payload or session transcript tail."""
    for key in ("lastUserInput", "prompt", "userMessage", "query"):
        if isinstance(value := payload.get(key), str) and value.strip():
            return value
    raw_path = payload.get("transcript_path") or payload.get("transcriptPath")
    path = Path(raw_path).expanduser() if isinstance(raw_path, str) and raw_path.strip() else None
    if path is None and session:
        home = Path(account).expanduser() if isinstance(account, str) and account else Path.home() / ".gemini"
        candidate = home / "antigravity-cli/brain" / session / ".system_generated/logs/transcript.jsonl"
        if candidate.is_file():
            path = candidate
    if path is None:
        return None
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            offset = max(0, size - 16384)
            handle.seek(offset)
            chunk = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    lines = chunk.splitlines()
    if offset > 0 and lines:
        lines = lines[1:]
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        kind = entry.get("type")
        if kind in {"USER_INPUT", "user"}:
            content = entry.get("content")
            if not isinstance(content, str) and isinstance(entry.get("message"), dict):
                content = entry["message"].get("content")
            if isinstance(content, str):
                return content
            return None
        if kind in {"SYSTEM_MESSAGE", "PLANNER_RESPONSE", "assistant"}:
            return None
    return None


def wake_notice_id(payload: dict[str, Any], session: str, account: str | None = None) -> str | None:
    """Message id from a `Local peer mailbox notification (<id>)` turn trigger, if this turn started from one."""
    prompt = _MB.latest_user_prompt(payload, session, account)
    return match.group(1) if prompt and (match := _WAKE_NOTICE_ID.search(prompt)) else None


def transcript_model(payload: dict[str, Any]) -> str | None:
    """Latest model recorded in a hook's transcript JSONL (catches mid-session `/model` changes)."""
    raw_path = payload.get("transcript_path") or payload.get("transcriptPath")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = Path(raw_path).expanduser()
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            offset = max(0, size - _TRANSCRIPT_TAIL_BYTES)
            handle.seek(offset)
            chunk = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    lines = chunk.splitlines()
    if offset > 0 and lines:
        lines = lines[1:]
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("isSidechain"):
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        if entry.get("type") == "assistant":
            model = message.get("model")
            if isinstance(model, str) and model.strip() and not model.strip().startswith("<"):
                return model.strip()
        if entry.get("type") == "user":
            content = message.get("content")
            if isinstance(content, str) and "<local-command-stdout>Set model to " in content:
                match = _MODEL_SET_STDOUT.search(content)
                if match:
                    chosen = (match.group(1) or match.group(2) or "").strip()
                    if chosen:
                        return chosen
    return None


def _agy_subagent_info(transcript_path: str | None) -> tuple[bool, str | None]:
    """Detect an Antigravity subagent from the opening JSONL entries of its transcript."""
    if not isinstance(transcript_path, str) or not transcript_path.strip():
        return False, None
    path = Path(transcript_path).expanduser()
    if not path.is_file():
        return False, None
    sender_uuid: str | None = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for _, line in zip(range(12), handle, strict=False):
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(entry, dict):
                    continue
                if entry.get("source") == "USER_EXPLICIT":
                    return False, None
                if sender_uuid is None and entry.get("type") == "SYSTEM_MESSAGE":
                    content = entry.get("content")
                    if not isinstance(content, str) and isinstance(entry.get("message"), dict):
                        content = entry["message"].get("content")
                    if isinstance(content, str) and (match := _AGY_SUBAGENT_SENDER.search(content)):
                        sender_uuid = match.group(1)
    except OSError:
        return False, None
    if sender_uuid:
        return True, sender_uuid
    return False, None


def _codex_sqlite_settings(account: str | None, session: str) -> tuple[str | None, str | None]:
    """Read (model, reasoning_effort) for a Codex thread from the newest state_*.sqlite in account_home."""
    if not isinstance(account, str) or not account.strip():
        return None, None
    account_path = Path(account).expanduser()
    if not account_path.is_dir():
        return None, None
    try:
        databases = sorted(
            account_path.glob("state_*.sqlite"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:8]
    except OSError:
        return None, None
    for db_path in databases:
        try:
            with contextlib.closing(
                sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=0.05)
            ) as connection:
                row = connection.execute(
                    "SELECT model, reasoning_effort FROM threads WHERE id = ?",
                    (session,),
                ).fetchone()
                if row:
                    model = str(row[0]).strip() if isinstance(row[0], str) and str(row[0]).strip() else None
                    effort = str(row[1]).strip() if isinstance(row[1], str) and str(row[1]).strip() else None
                    if model or effort:
                        return model, effort
        except (OSError, sqlite3.Error, ValueError):
            continue
    return None, None


def end_session(base: Path, session: str, *, reason: str, pid: int | None) -> None:
    # Serialize a normal exit with background disappearance detection. /clear registers its successor
    # and takes other peer locks, so keep its existing pairing path outside this lock.
    if reason == "clear":
        _end_session(base, session, reason=reason, pid=pid)
    else:
        with locked(peer_path(base, session)):
            _end_session(base, session, reason=reason, pid=pid)


def _end_session(base: Path, session: str, *, reason: str, pid: int | None) -> None:
    """A session is going away. A /clear keeps it for its successor; any other end tells its waiting senders."""
    peer = _MB.load(peer_path(base, session))
    if valid_peer(peer) and not _MB.is_run_peer(peer):
        if reason == "clear":
            _MB.write(
                base / "cleared" / f"{session_key(session)}.json",
                {**peer, "clearedAt": _MB.stamp(), "clearedPid": pid},
            )
            # Claude Code does not order the two events: the successor may already be waiting.
            moment = _MB.now()
            for path in (base / "peers").glob("*.json"):
                waiting = _MB.load(path)
                if (
                    valid_peer(waiting)
                    and waiting["session"] != session
                    and waiting.get("harness") == peer.get("harness")
                    and waiting.get("pid") == pid
                    and isinstance(waiting.get("awaitingClear"), str)
                    and moment - dt.datetime.fromisoformat(waiting["awaitingClear"]) <= CLEAR_PAIRING
                ):
                    notice = _MB.adopt_cleared(base, waiting)
                    waiting = _MB.load(peer_path(base, waiting["session"])) or waiting
                    swarm_notice = _MB.swarm_coordinator_context(base, waiting, "SessionStart")
                    if swarm_notice:
                        notice = f"{notice}\n\n{swarm_notice}" if notice else swarm_notice
                    if notice:
                        _MB.notify(base, waiting, notice)
                    break
        else:
            unread = _MB.messages(base, session)
            name = display_label(peer)
            _MB.notify_senders(
                base,
                unread,
                lambda _peer, ids: (
                    f"{name} ended ({reason or 'closed'}) without reading your message "
                    f"{', '.join(ids)}. Nobody received it: send it to another session if it still matters."
                ),
            )
    _MB.unregister(base, session)


def adopt_cleared(base: Path, me: dict[str, Any]) -> str:
    """Give a session started by /clear what its predecessor in the same process left: unread mail, requests it
    read but never answered, its names, and a lead role offered for acceptance. Returns a notice, or ''."""
    moment = _MB.now()
    stashed = []
    for path in (base / "cleared").glob("*.json"):
        record = _MB.load(path)
        if not valid_peer(record) or record["session"] == me["session"]:
            continue
        age = moment - dt.datetime.fromisoformat(record["clearedAt"])
        if age > CLEAR_PAIRING:
            path.unlink(missing_ok=True)  # never adopted: nothing in this process asked for it in time
        elif record.get("harness") == me["harness"] and record.get("clearedPid") == me.get("pid"):
            stashed.append((record["clearedAt"], path, record))
    if not stashed:
        # The old session's end may still be on its way; it hands over when it arrives.
        _MB.annotate(base, me["session"], awaitingClear=_MB.stamp())
        return ""
    _, path, old = max(stashed, key=lambda item: item[0])
    temp_name = me.get("name") if old.get("person") and old.get("person") != me.get("person") else None
    names = [old["session"], old.get("name"), *old.get("aliases", [])]
    adopted_aliases = [name for name in dict.fromkeys(names) if isinstance(name, str) and name != temp_name][-8:]
    focus = me.get("focus") or old.get("focus")
    if old.get("person") and old.get("person") != me.get("person"):
        _MB.annotate(base, me["session"], person=old["person"])
        refreshed = _MB.register(base, session=me["session"], harness=me["harness"], cwd=me["cwd"])
        me.update(refreshed)
    annotated = _MB.annotate(
        base,
        me["session"],
        aliases=adopted_aliases,
        clearedFrom=old["session"],
        awaitingClear=None,
        **({"focus": focus} if focus else {}),
        **({"channels": old["channels"]} if old.get("channels") else {}),
    )
    if isinstance(annotated, dict):
        me.update(annotated)
    # The cleared record is paired by harness/process; only its verified history travels.
    current_native = (
        me.get("nativeSession") if me.get("nativeSession") in _MB.native_session_ids(me, base) else me["session"]
    )
    me.update(
        _MB.attest_native_sessions(base, me["session"], *sorted(_MB.native_session_ids(old, base)), current_native)
    )
    carried, orphaned, replied = [], 0, _MB.replied_to(base, old["session"])
    for message in _MB.messages(base, old["session"], unread_only=False):
        sent = dt.datetime.fromisoformat(message["sentAt"])
        unread = not message.get("readAt")
        open_request = (
            not unread
            and moment - sent <= OPEN_REQUEST_WINDOW
            and message["from"].get("session") != MAILBOX_SENDER["session"]
            and message.get("kind") not in {"reply", "update", "notice"}
            and message["id"] not in replied
        )
        if open_request and not _MB.live_session(base, message["from"].get("session")):
            # Nobody waits on it any more, and its reply may have gone with the sender's inbox.
            orphaned += 1
            continue
        if unread or open_request:
            message.update(
                to={"session": me["session"], "name": me["name"]},
                readAt=None,
                carriedFrom=old["session"],
                carried="unread before /clear" if unread else "read before /clear but never answered",
            )
            _MB.write(inbox_dir(base, me["session"]) / f"{message['id']}.json", message)
            (inbox_dir(base, old["session"]) / f"{message['id']}.json").unlink(missing_ok=True)
            carried.append(message)
    old_progress_path = base / "progress" / f"{session_key(old['session'])}.json"
    new_progress_path = base / "progress" / f"{session_key(me['session'])}.json"
    if old_progress_path.is_file() and not new_progress_path.exists():
        with contextlib.suppress(OSError, ValueError), locked(new_progress_path):
            if not new_progress_path.exists():
                old_progress = _MB.load(old_progress_path)
                if isinstance(old_progress, dict):
                    _MB.write(new_progress_path, {**old_progress, "session": me["session"]})
    board_path = base / "work" / "board.json"
    if board_path.is_file():
        with contextlib.suppress(OSError, ValueError), locked(board_path):
            board = _MB.load(board_path)
            raw_items = board.get("items") if isinstance(board, dict) else None
            item_list = (
                raw_items
                if isinstance(raw_items, list)
                else (list(raw_items.values()) if isinstance(raw_items, dict) else [])
            )
            if item_list:
                board_changed = False
                for item in item_list:
                    if not isinstance(item, dict):
                        continue
                    for role_key in ("creator", "integrator", "owner", "transfer"):
                        role_obj = item.get(role_key)
                        if isinstance(role_obj, str) and role_obj == old["session"]:
                            item[role_key] = me["session"]
                            board_changed = True
                        elif isinstance(role_obj, dict):
                            if role_obj.get("session") == old["session"]:
                                role_obj["session"] = me["session"]
                                if me.get("name"):
                                    role_obj["name"] = str(me["name"])[:120]
                                board_changed = True
                            for sub_key in ("to", "from"):
                                sub_val = role_obj.get(sub_key)
                                if isinstance(sub_val, str) and sub_val == old["session"]:
                                    role_obj[sub_key] = me["session"]
                                    board_changed = True
                                elif isinstance(sub_val, dict) and sub_val.get("session") == old["session"]:
                                    sub_val["session"] = me["session"]
                                    if me.get("name"):
                                        sub_val["name"] = str(me["name"])[:120]
                                    board_changed = True
                if board_changed:
                    _MB.write(board_path, board)
    _MB.notify_senders(
        base,
        carried,
        lambda _peer, ids: (
            f"{display_label(me)} (formerly {old.get('name')}) cleared its context. Your message "
            f"{', '.join(ids)} now reaches it, but the conversation behind it is gone: resend any context it needs."
        ),
    )
    offers = _MB.offer_cleared_lead(old["session"], me)
    path.unlink(missing_ok=True)
    lines = [
        f"Your earlier context in this process was cleared (previous session {old['session']}, {old.get('name')})."
    ]
    if old.get("focus"):
        lines.append(f"Before that you were working on: {old['focus']}.")
    if old.get("channels"):
        lines.append(f"You are still in channel {', '.join(old['channels'])}; leave it if your task changed.")
    if carried:
        lines.append(
            f"{len(carried)} message(s) addressed to you before /clear follow; the conversation behind them is gone, "
            "so ask the sender for context before acting."
        )
    if orphaned:
        lines.append(f"{orphaned} request(s) you had read came from sessions that have since ended; not carried.")
    lines += offers
    return "\n".join(lines)


def offer_cleared_lead(old_session: str, me: dict[str, Any]) -> list[str]:
    """A cleared lead's role is offered to its successor session, which must review and accept it."""
    path = Path(__file__).with_name("authority.py")
    spec = importlib.util.spec_from_file_location("agent_executor_mailbox_authority", path)
    if spec is None or spec.loader is None:
        return []
    authority = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(authority)
    notes = []
    for directory in sorted((authority.cache_dir() / "authority-v1").glob("*")):
        with contextlib.suppress(ValueError, OSError):
            record = authority.load(directory)
            if not record or record["lead"]["session"] != old_session:
                continue
            team, generation = record["team"], record["generation"]
            if record["status"] == "pending":
                notes.append(
                    f"You were taking over team {team} (generation {generation}) but had not accepted. A cleared "
                    "successor cannot accept: only the user can re-appoint the team's lead now."
                )
                continue
            pending_to = (record.get("offer") or {}).get("to") or {}
            if pending_to.get("session") not in (None, me["session"]):
                # A planned handover the lead already made stands; the hook never redirects it.
                notes.append(
                    f"You were the lead of team {team} (generation {generation}) and had offered the role to "
                    f"{pending_to['session']}. That offer stands and this session was not offered the role."
                )
                continue
            if record["status"] == "active":
                authority.offer(
                    record["team"],
                    old_session,
                    record["generation"],
                    authority.member(me["session"], me["harness"]),
                    note="offered to the session that replaced the lead after /clear",
                )
                notes.append(
                    f"You were the lead of team {record['team']} (generation {record['generation']}). The role is "
                    f"offered to this session, not given: run authority.py show --team {record['team']} --harness "
                    f"{me['harness']}, review it, then accept with its digest. Until then the old generation stands."
                )
    return notes


def succession_module() -> Any:
    path = Path(__file__).with_name("succession.py")
    spec = importlib.util.spec_from_file_location("agent_executor_mailbox_succession", path)
    if spec is None or spec.loader is None:
        raise MailboxError("cannot load succession")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def succession_notice(base: Path, me: dict[str, Any]) -> str:
    """Quota advice for a team's lead or deputy: from monitor's cache, at most every few minutes, once per status.

    The lead hears when its pool runs low or out, so it can checkpoint and offer the handover. The deputy hears
    when the lead's pool is exhausted and the lead has gone quiet: a lead that is out takes no turns, so its own
    hook can never say so."""
    if me.get("delegatedRun") or _MB.is_run_peer(me):
        return ""
    try:
        succession = _MB.succession_module()
        authority = succession.module("authority")
        records = [
            record
            for directory in sorted((authority.cache_dir() / "authority-v1").glob("*"))
            if (record := authority.load(directory)) and record.get("status") == "active"
        ]
    except (MailboxError, OSError, ValueError, ImportError):
        return ""
    config = succession.monitor_config()
    roles = []
    for record in records:
        deputy = record.get("deputy") or {}
        if record["lead"]["session"] == me["session"]:
            roles.append(("lead", record))
        elif succession.same_repository(me.get("repo"), record.get("repository")) and (
            deputy.get("session") == me["session"]
            or (
                not deputy.get("session")
                and deputy.get("harness") == me["harness"]
                and deputy.get("account")
                and succession.account_of(me["harness"], me.get("accountHome"), config)[0] == deputy["account"]
            )
        ):
            # Only in the team's own repository: one Codex or Antigravity login serves work and personal repos.
            roles.append(("deputy", record))
    if not roles:
        return ""
    checked = succession.parse_time(me.get("successionCheckedAt"))
    if checked is not None and (_MB.now() - checked).total_seconds() < succession.HOOK_CHECK_SECONDS:
        return ""
    _MB.annotate(base, me["session"], successionCheckedAt=_MB.stamp())
    view = succession.cached_view()
    if view is None:
        return ""
    by_key = {pool["pool"]: pool for pool in succession.pools(view, config)}
    notified = dict(me.get("successionNotified") or {})
    lines = []
    for role, record in roles:
        team, lead_pool = record["team"], by_key.get(record["lead"].get("pool") or "")
        if lead_pool is None:
            continue
        status, key = lead_pool["status"], f"{record['team']}:{role}"
        deputy = record.get("deputy") or {}
        if deputy:
            notified.pop(f"{team}:no-deputy", None)
        if role == "lead" and not deputy and not notified.get(f"{team}:no-deputy"):
            lines.append(
                f"Team {team} has no deputy, so nobody can take over if your pool runs out. Run authority.py "
                f"propose --session {me['session']} --harness {me['harness']} and ask the user to appoint one."
            )
            notified[f"{team}:no-deputy"] = "told"
        if role == "lead":
            if status in ("low", *succession.EXHAUSTED) and notified.get(key) != status:
                to = (
                    deputy.get("session") or "SESSION (start one on " + str(deputy.get("pool") or "a deputy pool") + ")"
                )
                lines.append(
                    f"Team {team}: your pool {lead_pool['pool']} is {status}. Checkpoint your work first, then hand "
                    f"over: authority.py offer --team {team} --session {me['session']} --expect-generation "
                    f"{record['generation']} --to-session {to} --to-harness {deputy.get('harness') or 'HARNESS'}"
                    + ("" if deputy else ". No deputy is named: run authority.py propose first and ask the user")
                    + "."
                )
            notified[key] = status
            continue
        offered = (record.get("offer") or {}).get("to") or {}
        if offered.get("session") == me["session"]:
            told = f"{team}:offer:{record['generation']}"
            if not notified.get(told):
                lines.append(
                    f"Team {team}: the lead offered you the handover. Run authority.py show --team {team} --harness "
                    f"{me['harness']}, review it, then authority.py accept --team {team} --session {me['session']} "
                    f"--harness {me['harness']} --expect-generation {record['generation']} --digest DIGEST."
                )
                notified[told] = "told"
            continue
        rule = record.get("standing")
        statuses = rule["statuses"] if rule else list(succession.EXHAUSTED)
        lead_peer = _MB.load(peer_path(base, record["lead"]["session"]))
        seen = succession.parse_time((lead_peer or {}).get("lastSeenAt"))
        quiet = None if seen is None else int((_MB.now() - seen).total_seconds())
        if status not in statuses:
            notified[key] = status
            continue
        if (quiet is not None and quiet < (rule["seconds"] if rule else 0)) or notified.get(key) == status:
            continue
        if rule:
            # Advise a standing takeover only when it would pass now (fresh data is the takeover's own check);
            # otherwise stay quiet and unlatched, so the notice comes once the blocking condition clears.
            reasons, lead_status = succession.monitor_evidence(
                record, view=view, config=config, moment=_MB.now(), fresh_required=False
            )
            reasons += succession.local_evidence(record, lead_status=lead_status, moment=_MB.now())
            if reasons:
                continue
        how = "--standing" if rule else "--user-approved, after asking the user"
        lines.append(
            f"Team {team}: the lead's pool {lead_pool['pool']} is {status} and the lead has been quiet "
            + ("since it ended" if quiet is None else f"{quiet} s")
            + f". You are its deputy: run authority.py takeover --team {team} --session {me['session']} "
            f"--harness {me['harness']} --expect-generation {record['generation']} {how}, then review "
            "authority.py show and accept with its digest."
        )
        notified[key] = status
    _MB.annotate(base, me["session"], successionNotified=notified)
    return "\n".join(lines)


def _swarm_next_advisor(
    base: Path,
    me: dict[str, Any],
    room: dict[str, Any],
    room_id: str,
    member_id: str,
) -> str:
    """Compute canonical swarmNextDigest over actionable room items and emit a compact advisor when changed."""
    fresh_room = room_store.read_room(base, room_id)
    if isinstance(fresh_room, dict):
        room = fresh_room
    agents = [a for a in (room.get("agents") or []) if isinstance(a, dict)]
    if member_id != "conductor":
        scoped = [a for a in agents if a.get("parent") == member_id]
        if scoped:
            agents = scoped

    respond_items: list[str] = []
    expired_lease_items: list[str] = []
    review_items: list[str] = []
    failed_items: list[str] = []
    smelt_items: list[str] = []
    queued_items: list[str] = []
    advisor_lines: list[str] = []

    for agent in agents:
        agent_id = str(agent.get("id") or "worker")
        status_lower = str(agent.get("status") or "").lower()
        dispatch = agent.get("dispatch") if isinstance(agent.get("dispatch"), dict) else None
        task_dir_raw = dispatch.get("taskDir") if dispatch else None
        task_data: dict[str, Any] | None = None

        if isinstance(task_dir_raw, str) and task_dir_raw.strip():
            task_dir = Path(task_dir_raw).expanduser()
            task_file = task_dir / "task.json"
            if task_file.is_file():
                loaded_task = _MB.load(task_file)
                if isinstance(loaded_task, dict):
                    task_data = loaded_task
                    runs = [r for r in (task_data.get("runs") or []) if isinstance(r, dict)]
                    needs_recover = any(
                        r.get("status") in {"dispatching", "uncertain", "active", "reserved"}
                        and isinstance(r.get("result_path"), str)
                        and Path(r["result_path"]).is_file()
                        for r in runs
                    )
                    if needs_recover:
                        with contextlib.suppress(Exception):
                            import coordinator as _coord

                            recovered = _coord.auto_recover_task(task_dir)
                            if isinstance(recovered, dict):
                                task_data = recovered
                            else:
                                reloaded = _MB.load(task_file)
                                if isinstance(reloaded, dict):
                                    task_data = reloaded

        if isinstance(task_data, dict):
            runs = [r for r in (task_data.get("runs") or []) if isinstance(r, dict)]
            decided_run_ids = {
                str(d.get("run_id"))
                for d in (task_data.get("decisions") or [])
                if isinstance(d, dict) and d.get("run_id") and d.get("decision")
            }
            for run in runs:
                run_id = str(run.get("run_id") or "")
                conductor_peer = (
                    (run.get("mailbox") or {}).get("conductor") if isinstance(run.get("mailbox"), dict) else None
                )
                if isinstance(conductor_peer, str) and conductor_peer:
                    c_inbox = inbox_dir(base, conductor_peer)
                    if c_inbox.is_dir():
                        unread = [
                            p
                            for p in c_inbox.glob("*.json")
                            if isinstance(m := _MB.load(p), dict) and not m.get("readAt")
                        ]
                        if unread:
                            respond_items.append(f"respond:{agent_id}:{run_id}:{len(unread)}")
                            advisor_lines.append(
                                f"- [respond] {agent_id} ({run_id}) has {len(unread)} unread worker message(s) waiting."
                            )
            if runs:
                latest_run = runs[-1]
                run_id = str(latest_run.get("run_id") or "")
                run_status = str(latest_run.get("status") or "")
                runner_status = latest_run.get("runner_status")
                if run_status == "finished" and run_id not in decided_run_ids:
                    if runner_status in {None, "completed"}:
                        review_items.append(f"review:{agent_id}:{run_id}")
                        advisor_lines.append(
                            f"- [review] {agent_id} finished run {run_id}; review with `coordinator.py review --task-dir {task_dir_raw} --run-id {run_id} --decision accept`."
                        )
                    else:
                        failed_items.append(f"failed:{agent_id}:{run_id}:{runner_status}")
                        advisor_lines.append(
                            f"- [failed] {agent_id} run {run_id} ended with {runner_status}; inspect artifacts in {task_dir_raw}."
                        )
                elif run_status == "uncertain" and run_id not in decided_run_ids:
                    failed_items.append(f"failed:{agent_id}:{run_id}:uncertain")
                    advisor_lines.append(
                        f"- [failed] {agent_id} run {run_id} is uncertain; run `coordinator.py recover --task-dir {task_dir_raw}`."
                    )

        if agent.get("dispatchError"):
            failed_items.append(f"failed:{agent_id}:dispatch_error")
            advisor_lines.append(f"- [failed] {agent_id} dispatch error: {agent.get('dispatchError')}")

        wt = agent.get("worktree") if isinstance(agent.get("worktree"), dict) else None
        if wt and wt.get("branch") and status_lower in {"completed", "complete", "done"}:
            branch = str(wt.get("branch"))
            smelt_items.append(f"smelt:{agent_id}:{branch}")
            advisor_lines.append(
                f"- [smelt] {agent_id} worktree branch `{branch}` is ready to smelt (`ork smelter run`)."
            )

        if status_lower == "queued" and not dispatch and not agent.get("session"):
            queued_items.append(f"dispatch_queued:{agent_id}")
            advisor_lines.append(f"- [dispatch_queued] {agent_id} is queued and ready to dispatch.")

    # Check expired workboard leases
    with contextlib.suppress(Exception):
        board = _MB.load(base / "work" / "board.json") or _MB.load(base / "workboard.json")
        if isinstance(board, dict) and isinstance(board.get("items"), list):
            import succession

            now_dt = _MB.now()
            for item in board["items"]:
                if not isinstance(item, dict) or item.get("status") != "claimed":
                    continue
                lease_raw = item.get("leaseExpiresAt") or (item.get("lease") or {}).get("expiresAt")
                lease_exp = succession.parse_time(lease_raw)
                if lease_exp is not None and lease_exp < now_dt:
                    item_id = str(item.get("id") or "")
                    expired_lease_items.append(f"expired_leases:{item_id}")
                    advisor_lines.append(f"- [expired_leases] Workboard item {item_id} has an expired claim lease.")

    all_actions = [
        *respond_items,
        *expired_lease_items,
        *review_items,
        *failed_items,
        *smelt_items,
        *queued_items,
    ]
    if not all_actions:
        if me.get("swarmNextDigest") is not None or me.get("swarmNextTurns"):
            _MB.annotate(base, me["session"], swarmNextDigest=None, swarmNextTurns=0)
        return ""

    digest = hashlib.sha256("|".join(all_actions).encode("utf-8")).hexdigest()[:16]
    has_blocker = bool(respond_items or expired_lease_items or failed_items)
    prev_digest = me.get("swarmNextDigest")
    turns_since = int(me.get("swarmNextTurns") or 0) + 1

    if digest == prev_digest:
        if has_blocker and turns_since >= 5:
            _MB.annotate(base, me["session"], swarmNextDigest=digest, swarmNextTurns=0)
        else:
            _MB.annotate(base, me["session"], swarmNextTurns=turns_since)
            return ""
    else:
        _MB.annotate(base, me["session"], swarmNextDigest=digest, swarmNextTurns=0)

    top_lines = advisor_lines[:2]
    return f"Swarm next step (room {room_id}, digest {digest}):\n" + "\n".join(top_lines)


def _format_swarm_reconnection_summary(room: dict[str, Any], room_id: str, member_id: str) -> str:
    title = str(room.get("title") or room_id).strip()
    role_label = "root swarm coordinator (conductor)" if member_id == "conductor" else f"subswarm lead ({member_id})"
    objective = str(room.get("objective") or "").strip()
    if member_id != "conductor" and isinstance(room.get("agents"), list):
        for agent in room["agents"]:
            if isinstance(agent, dict) and agent.get("id") == member_id and isinstance(agent.get("objective"), str):
                if agent["objective"].strip():
                    objective = agent["objective"].strip()
                break
    agents = [a for a in (room.get("agents") or []) if isinstance(a, dict)]
    active = sum(
        1
        for a in agents
        if str(a.get("status") or "").lower()
        in {"running", "active", "working", "planning", "testing", "review", "claimed", "reserved", "spawned"}
    )
    completed = sum(
        1 for a in agents if str(a.get("status") or "").lower() in {"completed", "complete", "done", "merged"}
    )
    blocked = sum(1 for a in agents if str(a.get("status") or "").lower() in {"blocked", "failed", "rejected", "error"})
    title_part = f" ({title})" if title and title != room_id else ""
    obj_part = f" Objective: {objective}." if objective else ""
    counts = f"{len(agents)} total ({active} active, {completed} completed, {blocked} blocked/failed)"
    return (
        f"Reconnected to swarm room {room_id}{title_part} as {role_label}.{obj_part} "
        f"Horde members: {counts}. "
        f"Run `ork rooms show --room {room_id}` to inspect your swarm or `/swarm` to toggle the Swarm View."
    )


def _deliver_swarm_brief_or_summary(
    base: Path,
    me: dict[str, Any],
    room: dict[str, Any],
    room_id: str,
    member_id: str,
    instance_key: str,
    *,
    allow_brief: bool = True,
) -> str:
    """Deliver the member's swarm brief on first briefing (only recording swarmBriefed after a read) or reconnect summary."""
    has_state = bool(room.get("objective") or room.get("agents"))
    already_reconnected = me.get("swarmAutoReconnected") == instance_key
    if allow_brief and me.get("swarmBriefed") != room_id:
        brief_file = base / "swarm-briefs" / room_id / f"{member_id}.md"
        with contextlib.suppress(OSError):
            if brief_file.is_file():
                brief_text = (
                    brief_file.read_text(encoding="utf-8").replace("YOUR_ACTUAL_SESSION_ID", me["session"]).strip()
                )
                if brief_text:
                    _MB.annotate(base, me["session"], swarmBriefed=room_id, swarmAutoReconnected=instance_key)
                    if has_state and not already_reconnected:
                        return f"{brief_text}\n\n{_format_swarm_reconnection_summary(room, room_id, member_id)}"
                    return brief_text
    if has_state and not already_reconnected:
        _MB.annotate(base, me["session"], swarmAutoReconnected=instance_key)
        return _format_swarm_reconnection_summary(room, room_id, member_id)
    return ""


def _herdr_active() -> bool:
    """Return True if Herdr environment integration is active and not suppressed by pytest or unittest."""
    if os.environ.get("HERDR_ENV") != "1":
        return False
    return not (
        (os.environ.get("PYTEST_CURRENT_TEST") or "unittest" in sys.modules)
        and os.environ.get("ORKEST_TEST_ALLOW_HERDR") != "1"
    )


def _maybe_trigger_auto_update(base: Path, me: dict[str, Any], event: str) -> None:
    """Spawn a detached background auto-update check on SessionStart at most once every 30 minutes."""
    if event != "SessionStart":
        return
    if me.get("isSubagent") or me.get("delegatedRun") or _MB.is_run_peer(me):
        return
    if os.environ.get("PYTEST_CURRENT_TEST") and os.environ.get("ORKEST_TEST_AUTO_UPDATE") != "1":
        return
    state_file = base.parent / "auto-update-v1.json"
    with contextlib.suppress(Exception):
        if state_file.is_file():
            now_ts = dt.datetime.now(dt.UTC).timestamp()
            if (now_ts - state_file.stat().st_mtime) < 1800:
                return
            state_data = _MB.load(state_file)
            if isinstance(state_data, dict):
                raw_checked = (
                    state_data.get("lastCheckedAt") or state_data.get("checkedAt") or state_data.get("checked_at")
                )
                if isinstance(raw_checked, int | float):
                    ts = raw_checked / 1000.0 if raw_checked > 1e11 else float(raw_checked)
                    if (now_ts - ts) < 1800:
                        return
                elif isinstance(raw_checked, str) and raw_checked.strip():
                    import succession

                    parsed = succession.parse_time(raw_checked)
                    if parsed is not None and (_MB.now() - parsed).total_seconds() < 1800:
                        return
        cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
        node_bin = shutil.which("node") or "node"
        subprocess.Popen(
            [node_bin, str(cli), "update", "run", "--auto", "--quiet"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )


def _update_notice(base: Path, me: dict[str, Any]) -> str:
    """One line at session start when the background check found an update the user has not applied."""
    if me.get("isSubagent") or me.get("delegatedRun") or _MB.is_run_peer(me):
        return ""
    with contextlib.suppress(Exception):
        state = _MB.load(base.parent / "auto-update-v1.json")
        if not isinstance(state, dict) or state.get("status") != "update_available":
            return ""
        plugin_root = Path(__file__).resolve().parents[3]
        head = subprocess.run(
            ["git", "-C", str(plugin_root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout.strip()
        if not head or head == state.get("remoteSha"):
            return ""
        count = state.get("commitsBehind")
        what = f"{count} new commit{'' if count == 1 else 's'}" if isinstance(count, int) else "new commits"
        return f"An Orkest update is available ({what}). Tell the user it is there: run /update to apply it, then restart sessions."
    return ""


def _record_native_swarm_identity(base: Path, me: dict[str, Any]) -> None:
    """Attest this harness's native environment ID without claiming another live conversation."""
    if me.get("isSubagent") or me.get("delegatedRun") or _MB.is_run_peer(me):
        return
    key = {
        "claude": "CLAUDE_CODE_SESSION_ID",
        "codex": "CODEX_THREAD_ID",
        "gemini": "ANTIGRAVITY_CONVERSATION_ID",
        "opencode": "OPENCODE_SESSION_ID",
    }.get(me.get("harness"))
    native = os.environ.get(key, "") if key else ""
    if not native:
        return
    owner = _MB.session_peer(base, native, harness=me["harness"], cwd=me["cwd"])
    if owner and owner["session"] != me["session"]:
        return
    updated = _MB.attest_native_sessions(base, me["session"], native)
    if isinstance(updated, dict):
        me.update(updated)


def _promote_resumed_coordinator(base: Path, me: dict[str, Any]) -> dict[str, Any] | None:
    cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
    environment = {**os.environ, "AGENT_EXECUTOR_HOME": str(base.parent), "ORCHESTRATE_HOME": str(base.parent)}
    with contextlib.suppress(OSError, ValueError, subprocess.SubprocessError):
        result = subprocess.run(
            [room_store._node_binary(), str(cli), "hall", "promote", "--session", me["session"], "--cwd", me["cwd"]],
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode == 0:
            room = json.loads(result.stdout).get("room")
            if isinstance(room, dict):
                return room
    return None


def swarm_coordinator_context(
    base: Path, me: dict[str, Any], event: str = "SessionStart", *, mid_turn: bool = False
) -> str:
    """Auto-bind the root swarm coordinator (or reconnect a resumed coordinator/lead) and deliver its brief."""
    if me.get("isSubagent") or me.get("delegatedRun") or _MB.is_run_peer(me):
        return ""
    is_turn_start = event in {"SessionStart", "UserPromptSubmit"} or (event == "PreInvocation" and not mid_turn)
    _record_native_swarm_identity(base, me)
    room_id = os.environ.get("ORKEST_SWARM_ROOM", "").strip()
    if is_turn_start and os.environ.get("ORKEST_RESUME_SWARM") == "1":
        # A stale inherited room must not make this new process claim another
        # live coordinator's terminal or brief. Resume by target in a fresh room.
        inherited = (
            room_store.read_room(base, room_id) if re.fullmatch(r"[\w-]{1,80}", room_id, flags=re.ASCII) else None
        )
        if isinstance(inherited, dict) and any(
            owner["session"] != me["session"]
            for owner in _MB.room_session_peers(base, inherited, inherited.get("conductor") or {})
        ):
            os.environ.pop("ORKEST_SWARM_ROOM", None)
        promoted = _promote_resumed_coordinator(base, me)
        if not promoted:
            return ""
        room_id = promoted["id"]
        instance_key = f"{room_id}:{me.get('terminalServer') or me.get('herdrPaneId') or me.get('pid') or ''}"
        if me.get("swarmAutoReconnected") != instance_key and (
            me.get("terminalServer") or os.environ.get("ORKEST_TERMINAL_SERVER") or _herdr_active()
        ):
            import agent_statusline_tmux

            with contextlib.suppress(Exception):
                agent_statusline_tmux.toggle_swarm_view(
                    "open", room=room_id, session_id=me["session"], harness=me["harness"], cwd=me.get("cwd"), base=base
                )
    if not room_id:
        if not is_turn_start:
            return ""
        import agent_statusline_tmux

        aliases = me.get("aliases") if isinstance(me.get("aliases"), list) else None
        matched = agent_statusline_tmux.find_session_swarm_room(
            base,
            me["session"],
            harness=me["harness"],
            cwd=me.get("cwd"),
            aliases=aliases,
        )
        if not isinstance(matched, dict) or not isinstance(matched.get("id"), str):
            return ""
        room_id = matched["id"]
        member_id = str(matched.get("_matchedMemberId") or "conductor")
        matched_session = str(matched.get("_matchedSessionId") or me["session"])
        room: dict[str, Any] = matched
        if matched_session != me["session"]:
            rebound = agent_statusline_tmux.rebind_session_swarm_room(base, room_id, member_id, me["session"])
            if not isinstance(rebound, dict):
                return ""
            room = rebound
        instance_key = f"{room_id}:{me.get('terminalServer') or me.get('herdrPaneId') or me.get('pid') or ''}"
        toggled_view = False
        if me.get("swarmAutoReconnected") != instance_key and (
            me.get("terminalServer") or os.environ.get("ORKEST_TERMINAL_SERVER") or _herdr_active()
        ):
            server_sock = (
                None if _herdr_active() else (me.get("terminalServer") or os.environ.get("ORKEST_TERMINAL_SERVER"))
            )
            with contextlib.suppress(Exception):
                agent_statusline_tmux.toggle_swarm_view(
                    "open",
                    socket=server_sock,
                    room=room_id,
                    session_id=me["session"],
                    harness=me["harness"],
                    cwd=me.get("cwd"),
                    base=base,
                )
                toggled_view = True
        delivered = _deliver_swarm_brief_or_summary(
            base, me, room, room_id, member_id, instance_key, allow_brief=is_turn_start
        )
        if toggled_view and not delivered and me.get("swarmAutoReconnected") != instance_key:
            _MB.annotate(base, me["session"], swarmAutoReconnected=instance_key)
        if delivered:
            return delivered
        return _swarm_next_advisor(base, me, room, room_id, member_id) if is_turn_start else ""

    if not re.fullmatch(r"[\w-]{1,80}", room_id, flags=re.ASCII):
        return ""
    loaded_room = room_store.read_room(base, room_id)
    if not isinstance(loaded_room, dict) or not loaded_room.get("swarm"):
        return ""
    room = loaded_room
    if not _MB.local_session_binding(room, room.get("conductor") or {}):
        return ""
    engine = "agy" if me["harness"] == "gemini" else me["harness"]
    conductor = room.get("conductor") or {}
    candidate_ids = _MB.native_session_ids(me, base)
    bound_session = (conductor.get("session") or {}).get("id")
    if conductor.get("engine") != engine or (bound_session and bound_session not in candidate_ids):
        if isinstance(room.get("agents"), list):
            for agent in room["agents"]:
                if not isinstance(agent, dict) or agent.get("role") != "lead" or agent.get("engine") != engine:
                    continue
                lead_sid = (agent.get("session") or {}).get("id") if isinstance(agent.get("session"), dict) else None
                owner = _MB.room_session_peer(base, room, agent)
                if (
                    isinstance(lead_sid, str)
                    and lead_sid in candidate_ids
                    and owner
                    and owner["session"] == me["session"]
                ):
                    member_id = str(agent.get("id") or "")
                    if lead_sid != me["session"] and member_id:
                        import agent_statusline_tmux

                        rebound = agent_statusline_tmux.rebind_session_swarm_room(
                            base, room_id, member_id, me["session"]
                        )
                        if not isinstance(rebound, dict):
                            return ""
                        room = rebound
                    instance_key = (
                        f"{room_id}:{me.get('terminalServer') or me.get('herdrPaneId') or me.get('pid') or ''}"
                    )
                    if is_turn_start:
                        delivered = _deliver_swarm_brief_or_summary(
                            base, me, room, room_id, member_id, instance_key, allow_brief=True
                        )
                        if delivered:
                            return delivered
                    return _swarm_next_advisor(base, me, room, room_id, member_id) if is_turn_start else ""
        return ""

    if bound_session:
        owner = _MB.room_session_peer(base, room, conductor)
        if not owner or owner["session"] != me["session"]:
            return ""
    if bound_session and bound_session != me["session"] and bound_session in candidate_ids:
        import agent_statusline_tmux

        rebound = agent_statusline_tmux.rebind_session_swarm_room(base, room_id, "conductor", me["session"])
        if not isinstance(rebound, dict):
            return ""
        room = rebound
        bound_session = me["session"]
    was_already_bound = bool(bound_session)
    if not bound_session:
        cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
        env = {**os.environ, "AGENT_EXECUTOR_HOME": str(base.parent)}
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            subprocess.run(
                [
                    shutil.which("node") or "node",
                    str(cli),
                    "rooms",
                    "bind",
                    "--room",
                    room_id,
                    "--member",
                    "conductor",
                    "--engine",
                    engine,
                    "--session",
                    me["session"],
                ],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        rebound = room_store.read_room(base, room_id)
        if isinstance(rebound, dict):
            room = rebound
            bound_session = ((room.get("conductor") or {}).get("session") or {}).get("id")
        if bound_session and bound_session != me["session"]:
            return ""
    instance_key = f"{room_id}:{me.get('terminalServer') or me.get('herdrPaneId') or me.get('pid') or ''}"
    is_prompt_turn = event == "UserPromptSubmit" or (event == "PreInvocation" and not mid_turn)
    cli_launched_with_brief = not was_already_bound and bool(str(room.get("objective") or "").strip())
    if cli_launched_with_brief and me.get("swarmBriefed") != room_id:
        _MB.annotate(base, me["session"], swarmBriefed=room_id, swarmAutoReconnected=instance_key)
        me["swarmBriefed"] = room_id
        me["swarmAutoReconnected"] = instance_key
    if is_prompt_turn or (was_already_bound and is_turn_start):
        delivered = _deliver_swarm_brief_or_summary(
            base,
            me,
            room,
            room_id,
            "conductor",
            instance_key,
            allow_brief=(is_prompt_turn or os.environ.get("ORKEST_RESUME_SWARM") == "1")
            and not cli_launched_with_brief,
        )
        if delivered:
            return delivered
    return _swarm_next_advisor(base, me, room, room_id, "conductor") if is_turn_start else ""


def side_command_context(
    base: Path, me: dict[str, Any], payload: dict[str, Any], event: str, *, mid_turn: bool = False
) -> str:
    """Intercept `/side`, `[orkest-side-command: ...]`, `!side`, or `side:` on turn start and dispatch via side.mjs."""
    if me.get("isSubagent") or me.get("delegatedRun") or _MB.is_run_peer(me):
        return ""
    if not (event == "UserPromptSubmit" or (event == "PreInvocation" and not mid_turn)):
        return ""
    prompt = _MB.latest_user_prompt(payload, me["session"], me.get("accountHome"))
    if not prompt:
        return ""
    cleaned = re.sub(r"</?USER_REQUEST>", "", prompt).strip()
    match = _SIDE_TAG_CMD.search(cleaned) or _SIDE_SLASH_CMD.match(cleaned) or _SIDE_PREFIX_CMD.match(cleaned)
    if not match:
        return ""
    raw_args = (match.group(1) or "").strip()
    if not raw_args:
        return (
            "[orkest-side-dispatched] Usage: `/side [--later|--issue|--investigate] <idea>`. "
            "Let the user know in one short line and do not call any tools."
        )
    try:
        parsed_tokens = shlex.split(raw_args)
    except ValueError:
        parsed_tokens = [raw_args]
    side_script = Path(__file__).resolve().parents[3] / "lib" / "side.mjs"
    node_bin = shutil.which("node") or "node"
    cwd = str(me.get("cwd") or os.getcwd())
    cmd = [
        node_bin,
        str(side_script),
        *parsed_tokens,
        "--session",
        str(me["session"]),
        "--harness",
        str(me["harness"]),
        "--cwd",
        cwd,
        "--json",
    ]
    room_env = os.environ.get("ORKEST_SWARM_ROOM", "").strip()
    if room_env and "--room" not in parsed_tokens:
        cmd.extend(["--room", room_env])
    env = {**os.environ, "ORCHESTRATE_MAILBOX_DIR": str(base)}
    with contextlib.suppress(Exception):
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        out = (proc.stdout or "").strip()
        if out:
            data = json.loads(out)
            if isinstance(data, dict):
                if data.get("status") == "error":
                    if (event == "UserPromptSubmit" and me.get("harness") != "gemini") or (
                        event == "PreInvocation" and not mid_turn
                    ):
                        return f"Side mission error: {data.get('error')}"
                    return f"[orkest-side-dispatched] Side mission error: {data.get('error')}. Report this in one line and do not call any tools."
                summary = str(data.get("summary") or "").strip()
                if summary:
                    if (event == "UserPromptSubmit" and me.get("harness") != "gemini") or (
                        event == "PreInvocation" and not mid_turn
                    ):
                        return summary
                    return f"[orkest-side-dispatched] {summary} Confirm this to the user in one short line and do not call any tools."
    return ""


def swarm_command_context(
    base: Path, me: dict[str, Any], payload: dict[str, Any], event: str, *, mid_turn: bool = False
) -> str:
    """Toggle or open the Orkest Swarm View split pane when the user submits `/swarm` or `/horde`."""
    if me.get("isSubagent") or me.get("delegatedRun") or _MB.is_run_peer(me):
        return ""
    if not (event == "UserPromptSubmit" or (event == "PreInvocation" and not mid_turn)):
        return ""
    prompt = _MB.latest_user_prompt(payload, me["session"], me.get("accountHome"))
    if not prompt:
        return ""
    cleaned = re.sub(r"</?USER_REQUEST>", "", prompt).strip()
    match = _SWARM_SLASH_CMD.match(cleaned) or _SWARM_TAG_CMD.search(cleaned)
    if not match:
        return ""
    raw_arg = (match.group(1) or "").strip()
    if raw_arg.lower() in {"", "toggle", "open", "close"}:
        action = (raw_arg or "toggle").lower()
        goal = ""
    else:
        action = "open"
        goal = raw_arg
    import agent_statusline_tmux

    with contextlib.suppress(Exception):
        outcome = agent_statusline_tmux.toggle_swarm_view(
            action,
            socket=None if os.environ.get("HERDR_ENV") == "1" else me.get("terminalServer"),
            session_id=me["session"],
            harness=me["harness"],
            cwd=me["cwd"],
            base=base,
        )
        status = outcome.get("status", "unavailable").replace("_", " ")
        room = outcome.get("room")
        room_note = f" (room {room})" if room else ""
        if outcome.get("status") in {"opened", "closed", "already_open", "already_closed"}:
            if goal:
                return (
                    f"[orkest-swarm-goal] Orkest Swarm View pane is now {status}{room_note}. "
                    f"Proceed with the user's swarm objective: {goal}"
                )
            return f"Orkest Swarm View pane is now {status}{room_note}."
        reason = outcome.get("reason") or "no enclosing Orkest tmux terminal"
        if goal:
            return (
                f"[orkest-swarm-goal] Orkest Swarm View pane could not be opened automatically ({reason}). "
                f"Proceed with the user's swarm objective: {goal}"
            )
        return (
            f"Orkest Swarm View pane could not be toggled automatically ({reason}). "
            "Use Ctrl+Option+S in Herdr or an Orkest-wrapped terminal session."
        )
    return ""


def hook(
    payload: dict[str, Any],
    *,
    harness: str | None = None,
    event: str | None = None,
    base: Path | None = None,
) -> dict[str, Any] | None:
    """Turn hooks for Claude Code, Codex (one hooks.json contract) and Antigravity: presence, delivery, idle."""
    base = base or _MB.root()
    harness = harness or _MB.detect_harness(payload)
    event = event or payload.get("hook_event_name")
    if not event and harness == "gemini":
        event = (
            "Stop"
            if "terminationReason" in payload
            else "PreInvocation"
            if "invocationNum" in payload
            else "SessionStart"
        )
    session = (
        payload.get("session_id") or payload.get("conversationId") or os.environ.get("ANTIGRAVITY_CONVERSATION_ID")
    )
    if not session or not event:
        return None
    native_session = session
    gemini = harness == "gemini"
    cwd = payload.get("cwd")
    if not cwd:
        spaces = payload.get("workspacePaths")
        cwd = spaces[0] if isinstance(spaces, list) and spaces and isinstance(spaces[0], str) else os.getcwd()
    canonical = _MB.session_peer(base, session, harness=harness, cwd=cwd)
    if canonical:
        session = canonical["session"]
    if event == "SessionEnd":
        existing_peer = _MB.load(peer_path(base, session))
        parent_to_refresh = (
            existing_peer.get("parentSession")
            if isinstance(existing_peer, dict) and existing_peer.get("isSubagent")
            else None
        )
        _MB.end_session(base, session, reason=str(payload.get("reason") or ""), pid=_MB.harness_pid(harness))
        if isinstance(parent_to_refresh, str) and parent_to_refresh:
            with contextlib.suppress(Exception):
                import agent_terminal

                agent_terminal.refresh_parent_pane(base, parent_to_refresh)
        return None
    if event == "SubagentStart":
        raw_agent_id = payload.get("agent_id") or payload.get("subagent_id")
        if isinstance(raw_agent_id, str) and raw_agent_id.strip():
            agent_id_clean = raw_agent_id.strip()
            sub_sid = re.sub(r"[^A-Za-z0-9_.-]+", "-", f"subagent-{agent_id_clean}")[:80]
            agent_type = str(payload.get("agent_type") or payload.get("subagent_type") or "subagent").strip()[:60]
            raw_transcript = payload.get("transcript_path") or payload.get("transcriptPath")
            account_home_dir = _MB.account_home(harness, raw_transcript)
            meta_data: dict[str, Any] = {}
            sub_jsonl: Path | None = None
            if isinstance(raw_transcript, str) and raw_transcript.strip():
                subagents_dir = Path(raw_transcript).expanduser().with_suffix("") / "subagents"
                meta_candidate = subagents_dir / f"agent-{agent_id_clean}.meta.json"
                loaded_meta = _MB.load(meta_candidate)
                if isinstance(loaded_meta, dict):
                    meta_data = loaded_meta
                jsonl_candidate = subagents_dir / f"agent-{agent_id_clean}.jsonl"
                if jsonl_candidate.is_file():
                    sub_jsonl = jsonl_candidate
            sub_model = payload.get("model") or payload.get("modelName")
            sub_model_source = "runtime"
            if isinstance(sub_model, dict):
                sub_model = sub_model.get("id")
            if isinstance(sub_model, str) and sub_model.strip().lower() == "auto":
                sub_model = None
            if not (isinstance(sub_model, str) and sub_model.strip()) and sub_jsonl is not None:
                sub_model = _MB.transcript_model({"transcript_path": str(sub_jsonl)})
                if sub_model:
                    sub_model_source = "runtime"
            if not (isinstance(sub_model, str) and sub_model.strip()):
                meta_model = meta_data.get("model")
                if isinstance(meta_model, str) and meta_model.strip() and meta_model.strip().lower() != "auto":
                    sub_model = meta_model.strip()
                    sub_model_source = "requested"
            sub_effort = payload.get("effort") or payload.get("effortLevel") or meta_data.get("effort")
            if isinstance(sub_effort, dict):
                sub_effort = sub_effort.get("level") or sub_effort.get("effort")
            sub_effort_str = str(sub_effort).strip() if isinstance(sub_effort, str) and sub_effort.strip() else None
            sub_desc = str(meta_data.get("description") or "").strip()[:160]
            sub_peer = _MB.register(
                base,
                session=sub_sid,
                harness=harness,
                cwd=cwd,
                pid=_MB.harness_pid(harness),
                state="busy",
                cwd_source="hook",
                model=sub_model if isinstance(sub_model, str) and sub_model.strip() else None,
                model_source=sub_model_source,
                account=account_home_dir,
                effort=sub_effort_str,
            )
            extra_annotations: dict[str, Any] = {
                "isSubagent": True,
                "parentSession": session,
                "focus": f"native {agent_type}",
            }
            if sub_desc:
                extra_annotations["subagentDescription"] = sub_desc
            _MB.annotate(base, sub_sid, **extra_annotations)
            import agent_progress

            previous_progress = agent_progress.read(base, sub_peer) or {}
            # A generic subagent has no workforce preset. Keep any role it already reported.
            sub_role = previous_progress.get("role") or {"explore": "scout", "plan": "planner"}.get(agent_type.lower())
            _MB.write(
                base / "progress" / f"{session_key(sub_sid)}.json",
                {
                    "schema": "orchestrate.progress.v1",
                    "session": sub_sid,
                    "harness": harness,
                    "machine": socket.gethostname(),
                    "accountHome": sub_peer.get("accountHome"),
                    "checkout": sub_peer.get("checkout") or cwd,
                    **({"role": sub_role} if sub_role else {}),
                    "stage": "working",
                    "goal": f"Native {agent_type}",
                    "task": sub_desc or f"Running {agent_type} subagent ({agent_id_clean[:12]})",
                    "updatedAt": _MB.stamp(),
                },
            )
            with contextlib.suppress(Exception):
                import agent_terminal

                agent_terminal.refresh_parent_pane(base, session)
        if os.environ.get("ORKEST_READONLY_RUN") != "1":
            with contextlib.suppress(Exception):
                import repo_env

                repo_env.bootstrap_worktree_env(cwd, overwrite=False)
        return {}
    if event == "SubagentStop":
        raw_agent_id = payload.get("agent_id") or payload.get("subagent_id")
        if isinstance(raw_agent_id, str) and raw_agent_id.strip():
            sub_sid = re.sub(r"[^A-Za-z0-9_.-]+", "-", f"subagent-{raw_agent_id.strip()}")[:80]
            prog_path = base / "progress" / f"{session_key(sub_sid)}.json"
            existing_prog = _MB.load(prog_path)
            if isinstance(existing_prog, dict):
                existing_prog["stage"] = "complete"
                existing_prog["updatedAt"] = _MB.stamp()
                _MB.write(prog_path, existing_prog)
            _MB.end_session(base, sub_sid, reason="completed", pid=_MB.harness_pid(harness))
            with contextlib.suppress(Exception):
                import agent_terminal

                agent_terminal.refresh_parent_pane(base, session)
        return {}
    state = {"SessionStart": "idle", "UserPromptSubmit": "busy", "PreInvocation": "busy", "Stop": "idle"}.get(event)
    if state is None:
        return None
    raw_transcript = payload.get("transcript_path") or payload.get("transcriptPath")
    account_home_dir = _MB.account_home(harness, raw_transcript)
    runtime_model = payload.get("model") or payload.get("modelName")
    if isinstance(runtime_model, dict):
        runtime_model = runtime_model.get("id")
    if isinstance(runtime_model, str) and runtime_model.strip().lower() == "auto":
        runtime_model = None
    if not (isinstance(runtime_model, str) and runtime_model.strip()):
        runtime_model = _MB.transcript_model(payload)
    runtime_effort_val = _MB.runtime_effort(harness, payload)
    if harness == "codex" and (not runtime_model or not runtime_effort_val):
        db_model, db_effort = _codex_sqlite_settings(account_home_dir, session)
        if not runtime_model and db_model:
            runtime_model = db_model
        if not runtime_effort_val and db_effort:
            runtime_effort_val = db_effort
    previous = _MB.load(peer_path(base, session))
    effective_transcript = raw_transcript if isinstance(raw_transcript, str) and raw_transcript.strip() else None
    if gemini and not effective_transcript and session:
        home_dir = (
            Path(account_home_dir).expanduser()
            if isinstance(account_home_dir, str) and account_home_dir
            else Path.home() / ".gemini"
        )
        candidate_transcript = home_dir / "antigravity-cli/brain" / session / ".system_generated/logs/transcript.jsonl"
        if candidate_transcript.is_file():
            effective_transcript = str(candidate_transcript)
    if gemini:
        if valid_peer(previous) and previous.get("isSubagent") and previous.get("parentSession"):
            is_subagent, parent_session = True, str(previous["parentSession"])
        else:
            is_subagent, parent_session = _agy_subagent_info(effective_transcript)
            if not is_subagent and valid_peer(previous) and previous.get("isSubagent"):
                is_subagent = True
                parent_session = parent_session or previous.get("parentSession")
    else:
        is_subagent, parent_session = False, None
    # Antigravity runs PreInvocation before every model step, tool results included; only the first starts a turn.
    mid_turn = event == "PreInvocation" and valid_peer(previous) and previous.get("state") == "busy"
    me = _MB.register(
        base,
        session=session,
        harness=harness,
        cwd=cwd,
        pid=_MB.harness_pid(harness),
        state=state,
        cwd_source="hook",
        model=runtime_model if isinstance(runtime_model, str) and runtime_model.strip() else None,
        model_source="runtime",
        account=account_home_dir,
        effort=runtime_effort_val,
    )
    me = _MB.mark_delegated(base, me)
    if not is_subagent and not me.get("delegatedRun"):
        me = _MB.attest_native_sessions(base, session, native_session) or me
    if is_subagent:
        subagent_fields: dict[str, Any] = {"isSubagent": True}
        if parent_session:
            subagent_fields["parentSession"] = parent_session
        for k in ("terminalServer", "herdrPaneId", "herdrWorkspaceId", "herdrEndpoint", "herdrBinary"):
            if me.get(k) is not None or (valid_peer(previous) and previous.get(k) is not None):
                subagent_fields[k] = None
        if any(me.get(k) != v for k, v in subagent_fields.items()):
            me = _MB.annotate(base, session, **subagent_fields) or me
    if not is_subagent and not me.get("isSubagent") and not me.get("delegatedRun"):
        terminal_server = os.environ.get("ORKEST_TERMINAL_SERVER", "").strip()
        if re.fullmatch(r"orkest-label-[0-9a-f]{12}", terminal_server) and me.get("terminalServer") != terminal_server:
            me = _MB.annotate(base, session, terminalServer=terminal_server) or me
        if _herdr_active() and harness != "codex":
            if me.get("terminalServer") is not None:
                me = _MB.annotate(base, session, terminalServer=None) or me
            from herdr_context import endpoint as herdr_endpoint

            herdr_pane = os.environ.get("HERDR_PANE_ID", "").strip()
            herdr_workspace = os.environ.get("HERDR_WORKSPACE_ID", "").strip()
            herdr_binary = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
            herdr_fields: dict[str, Any] = {}
            if herdr_pane and me.get("herdrPaneId") != herdr_pane:
                herdr_fields["herdrPaneId"] = herdr_pane
            if herdr_workspace and me.get("herdrWorkspaceId") != herdr_workspace:
                herdr_fields["herdrWorkspaceId"] = herdr_workspace
            endpoint = herdr_endpoint(dict(os.environ))
            # Rewrite older alias paths too, so every new binding stores the canonical endpoint.
            if herdr_pane and me.get("herdrEndpoint") != endpoint:
                herdr_fields["herdrEndpoint"] = endpoint
            if herdr_pane and herdr_binary and me.get("herdrBinary") != herdr_binary:
                herdr_fields["herdrBinary"] = herdr_binary
            if herdr_fields:
                me = _MB.annotate(base, session, **herdr_fields) or me
        elif harness != "codex" or terminal_server:
            stale_herdr_fields = {
                key: None
                for key in (
                    "herdrPaneId",
                    "herdrWorkspaceId",
                    "herdrEndpoint",
                    "herdrBinary",
                    "herdrSyncedTitle",
                    "herdrSyncedTarget",
                    "herdrSyncedAt",
                )
                if me.get(key) is not None
            }
            if stale_herdr_fields:
                me = _MB.annotate(base, session, **stale_herdr_fields) or me
    if event == "SessionStart" or (gemini and event == "PreInvocation" and previous is None):
        with contextlib.suppress(Exception):
            import repo_env

            if not me.get("delegatedRun") and os.environ.get("ORKEST_READONLY_RUN") != "1":
                repo_env.bootstrap_worktree_env(cwd, overwrite=False)
            if harness == "claude" and event == "SessionStart":
                repo_env.export_claude_env_file(cwd)
    if event == "SessionStart":
        _maybe_trigger_auto_update(base, me, event)
    # How the last turn ended: wake recovery must not set a conversation going that its own user stopped.
    if gemini and event == "Stop" and payload.get("terminationReason"):
        me = _MB.annotate(base, session, lastStopReason=str(payload["terminationReason"])) or me
    elif me.get("lastStopReason") and event in {"SessionStart", "UserPromptSubmit", "PreInvocation"}:
        me = _MB.annotate(base, session, lastStopReason=None) or me
    cleared_notice = ""
    if event == "SessionStart" and payload.get("source") == "clear" and not me.get("delegatedRun"):
        cleared_notice = _MB.adopt_cleared(base, me)
        me = _MB.load(peer_path(base, session)) or me
    if not is_subagent and not me.get("isSubagent") and not me.get("delegatedRun"):
        with contextlib.suppress(Exception):
            import agent_terminal

            shared_codex = (
                harness == "codex"
                and ("unittest" not in sys.modules or os.environ.get("ORKEST_TEST_ALLOW_HERDR") == "1")
                and (agent_terminal.discovery_available() or me.get("herdrPaneId"))
            )
            if not mid_turn and (_herdr_active() or shared_codex or agent_terminal.context(harness)):
                agent_terminal.bind(session, harness, payload, base=base, force=event == "SessionStart")
    elif (is_subagent or me.get("isSubagent")) and not mid_turn:
        target_parent = parent_session or me.get("parentSession")
        if isinstance(target_parent, str) and target_parent.strip():
            with contextlib.suppress(Exception):
                import agent_terminal

                agent_terminal.refresh_parent_pane(base, target_parent)
    if not me.get("isSubagent") and event in {"SessionStart", "UserPromptSubmit", "PreInvocation", "Stop"}:
        with contextlib.suppress(Exception):
            import mailbox_work as _WORK

            _WORK.renew_leases(base, me, force=False)
    team_notice = (
        _MB.succession_notice(base, me)
        if event in {"SessionStart", "UserPromptSubmit", "PreInvocation", "Stop"}
        else ""
    )
    if event in {"SessionStart", "UserPromptSubmit"} or (event == "PreInvocation" and not mid_turn):
        wake_dir = base / "wakes" / session_key(session)
        for marker_name in ("agy-wake.json", "claude-wake.json"):
            (wake_dir / marker_name).unlink(missing_ok=True)
    identity_hint = ""
    availability_hint = ""
    import mailbox_daemon

    try:
        http_mode = mailbox_daemon.get_mode(base) == "http"
        if http_mode and event != "Stop":
            live = mailbox_daemon.ensure_running(base, startup_timeout=0.5)
            stale = live.get("runtimeRevision") != mailbox_daemon.runtime_revision()
            if stale and not mid_turn and not live.get("activeWaits"):
                with contextlib.suppress(MailboxError, OSError):
                    if mailbox_daemon.stop_service(base):
                        live = mailbox_daemon.ensure_running(base, startup_timeout=2.0)
                        stale = live.get("runtimeRevision") != mailbox_daemon.runtime_revision()
            issue = "HTTP mailbox is running old code; use mailbox daemon restart after upgrade." if stale else ""
            if issue != me.get("httpAvailabilityIssue", ""):
                availability_hint = issue
                _MB.annotate(base, session, httpAvailabilityIssue=issue)
        if (
            http_mode
            and event in {"SessionStart", "UserPromptSubmit", "PreInvocation"}
            and (event == "SessionStart" or not me.get("httpIdentityAnnounced"))
        ):
            identity_hint = f"HTTP peer mailbox session: {session}. Pass this session on tool calls; ack received mail and reuse send idempotencyKey only for identical retries."
            _MB.annotate(base, session, httpIdentityAnnounced=True)
    except (MailboxError, OSError, ValueError):
        issue = "HTTP mailbox is unavailable; queued mail is delivered locally. Use mailbox daemon start or repair before HTTP tools."
        if issue != me.get("httpAvailabilityIssue", ""):
            availability_hint = issue
            _MB.annotate(base, session, httpAvailabilityIssue=issue)
    if gemini and event == "Stop" and payload.get("terminationReason") in ANTIGRAVITY_NO_CONTINUE:
        return {}
    import mailbox_channels

    route_hint = (
        _MB.wake_route_hint(base, me)
        if event == "SessionStart" and not is_subagent and not me.get("isSubagent")
        else ""
    )
    swarm_toggle = (
        _MB.swarm_command_context(base, me, payload, event, mid_turn=mid_turn)
        if not is_subagent and not me.get("isSubagent")
        else ""
    )
    side_notice = (
        getattr(_MB, "side_command_context", side_command_context)(base, me, payload, event, mid_turn=mid_turn)
        if not is_subagent and not me.get("isSubagent")
        else ""
    )
    is_swarm_goal = swarm_toggle.startswith("[orkest-swarm-goal] ")
    intercept_notice = side_notice or ("" if is_swarm_goal else swarm_toggle)
    if intercept_notice and not mid_turn:
        if event == "UserPromptSubmit" and not gemini:
            _MB.annotate(base, session, state="idle")
            return {"decision": "block", "reason": intercept_notice}
        if gemini and event == "PreInvocation":
            _MB.annotate(base, session, state="idle")
            return {
                "injectSteps": [
                    {
                        "systemMessage": {
                            "systemMessage": "",
                            "metadata": {"user_markdown": intercept_notice},
                        }
                    }
                ],
                "terminationBehavior": "terminate",
            }
    swarm_brief = (
        _MB.swarm_coordinator_context(base, me, event, mid_turn=mid_turn)
        if not is_subagent
        and not me.get("isSubagent")
        and (event in {"SessionStart", "UserPromptSubmit"} or (gemini and event == "PreInvocation" and not mid_turn))
        else ""
    )
    progress_hint = ""
    help_hint = ""
    if (
        not is_subagent
        and not me.get("isSubagent")
        and (event in {"SessionStart", "UserPromptSubmit"} or (gemini and event == "PreInvocation" and not mid_turn))
    ):
        import agent_progress
        import mailbox_work

        with contextlib.suppress(MailboxError, OSError, ValueError):
            progress_hint = agent_progress.reminder(base, me, starting=event == "SessionStart")
        with contextlib.suppress(MailboxError, OSError, ValueError):
            help_hint = mailbox_work.help_board_hint(base, me, previous=previous)
    # At Stop or between steps of a turn only mail worth interrupting it for is read; quiet channel posts wait for
    # the next turn.
    delivered = _MB.take(
        base, session, eligible=mailbox_channels.reads_at_stop if event == "Stop" or mid_turn else None
    )
    stale_wake_notice = ""
    if (
        event in {"UserPromptSubmit", "PreInvocation"}
        and not mid_turn
        and not delivered
        and (notice_id := _MB.wake_notice_id(payload, session, me.get("accountHome")))
    ):
        existing_mail = _MB.load(inbox_dir(base, session) / f"{notice_id}.json")
        if existing_mail and existing_mail.get("readAt"):
            stale_wake_notice = (
                f"Mailbox notification ({notice_id}) was already delivered and marked read in an earlier turn "
                f"(at {existing_mail['readAt']}); no unread peer messages remain. Do not call inbox or ack—finish immediately."
            )
        else:
            stale_wake_notice = (
                f"Mailbox notification ({notice_id}) has no unread messages waiting in your inbox. "
                "Do not call inbox or ack—finish immediately."
            )
    context = _MB.render_all(delivered, me["name"])
    update_notice = _update_notice(base, me) if event == "SessionStart" else ""
    hint = "\n".join(
        value
        for value in (
            side_notice,
            swarm_toggle,
            swarm_brief,
            cleared_notice,
            update_notice,
            team_notice,
            identity_hint,
            availability_hint,
            route_hint,
            progress_hint,
            help_hint,
            stale_wake_notice,
        )
        if value
    )
    if hint:
        context = hint + ("\n\n" + context if context else "")
    if event == "Stop":
        if not delivered:  # a hint or notice alone never keeps a turn going
            return {} if gemini else None
        # New mail arrived during the turn: keep going instead of leaving it unread until the user returns.
        _MB.feedback_module().observe(
            base,
            me,
            code="turn_extended",
            category="interruption",
            operation="hook",
            message_ids=[message["id"] for message in delivered],
            measurements={
                "messageCount": len(delivered),
                "messageBytes": sum(len(message["text"].encode()) for message in delivered),
            },
            repeat=False,
        )
        _MB.annotate(base, session, state="busy")
        decision = "continue" if gemini else "block"
        return {"decision": decision, "reason": f"Peer messages arrived while you worked:\n\n{context}"}
    # Who else works in this repository: at session start, and again whenever this session's channel-mates (or,
    # without channels, the other channel-less sessions) change. Other teams appear only as counts.
    others = [] if me.get("delegatedRun") else _MB.colleagues(base, me)
    mates, elsewhere = mailbox_channels.split(me, others)
    seen = mailbox_channels.roster_key(me, mates)
    rule_shown = False
    if event == "SessionStart" or seen != me.get("seenColleagues", []):
        notice = _MB.describe_colleagues(mates, me, elsewhere)
        rule_shown = bool(mates and notice)
        if not notice and not elsewhere and me.get("seenColleagues") and not me.get("delegatedRun"):
            notice = "The other agent sessions in this project have ended; none is working here now."
        if event == "SessionStart" and (joining := mailbox_channels.join_hint(me, others)):
            notice = f"{notice}\n{joining}" if notice else joining
        if notice:
            context = f"{notice}\n\n{context}" if context else notice
        _MB.annotate(base, session, seenColleagues=seen)
    if others and not _MB.is_run_peer(me) and (event == "SessionStart" or me["name"] != me.get("announcedName")):
        # Only where other agents are around: the name is what they call this session. It goes out on its own
        # when nothing else does, so a rename (a model learned late, an upgrade) is never held back. The roster
        # states the naming rule itself, so it is repeated here only when the roster is not part of this context.
        rule = "" if rule_shown else f" {NAME_RULE}."
        announcement = f"Your agent name is {me['name']}; use it when you introduce yourself or sign a message.{rule}"
        context = f"{announcement}\n\n{context}" if context else announcement
        _MB.annotate(base, session, announcedName=me["name"])
    if gemini:
        return {"injectSteps": [{"ephemeralMessage": context}]} if context else {}
    if not context:
        return None
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": context}}
