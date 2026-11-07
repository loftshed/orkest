"""Bind a visible native session to its Herdr or private Orkest tmux pane."""

from __future__ import annotations

import contextlib
import json
import os
import re
import shlex
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

import peer_mailbox as mailbox
from herdr_context import endpoint as herdr_endpoint
from herdr_context import verified_agent

_HERDR_METADATA_TTL_MS = 120_000
_HERDR_METADATA_REFRESH_SEC = 45
_SUBAGENT_MAX_STALE_SEC = 1800.0


def _clean_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:120]


def _extract_model_and_effort(
    peer_data: dict[str, Any] | None, payload: dict[str, Any] | None = None
) -> tuple[str, str, str]:
    payload = payload if isinstance(payload, dict) else {}
    peer = peer_data if isinstance(peer_data, dict) else {}
    raw_model = peer.get("model") or payload.get("model")
    raw_effort = peer.get("effort") or payload.get("effort")
    if isinstance(raw_model, dict):
        if not raw_effort:
            raw_effort = raw_model.get("effort") or raw_model.get("level")
        raw_model = raw_model.get("display_name") or raw_model.get("id") or ""
    if isinstance(raw_effort, dict):
        raw_effort = raw_effort.get("level") or raw_effort.get("effort") or ""
    if not raw_effort:
        raw_effort = payload.get("effortLevel") or payload.get("reasoning_effort") or peer.get("effortLevel") or ""
    model_str = _clean_text(raw_model)
    if model_str.lower() == "auto":
        model_str = ""
    effort_str = _clean_text(raw_effort)
    if effort_str == "—":
        effort_str = ""
    source_str = _clean_text(peer.get("modelSource") or ("runtime" if payload.get("model") else ""))
    return model_str, effort_str, source_str


def aggregate_children(base: Path, parent_peer: dict[str, Any]) -> dict[str, Any]:
    """Aggregate active observed children matching explicit parentSession, accountHome, and checkout."""
    parent_session = _clean_text(parent_peer.get("session"))
    parent_account = _clean_text(parent_peer.get("accountHome"))
    parent_checkout_raw = parent_peer.get("checkout") or parent_peer.get("cwd")
    if not parent_session or not isinstance(parent_checkout_raw, str) or not parent_checkout_raw.strip():
        return {"count": 0, "summary": "", "digest": "", "children": []}
    try:
        parent_checkout = str(Path(parent_checkout_raw).expanduser().resolve())
    except OSError:
        return {"count": 0, "summary": "", "digest": "", "children": []}

    active_children: list[dict[str, str]] = []
    moment = mailbox.now()
    peers_dir = base / "peers"
    if peers_dir.is_dir():
        for path in sorted(peers_dir.glob("*.json")):
            peer = mailbox.load(path)
            if not isinstance(peer, dict) or peer.get("schema") != mailbox.PEER_SCHEMA:
                continue
            if not peer.get("isSubagent"):
                continue
            if _clean_text(peer.get("parentSession")) != parent_session:
                continue
            child_account = _clean_text(peer.get("accountHome"))
            if parent_account and child_account != parent_account:
                continue
            child_checkout_raw = peer.get("checkout") or peer.get("cwd")
            if not isinstance(child_checkout_raw, str) or not child_checkout_raw.strip():
                continue
            try:
                child_checkout = str(Path(child_checkout_raw).expanduser().resolve())
            except OSError:
                continue
            if child_checkout != parent_checkout:
                continue
            if peer.get("state") != "busy" or peer.get("lastStopReason"):
                continue
            if not mailbox.is_live(peer, moment):
                continue
            # Expire abandoned subagent records if no hook/progress arrived within the stale safety ceiling.
            seen_stamp = peer.get("lastSeenAt") or peer.get("startedAt")
            if isinstance(seen_stamp, str):
                with contextlib.suppress(ValueError):
                    age_sec = (moment - mailbox.parse_stamp(seen_stamp)).total_seconds()
                    if age_sec > _SUBAGENT_MAX_STALE_SEC:
                        continue
            model_str, effort_str, source_str = _extract_model_and_effort(peer)
            provenance = (
                "observed" if source_str == "runtime" and model_str else ("requested" if model_str else "unknown")
            )
            spec = f"{model_str}/{effort_str}" if model_str and effort_str else (model_str or effort_str or "subagent")
            active_children.append(
                {
                    "session": _clean_text(peer.get("session")),
                    "model": model_str,
                    "effort": effort_str,
                    "provenance": provenance,
                    "spec": spec,
                }
            )

    if not active_children:
        return {"count": 0, "summary": "", "digest": "", "children": []}

    count = len(active_children)
    noun = "1 child" if count == 1 else f"{count} children"
    specs: list[str] = []
    for item in active_children:
        label = item["spec"]
        if item["provenance"] == "observed" and item["model"]:
            label = f"{label} observed"
        if label not in specs:
            specs.append(label)
    detail = ", ".join(specs[:2])
    if len(specs) > 2:
        detail = f"{detail}, +{len(specs) - 2}"
    summary = f"{noun}: {detail}" if detail else noun
    digest = ";".join(
        f"{item['session']}:{item['model']}:{item['effort']}:{item['provenance']}" for item in active_children
    )
    return {"count": count, "summary": summary, "digest": digest, "children": active_children}


def refresh_parent_pane(base: Path, parent_session: str | None) -> bool:
    """Refresh a parent session's Herdr pane metadata using its own recorded Herdr binding."""
    if not isinstance(parent_session, str) or not parent_session.strip():
        return False
    try:
        mailbox.session_key(parent_session)
        peer_data = mailbox.load(mailbox.peer_path(base, parent_session))
    except (mailbox.MailboxError, OSError):
        return False
    if not isinstance(peer_data, dict) or peer_data.get("isSubagent") or peer_data.get("delegatedRun"):
        return False
    pane_id = _clean_text(peer_data.get("herdrPaneId"))
    endpoint = _clean_text(peer_data.get("herdrEndpoint"))
    harness = _clean_text(peer_data.get("harness"))
    binary = _clean_text(peer_data.get("herdrBinary")) or os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
    if not pane_id or not endpoint or not harness or not binary:
        return False
    workspace_id = _clean_text(peer_data.get("herdrWorkspaceId")) or None
    return _sync_herdr_pane(
        base=base,
        session=parent_session,
        harness=harness,
        peer_data=peer_data,
        payload={},
        pane_id=pane_id,
        workspace_id=workspace_id,
        endpoint=endpoint,
        binary=binary,
        force=False,
    )


def _resolve_structural_role(
    base: Path,
    session: str,
    harness: str | None,
    peer_data: dict[str, Any] | None,
    only_room: str | None = None,
) -> tuple[str, str, bool]:
    matched_room_id = ""
    structural_role = ""
    is_exact_conductor = False
    with contextlib.suppress(Exception):
        import agent_statusline_tmux

        peer_cwd = peer_data.get("checkout") or peer_data.get("cwd") if isinstance(peer_data, dict) else None
        aliases = (
            peer_data.get("aliases")
            if isinstance(peer_data, dict) and isinstance(peer_data.get("aliases"), list)
            else None
        )
        matched = agent_statusline_tmux.find_session_swarm_room(
            base,
            session,
            harness=harness,
            cwd=peer_cwd,
            aliases=aliases,
            only_room=only_room,
        )
        if isinstance(matched, dict) and isinstance(matched.get("id"), str):
            member_id = matched.get("_matchedMemberId")
            member = (
                matched.get("conductor")
                if member_id == "conductor"
                else next((agent for agent in matched.get("agents", []) if agent.get("id") == member_id), None)
            )
            binding = member.get("session") if isinstance(member, dict) else None
            bound_cwd = (
                (binding.get("cwd") if isinstance(binding, dict) else None)
                or (member.get("cwd") if isinstance(member, dict) else None)
                or matched.get("cwd")
            )
            if not peer_cwd or not bound_cwd or Path(peer_cwd).resolve() == Path(bound_cwd).resolve():
                matched_room_id = matched["id"]
                if matched.get("_matchedSessionId") == session:
                    is_exact_conductor = member_id == "conductor"
                    structural_role = "Coordinator" if is_exact_conductor else "Lead"
    return matched_room_id, structural_role, is_exact_conductor


def _sync_herdr_pane(
    *,
    base: Path,
    session: str,
    harness: str | None,
    peer_data: dict[str, Any] | None,
    payload: dict[str, Any],
    pane_id: str,
    workspace_id: str | None,
    endpoint: str,
    binary: str | None,
    force: bool = False,
    structural_role: str | None = None,
) -> bool:
    annotations: dict[str, Any] = {}
    if isinstance(peer_data, dict) and peer_data.get("terminalServer") is not None:
        annotations["terminalServer"] = None
    if not isinstance(peer_data, dict) or peer_data.get("herdrPaneId") != pane_id:
        annotations["herdrPaneId"] = pane_id
    if workspace_id and (not isinstance(peer_data, dict) or peer_data.get("herdrWorkspaceId") != workspace_id):
        annotations["herdrWorkspaceId"] = workspace_id
    if not isinstance(peer_data, dict) or peer_data.get("herdrEndpoint") != endpoint:
        annotations["herdrEndpoint"] = endpoint
    if binary and (not isinstance(peer_data, dict) or peer_data.get("herdrBinary") != binary):
        annotations["herdrBinary"] = binary

    if isinstance(peer_data, dict):
        if structural_role is None:
            _, structural_role, _ = _resolve_structural_role(
                base, session, harness, peer_data, only_room=os.environ.get("ORKEST_SWARM_ROOM") or None
            )
        person = peer_data.get("person")
        raw_name = peer_data.get("name")
        short_name = (
            raw_name.split("-", 1)[0].strip()
            if isinstance(raw_name, str) and raw_name.strip()
            else (person.strip() if isinstance(person, str) and person.strip() else "")
        )
        stage = ""
        role = ""
        with contextlib.suppress(Exception):
            import agent_progress

            progress = agent_progress.read(base, peer_data)
            if isinstance(progress, dict):
                stage = str(progress.get("stage") or "").strip()
                role = str(progress.get("role") or "").strip()
        title = f"{short_name} · {stage}" if short_name and stage else short_name
        report_seq = time.time_ns()
        model_str, effort_str, source_str = _extract_model_and_effort(peer_data, payload)
        children_info = aggregate_children(base, peer_data)
        child_summary = children_info["summary"]
        child_digest = children_info["digest"]
        roles = [structural_role]
        if role.casefold() != structural_role.casefold():
            roles.append(role)
        display_agent = " · ".join(part for part in (*roles, model_str, child_summary) if part)
        provenance = "observed" if source_str == "runtime" and model_str else ""
        extra_sync: list[str] = []
        if effort_str:
            extra_sync.append(f"effort={effort_str}")
        if provenance and isinstance(peer_data.get("modelSource"), str):
            extra_sync.append(f"prov={provenance}")
        if child_digest:
            extra_sync.append(f"children={child_digest}")
        base_sync_key = f"{title}|{display_agent}" if display_agent else title
        sync_key = f"{base_sync_key}|{'|'.join(extra_sync)}" if extra_sync else base_sync_key
        sync_target: dict[str, Any] = {"endpoint": endpoint, "pane": pane_id}
        last_sync = peer_data.get("herdrSyncedAt")
        if (
            title
            and (
                force
                or peer_data.get("herdrSyncedTitle") != sync_key
                or peer_data.get("herdrSyncedTarget") != sync_target
                or not isinstance(last_sync, int | float)
                or time.time() - last_sync >= _HERDR_METADATA_REFRESH_SEC
            )
            and binary
        ):
            herdr_env = {**os.environ, "HERDR_SOCKET_PATH": endpoint}
            occupant = verified_agent(binary, pane_id, {session}, env=herdr_env, timeout=0.5)
            ref = occupant["agent_session"] if occupant else {}
            if occupant and isinstance(ref.get("agent"), str) and ref["agent"]:
                resolved_pane = occupant["pane_id"]
                if resolved_pane != pane_id:
                    annotations["herdrPaneId"] = resolved_pane
                sync_target = {"endpoint": endpoint, "pane": resolved_pane}
                cmd = [
                    binary,
                    "pane",
                    "report-metadata",
                    resolved_pane,
                    "--source",
                    "orkest",
                    "--agent",
                    ref["agent"],
                    "--title",
                    title,
                    "--seq",
                    str(report_seq),
                    "--ttl-ms",
                    str(_HERDR_METADATA_TTL_MS),
                ]
                # Session-only integrations have no lifecycle authority to match.
                if ref.get("source") == "herdr:opencode":
                    cmd.extend(["--applies-to-source", ref["source"]])
                if display_agent:
                    cmd.extend(["--display-agent", display_agent])
                else:
                    cmd.append("--clear-display-agent")
                with contextlib.suppress(OSError, subprocess.SubprocessError):
                    res = subprocess.run(
                        cmd,
                        env=herdr_env,
                        capture_output=True,
                        text=True,
                        timeout=0.5,
                        check=False,
                    )
                    if getattr(res, "returncode", 1) == 0:
                        annotations["herdrSyncedTitle"] = sync_key
                        annotations["herdrSyncedTarget"] = sync_target
                        annotations["herdrSyncedAt"] = time.time()
    if annotations:
        with contextlib.suppress(Exception):
            mailbox.annotate(base, session, **annotations)
    return True


def context(harness: str | None) -> tuple[str, str] | None:
    server = os.environ.get("ORKEST_TERMINAL_SERVER", "")
    pane = os.environ.get("TMUX_PANE", "")
    socket = os.environ.get("TMUX", "").split(",", 1)[0]
    if (
        not re.fullmatch(r"orkest-label-[0-9a-f]{12}", server)
        or not re.fullmatch(r"%[0-9]+", pane)
        or Path(socket).name != server
        or harness != os.environ.get("ORKEST_TERMINAL_HARNESS")
    ):
        return None
    return server, pane


def herdr_context(harness: str | None) -> tuple[str, str | None] | None:
    if os.environ.get("HERDR_ENV") != "1":
        return None
    pane = os.environ.get("HERDR_PANE_ID", "").strip()
    if not pane:
        return None
    expected_harness = os.environ.get("ORKEST_TERMINAL_HARNESS", "").strip()
    if expected_harness and harness and harness != expected_harness:
        return None
    workspace = os.environ.get("HERDR_WORKSPACE_ID", "").strip() or None
    return pane, workspace


def bind(
    session: str,
    harness: str | None,
    payload: dict[str, Any],
    *,
    base: Path | None = None,
    force: bool = False,
) -> bool:
    target = context(harness)
    herdr = herdr_context(harness)
    if herdr:
        target = None
    if not target and not herdr:
        return False
    try:
        mailbox.session_key(session)
        base = base or mailbox.root()
        peer_data: dict[str, Any] | None = None
        with contextlib.suppress(Exception):
            loaded = mailbox.load(mailbox.peer_path(base, session))
            if isinstance(loaded, dict):
                peer_data = loaded
        if isinstance(peer_data, dict) and (peer_data.get("isSubagent") or peer_data.get("delegatedRun")):
            return False
        matched_room_id, structural_role, is_exact_conductor = _resolve_structural_role(
            base,
            session,
            harness,
            peer_data,
            only_room=os.environ.get("ORKEST_SWARM_ROOM") or None,
        )
        annotations: dict[str, Any] = {}
        if target and (not isinstance(peer_data, dict) or peer_data.get("terminalServer") != target[0]):
            annotations["terminalServer"] = target[0]
        if target and isinstance(peer_data, dict):
            for key in (
                "herdrPaneId",
                "herdrWorkspaceId",
                "herdrEndpoint",
                "herdrBinary",
                "herdrSyncedTitle",
                "herdrSyncedTarget",
                "herdrSyncedAt",
            ):
                if peer_data.get(key) is not None:
                    annotations[key] = None
        if herdr:
            pane_id, workspace_id = herdr
            endpoint = herdr_endpoint(dict(os.environ))
            binary = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
            _sync_herdr_pane(
                base=base,
                session=session,
                harness=harness,
                peer_data=peer_data,
                payload=payload,
                pane_id=pane_id,
                workspace_id=workspace_id,
                endpoint=endpoint,
                binary=binary,
                force=force,
                structural_role=structural_role,
            )
        elif annotations:
            with contextlib.suppress(Exception):
                mailbox.annotate(base, session, **annotations)
        if herdr and matched_room_id and is_exact_conductor:
            with contextlib.suppress(Exception):
                import agent_statusline_tmux

                pane_id, workspace_id = herdr
                agent_statusline_tmux._update_room_metadata(
                    base,
                    matched_room_id,
                    herdrCoordinatorPaneId=pane_id,
                    herdrEndpoint=endpoint,
                    **({"herdrWorkspaceId": workspace_id} if workspace_id else {}),
                )
        if not target:
            return True
        # Only display metadata crosses into the pane; never retain the native session payload.
        fields = {}
        for key in ("model", "effort", "effortLevel", "reasoning_effort"):
            value = payload.get(key)
            if isinstance(value, str):
                fields[key] = value[:240]
            elif isinstance(value, dict):
                fields[key] = {
                    k: v[:240]
                    for k, v in value.items()
                    if k in {"id", "display_name", "effort", "level"} and isinstance(v, str)
                }
        server, pane = target
        binding = json.dumps({"session": session, "harness": harness, "payload": fields})
        subprocess.run(
            [
                "tmux",
                "-L",
                server,
                "set-option",
                "-p",
                "-t",
                pane,
                "@orkest_identity",
                binding,
                ";",
                "set-option",
                "-p",
                "-t",
                pane,
                "@orkest_session",
                session,
            ],
            capture_output=True,
            timeout=2,
            check=True,
        )
        if matched_room_id:
            with contextlib.suppress(OSError, subprocess.SubprocessError):
                existing_room = subprocess.run(
                    ["tmux", "-L", server, "show-option", "-t", "orkest", "-v", "@orkest_room"],
                    capture_output=True,
                    text=True,
                    timeout=2,
                    check=False,
                ).stdout.strip()
                if not existing_room:
                    subprocess.run(
                        ["tmux", "-L", server, "set-option", "-t", "orkest", "@orkest_room", matched_room_id],
                        capture_output=True,
                        timeout=2,
                        check=False,
                    )
        return True
    except (mailbox.MailboxError, OSError, subprocess.SubprocessError):
        return False


def read(server: str, pane: str, harness: str) -> dict[str, Any] | None:
    if not re.fullmatch(r"orkest-label-[0-9a-f]{12}", server) or not re.fullmatch(r"%[0-9]+", pane):
        return None
    try:
        output = subprocess.run(
            ["tmux", "-L", server, "display-message", "-p", "-t", pane, "#{@orkest_session}\n#{@orkest_identity}"],
            capture_output=True,
            text=True,
            timeout=2,
            check=True,
        ).stdout
        if len(output) > 8192:
            return None
        session, raw = output.split("\n", 1)
        mailbox.session_key(session)
        data = json.loads(raw)
        if (
            isinstance(data, dict)
            and data.get("session") == session
            and data.get("harness") == harness
            and isinstance(data.get("payload"), dict)
        ):
            return data
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def clear(session: str, harness: str | None) -> None:
    target = context(harness)
    if not target:
        return
    try:
        mailbox.session_key(session)
        server, pane = target
        # The comparison and unset happen in tmux, so a late cleanup cannot clear a newer session.
        subprocess.run(
            [
                "tmux",
                "-L",
                server,
                "if-shell",
                "-F",
                "-t",
                pane,
                f"#{{==:#{{@orkest_session}},{session}}}",
                shlex.join(["set-option", "-p", "-u", "-t", pane, "@orkest_session"]),
            ],
            capture_output=True,
            timeout=2,
            check=True,
        )
    except (mailbox.MailboxError, OSError, subprocess.SubprocessError):
        pass
