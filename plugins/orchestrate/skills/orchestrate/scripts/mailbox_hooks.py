# cspell:words herdr
"""Turn lifecycle hooks, /clear context adoption, team lead succession notices, and swarm context."""

from __future__ import annotations

import contextlib
import datetime as dt
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

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
_SWARM_SLASH_CMD = re.compile(r"^\s*/(?:orchestrate:)?swarm(?:\s+(toggle|open|close))?\s*$", re.IGNORECASE)
_SWARM_TAG_CMD = re.compile(r"\[orkest-swarm-command(?::\s*(toggle|open|close)?)?\]", re.IGNORECASE)

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
    for key in ("prompt", "userMessage", "query"):
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
    names = [old["session"], old.get("name"), *old.get("aliases", [])]
    _MB.annotate(
        base,
        me["session"],
        aliases=[name for name in dict.fromkeys(names) if isinstance(name, str)][-8:],
        clearedFrom=old["session"],
        awaitingClear=None,
        **({"person": old["person"]} if old.get("person") else {}),
        **({"channels": old["channels"]} if old.get("channels") else {}),
    )
    me = _MB.register(base, session=me["session"], harness=me["harness"], cwd=me["cwd"])
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
        f"Run `ork rooms status --room {room_id}` to inspect your swarm or `/swarm` to toggle the Swarm View."
    )


def swarm_coordinator_context(base: Path, me: dict[str, Any], event: str, *, mid_turn: bool = False) -> str:
    """Auto-bind the root swarm coordinator (or reconnect a resumed coordinator/lead) and deliver its brief."""
    if me.get("delegatedRun") or _MB.is_run_peer(me):
        return ""
    is_turn_start = event in {"SessionStart", "UserPromptSubmit"} or (event == "PreInvocation" and not mid_turn)
    room_id = os.environ.get("ORKEST_SWARM_ROOM", "").strip()
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
            if isinstance(rebound, dict):
                room = rebound
        instance_key = f"{room_id}:{me.get('terminalServer') or me.get('herdrPaneId') or me.get('pid') or ''}"
        if me.get("swarmAutoReconnected") != instance_key:
            _MB.annotate(base, me["session"], swarmAutoReconnected=instance_key, swarmBriefed=room_id)
            if (
                me.get("terminalServer")
                or os.environ.get("ORKEST_TERMINAL_SERVER")
                or os.environ.get("HERDR_ENV") == "1"
            ):
                server_sock = (
                    None
                    if os.environ.get("HERDR_ENV") == "1"
                    else (me.get("terminalServer") or os.environ.get("ORKEST_TERMINAL_SERVER"))
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
            return _format_swarm_reconnection_summary(room, room_id, member_id)
        return ""

    if not re.fullmatch(r"[\w-]{1,80}", room_id, flags=re.ASCII):
        return ""
    loaded_room = _MB.load(base / "rooms" / f"{room_id}.json")
    if not isinstance(loaded_room, dict) or not loaded_room.get("swarm"):
        return ""
    room = loaded_room
    engine = "agy" if me["harness"] == "gemini" else me["harness"]
    conductor = room.get("conductor") or {}
    aliases_list = me.get("aliases") if isinstance(me.get("aliases"), list) else []
    candidate_ids = {me["session"], *(item for item in aliases_list if isinstance(item, str))}
    bound_session = (conductor.get("session") or {}).get("id")
    if conductor.get("engine") != engine or (bound_session and bound_session not in candidate_ids):
        if isinstance(room.get("agents"), list):
            for agent in room["agents"]:
                if not isinstance(agent, dict) or agent.get("role") != "lead" or agent.get("engine") != engine:
                    continue
                lead_sid = (agent.get("session") or {}).get("id") if isinstance(agent.get("session"), dict) else None
                if isinstance(lead_sid, str) and lead_sid in candidate_ids:
                    member_id = str(agent.get("id") or "")
                    if lead_sid != me["session"] and member_id:
                        import agent_statusline_tmux

                        rebound = agent_statusline_tmux.rebind_session_swarm_room(
                            base, room_id, member_id, me["session"]
                        )
                        if isinstance(rebound, dict):
                            room = rebound
                    instance_key = (
                        f"{room_id}:{me.get('terminalServer') or me.get('herdrPaneId') or me.get('pid') or ''}"
                    )
                    if is_turn_start and me.get("swarmAutoReconnected") != instance_key:
                        _MB.annotate(base, me["session"], swarmAutoReconnected=instance_key, swarmBriefed=room_id)
                        return _format_swarm_reconnection_summary(room, room_id, member_id)
                    return ""
        return ""

    if bound_session and bound_session != me["session"] and bound_session in candidate_ids:
        import agent_statusline_tmux

        rebound = agent_statusline_tmux.rebind_session_swarm_room(base, room_id, "conductor", me["session"])
        if isinstance(rebound, dict):
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
        rebound = _MB.load(base / "rooms" / f"{room_id}.json")
        if isinstance(rebound, dict):
            room = rebound
            bound_session = ((room.get("conductor") or {}).get("session") or {}).get("id")
        if bound_session and bound_session != me["session"]:
            return ""
    instance_key = f"{room_id}:{me.get('terminalServer') or me.get('herdrPaneId') or me.get('pid') or ''}"
    if (event == "UserPromptSubmit" or (event == "PreInvocation" and not mid_turn)) and me.get(
        "swarmBriefed"
    ) != room_id:
        _MB.annotate(base, me["session"], swarmBriefed=room_id, swarmAutoReconnected=instance_key)
        if not room.get("objective") and not room.get("agents"):
            brief_file = base / "swarm-briefs" / room_id / "conductor.md"
            with contextlib.suppress(OSError):
                if brief_file.is_file():
                    return (
                        brief_file.read_text(encoding="utf-8").replace("YOUR_ACTUAL_SESSION_ID", me["session"]).strip()
                    )
        else:
            return _format_swarm_reconnection_summary(room, room_id, "conductor")
    elif (
        was_already_bound
        and (room.get("objective") or room.get("agents"))
        and is_turn_start
        and me.get("swarmAutoReconnected") != instance_key
    ):
        _MB.annotate(base, me["session"], swarmAutoReconnected=instance_key)
        return _format_swarm_reconnection_summary(room, room_id, "conductor")
    return ""


def swarm_command_context(
    base: Path, me: dict[str, Any], payload: dict[str, Any], event: str, *, mid_turn: bool = False
) -> str:
    """Toggle the Orkest Swarm View split pane when the user submits `/swarm`."""
    if not (event == "UserPromptSubmit" or (event == "PreInvocation" and not mid_turn)):
        return ""
    prompt = _MB.latest_user_prompt(payload, me["session"], me.get("accountHome"))
    if not prompt:
        return ""
    cleaned = re.sub(r"</?USER_REQUEST>", "", prompt).strip()
    match = _SWARM_SLASH_CMD.match(cleaned) or _SWARM_TAG_CMD.search(cleaned)
    if not match:
        return ""
    action = (match.group(1) or "toggle").lower()
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
            return (
                f"Orkest Swarm View pane is now {status}{room_note} (toggled automatically by the `/swarm` turn hook). "
                "Confirm this to the user in one short line and do not call any tools."
            )
        reason = outcome.get("reason") or "no enclosing Orkest tmux terminal"
        return (
            f"Orkest Swarm View pane could not be toggled automatically ({reason}). "
            "Let the user know in one short line that `/swarm` requires an Orkest-wrapped terminal session."
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
    gemini = harness == "gemini"
    cwd = payload.get("cwd")
    if not cwd:
        spaces = payload.get("workspacePaths")
        cwd = spaces[0] if isinstance(spaces, list) and spaces and isinstance(spaces[0], str) else os.getcwd()
    if event == "SessionEnd":
        _MB.end_session(base, session, reason=str(payload.get("reason") or ""), pid=_MB.harness_pid(harness))
        return None
    state = {"SessionStart": "idle", "UserPromptSubmit": "busy", "PreInvocation": "busy", "Stop": "idle"}.get(event)
    if state is None:
        return None
    runtime_model = payload.get("model") or payload.get("modelName")
    if isinstance(runtime_model, dict):
        runtime_model = runtime_model.get("id")
    if isinstance(runtime_model, str) and runtime_model.strip().lower() == "auto":
        runtime_model = None
    if not (isinstance(runtime_model, str) and runtime_model.strip()):
        runtime_model = _MB.transcript_model(payload)
    previous = _MB.load(peer_path(base, session))
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
        account=_MB.account_home(harness, payload.get("transcript_path") or payload.get("transcriptPath")),
        effort=_MB.runtime_effort(harness, payload),
    )
    me = _MB.mark_delegated(base, me)
    terminal_server = os.environ.get("ORKEST_TERMINAL_SERVER", "").strip()
    if re.fullmatch(r"orkest-label-[0-9a-f]{12}", terminal_server) and me.get("terminalServer") != terminal_server:
        me = _MB.annotate(base, session, terminalServer=terminal_server) or me
    if os.environ.get("HERDR_ENV") == "1":
        herdr_pane = os.environ.get("HERDR_PANE_ID", "").strip()
        herdr_workspace = os.environ.get("HERDR_WORKSPACE_ID", "").strip()
        herdr_fields: dict[str, Any] = {}
        if herdr_pane and me.get("herdrPaneId") != herdr_pane:
            herdr_fields["herdrPaneId"] = herdr_pane
        if herdr_workspace and me.get("herdrWorkspaceId") != herdr_workspace:
            herdr_fields["herdrWorkspaceId"] = herdr_workspace
        if herdr_fields:
            me = _MB.annotate(base, session, **herdr_fields) or me
    # How the last turn ended: wake recovery must not set a conversation going that its own user stopped.
    if gemini and event == "Stop" and payload.get("terminationReason"):
        me = _MB.annotate(base, session, lastStopReason=str(payload["terminationReason"])) or me
    elif me.get("lastStopReason") and event in {"SessionStart", "UserPromptSubmit", "PreInvocation"}:
        me = _MB.annotate(base, session, lastStopReason=None) or me
    cleared_notice = ""
    if event == "SessionStart" and payload.get("source") == "clear" and not me.get("delegatedRun"):
        cleared_notice = _MB.adopt_cleared(base, me)
        me = _MB.load(peer_path(base, session)) or me
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

    route_hint = _MB.wake_route_hint(base, me) if event == "SessionStart" else ""
    swarm_brief = (
        _MB.swarm_coordinator_context(base, me, event, mid_turn=mid_turn)
        if event in {"SessionStart", "UserPromptSubmit"} or (gemini and event == "PreInvocation" and not mid_turn)
        else ""
    )
    swarm_toggle = _MB.swarm_command_context(base, me, payload, event, mid_turn=mid_turn)
    progress_hint = ""
    help_hint = ""
    if event in {"SessionStart", "UserPromptSubmit"} or (gemini and event == "PreInvocation" and not mid_turn):
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
    hint = "\n".join(
        value
        for value in (
            swarm_toggle,
            swarm_brief,
            cleared_notice,
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
        if not delivered and not team_notice:  # a hint alone never keeps a turn going
            return {} if gemini else None
        _MB.feedback_module().observe(
            base,
            me,
            code="turn_extended",
            category="interruption",
            operation="hook",
            message_ids=[message["id"] for message in delivered],
            measurements={
                "messageCount": len(delivered),
                "messageBytes": sum(len(m["text"].encode()) for m in delivered),
            },
            repeat=False,
        )
        # New mail arrived during the turn: keep going instead of leaving it unread until the user returns.
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
