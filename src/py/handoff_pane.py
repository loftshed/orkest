"""Start a quota successor on the pane's PTY and report startup to the handoff worker."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

import authority
import execution_support
import handoff
import repo_policy
import runtime_paths
import succession
from run_agent import CLAUDE_AUTH_ENV_OVERRIDES, HOST_SESSION_ENV

PANE_ENV = {
    "CLAUDE_CONFIG_DIR",
    "ANTIGRAVITY_APP_DATA_DIR",
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "TMUX",
    "TMUX_PANE",
    "ORKEST_TERMINAL_SERVER",
}


def native_environment(request: dict[str, Any], ready: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key in PANE_ENV or not HOST_SESSION_ENV.match(key)}
    for key in ("AGENT_MAILBOX_LISTENER_SESSION", "ORKEST_HANDOFF_LAUNCH", "ORKEST_READONLY_RUN"):
        env.pop(key, None)
    env["ORKEST_HANDOFF_SUCCESSOR"] = request["session"]
    env["ORKEST_HANDOFF_STARTUP"] = str(ready)
    env["ORKEST_TERMINAL_HARNESS"] = request["harness"]
    if request["engine"] == "claude":
        for key in CLAUDE_AUTH_ENV_OVERRIDES:
            env.pop(key, None)
        if home := env.pop("ORKEST_CLAUDE_ACCOUNT_HOME", None):
            env["HOME"] = home
    elif request["engine"] == "agy" and "GEMINI_CLI_HOME" in env:
        env.setdefault("ANTIGRAVITY_APP_DATA_DIR", str(Path(env["GEMINI_CLI_HOME"]) / "antigravity-cli"))
    return env


def offer_live(request: dict[str, Any]) -> bool:
    if time.monotonic() >= request["deadline"]:
        return False
    event = handoff.load_json(handoff.session_dir(request["predecessor"]) / "event.json") or {}
    record = authority.load(authority.team_dir(request["team"])) or {}
    offer = record.get("offer") or {}
    return (
        event.get("id") == request["event"]
        and record.get("generation") == request["generation"]
        and offer.get("automatic") == request["event"]
        and offer["to"]["session"] == request["session"]
        and not authority.automatic_offer_expired(offer)
    )


def start(request_path: Path) -> int:
    ready = request_path.with_name("ready.json")
    exited = request_path.with_name("exit.json")
    attempts = request_path.with_name("attempts.json")

    def fail(code: int, reason: str, **detail: Any) -> int:
        print(f"Orkest quota handoff: {reason}", flush=True)
        handoff.write_private(exited, json.dumps({"exitCode": code, "reason": reason, **detail}))
        return code

    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        if not offer_live(request):
            return fail(1, "the automatic handoff offer is no longer current")
        config, view = succession.monitor_config(), succession.cached_view()
        pool = succession.pool_for(request["harness"], request["model"], request["account"], view or {}, config)
        if pool.get("status") == "credits":
            return fail(18, "the selected successor pool would bill credits")
        if pool.get("status") == "blocked":
            return fail(15, "the selected successor pool is blocked")
        if (
            pool.get("status") != "available"
            or pool["pool"] != request["pool"]
            or pool["billing"] != request["context"]
            or not succession.pool_fresh(pool, config)
            or succession.account_of(request["harness"], request["accountHome"], config, view=view)[0]
            != request["account"]
        ):
            return fail(15, "fresh quota on the selected successor account could not be verified")
        engine, model = request["engine"], request["model"]
        env = native_environment(request, ready)
        if not handoff.allowed_here(
            repo_policy,
            request["checkout"],
            engine,
            env.get("CLAUDE_CONFIG_DIR") if engine == "claude" else None,
            account_id=request["account"],
            provider=pool["provider"],
            billing_mode=pool["billing"],
            tags=pool["tags"],
            account_alias=pool["alias"],
            codex_home=request["accountHome"] if engine == "codex" else None,
            agy_home=request["accountHome"] if engine == "agy" else None,
            strict=True,
        ):
            return fail(4, "the repository policy refused the selected successor account")
        prompt = Path(request["brief"]).read_text(encoding="utf-8")
        command = {
            "claude": ["claude", "--model", model, "--", prompt],
            "codex": ["codex", "-m", model, "--", prompt],
            "agy": ["agy", "--model", model, "--prompt-interactive", prompt],
        }[engine]
        child = None
        # A short reader can hold the lease. Retry in this pane, so a busy lease never opens another one.
        for attempt, delay in enumerate((0, *request.get("retrySeconds", ())), start=1):
            if delay:
                time.sleep(delay)
            try:
                # Interactive sessions use the same exclusive startup probe as detached runs. After spawn
                # the team offer governs their authority, and interactive sessions hold no executor lease.
                with execution_support.workspace_lease(Path(request["checkout"]), runtime_paths.cache_home()):
                    handoff.write_private(attempts, json.dumps({"attempts": attempt, "leaseBusy": False}))
                    if not offer_live(request):
                        return fail(1, "the automatic handoff offer is no longer current")
                    # The harness shares the foreground process group and handles the user's interrupt.
                    signal.signal(signal.SIGINT, lambda *_: None)
                    child = subprocess.Popen(command, cwd=request["checkout"], env=env)
                break
            except execution_support.ContractError as error:
                busy = str(error)
                handoff.write_private(attempts, json.dumps({"attempts": attempt, "leaseBusy": True}))
                print(f"Orkest quota handoff: {busy}; waiting to retry", flush=True)
        if child is None:
            return fail(handoff.LEASE_BUSY_EXIT, busy)
    except (OSError, ValueError, KeyError) as error:
        return fail(1, f"the interactive harness could not start: {error}")

    while time.monotonic() < request["deadline"]:
        if (code := child.poll()) is not None:
            return fail(code if code > 0 else 1, "the interactive harness exited during startup")
        if ready.is_file():
            return child.wait()
        time.sleep(0.1)
    # A harness without a working mailbox hook cannot confirm it started as the intended successor,
    # often because the successor account has not yet trusted this folder or its hooks. Stop it
    # before reporting, so the headless fallback can never run beside it.
    child.terminate()
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    return fail(
        1,
        "the interactive harness did not register before the startup deadline; "
        "its account may not trust this folder or its hooks yet",
        readyTimeout=True,
    )
