#!/usr/bin/env python3
"""Scoped, backed-up, idempotent migration of harness-facing Orkest paths (issue 233, stage 0).

The restructuring in issue 233 moves the runtime out of `plugins/*` and the skill folder. User machines
hold absolute paths into the old layout: links in `~/.local/bin` and the skill hubs, generated commands,
hook commands and trust rules. This module finds exactly those references and rewrites them to the new
layout once, and only once, the new file really exists. Until a stage lands its move, the same inventory is
reported as `pending` and nothing is touched, so a working install is never pointed at a missing file.

Scope: only symlinks whose target is under a known Orkest checkout's old path, and only complete path
references inside owned values (hook, status line, permission and MCP commands, generated commands, rules and
the trust state) of the harness files in `text_files`. Everything else is left byte for byte. Files that are
hard-linked or that resolve outside the home are reported as blocked and never written.

Default mode is a read-only report. `--apply` first backs up and digests everything (to
`~/.local/share/orchestrate/backups`), records before/after state per entry, then swaps each entry in place and
rolls back on failure. `--restore DIR` refuses to touch anything the user changed since the apply.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

SCHEMA = "ork.path-migration.v1"
MANIFEST = "manifest.json"
MAX_TEXT_BYTES = 5_000_000

# (old, new) paths relative to the checkout root, longest `old` first. Each maps a whole subtree; a
# reference migrates only if the mapped file or directory exists. Stage 3 has not decided where monitor's
# lib lands, so it has no rule yet.
MOVES: tuple[tuple[str, str], ...] = (
    ("plugins/orchestrate/skills/orchestrate/scripts", "src/py"),
    ("plugins/orchestrate/skills/orchestrate/references", "references"),
    ("plugins/orchestrate/commands", "adapters/claude/commands"),
    ("plugins/orchestrate/skills", "adapters/skills"),
    ("plugins/monitor/skills", "adapters/skills"),
    ("plugins/orchestrate/bin", "src/bin"),
    ("plugins/monitor/bin", "src/bin"),
    ("plugins/orchestrate/lib", "src/lib"),
)
# Hooks and rules written by the installer name scripts through each skill link, which points at the hub.
SCRIPTS_NEW = "src/py"
# String values under these JSON/TOML keys (or keys inside them) are installer-owned command lines and rules.
OWNED_KEYS = frozenset(
    {
        "hooks",
        "statusLine",
        "permissions",
        "permission",
        "mcpServers",
        "mcp",
        "mcp_servers",
        "command",
        "args",
        "allow",
        "ask",
        "deny",
        "entries",
        "ask_entries",
    }
)
GENERATED_COMMANDS = frozenset({"swarm", "horde", "cleanup", "chief", "side", "update"})
_SEGMENT = r"[A-Za-z0-9_@+\-]+(?:\.[A-Za-z0-9_@+\-]+)*"


class MigrationError(RuntimeError):
    """A migration or restore stopped before mutating anything it could not undo."""


@dataclass(frozen=True)
class Rule:
    old: str  # absolute
    new: str  # absolute


@dataclass
class Change:
    kind: str  # "symlink" or "text"
    path: str
    status: str  # "ready" (a destination exists), "pending" (destinations missing) or "blocked"
    replacements: list[tuple[str, str]] = field(default_factory=list)  # old -> new, unique pairs
    occurrences: int = 0
    reason: str = ""
    flavor: str = ""

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "path": self.path,
            "status": self.status,
            "reason": self.reason,
            "occurrences": self.occurrences,
            "replacements": [{"old": old, "new": new, "exists": os.path.exists(new)} for old, new in self.replacements],
        }


def find_root(start: Path | None = None) -> Path | None:
    """The checkout holding this module: the nearest parent with package.json and a runtime layout."""
    here = (start or Path(__file__)).resolve()
    for parent in here.parents:
        if (parent / "package.json").is_file() and ((parent / "plugins").is_dir() or (parent / "src").is_dir()):
            return parent
    return None


def _inside(path: Path, home: Path) -> bool:
    try:
        return path.resolve().is_relative_to(home.resolve())
    except OSError:
        return False


def _env_dir(name: str, default: Path, home: Path) -> Path:
    """An environment override, honoured only inside `home` so a test home never reaches the real profile."""
    value = os.environ.get(name)
    if value:
        candidate = Path(value).expanduser()
        if _inside(candidate, home):
            return candidate
    return default


def _variants(path: Path) -> list[str]:
    values = {str(path)}
    with contextlib.suppress(OSError):
        values.add(str(path.resolve()))
    return sorted(values)


def known_roots(home: Path, extra: list[Path] | None = None) -> list[Path]:
    """This checkout, explicit roots, and the checkout `~/.local/bin/ork` currently links into."""
    roots: list[Path] = []

    def add(candidate: Path | None) -> None:
        if candidate is not None and candidate not in roots:
            roots.append(candidate)

    for root in extra or []:
        add(root.expanduser().resolve())
    add(find_root())
    link = home / ".local/bin/ork"
    if link.is_symlink():
        text = str(link.resolve()) if _inside(link.parent, home) else ""
        for old, _new in MOVES:
            needle = "/" + old + "/"
            if needle in text:
                add(Path(text.split(needle, 1)[0]))
                break
    return [root for root in roots if root.is_dir()]


def claude_profiles(home: Path) -> list[Path]:
    """`~/.claude`, every `~/.claude-*` profile with settings, and a configured CLAUDE_CONFIG_DIR inside home."""
    profiles = [home / ".claude"]
    profiles += sorted(
        p
        for p in home.glob(".claude-*")
        if p.is_dir() and ((p / "settings.json").is_file() or (p / ".claude.json").is_file())
    )
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    if configured and _inside(Path(configured).expanduser(), home):
        profiles.append(Path(configured).expanduser())
    unique: list[Path] = []
    for profile in profiles:
        if profile.is_dir() and profile not in unique:
            unique.append(profile)
    return unique


def config_home(home: Path) -> Path:
    base = _env_dir("XDG_CONFIG_HOME", home / ".config", home)
    return base / "orchestrate"


def link_dirs(home: Path) -> list[Path]:
    codex = _env_dir("CODEX_HOME", home / ".codex", home)
    xdg = _env_dir("XDG_CONFIG_HOME", home / ".config", home)
    dirs = [home / ".local/bin", home / ".agents/skills", codex / "skills", home / ".codex/skills"]
    dirs += [home / ".gemini/config/skills", home / ".gemini/antigravity/skills", xdg / "opencode/skills"]
    dirs += [profile / "skills" for profile in claude_profiles(home)]
    unique: list[Path] = []
    for directory in dirs:
        if directory not in unique:
            unique.append(directory)
    return unique


def build_rules(home: Path, roots: list[Path]) -> list[Rule]:
    rules: dict[str, str] = {}
    for root in roots:
        for old, new in MOVES:
            for variant in _variants(root / old):
                rules[variant] = str(root / new)
        # Every skill link (hub, each harness) that really leads into this checkout is an alias of its scripts.
        for directory in link_dirs(home):
            alias = directory / "orchestrate"
            if alias.is_symlink() and (alias / "scripts").is_dir() and _inside_root(alias, root):
                for variant in _variants(alias / "scripts"):
                    rules.setdefault(variant, str(root / SCRIPTS_NEW))
    return [Rule(old, rules[old]) for old in sorted(rules, key=lambda value: (-len(value), value))]


def _inside_root(link: Path, root: Path) -> bool:
    try:
        return link.resolve().is_relative_to(root.resolve())
    except OSError:
        return False


def owned_command_names(roots: list[Path]) -> set[str]:
    names = set(GENERATED_COMMANDS)
    for root in roots:
        for directory in ("plugins/orchestrate/commands", "adapters/claude/commands"):
            names |= {p.stem for p in (root / directory).glob("*.md")}
    return names


def text_files(home: Path, roots: list[Path]) -> list[tuple[Path, str]]:
    """Harness files that can hold command lines or rules naming Orkest paths, with how to scan them."""
    files: list[tuple[Path, str]] = []
    names = owned_command_names(roots)
    for profile in claude_profiles(home):
        files += [(profile / name, "json") for name in ("settings.json", "settings.local.json", ".claude.json")]
        files += [(p, "md") for p in sorted((profile / "commands").glob("*.md")) if p.stem in names]
    files.append((home / ".claude.json", "json"))
    codex = _env_dir("CODEX_HOME", home / ".codex", home)
    files += [(codex / "hooks.json", "json"), (codex / "config.toml", "toml")]
    files += [(p, "text") for p in sorted((codex / "rules").glob("*.rules"))]
    files += [
        (home / ".gemini/config/hooks.json", "json"),
        (home / ".gemini/config/mcp_config.json", "json"),
        (home / ".gemini/antigravity-cli/settings.json", "json"),
    ]
    opencode = _env_dir("XDG_CONFIG_HOME", home / ".config", home) / "opencode"
    files += [(opencode / "opencode.json", "json"), (opencode / "opencode.jsonc", "json")]
    files += [(p, "md") for p in sorted((opencode / "commands").glob("*.md")) if p.stem in names]
    files.append((config_home(home) / "command-approval.json", "json"))
    return files


def _map(rule_set: list[Rule], text: str) -> tuple[str, str] | None:
    """Map one absolute path through the longest matching rule; None if no rule covers it."""
    for rule in rule_set:
        if text == rule.old or text.startswith(rule.old + "/"):
            return text, rule.new + text[len(rule.old) :]
    return None


def _abs_target(link: Path, target: str) -> str:
    return target if os.path.isabs(target) else os.path.normpath(str(link.parent / target))


def _symlink_changes(rules: list[Rule], directory: Path, home: Path, seen: set[str]) -> list[Change]:
    changes: list[Change] = []
    if not directory.is_dir():
        return changes
    for entry in sorted(directory.iterdir()):
        if not entry.is_symlink() or str(entry) in seen:
            continue
        mapped = _map(rules, _abs_target(entry, os.readlink(entry)))
        if mapped is None:
            continue
        seen.add(str(entry))
        if not _inside(entry.parent, home):
            changes.append(Change("symlink", str(entry), "blocked", [mapped], 1, "directory resolves outside home"))
            continue
        status = "ready" if os.path.exists(mapped[1]) else "pending"
        changes.append(Change("symlink", str(entry), status, [mapped], 1))
    return changes


def _text_pattern(rules: list[Rule]) -> re.Pattern[str]:
    alternatives = "|".join(re.escape(rule.old) for rule in rules)
    # Not preceded by more path (so `/x/<root>/...` is not ours) and not followed by more name.
    return re.compile(
        rf"(?<![A-Za-z0-9_.\-/~])(?P<old>{alternatives})(?P<rest>(?:/{_SEGMENT})*)(?![A-Za-z0-9_\-]|\.[A-Za-z0-9])"
    )


def _json_spans(text: str) -> list[tuple[int, int]]:
    """Character ranges of JSON(C) string tokens that are owned: some enclosing key is in OWNED_KEYS."""
    spans: list[tuple[int, int]] = []
    stack: list[list] = []  # ["o", current_key, expecting_key] or ["a"]
    i, n = 0, len(text)
    while i < n:
        char = text[i]
        if char == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            raw = text[i + 1 : j]
            top = stack[-1] if stack else None
            if top and top[0] == "o" and top[2]:
                owned = any(frame[1] in OWNED_KEYS for frame in stack[:-1] if frame[0] == "o")
                top[1], top[2] = raw, False
            else:
                owned = any(frame[1] in OWNED_KEYS for frame in stack if frame[0] == "o")
            if owned:
                spans.append((i + 1, j))
            i = j + 1
            continue
        if char == "/" and text.startswith("//", i):
            i = text.find("\n", i)
            i = n if i < 0 else i
            continue
        if char == "/" and text.startswith("/*", i):
            i = text.find("*/", i + 2)
            i = n if i < 0 else i + 2
            continue
        if char == "{":
            stack.append(["o", None, True])
        elif char == "[":
            stack.append(["a"])
        elif char in "}]" and stack:
            stack.pop()
        elif char == "," and stack and stack[-1][0] == "o":
            stack[-1][1], stack[-1][2] = None, True
        i += 1
    return spans


def _toml_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    offset, in_array = 0, False
    for line in text.splitlines(keepends=True):
        match = re.match(r'\s*"?([A-Za-z0-9_\-]+)"?\s*=(.*)', line)
        if match:
            owned = match.group(1) in OWNED_KEYS
            in_array = owned and "[" in match.group(2) and "]" not in match.group(2)
        elif in_array:
            owned = True
            in_array = "]" not in line
        else:
            owned = False
        if owned:
            spans.append((offset, offset + len(line)))
        offset += len(line)
    return spans


def _rewrite(rules: list[Rule], text: str, flavor: str, *, only_ready: bool) -> tuple[str, Change]:
    pattern = _text_pattern(rules)
    new_for = {rule.old: rule.new for rule in rules}
    pairs: list[tuple[str, str]] = []
    counts = {"ready": 0, "pending": 0}

    def replace(match: re.Match[str]) -> str:
        original = match.group(0)
        candidate = new_for[match.group("old")] + match.group("rest")
        ready = os.path.exists(candidate)
        counts["ready" if ready else "pending"] += 1
        if (original, candidate) not in pairs:
            pairs.append((original, candidate))
        return candidate if ready or not only_ready else original

    if not rules:
        spans: list[tuple[int, int]] = []
    elif flavor == "json":
        spans = _json_spans(text)
    elif flavor == "toml":
        spans = _toml_spans(text)
    else:
        spans = [(0, len(text))]
    out, cursor = [], 0
    for start, end in spans:
        out += [text[cursor:start], pattern.sub(replace, text[start:end])]
        cursor = end
    out.append(text[cursor:])
    updated = "".join(out)
    status = "ready" if counts["ready"] else "pending"
    return updated, Change("text", "", status, pairs, counts["ready"] + counts["pending"], flavor=flavor)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def discover(home: Path, *, roots: list[Path] | None = None) -> dict:
    """Read-only inventory of every path this migration would touch."""
    home = home.expanduser()
    roots = known_roots(home, roots)
    rules = build_rules(home, roots)
    changes: list[Change] = []
    seen: set[str] = set()
    if rules:
        for directory in link_dirs(home):
            changes += _symlink_changes(rules, directory, home, seen)
        for path, flavor in text_files(home, roots):
            real = path.resolve() if path.exists() else path
            if str(real) in seen:
                continue
            try:
                if not stat.S_ISREG(path.stat().st_mode):
                    raise ValueError("not a regular file")
                with path.open("rb") as stream:
                    data = stream.read(MAX_TEXT_BYTES + 1)
                if len(data) > MAX_TEXT_BYTES:
                    raise ValueError("file exceeds inventory size limit")
                text = data.decode("utf-8")
            except FileNotFoundError:
                continue
            except (OSError, ValueError) as exc:
                reason = "invalid UTF-8" if isinstance(exc, UnicodeDecodeError) else str(exc)
                changes.append(Change("text", str(path), "blocked", reason=f"not inspected: {reason}"))
                seen.add(str(real))
                continue
            _, change = _rewrite(rules, text, flavor, only_ready=False)
            if not change.occurrences:
                continue
            seen.add(str(real))
            change.path = str(path)
            if not _inside(real, home):
                change.status, change.reason = "blocked", "resolves outside home"
            elif real.stat().st_nlink > 1:
                change.status, change.reason = "blocked", "hard-linked file"
            changes.append(change)
    ready = [c for c in changes if c.status == "ready"]
    blocked = [c for c in changes if c.status == "blocked"]
    return {
        "schema": SCHEMA,
        "home": str(home),
        "roots": [str(root) for root in roots],
        "claude_profiles": [str(p) for p in claude_profiles(home)],
        "changes": [c.as_dict() for c in changes],
        "ready": len(ready),
        "blocked": len(blocked),
        "pending": len(changes) - len(ready) - len(blocked),
        "total": len(changes),
    }


def backup_root(home: Path) -> Path:
    return home / ".local/share/orchestrate/backups"


def _atomic_write(path: Path, data: bytes, expect_sha: str) -> None:
    """Replace `path` (through a symlink, keeping hard links out of it) only if it still has `expect_sha`."""
    real = path.resolve()
    mode = real.stat().st_mode & 0o7777
    handle, temp = tempfile.mkstemp(prefix=f".{real.name}.orkest-", dir=str(real.parent))
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
        os.chmod(temp, mode)
        if _sha(real.read_bytes()) != expect_sha:
            raise MigrationError(f"changed during migration: {path}")
        os.replace(temp, real)
    except BaseException:
        Path(temp).unlink(missing_ok=True)  # our own temp file only
        raise


def _set_symlink(path: Path, target: str, expect: str) -> None:
    """Swap a symlink via a fresh uniquely named sibling; never removes an existing file."""
    for _ in range(16):
        temp = path.with_name(f".{path.name}.orkest-{secrets.token_hex(4)}")
        try:
            os.symlink(target, temp)
        except FileExistsError:
            continue
        break
    else:
        raise MigrationError(f"no free temporary name beside {path}")
    try:
        if not path.is_symlink() or os.readlink(path) != expect:
            raise MigrationError(f"changed during migration: {path}")
        os.replace(temp, path)
    except BaseException:
        if os.path.lexists(temp):
            os.unlink(temp)  # our own temp link only
        raise


def _flush(directory: Path, entries: list[dict], state: str) -> None:
    payload = json.dumps({"schema": SCHEMA, "state": state, "entries": entries}, indent=2) + "\n"
    temp = directory / f".{MANIFEST}.tmp"
    temp.write_text(payload)
    os.replace(temp, directory / MANIFEST)


def _plan(home: Path, found: dict, rules: list[Rule]) -> tuple[list[dict], list[dict]]:
    """Recompute each ready change from the files as they are now; return (entries, skipped changes)."""
    entries: list[dict] = []
    skipped: list[dict] = []
    flavors = {str(p): f for p, f in text_files(home, [Path(r) for r in found["roots"]])}
    for change in found["changes"]:
        if change["status"] != "ready":
            continue
        path = Path(change["path"])
        if change["kind"] == "symlink":
            mapped = _map(rules, _abs_target(path, os.readlink(path)))
            if not path.is_symlink() or mapped is None or not os.path.exists(mapped[1]):
                skipped.append(change)
                continue
            entries.append(
                {
                    "kind": "symlink",
                    "path": str(path),
                    "before": os.readlink(path),
                    "after": mapped[1],
                    "status": "planned",
                }
            )
            continue
        data = path.resolve().read_bytes()
        updated, _ = _rewrite(rules, data.decode("utf-8"), flavors.get(str(path), "text"), only_ready=True)
        if updated.encode("utf-8") == data:
            skipped.append(change)
            continue
        entries.append(
            {
                "kind": "text",
                "path": str(path.resolve()),
                "before": _sha(data),
                "after": _sha(updated.encode("utf-8")),
                "content": updated,
                "status": "planned",
            }
        )
    return entries, skipped


def apply(home: Path, *, roots: list[Path] | None = None) -> dict:
    """Back up, then rewrite every ready change. Idempotent: a second run finds nothing ready."""
    home = home.expanduser()
    found = discover(home, roots=roots)
    result = {**found, "applied": 0, "backup": None, "skipped": found["total"] - found["ready"], "conflicts": []}
    if not found["ready"]:
        return result
    rules = build_rules(home, [Path(r) for r in found["roots"]])
    planned, skipped = _plan(home, found, rules)
    result["skipped"] += len(skipped)
    if not planned:
        return result
    directory = backup_root(home) / f"path-migration-{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{time.time_ns()}"
    directory.mkdir(parents=True, mode=0o700)
    (directory / "files").mkdir(mode=0o700)
    # Preflight: every backup exists and matches its source digest before anything is touched.
    for index, entry in enumerate(planned):
        if entry["kind"] == "text":
            source = Path(entry["path"])
            stored = directory / "files" / f"{index}-{source.name}"
            shutil.copyfile(source, stored)
            os.chmod(stored, 0o600)
            if _sha(stored.read_bytes()) != entry["before"]:
                raise MigrationError(f"backup digest mismatch for {source}; nothing was changed")
            entry["backup"] = str(stored)
    persisted = [{k: v for k, v in e.items() if k != "content"} for e in planned]
    _flush(directory, persisted, "prepared")
    done: list[int] = []
    try:
        for index, entry in enumerate(planned):
            path = Path(entry["path"])
            try:
                if entry["kind"] == "symlink":
                    _set_symlink(path, entry["after"], entry["before"])
                else:
                    _atomic_write(path, entry["content"].encode("utf-8"), entry["before"])
            except MigrationError as error:
                persisted[index]["status"] = "conflict"
                result["conflicts"].append(str(error))
                continue
            persisted[index]["status"] = "applied"
            done.append(index)
            _flush(directory, persisted, "applying")
    except BaseException:
        _rollback(persisted, done)
        _flush(directory, persisted, "rolled-back")
        raise
    _flush(directory, persisted, "applied")
    result.update(applied=len(done), backup=str(directory))
    return result


def _current(entry: dict) -> str:
    """'before', 'after' or 'other' for the entry's path as it is now."""
    path = Path(entry["path"])
    if entry["kind"] == "symlink":
        value = os.readlink(path) if path.is_symlink() else None
    else:
        value = _sha(path.read_bytes()) if path.is_file() and not path.is_symlink() else None
    return "before" if value == entry["before"] else "after" if value == entry["after"] else "other"


def _rollback(entries: list[dict], done: list[int]) -> None:
    for index in reversed(done):
        entry = entries[index]
        if entry["kind"] == "symlink":
            _set_symlink(Path(entry["path"]), entry["before"], entry["after"])
        else:
            _atomic_write(Path(entry["path"]), Path(entry["backup"]).read_bytes(), entry["after"])
        entry["status"] = "rolled-back"


def restore(directory: Path) -> int:
    """Undo one `apply`. Aborts, changing nothing, if a path was edited since or a backup is damaged."""
    manifest = json.loads((directory / MANIFEST).read_text())
    entries = manifest["entries"]
    todo: list[int] = []
    problems: list[str] = []
    for index, entry in enumerate(entries):
        if entry["kind"] == "text":
            stored = Path(entry["backup"])
            if not stored.is_file() or _sha(stored.read_bytes()) != entry["before"]:
                problems.append(f"backup damaged: {stored}")
                continue
        try:
            state = _current(entry)
        except OSError as error:
            problems.append(f"unreadable: {entry['path']} ({error})")
            continue
        if state == "after":
            todo.append(index)
        elif state == "other":
            problems.append(f"changed since migration: {entry['path']}")
    if problems:
        raise MigrationError("restore refused, nothing changed: " + "; ".join(problems))
    _rollback(entries, todo)
    return len(todo)


def summary(home: Path | None = None) -> dict:
    """Exact status for `doctor`: every affected path, its state and the destinations it waits for."""
    found = discover(home or Path.home())
    return {k: found[k] for k in ("ready", "pending", "blocked", "total", "changes")}


def render(report: dict, *, destinations: int = 3) -> str:
    lines = [
        f"path migration: {report['total']} file(s) in the migration inventory: "
        f"{report['ready']} ready, {report['pending']} waiting for the new layout, {report['blocked']} blocked"
    ]
    for change in report["changes"]:
        detail = f" ({change['reason']})" if change.get("reason") else ""
        lines.append(f"  [{change['status']}] {change['kind']} {change['path']} x{change['occurrences']}{detail}")
        pairs = [r for r in change["replacements"] if change["status"] != "ready" or r.get("exists")]
        for pair in pairs[:destinations]:
            lines.append(f"      {pair['old']} -> {pair['new']}{'' if pair.get('exists') else ' (missing)'}")
        if len(pairs) > destinations:
            lines.append(f"      ... {len(pairs) - destinations} more path(s); see --json")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home(), help="home directory to inspect (default: $HOME)")
    parser.add_argument("--root", type=Path, action="append", default=[], help="additional Orkest checkout root")
    parser.add_argument("--apply", action="store_true", help="back up, then rewrite ready paths (default: report only)")
    parser.add_argument("--restore", type=Path, help="undo an earlier --apply from its backup directory")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.restore:
            print(f"restored {restore(args.restore)} path(s)")
            return 0
        report = apply(args.home, roots=args.root) if args.apply else discover(args.home, roots=args.root)
    except (MigrationError, OSError, ValueError) as error:
        print(f"path migration: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2) if args.json else render(report))
    if args.apply and report["backup"]:
        print(f"backup: {report['backup']} (undo with --restore)", file=sys.stderr)
    return 1 if report.get("conflicts") else 0


if __name__ == "__main__":
    raise SystemExit(main())
