"""Live subscription quota per executor route, read from monitor at decision time. Nothing is stored.

monitor (orkest/plugins/monitor) reports each account's rate-limit windows and ranks its
pools. This module maps an engine and model onto the pool that pays for it, so the conductor can see
whether a route can take a run now and the runner can refuse to launch into an exhausted one.

A pool whose included allowance is used up but that has a credit balance (Codex/ChatGPT) has status
"credits": every request there is billed against the balance, so a run is refused unless the user
allows credits, and a running Codex job stops once its account starts spending them (credit_spend).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import ssl
import subprocess
import urllib.request
from pathlib import Path
from typing import Any

SCHEMA_PREFIX = "monitor.snapshot."
LOW_USABLE_PCT = 10
EXIT_QUOTA_EXHAUSTED = 15
OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"
LOW_CREDIT_USD = 1


def monitor_command() -> str | None:
    override = os.environ.get("MONITOR_BIN")
    if override:
        return override
    found = shutil.which("monitor")
    if found:
        return found
    fallback = Path.home() / ".local" / "bin" / "monitor"
    return str(fallback) if os.access(fallback, os.X_OK) else None


def snapshot(timeout: float = 95) -> dict[str, Any] | None:
    """Current monitor view, or None when monitor is missing or fails. Unknown quota is never zero."""
    command = monitor_command()
    if not command:
        return None
    try:
        completed = subprocess.run(
            [command, "json"],
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "NO_COLOR": "1"},
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    try:
        view = json.loads(completed.stdout)
    except ValueError:
        return None
    return view if str(view.get("schema", "")).startswith(SCHEMA_PREFIX) else None


def route_for(engine: str, model: str) -> tuple[str, str | None] | None:
    """(monitor provider, pool id) that pays for a run, or None for metered/unmonitored engines."""
    lowered = model.lower()
    if engine == "codex":
        return "codex", None
    if engine == "agy":
        if lowered.startswith("gemini"):
            return "antigravity", "gemini"
        if lowered.startswith(("claude", "gpt")):
            return "antigravity", "claude-gpt"
        return "antigravity", None
    if engine == "claude":
        return "claude", None
    return None


def _normalize_tags(*values: Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        items = value if isinstance(value, (list, tuple, set)) else [value]
        for item in items:
            if not isinstance(item, str):
                continue
            cleaned = item.strip().lower()
            if cleaned and cleaned not in seen:
                seen.add(cleaned)
                result.append(cleaned)
    return result


def _canonical_path(target: str | Path) -> Path:
    raw = str(target).strip()
    expanded = Path(os.path.expanduser(raw))
    if not expanded.is_absolute():
        expanded = Path.home() / expanded
    try:
        return expanded.resolve()
    except OSError:
        return Path(os.path.abspath(str(expanded)))


def _agy_home_from_path(target: str | Path) -> Path:
    path = _canonical_path(target)
    return path.parent if path.name.startswith("antigravity") else path


def _load_monitor_accounts_by_id() -> dict[str, dict[str, Any]]:
    raw_override = os.environ.get("MONITOR_CONFIG")
    cfg_path = (
        Path(raw_override).expanduser()
        if isinstance(raw_override, str) and raw_override.strip()
        else Path.home() / ".config" / "monitor" / "config.json"
    )
    try:
        loaded = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(loaded, dict) or not isinstance(loaded.get("accounts"), list):
        return {}
    return {
        acct["id"]: acct
        for acct in loaded["accounts"]
        if isinstance(acct, dict) and isinstance(acct.get("id"), str) and acct["id"]
    }


def _resolved_configured_home(account: dict[str, Any], provider: str) -> Path | None:
    env = account.get("env") if isinstance(account.get("env"), dict) else {}
    if provider == "claude":
        raw_cfg = account.get("claudeConfigDir") or account.get("configDir") or env.get("CLAUDE_CONFIG_DIR")
        if isinstance(raw_cfg, str) and raw_cfg.strip():
            return _canonical_path(raw_cfg)
        raw_home = env.get("HOME")
        if isinstance(raw_home, str) and raw_home.strip():
            return _canonical_path(Path(os.path.expanduser(raw_home)) / ".claude")
        return None
    if provider == "codex":
        raw_codex = account.get("codexHome") or env.get("CODEX_HOME")
        if isinstance(raw_codex, str) and raw_codex.strip():
            return _canonical_path(raw_codex)
        raw_home = env.get("HOME")
        if isinstance(raw_home, str) and raw_home.strip():
            return _canonical_path(Path(os.path.expanduser(raw_home)) / ".codex")
        return None
    if provider == "antigravity":
        raw_gemini = env.get("GEMINI_CLI_HOME")
        if isinstance(raw_gemini, str) and raw_gemini.strip():
            return _canonical_path(raw_gemini)
        raw_app = env.get("ANTIGRAVITY_APP_DATA_DIR")
        if isinstance(raw_app, str) and raw_app.strip():
            return _agy_home_from_path(raw_app)
        raw_home = env.get("HOME")
        if isinstance(raw_home, str) and raw_home.strip():
            return _canonical_path(Path(os.path.expanduser(raw_home)) / ".gemini")
        return None
    return None


def pool_lanes(engine: str, model: str, view: dict[str, Any]) -> list[dict[str, Any]]:
    """Every account's lane for this route, best first (monitor ranks lanes)."""
    route = route_for(engine, model)
    if route is None:
        return []
    provider, pool = route
    configured_accounts = _load_monitor_accounts_by_id()
    accounts = {account["id"]: account for account in view.get("accounts", []) if isinstance(account, dict)}
    # An "error" lane means monitor has no data for that account at all: unknown, not empty.
    lanes = [
        lane
        for lane in view.get("lanes", [])
        if accounts.get(lane.get("accountId"), {}).get("provider") == provider and lane.get("status") != "error"
    ]
    chosen: list[dict[str, Any]] = []
    for account_id in dict.fromkeys(lane["accountId"] for lane in lanes):
        own = [lane for lane in lanes if lane["accountId"] == account_id]
        if pool:
            match = [lane for lane in own if lane.get("poolId") == pool]
        else:
            # A model-specific limit (Codex per-model ids, Claude's per-model weekly cap) binds before the
            # account-wide one, so prefer a pool named after the model.
            match = [lane for lane in own if lane.get("poolId") and lane["poolId"] in model.lower()]
            match = match or [lane for lane in own if lane.get("poolId") in ("codex", "all")] or own
        if match:
            account = accounts.get(account_id, {})
            cfg_account = configured_accounts.get(account_id, {})
            config_dir = (
                account.get("claudeConfigDir")
                or account.get("configDir")
                or account.get("config_dir")
                or cfg_account.get("claudeConfigDir")
                or cfg_account.get("configDir")
                or match[0].get("configDir")
                or match[0].get("config_dir")
            )
            account_home = (
                account.get("accountHome")
                or account.get("account_home")
                or cfg_account.get("accountHome")
                or match[0].get("accountHome")
            )
            if account_home is None:
                resolved_cfg_home = _resolved_configured_home(cfg_account, provider)
                if resolved_cfg_home is not None:
                    account_home = str(resolved_cfg_home)
            tags = _normalize_tags(
                account.get("tags"),
                account.get("category"),
                cfg_account.get("tags"),
                cfg_account.get("category"),
            )
            category = account.get("category") or cfg_account.get("category")
            billing = account.get("billing") or cfg_account.get("billing")
            alias = account.get("alias") or cfg_account.get("alias")
            aliases = [
                item.strip()
                for src in (account.get("aliases"), cfg_account.get("aliases"))
                if isinstance(src, (list, tuple))
                for item in src
                if isinstance(item, str) and item.strip()
            ]
            unset_claude_dir = account.get("unsetClaudeConfigDir")
            chosen.append(
                {
                    **match[0],
                    "billing": billing,
                    **({"category": category} if category is not None else {}),
                    **({"tags": tags} if tags else {}),
                    **({"alias": alias} if alias is not None else {}),
                    **({"aliases": aliases} if aliases else {}),
                    **({"configDir": config_dir} if config_dir is not None else {}),
                    **({"accountHome": account_home} if account_home is not None else {}),
                    **({"unsetClaudeConfigDir": bool(unset_claude_dir)} if unset_claude_dir is not None else {}),
                }
            )
    return chosen


def assess(lane: dict[str, Any]) -> str:
    status = lane.get("status")
    if status in ("blocked", "credits"):
        return status
    if lane.get("stale"):
        # Old data saying there is room may hide a pool that has since moved onto credits.
        return "unknown"
    usable = lane.get("availableNowPct")
    if usable is None or not isinstance(usable, int | float) or isinstance(usable, bool):
        return "unknown"
    if usable < LOW_USABLE_PCT:
        return "low"
    return "available"


def _prefer_claude_pool(candidates: list[dict[str, Any]], model: str | None) -> dict[str, Any]:
    lowered = model.lower() if model else ""
    target_pool = "fable" if ("fable" in lowered or "mythos" in lowered) else "all"
    for lane in candidates:
        if lane.get("poolId") == target_pool:
            return lane
    return candidates[0]


def _prefer_pool(candidates: list[dict[str, Any]], engine: str, model: str | None) -> dict[str, Any]:
    if engine == "claude":
        return _prefer_claude_pool(candidates, model)
    return candidates[0]


def _lane_paths(lane: dict[str, Any]) -> set[Path]:
    paths: set[Path] = set()
    for key in ("configDir", "config_dir", "claudeConfigDir", "accountHome", "account_home"):
        raw = lane.get(key)
        if isinstance(raw, str) and raw.strip():
            paths.add(_canonical_path(raw))
    return paths


def _lane_tags(lane: dict[str, Any]) -> set[str]:
    return set(_normalize_tags(lane.get("tags"), lane.get("category"), lane.get("billing")))


_STATUS_RANK = {"available": 0, "low": 1, "unknown": 2, "credits": 3, "blocked": 4}


def _lane_rank(lane: dict[str, Any]) -> tuple[int, bool, float, float]:
    status = assess(lane)
    surplus = lane.get("surplusPts")
    usable = lane.get("availableNowPct")
    surplus_val = float(surplus) if isinstance(surplus, int | float) and not isinstance(surplus, bool) else -1e9
    usable_val = float(usable) if isinstance(usable, int | float) and not isinstance(usable, bool) else -1.0
    return (_STATUS_RANK.get(status, 5), bool(lane.get("stale")), -surplus_val, -usable_val)


def _best_account_lane(candidates: list[dict[str, Any]], *, engine: str, model: str | None) -> dict[str, Any]:
    by_account: dict[str, list[dict[str, Any]]] = {}
    for lane in candidates:
        acct_id = str(lane.get("accountId") or "")
        by_account.setdefault(acct_id, []).append(lane)
    per_account = [_prefer_pool(group, engine, model) for group in by_account.values()]
    return min(per_account, key=_lane_rank)


def route_account_lane(
    lanes: list[dict[str, Any]],
    *,
    engine: str,
    model: str | None = None,
    account_id: str | None = None,
    account_alias: str | None = None,
    claude_config_dir: str | Path | None = None,
    codex_home: str | Path | None = None,
    agy_home: str | Path | None = None,
    tags: list[str] | tuple[str, ...] | None = None,
    category: str | None = None,
    billing: str | None = None,
    allowed_account_ids: set[str] | frozenset[str] | None = None,
) -> dict[str, Any] | None:
    """Select the matching lane across N accounts per provider:
    accountId/alias -> canonical configDir/accountHome -> explicit tags/category -> highest-surplus allowed account.
    """
    candidates = [lane for lane in lanes if allowed_account_ids is None or lane.get("accountId") in allowed_account_ids]
    if not candidates:
        return None

    if account_id is not None and account_id.strip():
        target_id = account_id.strip().lower()
        exact_id = [lane for lane in candidates if str(lane.get("accountId") or "").strip().lower() == target_id]
        return _best_account_lane(exact_id, engine=engine, model=model) if exact_id else None

    if account_alias is not None and account_alias.strip():
        target_alias = account_alias.strip().lower()

        def _matches_alias(lane: dict[str, Any]) -> bool:
            if str(lane.get("alias") or "").strip().lower() == target_alias:
                return True
            if str(lane.get("accountId") or "").strip().lower() == target_alias:
                return True
            raw_aliases = lane.get("aliases")
            if isinstance(raw_aliases, (list, tuple, set)):
                return any(isinstance(item, str) and item.strip().lower() == target_alias for item in raw_aliases)
            return False

        exact_alias = [lane for lane in candidates if _matches_alias(lane)]
        return _best_account_lane(exact_alias, engine=engine, model=model) if exact_alias else None

    target_home: Path | None = None
    explicit_home_requested = False
    if engine == "claude":
        if claude_config_dir is not None and str(claude_config_dir).strip():
            target_home = _canonical_path(claude_config_dir)
            explicit_home_requested = True
        elif os.environ.get("ORKEST_CLAUDE_ACCOUNT_HOME", "").strip():
            target_home = _canonical_path(Path(os.environ["ORKEST_CLAUDE_ACCOUNT_HOME"]).expanduser() / ".claude")
            explicit_home_requested = True
        else:
            target_home = _canonical_path(Path.home() / ".claude")
    elif engine == "codex":
        raw_codex = codex_home or os.environ.get("ORKEST_CODEX_ACCOUNT_HOME") or os.environ.get("CODEX_HOME")
        if raw_codex is not None and str(raw_codex).strip():
            target_home = _canonical_path(raw_codex)
            explicit_home_requested = True
    elif engine == "agy":
        if agy_home is not None and str(agy_home).strip():
            target_home = _agy_home_from_path(agy_home)
            explicit_home_requested = True
        elif os.environ.get("ORKEST_AGY_ACCOUNT_HOME", "").strip():
            target_home = _agy_home_from_path(os.environ["ORKEST_AGY_ACCOUNT_HOME"])
            explicit_home_requested = True
        elif os.environ.get("GEMINI_CLI_HOME", "").strip():
            target_home = _canonical_path(os.environ["GEMINI_CLI_HOME"])
            explicit_home_requested = True
        elif os.environ.get("ANTIGRAVITY_APP_DATA_DIR", "").strip():
            target_home = _agy_home_from_path(os.environ["ANTIGRAVITY_APP_DATA_DIR"])
            explicit_home_requested = True

    if target_home is not None:
        exact_home = [lane for lane in candidates if target_home in _lane_paths(lane)]
        if not exact_home and engine == "claude" and target_home == _canonical_path(Path.home() / ".claude"):
            exact_home = [
                lane
                for lane in candidates
                if lane.get("unsetClaudeConfigDir") is True
                and (not _lane_paths(lane) or target_home in _lane_paths(lane))
            ]
        if exact_home:
            return _best_account_lane(exact_home, engine=engine, model=model)

    requested_tags = set(_normalize_tags(tags, category, billing))
    if not requested_tags and explicit_home_requested and target_home is not None:
        dir_name = target_home.name.lower().lstrip(".")
        suffix = dir_name.removeprefix("claude-").removeprefix("codex-").removeprefix("gemini-")
        if suffix and suffix not in ("claude", "codex", "gemini"):
            requested_tags = {suffix}

    if requested_tags:
        all_match = [lane for lane in candidates if requested_tags.issubset(_lane_tags(lane))]
        if all_match:
            return _best_account_lane(all_match, engine=engine, model=model)
        any_match = [lane for lane in candidates if _lane_tags(lane) & requested_tags]
        if any_match:
            return _best_account_lane(any_match, engine=engine, model=model)
        alias_id_match = [
            lane
            for lane in candidates
            if str(lane.get("accountId") or "").strip().lower() in requested_tags
            or str(lane.get("alias") or "").strip().lower() in requested_tags
        ]
        if alias_id_match:
            return _best_account_lane(alias_id_match, engine=engine, model=model)

    return _best_account_lane(candidates, engine=engine, model=model)


def _match_claude_lane(
    lanes: list[dict[str, Any]],
    claude_config_dir: str | Path | None = None,
    *,
    model: str | None = None,
) -> dict[str, Any]:
    matched = route_account_lane(lanes, engine="claude", model=model, claude_config_dir=claude_config_dir)
    return matched if matched is not None else _prefer_claude_pool(lanes, model)


def check(
    engine: str,
    model: str,
    view: dict[str, Any] | None,
    *,
    claude_config_dir: str | Path | None = None,
    account_id: str | None = None,
    account_alias: str | None = None,
    codex_home: str | Path | None = None,
    agy_home: str | Path | None = None,
    tags: list[str] | tuple[str, ...] | None = None,
    category: str | None = None,
    allowed_account_ids: set[str] | frozenset[str] | None = None,
) -> dict[str, Any]:
    """Whether a run on engine/model can start now: available, low, credits, blocked, unknown or not_applicable."""
    if route_for(engine, model) is None:
        return {"status": "not_applicable", "detail": f"{engine} bills per request; no subscription window to check"}
    if view is None:
        return {"status": "unknown", "detail": "monitor is not installed or did not answer"}
    lanes = pool_lanes(engine, model, view)
    if not lanes:
        provider = route_for(engine, model)[0]
        providers = {account["id"]: account.get("provider") for account in view.get("accounts", [])}
        failed = [
            lane
            for lane in view.get("lanes", [])
            if lane.get("status") == "error" and providers.get(lane.get("accountId")) == provider
        ]
        detail = failed[0].get("advice") if failed else f"monitor has no pool for {engine} {model}"
        return {"status": "unknown", "detail": detail}
    lane = route_account_lane(
        lanes,
        engine=engine,
        model=model,
        account_id=account_id,
        account_alias=account_alias,
        claude_config_dir=claude_config_dir,
        codex_home=codex_home,
        agy_home=agy_home,
        tags=tags,
        category=category,
        allowed_account_ids=allowed_account_ids,
    )
    if lane is None:
        return {"status": "unknown", "detail": f"monitor has no allowed pool for {engine} {model}"}
    return {"status": assess(lane), **summary(lane)}


check_quota = check


def summary(lane: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "label",
        "accountId",
        "poolId",
        "billing",
        "category",
        "tags",
        "alias",
        "credits",
        "availableNowPct",
        "weeklyRemainingPct",
        "surplusPts",
        "blockedUntil",
        "expiring",
        "expiresAt",
        "burnPctPerHour",
        "advice",
        "stale",
    )
    return {key: lane.get(key) for key in keys}


def openrouter_key() -> str | None:
    """The OpenRouter key OpenCode uses: OPENROUTER_API_KEY, else OpenCode's stored auth."""
    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ["OPENROUTER_API_KEY"]
    data_home = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    try:
        auth = json.loads((data_home / "opencode" / "auth.json").read_text())
    except (OSError, ValueError):
        return None
    key = auth.get("openrouter", {}).get("key") if isinstance(auth, dict) else None
    return key if isinstance(key, str) and key else None


def tls_context() -> ssl.SSLContext:
    """Default trust plus any extra CA bundle the environment names (corporate TLS inspection)."""
    context = ssl.create_default_context()
    for variable in ("SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE"):
        bundle = os.environ.get(variable)
        if bundle and os.path.isfile(bundle):
            context.load_verify_locations(bundle)
    return context


def openrouter_credit(timeout: float = 15) -> dict[str, Any] | None:
    """Remaining OpenRouter account credit in USD, or None when there is no key or the API fails."""
    key = openrouter_key()
    if not key:
        return None
    request = urllib.request.Request(OPENROUTER_CREDITS_URL, headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=tls_context()) as response:
            data = json.loads(response.read()).get("data", {})
        total, used = float(data["total_credits"]), float(data["total_usage"])
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None
    return {"totalUsd": total, "usedUsd": used, "remainingUsd": total - used}


def credit_row(credit: dict[str, Any] | None) -> dict[str, Any]:
    row = {"engine": "opencode", "models": "openrouter/*"}
    if credit is None:
        return {
            **row,
            "status": "unknown",
            "detail": "OpenRouter credit unreadable (no key, or the API did not answer)",
        }
    remaining = credit["remainingUsd"]
    status = "blocked" if remaining <= 0 else "low" if remaining < LOW_CREDIT_USD else "available"
    return {**row, "status": status, **credit, "detail": f"${remaining:.2f} OpenRouter credit left"}


ROUTES = (
    ("codex", "gpt-*", "codex"),
    ("agy", "gemini-*", "gemini"),
    ("agy", "claude-* / gpt-oss-*", "claude-gpt"),
)


def route_table(view: dict[str, Any] | None, credit: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Quota for every route agent-executor can dispatch to, plus the native Claude accounts for reference.

    OpenCode's row is OpenRouter's remaining dollar credit (from openrouter_credit()), not a window.
    """
    rows = []
    for engine, models, sample in ROUTES:
        probe = {"codex": "gpt", "gemini": "gemini", "claude-gpt": "claude"}[sample]
        result = check(engine, probe, view)
        rows.append({"engine": engine, "models": models, **result})
    if view is not None:
        for lane in pool_lanes("claude", "claude", view):
            rows.append(
                {"engine": "claude (native host)", "models": "claude-*", "status": assess(lane), **summary(lane)}
            )
    rows.append(credit_row(credit))
    return rows


def credits_text(row: dict[str, Any]) -> str:
    """Describe a route running on a credit balance: "on credits, 62,168.59 cr left"."""
    credits = row.get("credits") or {}
    return f"on credits, {credits.get('text', 'balance unknown')} left"


def blocked_message(engine: str, model: str, result: dict[str, Any], view: dict[str, Any] | None) -> str:
    until = result.get("blockedUntil")
    when = f" until {until}" if until else ""
    rows = [
        row
        for row in route_table(view)
        if row["engine"] in ("codex", "agy") and row.get("label") != result.get("label")
    ]
    alternatives = [
        f"--engine {row['engine']} ({row['models']}): {row['label']}, {round(row['availableNowPct'])}% usable now"
        for row in rows
        if row["status"] in ("available", "low")
    ]
    on_credits = [
        f"--engine {row['engine']}: {row['label']}, {credits_text(row)}" for row in rows if row["status"] == "credits"
    ]
    text = f"{result.get('label', engine)} quota is exhausted{when}; a {engine} run on {model} would stall."
    if alternatives:
        text += " Routes with quota now: " + "; ".join(alternatives) + "."
    if on_credits:
        text += " On credits, only with the user's permission (--allow-credits): " + "; ".join(on_credits) + "."
    return text + " Pass --ignore-quota only when the user asks to launch anyway."


def credits_message(engine: str, model: str, result: dict[str, Any]) -> str:
    """Why a run onto a pool on credits is refused."""
    back = result.get("blockedUntil")
    when = f"; its included quota returns at {back}" if back else ""
    return (
        f"{result.get('label', engine)} has used its included quota and is {credits_text(result)}{when}. "
        f"A {engine} run on {model} would be billed to that balance, so it is refused. "
        "Pass --allow-credits only when the user allows spending credits."
    )


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def rollout_records(text: str, since: dt.datetime | None = None) -> list[dict[str, Any]]:
    """JSON records in Codex session-log (rollout) lines, oldest first. With `since`, lines stamped earlier
    are skipped, so a resumed session's history does not count against a new run."""
    records = []
    for line in text.splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        if since is not None and isinstance(record.get("timestamp"), str):
            try:
                if dt.datetime.fromisoformat(record["timestamp"].replace("Z", "+00:00")) < since:
                    continue
            except ValueError:
                pass
        records.append(record)
    return records


def rate_limit_snapshots(
    text: str, since: dt.datetime | None = None, *, records: list[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """The rate_limits objects in Codex session-log (rollout) lines, oldest first. With `since`, lines
    stamped earlier are skipped, so a resumed session's history does not count against a new run."""
    found = []
    for record in rollout_records(text, since=since) if records is None else records:
        stack: list[Any] = [record]
        while stack:
            item = stack.pop()
            if isinstance(item, dict):
                if isinstance(item.get("rate_limits"), dict):
                    found.append(item["rate_limits"])
                stack.extend(value for key, value in item.items() if key != "rate_limits")
            elif isinstance(item, list):
                stack.extend(item)
    return found


def valid_rate_limits(snapshot: Any) -> bool:
    """Whether a rate_limits object has the window or credit fields credit_spend relies on."""
    if not isinstance(snapshot, dict):
        return False
    has_window = any(
        isinstance(snapshot.get(key), dict) and _number(snapshot[key].get("used_percent")) is not None
        for key in ("primary", "secondary")
    )
    credits = snapshot.get("credits")
    has_credits = isinstance(credits, dict) and any(key in credits for key in ("balance", "has_credits", "unlimited"))
    return has_window or has_credits


def credit_spend(previous: dict[str, Any] | None, current: dict[str, Any]) -> str | None:
    """Why a Codex account is spending credits, judged from two successive rate_limits snapshots, or None.

    Holding a balance is not spending it. Spending is: spend control reached, a balance that falls between
    snapshots (any session on the account may cause it), or an included allowance used up in either window
    while a balance remains, so requests continue on credits. Used up with no balance is "blocked", which
    Codex reports itself; it is not a credits stop.
    """
    if current.get("spend_control_reached"):
        return "spend_control_reached"
    credits = current.get("credits") if isinstance(current.get("credits"), dict) else {}
    earlier = (previous or {}).get("credits") if isinstance((previous or {}).get("credits"), dict) else {}
    balance, before = _number(credits.get("balance")), _number(earlier.get("balance"))
    if balance is not None and before is not None and balance < before:
        return "account_balance_falling"
    windows = [current.get(key) for key in ("primary", "secondary")]
    used_up = bool(current.get("rate_limit_reached_type")) or any(
        isinstance(window, dict) and (_number(window.get("used_percent")) or 0) >= 100 for window in windows
    )
    if used_up and (credits.get("has_credits") or credits.get("unlimited")):
        return "allowance_used_up_on_credits"
    return None


# Engines the runner can dispatch to from any host (a Claude host uses its native sub-agents for Claude).
DISPATCHABLE = ("codex", "agy", "claude")


def access_records(
    view: dict[str, Any] | None, registry: dict[str, Any], host: str | None = None
) -> list[dict[str, Any]]:
    """Observed-access records for conductor_policy.recommend(), built from live quota.

    One record per profile model and account, for routes this host can actually use: the runner's
    engines plus the host's own models. Personal accounts are marked personal_subscription so
    recommend() keeps excluding them unless the packet authorizes personal quota. A pool on credits is
    not available: every request there is billed to a balance, which needs the user's permission.
    """
    observed_at = dt.datetime.now(dt.UTC).isoformat()
    records = []
    for profile in registry.get("profiles", []):
        profile_engine = profile.get("engine")
        for model in profile.get("model_ids", []):
            engine = (
                profile_engine
                if profile_engine in DISPATCHABLE
                else "codex"
                if model.startswith("gpt")
                else "agy"
                if model.startswith("gemini")
                else "claude"
                if model.startswith("claude") or model in {"opus", "sonnet", "haiku", "fable", "mythos"}
                else None
            )
            if engine is None or (engine not in DISPATCHABLE and engine != host):
                continue
            lanes = pool_lanes(engine, model, view) if view is not None else []
            if not lanes:
                records.append(
                    {
                        "model": model,
                        "engine": engine,
                        "available": True,
                        "observed_at": observed_at,
                        "source": "monitor:unknown",
                        "billing_mode": "unknown",
                        "quota": None,
                    }
                )
                continue
            for lane in lanes:
                billing = str(lane.get("billing") or "").strip().lower()
                category = str(lane.get("category") or "").strip().lower()
                lane_tags = set(_normalize_tags(lane.get("tags")))
                status = assess(lane)
                if billing == "personal" or category == "personal" or "personal" in lane_tags:
                    billing_mode = "personal_subscription"
                elif status == "credits":
                    billing_mode = "credits"
                else:
                    billing_mode = "subscription"
                records.append(
                    {
                        "model": model,
                        "engine": engine,
                        "available": status not in ("blocked", "credits"),
                        "observed_at": observed_at,
                        "source": f"monitor:{lane['accountId']}",
                        "billing_mode": billing_mode,
                        "quota": {"status": status, **summary(lane)},
                    }
                )
    return records
