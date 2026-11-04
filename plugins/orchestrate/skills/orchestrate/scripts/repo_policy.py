#!/usr/bin/env python3
"""Per-repository harness and account denylist policy evaluation."""

from __future__ import annotations

import fnmatch
import json
import os
import subprocess
from pathlib import Path
from typing import Any

import runtime_paths

CANONICAL_HARNESSES = ("codex", "agy", "opencode", "claude-work", "plaude")

TOKEN_ALIASES = {
    "claude": "claude-work",
    "claude-work": "claude-work",
    "claude_work": "claude-work",
    "work-claude": "claude-work",
    "plaude": "plaude",
    "claude-personal": "plaude",
    "claude_personal": "plaude",
    "personal-claude": "plaude",
    "claude-all": "claude-all",
    "claude_all": "claude-all",
    "all-claude": "claude-all",
    "codex": "codex",
    "openai": "codex",
    "agy": "agy",
    "gemini": "agy",
    "antigravity": "agy",
    "opencode": "opencode",
    "openrouter": "opencode",
}


def normalize_deny_token(token: str) -> str:
    cleaned = str(token or "").strip().lower()
    if not cleaned:
        return ""
    return TOKEN_ALIASES.get(cleaned, cleaned)


def resolve_repo_root(cwd: Path | str | None = None) -> Path:
    base = Path(cwd or Path.cwd()).expanduser()
    try:
        base_resolved = base.resolve()
    except OSError:
        base_resolved = base
    target_dir = base_resolved if base_resolved.is_dir() else base_resolved.parent
    try:
        res = subprocess.run(
            ["git", "-C", str(target_dir), "rev-parse", "--show-toplevel"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if res.returncode == 0 and res.stdout.strip():
            return Path(res.stdout.strip()).resolve()
    except (OSError, subprocess.SubprocessError):
        pass
    return base_resolved


def resolve_git_remote(repo_root: Path) -> str:
    try:
        res = subprocess.run(
            ["git", "-C", str(repo_root), "config", "--get", "remote.origin.url"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if res.returncode == 0:
            return res.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return ""


def _load_json_dict(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _expand_home(pattern: str, home: Path | None = None) -> str:
    text = str(pattern or "").strip()
    if not text:
        return ""
    if home is not None and (text == "~" or text.startswith("~/")):
        return str(home) + text[1:]
    return os.path.expanduser(text)


def _matches_path_pattern(repo_root: Path, raw_pattern: str, *, home: Path | None = None) -> bool:
    expanded = _expand_home(raw_pattern, home=home)
    if not expanded:
        return False
    repo_str = str(repo_root)
    if expanded == repo_str:
        return True
    with_no_trailing = expanded.rstrip("/")
    if with_no_trailing == repo_str:
        return True
    try:
        resolved_pat = str(Path(expanded).resolve())
        if resolved_pat == repo_str:
            return True
    except OSError:
        pass
    if expanded.endswith("/*"):
        prefix = expanded[:-2].rstrip("/")
        if repo_str == prefix or repo_str.startswith(prefix + "/"):
            return True
    if expanded.endswith("/"):
        prefix = expanded.rstrip("/")
        if repo_str == prefix or repo_str.startswith(prefix + "/"):
            return True
    return bool(any(ch in expanded for ch in "*?[") and fnmatch.fnmatchcase(repo_str, expanded))


def _matches_remote_pattern(remote_url: str, raw_pattern: str) -> bool:
    if not remote_url:
        return False
    pat = str(raw_pattern or "").strip().lower()
    if not pat:
        return False
    rem = remote_url.strip().lower()
    if pat in rem:
        return True
    return bool(fnmatch.fnmatchcase(rem, pat) or fnmatch.fnmatchcase(rem, f"*{pat}"))


def _normalize_rules_list(raw_policies: Any, *, source: str, default_match_all: bool = False) -> list[dict[str, Any]]:
    rules: list[dict[str, Any]] = []
    if isinstance(raw_policies, dict):
        for key, value in raw_policies.items():
            if isinstance(value, list):
                rules.append({"match": str(key), "deny": list(value), "source": source})
            elif isinstance(value, dict):
                rule = {**value, "source": source}
                if not any(rule.get(k) for k in ("path", "remote", "match")):
                    rule["match"] = str(key)
                rules.append(rule)
    elif isinstance(raw_policies, list):
        for entry in raw_policies:
            if isinstance(entry, dict):
                rules.append({**entry, "source": source})
    elif default_match_all:
        pass
    return rules


def _rule_matches_repo(
    rule: dict[str, Any],
    repo_root: Path,
    remote_url: str,
    *,
    home: Path | None = None,
    default_match_all: bool = False,
) -> bool:
    path_pat = rule.get("path") or rule.get("repo")
    remote_pat = rule.get("remote")
    match_pat = rule.get("match") or rule.get("pattern")

    has_selector = bool(path_pat or remote_pat or match_pat)
    if not has_selector:
        return default_match_all

    if path_pat and not _matches_path_pattern(repo_root, str(path_pat), home=home):
        return False
    if remote_pat and not _matches_remote_pattern(remote_url, str(remote_pat)):
        return False
    if match_pat:
        pat_str = str(match_pat)
        if not (_matches_path_pattern(repo_root, pat_str, home=home) or _matches_remote_pattern(remote_url, pat_str)):
            return False
    return True


def is_personal_claude_profile(claude_config_dir: Path | str | None) -> bool:
    if claude_config_dir is None:
        return False
    raw = str(claude_config_dir).strip()
    if not raw:
        return False
    expanded = Path(raw).expanduser()
    lower_name = expanded.name.lower()
    lower_full = str(expanded).lower()
    return "personal" in lower_name or "plaude" in lower_name or "/.claude-personal" in lower_full


def resolve_repo_policy(
    cwd: Path | str | None = None,
    config: dict[str, Any] | None = None,
    *,
    home: Path | None = None,
) -> dict[str, Any]:
    repo_root = resolve_repo_root(cwd)
    remote_url = resolve_git_remote(repo_root)

    if config is None:
        cfg_fn = getattr(runtime_paths, "config_path", None)
        cfg_path = cfg_fn() if callable(cfg_fn) else (runtime_paths.config_home() / "config.json")
        config_data = _load_json_dict(cfg_path)
        config_source = str(cfg_path)
    else:
        config_data = config if isinstance(config, dict) else {}
        config_source = "config"

    candidate_rules: list[tuple[dict[str, Any], bool]] = []
    if "repo_policies" in config_data:
        for r in _normalize_rules_list(config_data.get("repo_policies"), source=config_source):
            candidate_rules.append((r, False))

    repo_policy_file = repo_root / ".orkest" / "policy.json"
    if repo_policy_file.is_file():
        repo_local = _load_json_dict(repo_policy_file)
        local_source = str(repo_policy_file)
        if isinstance(repo_local.get("deny"), list):
            candidate_rules.append(
                (
                    {
                        "path": str(repo_root),
                        "deny": list(repo_local["deny"]),
                        "source": local_source,
                    },
                    True,
                )
            )
        if "repo_policies" in repo_local:
            for r in _normalize_rules_list(
                repo_local.get("repo_policies"), source=local_source, default_match_all=True
            ):
                candidate_rules.append((r, True))

    matched_rules: list[dict[str, Any]] = []
    deny_tokens: list[str] = []
    seen_deny: set[str] = set()

    for rule, default_all in candidate_rules:
        if not _rule_matches_repo(rule, repo_root, remote_url, home=home, default_match_all=default_all):
            continue
        raw_deny = rule.get("deny")
        if not isinstance(raw_deny, list):
            continue
        normalized_rule_deny: list[str] = []
        for item in raw_deny:
            norm = normalize_deny_token(str(item))
            if not norm:
                continue
            normalized_rule_deny.append(norm)
            if norm not in seen_deny:
                seen_deny.add(norm)
                deny_tokens.append(norm)
        matched_rules.append(
            {
                "source": rule.get("source", config_source),
                **({"path": rule.get("path") or rule.get("repo")} if (rule.get("path") or rule.get("repo")) else {}),
                **({"remote": rule.get("remote")} if rule.get("remote") else {}),
                **(
                    {"match": rule.get("match") or rule.get("pattern")}
                    if (rule.get("match") or rule.get("pattern"))
                    else {}
                ),
                "deny": normalized_rule_deny,
            }
        )

    deny_set = set(deny_tokens)
    allowed_harnesses: list[str] = []
    if "codex" not in deny_set:
        allowed_harnesses.append("codex")
    if "agy" not in deny_set:
        allowed_harnesses.append("agy")
    if "opencode" not in deny_set:
        allowed_harnesses.append("opencode")
    if not ({"claude-work", "claude-all"} & deny_set):
        allowed_harnesses.append("claude-work")
    if not ({"plaude", "claude-all"} & deny_set):
        allowed_harnesses.append("plaude")

    return {
        "repo": str(repo_root),
        "remote": remote_url,
        "deny": deny_tokens,
        "allowed_harnesses": allowed_harnesses,
        "matched_rules": matched_rules,
    }


def check_execution_allowed(
    cwd: Path | str | None,
    engine: str,
    claude_config_dir: Path | str | None = None,
    config: dict[str, Any] | None = None,
) -> tuple[bool, str | None, Path | None]:
    policy = resolve_repo_policy(cwd, config=config)
    deny_set = set(policy["deny"])
    allowed_list = policy["allowed_harnesses"]
    allowed_str = ", ".join(allowed_list) if allowed_list else "none"
    eng = str(engine or "").strip().lower()

    if eng in ("agy", "gemini", "antigravity"):
        if "agy" in deny_set:
            return (
                False,
                f"Harness 'agy' is denied for repository {policy['repo']} by repo policy; allowed harnesses: {allowed_str}.",
                None,
            )
        return (True, None, None)

    if eng == "codex":
        if "codex" in deny_set:
            return (
                False,
                f"Harness 'codex' is denied for repository {policy['repo']} by repo policy; allowed harnesses: {allowed_str}.",
                None,
            )
        return (True, None, None)

    if eng == "opencode":
        if "opencode" in deny_set:
            return (
                False,
                f"Harness 'opencode' is denied for repository {policy['repo']} by repo policy; allowed harnesses: {allowed_str}.",
                None,
            )
        return (True, None, None)

    if eng == "claude":
        work_denied = bool({"claude-work", "claude-all"} & deny_set)
        plaude_denied = bool({"plaude", "claude-all"} & deny_set)
        resolved_cfg = Path(claude_config_dir).expanduser() if claude_config_dir else None
        is_personal = is_personal_claude_profile(resolved_cfg)

        if work_denied and plaude_denied:
            return (
                False,
                f"Harness 'claude' (all profiles) is denied for repository {policy['repo']} by repo policy; allowed harnesses: {allowed_str}.",
                None,
            )

        if work_denied and not plaude_denied:
            if resolved_cfg is None:
                if os.environ.get("ORCHESTRATE_AUTO_PLAUDE") == "1":
                    return (True, None, Path.home() / ".claude-personal")
                return (
                    False,
                    "Harness 'claude-work' (default/work Claude profile) is denied for this repository by repo policy; "
                    "use 'plaude' (--claude-config-dir ~/.claude-personal), 'agy', or 'codex'.",
                    None,
                )
            if not is_personal:
                return (
                    False,
                    "Harness 'claude-work' (default/work Claude profile) is denied for this repository by repo policy; "
                    "use 'plaude' (--claude-config-dir ~/.claude-personal), 'agy', or 'codex'.",
                    None,
                )
            return (True, None, resolved_cfg)

        if plaude_denied and not work_denied:
            if is_personal:
                return (
                    False,
                    "Harness 'plaude' (personal Claude profile) is denied for this repository by repo policy; "
                    "use default 'claude', 'agy', or 'codex'.",
                    None,
                )
            return (True, None, resolved_cfg)

        return (True, None, resolved_cfg)

    return (True, None, None)
