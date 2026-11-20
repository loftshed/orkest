#!/usr/bin/env python3
"""Opt-in, persistent approval of Orkest's own commands in each installed harness.

`install_mailbox.py --trust-orkest-commands` records the opt-in and writes scoped allow rules into the
user profile of every installed harness. Later setup runs (`ork update`, `ork setup`, doctor repair)
refresh those rules from the same state file, so the approval survives a moved checkout or a new
Python. `--untrust-orkest-commands` removes exactly the rules this module added.

The approved scope is an explicit list of `ork` subcommands and Orkest coordination scripts at their
absolute install paths (with read/accept scoping on `authority.py`, `handoff.py`, `ork policy show`,
and `ork setup --dry-run`). Generic `python3`, `node` or shell, other scripts, and the Orkest commands
that run an arbitrary program (`ork gate -- COMMAND`, `ork label -- HARNESS`, `gate.py`, the interactive
`ork codex|claude|agy|opencode` launchers) still ask. `run_agent.py` still enforces `credits.allow=false`
in `config.json` across all harnesses, while Claude Code and OpenCode also re-prompt on
`--allow-credits`, `--ignore-quota`, and `--trust-codex-hooks`; account selection, worker scopes,
repository policy and deletion confirmations are enforced inside the commands.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import sys
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

import mailbox_configuration as configuration

STATE_VERSION = 1
STATE_NAME = "command-approval.json"
CODEX_RULES_NAME = "orkest-commands.rules"
BACKUP_MARK = ".orkest-approval-bak."
JUSTIFICATION = "User-approved Orkest command (install_mailbox.py --trust-orkest-commands)"

# Every `ork` subcommand except those that hand an arbitrary program to the shell or open an
# interactive harness: `gate -- COMMAND`, `label -- HARNESS ...`, `codex|claude|agy|opencode`, and
# interactive `ork horde` (only non-launching/attached `ork horde` operations are approved).
ORK_SUBCOMMANDS: tuple[tuple[str, ...], ...] = (
    ("chief",),
    ("cleanup",),
    ("factory",),
    ("foundry",),
    ("hall",),
    ("herdr-status",),
    ("name",),
    ("next",),
    ("policy", "show"),
    ("progress",),
    ("quota",),
    ("radar",),
    ("rooms",),
    ("routes",),
    ("setup", "--dry-run"),
    ("side",),
    ("side-mission",),
    ("smelter",),
    ("swarm",),
    ("telemetry",),
    ("update",),
    ("gate", "status"),
    ("horde", "toggle"),
    ("horde", "open"),
    ("horde", "close"),
    ("horde", "spawn"),
    ("horde", "--attach-room"),
    ("horde", "--view"),
    ("horde", "--chief"),
    ("horde", "--print"),
    ("horde", "--json"),
    ("horde", "--fixture"),
)
# The coordination, dispatch, mailbox and progress entry points. gate.py is left out because
# `gate.py -- COMMAND` runs any command, and run_agent.py/authority.py/handoff.py stay subcommand-scoped.
SCRIPTS = (
    "run_agent.py",
    "coordinator.py",
    "agent_progress.py",
    "peer_mailbox.py",
    "context_handoff.py",
    "continuation_requests.py",
    "telemetry.py",
)
RUN_AGENT_ARGS: tuple[str, ...] = (
    "consult",
    "mailbox",
    "events",
    "steer",
    "models",
    "routes",
    "families",
    "quota",
    "doctor",
    "prune",
    "init",
    "--cwd",
    "--task-spec",
    "--brief",
    "--route",
    "--engine",
    "--host",
    "--transport",
    "--model",
    "--session",
    "--resume-result",
    "--dry-run",
    "--help",
    "-h",
)
SCRIPT_SUBCOMMANDS: dict[str, tuple[str, ...]] = {
    "run_agent.py": RUN_AGENT_ARGS,
    "authority.py": ("show", "accept", "offer", "--help", "-h"),
    "handoff.py": ("status", "show", "--help", "-h"),
}
CLAUDE_ASK_RULES = (
    "Bash(* --allow-credits*)",
    "Bash(* --ignore-quota*)",
    "Bash(* --trust-codex-hooks*)",
)
OPENCODE_ASK_RULES = (
    "* --allow-credits*",
    "* --ignore-quota*",
    "* --trust-codex-hooks*",
)

SCOPE_TEXT = """\
Approving Orkest commands for future agents in every installed harness:
  ork <subcommand>        {ork}
  ork horde / gate        horde toggle|open|close|spawn|--attach-room|--view|--chief|--print|--json|--fixture, gate status, policy show, setup --dry-run
  node <ork.mjs> ...      the same subcommands through this checkout's CLI
  python3 <script> ...    {scripts}, plus scoped authority.py (show|accept|offer) and handoff.py (status|show) at their absolute install paths (run_agent.py probe/horde/listen, mutating authority.py, and handoff.py enable|disable stay prompted)
Generic python3, node and shell commands, other scripts, ork gate --, ork label and launchers still ask.
run_agent.py still enforces credits.allow=false in config.json across all harnesses; Claude Code and OpenCode also re-prompt on --allow-credits, --ignore-quota and --trust-codex-hooks. Account selection, worker scopes and deletion confirmations still apply.
Undo with --untrust-orkest-commands."""

# Antigravity treats each token inside command(...) as an anchored regex `^(?:token)$`. We keep `.`
# unescaped to match Antigravity's own generated rules; quantifiers/wildcards remain disallowed.
AGY_SAFE = re.compile(r"[A-Za-z0-9_./@:=~-]+")
# OpenCode patterns treat * and ? as wildcards.
OPENCODE_UNSAFE = re.compile(r"[*?]")


@dataclass(frozen=True)
class Scope:
    """The concrete programs and paths that make up the approved command scope."""

    ork_programs: list[str]
    cli_paths: list[str]
    nodes: list[str]
    pythons: list[str]
    hub: Path
    source: Path

    def script_paths(self, skill_dirs: Iterable[Path] = (), *, scripts: Iterable[str] = SCRIPTS) -> list[str]:
        directories = [self.hub, *skill_dirs, self.source]
        return _variants(directory / name for name in scripts for directory in directories)

    def prefixes(self, skill_dirs: Iterable[Path] = ()) -> list[tuple[str, ...]]:
        """Each approved command prefix as concrete argv tokens."""
        found: list[tuple[str, ...]] = []
        for program in [*self.ork_programs, *self.cli_paths]:
            found.extend((program, *sub) for sub in ORK_SUBCOMMANDS)
        for node in self.nodes:
            for cli in self.cli_paths:
                found.extend((node, cli, *sub) for sub in ORK_SUBCOMMANDS)
        unscoped_scripts = [name for name in SCRIPTS if name not in SCRIPT_SUBCOMMANDS]
        other_paths = self.script_paths(skill_dirs, scripts=unscoped_scripts)
        scoped_paths = [
            (self.script_paths(skill_dirs, scripts=(name,)), subcommands)
            for name, subcommands in SCRIPT_SUBCOMMANDS.items()
        ]
        for python in self.pythons:
            for paths, subcommands in scoped_paths:
                for script in paths:
                    found.extend((python, script, arg) for arg in subcommands)
            found.extend((python, script) for script in other_paths)
        return list(dict.fromkeys(found))


@dataclass
class Target:
    """One harness file and the rules Orkest should own in it."""

    harness: str
    path: Path
    kind: str  # "codex", "claude", "agy" or "opencode"
    skill_dirs: list[Path] = field(default_factory=list)
    entries: list[str] = field(default_factory=list)
    ask_entries: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def _variants(paths: Iterable[Path]) -> list[str]:
    """Each path as given and fully resolved, since agents quote either (e.g. /home vs /var/home)."""
    found: list[str] = []
    for path in paths:
        for candidate in (path, path.resolve()):
            text = str(candidate)
            if text not in found:
                found.append(text)
    return found


def build_scope(
    home: Path,
    hub: Path,
    *,
    source: Path | None = None,
    which: Callable[[str], str | None] = shutil.which,
    executable: str | None = None,
    environ: dict[str, str] | None = None,
) -> Scope:
    environ = dict(os.environ) if environ is None else environ
    raw_source = Path(os.path.abspath(source)) if source is not None else Path(os.path.abspath(__file__)).parent
    resolved_source = raw_source.resolve()
    cli_candidates = [
        *([raw_source.parents[4] / "src/bin/ork.mjs"] if len(raw_source.parents) >= 5 else []),
        *([resolved_source.parents[4] / "src/bin/ork.mjs"] if len(resolved_source.parents) >= 5 else []),
    ]
    links = [Path(environ.get("ORKEST_BIN_DIR") or home / ".local/bin") / "ork", home / ".local/bin/ork"]
    found_ork = which("ork")
    if found_ork:
        links.append(Path(found_ork))
    if found_ork and Path(found_ork).resolve().name == "ork.mjs":
        cli_candidates.append(Path(found_ork).resolve())
    cli_paths = _variants(cli_candidates)
    expanded_links: list[Path] = []
    for link in links:
        expanded_links.append(link)
        if link.parent.exists():
            expanded_links.append(link.parent.resolve() / link.name)
    ork_programs = ["ork", *(str(link) for link in expanded_links if str(link) not in cli_paths)]
    pythons = ["python3", executable or sys.executable, which("python3") or ""]
    nodes = ["node", which("node") or ""]
    return Scope(
        ork_programs=list(dict.fromkeys(ork_programs)),
        cli_paths=cli_paths,
        nodes=list(dict.fromkeys(item for item in nodes if item)),
        pythons=list(dict.fromkeys(item for item in pythons if item)),
        hub=hub,
        source=raw_source,
    )


# ---------------------------------------------------------------------------- rule rendering


def claude_rules(prefixes: Iterable[tuple[str, ...]]) -> list[str]:
    """Claude Code `Bash(prefix:*)` rules: the literal prefix, alone or followed by arguments."""
    return [f"Bash({shlex.join(prefix)}:*)" for prefix in prefixes]


def agy_rules(prefixes: Iterable[tuple[str, ...]]) -> tuple[list[str], list[str]]:
    """Antigravity `command(prefix)` rules; prefixes it would read as a pattern are skipped."""
    rules, skipped = [], []
    for prefix in prefixes:
        if all(AGY_SAFE.fullmatch(token) for token in prefix):
            rules.append(f"command({' '.join(prefix)})")
        else:
            skipped.append(shlex.join(prefix))
    return rules, skipped


def opencode_rules(prefixes: Iterable[tuple[str, ...]]) -> tuple[list[str], list[str]]:
    """OpenCode shell patterns; a trailing ` *` also matches the bare prefix."""
    rules, skipped = [], []
    for prefix in prefixes:
        text = shlex.join(prefix)
        if OPENCODE_UNSAFE.search(text):
            skipped.append(text)
        else:
            rules.append(f"{text} *")
    return rules, skipped


CODEX_HEADER = """\
# Managed by Orkest's installer (--trust-orkest-commands) and rewritten on every setup refresh.
# Allows Orkest's own commands without a prompt: listed ork subcommands and Orkest scripts at their
# absolute install paths. Generic python3/node/shell, `ork gate -- COMMAND`, `ork label` and the
# interactive launchers still ask. Remove with --untrust-orkest-commands; put your own rules elsewhere.
"""


def codex_rules(scope: Scope, skill_dirs: Iterable[Path]) -> str:
    def rule(*tokens: str | list[str]) -> str:
        parts = ", ".join(json.dumps(part, ensure_ascii=False) for part in tokens)
        return f'prefix_rule(pattern=[{parts}], decision="allow", justification={json.dumps(JUSTIFICATION)})'

    single = [sub[0] for sub in ORK_SUBCOMMANDS if len(sub) == 1]
    longer = [list(sub) for sub in ORK_SUBCOMMANDS if len(sub) > 1]
    programs = [*scope.ork_programs, *scope.cli_paths]
    lines = [CODEX_HEADER, rule(programs, single)]
    lines.extend(rule(programs, *sub) for sub in longer)
    lines.append(rule(scope.nodes, scope.cli_paths, single))
    lines.extend(rule(scope.nodes, scope.cli_paths, *sub) for sub in longer)
    other_scripts = scope.script_paths(skill_dirs, scripts=[name for name in SCRIPTS if name not in SCRIPT_SUBCOMMANDS])
    lines.append(rule(scope.pythons, other_scripts))
    for name, subcommands in SCRIPT_SUBCOMMANDS.items():
        scoped_scripts = scope.script_paths(skill_dirs, scripts=(name,))
        lines.append(rule(scope.pythons, scoped_scripts, list(subcommands)))
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------- file editing


def _real(path: Path) -> Path:
    """Edit through a symlink so the link itself (often a dotfiles checkout) is preserved."""
    return path.resolve() if path.is_symlink() else path


def _backup(path: Path) -> Path | None:
    """A copy next to the edited file; never rotated, so earlier backups stay."""
    if not path.is_file():
        return None
    target = path.with_name(f"{path.name}{BACKUP_MARK}{time.time_ns()}")
    shutil.copy2(path, target)
    target.chmod(0o600)
    return target


def _strip_jsonc(text: str) -> str:
    text = re.sub(
        r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/', lambda match: match[0] if match[0].startswith('"') else " ", text
    )
    return re.sub(r'"(?:\\.|[^"\\])*"|,\s*(?=[}\]])', lambda match: match[0] if match[0].startswith('"') else "", text)


def _parse(text: str) -> dict:
    value = json.loads(_strip_jsonc(text).strip() or "{}")
    if not isinstance(value, dict):
        raise ValueError("configuration must be a JSON object")
    return value


def _comments_in(text: str, keys: list[str]) -> str:
    """Comments inside the value about to be replaced, so a JSONC edit does not drop them."""
    try:
        start = configuration.skip(text, 0)
        for key in keys:
            entries, _, _ = configuration.members(text, start)
            if key not in entries:
                return ""
            start, end = entries[key]
    except (ValueError, IndexError):
        return ""
    comments = [
        match[0]
        for match in re.finditer(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/', text[start:end])
        if not match[0].startswith('"')
    ]
    return "\n".join(comments) + "\n" if comments else ""


def _render_updates(text: str, data: dict, updates: list[tuple[list[str], object]]) -> str:
    """Plain JSON is rewritten whole; JSONC keeps its comments and only the edited values change."""
    if not _strip_jsonc(text).strip():
        prefix = text.rstrip()
        rendered = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        updated = (prefix + "\n" + rendered) if prefix else rendered
        _parse(updated)
        return updated
    try:
        json.loads((text or "").strip() or "{}")
    except ValueError:
        updated = text
        for keys, value in updates:
            updated = configuration.set_json_path(updated, keys, value, preserved_comments=_comments_in(updated, keys))
    else:
        updated = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    _parse(updated)
    return updated


def _render(text: str, data: dict, keys: list[str], value: object) -> str:
    return _render_updates(text, data, [(keys, value)])


def _write(path: Path, before: str | None, after: str) -> None:
    real = _real(path)
    _backup(real)
    configuration.write_private(real, after, expected=before)


def _edit_rule_lists(
    target: Target,
    sections: list[tuple[list[str], list[str], list[str]]],
    *,
    dry_run: bool,
    label: str,
) -> tuple[list[list[str]], int, int]:
    """Add wanted rules to each JSON list and drop stale rules Orkest added earlier."""
    real = _real(target.path)
    before = real.read_text() if real.exists() else None
    data = _parse(before or "{}")
    owned_lists: list[list[str]] = []
    changed_sections: list[tuple[list[str], object]] = []
    total_wanted = 0
    total_added = 0
    total_removed = 0
    for keys, wanted, previous in sections:
        parent = data
        for key in keys[:-1]:
            child = parent.setdefault(key, {})
            if not isinstance(child, dict):
                raise ValueError(f"{'.'.join(keys[:-1])} is not an object")
            parent = child
        current = parent.get(keys[-1], [])
        if not isinstance(current, list):
            raise ValueError(f"{'.'.join(keys)} is not a list")
        stale = {entry for entry in previous if entry not in wanted}
        added = [entry for entry in wanted if entry not in current]
        removed = [entry for entry in current if entry in stale]
        owned = [entry for entry in previous if entry in wanted and entry in current] + added
        owned_lists.append(owned)
        total_wanted += len(wanted)
        total_added += len(added)
        total_removed += len(removed)
        if added or removed:
            updated_list = [entry for entry in current if entry not in stale] + added
            parent[keys[-1]] = updated_list
            changed_sections.append((keys, updated_list))
    if not changed_sections:
        print(f"• {label}: Orkest commands already approved ({total_wanted} rules): {target.path}")
        return owned_lists, 0, 0
    if dry_run:
        print(f"would approve Orkest commands in {label}: +{total_added} -{total_removed} rules: {target.path}")
        return owned_lists, total_added, total_removed
    _write(target.path, before, _render_updates(before or "{}", data, changed_sections))
    print(f"✓ {label}: approved Orkest commands (+{total_added} -{total_removed} rules): {target.path}")
    return owned_lists, total_added, total_removed


def _edit_opencode(
    target: Target, previous_allow: list[str], previous_ask: list[str], *, dry_run: bool
) -> tuple[list[str], list[str], int, int]:
    """OpenCode reads `permission.bash` (or `shell`) patterns and lets the last match win."""
    real = _real(target.path)
    before = real.read_text() if real.exists() else None
    data = _parse(before or "{}")
    permission = data.get("permission")
    if permission is not None and not isinstance(permission, (dict, str)):
        raise ValueError("permission is neither an object nor a string")
    section = "bash"
    if isinstance(permission, dict):
        present = [key for key in permission if key in ("bash", "shell")]
        section = present[-1] if present else "bash"
    rules = permission.get(section) if isinstance(permission, dict) else None
    if rules is not None and not isinstance(rules, (dict, str)):
        raise ValueError(f"permission.{section} is neither an object nor a string")
    current = dict(rules) if isinstance(rules, dict) else ({"*": rules} if isinstance(rules, str) else {})
    wanted_allow = target.entries
    wanted_ask = target.ask_entries
    ask_set = set(wanted_ask)
    stale_allow = {
        entry
        for entry in previous_allow
        if entry not in wanted_allow and entry not in ask_set and current.get(entry) == "allow"
    }
    stale_ask = {entry for entry in previous_ask if entry not in ask_set and current.get(entry) == "ask"}
    stale = stale_allow | stale_ask
    kept_by_user = [entry for entry in wanted_allow if entry in current and current[entry] != "allow"]
    added_allow = [entry for entry in wanted_allow if entry not in current and entry not in ask_set]
    owned_allow = [
        entry
        for entry in previous_allow
        if entry in wanted_allow and entry not in ask_set and current.get(entry) == "allow"
    ] + added_allow

    owned_ask: list[str] = []
    added_ask_count = 0
    for entry in wanted_ask:
        existing = current.get(entry)
        if existing == "deny":
            continue
        if existing == "ask":
            if entry in previous_ask:
                owned_ask.append(entry)
            continue
        owned_ask.append(entry)
        added_ask_count += 1

    updated_rules = {key: value for key, value in current.items() if key not in stale and key not in ask_set}
    for entry in added_allow:
        updated_rules[entry] = "allow"
    for entry in wanted_ask:
        updated_rules[entry] = "deny" if current.get(entry) == "deny" else "ask"

    if kept_by_user:
        print(f"• OpenCode: kept {len(kept_by_user)} of your own non-allow rules for Orkest commands")
    total_added = len(added_allow) + added_ask_count
    total_removed = len(stale)
    if list(updated_rules.items()) == list(current.items()):
        print(f"• OpenCode: Orkest commands already approved ({len(wanted_allow)} rules): {target.path}")
        return owned_allow, owned_ask, 0, 0
    if dry_run:
        print(f"would approve Orkest commands in OpenCode: +{total_added} -{total_removed} rules: {target.path}")
        return owned_allow, owned_ask, total_added, total_removed
    if isinstance(permission, dict):
        permission[section] = updated_rules
        keys, value = ["permission", section], updated_rules
    else:
        base = {"*": permission} if isinstance(permission, str) else {}
        data["permission"] = {**base, section: updated_rules}
        keys, value = ["permission"], data["permission"]
    _write(target.path, before, _render(before or "{}", data, keys, value))
    print(f"✓ OpenCode: approved Orkest commands (+{total_added} -{total_removed} rules): {target.path}")
    return owned_allow, owned_ask, total_added, total_removed


def _remove_opencode(path: Path, owned_allow: list[str], owned_ask: list[str], *, dry_run: bool) -> int:
    real = _real(path)
    if not real.exists():
        return 0
    before = real.read_text()
    data = _parse(before)
    permission = data.get("permission")
    if not isinstance(permission, dict):
        return 0
    count = 0
    allow_set = set(owned_allow)
    ask_set = set(owned_ask)
    for section in ("bash", "shell"):
        rules = permission.get(section)
        if not isinstance(rules, dict):
            continue
        remaining = {
            key: value
            for key, value in rules.items()
            if not ((key in allow_set and value == "allow") or (key in ask_set and value == "ask"))
        }
        count += len(rules) - len(remaining)
        permission[section] = remaining
    if count and not dry_run:
        _write(path, before, _render(before, data, ["permission"], permission))
    return count


def _remove_rule_lists(path: Path, sections: list[tuple[list[str], list[str]]], *, dry_run: bool) -> int:
    real = _real(path)
    if not real.exists():
        return 0
    before = real.read_text()
    data = _parse(before)
    changed_sections: list[tuple[list[str], object]] = []
    removed_count = 0
    for keys, owned in sections:
        if not owned:
            continue
        parent = data
        for key in keys[:-1]:
            parent = parent.get(key)
            if not isinstance(parent, dict):
                parent = None
                break
        if parent is None:
            continue
        current = parent.get(keys[-1])
        if not isinstance(current, list):
            continue
        owned_set = set(owned)
        remaining = [entry for entry in current if entry not in owned_set]
        if remaining != current:
            parent[keys[-1]] = remaining
            changed_sections.append((keys, remaining))
            removed_count += len(current) - len(remaining)
    if removed_count and not dry_run:
        _write(path, before, _render_updates(before, data, changed_sections))
    return removed_count


def _install_codex(target: Target, content: str, *, dry_run: bool) -> bool:
    real = _real(target.path)
    if real.is_file() and real.read_text() == content:
        print(f"• Codex: Orkest commands already approved: {target.path}")
        return False
    if dry_run:
        print(f"would approve Orkest commands in Codex: {target.path}")
        return True
    _backup(real)
    configuration.write_private(real, content)
    print(f"✓ Codex: approved Orkest commands: {target.path}")
    return True


def _retire_codex(path: Path, *, dry_run: bool) -> bool:
    """Move the managed rules file aside instead of deleting it; Codex loads only *.rules."""
    real = _real(path)
    if not real.is_file() or not real.read_text().startswith(CODEX_HEADER.splitlines()[0]):
        return False
    if not dry_run:
        real.rename(real.with_name(f"{real.name}{BACKUP_MARK}{time.time_ns()}"))
    return True


# ---------------------------------------------------------------------------- state


def load_state(path: Path) -> dict:
    try:
        state = json.loads(path.read_text())
    except (OSError, ValueError):
        return {"version": STATE_VERSION, "enabled": False, "files": {}}
    if not isinstance(state, dict) or not isinstance(state.get("files"), dict):
        return {"version": STATE_VERSION, "enabled": False, "files": {}}
    return state


def save_state(path: Path, state: dict) -> None:
    configuration.write_private(path, json.dumps(state, indent=2, sort_keys=True) + "\n")


def enabled(state_path: Path) -> bool:
    return bool(load_state(state_path).get("enabled"))


# ---------------------------------------------------------------------------- targets


def targets(
    scope: Scope,
    *,
    harnesses: set[str],
    claude_profiles: Iterable[Path] = (),
    codex_home: Path | None = None,
    agy_settings: Path | None = None,
    opencode_config: Path | None = None,
    home: Path,
) -> list[Target]:
    skills = "skills/orchestrate/scripts"
    found: list[Target] = []
    if "codex" in harnesses and codex_home is not None:
        found.append(Target("Codex", codex_home / "rules" / CODEX_RULES_NAME, "codex", [codex_home / skills]))
    if "claude" in harnesses:
        for profile in claude_profiles:
            target = Target(f"Claude ({profile.name})", profile / "settings.json", "claude", [profile / skills])
            target.entries = claude_rules(scope.prefixes(target.skill_dirs))
            target.ask_entries = list(CLAUDE_ASK_RULES)
            found.append(target)
    if "agy" in harnesses and agy_settings is not None:
        dirs = [home / ".gemini/config" / skills, home / ".gemini/antigravity" / skills]
        target = Target("Antigravity", agy_settings, "agy", dirs)
        target.entries, target.skipped = agy_rules(scope.prefixes(dirs))
        found.append(target)
    if "opencode" in harnesses and opencode_config is not None:
        target = Target("OpenCode", opencode_config, "opencode", [opencode_config.parent / skills])
        target.entries, target.skipped = opencode_rules(scope.prefixes(target.skill_dirs))
        target.ask_entries = list(OPENCODE_ASK_RULES)
        found.append(target)
    return found


def apply(
    scope: Scope,
    found: list[Target],
    *,
    state_path: Path,
    opt_in: bool = False,
    revoke: bool = False,
    dry_run: bool = False,
) -> bool:
    """Approve, refresh or revoke; returns whether approval is on afterwards."""
    state = load_state(state_path)
    files: dict = state["files"]
    if revoke:
        return _revoke(state, state_path, dry_run=dry_run)
    if not (opt_in or state.get("enabled")):
        print(
            "• Full Orkest command approval is off (only Codex bookkeeping rules are installed); "
            "rerun setup with --trust-orkest-commands to approve them"
        )
        return False
    if opt_in and not state.get("enabled"):
        print(
            SCOPE_TEXT.format(
                ork=" ".join(" ".join(sub) for sub in ORK_SUBCOMMANDS if len(sub) == 1),
                scripts=", ".join(SCRIPTS),
            )
        )
    for target in found:
        key = str(target.path)
        record = files.get(key, {})
        previous = record.get("entries", []) if isinstance(record, dict) else []
        previous_ask = record.get("ask_entries", []) if isinstance(record, dict) else []
        owned_ask: list[str] = []
        try:
            if target.kind == "codex":
                _install_codex(target, codex_rules(scope, target.skill_dirs), dry_run=dry_run)
                owned: list[str] = []
            elif target.kind == "claude":
                owned_lists, _, _ = _edit_rule_lists(
                    target,
                    [
                        (["permissions", "allow"], target.entries, previous),
                        (["permissions", "ask"], target.ask_entries, previous_ask),
                    ],
                    dry_run=dry_run,
                    label=target.harness,
                )
                owned, owned_ask = owned_lists
            elif target.kind == "agy":
                owned_lists, _, _ = _edit_rule_lists(
                    target,
                    [(["permissions", "allow"], target.entries, previous)],
                    dry_run=dry_run,
                    label=target.harness,
                )
                (owned,) = owned_lists
            else:
                owned, owned_ask, _, _ = _edit_opencode(target, previous, previous_ask, dry_run=dry_run)
        except (OSError, ValueError) as error:
            print(f"! {target.harness}: left unchanged ({error}): {target.path}")
            continue
        if target.skipped:
            print(f"• {target.harness}: {len(target.skipped)} paths with pattern characters stay prompted")
        entry_record: dict[str, object] = {"kind": target.kind, "entries": owned}
        if target.kind in ("claude", "opencode"):
            entry_record["ask_entries"] = owned_ask
        files[key] = entry_record
    if not dry_run:
        state.update(version=STATE_VERSION, enabled=True, files=files)
        save_state(state_path, state)
    return True


def _revoke(state: dict, state_path: Path, *, dry_run: bool) -> bool:
    files: dict = state.get("files", {})
    for key, record in list(files.items()):
        path = Path(key)
        kind = record.get("kind") if isinstance(record, dict) else None
        owned = record.get("entries", []) if isinstance(record, dict) else []
        owned_ask = record.get("ask_entries", []) if isinstance(record, dict) else []
        try:
            if kind == "codex":
                count = int(_retire_codex(path, dry_run=dry_run))
            elif kind == "claude":
                sections = [(["permissions", "allow"], owned)]
                if owned_ask:
                    sections.append((["permissions", "ask"], owned_ask))
                count = _remove_rule_lists(path, sections, dry_run=dry_run)
            elif kind == "agy":
                count = _remove_rule_lists(path, [(["permissions", "allow"], owned)], dry_run=dry_run)
            elif kind == "opencode":
                count = _remove_opencode(path, owned, owned_ask, dry_run=dry_run)
            else:
                count = 0
        except (OSError, ValueError) as error:
            print(f"! left unchanged ({error}): {path}")
            continue
        verb = "would remove" if dry_run else "removed"
        print(f"{'•' if not count else '✓'} {verb} {count} Orkest approval rules: {path}")
        if not dry_run:
            files.pop(key, None)
    if not dry_run:
        state.update(version=STATE_VERSION, enabled=False, files=files)
        save_state(state_path, state)
    return False
