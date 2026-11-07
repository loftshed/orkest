"""Resolve Herdr endpoints and native conversations across pane moves."""

import json
import subprocess
from pathlib import Path
from typing import Any


def endpoint(env: dict[str, str]) -> str:
    if env.get("HERDR_SOCKET_PATH"):
        return str(Path(env["HERDR_SOCKET_PATH"]).expanduser().resolve())
    config = Path(env.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "herdr"
    session = env.get("HERDR_SESSION")
    if session:
        config = config / "sessions" / session
    return str((config / "herdr.sock").resolve())


def verified_agent(
    binary: str, pane: str, sessions: set[str], *, env: dict[str, str] | None = None, timeout: float = 3
) -> dict[str, Any] | None:
    if not pane or not sessions:
        return None

    def query(*args: str) -> dict:
        response = subprocess.run(
            [binary, *args], env=env, capture_output=True, text=True, timeout=timeout, check=False
        )
        if response.returncode:
            return {}
        payload = json.loads(response.stdout)
        result = payload.get("result") if isinstance(payload, dict) else None
        return result if isinstance(result, dict) else {}

    try:
        result = query("agent", "get", pane)
        if not result:
            # Herdr preserves moved IDs as pane aliases. Agent commands need the current ID.
            current = query("pane", "current", "--pane", pane).get("pane")
            canonical = current.get("pane_id") if isinstance(current, dict) else None
            if not isinstance(canonical, str) or not canonical or canonical == pane:
                return None
            pane = canonical
            result = query("agent", "get", pane)
        agent = result.get("agent") if result.get("type") == "agent_info" else None
        ref = agent.get("agent_session") if isinstance(agent, dict) else None
        if (
            isinstance(ref, dict)
            and ref.get("kind") == "id"
            and isinstance(ref.get("value"), str)
            and ref["value"] in sessions
        ):
            return {**agent, "pane_id": pane}
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None
