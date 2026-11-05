"""CLI parser, formatting helpers, and entry point for the project-scoped peer mailbox."""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import secrets
import shlex
import sys
from pathlib import Path
from typing import Any

from mailbox_store import (
    _MB,
    HARNESSES,
    NATIVE_MESSAGING,
    SCOPES,
    MailboxError,
    account_label,
    account_route,
    check_scope,
    display_label,
    display_name,
    native_route,
    peer_path,
    readable_name,
    repository_name,
    same_project,
    short_agent_name,
)


def session_arg(args: argparse.Namespace) -> str | None:
    return (
        args.session
        or os.environ.get("AGENT_MAILBOX_SESSION")
        or os.environ.get("CLAUDE_CODE_SESSION_ID")
        or os.environ.get("ANTIGRAVITY_CONVERSATION_ID")
    )


def caller(args: argparse.Namespace, base: Path) -> dict[str, Any]:
    session = _MB.session_arg(args)
    if not session:
        raise MailboxError("pass --session (or set AGENT_MAILBOX_SESSION / CLAUDE_CODE_SESSION_ID)")
    existing = _MB.load(peer_path(base, session))
    if _MB.is_run_peer(existing):
        return existing
    harness = args.harness or _MB.detect_harness()
    return _MB.refresh(
        base,
        session=session,
        harness=harness,
        cwd=os.getcwd(),
        pid=_MB.harness_pid(harness),
        source="cli",
        account=_MB.account_home(harness),
        effort=_MB.runtime_effort(harness),
    )


def table(
    rows: list[dict[str, Any]],
    session: str | None,
    harness: str | None = None,
    here: dict[str, Any] | None = None,
    *,
    scope: str = "project",
) -> str:
    check_scope(scope)
    own = next((peer for peer in rows if peer["session"] == session), None)
    # The CLI passes where it runs (outside git: no repository at all); the MCP server passes nothing.
    mine = here if here is not None else own or {}
    rows = [
        peer
        for peer in rows
        if scope == "cross-project" or peer["session"] == mine.get("session") or same_project(mine, peer)
    ]
    if not rows:
        return "no live peers in this project" if scope == "project" else "no live peers on this machine"
    # Sessions in the caller's local repository come first: they can collide with its edits.
    rows = sorted(rows, key=lambda peer: not (mine.get("repo") and peer.get("repo") == mine.get("repo")))
    lines = []
    native = NATIVE_MESSAGING.get(harness or "")
    my_account = (own or mine).get("accountHome")
    for peer in rows:
        marks = []
        if peer["session"] == session:
            marks.append("you")
        else:
            if mine.get("repo") and peer.get("repo") == mine["repo"]:
                marks.append("same repository")
            elif same_project(mine, peer):
                marks.append("same project")
            else:
                marks.append("other project")
            if peer.get("delegatedRun"):
                marks.append("delegated run worker")
            if cross_account := account_route(peer, harness, my_account):
                marks.append(cross_account)
            elif harness and peer["harness"] == harness:
                route = native_route(peer, harness, my_account)
                tool_label = native.split(" ")[0] if native else route["nativeTool"]
                addr_note = f", native address: {route['nativeAddress']}" if route["nativeAddress"] else ""
                marks.append(f"same harness: use {tool_label}{addr_note}")
        mark = f"  ({'; '.join(marks)})" if marks else ""
        branch = f"  {peer['branch']}" if peer.get("branch") else ""
        checkout = peer.get("checkout") or peer["cwd"]
        worktree = Path(checkout).name
        if any(
            (p.get("checkout") or p["cwd"]) != checkout and Path(p.get("checkout") or p["cwd"]).name == worktree
            for p in rows
        ):
            worktree = checkout
        context = f"repo: {repository_name(peer)}{branch}  worktree: {worktree}"
        identity = peer["session"][:8]
        if any(p["session"] != peer["session"] and p["session"].startswith(identity) for p in rows):
            identity = peer["session"]
        account = f" (account: {account_label(peer)})" if peer.get("accountHome") else ""
        lines.append(
            f"{display_label(peer)} [id: {identity}]  {peer['harness']}{account}  {peer['state']}  {context}{mark}"
        )
    return "\n".join(lines)


def render_work(result: dict[str, Any]) -> str:
    """Compact workboard response shared by CLI and MCP; details stay available as JSON."""
    rows = result.get("items", [result["item"]] if "item" in result else [])
    lines = ["Project workboard (coordination only; no user approval or file protection)."]
    for row in rows:
        owner = row.get("owner") or {}
        integrator = row.get("integrator") or {}
        revision = f" r{row['revision']}" if "revision" in row else ""
        lines.append(f"{row['id']}{revision} [{row['state']}] {row['title']}")
        source = row.get("source", "interactive")
        lines.append(f"  Source: {source}" + (" (read-only)" if row.get("readOnly") else ""))
        if source == "legacy-note":
            lines.append("  If resuming, create a work item; do not maintain this legacy card alongside it.")
        if source == "coordinator":
            lines.append("  Ownership and acceptance: managed by the coordinator; follow its route.")
        elif source == "legacy-note":
            lines.append(f"  Recorded author: {owner.get('name', 'unknown')}")
        else:
            lines.append(f"  Owner: {owner.get('name', 'unclaimed')}; integrator: {integrator.get('name', 'unknown')}")
        for field in ("scope", "acceptance", "checkout", "done", "next", "blocker", "evidence", "verification", "note"):
            if row.get(field):
                lines.append(f"  {field.capitalize()}: {row[field]}")
        if row.get("unmetDependencies"):
            lines.append("  Waiting for: " + ", ".join(row["unmetDependencies"]))
        if row.get("recoveryNeeded"):
            lines.append(f"  Recovery needed: {row['recoveryNeeded']}; no ownership was transferred.")
        if row.get("transfer"):
            lines.append(f"  Integrator transfer offered to: {row['transfer']['name']}")
        if command := row.get("route", {}).get("command"):
            lines.append("  Route: " + shlex.join(command))
    if not rows:
        lines.append("No work items.")
    if result.get("has_more"):
        lines.append(f"More work items: offset={result['next_offset']}.")
    if result.get("replayed"):
        lines.append("Existing item returned for this create key.")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="run_agent.py mailbox",
        description=__doc__,
        epilog="Name your actual task: mailbox focus --session NATIVE_SESSION_ID --text 'Your actual task'. "
        "This registers CLI presence automatically; update focus when the task changes. "
        "Refer to peers by their displayed task/model/harness label; route by stable session ID (old names still work). "
        "Send accepts --text/--message/--body. Wait for a reply with mailbox wait --session ID "
        "--reply-to MESSAGE_ID --timeout 300, rather than repeated inbox checks. "
        "Use --no-wake for FYI/progress and avoid acknowledgement-only replies.",
    )
    commands = parser.add_subparsers(dest="action", required=True)
    for name in (
        "peers",
        "send",
        "ask",
        "inbox",
        "receive",
        "wait",
        "ack",
        "history",
        "focus",
        "prune",
        "hook",
        "feedback",
        "feedback-summary",
        "name",
        "attach-wake-route",
        "wake-health",
        "wake-retry",
        "join",
        "leave",
        "channels",
        "tasks",
        "board",
        "work",
    ):
        sub = commands.add_parser(name)
        if name == "name":
            sub.add_argument("--harness", choices=HARNESSES)
            sub.add_argument("--model", help="model the new session will run, e.g. opus-5.5 or claude-opus-5-5")
            sub.add_argument("--effort", help="its effort level; defaults to the current harness's")
            sub.add_argument(
                "--short", action="store_true", help="print Herdr-compatible short agent name (<= 32 chars)"
            )
            continue
        sub.add_argument(
            "--session",
            help="this session's id (default: $AGENT_MAILBOX_SESSION then $CLAUDE_CODE_SESSION_ID)",
        )
        sub.add_argument("--harness", choices=HARNESSES)
        sub.add_argument("--format", choices=("text", "json", "context"), default="text")
        if name in {
            "peers",
            "send",
            "inbox",
            "receive",
            "wait",
            "history",
            "feedback-summary",
            "wake-health",
            "wake-retry",
            "tasks",
        }:
            sub.add_argument(
                "--scope", choices=SCOPES, default="project", help="cross-project requires explicit opt-in"
            )
        if name == "wake-retry":
            sub.add_argument("--to", help="only this peer; default every peer in scope")
        if name in {"join", "leave"}:
            sub.add_argument("channels", nargs="+", help="channel names, e.g. retrieval graph")
        if name == "history":
            sub.add_argument("--channel", help="this channel's posts in your project, newest first")
            sub.add_argument("--limit", type=int, default=20)
            sub.add_argument("--before", help="page back from this post id")
        if name == "peers":
            sub.add_argument("--runs", action="store_true", help="include run-scoped worker/conductor sessions")
        if name in {"tasks", "board"}:
            sub.add_argument("--limit", type=int, default=10)
            sub.add_argument("--offset", type=int, default=0)
        if name == "board":
            sub.add_argument("--item", help="one project work item by stable id")
            sub.add_argument("--view", choices=("work", "status"), default="work")
            sub.add_argument("--agent", help="status view: stable session ID or full agent name")
            sub.add_argument("--channel", help="status view: members of this task channel and their work")
            sub.add_argument("--since", help="status view: wait for a change from this prior cursor")
            sub.add_argument("--timeout", type=float, default=300, help="status change wait, at most 600 seconds")
        if name == "work":
            import mailbox_work

            sub.add_argument("work_action", choices=mailbox_work.ACTIONS)
            sub.add_argument("--item", help="stable item id; required after create")
            sub.add_argument("--revision", type=int, help="expected current revision; required after create")
            sub.add_argument("--key", help="stable idempotency key; required for create")
            for field in (
                "title",
                "scope",
                "acceptance",
                "integrator",
                "blocker",
                "evidence",
                "verification",
                "note",
                "successor",
            ):
                sub.add_argument(f"--{field}")
            sub.add_argument("--next", dest="next_step", help="concrete next step")
            sub.add_argument("--dependencies", nargs="+", help="accepted prerequisite item ids")
            sub.add_argument("--lease-ttl", type=int, dest="lease_ttl", help="claim lease TTL in seconds (60-7200)")
            sub.add_argument("--handoff", help="structured handoff packet as JSON object")
            sub.add_argument("--files-touched", nargs="+", dest="files_touched", help="handoff files touched")
            sub.add_argument("--decisions-made", nargs="+", dest="decisions_made", help="handoff decisions made")
            sub.add_argument("--remaining-steps", nargs="+", dest="remaining_steps", help="handoff remaining steps")
            sub.add_argument("--blockers", nargs="+", dest="handoff_blockers", help="handoff blockers")
            sub.add_argument("--verify-cmd", dest="verification_command_run", help="handoff verification command run")
        if name == "hook":
            sub.add_argument("--event", help="lifecycle event, for hosts whose payload does not name it")
        if name == "send":
            sub.add_argument("--no-wake", action="store_true", help="queue mail without waking an idle receiver")
            sub.add_argument(
                "--native-unreachable",
                metavar="REASON",
                help="what native messaging failed to do; lifts the same-harness, same-account refusal",
            )
            sub.add_argument("--to", default=os.environ.get("AGENT_MAILBOX_PEER"))
            sub.add_argument(
                "--channel", help="post to this channel's members instead of one peer (also: all, worktree)"
            )
            sub.add_argument("--wake", action="store_true", help="for a channel post: wake idle members too")
            sub.add_argument("--text", "--body", "--message", dest="text", required=True)
            sub.add_argument("--kind", choices=("question", "reply", "update"))
            sub.add_argument("--id", help="caller ID for idempotent run-message delivery")
            sub.add_argument("--reply-to")
        if name == "ask":
            sub.add_argument("--to", default=os.environ.get("AGENT_MAILBOX_PEER"))
            sub.add_argument("--id", required=True)
            sub.add_argument("--text", "--body", "--message", dest="text", required=True)
            sub.add_argument("--timeout", type=float, default=300)
        if name in {"inbox", "receive", "wait"}:
            sub.add_argument("--peek", action="store_true", help="leave the messages unread")
            sub.add_argument("--reply-to")
        if name in {"inbox", "receive"}:
            sub.add_argument(
                "--wait-seconds",
                type=float,
                default=0.0,
                help="wait up to this many seconds for messages if none are immediately available",
            )
        if name == "wait":
            sub.add_argument(
                "--timeout", type=float, default=300, help="block locally for mail; no model polling (seconds)"
            )
            sub.add_argument("--wait-seconds", type=float, default=None, help="alias for --timeout")
        if name == "ack":
            sub.add_argument("ids", nargs="+")
        if name == "focus":
            import mailbox_tasks

            for field, maximum in mailbox_tasks.LIMITS.items():
                sub.add_argument(
                    f"--{field}",
                    help=f"legacy recovery note, at most {maximum} characters; use board/work for current work",
                )
            sub.add_argument("--status", choices=mailbox_tasks.STATUSES)
            sub.add_argument("--harness-label", help="actual host name, e.g. Antigravity; omit if not known")
            sub.add_argument("--model", help="current model ID/name verified from your runtime; omit if unknown")
            sub.add_argument(
                "--text",
                required=True,
                help="task display name from your actual assignment; update when the task changes (max 200 characters)",
            )
            sub.add_argument(
                "--channel", action="append", default=[], help="also join this channel (repeatable); never leaves one"
            )
        if name == "feedback":
            fb = _MB.feedback_module()
            sub.add_argument("--category", choices=fb.CATEGORIES, required=True)
            sub.add_argument("--intent", required=True)
            sub.add_argument("--problem", required=True)
            sub.add_argument("--needed", required=True)
            sub.add_argument("--operation", choices=fb.OPERATIONS, default="other")
            sub.add_argument("--scope", choices=SCOPES, default="project")
            sub.add_argument("--message-id", action="append", default=[])
    return parser


def main(argv: list[str] | None = None) -> int:
    supplied = sys.argv[1:] if argv is None else argv
    if supplied and supplied[0] == "daemon":
        import mailbox_daemon

        return mailbox_daemon.main(supplied[1:])
    parser = build_parser()
    args = parser.parse_args(argv)
    base = _MB.root()

    try:
        if args.action == "hook":
            raw = sys.stdin.read()
            try:
                output = _MB.hook(
                    json.loads(raw) if raw.strip() else {}, harness=args.harness, event=args.event, base=base
                )
            except Exception as error:  # noqa: BLE001 -- a mailbox fault must never break the host's turn
                _MB.record_failure(base, {"harness": args.harness or "unknown"}, "hook", "project", error)
                print(f"mailbox hook: {error}", file=sys.stderr)
                return 0
            if output:
                print(json.dumps(output, ensure_ascii=True))
            return 0
        if args.action == "name":
            # A fresh name for a session about to start, e.g. claude --name "$(... mailbox name --model opus-5.5)".
            here = _MB.workspace(os.getcwd())
            here["cwd"] = os.getcwd()
            harness = args.harness or "claude"
            person = _MB.pick_martian(secrets.token_hex(8), _MB.taken_persons(base, ""))
            effort = args.effort or _MB.runtime_effort(harness)
            tag = secrets.token_hex(1)
            if args.short:
                print(short_agent_name(person, repository_name(here), tag))
            else:
                print(readable_name(person, repository_name(here), args.model, effort, tag))
            return 0
        if args.action == "prune":
            output: Any = _MB.prune(base)
        elif args.action == "feedback-summary":
            me = _MB.caller(args, base) if _MB.session_arg(args) else _MB.workspace(os.getcwd())
            output = _MB.feedback_module().summary(base, peer=None if args.scope == "cross-project" else me)
        elif args.action == "wake-health":
            import mailbox_wake
            import wake_recovery

            me = _MB.caller(args, base) if _MB.session_arg(args) else _MB.workspace(os.getcwd())
            output = []
            for peer in _MB.scoped_peers(base, me, scope=args.scope):
                row = {"name": peer["name"], "session": peer["session"], "harness": peer["harness"]}
                row |= mailbox_wake.wake_health(peer, base=base)
                if pending := wake_recovery.summary(base, peer["session"]):
                    row["pending"] = pending
                output.append(row)
            if args.format != "json":
                for row in output:
                    state = "wakeable" if row["wakeable"] else "not wakeable"
                    repair = f" (repair: {row['repair']})" if row.get("repair") else ""
                    pending = row.get("pending")
                    waiting = (
                        f" [wake {pending['state']}: {pending['messages']} unread, {pending['attempts']} attempts]"
                        if pending
                        else ""
                    )
                    print(f"{row['name']}: {state} via {row['route']}: {row['reason']}{repair}{waiting}")
                return 0
        elif args.action == "wake-retry":
            import wake_recovery

            me = _MB.caller(args, base) if _MB.session_arg(args) else _MB.workspace(os.getcwd())
            if args.to:
                sessions = [_MB.resolve(base, args.to, sender=me, scope=args.scope)["session"]]
            else:
                sessions = [peer["session"] for peer in _MB.scoped_peers(base, me, scope=args.scope)]
            reopened = wake_recovery.reopen(base, sessions)
            output = {"reopened": reopened, "outcomes": wake_recovery.reconcile(base, sessions=sessions)}
        elif args.action in {"board", "work"}:
            import mailbox_work

            if args.action == "board" and args.view == "status":
                import mailbox_status

                if args.item:
                    raise MailboxError("status view uses --agent/--channel; use the work view for --item")
                output = mailbox_status.observe(
                    base,
                    _MB.workspace(os.getcwd()),
                    agent=args.agent,
                    channel=args.channel,
                    since=args.since,
                    timeout=args.timeout,
                    limit=args.limit,
                    offset=args.offset,
                )
                print(json.dumps(output, ensure_ascii=True) if args.format == "json" else mailbox_status.render(output))
                return 0
            if args.action == "board" and any((args.agent, args.channel, args.since)):
                raise MailboxError("--agent, --channel and --since require --view status")
            me = (
                _MB.caller(args, base) if args.action == "work" or _MB.session_arg(args) else _MB.workspace(os.getcwd())
            )
            if args.action == "board":
                output = mailbox_work.listing(base, me, item=args.item, limit=args.limit, offset=args.offset)
            else:
                fields = {
                    key: getattr(args, key)
                    for key in (
                        "item",
                        "revision",
                        "key",
                        "title",
                        "scope",
                        "acceptance",
                        "dependencies",
                        "integrator",
                        "next_step",
                        "blocker",
                        "evidence",
                        "verification",
                        "note",
                        "successor",
                        "lease_ttl",
                    )
                    if getattr(args, key) is not None
                }
                handoff_payload: dict[str, Any] = {}
                if args.handoff is not None:
                    try:
                        parsed_handoff = json.loads(args.handoff)
                    except ValueError as error:
                        raise MailboxError("work --handoff must be valid JSON") from error
                    if not isinstance(parsed_handoff, dict):
                        raise MailboxError("work --handoff must be a JSON object")
                    handoff_payload.update(parsed_handoff)
                for value, field_name in (
                    (args.files_touched, "files_touched"),
                    (args.decisions_made, "decisions_made"),
                    (args.remaining_steps, "remaining_steps"),
                    (args.handoff_blockers, "blockers"),
                    (args.verification_command_run, "verification_command_run"),
                ):
                    if value is not None:
                        handoff_payload[field_name] = value
                if handoff_payload:
                    fields["handoff"] = handoff_payload
                output = mailbox_work.mutate(base, me, action=args.work_action, **fields)
            if args.format != "json":
                print(_MB.render_work(output))
                return 0
        elif args.action == "tasks":
            import mailbox_tasks

            me = _MB.caller(args, base) if _MB.session_arg(args) else _MB.workspace(os.getcwd())
            output = mailbox_tasks.listing(base, me, scope=args.scope, limit=args.limit, offset=args.offset)
            if args.format != "json":
                print(mailbox_tasks.render(output))
                return 0
        elif args.action == "peers":
            me = _MB.caller(args, base) if _MB.session_arg(args) else _MB.workspace(os.getcwd())
            caller_harness = args.harness or me.get("harness") or _MB.detect_harness()
            if not me.get("accountHome") and (own_account := _MB.account_home(caller_harness)):
                me = {**me, "accountHome": own_account}
            rows = _MB.scoped_peers(base, me, scope=args.scope, include_runs=args.runs)
            if args.format != "json":
                print(_MB.table(rows, _MB.session_arg(args), caller_harness, here=me, scope=args.scope))
                return 0
            output = [
                {
                    **peer,
                    "displayName": display_name(peer),
                    "displayLabel": display_label(peer),
                    "repositoryName": repository_name(peer),
                    "account": account_label(peer),
                    **(
                        native_route(peer, caller_harness, me.get("accountHome"))
                        if peer["session"] != _MB.session_arg(args)
                        else {"nativeAddress": "", "nativeTool": ""}
                    ),
                }
                for peer in rows
            ]
        else:
            if args.action == "attach-wake-route":
                _MB.check_attach_shell(_MB.session_arg(args), args.harness or _MB.detect_harness())
            me = _MB.caller(args, base)
            if args.action == "feedback":
                output = _MB.feedback_module().submit(
                    base,
                    me,
                    category=args.category,
                    intent=args.intent,
                    problem=args.problem,
                    needed=args.needed,
                    operation=args.operation,
                    scope=args.scope,
                    message_ids=args.message_id,
                )
            elif args.action == "send" and args.channel:
                import mailbox_channels

                if args.to and args.to != os.environ.get("AGENT_MAILBOX_PEER"):
                    raise MailboxError("send to one peer (--to) or to a channel (--channel), not both")
                output = mailbox_channels.post(
                    base,
                    sender=me,
                    channel=args.channel,
                    text=args.text,
                    reply_to=args.reply_to,
                    wake=args.wake,
                    idempotency_key=args.id,
                )
            elif args.action in {"send", "ask"}:
                to = args.to or (me.get("counterpart") if _MB.is_run_peer(me) else None)
                if not to:
                    raise MailboxError("pass --to (or set AGENT_MAILBOX_PEER)")
                if args.action == "ask" and not _MB.is_run_peer(me):
                    raise MailboxError("ask is only supported for run sessions")
                if args.action == "ask" and (not math.isfinite(args.timeout) or args.timeout <= 0):
                    raise MailboxError("timeout must be a finite number of seconds greater than zero")
                output = _MB.send(
                    base,
                    sender=me,
                    to=to,
                    text=args.text,
                    reply_to=getattr(args, "reply_to", None),
                    kind="question" if args.action == "ask" else args.kind,
                    client_id=args.id,
                    scope=getattr(args, "scope", "project"),
                    wake=args.action == "send" and not args.no_wake,
                    native_unreachable=getattr(args, "native_unreachable", None),
                )
                if args.action == "ask":
                    output = _MB.wait(base, me["session"], timeout=args.timeout, reply_to=args.id)
            elif args.action in {"inbox", "receive"}:
                wait_seconds = getattr(args, "wait_seconds", 0.0)
                msgs = (
                    _MB.run_inbox(base, me["run"], me["role"])
                    if _MB.is_run_peer(me)
                    else _MB.take(base, me["session"], mark=not args.peek, scope=args.scope)
                )
                if not msgs and wait_seconds > 0:
                    if not _MB.is_run_peer(me):
                        _MB.register(base, session=me["session"], harness=me["harness"], cwd=me["cwd"], state="waiting")
                    try:
                        output = _MB.wait(
                            base,
                            me["session"],
                            timeout=wait_seconds,
                            reply_to=getattr(args, "reply_to", None),
                            mark=not args.peek,
                            scope=args.scope,
                        )
                    finally:
                        if not _MB.is_run_peer(me):
                            _MB.annotate(base, me["session"], state="busy")
                else:
                    output = {"messages": msgs}
            elif args.action == "wait":
                timeout = args.wait_seconds if getattr(args, "wait_seconds", None) is not None else args.timeout
                _MB.register(base, session=me["session"], harness=me["harness"], cwd=me["cwd"], state="waiting")
                try:
                    output = _MB.wait(
                        base,
                        me["session"],
                        timeout=timeout,
                        reply_to=args.reply_to,
                        mark=not args.peek,
                        scope=args.scope,
                    )
                finally:
                    if not _MB.is_run_peer(me):
                        _MB.annotate(base, me["session"], state="busy")
            else:
                if args.action == "ack":
                    output = {
                        "acknowledged": _MB.run_ack(base, me["session"], args.ids)
                        if _MB.is_run_peer(me)
                        else _MB.mark_read(base, me["session"], args.ids)
                    }
                elif args.action == "attach-wake-route":
                    if _MB.is_run_peer(me):
                        raise MailboxError("run sessions are woken by their runner, not an attached route")
                    output = _MB.attach_wake_route(base, me)
                elif args.action == "focus":
                    import mailbox_tasks

                    if _MB.is_run_peer(me):
                        raise MailboxError("focus is for interactive sessions")
                    output = _MB.set_focus(
                        base,
                        me["session"],
                        args.text,
                        model=args.model,
                        harness_label=args.harness_label,
                        channels=args.channel,
                        task_details={
                            key: getattr(args, key)
                            for key in (*mailbox_tasks.LIMITS, "status")
                            if getattr(args, key) is not None
                        },
                    )
                elif args.action in {"join", "leave"}:
                    import mailbox_channels

                    if _MB.is_run_peer(me):
                        raise MailboxError("run sessions report to their conductor, not to channels")
                    changed = mailbox_channels.update(base, me["session"], **{args.action: args.channels})
                    output = {"session": me["session"], "channels": mailbox_channels.memberships(changed)}
                elif args.action == "channels":
                    import mailbox_channels

                    output = {"channels": mailbox_channels.overview(base, me)}
                elif args.action == "history" and args.channel:
                    import mailbox_channels

                    output = mailbox_channels.history(base, me, args.channel, limit=args.limit, before=args.before)
                elif args.action == "history":
                    output = (
                        _MB.run_history(base, me["run"])
                        if _MB.is_run_peer(me)
                        else {
                            "session": me["session"],
                            "messages": _MB.incoming(base, me["session"], unread_only=False, scope=args.scope),
                        }
                    )
                else:
                    raise MailboxError(f"unsupported mailbox action: {args.action}")
            if output.get("status") == "timed_out" and (getattr(args, "reply_to", None) or args.action == "ask"):
                request = _MB.feedback_request(base, me)
                if request:
                    output["feedbackRequest"] = request
            if args.format == "context" and "messages" in output:
                print(_MB.render_all(output["messages"]))
                return 12 if output.get("status") == "timed_out" else 0
        print(json.dumps(output, ensure_ascii=True, indent=None if args.format == "json" else 2))
        if isinstance(output, dict) and output.get("status") == "timed_out":
            return 12
        return 30 if isinstance(output, dict) and output.get("status") == "closed" else 0
    except (MailboxError, OSError, _MB.feedback_module().FeedbackError) as error:
        if args.action not in {"feedback", "feedback-summary", "prune"}:
            peer = {"harness": args.harness or "unknown", "session": _MB.session_arg(args)}
            if _MB.session_arg(args):
                with contextlib.suppress(MailboxError):
                    peer = _MB.load(peer_path(base, _MB.session_arg(args))) or peer
            _MB.record_failure(base, peer, args.action, getattr(args, "scope", "project"), error)
            request = _MB.feedback_request(base, peer)
            if request:
                print(request, file=sys.stderr)
        print(f"mailbox: {error}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
