# cspell:words herdr
"""Bind a visible native session to its private Orkest tmux pane, without changing presence."""

from __future__ import annotations

import contextlib
import json
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Any

import peer_mailbox as mailbox
from herdr_swarm_restore import endpoint as herdr_endpoint


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
                only_room=os.environ.get("ORKEST_SWARM_ROOM") or None,
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
        annotations: dict[str, Any] = {}
        if target and (not isinstance(peer_data, dict) or peer_data.get("terminalServer") != target[0]):
            annotations["terminalServer"] = target[0]
        if herdr:
            pane_id, workspace_id = herdr
            if not isinstance(peer_data, dict) or peer_data.get("herdrPaneId") != pane_id:
                annotations["herdrPaneId"] = pane_id
            if workspace_id and (not isinstance(peer_data, dict) or peer_data.get("herdrWorkspaceId") != workspace_id):
                annotations["herdrWorkspaceId"] = workspace_id
            if isinstance(peer_data, dict):
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
                raw_model = peer_data.get("model") or payload.get("model")
                if isinstance(raw_model, dict):
                    raw_model = raw_model.get("display_name") or raw_model.get("id") or ""
                model_str = str(raw_model or "").strip()
                roles = [structural_role]
                if role.casefold() != structural_role.casefold():
                    roles.append(role)
                display_agent = " · ".join(part for part in (*roles, model_str) if part)
                sync_key = f"{title}|{display_agent}" if display_agent else title
                sync_target = {"endpoint": herdr_endpoint(dict(os.environ)), "pane": pane_id}
                if (
                    title
                    and (
                        force
                        or peer_data.get("herdrSyncedTitle") != sync_key
                        or peer_data.get("herdrSyncedTarget") != sync_target
                    )
                    and shutil.which("herdr")
                ):
                    cmd = ["herdr", "pane", "report-metadata", pane_id, "--source", "orkest", "--title", title]
                    if display_agent:
                        cmd.extend(["--display-agent", display_agent])
                    with contextlib.suppress(OSError, subprocess.SubprocessError):
                        res = subprocess.run(
                            cmd,
                            capture_output=True,
                            text=True,
                            timeout=0.5,
                            check=False,
                        )
                        if getattr(res, "returncode", 1) == 0:
                            annotations["herdrSyncedTitle"] = sync_key
                            annotations["herdrSyncedTarget"] = sync_target
        if annotations:
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
