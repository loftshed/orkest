"""Find the retired Orkest Claude Code / Codex plugin install and say how to remove it.

Orkest is no longer a plugin (issue 233 stage 1): `install.sh` links the skills, writes the
commands and registers monitor's MCP server, and everything calls `ork` on PATH. A machine that
once installed `orchestrate@orkest` or `monitor@orkest`, or registered the `orkest` marketplace,
still has that copy. It is read-only evidence here: this module never uninstalls anything, it
only reports what is left and prints the exact commands for the user to run.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path

MARKETPLACE = "orkest"
PLUGINS = ("orchestrate", "monitor")
PLUGIN_IDS = tuple(f"{name}@{MARKETPLACE}" for name in PLUGINS)

_CODEX_PLUGIN = re.compile(r'^\[plugins\."(?P<id>(?:orchestrate|monitor)@orkest)"\]', re.MULTILINE)


def _json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _claude_dirs(home: Path) -> list[Path]:
    dirs = [home / ".claude", *sorted(p for p in home.glob(".claude-*") if p.is_dir())]
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    if configured:
        extra = Path(configured).expanduser()
        if extra not in dirs:
            dirs.append(extra)
    return [d for d in dirs if d.is_dir()]


def _claude_entry(directory: Path, home: Path) -> dict | None:
    plugins: set[str] = set()
    settings = _json(directory / "settings.json")
    enabled = settings.get("enabledPlugins")
    if isinstance(enabled, dict):
        plugins.update(key for key in enabled if key in PLUGIN_IDS)
    installed = _json(directory / "plugins/installed_plugins.json").get("plugins")
    if isinstance(installed, dict):
        plugins.update(key for key in installed if key in PLUGIN_IDS)
    registered = MARKETPLACE in _json(directory / "plugins/known_marketplaces.json")
    extra = settings.get("extraKnownMarketplaces")
    registered = registered or (isinstance(extra, dict) and MARKETPLACE in extra)
    if not plugins and not registered:
        return None
    return {
        "harness": "claude",
        "profile": str(directory),
        "default_profile": directory == home / ".claude",
        "plugins": sorted(plugins),
        "marketplace": registered,
    }


def _codex_entry(home: Path) -> dict | None:
    codex = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))).expanduser()
    config = codex / "config.toml"
    try:
        text = config.read_text(encoding="utf-8")
    except OSError:
        text = ""
    plugins = sorted({m.group("id") for m in _CODEX_PLUGIN.finditer(text)})
    cached = (codex / "plugins/cache" / MARKETPLACE).is_dir()
    if not plugins and not cached:
        return None
    return {"harness": "codex", "profile": str(codex), "config": str(config), "plugins": plugins, "marketplace": cached}


def discover(home: Path | None = None) -> list[dict]:
    """Every profile that still has the retired plugin or marketplace; [] on a clean machine."""
    home = home or Path.home()
    entries = [entry for d in _claude_dirs(home) if (entry := _claude_entry(d, home))]
    codex = _codex_entry(home)
    if codex:
        entries.append(codex)
    return entries


def removal_commands(entry: dict) -> list[str]:
    """The exact commands that retire one profile's install. Nothing here runs them."""
    if entry["harness"] != "claude":
        return []
    prefix = "" if entry["default_profile"] else f"CLAUDE_CONFIG_DIR={shlex.quote(entry['profile'])} "
    commands = [f"{prefix}claude plugin uninstall {plugin_id}" for plugin_id in entry["plugins"]]
    if entry["marketplace"]:
        commands.append(f"{prefix}claude plugin marketplace remove {MARKETPLACE}")
    return commands


def render(entries: list[dict]) -> str:
    """Text for `ork update` and `ork doctor`; empty when there is nothing to remove."""
    if not entries:
        return ""
    lines = [
        "Orkest is no longer a Claude Code plugin; its skills, commands and monitor MCP server now come "
        "from install.sh. These old plugin installs are still present. Nothing was uninstalled; "
        "remove them yourself when ready:"
    ]
    for entry in entries:
        what = ", ".join(entry["plugins"]) or "the orkest marketplace"
        lines.append(f"  {entry['harness']} {entry['profile']}: {what}")
        if entry["harness"] == "claude":
            lines.extend(f"    {command}" for command in removal_commands(entry))
        else:
            lines.append(
                f'    remove the [plugins."...@{MARKETPLACE}"] tables from {entry["config"]} '
                "(or disable them in Codex's plugin list) and delete plugins/cache/orkest if present"
            )
    lines.append(
        "  Until they are removed a profile may list every Orkest command twice (`name` and `orchestrate:name`)."
    )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    home = Path(args[args.index("--home") + 1]) if "--home" in args else Path.home()
    entries = discover(home)
    if "--json" in args:
        print(json.dumps(entries, indent=2))
    elif entries or "--only-if-present" not in args:
        print(render(entries) or "no retired Orkest plugin install found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
