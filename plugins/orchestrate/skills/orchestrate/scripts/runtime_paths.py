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
    primary = cache_root / "orchestrate"
    legacy = cache_root / "agent-executor"
    if primary.exists():
        return primary
    if legacy.exists():
        return legacy
    return primary


def config_home(env: Mapping[str, str] | None = None, home: Path | None = None) -> Path:
    """Resolve the orchestrate config directory, falling back to an existing legacy agent-executor config dir."""
    source = os.environ if env is None else env
    explicit = env_first("ORCHESTRATE_CONFIG", "AGENT_EXECUTOR_CONFIG", env=source)
    if explicit:
        return _expand(explicit, home).parent
    base_home = home if home is not None else Path.home()
    xdg = source.get("XDG_CONFIG_HOME")
    config_root = _expand(xdg, base_home) if xdg else base_home / ".config"
    primary = config_root / "orchestrate"
    legacy = config_root / "agent-executor"
    if (primary / "config.json").exists() or primary.exists():
        return primary
    if (legacy / "config.json").exists() or legacy.exists():
        return legacy
    return primary


def config_path(env: Mapping[str, str] | None = None, home: Path | None = None) -> Path:
    """Resolve the orchestrate config file, falling back to an existing legacy agent-executor config."""
    source = os.environ if env is None else env
    explicit = env_first("ORCHESTRATE_CONFIG", "AGENT_EXECUTOR_CONFIG", env=source)
    if explicit:
        return _expand(explicit, home)
    base_home = home if home is not None else Path.home()
    xdg = source.get("XDG_CONFIG_HOME")
    config_root = _expand(xdg, base_home) if xdg else base_home / ".config"
    primary = config_root / "orchestrate" / "config.json"
    legacy = config_root / "agent-executor" / "config.json"
    if primary.exists():
        return primary
    if legacy.exists():
        return legacy
    return primary


def set_home_env(env: dict[str, str] | None, path: str | Path) -> dict[str, str]:
    """Set both ORCHESTRATE_HOME and AGENT_EXECUTOR_HOME on an environment dict so all subprocesses agree."""
    resolved = str(path)
    if env is not None and isinstance(env, dict):
        env["ORCHESTRATE_HOME"] = resolved
        env["AGENT_EXECUTOR_HOME"] = resolved
        return env
    target = dict(os.environ if env is None else env)
    target["ORCHESTRATE_HOME"] = resolved
    target["AGENT_EXECUTOR_HOME"] = resolved
    return target
