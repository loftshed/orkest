"""Propagate untracked repo .env files and .worktreeinclude entries across worktrees and subagents."""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
from collections.abc import Mapping, MutableMapping
from pathlib import Path

MAX_DOTENV_BYTES = 262_144
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ROOT_ENV_FILE_RE = re.compile(r"^\.env(?:\.[^/]+)?$")
ENV_TEMPLATE_FILE_RE = re.compile(r"^\.env\.(?:defaults|dist|example|sample|schema|template)(?:\..+)?$", re.IGNORECASE)
EXPORT_LINE_RE = re.compile(r"^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=", re.MULTILINE)

BLOCKED_EXACT_KEYS = frozenset(
    {
        "ALL_PROXY",
        "ANTHROPIC_BASE_URL",
        "BASH_ENV",
        "CARGO_BUILD_RUSTC_WRAPPER",
        "CDPATH",
        "CLAUDE_CONFIG_DIR",
        "DOTNET_STARTUP_HOOKS",
        "ENV",
        "GOFLAGS",
        "HOME",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "IFS",
        "INFOPATH",
        "JAVA_TOOL_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "LOGNAME",
        "MANPATH",
        "NODE_EXTRA_CA_CERTS",
        "NODE_OPTIONS",
        "NODE_PATH",
        "NODE_REDIRECT_WARNINGS",
        "NO_PROXY",
        "NPM_CONFIG_GLOBALCONFIG",
        "NPM_CONFIG_PREFIX",
        "NPX_CONFIG_USERCONFIG",
        "OLDPWD",
        "OPENAI_BASE_URL",
        "OPENSSL_CONF",
        "OPENSSL_ENGINES",
        "PATH",
        "PERL5DB",
        "PERL5LIB",
        "PERL5OPT",
        "PROMPT_COMMAND",
        "PS1",
        "PS2",
        "PS4",
        "PWD",
        "PYTHONEXECUTABLE",
        "PYTHONHOME",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "PYTHONWARNINGS",
        "RUBYLIB",
        "RUBYOPT",
        "RUSTC_WRAPPER",
        "SHELL",
        "SHLVL",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USER",
        "ZDOTDIR",
        "_JAVA_OPTIONS",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    }
)

BLOCKED_PREFIXES = (
    "AGENT_EXECUTOR_",
    "AGENT_MAILBOX_",
    "ANTIGRAVITY_",
    "BASH_FUNC_",
    "CLAUDE_CODE_",
    "CODEX_",
    "DYLD_",
    "GEMINI_",
    "GIT_",
    "HERDR_",
    "LD_",
    "OPENCODE_",
    "ORCHESTRATE_",
    "ORKEST_",
    "SSH_",
    "TMUX",
)

CLAUDE_ISOLATED_AUTH_KEYS = frozenset(
    {
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
    }
)


def is_safe_dotenv_key(key: str) -> bool:
    if not ENV_KEY_RE.fullmatch(key):
        return False
    if key in BLOCKED_EXACT_KEYS:
        return False
    return not key.startswith(BLOCKED_PREFIXES)


def _unescape_double_quoted(raw: str) -> str:
    escapes = {"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\", "$": "$"}
    out: list[str] = []
    idx = 0
    while idx < len(raw):
        ch = raw[idx]
        if ch == "\\" and idx + 1 < len(raw):
            nxt = raw[idx + 1]
            out.append(escapes.get(nxt, "\\" + nxt))
            idx += 2
            continue
        out.append(ch)
        idx += 1
    return "".join(out)


def parse_dotenv(text: str) -> dict[str, str]:
    """Parse KEY=VALUE assignments strictly as literal data without shell execution."""
    cleaned = text.removeprefix(chr(0xFEFF))
    lines = cleaned.splitlines()
    parsed: dict[str, str] = {}
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export ") or stripped.startswith("export\t"):
            stripped = stripped[6:].lstrip()
        if "=" not in stripped:
            continue
        raw_key, raw_value = stripped.split("=", 1)
        key = raw_key.strip()
        if not ENV_KEY_RE.fullmatch(key):
            continue
        value_part = raw_value.lstrip(" \t")
        if not value_part:
            parsed[key] = ""
            continue
        quote = value_part[0]
        if quote in {"'", '"'}:
            buffer = value_part[1:]
            chunks: list[str] = []
            closed = False
            while True:
                pos = 0
                while pos < len(buffer):
                    if quote == '"' and buffer[pos] == "\\":
                        pos += 2
                        continue
                    if buffer[pos] == quote:
                        segment = buffer[:pos]
                        chunks.append(_unescape_double_quoted(segment) if quote == '"' else segment)
                        closed = True
                        break
                    pos += 1
                if closed or index >= len(lines):
                    if not closed:
                        chunks.append(_unescape_double_quoted(buffer) if quote == '"' else buffer)
                    break
                chunks.append(_unescape_double_quoted(buffer) if quote == '"' else buffer)
                chunks.append("\n")
                buffer = lines[index]
                index += 1
            parsed[key] = "".join(chunks)
            continue
        unquoted = re.split(r"\s+#", value_part, maxsplit=1)[0].strip()
        parsed[key] = unquoted
    return parsed


def _git_output(cwd: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def resolve_worktree_roots(cwd: Path | str) -> tuple[Path, Path] | None:
    """Return (worktree_root, main_repo_root) when cwd is inside a non-bare Git checkout."""
    target = Path(cwd).expanduser()
    if not target.is_dir():
        return None
    rev = _git_output(target, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir")
    if not rev:
        return None
    parts = [line.strip() for line in rev.splitlines() if line.strip()]
    if len(parts) < 2:
        return None
    worktree_root = Path(parts[0]).resolve()
    common_dir = Path(parts[1]).resolve()
    porcelain = _git_output(worktree_root, "worktree", "list", "--porcelain")
    if porcelain:
        first_block = porcelain.split("\n\n", 1)[0].splitlines()
        first_path: Path | None = None
        is_bare = False
        for entry in first_block:
            if entry.startswith("worktree "):
                first_path = Path(entry[len("worktree ") :].strip()).resolve()
            elif entry == "bare":
                is_bare = True
        if first_path is not None and not is_bare and first_path.is_dir():
            return worktree_root, first_path
    if common_dir.name == ".git" and common_dir.parent.is_dir():
        return worktree_root, common_dir.parent.resolve()
    return worktree_root, worktree_root


def _normalize_rel_pattern(raw: str) -> str:
    slash = raw.replace("\\", "/").strip()
    if not slash or slash.startswith("/"):
        return ""
    parts: list[str] = []
    for piece in slash.split("/"):
        if not piece or piece == ".":
            continue
        if piece == "..":
            return ""
        parts.append(piece)
    if not parts or parts[0] == ".git":
        return ""
    return "/".join(parts)


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    out = ["^"]
    idx = 0
    while idx < len(pattern):
        ch = pattern[idx]
        if ch == "*":
            if idx + 1 < len(pattern) and pattern[idx + 1] == "*":
                out.append(".*")
                idx += 2
                continue
            out.append("[^/]*")
        elif ch == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(ch))
        idx += 1
    out.append("$")
    return re.compile("".join(out))


def _is_within(real_root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(real_root)
        return True
    except ValueError:
        return False


def _tracked_files(repo_root: Path) -> set[str]:
    out = _git_output(repo_root, "ls-files")
    if out is None:
        return set()
    return {norm for line in out.splitlines() if (norm := _normalize_rel_pattern(line))}


def _parse_worktreeinclude(include_path: Path) -> tuple[list[str], list[re.Pattern[str]]]:
    if not include_path.is_file():
        return [], []
    try:
        raw_lines = include_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return [], []
    includes: list[str] = []
    excludes: list[re.Pattern[str]] = []
    for raw in raw_lines:
        trimmed = raw.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        if trimmed.startswith("!"):
            neg = _normalize_rel_pattern(trimmed[1:])
            if neg:
                excludes.append(_glob_to_regex(neg))
            continue
        norm = _normalize_rel_pattern(trimmed)
        if norm:
            includes.append(norm)
    return includes, excludes


def _list_files_recursive(root_dir: Path, real_root: Path, current_rel: str = "") -> list[str]:
    abs_dir = root_dir / current_rel if current_rel else root_dir
    try:
        entries = list(os.scandir(abs_dir))
    except OSError:
        return []
    found: list[str] = []
    for entry in entries:
        if entry.name in {".git", "node_modules"}:
            continue
        rel = f"{current_rel}/{entry.name}" if current_rel else entry.name
        entry_path = root_dir / rel
        try:
            if entry.is_symlink():
                real_target = entry_path.resolve(strict=True)
                if _is_within(real_root, real_target) and real_target.is_file():
                    found.append(rel)
                continue
            if entry.is_dir(follow_symlinks=False):
                found.extend(_list_files_recursive(root_dir, real_root, rel))
            elif entry.is_file(follow_symlinks=False):
                found.append(rel)
        except OSError:
            continue
    return found


def _is_sensitive_env_name(name: str) -> bool:
    return bool(ROOT_ENV_FILE_RE.fullmatch(name) and not ENV_TEMPLATE_FILE_RE.fullmatch(name))


def bootstrap_worktree_env(cwd: Path | str, *, overwrite: bool = False) -> list[str]:
    """Materialize untracked main-checkout .env* and .worktreeinclude files into a linked worktree."""
    roots = resolve_worktree_roots(cwd)
    if roots is None:
        return []
    worktree_root, main_root = roots
    if worktree_root == main_root:
        return []

    real_main = main_root.resolve()
    real_worktree = worktree_root.resolve()
    tracked = _tracked_files(main_root)
    includes, excludes = _parse_worktreeinclude(main_root / ".worktreeinclude")

    candidates: set[str] = set()
    try:
        for entry in os.scandir(main_root):
            if not _is_sensitive_env_name(entry.name) or entry.name in tracked:
                continue
            real_target = Path(entry.path).resolve(strict=True)
            if _is_within(real_main, real_target) and real_target.is_file():
                candidates.add(entry.name)
    except OSError:
        pass

    all_files: list[str] | None = None
    for pattern in includes:
        if any(ch in pattern for ch in "*?[]"):
            if all_files is None:
                all_files = _list_files_recursive(main_root, real_main)
            matcher = _glob_to_regex(pattern)
            for rel in all_files:
                if matcher.match(rel) and rel not in tracked:
                    candidates.add(rel)
            continue
        source_path = main_root / pattern
        if not source_path.exists():
            continue
        try:
            real_target = source_path.resolve(strict=True)
            if not _is_within(real_main, real_target):
                continue
            if real_target.is_dir():
                for rel in _list_files_recursive(main_root, real_main, pattern):
                    if rel not in tracked:
                        candidates.add(rel)
            elif real_target.is_file() and pattern not in tracked:
                candidates.add(pattern)
        except OSError:
            continue

    copied: list[str] = []
    for rel in sorted(candidates):
        if any(ex.match(rel) for ex in excludes):
            continue
        src = main_root / rel
        dest = worktree_root / rel
        try:
            real_src = src.resolve(strict=True)
            if not _is_within(real_main, real_src) or not real_src.is_file():
                continue
        except OSError:
            continue
        if not overwrite and (dest.exists() or dest.is_symlink()):
            continue
        if dest.is_symlink():
            continue
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not _is_within(real_worktree, dest.parent.resolve()):
                continue
            shutil.copyfile(real_src, dest)
            if _is_sensitive_env_name(dest.name):
                dest.chmod(0o600)
            copied.append(rel)
        except OSError:
            continue
    return copied


def _read_untracked_dotenv_dir(
    directory: Path,
    repo_root: Path,
    real_root: Path,
    tracked: set[str],
    excludes: list[re.Pattern[str]],
) -> dict[str, str]:
    loaded: dict[str, str] = {}
    for filename in (".env", ".env.local"):
        candidate = directory / filename
        try:
            rel = candidate.relative_to(repo_root).as_posix()
        except ValueError:
            continue
        if rel in tracked or any(ex.match(rel) for ex in excludes):
            continue
        try:
            if not candidate.exists():
                continue
            real_file = candidate.resolve(strict=True)
            if not _is_within(real_root, real_file) or not real_file.is_file():
                continue
            size = real_file.stat().st_size
            if size <= 0 or size > MAX_DOTENV_BYTES:
                continue
            raw = real_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for key, value in parse_dotenv(raw).items():
            if is_safe_dotenv_key(key):
                loaded[key] = value
    return loaded


def load_repo_dotenv(cwd: Path | str | None) -> dict[str, str]:
    """Load safe, untracked .env and .env.local defaults for cwd (including main-worktree fallback)."""
    if cwd is None:
        return {}
    target = Path(cwd).expanduser()
    roots = resolve_worktree_roots(target)
    if roots is None:
        return {}
    worktree_root, main_root = roots
    _, main_excludes = _parse_worktreeinclude(main_root / ".worktreeinclude")
    _, wt_excludes = _parse_worktreeinclude(worktree_root / ".worktreeinclude")
    excludes = [*main_excludes, *wt_excludes]

    merged: dict[str, str] = {}
    if main_root != worktree_root:
        main_tracked = _tracked_files(main_root)
        merged.update(_read_untracked_dotenv_dir(main_root, main_root, main_root.resolve(), main_tracked, excludes))

    wt_tracked = _tracked_files(worktree_root)
    real_wt = worktree_root.resolve()
    merged.update(_read_untracked_dotenv_dir(worktree_root, worktree_root, real_wt, wt_tracked, excludes))

    resolved_target = target.resolve()
    if resolved_target != real_wt and _is_within(real_wt, resolved_target):
        merged.update(_read_untracked_dotenv_dir(resolved_target, worktree_root, real_wt, wt_tracked, excludes))
    return merged


def apply_repo_dotenv(environment: MutableMapping[str, str], cwd: Path | str | None) -> list[str]:
    """Populate missing keys in environment from untracked repo .env/.env.local files."""
    defaults = load_repo_dotenv(cwd)
    applied: list[str] = []
    for key, value in defaults.items():
        if key not in environment:
            environment[key] = value
            applied.append(key)
    return applied


def _is_isolated_claude_profile(environ: Mapping[str, str]) -> bool:
    configured = environ.get("CLAUDE_CONFIG_DIR", "").strip()
    if not configured:
        return False
    try:
        return Path(configured).expanduser().resolve() != (Path.home() / ".claude").resolve()
    except OSError:
        return True


def export_claude_env_file(
    cwd: Path | str | None,
    *,
    env_file: Path | str | None = None,
    environ: Mapping[str, str] | None = None,
) -> list[str]:
    """Append safe repo .env defaults to Claude Code's $CLAUDE_ENV_FILE idempotently."""
    effective_environ = os.environ if environ is None else environ
    raw_target = env_file if env_file is not None else effective_environ.get("CLAUDE_ENV_FILE", "")
    if not raw_target or not str(raw_target).strip():
        return []
    target = Path(str(raw_target).strip()).expanduser()
    try:
        if target.is_symlink():
            return []
    except OSError:
        return []

    defaults = load_repo_dotenv(cwd)
    if not defaults:
        return []

    isolated_claude = _is_isolated_claude_profile(effective_environ)
    existing_exported: set[str] = set()
    if target.exists():
        try:
            existing_text = target.read_text(encoding="utf-8", errors="replace")
            existing_exported.update(EXPORT_LINE_RE.findall(existing_text))
        except OSError:
            return []

    lines_to_append: list[str] = []
    exported_keys: list[str] = []
    for key, value in defaults.items():
        if key in effective_environ or key in existing_exported:
            continue
        if isolated_claude and key in CLAUDE_ISOLATED_AUTH_KEYS:
            continue
        lines_to_append.append(f"export {key}={shlex.quote(value)}\n")
        exported_keys.append(key)

    if not lines_to_append:
        return []

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, "".join(lines_to_append).encode("utf-8"))
        finally:
            os.close(fd)
    except OSError:
        return []
    return exported_keys
