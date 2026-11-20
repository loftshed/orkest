"""Shared helpers for invoking the compiled ork-fast binary in Python test suites."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = REPO_ROOT / "src/py"

_DEFAULT_PID = object()


def find_ork_fast_bin() -> Path:
    explicit = os.environ.get("ORK_FAST_BIN")
    if explicit:
        candidate = Path(explicit).expanduser()
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    for profile in ("release", "debug"):
        candidate = REPO_ROOT / "crates/ork-fast/target" / profile / "ork-fast"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise FileNotFoundError(
        f"ork-fast binary not found under {REPO_ROOT / 'crates/ork-fast/target'}; build with cargo build --release"
    )


def build_test_env(
    *,
    base: Path | None = None,
    env: dict[str, str] | None = None,
    pid: int | None | object = _DEFAULT_PID,
    allow_herdr: bool = False,
    allow_auto_update: bool = False,
) -> dict[str, str]:
    merged = dict(os.environ if env is None else env)
    merged["ORKEST_TEST_MODE"] = "1"
    merged.setdefault("ORKEST_SCRIPTS_DIR", str(SCRIPTS))
    merged.setdefault("ORKEST_PLUGIN_ROOT", str(REPO_ROOT / "plugins/orchestrate"))
    if base is not None:
        home_dir = str(base.parent)
        merged["ORCHESTRATE_HOME"] = home_dir
        merged["AGENT_EXECUTOR_HOME"] = home_dir
    if pid is _DEFAULT_PID:
        merged.setdefault("ORKEST_TEST_HARNESS_PID", str(os.getpid()))
    elif pid is None:
        merged["ORKEST_TEST_HARNESS_PID"] = "none"
    else:
        merged["ORKEST_TEST_HARNESS_PID"] = str(pid)
    if allow_herdr:
        merged["ORKEST_TEST_ALLOW_HERDR"] = "1"
    if allow_auto_update:
        merged["ORKEST_TEST_AUTO_UPDATE"] = "1"
    return merged


def run_mailbox_hook(
    payload: dict[str, Any],
    *,
    harness: str | None = None,
    event: str | None = None,
    base: Path | None = None,
    cwd: str | Path | None = None,
    pid: int | None | object = _DEFAULT_PID,
    env: dict[str, str] | None = None,
    allow_herdr: bool = False,
    allow_auto_update: bool = False,
    timeout: float = 10,
) -> dict[str, Any] | None:
    fast_bin = find_ork_fast_bin()
    cmd = [str(fast_bin), "mailbox-hook"]
    if harness:
        cmd.extend(["--harness", harness])
    if event:
        cmd.extend(["--event", event])
    run_env = build_test_env(
        base=base,
        env=env,
        pid=pid,
        allow_herdr=allow_herdr,
        allow_auto_update=allow_auto_update,
    )
    completed = subprocess.run(
        cmd,
        input=json.dumps(payload),
        cwd=str(cwd) if cwd is not None else None,
        env=run_env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=True,
    )
    raw = (completed.stdout or "").strip()
    if not raw:
        return None
    return json.loads(raw)


def run_gate_hook(
    payload: dict[str, Any],
    *,
    harness: str = "claude",
    gate_dir: Path | str | None = None,
    cwd: str | Path | None = None,
    env: dict[str, str] | None = None,
    timeout: float = 10,
) -> dict[str, Any] | None:
    fast_bin = find_ork_fast_bin()
    run_env = build_test_env(env=env)
    if gate_dir is not None:
        run_env["AGENT_GATE_DIR"] = str(gate_dir)
    completed = subprocess.run(
        [str(fast_bin), "gate-hook", "--harness", harness],
        input=json.dumps(payload),
        cwd=str(cwd) if cwd is not None else None,
        env=run_env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=True,
    )
    raw = (completed.stdout or "").strip()
    if not raw:
        return None
    return json.loads(raw)


def run_statusline(
    *args: str,
    stdin_data: dict[str, Any] | str | None = None,
    base: Path | None = None,
    cwd: str | Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = False,
    timeout: float = 10,
) -> subprocess.CompletedProcess[str]:
    fast_bin = find_ork_fast_bin()
    run_env = build_test_env(base=base, env=env)
    raw_input = json.dumps(stdin_data) if isinstance(stdin_data, dict) else (stdin_data or "")
    return subprocess.run(
        [str(fast_bin), "statusline", *args],
        input=raw_input,
        cwd=str(cwd) if cwd is not None else None,
        env=run_env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=check,
    )


def statusline_identity(
    session: str,
    harness: str,
    *,
    base: Path | None = None,
    width: int = 120,
    native_status: bool = False,
    refresh_terminal: bool = False,
    payload: dict[str, Any] | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    args = ["--session", session, "--harness", harness, "--width", str(width), "--json"]
    if native_status:
        args.append("--native-status")
    if refresh_terminal:
        args.append("--refresh-terminal")
    completed = run_statusline(*args, stdin_data=payload, base=base, env=env)
    raw = (completed.stdout or "").strip()
    if completed.returncode != 0 or not raw:
        return None
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, dict) and parsed else None
