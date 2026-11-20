#!/usr/bin/env python3
"""Register the peer mailbox and turn hooks for installed local harnesses."""

from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import io
import json
import os
import platform
import plistlib
import re
import shlex
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path
from typing import Any

import command_approval
import legacy_plugin
import mailbox_configuration as configuration
import mailbox_daemon
import mailbox_mcp
import path_migration
import peer_mailbox as mailbox
import runtime_paths
from check_mailbox import RpcClient, check, initialize_codex

EVENTS = ("SessionStart", "UserPromptSubmit", "Stop", "SessionEnd")
CLAUDE_EVENTS = (*EVENTS, "SubagentStart", "SubagentStop", "StopFailure")
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


def install_orchestrate_skill_links(home: Path, *, dry_run: bool = False) -> bool:
    """Keep <harness>/skills/orchestrate linked to ~/.agents/skills/orchestrate across installed harnesses."""
    hub = home / ".agents/skills/orchestrate"
    if not (hub / "SKILL.md").is_file():
        return False
    changed = False
    targets: list[Path] = [
        home / ".codex",
        home / ".gemini/config",
        home / ".gemini/antigravity",
        home / ".config/opencode",
    ]
    for claude_dir in [home / ".claude", *sorted(home.glob(".claude-*"))]:
        if not claude_dir.is_dir():
            continue
        targets.append(claude_dir)
    for base_dir in targets:
        if not base_dir.is_dir():
            continue
        skill_link = base_dir / "skills/orchestrate"
        if skill_link.is_symlink() and skill_link.exists() and skill_link.resolve() == hub.resolve():
            continue
        if dry_run:
            print(f"would link orchestrate skill: {skill_link} -> {hub}")
        else:
            skill_link.parent.mkdir(parents=True, exist_ok=True)
            if skill_link.exists() or skill_link.is_symlink():
                skill_link.rename(skill_link.with_name(f"{skill_link.name}.mailbox-bak.{time.time_ns()}"))
                rotate_backups(skill_link)
            skill_link.symlink_to(hub, target_is_directory=True)
            print(f"✓ orchestrate skill linked: {skill_link} -> {hub}")
        changed = True
    return changed


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


# A command or skill file is Orkest's to replace only when its bytes are exactly a body Orkest wrote: the current
# source, a historical shipped body (SHA-256 digests in `adapters/owned-digests.json`, so no second copy of any body
# is embedded), or the body this installer last recorded for that path. Anything else is the user's and stays.
OWNED_DIGESTS_FILE = "adapters/owned-digests.json"
INSTALLED_DIGESTS = ".local/share/orchestrate/installed-text-digests.json"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _known_digests(kind: str, name: str) -> set[str]:
    for root in _adapter_roots():
        manifest = root / OWNED_DIGESTS_FILE
        if manifest.is_file():
            try:
                return set(json.loads(manifest.read_text(encoding="utf-8")).get(kind, {}).get(name, ()))
            except (OSError, ValueError, AttributeError):
                return set()
    return set()


def _recorded_digests(home: Path) -> dict[str, str]:
    try:
        data = json.loads((home / INSTALLED_DIGESTS).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return (
        {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(data, dict) else {}
    )


def _record_digest(home: Path, path: Path, digest: str) -> None:
    recorded = _recorded_digests(home)
    recorded[str(path)] = digest
    configuration.write_private(home / INSTALLED_DIGESTS, json.dumps(recorded, indent=2, sort_keys=True) + "\n")


def _write_owned_text(home: Path, path: Path, content: str, label: str, kind: str, name: str, *, dry_run: bool) -> bool:
    """Write `content` to `path` unless it already matches; edited, foreign and symlinked files are left alone."""
    new = content.encode("utf-8")
    try:
        existing = configuration.regular_file_bytes(path)
    except (ValueError, OSError) as error:
        print(f"• {label} left unchanged: {error}")
        return False
    if existing == new:
        digest = _sha256(new)
        if digest not in _known_digests(kind, name) and _recorded_digests(home).get(str(path)) != digest:
            if not dry_run:
                _record_digest(home, path, digest)
            return True
        return False
    if existing is not None:
        digest = _sha256(existing)
        if digest not in _known_digests(kind, name) and _recorded_digests(home).get(str(path)) != digest:
            print(f"• {label} left unchanged (edited or not written by Orkest): {path}")
            return False
    if dry_run:
        print(f"would install {label}: {path}")
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if existing is None:
            configuration.write_private(path, content, create_only=True)
        else:
            backup(path)
            configuration.write_private(path, content, expected=existing)
    except (ValueError, FileExistsError, FileNotFoundError) as error:
        print(f"• {label} changed during setup; skipped: {error}")
        return False
    _record_digest(home, path, _sha256(new))
    print(f"✓ {label}: {path}")
    return True


def _install_claude_command(home: Path, name: str, content: str, *, dry_run: bool = False) -> bool:
    changed = False
    for claude_dir in [home / ".claude", *sorted(home.glob(".claude-*"))]:
        if claude_dir.is_dir() and _write_owned_text(
            home, claude_dir / f"commands/{name}.md", content, f"/{name} command", "commands", name, dry_run=dry_run
        ):
            changed = True
    return changed


def _orkest_owned_link(link: Path, hub: Path) -> bool:
    """A symlink Orkest created: it leads to this skill in the hub or to its shipped directory."""
    if not link.is_symlink():
        return False
    target = Path(os.path.realpath(link))
    if target == Path(os.path.realpath(hub)):
        return True
    return any(
        target == (root / directory / hub.name).resolve()
        for root in _adapter_roots()
        for directory in ("skills", "adapters/skills", "plugins/orchestrate/skills")
    )


def _install_cross_harness_skill(
    home: Path,
    name: str,
    content: str,
    *,
    include_claude: bool = False,
    dry_run: bool = False,
) -> bool:
    changed = False
    skill_hub = home / f".agents/skills/{name}"
    if skill_hub.is_symlink():
        print(f"• /{name} skill hub left unchanged (symlink): {skill_hub}")
        return False
    if _write_owned_text(
        home,
        skill_hub / "SKILL.md",
        content,
        f"/{name} skill",
        "skills",
        name,
        dry_run=dry_run,
    ):
        changed = True
    duplicate_parents: tuple[Path, ...] = (
        (home / ".gemini/antigravity/skills",)
        if include_claude
        else (
            home / ".claude/skills",
            *(p / "skills" for p in sorted(home.glob(".claude-*")) if p.is_dir()),
            home / ".gemini/antigravity/skills",
        )
    )
    owned_duplicates = {}
    for dup_parent in duplicate_parents:
        dup_link = dup_parent / name
        if not (dup_link.is_symlink() or dup_link.exists()):
            continue
        if not _orkest_owned_link(dup_link, skill_hub):
            print(f"• /{name} skill left unchanged (not an Orkest link): {dup_link}")
            continue
        owned_duplicates[dup_link] = dup_link.readlink()
    # A profile can link through another profile. Resolve ownership before either link is removed.
    for dup_link, original_target in owned_duplicates.items():
        if not dup_link.is_symlink() or dup_link.readlink() != original_target:
            continue
        if dry_run:
            print(f"would remove duplicate /{name} skill link: {dup_link}")
        else:
            dup_link.unlink(missing_ok=True)
            print(f"✓ removed duplicate /{name} skill link: {dup_link}")
        changed = True
    skill_parents: tuple[Path, ...] = (
        home / ".codex/skills",
        home / ".gemini/config/skills",
        home / ".config/opencode/skills",
        *(
            (
                home / ".claude/skills",
                *(p / "skills" for p in sorted(home.glob(".claude-*")) if p.is_dir()),
            )
            if include_claude
            else ()
        ),
    )
    for skill_parent in skill_parents:
        if not skill_parent.parent.is_dir():
            continue
        skill_link = skill_parent / name
        if not (skill_link.is_symlink() and skill_link.resolve() == skill_hub.resolve()):
            if (skill_link.exists() or skill_link.is_symlink()) and not _orkest_owned_link(skill_link, skill_hub):
                print(f"• /{name} skill left unchanged (not an Orkest link): {skill_link}")
                continue
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


ORK_CLI_RELATIVE = Path("src/bin/ork.mjs")


def _default_ork_cli() -> Path:
    """`ork` in this checkout: `src/bin/ork.mjs` under the repository root."""
    return Path(__file__).resolve().parents[5] / ORK_CLI_RELATIVE


def _checkout_of(ork_cli: Path) -> Path:
    """The repository root above `<root>/src/bin/ork.mjs`; the plugin directory above a pre-move `bin/ork.mjs`."""
    return ork_cli.parent.parent.parent if ork_cli.parent.parent.name == "src" else ork_cli.parent.parent


def _orchestrate_plugin_of(ork_cli: Path) -> Path:
    """The `plugins/orchestrate` directory (skill, macOS HUD) that belongs to this `ork.mjs`."""
    checkout = _checkout_of(ork_cli)
    return checkout / "plugins/orchestrate" if (checkout / "plugins/orchestrate").is_dir() else checkout


def _candidate_plugin_roots(plugin_root: Path | None = None, ork_cli: Path | None = None) -> list[Path]:
    roots: list[Path] = []
    if plugin_root is not None:
        roots.append(plugin_root)
    if ork_cli is not None:
        roots.append(_orchestrate_plugin_of(ork_cli))
    roots.append(Path(__file__).resolve().parents[3])
    unique: list[Path] = []
    for root in roots:
        if root not in unique:
            unique.append(root)
    return unique


HERDR_PLUGIN_ID = "orkest.swarms"
HERDR_SHORTCUT_BLOCK = (
    "\n[[keys.command]]\n"
    'key = "ctrl+alt+s"\n'
    'type = "plugin_action"\n'
    'command = "orkest.swarms.toggle"\n'
    'description = "toggle Orkest Swarm View"\n'
)


def _herdr_source_root(ork_cli: Path | None) -> Path | None:
    cli = ork_cli or _default_ork_cli()
    return next((directory for directory in cli.resolve().parents if (directory / "herdr-plugin.toml").is_file()), None)


def _herdr_binary() -> str | None:
    return os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")


def _herdr_config_file(home: Path) -> Path:
    return Path(os.environ.get("HERDR_CONFIG_PATH") or home / ".config/herdr/config.toml").expanduser()


def _herdr_command(herdr: str, arguments: list[str], home: Path) -> subprocess.CompletedProcess:
    environment = {**os.environ, "HOME": str(home), "HERDR_CONFIG_PATH": str(_herdr_config_file(home))}
    # Registry operations are local to this installation, never a remote pane/session socket.
    environment.pop("HERDR_SOCKET_PATH", None)
    process = subprocess.run(
        [herdr, *arguments], env=environment, capture_output=True, text=True, timeout=15, check=False
    )
    if process.returncode:
        raise RuntimeError(
            f"Herdr {' '.join(arguments[:2])} failed: {process.stderr.strip() or process.stdout.strip()}"
        )
    return process


def _herdr_registration(herdr: str, home: Path) -> dict | None:
    process = _herdr_command(herdr, ["plugin", "list", "--plugin", HERDR_PLUGIN_ID, "--json"], home)
    try:
        response = json.loads(process.stdout)
        entries = response["result"]["plugins"]
        if not isinstance(entries, list):
            raise ValueError("plugins must be an array")
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError("Herdr returned an unreadable plugin list; registration was left unchanged") from error
    return next(
        (entry for entry in entries if isinstance(entry, dict) and entry.get("plugin_id") == HERDR_PLUGIN_ID), None
    )


def _owned_herdr_registration(registration: dict, source_root: Path) -> bool:
    source = registration.get("source")
    return (
        isinstance(source, dict)
        and source.get("kind") == "local"
        and isinstance(registration.get("plugin_root"), str)
        and Path(registration["plugin_root"]).resolve() == source_root.resolve()
    )


def _herdr_shortcut_available(config: str) -> bool:
    try:
        commands = tomllib.loads(config).get("keys", {}).get("command", [])
    except (tomllib.TOMLDecodeError, AttributeError):
        return False
    if not isinstance(commands, list):
        return False
    return not any(
        isinstance(command, dict)
        and (str(command.get("key", "")).lower() == "ctrl+alt+s" or command.get("command") == "orkest.swarms.toggle")
        for command in commands
    )


def _offer_herdr_ui(config_file: Path) -> bool:
    """Offer missing UI settings without overriding any explicit user preference."""
    if not sys.stdin.isatty():
        return False
    existing = config_file.read_text(encoding="utf-8") if config_file.is_file() else ""
    try:
        ui = tomllib.loads(existing).get("ui", {})
    except tomllib.TOMLDecodeError:
        return False
    if not isinstance(ui, dict):
        return False
    additions = []
    offers = (
        ("show_agent_labels_on_pane_borders", "Show Orkest agent labels on Herdr pane borders? [y/N] ", "true"),
        (
            "tab_bar_right",
            "Show the focused Orkest agent in Herdr's tab bar? [y/N] ",
            '[{ type = "command", command = "ork herdr-status", interval_seconds = 1, timeout_seconds = 1 }]',
        ),
    )
    for key, prompt, value in offers:
        if key in ui:
            continue
        try:
            accepted = input(prompt).strip().lower() in {"y", "yes"}
        except (EOFError, OSError):
            accepted = False
        if accepted:
            additions.append(f"{key} = {value}\n")
    if not additions:
        return False
    block = "".join(additions)
    # Add at the beginning of the existing table so nested/following tables retain their scope.
    header = re.search(r"(?m)^\[ui\][ \t]*(?:#.*)?$", existing)
    if header:
        updated = existing[: header.end()] + "\n" + block + existing[header.end() :]
    elif "ui" not in tomllib.loads(existing):
        updated = existing.rstrip() + "\n\n[ui]\n" + block
    else:
        return False  # Preserve unusual inline/dotted table declarations verbatim.
    tomllib.loads(updated)
    config_file.parent.mkdir(parents=True, exist_ok=True)
    if config_file.exists():
        backup(config_file)
    config_file.write_text(updated, encoding="utf-8")
    return True


def install_herdr_integration(home: Path, ork_cli: Path | None = None, *, dry_run: bool = False) -> bool:
    """Refresh the official local plugin registration without editing Herdr's private registry."""
    herdr = _herdr_binary()
    if not herdr:
        return False
    source_root = _herdr_source_root(ork_cli)
    if source_root is None:
        print("• Herdr integration skipped: install Orkest from its checkout to include herdr-plugin.toml")
        return False
    registration = _herdr_registration(herdr, home)
    if registration is not None and not _owned_herdr_registration(registration, source_root):
        print(
            "• Herdr Orkest plugin belongs to another installation; its registration and shortcut were left unchanged"
        )
        return False
    enabled = registration is None or registration.get("enabled", True)
    if dry_run:
        print(
            f"would refresh Herdr {HERDR_PLUGIN_ID} registration from: {source_root} ({'enabled' if enabled else 'disabled'})"
        )
        return True
    # Link re-reads the actual manifest, including newly added startup hooks. Herdr preserves config/state.
    _herdr_command(herdr, ["plugin", "link", str(source_root), "--enabled" if enabled else "--disabled"], home)
    print(f"✓ Herdr {HERDR_PLUGIN_ID} registration refreshed ({'enabled' if enabled else 'disabled'})")
    config_file = _herdr_config_file(home)
    existing_cfg = config_file.read_text(encoding="utf-8") if config_file.is_file() else ""
    if enabled and _herdr_shortcut_available(existing_cfg):
        config_file.parent.mkdir(parents=True, exist_ok=True)
        if config_file.exists():
            backup(config_file)
        config_file.write_text(
            existing_cfg.rstrip() + ("\n" if existing_cfg.strip() else "") + HERDR_SHORTCUT_BLOCK, encoding="utf-8"
        )
        print(f"✓ Herdr ctrl+alt+s shortcut: {config_file}")
    if enabled:
        _offer_herdr_ui(config_file)
    cli = ork_cli or _default_ork_cli()
    helper = _orchestrate_plugin_of(cli.resolve()) / "skills/orchestrate/scripts/herdr_swarm_restore.py"
    if enabled and os.environ.get("HERDR_ENV") == "1" and helper.is_file():
        try:
            adopted = subprocess.run(
                [sys.executable, str(helper), "--adopt"],
                env={**os.environ, "HOME": str(home), "HERDR_BIN_PATH": herdr},
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            if adopted.returncode:
                print("• Herdr live swarm adoption could not complete; existing views were left running")
            elif adopted.stdout.strip():
                print(adopted.stdout.strip())
        except (OSError, subprocess.SubprocessError):
            print("• Herdr live swarm adoption unavailable; existing views were left running")
    return True


def uninstall_herdr_integration(home: Path, ork_cli: Path | None = None, *, dry_run: bool = False) -> bool:
    """Unregister only this checkout's local plugin; retain Herdr and Orkest config/state."""
    herdr = _herdr_binary()
    source_root = _herdr_source_root(ork_cli)
    if not herdr or source_root is None:
        return False
    registration = _herdr_registration(herdr, home)
    if registration is not None and not _owned_herdr_registration(registration, source_root):
        print("• Herdr Orkest plugin belongs to another installation; left unchanged")
        return False
    config_file = _herdr_config_file(home)
    existing_cfg = config_file.read_text(encoding="utf-8") if config_file.is_file() else ""
    updated_cfg = existing_cfg.replace(HERDR_SHORTCUT_BLOCK, "")
    changed = registration is not None or updated_cfg != existing_cfg
    if dry_run:
        if changed:
            print(f"would unregister this installation's Herdr {HERDR_PLUGIN_ID} plugin and managed shortcut")
        return changed
    if registration is not None:
        _herdr_command(herdr, ["plugin", "unlink", HERDR_PLUGIN_ID], home)
        print(f"✓ Herdr {HERDR_PLUGIN_ID} unregistered; config and state retained")
    if updated_cfg != existing_cfg:
        backup(config_file)
        config_file.write_text(updated_cfg, encoding="utf-8")
        print(f"✓ Herdr managed shortcut removed: {config_file}")
    return changed


def install_herdr_skill(
    home: Path, *, plugin_root: Path | None = None, ork_cli: Path | None = None, dry_run: bool = False
) -> bool:
    """Install the official Herdr skill across ~/.agents/skills, Codex, Antigravity, and OpenCode."""
    content = ""
    herdr = _herdr_binary()
    if herdr:
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            proc = subprocess.run([herdr, "--skill"], capture_output=True, text=True, timeout=5, check=False)
            if proc.returncode == 0 and proc.stdout.strip().startswith("---"):
                content = proc.stdout
    if not content:
        source_root = _herdr_source_root(ork_cli)
        if source_root is not None:
            repo_skill = source_root / ".agents/skills/herdr/SKILL.md"
            if repo_skill.is_file():
                content = repo_skill.read_text(encoding="utf-8")
    if not content:
        for root in _candidate_plugin_roots(plugin_root, ork_cli):
            candidate = root.parent.parent / ".agents/skills/herdr/SKILL.md"
            if candidate.is_file():
                content = candidate.read_text(encoding="utf-8")
                break
    if not content:
        return False
    return _install_cross_harness_skill(home, "herdr", content, include_claude=True, dry_run=dry_run)


def _adapter_roots(plugin_root: Path | None = None, ork_cli: Path | None = None) -> list[Path]:
    """Directories that may hold `adapters/`: each candidate root, and the checkout above a `plugins/<name>` root."""
    roots: list[Path] = []
    for root in _candidate_plugin_roots(plugin_root, ork_cli):
        for candidate in (root, root.parent.parent if root.parent.name == "plugins" else root):
            if candidate not in roots:
                roots.append(candidate)
    return roots


def _adapter_source(relative: str, plugin_root: Path | None = None, ork_cli: Path | None = None) -> str | None:
    """Read the one tracked source for a command or skill, from `adapters/<relative>`."""
    for root in _adapter_roots(plugin_root, ork_cli):
        source = root / "adapters" / relative
        if source.is_file():
            return source.read_text(encoding="utf-8")
    return None


def _install_command_source(
    home: Path, name: str, plugin_root: Path | None, ork_cli: Path | None, dry_run: bool
) -> bool:
    content = _adapter_source(f"claude/commands/{name}.md", plugin_root, ork_cli)
    return content is not None and _install_claude_command(home, name, content, dry_run=dry_run)


def _install_skill_source(home: Path, name: str, plugin_root: Path | None, ork_cli: Path | None, dry_run: bool) -> bool:
    content = _adapter_source(f"skills/{name}/SKILL.md", plugin_root, ork_cli)
    return content is not None and _install_cross_harness_skill(home, name, content, dry_run=dry_run)


# Every command and skill Orkest writes, each read from exactly one file under `adapters/`.
ADAPTER_COMMANDS = ("account", "swarm", "horde", "cleanup", "side", "update", "chief")
ADAPTER_SKILLS = ("swarm", "cleanup", "side", "update", "chief")


def install_adapter_commands(
    home: Path, *, plugin_root: Path | None = None, ork_cli: Path | None = None, dry_run: bool = False
) -> bool:
    """Write each `adapters/claude/commands/*.md` into every Claude profile's commands directory."""
    changed = False
    for name in ADAPTER_COMMANDS:
        if _install_command_source(home, name, plugin_root, ork_cli, dry_run):
            changed = True
    return changed


def install_adapter_skills(
    home: Path, *, plugin_root: Path | None = None, ork_cli: Path | None = None, dry_run: bool = False
) -> bool:
    """Copy each `adapters/skills/<name>/SKILL.md` to ~/.agents/skills and link it into the other harnesses.

    Claude Code loads these as commands, so its skill directories only lose stale duplicates.
    """
    changed = False
    for name in ADAPTER_SKILLS:
        if _install_skill_source(home, name, plugin_root, ork_cli, dry_run):
            changed = True
    return changed


_ALIAS_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
_RESERVED_WRAPPER_NAMES = frozenset(
    {
        "codex",
        "claude",
        "agy",
        "gemini",
        "opencode",
        "ork",
        "ocodex",
        "oclaude",
        "oagy",
        "oopencode",
        "_orkest_interactive",
        "_claude_mode_flag",
        "if",
        "then",
        "else",
        "elif",
        "fi",
        "case",
        "esac",
        "for",
        "select",
        "while",
        "until",
        "do",
        "done",
        "in",
        "function",
        "time",
        "coproc",
        "foreach",
        "repeat",
        "nocorrect",  # cspell:ignore nocorrect
        "noglob",
        "exec",
        "eval",
        "export",
        "unset",
        "set",
        "local",
        "declare",
        "typeset",
        "readonly",
        "return",
        "exit",
        "break",
        "continue",
        "shift",
        "source",
        "alias",
        "unalias",
        "command",
        "builtin",
        "type",
        "which",
        "whence",
        "cd",
        "pwd",
        "echo",
        "printf",
        "read",
        "test",
        "true",
        "false",
        "trap",
        "wait",
        "kill",
        "jobs",
        "fg",
        "bg",
        "umask",
        "ulimit",
        "env",
        "sh",
        "bash",
        "zsh",
        "dash",
        "fish",
        "sudo",
        "git",
        "python",
        "python3",
        "node",
        "npm",
        "ls",
        "cat",
        "rm",
        "mv",
        "cp",
        "mkdir",
        "chmod",
        "chown",
        "grep",
        "rg",
        "sed",
        "awk",
        "find",
        "xargs",
        # Shell lifecycle hooks & special dispatch functions (bash/zsh).
        "precmd",  # cspell:ignore precmd
        "preexec",  # cspell:ignore preexec
        "chpwd",  # cspell:ignore chpwd
        "periodic",
        "zshexit",  # cspell:ignore zshexit
        "zshaddhistory",  # cspell:ignore zshaddhistory
        "zsh_directory_name",
        "PROMPT_COMMAND",
        "command_not_found_handle",
        "command_not_found_handler",
    }
)
_PROVIDER_TO_WRAPPER_ENGINE = {
    "claude": "claude",
    "codex": "codex",
    "antigravity": "agy",
    "agy": "agy",
    "gemini": "agy",
    "opencode": "opencode",
}


def _load_monitor_config_for_wrappers(home: Path | None = None) -> dict[str, Any]:
    raw_override = os.environ.get("MONITOR_CONFIG")
    cfg_path = (
        Path(raw_override).expanduser()
        if isinstance(raw_override, str) and raw_override.strip()
        else (home or Path.home()) / ".config" / "monitor" / "config.json"
    )
    try:
        loaded = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _custom_wrapper_aliases(
    home: Path | None = None,
    *,
    monitor_config: dict[str, Any] | None = None,
) -> list[tuple[str, str]]:
    config = monitor_config if isinstance(monitor_config, dict) else _load_monitor_config_for_wrappers(home)
    accounts = config.get("accounts")
    if not isinstance(accounts, list):
        return []
    aliases: list[tuple[str, str]] = []
    seen: set[str] = set()
    for account in accounts:
        if not isinstance(account, dict):
            continue
        provider = _PROVIDER_TO_WRAPPER_ENGINE.get(str(account.get("provider") or "").strip().lower())
        if not provider:
            continue
        candidates: list[str] = []
        raw_alias = account.get("alias")
        if isinstance(raw_alias, str) and raw_alias.strip():
            candidates.append(raw_alias.strip())
        raw_route = account.get("route")
        if isinstance(raw_route, str):
            stripped_route = raw_route.strip()
            if stripped_route and not any(ch.isspace() for ch in stripped_route) and "=" not in stripped_route:
                candidates.append(stripped_route)
        for name in candidates:
            lowered = name.lower()
            if (
                name in seen
                or name in _RESERVED_WRAPPER_NAMES
                or name.startswith("_")
                or lowered.startswith("trap")
                or lowered.endswith("_functions")
                or not _ALIAS_NAME_RE.fullmatch(name)
            ):
                continue
            seen.add(name)
            aliases.append((name, provider))
    return aliases


def _render_custom_alias_wrapper(alias: str, engine: str) -> str:
    if engine == "claude":
        return f"""{alias}() {{
  case "${{1:-}}" in
    agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|purge|remote-control|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade|-h|--help|-v|--version) _orkest_direct {alias} "$@"; return ;;
  esac
  if _orkest_interactive {alias} "$@"; then
    local -a reply _orkest_cmd; _orkest_base {alias}; _claude_mode_flag "${{_orkest_cmd[@]}}" "$@"
    command ork label -- "${{_orkest_cmd[@]}}" "${{reply[@]}}" "$@"
  else
    _orkest_direct {alias} "$@"
  fi
}}"""
    if engine == "codex":
        return f"""{alias}() {{
  case "${{1:-}}" in
    exec|e|review|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|queue|archive|delete|migrate-rollouts|migrate-nfs-db|unarchive|cloud|exec-server|features|help) _orkest_direct {alias} "$@"; return ;;
  esac
  if _orkest_interactive {alias} "$@"; then
    local -a _orkest_cmd; _orkest_base {alias}
    command ork label -- "${{_orkest_cmd[@]}}" "$@"
  else
    _orkest_direct {alias} "$@"
  fi
}}"""
    if engine == "agy":
        return f"""{alias}() {{
  case "${{1:-}}" in
    agent|agents|changelog|help|install|mcp|mic-serve|models|plugin|plugins|remote-control|update|-h|--help|-v|--version) _orkest_direct {alias} "$@"; return ;;
  esac
  local -a _orkest_cmd; _orkest_base {alias}
  if _orkest_interactive {alias} "$@"; then
    command ork label -- "${{_orkest_cmd[@]}}" --dangerously-skip-permissions "$@"
  else
    command "${{_orkest_cmd[@]}}" --dangerously-skip-permissions "$@"
  fi
}}"""
    return f"""{alias}() {{
  if _orkest_interactive {alias} "$@"; then
    local -a _orkest_cmd; _orkest_base {alias}
    command ork label -- "${{_orkest_cmd[@]}}" "$@"
  else
    _orkest_direct {alias} "$@"
  fi
}}"""


LEGACY_FOOTERS = {
    "ocodex": "ork label -- codex",
    "oclaude": "ork label -- claude",
    "oagy": "ork label -- agy --dangerously-skip-permissions",
    "oopencode": "ork label -- opencode",
}


def shell_wrapper_script(home: Path | None = None, *, monitor_config: dict[str, Any] | None = None) -> str:
    custom_aliases = _custom_wrapper_aliases(home=home, monitor_config=monitor_config)
    unalias_targets = " ".join(["codex", "claude", "agy", *(alias for alias, _ in custom_aliases)])
    custom_blocks = "\n".join(_render_custom_alias_wrapper(alias, engine) for alias, engine in custom_aliases)
    custom_section = f"\n{custom_blocks}" if custom_blocks else ""
    return f"""# Generated by Orkest setup. Sourced from ~/.zshrc.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

# Interactive harnesses get an Orkest footer; automation and management commands stay direct.
# A function cannot replace an alias of the same name, so the user's own alias is set aside here,
# not discarded: _orkest_base puts its expansion (flags and all) back in front of every launch.
typeset -gA _orkest_user_alias
for _orkest_name in {unalias_targets}; do
  (( ${{+aliases[$_orkest_name]}} )) && _orkest_user_alias[$_orkest_name]=${{aliases[$_orkest_name]}}
done
unset _orkest_name
unalias {unalias_targets} 2>/dev/null
# Complex aliases are restored as native aliases below. Only simple literal argv reach this helper.
_orkest_base() {{
  _orkest_cmd=($1)
  local text=${{_orkest_user_alias[$1]:-}}
  [[ -n $text ]] || return 0
  local -a words=( ${{(Q)${{(z)text}}}} )
  (( ${{#words}} )) || return 0
  local word
  for word in $words; do
    case $word in
      ';'|'&'|'|'|'&&'|'||'|'<'*|'>'*|'('*|')'*|*'`'*|*'$('*) return 0 ;;
    esac
  done
  [[ $words[1] == *=* ]] && words=(env $words)
  _orkest_cmd=($words)
}}
_orkest_direct() {{
  local -a _orkest_cmd; _orkest_base $1; shift
  command "${{_orkest_cmd[@]}}" "$@"
}}
_orkest_interactive() {{
  [[ -t 0 && -t 1 && -z ${{ORKEST_TERMINAL_SERVER:-}} ]] || return 1
  command -v ork >/dev/null 2>&1 || return 1
  local harness="${{1:-}}"
  shift 2>/dev/null || true
  local arg
  for arg in "$@"; do
    case "$arg" in
      --print|--print=*|--help|-h|--version|-v) return 1 ;;
      -p) [[ $harness == codex ]] || return 1 ;;
    esac
  done
  return 0
}}
codex() {{
  case "${{1:-}}" in
    exec|e|review|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|queue|archive|delete|migrate-rollouts|migrate-nfs-db|unarchive|cloud|exec-server|features|help) _orkest_direct codex "$@"; return ;;
  esac
  if _orkest_interactive codex "$@"; then
    local -a _orkest_cmd; _orkest_base codex
    command ork label -- "${{_orkest_cmd[@]}}" "$@"
  else
    _orkest_direct codex "$@"
  fi
}}
# Interactive Claude sessions start in auto mode unless the caller already chose a mode.
_claude_mode_flag() {{
  reply=(--permission-mode auto)
  local arg
  for arg in "$@"; do
    case "$arg" in
      --permission-mode|--permission-mode=*|--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--harness-arg=--permission-mode*|--harness-arg=--dangerously-skip-permissions|--harness-arg=--allow-dangerously-skip-permissions) reply=(); return ;;
    esac
  done
}}
claude() {{
  case "${{1:-}}" in
    agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|purge|remote-control|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade|-h|--help|-v|--version) _orkest_direct claude "$@"; return ;;
  esac
  if _orkest_interactive claude "$@"; then
    local -a reply _orkest_cmd; _orkest_base claude; _claude_mode_flag "${{_orkest_cmd[@]}}" "$@"
    command ork label -- "${{_orkest_cmd[@]}}" "${{reply[@]}}" "$@"
  else
    _orkest_direct claude "$@"
  fi
}}
agy() {{
  case "${{1:-}}" in
    agent|agents|changelog|help|install|mcp|mic-serve|models|plugin|plugins|remote-control|update|-h|--help|-v|--version) _orkest_direct agy "$@"; return ;;
  esac
  local -a _orkest_cmd; _orkest_base agy
  if _orkest_interactive agy "$@"; then
    command ork label -- "${{_orkest_cmd[@]}}" --dangerously-skip-permissions "$@"
  else
    command "${{_orkest_cmd[@]}}" --dangerously-skip-permissions "$@"
  fi
}}{custom_section}
ork() {{
  case "${{1:-}}" in
    agy)
      shift
      command ork agy --dangerously-skip-permissions "$@"
      ;;
    claude)
      shift
      local -a reply; _claude_mode_flag "$@"
      local -a harness_args=()
      local flag
      for flag in "${{reply[@]}}"; do harness_args+=("--harness-arg=$flag"); done
      command ork claude "${{harness_args[@]}}" "$@"
      ;;
    *)
      command ork "$@"
      ;;
  esac
}}

# Restore aliases that need the shell's own expansion and parsing.
_orkest_alias_uses_executable() {{
  local name=$1 text=${{_orkest_user_alias[$1]}}
  local literal='^[a-zA-Z0-9_./=:+@ -]+$' assignment='^[a-zA-Z_][a-zA-Z0-9_]*='
  [[ $text =~ $literal ]] || return 1
  local -a words=( ${{(z)text}} )
  local target
  for target in $words; do
    [[ $target =~ $assignment ]] && continue
    [[ $target == $name && -n ${{commands[$target]:-}} ]] && return 0
    [[ $target == */* && -x $target ]] && return 0
    [[ $(whence -w -- "$target") == "$target: command" ]]
    return
  done
  return 1
}}
for _orkest_name in {unalias_targets}; do
  if (( ${{+_orkest_user_alias[$_orkest_name]}} )) && ! _orkest_alias_uses_executable "$_orkest_name"; then
    unset -f "$_orkest_name" 2>/dev/null
    aliases[$_orkest_name]=${{_orkest_user_alias[$_orkest_name]}}
  fi
done
unset _orkest_name
# Preserve personal shortcuts and upgrade only known stock definitions.
typeset -gA _orkest_stock_footer
_orkest_footer() {{
  local engine=$1
  shift
  local -a _orkest_cmd
  _orkest_base "$engine"
  if [[ $engine == agy ]] && (( ! ${{_orkest_cmd[(Ie)--dangerously-skip-permissions]}} && ! ${{@[(Ie)--dangerously-skip-permissions]}} )); then
    _orkest_cmd+=(--dangerously-skip-permissions)
  fi
  command ork label -- "${{_orkest_cmd[@]}}" "$@"
}}
_orkest_set_footer() {{
  local shortcut=$1 engine=$2 legacy=$3
  local current=${{aliases[$shortcut]-}}
  if (( ${{+aliases[$shortcut]}} )) && [[ $current != "$legacy" ]] && {{ (( ! ${{+_orkest_stock_footer[$shortcut]}} )) || [[ $current != "${{_orkest_stock_footer[$shortcut]}}" ]]; }}; then
    return
  fi
  if (( ${{+functions[$shortcut]}} )); then
    unset "aliases[$shortcut]"
    return
  fi
  local body="_orkest_footer $engine"
  if (( ${{+_orkest_user_alias[$engine]}} )) && ! _orkest_alias_uses_executable "$engine"; then
    body=$engine
  elif [[ $engine == opencode ]] && (( ${{+functions[opencode]}} )); then
    body=$engine
  fi
  aliases[$shortcut]=$body
  _orkest_stock_footer[$shortcut]=$body
}}
if (( ${{+aliases[opencode]}} )); then
  _orkest_user_alias[opencode]=${{aliases[opencode]}}
else
  unset '_orkest_user_alias[opencode]'
fi
{chr(10).join(f"_orkest_set_footer {name} {name[1:]} '{body}'" for name, body in LEGACY_FOOTERS.items())}
unset -f _orkest_set_footer _orkest_alias_uses_executable
"""


def sync_installed_runtimes(home: Path, ork_cli: Path | None = None, *, dry_run: bool = False) -> bool:
    """Refresh an existing ~/.local/share/monitor copy from this checkout.

    The monitor installer does the work (`--runtime-only`): it stages a complete runtime, checks it, keeps the
    previous copy under ~/.local/share/monitor-backups and rewrites the launcher.
    """
    ork_cli = ork_cli or _default_ork_cli()
    checkout = _checkout_of(ork_cli.resolve())
    installer = checkout / "plugins/monitor/install.sh"
    monitor_runtime = home / ".local/share/monitor"
    if not installer.is_file() or not monitor_runtime.is_dir():
        return False
    if dry_run:
        print(f"would sync monitor runtime: {monitor_runtime}")
        return True
    try:
        result = subprocess.run(
            ["sh", str(installer), "--runtime-only"],
            env={**os.environ, "HOME": str(home)},
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        print(f"• monitor runtime not synced ({error}); the installed copy was left as it was")
        return False
    if result.returncode:
        print(f"• monitor runtime not synced: {(result.stderr or result.stdout).strip()}")
        return False
    print(f"✓ monitor runtime synced: {monitor_runtime}")
    return True


def _validate_fast_bin(fast_bin: Path | str) -> Path:
    resolved = Path(fast_bin).expanduser().resolve()
    if not resolved.is_file() or not os.access(resolved, os.X_OK) or not resolved.name.startswith("ork-fast"):
        raise ValueError(f"invalid --fast-bin {fast_bin!s}: expected an existing executable ork-fast file")
    return resolved


SHELL_OWNER_HEADER = "# Generated by Orkest setup."


def canonical_shell_file(home: Path) -> Path:
    return home / ".config/orkest/shell.zsh"


def _owned_shell_file(path: Path) -> bool:
    if path.is_symlink():
        return False
    if not path.exists():
        return True
    try:
        return path.is_file() and path.read_text(encoding="utf-8").startswith(SHELL_OWNER_HEADER)
    except (OSError, UnicodeDecodeError):
        return False


def _shell_shim_text(canonical: Path) -> str:
    quoted = shlex.quote(str(canonical))
    return f"{SHELL_OWNER_HEADER} Sourced from ~/.zshrc.\n# Delegates to the canonical shell setup.\n[ -r {quoted} ] && . {quoted}\n"


def sync_shell_artifacts(home: Path, *, monitor_config: dict[str, Any] | None = None, dry_run: bool = False) -> str:
    """Write only the shell wrapper artifacts: shell.zsh, the orkest.sh shim and one .zshrc inclusion.

    Returns "current", "changed" or "would-change". A foreign file at either path is never overwritten.
    """
    canonical = canonical_shell_file(home)
    shim = resolve_config_home(home) / "orkest.sh"
    for target in (canonical, shim):
        if not _owned_shell_file(target):
            raise ValueError(f"refusing to overwrite a file Orkest does not own: {target}")
    status = "current"
    script_text = shell_wrapper_script(home=home, monitor_config=monitor_config)
    wanted = {
        canonical: script_text,
        shim: _shell_shim_text(canonical),
    }
    for target, text in wanted.items():
        if target.is_file() and target.read_text(encoding="utf-8") == text:
            print(f"• shell wrappers already installed: {target}")
            continue
        status = "would-change" if dry_run else "changed"
        if dry_run:
            print(f"would install shell wrappers: {target}")
            continue
        if target.exists():
            backup(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        configuration.write_private(target, text)
        print(f"✓ shell wrappers: {target}")

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
    legacy_block = legacy_pattern.search(existing)
    # A legacy block is only ours to replace while every line in it is a line Orkest generates. Anything
    # else between its markers is the user's (an alias, a function body, an edited argument): the block
    # keeps its user lines and the managed block is added after it.
    generated = {line.strip() for line in script_text.splitlines()}
    legacy_aliases = {name: f"alias {name}='{body}'" for name, body in LEGACY_FOOTERS.items()}
    generated.update(legacy_aliases.values())
    foreign = (
        [line for line in legacy_block.group(0).splitlines() if line.strip() and line.strip() not in generated]
        if legacy_block
        else []
    )
    prefix = "\n" if existing and not existing.endswith("\n") else ""
    updated = existing
    if legacy_block and foreign:
        # Guard historical assignments in retained blocks, including previously migrated profiles.
        block = legacy_block.group(0)
        unalias_line = next(line for line in script_text.splitlines() if line.startswith("unalias "))
        if unalias_line in block.splitlines() and "typeset -gA _orkest_user_alias" not in block.splitlines():
            start = script_text.index("typeset -gA _orkest_user_alias")
            capture = script_text[start : script_text.index(unalias_line, start)]
            block = re.sub(
                rf"^{re.escape(unalias_line)}$", lambda _: capture + unalias_line, block, count=1, flags=re.M
            )
        for name, assignment in legacy_aliases.items():
            guard = f"(( ${{+aliases[{name}]}} || ${{+functions[{name}]}} )) || {assignment}"
            block = re.sub(rf"^{re.escape(assignment)}$", guard, block, flags=re.M)
        updated = existing[: legacy_block.start()] + block + existing[legacy_block.end() :]
        print(f"• preserved user lines in the edited legacy Orkest block in {zshrc}")
    if not managed_pattern.search(updated):
        if legacy_block and not foreign:
            updated = legacy_pattern.sub(MANAGED_ZSHRC_BLOCK, updated, count=1)
        else:
            updated += prefix + MANAGED_ZSHRC_BLOCK
    if updated != existing:
        if dry_run:
            print(f"would configure shell wrappers in: {zshrc}")
            status = "would-change"
        else:
            if zshrc.exists():
                backup(zshrc)
            zshrc.write_text(updated, encoding="utf-8")
            print(f"✓ shell wrapper source block: {zshrc}")
            status = "changed"
    return status


def install_shell_wrappers(
    home: Path, ork_cli: Path | None = None, *, fast_bin: Path | str | None = None, dry_run: bool = False
) -> bool:
    """Write ~/.config/orchestrate/orkest.sh (with legacy fallback), link ~/.local/bin/ork, and wire ~/.zshrc."""
    if fast_bin is not None:
        fast_bin = _validate_fast_bin(fast_bin)
    changed = False
    ork_cli = ork_cli or _default_ork_cli()
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

    if sync_shell_artifacts(home, dry_run=dry_run) != "current":
        changed = True

    if remove_legacy_skill_links(home, dry_run=dry_run):
        changed = True
    if install_orchestrate_skill_links(home, dry_run=dry_run):
        changed = True
    if install_adapter_commands(home, ork_cli=ork_cli, dry_run=dry_run):
        changed = True
    if install_adapter_skills(home, ork_cli=ork_cli, dry_run=dry_run):
        changed = True
    if install_herdr_skill(home, ork_cli=ork_cli, dry_run=dry_run):
        changed = True
    if install_agy_statusline(
        home / ".gemini/antigravity-cli/settings.json", fast_bin=fast_bin, home=home, dry_run=dry_run
    ):
        changed = True
    if install_herdr_integration(home, ork_cli=ork_cli, dry_run=dry_run):
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


def _is_direct_hook_command(cmd: object, exact: str, required_fragment: str) -> bool:
    if not isinstance(cmd, str):
        return False
    if cmd == exact:
        return True
    if "peer_mailbox.py" in cmd or "--fallback-script" in cmd or cmd.startswith("[ -x "):
        return False
    return "ork-fast" in cmd and "mailbox-hook" in cmd and required_fragment in cmd


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
            fast_bin = runtime_paths.ork_fast_bin(home=home)
            try:
                group = json.loads(hooks_path.read_text()).get("peer-mailbox", {})
                for event in AGY_EVENTS:
                    command = agy_command(expected.with_name("peer_mailbox.py"), event, fast_bin=fast_bin)
                    if not any(
                        isinstance(entry, dict)
                        and _is_direct_hook_command(entry.get("command"), command, f"--event {event}")
                        for entry in group.get(event, [])
                    ):
                        issues.append(f"{event} mailbox hook missing or stale")
            except (OSError, ValueError, AttributeError):
                issues.append("mailbox turn hooks missing or unreadable")
        elif hooks_path:
            fast_bin = runtime_paths.ork_fast_bin(home=home)
            try:
                hooks = json.loads(hooks_path.read_text()).get("hooks", {})
                command = hook_command(expected.with_name("peer_mailbox.py"), harness, fast_bin=fast_bin)
                expected_events = CLAUDE_EVENTS if harness == "claude" else EVENTS
                for event in expected_events:
                    if not any(
                        _is_direct_hook_command(entry.get("command"), command, f"--harness {harness}")
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


def _resolve_fast_bin(fast_bin: Path | str | None, *, home: Path | None = None) -> Path:
    return Path(fast_bin) if fast_bin is not None else runtime_paths.ork_fast_bin(home=home)


def agy_command(script: Path | None, event: str, fast_bin: Path | str | None = None) -> str:
    resolved = _resolve_fast_bin(fast_bin)
    return shlex.join([str(resolved), "mailbox-hook", "--harness", "gemini", "--event", event])


def hook_command(script: Path | None, harness: str, fast_bin: Path | str | None = None) -> str:
    resolved = _resolve_fast_bin(fast_bin)
    return shlex.join([str(resolved), "mailbox-hook", "--harness", harness])


def statusline_command(
    script: Path | str | None,
    extra_args: list[str] | None = None,
    *,
    fast_bin: Path | str | None = None,
    home: Path | None = None,
    py_cmd_tokens: list[str] | None = None,
) -> str:
    extra = list(extra_args or ())
    resolved = _resolve_fast_bin(fast_bin, home=home)
    return shlex.join([str(resolved), "statusline", *extra])


def _strip_fallback_script(tokens: list[str]) -> list[str]:
    cleaned: list[str] = []
    idx = 0
    while idx < len(tokens):
        if tokens[idx] == "--fallback-script":
            idx += 2
            continue
        cleaned.append(tokens[idx])
        idx += 1
    return cleaned


def upgrade_statusline_command(cmd: str, *, fast_bin: Path | str | None = None, home: Path | None = None) -> str:
    resolved = _resolve_fast_bin(fast_bin, home=home)
    part = cmd
    if "&& exec " in cmd and "; exec " in cmd:
        part = cmd.split("; exec ", 1)[1]
    try:
        tokens = shlex.split(part)
    except ValueError:
        return cmd
    fast_idx = next(
        (
            idx
            for idx, tok in enumerate(tokens)
            if Path(tok).name == "ork-fast" and tokens[idx + 1 : idx + 2] == ["statusline"]
        ),
        None,
    )
    if fast_idx is not None:
        return statusline_command(None, _strip_fallback_script(tokens[fast_idx + 2 :]), fast_bin=resolved, home=home)
    script_idx = next(
        (idx for idx, tok in enumerate(tokens) if Path(tok).name == "agent_statusline.py"),
        None,
    )
    if script_idx is not None:
        return statusline_command(None, tokens[script_idx + 1 :], fast_bin=resolved, home=home)
    return cmd


def install_agy_statusline(
    path: Path,
    *,
    fast_bin: Path | str | None = None,
    home: Path | None = None,
    dry_run: bool = False,
) -> bool:
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
    if not isinstance(cmd, str) or ("agent_statusline.py" not in cmd and "ork-fast statusline" not in cmd):
        return False
    new_cmd = upgrade_statusline_command(cmd, fast_bin=fast_bin, home=home)
    if status_line.get("stack_with_default") is False and new_cmd == cmd:
        return False
    if dry_run:
        print(f"would update Antigravity statusLine: {path}")
        return True
    status_line["stack_with_default"] = False
    status_line["command"] = new_cmd
    backup(path)
    configuration.write_private(path, json.dumps(settings, indent=2) + "\n")
    print(f"✓ Antigravity statusLine glued to bottom (stack_with_default=false): {path}")
    return True


def install_claude_statusline(
    path: Path,
    *,
    fast_bin: Path | str | None = None,
    home: Path | None = None,
    dry_run: bool = False,
) -> bool:
    """Upgrade an existing Claude statusLine command to direct ork-fast invocation."""
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
    if not isinstance(cmd, str) or ("agent_statusline.py" not in cmd and "ork-fast statusline" not in cmd):
        return False
    new_cmd = upgrade_statusline_command(cmd, fast_bin=fast_bin, home=home)
    if new_cmd == cmd:
        return False
    if dry_run:
        print(f"would update Claude statusLine: {path}")
        return True
    status_line["command"] = new_cmd
    backup(path)
    configuration.write_private(path, json.dumps(settings, indent=2) + "\n")
    print(f"✓ Claude statusLine updated: {path}")
    return True


def install_agy_hooks(path: Path, script: Path, *, fast_bin: Path | str | None = None, dry_run: bool = False) -> bool:
    """Antigravity hooks.json: named groups of flat handler lists; other groups stay untouched."""
    settings = json.loads(path.read_text()) if path.exists() else {}
    before = json.dumps(settings, sort_keys=True)
    settings["peer-mailbox"] = {
        event: [{"type": "command", "command": agy_command(script, event, fast_bin=fast_bin), "timeout": 10}]
        for event in AGY_EVENTS
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


def install_hooks(
    path: Path, script: Path, harness: str, *, fast_bin: Path | str | None = None, dry_run: bool = False
) -> bool:
    settings = json.loads(path.read_text()) if path.exists() else {}
    before = json.dumps(settings, sort_keys=True)
    command = hook_command(script, harness, fast_bin=fast_bin)
    hooks = settings.setdefault("hooks", {})
    target_events = CLAUDE_EVENTS if harness == "claude" else EVENTS
    for event in target_events:
        groups = hooks.setdefault(event, [])
        entries = [
            hook
            for group in groups
            for hook in group.get("hooks", [])
            if "peer_mailbox.py hook" in hook.get("command", "")
            or "peer_mailbox.py' hook" in hook.get("command", "")
            or 'peer_mailbox.py" hook' in hook.get("command", "")
            or "mailbox-hook" in hook.get("command", "")
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


def mailbox_hook_updates(response: dict, script: Path, hooks_file: Path, *, fast_bin: Path | str | None = None) -> dict:
    """Only the four installer-owned commands qualify for explicit scoped trust."""
    resolved = _resolve_fast_bin(fast_bin)
    expected_cmd = hook_command(script, "codex", fast_bin=resolved)
    events = {"sessionStart", "userPromptSubmit", "stop", "sessionEnd"}
    matches = []
    for entry in response.get("data", []):
        for hook in entry.get("hooks", []):
            cmd = hook.get("command", "")
            tokens = shlex.split(cmd) if isinstance(cmd, str) and not cmd.startswith("[ -x ") else []
            is_match = cmd == expected_cmd or (
                len(tokens) == 4
                and Path(tokens[0]).name == "ork-fast"
                and tokens[1:4] == ["mailbox-hook", "--harness", "codex"]
            )

            if (
                hook.get("handlerType") == "command"
                and Path(hook.get("sourcePath", "")).resolve() == hooks_file.resolve()
                and is_match
                and hook.get("eventName") in events
            ):
                matches.append(hook)
    if len(matches) != 4 or {hook["eventName"] for hook in matches} != events:
        raise ValueError("Expected exactly four mailbox hooks; refusing to trust other hook definitions")
    return {hook["key"]: {"trusted_hash": hook["currentHash"]} for hook in matches}


def trust_codex(script: Path, codex: Path, *, fast_bin: Path | str | None = None, dry_run: bool = False) -> None:
    if dry_run:
        print("would trust only the four installer-owned Codex mailbox hooks")
        return
    with RpcClient(["codex", "app-server", "--stdio"]) as client:
        initialize_codex(client)
        response = client.request("hooks/list", {"cwds": [str(Path.home())]})
        updates = mailbox_hook_updates(response, script, codex / "hooks.json", fast_bin=fast_bin)
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


def permit_codex_tools(config: Path, *, dry_run: bool = False, codex_home: Path | None = None) -> None:
    server = tomllib.loads(config.read_text()).get("mcp_servers", {}).get("peer-mailbox", {})
    edits = codex_tool_edits(server)
    if not edits:
        return
    if dry_run:
        print(f"would permit only the {len(TOOLS)} local Codex mailbox tools")
        return
    backup(config)
    env = {**os.environ, "CODEX_HOME": str(codex_home)} if codex_home is not None else None
    with RpcClient(["codex", "app-server", "--stdio"], env=env) as client:
        initialize_codex(client)
        client.request("config/batchWrite", {"edits": edits, "reloadUserConfig": True})
    print(f"✓ scoped permission for {len(TOOLS)} local Codex mailbox tools")


CODEX_RULES_HEADER = """\
# Managed by Orkest's installer and rewritten on every install; edits here are lost.
# Allows only Orkest's own bookkeeping commands (progress, mailbox, room status, waits). Mailbox
# send/ask match the peer-mailbox MCP tools setup already approves. Launching workers, changing
# rooms, policy or config, updating and installing still ask. Put your own rules in default.rules.
"""
MAILBOX_COMMANDS = [
    "peers",
    "send",
    "ask",
    "inbox",
    "receive",
    "wait",
    "ack",
    "history",
    "focus",
    "board",
    "tasks",
    "channels",
    "name",
]
ORK_ROOM_COMMANDS = ["list", "show", "resume-status"]
ORK_COMMANDS = [
    ["progress"],
    ["name"],
    ["herdr-status"],
    ["quota"],
    ["radar"],
    ["routes"],
]


def _path_variants(paths: list[Path]) -> list[str]:
    """Each path as given and fully resolved, since agents quote either (e.g. /home vs /var/home)."""
    variants: list[str] = []
    for path in paths:
        for candidate in (path, path.resolve()):
            text = str(candidate)
            if text not in variants:
                variants.append(text)
    return variants


def codex_rules(home: Path, hub: Path, ork_cli: Path | None = None) -> str:
    """Codex execpolicy rules allowing Orkest's bookkeeping commands at their absolute install paths.

    Relative paths are left out on purpose: a rule for plugins/orchestrate/... would also allow a
    same-named script in any other checkout.
    """
    source = Path(__file__).resolve().parent
    script_dirs = [hub, source, home / ".codex/skills/orchestrate/scripts"]

    def script(name: str) -> list[str]:
        return _path_variants([directory / name for directory in script_dirs])

    cli = ork_cli or _default_ork_cli()
    nodes = ["node", *_path_variants([Path(found) for found in [shutil.which("node")] if found])]
    ork_commands = ["ork", *_path_variants([Path(found) for found in [shutil.which("ork")] if found])]
    pythons = [
        "python3",
        "python",
        *_path_variants(
            [Path(found) for found in [sys.executable, shutil.which("python3"), shutil.which("python")] if found]
        ),
    ]
    patterns: list[list] = [
        [pythons, script("agent_progress.py")],
        [pythons, script("run_agent.py"), "mailbox", MAILBOX_COMMANDS],
        # `events` alone also takes --ack/--ack-all; only waiting is bookkeeping.
        [pythons, script("run_agent.py"), "events", "wait"],
        [pythons, script("run_agent.py"), "models"],
        [pythons, script("peer_mailbox.py"), MAILBOX_COMMANDS],
    ]
    for prefix in ([ork_commands], [nodes, _path_variants([cli])]):
        patterns.append([*prefix, ["rooms", "hall"], ORK_ROOM_COMMANDS])
        patterns.extend([*prefix, *command] for command in ORK_COMMANDS)
    lines = [CODEX_RULES_HEADER]
    for pattern in patterns:
        tokens = ", ".join(json.dumps(part, ensure_ascii=False) for part in pattern)
        lines.append(f'prefix_rule(pattern=[{tokens}], decision="allow", justification="Orkest bookkeeping")')
    return "\n".join(lines) + "\n"


def install_codex_rules(codex: Path, home: Path, hub: Path, *, dry_run: bool = False) -> bool:
    """Write Orkest's own rules file; Codex loads every rules file under ~/.codex/rules/."""
    target = codex / "rules/orkest.rules"
    content = codex_rules(home, hub)
    if target.is_file() and target.read_text() == content:
        return False
    if dry_run:
        print(f"would write Codex rules for Orkest bookkeeping commands: {target}")
        return True
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    print(f"✓ Codex allows Orkest bookkeeping commands: {target}")
    return True


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


def target_triple() -> str | None:
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Darwin":
        if machine in ("arm64", "aarch64"):
            return "aarch64-apple-darwin"
        if machine in ("x86_64", "amd64"):
            return "x86_64-apple-darwin"
    elif system == "Linux":
        if machine in ("x86_64", "amd64"):
            return "x86_64-unknown-linux-gnu"
        if machine in ("aarch64", "arm64"):
            return "aarch64-unknown-linux-gnu"
    return None


def product_root() -> Path | None:
    """The checkout root: the nearest parent holding the product's package.json."""
    for parent in Path(__file__).resolve().parents:
        manifest = parent / "package.json"
        if manifest.is_file():
            try:
                if json.loads(manifest.read_text(encoding="utf-8")).get("name") == "orkest":
                    return parent
            except (OSError, ValueError):
                pass
    return None


def product_version() -> str:
    """The Orkest release this checkout is: `version` in the root package.json."""
    root = product_root()
    if root:
        try:
            return str(json.loads((root / "package.json").read_text(encoding="utf-8")).get("version") or "0.0.0")
        except (OSError, ValueError):
            pass
    return "0.0.0"


def ork_fast_release_bases(version: str, override: str | None = None) -> list[str]:
    """Where `ork-fast` for `version` is published: the product tag, then the pre-merge orchestrate tag."""
    if override:
        return [override]
    root = "https://github.com/loftshed/orkest/releases/download"
    return [f"{root}/v{version}", f"{root}/orchestrate--v{version}"]


def _download_ork_fast(base: str, target: str, version: str, dest: Path, meta_path: Path) -> bool:
    """Fetch, verify and install one release's binary; False when it is absent or does not verify."""
    import urllib.error
    import urllib.request

    try:
        sums_url = f"{base}/SHA256SUMS"
        req = urllib.request.Request(sums_url, headers={"User-Agent": "orkest-installer"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            sums_text = resp.read().decode("utf-8")
        expected_sha = None
        binary_filename = f"ork-fast-{target}"
        for line in sums_text.splitlines():
            parts = line.strip().split()
            if len(parts) >= 2 and parts[1].lstrip("*") == binary_filename:
                expected_sha = parts[0]
                break
        if expected_sha:
            bin_url = f"{base}/{binary_filename}"
            req_bin = urllib.request.Request(bin_url, headers={"User-Agent": "orkest-installer"})
            with urllib.request.urlopen(req_bin, timeout=30) as resp:
                bin_bytes = resp.read()
            computed_sha = hashlib.sha256(bin_bytes).hexdigest()
            if computed_sha.lower() != expected_sha.lower():
                raise ValueError(
                    f"SHA-256 digest mismatch for {binary_filename}: expected {expected_sha}, got {computed_sha}"
                )
            _install_binary(bin_bytes, dest)
            meta = {
                "version": version,
                "target": target,
                "sha256": computed_sha,
                "installed_at": time.time(),
            }
            meta_path.write_text(json.dumps(meta, indent=2))
            print(f"✓ ork-fast accelerator installed: {dest}")
            return True
    except (urllib.error.URLError, OSError, TimeoutError, UnicodeDecodeError):
        pass
    return False


def _codesign_macos(path: Path) -> None:
    if platform.system() == "Darwin" and shutil.which("codesign"):
        with contextlib.suppress(subprocess.SubprocessError, OSError):
            subprocess.run(
                ["codesign", "--force", "--sign", "-", str(path)],
                check=True,
                capture_output=True,
            )


def _install_binary(source_bytes: bytes, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp_path = dest.with_name(f".{dest.name}.tmp.{os.getpid()}.{time.time_ns()}")
    try:
        temp_path.write_bytes(source_bytes)
        temp_path.chmod(0o755)
        _codesign_macos(temp_path)
        os.replace(temp_path, dest)
    finally:
        if temp_path.exists():
            with contextlib.suppress(OSError):
                temp_path.unlink()


def _build_local_ork_fast(crate_dir: Path, dest: Path) -> bool:
    cargo = shutil.which("cargo")
    if not cargo:
        return False
    manifest = crate_dir / "Cargo.toml"
    if not manifest.is_file():
        return False
    try:
        res = subprocess.run(
            [cargo, "build", "--manifest-path", str(manifest), "--release"],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            return False
        built_bin = crate_dir / "target/release/ork-fast"
        if not built_bin.is_file():
            for parent in crate_dir.parents:
                candidate = parent / "target/release/ork-fast"
                if candidate.is_file():
                    built_bin = candidate
                    break
            else:
                return False
        _install_binary(built_bin.read_bytes(), dest)
        meta = {
            "version": product_version(),
            "source": "local-cargo",
            "installed_at": time.time(),
        }
        dest.with_name("ork-fast.meta.json").write_text(json.dumps(meta, indent=2))
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def ensure_ork_fast(
    *,
    dry_run: bool = False,
    home: Path | None = None,
    base_url: str | None = None,
    force_build: bool = False,
    env: dict | None = None,
) -> Path:
    current_env = os.environ if env is None else env
    custom_bin = current_env.get("ORK_FAST_BIN")
    if custom_bin:
        custom_path = Path(custom_bin).expanduser()
        if custom_path.is_file() and os.access(custom_path, os.X_OK):
            return custom_path

    target = target_triple()
    cache = runtime_paths.cache_home(env=current_env, home=home)
    dest = cache / "bin" / "ork-fast"

    if dry_run:
        print(f"would ensure ork-fast accelerator: {dest}")
        return dest

    crate_dir = None
    cur = Path(__file__).resolve().parent
    for _ in range(8):
        candidate = cur / "crates/ork-fast"
        if (candidate / "Cargo.toml").is_file():
            crate_dir = candidate
            break
        cur = cur.parent

    has_local_changes = False
    if crate_dir and dest.is_file():
        dest_mtime = dest.stat().st_mtime
        for p in crate_dir.rglob("*.rs"):
            if p.stat().st_mtime > dest_mtime:
                has_local_changes = True
                break
        if not has_local_changes and (crate_dir / "Cargo.toml").stat().st_mtime > dest_mtime:
            has_local_changes = True

    if (force_build or has_local_changes) and crate_dir and _build_local_ork_fast(crate_dir, dest):
        print(f"✓ ork-fast accelerator compiled from source: {dest}")
        return dest

    version = product_version()
    meta_path = dest.with_name("ork-fast.meta.json")
    if dest.is_file() and os.access(dest, os.X_OK) and meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if meta.get("version") == version and (meta.get("target") == target or meta.get("source") == "local-cargo"):
                return dest
        except (OSError, ValueError):
            pass

    override = base_url or current_env.get("ORK_FAST_RELEASE_BASE_URL")
    if target and any(
        _download_ork_fast(base, target, version, dest, meta_path) for base in ork_fast_release_bases(version, override)
    ):
        return dest

    if crate_dir and _build_local_ork_fast(crate_dir, dest):
        print(f"✓ ork-fast accelerator compiled from source: {dest}")
        return dest

    if dest.is_file() and os.access(dest, os.X_OK):
        return dest

    raise RuntimeError(f"ork-fast binary is required at {dest}; install a Rust toolchain or pass --fast-bin")


def ensure_macos_hud(
    plugin_root: Path | None = None,
    *,
    dry_run: bool = False,
    home: Path | None = None,
    env: dict | None = None,
) -> Path | None:
    """Compile OrkestHUD.app via macos/build.sh on macOS when xcrun is available."""
    if sys.platform != "darwin":
        return None
    current_env = os.environ if env is None else env
    cache = runtime_paths.cache_home(env=current_env, home=home)
    app_dir = cache / "macos" / "OrkestHUD.app"
    bin_path = app_dir / "Contents" / "MacOS" / "OrkestHUD"

    if dry_run:
        print(f"would ensure OrkestHUD.app: {app_dir}")
        return bin_path

    macos_dir = next(
        (root / "macos" for root in _candidate_plugin_roots(plugin_root) if (root / "macos" / "build.sh").is_file()),
        Path(__file__).resolve().parents[3] / "macos",
    )
    build_sh = macos_dir / "build.sh"
    hud_swift = macos_dir / "hud.swift"
    if not shutil.which("xcrun") or not build_sh.is_file() or not hud_swift.is_file():
        return bin_path if bin_path.is_file() and os.access(bin_path, os.X_OK) else None

    build_hash = hashlib.sha256(hud_swift.read_bytes() + b"\0" + build_sh.read_bytes()).hexdigest()
    info_plist = app_dir / "Contents" / "Info.plist"
    if bin_path.is_file() and os.access(bin_path, os.X_OK) and info_plist.is_file():
        with contextlib.suppress(OSError, plistlib.InvalidFileException, ValueError):
            meta = plistlib.loads(info_plist.read_bytes())
            if isinstance(meta, dict) and meta.get("OrkestHUDBuildHash") == build_hash:
                return bin_path

    completed = subprocess.run(
        ["/bin/sh", str(build_sh), str(app_dir)],
        env={**current_env, "ORKEST_HUD_BUILD_HASH": build_hash},
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if completed.returncode == 0 and bin_path.is_file() and os.access(bin_path, os.X_OK):
        print(f"✓ OrkestHUD installed: {app_dir}")
        return bin_path
    return bin_path if bin_path.is_file() and os.access(bin_path, os.X_OK) else None


def claude_profiles(home: Path) -> list[Path]:
    """~/.claude and each ~/.claude-* profile that holds Claude settings."""
    return [home / ".claude"] + sorted(
        p
        for p in home.glob(".claude-*")
        if p.is_dir() and ((p / "settings.json").is_file() or (p / ".claude.json").is_file())
    )


def opencode_config_path(home: Path, xdg_config: Path | str | None = None) -> Path:
    directory = Path(xdg_config or os.environ.get("XDG_CONFIG_HOME", str(home / ".config"))) / "opencode"
    config = directory / "opencode.jsonc"
    return config if config.exists() else directory / "opencode.json"


def approve_orkest_commands(
    home: Path,
    hub: Path,
    *,
    opt_in: bool = False,
    revoke: bool = False,
    dry_run: bool = False,
    harnesses: set[str] | None = None,
) -> bool:
    """Approve (opt-in), refresh (already opted in) or revoke Orkest's own commands per harness."""
    harnesses = (
        harnesses
        if harnesses is not None
        else {name for name in ("claude", "codex", "agy", "opencode") if shutil.which(name)}
    )
    scope = command_approval.build_scope(home, hub)
    found = command_approval.targets(
        scope,
        harnesses=harnesses,
        claude_profiles=[profile for profile in claude_profiles(home) if profile.is_dir()],
        codex_home=Path(os.environ.get("CODEX_HOME", str(home / ".codex"))).expanduser(),
        agy_settings=home / ".gemini/antigravity-cli/settings.json",
        opencode_config=opencode_config_path(home),
        home=home,
    )
    return command_approval.apply(
        scope,
        found,
        state_path=resolve_config_home(home) / command_approval.STATE_NAME,
        opt_in=opt_in,
        revoke=revoke,
        dry_run=dry_run,
    )


def migrate_legacy_paths(home: Path, *, dry_run: bool = False) -> None:
    """Issue 233 stage 0: move owned links, commands, hooks and trust rules to the new layout once it exists."""
    try:
        report = path_migration.discover(home) if dry_run else path_migration.apply(home)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"! path migration skipped: {error}")
        return
    if dry_run:
        if report["total"]:
            print(path_migration.render(report))
        return
    for conflict in report.get("conflicts", []):
        print(f"! path migration skipped one path: {conflict}")
    if report.get("applied"):
        print(f"✓ migrated {report['applied']} legacy path file(s); backup: {report['backup']}")
        print("  Codex hooks changed by the migration need review again (/hooks).")


_ACCOUNT_HARNESS = {
    "claude": "claude",
    "codex": "codex",
    "antigravity": "agy",
    "agy": "agy",
    "gemini": "agy",
    "opencode": "opencode",
}
_STORED_PROVIDER = {"claude": "claude", "codex": "codex", "agy": "antigravity", "opencode": "opencode"}
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def _expand_profile(raw: object, home: Path) -> Path | None:
    if not isinstance(raw, str) or not raw.strip() or _CONTROL_RE.search(raw):
        return None
    text = raw.strip()
    if text == "~":
        return home
    path = home / text[2:] if text.startswith("~/") else Path(text)
    return path if path.is_absolute() else None


def _profile_problem(path: Path, home: Path) -> str | None:
    """Why a configured profile root cannot be written, or None when it is acceptable."""
    resolved_home = home.resolve()
    lexical = Path(os.path.normpath(path))
    try:
        canonical = path.resolve()
    except (OSError, RuntimeError):
        return "profile path cannot be resolved"
    if canonical == resolved_home or lexical == home or canonical in resolved_home.parents:
        return "profile must not be the home directory or one of its ancestors"
    # Audit every component below the home directory: a symlink anywhere could redirect secrets.
    for base in (home, resolved_home):
        with contextlib.suppress(ValueError):
            walk = base
            for part in lexical.relative_to(base).parts:
                walk = walk / part
                if walk.is_symlink():
                    return f"profile path crosses a symlink: {walk}"
    if lexical.exists() and not lexical.is_dir():
        return "profile path is not a directory"
    with contextlib.suppress(OSError):
        if lexical.exists() and lexical.stat().st_uid != os.getuid():
            return "profile directory is not owned by the current user"
    return None


def account_profile_targets(home: Path, config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Every distinct (harness, config file) target: legacy discoveries plus configured accounts.

    Each entry carries ``ids`` (the accounts sharing it) or an ``error`` explaining why an account's
    profile is unusable. One bad account never removes the other profiles from the plan.
    """
    config = config if isinstance(config, dict) else _load_monitor_config_for_wrappers(home)
    targets: dict[tuple[str, str], dict[str, Any]] = {}
    failures: list[dict[str, Any]] = []

    def add(harness: str, root: Path, main: Path, ids: list[str], **extra: Any) -> dict[str, Any]:
        key = (harness, str(main.resolve()))
        entry = targets.get(key)
        if entry is None:
            entry = targets[key] = {"harness": harness, "home": root, "main": main, "ids": [], **extra}
        for account_id in ids:
            if account_id not in entry["ids"]:
                entry["ids"].append(account_id)
        return entry

    def agy_target(root: Path, ids: list[str]) -> dict[str, Any]:
        directory = root / ".gemini/config"
        return add(
            "agy",
            root,
            directory / "mcp_config.json",
            ids,
            hooks=directory / "hooks.json",
            statusline=root / ".gemini/antigravity-cli/settings.json",
        )

    for profile in claude_profiles(home):
        if profile.is_dir():
            default = profile.resolve() == (home / ".claude").resolve()
            add("claude", profile, (home / ".claude.json") if default else profile / ".claude.json", [])
    codex_default = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))).expanduser()
    add("codex", codex_default, codex_default / "config.toml", [])
    agy_target(home, [])
    add("opencode", home / ".config", opencode_config_path(home), [])

    def default_of(harness: str) -> dict[str, Any] | None:
        for (name, _), entry in targets.items():
            if name == harness and entry["home"] in {home / ".claude", codex_default, home, home / ".config"}:
                return entry
        return None

    for account in config.get("accounts") or []:
        if not isinstance(account, dict):
            continue
        account_id = str(account.get("id") or "").strip()
        harness = _ACCOUNT_HARNESS.get(str(account.get("provider") or "").strip().lower())
        if not account_id or not harness:
            continue
        env = account.get("env") if isinstance(account.get("env"), dict) else {}

        def fail(message: str, harness: str = harness, account_id: str = account_id) -> None:
            failures.append({"harness": harness, "ids": [account_id], "error": message})

        roots: list[Path] = []
        raws: list[object] = []
        if harness == "claude":
            raws = [account.get("configDir")]
        elif harness == "codex":
            raws = [env.get("CODEX_HOME")]
        elif harness == "agy":
            raws = [env.get("GEMINI_CLI_HOME"), env.get("ANTIGRAVITY_APP_DATA_DIR")]
        else:
            raws = [env.get("XDG_CONFIG_HOME")]
        configured = [raw for raw in raws if raw not in (None, "")]
        if not configured:
            target = default_of(harness)
            if target is not None:
                target["ids"].append(account_id)
            continue
        for raw in configured:
            expanded = _expand_profile(raw, home)
            if expanded is None:
                fail("profile path must be absolute or start with ~/")
                continue
            if harness == "opencode":
                problem = _profile_problem(expanded.parent if expanded.name == "config" else expanded, home)
            else:
                problem = _profile_problem(expanded, home)
            if problem:
                fail(problem)
                continue
            roots.append(expanded)
        for root in dict.fromkeys(roots):
            if harness == "claude":
                default = root.resolve() == (home / ".claude").resolve()
                add("claude", root, (home / ".claude.json") if default else root / ".claude.json", [account_id])
            elif harness == "codex":
                add("codex", root, root / "config.toml", [account_id])
            elif harness == "agy":
                # The Gemini home variable locates the harness config; an app-data directory counts
                # only when it already carries its own config tree, never inferred from token paths.
                gemini = _expand_profile(env.get("GEMINI_CLI_HOME"), home)
                if root == gemini or gemini is None or (root / ".gemini/config").is_dir():
                    agy_target(root, [account_id])
            else:
                add(
                    "opencode",
                    root.parent if root.name == "config" else root,
                    opencode_config_path(home, root),
                    [account_id],
                )
    return [*targets.values(), *failures]


def _plugin_enabled(settings_file: Path, harness: str) -> bool:
    try:
        if harness == "codex":
            return bool(
                re.search(
                    r'^\[plugins\."monitor@[^"\r\n]+"\]\s*\r?\n(?:[^\][\r\n]*\r?\n)*?enabled\s*=\s*true\b',
                    settings_file.read_text(),
                    re.MULTILINE,
                )
            )
        enabled = json.loads(settings_file.read_text()).get("enabledPlugins", {})
        return any(on and name.startswith("monitor@") for name, on in enabled.items())
    except (OSError, ValueError, AttributeError):
        return False


def ensure_monitor(
    name: str, config: Path, section: str, harness: str, launcher: Path | None, *, enabled: bool, dry_run: bool
) -> None:
    """Make the Monitor MCP server available once in this harness config, honoring an enabled plugin."""
    if enabled:
        print(f"• {name} monitor provided by the monitor plugin")
        return
    if launcher is None or not launcher.exists():
        print(f"• {name} monitor not registered: launcher missing")
        return
    if config.is_symlink():
        raise ValueError("MCP configuration must be a regular local file")
    text = config.read_text() if config.exists() else ("" if config.suffix == ".toml" else "{}\n")
    if harness == "codex":
        servers = tomllib.loads(text).get("mcp_servers", {})
        if "monitor" in servers:
            print(f"• {name} monitor already registered")
            return
        prefix = "" if not text or text.endswith("\n") else "\n"
        updated = f'{text}{prefix}\n[mcp_servers.monitor]\ncommand = {json.dumps(str(launcher))}\nargs = ["mcp"]\n'
        tomllib.loads(updated)
    else:
        settings = configuration.read_json(config)
        entries = settings.get(section, {})
        if harness == "opencode" and legacy_opencode_map(entries):
            entries = entries.get("servers", {})
        if isinstance(entries, dict) and "monitor" in entries:
            print(f"• {name} monitor already registered")
            return
        desired = (
            {"type": "local", "command": [str(launcher), "mcp"], "enabled": True}
            if harness == "opencode"
            else {"command": str(launcher), "args": ["mcp"], **({"type": "stdio"} if harness == "claude" else {})}
        )
        updated = configuration.set_json_path(text or "{}", [section, "monitor"], desired)
        json.loads(
            re.sub(
                r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/', lambda m: m[0] if m[0].startswith('"') else " ", updated
            ).replace(",\n}", "\n}")
        )
    if dry_run:
        print(f"would register {name} monitor")
        return
    backup(config)
    configuration.write_private(config, updated, expected=text if config.exists() else None)
    print(f"✓ {name} monitor registered")


def _delegated_run() -> bool:
    return os.environ.get("ORKEST_DELEGATED_RUN") == "1" or bool(os.environ.get("AGENT_EXECUTOR_RUN_ID"))


def _gate_opted_in(home: Path) -> bool:
    """`ork gate install` is an explicit opt-in; federation mirrors it only where it already exists."""
    import gate

    for profile in claude_profiles(home):
        try:
            hooks = json.loads((profile / "settings.json").read_text()).get("hooks", {})
        except (OSError, ValueError, AttributeError):
            continue
        groups = hooks.get("PreToolUse", []) if isinstance(hooks, dict) else []
        if any(gate.ours(entry) for group in groups if isinstance(group, dict) for entry in group.get("hooks", [])):
            return True
    return False


def install_gate_hook(path: Path, home: Path, *, fast_bin: Path | str | None = None, dry_run: bool = False) -> bool:
    """Register the heavy-run gate in a Claude profile whose owner already opted in elsewhere."""
    import gate

    if not _gate_opted_in(home):
        return False
    settings = json.loads(path.read_text()) if path.exists() else {}
    hub = home / ".agents/skills/orchestrate/scripts/gate.py"
    result = gate.updated(
        settings, "claude", hub if hub.is_file() else Path(gate.__file__).resolve(), fast_bin=fast_bin
    )
    if result == settings:
        return False
    if dry_run:
        print(f"would install the gate hook: {path}")
        return True
    backup(path)
    configuration.write_private(path, json.dumps(result, indent=2) + "\n")
    print(f"✓ gate hook: {path}")
    return True


def _target_files(target: dict[str, Any], home: Path) -> list[Path]:
    root = target["home"]
    files = [target["main"]]
    if target["harness"] == "claude":
        files.append(root / "settings.json")
    elif target["harness"] == "codex":
        files += [root / "hooks.json", root / "rules/orkest.rules"]
    elif target["harness"] == "agy":
        files += [target["hooks"], target["statusline"]]
    return files


def _snapshot(files: list[Path]) -> dict[str, bytes | None]:
    return {str(path): (path.read_bytes() if path.is_file() else None) for path in files}


def apply_profile_target(
    target: dict[str, Any],
    home: Path,
    hub: Path,
    *,
    fast_bin: Path | str | None,
    dry_run: bool,
    stdio: bool,
    daemon_url: str,
    daemon_token: str,
    trust_codex_hooks: bool = False,
    stream: Any = None,
) -> str:
    """Install the mailbox, hooks and Monitor registration into one profile. Returns its status."""
    if trust_codex_hooks and _delegated_run():
        raise ValueError("delegated agent runs cannot self-trust Codex hooks")
    harness = target["harness"]
    root: Path = target["home"]
    main: Path = target["main"]
    launcher = home / ".local/bin/monitor"
    files = _target_files(target, home)
    before = _snapshot(files)
    buffer = io.StringIO()
    shared = {"dry_run": dry_run, "stdio": stdio, "daemon_url": daemon_url, "daemon_token": daemon_token}
    with contextlib.redirect_stdout(buffer):
        if harness == "claude":
            register(f"Claude ({root.name})", main, "mcpServers", "claude", **shared)
            install_hooks(root / "settings.json", hub / "peer_mailbox.py", "claude", fast_bin=fast_bin, dry_run=dry_run)
            install_claude_statusline(root / "settings.json", fast_bin=fast_bin, home=home, dry_run=dry_run)
            install_gate_hook(root / "settings.json", home, fast_bin=fast_bin, dry_run=dry_run)
            ensure_monitor(
                f"Claude ({root.name})", main, "mcpServers", "claude", launcher,
                enabled=_plugin_enabled(root / "settings.json", "claude"), dry_run=dry_run,
            )  # fmt: skip
        elif harness == "codex":
            register("Codex", main, "mcp_servers", "codex", **shared)
            if not dry_run or main.exists() and "peer-mailbox" in main.read_text():
                set_codex_timeout(main, dry_run=dry_run)
                permit_codex_tools(main, dry_run=dry_run, codex_home=root)
            install_codex_rules(root, home, hub, dry_run=dry_run)
            install_hooks(root / "hooks.json", hub / "peer_mailbox.py", "codex", fast_bin=fast_bin, dry_run=dry_run)
            if trust_codex_hooks:
                trust_codex(hub / "peer_mailbox.py", root, fast_bin=fast_bin, dry_run=dry_run)
            ensure_monitor(
                "Codex", main, "mcp_servers", "codex", launcher,
                enabled=_plugin_enabled(main, "codex"), dry_run=dry_run,
            )  # fmt: skip
        elif harness == "agy":
            register("Antigravity", main, "mcpServers", "agy", **shared)
            install_agy_hooks(target["hooks"], hub / "peer_mailbox.py", fast_bin=fast_bin, dry_run=dry_run)
            install_agy_statusline(target["statusline"], fast_bin=fast_bin, home=home, dry_run=dry_run)
            ensure_monitor("Antigravity", main, "mcpServers", "agy", launcher, enabled=False, dry_run=dry_run)
        else:
            register("OpenCode", main, "mcp", "opencode", **shared)
            ensure_monitor("OpenCode", main, "mcp", "opencode", launcher, enabled=False, dry_run=dry_run)
    (stream or sys.stderr).write(buffer.getvalue())
    if dry_run:
        return "would-change" if any(line.startswith("would") for line in buffer.getvalue().splitlines()) else "current"
    return "changed" if _snapshot(files) != before else "current"


def sync_account_profiles(
    home: Path,
    config: dict[str, Any] | None = None,
    *,
    dry_run: bool = False,
    stdio: bool = False,
    fast_bin: Path | str | None = None,
    trust_codex_hooks: bool = False,
) -> dict[str, Any]:
    """Federate every discovered and configured harness profile onto one mailbox daemon."""
    if trust_codex_hooks and _delegated_run():
        raise ValueError("delegated agent runs cannot self-trust Codex hooks")
    hub = home / ".agents/skills/orchestrate/scripts"
    profiles: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    targets = account_profile_targets(home, config)
    daemon_url, daemon_token = "", ""
    startup_error: str | None = None
    if not stdio:
        if dry_run:
            daemon_url, daemon_token = "http://127.0.0.1:49152/mcp", "mock"
        else:
            try:
                base = mailbox.root()
                daemon_url = mailbox_daemon.ensure_running(base)["url"]
                daemon_token = mailbox_daemon.read_token(base)
            except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
                startup_error = f"mailbox daemon unavailable: {error}"
    if not dry_run and not (hub / "peer_mailbox.py").exists():
        ensure_hub(hub.parent, Path(__file__).resolve().parent.parent)
    binaries = {"claude": "claude", "codex": "codex", "agy": "agy", "opencode": "opencode"}
    for target in targets:
        harness = target["harness"]
        provider = _STORED_PROVIDER[harness]
        ids = target["ids"] or [provider]
        shown = target.get("home")
        if "error" in target:
            for account_id in target["ids"]:
                profiles.append({"provider": provider, "id": account_id, "home": None, "status": "error"})
                errors.append({"id": account_id, "operation": "profile", "message": target["error"]})
            continue
        if not shutil.which(binaries[harness]):
            status = "unavailable"
        elif startup_error:
            status = "error"
            for account_id in ids:
                errors.append({"id": account_id, "operation": "daemon", "message": startup_error})
        else:
            try:
                status = apply_profile_target(
                    target, home, hub, fast_bin=fast_bin, dry_run=dry_run, stdio=stdio,
                    daemon_url=daemon_url, daemon_token=daemon_token, trust_codex_hooks=trust_codex_hooks,
                )  # fmt: skip
            except (ValueError, OSError, RuntimeError, tomllib.TOMLDecodeError, json.JSONDecodeError) as error:
                status = "error"
                for account_id in ids:
                    errors.append({"id": account_id, "operation": "register", "message": str(error)})
        # Legacy default targets are reported only when they carry configuration worth showing.
        if not target["ids"] and status in {"unavailable", "current"}:
            continue
        for account_id in ids:
            profiles.append({"provider": provider, "id": account_id, "home": str(shown), "status": status})
    return {"profiles": profiles, "errors": errors}


def run_account_sync(*, shell_only: bool, dry_run: bool, fast_bin: Path | str | None = None) -> dict[str, Any]:
    """The narrow federation entry point: no pruning, login service, cache copy or trust changes."""
    home = Path.home()
    config = _load_monitor_config_for_wrappers(home)
    result: dict[str, Any] = {"schema": "ork.account.sync.v1", "dryRun": dry_run, "profiles": [], "errors": []}
    if not shell_only:
        if fast_bin is not None:
            fast_bin = _validate_fast_bin(fast_bin)
        result.update(sync_account_profiles(home, config, dry_run=dry_run, fast_bin=fast_bin))
    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer):
            shell = sync_shell_artifacts(home, monitor_config=config, dry_run=dry_run)
        result["shell"] = {"status": shell}
    except (ValueError, OSError) as error:
        result["shell"] = {"status": "error"}
        result["errors"].append({"id": "*", "operation": "shell", "message": str(error)})
    sys.stderr.write(buffer.getvalue())
    return result


def report_legacy_plugin(home: Path) -> list[dict]:
    """Print how to remove the retired plugin install. Never uninstalls: that is the user's call."""
    entries = legacy_plugin.discover(home)
    if entries:
        print(legacy_plugin.render(entries))
    return entries


def install(
    *,
    dry_run: bool = False,
    trust_codex_hooks: bool = False,
    trust_orkest_commands: bool = False,
    untrust_orkest_commands: bool = False,
    verify: bool = True,
    stdio: bool = False,
    fast_bin: Path | str | None = None,
) -> None:
    if trust_codex_hooks and (os.environ.get("ORKEST_DELEGATED_RUN") == "1" or os.environ.get("AGENT_EXECUTOR_RUN_ID")):
        raise ValueError("delegated agent runs cannot self-trust Codex hooks")
    if fast_bin is not None:
        fast_bin = _validate_fast_bin(fast_bin)
    home = Path.home()
    hub = home / ".agents/skills/orchestrate/scripts"
    ensure_hub(hub.parent, Path(__file__).resolve().parent.parent, dry_run=dry_run)

    if fast_bin is None:
        fast_bin = ensure_ork_fast(dry_run=dry_run, home=home)
    ensure_macos_hud(dry_run=dry_run, home=home)

    daemon_url = ""
    daemon_token = ""
    if not stdio:
        if dry_run:
            daemon_url = "http://127.0.0.1:49152/mcp"
            daemon_token = "mock"
        else:
            base = mailbox.root()
            state = mailbox_daemon.ensure_running(base)
            if state.get("runtimeRevision") != mailbox_daemon.runtime_revision() and mailbox_daemon.stop_service(
                base,
                if_idle=True,
                expected_instance=state.get("instance"),
            ):
                state = mailbox_daemon.ensure_running(base)
            daemon_url = state["url"]
            daemon_token = mailbox_daemon.read_token(base)
            mailbox_daemon.set_mode(base, "http")

    binaries = {"claude": "claude", "codex": "codex", "agy": "agy", "opencode": "opencode"}
    for target in account_profile_targets(home, _load_monitor_config_for_wrappers(home)):
        if "error" in target:
            sys.stderr.write(f"✗ account {', '.join(target['ids'])}: {target['error']}\n")
            continue
        if not shutil.which(binaries[target["harness"]]):
            continue
        apply_profile_target(
            target, home, hub, fast_bin=fast_bin, dry_run=dry_run, stdio=stdio,
            daemon_url=daemon_url, daemon_token=daemon_token, trust_codex_hooks=trust_codex_hooks,
            stream=sys.stdout,
        )  # fmt: skip
        if target["harness"] == "codex" and not trust_codex_hooks:
            config = target["main"]
            trusted_state = (
                tomllib.loads(config.read_text()).get("hooks", {}).get("state", {}) if config.exists() else {}
            )
            trusted_count = sum(
                isinstance(entry, dict) and bool(entry.get("trusted_hash")) for entry in trusted_state.values()
            )
            if trusted_count < len(EVENTS):
                print(
                    "Codex automatic delivery needs hook trust: use /hooks, or rerun with --trust-codex-hooks after reviewing."
                )

    approve_orkest_commands(home, hub, opt_in=trust_orkest_commands, revoke=untrust_orkest_commands, dry_run=dry_run)
    migrate_legacy_paths(home, dry_run=dry_run)
    report_legacy_plugin(home)
    install_shell_wrappers(home, fast_bin=fast_bin, dry_run=dry_run)
    sync_installed_runtimes(home, dry_run=dry_run)
    install_login_startup(home, mailbox.root(), hub / "mailbox_daemon.py", stdio=stdio, dry_run=dry_run)
    prune_daemon_runtimes(mailbox.root(), dry_run=dry_run)
    if not dry_run:
        mailbox_daemon.set_mode(mailbox.root(), "stdio" if stdio else "http")
    if verify and not dry_run:
        report = check(require_codex_hook_trust=trust_codex_hooks)
        print(f"✓ {len(report['round_trips'])} mailbox message/reply round trips; evidence: {report['evidence']}")
        if report.get("codex_hook_trust") == "pending_review":
            print(
                "• Codex mailbox hooks are pending review: use /hooks in Codex, "
                "or rerun with --trust-codex-hooks after reviewing them."
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--remove-herdr",
        action="store_true",
        help="remove only this installation's Herdr registration and managed shortcut",
    )
    parser.add_argument(
        "--trust-codex-hooks", action="store_true", help="explicitly trust only the four installed mailbox hooks"
    )
    approval = parser.add_mutually_exclusive_group()
    approval.add_argument(
        "--trust-orkest-commands",
        action="store_true",
        help="approve listed ork subcommands and listed Orkest coordination scripts in every installed harness, now and on "
        "later setup refreshes; generic python3/node/shell, ork gate --, ork label and other scripts still ask",
    )
    approval.add_argument(
        "--untrust-orkest-commands",
        action="store_true",
        help="remove only the command approvals --trust-orkest-commands added",
    )
    parser.add_argument("--stdio", action="store_true", help="install using local stdio rather than the daemon")
    narrow = parser.add_mutually_exclusive_group()
    narrow.add_argument(
        "--account-sync", action="store_true", help="federate configured account profiles and shell wrappers only"
    )
    narrow.add_argument("--shell-sync", action="store_true", help="refresh only the shell wrapper artifacts")
    parser.add_argument("--json", action="store_true", help="with --account-sync/--shell-sync, print one JSON result")
    parser.add_argument(
        "--fast-bin",
        type=Path,
        default=None,
        help="path to custom ork-fast accelerator binary",
    )
    args = parser.parse_args(argv)
    if (args.account_sync or args.shell_sync) and (
        args.trust_codex_hooks or args.trust_orkest_commands or args.untrust_orkest_commands or args.remove_herdr
    ):
        parser.error("--account-sync/--shell-sync never change trust and take no other action")
    if args.json and not (args.account_sync or args.shell_sync):
        parser.error("--json requires --account-sync or --shell-sync")
    try:
        if args.account_sync or args.shell_sync:
            result = run_account_sync(shell_only=args.shell_sync, dry_run=args.dry_run, fast_bin=args.fast_bin)
            if args.json:
                print(json.dumps(result))
            else:
                print(
                    f"{len(result['profiles'])} profile target(s); shell {result['shell']['status']}; "
                    f"{len(result['errors'])} error(s)"
                )
            return 1 if result["errors"] else 0
        if args.remove_herdr:
            uninstall_herdr_integration(Path.home(), dry_run=args.dry_run)
            return 0
        install(
            dry_run=args.dry_run,
            trust_codex_hooks=args.trust_codex_hooks,
            trust_orkest_commands=args.trust_orkest_commands,
            untrust_orkest_commands=args.untrust_orkest_commands,
            stdio=args.stdio,
            fast_bin=args.fast_bin,
        )
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"mailbox install: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
