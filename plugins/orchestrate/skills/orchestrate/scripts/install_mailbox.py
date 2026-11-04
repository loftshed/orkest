#!/usr/bin/env python3
"""Register the peer mailbox and turn hooks for installed local harnesses."""

from __future__ import annotations

import argparse
import copy
import json
import os
import plistlib
import re
import shlex
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path

import mailbox_configuration as configuration
import mailbox_daemon
import mailbox_mcp
import peer_mailbox as mailbox
import runtime_paths
from check_mailbox import RpcClient, check, initialize_codex

EVENTS = ("SessionStart", "UserPromptSubmit", "Stop", "SessionEnd")
CLAUDE_EVENTS = (*EVENTS, "SubagentStart", "SubagentStop")
AGY_EVENTS = ("SessionStart", "PreInvocation", "Stop")
TOOLS = tuple(sorted(mailbox_mcp.TOOL_NAMES))
DEFAULT_KEEP_BACKUPS = 1
DAEMON_RUNTIME_GRACE_SECONDS = 15 * 60
MANAGED_ZSHRC_START = "# >>> orkest (managed) >>>"
MANAGED_ZSHRC_END = "# <<< orkest (managed) <<<"
MANAGED_ZSHRC_BLOCK = (
    f"{MANAGED_ZSHRC_START}\n"
    'if [ -f "$HOME/.config/orchestrate/orkest.sh" ]; then\n'
    '  . "$HOME/.config/orchestrate/orkest.sh"\n'
    'elif [ -f "$HOME/.config/agent-executor/orkest.sh" ]; then\n'
    '  . "$HOME/.config/agent-executor/orkest.sh"\n'
    "fi\n"
    f"{MANAGED_ZSHRC_END}\n"
)

SWARM_COMMAND_TEXT = (
    "---\n"
    "description: Toggle (open or close) the live Orkest Swarm View split pane in this terminal\n"
    'argument-hint: "[toggle|open|close]"\n'
    "---\n\n"
    "[orkest-swarm-command: $ARGUMENTS]\n"
    "If the `/swarm` turn hook already opened or closed the Orkest Swarm View pane, confirm the result in one "
    "short line and do not call any tools. Otherwise run `ork swarm $ARGUMENTS` and report the result in one "
    "short line.\n"
)

SWARM_SKILL_TEXT = (
    "---\n"
    "name: swarm\n"
    "description: Toggle (open or close) the live Orkest Swarm View split pane in the current terminal when the user types /swarm.\n"
    "metadata:\n"
    "  version: 0.50.0\n"
    "---\n\n"
    "[orkest-swarm-command]\n"
    "If the `/swarm` turn hook already opened or closed the Orkest Swarm View pane, confirm the result in one "
    "short line and do not call any tools. Otherwise run `ork swarm` (`ork swarm open` or `ork swarm close`) "
    "and report the result in one short line.\n"
)

CLEANUP_COMMAND_TEXT = (
    "---\n"
    "description: Audit, prune, and migrate legacy Orkest / agent-executor state, worktrees, and backups\n"
    'argument-hint: "[status|run] [--dry-run] [--migrate-legacy]"\n'
    "---\n\n"
    "[orkest-cleanup-command: $ARGUMENTS]\n"
    "Run `ork cleanup $ARGUMENTS` (use `ork cleanup status --json` first if you want to preview before mutating, "
    "or `ork cleanup run --migrate-legacy` when the user asks to clean up and migrate legacy paths) and report "
    "the reclaimed artifacts, worktrees, backups, and legacy path migration status concisely.\n"
)

CLEANUP_SKILL_TEXT = (
    "---\n"
    "name: cleanup\n"
    "description: Audit, prune, and migrate legacy Orkest and agent-executor caches, disposable worktrees, staged daemon runtimes, and configuration backups when the user types /cleanup or asks to clean up old Orkest versions.\n"
    "metadata:\n"
    "  version: 0.50.0\n"
    "---\n\n"
    "[orkest-cleanup-command]\n"
    "Run `ork cleanup status --json` to inspect reclaimable Orkest state, or `ork cleanup run [--migrate-legacy] --json` "
    "to prune stale runs, disposable worktrees, staged daemon runtimes, and backups (and optionally migrate legacy "
    "`~/.cache/agent-executor` and `~/.config/agent-executor` paths).\n"
)

SIDE_SKILL_TEXT = (
    "---\n"
    "name: side\n"
    'description: Dispatch or park a side mission from the current tab without derailing the active task or cluttering the main conversation context. Triggers on "/side", "ork side", "side:", or "!side".\n'
    "metadata:\n"
    "  version: 0.50.0\n"
    "---\n\n"
    "[orkest-side-command]\n"
    "When the `/side` turn hook has already dispatched or parked this side mission, confirm the result in one short line "
    "and do not call any tools. Otherwise run `ork side <idea>` (`--execute`, `--investigate`, `--later`, or `--issue`) "
    "and report the result in one short line.\n"
)

UPDATE_SKILL_TEXT = (
    "---\n"
    "name: update\n"
    "description: Check for and apply fast-forward Orkest repository updates, re-run mailbox installation, and migrate legacy agent-executor state when the user runs /update or ork update.\n"
    "metadata:\n"
    "  version: 0.50.0\n"
    "---\n\n"
    "[orkest-update-command]\n"
    "Run `ork update` (`ork update check`, `ork update status`, `ork update enable`, or `ork update disable`) "
    "and report the update status concisely.\n"
)


def resolve_config_home(home: Path) -> Path:
    if home.resolve() == Path.home().resolve():
        return runtime_paths.config_home()
    saved: dict[str, str | None] = {}
    for key in (
        "XDG_CONFIG_HOME",
        "ORCHESTRATE_CONFIG_HOME",
        "AGENT_EXECUTOR_CONFIG_HOME",
        "ORCHESTRATE_CONFIG",
        "AGENT_EXECUTOR_CONFIG",
    ):
        saved[key] = os.environ.pop(key, None)
    os.environ["XDG_CONFIG_HOME"] = str(home / ".config")
    try:
        return runtime_paths.config_home()
    finally:
        for key, val in saved.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val


def _backup_sort_key(path: Path) -> tuple[int, int, str]:
    suffix = path.name.rsplit(".mailbox-bak.", 1)[-1]
    stamp = int(suffix) if suffix.isdigit() else 0
    try:
        mtime_ns = path.lstat().st_mtime_ns
    except OSError:
        mtime_ns = 0
    return (stamp, mtime_ns, path.name)


def rotate_backups(target: Path, *, keep_backups: int = DEFAULT_KEEP_BACKUPS, dry_run: bool = False) -> list[Path]:
    """Retain only the newest `keep_backups` `.mailbox-bak.*` siblings for `target`."""
    keep = max(0, int(keep_backups))
    parent = target.parent
    if not parent.is_dir():
        return []
    prefix = f"{target.name}.mailbox-bak."
    candidates = [entry for entry in parent.iterdir() if entry.name.startswith(prefix)]
    candidates.sort(key=_backup_sort_key, reverse=True)
    stale = candidates[keep:]
    removed: list[Path] = []
    for item in stale:
        removed.append(item)
        if not dry_run:
            if item.is_dir() and not item.is_symlink():
                shutil.rmtree(item, ignore_errors=True)
            else:
                item.unlink(missing_ok=True)
    return removed


def prune_daemon_runtimes(
    base: Path | None = None,
    *,
    grace_seconds: float = DAEMON_RUNTIME_GRACE_SECONDS,
    dry_run: bool = False,
) -> list[Path]:
    """Prune inactive staged daemon runtime directories in mailbox-daemon-v1/runtimes/*,
    keeping state.json['runtimeRevision'] plus any runtime modified within the grace window."""
    base = base or mailbox.root()
    daemon_dirs: list[Path] = []
    for candidate in (base.parent / "mailbox-daemon-v1", base / "mailbox-daemon-v1", base):
        if (candidate / "runtimes").is_dir() and candidate not in daemon_dirs:
            daemon_dirs.append(candidate)
    now = time.time()
    current_rev = ""
    try:
        current_rev = str(mailbox_daemon.runtime_revision() or "")
    except Exception:
        current_rev = ""
    pruned: list[Path] = []
    for daemon_dir in daemon_dirs:
        active_rev = ""
        state_path = daemon_dir / "state.json"
        if state_path.is_file():
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
                if isinstance(state, dict):
                    active_rev = str(state.get("runtimeRevision") or "")
            except (OSError, ValueError):
                active_rev = ""
        runtimes_dir = daemon_dir / "runtimes"
        if not runtimes_dir.is_dir():
            continue
        for entry in sorted(runtimes_dir.iterdir()):
            if not entry.is_dir() and not entry.is_symlink():
                continue
            if entry.name and entry.name in {active_rev, current_rev}:
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if (now - mtime) < grace_seconds:
                continue
            pruned.append(entry)
            if not dry_run:
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry, ignore_errors=True)
                else:
                    entry.unlink(missing_ok=True)
    return pruned


def remove_legacy_skill_links(home: Path, *, dry_run: bool = False) -> list[Path]:
    """Remove legacy `agent-executor` skill links across harnesses when refreshing."""
    removed: list[Path] = []
    skill_parents = [
        home / ".agents/skills",
        home / ".codex/skills",
        home / ".gemini/config/skills",
        home / ".gemini/antigravity/skills",
        home / ".config/opencode/skills",
        home / ".claude/skills",
        *(p / "skills" for p in sorted(home.glob(".claude-*")) if p.is_dir()),
    ]
    for parent in skill_parents:
        legacy_link = parent / "agent-executor"
        if not (legacy_link.is_symlink() or legacy_link.exists()):
            continue
        removed.append(legacy_link)
        if dry_run:
            print(f"would remove legacy agent-executor skill link: {legacy_link}")
        else:
            if legacy_link.is_dir() and not legacy_link.is_symlink():
                shutil.rmtree(legacy_link, ignore_errors=True)
            else:
                legacy_link.unlink(missing_ok=True)
            print(f"✓ removed legacy skill link: {legacy_link}")
    return removed


def _install_claude_command(home: Path, name: str, content: str, *, dry_run: bool = False) -> bool:
    changed = False
    for claude_dir in [home / ".claude", *sorted(home.glob(".claude-*"))]:
        if not claude_dir.is_dir():
            continue
        cmd_file = claude_dir / f"commands/{name}.md"
        if not cmd_file.is_file() or cmd_file.read_text(encoding="utf-8") != content:
            if dry_run:
                print(f"would install /{name} command: {cmd_file}")
            else:
                cmd_file.parent.mkdir(parents=True, exist_ok=True)
                configuration.write_private(cmd_file, content)
                print(f"✓ /{name} command: {cmd_file}")
            changed = True
    return changed


def _install_cross_harness_skill(home: Path, name: str, content: str, *, dry_run: bool = False) -> bool:
    changed = False
    skill_hub = home / f".agents/skills/{name}"
    skill_file = skill_hub / "SKILL.md"
    if not skill_file.is_file() or skill_file.read_text(encoding="utf-8") != content:
        if dry_run:
            print(f"would install /{name} skill: {skill_file}")
        else:
            skill_hub.mkdir(parents=True, exist_ok=True)
            configuration.write_private(skill_file, content)
            print(f"✓ /{name} skill: {skill_file}")
        changed = True
    duplicate_parents = (
        home / ".claude/skills",
        *(p / "skills" for p in sorted(home.glob(".claude-*")) if p.is_dir()),
        home / ".gemini/antigravity/skills",
    )
    for dup_parent in duplicate_parents:
        dup_link = dup_parent / name
        if dup_link.is_symlink() or dup_link.exists():
            if dry_run:
                print(f"would remove duplicate /{name} skill link: {dup_link}")
            else:
                if dup_link.is_dir() and not dup_link.is_symlink():
                    shutil.rmtree(dup_link, ignore_errors=True)
                else:
                    dup_link.unlink(missing_ok=True)
                print(f"✓ removed duplicate /{name} skill link: {dup_link}")
            changed = True
    skill_parents = (
        home / ".codex/skills",
        home / ".gemini/config/skills",
        home / ".config/opencode/skills",
    )
    for skill_parent in skill_parents:
        if not skill_parent.parent.is_dir():
            continue
        skill_link = skill_parent / name
        if not (skill_link.is_symlink() and skill_link.resolve() == skill_hub.resolve()):
            if dry_run:
                print(f"would link /{name} skill: {skill_link} -> {skill_hub}")
            else:
                skill_parent.mkdir(parents=True, exist_ok=True)
                if skill_link.exists() or skill_link.is_symlink():
                    skill_link.rename(skill_link.with_name(f"{skill_link.name}.mailbox-bak.{time.time_ns()}"))
                    rotate_backups(skill_link)
                skill_link.symlink_to(skill_hub)
                print(f"✓ /{name} skill linked: {skill_link} -> {skill_hub}")
            changed = True
    return changed


def _candidate_plugin_roots(plugin_root: Path | None = None, ork_cli: Path | None = None) -> list[Path]:
    roots: list[Path] = []
    if plugin_root is not None:
        roots.append(plugin_root)
    if ork_cli is not None:
        roots.append(ork_cli.parent.parent)
    roots.append(Path(__file__).resolve().parents[3])
    unique: list[Path] = []
    for root in roots:
        if root not in unique:
            unique.append(root)
    return unique


def install_swarm_command(home: Path, *, dry_run: bool = False) -> bool:
    return _install_claude_command(home, "swarm", SWARM_COMMAND_TEXT, dry_run=dry_run)


def install_swarm_skill(home: Path, *, dry_run: bool = False) -> bool:
    return _install_cross_harness_skill(home, "swarm", SWARM_SKILL_TEXT, dry_run=dry_run)


def install_cleanup_command(home: Path, *, dry_run: bool = False) -> bool:
    return _install_claude_command(home, "cleanup", CLEANUP_COMMAND_TEXT, dry_run=dry_run)


def install_cleanup_skill(home: Path, *, dry_run: bool = False) -> bool:
    return _install_cross_harness_skill(home, "cleanup", CLEANUP_SKILL_TEXT, dry_run=dry_run)


def install_side_command(
    home: Path, *, plugin_root: Path | None = None, ork_cli: Path | None = None, dry_run: bool = False
) -> bool:
    for root in _candidate_plugin_roots(plugin_root, ork_cli):
        side_cmd = root / "commands/side.md"
        if side_cmd.is_file():
            return _install_claude_command(home, "side", side_cmd.read_text(encoding="utf-8"), dry_run=dry_run)
    return False


def install_side_skill(
    home: Path, *, plugin_root: Path | None = None, ork_cli: Path | None = None, dry_run: bool = False
) -> bool:
    for root in _candidate_plugin_roots(plugin_root, ork_cli):
        side_skill = root / "skills/side/SKILL.md"
        if side_skill.is_file():
            return _install_cross_harness_skill(home, "side", side_skill.read_text(encoding="utf-8"), dry_run=dry_run)
        if (root / "commands/side.md").is_file():
            return _install_cross_harness_skill(home, "side", SIDE_SKILL_TEXT, dry_run=dry_run)
    return False


def install_update_command(
    home: Path, *, plugin_root: Path | None = None, ork_cli: Path | None = None, dry_run: bool = False
) -> bool:
    for root in _candidate_plugin_roots(plugin_root, ork_cli):
        update_cmd = root / "commands/update.md"
        if update_cmd.is_file():
            return _install_claude_command(home, "update", update_cmd.read_text(encoding="utf-8"), dry_run=dry_run)
    return False


def install_update_skill(
    home: Path, *, plugin_root: Path | None = None, ork_cli: Path | None = None, dry_run: bool = False
) -> bool:
    for root in _candidate_plugin_roots(plugin_root, ork_cli):
        update_skill = root / "skills/update/SKILL.md"
        if update_skill.is_file():
            return _install_cross_harness_skill(
                home, "update", update_skill.read_text(encoding="utf-8"), dry_run=dry_run
            )
        if (root / "commands/update.md").is_file():
            return _install_cross_harness_skill(home, "update", UPDATE_SKILL_TEXT, dry_run=dry_run)
    return False


def shell_wrapper_script() -> str:
    return """# Generated by Orkest setup. Sourced from ~/.zshrc.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

# Interactive harnesses get an Orkest footer; automation and management commands stay direct.
unalias codex claude agy plaude 2>/dev/null
_orkest_interactive() {
  [[ -t 0 && -t 1 && -z ${ORKEST_TERMINAL_SERVER:-} ]] || return 1
  command -v ork >/dev/null 2>&1 || return 1
  local harness="${1:-}"
  shift 2>/dev/null || true
  local arg
  for arg in "$@"; do
    case "$arg" in
      --print|--print=*|--help|-h|--version|-v) return 1 ;;
      -p) [[ $harness == codex ]] || return 1 ;;
    esac
  done
  return 0
}
codex() {
  case "${1:-}" in
    exec|e|review|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|queue|archive|delete|migrate-rollouts|migrate-nfs-db|unarchive|cloud|exec-server|features|help) command codex "$@"; return ;;
  esac
  if _orkest_interactive codex "$@"; then command ork label -- codex "$@"; else command codex "$@"; fi
}
# Interactive Claude sessions start in auto mode unless the caller already chose a mode.
_claude_mode_flag() {
  reply=(--permission-mode auto)
  local arg
  for arg in "$@"; do
    case "$arg" in
      --permission-mode|--permission-mode=*|--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--harness-arg=--permission-mode*|--harness-arg=--dangerously-skip-permissions|--harness-arg=--allow-dangerously-skip-permissions) reply=(); return ;;
    esac
  done
}
claude() {
  case "${1:-}" in
    agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|purge|remote-control|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade|-h|--help|-v|--version) command claude "$@"; return ;;
  esac
  if _orkest_interactive claude "$@"; then
    local -a reply; _claude_mode_flag "$@"
    command ork label -- claude "${reply[@]}" "$@"
  else
    command claude "$@"
  fi
}
plaude() {
  case "${1:-}" in
    agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|purge|remote-control|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade|-h|--help|-v|--version) command plaude "$@"; return ;;
  esac
  if _orkest_interactive plaude "$@"; then
    local -a reply; _claude_mode_flag "$@"
    command ork label -- plaude "${reply[@]}" "$@"
  else
    command plaude "$@"
  fi
}
agy() {
  case "${1:-}" in
    agent|agents|changelog|help|install|mcp|mic-serve|models|plugin|plugins|remote-control|update|-h|--help|-v|--version) command agy "$@"; return ;;
  esac
  if _orkest_interactive agy "$@"; then
    command ork label -- agy --dangerously-skip-permissions "$@"
  else
    command agy --dangerously-skip-permissions "$@"
  fi
}
ork() {
  case "${1:-}" in
    agy)
      shift
      command ork agy --dangerously-skip-permissions "$@"
      ;;
    claude)
      shift
      local -a reply; _claude_mode_flag "$@"
      local -a harness_args=()
      local flag
      for flag in "${reply[@]}"; do harness_args+=("--harness-arg=$flag"); done
      command ork claude "${harness_args[@]}" "$@"
      ;;
    *)
      command ork "$@"
      ;;
  esac
}

# Launch each harness with the same outer Orkest footer.
alias ocodex='ork label -- codex'
alias oclaude='ork label -- claude'
alias oagy='ork label -- agy --dangerously-skip-permissions'
alias oopencode='ork label -- opencode'
"""


def sync_installed_runtimes_and_caches(home: Path, ork_cli: Path | None = None, *, dry_run: bool = False) -> bool:
    """Propagate local plugin changes to ~/.local/share/monitor and installed Claude/Codex plugin caches."""
    changed = False
    ork_cli = ork_cli or (Path(__file__).resolve().parents[3] / "bin/ork.mjs")
    plugins_dir = ork_cli.resolve().parents[2]
    if plugins_dir.name != "plugins":
        return False

    monitor_src = plugins_dir / "monitor"
    monitor_runtime = home / ".local/share/monitor"
    if monitor_src.is_dir() and monitor_runtime.is_dir():
        if dry_run:
            print(f"would sync monitor runtime: {monitor_runtime}")
        else:
            for item_name in ("bin", "lib", "package.json"):
                src_item = monitor_src / item_name
                dst_item = monitor_runtime / item_name
                if not src_item.exists():
                    continue
                if src_item.is_dir():
                    shutil.copytree(src_item, dst_item, dirs_exist_ok=True)
                else:
                    shutil.copy2(src_item, dst_item)
            print(f"✓ monitor runtime synced: {monitor_runtime}")
        changed = True

    cache_roots = [
        home / ".claude/plugins/cache/orkest",
        *(p / "plugins/cache/orkest" for p in sorted(home.glob(".claude-*")) if p.is_dir()),
        home / ".codex/plugins/cache/orkest",
    ]
    seen_real_caches: set[Path] = set()
    for cache_root in cache_roots:
        if not cache_root.is_dir():
            continue
        real_cache = cache_root.resolve()
        if real_cache in seen_real_caches:
            continue
        seen_real_caches.add(real_cache)
        for plugin_name in ("orchestrate", "monitor"):
            src_plugin = plugins_dir / plugin_name
            plugin_cache_dir = real_cache / plugin_name
            if not src_plugin.is_dir() or not plugin_cache_dir.is_dir():
                continue
            manifest = src_plugin / ".claude-plugin/plugin.json"
            version = ""
            if manifest.is_file():
                try:
                    version = str(json.loads(manifest.read_text(encoding="utf-8")).get("version") or "")
                except (OSError, ValueError):
                    version = ""
            target_dirs = [d for d in sorted(plugin_cache_dir.iterdir()) if d.is_dir()]
            if version and (plugin_cache_dir / version) not in target_dirs:
                target_dirs.append(plugin_cache_dir / version)
            if not target_dirs:
                continue
            target_dir = target_dirs[-1]
            if dry_run:
                print(f"would sync cached plugin {plugin_name}: {target_dir}")
            else:
                shutil.copytree(
                    src_plugin,
                    target_dir,
                    dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
                )
                print(f"✓ cached plugin synced ({plugin_name}): {target_dir}")
            changed = True
    return changed


def install_shell_wrappers(home: Path, ork_cli: Path | None = None, *, dry_run: bool = False) -> bool:
    """Write ~/.config/orchestrate/orkest.sh (with legacy fallback), link ~/.local/bin/ork, and wire ~/.zshrc."""
    changed = False
    ork_cli = ork_cli or (Path(__file__).resolve().parents[3] / "bin/ork.mjs")
    bin_link = home / ".local/bin/ork"
    if ork_cli.is_file() and not (bin_link.is_symlink() and bin_link.resolve() == ork_cli.resolve()):
        if dry_run:
            print(f"would link ork CLI: {bin_link} -> {ork_cli}")
        else:
            bin_link.parent.mkdir(parents=True, exist_ok=True)
            if bin_link.exists() or bin_link.is_symlink():
                bin_link.rename(bin_link.with_name(f"{bin_link.name}.mailbox-bak.{time.time_ns()}"))
                rotate_backups(bin_link)
            bin_link.symlink_to(ork_cli)
            print(f"✓ ork CLI linked: {bin_link} -> {ork_cli}")
        changed = True

    config_dir = resolve_config_home(home)
    wrapper_file = config_dir / "orkest.sh"
    script_text = shell_wrapper_script()
    if not wrapper_file.is_file() or wrapper_file.read_text(encoding="utf-8") != script_text:
        if dry_run:
            print(f"would install shell wrappers: {wrapper_file}")
        else:
            if wrapper_file.exists():
                backup(wrapper_file)
            wrapper_file.parent.mkdir(parents=True, exist_ok=True)
            configuration.write_private(wrapper_file, script_text)
            print(f"✓ shell wrappers: {wrapper_file}")
        changed = True
    else:
        print(f"• shell wrappers already installed: {wrapper_file}")

    zshrc = home / ".zshrc"
    existing = zshrc.read_text(encoding="utf-8") if zshrc.exists() else ""
    managed_pattern = re.compile(
        rf"^{re.escape(MANAGED_ZSHRC_START)}\n[\s\S]*?^{re.escape(MANAGED_ZSHRC_END)}\n?",
        re.MULTILINE,
    )
    legacy_pattern = re.compile(
        r"^# Interactive harnesses get an Orkest footer; automation and management commands stay direct\.\n"
        r"[\s\S]*?^alias oopencode='ork label -- opencode'\n?",
        re.MULTILINE,
    )
    if managed_pattern.search(existing):
        updated = managed_pattern.sub(MANAGED_ZSHRC_BLOCK, existing, count=1)
    elif legacy_pattern.search(existing):
        updated = legacy_pattern.sub(MANAGED_ZSHRC_BLOCK, existing, count=1)
    else:
        prefix = "\n" if existing and not existing.endswith("\n") else ""
        updated = existing + prefix + MANAGED_ZSHRC_BLOCK
    if updated != existing:
        if dry_run:
            print(f"would configure shell wrappers in: {zshrc}")
        else:
            if zshrc.exists():
                backup(zshrc)
            zshrc.write_text(updated, encoding="utf-8")
            print(f"✓ shell wrapper source block: {zshrc}")
        changed = True

    if remove_legacy_skill_links(home, dry_run=dry_run):
        changed = True
    if install_swarm_command(home, dry_run=dry_run):
        changed = True
    if install_swarm_skill(home, dry_run=dry_run):
        changed = True
    if install_cleanup_command(home, dry_run=dry_run):
        changed = True
    if install_cleanup_skill(home, dry_run=dry_run):
        changed = True
    if install_side_command(home, ork_cli=ork_cli, dry_run=dry_run):
        changed = True
    if install_side_skill(home, ork_cli=ork_cli, dry_run=dry_run):
        changed = True
    if install_update_command(home, ork_cli=ork_cli, dry_run=dry_run):
        changed = True
    if install_update_skill(home, ork_cli=ork_cli, dry_run=dry_run):
        changed = True
    if install_agy_statusline(home / ".gemini/antigravity-cli/settings.json", dry_run=dry_run):
        changed = True
    return changed


def legacy_opencode_map(entries: dict) -> bool:
    nested = entries.get("servers")
    return (
        isinstance(nested, dict)
        and bool(nested)
        and not configuration.TRANSPORT_FIELDS.intersection(nested)
        and all(isinstance(value, dict) for value in nested.values())
    )


def read_json_config(path: Path) -> dict:
    text = path.read_text()
    if path.suffix == ".jsonc":
        # Keep quoted strings intact when removing JSONC comments and trailing commas.
        text = re.sub(
            r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/',
            lambda match: match[0] if match[0].startswith('"') else " ",
            text,
        )
        text = re.sub(
            r'"(?:\\.|[^"\\])*"|,\s*(?=[}\]])',
            lambda match: match[0] if match[0].startswith('"') else "",
            text,
        )
    return json.loads(text)


def configuration_status(
    home: Path | None = None, binaries: set[str] | None = None, *, base: Path | None = None
) -> dict:
    """Inspect only messaging settings; never return credentials or unrelated config."""
    home = home or Path.home()
    base = base or mailbox.root()
    binaries = (
        binaries
        if binaries is not None
        else {name for name in ("claude", "codex", "agy", "opencode") if shutil.which(name)}
    )
    expected = home / ".agents/skills/orchestrate/scripts/mailbox_mcp.py"
    checks = {
        "claude": (home / ".claude.json", "mcpServers", home / ".claude/settings.json"),
        "codex": (
            Path(os.environ.get("CODEX_HOME", str(home / ".codex"))) / "config.toml",
            "mcp_servers",
            Path(os.environ.get("CODEX_HOME", str(home / ".codex"))) / "hooks.json",
        ),
        "agy": (home / ".gemini/config/mcp_config.json", "mcpServers", home / ".gemini/config/hooks.json"),
        "opencode": (
            Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config"))) / "opencode/opencode.jsonc",
            "mcp",
            None,
        ),
    }
    for profile in sorted(home.glob(".claude-*")):
        if profile.is_dir() and ((profile / "settings.json").is_file() or (profile / ".claude.json").is_file()):
            checks["claude:" + profile.name] = (profile / ".claude.json", "mcpServers", profile / "settings.json")
    result = {}
    for identity, (path, section, hooks_path) in checks.items():
        harness = "claude" if identity.startswith("claude:") else identity
        if harness not in binaries:
            continue
        if harness == "opencode" and not path.exists():
            path = path.with_suffix(".json")
        issues = []
        try:
            data = tomllib.loads(path.read_text()) if section == "mcp_servers" else read_json_config(path)
            entries = data.get(section, {})
            if harness == "opencode" and legacy_opencode_map(entries):
                issues.append("legacy OpenCode nested MCP map; rerun messaging repair")
            server = entries.get("peer-mailbox", {})
            command = server.get("command")
            args = server.get("args", [])
            if isinstance(command, list):
                args, command = command[1:], command[0] if command else None

            matches_stdio = command == "python3" and args == [str(expected)]

            url = server.get("url") or server.get("serverUrl")
            has_auth = False
            if section == "mcp_servers" and harness == "codex":
                has_auth = bool(server.get("http_headers", {}).get("Authorization"))
            else:
                has_auth = bool(server.get("headers", {}).get("Authorization"))

            matches_http = False
            if url and has_auth:
                try:
                    mailbox_daemon.endpoint(url)
                    matches_http = not command and not server.get("env")
                except mailbox.MailboxError:
                    issues.append("mailbox HTTP endpoint is invalid")

            if not matches_stdio and not matches_http:
                issues.append("mailbox MCP registration missing or stale")
            if matches_http:
                live = mailbox_daemon.owned_state(base)
                auth = server.get("http_headers" if harness == "codex" else "headers", {}).get("Authorization")
                if not live:
                    issues.append("mailbox daemon unavailable; run mailbox daemon start")
                elif live.get("runtimeRevision") != mailbox_daemon.runtime_revision():
                    issues.append("mailbox daemon uses stale code; restart after upgrade and refresh the host catalog")
                elif url != live["url"] or auth != "Bearer " + mailbox_daemon.read_token(base):
                    issues.append(
                        "mailbox HTTP registration is stale; rerun messaging repair and refresh the host catalog"
                    )
                if any(field in server for field in ("command", "args", "env", "env_vars", "environment", "cwd")):
                    issues.append("mailbox HTTP entry still contains stdio fields")
                if path.stat().st_mode & 0o077:
                    issues.append("mailbox HTTP credentials require owner-only configuration permissions")

            if server.get("disabled", False) or not server.get("enabled", True):
                issues.append("mailbox MCP is disabled")
            if harness == "codex" and server.get("tool_timeout_sec", 0) < 660:
                issues.append("Codex mailbox wait timeout is too short")
            if harness == "opencode":
                if server.get("type") != ("remote" if url else "local"):
                    issues.append("OpenCode mailbox transport type is invalid")
                if server.get("timeout", 0) < 660000:
                    issues.append("OpenCode mailbox wait timeout is too short")
            if harness == "codex":
                for tool in TOOLS:
                    if server.get("tools", {}).get(tool, {}).get("approval_mode") != "approve":
                        issues.append(f"Codex mailbox {tool} needs scoped tool permission")
        except (OSError, ValueError):
            issues.append("mailbox configuration could not be read")
        if hooks_path and harness == "agy":
            try:
                group = json.loads(hooks_path.read_text()).get("peer-mailbox", {})
                for event in AGY_EVENTS:
                    command = agy_command(expected.with_name("peer_mailbox.py"), event)
                    if not any(
                        isinstance(entry, dict) and entry.get("command") == command for entry in group.get(event, [])
                    ):
                        issues.append(f"{event} mailbox hook missing or stale")
            except (OSError, ValueError, AttributeError):
                issues.append("mailbox turn hooks missing or unreadable")
        elif hooks_path:
            try:
                hooks = json.loads(hooks_path.read_text()).get("hooks", {})
                command = shlex.join(
                    ["python3", str(expected.with_name("peer_mailbox.py")), "hook", "--harness", harness]
                )
                expected_events = CLAUDE_EVENTS if harness == "claude" else EVENTS
                for event in expected_events:
                    if not any(
                        entry.get("command") == command
                        for group in hooks.get(event, [])
                        for entry in group.get("hooks", [])
                    ):
                        issues.append(f"{event} mailbox hook missing or stale")
            except (OSError, ValueError):
                issues.append("mailbox turn hooks missing or unreadable")
        result[identity] = {"configured": not issues, "issues": issues}
    return result


def backup(path: Path, *, keep_backups: int = DEFAULT_KEEP_BACKUPS) -> None:
    configuration.backup(path)
    rotate_backups(path, keep_backups=keep_backups)


def ensure_hub(hub: Path, skill: Path, *, dry_run: bool = False) -> None:
    if hub.exists() and hub.resolve() == skill.resolve() and (hub / "scripts/mailbox_mcp.py").is_file():
        return
    if dry_run:
        print(f"would link messaging skill hub: {hub} -> {skill}")
        return
    hub.parent.mkdir(parents=True, exist_ok=True)
    if hub.exists() or hub.is_symlink():
        hub.rename(hub.with_name(f"{hub.name}.mailbox-bak.{time.time_ns()}"))
        rotate_backups(hub)
    hub.symlink_to(skill, target_is_directory=True)


def agy_command(script: Path, event: str) -> str:
    return shlex.join(["python3", str(script), "hook", "--harness", "gemini", "--event", event])


def install_agy_statusline(path: Path, *, dry_run: bool = False) -> bool:
    """Keep Antigravity's Orkest statusLine glued to the bottom of the panel without default-bar padding."""
    if not path.is_file():
        return False
    try:
        settings = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    status_line = settings.get("statusLine")
    if not isinstance(status_line, dict):
        return False
    cmd = status_line.get("command")
    if not isinstance(cmd, str) or "agent_statusline.py" not in cmd:
        return False
    if status_line.get("stack_with_default") is False:
        return False
    if dry_run:
        print(f"would disable stack_with_default on Antigravity statusLine: {path}")
        return True
    status_line["stack_with_default"] = False
    backup(path)
    configuration.write_private(path, json.dumps(settings, indent=2) + "\n")
    print(f"✓ Antigravity statusLine glued to bottom (stack_with_default=false): {path}")
    return True


def install_agy_hooks(path: Path, script: Path, *, dry_run: bool = False) -> bool:
    """Antigravity hooks.json: named groups of flat handler lists; other groups stay untouched."""
    settings = json.loads(path.read_text()) if path.exists() else {}
    before = json.dumps(settings, sort_keys=True)
    settings["peer-mailbox"] = {
        event: [{"type": "command", "command": agy_command(script, event), "timeout": 10}] for event in AGY_EVENTS
    }
    if before == json.dumps(settings, sort_keys=True):
        print(f"• hooks already installed: {path}")
        return False
    if dry_run:
        print(f"would install Antigravity turn hooks: {path}")
        return True
    backup(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    configuration.write_private(path, json.dumps(settings, indent=2) + "\n")
    print(f"✓ Antigravity turn hooks: {path}")
    return True


def install_hooks(path: Path, script: Path, harness: str, *, dry_run: bool = False) -> bool:
    settings = json.loads(path.read_text()) if path.exists() else {}
    before = json.dumps(settings, sort_keys=True)
    command = shlex.join(["python3", str(script), "hook", "--harness", harness])
    hooks = settings.setdefault("hooks", {})
    target_events = CLAUDE_EVENTS if harness == "claude" else EVENTS
    for event in target_events:
        groups = hooks.setdefault(event, [])
        entries = [
            hook
            for group in groups
            for hook in group.get("hooks", [])
            if "peer_mailbox.py hook" in hook.get("command", "") or "peer_mailbox.py' hook" in hook.get("command", "")
        ]
        desired = {"type": "command", "command": command, "timeout": 3 if event == "SessionEnd" else 10}
        if entries:
            for entry in entries:
                entry.update(desired)
        else:
            groups.append({"hooks": [desired]})
    if before == json.dumps(settings, sort_keys=True):
        print(f"• hooks already installed: {path}")
        return False
    if dry_run:
        print(f"would install {harness} turn hooks: {path}")
        return True
    backup(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    configuration.write_private(path, json.dumps(settings, indent=2) + "\n")
    print(f"✓ {harness} turn hooks: {path}")
    return True


def set_codex_timeout(path: Path, *, dry_run: bool = False) -> None:
    text = path.read_text()
    value = tomllib.loads(text).get("mcp_servers", {}).get("peer-mailbox", {})
    if value.get("tool_timeout_sec", 0) >= 660:
        return
    # `codex mcp add` creates this table. Preserve all other config and its comments.
    table = re.search(r'^\[mcp_servers\.(?:peer-mailbox|"peer-mailbox")\]\s*\n', text, re.MULTILINE)
    if not table:
        raise ValueError("Codex did not create the peer-mailbox configuration table")
    following = re.search(r"^\[", text[table.end() :], re.MULTILINE)
    end = table.end() + following.start() if following else len(text)
    block = text[table.end() : end]
    timeout = re.compile(r"^tool_timeout_sec\s*=.*$", re.MULTILINE)
    if timeout.search(block):
        block = timeout.sub("tool_timeout_sec = 660", block)
    else:
        block = "tool_timeout_sec = 660\n" + block
    updated = text[: table.end()] + block + text[end:]
    tomllib.loads(updated)
    if dry_run:
        print(f"would allow 600-second mailbox waits: {path}")
    else:
        backup(path)
        path.write_text(updated)
        print("✓ Codex mailbox tool timeout: 660 seconds")


def register(
    name: str,
    config: Path,
    section: str,
    harness: str,
    *,
    dry_run: bool,
    stdio: bool = False,
    daemon_url: str = "",
    daemon_token: str = "",
    env: dict[str, str] | None = None,
) -> None:
    del env  # Structured local writes never send credentials through process arguments.
    if config.is_symlink():
        raise ValueError("MCP configuration must be a regular local file")
    text = config.read_text() if config.exists() else ("" if config.suffix == ".toml" else "{}\n")
    settings = tomllib.loads(text) if config.suffix == ".toml" else configuration.read_json(config)
    entries = settings.get(section, {})
    nested = section == "mcp" and legacy_opencode_map(entries)
    servers = entries.get("servers", {}) if nested else entries
    current = servers.get("peer-mailbox", {})
    if not isinstance(current, dict):
        raise ValueError("mailbox configuration entry must be an object")
    desired = copy.deepcopy({key: value for key, value in current.items() if key not in configuration.TRANSPORT_FIELDS})
    script = str(Path.home() / ".agents/skills/orchestrate/scripts/mailbox_mcp.py")
    if stdio:
        if harness == "opencode":
            desired = {key: value for key, value in desired.items() if key in {"enabled", "timeout"}}
            desired.update(
                type="local", command=["python3", script], enabled=True, timeout=max(desired.get("timeout", 0), 660000)
            )
        else:
            desired.update(command="python3", args=[script])
            if harness != "agy":
                desired["type"] = "stdio"
    else:
        mailbox_daemon.endpoint(daemon_url)
        if not daemon_token:
            raise ValueError("local daemon credentials are missing")
        if harness == "codex":
            desired.update(url=daemon_url, http_headers={"Authorization": "Bearer " + daemon_token})
        elif harness == "agy":
            desired.update(serverUrl=daemon_url, headers={"Authorization": "Bearer " + daemon_token})
        else:
            if harness == "opencode":
                desired = {key: value for key, value in desired.items() if key in {"enabled", "timeout", "oauth"}}
                desired["timeout"] = max(desired.get("timeout", 0), 660000)
                desired["oauth"] = False
            desired.update(
                type="remote" if harness == "opencode" else "http",
                url=daemon_url,
                headers={"Authorization": "Bearer " + daemon_token},
            )
    if harness == "codex":
        desired["tool_timeout_sec"] = max(desired.get("tool_timeout_sec", 0), 660)
        tools = desired.setdefault("tools", {})
        for tool in TOOLS:
            tools.setdefault(tool, {})["approval_mode"] = "approve"
        updated = configuration.set_toml_server(text, desired)
    else:
        if harness == "opencode" and nested:
            # Migrate the former nested shape into the current direct server map.
            # Preserve every other server and comment; only the owned entry changes transport.
            flattened = {key: value for key, value in entries.items() if key != "servers"}
            if any(key in flattened for key in servers):
                raise ValueError("legacy OpenCode server names conflict with direct entries")
            flattened.update(servers)
            flattened["peer-mailbox"] = desired
            root_members, _, _ = configuration.members(text, configuration.skip(text, 0))
            begin, end = root_members["mcp"]
            comments = [
                match[0]
                for match in re.finditer(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/', text[begin:end])
                if not match[0].startswith('"')
            ]
            updated = configuration.set_json_path(
                text, ["mcp"], flattened, preserved_comments="\n".join(comments) + ("\n" if comments else "")
            )
        else:
            updated = configuration.set_json_path(text or "{}", [section, "peer-mailbox"], desired)
        # Validate the actual edited text before replacing the user's file.
        clean = re.sub(
            r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/',
            lambda match: match[0] if match[0].startswith('"') else " ",
            updated,
        )
        clean = re.sub(
            r'"(?:\\.|[^"\\])*"|,\s*(?=[}\]])', lambda match: match[0] if match[0].startswith('"') else "", clean
        )
        json.loads(clean)
    if current == desired or updated == text:
        if not dry_run and config.exists():
            config.chmod(0o600)
        print(f"• {name} mailbox already registered ({'stdio' if stdio else 'http'})")
        return
    if dry_run:
        print(f"would register {name} ({'stdio' if stdio else 'http'}); credential values omitted")
        return
    backup(config)
    configuration.write_private(config, updated, expected=text if config.exists() else None)
    print(f"✓ {name} mailbox registered ({'stdio' if stdio else 'http'})")


def mailbox_hook_updates(response: dict, script: Path, hooks_file: Path) -> dict:
    """Only the four installer-owned commands qualify for explicit scoped trust."""
    expected = ["python3", str(script), "hook", "--harness", "codex"]
    events = {"sessionStart", "userPromptSubmit", "stop", "sessionEnd"}
    matches = []
    for entry in response.get("data", []):
        for hook in entry.get("hooks", []):
            if (
                hook.get("handlerType") == "command"
                and Path(hook.get("sourcePath", "")).resolve() == hooks_file.resolve()
                and shlex.split(hook.get("command", "")) == expected
                and hook.get("eventName") in events
            ):
                matches.append(hook)
    if len(matches) != 4 or {hook["eventName"] for hook in matches} != events:
        raise ValueError("Expected exactly four mailbox hooks; refusing to trust other hook definitions")
    return {hook["key"]: {"trusted_hash": hook["currentHash"]} for hook in matches}


def trust_codex(script: Path, codex: Path, *, dry_run: bool = False) -> None:
    if dry_run:
        print("would trust only the four installer-owned Codex mailbox hooks")
        return
    with RpcClient(["codex", "app-server", "--stdio"]) as client:
        initialize_codex(client)
        response = client.request("hooks/list", {"cwds": [str(Path.home())]})
        updates = mailbox_hook_updates(response, script, codex / "hooks.json")
        current = tomllib.loads((codex / "config.toml").read_text()).get("hooks", {}).get("state", {})
        if all(current.get(key, {}).get("trusted_hash") == value["trusted_hash"] for key, value in updates.items()):
            print("• Codex mailbox hooks already trusted")
            return
        backup(codex / "config.toml")
        client.request(
            "config/batchWrite",
            {
                "edits": [{"keyPath": "hooks.state", "value": updates, "mergeStrategy": "upsert"}],
                "reloadUserConfig": True,
            },
        )
        response = client.request("hooks/list", {"cwds": [str(Path.home())]})
        trusted = {
            hook["key"]: hook["trustStatus"]
            for entry in response.get("data", [])
            for hook in entry.get("hooks", [])
            if hook["key"] in updates
        }
        if trusted != dict.fromkeys(updates, "trusted"):
            raise RuntimeError("Codex did not confirm trust for all four mailbox hooks")
        print("✓ trusted exactly four Codex mailbox hooks")


def codex_tool_edits(server: dict) -> list[dict]:
    """Permit the local mailbox operations without changing other tool policy."""
    return [
        {
            "keyPath": f"mcp_servers.peer-mailbox.tools.{tool}.approval_mode",
            "value": "approve",
            "mergeStrategy": "replace",
        }
        for tool in TOOLS
        if server.get("tools", {}).get(tool, {}).get("approval_mode") != "approve"
    ]


def permit_codex_tools(config: Path, *, dry_run: bool = False) -> None:
    server = tomllib.loads(config.read_text()).get("mcp_servers", {}).get("peer-mailbox", {})
    edits = codex_tool_edits(server)
    if not edits:
        return
    if dry_run:
        print(f"would permit only the {len(TOOLS)} local Codex mailbox tools")
        return
    backup(config)
    with RpcClient(["codex", "app-server", "--stdio"]) as client:
        initialize_codex(client)
        client.request("config/batchWrite", {"edits": edits, "reloadUserConfig": True})
    print(f"✓ scoped permission for {len(TOOLS)} local Codex mailbox tools")


def install_login_startup(home: Path, base: Path, script: Path, *, stdio: bool, dry_run: bool) -> None:
    """Queue startup at macOS login; the current service is already started explicitly by install."""
    if sys.platform != "darwin":
        return
    path = home / "Library/LaunchAgents/dev.loftshed.agent-mailbox.plist"
    if stdio:
        if path.exists() and not dry_run:
            backup(path)
            path.unlink()
        return
    data = {
        "Label": "dev.loftshed.agent-mailbox",
        "ProgramArguments": [
            sys.executable,
            str(script if dry_run else mailbox_daemon.runtime_bundle(base)),
            "serve",
            "--root",
            str(base),
            "--json",
        ],
        "RunAtLoad": True,
        "ProcessType": "Background",
        "EnvironmentVariables": {key: os.environ[key] for key in ("PATH", "CODEX_HOME") if key in os.environ},
    }
    content = plistlib.dumps(data).decode("utf-8")
    if path.exists() and path.read_text() == content:
        return
    if dry_run:
        print("would install owner-only mailbox startup at macOS login")
        return
    backup(path)
    configuration.write_private(path, content)


def install(
    *, dry_run: bool = False, trust_codex_hooks: bool = False, verify: bool = True, stdio: bool = False
) -> None:
    home = Path.home()
    hub = home / ".agents/skills/orchestrate/scripts"
    ensure_hub(hub.parent, Path(__file__).resolve().parent.parent, dry_run=dry_run)

    daemon_url = ""
    daemon_token = ""
    if not stdio:
        if dry_run:
            daemon_url = "http://127.0.0.1:49152/mcp"
            daemon_token = "mock"
        else:
            base = mailbox.root()
            state = mailbox_daemon.ensure_running(base)
            if state.get("runtimeRevision") != mailbox_daemon.runtime_revision():
                mailbox_daemon.stop_service(base)
                state = mailbox_daemon.ensure_running(base)
            daemon_url = state["url"]
            daemon_token = mailbox_daemon.read_token(base)
            mailbox_daemon.set_mode(base, "http")

    if shutil.which("claude"):
        profiles = [home / ".claude"] + sorted(
            p
            for p in home.glob(".claude-*")
            if p.is_dir() and ((p / "settings.json").is_file() or (p / ".claude.json").is_file())
        )
        for profile in profiles:
            if not profile.is_dir():
                continue
            env = dict(os.environ)
            env.pop("CLAUDE_CONFIG_DIR", None)
            config = home / ".claude.json"
            if profile.name != ".claude":
                env["CLAUDE_CONFIG_DIR"] = str(profile)
                config = profile / ".claude.json"
            register(
                f"Claude ({profile.name})",
                config,
                "mcpServers",
                "claude",
                dry_run=dry_run,
                stdio=stdio,
                daemon_url=daemon_url,
                daemon_token=daemon_token,
                env=env,
            )
            install_hooks(profile / "settings.json", hub / "peer_mailbox.py", "claude", dry_run=dry_run)

    if shutil.which("codex"):
        codex = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))).expanduser()
        config = codex / "config.toml"
        register(
            "Codex",
            config,
            "mcp_servers",
            "codex",
            dry_run=dry_run,
            stdio=stdio,
            daemon_url=daemon_url,
            daemon_token=daemon_token,
        )
        if not dry_run or config.exists() and "peer-mailbox" in config.read_text():
            set_codex_timeout(config, dry_run=dry_run)
            permit_codex_tools(config, dry_run=dry_run)
        install_hooks(codex / "hooks.json", hub / "peer_mailbox.py", "codex", dry_run=dry_run)
        if trust_codex_hooks:
            trust_codex(hub / "peer_mailbox.py", codex, dry_run=dry_run)
        else:
            trusted_state = (
                tomllib.loads(config.read_text()).get("hooks", {}).get("state", {}) if config.exists() else {}
            )
            trusted_count = sum(
                isinstance(entry, dict) and bool(entry.get("trusted_hash")) for entry in trusted_state.values()
            )
            if trusted_count < len(EVENTS):
                print(
                    "Codex automatic delivery needs hook trust: use /hooks, or rerun with --trust-codex-hooks after review."
                )

    if shutil.which("agy"):
        register(
            "Antigravity",
            home / ".gemini/config/mcp_config.json",
            "mcpServers",
            "agy",
            dry_run=dry_run,
            stdio=stdio,
            daemon_url=daemon_url,
            daemon_token=daemon_token,
        )
        install_agy_hooks(home / ".gemini/config/hooks.json", hub / "peer_mailbox.py", dry_run=dry_run)

    if shutil.which("opencode"):
        directory = Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config"))) / "opencode"
        config = directory / "opencode.jsonc"
        if not config.exists():
            config = directory / "opencode.json"
        register(
            "OpenCode",
            config,
            "mcp",
            "opencode",
            dry_run=dry_run,
            stdio=stdio,
            daemon_url=daemon_url,
            daemon_token=daemon_token,
        )

    install_shell_wrappers(home, dry_run=dry_run)
    sync_installed_runtimes_and_caches(home, dry_run=dry_run)
    install_login_startup(home, mailbox.root(), hub / "mailbox_daemon.py", stdio=stdio, dry_run=dry_run)
    prune_daemon_runtimes(mailbox.root(), dry_run=dry_run)
    if not dry_run:
        mailbox_daemon.set_mode(mailbox.root(), "stdio" if stdio else "http")
    if verify and not dry_run:
        report = check()
        print(f"✓ {len(report['round_trips'])} mailbox message/reply round trips; evidence: {report['evidence']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--trust-codex-hooks", action="store_true", help="explicitly trust only the four installed mailbox hooks"
    )
    parser.add_argument("--stdio", action="store_true", help="install using local stdio rather than the daemon")
    args = parser.parse_args(argv)
    try:
        install(dry_run=args.dry_run, trust_codex_hooks=args.trust_codex_hooks, stdio=args.stdio)
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"mailbox install: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
