"""Orca IDE terminal identity, safe CLI resolution, and the state files shared with the Orca worker."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import runtime_paths

TERMINALS_SCHEMA = "orkest.orca-terminals.v1"
VIEW_SCHEMA = "orkest.orca-view.v1"
VIEW_TITLE_PREFIX = "Orkest Swarm"
# On Linux these are the GNOME Orca screen reader, never the Orca IDE CLI.
SCREEN_READER_PATHS = ("/usr/bin/orca", "/bin/orca")
_HANDLE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}")


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def terminal_handle(value: Any) -> str:
    """A terminal handle that is safe to pass as a CLI argument; otherwise ""."""
    handle = _text(value)
    return handle if _HANDLE.fullmatch(handle) else ""


def _realpath(path: str) -> str:
    try:
        return os.path.realpath(path)
    except OSError:
        return path


def is_screen_reader(path: str | None, platform: str | None = None) -> bool:
    if (platform or sys.platform) != "linux" or not path:
        return False
    resolved = _realpath(path)
    return any(path == candidate or resolved == _realpath(candidate) for candidate in SCREEN_READER_PATHS)


def resolve_cli(
    env: Mapping[str, str] | None = None,
    *,
    platform: str | None = None,
    which: Callable[..., str | None] = shutil.which,
) -> str | None:
    """The Orca IDE CLI for this environment, as an absolute path, or None.

    Order: ORCA_CLI_COMMAND, orca-dev in a dev checkout, orca (only when it is not the Linux screen
    reader), then orca-ide. An explicit choice never falls through to another executable.
    """
    source = os.environ if env is None else env
    platform = platform or sys.platform
    search = source.get("PATH")

    def guard(name: str) -> str | None:
        found = which(name, path=search)
        return found if found and not is_screen_reader(found, platform) else None

    explicit = _text(source.get("ORCA_CLI_COMMAND"))
    if explicit:
        return guard(explicit)
    if _text(source.get("ORCA_DEV_REPO_ROOT")):
        return guard("orca-dev")
    orca = guard("orca")
    if platform != "linux":
        return orca
    return orca or guard("orca-ide")


def pane_context(env: Mapping[str, str] | None = None) -> dict[str, str] | None:
    """The Orca terminal this process runs in, from the PTY environment, or None outside Orca."""
    source = os.environ if env is None else env
    pane_key = _text(source.get("ORCA_PANE_KEY")) or _text(source.get("ORCA_AGENT_PANE"))
    if not pane_key:
        return None
    return {
        "paneKey": pane_key,
        "terminalHandle": terminal_handle(source.get("ORCA_TERMINAL_HANDLE")),
        "tabId": _text(source.get("ORCA_TAB_ID")),
        "worktreeId": _text(source.get("ORCA_WORKTREE_ID")),
        "environment": _text(source.get("ORCA_ENVIRONMENT")),
        "launchToken": _text(source.get("ORCA_AGENT_LAUNCH_TOKEN")) or _text(source.get("ORCA_AGENT_LAUNCH")),
    }


def terminals_path(cache: Path | None = None) -> Path:
    return (cache or runtime_paths.cache_home()) / "orca-terminals-v1.json"


def view_key(room: str) -> str:
    return hashlib.sha256(room.encode()).hexdigest()


def views_directory(cache: Path | None = None) -> Path:
    return (cache or runtime_paths.cache_home()) / "orca-views-v1"


def view_path(room: str, cache: Path | None = None) -> Path:
    return views_directory(cache) / f"{view_key(room)}.json"


def view_title(room: str) -> str:
    return f"{VIEW_TITLE_PREFIX} · {room[:64]}"


def load(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def save(path: Path, data: dict[str, Any]) -> None:
    """Replace path atomically, private to this user."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data) + "\n")
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def registry(cache: Path | None = None) -> dict[str, dict[str, Any]]:
    data = load(terminals_path(cache))
    terminals = data.get("terminals") if data and data.get("schema") == TERMINALS_SCHEMA else None
    return {key: value for key, value in (terminals or {}).items() if isinstance(value, dict)}


def lookup_terminal(pane_key: str, cache: Path | None = None) -> str:
    """The terminal handle the Orca worker recorded for a pane key, when exactly one matches."""
    if not pane_key:
        return ""
    matches = {
        terminal_handle(entry.get("terminalId") or key)
        for key, entry in registry(cache).items()
        if entry.get("paneKey") == pane_key
    }
    matches.discard("")
    return matches.pop() if len(matches) == 1 else ""


def current_terminal(env: Mapping[str, str] | None = None, cache: Path | None = None) -> str:
    context = pane_context(env)
    if not context:
        return ""
    return context["terminalHandle"] or lookup_terminal(context["paneKey"], cache)


class OrcaCli:
    """A thin wrapper over the Orca IDE CLI's JSON output."""

    def __init__(self, binary: str, env: Mapping[str, str] | None = None, *, run: Callable[..., Any] = subprocess.run):
        self.binary = binary
        self.env = dict(os.environ if env is None else env)
        self.run = run

    def call(self, *args: str, timeout: float = 15) -> dict[str, Any]:
        result = self.run(
            [self.binary, *args, "--json"],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(f"Orca {' '.join(args[:2])} failed: {(result.stderr or '').strip()[:500]}")
        data = json.loads(result.stdout or "{}")
        if not isinstance(data, dict):
            raise RuntimeError("Orca returned malformed JSON")
        if data.get("error"):
            raise RuntimeError(str(data["error"]))
        payload = data.get("result", data)
        return payload if isinstance(payload, dict) else {}

    def terminals(self) -> set[str]:
        listed = self.call("terminal", "list").get("terminals")
        if not isinstance(listed, list):
            raise RuntimeError("Orca terminal list did not contain terminals")
        return {terminal_handle(item.get("handle")) for item in listed if isinstance(item, dict)} - {""}

    def split(self, terminal: str, command: str) -> str:
        split = self.call(
            "terminal", "split", "--terminal", terminal, "--direction", "vertical", "--command", command, timeout=20
        ).get("split")
        handle = terminal_handle(split.get("handle") if isinstance(split, dict) else None)
        if not handle:
            raise RuntimeError("Orca split the pane without naming its terminal")
        return handle

    def rename(self, terminal: str, title: str) -> None:
        self.call("terminal", "rename", "--terminal", terminal, "--title", title)

    def close(self, terminal: str) -> None:
        self.call("terminal", "close", "--terminal", terminal)

    def focus(self, terminal: str) -> bool:
        focus = self.call("terminal", "switch", "--terminal", terminal).get("focus")
        return not isinstance(focus, dict) or focus.get("focused") is not False
