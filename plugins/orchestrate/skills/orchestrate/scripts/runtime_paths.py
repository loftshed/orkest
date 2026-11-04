"""Shared runtime path and environment variable resolution for orchestrate with agent-executor fallback."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path


def env_first(*names: str, env: Mapping[str, str] | None = None) -> str | None:
    """Return the first non-empty environment variable value among names."""
    source = os.environ if env is None else env
    for name in names:
        value = source.get(name)
        if value:
            return value
    return None


def _expand(value: str, home: Path | None = None) -> Path:
    base_home = home if home is not None else Path.home()
    if value == "~":
        return base_home
    if value.startswith("~/"):
        return base_home / value[2:]
    return Path(value).expanduser()


def cache_home(env: Mapping[str, str] | None = None, home: Path | None = None) -> Path:
    """Resolve the orchestrate cache directory, falling back to an existing legacy agent-executor cache."""
    source = os.environ if env is None else env
    explicit = env_first("ORCHESTRATE_HOME", "AGENT_EXECUTOR_HOME", env=source)
    if explicit:
        return _expand(explicit, home)
    base_home = home if home is not None else Path.home()
    xdg = source.get("XDG_CACHE_HOME")
    cache_root = _expand(xdg, base_home) if xdg else base_home / ".cache"
    preferred = cache_root / "orchestrate"
    legacy = cache_root / "agent-executor"
    if not preferred.exists() and legacy.exists():
        return legacy
    return preferred


def config_path(env: Mapping[str, str] | None = None, home: Path | None = None) -> Path:
    """Resolve the orchestrate config file, falling back to an existing legacy agent-executor config."""
    source = os.environ if env is None else env
    explicit = env_first("ORCHESTRATE_CONFIG", "AGENT_EXECUTOR_CONFIG", env=source)
    if explicit:
        return _expand(explicit, home)
    base_home = home if home is not None else Path.home()
    xdg = source.get("XDG_CONFIG_HOME")
    config_root = _expand(xdg, base_home) if xdg else base_home / ".config"
    preferred = config_root / "orchestrate" / "config.json"
    legacy = config_root / "agent-executor" / "config.json"
    if not preferred.exists() and legacy.exists():
        return legacy
    return preferred
