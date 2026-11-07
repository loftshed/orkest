"""Bounded auto-correct rounds for a failed runner-owned verification gate.

When a `--verify-command` gate fails after a clean handoff, the runner can resume the same executor
session with a correction turn and run the gates again, at most `MAX_ROUNDS` times. run_agent.py owns
the loop, the audit and the timing; this module holds the parts that need none of its state: the
round limit, the correction turn, the gate files a round may not change, and the fit check.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any

MAX_ROUNDS = 2
# A round needs a correction turn plus another pass of the gates; with less left it is refused.
MIN_ROUND_SECONDS = 60.0
INSTRUCTION = "Fix exactly these problems; change nothing else."
# Shell words that end one command and start the next, and words that run the command after them.
OPERATOR_CHARACTERS = frozenset(";&|()")
COMMAND_PREFIXES = frozenset(
    {"!", "{", "}", "if", "then", "else", "elif", "do", "while", "until", "time", "exec", "command", "env", "nohup"}
)
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*", re.DOTALL)
# A shell's inline-command flag (`-c`, `-lc`, `-ec`): the next word is a whole command line.
INLINE_COMMAND_FLAG = re.compile(r"-[A-Za-z]*c[A-Za-z]*")
MAX_BASES = 16


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


def _named(command: str, bases: list[Path], depth: int = 0) -> list[tuple[Path, bool]]:
    """Paths the words of a shell command may name, each with whether it is the program a command runs.

    Best effort, and deliberately generous: words count plain and as `--flag=value`, relative to the
    repository root and to every directory a `cd`/`pushd` may have entered (a subshell's `cd` is not
    undone), and inside an inner `sh -c '...'`. Glob words are skipped: like a directory, what they
    match is the work under test. A gate kept outside the worker's allowed paths needs none of this:
    scope already protects it.
    """
    bases = list(bases)
    found: list[tuple[Path, bool]] = []
    words = _words(command)
    expect_program = True
    changing_directory = False
    for index, word in enumerate(words):
        if word and set(word) <= OPERATOR_CHARACTERS:
            expect_program, changing_directory = True, False
            continue
        if word in ("cd", "pushd") and expect_program:
            expect_program, changing_directory = False, True
            continue
        if changing_directory:
            if word.startswith("-"):
                continue  # cd -P, cd -L, cd --
            target = Path(word)
            entered = [Path(os.path.normpath(target if target.is_absolute() else base / target)) for base in bases]
            bases = list(dict.fromkeys([*bases, *entered]))[:MAX_BASES]
            changing_directory = False
            continue
        if expect_program and (ASSIGNMENT.fullmatch(word) or word in COMMAND_PREFIXES or word.startswith("-")):
            program = False  # an assignment, a prefix such as `env`/`exec`/`{`, or a prefix's flag
        else:
            program, expect_program = expect_program, False
        inline = bool(index) and INLINE_COMMAND_FLAG.fullmatch(words[index - 1]) is not None
        if depth < 3 and (inline or any(mark in word for mark in (" ", "\t", "\n", ";", "&", "|", "("))):
            found += _named(word, bases, depth + 1)
        for candidate in dict.fromkeys((word, *word.split("=", 1)[1:])):
            if not candidate or any(mark in candidate for mark in "*?["):
                continue
            path = Path(candidate)
            for base in dict.fromkeys(bases):
                found.append((Path(os.path.normpath(path if path.is_absolute() else base / path)), program))
    return found


def _link_chain(path: Path) -> list[Path]:
    """A name and every link it passes through: each hop of a symlink chain, then its final target."""
    chain = [path]
    for _ in range(40):
        if not chain[-1].is_symlink():
            break
        target = Path(os.readlink(chain[-1]))
        hop = target if target.is_absolute() else chain[-1].parent / target
        chain.append(Path(os.path.realpath(hop.parent)) / hop.name)
    return list(dict.fromkeys(chain))


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
    writes later is never one. A symlink also protects its target. The program a command runs is
    protected even when Git ignores it (`./node_modules/.bin/vitest`, `.venv/bin/pytest`). Not gate
    files: directories and globs (`ruff check src`, `mypy src/*.py`), other ignored files (a gate's
    `> build/gate.log`), and, as the runner drops them before each round, files the run changed
    (`test -s out.txt`). Those are the work under test.
    """
    root = repo.resolve()
    # name -> protected even when Git ignores it: the program a command runs, or a link's hop or target.
    names: dict[str, bool] = {}
    for command in commands:
        for path, program in _named(command, [root]):
            # Name files by their real directory, as Git tracks them: through a symlinked directory
            # inside the repository, or a symlinked prefix outside it (macOS /var -> /private/var).
            # Only the directory is resolved, so a symlinked gate stays the link.
            located = Path(os.path.realpath(path.parent)) / path.name
            for hop, target in enumerate(_link_chain(located)):
                try:
                    relative = target.relative_to(root)
                except ValueError:
                    continue
                name = relative.as_posix()
                if relative.parts and relative.parts[0] != ".git" and os.path.lexists(target) and not target.is_dir():
                    names[name] = names.get(name, False) or program or hop > 0
    ignored = _ignored(root, [name for name, always in names.items() if not always])
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
