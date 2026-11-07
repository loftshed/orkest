"""Bounded auto-correct rounds for a failed runner-owned verification gate.

When a `--verify-command` gate fails after a clean handoff, the runner can resume the same executor
session with a correction turn and run the gates again, at most `MAX_ROUNDS` times. run_agent.py owns
the loop, the audit and the timing; this module holds the parts that need none of its state: the
round limit, the correction turn, the gate files a round may not change, and the fit check.
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path
from typing import Any

MAX_ROUNDS = 2
# A round needs a correction turn plus another pass of the gates; with less left it is refused.
MIN_ROUND_SECONDS = 60.0
INSTRUCTION = "Fix exactly these problems; change nothing else."


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


def gate_paths(commands: list[str], repo: Path, *, changed: list[str] | tuple[str, ...] = ()) -> list[str]:
    """Repository files named in the verify commands: the gate's own scripts, tests and inputs.

    A word (or the value of `--flag=value`) counts when it names an existing file inside the repository,
    relative to its root or absolute. Two kinds of name are the work under test instead, which a
    correction may change: a file in `changed` (the run's own changes so far, as in
    `test -s allowed/output.txt`), and a directory (`ruff check src`).
    """
    root = repo.resolve()
    work = set(changed)
    found: list[str] = []
    for command in commands:
        for word in _words(command):
            for candidate in (word, *word.split("=", 1)[1:]):
                if not candidate:
                    continue
                path = Path(os.path.normpath(Path(candidate) if Path(candidate).is_absolute() else root / candidate))
                try:
                    relative = path.relative_to(root)
                except ValueError:
                    continue
                if not relative.parts or relative.parts[0] == ".git":
                    continue
                name = relative.as_posix()
                if os.path.lexists(path) and not path.is_dir() and name not in work and name not in found:
                    found.append(name)
    return found


def round_refusal(*, executor_seconds_left: float, deadline_left: float | None, gate_seconds: float) -> str | None:
    """Why a round cannot fit: the executor time left under --timeout, or the task deadline."""
    if executor_seconds_left < MIN_ROUND_SECONDS:
        return "timeout"
    if deadline_left is not None and deadline_left < MIN_ROUND_SECONDS + gate_seconds:
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
