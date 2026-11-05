#!/usr/bin/env python3
"""Restore previously open swarm displays into verified Herdr panes, without splitting."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import shlex
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

import runtime_paths

SCHEMA = "orkest.herdr-view.v1"


def endpoint(env: dict[str, str]) -> str:
    if env.get("HERDR_SOCKET_PATH"):
        return str(Path(env["HERDR_SOCKET_PATH"]).expanduser().resolve())
    config = Path(env.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "herdr"
    session = env.get("HERDR_SESSION")
    if session:
        config = config / "sessions" / session
    return str((config / "herdr.sock").resolve())


def state_directory(base: Path, env: dict[str, str]) -> Path:
    server = hashlib.sha256(endpoint(env).encode()).hexdigest()[:24]
    return base / "herdr-views-v1" / server


def state_path(base: Path, room: str, env: dict[str, str]) -> Path:
    return state_directory(base, env) / (hashlib.sha256(room.encode()).hexdigest() + ".json")


@contextlib.contextmanager
def operation_lock(base: Path, env: dict[str, str]):
    directory = state_directory(base, env)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / ".operation.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def load(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def save(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data) + "\n")
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class Herdr:
    def __init__(self, binary: str, env: dict[str, str]):
        self.binary, self.env = binary, env

    def call(self, *args: str) -> dict[str, Any]:
        result = subprocess.run(
            [self.binary, *args], env=self.env, capture_output=True, text=True, timeout=15, check=False
        )
        if result.returncode:
            raise RuntimeError(f"Herdr {' '.join(args[:2])} failed: {result.stderr.strip()[:500]}")
        if not result.stdout.strip():
            return {}
        data = json.loads(result.stdout)
        if data.get("error"):
            raise RuntimeError(str(data["error"]))
        return data.get("result", data)

    def panes(self) -> list[dict[str, Any]]:
        snapshot = self.call("api", "snapshot")
        snapshot = snapshot.get("snapshot", snapshot)
        panes = snapshot.get("panes")
        if not isinstance(panes, list):
            raise RuntimeError("Herdr snapshot did not contain panes")
        return [pane for pane in panes if isinstance(pane, dict) and isinstance(pane.get("pane_id"), str)]

    def processes(self, pane: str) -> dict[str, Any]:
        result = self.call("pane", "process-info", "--pane", pane)
        return result.get("process_info", result)


def view_process(info: dict[str, Any], cli: Path, room: str) -> bool:
    for process in info.get("foreground_processes") or []:
        argv = process.get("argv") or []
        if not isinstance(argv, list) or len(argv) < 6:
            continue
        # Require the actual executable script and exact view arguments, not a shell command substring.
        if Path(str(argv[1])).resolve() != cli.resolve():
            continue
        if argv[2:] == ["horde", "--attach-room", room, "--view"]:
            return True
    return False


def idle_shell(info: dict[str, Any]) -> bool:
    shell = info.get("shell_pid")
    processes = info.get("foreground_processes") or []
    return bool(
        isinstance(shell, int)
        and shell > 0
        and processes
        and all(process.get("pid") == shell for process in processes)
        and info.get("foreground_process_group_id") == shell
    )


def prepare(base: Path, room: str, pane: str, cli: Path, env: dict[str, str], api: Herdr) -> Path:
    path = state_path(base, room, env)
    label = "Orkest swarm " + uuid.uuid4().hex
    api.call("pane", "rename", pane, label)
    save(
        path,
        {
            "schema": SCHEMA,
            "room": room,
            "pane": pane,
            "label": label,
            "endpoint": endpoint(env),
            "host": socket.gethostname(),
            "cli": str(cli.resolve()),
        },
    )
    path.with_suffix(".closed").unlink(missing_ok=True)
    path.with_suffix(".pending").unlink(missing_ok=True)
    return path


def command(cli: Path, room: str, state: Path, env: dict[str, str] | None = None) -> str:
    source = os.environ if env is None else env
    return shlex.join(
        [
            "env",
            f"ORKEST_HERDR_VIEW_STATE={state}",
            *([f"AGENT_EXECUTOR_HOME={source['AGENT_EXECUTOR_HOME']}"] if source.get("AGENT_EXECUTOR_HOME") else []),
            shutil.which("node", path=source.get("PATH")) or "node",
            str(cli),
            "horde",
            "--attach-room",
            room,
            "--view",
        ]
    )


def locate(record: dict[str, Any], panes: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not isinstance(record.get("label"), str) or not record["label"].startswith("Orkest swarm "):
        return None
    matches = [pane for pane in panes if pane.get("label") == record.get("label")]
    return matches[0] if len(matches) == 1 else None


def restore(
    base: Path,
    env: dict[str, str],
    api: Herdr,
    *,
    locked: bool = False,
    only_room: str | None = None,
    shell_ready_timeout: float = 0,
) -> list[dict[str, str]]:
    directory = state_directory(base, env)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    outcomes = []
    with contextlib.nullcontext() if locked else operation_lock(base, env):
        panes = api.panes()
        for path in sorted(directory.glob("*.json")):
            record = load(path)
            if not record or record.get("schema") != SCHEMA:
                continue
            if record.get("endpoint") != endpoint(env) or record.get("host") != socket.gethostname():
                continue
            if not isinstance(record.get("cli"), str) or not isinstance(record.get("room"), str):
                continue
            if only_room is not None and record["room"] != only_room:
                continue
            if path.with_suffix(".closed").exists():
                continue
            room = record.get("room")
            pane = locate(record, panes)
            status = "missing_pane"
            if pane and not pane.get("restore_error") and isinstance(room, str):
                try:
                    info = api.processes(pane["pane_id"])
                    # Newly split shells may still be running profile hooks. Only explicit
                    # new-pane launches wait; ordinary restores still skip busy panes.
                    if shell_ready_timeout > 0:
                        deadline = time.monotonic() + shell_ready_timeout
                        while not idle_shell(info) and not view_process(info, Path(record["cli"]), room):
                            if time.monotonic() >= deadline or path.with_suffix(".closed").exists():
                                break
                            time.sleep(0.1)
                            info = api.processes(pane["pane_id"])
                except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                    outcomes.append({"room": room, "status": "inspection_failed"})
                    continue
                cli = Path(record["cli"])
                if view_process(info, cli, room):
                    path.with_suffix(".pending").unlink(missing_ok=True)
                    status = "already_running"
                elif idle_shell(info) and cli.is_file():
                    # Recheck the close tombstone immediately before admitting a command.
                    if path.with_suffix(".closed").exists():
                        continue
                    pending_path = path.with_suffix(".pending")
                    pending = load(pending_path) or {}
                    if pending.get("shell_pid") == info["shell_pid"]:
                        outcomes.append({"room": room, "status": "launch_pending"})
                        continue
                    save(pending_path, {"shell_pid": info["shell_pid"]})
                    try:
                        api.call("pane", "run", pane["pane_id"], command(cli, room, path, env))
                    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                        outcomes.append({"room": room, "status": "launch_unknown"})
                        continue
                    status = "submitted"
                    # Input admission is not proof that the command started. Keep the pending
                    # marker on timeout, so another startup hook cannot queue the same command.
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        try:
                            current = api.processes(pane["pane_id"])
                        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                            status = "launch_unknown"
                            break
                        if view_process(current, cli, room):
                            pending_path.unlink(missing_ok=True)
                            status = "restored"
                            break
                        time.sleep(0.1)
                else:
                    status = "busy_or_unknown"
            # Never recreate an absent pane: its owner may have deliberately closed it in Herdr.
            outcomes.append({"room": str(room), "status": status})
    return outcomes


def adopt(base: Path, env: dict[str, str], api: Herdr, cli: Path) -> list[dict[str, str]]:
    with operation_lock(base, env):
        return _adopt_unlocked(base, env, api, cli)


def _adopt_unlocked(base: Path, env: dict[str, str], api: Herdr, cli: Path) -> list[dict[str, str]]:
    outcomes = []
    panes = {pane["pane_id"]: pane for pane in api.panes()}
    for path in sorted((base / "mailbox-v1" / "rooms").glob("*.json")):
        room = load(path) or {}
        room_id, pane_id = room.get("id"), room.get("herdrViewPaneId")
        if not isinstance(room_id, str) or pane_id not in panes:
            continue
        state = state_path(base, room_id, env)
        if state.exists():
            continue
        if view_process(api.processes(pane_id), cli, room_id):
            prepare(base, room_id, pane_id, cli, env, api)
            outcomes.append({"room": room_id, "status": "adopted"})
    return outcomes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--adopt", action="store_true")
    args = parser.parse_args()
    env = dict(os.environ)
    if env.get("HERDR_ENV") != "1":
        print(json.dumps({"status": "skipped", "reason": "not_inside_herdr"}))
        return 0
    binary = env.get("HERDR_BIN_PATH") or shutil.which("herdr")
    if not binary:
        print(json.dumps({"status": "skipped", "reason": "herdr_unavailable"}))
        return 0
    api = Herdr(binary, env)
    base = runtime_paths.cache_home()
    cli = Path(__file__).resolve().parents[3] / "bin" / "ork.mjs"
    outcomes = adopt(base, env, api, cli) if args.adopt else restore(base, env, api)
    print(json.dumps({"status": "ok", "views": outcomes}))
    return 0


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        raise SystemExit(main())
