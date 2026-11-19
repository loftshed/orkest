#!/usr/bin/env python3
"""Per-repository harness and account denylist policy evaluation."""

from __future__ import annotations

import fnmatch
import json
import os
import posixpath
import re
import stat
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import runtime_paths

POLICY_SCHEMA = "ork.policy.v1"
CANONICAL_HARNESSES = ("codex", "agy", "claude", "opencode")
_CANONICAL_HARNESS_SET = frozenset(CANONICAL_HARNESSES)
TRANSPORT_BILLING_WORDS = frozenset({"subscription", "api", "unknown", "oauth"})
DENY_KEYS = ("deny", "denied", "denied_harnesses", "deniedHarnesses", "denied_engines")


class PolicyConfigError(ValueError):
    """Raised in strict mode when repository policy config or git lookup fails."""


TOKEN_ALIASES = {
    "codex": "codex",
    "openai": "codex",
    "agy": "agy",
    "gemini": "agy",
    "antigravity": "agy",
    "opencode": "opencode",
    "openrouter": "opencode",
    "claude": "claude",
    "anthropic": "claude",
    "claude-all": "claude",
    "claude_all": "claude",
    "all-claude": "claude",
    "claude-work": "claude-work",
    "claude_work": "claude-work",
    "work-claude": "claude-work",
    "claude-personal": "claude-personal",
    "claude_personal": "claude-personal",
    "personal-claude": "claude-personal",
}


def normalize_deny_token(token: Any) -> str:
    if not isinstance(token, str):
        return ""
    cleaned = token.strip().lower()
    if not cleaned:
        return ""
    if cleaned in TOKEN_ALIASES:
        return TOKEN_ALIASES[cleaned]
    if ":" in cleaned:
        prefix, rest = cleaned.split(":", 1)
        prefix = prefix.strip()
        rest = rest.strip()
        if prefix in ("tag", "category", "account"):
            return f"{prefix}:{rest}" if rest else ""
        mapped_prefix = TOKEN_ALIASES.get(prefix, prefix)
        if mapped_prefix in _CANONICAL_HARNESS_SET:
            return f"{mapped_prefix}:{rest}" if rest else mapped_prefix
    return cleaned


def normalize_account_tags(account: Any) -> list[str]:
    if not isinstance(account, Mapping):
        return []
    tags: list[str] = []
    seen: set[str] = set()

    def _add(raw: Any) -> None:
        if not isinstance(raw, str):
            return
        cleaned = raw.strip().lower()
        if not cleaned or cleaned in seen:
            return
        seen.add(cleaned)
        tags.append(cleaned)

    raw_tags = account.get("tags")
    if isinstance(raw_tags, (list, tuple, set)):
        for item in raw_tags:
            _add(item)
    elif isinstance(raw_tags, str):
        for item in raw_tags.split(","):
            _add(item)

    _add(account.get("category"))

    raw_billing = account.get("billing")
    if isinstance(raw_billing, str):
        billing = raw_billing.strip().lower()
        if billing and billing not in TRANSPORT_BILLING_WORDS:
            _add(billing)

    return tags


def _canonicalize_path(target_path: Path | str) -> Path:
    raw = str(target_path or "")
    if not raw:
        try:
            return Path.cwd().resolve(strict=True)
        except OSError:
            return Path(os.path.abspath("."))
    try:
        return Path(raw).resolve(strict=True)
    except OSError:
        is_abs = os.path.isabs(raw)
        try:
            current = Path("/").resolve(strict=True) if is_abs else Path.cwd().resolve(strict=True)
        except OSError:
            current = Path("/") if is_abs else Path(os.path.abspath("."))
        suffix: list[str] = []
        for part in raw.replace("\\", "/").split("/"):
            if not part or part == ".":
                continue
            if part == "..":
                if suffix:
                    suffix.pop()
                else:
                    parent = current.parent
                    if parent != current:
                        try:
                            current = parent.resolve(strict=True)
                        except OSError:
                            current = parent
                continue
            if not suffix:
                candidate = current / part
                try:
                    current = candidate.resolve(strict=True)
                except OSError:
                    suffix.append(part)
            else:
                suffix.append(part)
        for part in suffix:
            current = current / part
        return current


def _existing_directory_ancestor(target_path: Path) -> Path:
    current = target_path
    while True:
        try:
            if current.is_dir():
                return current
        except OSError:
            pass
        parent = current.parent
        if parent == current:
            return current
        current = parent


def _resolve_home(home: Path | str | None = None, env: Mapping[str, str] | None = None) -> Path:
    if home is not None:
        return Path(os.path.abspath(str(home)))
    env_home = (env or os.environ).get("HOME")
    if env_home:
        return Path(os.path.abspath(env_home))
    return Path.home()


def _expand_home(pattern: str, home: Path | None = None) -> str:
    text = str(pattern or "").strip()
    if not text:
        return ""
    base_home = home if home is not None else _resolve_home()
    home_str = str(base_home).rstrip("/") or "/"
    if text == "~":
        return home_str
    if text == "~/":
        return "/" if home_str == "/" else f"{home_str}/"
    if text.startswith("~/"):
        prefix = "" if home_str == "/" else home_str
        return f"{prefix}/{text[2:]}"
    return text


def _is_non_git_repo_result(res: subprocess.CompletedProcess[str]) -> bool:
    return res.returncode == 128 and "not a git repository" in (res.stderr or "").lower()


def _is_missing_git_config_key(res: subprocess.CompletedProcess[str]) -> bool:
    return res.returncode == 1 and not (res.stderr or "").strip()


def resolve_repo_root(cwd: Path | str | None = None, *, home: Path | None = None, strict: bool = False) -> Path:
    raw = str(cwd or Path.cwd())
    expanded = _expand_home(raw, home=home) if raw.lstrip().startswith("~") else raw
    base_resolved = _canonicalize_path(expanded)
    target_dir = _existing_directory_ancestor(base_resolved)
    try:
        res = subprocess.run(
            ["git", "-C", str(target_dir), "rev-parse", "--show-toplevel"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        if strict:
            raise PolicyConfigError(f"Failed to resolve git repository root for {target_dir}: {exc}") from exc
        return base_resolved
    if res.returncode == 0 and res.stdout.strip():
        return _canonicalize_path(res.stdout.strip())
    if _is_non_git_repo_result(res):
        return base_resolved
    if strict:
        detail = (res.stderr or "").strip() or f"git exited with status {res.returncode}"
        raise PolicyConfigError(f"Failed to resolve git repository root for {target_dir}: {detail}")
    return base_resolved


def resolve_git_remote(repo_root: Path, *, strict: bool = False) -> str:
    try:
        res = subprocess.run(
            ["git", "-C", str(repo_root), "config", "--get", "remote.origin.url"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        if strict:
            raise PolicyConfigError(f"Failed to resolve git remote for {repo_root}: {exc}") from exc
        return ""
    if res.returncode == 0:
        return res.stdout.strip()
    if _is_missing_git_config_key(res) or _is_non_git_repo_result(res):
        return ""
    if strict:
        detail = (res.stderr or "").strip() or f"git exited with status {res.returncode}"
        raise PolicyConfigError(f"Failed to resolve git remote for {repo_root}: {detail}")
    return ""


def _is_missing_policy_file_error(path: Path, exc: OSError) -> bool:
    if not isinstance(exc, FileNotFoundError):
        return False
    try:
        parent_lstat = os.lstat(path.parent)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    if stat.S_ISLNK(parent_lstat.st_mode):
        try:
            parent_stat = os.stat(path.parent)
        except FileNotFoundError:
            return True
        except OSError:
            return False
        return stat.S_ISDIR(parent_stat.st_mode)
    return stat.S_ISDIR(parent_lstat.st_mode)


def _load_json_dict(path: Path, *, is_strict: bool = False) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        if _is_missing_policy_file_error(path, exc):
            return {}
        if is_strict:
            raise PolicyConfigError(f"Failed to read policy JSON in {path}: {exc}") from exc
        return {}
    try:
        data = json.loads(raw)
    except ValueError as exc:
        if is_strict:
            raise PolicyConfigError(f"Failed to parse policy JSON in {path}: {exc}") from exc
        return {}
    if isinstance(data, dict):
        return data
    if is_strict:
        raise PolicyConfigError(f"Invalid policy JSON object in {path}")
    return {}


def _rule_display_name(rule: dict[str, Any], fallback: str | int) -> str:
    for key in ("path", "repo", "remote", "match", "pattern"):
        val = rule.get(key)
        if val is not None and str(val).strip():
            return str(val)
    return str(fallback)


def _validate_deny_array(raw_list: Any, label: str) -> None:
    if not isinstance(raw_list, list):
        raise PolicyConfigError(f"Invalid rule {label}: expected array")
    for idx, item in enumerate(raw_list):
        if not isinstance(item, str) or not item.strip():
            raise PolicyConfigError(f"Invalid rule {label}[{idx}]: expected non-empty string")


def _validate_policy_container(container: Any, source: str, *, is_strict: bool = False) -> None:
    if not is_strict:
        return
    if not isinstance(container, dict):
        raise PolicyConfigError(f"Invalid policy container in {source}: expected JSON object")
    for key in DENY_KEYS:
        if key in container and container[key] is not None:
            _validate_deny_array(container[key], f"'{key}' in {source}")
    for policies_key in ("repo_policies", "repoPolicies"):
        raw_policies = container.get(policies_key)
        if raw_policies is None:
            continue
        if isinstance(raw_policies, list):
            for idx, entry in enumerate(raw_policies):
                if not isinstance(entry, dict):
                    raise PolicyConfigError(f"Invalid rule [{idx}] in {source}.{policies_key}: expected object")
                name = _rule_display_name(entry, f"[{idx}]")
                for deny_key in DENY_KEYS:
                    if deny_key in entry and entry[deny_key] is not None:
                        _validate_deny_array(
                            entry[deny_key],
                            f"'{deny_key}' for rule {json.dumps(name)} in {source}.{policies_key}",
                        )
            continue
        if isinstance(raw_policies, dict):
            for rule_key, value in raw_policies.items():
                if isinstance(value, list):
                    _validate_deny_array(
                        value,
                        f"shorthand entry {json.dumps(str(rule_key))} in {source}.{policies_key}",
                    )
                    continue
                if not isinstance(value, dict):
                    raise PolicyConfigError(
                        f"Invalid rule map entry {json.dumps(str(rule_key))} in {source}.{policies_key}: "
                        "expected array or object"
                    )
                name = _rule_display_name(value, str(rule_key))
                for deny_key in DENY_KEYS:
                    if deny_key in value and value[deny_key] is not None:
                        _validate_deny_array(
                            value[deny_key],
                            f"'{deny_key}' for rule {json.dumps(name)} in {source}.{policies_key}",
                        )
            continue
        raise PolicyConfigError(f"Invalid '{policies_key}' in {source}: expected array or object")


def _canonicalize_glob_path(abs_pattern: str) -> str:
    first_glob = next((idx for idx, ch in enumerate(abs_pattern) if ch in "*?["), -1)
    if first_glob == -1:
        return str(_canonicalize_path(abs_pattern))
    literal_part = abs_pattern[:first_glob]
    last_slash = literal_part.rfind("/")
    dir_prefix = "/" if last_slash <= 0 else literal_part[:last_slash]
    glob_suffix = abs_pattern[last_slash + 1 :]
    canon_dir = str(_canonicalize_path(dir_prefix))
    return f"/{glob_suffix}" if canon_dir == "/" else f"{canon_dir}/{glob_suffix}"


def _matches_literal_prefix(repo_str: str, prefix: str) -> bool:
    if prefix == "/":
        return repo_str.startswith("/")
    return repo_str == prefix or repo_str.startswith(f"{prefix}/")


def _matches_path_pattern(repo_root: Path, raw_pattern: str, *, home: Path | None = None) -> bool:
    expanded = _expand_home(raw_pattern, home=home)
    if not expanded:
        return False
    repo_str = str(repo_root)
    if os.path.isabs(expanded):
        # Check exact literal equality / directory prefix BEFORE any glob evaluation
        # so literal directory names containing '[', '?', or '*' (e.g. project[1]) still match.
        if len(expanded) > 1 and expanded.endswith("/"):
            literal_prefix = str(_canonicalize_path(expanded.rstrip("/") or "/"))
            if _matches_literal_prefix(repo_str, literal_prefix):
                return True
        elif expanded.endswith("/*"):
            literal_prefix = str(_canonicalize_path(expanded[:-2] or "/"))
            if _matches_literal_prefix(repo_str, literal_prefix):
                return True
        elif repo_str == str(_canonicalize_path(expanded)):
            return True

        has_glob = any(ch in expanded for ch in "*?[")
        if not has_glob:
            return False

        canon_pattern = _canonicalize_glob_path(expanded)
        if canon_pattern.endswith("/*"):
            prefix_pattern = canon_pattern[:-2] or "/"
            if not any(ch in prefix_pattern for ch in "*?["):
                return _matches_literal_prefix(repo_str, prefix_pattern)
            return bool(fnmatch.fnmatchcase(repo_str, prefix_pattern) or fnmatch.fnmatchcase(repo_str, canon_pattern))
        if len(canon_pattern) > 1 and canon_pattern.endswith("/"):
            prefix_pattern = canon_pattern.rstrip("/") or "/"
            desc_pattern = "/*" if prefix_pattern == "/" else f"{prefix_pattern}/*"
            return bool(fnmatch.fnmatchcase(repo_str, prefix_pattern) or fnmatch.fnmatchcase(repo_str, desc_pattern))
        return bool(fnmatch.fnmatchcase(repo_str, canon_pattern))

    raw_rel = expanded.replace(os.sep, "/")
    had_trailing_slash = raw_rel.endswith("/")
    rel = posixpath.normpath(raw_rel)
    if rel == ".":
        return True
    if had_trailing_slash and rel != "/" and not rel.endswith("/"):
        rel = f"{rel}/"
    if "/" not in rel:
        if repo_root.name == rel:
            return True
        return bool(fnmatch.fnmatchcase(repo_root.name, rel))
    if rel.endswith("/*") or rel.endswith("/"):
        rel_prefix = (rel[:-2] if rel.endswith("/*") else rel).rstrip("/")
        if not rel_prefix:
            return False
        if repo_str.endswith(f"/{rel_prefix}") or f"/{rel_prefix}/" in repo_str:
            return True
        return bool(
            fnmatch.fnmatchcase(repo_str, f"*/{rel_prefix}") or fnmatch.fnmatchcase(repo_str, f"*/{rel_prefix}/*")
        )
    if repo_str.endswith(f"/{rel}"):
        return True
    return bool(fnmatch.fnmatchcase(repo_str, f"*/{rel}"))


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


def _has_rule_selector(rule: dict[str, Any]) -> bool:
    return any(rule.get(k) for k in ("path", "repo", "remote", "match", "pattern"))


def _normalize_rules_list(raw_policies: Any, *, source: str) -> list[dict[str, Any]]:
    rules: list[dict[str, Any]] = []
    if isinstance(raw_policies, dict):
        for key, value in raw_policies.items():
            if isinstance(value, list):
                rules.append({"match": str(key), "deny": list(value), "source": source})
            elif isinstance(value, dict):
                rule = {**value, "source": source}
                if not _has_rule_selector(rule):
                    rule["match"] = str(key)
                rules.append(rule)
    elif isinstance(raw_policies, list):
        for entry in raw_policies:
            if isinstance(entry, dict):
                rules.append({**entry, "source": source})
    return rules


def _collect_rule_deny_tokens(rule: dict[str, Any]) -> list[str] | None:
    if not isinstance(rule, dict):
        return None
    has_deny_list = False
    tokens: list[str] = []
    seen: set[str] = set()
    for key in DENY_KEYS:
        raw_list = rule.get(key)
        if not isinstance(raw_list, list):
            continue
        has_deny_list = True
        for item in raw_list:
            norm = normalize_deny_token(item)
            if not norm or norm in seen:
                continue
            seen.add(norm)
            tokens.append(norm)
    return tokens if has_deny_list else None


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

    if rule.get("literal_root") and path_pat:
        return str(repo_root) == str(path_pat)

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


def resolve_repo_policy(
    cwd: Path | str | None = None,
    config: dict[str, Any] | None = None,
    *,
    home: Path | str | None = None,
    config_path: Path | str | None = None,
    env: Mapping[str, str] | None = None,
    remote: str | None = None,
    strict: bool = False,
) -> dict[str, Any]:
    resolved_home = _resolve_home(home=home, env=env)
    repo_root = resolve_repo_root(cwd, home=resolved_home, strict=strict)
    remote_url = resolve_git_remote(repo_root, strict=strict) if remote is None else str(remote or "")

    if config is None:
        if config_path is not None:
            cfg_path = Path(os.path.abspath(_expand_home(str(config_path), home=resolved_home)))
        else:
            cfg_fn = getattr(runtime_paths, "config_path", None)
            cfg_path = (
                cfg_fn(env=env, home=resolved_home)
                if callable(cfg_fn)
                else (runtime_paths.config_home(env=env, home=resolved_home) / "config.json")
            )
        config_data = _load_json_dict(cfg_path, is_strict=strict)
        config_source = str(cfg_path)
    else:
        if isinstance(config, dict):
            config_data = config
        elif strict:
            raise PolicyConfigError("Invalid policy config: expected object")
        else:
            config_data = {}
        config_source = "config"
    _validate_policy_container(config_data, config_source, is_strict=strict)

    candidate_rules: list[tuple[dict[str, Any], bool]] = []
    for key in ("repo_policies", "repoPolicies"):
        if key in config_data and config_data[key] is not None:
            for r in _normalize_rules_list(config_data.get(key), source=config_source):
                candidate_rules.append((r, False))

    repo_policy_file = repo_root / ".orkest" / "policy.json"
    repo_local = _load_json_dict(repo_policy_file, is_strict=strict)
    local_source = str(repo_policy_file)
    _validate_policy_container(repo_local, local_source, is_strict=strict)
    local_top_tokens = _collect_rule_deny_tokens(repo_local)
    if local_top_tokens is not None:
        candidate_rules.append(
            (
                {
                    "path": str(repo_root),
                    "deny": local_top_tokens,
                    "source": local_source,
                    "literal_root": True,
                },
                True,
            )
        )
    for key in ("repo_policies", "repoPolicies"):
        if key in repo_local and repo_local[key] is not None:
            for r in _normalize_rules_list(repo_local.get(key), source=local_source):
                candidate_rules.append((r, True))

    matched_rules: list[dict[str, Any]] = []
    deny_tokens: list[str] = []
    seen_deny: set[str] = set()

    for rule, default_all in candidate_rules:
        if not _rule_matches_repo(rule, repo_root, remote_url, home=resolved_home, default_match_all=default_all):
            continue
        normalized_rule_deny = _collect_rule_deny_tokens(rule)
        if normalized_rule_deny is None:
            continue
        for norm in normalized_rule_deny:
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
    if "all" not in deny_set:
        for harness in CANONICAL_HARNESSES:
            if harness not in deny_set:
                allowed_harnesses.append(harness)

    return {
        "schema": POLICY_SCHEMA,
        "repo": str(repo_root),
        "remote": remote_url,
        "deny": deny_tokens,
        "allowed_harnesses": allowed_harnesses,
        "matched_rules": matched_rules,
    }


def _classify_provider_family(provider: str | None) -> str:
    text = str(provider or "").strip().lower()
    if not text:
        return ""
    if "opencode" in text or "openrouter" in text:
        return "opencode"
    if "codex" in text or "openai" in text or "chatgpt" in text:
        return "codex"
    if "agy" in text or "gemini" in text or "antigravity" in text:
        return "agy"
    if "claude" in text or "anthropic" in text:
        return "claude"
    return ""


def _resolve_monitor_config_path(
    *,
    home: Path | str | None = None,
    monitor_config_path: Path | str | None = None,
    env: Mapping[str, str] | None = None,
) -> Path:
    resolved_home = _resolve_home(home=home, env=env)
    if monitor_config_path is not None:
        return Path(os.path.abspath(_expand_home(str(monitor_config_path), home=resolved_home)))
    source_env = os.environ if env is None else env
    explicit = source_env.get("MONITOR_CONFIG")
    if explicit:
        return Path(os.path.abspath(_expand_home(explicit, home=resolved_home)))
    return resolved_home / ".config" / "monitor" / "config.json"


def _resolve_account_dir_path(raw_value: Any, base_home: Path, home_dir: Path) -> str:
    if not isinstance(raw_value, (str, Path)):
        return ""
    text = str(raw_value).strip()
    if not text:
        return ""
    expanded = _expand_home(text, home=base_home)
    abs_path = Path(expanded) if os.path.isabs(expanded) else (base_home / expanded)
    return str(_canonicalize_path(abs_path))


_SINGLE_WORD_ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_RESERVED_ROUTE_ALIAS_NAMES = frozenset({"claude", "codex", "agy", "gemini", "opencode", "antigravity", "all"})


def _get_account_aliases(account: Mapping[str, Any]) -> list[str]:
    aliases: list[str] = []
    seen: set[str] = set()

    def _add(val: Any) -> None:
        if not isinstance(val, str):
            return
        cleaned = val.strip().lower()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            aliases.append(cleaned)

    _add(account.get("alias"))
    raw_aliases = account.get("aliases")
    if isinstance(raw_aliases, (list, tuple)):
        for item in raw_aliases:
            _add(item)
    raw_route = account.get("route")
    if isinstance(raw_route, str):
        route_tok = raw_route.strip()
        if (
            route_tok
            and _SINGLE_WORD_ALIAS_RE.fullmatch(route_tok)
            and route_tok.lower() not in _RESERVED_ROUTE_ALIAS_NAMES
        ):
            _add(route_tok)
    return aliases


def load_configured_accounts(
    *,
    home: Path | str | None = None,
    monitor_config_path: Path | str | None = None,
    env: Mapping[str, str] | None = None,
    config: Mapping[str, Any] | None = None,
    strict: bool = False,
) -> list[dict[str, Any]]:
    raw_accounts: Any = None
    raw_global_env: Any = None
    if isinstance(config, Mapping):
        raw_global_env = config.get("env")
        if "accounts" in config:
            if not isinstance(config.get("accounts"), list):
                if strict:
                    raise PolicyConfigError("Invalid accounts list in Monitor config: expected array")
                raw_accounts = []
            else:
                raw_accounts = config["accounts"]
        else:
            raw_accounts = []
    else:
        cfg_path = _resolve_monitor_config_path(
            home=home,
            monitor_config_path=monitor_config_path,
            env=env,
        )
        parsed = _load_json_dict(cfg_path, is_strict=strict)
        raw_global_env = parsed.get("env")
        if "accounts" in parsed and not isinstance(parsed.get("accounts"), list):
            if strict:
                raise PolicyConfigError(f"Invalid accounts list in Monitor config {cfg_path}: expected array")
            raw_accounts = []
        else:
            raw_accounts = parsed.get("accounts") if isinstance(parsed.get("accounts"), list) else []

    normalized: list[dict[str, Any]] = []
    for entry in raw_accounts:
        if not isinstance(entry, Mapping):
            continue
        merged_env: dict[str, str] = {}
        for mapping in (raw_global_env, entry.get("env")):
            if not isinstance(mapping, Mapping):
                continue
            for key, val in mapping.items():
                if not isinstance(key, str):
                    continue
                if val is None:
                    merged_env.pop(key, None)
                elif isinstance(val, str) and val.strip():
                    merged_env[key] = val.strip()
        cleaned_entry = {k: v for k, v in entry.items() if k != "env"}
        if merged_env:
            cleaned_entry["env"] = merged_env
        cleaned_entry["tags"] = normalize_account_tags(entry)
        normalized.append(cleaned_entry)
    return normalized


def _first_nonempty_str(*values: Any) -> str | None:
    return next((v.strip() for v in values if isinstance(v, str) and v.strip()), None)


def _derive_effective_agy_profile(
    agy_homes: list[str] | set[str],
    agy_app_data_dirs: list[str] | set[str],
    base_home: Path,
    *,
    fallback_to_default: bool = False,
    infer_basename: bool = False,
) -> dict[str, Any]:
    homes = [h for h in agy_homes if h]
    apps = [a for a in agy_app_data_dirs if a]
    effective_app_data = ""
    if apps:
        effective_app_data = apps[0]
    elif homes:
        home_path = Path(homes[0])
        if infer_basename and home_path.name.lower().startswith("antigravity"):
            effective_app_data = str(_canonicalize_path(home_path))
        else:
            effective_app_data = str(_canonicalize_path(home_path / "antigravity-cli"))
    elif fallback_to_default:
        default_home = str(_canonicalize_path(base_home / ".gemini"))
        homes = [default_home]
        effective_app_data = str(_canonicalize_path(base_home / ".gemini" / "antigravity-cli"))
    exact_paths: set[str] = set()
    if effective_app_data:
        exact_paths.add(effective_app_data)
    exact_paths.update(homes)
    exact_paths.update(apps)
    return {
        "homes": set(homes),
        "apps": set(apps),
        "effective_app_data": effective_app_data,
        "exact_paths": exact_paths,
    }


def _describe_account_paths(account: Mapping[str, Any], home_dir: Path) -> dict[str, Any]:
    raw_env = account.get("env")
    env_obj = raw_env if isinstance(raw_env, Mapping) else {}
    env_home = _resolve_account_dir_path(env_obj.get("HOME"), home_dir, home_dir)
    base_home = Path(env_home) if env_home else _canonicalize_path(home_dir)
    family = _classify_provider_family(str(account.get("provider") or "").strip().lower())

    claude_raw = _first_nonempty_str(
        account.get("claudeConfigDir"),
        account.get("claude_config_dir"),
        account.get("configDir"),
        env_obj.get("CLAUDE_CONFIG_DIR"),
    )
    claude_dir = _resolve_account_dir_path(claude_raw, base_home, home_dir)
    if not claude_dir and family == "claude":
        claude_dir = str(_canonicalize_path(base_home / ".claude"))

    codex_raw = _first_nonempty_str(account.get("codexHome"), account.get("codex_home"), env_obj.get("CODEX_HOME"))
    codex_home = _resolve_account_dir_path(codex_raw, base_home, home_dir)
    if not codex_home and family == "codex":
        codex_home = str(_canonicalize_path(base_home / ".codex"))

    raw_app_dir = _first_nonempty_str(
        account.get("agyAppDataDir"),
        account.get("agy_app_data_dir"),
        env_obj.get("ANTIGRAVITY_APP_DATA_DIR"),
    )
    raw_agy_home = _first_nonempty_str(account.get("agyHome"), account.get("agy_home"))
    raw_env_gemini = _first_nonempty_str(env_obj.get("GEMINI_CLI_HOME"))
    agy_app_dir = _resolve_account_dir_path(raw_app_dir, base_home, home_dir)
    agy_gemini_home = _resolve_account_dir_path(raw_agy_home or raw_env_gemini, base_home, home_dir)
    infer_acct_basename = bool(not agy_app_dir and raw_agy_home and not raw_env_gemini)
    agy_profile = _derive_effective_agy_profile(
        [agy_gemini_home] if agy_gemini_home else [],
        [agy_app_dir] if agy_app_dir else [],
        base_home,
        fallback_to_default=(family == "agy"),
        infer_basename=infer_acct_basename,
    )
    agy_homes: set[str] = set(agy_profile["exact_paths"])
    for resolved in list(agy_homes):
        p_resolved = Path(resolved)
        if p_resolved.name.lower().startswith("antigravity"):
            agy_homes.add(str(_canonicalize_path(p_resolved.parent)))

    return {
        "family": family,
        "env_home": env_home,
        "claude_dir": claude_dir,
        "codex_home": codex_home,
        "agy_app_dir": agy_app_dir,
        "agy_effective_app": agy_profile["effective_app_data"],
        "agy_exact_homes": agy_profile["homes"] | agy_profile["apps"],
        "agy_homes": agy_homes,
    }


def resolve_configured_account(
    selector_or_paths: Any = None,
    *,
    accounts: list[dict[str, Any]] | None = None,
    home: Path | str | None = None,
    monitor_config_path: Path | str | None = None,
    env: Mapping[str, str] | None = None,
    provider: str | None = None,
    account_id: str | None = None,
    account_alias: str | None = None,
    claude_config_dir: Path | str | None = None,
    codex_home: Path | str | None = None,
    agy_home: Path | str | None = None,
    agy_app_data_dir: Path | str | None = None,
    infer_agy_basename: bool = False,
    strict: bool = False,
) -> dict[str, Any] | None:
    if accounts is not None:
        loaded_accounts = [
            {**entry, "tags": normalize_account_tags(entry)} for entry in accounts if isinstance(entry, Mapping)
        ]
    else:
        loaded_accounts = load_configured_accounts(
            home=home,
            monitor_config_path=monitor_config_path,
            env=env,
            strict=strict,
        )
    if not loaded_accounts:
        return None

    home_dir = _resolve_home(home=home, env=env)
    canon_home = _canonicalize_path(home_dir)
    canon_home_str = str(canon_home)
    id_candidates: set[str] = set()
    alias_candidates: set[str] = set()
    claude_dirs: set[str] = set()
    codex_homes: set[str] = set()
    agy_homes: list[str] = []
    agy_app_dirs: list[str] = []
    env_homes: set[str] = set()
    generic_paths: set[str] = set()

    def _add_id(val: Any) -> None:
        if not isinstance(val, str):
            return
        cleaned = val.strip().lower()
        if cleaned.startswith("account:"):
            cleaned = cleaned[len("account:") :].strip()
        if cleaned:
            id_candidates.add(cleaned)

    def _add_alias(val: Any) -> None:
        if not isinstance(val, str):
            return
        cleaned = val.strip().lower()
        if cleaned:
            alias_candidates.add(cleaned)

    def _add_path(target: set[str] | list[str], raw: Any) -> None:
        resolved = _resolve_account_dir_path(raw, canon_home, home_dir)
        if resolved:
            if isinstance(target, set):
                target.add(resolved)
            elif resolved not in target:
                target.append(resolved)

    provider_filter = _classify_provider_family(provider)
    _add_id(account_id)
    _add_alias(account_alias)
    _add_path(claude_dirs, claude_config_dir)
    _add_path(codex_homes, codex_home)
    _add_path(agy_homes, agy_home)
    _add_path(agy_app_dirs, agy_app_data_dir)

    if isinstance(selector_or_paths, Path):
        _add_path(generic_paths, selector_or_paths)
    elif isinstance(selector_or_paths, str):
        raw_str = selector_or_paths.strip()
        _add_id(raw_str)
        _add_alias(raw_str)
        if "/" in raw_str or "\\" in raw_str or raw_str.startswith(("~", ".")):
            _add_path(generic_paths, raw_str)
    elif isinstance(selector_or_paths, Mapping):
        sel_prov = _classify_provider_family(
            str(
                selector_or_paths.get("provider")
                or selector_or_paths.get("engine")
                or selector_or_paths.get("harness")
                or ""
            )
        )
        if not provider_filter and sel_prov:
            provider_filter = sel_prov
        _add_id(selector_or_paths.get("id"))
        _add_id(selector_or_paths.get("accountId"))
        _add_alias(selector_or_paths.get("alias"))
        _add_alias(selector_or_paths.get("accountAlias"))
        raw_sel_env = selector_or_paths.get("env")
        sel_env = raw_sel_env if isinstance(raw_sel_env, Mapping) else {}
        _add_path(
            claude_dirs,
            _first_nonempty_str(
                selector_or_paths.get("claudeConfigDir"),
                selector_or_paths.get("claude_config_dir"),
                selector_or_paths.get("configDir"),
                sel_env.get("CLAUDE_CONFIG_DIR"),
            ),
        )
        _add_path(
            codex_homes,
            _first_nonempty_str(
                selector_or_paths.get("codexHome"),
                selector_or_paths.get("codex_home"),
                sel_env.get("CODEX_HOME"),
            ),
        )
        for raw_agy in (
            selector_or_paths.get("agyHome"),
            selector_or_paths.get("agy_home"),
            sel_env.get("GEMINI_CLI_HOME"),
        ):
            _add_path(agy_homes, raw_agy)
        for raw_app in (
            selector_or_paths.get("agyAppDataDir"),
            selector_or_paths.get("agy_app_data_dir"),
            sel_env.get("ANTIGRAVITY_APP_DATA_DIR"),
        ):
            _add_path(agy_app_dirs, raw_app)
        sel_home = _resolve_account_dir_path(
            selector_or_paths.get("home") or sel_env.get("HOME"),
            canon_home,
            home_dir,
        )
        if sel_home and sel_home != canon_home_str:
            env_homes.add(sel_home)

    for acct in loaded_accounts:
        acct_id = str(acct.get("id") or "").strip().lower()
        if acct_id and acct_id in id_candidates:
            return acct
    for acct in loaded_accounts:
        aliases = _get_account_aliases(acct)
        if any(a in alias_candidates for a in aliases):
            return acct

    sel_agy_profile = _derive_effective_agy_profile(
        agy_homes,
        agy_app_dirs,
        canon_home,
        fallback_to_default=False,
        infer_basename=infer_agy_basename,
    )
    sel_agy_home_set = sel_agy_profile["homes"]
    sel_agy_app_set = sel_agy_profile["apps"]
    sel_agy_eff_app = sel_agy_profile["effective_app_data"]
    has_agy_selector = bool(sel_agy_home_set or sel_agy_app_set)

    account_infos = [(acct, _describe_account_paths(acct, home_dir)) for acct in loaded_accounts]
    for acct, info in account_infos:
        if provider_filter and info["family"] and info["family"] != provider_filter:
            continue
        if claude_dirs and info["family"] == "claude" and info["claude_dir"] in claude_dirs:
            return acct
        if codex_homes and info["family"] == "codex" and info["codex_home"] in codex_homes:
            return acct
        if (
            has_agy_selector
            and info["family"] == "agy"
            and sel_agy_eff_app
            and info["agy_effective_app"] == sel_agy_eff_app
        ):
            return acct
    for acct, info in account_infos:
        if provider_filter and info["family"] and info["family"] != provider_filter:
            continue
        if not has_agy_selector or info["family"] != "agy":
            continue
        if sel_agy_app_set:
            if info["agy_app_dir"] and info["agy_app_dir"] in sel_agy_app_set:
                return acct
        else:
            if (info["agy_app_dir"] and info["agy_app_dir"] in sel_agy_home_set) or (
                not info["agy_app_dir"] and (sel_agy_home_set & info["agy_exact_homes"])
            ):
                return acct
    stripped_agy = {
        str(_canonicalize_path(Path(p).parent))
        for p in (*sel_agy_home_set, *sel_agy_app_set)
        if Path(p).name.lower().startswith("antigravity")
    }
    for acct, info in account_infos:
        if provider_filter and info["family"] and info["family"] != provider_filter:
            continue
        if (
            has_agy_selector
            and not sel_agy_app_set
            and info["family"] == "agy"
            and not info["agy_app_dir"]
            and ((sel_agy_home_set & info["agy_homes"]) or (stripped_agy and (stripped_agy & info["agy_homes"])))
        ):
            return acct
        if env_homes and info["env_home"] in env_homes:
            return acct
        if generic_paths and (
            info["claude_dir"] in generic_paths
            or info["codex_home"] in generic_paths
            or info["env_home"] in generic_paths
            or (generic_paths & info["agy_homes"])
        ):
            return acct

    return None


def _collect_effective_tags(
    tags: Any,
    billing_mode: str | None,
    eng_norm: str,
    resolved_acct: Mapping[str, Any] | None,
) -> set[str]:
    result: set[str] = set()

    def _add(raw: Any) -> None:
        if not isinstance(raw, str):
            return
        cleaned = raw.strip().lower()
        if cleaned:
            result.add(cleaned)

    if isinstance(tags, str):
        for part in tags.split(","):
            _add(part)
    elif isinstance(tags, (list, tuple, set)):
        for item in tags:
            _add(item)

    if billing_mode:
        b = str(billing_mode).strip().lower()
        if b and b not in TRANSPORT_BILLING_WORDS:
            if b == "personal_subscription":
                result.add("personal")
            elif b == "work_subscription":
                result.add("work")
            else:
                result.add(b)

    if eng_norm == "claude-work":
        result.add("work")
    elif eng_norm == "claude-personal":
        result.add("personal")
    elif eng_norm.startswith(("tag:", "category:")):
        tag = eng_norm.split(":", 1)[1]
        if tag:
            result.add(tag)
    elif ":" in eng_norm:
        prov_part, tag_part = eng_norm.split(":", 1)
        if prov_part in _CANONICAL_HARNESS_SET and tag_part:
            result.add(tag_part)

    if resolved_acct is not None:
        for tag in normalize_account_tags(resolved_acct):
            result.add(tag)

    return result


def check_execution_allowed(
    cwd: Path | str | None,
    engine: str,
    claude_config_dir: Path | str | None = None,
    config: dict[str, Any] | None = None,
    *,
    home: Path | str | None = None,
    config_path: Path | str | None = None,
    monitor_config_path: Path | str | None = None,
    env: Mapping[str, str] | None = None,
    account_id: str | None = None,
    provider: str | None = None,
    billing_mode: str | None = None,
    tags: list[str] | tuple[str, ...] | set[str] | str | None = None,
    account_alias: str | None = None,
    codex_home: Path | str | None = None,
    agy_home: Path | str | None = None,
    agy_app_data_dir: Path | str | None = None,
    strict: bool = False,
) -> tuple[bool, str | None, Path | None]:
    policy = resolve_repo_policy(
        cwd,
        config=config,
        home=home,
        config_path=config_path,
        env=env,
        strict=strict,
    )
    deny_tokens = list(policy["deny"])
    deny_set = set(deny_tokens)
    allowed_list = policy["allowed_harnesses"]
    allowed_str = ", ".join(allowed_list) if allowed_list else "none"
    effective_env = os.environ if env is None else env
    resolved_home = _resolve_home(home=home, env=effective_env)

    if "all" in deny_set:
        return (
            False,
            f"All harnesses are denied for repository {policy['repo']} by repo policy; allowed harnesses: {allowed_str}.",
            None,
        )

    eng_raw = str(engine or "").strip().lower()
    eng_norm = normalize_deny_token(eng_raw)
    prov_family = _classify_provider_family(provider)
    eng_family = ""
    if eng_norm in _CANONICAL_HARNESS_SET:
        eng_family = eng_norm
    elif eng_norm in ("claude-work", "claude-personal"):
        eng_family = "claude"
    elif ":" in eng_norm and eng_norm.split(":", 1)[0] in _CANONICAL_HARNESS_SET:
        eng_family = eng_norm.split(":", 1)[0]
    else:
        eng_family = _classify_provider_family(eng_raw)

    provider_family = prov_family or eng_family
    explicit_claude_dir = Path(_expand_home(str(claude_config_dir), home=resolved_home)) if claude_config_dir else None

    is_custom_engine_selector = bool(
        eng_raw and eng_raw not in TOKEN_ALIASES and eng_raw != "all" and ":" not in eng_raw and not prov_family
    )
    needs_account_lookup = any(
        tok.startswith(("tag:", "category:", "account:")) or (tok not in _CANONICAL_HARNESS_SET and tok != "all")
        for tok in deny_set
    )
    has_explicit_account_or_home = bool(
        account_id
        or account_alias
        or claude_config_dir is not None
        or codex_home is not None
        or agy_home is not None
        or agy_app_data_dir is not None
        or is_custom_engine_selector
    )
    lookup_claude_dir = claude_config_dir
    lookup_codex_home = codex_home
    lookup_agy_home = agy_home
    lookup_agy_app_dir = agy_app_data_dir
    infer_agy_basename = False
    if (
        lookup_claude_dir is None
        and provider_family == "claude"
        and not account_id
        and not account_alias
        and (needs_account_lookup or home is not None or monitor_config_path is not None or env is not None)
    ):
        orkest_claude_home = (effective_env.get("ORKEST_CLAUDE_ACCOUNT_HOME") or "").strip()
        if orkest_claude_home:
            lookup_claude_dir = Path(_expand_home(orkest_claude_home, home=resolved_home)) / ".claude"
        elif effective_env.get("ORKEST_PINNED_CLAUDE_ACCOUNT") == "1":
            lookup_claude_dir = resolved_home / ".claude"
        else:
            lookup_claude_dir = (effective_env.get("CLAUDE_CONFIG_DIR") or "").strip() or (resolved_home / ".claude")
    if (
        lookup_codex_home is None
        and provider_family == "codex"
        and not has_explicit_account_or_home
        and needs_account_lookup
    ):
        orkest_codex_home = (effective_env.get("ORKEST_CODEX_ACCOUNT_HOME") or "").strip()
        if orkest_codex_home:
            lookup_codex_home = orkest_codex_home
        elif effective_env.get("ORKEST_PINNED_CODEX_ACCOUNT") == "1":
            lookup_codex_home = resolved_home / ".codex"
        else:
            lookup_codex_home = (effective_env.get("CODEX_HOME") or "").strip() or (resolved_home / ".codex")
    if (
        lookup_agy_home is None
        and lookup_agy_app_dir is None
        and provider_family == "agy"
        and not has_explicit_account_or_home
        and needs_account_lookup
    ):
        orkest_agy_home = (effective_env.get("ORKEST_AGY_ACCOUNT_HOME") or "").strip()
        if orkest_agy_home:
            lookup_agy_home = orkest_agy_home
            infer_agy_basename = True
        elif effective_env.get("ORKEST_PINNED_AGY_ACCOUNT") == "1":
            lookup_agy_home = resolved_home / ".gemini"
        else:
            env_agy_app = (effective_env.get("ANTIGRAVITY_APP_DATA_DIR") or "").strip()
            env_gemini = (effective_env.get("GEMINI_CLI_HOME") or "").strip()
            lookup_agy_app_dir = env_agy_app or None
            lookup_agy_home = env_gemini or (None if env_agy_app else (resolved_home / ".gemini"))

    resolved_acct: dict[str, Any] | None = None
    if (
        account_id
        or account_alias
        or lookup_claude_dir is not None
        or lookup_codex_home is not None
        or lookup_agy_home is not None
        or lookup_agy_app_dir is not None
        or is_custom_engine_selector
    ):
        resolved_acct = resolve_configured_account(
            eng_raw if is_custom_engine_selector else None,
            home=resolved_home,
            monitor_config_path=monitor_config_path,
            env=effective_env,
            provider=provider_family or provider,
            account_id=account_id,
            account_alias=account_alias,
            claude_config_dir=lookup_claude_dir,
            codex_home=lookup_codex_home,
            agy_home=lookup_agy_home,
            agy_app_data_dir=lookup_agy_app_dir,
            infer_agy_basename=infer_agy_basename,
            strict=strict,
        )
    elif strict:
        load_configured_accounts(
            home=resolved_home,
            monitor_config_path=monitor_config_path,
            env=effective_env,
            strict=True,
        )

    if not provider_family and resolved_acct is not None:
        provider_family = _classify_provider_family(resolved_acct.get("provider"))

    effective_tags = _collect_effective_tags(tags, billing_mode, eng_norm, resolved_acct)
    eff_id = str(account_id or (resolved_acct or {}).get("id") or "").strip().lower()
    eff_aliases: set[str] = set()
    if account_alias:
        cleaned_alias = str(account_alias).strip().lower()
        if cleaned_alias:
            eff_aliases.add(cleaned_alias)
    if resolved_acct is not None:
        eff_aliases.update(_get_account_aliases(resolved_acct))
    if eng_norm in ("claude-work", "claude-personal") and not eff_id:
        eff_aliases.add(eng_norm)
    if not provider_family and not eff_id and not eff_aliases and eng_raw:
        eff_id = eng_raw
        eff_aliases.add(eng_raw)

    returned_cfg_dir = explicit_claude_dir
    if returned_cfg_dir is None and resolved_acct is not None and provider_family == "claude":
        acct_env = resolved_acct.get("env")
        raw_cfg = _first_nonempty_str(
            resolved_acct.get("claudeConfigDir"),
            resolved_acct.get("claude_config_dir"),
            resolved_acct.get("configDir"),
            acct_env.get("CLAUDE_CONFIG_DIR") if isinstance(acct_env, Mapping) else None,
        )
        if raw_cfg:
            raw_acct_home = acct_env.get("HOME") if isinstance(acct_env, Mapping) else None
            if isinstance(raw_acct_home, str) and raw_acct_home.strip():
                expanded_acct_home = _expand_home(raw_acct_home, home=resolved_home)
                acct_home = (
                    Path(os.path.abspath(expanded_acct_home))
                    if os.path.isabs(expanded_acct_home)
                    else (resolved_home / expanded_acct_home)
                )
            else:
                acct_home = resolved_home
            expanded_cfg = _expand_home(raw_cfg, home=acct_home)
            returned_cfg_dir = Path(
                os.path.abspath(expanded_cfg)
                if os.path.isabs(expanded_cfg)
                else os.path.abspath(acct_home / expanded_cfg)
            )

    for raw_deny in deny_tokens:
        if raw_deny in _CANONICAL_HARNESS_SET:
            if provider_family == raw_deny:
                return (
                    False,
                    f"Harness {provider_family!r} is denied for repository {policy['repo']} by repo policy; "
                    f"allowed harnesses: {allowed_str}.",
                    None,
                )
            continue

        if raw_deny.startswith(("tag:", "category:")):
            tag = raw_deny.split(":", 1)[1]
            if tag and tag in effective_tags:
                return (
                    False,
                    f"Harness {provider_family or eng_raw!r} (denied by {raw_deny!r}) is denied for repository "
                    f"{policy['repo']} by repo policy; allowed harnesses: {allowed_str}.",
                    None,
                )
            continue

        if raw_deny.startswith("account:"):
            acct_tok = raw_deny.split(":", 1)[1]
            if acct_tok and (acct_tok == eff_id or acct_tok in eff_aliases):
                display = account_id or account_alias or eff_id or acct_tok
                return (
                    False,
                    f"Account {display!r} is denied for repository {policy['repo']} by repo policy; "
                    f"allowed harnesses: {allowed_str}.",
                    None,
                )
            continue

        if raw_deny == "claude-work":
            if (provider_family == "claude" and "work" in effective_tags) or (
                eff_id == "claude-work" or "claude-work" in eff_aliases
            ):
                return (
                    False,
                    f"Harness 'claude-work' is denied for repository {policy['repo']} by repo policy; "
                    f"allowed harnesses: {allowed_str}.",
                    None,
                )
            continue

        if raw_deny == "claude-personal":
            if (provider_family == "claude" and "personal" in effective_tags) or (
                eff_id == "claude-personal" or "claude-personal" in eff_aliases
            ):
                return (
                    False,
                    f"Harness 'claude-personal' is denied for repository {policy['repo']} by repo policy; "
                    f"allowed harnesses: {allowed_str}.",
                    None,
                )
            continue

        if ":" in raw_deny:
            raw_prov, tag_part = raw_deny.split(":", 1)
            prov_part = TOKEN_ALIASES.get(raw_prov, raw_prov)
            if prov_part and tag_part and provider_family == prov_part and tag_part in effective_tags:
                return (
                    False,
                    f"Harness {provider_family!r} (denied by {raw_deny!r}) is denied for repository "
                    f"{policy['repo']} by repo policy; allowed harnesses: {allowed_str}.",
                    None,
                )
            continue

        if raw_deny in effective_tags:
            return (
                False,
                f"Harness {provider_family or eng_raw!r} (denied by tag {raw_deny!r}) is denied for repository "
                f"{policy['repo']} by repo policy; allowed harnesses: {allowed_str}.",
                None,
            )

        if raw_deny == eff_id or raw_deny in eff_aliases:
            display = account_id or account_alias or eff_id or raw_deny
            return (
                False,
                f"Account {display!r} is denied for repository {policy['repo']} by repo policy; "
                f"allowed harnesses: {allowed_str}.",
                None,
            )

    return (True, None, returned_cfg_dir)
