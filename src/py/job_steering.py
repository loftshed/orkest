"""Detached job launch, live steering protocol, and Codex credits watch."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows falls back to atomic replacement.
    fcntl = None  # type: ignore[assignment]

CREDITS_CHECK_SECONDS = 5.0
CREDITS_WATCH_GRACE_SECONDS = 120.0
CREDITS_WATCH_MAX_BLIND_LINES = 150

STEER_PROTOCOL = 1
STEER_REQUEST_NAME = "steer-request.json"
STEER_STATE_NAME = "steering.json"
STEER_STATE_SCHEMA = "agent-executor.steering.v1"
STEER_REQUEST_SCHEMA = "agent-executor.steer-request.v1"
STEER_POLL_SECONDS = 0.5
STEER_INTERRUPT_GRACE_SECONDS = 10.0
STEER_MESSAGE_MAX_BYTES = 64 * 1024
DEFAULT_STEER_WAIT_TIMEOUT = "2m"
EXIT_STEER_JOB_FINISHED = 30
EXIT_STEER_OTHER_WORKTREE = 31
EXIT_STEER_PROCESS_NOT_FOUND = 32
EXIT_STEER_REJECTED = 33


def _runner() -> Any:
    mod = globals().get("_runner_module")
    if mod is not None and hasattr(mod, "RunnerError"):
        return mod
    for key in ("run_agent", "agent_executor_run_agent", "__main__"):
        candidate = sys.modules.get(key)
        if candidate is not None and hasattr(candidate, "RunnerError"):
            return candidate
    return None


def _attr(name: str, default: Any = None) -> Any:
    runner = _runner()
    if runner is not None:
        try:
            return getattr(runner, name)
        except AttributeError:
            pass
    if name in globals():
        return globals()[name]
    return default


def _runner_error(message: str, exit_code: int = 2) -> Exception:
    error_cls = _attr("RunnerError", ValueError)
    try:
        return error_cls(message, exit_code)
    except TypeError:
        return error_cls(message)


def _bundled_module(name: str) -> Any:
    bundled = _attr("bundled_module")
    if callable(bundled):
        return bundled(name)
    import importlib.util

    module_path = Path(__file__).with_name(name + ".py")
    spec = importlib.util.spec_from_file_location("agent_executor_" + name, module_path)
    if spec is None or spec.loader is None:
        raise _runner_error(f"could not load bundled module {name!r}", 4)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def interrupt_process(
    process: subprocess.Popen[bytes], *, grace_seconds: float = STEER_INTERRUPT_GRACE_SECONDS
) -> None:
    """Stop an executor's process group gracefully: SIGINT, then SIGTERM, then SIGKILL.

    SIGINT is what an interactive user sends, so each CLI saves its session the way it would for a
    person pressing Ctrl-C; the later signals only apply when it does not exit within the grace period.
    """
    for signal_number in (signal.SIGINT, signal.SIGTERM):
        try:
            os.killpg(process.pid, signal_number)
        except ProcessLookupError:
            process.wait()
            return
        try:
            process.wait(timeout=grace_seconds)
            return
        except subprocess.TimeoutExpired:
            continue
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    process.wait()


class CodexCreditsWatch:
    """Stop a Codex run once its account starts spending credits, which the user has not allowed.

    Codex writes every rate-limit update into its session log (CODEX_HOME/sessions/.../rollout-*-<id>.jsonl).
    The watch follows that log from the moment the run started; quota.credit_spend decides what counts as
    spending. A stop interrupts the executor like a user's Ctrl-C and ends the run as stopped_credits.
    """

    def __init__(
        self,
        environment: dict[str, str],
        session_of: Any,
        *,
        check_seconds: float = CREDITS_CHECK_SECONDS,
        grace_seconds: float = CREDITS_WATCH_GRACE_SECONDS,
        max_blind_lines: int = CREDITS_WATCH_MAX_BLIND_LINES,
    ):
        self.sessions = Path(environment.get("CODEX_HOME") or Path.home() / ".codex").expanduser() / "sessions"
        self.session_of = session_of
        self.check_seconds = check_seconds
        self.give_up_at = time.monotonic() + grace_seconds
        self.max_blind_lines = max_blind_lines
        self.unavailable: str | None = None
        self.since = dt.datetime.now(dt.UTC)
        self.path: Path | None = None
        self.offset = 0
        self.lines_seen = 0
        self.previous: dict[str, Any] | None = None
        self.next_check = 0.0
        self.stopped: dict[str, Any] | None = None

    def _mark_unavailable(self, reason: str) -> None:
        if self.unavailable != reason:
            self.unavailable = reason
            _attr("emit_lifecycle")("credits_watch_unavailable", reason=reason)

    def poll(self, process: subprocess.Popen[bytes]) -> bool:
        """True when the run was stopped for spending credits."""
        if self.stopped is not None or time.monotonic() < self.next_check:
            return False
        self.next_check = time.monotonic() + self.check_seconds
        if self.path is None:
            session = self.session_of()
            found = sorted(self.sessions.glob(f"*/*/*/rollout-*-{session}.jsonl")) if session else []
            if not found:
                if self.unavailable is None and time.monotonic() >= self.give_up_at:
                    # Fail visibly: the run goes on, but nothing stops it from spending credits.
                    self._mark_unavailable(
                        "no session id" if not session else "no session log under " + str(self.sessions)
                    )
                return False
            self.path = found[-1]
            self.unavailable = None
        try:
            with self.path.open("rb") as handle:
                handle.seek(self.offset)
                chunk = handle.read()
        except OSError:
            return False
        whole = chunk[: chunk.rfind(b"\n") + 1]  # a line still being written is read next time
        self.offset += len(whole)
        text = whole.decode("utf-8", errors="replace")
        quota = _bundled_module("quota")
        records = quota.rollout_records(text, since=self.since)
        self.lines_seen += len(records)
        for snapshot in quota.rate_limit_snapshots(text, since=self.since, records=records):
            if not quota.valid_rate_limits(snapshot):
                if self.previous is None and self.unavailable is None:
                    self._mark_unavailable(
                        f"rate_limits in {self.path} lacks expected primary/secondary window and credits keys"
                    )
                continue
            self.unavailable = None
            reason = quota.credit_spend(self.previous, snapshot)
            self.previous = snapshot
            if reason is None:
                continue
            credits = snapshot.get("credits") if isinstance(snapshot.get("credits"), dict) else {}
            self.stopped = {
                "reason": reason,
                "scope": "account",
                "balance": credits.get("balance"),
                "detected_at": _attr("utc_now")(),
                "session_log": str(self.path),
            }
            _attr("emit_lifecycle")("credits_stop", reason=reason, balance=credits.get("balance"))
            _attr("interrupt_process")(process)
            return True
        if self.previous is None and self.unavailable is None and self.lines_seen >= self.max_blind_lines:
            self._mark_unavailable(f"session log {self.path} has no rate_limits snapshots")
        return False


def detached_runner_command(
    args: argparse.Namespace,
    *,
    repo: Path,
    brief_path: Path | None,
    task_spec_path: Path | None,
    run_dir: Path,
    event_path: Path,
    notification_mode: str,
    completion_hook: Path | None,
    job_dir: Path | None = None,
    allowed_paths_override: list[str] | None = None,
    conductor_model: str | None = None,
) -> list[str]:
    if (brief_path is None) == (task_spec_path is None):
        raise _runner_error("detached launch requires exactly one task input", 4)
    command = [
        sys.executable,
        str(Path(__file__).with_name("run_agent.py").resolve()),
        "--cwd",
        str(repo),
        "--engine",
        args.engine,
        "--transport",
        "executor",
        "--timeout",
        args.timeout,
        "--out-dir",
        str(run_dir),
        "--heartbeat-seconds",
        str(args.heartbeat_seconds),
        "--completion-event",
        str(event_path),
        "--notify",
        notification_mode,
        "--mailbox-run-id",
        _bundled_module("peer_mailbox").run_id_for(args.mailbox_run_id or event_path.stem),
    ]
    if task_spec_path is not None:
        command.extend(["--task-spec", str(task_spec_path)])
    else:
        command.extend(["--brief", str(brief_path)])
    if completion_hook is not None:
        command.extend(["--completion-hook", str(completion_hook)])
    if job_dir is not None:
        command.extend(["--steer-dir", str(job_dir)])
    if args.model:
        command.extend(["--model", args.model])
    if args.variant:
        command.extend(["--variant", args.variant])
    if args.effort:
        command.extend(["--effort", args.effort])
    if conductor_model or getattr(args, "conductor_model", None):
        command.extend(["--conductor-model", str(conductor_model or args.conductor_model)])
    command.extend(["--billing-mode", args.billing_mode])
    if args.deadline:
        command.extend(["--deadline", args.deadline])
    if args.resume_result:
        command.extend(["--resume-result", str(args.resume_result.expanduser().resolve())])
    if args.refresh_models:
        command.append("--refresh-models")
    if args.ignore_quota:
        command.append("--ignore-quota")
    if args.allow_credits:
        command.append("--allow-credits")
    if args.claude_config_dir:
        command.extend(["--claude-config-dir", str(args.claude_config_dir.expanduser())])
    for extra in args.add_dir:
        command.extend(["--add-dir", str(extra)])
    if task_spec_path is None:
        for allowed in allowed_paths_override if allowed_paths_override is not None else args.allow_path:
            command.extend(["--allow-path", allowed])
        for tracked in args.track_path:
            command.extend(["--track-path", tracked])
    for verification_command in args.verify_command:
        command.extend(["--verify-command", verification_command])
    command.extend(["--verify-timeout", args.verify_timeout])
    if getattr(args, "auto_correct", None) is not None:
        command.extend(["--auto-correct", str(args.auto_correct)])
    for protected in getattr(args, "protect_path", []):
        command.extend(["--protect-path", protected])
    if args.expect_changes:
        command.append("--expect-changes")
    if getattr(args, "expect_task_changes", False):
        command.append("--expect-task-changes")
    if args.retry_read_only:
        command.extend(["--retry-read-only", str(args.retry_read_only)])
    if args.session:
        command.extend(["--session", args.session])
    elif args.continue_last:
        command.append("--continue")
    return command


def launch_detached(args: argparse.Namespace) -> int:
    if args.brief == "-" or args.task_spec == "-":
        raise _runner_error("--detach requires a task input file instead of stdin", 4)
    if args.out_dir:
        raise _runner_error("--out-dir cannot be combined with --detach; use --job-dir", 4)
    if args.dry_run:
        raise _runner_error("--dry-run cannot be combined with --detach", 4)
    cwd = args.cwd.expanduser().resolve()
    if not cwd.is_dir():
        raise _runner_error(f"target directory does not exist: {cwd}", 4)
    repo = _attr("git_root")(cwd)
    if cwd != repo:
        raise _runner_error(f"--cwd must be the Git repository root: {repo}", 4)

    brief, task_spec = _attr("resolve_execution_brief")(args, repo=repo)
    _, add_dirs, allowed_paths, tracked_paths, enforced_paths, timeout_seconds, _ = _attr("validated_run_options")(
        args, task_spec=task_spec
    )
    # Check before detaching so the caller hears about an exhausted pool now, not in a completion event.
    # Fail before reporting "started": model and effort against the live catalog, the native-route rule,
    # quota, and whether another executor already holds this worktree.
    _executable, _version, _models, model, _reason, catalog = _attr("executor_preflight")(
        args.engine, args.model, refresh=args.refresh_models
    )
    brief, task_spec, allowed_paths, enforced_paths, scope_info = _attr("apply_upward_delegation_policy")(
        args,
        repo=repo,
        brief=brief,
        task_spec=task_spec,
        allowed_paths=allowed_paths,
        tracked_paths=tracked_paths,
        enforced_paths=enforced_paths,
        worker_model=model,
    )
    support = _bundled_module("execution_support")
    effort = args.effort
    try:
        support.bind_effort(args.engine, model, effort, catalog)
    except support.ContractError as error:
        raise _runner_error(str(error), 4) from error
    _attr("quota_gate")(
        args.engine,
        model,
        ignore=args.ignore_quota,
        claude_config_dir=args.claude_config_dir,
        allow_credits=args.allow_credits,
    )
    try:
        with support.workspace_lease(repo, _attr("default_agent_cache_dir")(), read_only=not enforced_paths):
            pass
    except support.ContractError as error:
        raise _runner_error(str(error), 27) from error
    event_dir = _attr("default_completion_event_dir")().resolve()
    if event_dir == repo or repo in event_dir.parents:
        raise _runner_error("the agent-executor cache must be outside the target repository", 4)
    job_dir = _attr("prepare_job_dir")(args.job_dir, repo)
    event_path = _attr("prepare_completion_event_path")()
    notification_mode = args.notify or "desktop"
    completion_hook = _attr("resolve_completion_hook")(args.completion_hook)
    _attr("ensure_hook_outside_workspaces")(completion_hook, [repo, *add_dirs])
    copied_brief_path: Path | None = None
    copied_task_spec_path: Path | None = None
    stdout_path = job_dir / "runner.stdout"
    stderr_path = job_dir / "runner.stderr"
    run_dir = job_dir / "run"
    result_path = run_dir / "result.json"
    mailbox_module = _bundled_module("peer_mailbox")
    mailbox_run_id = mailbox_module.run_id_for(args.mailbox_run_id or event_path.stem)
    mailbox_deadline = (
        args.deadline or (dt.datetime.now(dt.UTC) + dt.timedelta(seconds=timeout_seconds + 60)).isoformat()
    )
    mailbox_info = mailbox_module.open_run(
        mailbox_module.root(),
        mailbox_run_id,
        worker_harness=args.engine,
        repository=repo,
        result_path=result_path,
        deadline=mailbox_deadline,
        worker_pid=None,
    )
    if task_spec is not None:
        copied_task_spec_path = job_dir / "task-spec.json"
        _attr("write_json")(copied_task_spec_path, task_spec)
    else:
        copied_brief_path = job_dir / "brief.txt"
        _attr("write_private_text")(copied_brief_path, brief + "\n")
    command = _attr("detached_runner_command")(
        args,
        repo=repo,
        brief_path=copied_brief_path,
        task_spec_path=copied_task_spec_path,
        run_dir=run_dir,
        event_path=event_path,
        notification_mode=notification_mode,
        completion_hook=completion_hook,
        job_dir=job_dir,
        allowed_paths_override=allowed_paths if task_spec is None else None,
        conductor_model=scope_info.get("conductor_model"),
    )
    environment = dict(os.environ)
    environment["PWD"] = str(repo)
    open_bin = _attr("open_private_binary")
    with (
        open_bin(stdout_path) as stdout_handle,
        open_bin(stderr_path) as stderr_handle,
    ):
        process = subprocess.Popen(
            command,
            cwd=repo,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=stdout_handle,
            stderr=stderr_handle,
            start_new_session=True,
        )
    threading.Thread(target=process.wait, daemon=True).start()

    job = {
        "schema": "agent-executor.job.v1",
        "runner_version": _attr("RUNNER_VERSION", "unknown"),
        "status": "started",
        "pid": process.pid,
        "started_at": _attr("utc_now")(),
        "repository": str(repo),
        "engine": args.engine,
        "requested_model": args.model,
        "task_input": "task_spec" if task_spec is not None else "brief",
        "allowed_paths": enforced_paths,
        "tracked_paths": tracked_paths,
        "scope_owner": scope_info["scope_owner"],
        "conductor_model": scope_info["conductor_model"],
        "scope_hints": scope_info["scope_hints"],
        "job_dir": str(job_dir),
        "run_dir": str(run_dir),
        "result_path": str(result_path),
        "completion_event_path": str(event_path),
        "completion_event_id": event_path.stem,
        "notification_mode": notification_mode,
        "completion_hook": str(completion_hook) if completion_hook else None,
        # `steer` hands this job a new instruction through the runner (see steer_main).
        "steer_protocol": STEER_PROTOCOL,
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
        "command": _attr("command_preview")(command),
    }
    job_path = job_dir / "job.json"
    _attr("write_json")(job_path, job)
    print("AGENT_JOB_STATUS=started")
    print(f"AGENT_JOB_PID={process.pid}")
    print(f"AGENT_JOB={job_path}")
    print(f"AGENT_RESULT={result_path}")
    print(f"AGENT_EVENT={event_path}")
    print(f"AGENT_EVENT_ID={event_path.stem}")
    print(f"AGENT_MAILBOX={mailbox_info['conductor']}")
    return 0


def executor_session_so_far(engine: str, stdout_path: Path, log_path: Path) -> str | None:
    """The session ID a still-running (or just interrupted) executor has exposed, or None."""
    try:
        text = stdout_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    if engine == "codex":
        return _attr("parse_codex_session_id")(text)
    if engine == "claude":
        return _attr("parse_claude_output")(text)[1]
    if engine == "opencode":
        return _attr("parse_opencode_output")(text)[1]
    if engine == "agy":
        for event in _bundled_module("usage").agy_events(text):
            conversation = event.get("conversation_id")
            if isinstance(conversation, str) and conversation:
                return conversation
        return _attr("parse_agy_session_id")(log_path)
    return None


def steering_brief(
    message: str,
    *,
    steer_id: int,
    allowed_paths: list[str],
    verify_commands: list[str],
    expect_changes: bool,
    engine: str | None = None,
    added_allow_paths: list[str] | None = None,
) -> str:
    """The new user turn for a steered continuation: the conductor's message inside the unchanged contract."""
    scope = ", ".join(allowed_paths) if allowed_paths else "none; this is a read-only task, change no files"
    checks = "; ".join(verify_commands) if verify_commands else "none declared"
    scope_clause = (
        "This update also widens the repository paths you are authorized to change."
        if added_allow_paths
        else "This update\ncannot widen the scope or grant authority the original brief did not."
    )
    scope_bullet = (
        "- Paths you may change (widened in this update): . (worker-owned full repository scope, excluding .git)."
        if added_allow_paths and "." in allowed_paths
        else f"- Paths you may change (widened in this update): {scope}."
        if added_allow_paths
        else f"- Paths you may change: {scope}."
    )
    lines = [
        f"STEERING UPDATE {steer_id} FROM THE CONDUCTOR",
        "",
        "The conductor interrupted your previous turn to redirect this same task. This is a continuation,",
        "not a new task: the original brief and every constraint in it still apply, and your earlier",
        f"changes in the workspace remain. Do not undo them unless this update says so. {scope_clause}",
        "",
        "--- conductor's update ---",
        message.strip(),
        "--- end of update ---",
        "",
        "Unchanged from the original brief:",
        scope_bullet,
        f"- The runner runs these checks after your handoff: {checks}.",
    ]
    if expect_changes:
        lines.append("- The task must leave a net change inside those paths.")
    report_contract = _attr("REPORT_CONTRACT", "")
    agy_guardrail = _attr("AGY_ONESHOT_GUARDRAIL", "")
    contract = report_contract + (agy_guardrail if engine == "agy" else "")
    return "\n".join(lines) + f"\n\n{contract}\n"


class JobSteering:
    """Runner side of `steer`: the detached runner, which holds the worktree lease, performs the handoff.

    While the executor runs, the runner polls its job directory for a steer request. It claims the
    request by renaming it (so a withdrawn request and a claimed one never both happen), answers it,
    and, when it accepts, interrupts the executor and resumes the same session in the same process
    (or widens scope in-place without interrupting when `--allow-path` is given without `--message`
    or with `--no-interrupt`).
    The lease therefore never leaves this process, and no other runner can slip in between.
    """

    def __init__(self, job_dir: Path, *, engine: str, deadline: str | None) -> None:
        self.job_dir = job_dir
        self.engine = engine
        self.deadline = deadline
        self.state_path = job_dir / STEER_STATE_NAME
        self.pending: dict[str, Any] | None = None
        self.stdout_path: Path | None = None
        self.log_path: Path | None = None
        self.session_hint: str | None = None
        self.mailbox_run: str | None = None
        self.allowed_paths: list[str] = []
        self.tracked_paths: list[str] = []
        self.enforced_paths: list[str] = []
        self.live_steers: list[dict[str, Any]] = []
        self.state: dict[str, Any] = {
            "schema": STEER_STATE_SCHEMA,
            "protocol": STEER_PROTOCOL,
            "runner_pid": os.getpid(),
            "phase": "starting",
            "segment": 0,
            "executor_pid": None,
            "session_id": None,
            "result_path": None,
            "completion_event_path": None,
            "completion_event_id": None,
            "steers": [],
        }

    def save(self, **fields: Any) -> None:
        self.state.update(fields)
        self.state["updated_at"] = _attr("utc_now")()
        _attr("write_json_atomic")(self.state_path, self.state)

    def _update_job_allowed_paths(self, enforced_paths: list[str]) -> None:
        job_path = self.job_dir / "job.json"
        runner_error_cls = _attr("RunnerError", ValueError)
        with contextlib.suppress(runner_error_cls, OSError):
            job_payload = _attr("read_json_file")(job_path)
            if job_payload:
                job_payload["allowed_paths"] = list(enforced_paths)
                if "." in enforced_paths:
                    job_payload["scope_owner"] = "worker"
                _attr("write_json_atomic")(job_path, job_payload)

    def begin_segment(
        self,
        *,
        segment: int,
        result_path: Path,
        event_path: Path,
        stdout_path: Path,
        log_path: Path,
        session_hint: str | None,
    ) -> None:
        self.pending = None
        self.stdout_path, self.log_path, self.session_hint = stdout_path, log_path, session_hint
        self.save(
            phase="starting",
            segment=segment,
            executor_pid=None,
            session_id=session_hint,
            result_path=str(result_path),
            completion_event_path=str(event_path),
            completion_event_id=event_path.stem,
        )

    def executor_started(self, pid: int) -> None:
        self.save(phase="executor_running", executor_pid=pid)

    def current_session(self) -> str | None:
        assert self.stdout_path is not None and self.log_path is not None
        return _attr("executor_session_so_far")(self.engine, self.stdout_path, self.log_path) or self.session_hint

    def poll(self, process: subprocess.Popen[bytes]) -> bool:
        """Handle a pending steer request. True when the executor was interrupted for a continuation."""
        request_path = self.job_dir / STEER_REQUEST_NAME
        if self.pending is not None or not request_path.exists():
            return False
        try:
            request = json.loads(request_path.read_text(encoding="utf-8"))
            steer_id = int(request["steer_id"])
        except (OSError, ValueError, KeyError, TypeError):
            return False
        steer_dir = self.job_dir / "steers" / str(steer_id)
        if not steer_dir.is_dir():
            return False
        try:
            os.rename(request_path, steer_dir / "request.json")
        except FileNotFoundError:
            return False  # withdrawn by the steer command before we claimed it
        record = {
            "steer_id": steer_id,
            "segment": self.state["segment"],
            "requested_at": request.get("requested_at"),
            "message_path": str(steer_dir / "message.txt"),
            "message_sha256": request.get("message_sha256"),
        }

        def reject(reason: str) -> bool:
            response = {**record, "status": "rejected", "reason": reason, "responded_at": _attr("utc_now")()}
            _attr("write_json_atomic")(
                steer_dir / "response.json", {"schema": "agent-executor.steer-response.v1", **response}
            )
            self.state["steers"].append(response)
            self.save()
            _attr("emit_lifecycle")("steer_rejected", steer=steer_id)
            return False

        raw_allow = request.get("allow_paths") or []
        if not isinstance(raw_allow, list) or not all(isinstance(item, str) for item in raw_allow):
            return reject("invalid allow_paths in steer request")
        runner_error_cls = _attr("RunnerError", ValueError)
        try:
            extra_allow_paths = _attr("normalize_repo_paths")(list(raw_allow), option="--allow-path", allow_root=True)
        except runner_error_cls as exc:
            return reject(str(exc))
        no_interrupt = bool(request.get("no_interrupt"))

        try:
            message = (steer_dir / "message.txt").read_text(encoding="utf-8")
        except OSError:
            return reject("the steering message file is missing")
        if _attr("text_fingerprint")(message) != request.get("message_sha256"):
            return reject("the steering message does not match its request")
        if not message.strip() and not extra_allow_paths:
            return reject("the steering message is empty")
        if extra_allow_paths and not self.enforced_paths:
            return reject("cannot widen scope on a read-only job")
        remaining = _attr("deadline_remaining")(self.deadline)
        if remaining is not None and remaining <= 0:
            return reject("the task deadline has passed")

        widened_allowed = list(self.allowed_paths)
        widened_enforced = list(self.enforced_paths)
        if extra_allow_paths:
            for path in extra_allow_paths:
                if path not in widened_allowed:
                    widened_allowed.append(path)
            if "." in widened_allowed:
                widened_allowed = ["."]
            widened_enforced = list(dict.fromkeys([*widened_allowed, *self.tracked_paths]))

        if no_interrupt:
            self.allowed_paths = widened_allowed
            self.enforced_paths = widened_enforced
            self._update_job_allowed_paths(widened_enforced)
            session_id = self.current_session()
            accepted = {
                **record,
                "status": "accepted",
                "mode": "live_scope_update",
                "interrupted": False,
                "session_id": session_id,
                "added_allow_paths": extra_allow_paths,
                "allowed_paths": list(self.enforced_paths),
                "previous_event_id": self.state["completion_event_id"],
                "previous_result_path": self.state["result_path"],
                "event_id": self.state["completion_event_id"],
                "event_path": self.state["completion_event_path"],
                "run_dir": str(Path(str(self.state["result_path"])).parent),
                "result_path": self.state["result_path"],
                "accepted_at": _attr("utc_now")(),
            }
            _attr("write_json_atomic")(
                steer_dir / "response.json", {"schema": "agent-executor.steer-response.v1", **accepted}
            )
            _attr("emit_lifecycle")("steer_scope_widened", steer=steer_id, allowed_paths=",".join(self.enforced_paths))
            self.state["steers"].append(accepted)
            self.live_steers.append(accepted)
            self.save(allowed_paths=list(self.enforced_paths))
            return False

        session_id = self.current_session()
        if not session_id:
            return reject(
                f"the {self.engine} executor has not exposed a session ID yet, so its context cannot be "
                "resumed. Retry shortly; if no session ID ever appears, stop the job and relaunch with "
                "the new instruction in the brief (the executor's context is lost)"
            )
        if extra_allow_paths:
            self.allowed_paths = widened_allowed
            self.enforced_paths = widened_enforced
            self._update_job_allowed_paths(widened_enforced)
        event_path = _attr("prepare_completion_event_path")()
        if self.mailbox_run:
            # Waiting on the new event finds the run's mail before that event exists.
            mailbox = _bundled_module("peer_mailbox")
            mailbox.alias_event(mailbox.root(), event_path.stem, self.mailbox_run)
        run_dir = steer_dir / "run"
        run_dir.mkdir(mode=0o700)
        accepted = {
            **record,
            "status": "accepted",
            "mode": "interrupt_and_resume",
            "interrupted": True,
            "session_id": session_id,
            "added_allow_paths": extra_allow_paths,
            "allowed_paths": list(self.enforced_paths),
            "previous_event_id": self.state["completion_event_id"],
            "previous_result_path": self.state["result_path"],
            "event_id": event_path.stem,
            "event_path": str(event_path),
            "run_dir": str(run_dir),
            "result_path": str(run_dir / "result.json"),
            "accepted_at": _attr("utc_now")(),
        }
        _attr("write_json_atomic")(
            steer_dir / "response.json", {"schema": "agent-executor.steer-response.v1", **accepted}
        )
        _attr("emit_lifecycle")("steer_accepted", steer=steer_id, session=session_id)
        _attr("interrupt_process")(process)
        accepted["interrupted_at"] = _attr("utc_now")()
        accepted["interrupted_executor_exit_code"] = process.returncode
        self.state["steers"].append(accepted)
        self.save(phase="steering", executor_pid=None, allowed_paths=list(self.enforced_paths))
        self.pending = {**accepted, "message": message}
        return True


def parse_steer_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=f"{Path(sys.argv[0]).name} steer",
        description=(
            "Redirect a running detached job or widen its allowed scope mid-run: its runner interrupts "
            "the executor and resumes the same session with a new instruction (or widens allowed_paths "
            "in-place without interrupting when --allow-path is given without --message)."
        ),
    )
    parser.add_argument(
        "job",
        metavar="JOB_OR_EVENT",
        help="The job directory, its job.json, or the job's exact event ID or AGENT_EVENT path",
    )
    parser.add_argument(
        "--message",
        help="The new instruction, or @FILE to read it from a file (required unless --allow-path is given)",
    )
    parser.add_argument(
        "--allow-path",
        action="append",
        default=[],
        help=(
            "Widen the running job's allowed scope with an additional repository-relative file or "
            "directory prefix (or '.' for full repository scope); repeatable"
        ),
    )
    parser.add_argument(
        "--no-interrupt",
        action="store_true",
        help=(
            "With --allow-path, widen the running job's allowed scope in-place without interrupting "
            "the running executor process (default when --message is omitted)"
        ),
    )
    parser.add_argument("--cwd", type=Path, help="Refuse unless the job runs in this Git repository")
    parser.add_argument(
        "--wait-timeout",
        default=DEFAULT_STEER_WAIT_TIMEOUT,
        help=f"How long to wait for the runner to take the request (default: {DEFAULT_STEER_WAIT_TIMEOUT})",
    )
    parser.add_argument("--format", choices=("table", "json"), default="table", help="Output format")
    return parser.parse_args(argv)


def read_steer_message(value: str) -> str:
    if value.startswith("@"):
        try:
            message = Path(value[1:]).expanduser().read_text(encoding="utf-8")
        except OSError as error:
            raise _runner_error(f"could not read the steering message: {error}", 4) from error
    else:
        message = value
    if not message.strip():
        raise _runner_error("the steering message is empty", 4)
    max_bytes = _attr("STEER_MESSAGE_MAX_BYTES", STEER_MESSAGE_MAX_BYTES)
    if len(message.encode("utf-8")) > max_bytes:
        raise _runner_error(f"the steering message exceeds {max_bytes // 1024} KiB", 4)
    return message


def read_json_file(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise _runner_error(f"could not read {path}: {error}", 4) from error
    return payload if isinstance(payload, dict) else {}


def find_steerable_job_dir(reference: str) -> Path:
    value = reference.strip()
    candidate = Path(value).expanduser()
    if candidate.is_dir() and (candidate / "job.json").is_file():
        return candidate.resolve()
    if candidate.name == "job.json" and candidate.is_file():
        return candidate.parent.resolve()
    event_id: str | None = None
    if re.fullmatch(r"[0-9a-fA-F]{32}", value):
        event_id = value.lower()
    elif candidate.suffix == ".json" and re.fullmatch(r"[0-9a-fA-F]{32}", candidate.stem):
        event_id = candidate.stem.lower()
    if event_id is None:
        raise _runner_error("steer needs a job directory, its job.json, or an exact event ID or AGENT_EVENT path", 4)
    runner_error_cls = _attr("RunnerError", ValueError)
    read_json = _attr("read_json_file")
    for job_path in sorted((_attr("default_agent_cache_dir")() / "jobs-v1").glob("*/job.json")):
        try:
            job = read_json(job_path)
            state = read_json(job_path.parent / STEER_STATE_NAME)
        except runner_error_cls:
            continue
        event_ids = {job.get("completion_event_id")}
        event_ids.update(steer.get("event_id") for steer in state.get("steers", []) if isinstance(steer, dict))
        if event_id in event_ids:
            return job_path.parent.resolve()
    raise _runner_error(f"no detached job found for event {event_id}", 4)


def runner_process_alive(pid: Any, original_event_path: str) -> bool:
    """True only when `pid` is still this job's runner: alive, and started with the job's event path."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    try:
        listing = subprocess.run(
            ["ps", "-ww", "-o", "command=", "-p", str(pid)],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    # A reused PID belongs to some other command line.
    return listing.returncode == 0 and original_event_path in listing.stdout


def steer_job_finished(job: dict[str, Any], state: dict[str, Any]) -> bool:
    current_event = state.get("completion_event_path") or job.get("completion_event_path")
    return bool(current_event and Path(current_event).exists()) or state.get("phase") in ("auditing", "finished")


def steer_finished_error(job: dict[str, Any], state: dict[str, Any]) -> Exception:
    result_path = Path(state.get("result_path") or job.get("result_path") or "")
    session = None
    runner_error_cls = _attr("RunnerError", ValueError)
    with contextlib.suppress(runner_error_cls):
        session = _attr("read_json_file")(result_path).get("session_id")
    handoff = (
        "the executor already handed off and the runner is auditing it; wait for the event, then "
        if state.get("phase") == "auditing" and not Path(state.get("completion_event_path") or "/").exists()
        else "the job already finished; review it, then "
    )
    return _runner_error(
        "nothing to steer: " + handoff + "send a correction as a new run on the same session: "
        f"run_agent.py --cwd {job.get('repository')} --session {session or '<session_id from result.json>'} "
        f"--resume-result {result_path} with the job's original engine, model, effort, scope and "
        "--verify-command flags",
        _attr("EXIT_STEER_JOB_FINISHED", EXIT_STEER_JOB_FINISHED),
    )


def wait_for_steer_response(
    *, job_dir: Path, steer_dir: Path, job: dict[str, Any], wait_seconds: float
) -> dict[str, Any]:
    request_path = job_dir / STEER_REQUEST_NAME
    response_path = steer_dir / "response.json"
    deadline = time.monotonic() + wait_seconds
    read_json = _attr("read_json_file")
    finished_fn = _attr("steer_job_finished")
    alive_fn = _attr("runner_process_alive")
    iteration = 0
    alive = True
    while True:
        if response_path.exists():
            return read_json(response_path)
        state = read_json(job_dir / STEER_STATE_NAME)
        finished = finished_fn(job, state)
        expired = time.monotonic() >= deadline
        if iteration % 5 == 0 or expired or finished or not request_path.exists():
            alive = alive_fn(job.get("pid"), str(job.get("completion_event_path")))
        iteration += 1
        if request_path.exists():
            if not (expired or finished or not alive):
                time.sleep(0.2)
                continue
            try:
                os.rename(request_path, steer_dir / "withdrawn.json")
            except FileNotFoundError:
                continue  # the runner claimed it at this instant; its answer follows
            if finished:
                raise _attr("steer_finished_error")(job, state)
            if not alive:
                raise _runner_error(
                    "the job's runner exited before taking the steer request",
                    _attr("EXIT_STEER_PROCESS_NOT_FOUND", EXIT_STEER_PROCESS_NOT_FOUND),
                )
            raise _runner_error(
                "the runner did not take the steer request in time. It takes requests only while the "
                "executor runs, not between retry attempts or during verification; the request was withdrawn",
                _attr("EXIT_STEER_REJECTED", EXIT_STEER_REJECTED),
            )
        # Claimed: the runner answers before it interrupts anything.
        if not alive:
            raise _runner_error(
                "the job's runner exited after claiming the steer request without answering",
                _attr("EXIT_STEER_PROCESS_NOT_FOUND", EXIT_STEER_PROCESS_NOT_FOUND),
            )
        if time.monotonic() >= deadline + 60:
            raise _runner_error(
                f"the runner claimed the steer request but did not answer; see {steer_dir}",
                _attr("EXIT_STEER_REJECTED", EXIT_STEER_REJECTED),
            )
        time.sleep(0.2)


def steer_main(argv: list[str] | None = None) -> int:
    args = _attr("parse_steer_args")(argv)
    extra_allow_paths = (
        _attr("normalize_repo_paths")(args.allow_path, option="--allow-path", allow_root=True)
        if args.allow_path
        else []
    )
    if args.no_interrupt and args.message is not None:
        raise _runner_error(
            "--no-interrupt cannot be combined with --message; omit --no-interrupt to interrupt and deliver "
            "the message, or send an advisory note over the peer mailbox",
            4,
        )
    if args.no_interrupt and not extra_allow_paths:
        raise _runner_error("--no-interrupt requires at least one --allow-path", 4)
    if args.message is None and not extra_allow_paths:
        raise _runner_error("steer requires --message and/or at least one --allow-path", 4)
    message = _attr("read_steer_message")(args.message) if args.message is not None else ""
    wait_seconds = _attr("parse_duration")(args.wait_timeout, option="--wait-timeout")
    job_dir = _attr("find_steerable_job_dir")(args.job)
    job_path = job_dir / "job.json"
    read_json = _attr("read_json_file")
    job = read_json(job_path)
    if job.get("schema") != "agent-executor.job.v1":
        raise _runner_error(f"not a detached agent-executor job: {job_path}", 4)
    repository = Path(str(job.get("repository"))).resolve()
    if args.cwd is not None:
        cwd = args.cwd.expanduser().resolve()
        if not cwd.is_dir():
            raise _runner_error(f"target directory does not exist: {cwd}", 4)
        git_root_fn = _attr("git_root")
        if git_root_fn(cwd) != repository:
            raise _runner_error(
                f"the job runs in {repository}, not {git_root_fn(cwd)}; steer it from its own worktree",
                _attr("EXIT_STEER_OTHER_WORKTREE", EXIT_STEER_OTHER_WORKTREE),
            )
    state = read_json(job_dir / STEER_STATE_NAME)
    if _attr("steer_job_finished")(job, state):
        raise _attr("steer_finished_error")(job, state)
    if job.get("steer_protocol") != _attr("STEER_PROTOCOL", STEER_PROTOCOL):
        raise _runner_error(
            f"this job was launched by agent-executor {job.get('runner_version')}, which cannot be steered; "
            "wait for it, or stop it and relaunch",
            _attr("EXIT_STEER_REJECTED", EXIT_STEER_REJECTED),
        )
    if extra_allow_paths and not job.get("allowed_paths"):
        raise _runner_error(
            "cannot widen scope on a read-only job (it holds a shared reader lease); relaunch with --allow-path",
            _attr("EXIT_STEER_REJECTED", EXIT_STEER_REJECTED),
        )
    original_event = str(job.get("completion_event_path"))
    if not _attr("runner_process_alive")(job.get("pid"), original_event):
        state = read_json(job_dir / STEER_STATE_NAME)
        if _attr("steer_job_finished")(job, state):
            raise _attr("steer_finished_error")(job, state)
        raise _runner_error(
            f"the job's runner process (pid {job.get('pid')}) is not running and no completion event exists. "
            "The job died without reporting: inspect its job directory, then relaunch (or resume with "
            f"--session if its stdout names one): {job_dir}",
            _attr("EXIT_STEER_PROCESS_NOT_FOUND", EXIT_STEER_PROCESS_NOT_FOUND),
        )
    if fcntl is None:
        raise _runner_error("steering requires POSIX flock on this platform", 4)
    lock = os.open(job_dir / "steer.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise _runner_error(
                "another steer of this job is in progress", _attr("EXIT_STEER_REJECTED", EXIT_STEER_REJECTED)
            ) from error
        steers_root = job_dir / "steers"
        steers_root.mkdir(mode=0o700, exist_ok=True)
        request_path = job_dir / STEER_REQUEST_NAME
        if request_path.exists():
            # Left by a steer command that died before it was answered or withdrew.
            stale = read_json(request_path)
            stale_dir = steers_root / str(stale.get("steer_id"))
            with contextlib.suppress(FileNotFoundError):
                os.rename(request_path, (stale_dir if stale_dir.is_dir() else job_dir) / "withdrawn.json")
        steer_id = 1 + max((int(entry.name) for entry in steers_root.iterdir() if entry.name.isdigit()), default=0)
        steer_dir = steers_root / str(steer_id)
        steer_dir.mkdir(mode=0o700)
        _attr("write_private_text")(steer_dir / "message.txt", message)
        _attr("write_json_atomic")(
            request_path,
            {
                "schema": STEER_REQUEST_SCHEMA,
                "steer_id": steer_id,
                "message_sha256": _attr("text_fingerprint")(message),
                "allow_paths": extra_allow_paths,
                "no_interrupt": bool(args.no_interrupt or not message),
                "requested_at": _attr("utc_now")(),
                "requested_by_pid": os.getpid(),
            },
        )
        response = _attr("wait_for_steer_response")(
            job_dir=job_dir, steer_dir=steer_dir, job=job, wait_seconds=wait_seconds
        )
    finally:
        os.close(lock)
    if response.get("status") != "accepted":
        raise _runner_error(
            f"steer rejected: {response.get('reason') or 'no reason given'}",
            _attr("EXIT_STEER_REJECTED", EXIT_STEER_REJECTED),
        )
    if args.format == "json":
        print(json.dumps({**response, "job_path": str(job_path)}, indent=2, ensure_ascii=True))
        return 0
    print("AGENT_STEER_STATUS=accepted")
    print(f"AGENT_STEER_ID={response['steer_id']}")
    if response.get("mode"):
        print(f"AGENT_STEER_MODE={response['mode']}")
    if response.get("session_id"):
        print(f"AGENT_SESSION={response['session_id']}")
    if response.get("allowed_paths") is not None:
        print(f"AGENT_ALLOWED_PATHS={','.join(response['allowed_paths'])}")
    print(f"AGENT_JOB={job_path}")
    print(f"AGENT_STEERED_FROM={response['previous_event_id']}")
    print(f"AGENT_RESULT={response['result_path']}")
    print(f"AGENT_EVENT={response['event_path']}")
    print(f"AGENT_EVENT_ID={response['event_id']}")
    return 0
