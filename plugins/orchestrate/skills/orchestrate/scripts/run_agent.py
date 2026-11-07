#!/usr/bin/env python3
"""Run one bounded external-agent delegation and retain structured evidence."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import difflib
import functools
import hashlib
import importlib.util
import json
import math
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows falls back to atomic replacement.
    fcntl = None  # type: ignore[assignment]


def skill_version(skill_file: Path) -> str:
    """`metadata.version` from SKILL.md's frontmatter, which the release workflow writes.

    SKILL.md is the one versioned file every install has: the plugin cache, and the skill directory
    linked on its own into ~/.agents/skills. Copies without it, such as the mailbox daemon's runtime,
    report "unknown".
    """
    try:
        text = skill_file.read_text(encoding="utf-8")
    except OSError:
        return "unknown"
    if not text.startswith("---\n"):
        return "unknown"
    in_metadata = False
    for line in text[4:].split("\n"):
        if line.startswith("---"):
            break
        if line[:1].strip():
            in_metadata = line.startswith("metadata:")
        elif in_metadata and line.strip().startswith("version:"):
            return line.split(":", 1)[1].strip() or "unknown"
    return "unknown"


DEFAULT_ENGINE = "codex"
EXECUTION_ENGINES = ("codex", "agy", "opencode", "claude")
CATALOG_ENGINES = EXECUTION_ENGINES
# Last-resort defaults when no route covers an engine. Family selectors (scripts/families.py) resolve to
# the newest live ID, so none of these needs an edit when a model ships.
PREFERRED_MODELS = {
    "codex": "gpt:luna",
    "agy": "gemini:fast",
    "opencode": "glm:flash",
    "claude": "opus",
}
# Claude Code has no model-list command. Its aliases resolve to the current model of each tier; exact
# `claude-*` IDs are passed through and recorded as unverified.
CLAUDE_MODEL_ALIASES = ("opus", "sonnet", "haiku", "fable", "claude-mythos-5-1")
CLAUDE_MODEL_ID = re.compile(r"^claude-[a-z0-9][a-z0-9.\-]*(\[1m\])?$")
# Host session state that must not leak into an executor: harness session IDs, control endpoints,
# messaging tokens, and the host's account profile (an executor could otherwise act inside, or bill to,
# the host session).
HOST_SESSION_ENV = re.compile(
    r"^(CLAUDECODE|CLAUDE_CODE_(?!OAUTH_TOKEN$|USE_BEDROCK$|USE_VERTEX$).*|CLAUDE_CONFIG_DIR|CLAUDE_PID|AI_AGENT"
    r"|CODEX_SANDBOX|CODEX_SANDBOX_.*|CODEX_THREAD_ID|CODEX_MANAGED_BY_NPM|CODEX_CI"
    r"|OPENCODE|OPENCODE_SESSION|OPENCODE_SESSION_ID"
    r"|ANTIGRAVITY|ANTIGRAVITY_.*|GEMINI_CLI"
    r"|ORKEST_SWARM_ROOM|ORKEST_TERMINAL_SERVER|ORKEST_TERMINAL_HARNESS"
    r"|TMUX|TMUX_PANE|HERDR_ENV|HERDR_PANE_ID|HERDR_WORKSPACE_ID)$"
)
# Provider error messages that mean the account is out of quota or credits, not that the task failed.
# They are matched only against provider error channels (stderr, structured CLI error fields), never
# against the model's content or tool output, and they are anchored: a bare "quota" or "rate limit"
# is ordinary vocabulary in code and docs.
PROVIDER_QUOTA_PATTERNS = re.compile(
    r"\bresource_exhausted\b"
    r"|\b(?:http|status|code|error|api error)\s*[:=(]?\s*429\b"
    r"|\b429\s+too many requests\b"
    r"|\b(?:insufficient_quota|rate_limit_error|rate_limit_exceeded|usage_limit_reached|quota_exceeded)\b"
    r"|\bquota (?:exceeded|exhausted)\b|\bexceeded your current quota\b"
    r"|\brate limit (?:reached|exceeded|hit)\b"
    r"|\busage limit (?:reached|exceeded)\b|\bhit your (?:usage )?limit\b|\breached your usage limit\b"
    r"|\binsufficient credits\b|\bcredit balance is too low\b|\bout of credits\b",
    re.IGNORECASE,
)
# Claude Code's structured assistant error kinds that mean quota or billing, not a task failure.
CLAUDE_QUOTA_ERROR_KINDS = frozenset({"rate_limit", "billing_error"})
EXIT_PROVIDER_QUOTA = 16
EXIT_ROUTE_NOT_ALLOWED = 17
# Codex credits are billed to the user's balance: refused at launch and stopped mid-run unless allowed.
EXIT_POOL_ON_CREDITS = 18
EXIT_STOPPED_CREDITS = 19
CREDITS_CHECK_SECONDS = 5.0
# Without a session log after 120 s, or after 150 post-start rollout records with no usable rate_limits,
# the credits watch says it cannot protect the run.
CREDITS_WATCH_GRACE_SECONDS = 120.0
CREDITS_WATCH_MAX_BLIND_LINES = 150

DEFAULT_OPENCODE_VARIANT = "high"
OPENCODE_RUNTIME_CONFIG = {
    "permission": "allow",
    "agent": {"build": {"permission": "allow"}},
    "share": "disabled",
    "autoupdate": False,
}
DEFAULT_TIMEOUT = "15m"
DEFAULT_VERIFY_TIMEOUT = "10m"
DEFAULT_HEARTBEAT_SECONDS = 0.0
DEFAULT_EVENT_WAIT_TIMEOUT = "30m"
DEFAULT_EVENT_POLL_SECONDS = 0.5
DEFAULT_CATALOG_MAX_AGE_SECONDS = 24 * 60 * 60
MAX_FINAL_MESSAGE_CHARS = 4000
MAX_COMPLETION_SIGNAL_ERROR_CHARS = 500
MAX_VERIFICATION_TAIL_BYTES = 64 * 1024
MAX_VERIFICATION_TAIL_LINE_CHARS = 500
RUNNER_VERSION = skill_version(Path(__file__).resolve().parents[1] / "SKILL.md")
RESULT_SCHEMA = "agent-executor.result.v2"
MODEL_CATALOG_SCHEMA = "agent-executor.models.v1"
MODEL_CACHE_SCHEMA = "agent-executor.model-cache.v1"
COMPLETION_EVENT_SCHEMA = "agent-executor.completion.v1"
COMPLETION_LIST_SCHEMA = "agent-executor.completion-list.v1"
COMPLETION_SIGNAL_SCHEMA = "agent-executor.completion-signal.v1"
NOTIFICATION_MODES = ("none", "desktop")
# Steering a running detached job: the runner that holds the worktree lease performs the handoff.
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


# A correction round that broke down (no usable handoff) ends the run as its last handoff did. Any other
# round status stands: the gates' verdict, BLOCKED, no net change, or an audit violation.
CONVERTED_ROUND_STATUSES = frozenset({"failed", "timed_out", "malformed_report", "empty_output", "stopped_credits"})


class RunnerError(Exception):
    def __init__(self, message: str, exit_code: int = 2) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class _RunnerNamespaceProxy:
    def __getattr__(self, attr: str) -> Any:
        try:
            return globals()[attr]
        except KeyError as exc:
            raise AttributeError(attr) from exc


_RUNNER_PROXY = _RunnerNamespaceProxy()


@functools.cache
def bundled_module(name: str) -> Any:
    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    renderer_path = Path(__file__).with_name(name + ".py")
    spec = importlib.util.spec_from_file_location("agent_executor_" + name, renderer_path)
    if spec is None or spec.loader is None:
        raise RunnerError("could not load the bundled task-spec renderer", 4)
    module = importlib.util.module_from_spec(spec)
    runner_mod = sys.modules.get(__name__) or _RUNNER_PROXY
    module._runner_module = runner_mod  # type: ignore[attr-defined]
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    module._runner_module = sys.modules.get(__name__) or _RUNNER_PROXY  # type: ignore[attr-defined]
    return module


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="Subcommands: consult, mailbox, events, steer, listen, probe, horde, models, routes, families, "
        "quota, doctor, prune, init (run `<subcommand> --help`). "
        "Peer communication: mailbox peers lists task/model/harness labels; mailbox focus sets your actual "
        "task and optional verified model/host metadata. mailbox send --to SESSION --message TEXT sends; "
        "--text and --body are aliases. mailbox wait --reply-to MESSAGE_ID --timeout 300 blocks locally "
        "without model polling. mailbox feedback records friction. Run mailbox --help for details.",
    )
    parser.add_argument("--cwd", type=Path, default=Path.cwd(), help="Target Git repository root")
    task_input = parser.add_mutually_exclusive_group(required=True)
    task_input.add_argument("--brief", help="Handwritten Markdown brief file path, or '-' to read stdin")
    task_input.add_argument(
        "--task-spec",
        help=("Compact JSON task spec file, or '-' to read stdin. Its repository_root and scope are authoritative."),
    )
    parser.add_argument(
        "--route",
        help="Role from the route config (implementation, consultation, gemini, claude, opencode, or your "
        "own): fills in engine, model and effort. Explicit --engine/--model/--effort still win",
    )
    parser.add_argument(
        "--engine",
        choices=EXECUTION_ENGINES,
        help="Local executor CLI (default: the --route's engine, else codex)",
    )
    parser.add_argument(
        "--host", choices=EXECUTION_ENGINES, help="Calling harness; otherwise detected from its environment"
    )
    parser.add_argument(
        "--transport",
        choices=("auto", "native", "executor"),
        default="auto",
        help="Use native tools for a fresh same-harness task, or explicitly select an isolated CLI executor",
    )
    parser.add_argument(
        "--model",
        help=(
            "Exact live model ID, or a family selector (`gpt:sol`, `deepseek`) that resolves to the newest "
            "live ID; see `families`. An omitted value uses the route's model"
        ),
    )
    parser.add_argument(
        "--refresh-models",
        action="store_true",
        help="Bypass the model cache before execution",
    )
    parser.add_argument(
        "--claude-config-dir",
        type=Path,
        help="Claude account profile (CLAUDE_CONFIG_DIR) for --engine claude; default is Claude Code's default "
        "profile. Choosing an account chooses its billing: follow the user's rules",
    )
    parser.add_argument(
        "--ignore-quota",
        action="store_true",
        help="Launch even when monitor reports the route's subscription quota as exhausted",
    )
    parser.add_argument(
        "--allow-credits",
        action="store_true",
        help="Let a Codex run bill the account's credit balance once its included quota is used up. "
        "Only when the user allows spending credits",
    )
    parser.add_argument(
        "--variant",
        help="OpenCode model variant (default: high); invalid for other engines",
    )
    parser.add_argument("--effort", help="Catalog-validated Codex effort or AGY model-slug effort")
    parser.add_argument(
        "--billing-mode",
        choices=("unknown", "subscription", "personal_subscription", "api"),
        default="unknown",
        help="Declared billing context; never inferred from credentials",
    )
    parser.add_argument(
        "--conductor-model",
        help=(
            "Calling conductor model ID or selector (auto-detected from the environment or "
            "peer mailbox when omitted); used to widen mutating scope to worker-owned '.' on "
            "lower-to-higher capability delegation"
        ),
    )
    parser.add_argument(
        "--resume-result",
        type=Path,
        help="Previous result.json for exact-session correction and cumulative usage baseline",
    )
    parser.add_argument(
        "--timeout",
        default=DEFAULT_TIMEOUT,
        help="Outer executor duration such as 15m or 1h",
    )
    parser.add_argument("--deadline", help="Optional task-wide ISO-8601 deadline with timezone")
    parser.add_argument(
        "--verify-command",
        action="append",
        default=[],
        help=(
            "Non-mutating POSIX-shell command run by the runner after a clean "
            "executor handoff; repeatable and fail-fast"
        ),
    )
    parser.add_argument(
        "--verify-timeout",
        default=DEFAULT_VERIFY_TIMEOUT,
        help="Per-command post-verification timeout such as 10m or 1h",
    )
    parser.add_argument(
        "--auto-correct",
        type=int,
        metavar="ROUNDS",
        help=(
            "When a --verify-command gate fails, resume the same session up to ROUNDS times (0-2) with the "
            "failure and re-run the gates. Default: the task spec's auto_correct, else 0"
        ),
    )
    parser.add_argument(
        "--add-dir",
        action="append",
        default=[],
        type=Path,
        help="Additional workspace directory; repeatable",
    )
    parser.add_argument(
        "--allow-path",
        action="append",
        default=[],
        help="Repository-relative file or directory prefix the executor may change; repeatable",
    )
    parser.add_argument(
        "--track-path",
        action="append",
        default=[],
        help="Repository-relative ignored or generated deliverable to fingerprint; repeatable and implicitly allowed",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        help="Artifact directory; defaults outside the repository",
    )
    parser.add_argument(
        "--detach",
        action="store_true",
        help="Launch a private background job and return without polling it",
    )
    parser.add_argument(
        "--job-dir",
        type=Path,
        help="Detached-job directory; valid only with --detach and created exclusively",
    )
    parser.add_argument(
        "--notify",
        choices=NOTIFICATION_MODES,
        help="Detached completion notification (default: desktop; the event inbox is always written)",
    )
    parser.add_argument(
        "--completion-hook",
        type=Path,
        help="Trusted executable called once with the completion-event path; detached jobs only",
    )
    parser.add_argument(
        "--completion-event",
        type=Path,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--steer-dir",
        type=Path,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--mailbox-run-id", help=argparse.SUPPRESS)
    parser.add_argument(
        "--expect-changes",
        action="store_true",
        help="Fail when the Git worktree has no net content change",
    )
    parser.add_argument(
        "--retry-read-only",
        type=int,
        default=0,
        metavar="COUNT",
        help=(
            "Retry a transient provider failure at most COUNT times. Valid only for a "
            "read-only run with empty scope (maximum 3)."
        ),
    )
    parser.add_argument(
        "--heartbeat-seconds",
        type=float,
        default=DEFAULT_HEARTBEAT_SECONDS,
        help="Print elapsed-time progress while the executor runs; disabled by default",
    )
    session = parser.add_mutually_exclusive_group()
    session.add_argument("--session", help="Resume a specific executor session ID")
    session.add_argument(
        "--continue",
        dest="continue_last",
        action="store_true",
        help="Resume the most recent executor session (discouraged; prefer --session)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and print the command without calling the model",
    )
    return parser.parse_args(argv)


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat()


def parse_duration(value: str, *, option: str = "--timeout") -> float:
    units = {"d": 86400, "h": 3600, "m": 60, "s": 1}
    position = 0
    seconds = 0.0
    for match in re.finditer(r"(\d+(?:\.\d+)?)(d|h|m|s)", value):
        if match.start() != position:
            raise RunnerError(f"invalid {option}: {value!r}")
        seconds += float(match.group(1)) * units[match.group(2)]
        position = match.end()
    if position != len(value) or seconds <= 0:
        raise RunnerError(f"invalid {option}: {value!r}")
    return seconds


def deadline_remaining(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        deadline = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if deadline.tzinfo is None:
            raise ValueError("timezone required")
        return (deadline - dt.datetime.now(dt.UTC)).total_seconds()
    except ValueError as exc:
        raise RunnerError("--deadline must be an ISO-8601 timestamp with timezone", 4) from exc


def run_checked(
    command: list[str],
    *,
    cwd: Path | None = None,
    timeout: float = 30,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RunnerError(f"command timed out during preflight: {command[0]}", 12) from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RunnerError(
            f"preflight command failed ({result.returncode}): {' '.join(command)}\n{detail}",
            11,
        )
    return result


def default_agent_cache_dir() -> Path:
    return bundled_module("runtime_paths").cache_home()


_MODEL_ROUTING_MOD = bundled_module("model_routing")
parse_models_args = _MODEL_ROUTING_MOD.parse_models_args
cli_version = _MODEL_ROUTING_MOD.cli_version
normalized_option_values = _MODEL_ROUTING_MOD.normalized_option_values
normalized_codex_model = _MODEL_ROUTING_MOD.normalized_codex_model
read_json_rpc_response = _MODEL_ROUTING_MOD.read_json_rpc_response
codex_model_records = _MODEL_ROUTING_MOD.codex_model_records
simple_model_records = _MODEL_ROUTING_MOD.simple_model_records
discover_live_engine_catalog = _MODEL_ROUTING_MOD.discover_live_engine_catalog
default_model_cache_path = _MODEL_ROUTING_MOD.default_model_cache_path
read_model_cache = _MODEL_ROUTING_MOD.read_model_cache
write_model_cache = _MODEL_ROUTING_MOD.write_model_cache
default_cli_version_cache_path = _MODEL_ROUTING_MOD.default_cli_version_cache_path
_stat_executable = _MODEL_ROUTING_MOD._stat_executable
read_cli_version_cache = _MODEL_ROUTING_MOD.read_cli_version_cache
write_cli_version_cache = _MODEL_ROUTING_MOD.write_cli_version_cache
_extract_cached_cli_version = _MODEL_ROUTING_MOD._extract_cached_cli_version
_build_cli_version_entry = _MODEL_ROUTING_MOD._build_cli_version_entry
get_cached_cli_version = _MODEL_ROUTING_MOD.get_cached_cli_version
record_cli_version = _MODEL_ROUTING_MOD.record_cli_version
opencode_major_version = _MODEL_ROUTING_MOD.opencode_major_version
cached_catalog_entry = _MODEL_ROUTING_MOD.cached_catalog_entry
store_catalog_in_cache = _MODEL_ROUTING_MOD.store_catalog_in_cache
discover_engine_catalog = _MODEL_ROUTING_MOD.discover_engine_catalog
filtered_catalog = _MODEL_ROUTING_MOD.filtered_catalog
matching_catalog = _MODEL_ROUTING_MOD.matching_catalog
markdown_cell = _MODEL_ROUTING_MOD.markdown_cell
print_model_table = _MODEL_ROUTING_MOD.print_model_table
models_main = _MODEL_ROUTING_MOD.models_main

_WORKSPACE_AUDIT_MOD = bundled_module("workspace_audit")
git_output = _WORKSPACE_AUDIT_MOD.git_output
git_root = _WORKSPACE_AUDIT_MOD.git_root
nul_paths = _WORKSPACE_AUDIT_MOD.nul_paths
hash_path = _WORKSPACE_AUDIT_MOD.hash_path
path_fingerprint = _WORKSPACE_AUDIT_MOD.path_fingerprint
normalize_repo_paths = _WORKSPACE_AUDIT_MOD.normalize_repo_paths
index_fingerprints = _WORKSPACE_AUDIT_MOD.index_fingerprints
git_path_fingerprint = _WORKSPACE_AUDIT_MOD.git_path_fingerprint
git_state = _WORKSPACE_AUDIT_MOD.git_state
state_delta = _WORKSPACE_AUDIT_MOD.state_delta
REVIEW_FLAG_PATTERN = _WORKSPACE_AUDIT_MOD.REVIEW_FLAG_PATTERN
file_line_delta = _WORKSPACE_AUDIT_MOD.file_line_delta
compact_review_bundle = _WORKSPACE_AUDIT_MOD.compact_review_bundle
path_is_allowed = _WORKSPACE_AUDIT_MOD.path_is_allowed
find_scope_violations = _WORKSPACE_AUDIT_MOD.find_scope_violations
prepare_scratch_dir = _WORKSPACE_AUDIT_MOD.prepare_scratch_dir
scratch_brief_note = _WORKSPACE_AUDIT_MOD.scratch_brief_note
RUNNER_OUT_DIR_FILES = _WORKSPACE_AUDIT_MOD.RUNNER_OUT_DIR_FILES
RUNNER_ARCHIVED_ATTEMPT_PATTERN = _WORKSPACE_AUDIT_MOD.RUNNER_ARCHIVED_ATTEMPT_PATTERN
RUNNER_VERIFICATION_OUTPUT_PATTERN = _WORKSPACE_AUDIT_MOD.RUNNER_VERIFICATION_OUTPUT_PATTERN
is_runner_out_dir_file = _WORKSPACE_AUDIT_MOD.is_runner_out_dir_file
collect_scratch_artifacts = _WORKSPACE_AUDIT_MOD.collect_scratch_artifacts


_REPORT_CONTRACT_MOD = bundled_module("report_contract")
REPORT_HEADINGS = _REPORT_CONTRACT_MOD.REPORT_HEADINGS
REPORT_CONTRACT = _REPORT_CONTRACT_MOD.REPORT_CONTRACT
AGY_ONESHOT_GUARDRAIL = _REPORT_CONTRACT_MOD.AGY_ONESHOT_GUARDRAIL
read_brief = _REPORT_CONTRACT_MOD.read_brief
brief_renderer_module = _REPORT_CONTRACT_MOD.brief_renderer_module
read_task_spec = _REPORT_CONTRACT_MOD.read_task_spec
resolve_execution_brief = _REPORT_CONTRACT_MOD.resolve_execution_brief
brief_report_contract_violations = _REPORT_CONTRACT_MOD.brief_report_contract_violations
validate_brief_contract = _REPORT_CONTRACT_MOD.validate_brief_contract


def prepare_out_dir(requested: Path | None, repo: Path) -> Path:
    resolved_repo = repo.resolve()
    if requested:
        out_dir = requested.expanduser().resolve()
        if out_dir == resolved_repo or resolved_repo in out_dir.parents:
            raise RunnerError("--out-dir must be outside the target repository", 4)
        out_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
        out_dir.chmod(0o700)
        return out_dir
    # Under the cache (not $TMPDIR, which macOS cleans) so --resume-result paths stay valid; pruned by age.
    base = default_agent_cache_dir().resolve() / "runs-v1"
    if base == resolved_repo or resolved_repo in base.parents:
        raise RunnerError("the agent-executor cache must be outside the target repository", 4)
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = base / f"{repo.name}-{stamp}-{uuid.uuid4().hex[:8]}"
    out_dir.mkdir(mode=0o700)
    out_dir.chmod(0o700)
    return out_dir


def prepare_job_dir(requested: Path | None, repo: Path) -> Path:
    resolved_repo = repo.resolve()
    if requested:
        job_dir = requested.expanduser().resolve()
        if job_dir == resolved_repo or resolved_repo in job_dir.parents:
            raise RunnerError("--job-dir must be outside the target repository", 4)
        job_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
        job_dir.chmod(0o700)
        return job_dir
    base = default_agent_cache_dir().resolve() / "jobs-v1"
    if base == resolved_repo or resolved_repo in base.parents:
        raise RunnerError("the agent-executor cache must be outside the target repository", 4)
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    job_dir = base / f"{repo.name}-{stamp}-{uuid.uuid4().hex[:8]}"
    job_dir.mkdir(mode=0o700)
    job_dir.chmod(0o700)
    return job_dir


def command_preview(command: list[str]) -> list[str]:
    return [
        "--print=<brief omitted>" if item.startswith("--print=") and item != "--print=" else item for item in command
    ]


def write_private_text(path: Path, text: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
    finally:
        path.chmod(0o600)


def open_private_binary(path: Path) -> Any:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    path.chmod(0o600)
    return os.fdopen(descriptor, "wb")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    # Escaping non-ASCII data also makes paths decoded with surrogateescape safe to
    # serialize, while keeping the result portable across JSON consumers.
    write_private_text(path, json.dumps(payload, indent=2, ensure_ascii=True) + "\n")


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        write_json(temporary, payload)
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary.exists():
            temporary.unlink()


_EVENTS_BUS_MOD = bundled_module("events_bus")
parse_events_args = _EVENTS_BUS_MOD.parse_events_args
default_completion_event_dir = _EVENTS_BUS_MOD.default_completion_event_dir
prepare_completion_event_path = _EVENTS_BUS_MOD.prepare_completion_event_path
normalize_completion_event_path = _EVENTS_BUS_MOD.normalize_completion_event_path
completion_event_path_from_reference = _EVENTS_BUS_MOD.completion_event_path_from_reference
read_completion_event = _EVENTS_BUS_MOD.read_completion_event
resolve_completion_hook = _EVENTS_BUS_MOD.resolve_completion_hook
ensure_hook_outside_workspaces = _EVENTS_BUS_MOD.ensure_hook_outside_workspaces
send_desktop_notification = _EVENTS_BUS_MOD.send_desktop_notification
run_completion_hook = _EVENTS_BUS_MOD.run_completion_hook
publish_completion_event = _EVENTS_BUS_MOD.publish_completion_event
completion_events = _EVENTS_BUS_MOD.completion_events
completion_signal = _EVENTS_BUS_MOD.completion_signal
print_completion_signal = _EVENTS_BUS_MOD.print_completion_signal
MISSING_EVENT_GRACE_SECONDS = _EVENTS_BUS_MOD.MISSING_EVENT_GRACE_SECONDS
wait_for_completion_events = _EVENTS_BUS_MOD.wait_for_completion_events
acknowledge_completion_event = _EVENTS_BUS_MOD.acknowledge_completion_event
events_main = _EVENTS_BUS_MOD.events_main

bound_final_message = _REPORT_CONTRACT_MOD.bound_final_message
extract_final_report = _REPORT_CONTRACT_MOD.extract_final_report
_STATUS_HEADING_RE = _REPORT_CONTRACT_MOD._STATUS_HEADING_RE
extract_raw_final_report = _REPORT_CONTRACT_MOD.extract_raw_final_report
parse_reported_outcome = _REPORT_CONTRACT_MOD.parse_reported_outcome
report_contract_violations = _REPORT_CONTRACT_MOD.report_contract_violations
task_outcome_for_status = _REPORT_CONTRACT_MOD.task_outcome_for_status


def print_summary(result: dict[str, Any], result_path: Path) -> None:
    print(f"AGENT_STATUS={result['status']}")
    print(f"AGENT_OUTCOME={result.get('task_outcome', '')}")
    print(f"AGENT_VERIFICATION_STATUS={(result.get('verification') or {}).get('status', '')}")
    print(f"AGENT_ENGINE={result.get('engine', '')}")
    print(f"AGENT_MODEL={result.get('model', '')}")
    print(f"AGENT_FULL_PERMISSIONS={str(result.get('full_permissions', False)).lower()}")
    if result.get("session_id"):
        print(f"AGENT_SESSION={result['session_id']}")
    if result.get("scope_violations"):
        print(f"AGENT_SCOPE_VIOLATIONS={json.dumps(result['scope_violations'])}")
    if result.get("scratch") and result["scratch"].get("artifacts"):
        print(f"AGENT_SCRATCH={json.dumps(result['scratch']['artifacts'])}")
    if result.get("history_violations"):
        print(f"AGENT_HISTORY_VIOLATIONS={json.dumps(result['history_violations'])}")
    if result.get("event_errors"):
        print(f"AGENT_EVENT_ERRORS={json.dumps(result['event_errors'])}")
    auto_correct = result.get("auto_correct")
    if auto_correct:
        summary = {key: auto_correct.get(key) for key in ("max_rounds", "rounds_used", "outcome")}
        print("AGENT_AUTO_CORRECT=" + json.dumps(summary, ensure_ascii=True, separators=(",", ":")))
    review = result.get("review") or {}
    if review:
        print(
            "AGENT_REVIEW="
            + json.dumps(
                {
                    "changed_file_count": review.get("changed_file_count", 0),
                    "files": review.get("files", []),
                    "verification": review.get("verification", {}),
                    "review_flags": review.get("review_flags", []),
                },
                ensure_ascii=True,
                separators=(",", ":"),
            )
        )
    print(f"AGENT_RESULT={result_path}")
    final_message = result.get("final_message", "").strip()
    if final_message:
        print("--- AGENT FINAL REPORT ---")
        print(final_message)
        print("--- END AGENT REPORT ---")


def emit_lifecycle(stage: str, **fields: Any) -> None:
    details = " ".join(
        f"{key}={json.dumps(value, ensure_ascii=True)}" for key, value in fields.items() if value is not None
    )
    print(
        f"AGENT_LIFECYCLE={stage}" + (f" {details}" if details else ""),
        flush=True,
    )


_OUTPUT_PARSERS_MOD = bundled_module("output_parsers")
parse_agy_session_id = _OUTPUT_PARSERS_MOD.parse_agy_session_id
parse_jsonl_events = _OUTPUT_PARSERS_MOD.parse_jsonl_events
parse_agy_output = _OUTPUT_PARSERS_MOD.parse_agy_output
agy_terminal_error = _OUTPUT_PARSERS_MOD.agy_terminal_error
claude_result_text = _OUTPUT_PARSERS_MOD.claude_result_text
parse_claude_output = _OUTPUT_PARSERS_MOD.parse_claude_output
codex_terminal_error = _OUTPUT_PARSERS_MOD.codex_terminal_error
opencode_terminal_error = _OUTPUT_PARSERS_MOD.opencode_terminal_error
provider_terminal_error = _OUTPUT_PARSERS_MOD.provider_terminal_error
provider_quota_exhausted = _OUTPUT_PARSERS_MOD.provider_quota_exhausted
structured_quota_signal = _OUTPUT_PARSERS_MOD.structured_quota_signal
parse_codex_session_id = _OUTPUT_PARSERS_MOD.parse_codex_session_id
parse_event_errors = _OUTPUT_PARSERS_MOD.parse_event_errors
parse_opencode_output = _OUTPUT_PARSERS_MOD.parse_opencode_output


git_optional_output = _WORKSPACE_AUDIT_MOD.git_optional_output
text_fingerprint = _WORKSPACE_AUDIT_MOD.text_fingerprint
nonempty_line_count = _WORKSPACE_AUDIT_MOD.nonempty_line_count
git_identity = _WORKSPACE_AUDIT_MOD.git_identity
GIT_METADATA_VOLATILE = _WORKSPACE_AUDIT_MOD.GIT_METADATA_VOLATILE
git_metadata_snapshot = _WORKSPACE_AUDIT_MOD.git_metadata_snapshot
find_git_metadata_changes = _WORKSPACE_AUDIT_MOD.find_git_metadata_changes
git_activity = _WORKSPACE_AUDIT_MOD.git_activity
find_history_violations = _WORKSPACE_AUDIT_MOD.find_history_violations


def terminate_process(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=5)
        return
    try:
        process.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        pass
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(process.pid, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.wait(timeout=5)


@contextlib.contextmanager
def forward_termination_signals(process: subprocess.Popen[bytes]) -> Iterator[None]:
    """Forward SIGTERM, SIGINT, and SIGHUP to the child executor process group when running in the main thread."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    signals = [sig for sig in (signal.SIGTERM, signal.SIGINT, getattr(signal, "SIGHUP", None)) if sig is not None]
    previous_handlers: dict[int, Any] = {}

    def _handler(signum: int, frame: Any) -> None:
        terminate_process(process)
        previous = previous_handlers.get(signum)
        if signum == signal.SIGINT and (previous is signal.default_int_handler or previous == signal.SIG_DFL):
            raise KeyboardInterrupt
        if callable(previous):
            previous(signum, frame)
        raise SystemExit(128 + signum)

    try:
        for sig in signals:
            previous_handlers[sig] = signal.getsignal(sig)
            signal.signal(sig, _handler)
        yield
    finally:
        for sig, previous in previous_handlers.items():
            signal.signal(sig, previous)


_JOB_STEERING_MOD = bundled_module("job_steering")
interrupt_process = _JOB_STEERING_MOD.interrupt_process
CodexCreditsWatch = _JOB_STEERING_MOD.CodexCreditsWatch


def wait_with_heartbeats(
    process: subprocess.Popen[bytes],
    *,
    timeout_seconds: float,
    heartbeat_seconds: float,
    monotonic_start: float,
    poll: Any = None,
    poll_seconds: float = STEER_POLL_SECONDS,
) -> bool:
    """Wait for the executor; True when it timed out. `poll()` returning True means it stopped the
    process itself (a steering interrupt), which is not a timeout."""
    deadline = time.monotonic() + timeout_seconds
    next_heartbeat = time.monotonic() + heartbeat_seconds if heartbeat_seconds > 0 else math.inf
    while True:
        now = time.monotonic()
        remaining = deadline - now
        if remaining <= 0:
            terminate_process(process)
            return True
        wait_for = min(remaining, max(0.0, next_heartbeat - now))
        if poll is not None:
            wait_for = min(wait_for, poll_seconds)
        try:
            process.wait(timeout=wait_for)
            return False
        except subprocess.TimeoutExpired:
            pass
        if poll is not None and poll():
            process.wait()
            return False
        if time.monotonic() >= next_heartbeat:
            elapsed = round(time.monotonic() - monotonic_start, 1)
            print(f"AGENT_PROGRESS elapsed_seconds={elapsed}", flush=True)
            next_heartbeat = time.monotonic() + heartbeat_seconds


verification_summary = _WORKSPACE_AUDIT_MOD.verification_summary
nonempty_tail = _WORKSPACE_AUDIT_MOD.nonempty_tail
read_text_tail = _WORKSPACE_AUDIT_MOD.read_text_tail
run_verification_commands = _WORKSPACE_AUDIT_MOD.run_verification_commands

classify_result = _REPORT_CONTRACT_MOD.classify_result


def resolve_additional_directories(values: list[Path]) -> list[Path]:
    resolved: list[Path] = []
    for value in values:
        directory = value.expanduser().resolve()
        if not directory.is_dir():
            raise RunnerError(f"additional workspace directory does not exist: {directory}", 4)
        if directory not in resolved:
            resolved.append(directory)
    return resolved


CLAUDE_AUTH_ENV_OVERRIDES = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
)


def executor_environment(
    engine: str,
    repo: Path | None = None,
    claude_config_dir: Path | str | None = None,
    session_id: str | None = None,
    *,
    read_only: bool = False,
) -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items() if not HOST_SESSION_ENV.match(key)}
    if read_only:
        environment["ORKEST_READONLY_RUN"] = "1"
    else:
        environment.pop("ORKEST_READONLY_RUN", None)
    if repo is not None:
        bundled_module("repo_env").apply_repo_dotenv(environment, repo)
    if engine == "claude":
        if claude_config_dir is not None:
            for key in CLAUDE_AUTH_ENV_OVERRIDES:
                environment.pop(key, None)
            # Chooses the Claude account. Unset means Claude Code's default profile (~/.claude).
            environment["CLAUDE_CONFIG_DIR"] = str(Path(claude_config_dir).expanduser())
        if session_id:
            environment["CLAUDE_CODE_SESSION_ID"] = session_id
    if repo is not None:
        environment["PWD"] = str(repo)
    if engine == "agy":
        # Antigravity's terminal-title updates are not task progress and can bypass
        # ordinary stdout/stderr capture when the caller owns a PTY.
        environment["TERM"] = "dumb"
        environment["NO_COLOR"] = "1"
    if engine == "opencode":
        environment["OPENCODE_PERMISSION"] = json.dumps("allow")
        environment["OPENCODE_AUTO_SHARE"] = "false"
        environment["OPENCODE_DISABLE_AUTOUPDATE"] = "true"
        environment["OPENCODE_CONFIG_CONTENT"] = json.dumps(OPENCODE_RUNTIME_CONFIG)
    return environment


_NATIVE_FAMILIES = _MODEL_ROUTING_MOD._NATIVE_FAMILIES
native_engine_for = _MODEL_ROUTING_MOD.native_engine_for
normalize_claude_model_id = _MODEL_ROUTING_MOD.normalize_claude_model_id
parse_bare_tier_selector = _MODEL_ROUTING_MOD.parse_bare_tier_selector
enforce_native_route = _MODEL_ROUTING_MOD.enforce_native_route
families_module = _MODEL_ROUTING_MOD.families_module
load_model_families = _MODEL_ROUTING_MOD.load_model_families
resolve_family_selector = _MODEL_ROUTING_MOD.resolve_family_selector
note_selector_advance = _MODEL_ROUTING_MOD.note_selector_advance
resume_pinned_model = _MODEL_ROUTING_MOD.resume_pinned_model
MODEL_PREFLIGHT = _MODEL_ROUTING_MOD.MODEL_PREFLIGHT
split_opencode_model = _MODEL_ROUTING_MOD.split_opencode_model
select_live_model = _MODEL_ROUTING_MOD.select_live_model
executor_preflight = _MODEL_ROUTING_MOD.executor_preflight


AGY_STDIN_MIN_VERSION = (1, 1, 15)


def version_at_least(version: str | None, minimum: tuple[int, ...]) -> bool:
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", version or "")
    return bool(match) and tuple(int(part) for part in match.groups()) >= minimum


def agy_stream_input(brief: str) -> bytes:
    return (json.dumps({"event": "user", "message": {"content": brief}}) + "\n").encode("utf-8")


def format_duration(seconds: float) -> str:
    whole = max(1, int(math.ceil(seconds)))
    if whole % 3600 == 0:
        return f"{whole // 3600}h"
    if whole % 60 == 0:
        return f"{whole // 60}m"
    return f"{whole}s"


def build_executor_command(
    *,
    executable: str,
    engine: str,
    model: str,
    variant: str | None,
    repo: Path,
    add_dirs: list[Path],
    session_id: str | None,
    continue_last: bool,
    timeout: str,
    submitted_brief_path: Path,
    final_output_path: Path,
    log_path: Path,
    effort: str | None = None,
    agy_stdin: bool = False,
    new_session_id: str | None = None,
    executor_version: str | None = None,
) -> list[str]:
    if engine == "agy":
        command = [executable]
        if session_id:
            command += ["--conversation", session_id]
        elif continue_last:
            command += ["--continue"]
        else:
            command += ["--new-project", "--add-dir", str(repo)]
            for directory in add_dirs:
                command += ["--add-dir", str(directory)]
        command += [
            "--model",
            model,
            "--output-format",
            "stream-json",
            "--dangerously-skip-permissions",
            "--print-timeout",
            format_duration(parse_duration(timeout) + 90),
            "--log-file",
            str(log_path),
        ]
        if agy_stdin:
            # The brief arrives as one stream-json message on stdin, keeping it out of argv
            # (visible in the process table and bounded by ARG_MAX).
            command += ["--input-format", "stream-json", "--print="]
        else:
            command.append(f"--print={submitted_brief_path.read_text(encoding='utf-8')}")
        return command

    if engine == "claude":
        command = [
            executable,
            "-p",
            "--output-format",
            "json",
            "--model",
            model,
            "--permission-mode",
            "bypassPermissions",
            "--add-dir",
            str(repo),
        ]
        for directory in add_dirs:
            command += ["--add-dir", str(directory)]
        if effort is not None:
            command += ["--effort", effort]
        if session_id:
            command += ["--resume", session_id]
        elif continue_last:
            command += ["--continue"]
        elif new_session_id:
            # Claude Code prints its session ID only in the final result; naming it up front keeps an
            # interrupted (steered) run resumable.
            command += ["--session-id", new_session_id]
        return command

    if engine == "codex":
        if session_id or continue_last:
            command = [executable, "exec", "resume"]
            command += [session_id] if session_id else ["--last"]
        else:
            command = [executable, "exec", "-C", str(repo)]
            for directory in add_dirs:
                command += ["--add-dir", str(directory)]
        if effort is not None:
            command += ["-c", "model_reasoning_effort=" + json.dumps(effort)]
        command += [
            "--model",
            model,
            "--dangerously-bypass-approvals-and-sandbox",
            "--json",
            "--output-last-message",
            str(final_output_path),
            "-",
        ]
        return command

    ver_str = executor_version or get_cached_cli_version(executable, executor_environment("opencode"))
    major = opencode_major_version(ver_str)
    base_model, inline_variant = split_opencode_model("opencode", model)
    assert base_model is not None
    effective_variant = variant or inline_variant
    if major >= 2:
        effective_model = f"{base_model}#{effective_variant}" if effective_variant else base_model
        command = [executable, "run", "--standalone"]
        if session_id:
            command += ["--session", session_id]
        elif continue_last:
            command += ["--continue"]
        command += [
            "--model",
            effective_model,
            "--agent",
            "build",
            "--format",
            "json",
            "--auto",
            "Execute the attached execution brief exactly and return its required report.",
            "--file",
            str(submitted_brief_path),
        ]
        return command

    command = [executable, "run"]
    if session_id:
        command += ["--session", session_id]
    elif continue_last:
        command += ["--continue"]
    command += [
        "--model",
        base_model,
        "--variant",
        effective_variant or DEFAULT_OPENCODE_VARIANT,
        "--pure",
        "--agent",
        "build",
        "--format",
        "json",
        "--auto",
        "--dir",
        str(repo),
        "Execute the attached execution brief exactly and return its required report.",
        "--file",
        str(submitted_brief_path),
    ]
    return command


def validated_run_options(
    args: argparse.Namespace, *, task_spec: dict[str, Any] | None = None
) -> tuple[
    str | None,
    list[Path],
    list[str],
    list[str],
    list[str],
    float,
    float,
]:
    variant = args.variant
    if args.resume_result and not args.session:
        raise RunnerError("--resume-result requires an exact --session", 4)
    if args.engine == "opencode":
        args.model, inline_variant = split_opencode_model("opencode", getattr(args, "model", None))
        variant = variant or inline_variant or getattr(args, "effort", None) or DEFAULT_OPENCODE_VARIANT
    elif variant:
        raise RunnerError("--variant is only valid with --engine opencode", 4)
    if args.heartbeat_seconds < 0:
        raise RunnerError("--heartbeat-seconds must be 0 or greater", 4)
    if args.add_dir and (args.session or args.continue_last):
        raise RunnerError("--add-dir is only valid when creating a fresh executor session", 4)
    if args.engine == "opencode" and args.add_dir:
        raise RunnerError(
            "--engine opencode cannot faithfully establish additional workspace roots; use codex or agy",
            4,
        )
    add_dirs = resolve_additional_directories(args.add_dir)
    if task_spec is not None:
        if args.allow_path or args.track_path:
            raise RunnerError(
                "--task-spec derives scope; do not also pass --allow-path or --track-path",
                4,
            )
        allowed_paths = normalize_repo_paths(
            list(task_spec["allow_paths"]), option="task-spec allow_paths", allow_root=True
        )
        tracked_paths = normalize_repo_paths(list(task_spec["track_paths"]), option="task-spec track_paths")
    else:
        allowed_paths = normalize_repo_paths(args.allow_path, option="--allow-path", allow_root=True)
        tracked_paths = normalize_repo_paths(args.track_path, option="--track-path")
    enforced_paths = list(dict.fromkeys([*allowed_paths, *tracked_paths]))
    if args.expect_changes and not enforced_paths:
        raise RunnerError(
            "--expect-changes requires at least one --allow-path or --track-path for scope enforcement",
            4,
        )
    if args.retry_read_only < 0 or args.retry_read_only > 3:
        raise RunnerError("--retry-read-only must be between 0 and 3", 4)
    if args.retry_read_only and (args.expect_changes or enforced_paths):
        raise RunnerError(
            "--retry-read-only requires a read-only run with no allowed or tracked paths",
            4,
        )
    if any(not command.strip() for command in args.verify_command):
        raise RunnerError("--verify-command cannot be empty", 4)
    if getattr(args, "auto_correct", None) is not None:
        try:
            bundled_module("auto_correct").validate_rounds(args.auto_correct, name="--auto-correct")
        except ValueError as error:
            raise RunnerError(str(error), 4) from error
        if args.auto_correct and not args.verify_command:
            raise RunnerError("--auto-correct requires a --verify-command gate to correct against", 4)
    timeout_seconds = parse_duration(args.timeout)
    deadline_remaining(args.deadline)
    verify_timeout_seconds = parse_duration(
        args.verify_timeout,
        option="--verify-timeout",
    )
    return (
        variant,
        add_dirs,
        allowed_paths,
        tracked_paths,
        enforced_paths,
        timeout_seconds,
        verify_timeout_seconds,
    )


def detect_conductor_model(repo: Path) -> str | None:
    """Best-effort detection of the calling conductor's model from the environment or peer mailbox."""
    raw_env = os.environ.get("ORCHESTRATE_CONDUCTOR_MODEL") or os.environ.get("AGENT_EXECUTOR_CONDUCTOR_MODEL")
    if isinstance(raw_env, str) and raw_env.strip():
        return raw_env.strip()
    with contextlib.suppress(Exception):
        mailbox = bundled_module("peer_mailbox")
        base = mailbox.root()
        peers_dir = base / "peers"
        if not peers_dir.is_dir():
            return None
        target_ws = mailbox.workspace(str(repo))
        if not target_ws:
            return None
        for env_key in (
            "AGENT_MAILBOX_SESSION",
            "CLAUDE_CODE_SESSION_ID",
            "CODEX_THREAD_ID",
            "ANTIGRAVITY_CONVERSATION_ID",
            "OPENCODE_SESSION_ID",
        ):
            session = (os.environ.get(env_key) or "").strip()
            if not session or session.startswith("run-"):
                continue
            peer = mailbox.load(mailbox.peer_path(base, session))
            if (
                isinstance(peer, dict)
                and not mailbox.is_run_peer(peer)
                and mailbox.same_project(target_ws, peer)
                and isinstance(peer.get("model"), str)
                and peer["model"].strip()
            ):
                return peer["model"].strip()
        ancestors: set[int] = set()
        pid = os.getppid()
        for _ in range(8):
            if pid <= 1 or pid in ancestors:
                break
            ancestors.add(pid)
            line = subprocess.run(
                ["ps", "-o", "ppid=", "-p", str(pid)],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            ).stdout.strip()
            if not line.isdigit():
                break
            pid = int(line)
        if ancestors:
            candidates = [
                peer
                for peer in mailbox.peers(base, prune_dead=False)
                if not peer.get("isSubagent")
                and not peer.get("delegatedRun")
                and peer.get("pid") in ancestors
                and mailbox.same_project(target_ws, peer)
                and isinstance(peer.get("model"), str)
                and peer["model"].strip()
            ]
            non_shared = [peer for peer in candidates if not peer.get("sharedProcess")]
            if len(non_shared) == 1:
                return non_shared[0]["model"].strip()
            if candidates:
                newest = max(candidates, key=lambda item: str(item.get("lastSeenAt") or item.get("startedAt") or ""))
                return newest["model"].strip()
    return None


def apply_upward_delegation_policy(
    args: argparse.Namespace,
    *,
    repo: Path,
    brief: str,
    task_spec: dict[str, Any] | None,
    allowed_paths: list[str],
    tracked_paths: list[str],
    enforced_paths: list[str],
    worker_model: str | None = None,
    emit_note: bool = True,
) -> tuple[str, dict[str, Any] | None, list[str], list[str], dict[str, Any]]:
    """Resolve worker-owned scope when a lower-tier conductor delegates a mutating run to a higher-tier worker."""
    support = bundled_module("execution_support")
    conductor_model = (
        getattr(args, "conductor_model", None)
        or (task_spec or {}).get("conductor_model")
        or detect_conductor_model(repo)
    )
    resolved_worker_model = (
        worker_model
        or (task_spec or {}).get("worker_model")
        or resume_pinned_model(args)
        or preferred_model(args.engine)
    )
    is_mutating = bool(allowed_paths) or (task_spec is not None and task_spec.get("scope_owner") == "worker")
    if not is_mutating:
        return (
            brief,
            task_spec,
            allowed_paths,
            enforced_paths,
            {
                "scope_owner": "conductor",
                "conductor_model": conductor_model,
                "scope_hints": [],
                "upward_delegation": False,
            },
        )
    upward = support.is_upward_delegation(conductor_model, resolved_worker_model)
    explicit_worker_scope = "." in allowed_paths or (task_spec is not None and task_spec.get("scope_owner") == "worker")
    if not (upward or explicit_worker_scope):
        return (
            brief,
            task_spec,
            allowed_paths,
            enforced_paths,
            {
                "scope_owner": "conductor",
                "conductor_model": conductor_model,
                "scope_hints": [],
                "upward_delegation": False,
            },
        )

    if task_spec is not None:
        if (
            task_spec.get("scope_owner") != "worker"
            or "." not in task_spec.get("allow_paths", [])
            or (conductor_model and not task_spec.get("conductor_model"))
            or (resolved_worker_model and not task_spec.get("worker_model"))
        ):
            renderer = brief_renderer_module()
            upgraded_raw = {
                **task_spec,
                "scope_owner": "worker",
                "conductor_model": conductor_model or task_spec.get("conductor_model"),
                "worker_model": resolved_worker_model or task_spec.get("worker_model"),
            }
            task_spec = renderer.validate_spec(upgraded_raw)
            brief = renderer.render_brief(task_spec)
        scope_hints = list(task_spec.get("scope_hints", []))
        allowed_paths = ["."]
        enforced_paths = list(dict.fromkeys([*allowed_paths, *tracked_paths]))
    else:
        scope_hints = [path for path in allowed_paths if path != "."]
        allowed_paths = ["."]
        enforced_paths = list(dict.fromkeys([*allowed_paths, *tracked_paths]))
        if upward and "# Upward-delegation scope authority" not in brief:
            note_lines = [
                "",
                "# Upward-delegation scope authority",
                "- Scope owner: worker (`.` — full repository scope, excluding `.git`).",
                f"- Delegated from lower-tier conductor (`{conductor_model}`) to higher-tier worker (`{resolved_worker_model}`).",
                "- You own the implementation plan, architectural decisions, and file selection across the repository. "
                "Treat any file lists or step-by-step plans in the brief above as non-binding starting hints.",
            ]
            if scope_hints:
                note_lines.append(f"- Conductor starting hints: {', '.join(scope_hints)}")
            brief = brief.rstrip() + "\n" + "\n".join(note_lines) + "\n"

    if emit_note and upward:
        emit_lifecycle(
            "worker_owned_scope",
            conductor=conductor_model or "unknown",
            worker=resolved_worker_model,
        )
    return (
        brief,
        task_spec,
        allowed_paths,
        enforced_paths,
        {
            "scope_owner": "worker",
            "conductor_model": conductor_model,
            "scope_hints": scope_hints,
            "upward_delegation": upward,
        },
    )


TRANSIENT_FAILURE_PATTERNS = _OUTPUT_PARSERS_MOD.TRANSIENT_FAILURE_PATTERNS
transient_provider_failure = _OUTPUT_PARSERS_MOD.transient_provider_failure
MODEL_AVAILABILITY_FAILURE_PATTERNS = _OUTPUT_PARSERS_MOD.MODEL_AVAILABILITY_FAILURE_PATTERNS
classify_model_availability_failure = _OUTPUT_PARSERS_MOD.classify_model_availability_failure


def archive_executor_attempt_artifacts(
    *,
    out_dir: Path,
    attempt: int,
    stdout_path: Path,
    stderr_path: Path,
    log_path: Path,
    final_output_path: Path,
) -> dict[str, str]:
    """Keep a failed retry attempt private before its paths are reused."""
    archived: dict[str, str] = {}
    for label, source in (
        ("stdout_path", stdout_path),
        ("stderr_path", stderr_path),
        ("log_path", log_path),
        ("final_output_path", final_output_path),
    ):
        if not source.exists():
            continue
        destination = out_dir / f"attempt-{attempt}-{source.name}"
        os.replace(source, destination)
        destination.chmod(0o600)
        archived[label] = str(destination)
    return archived


detached_runner_command = _JOB_STEERING_MOD.detached_runner_command
launch_detached = _JOB_STEERING_MOD.launch_detached
executor_session_so_far = _JOB_STEERING_MOD.executor_session_so_far
steering_brief = _JOB_STEERING_MOD.steering_brief
JobSteering = _JOB_STEERING_MOD.JobSteering


def foreground_run_name(out_dir: Path) -> str:
    """Output directories can share a basename; the path's hash keeps their mailbox runs apart."""
    return f"{out_dir.name}-{hashlib.sha1(str(out_dir.resolve()).encode()).hexdigest()[:8]}"


def write_run_result(result_path: Path, result: dict[str, Any]) -> None:
    """Publish a run's result under the lock every run send holds, so no message lands after it."""
    run = (result.get("mailbox") or {}).get("run")
    if not run:
        write_json_atomic(result_path, result)
        return
    mailbox = bundled_module("peer_mailbox")
    with mailbox.run_lock(mailbox.root(), run):
        write_json_atomic(result_path, result)


def attach_tariff_estimate(result: dict[str, Any]) -> None:
    """Add the reference tariff estimate for the result's reported usage; a missing registry is a gap, not a failure."""
    usage_module = bundled_module("usage")
    registry_path = Path(__file__).parents[1] / "references" / "model-registry.json"
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        result["tariff_estimate"] = usage_module.estimate_tariff(
            result["usage"],
            result.get("model", ""),
            registry,
            billing_mode=result.get("billing_mode", "unknown"),
        )
    except (OSError, ValueError, KeyError, TypeError):
        result["tariff_estimate"] = {"estimated_usd": None, "gaps": ["tariff_registry_unavailable_or_invalid"]}


# The segment a detached runner is on, so an uncaught failure publishes to the event people wait on.
_ACTIVE_SEGMENT: dict[str, Path] = {}


def finish_run(
    *,
    result: dict[str, Any],
    result_path: Path,
    completion_event_path: Path | None,
    notification_mode: str,
    completion_hook: Path | None,
    extra_event_fields: dict[str, Any] | None = None,
) -> int:
    result.setdefault("usage", bundled_module("usage").empty())
    attach_tariff_estimate(result)
    write_run_result(result_path, result)
    if completion_event_path is not None:
        publish_completion_event(
            result=result,
            result_path=result_path,
            event_path=completion_event_path,
            notification_mode=notification_mode,
            completion_hook=completion_hook,
            extra=extra_event_fields,
        )
    print_summary(result, result_path)
    return int(result["exit_code"])


def publish_uncaught_completion_failure(error: Exception, exit_code: int) -> None:
    if "--completion-event" not in sys.argv[1:]:
        return
    try:
        args = parse_args(sys.argv[1:])
    except SystemExit:
        return
    try:
        args = resolve_route(args)
    except RunnerError:
        args.engine = args.engine or DEFAULT_ENGINE
    if not args.completion_event or not args.out_dir:
        return
    try:
        event_path = _ACTIVE_SEGMENT.get("event_path") or normalize_completion_event_path(args.completion_event)
        if event_path.exists():
            return
        result_path = _ACTIVE_SEGMENT.get("result_path") or args.out_dir.expanduser().resolve() / "result.json"
        repository = args.cwd.expanduser().resolve()
        if result_path == repository or repository in result_path.parents:
            return
        result = {
            "schema": RESULT_SCHEMA,
            "runner_version": RUNNER_VERSION,
            "status": "runner_failed",
            "task_outcome": "failed",
            "reported_outcome": None,
            "exit_code": exit_code,
            "error": str(error),
            "started_at": utc_now(),
            "finished_at": utc_now(),
            "engine": args.engine,
            "model": args.model or preferred_model(args.engine),
            "variant": args.variant,
            "full_permissions": True,
            "repository": str(repository),
            "scope_violations": [],
            "history_violations": [],
            "verification": verification_summary(
                args.verify_command,
                status="skipped" if args.verify_command else "not_requested",
                skipped_reason=("runner_failed" if args.verify_command else None),
            ),
        }
        run_id = bundled_module("peer_mailbox").run_id_for(args.mailbox_run_id or event_path.stem)
        mailbox_info = bundled_module("peer_mailbox").run_info(bundled_module("peer_mailbox").root(), run_id)
        if mailbox_info:
            result["mailbox"] = mailbox_info
        write_run_result(result_path, result)
        completion_hook: Path | None
        try:
            completion_hook = resolve_completion_hook(args.completion_hook)
        except RunnerError:
            completion_hook = None
        publish_completion_event(
            result=result,
            result_path=result_path,
            event_path=event_path,
            notification_mode=args.notify or "none",
            completion_hook=completion_hook,
        )
    except Exception as notification_error:
        print(
            f"agent-executor: could not publish failure event: {notification_error}",
            file=sys.stderr,
        )


AUTO_PRUNE_SECONDS = 30 * 24 * 60 * 60
LOCK_GRACE_SECONDS = 15 * 60


def _tree_size(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file()) if path.is_dir() else 0


def _pid_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _lock_has_live_pid(lock_path: Path) -> bool:
    try:
        raw = lock_path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return False
    if not raw:
        return False
    pids: list[int] = []
    if raw.isdigit():
        pids.append(int(raw))
    elif raw.startswith("{"):
        with contextlib.suppress(ValueError, TypeError):
            payload = json.loads(raw)
            if isinstance(payload, dict):
                for key in ("pid", "holder_pid", "owner_pid"):
                    val = payload.get(key)
                    if isinstance(val, int) and not isinstance(val, bool):
                        pids.append(val)
                    elif isinstance(val, str) and val.strip().isdigit():
                        pids.append(int(val.strip()))
    return any(_pid_is_alive(pid) for pid in pids)


def prune_state(older_than_seconds: float, *, dry_run: bool = False) -> dict[str, Any]:
    """Remove runner state older than the cutoff. Unacknowledged completion events, and the job
    directories they point to, are always kept: they are results nobody has reviewed yet."""
    cache = default_agent_cache_dir()
    now = time.time()
    cutoff = now - older_than_seconds
    lock_cutoff = min(cutoff, now - LOCK_GRACE_SECONDS)
    removed = {"events": 0, "jobs": 0, "runs": 0, "consults": 0, "locks": 0, "mailbox": 0, "bytes": 0}
    protected: set[Path] = set()
    job_roots = (cache / "jobs-v1", cache / "consults-v1")
    for event_path in sorted((cache / "completions-v1").glob("*.json")):
        try:
            event = json.loads(event_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        result_path = Path(str(event.get("result_path") or ""))
        job_dir = next((parent for parent in result_path.parents if parent.parent in job_roots), None)
        if not event.get("acknowledged_at") or event_path.stat().st_mtime > cutoff:
            if job_dir is not None:
                protected.add(job_dir)
            continue
        removed["events"] += 1
        removed["bytes"] += event_path.stat().st_size
        if not dry_run:
            event_path.unlink(missing_ok=True)
            (event_path.parent / "channels" / event_path.name).unlink(missing_ok=True)
    for kind, directory in (
        ("jobs", cache / "jobs-v1"),
        ("runs", cache / "runs-v1"),
        ("consults", cache / "consults-v1"),
    ):
        for entry in sorted(directory.glob("*")) if directory.is_dir() else []:
            if not entry.is_dir() or entry in protected or entry.stat().st_mtime > cutoff:
                continue
            removed[kind] += 1
            removed["bytes"] += _tree_size(entry)
            if not dry_run:
                shutil.rmtree(entry, ignore_errors=True)
    # Never unlink persistent flock targets in worktree-locks-v1; only prune locks and coordinator-locks.
    for lock_dir in (cache / "locks", cache / "coordinator-locks"):
        if not lock_dir.is_dir():
            continue
        for lock_path in sorted(lock_dir.glob("*.lock")):
            if lock_path.name == "cleanup.lock":
                continue
            try:
                stat = lock_path.stat()
            except OSError:
                continue
            if stat.st_mtime > lock_cutoff:
                continue
            try:
                with lock_path.open("a+b") as handle:
                    if fcntl is not None:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    try:
                        if _lock_has_live_pid(lock_path):
                            continue
                        removed["locks"] += 1
                        removed["bytes"] += stat.st_size
                        if not dry_run:
                            lock_path.unlink(missing_ok=True)
                    finally:
                        if fcntl is not None:
                            with contextlib.suppress(OSError):
                                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                continue
    mailbox_dir = cache / "mailbox-v1"
    if mailbox_dir.is_dir():
        mailbox_candidates: list[Path] = []
        for sub in (mailbox_dir, mailbox_dir / "peers", mailbox_dir / "locks"):
            if not sub.is_dir():
                continue
            for pattern in (
                "run-*-conductor.json",
                "run-*-worker.json",
                "run-*-conductor.lock",
                "run-*-worker.lock",
                "run-*.lock",
            ):
                mailbox_candidates.extend(sub.glob(pattern))
        for item in sorted(set(mailbox_candidates)):
            try:
                stat = item.stat()
            except OSError:
                continue
            if not item.is_file() or stat.st_mtime > cutoff:
                continue
            removed["mailbox"] += 1
            removed["bytes"] += stat.st_size
            if not dry_run:
                item.unlink(missing_ok=True)
    return {"dry_run": dry_run, "older_than_seconds": older_than_seconds, "cache": str(cache), **removed}


def auto_prune() -> None:
    """At most once a day, drop mailbox runs closed for a week and state older than 30 days.
    Best effort; never fails a run."""
    marker = default_agent_cache_dir() / "last-prune"
    try:
        if marker.exists() and time.time() - marker.stat().st_mtime < 24 * 60 * 60:
            return
        with contextlib.suppress(OSError, ValueError, RunnerError):  # MailboxError is a ValueError
            mailbox = bundled_module("peer_mailbox")
            mailbox.prune(mailbox.root())
        prune_state(AUTO_PRUNE_SECONDS)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
    except OSError:
        pass


def prune_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog=f"{Path(__file__).name} prune",
        description="Remove acknowledged events and job/run directories older than a cutoff.",
    )
    parser.add_argument("--older-than", default="14d", help="Age cutoff such as 14d, 12h (default 14d)")
    parser.add_argument("--dry-run", action="store_true", help="Report what would be removed")
    args = parser.parse_args(argv)
    older_than = parse_duration(args.older_than, option="--older-than")
    summary = prune_state(older_than, dry_run=args.dry_run)
    if not args.dry_run:
        with contextlib.suppress(OSError, ValueError, RunnerError):
            mailbox = bundled_module("peer_mailbox")
            mailbox.prune(mailbox.root())
    print(json.dumps(summary, indent=2))
    return 0


routes_module = _MODEL_ROUTING_MOD.routes_module
preferred_model = _MODEL_ROUTING_MOD.preferred_model
resolve_route = _MODEL_ROUTING_MOD.resolve_route
families_main = _MODEL_ROUTING_MOD.families_main
routes_main = _MODEL_ROUTING_MOD.routes_main
init_main = _MODEL_ROUTING_MOD.init_main


HOST_MARKERS = {
    "claude": ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"),
    "codex": ("CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_MANAGED_BY_NPM"),
    "opencode": ("OPENCODE", "OPENCODE_SESSION_ID"),
    "agy": ("ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_AGENT"),
}


def detect_host() -> str | None:
    return next((host for host, keys in HOST_MARKERS.items() if any(os.environ.get(key) for key in keys)), None)


def decide_transport(args: argparse.Namespace, host: str | None) -> str:
    if args.transport == "executor":
        return "executor"
    executor_boundary = any(
        (
            args.detach,
            args.session,
            args.continue_last,
            args.resume_result,
            args.completion_event,
            args.mailbox_run_id,
            args.dry_run,
            args.engine == "claude" and args.claude_config_dir,
        )
    )
    if args.transport == "native":
        if host != args.engine or executor_boundary or args.claude_config_dir:
            raise RunnerError(
                "--transport native requires the calling harness to match --engine and a fresh task without "
                "CLI session, profile, detached, completion, mailbox, or dry-run options; use --transport executor",
                4,
            )
        return "native"
    return "native" if host == args.engine and not executor_boundary else "executor"


def enforce_repo_policy(
    cwd: Path | str,
    engine: str,
    claude_config_dir: Path | str | None = None,
) -> Path | None:
    allowed, reason, auto_claude_dir = bundled_module("repo_policy").check_execution_allowed(
        cwd,
        engine,
        claude_config_dir,
    )
    if not allowed:
        raise RunnerError(reason or f"Harness {engine!r} is denied by repository policy", 2)
    return auto_claude_dir


def native_handoff(args: argparse.Namespace, host: str) -> int:
    if args.job_dir or args.notify or args.completion_hook or args.steer_dir:
        raise RunnerError("job, notification, and steering options require executor transport", 4)
    cwd = args.cwd.expanduser().resolve()
    if not cwd.is_dir():
        raise RunnerError(f"target directory does not exist: {cwd}", 4)
    repo = git_root(cwd)
    if cwd != repo:
        raise RunnerError(f"--cwd must be the Git repository root: {repo}", 4)
    auto_claude_dir = enforce_repo_policy(repo, args.engine, getattr(args, "claude_config_dir", None))
    if auto_claude_dir is not None and getattr(args, "claude_config_dir", None) is None:
        args.claude_config_dir = auto_claude_dir
    brief, task_spec = resolve_execution_brief(args, repo=repo)
    _, add_dirs, allowed, tracked, enforced, _, _ = validated_run_options(args, task_spec=task_spec)
    brief, task_spec, allowed, enforced, scope_info = apply_upward_delegation_policy(
        args,
        repo=repo,
        brief=brief,
        task_spec=task_spec,
        allowed_paths=allowed,
        tracked_paths=tracked,
        enforced_paths=enforced,
        worker_model=args.model or preferred_model(args.engine),
    )
    if enforced:
        bundled_module("repo_env").bootstrap_worktree_env(repo, overwrite=False)
    out_dir = prepare_out_dir(args.out_dir, repo)
    scratch = prepare_scratch_dir(out_dir) if not enforced else None
    submitted_path = out_dir / "submitted-brief.txt"
    write_private_text(out_dir / "brief.txt", brief + "\n")
    scratch_note = scratch_brief_note(scratch) if scratch else ""
    write_private_text(submitted_path, f"{brief}\n{scratch_note}\n{REPORT_CONTRACT}\n")
    tools = {
        "codex": "collaboration.spawn_agent and native collaboration messaging for subagents, or codex_tui "
        "thread tools for a separate task when the user requested one",
        "claude": "Claude Code's native Agent and SendMessage tools",
        "agy": "Antigravity's native invoke_subagent and send_message tools",
        "opencode": "OpenCode's native subagent tools",
    }[host]
    instructions = (
        f"Run the submitted brief using {tools}, within the user's delegation authority. "
        "Use native parent-worker communication. Resolve the requested model and effort through the host's "
        "available native controls; this handoff has not validated or run a model. "
        "No workspace lease, executor, or verification gates have run. "
        "Use coordinator.py dispatch --transport native when a durable lease and audit guard are needed. "
        "Use --transport executor when an isolated CLI process or account profile is needed."
    )
    rounds, rounds_source = bundled_module("auto_correct").effective_rounds(
        getattr(args, "auto_correct", None), task_spec, args.verify_command
    )
    auto_correct = None
    if rounds:
        # Native transport never loops: the host sends any correction turn to its own worker.
        instructions += (
            f" Auto-correct is not run for native transport: when a gate fails, send the same worker its command, "
            f"exit code and trimmed output with '{bundled_module('auto_correct').INSTRUCTION}', at most {rounds} "
            "times."
        )
        auto_correct = {"max_rounds": rounds, "source": rounds_source, "mode": "native", "rounds": []}
    result_path = out_dir / "result.json"
    write_json(
        result_path,
        {
            "schema": RESULT_SCHEMA,
            "status": "native_handoff",
            "task_outcome": "not_run",
            "transport": "native",
            "host": host,
            "engine": args.engine,
            "model": args.model or preferred_model(args.engine),
            "requested_effort": args.effort,
            "repository": str(repo),
            "submitted_brief_path": str(submitted_path),
            "native_instructions": instructions,
            "allowed_paths": allowed,
            "tracked_paths": tracked,
            "scope_owner": scope_info["scope_owner"],
            "conductor_model": scope_info["conductor_model"],
            "scope_hints": scope_info["scope_hints"],
            "additional_directories": [str(path) for path in add_dirs],
            "scratch_dir": str(scratch) if scratch else None,
            "verification_commands": args.verify_command,
            "deadline": args.deadline,
            **({"auto_correct": auto_correct} if auto_correct else {}),
        },
    )
    print("AGENT_STATUS=native_handoff")
    print("AGENT_TRANSPORT=native")
    print(f"AGENT_BRIEF={submitted_path}")
    print(f"AGENT_RESULT={result_path}")
    print(instructions)
    return 0


def doctor_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog=f"{Path(__file__).name} doctor",
        description="Report host, installed CLIs, routes, quota source, paths and skill installs.",
    )
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument(
        "--check-messaging", action="store_true", help="verify messaging with isolated, model-free round trips"
    )
    parser.add_argument(
        "--repair-messaging", action="store_true", help="register missing mailbox servers and turn hooks"
    )
    parser.add_argument(
        "--trust-codex-hooks", action="store_true", help="with --repair-messaging, trust only the four mailbox hooks"
    )
    parser.add_argument(
        "--stdio-messaging", action="store_true", help="with --repair-messaging, restore stdio registration"
    )
    args = parser.parse_args(argv)
    messaging_check = None
    if args.trust_codex_hooks and not args.repair_messaging:
        parser.error("--trust-codex-hooks requires --repair-messaging")
    if args.repair_messaging:
        bundled_module("install_mailbox").install(trust_codex_hooks=args.trust_codex_hooks, stdio=args.stdio_messaging)
    elif args.stdio_messaging:
        parser.error("--stdio-messaging requires --repair-messaging")
    elif args.check_messaging:
        messaging_check = bundled_module("check_mailbox").check()
    hosts = [host for host, keys in HOST_MARKERS.items() if any(os.environ.get(key) for key in keys)]
    clis = {}
    for engine in EXECUTION_ENGINES:
        executable = shutil.which(engine)
        version = None
        if executable:
            try:
                version = cli_version(executable, executor_environment(engine))
            except (OSError, RunnerError) as error:
                version = f"error: {error}"
        clis[engine] = {"executable": executable, "version": version}
    skill_dir = Path(__file__).resolve().parent.parent
    installs = {}
    for location in (
        "~/.agents/skills",
        "~/.claude/skills",
        "~/.claude-personal/skills",
        "~/.codex/skills",
        "~/.config/opencode/skills",
        "~/.gemini/config/skills",
    ):
        base_dir = Path(location).expanduser()
        entry = base_dir / "orchestrate"
        if not (entry.exists() or entry.is_symlink()):
            entry = base_dir / "agent-executor"
        if entry.exists() or entry.is_symlink():
            resolved = entry.resolve()
            installs[location] = {
                "resolves_to": str(resolved),
                "same_as_this": resolved == skill_dir,
                "kind": "link" if entry.is_symlink() else "copy",
            }
    quota = bundled_module("quota")
    report = {
        "runner_version": RUNNER_VERSION,
        "skill_dir": str(skill_dir),
        "host": hosts or ["unknown"],
        "clis": clis,
        "routes_config": str(routes_module().config_path()),
        "routes": routes_module().load_routes(),
        "monitor": quota.monitor_command(),
        "cache_dir": str(default_agent_cache_dir()),
        "skill_installs": installs,
        "stale_copies": [loc for loc, info in installs.items() if not info["same_as_this"]],
        "peer_messaging": bundled_module("install_mailbox").configuration_status(),
    }
    if messaging_check is not None:
        report["messaging_check"] = messaging_check
    if args.format == "json":
        print(json.dumps(report, indent=2))
        return 0
    print(f"orchestrate {RUNNER_VERSION} at {skill_dir}")
    print(f"host: {', '.join(report['host'])}")
    for engine, info in clis.items():
        print(
            f"  {engine:<9} {info['executable'] or 'not installed'}{'  ' + info['version'] if info['version'] else ''}"
        )
    print(f"routes: {report['routes_config']} ({len(report['routes'])} roles; run `routes` for detail)")
    print(f"quota source: {report['monitor'] or 'monitor not installed (quota unknown, runs not blocked)'}")
    print(f"cache: {report['cache_dir']}")
    if messaging_check is not None:
        print(f"mailbox check: {len(messaging_check['round_trips'])} message/reply round trips passed")
    for location, info in installs.items():
        flag = "" if info["same_as_this"] else "  <- different copy: update or relink it"
        print(f"  skill {location}: {info['kind']} -> {info['resolves_to']}{flag}")
    for harness, state in report["peer_messaging"].items():
        summary = "configured" if state["configured"] else "; ".join(state["issues"])
        print(f"  mailbox {harness}: {summary}")
    if any(not row["configured"] for row in report["peer_messaging"].values()):
        print("Repair messaging with: doctor --repair-messaging (add --trust-codex-hooks only after review).")
    return 0


def quota_gate(
    engine: str,
    model: str,
    *,
    ignore: bool,
    claude_config_dir: Path | str | None = None,
    allow_credits: bool = False,
) -> None:
    """Refuse to launch into an exhausted subscription pool and warn when little is usable now.

    Quota is read live from monitor and never stored. Missing monitor means unknown quota, which
    does not block a run (the in-run credits watch still applies). A pool whose included allowance is
    used up but that has a credit balance (Codex) would bill that balance: refused unless the user
    allows credits, and then the run goes ahead and says so.
    """
    if ignore and allow_credits:
        return
    quota = bundled_module("quota")
    view = quota.snapshot()
    result = quota.check(engine, model, view, claude_config_dir=claude_config_dir)
    # --ignore-quota launches into an exhausted pool; it never implies permission to bill credits.
    if result["status"] == "credits" and not allow_credits:
        raise RunnerError(quota.credits_message(engine, model, result), EXIT_POOL_ON_CREDITS)
    if ignore:
        return
    if result["status"] == "blocked":
        raise RunnerError(quota.blocked_message(engine, model, result, view), quota.EXIT_QUOTA_EXHAUSTED)
    if result["status"] == "credits":
        emit_lifecycle(
            "quota_credits",
            pool=result.get("label"),
            balance=(result.get("credits") or {}).get("text"),
            included_quota_back=result.get("blockedUntil"),
        )
    if result["status"] == "low":
        emit_lifecycle(
            "quota_low",
            pool=result.get("label"),
            usable_now_pct=round(result.get("availableNowPct") or 0),
            advice=result.get("advice"),
        )


def quota_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog=f"{Path(__file__).name} quota",
        description="Live subscription quota for each executor route, read from monitor. Nothing is stored.",
    )
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    quota = bundled_module("quota")
    view = quota.snapshot()
    rows = quota.route_table(view, quota.openrouter_credit())
    if args.format == "json":
        print(
            json.dumps(
                {
                    "source": "monitor" if view else None,
                    "generated_at": view.get("generatedAt") if view else None,
                    "routes": rows,
                },
                indent=2,
            )
        )
        return 0
    if view is None:
        print("monitor is not installed or did not answer: quota unknown, runs are not blocked.")
    for row in rows:
        head = f"{row['engine']:<21} {row['models']:<21}"
        if row["engine"] == "opencode" or row["status"] in ("not_applicable", "unknown"):
            print(f"{head} {row['status']}: {row.get('detail', '')}")
            continue
        billing = " [personal]" if row.get("billing") == "personal" else ""
        if row["status"] == "credits":
            print(f"{head} {row['status']:<9} {quota.credits_text(row)}  {row['label']}{billing}: {row['advice']}")
            continue
        points = row.get("surplusPts")
        pace = f"{points:+d} pts" if isinstance(points, int) and row["status"] != "blocked" else ""
        print(
            f"{head} {row['status']:<9} {round(row['availableNowPct']):>3}% usable {pace:>8}  "
            f"{row['label']}{billing}: {row['advice']}"
        )
    return 0


parse_steer_args = _JOB_STEERING_MOD.parse_steer_args
read_steer_message = _JOB_STEERING_MOD.read_steer_message
read_json_file = _JOB_STEERING_MOD.read_json_file
find_steerable_job_dir = _JOB_STEERING_MOD.find_steerable_job_dir
runner_process_alive = _JOB_STEERING_MOD.runner_process_alive
steer_job_finished = _JOB_STEERING_MOD.steer_job_finished
steer_finished_error = _JOB_STEERING_MOD.steer_finished_error
wait_for_steer_response = _JOB_STEERING_MOD.wait_for_steer_response
steer_main = _JOB_STEERING_MOD.steer_main


def main() -> int:
    argv = sys.argv[1:]
    if argv and argv[0] == "probe":
        return probe_main(argv[1:])
    if argv and argv[0] == "horde":
        plugin_root = Path(__file__).resolve().parents[3]
        command = ["node", str(plugin_root / "bin" / "ork.mjs"), "horde", *argv[1:]]
        try:
            return subprocess.run(command, check=False).returncode
        except FileNotFoundError:
            print("run_agent.py horde requires Node.js (`node`) on PATH.", file=sys.stderr)
            return 127
        except OSError as exc:
            print(f"run_agent.py horde could not start Node.js: {exc}", file=sys.stderr)
            return 126
    if argv and argv[0] == "messages":
        print("run_agent.py messages was removed; use run_agent.py mailbox.", file=sys.stderr)
        return 4
    if argv and argv[0] == "mailbox":
        return bundled_module("peer_mailbox").main(argv[1:])
    if argv and argv[0] == "listen":
        return bundled_module("mailbox_listener").main(argv[1:])
    if argv and argv[0] == "steer":
        return steer_main(argv[1:])
    if argv and argv[0] == "consult":
        auto_prune()
        consult_mod = bundled_module("consult")
        if not any(flag in argv[1:] for flag in ("-h", "--help")):
            c_args = consult_mod.parse_args(argv[1:])
            if not c_args.request:
                c_req = consult_mod.build_request(c_args)
                target_cwd = Path(c_req["read"]) if c_req.get("read") else Path.cwd()
                enforce_repo_policy(target_cwd, c_req["engine"], c_req.get("claude_config_dir"))
        return consult_mod.main(argv[1:])
    if argv and argv[0] == "models":
        return models_main(argv[1:])
    if argv and argv[0] == "events":
        return events_main(argv[1:])
    if argv and argv[0] == "quota":
        return quota_main(argv[1:])
    if argv and argv[0] == "prune":
        return prune_main(argv[1:])
    if argv and argv[0] == "routes":
        return routes_main(argv[1:])
    if argv and argv[0] == "families":
        return families_main(argv[1:])
    if argv and argv[0] == "init":
        return init_main(argv[1:])
    if argv and argv[0] == "doctor":
        return doctor_main(argv[1:])
    args = resolve_route(parse_args(argv))
    host = args.host or detect_host()
    if decide_transport(args, host) == "native":
        return native_handoff(args, host)
    auto_prune()
    if args.detach:
        return execute(args)
    repo = git_root(args.cwd.expanduser().resolve())
    support = bundled_module("execution_support")
    # Determine the mutation contract before choosing a shared reader lease.
    # Stdin task inputs cannot be consumed twice, so keep their conservative exclusive lease.
    read_only = False
    if args.brief != "-" and args.task_spec != "-":
        _, spec = resolve_execution_brief(args, repo=repo)
        options = validated_run_options(args, task_spec=spec)
        read_only = not options[4]
    try:
        with support.workspace_lease(repo, default_agent_cache_dir(), read_only=read_only) as lease:
            return execute(args, lease=lease)
    except support.ContractError as exc:
        raise RunnerError(str(exc), 27) from exc


def probe_main(argv: list[str]) -> int:
    if "--target-repo" not in argv and "--cmd" not in argv:
        return bundled_module("probe_overlay").main(argv)

    parser = argparse.ArgumentParser(
        prog="run_agent.py probe",
        description="Run a candidate patch and test command in an isolated source overlay.",
    )
    parser.add_argument("--target-repo", type=Path, required=True, help="source repository to copy from")
    parser.add_argument("--copy", action="append", default=[], metavar="PATH", help="copy a repository-relative file")
    parser.add_argument("--patch", type=Path, required=True, help="candidate patch to apply inside the overlay")
    parser.add_argument("--cmd", required=True, help="test command and arguments, quoted as one string")
    args = parser.parse_args(argv)
    try:
        command = shlex.split(args.cmd)
    except ValueError as exc:
        print(f"run_agent.py probe: invalid --cmd: {exc}", file=sys.stderr)
        return 2
    if not command:
        print("run_agent.py probe: --cmd must contain an executable and arguments.", file=sys.stderr)
        return 2

    forwarded = ["--repo", str(args.target_repo)]
    for path in args.copy:
        forwarded.extend(["--copy", path])
    forwarded.extend(["--patch", str(args.patch), "--", *command])
    return bundled_module("probe_overlay").main(forwarded)


def usage_cost_source(previous: dict[str, Any] | None) -> dict[str, Any] | None:
    """The result whose executor recorded the resumed session's cost.

    A host recheck (coordinator reverify) invokes no model and records no cost of its own; the
    session's cumulative cost lives in the run it rechecked, so follow `verification_of` back to it.
    """
    source = previous
    for _ in range(4):
        if not isinstance(source, dict) or source.get("model_invoked") is not False:
            break
        rechecked = (source.get("verification_of") or {}).get("path")
        try:
            source = json.loads(Path(rechecked).read_text(encoding="utf-8")) if rechecked else None
        except (OSError, ValueError):
            source = None
    if not isinstance(source, dict) or source.get("model_invoked") is False:
        return None
    return source


def execute(args: argparse.Namespace, *, lease: int | None = None) -> int:
    if args.job_dir and not args.detach:
        raise RunnerError("--job-dir requires --detach", 4)
    if (args.notify or args.completion_hook) and not (args.detach or args.completion_event):
        raise RunnerError("--notify and --completion-hook are only valid with --detach", 4)
    cwd_initial = args.cwd.expanduser().resolve()
    if cwd_initial.is_dir():
        auto_claude_dir = enforce_repo_policy(cwd_initial, args.engine, getattr(args, "claude_config_dir", None))
        if auto_claude_dir is not None and getattr(args, "claude_config_dir", None) is None:
            args.claude_config_dir = auto_claude_dir
    if args.detach:
        return launch_detached(args)
    completion_event_path = normalize_completion_event_path(args.completion_event) if args.completion_event else None
    notification_mode = args.notify or "none"
    completion_hook = resolve_completion_hook(args.completion_hook)
    steering: JobSteering | None = None
    if args.steer_dir is not None:
        if completion_event_path is None or args.out_dir is None:
            raise RunnerError("--steer-dir is internal to detached jobs", 4)
        steering = JobSteering(args.steer_dir.expanduser().resolve(), engine=args.engine, deadline=args.deadline)
    started_at = utc_now()
    monotonic_start = time.monotonic()
    model = args.model or preferred_model(args.engine)
    # resolve_route() already applied the route's effort when the model is the route's model.
    selected_effort = args.effort
    cwd = args.cwd.expanduser().resolve()
    if not cwd.is_dir():
        raise RunnerError(f"target directory does not exist: {cwd}", 4)
    repo = git_root(cwd)
    if cwd != repo:
        raise RunnerError(f"--cwd must be the Git repository root: {repo}", 4)
    brief, task_spec = resolve_execution_brief(args, repo=repo)
    (
        variant,
        add_dirs,
        allowed_paths,
        tracked_paths,
        enforced_paths,
        timeout_seconds,
        verify_timeout_seconds,
    ) = validated_run_options(args, task_spec=task_spec)
    brief, task_spec, allowed_paths, enforced_paths, scope_info = apply_upward_delegation_policy(
        args,
        repo=repo,
        brief=brief,
        task_spec=task_spec,
        allowed_paths=allowed_paths,
        tracked_paths=tracked_paths,
        enforced_paths=enforced_paths,
        worker_model=resume_pinned_model(args) or model,
        emit_note=steering is None,
    )
    if steering is not None:
        steering.allowed_paths = list(allowed_paths)
        steering.tracked_paths = list(tracked_paths)
        steering.enforced_paths = list(enforced_paths)
    launch_allowed_paths = list(allowed_paths)

    def steer_released(path: str) -> bool:
        """A path a steer allowed after launch (live or interrupting) is no longer a gate: the user opened it."""
        if steering is None:
            return False
        added = [str(entry) for entry in steering.allowed_paths if entry not in launch_allowed_paths]
        return any(add == "." or path == add or path.startswith(f"{add}/") for add in added)

    ensure_hook_outside_workspaces(completion_hook, [repo, *add_dirs])
    out_dir = prepare_out_dir(args.out_dir, repo)
    result_path = out_dir / "result.json"
    scratch_dir = prepare_scratch_dir(out_dir) if not enforced_paths else None
    if scratch_dir is not None:
        add_dirs = [*add_dirs, scratch_dir]
    mailbox_module = bundled_module("peer_mailbox")
    mailbox_run_id = bundled_module("peer_mailbox").run_id_for(
        args.mailbox_run_id or (completion_event_path.stem if completion_event_path else foreground_run_name(out_dir))
    )
    if steering is not None:
        steering.mailbox_run = mailbox_run_id
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
    print(f"AGENT_MAILBOX={mailbox_info['conductor']}", flush=True)
    original_brief_path = out_dir / "brief.txt"
    submitted_brief_path = out_dir / "submitted-brief.txt"
    stdout_path = out_dir / "stdout.txt"
    stderr_path = out_dir / "stderr.txt"
    log_path = out_dir / "executor.log"
    final_output_path = out_dir / "final-output.txt"
    write_private_text(original_brief_path, brief + "\n")
    contract_text = REPORT_CONTRACT + (AGY_ONESHOT_GUARDRAIL if args.engine == "agy" else "")
    scratch_note = scratch_brief_note(scratch_dir) if scratch_dir is not None else ""
    submitted_brief = f"{brief}\n{scratch_note}\n{contract_text}\n{mailbox_module.run_instructions(mailbox_run_id)}"
    write_private_text(submitted_brief_path, submitted_brief)
    write_private_text(log_path, "")
    write_private_text(final_output_path, "")

    try:
        (
            executable,
            version,
            available_models,
            model,
            model_selection,
            model_catalog,
        ) = executor_preflight(
            args.engine,
            resume_pinned_model(args),
            refresh=args.refresh_models,
        )
        quota_gate(
            args.engine,
            model,
            ignore=args.ignore_quota or args.dry_run,
            claude_config_dir=args.claude_config_dir,
            allow_credits=args.allow_credits or args.dry_run,
        )
        support = bundled_module("execution_support")
        try:
            effort = support.bind_effort(args.engine, model, selected_effort, model_catalog)
            previous_result = None
            if args.resume_result:
                previous_result = json.loads(args.resume_result.expanduser().read_text(encoding="utf-8"))
                support.validate_resume(
                    previous_result,
                    {
                        "repository": str(repo),
                        "session_id": args.session,
                        "engine": args.engine,
                        "model": model,
                        "variant": variant,
                        "executor_version": version,
                        "effort": effort["bound"],
                        "allowed_paths": enforced_paths,
                        "tracked_paths": tracked_paths,
                        "verification_commands": args.verify_command,
                        "billing_mode": args.billing_mode,
                    },
                )
        except support.ContractError as error:
            raise RunnerError(str(error), 4) from error
        except (OSError, ValueError, TypeError) as error:
            raise RunnerError(f"invalid --resume-result: {error}", 4) from error
    except RunnerError as exc:
        result = {
            "schema": RESULT_SCHEMA,
            "runner_version": RUNNER_VERSION,
            "status": "preflight_failed",
            "task_outcome": "failed",
            "reported_outcome": None,
            "exit_code": exc.exit_code,
            "error": str(exc),
            "started_at": started_at,
            "finished_at": utc_now(),
            "engine": args.engine,
            "model": model,
            "requested_model": args.model,
            **({"route": args.route, "task_archetype": args.route} if args.route else {}),
            "requested_effort": selected_effort,
            "variant": variant,
            "full_permissions": True,
            "repository": str(repo),
            "verification": verification_summary(
                args.verify_command,
                status="skipped" if args.verify_command else "not_requested",
                skipped_reason=("preflight_failed" if args.verify_command else None),
            ),
            "mailbox": mailbox_info,
        }
        return finish_run(
            result=result,
            result_path=result_path,
            completion_event_path=completion_event_path,
            notification_mode=notification_mode,
            completion_hook=completion_hook,
        )

    if not args.dry_run and previous_result is None and enforced_paths:
        bundled_module("repo_env").bootstrap_worktree_env(repo, overwrite=False)
    before = git_state(repo, tracked_paths)
    git_identity_before = git_identity(repo)
    git_metadata_before = git_metadata_snapshot(repo) if not enforced_paths else {}
    git_activity_before = git_activity(repo)
    if previous_result is not None and (
        (bool(enforced_paths) and previous_result.get("git_after", {}).get("fingerprint") != before["fingerprint"])
        or previous_result.get("git_identity_after") != git_identity_before
    ):
        raise RunnerError("workspace or history changed since the resume result; investigate before correction", 4)
    agy_stdin = args.engine == "agy" and version_at_least(version, AGY_STDIN_MIN_VERSION)
    # The session this segment runs in, when known before the executor prints it.
    segment_session: str | None = args.session or (
        str(uuid.uuid4()) if args.engine == "claude" and not args.continue_last else None
    )
    segment_resumed = bool(args.session or args.continue_last)
    stdin_path = submitted_brief_path
    if agy_stdin:
        stdin_path = submitted_brief_path.with_name("agy-input.jsonl")
        stdin_path.write_bytes(agy_stream_input(submitted_brief_path.read_text(encoding="utf-8")))
    command = build_executor_command(
        executable=executable,
        engine=args.engine,
        model=model,
        variant=variant,
        repo=repo,
        add_dirs=add_dirs,
        session_id=args.session,
        continue_last=args.continue_last,
        timeout=args.timeout,
        submitted_brief_path=submitted_brief_path,
        final_output_path=final_output_path,
        log_path=log_path,
        effort=effort["bound"] if args.engine in ("codex", "claude") else None,
        agy_stdin=agy_stdin,
        new_session_id=segment_session if args.engine == "claude" and not segment_resumed else None,
        executor_version=version,
    )

    auto_correct_module = bundled_module("auto_correct")
    max_rounds, rounds_source = auto_correct_module.effective_rounds(
        getattr(args, "auto_correct", None), task_spec, args.verify_command
    )
    # The gate's own files, as named before the first handoff; a file written later is never one.
    gate_candidates = auto_correct_module.gate_paths(args.verify_command, repo) if max_rounds else []
    if max_rounds and previous_result is not None:
        saved_candidates = (previous_result.get("auto_correct") or {}).get("gate_candidates")
        if isinstance(saved_candidates, list):
            gate_candidates = saved_candidates
        changed_before_resume = set((previous_result.get("run_delta") or {}).get("changed_paths", []))
        gate_candidates = [path for path in gate_candidates if path not in changed_before_resume]
    # Every auto-correct round of this run; absent when the run may use none, so N=0 results are unchanged.
    auto_correct: dict[str, Any] | None = (
        {
            "max_rounds": max_rounds,
            "source": rounds_source,
            "mode": "executor",
            "gate_candidates": list(gate_candidates),
            "rounds_used": 0,
            "outcome": "not_run",
            "refused_reason": None,
            "stop_reason": None,
            "converted_from": None,
            "executor_seconds": 0.0,
            "initial_verification": None,
            "rounds": [],
        }
        if max_rounds
        else None
    )

    base_result: dict[str, Any] = {
        "schema": RESULT_SCHEMA,
        "runner_version": RUNNER_VERSION,
        "engine": args.engine,
        "executor_version": version,
        "model": model,
        "requested_model": args.model,
        **({"route": args.route, "task_archetype": args.route} if args.route else {}),
        "resolved_model": None,
        "effort": effort,
        "billing_mode": args.billing_mode,
        "resumed_from": str(args.resume_result.expanduser().resolve()) if args.resume_result else None,
        "variant": variant,
        "model_preflight": MODEL_PREFLIGHT[model_selection],
        "model_selection": model_selection,
        "model_catalog": {
            "source": model_catalog.get("source"),
            "discovered_at": model_catalog.get("discovered_at"),
            "cache": model_catalog.get("cache"),
            "available_model_count": len(available_models),
        },
        "full_permissions": True,
        "sandbox": False,
        "repository": str(repo),
        "task_input": "task_spec" if task_spec is not None else "brief",
        "started_at": started_at,
        "command": command_preview(command),
        "brief_path": str(original_brief_path),
        "submitted_brief_path": str(submitted_brief_path),
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
        "log_path": str(log_path),
        "final_output_path": str(final_output_path),
        "git_before": before,
        "git_identity_before": git_identity_before,
        "allowed_paths": enforced_paths,
        "tracked_paths": tracked_paths,
        "scope_owner": scope_info["scope_owner"],
        "conductor_model": scope_info["conductor_model"],
        "scope_hints": scope_info["scope_hints"],
        "expected_changes": args.expect_changes,
        "retry_read_only": args.retry_read_only,
        "heartbeat_seconds": args.heartbeat_seconds,
        "verification_commands": args.verify_command,
        "verification_timeout": args.verify_timeout,
        "deadline": args.deadline,
        "mailbox": mailbox_info,
        **({"auto_correct": auto_correct} if auto_correct is not None else {}),
    }

    if args.dry_run:
        result = {
            **base_result,
            "status": "dry_run",
            "task_outcome": "not_run",
            "reported_outcome": None,
            "exit_code": 0,
            "finished_at": utc_now(),
            "duration_seconds": round(time.monotonic() - monotonic_start, 3),
            "git_after": before,
            "git_identity_after": git_identity_before,
            "run_delta": {"changed_paths": [], "tracked_paths_changed": []},
            "scope_violations": [],
            "history_violations": [],
            "workspace_changed": False,
            "workspace_changed_after_executor": False,
            "verification_changed_workspace": False,
            "verification_delta": {
                "changed_paths": [],
                "tracked_paths_changed": [],
            },
            "verification": verification_summary(
                args.verify_command,
                status="dry_run",
            ),
            "report_extracted": False,
            "report_contract_valid": False,
            "report_contract_violations": ["missing_heading:STATUS"],
            "final_message": "",
        }
        return finish_run(
            result=result,
            result_path=result_path,
            completion_event_path=completion_event_path,
            notification_mode=notification_mode,
            completion_hook=completion_hook,
        )

    environment = executor_environment(
        args.engine,
        repo,
        args.claude_config_dir,
        session_id=segment_session,
        read_only=not enforced_paths,
    )
    # A delegated worker owns its own mailbox identity, even when its conductor is a listener.
    environment.pop("AGENT_MAILBOX_LISTENER_SESSION", None)
    environment["AGENT_MAILBOX_SESSION"] = mailbox_info["worker"]
    environment["AGENT_MAILBOX_PEER"] = mailbox_info["conductor"]
    remaining = deadline_remaining(args.deadline)
    if remaining is not None and remaining <= 0:
        raise RunnerError("task deadline expired before executor dispatch", 28)
    usage_module = bundled_module("usage")
    usage_baseline = (previous_result or {}).get("usage", {}).get("cumulative")
    usage_baseline_cost = None
    cost_source = usage_cost_source(previous_result)
    if previous_result and cost_source is not None:
        for prior_attempt in reversed(cost_source.get("executor_attempts", [])):
            prior_stdout = Path(prior_attempt.get("stdout_path") or "")
            if prior_stdout.is_file():
                usage_baseline_cost = usage_module.latest_cost(
                    args.engine, prior_stdout.read_text(encoding="utf-8", errors="replace")
                )
                if usage_baseline_cost is not None:
                    break
        if usage_baseline_cost is None:
            candidate_cost = (cost_source.get("usage") or {}).get("native_cost_usd")
            if isinstance(candidate_cost, int | float) and not isinstance(candidate_cost, bool):
                usage_baseline_cost = candidate_cost
    attempt_usage: list[dict[str, Any]] = []
    executor_attempts: list[dict[str, Any]] = []
    attempt_number = 0
    segment = 0
    segment_attempts_start = 0
    segment_usage_start = 0
    steers_applied: list[dict[str, Any]] = []
    steered_from: list[str] = []
    # Auto-correct rounds share --timeout: a round gets the executor time that earlier attempts left.
    round_timeout_seconds = timeout_seconds
    executor_seconds_used = 0.0
    total_executor_seconds_used = 0.0
    retry_window_start = 0
    correction_round = 0
    rounds_started = 0
    gates: list[str] = []
    gates_before: dict[str, Any] = {}
    gate_edit_violations: list[str] = []
    round_attempts_start = 0
    round_before = before
    round_started = monotonic_start
    round_executor_start = 0.0
    round_wait_until: float | None = None
    last_handoff: dict[str, Any] = {}
    if steering is not None:
        assert completion_event_path is not None
        steering.begin_segment(
            segment=segment,
            result_path=result_path,
            event_path=completion_event_path,
            stdout_path=stdout_path,
            log_path=log_path,
            session_hint=segment_session,
        )
    credits_watch = (
        CodexCreditsWatch(environment, lambda: executor_session_so_far("codex", stdout_path, log_path) or args.session)
        if args.engine == "codex" and not args.allow_credits
        else None
    )

    def poll_executor(process: subprocess.Popen[bytes]) -> bool:
        if credits_watch is not None and credits_watch.poll(process):
            return True
        return steering.poll(process) if steering is not None else False

    while True:  # one pass per round: the handoff, then each auto-correct round
        while True:
            attempt_number += 1
            attempt_start = time.monotonic()
            remaining = deadline_remaining(args.deadline)
            if round_wait_until is not None and remaining is not None:
                remaining = min(remaining, round_wait_until - attempt_start)
            mailbox_module.set_run_deadline(
                mailbox_module.root(),
                mailbox_run_id,
                (
                    dt.datetime.now(dt.UTC)
                    + dt.timedelta(
                        seconds=min(round_timeout_seconds + 60, max(0, remaining))
                        if remaining is not None
                        else round_timeout_seconds + 60
                    )
                ).isoformat(),
            )
            stdin_handle: Any = (
                stdin_path.open("rb") if args.engine in ("codex", "claude") or agy_stdin else subprocess.DEVNULL
            )
            try:
                emit_lifecycle(
                    "executor_started",
                    engine=args.engine,
                    model=model,
                    attempt=attempt_number,
                )
                with (
                    open_private_binary(stdout_path) as stdout_handle,
                    open_private_binary(stderr_path) as stderr_handle,
                ):
                    process = subprocess.Popen(
                        command,
                        cwd=repo,
                        env=environment,
                        stdin=stdin_handle,
                        stdout=stdout_handle,
                        stderr=stderr_handle,
                        start_new_session=True,
                    )
                    if steering is not None:
                        steering.executor_started(process.pid)
                    with forward_termination_signals(process):
                        timed_out = wait_with_heartbeats(
                            process,
                            timeout_seconds=min(round_timeout_seconds + 60, max(0, remaining))
                            if remaining is not None
                            else round_timeout_seconds + 60,
                            heartbeat_seconds=args.heartbeat_seconds,
                            monotonic_start=monotonic_start,
                            poll=functools.partial(poll_executor, process)
                            if steering is not None or credits_watch is not None
                            else None,
                        )
            finally:
                if stdin_handle is not subprocess.DEVNULL:
                    stdin_handle.close()
            attempt_duration = time.monotonic() - attempt_start
            executor_seconds_used += attempt_duration
            total_executor_seconds_used += attempt_duration

            for artifact in (stdout_path, stderr_path, log_path, final_output_path):
                if artifact.exists():
                    artifact.chmod(0o600)
            stdout_bytes = stdout_path.read_bytes() if stdout_path.exists() else b""
            stderr_bytes = stderr_path.read_bytes() if stderr_path.exists() else b""
            stdout_text = stdout_bytes.decode("utf-8", errors="replace")
            stderr_text = stderr_bytes.decode("utf-8", errors="replace")
            usage = usage_module.normalize_usage(
                args.engine,
                stdout_text,
                resumed=segment_resumed,
                baseline=usage_baseline,
                baseline_cost=usage_baseline_cost,
                delta_accounting=auto_correct is not None,
            )
            attempt_cumulative_cost = usage_module.latest_cost(args.engine, stdout_text)
            attempt_usage.append(usage)
            if segment_resumed:
                usage_baseline = usage.get("cumulative") or usage_baseline
            if attempt_cumulative_cost is not None:
                usage_baseline_cost = attempt_cumulative_cost
            after_attempt = git_state(repo, tracked_paths)
            git_identity_after_attempt = git_identity(repo)
            attempt_delta = state_delta(before, after_attempt)
            attempt_history_violations = find_history_violations(git_identity_before, git_identity_after_attempt)
            attempt_workspace_changed = before["fingerprint"] != after_attempt["fingerprint"]
            if (
                args.engine == "opencode"
                and process.returncode not in (None, 0)
                and attempt_number == 1
                and not attempt_workspace_changed
                and not attempt_history_violations
            ):
                fresh_ver = get_cached_cli_version(executable, environment, force_refresh=True)
                if opencode_major_version(fresh_ver) != opencode_major_version(version):
                    version = fresh_ver
                    command = build_executor_command(
                        executable=executable,
                        engine=args.engine,
                        model=model,
                        variant=variant,
                        repo=repo,
                        add_dirs=add_dirs,
                        session_id=args.session,
                        continue_last=args.continue_last,
                        timeout=args.timeout,
                        submitted_brief_path=submitted_brief_path,
                        final_output_path=final_output_path,
                        log_path=log_path,
                        effort=effort["bound"] if args.engine in ("codex", "claude") else None,
                        agy_stdin=agy_stdin,
                        new_session_id=segment_session if args.engine == "claude" and not segment_resumed else None,
                        executor_version=version,
                    )
                    base_result.update(command=command_preview(command), executor_version=version)
                    attempt_usage.clear()
                    continue
            # agy reports provider errors (e.g. 429) as a terminal status with exit 0; count those as well.
            terminal_error = provider_terminal_error(args.engine, stdout_text)
            quota_structured = structured_quota_signal(args.engine, stdout_text)
            transient_failure = (
                not timed_out
                and not quota_structured
                and (process.returncode not in (None, 0) or terminal_error is not None)
                and transient_provider_failure(stderr_text, terminal_error)
            )
            steered = steering is not None and steering.pending is not None
            credits_stopped = credits_watch is not None and credits_watch.stopped is not None
            retry_eligible = (
                not steered
                and not credits_stopped
                and args.retry_read_only > len(executor_attempts) - retry_window_start
                and transient_failure
                and not attempt_workspace_changed
                and not attempt_history_violations
                and (args.deadline is None or deadline_remaining(args.deadline) > 0)
            )
            attempt_record: dict[str, Any] = {
                "attempt": attempt_number,
                "segment": segment,
                "steered": steered,
                "executor_exit_code": process.returncode,
                "timed_out": timed_out,
                "transient_provider_failure": transient_failure,
                "workspace_changed": attempt_workspace_changed,
                "history_violations": attempt_history_violations,
                "run_delta": attempt_delta,
                "usage": usage,
            }
            emit_lifecycle(
                "executor_finished",
                exit_code=process.returncode,
                changed_files=len(attempt_delta["changed_paths"]),
                attempt=attempt_number,
            )
            if retry_eligible:
                attempt_record["retrying"] = True
                attempt_record.update(
                    archive_executor_attempt_artifacts(
                        out_dir=out_dir,
                        attempt=attempt_number,
                        stdout_path=stdout_path,
                        stderr_path=stderr_path,
                        log_path=log_path,
                        final_output_path=final_output_path,
                    )
                )
                executor_attempts.append(attempt_record)
                if args.engine == "claude" and not segment_resumed:
                    segment_session = str(uuid.uuid4())
                    environment["CLAUDE_CODE_SESSION_ID"] = segment_session
                    command = build_executor_command(
                        executable=executable,
                        engine=args.engine,
                        model=model,
                        variant=variant,
                        repo=repo,
                        add_dirs=add_dirs,
                        session_id=args.session,
                        continue_last=args.continue_last,
                        timeout=args.timeout,
                        submitted_brief_path=submitted_brief_path,
                        final_output_path=final_output_path,
                        log_path=log_path,
                        effort=effort["bound"] if args.engine in ("codex", "claude") else None,
                        agy_stdin=agy_stdin,
                        new_session_id=segment_session,
                        executor_version=version,
                    )
                    base_result.update(command=command_preview(command))
                    if steering is not None:
                        steering.session_hint = segment_session
                        steering.save(session_id=segment_session)
                time.sleep(min(float(attempt_number), 3.0))
                continue

            attempt_record["retrying"] = False
            attempt_record.update(
                {
                    "stdout_path": str(stdout_path),
                    "stderr_path": str(stderr_path),
                    "log_path": str(log_path),
                    "final_output_path": str(final_output_path),
                }
            )
            executor_attempts.append(attempt_record)
            if steering is not None:
                allowed_paths = list(steering.allowed_paths)
                enforced_paths = list(steering.enforced_paths)
                base_result["allowed_paths"] = enforced_paths
                if "." in enforced_paths:
                    base_result["scope_owner"] = "worker"
            if steered:
                assert steering is not None and steering.pending is not None and completion_event_path is not None
                pending = steering.pending
                # Recorded, not final: the steered turn may still restore these, and the gates stay protected.
                interrupted_gate_changes = [
                    path for path in gates if path_fingerprint(repo / path) != gates_before.get(path)
                ]
                if correction_round and auto_correct is not None:
                    auto_correct["rounds"][-1].update(
                        finished_at=utc_now(),
                        duration_seconds=round(time.monotonic() - round_started, 3),
                        executor_seconds=round(executor_seconds_used - round_executor_start, 3),
                        attempts=[attempt["attempt"] for attempt in executor_attempts[round_attempts_start:]],
                        status="steered",
                        executor_exit_code=process.returncode,
                        timed_out=timed_out,
                        reported_outcome=None,
                        report_contract_valid=None,
                        report_contract_violations=[],
                        final_message="",
                        run_delta=state_delta(round_before, after_attempt),
                        gate_files_changed=interrupted_gate_changes,
                        verification=verification_summary(
                            args.verify_command,
                            status="skipped",
                            skipped_reason="steered",
                        ),
                    )
                # A steer starts a fresh user-controlled segment. Keep the global round count and
                # completed round records, but do not let mechanical-round timing leak into it.
                correction_round = 0
                executor_seconds_used = 0.0
                round_timeout_seconds = timeout_seconds
                round_wait_until = None
                # The interrupted round's gates stay protected through the steered turn, judged on the
                # workspace it leaves; only a path the steer explicitly allowed stops being a gate.
                gates = [path for path in gates if not steer_released(path)]
                gates_before = {path: gates_before[path] for path in gates if path in gates_before}
                round_attempts_start = len(executor_attempts)
                retry_window_start = len(executor_attempts)
                round_before = after_attempt
                round_started = time.monotonic()
                round_executor_start = 0.0
                last_handoff = {}
                # Close this segment: a superseded result and an already-acknowledged event pointing at the
                # continuation, so `events wait` follows it and the inbox shows only the combined result.
                steered_result = {
                    **base_result,
                    "status": "steered",
                    "task_outcome": "steered",
                    "reported_outcome": None,
                    "exit_code": None,
                    "executor_exit_code": process.returncode,
                    "executor_attempts": executor_attempts[segment_attempts_start:],
                    "finished_at": utc_now(),
                    "session_id": pending["session_id"],
                    "segment": segment,
                    "run_delta_at_interrupt": attempt_delta,
                    "history_violations_at_interrupt": attempt_history_violations,
                    "scope_violations_at_interrupt": [
                        *find_scope_violations(attempt_delta, enforced_paths),
                        *(f"gate-edit:{path}" for path in interrupted_gate_changes),
                    ],
                    "usage": usage_module.combine_attempts(attempt_usage[segment_usage_start:]),
                    "steered_to": {key: pending[key] for key in ("steer_id", "event_id", "event_path", "result_path")},
                }
                write_json_atomic(result_path, steered_result)
                publish_completion_event(
                    result=steered_result,
                    result_path=result_path,
                    event_path=completion_event_path,
                    notification_mode="none",
                    completion_hook=None,
                    extra={
                        "acknowledged_at": utc_now(),
                        "superseded_by": pending["event_id"],
                        "steer_id": pending["steer_id"],
                        "steered_from": list(steered_from),
                    },
                )
                steered_from.append(completion_event_path.stem)
                steers_applied.append({key: value for key, value in pending.items() if key != "message"})
                # Open the continuation: same session, worktree, scope and delivery, with fresh segment
                # budgets and no active mechanical round; only the artifact directory and user turn differ.
                segment += 1
                segment_attempts_start = retry_window_start = len(executor_attempts)
                segment_usage_start = len(attempt_usage)
                segment_session = pending["session_id"]
                if args.engine == "claude" and segment_session:
                    environment["CLAUDE_CODE_SESSION_ID"] = segment_session
                segment_resumed = True
                usage_baseline = usage.get("cumulative") or usage_baseline
                if attempt_cumulative_cost is not None:
                    usage_baseline_cost = attempt_cumulative_cost
                out_dir = Path(pending["run_dir"])
                result_path = out_dir / "result.json"
                completion_event_path = normalize_completion_event_path(Path(pending["event_path"]))
                _ACTIVE_SEGMENT.update(event_path=completion_event_path, result_path=result_path)
                submitted_brief_path = out_dir / "submitted-brief.txt"
                stdout_path = out_dir / "stdout.txt"
                stderr_path = out_dir / "stderr.txt"
                log_path = out_dir / "executor.log"
                final_output_path = out_dir / "final-output.txt"
                write_private_text(
                    submitted_brief_path,
                    steering_brief(
                        pending["message"],
                        steer_id=pending["steer_id"],
                        allowed_paths=enforced_paths,
                        verify_commands=args.verify_command,
                        expect_changes=args.expect_changes,
                        engine=args.engine,
                        added_allow_paths=pending.get("added_allow_paths"),
                    )
                    + mailbox_module.run_instructions(mailbox_run_id),
                )
                write_private_text(log_path, "")
                write_private_text(final_output_path, "")
                stdin_path = submitted_brief_path
                if agy_stdin:
                    stdin_path = out_dir / "agy-input.jsonl"
                    stdin_path.write_bytes(agy_stream_input(submitted_brief_path.read_text(encoding="utf-8")))
                    stdin_path.chmod(0o600)
                command = build_executor_command(
                    executable=executable,
                    engine=args.engine,
                    model=model,
                    variant=variant,
                    repo=repo,
                    add_dirs=add_dirs,
                    session_id=segment_session,
                    continue_last=False,
                    timeout=args.timeout,
                    submitted_brief_path=submitted_brief_path,
                    final_output_path=final_output_path,
                    log_path=log_path,
                    effort=effort["bound"] if args.engine in ("codex", "claude") else None,
                    agy_stdin=agy_stdin,
                    executor_version=version,
                )
                base_result.update(
                    command=command_preview(command),
                    submitted_brief_path=str(submitted_brief_path),
                    stdout_path=str(stdout_path),
                    stderr_path=str(stderr_path),
                    log_path=str(log_path),
                    final_output_path=str(final_output_path),
                )
                steering.begin_segment(
                    segment=segment,
                    result_path=result_path,
                    event_path=completion_event_path,
                    stdout_path=stdout_path,
                    log_path=log_path,
                    session_hint=segment_session,
                )
                emit_lifecycle("steer_resumed", steer=pending["steer_id"], session=segment_session)
                continue
            if steering is not None:
                steering.save(phase="auditing", executor_pid=None)
            after_executor = after_attempt
            git_identity_after_executor = git_identity_after_attempt
            run_delta_after_executor = attempt_delta
            history_violations_after_executor = attempt_history_violations
            workspace_changed_after_executor = attempt_workspace_changed
            break

        session_id: str | None
        agy_status = None
        if args.engine == "codex":
            candidate_message = (
                final_output_path.read_text(encoding="utf-8", errors="replace") if final_output_path.exists() else ""
            )
            session_id = parse_codex_session_id(stdout_text)
        elif args.engine == "opencode":
            candidate_message, session_id = parse_opencode_output(stdout_text)
        elif args.engine == "claude":
            candidate_message, session_id, agy_status, _claude_error = parse_claude_output(stdout_text)
            final_output_path.write_text(candidate_message, encoding="utf-8")
            final_output_path.chmod(0o600)
        else:
            candidate_message, session_id, agy_status = parse_agy_output(stdout_text)
            session_id = session_id or parse_agy_session_id(log_path)
            final_output_path.write_text(candidate_message, encoding="utf-8")
            final_output_path.chmod(0o600)
        session_id = session_id or segment_session
        provider_error = provider_terminal_error(args.engine, stdout_text)
        if (
            args.engine == "agy"
            and not timed_out
            and not candidate_message.strip()
            and (
                (round_timeout_seconds >= 10 and attempt_duration >= round_timeout_seconds - 5)
                or "timed out" in (provider_error or "").lower()
                or "timed out" in stderr_text.lower()
            )
        ):
            timed_out = True
            if executor_attempts:
                executor_attempts[-1]["timed_out"] = True
        raw_report, report_extracted = extract_raw_final_report(candidate_message)
        final_message = bound_final_message(raw_report)
        reported_outcome = parse_reported_outcome(
            raw_report,
            report_extracted,
        )
        report_violations = report_contract_violations(
            raw_report,
            report_extracted,
        )
        if agy_status is not None and agy_status != "success":
            if agy_status == "waiting_for_input":
                reported_outcome = "blocked"
            elif not (
                process.returncode == 0
                and report_extracted
                and not report_violations
                and reported_outcome in {"complete", "partial", "blocked"}
                and bool(provider_error)
            ):
                reported_outcome = "failed"
        report_contract_valid = not report_violations
        consultation = support.consultation_from_report(raw_report, reported_outcome)
        if consultation["status"] == "invalid":
            report_violations.append("invalid_consultation_request")
            report_contract_valid = False
        scope_violations_after_executor = find_scope_violations(
            run_delta_after_executor,
            enforced_paths,
        )
        scratch_report = collect_scratch_artifacts(scratch_dir) if scratch_dir is not None else None
        if scratch_report is not None:
            scope_violations_after_executor = [
                *scope_violations_after_executor,
                *(f"scratch-escape:{item}" for item in scratch_report["escapes"]),
            ]
            scope_violations_after_executor = [
                *scope_violations_after_executor,
                *find_git_metadata_changes(git_metadata_before, git_metadata_snapshot(repo)),
            ]
        # A correction round must fix the work, not the gate: changing a file the gates name fails the run.
        gates = [path for path in gates if not steer_released(path)]
        gate_violations = [
            f"gate-edit:{path}" for path in gates if path_fingerprint(repo / path) != gates_before.get(path)
        ]
        gate_edit_violations = list(dict.fromkeys([*gate_edit_violations, *gate_violations]))
        scope_violations_after_executor = [*scope_violations_after_executor, *gate_edit_violations]

        preliminary_status, preliminary_exit_code = classify_result(
            history_violations=history_violations_after_executor,
            scope_violations=scope_violations_after_executor,
            timed_out=timed_out,
            executor_exit_code=process.returncode,
            stdout_present=bool(candidate_message.strip()),
            report_extracted=report_extracted,
            expect_changes=args.expect_changes,
            workspace_changed=workspace_changed_after_executor,
            reported_outcome=reported_outcome,
            report_contract_valid=report_contract_valid,
        )

        if (
            credits_watch is not None
            and credits_watch.stopped is not None
            and preliminary_status not in {"history_violation", "scope_violation"}
        ):
            # The partial work stays audited and preserved but is never verified or accepted as complete.
            preliminary_status, preliminary_exit_code = "stopped_credits", EXIT_STOPPED_CREDITS

        verification_seconds = 0.0
        if preliminary_status == "completed":
            emit_lifecycle(
                "verification_started",
                commands=len(args.verify_command),
            )
            verification_start = time.monotonic()
            verification = run_verification_commands(
                args.verify_command,
                repo=repo,
                out_dir=out_dir,
                timeout_seconds=verify_timeout_seconds,
                deadline=args.deadline,
                lease=lease,
            )
            verification_seconds = time.monotonic() - verification_start
            emit_lifecycle(
                "verification_finished",
                status=verification["status"],
                completed=verification["completed_count"],
            )
        else:
            verification = verification_summary(
                args.verify_command,
                status="skipped" if args.verify_command else "not_requested",
                skipped_reason=(f"runner_status:{preliminary_status}" if args.verify_command else None),
            )

        after = git_state(repo, tracked_paths)
        git_identity_after = git_identity(repo)
        git_activity_after = git_activity(repo)
        run_delta = state_delta(before, after)
        verification_delta = state_delta(after_executor, after)
        history_violations = find_history_violations(
            git_identity_before,
            git_identity_after,
        )
        scope_violations = find_scope_violations(run_delta, enforced_paths)
        scratch_report = collect_scratch_artifacts(scratch_dir) if scratch_dir is not None else None
        if scratch_report is not None:
            scope_violations = [*scope_violations, *(f"scratch-escape:{item}" for item in scratch_report["escapes"])]
            scope_violations = [
                *scope_violations,
                *find_git_metadata_changes(git_metadata_before, git_metadata_snapshot(repo)),
            ]
        scope_violations = [*scope_violations, *gate_edit_violations]
        workspace_changed = before["fingerprint"] != after["fingerprint"]
        verification_changed_workspace = (
            verification["completed_count"] > 0 and after_executor["fingerprint"] != after["fingerprint"]
        )

        status, exit_code = preliminary_status, preliminary_exit_code
        if history_violations:
            status, exit_code = "history_violation", 21
        elif scope_violations:
            status, exit_code = "scope_violation", 22
        elif verification_changed_workspace:
            status, exit_code = "verification_mutation", 26
        elif verification["status"] in {"failed", "timed_out"}:
            status, exit_code = "verification_failed", 25

        if auto_correct is None:
            break
        round_status = status
        if correction_round:
            # The same evidence the final classification requires: a provider failure, a structured
            # quota signal or a non-zero exit, and quota text on the provider's error channels only.
            round_quota_structured = structured_quota_signal(args.engine, stdout_text)
            round_provider_failed = provider_error is not None or (
                args.engine == "agy" and agy_status not in (None, "success", "waiting_for_input")
            )
            if (
                status in {"failed", "malformed_report", "empty_output"}
                and (round_provider_failed or round_quota_structured or process.returncode not in (None, 0))
                and (round_quota_structured or provider_quota_exhausted(provider_error, stderr_text))
            ):
                round_status = "provider_quota_exhausted"
            auto_correct["rounds"][-1].update(
                finished_at=utc_now(),
                duration_seconds=round(time.monotonic() - round_started, 3),
                executor_seconds=round(executor_seconds_used - round_executor_start, 3),
                verification_seconds=round(verification_seconds, 3),
                attempts=[attempt["attempt"] for attempt in executor_attempts[round_attempts_start:]],
                status=round_status,
                executor_exit_code=process.returncode,
                timed_out=timed_out,
                reported_outcome=reported_outcome,
                report_contract_valid=report_contract_valid,
                report_contract_violations=report_violations,
                final_message=final_message,
                run_delta=state_delta(round_before, after_executor),
                gate_files_changed=[violation.split(":", 1)[1] for violation in gate_violations],
                verification=verification,
            )
        elif verification["status"] in {"failed", "timed_out"} and auto_correct["initial_verification"] is None:
            auto_correct["initial_verification"] = verification
        if correction_round and status in CONVERTED_ROUND_STATUSES:
            # A round that fails, times out or returns a bad report never leaves the run worse than no round:
            # the last handoff's report and gate results stand, and the round record keeps what it returned.
            # They predate the round's changes, so `coordinator reverify` refuses this result.
            status, exit_code = "verification_failed", 25
            verification = last_handoff["verification"]
            final_message = last_handoff["final_message"]
            reported_outcome = last_handoff["reported_outcome"]
            report_extracted = last_handoff["report_extracted"]
            report_contract_valid = last_handoff["report_contract_valid"]
            report_violations = last_handoff["report_violations"]
            consultation = last_handoff["consultation"]
            auto_correct.update(outcome="stopped", stop_reason=round_status, converted_from=round_status)
            break
        if status != "verification_failed":
            if not rounds_started:
                auto_correct["outcome"] = "not_needed"
            elif status == "completed":
                auto_correct["outcome"] = "passed"
            else:
                auto_correct.update(
                    outcome="stopped",
                    stop_reason="gate_files_changed" if gate_edit_violations else status,
                )
            break
        if rounds_started >= max_rounds:
            auto_correct["outcome"] = "exhausted"
            break
        round_fit = {
            "executor_seconds_left": timeout_seconds - executor_seconds_used,
            "deadline_left": deadline_remaining(args.deadline),
            "gate_seconds": verification_seconds,
        }
        refusal = auto_correct_module.round_refusal(**round_fit) if session_id else "no_session"
        if refusal is not None:
            auto_correct.update(outcome="refused", refused_reason=refusal)
            emit_lifecycle("auto_correct_refused", round=rounds_started + 1, reason=refusal)
            break
        # Open the next round: the same session gets the failed gate as a new turn, in the same worktree,
        # scope and gates. History, scope and --expect-changes stay judged from the first snapshot.
        failure = auto_correct_module.failed_command(verification)
        auto_correct_module.archive_verification(correction_round, verification)
        last_handoff = {
            "verification": verification,
            "final_message": final_message,
            "reported_outcome": reported_outcome,
            "report_extracted": report_extracted,
            "report_contract_valid": report_contract_valid,
            "report_violations": report_violations,
            "consultation": consultation,
        }
        executor_attempts[-1].update(
            archive_executor_attempt_artifacts(
                out_dir=out_dir,
                attempt=attempt_number,
                stdout_path=stdout_path,
                stderr_path=stderr_path,
                log_path=log_path,
                final_output_path=final_output_path,
            )
        )
        rounds_started += 1
        correction_round = rounds_started
        # Gate files existed before the first handoff and the run has not changed them since.
        gates = [
            path for path in gate_candidates if path not in run_delta["changed_paths"] and not steer_released(path)
        ]
        gates_before = {path: path_fingerprint(repo / path) for path in gates}
        round_brief_path = out_dir / f"round-{correction_round}-brief.txt"
        write_private_text(
            round_brief_path,
            auto_correct_module.correction_brief(
                auto_correct_module.correction_message(failure, verification, gates=gates),
                round_number=correction_round,
                max_rounds=max_rounds,
                allowed_paths=enforced_paths,
                verify_commands=args.verify_command,
                expect_changes=args.expect_changes,
                contract=contract_text,
            )
            + mailbox_module.run_instructions(mailbox_run_id),
        )
        write_private_text(log_path, "")
        write_private_text(final_output_path, "")
        stdin_path = round_brief_path
        if agy_stdin:
            stdin_path = out_dir / "agy-input.jsonl"
            stdin_path.write_bytes(agy_stream_input(round_brief_path.read_text(encoding="utf-8")))
            stdin_path.chmod(0o600)
        segment_session = session_id
        if args.engine == "claude":
            environment["CLAUDE_CODE_SESSION_ID"] = segment_session
        segment_resumed = True
        usage_baseline = usage.get("cumulative") or usage_baseline
        if attempt_cumulative_cost is not None:
            usage_baseline_cost = attempt_cumulative_cost
        round_timeout_seconds = auto_correct_module.round_budget(**round_fit)
        # With a deadline, the round's wait (60 s grace included) ends where the gates still fit after it.
        round_wait_until = (
            time.monotonic() + round_fit["deadline_left"] - verification_seconds
            if round_fit["deadline_left"] is not None
            else None
        )
        command = build_executor_command(
            executable=executable,
            engine=args.engine,
            model=model,
            variant=variant,
            repo=repo,
            add_dirs=add_dirs,
            session_id=segment_session,
            continue_last=False,
            timeout=format_duration(round_timeout_seconds),
            submitted_brief_path=round_brief_path,
            final_output_path=final_output_path,
            log_path=log_path,
            effort=effort["bound"] if args.engine in ("codex", "claude") else None,
            agy_stdin=agy_stdin,
            executor_version=version,
        )
        base_result.update(command=command_preview(command))
        if steering is not None:
            steering.session_hint = segment_session
        retry_window_start = round_attempts_start = len(executor_attempts)
        round_before = after
        round_started = time.monotonic()
        round_executor_start = executor_seconds_used
        auto_correct["rounds"].append(
            {
                "round": correction_round,
                "started_at": utc_now(),
                "session_id": segment_session,
                "trigger": {key: failure.get(key) for key in ("index", "command", "status", "exit_code")}
                if failure
                else None,
                "gate_files": gates,
                "timeout_seconds": round(round_timeout_seconds, 3),
                "command": command_preview(command),
                "prompt_path": str(round_brief_path),
                "prompt": round_brief_path.read_text(encoding="utf-8"),
            }
        )
        emit_lifecycle("auto_correct_round", round=correction_round, of=max_rounds, session=segment_session)
    # Only agy has a terminal status of its own; Claude's "unknown" just means no result message was found.
    provider_failed = provider_error is not None or (
        args.engine == "agy" and agy_status not in (None, "success", "waiting_for_input")
    )
    quota_structured = structured_quota_signal(args.engine, stdout_text)
    if (
        status in {"failed", "malformed_report", "empty_output"}
        and (provider_failed or quota_structured or process.returncode not in (None, 0))
        # Provider error channels only: stdout is the model's content and tool output.
        and (quota_structured or provider_quota_exhausted(provider_error, stderr_text))
    ):
        # The account ran out of quota or credits mid-run: not a task failure; retry elsewhere or later.
        status, exit_code = "provider_quota_exhausted", EXIT_PROVIDER_QUOTA

    post_failure_catalog: dict[str, Any] | None = None
    if process.returncode not in (None, 0) and classify_model_availability_failure(stderr_text, provider_error):
        refreshed_catalog = discover_engine_catalog(args.engine, refresh=True)
        refreshed_ids = [item["id"] for item in refreshed_catalog.get("models", []) if not item.get("hidden", False)]
        post_failure_catalog = {
            "status": refreshed_catalog.get("status"),
            "source": refreshed_catalog.get("source"),
            "discovered_at": refreshed_catalog.get("discovered_at"),
            "cache": refreshed_catalog.get("cache"),
            "model_still_available": model in refreshed_ids,
            "available_model_count": len(refreshed_ids),
            "closest_models": difflib.get_close_matches(model, refreshed_ids, n=5, cutoff=0.25),
            "error": refreshed_catalog.get("error"),
        }

    if auto_correct is not None:
        auto_correct.update(
            rounds_used=len(auto_correct["rounds"]),
            executor_seconds=round(total_executor_seconds_used, 3),
        )
    review = compact_review_bundle(
        repo=repo,
        before=before,
        run_delta=run_delta,
        verification=verification,
        result_path=result_path,
        session_id=session_id,
        scope_violations=scope_violations,
        history_violations=history_violations,
    )
    result = {
        **base_result,
        "status": status,
        "task_outcome": task_outcome_for_status(status),
        "reported_outcome": reported_outcome,
        "provider_terminal_status": agy_status,
        "provider_error": provider_error,
        "credits_stop": credits_watch.stopped if credits_watch is not None else None,
        "credits_watch": (
            {"status": "unavailable", "reason": credits_watch.unavailable}
            if credits_watch is not None and credits_watch.unavailable
            else {"status": "watching" if credits_watch is not None else "off"}
        ),
        "exit_code": exit_code,
        "executor_exit_code": process.returncode,
        "executor_attempts": executor_attempts,
        "finished_at": utc_now(),
        "duration_seconds": round(time.monotonic() - monotonic_start, 3),
        "session_id": session_id,
        "git_after_executor": after_executor,
        "git_identity_after_executor": git_identity_after_executor,
        "git_after": after,
        "git_identity_after": git_identity_after,
        "run_delta_after_executor": run_delta_after_executor,
        "run_delta": run_delta,
        "scope_violations_after_executor": scope_violations_after_executor,
        "history_violations_after_executor": history_violations_after_executor,
        "scope_violations": scope_violations,
        "history_violations": history_violations,
        # Other worktrees or branches changed during the run: informational, never a failure.
        "concurrent_activity": find_history_violations(git_activity_before, git_activity_after),
        "workspace_changed": workspace_changed,
        "workspace_changed_after_executor": workspace_changed_after_executor,
        "verification_changed_workspace": verification_changed_workspace,
        "verification_delta": verification_delta,
        "verification": verification,
        "report_extracted": report_extracted,
        "report_contract_valid": report_contract_valid,
        "report_contract_violations": report_violations,
        "stdout_size_bytes": len(stdout_bytes),
        "final_message": final_message,
        "stderr_tail": [line for line in stderr_text.splitlines() if line][-20:],
        "event_errors": parse_event_errors(stdout_text)[-20:],
        "post_failure_model_catalog": post_failure_catalog,
        "review": review,
        "usage": usage_module.combine_attempts(attempt_usage),
        "consultation": consultation,
        "scratch": scratch_report,
    }
    if steering is not None and steering.live_steers:
        seen_steer_ids = {item.get("steer_id") for item in steers_applied}
        for live_steer in steering.live_steers:
            if live_steer.get("steer_id") not in seen_steer_ids:
                steers_applied.append(live_steer)
        steers_applied.sort(key=lambda item: int(item.get("steer_id") or 0))
    if steers_applied:
        # History, scope and verification above were judged from the original snapshot: one combined run.
        result["steering"] = {
            "segment": segment,
            "steered_from": steered_from,
            "steers": steers_applied,
            "job_dir": str(steering.job_dir) if steering is not None else None,
        }
    exit_code = finish_run(
        result=result,
        result_path=result_path,
        completion_event_path=completion_event_path,
        notification_mode=notification_mode,
        completion_hook=completion_hook,
        extra_event_fields={"steered_from": steered_from} if steered_from else None,
    )
    if steering is not None:
        steering.save(phase="finished")
    return exit_code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RunnerError as exc:
        publish_uncaught_completion_failure(exc, exc.exit_code)
        print(f"agent-executor: {exc}", file=sys.stderr)
        raise SystemExit(exc.exit_code) from None
    except Exception as exc:
        publish_uncaught_completion_failure(exc, 1)
        raise
