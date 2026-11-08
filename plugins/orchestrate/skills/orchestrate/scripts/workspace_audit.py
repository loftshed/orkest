"""Git workspace fingerprinting, status/diff capture, scope enforcement, and commit audit helpers."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

MAX_VERIFICATION_TAIL_BYTES = 64 * 1024
MAX_VERIFICATION_TAIL_LINE_CHARS = 500
REVIEW_FLAG_PATTERN = re.compile(r"\b(?:TODO|FIXME|HACK)\b|@ts-ignore|eslint-disable|console\.(?:log|warn|error)\(")
GIT_METADATA_VOLATILE = {"objects", "logs", "refs", "index", "HEAD", "FETCH_HEAD", "ORIG_HEAD", "gc.pid"}
STEER_REQUEST_NAME = "steer-request.json"
RUNNER_OUT_DIR_FILES = frozenset(
    {
        "brief.txt",
        "submitted-brief.txt",
        "stdout.txt",
        "stderr.txt",
        "executor.log",
        "runner.log",
        "final-output.txt",
        "agy-input.jsonl",
        "result.json",
        "run_summary.json",
        "events.jsonl",
        "event_completion.json",
        "segment_summary.json",
        "history.json",
        STEER_REQUEST_NAME,
    }
)
RUNNER_ARCHIVED_ATTEMPT_PATTERN = re.compile(r"attempt-\d+-(?:stdout\.txt|stderr\.txt|executor\.log|final-output\.txt)")
RUNNER_VERIFICATION_OUTPUT_PATTERN = re.compile(r"verification-\d{2,}\.(?:stdout|stderr)\.txt")
# Auto-correct rounds: each correction turn, and the gate logs of every round before the last.
RUNNER_AUTO_CORRECT_PATTERN = re.compile(r"round-\d+-(?:brief\.txt|verification-\d{2,}\.(?:stdout|stderr)\.txt)")


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


def git_output(repo: Path, *args: str) -> bytes:
    return _attr("run_checked")(["git", *args], cwd=repo).stdout


def git_root(cwd: Path) -> Path:
    runner_error_cls = _attr("RunnerError", ValueError)
    try:
        return Path(_attr("git_output")(cwd, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    except runner_error_cls as exc:
        raise _runner_error(f"target is not a Git repository: {cwd}", 4) from exc


def nul_paths(blob: bytes) -> set[bytes]:
    return {item for item in blob.split(b"\0") if item}


def hash_path(path: Path, digest: Any, *, relative: str = ".") -> None:
    """Hash content, type, mode, names, and symlink targets without following symlinks."""
    try:
        metadata = path.lstat()
        digest.update(f"{relative}\0MODE:{metadata.st_mode:o}\0".encode())
        if path.is_symlink():
            digest.update(b"SYMLINK\0")
            digest.update(os.readlink(path).encode("utf-8", errors="surrogateescape"))
            return
        if path.is_file():
            digest.update(b"FILE\0")
            with path.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    digest.update(chunk)
            return
        if path.is_dir():
            digest.update(b"DIRECTORY\0")
            for child in sorted(path.iterdir(), key=lambda item: os.fsencode(item.name)):
                child_relative = child.name if relative == "." else f"{relative}/{child.name}"
                _attr("hash_path")(child, digest, relative=child_relative)
            return
        digest.update(b"OTHER\0")
    except OSError as exc:
        digest.update(f"{relative}\0UNREADABLE:{exc}".encode("utf-8", errors="replace"))


def path_fingerprint(path: Path) -> dict[str, Any]:
    if not path.exists() and not path.is_symlink():
        return {"kind": "missing", "sha256": hashlib.sha256(b"MISSING").hexdigest()}
    digest = hashlib.sha256()
    _attr("hash_path")(path, digest)
    try:
        if path.is_symlink():
            kind = "symlink"
        elif path.is_file():
            kind = "file"
        elif path.is_dir():
            kind = "directory"
        else:
            kind = "other"
    except OSError:
        kind = "unreadable"
    return {"kind": kind, "sha256": digest.hexdigest()}


def normalize_repo_paths(values: list[str], *, option: str, allow_root: bool = False) -> list[str]:
    normalized: list[str] = []
    for value in values:
        stripped = value.strip()
        if allow_root and stripped == ".":
            if "." not in normalized:
                normalized.append(".")
            continue
        candidate = Path(value)
        if (
            candidate.is_absolute()
            or stripped in {"", "."}
            or ".." in candidate.parts
            or (candidate.parts and candidate.parts[0] == ".git")
        ):
            raise _runner_error(f"{option} must be a non-root repository-relative path: {value!r}", 4)
        clean = candidate.as_posix().rstrip("/")
        if clean not in normalized:
            normalized.append(clean)
    return normalized


def index_fingerprints(repo: Path) -> dict[str, str]:
    entries: dict[str, list[bytes]] = {}
    for record in _attr("nul_paths")(_attr("git_output")(repo, "ls-files", "-s", "-z")):
        metadata, separator, raw_path = record.partition(b"\t")
        if not separator:
            continue
        relative = raw_path.decode("utf-8", errors="surrogateescape")
        entries.setdefault(relative, []).append(metadata)
    return {relative: hashlib.sha256(b"\0".join(metadata)).hexdigest() for relative, metadata in entries.items()}


def git_path_fingerprint(repo: Path, relative: str, index_entries: dict[str, str]) -> dict[str, Any]:
    state = _attr("path_fingerprint")(repo / relative)
    state["index_sha256"] = index_entries.get(relative, hashlib.sha256(b"").hexdigest())
    return state


def git_state(repo: Path, tracked_paths: list[str] | None = None) -> dict[str, Any]:
    git_out = _attr("git_output")
    nul = _attr("nul_paths")
    status_bytes = git_out(repo, "status", "--porcelain=v1", "--untracked-files=all", "-z")
    dirty_paths = set()
    dirty_paths |= nul(git_out(repo, "diff", "--name-only", "--no-renames", "-z"))
    dirty_paths |= nul(git_out(repo, "diff", "--cached", "--name-only", "--no-renames", "-z"))
    dirty_paths |= nul(git_out(repo, "ls-files", "--others", "--exclude-standard", "-z"))

    index_entries = _attr("index_fingerprints")(repo)
    path_fingerprints = {}
    for raw_path in sorted(dirty_paths):
        relative = raw_path.decode("utf-8", errors="surrogateescape")
        path_fingerprints[relative] = _attr("git_path_fingerprint")(repo, relative, index_entries)

    tracked_fingerprints = {relative: _attr("path_fingerprint")(repo / relative) for relative in (tracked_paths or [])}
    digest = hashlib.sha256()
    digest.update(status_bytes)
    digest.update(
        json.dumps(
            {"paths": path_fingerprints, "tracked": tracked_fingerprints},
            sort_keys=True,
            ensure_ascii=False,
        ).encode("utf-8", errors="surrogateescape")
    )

    status_text = git_out(repo, "status", "--short", "--untracked-files=all").decode("utf-8", errors="replace")
    return {
        "fingerprint": digest.hexdigest(),
        "status": [line for line in status_text.splitlines() if line],
        "path_fingerprints": path_fingerprints,
        "tracked_path_fingerprints": tracked_fingerprints,
    }


def state_delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, list[str]]:
    before_paths = before.get("path_fingerprints", {})
    after_paths = after.get("path_fingerprints", {})
    changed_paths = sorted(
        path for path in set(before_paths) | set(after_paths) if before_paths.get(path) != after_paths.get(path)
    )
    before_tracked = before.get("tracked_path_fingerprints", {})
    after_tracked = after.get("tracked_path_fingerprints", {})
    tracked_paths_changed = sorted(
        path for path in set(before_tracked) | set(after_tracked) if before_tracked.get(path) != after_tracked.get(path)
    )
    return {
        "changed_paths": sorted(set(changed_paths) | set(tracked_paths_changed)),
        "tracked_paths_changed": tracked_paths_changed,
    }


def file_line_delta(
    repo: Path,
    path: str,
    *,
    preexisting_dirty: bool,
) -> dict[str, Any]:
    if preexisting_dirty:
        return {
            "path": path,
            "added_lines": None,
            "removed_lines": None,
            "exact_for_run": False,
            "reason": "path_was_dirty_before_executor",
            "review_flags": [],
        }

    run_chk = _attr("run_checked")
    completed = run_chk(
        ["git", "diff", "--numstat", "HEAD", "--", path],
        cwd=repo,
    )
    line = completed.stdout.decode("utf-8", errors="replace").strip()
    added: int | None = None
    removed: int | None = None
    if line:
        fields = line.split("\t", 2)
        if len(fields) >= 2 and fields[0].isdigit() and fields[1].isdigit():
            added, removed = int(fields[0]), int(fields[1])
    else:
        target = repo / path
        if target.is_file():
            try:
                added = len(target.read_text(encoding="utf-8").splitlines())
                removed = 0
            except (OSError, UnicodeDecodeError):
                pass

    patch = run_chk(
        ["git", "diff", "--unified=0", "HEAD", "--", path],
        cwd=repo,
    ).stdout.decode("utf-8", errors="replace")
    flag_pattern = _attr("REVIEW_FLAG_PATTERN", REVIEW_FLAG_PATTERN)
    review_flags = sorted(
        {
            match.group(0)
            for raw_line in patch.splitlines()
            if raw_line.startswith("+") and not raw_line.startswith("+++")
            for match in flag_pattern.finditer(raw_line[1:])
        }
    )
    return {
        "path": path,
        "added_lines": added,
        "removed_lines": removed,
        "exact_for_run": added is not None and removed is not None,
        "reason": None if added is not None and removed is not None else "binary_or_unavailable",
        "review_flags": review_flags,
    }


def compact_review_bundle(
    *,
    repo: Path,
    before: dict[str, Any],
    run_delta: dict[str, list[str]],
    verification: dict[str, Any],
    result_path: Path,
    session_id: str | None,
    scope_violations: list[str],
    history_violations: list[str],
) -> dict[str, Any]:
    dirty_before = set(before.get("path_fingerprints", {}))
    line_delta_fn = _attr("file_line_delta")
    files = [
        line_delta_fn(
            repo,
            path,
            preexisting_dirty=path in dirty_before,
        )
        for path in run_delta["changed_paths"]
    ]
    return {
        "result_path": str(result_path),
        "session_id": session_id,
        "changed_file_count": len(files),
        "files": files,
        "verification": {
            "status": verification.get("status"),
            "command_count": verification.get("command_count", 0),
            "completed_count": verification.get("completed_count", 0),
            "commands": [
                {
                    "index": command.get("index"),
                    "status": command.get("status"),
                    "exit_code": command.get("exit_code"),
                    "duration_seconds": command.get("duration_seconds"),
                }
                for command in verification.get("commands", [])
            ],
        },
        "scope_violations": scope_violations,
        "history_violations": history_violations,
        "review_flags": sorted({flag for file in files for flag in file.get("review_flags", [])}),
    }


def path_is_allowed(path: str, prefixes: list[str]) -> bool:
    if path == ".git" or path.startswith(".git/"):
        return False
    return any(prefix == "." or path == prefix or path.startswith(f"{prefix}/") for prefix in prefixes)


def find_scope_violations(delta: dict[str, list[str]], allowed_paths: list[str]) -> list[str]:
    if not allowed_paths:
        return list(delta["changed_paths"])
    allowed_fn = _attr("path_is_allowed")
    return [path for path in delta["changed_paths"] if not allowed_fn(path, allowed_paths)]


def prepare_scratch_dir(out_dir: Path) -> Path:
    """Private per-run scratch directory for a read-only run: outside the reviewed checkout, inside the run dir."""
    scratch = out_dir / "scratch-root" / "scratch"
    scratch.parent.mkdir(mode=0o700, parents=True)
    scratch.parent.chmod(0o700)
    scratch.mkdir(mode=0o700)
    return scratch.resolve()


def scratch_brief_note(scratch: Path) -> str:
    return (
        "\nSCRATCH DIRECTORY (read-only task)\n"
        f"If you need to save a diff, notes or gathered context, write it only under {scratch}.\n"
        "Anything written elsewhere in the repository counts as a source change and fails the run.\n"
        "Do not create symlinks in the scratch directory that point outside it. Scratch files are kept "
        "and listed in the result.\n"
    )


def is_runner_out_dir_file(name: str) -> bool:
    return (
        name in _attr("RUNNER_OUT_DIR_FILES", RUNNER_OUT_DIR_FILES)
        or _attr("RUNNER_ARCHIVED_ATTEMPT_PATTERN", RUNNER_ARCHIVED_ATTEMPT_PATTERN).fullmatch(name) is not None
        or _attr("RUNNER_VERIFICATION_OUTPUT_PATTERN", RUNNER_VERIFICATION_OUTPUT_PATTERN).fullmatch(name) is not None
        or RUNNER_AUTO_CORRECT_PATTERN.fullmatch(name) is not None
    )


def collect_scratch_artifacts(scratch: Path) -> dict[str, Any]:
    """List what a run left in its scratch directory without following symlinks; report escapes as violations."""
    artifacts: list[dict[str, Any]] = []
    escapes: list[str] = []
    root = scratch.resolve()
    scratch_root = scratch.parent
    if scratch_root.is_symlink() or not scratch_root.is_dir():
        escapes.append(Path(os.path.relpath(scratch_root, scratch)).as_posix())
    elif scratch.is_symlink() or not scratch.is_dir():
        escapes.append(scratch.name)
    else:
        for current, directories, files in os.walk(scratch, followlinks=False):
            for name in [*directories, *files]:
                path = Path(current) / name
                relative = path.relative_to(scratch).as_posix()
                if path.is_symlink():
                    target = path.resolve()
                    if target != root and root not in target.parents:
                        escapes.append(relative)
                        continue
                if path.is_file() and not path.is_symlink():
                    artifacts.append({"path": relative, "size_bytes": path.stat().st_size})

    if scratch_root.is_dir() and not scratch_root.is_symlink():
        for entry in scratch_root.iterdir():
            if entry.name != scratch.name:
                escapes.append(Path(os.path.relpath(entry, scratch)).as_posix())

    run_dir = scratch_root.parent
    out_file_fn = _attr("is_runner_out_dir_file")
    if run_dir.is_dir():
        for entry in run_dir.iterdir():
            if entry.name == scratch_root.name and entry.is_dir() and not entry.is_symlink():
                continue
            if entry.is_symlink() or not entry.is_file() or not out_file_fn(entry.name):
                escapes.append(Path(os.path.relpath(entry, scratch)).as_posix())

    return {
        "path": str(scratch),
        "artifacts": sorted(artifacts, key=lambda item: item["path"]),
        "escapes": sorted(set(escapes)),
    }


def git_optional_output(repo: Path, *args: str) -> str:
    runner_error_cls = _attr("RunnerError", ValueError)
    try:
        return _attr("git_output")(repo, *args).decode("utf-8", errors="replace").strip()
    except runner_error_cls:
        return ""


def text_fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def nonempty_line_count(text: str) -> int:
    return sum(1 for line in text.splitlines() if line)


def git_identity(repo: Path) -> dict[str, Any]:
    """What this run must not change: this worktree's HEAD, branch, and HEAD reflog.

    Other worktrees, other branches, and the repository-wide stash move on their own when work runs in
    parallel; comparing them made any commit, stash, or `worktree add` elsewhere fail the job. Shared
    refs and worktrees are tracked by git_activity() instead and reported as concurrent activity, not as
    a history violation.
    """
    git_opt = _attr("git_optional_output")
    common_dir = git_opt(repo, "rev-parse", "--git-common-dir")
    if common_dir:
        common_path = Path(common_dir)
        if not common_path.is_absolute():
            common_path = (repo / common_path).resolve()
        common_dir = str(common_path)
    branch = git_opt(repo, "symbolic-ref", "--quiet", "--short", "HEAD") or None
    head_reflog = git_opt(repo, "reflog", "show", "-1", "--format=%H%x00%gs", "HEAD")
    branch_ref = git_opt(repo, "rev-parse", "--verify", f"refs/heads/{branch}") if branch else ""
    return {
        "head": git_opt(repo, "rev-parse", "--verify", "HEAD") or None,
        "branch": branch,
        "branch_ref": branch_ref or None,
        "head_reflog_sha256": _attr("text_fingerprint")(head_reflog),
        "common_dir": common_dir or None,
    }


def git_metadata_snapshot(repo: Path) -> dict[str, tuple[int, int]]:
    """Size and mtime of this worktree's Git metadata files, minus what Git itself rewrites during a read.

    `git status` never lists anything under .git, so a worker could add a hook or edit config unseen.
    HEAD, refs and the reflog are judged by git_identity(); objects, the index and lock files churn.
    """
    git_dir = _attr("git_optional_output")(repo, "rev-parse", "--absolute-git-dir")
    if not git_dir:
        return {}
    root = Path(git_dir)
    try:
        prefix = root.relative_to(repo.resolve()).as_posix()
    except ValueError:
        prefix = root.as_posix()
    volatile = _attr("GIT_METADATA_VOLATILE", GIT_METADATA_VOLATILE)
    snapshot: dict[str, tuple[int, int]] = {}
    for current, directories, files in os.walk(root, followlinks=False):
        relative_dir = Path(current).relative_to(root)
        if relative_dir == Path("."):
            directories[:] = [name for name in directories if name not in volatile]
        for name in files:
            if relative_dir == Path(".") and name in volatile or name.endswith(".lock"):
                continue
            path = Path(current) / name
            with contextlib.suppress(OSError):
                stat = path.lstat()
                snapshot[f"{prefix}/{(relative_dir / name).as_posix()}"] = (stat.st_size, stat.st_mtime_ns)
    return snapshot


def find_git_metadata_changes(before: dict[str, tuple[int, int]], after: dict[str, tuple[int, int]]) -> list[str]:
    return sorted(path for path in set(before) | set(after) if before.get(path) != after.get(path))


def git_activity(repo: Path) -> dict[str, Any]:
    """Repository state shared with other worktrees: branch names and worktree paths (not their HEADs)."""
    git_opt = _attr("git_optional_output")
    fp = _attr("text_fingerprint")
    ref_names = git_opt(repo, "for-each-ref", "--format=%(refname)", "refs/heads")
    worktrees = git_opt(repo, "worktree", "list", "--porcelain")
    paths = sorted(line[len("worktree ") :] for line in worktrees.splitlines() if line.startswith("worktree "))
    return {
        "local_ref_names_sha256": fp(ref_names),
        "local_ref_count": _attr("nonempty_line_count")(ref_names),
        "worktree_paths_sha256": fp("\n".join(paths)),
        "worktree_count": len(paths),
    }


def find_history_violations(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    return sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))


def verification_summary(
    commands: list[str],
    *,
    status: str,
    skipped_reason: str | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "command_count": len(commands),
        "completed_count": 0,
        "skipped_reason": skipped_reason,
        "commands": [],
    }


def nonempty_tail(text: str, limit: int = 20) -> list[str]:
    max_chars = _attr("MAX_VERIFICATION_TAIL_LINE_CHARS", MAX_VERIFICATION_TAIL_LINE_CHARS)
    return [line[-max_chars:] for line in text.splitlines() if line][-limit:]


def read_text_tail(path: Path) -> tuple[str, int]:
    max_bytes = _attr("MAX_VERIFICATION_TAIL_BYTES", MAX_VERIFICATION_TAIL_BYTES)
    size = path.stat().st_size
    with path.open("rb") as handle:
        start = max(0, size - max_bytes)
        handle.seek(start)
        data = handle.read()
    if start and b"\n" in data:
        data = data.split(b"\n", 1)[1]
    return data.decode("utf-8", errors="replace"), size


def run_verification_commands(
    commands: list[str],
    *,
    repo: Path,
    out_dir: Path,
    timeout_seconds: float,
    deadline: str | None = None,
    lease: int | None = None,
) -> dict[str, Any]:
    if not commands:
        return _attr("verification_summary")(commands, status="not_requested")

    command_results: list[dict[str, Any]] = []
    environment = dict(os.environ)
    with contextlib.suppress(Exception):
        _runner().bundled_module("repo_env").apply_repo_dotenv(environment, repo)
    environment["PWD"] = str(repo)
    # Python checks (including their subprocesses) must not mutate the worktree
    # merely by importing project modules. Explicit writers are still audited.
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    overall_status = "passed"

    for index, command in enumerate(commands, start=1):
        remaining = _attr("deadline_remaining")(deadline)
        if remaining is not None and remaining <= 0:
            overall_status = "timed_out"
            break
        stdout_path = out_dir / f"verification-{index:02d}.stdout.txt"
        stderr_path = out_dir / f"verification-{index:02d}.stderr.txt"
        started = time.monotonic()
        open_bin = _attr("open_private_binary")
        with (
            open_bin(stdout_path) as stdout_handle,
            open_bin(stderr_path) as stderr_handle,
        ):
            process = subprocess.Popen(
                ["/bin/sh", "-c", command],
                cwd=repo,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=stdout_handle,
                stderr=stderr_handle,
                start_new_session=True,
            )
            timed_out = _attr("wait_with_heartbeats")(
                process,
                timeout_seconds=min(timeout_seconds, remaining) if remaining is not None else timeout_seconds,
                heartbeat_seconds=0,
                monotonic_start=started,
            )

        stdout_text, stdout_size = _attr("read_text_tail")(stdout_path)
        stderr_text, stderr_size = _attr("read_text_tail")(stderr_path)
        command_status = "timed_out" if timed_out else ("passed" if process.returncode == 0 else "failed")
        tail_fn = _attr("nonempty_tail")
        command_results.append(
            {
                "index": index,
                "command": command,
                "status": command_status,
                "exit_code": process.returncode,
                "duration_seconds": round(time.monotonic() - started, 3),
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
                "stdout_size_bytes": stdout_size,
                "stderr_size_bytes": stderr_size,
                "stdout_tail": tail_fn(stdout_text),
                "stderr_tail": tail_fn(stderr_text),
            }
        )
        if command_status != "passed":
            overall_status = command_status
            break

    return {
        "status": overall_status,
        "command_count": len(commands),
        "completed_count": len(command_results),
        "skipped_reason": None,
        "commands": command_results,
    }
