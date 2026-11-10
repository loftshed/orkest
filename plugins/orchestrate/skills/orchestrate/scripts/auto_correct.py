"""Bounded auto-correct rounds for a failed runner-owned verification gate.

When a `--verify-command` gate fails after a clean handoff, the runner can resume the same executor
session with a correction turn and run the gates again, at most `MAX_ROUNDS` times. run_agent.py owns
the loop, the audit and the timing; this module holds the parts that need none of its state: the
round limit, the correction turn, the gate files a round may not change, and the fit check.

Gate files come from three places only: the program a verify command runs when it is a repository
file, the script it hands to an interpreter, and the explicit protect_paths. Arguments in general are
not read as files; see gate_paths.
"""

from __future__ import annotations

import importlib.util
import os
import posixpath
import re
import shlex
from pathlib import Path
from typing import Any, NamedTuple


def _load_repo_paths() -> Any:
    """Load the shared path rules by file. These scripts are loaded by path from a copied directory,
    so a sibling is not importable by name unless a caller happened to put it on `sys.path`."""
    spec = importlib.util.spec_from_file_location(
        "agent_executor_repo_paths", Path(__file__).with_name("repo_paths.py")
    )
    if spec is None or spec.loader is None:
        raise ImportError("could not load repository path rules")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_REPO_PATHS = _load_repo_paths()


MAX_ROUNDS = 2
# A round needs a correction turn plus another pass of the gates; with less left it is refused.
MIN_ROUND_SECONDS = 60.0
INSTRUCTION = "Fix exactly these problems; change nothing else."
# A check that is itself wrong goes to review, not into the work: the worker stops instead of editing it.
BLOCKED_GUIDANCE = (
    "If a check itself is wrong, do not change it; stop and report BLOCKED with the evidence that the "
    "check, not the work, is at fault."
)
# Shell operators, longest first. A redirection's next word is its target; a here-document's is its delimiter.
OPERATORS = ("&>>", "<<-", "<<<", "&&", "||", ";;", "|&", ">>", "<<", "<>", ">|", ">&", "<&", "&>")
OPERATORS += tuple(";&|()<>\n")
REDIRECTIONS = frozenset({"&>>", "<<<", ">>", "<>", ">|", ">&", "<&", "&>", "<", ">"})
HERE_DOCUMENTS = frozenset({"<<", "<<-"})
# Words that start a command without being its program.
KEYWORDS = frozenset({"!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"})
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*", re.DOTALL)
# Commands that run the command after them: (short options that take a value, long ones that do).
WRAPPERS = {
    "env": ("uCS", frozenset({"--unset", "--chdir", "--split-string"})),
    "exec": ("a", frozenset()),
    "command": ("", frozenset()),
    "time": ("fo", frozenset({"--format", "--output"})),
    "nohup": ("", frozenset()),
    "nice": ("n", frozenset({"--adjustment"})),
    "timeout": ("sk", frozenset({"--signal", "--kill-after"})),
}
SHELLS = frozenset({"sh", "bash", "zsh", "dash"})
SOURCE = frozenset({".", "source"})
PYTHON = re.compile(r"python(?:\d+(?:\.\d+)*t?)?")


class Interpreter(NamedTuple):
    """How an interpreter's options read, so its first operand, the script, can be found."""

    value: str = ""  # short options whose value is the rest of the word or the next word
    rest: str = ""  # short options whose value is the rest of the word only
    inline: str = ""  # short options after which no script runs: inline code or a module
    long_value: frozenset[str] = frozenset()
    long_inline: frozenset[str] = frozenset()
    runs: frozenset[str] = frozenset()  # subcommands the script follows (`deno run x.ts`)


INTERPRETERS = {
    "python": Interpreter(value="WX", inline="cm", long_value=frozenset({"--check-hash-based-pycs"})),
    "node": Interpreter(
        value="rC",
        inline="epc",
        long_value=frozenset(
            {"--require", "--import", "--loader", "--experimental-loader", "--conditions", "--input-type"}
            | {"--env-file", "--title"}
        ),
        # Inline code, and modes in which the operands are tests or package scripts, not a script to run.
        long_inline=frozenset({"--eval", "--print", "--test", "--run", "--check"}),
    ),
    "ruby": Interpreter(value="IrCE", rest="xF0W", inline="ec"),
    "perl": Interpreter(value="I", rest="MmDd0ixlCF", inline="eEc"),
    "deno": Interpreter(
        value="cL",
        long_value=frozenset({"--config", "--import-map", "--lock", "--cert", "--location", "--seed", "--log-level"}),
        long_inline=frozenset({"--eval"}),
        runs=frozenset({"run", "serve"}),
    ),
    "bun": Interpreter(
        value="r",
        inline="ep",
        long_value=frozenset({"--preload", "--config", "--cwd", "--env-file", "--tsconfig-override"}),
        long_inline=frozenset({"--eval", "--print"}),
        runs=frozenset({"run"}),
    ),
}
# PowerShell options are case-insensitive words.
PWSH_FILE = frozenset({"-f", "-file"})
PWSH_INLINE = frozenset({"-c", "-command", "-e", "-ec", "-encodedcommand", "-cwa", "-commandwithargs"})
PWSH_VALUE = frozenset(
    {"-ex", "-ep", "-executionpolicy", "-wd", "-workingdirectory", "-config", "-configurationname", "-o"}
    | {"-of", "-outputformat", "-if", "-inp", "-inputformat", "-w", "-windowstyle", "-settings", "-settingsfile"}
    | {"-custompipename"}
)
MAX_DEPTH = 4
MAX_LINK_HOPS = 40


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


def _substitution(command: str, start: int, text: list[str], nested: list[str]) -> int:
    """Read a command/process substitution into one word, retaining its nested command. Returns its end."""
    if command[start] == "`":
        end = start + 1
        while end < len(command) and command[end] != "`":
            end += 2 if command[end] == "\\" else 1
        nested.append(command[start + 1 : end].replace("\\`", "`"))
        text.append(command[start : end + 1])
        return end + 1
    depth, end = 1, start + 2
    started = False
    while end < len(command) and depth:
        char = command[end]
        if char == "\\":
            end += 2
            started = True
            continue
        if char in "'\"":
            quote = char
            end += 1
            while end < len(command) and command[end] != quote:
                end += 2 if quote == '"' and command[end] == "\\" else 1
            end += 1
            started = True
            continue
        if char == "#" and not started:
            newline = command.find("\n", end)
            end = len(command) if newline < 0 else newline
            continue
        depth += {"(": 1, ")": -1}.get(char, 0)
        started = char not in " \t\r\n;|&()"
        end += 1
    nested.append(command[start + 2 : end - 1 if depth == 0 else end])
    text.append(command[start:end])
    return end


def _skip_here_document(command: str, start: int, delimiter: str, strip_tabs: bool) -> int:
    """The index after a here-document's body, which is data, not commands."""
    position = start
    while position < len(command):
        newline = command.find("\n", position)
        end = len(command) if newline < 0 else newline
        line = command[position:end]
        position = end + 1
        if (line.lstrip("\t") if strip_tabs else line) == delimiter:
            break
    return min(position, len(command))


def _tokens(command: str) -> list[tuple[str, str, list[str]]]:
    """A POSIX shell command line as ("word", text, commands substituted in it) and ("op", operator, [])."""
    tokens: list[tuple[str, str, list[str]]] = []
    text: list[str] = []
    nested: list[str] = []
    started = quoted = False
    documents: list[tuple[str, bool]] = []
    awaiting_delimiter: str | None = None

    def flush() -> None:
        nonlocal text, nested, started, quoted, awaiting_delimiter
        if started:
            word = "".join(text)
            tokens.append(("word", word, nested))
            if awaiting_delimiter is not None:
                documents.append((word, awaiting_delimiter == "<<-"))
                awaiting_delimiter = None
        text, nested, started, quoted = [], [], False, False

    index = 0
    while index < len(command):
        char = command[index]
        if char == "\\":
            if command.startswith("\\\n", index):
                index += 2  # a line continuation joins the lines
                continue
            text.append(command[index + 1 : index + 2])
            started = quoted = True
            index += 2
        elif char == "'":
            close = command.find("'", index + 1)
            close = len(command) if close < 0 else close
            text.append(command[index + 1 : close])
            started = quoted = True
            index = close + 1
        elif char == '"':
            started = quoted = True
            index += 1
            while index < len(command) and command[index] != '"':
                escaped = command[index + 1 : index + 2]
                if command[index] == "\\" and escaped in ("$", "`", '"', "\\", "\n"):
                    text.append("" if escaped == "\n" else escaped)
                    index += 2
                elif command.startswith("$(", index) or command[index] == "`":
                    index = _substitution(command, index, text, nested)
                else:
                    text.append(command[index])
                    index += 1
            index += 1
        elif command.startswith(("$(", "<(", ">("), index) or char == "`":
            index = _substitution(command, index, text, nested)
            started = True
        elif char == "#" and not started:
            newline = command.find("\n", index)
            index = len(command) if newline < 0 else newline
        elif char in " \t\r":
            flush()
            index += 1
        else:
            operator = next((op for op in OPERATORS if command.startswith(op, index)), None)
            if operator is None:
                text.append(char)
                started = True
                index += 1
                continue
            if started and not quoted and "".join(text).isdigit() and operator in REDIRECTIONS | HERE_DOCUMENTS:
                text, nested, started = [], [], False  # `2>&1`: a file descriptor, not a word
            flush()
            tokens.append(("op", operator, []))
            index += len(operator)
            if operator in HERE_DOCUMENTS:
                awaiting_delimiter = operator
            elif operator == "\n":
                for delimiter, strip_tabs in documents:
                    index = _skip_here_document(command, index, delimiter, strip_tabs)
                documents.clear()
    flush()
    return tokens


def _literal(word: str) -> bool:
    """A word that names one path as written: no expansion, glob or brace a shell would rewrite."""
    return (
        bool(word)
        and not word.startswith("~")
        and not any(mark in word for mark in ("$", "`", "*", "?", "[", "{", "<(", ">("))
    )


def _options(words: list[str], index: int, short: str = "", long: frozenset[str] = frozenset()) -> tuple[int, dict]:
    """Skip options from `index`: the first operand's index and the values of the options that take one."""
    values: dict[str, str] = {}
    while index < len(words):
        word = words[index]
        if word == "--":
            return index + 1, values
        if word.startswith("--"):
            name, equals, value = word.partition("=")
            if name in long and not equals and index + 1 < len(words):
                index += 1
                value = words[index]
            values[name] = value
        elif len(word) > 1 and word.startswith("-"):
            for position, flag in enumerate(word[1:], 2):
                if flag in short:
                    value = word[position:]
                    if not value and index + 1 < len(words):
                        index += 1
                        value = words[index]
                    values[flag] = value
                    break
        else:
            return index, values
        index += 1
    return index, values


def _shell_script(operands: list[str]) -> tuple[str, str] | None:
    inline = stdin = False
    index = 0
    while index < len(operands):
        word = operands[index]
        if word in ("--", "-"):
            index += 1
            break
        if word.startswith("--"):
            index += 2 if word in ("--rcfile", "--init-file") else 1
            continue
        if len(word) > 1 and word[0] in "-+":
            inline = inline or (word[0] == "-" and "c" in word)
            stdin = stdin or (word[0] == "-" and "s" in word)
            index += 2 if "o" in word or "O" in word else 1  # `-o pipefail`, `+O extglob`
            continue
        break
    if index >= len(operands):
        return None if inline else ("stdin", "")
    if inline:
        return "command", operands[index]
    return ("stdin", "") if stdin else ("script", operands[index])


def _pwsh_script(operands: list[str]) -> tuple[str, str] | None:
    index = 0
    while index < len(operands):
        word = operands[index].lower()
        if word in PWSH_FILE:
            return ("script", operands[index + 1]) if index + 1 < len(operands) else None
        if word in PWSH_INLINE:
            return None
        if word.startswith("-"):
            index += 2 if word in PWSH_VALUE else 1
            continue
        return "script", operands[index]
    return None


def _script(program: str, operands: list[str]) -> tuple[str, str] | None:
    """What an interpreter runs: ("script", path), ("command", shell text), ("stdin", ""), or None.

    The script is the first operand after the interpreter's options (`python3 -u tools/gen.py apply x`
    runs tools/gen.py). Inline code and modules (`python3 -c`, `-m`, `node -e`) run no script file;
    a shell's `-c` string is a command line of its own.
    """
    name = posixpath.basename(program)
    if name in SHELLS:
        return _shell_script(operands)
    if name in SOURCE:
        index, _ = _options(operands, 0)
        return ("script", operands[index]) if index < len(operands) else None
    if name == "pwsh":
        return _pwsh_script(operands)
    spec = INTERPRETERS.get("python" if PYTHON.fullmatch(name) else name)
    if spec is None:
        return None
    index, subcommand = 0, bool(spec.runs)
    while index < len(operands):
        word = operands[index]
        if word == "--":
            return ("script", operands[index + 1]) if index + 1 < len(operands) else None
        if word == "-":
            return "stdin", ""
        if word.startswith("--"):
            option, equals, _ = word.partition("=")
            if option in spec.long_inline:
                return None
            index += 2 if option in spec.long_value and not equals else 1
            continue
        if len(word) > 1 and word.startswith("-"):
            for position, flag in enumerate(word[1:], 2):
                if flag in spec.inline:
                    return None
                if flag in spec.value or flag in spec.rest:
                    if flag in spec.value and position == len(word):
                        index += 1  # its value is the next word
                    break
            index += 1
            continue
        if subcommand:
            subcommand = False
            if word in spec.runs:
                index += 1
                continue
            if re.fullmatch(r"[a-z][a-z-]*", word):
                return None  # another subcommand, such as `deno test` or `bun install`
        return "script", word
    return "stdin", ""


def _simple_command(
    words: list[str],
    inputs: list[str],
    base: Path,
    stack: list[Path],
    previous: list[Path],
    found: list[Path],
    depth: int,
    root: Path,
) -> Path:
    """Add the files one simple command runs to `found`; returns the directory the next command runs in."""
    index, directory = 0, base
    while index < len(words):
        word = words[index]
        if word in KEYWORDS or ASSIGNMENT.fullmatch(word):
            index += 1
            continue
        wrapper = posixpath.basename(word)
        if "/" in word and _literal(word):
            found.append(directory / word)
            if Path(os.path.abspath(directory / word)).is_relative_to(root):
                break  # A repository program named env/time/etc. is still its own program.
        if wrapper not in WRAPPERS:
            break
        index, values = _options(words, index + 1, *WRAPPERS[wrapper])
        if wrapper == "env":
            chdir = values.get("C", values.get("--chdir"))
            if chdir is not None and _literal(chdir):
                directory = directory / chdir
            split = values.get("S", values.get("--split-string"))
            if split is not None:
                if depth < MAX_DEPTH:
                    try:
                        split_words = shlex.split(split, comments=True)
                    except ValueError:
                        return base
                    _simple_command([*split_words, *words[index:]], inputs, directory, [], [], found, depth + 1, root)
                return base
        if wrapper == "timeout":
            index += 1  # the duration
    if index >= len(words):
        return base
    program, operands = words[index], words[index + 1 :]
    if program in ("cd", "pushd", "popd"):
        if program == "popd":
            if stack:
                previous[:] = [base]
                return stack.pop()
            return base
        start, _ = _options(operands, 0)
        target = operands[start] if start < len(operands) else ""
        if target == "-" and program == "cd":
            target_path = previous[0] if previous else base
        elif not _literal(target) or target == "-" or target.startswith("+"):
            return base  # cd alone, pushd +1: not a directory this can follow
        else:
            target_path = base / target
        if program == "pushd":
            stack.append(base)
        previous[:] = [base]
        return target_path
    if "/" in program and _literal(program):
        found.append(directory / program)
    script = _script(program, operands)
    if script is not None:
        kind, value = script
        if kind == "command" and depth < MAX_DEPTH:
            found.extend(_named(value, directory, depth + 1, root=root))
        elif kind == "script" and _literal(value):
            found.append(directory / value)
        elif kind == "stdin" and inputs and _literal(inputs[-1]):
            found.append(directory / inputs[-1])  # `sh < gate.sh`
    return base


def _named(command: str, base: Path, depth: int = 0, *, root: Path | None = None) -> list[Path]:
    """The files a shell command line runs: each command's program when it is a path, and the script an
    interpreter is given. Follows `cd`/`pushd`/`popd` and subshells, `sh -c '...'` and `$(...)`."""
    root = base if root is None else root
    found: list[Path] = []
    stack: list[Path] = []
    previous: list[Path] = []
    scopes: list[tuple[Path, list[Path], list[Path]]] = []
    words: list[str] = []
    inputs: list[str] = []
    redirection: str | None = None
    for kind, text, nested in [*_tokens(command), ("op", ";", [])]:
        if kind == "word":
            if depth < MAX_DEPTH:
                for inner in nested:
                    found.extend(_named(inner, base, depth + 1, root=root))
            if redirection is None:
                words.append(text)
            elif redirection == "<":
                inputs.append(text)
            redirection = None
            continue
        if text in REDIRECTIONS or text in HERE_DOCUMENTS:
            redirection = text
            continue
        redirection = None
        if words:
            base = _simple_command(words, inputs, base, stack, previous, found, depth, root)
            words, inputs = [], []
        if text == "(":
            scopes.append((base, list(stack), list(previous)))
        elif text == ")" and scopes:
            base, stack, previous = scopes.pop()  # a subshell's cd is undone
    return found


def _record(path: Path, root: Path, names: dict[str, None]) -> None:
    """Name a path whose directory is already real, as Git tracks it: relative to the root, outside .git."""
    try:
        relative = path.relative_to(root)
    except ValueError:
        return
    if relative.parts and relative.parts[0] != ".git":
        names[relative.as_posix()] = None


def _resolve(
    path: Path,
    root: Path,
    names: dict[str, None],
    *,
    parents: bool = True,
    hops: int = 0,
) -> Path | None:
    """Resolve components one link at a time, retaining every hop before following it."""
    current = Path(path.anchor)
    parts = path.parts[1:]
    for index, part in enumerate(parts):
        current = current.parent if part == ".." else current / part
        if current.is_symlink():
            if parents or index == len(parts) - 1:
                _record(current, root, names)
            if hops >= MAX_LINK_HOPS:
                return None
            try:
                link = Path(os.readlink(current))
            except OSError:
                return None
            target = link if link.is_absolute() else current.parent / link
            return _resolve(target.joinpath(*parts[index + 1 :]), root, names, parents=parents, hops=hops + 1)
    return current


def _protect(
    path: Path,
    root: Path,
    names: dict[str, None],
    *,
    explicit: bool,
    parents: bool = True,
    seen: set[Path] | None = None,
) -> None:
    """Add the names a file at `path` depends on: every symlinked directory on the way to it, each hop of a
    symlink chain and its target. A derived name counts only for an existing file; an explicit one always."""
    # Do not retain parent links for a derived operand that is not an existing gate file.
    if not explicit and (not path.exists() or path.is_dir()):
        return
    target = _resolve(path, root, names, parents=parents)
    if target is None:
        return
    seen = set() if seen is None else seen
    # A link inside a protected directory may name that directory or an ancestor. Keep the
    # link itself, but never turn it into protection of the surrounding editable workspace.
    if any(directory.is_relative_to(target) for directory in seen):
        return
    _record(target, root, names)
    # Directory hashes retain links as links. Record their dependencies separately, without walking
    # outside the repository or revisiting directories through cycles.
    if explicit and target.is_relative_to(root) and target.is_dir() and target not in seen:
        seen.add(target)
        for directory, directories, files in os.walk(target, followlinks=False):
            directories[:] = [name for name in directories if name != ".git"]
            for name in sorted([*directories, *files]):
                child = Path(directory) / name
                if child.is_symlink():
                    _protect(child, root, names, explicit=True, parents=parents, seen=seen)


def gate_paths(commands: list[str], repo: Path) -> list[str]:
    """The gate's own files that verify commands run, as the workspace stands now.

    Two kinds count: the program a command runs when it is given as a path (`./gate.sh`,
    `.venv/bin/pytest`, `node_modules/.bin/vitest`), and the script handed to an interpreter
    (`python3 tools/gen.py`, `bash -e check.sh`). Arguments are never gate files: `pytest tests/x.py`
    protects nothing, and neither do redirections or globs. Git-ignored files count too. The runner
    takes these from the snapshot before the first handoff and drops files the run changes, which are
    the work under test. Anything else a gate depends on is listed in protect_paths.
    """
    root = Path(os.path.realpath(repo))
    names: dict[str, None] = {}
    for command in commands:
        for path in _named(command, root):
            _protect(path, root, names, explicit=False)
    return list(names)


def protected_paths(entries: list[str], repo: Path) -> list[str]:
    """Explicit protect_paths entries (repository-relative files or directories) as names to fingerprint.

    Each is protected whether or not it exists, is ignored by Git or was changed by the run, together
    with the symlinked directories and link hops it is reached through.
    """
    root = Path(os.path.realpath(repo))
    names: dict[str, None] = {}
    for entry in entries:
        _protect(root / entry, root, names, explicit=True)
    return list(names)


def released(path: str, rules: list[str]) -> bool:
    """Whether a path a steer explicitly allowed (`rules`, each a path or ".") covers `path`."""
    return _REPO_PATHS.path_covered_by_prefixes(path, rules, exclude_git=False)


def release_paths(entries: list[str]) -> list[str]:
    """The paths a steer frees: exactly those it names, with everything under them.

    A release never follows symlinks, so it can never reach a gate through a link, whether the
    link existed at the start or the worker made it later. To let a worker edit a gate through a
    link, release the link's target as well; the gate-edit violation names it.
    """
    return ["."] if "." in entries else list(dict.fromkeys(entries))


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
    lines.append(BLOCKED_GUIDANCE)
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
