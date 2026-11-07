"""Bounded auto-correct rounds for a failed runner-owned verification gate.

When a `--verify-command` gate fails after a clean handoff, the runner can resume the same executor
session with a correction turn and run the gates again, at most `MAX_ROUNDS` times. run_agent.py owns
the loop, the audit and the timing; this module holds the parts that need none of its state: the
round limit, the correction turn, the gate files a round may not change, and the fit check.
"""

from __future__ import annotations

import glob
import os
import shlex
import subprocess
from pathlib import Path
from typing import Any

MAX_ROUNDS = 2
# A round needs a correction turn plus another pass of the gates; with less left it is refused.
MIN_ROUND_SECONDS = 60.0
INSTRUCTION = "Fix exactly these problems; change nothing else."
# A glob in a gate command protects at most this many files.
MAX_GLOB_MATCHES = 500


def validate_rounds(value: Any, *, name: str) -> int:
    """An explicit round count: an integer from 0 to MAX_ROUNDS. Raises ValueError otherwise."""
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_ROUNDS:
        raise ValueError(f"{name} must be an integer from 0 to {MAX_ROUNDS}")
    return value


def effective_rounds(
    cli_value: int | None, task_spec: dict[str, Any] | None, verify_commands: list[str]
) -> tuple[int, str | None]:
    """Rounds this run may use and where the number came from. Without gates there is nothing to correct."""
    if cli_value is not None:
        rounds, source = cli_value, "cli"
    elif task_spec is not None and task_spec.get("auto_correct") is not None:
        rounds, source = int(task_spec["auto_correct"]), "task_spec"
    else:
        return 0, None
    return (rounds, source) if rounds and verify_commands else (0, None)


def failed_command(verification: dict[str, Any]) -> dict[str, Any] | None:
    """The gate that stopped a fail-fast verification run, or None when every recorded gate passed."""
    return next((command for command in verification.get("commands", []) if command.get("status") != "passed"), None)


def _words(command: str) -> list[str]:
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        return command.split()


def _named(command: str, bases: list[Path], depth: int = 0) -> list[Path]:
    """Paths the words of a shell command may name: plain, `--flag=value` and glob words, relative to the
    repository root and to every `cd` target before them, and the words of an inner `sh -c '...'`."""
    bases = list(bases)
    found: list[Path] = []
    words = _words(command)
    for index, word in enumerate(words):
        if index and words[index - 1] in ("cd", "pushd") and word and not word.startswith("-"):
            bases.append(Path(os.path.normpath(Path(word) if Path(word).is_absolute() else bases[-1] / word)))
            continue
        if depth < 3 and any(mark in word for mark in (" ", "\t", "\n", ";", "&", "|")):
            found += _named(word, bases, depth + 1)
        for candidate in dict.fromkeys((word, *word.split("=", 1)[1:])):
            if not candidate:
                continue
            for base in dict.fromkeys(bases):
                if any(mark in candidate for mark in "*?["):
                    matches = sorted(glob.glob(candidate, root_dir=base, recursive=True))[:MAX_GLOB_MATCHES]
                    found += [Path(os.path.normpath(base / match)) for match in matches]
                else:
                    found.append(
                        Path(os.path.normpath(Path(candidate) if Path(candidate).is_absolute() else base / candidate))
                    )
    return found


def _ignored(root: Path, names: list[str]) -> set[str]:
    """Names Git ignores. When Git cannot answer, none: protecting too much beats too little."""
    if not names:
        return set()
    try:
        answer = subprocess.run(
            ["git", "check-ignore", "-z", "--stdin"],
            cwd=root,
            input=b"\0".join(os.fsencode(name) for name in names),
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    if answer.returncode not in (0, 1):
        return set()
    return {os.fsdecode(item) for item in answer.stdout.split(b"\0") if item}


def gate_paths(commands: list[str], repo: Path) -> list[str]:
    """The gate's own files: repository files the verify commands name, as the workspace stands now.

    The runner takes them from the snapshot before the first handoff, so a file a gate or the worker
    writes later is never one. A symlink also protects its target. Directories (`ruff check src`) and
    files Git ignores (a gate's `> build/gate.log`) are not gate files, and the runner drops any file the
    run changes before a round (`test -s out.txt`): those are the work under test.
    """
    root = repo.resolve()
    names: list[str] = []
    for command in commands:
        for path in _named(command, [root]):
            for target in (path, path.resolve()) if path.is_symlink() else (path,):
                try:
                    relative = target.relative_to(root)
                except ValueError:
                    continue
                name = relative.as_posix()
                if (
                    relative.parts
                    and relative.parts[0] != ".git"
                    and os.path.lexists(target)
                    and not target.is_dir()
                    and name not in names
                ):
                    names.append(name)
    ignored = _ignored(root, names)
    return [name for name in names if name not in ignored]


def round_budget(*, executor_seconds_left: float, deadline_left: float | None, gate_seconds: float) -> float:
    """Seconds a round's executor may run: what --timeout left, and never past the deadline less the gates."""
    if deadline_left is None:
        return executor_seconds_left
    return min(executor_seconds_left, deadline_left - gate_seconds)


def round_refusal(*, executor_seconds_left: float, deadline_left: float | None, gate_seconds: float) -> str | None:
    """Why a round cannot fit: the executor time left under --timeout, or the task deadline."""
    if executor_seconds_left < MIN_ROUND_SECONDS:
        return "timeout"
    if deadline_left is not None and deadline_left - gate_seconds < MIN_ROUND_SECONDS:
        return "deadline"
    return None


def correction_message(failure: dict[str, Any] | None, verification: dict[str, Any], *, gates: list[str]) -> str:
    """The failing gate, its exit code and trimmed output, and the instruction to fix only that."""
    if failure is None:
        lines = ["The runner's verification gates did not finish before the task deadline.", ""]
    else:
        outcome = (
            f"timed out after {failure.get('duration_seconds')} s"
            if failure.get("status") == "timed_out"
            else f"failed with exit code {failure.get('exit_code')}"
        )
        lines = [
            f"Gate {failure.get('index')} of {verification.get('command_count')} {outcome}:",
            "",
            f"    {failure.get('command')}",
            "",
        ]
        printed = False
        for stream in ("stdout", "stderr"):
            tail = failure.get(f"{stream}_tail") or []
            if tail:
                printed = True
                lines += [f"Last {len(tail)} lines of {stream}:", *(f"    {line}" for line in tail), ""]
        if not printed:
            lines += ["The command printed nothing.", ""]
    lines.append(INSTRUCTION)
    if gates:
        lines.append(
            "Do not change the gate's own files: " + ", ".join(gates) + ". A round that changes them fails the run."
        )
    return "\n".join(lines)


def correction_brief(
    message: str,
    *,
    round_number: int,
    max_rounds: int,
    allowed_paths: list[str],
    verify_commands: list[str],
    expect_changes: bool,
    contract: str,
) -> str:
    """The new user turn for a correction round: the gate failure inside the unchanged contract."""
    scope = ", ".join(allowed_paths) if allowed_paths else "none; this is a read-only task, change no files"
    lines = [
        f"AUTO-CORRECT ROUND {round_number} OF {max_rounds} FROM THE RUNNER",
        "",
        "After your handoff the runner ran its verification gates, and one failed. This is a mechanical",
        "correction turn in the same task, not a new task: the original brief and every constraint in it",
        "still apply, and your changes in the workspace remain.",
        "",
        "--- failed gate ---",
        message,
        "--- end of failed gate ---",
        "",
        "Unchanged from the original brief:",
        f"- Paths you may change: {scope}.",
        f"- After your handoff the runner runs these checks again: {'; '.join(verify_commands)}.",
    ]
    if expect_changes:
        lines.append("- The task must leave a net change inside those paths.")
    lines.append("- Report on the whole task, this correction included.")
    return "\n".join(lines) + f"\n\n{contract}\n"


def archive_verification(round_number: int, verification: dict[str, Any]) -> None:
    """Keep a round's gate logs before the next round reuses their names; the records follow the files."""
    for command in verification.get("commands", []):
        for key in ("stdout_path", "stderr_path"):
            source = Path(command.get(key) or "")
            if source.name and source.is_file():
                destination = source.with_name(f"round-{round_number}-{source.name}")
                os.replace(source, destination)
                command[key] = str(destination)
