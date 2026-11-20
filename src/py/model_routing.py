"""Model catalog discovery, caching, and live model/family/route resolution for orchestrate."""

from __future__ import annotations

import argparse
import contextlib
import difflib
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows falls back to atomic replacement.
    fcntl = None  # type: ignore[assignment]

DEFAULT_ENGINE = "codex"
EXECUTION_ENGINES = ("codex", "agy", "opencode", "claude")
CATALOG_ENGINES = EXECUTION_ENGINES
PREFERRED_MODELS = {
    "codex": "gpt:luna",
    "agy": "gemini:fast",
    "opencode": "glm:flash",
    "claude": "opus",
}
CLAUDE_MODEL_ID = re.compile(r"^claude-[a-z0-9][a-z0-9.\-]*(\[1m\])?$")
EXIT_ROUTE_NOT_ALLOWED = 17
DEFAULT_CATALOG_MAX_AGE_SECONDS = 24 * 60 * 60
MODEL_CATALOG_SCHEMA = "agent-executor.models.v1"
MODEL_CACHE_SCHEMA = "agent-executor.model-cache.v1"
_REQUIRED_CAPABILITY_KEYS = (
    "vendor",
    "family_stem",
    "supported_efforts",
    "effort_slug",
    "composite",
    "observed_resolved_ids",
)


def _claude_model_aliases(families: dict[str, dict[str, Any]] | None = None) -> tuple[str, ...]:
    return _attr("families_module")().claude_aliases(families)


def _claude_model_shorthands(families: dict[str, dict[str, Any]] | None = None) -> dict[str, str]:
    return _attr("families_module")().claude_shorthands(families)


def _claude_versioned_pattern(families: dict[str, dict[str, Any]] | None = None) -> re.Pattern[str] | None:
    stems = _attr("families_module")().claude_versioned_stems(families)
    if not stems:
        return None
    joined = "|".join(re.escape(stem) for stem in stems)
    return re.compile(rf"^(?:claude-)?({joined})-(\d+(?:[.-]\d+)*)(\[1m\])?$", re.IGNORECASE)


def __getattr__(name: str) -> Any:
    if name == "CLAUDE_MODEL_ALIASES":
        return _claude_model_aliases()
    if name == "_NATIVE_FAMILIES":
        return _attr("families_module")().native_family_specs()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def normalize_claude_model_id(model: str) -> str:
    stripped = model.strip()
    lowered = stripped.lower()
    shorthands = _claude_model_shorthands()
    if lowered in shorthands:
        return shorthands[lowered]
    pattern = _claude_versioned_pattern()
    match = pattern.match(stripped) if pattern is not None else None
    if match:
        family, version, suffix = match.groups()
        normalized_ver = version.replace(".", "-")
        return f"claude-{family.lower()}-{normalized_ver}{(suffix or '').lower()}"
    return stripped


def parse_bare_tier_selector(
    engine: str,
    selector: str,
    families: dict[str, dict[str, Any]],
) -> tuple[str, str] | None:
    mod = _attr("families_module")()
    lowered = selector.strip().lower()
    aliases = mod.bare_tier_aliases(families)
    alias = aliases.get((engine, lowered))
    if alias and alias[0] in families and alias[1] in families[alias[0]].get("tiers", {}):
        return alias
    default_family = mod.engine_default_families(families).get(engine)
    if default_family and default_family in families and lowered in families[default_family].get("tiers", {}):
        return default_family, lowered
    return None


# How each select_live_model() outcome was checked against the live catalog, for the result record.
MODEL_PREFLIGHT = {
    "exact_user_request": "live_exact_match",
    "validated_preference": "live_exact_match",
    "family_latest": "live_family_resolved",
    "unverified_claude_id": "unverified_claude_id",
}


def _runner() -> Any:
    mod = globals().get("_runner_module")
    if mod is not None and hasattr(mod, "RunnerError"):
        return mod
    for key in ("run_agent", "agent_executor_run_agent", "__main__"):
        candidate = sys.modules.get(key)
        if candidate is not None and hasattr(candidate, "RunnerError"):
            return candidate
    return None


def _attr(name: str, default: Any = None) -> Any:
    runner = _runner()
    if runner is not None:
        try:
            return getattr(runner, name)
        except AttributeError:
            pass
    if name in globals():
        return globals()[name]
    return default


def _runner_error(message: str, exit_code: int = 2) -> Exception:
    error_cls = _attr("RunnerError", ValueError)
    try:
        return error_cls(message, exit_code)
    except TypeError:
        return error_cls(message)


def _bundled_module(name: str) -> Any:
    bundled = _attr("bundled_module")
    if callable(bundled):
        return bundled(name)
    import importlib.util

    module_path = Path(__file__).with_name(name + ".py")
    spec = importlib.util.spec_from_file_location("agent_executor_" + name, module_path)
    if spec is None or spec.loader is None:
        raise _runner_error(f"could not load bundled module {name!r}", 4)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def parse_models_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=f"{Path(sys.argv[0]).name} models",
        description="Retrieve normalized live model catalogs without invoking a model.",
    )
    parser.add_argument(
        "--engine",
        action="append",
        choices=CATALOG_ENGINES,
        help="Catalog to query; repeatable (default: every platform)",
    )
    parser.add_argument(
        "--format",
        choices=("table", "json"),
        default="table",
        help="Output format (default: table)",
    )
    parser.add_argument(
        "--include-hidden",
        action="store_true",
        help="Include provider-hidden/internal models in table output",
    )
    parser.add_argument(
        "--match",
        action="append",
        default=[],
        help="Case-insensitive model-ID substring filter; repeatable",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Ask providers that support it to refresh their local catalog",
    )
    return parser.parse_args(argv)


def cli_version(executable: str, environment: dict[str, str]) -> str:
    result = _attr("run_checked")([executable, "--version"], timeout=15, environment=environment)
    stdout = result.stdout.decode("utf-8", errors="replace").strip()
    stderr = result.stderr.decode("utf-8", errors="replace").strip()
    return stdout or stderr or "unknown"


def normalized_option_values(values: Any, *, keys: tuple[str, ...]) -> list[str]:
    if not isinstance(values, list):
        return []
    normalized: list[str] = []
    for value in values:
        candidate: Any = value
        if isinstance(value, dict):
            candidate = next(
                (value[key] for key in keys if isinstance(value.get(key), str)),
                None,
            )
        if isinstance(candidate, str) and candidate not in normalized:
            normalized.append(candidate)
    return normalized


def _split_effort_suffix(model_id: str, suffixes: tuple[str, ...]) -> tuple[str, str | None]:
    head, sep, tail = model_id.rpartition("-")
    if sep and head and tail.lower() in suffixes:
        return head, tail.lower()
    return model_id, None


def _infer_vendor(model_id: str, families: dict[str, dict[str, Any]] | None = None) -> str | None:
    lowered = model_id.strip().lower()
    if not lowered:
        return None
    if "/" in lowered:
        segments = [seg.lstrip("~") for seg in lowered.split("/") if seg]
        if len(segments) >= 3 and segments[0] == "openrouter":
            return segments[1]
        if segments and segments[0] != "opencode":
            return segments[0]
        leaf = segments[-1] if segments else lowered
    else:
        leaf = lowered
    mod = _attr("families_module")()
    loaded = families if families is not None else mod.load_families()
    tokens = [tok for tok in re.split(r"[-_.:~]", leaf) if tok]
    if len(tokens) >= 2 and tokens[0] == "gpt" and tokens[1] == "oss":
        return "openai"
    if "gemma" in tokens:
        return "google"
    for family in loaded.values():
        if not isinstance(family, dict):
            continue
        vendor = family.get("vendor")
        if not isinstance(vendor, str) or not vendor.strip():
            continue
        prefix = family.get("prefix")
        if isinstance(prefix, str) and prefix and leaf.startswith(prefix.lower()):
            return vendor.strip().lower()
        keywords = {str(k).lower() for k in (family.get("native_keywords") or []) if isinstance(k, str)}
        if keywords.intersection(tokens):
            return vendor.strip().lower()
    if "/" in lowered and lowered.startswith("opencode/"):
        return "opencode"
    return None


def _codex_stem_and_tier(model_id: str, families: dict[str, dict[str, Any]] | None = None) -> tuple[str, str | None]:
    mod = _attr("families_module")()
    loaded = families if families is not None else mod.load_families()
    suffixes = mod.effort_suffixes()
    stem, _ = _split_effort_suffix(model_id, suffixes)
    gpt_tiers = {str(k).lower() for k in (loaded.get("gpt", {}).get("tiers") or {})}
    head, sep, tail = stem.rpartition("-")
    if sep and head and tail.lower() in gpt_tiers:
        return head, tail.lower()
    return stem, None


def normalized_codex_model(item: dict[str, Any]) -> dict[str, Any] | None:
    model_id = item.get("id")
    if not isinstance(model_id, str) or not model_id.strip():
        return None
    reasoning_efforts = normalized_option_values(
        item.get("supportedReasoningEfforts"),
        keys=("reasoningEffort", "effort", "value", "id"),
    )
    service_tiers = normalized_option_values(
        item.get("supportedServiceTiers"),
        keys=("serviceTier", "tier", "value", "id"),
    )
    families = _attr("families_module")().load_families()
    family_stem, tier = _codex_stem_and_tier(model_id, families)
    return {
        "id": model_id,
        "display_name": item.get("displayName") or model_id,
        "description": item.get("description") or "",
        "default": bool(item.get("isDefault", False)),
        "hidden": bool(item.get("hidden", False)),
        "reasoning_efforts": reasoning_efforts,
        "default_reasoning_effort": item.get("defaultReasoningEffort"),
        "service_tiers": service_tiers,
        "vendor": _infer_vendor(model_id, families),
        "family_stem": family_stem,
        "tier": tier,
        "supported_efforts": list(reasoning_efforts),
        "effort_slug": None,
        "composite": False,
        "observed_resolved_ids": [],
    }


def read_json_rpc_response(
    responses: queue.Queue[str | None],
    request_id: int,
    *,
    timeout: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _runner_error("Codex model catalog request timed out", 12)
        try:
            line = responses.get(timeout=remaining)
        except queue.Empty as exc:
            raise _runner_error("Codex model catalog request timed out", 12) from exc
        if line is None:
            raise _runner_error("Codex app-server closed before returning its catalog", 11)
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(message, dict) or message.get("id") != request_id:
            continue
        if message.get("error"):
            raise _runner_error(f"Codex model catalog failed: {json.dumps(message['error'])}", 11)
        result = message.get("result")
        if not isinstance(result, dict):
            raise _runner_error("Codex model catalog returned an invalid response", 11)
        return result


def codex_model_records(executable: str, environment: dict[str, str]) -> list[dict[str, Any]]:
    terminate_fn = _attr("terminate_process")
    runner_version = _attr("RUNNER_VERSION", "unknown")
    process = subprocess.Popen(
        [executable, "app-server", "--stdio"],
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    if process.stdin is None or process.stdout is None or process.stderr is None:
        if callable(terminate_fn):
            terminate_fn(process)
        raise _runner_error("failed to open Codex app-server streams", 11)

    responses: queue.Queue[str | None] = queue.Queue()
    stderr_lines: list[str] = []

    def collect_stdout() -> None:
        try:
            for line in process.stdout:
                responses.put(line)
        finally:
            responses.put(None)

    def collect_stderr() -> None:
        stderr_lines.extend(process.stderr)

    stdout_thread = threading.Thread(target=collect_stdout, daemon=True)
    stderr_thread = threading.Thread(target=collect_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    def send(payload: dict[str, Any]) -> None:
        try:
            process.stdin.write(json.dumps(payload) + "\n")
            process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            detail = "".join(stderr_lines).strip()
            suffix = f": {detail}" if detail else ""
            raise _runner_error(f"Codex app-server write failed{suffix}", 11) from exc

    records: list[dict[str, Any]] = []
    try:
        send(
            {
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "agent-executor",
                        "version": runner_version,
                    },
                    "capabilities": {"experimentalApi": True},
                },
            }
        )
        _attr("read_json_rpc_response")(responses, 1, timeout=20)
        send({"method": "initialized"})

        request_id = 2
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": 100, "includeHidden": True}
            if cursor:
                params["cursor"] = cursor
            send({"id": request_id, "method": "model/list", "params": params})
            page = _attr("read_json_rpc_response")(responses, request_id, timeout=30)
            data = page.get("data")
            if not isinstance(data, list):
                raise _runner_error("Codex model/list omitted its data array", 11)
            for raw_model in data:
                if not isinstance(raw_model, dict):
                    continue
                if normalized := _attr("normalized_codex_model")(raw_model):
                    records.append(normalized)
            next_cursor = page.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor:
                break
            cursor = next_cursor
            request_id += 1
    finally:
        with contextlib.suppress(OSError):
            process.stdin.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            if callable(terminate_fn):
                terminate_fn(process)
        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)
        process.stdout.close()
        process.stderr.close()

    if not records:
        detail = "".join(stderr_lines).strip()
        suffix = f": {detail}" if detail else ""
        raise _runner_error(f"Codex returned an empty model catalog{suffix}", 11)
    return records


def _parse_tabular_catalog_rows(lines: str) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw_line in lines.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        if "\t" in stripped:
            model_id, _, display_name = stripped.partition("\t")
        else:
            parts = re.split(r"\s{2,}", stripped, maxsplit=1)
            model_id = parts[0]
            display_name = parts[1] if len(parts) > 1 else ""
        if not model_id or re.search(r"\s", model_id) or model_id in seen:
            continue
        seen.add(model_id)
        rows.append((model_id, display_name.strip() or model_id))
    return rows


def simple_model_records(lines: str) -> list[dict[str, Any]]:
    families = _attr("families_module")().load_families()
    return [
        {
            "id": model_id,
            "display_name": display_name,
            "description": "",
            "default": False,
            "hidden": False,
            "reasoning_efforts": [],
            "default_reasoning_effort": None,
            "service_tiers": [],
            "vendor": _infer_vendor(model_id, families),
            "family_stem": model_id,
            "supported_efforts": [],
            "effort_slug": None,
            "composite": False,
            "observed_resolved_ids": [],
        }
        for model_id, display_name in _parse_tabular_catalog_rows(lines)
    ]


def agy_model_records(lines: str) -> list[dict[str, Any]]:
    mod = _attr("families_module")()
    families = mod.load_families()
    suffixes = mod.effort_suffixes()
    suffix_rank = {suffix: idx for idx, suffix in enumerate(suffixes)}
    rows = _parse_tabular_catalog_rows(lines)
    parsed_rows: list[tuple[str, str, str, str | None]] = []
    stem_efforts: dict[str, set[str]] = {}
    for model_id, display_name in rows:
        stem, effort_slug = _split_effort_suffix(model_id, suffixes)
        parsed_rows.append((model_id, display_name, stem, effort_slug))
        if effort_slug is not None:
            stem_efforts.setdefault(stem.lower(), set()).add(effort_slug)

    records: list[dict[str, Any]] = []
    for model_id, display_name, stem, effort_slug in parsed_rows:
        grouped = stem_efforts.get(stem.lower(), set())
        ordered_efforts = sorted(grouped, key=lambda item: (suffix_rank.get(item, 999), item))
        is_composite = effort_slug is None and not ordered_efforts
        records.append(
            {
                "id": model_id,
                "display_name": display_name,
                "description": "",
                "default": False,
                "hidden": False,
                "reasoning_efforts": list(ordered_efforts),
                "default_reasoning_effort": None,
                "service_tiers": [],
                "vendor": _infer_vendor(model_id, families),
                "family_stem": stem,
                "supported_efforts": list(ordered_efforts),
                "effort_slug": effort_slug,
                "composite": is_composite,
                "observed_resolved_ids": [],
            }
        )
    return records


def _read_opencode_models_cache() -> dict[str, Any]:
    cache_home = Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache"))
    cache_path = cache_home / "opencode" / "models.json"
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _strip_snapshot_stem(slug: str) -> str:
    cleaned = re.sub(r"-(?:20\d{6}|\d{4})$", "", slug.strip())
    return cleaned or slug.strip()


def _opencode_efforts_and_variants(meta: dict[str, Any] | None) -> tuple[list[str], list[str]]:
    if not isinstance(meta, dict):
        return [], []
    efforts: list[str] = []
    options = meta.get("reasoning_options")
    if isinstance(options, list):
        for option in options:
            if not isinstance(option, dict) or option.get("type") != "effort":
                continue
            for val in option.get("values") or []:
                if isinstance(val, str) and val.strip():
                    lowered = val.strip().lower()
                    if lowered not in efforts:
                        efforts.append(lowered)
    raw_variants = meta.get("variants")
    variants: list[str] = []
    if isinstance(raw_variants, dict):
        for key in raw_variants:
            if isinstance(key, str) and key.strip():
                lowered = key.strip().lower()
                variants.append(lowered)
                if lowered not in efforts:
                    efforts.append(lowered)
    return efforts, variants


def opencode_model_records(lines: str) -> list[dict[str, Any]]:
    families = _attr("families_module")().load_families()
    local_cache = _read_opencode_models_cache()
    records: list[dict[str, Any]] = []
    for model_id, display_name in _parse_tabular_catalog_rows(lines):
        segments = [seg for seg in model_id.split("/") if seg]
        if len(segments) >= 3:
            routing_provider = segments[0].lstrip("~").lower()
            cache_key = "/".join(segments[1:])
            model_slug = segments[-1]
        elif len(segments) == 2:
            routing_provider = segments[0].lstrip("~").lower()
            cache_key = segments[1]
            model_slug = segments[1]
        else:
            routing_provider = ""
            cache_key = model_id
            model_slug = model_id

        provider_models = (local_cache.get(routing_provider) or {}).get("models")
        meta = provider_models.get(cache_key) if isinstance(provider_models, dict) else None
        if meta is None and isinstance(provider_models, dict) and "~" in cache_key:
            meta = provider_models.get(cache_key.replace("~", "", 1))
        supported_efforts, variants = _opencode_efforts_and_variants(meta)
        family_stem = (
            str(meta.get("family")).strip()
            if isinstance(meta, dict) and isinstance(meta.get("family"), str) and meta.get("family").strip()
            else _strip_snapshot_stem(model_slug)
        )
        resolved_display = (
            str(meta.get("name")).strip()
            if isinstance(meta, dict)
            and isinstance(meta.get("name"), str)
            and meta.get("name").strip()
            and display_name == model_id
            else display_name
        )
        description = str(meta.get("description") or "").strip() if isinstance(meta, dict) else ""
        record: dict[str, Any] = {
            "id": model_id,
            "display_name": resolved_display,
            "description": description,
            "default": False,
            "hidden": False,
            "reasoning_efforts": list(supported_efforts),
            "default_reasoning_effort": None,
            "service_tiers": [],
            "provider": routing_provider or None,
            "vendor": _infer_vendor(model_id, families),
            "family_stem": family_stem,
            "supported_efforts": supported_efforts,
            "effort_slug": None,
            "composite": False,
            "observed_resolved_ids": [],
        }
        if variants:
            record["variants"] = variants
        records.append(record)
    return records


def parse_claude_help_efforts(help_text: str) -> list[str]:
    lines = help_text.splitlines()
    for index, line in enumerate(lines):
        if not re.search(r"(?:^|\s)--effort(?:\s|=|<|$)", line):
            continue
        window = " ".join(lines[index : index + 3])
        after_flag = re.split(r"--effort\b", window, maxsplit=1)[-1]
        match = re.search(r"\(([^)]+)\)", after_flag)
        if not match:
            continue
        raw = re.sub(
            r"^(?:choices?|values?|levels?|default\s*:?)\s*:?\s*", "", match.group(1).strip(), flags=re.IGNORECASE
        )
        parts = [part.strip().lower() for part in re.split(r"[,/|]+|\bor\b", raw) if part.strip()]
        efforts = [
            part
            for part in parts
            if re.fullmatch(r"[a-z][a-z0-9-]{0,15}", part)
            and part not in {"choices", "values", "levels", "default", "current", "session"}
        ]
        if efforts:
            return list(dict.fromkeys(efforts))
    return []


def _agent_cache_dir() -> Path:
    fn = _attr("default_agent_cache_dir")
    if callable(fn):
        return Path(fn())
    return Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache")) / "orchestrate"


def _claude_help_cache_path() -> Path:
    return _agent_cache_dir() / "claude-help-v1.json"


def _cached_claude_help_efforts(
    executable: str,
    version: str | None,
    environment: dict[str, str],
    *,
    refresh: bool = False,
    families: dict[str, dict[str, Any]] | None = None,
) -> list[str]:
    mod = _attr("families_module")()
    fallback = list(mod.claude_default_efforts(families))
    resolved_path, mtime_ns, size = _attr("_stat_executable")(executable)
    cache_path = _claude_help_cache_path()
    cache_payload: dict[str, Any] = {}
    try:
        loaded = json.loads(cache_path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            cache_payload = loaded
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        cache_payload = {}

    if not refresh:
        entry = cache_payload.get(executable)
        if (
            isinstance(entry, dict)
            and isinstance(entry.get("efforts"), list)
            and entry["efforts"]
            and (not entry.get("path") or not resolved_path or entry["path"] == resolved_path)
            and (entry.get("mtime_ns") is None or mtime_ns is None or entry["mtime_ns"] == mtime_ns)
            and (entry.get("size") is None or size is None or entry["size"] == size)
            and (not version or not entry.get("version") or entry["version"] == version)
        ):
            return [str(v).strip().lower() for v in entry["efforts"] if isinstance(v, str) and v.strip()]

    runner_error_cls = _attr("RunnerError", ValueError)
    parsed: list[str] = []
    try:
        output = _attr("run_checked")([executable, "--help"], timeout=5, environment=environment).stdout.decode(
            "utf-8", errors="replace"
        )
        parsed = parse_claude_help_efforts(output)
    except (OSError, runner_error_cls, subprocess.SubprocessError):
        parsed = []

    if parsed:
        cache_payload[executable] = {
            "version": version,
            "path": resolved_path,
            "mtime_ns": mtime_ns,
            "size": size,
            "efforts": parsed,
            "fetched_at": _attr("utc_now")(),
        }
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            cache_path.parent.chmod(0o700)
            temporary_path = cache_path.parent / f".{cache_path.name}.{uuid.uuid4().hex}.tmp"
            try:
                _attr("write_private_text")(
                    temporary_path, json.dumps(cache_payload, indent=2, ensure_ascii=True) + "\n"
                )
                os.replace(temporary_path, cache_path)
                cache_path.chmod(0o600)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    temporary_path.unlink()
        except OSError:
            pass
        return parsed
    return fallback


def _observed_claude_resolved_ids(aliases: tuple[str, ...]) -> dict[str, list[str]]:
    observed_all: set[str] = set()
    claude_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))
    stats_path = claude_dir / "stats-cache.json"
    try:
        stats = json.loads(stats_path.read_text(encoding="utf-8"))
        if isinstance(stats, dict):
            model_usage = stats.get("modelUsage")
            if isinstance(model_usage, dict):
                for model_id in model_usage:
                    if isinstance(model_id, str) and CLAUDE_MODEL_ID.match(model_id.strip()):
                        observed_all.add(model_id.strip())
            daily = stats.get("dailyModelTokens")
            if isinstance(daily, list):
                for day in daily:
                    tokens_by_model = day.get("tokensByModel") if isinstance(day, dict) else None
                    if isinstance(tokens_by_model, dict):
                        for model_id in tokens_by_model:
                            if isinstance(model_id, str) and CLAUDE_MODEL_ID.match(model_id.strip()):
                                observed_all.add(model_id.strip())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass

    mailbox_dir = _agent_cache_dir() / "mailbox-v1"
    peer_docs: list[Any] = []
    if (mailbox_dir / "mailbox-sqlite-v1").is_file():
        # Best effort: an unreadable record store only hides observed model ids.
        with contextlib.suppress(Exception):
            records = _bundled_module("mailbox_records")
            peer_docs = [row["body"] for row in records.list_rows(mailbox_dir, "peer", "")]
    elif (mailbox_dir / "peers").is_dir():
        for peer_file in (mailbox_dir / "peers").glob("*.json"):
            with contextlib.suppress(json.JSONDecodeError, OSError):
                peer_docs.append(json.loads(peer_file.read_text(encoding="utf-8")))
    if peer_docs:
        for peer in peer_docs:
            if not isinstance(peer, dict):
                continue
            for key in ("sessionModel", "stepModel", "model", "executionModel"):
                val = peer.get(key)
                if isinstance(val, str) and CLAUDE_MODEL_ID.match(val.strip()):
                    observed_all.add(val.strip())

    by_alias: dict[str, list[str]] = {alias: [] for alias in aliases}
    for alias in aliases:
        stripped = alias.lower().removeprefix("claude-")
        stem_tokens = [tok for tok in stripped.split("-") if tok and not tok.isdigit()]
        stem_key = stem_tokens[0] if stem_tokens else stripped
        matches: list[str] = []
        for obs_id in sorted(observed_all):
            obs_tokens = re.split(r"[-_.:~\[\]]+", obs_id.lower())
            if stem_key in obs_tokens:
                matches.append(obs_id)
        by_alias[alias] = matches
    return by_alias


def claude_model_records(
    executable: str | None = None,
    version: str | None = None,
    environment: dict[str, str] | None = None,
    *,
    refresh: bool = False,
) -> list[dict[str, Any]]:
    mod = _attr("families_module")()
    families = _attr("load_model_families")()
    aliases = mod.claude_aliases(families)
    claude_cfg = families.get("claude", {}) if isinstance(families, dict) else {}
    default_tier = claude_cfg.get("default_tier")
    default_target = (claude_cfg.get("tiers") or {}).get(default_tier) if isinstance(default_tier, str) else None
    if executable:
        supported_efforts = _cached_claude_help_efforts(
            executable,
            version,
            environment or {},
            refresh=refresh,
            families=families,
        )
    else:
        supported_efforts = list(mod.claude_default_efforts(families))
    observed_map = _observed_claude_resolved_ids(aliases)
    records: list[dict[str, Any]] = []
    for alias in aliases:
        stem = alias if alias.startswith("claude-") else f"claude-{alias}"
        label = f"Claude {alias.title()} (current)"
        records.append(
            {
                "id": alias,
                "name": label,
                "display_name": label,
                "description": "",
                "default": bool(default_target and alias == default_target),
                "hidden": False,
                "reasoning_efforts": list(supported_efforts),
                "default_reasoning_effort": None,
                "service_tiers": [],
                "vendor": claude_cfg.get("vendor") or "anthropic",
                "family_stem": stem,
                "supported_efforts": list(supported_efforts),
                "effort_slug": None,
                "composite": False,
                "observed_resolved_ids": list(observed_map.get(alias, [])),
            }
        )
    return records


def discover_live_engine_catalog(
    engine: str,
    *,
    refresh: bool = False,
    executable: str | None = None,
    version: str | None = None,
) -> dict[str, Any]:
    if engine not in CATALOG_ENGINES:
        raise _runner_error(f"unsupported catalog engine: {engine}", 4)
    discovered_at = _attr("utc_now")()
    executable = executable or shutil.which(engine)
    if not executable:
        return {
            "engine": engine,
            "status": "not_installed",
            "source": None,
            "executable": None,
            "version": None,
            "discovered_at": discovered_at,
            "models": [],
            "error": f"{engine} is not on PATH",
        }

    environment = _attr("executor_environment")(engine)
    runner_error_cls = _attr("RunnerError", ValueError)
    try:
        version = version or _attr("cli_version")(executable, environment)
        if engine == "claude":
            # Non-LLM inspection only: alias definitions + cached `--help` efforts + local stats/peers.
            return {
                "engine": engine,
                "status": "live",
                "source": "claude aliases + --help capabilities",
                "executable": executable,
                "version": version,
                "discovered_at": discovered_at,
                "models": claude_model_records(executable, version, environment, refresh=refresh),
                "error": None,
            }
        if engine == "codex":
            models = _attr("codex_model_records")(executable, environment)
            source = "codex app-server model/list"
        elif engine == "agy":
            output = _attr("run_checked")([executable, "models"], timeout=60, environment=environment).stdout.decode(
                "utf-8", errors="replace"
            )
            models = _attr("agy_model_records")(output)
            source = "agy models"
        else:
            version = version or _attr("get_cached_cli_version")(executable, environment)
            major = _attr("opencode_major_version")(version)

            def _build_opencode_models_cmd(ver_major: int) -> tuple[list[str], str]:
                if ver_major >= 2:
                    return [executable, "models"], "opencode models"
                cmd = [executable, "models", "--pure"]
                if refresh:
                    cmd.append("--refresh")
                return cmd, "opencode models --pure" + (" --refresh" if refresh else "")

            command, source = _build_opencode_models_cmd(major)
            try:
                output = _attr("run_checked")(command, timeout=120, environment=environment).stdout.decode(
                    "utf-8", errors="replace"
                )
            except runner_error_cls:
                fresh_version = _attr("get_cached_cli_version")(executable, environment, force_refresh=True)
                fresh_major = _attr("opencode_major_version")(fresh_version)
                if fresh_major != major:
                    version = fresh_version
                    major = fresh_major
                    command, source = _build_opencode_models_cmd(major)
                    output = _attr("run_checked")(command, timeout=120, environment=environment).stdout.decode(
                        "utf-8", errors="replace"
                    )
                else:
                    raise
            models = _attr("opencode_model_records")(output)
        if not models:
            raise _runner_error(f"{engine} returned an empty model catalog", 11)
        return {
            "engine": engine,
            "status": "live",
            "source": source,
            "executable": executable,
            "version": version,
            "discovered_at": discovered_at,
            "models": models,
            "error": None,
        }
    except (OSError, runner_error_cls) as exc:
        return {
            "engine": engine,
            "status": "failed",
            "source": None,
            "executable": executable,
            "version": locals().get("version"),
            "discovered_at": discovered_at,
            "models": [],
            "error": str(exc),
        }


def default_model_cache_path() -> Path:
    return _attr("default_agent_cache_dir")() / "models-v1.json"


def read_model_cache(path: Path | None = None) -> dict[str, Any]:
    cache_path = path or _attr("default_model_cache_path")()
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"schema": MODEL_CACHE_SCHEMA, "platforms": {}}
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != MODEL_CACHE_SCHEMA
        or not isinstance(payload.get("platforms"), dict)
    ):
        return {"schema": MODEL_CACHE_SCHEMA, "platforms": {}}
    return payload


def write_model_cache(payload: dict[str, Any], path: Path | None = None) -> None:
    cache_path = path or _attr("default_model_cache_path")()
    cache_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache_path.parent.chmod(0o700)
    temporary_path = cache_path.parent / f".{cache_path.name}.{uuid.uuid4().hex}.tmp"
    try:
        _attr("write_private_text")(
            temporary_path,
            json.dumps(payload, indent=2, ensure_ascii=True) + "\n",
        )
        os.replace(temporary_path, cache_path)
        cache_path.chmod(0o600)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary_path.unlink()


def default_cli_version_cache_path() -> Path:
    return _attr("default_agent_cache_dir")() / "cli-versions-v1.json"


def _stat_executable(executable: str) -> tuple[str, int | None, int | None]:
    resolved = shutil.which(executable) or executable
    try:
        stat = os.stat(resolved)
        return str(Path(resolved).resolve()), stat.st_mtime_ns, stat.st_size
    except OSError:
        return str(resolved), None, None


def read_cli_version_cache(path: Path | None = None) -> dict[str, Any]:
    cache_path = path or _attr("default_cli_version_cache_path")()
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    if not isinstance(payload, dict):
        return {}
    result: dict[str, Any] = {}
    for k, v in payload.items():
        if not isinstance(k, str):
            continue
        if isinstance(v, str) or (isinstance(v, dict) and isinstance(v.get("version"), str)):
            result[k] = v
    return result


def write_cli_version_cache(payload: dict[str, Any], path: Path | None = None) -> None:
    cache_path = path or _attr("default_cli_version_cache_path")()
    cache_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache_path.parent.chmod(0o700)
    temporary_path = cache_path.parent / f".{cache_path.name}.{uuid.uuid4().hex}.tmp"
    try:
        _attr("write_private_text")(
            temporary_path,
            json.dumps(payload, indent=2, ensure_ascii=True) + "\n",
        )
        os.replace(temporary_path, cache_path)
        cache_path.chmod(0o600)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary_path.unlink()


def _extract_cached_cli_version(entry: Any, resolved_path: str, mtime_ns: int | None, size: int | None) -> str | None:
    if isinstance(entry, str):
        return entry or None
    if not isinstance(entry, dict):
        return None
    version = entry.get("version")
    if not isinstance(version, str) or not version:
        return None
    if entry.get("path") and resolved_path and entry.get("path") != resolved_path:
        return None
    if entry.get("mtime_ns") is not None and mtime_ns is not None and entry.get("mtime_ns") != mtime_ns:
        return None
    if entry.get("size") is not None and size is not None and entry.get("size") != size:
        return None
    return version


def _build_cli_version_entry(executable: str, version: str) -> dict[str, Any]:
    resolved_path, mtime_ns, size = _attr("_stat_executable")(executable)
    return {
        "version": version,
        "path": resolved_path,
        "mtime_ns": mtime_ns,
        "size": size,
        "fetched_at": _attr("utc_now")(),
    }


def get_cached_cli_version(
    executable: str,
    environment: dict[str, str],
    *,
    force_refresh: bool = False,
    cache_path: Path | None = None,
) -> str:
    path = cache_path or _attr("default_cli_version_cache_path")()
    resolved_path, mtime_ns, size = _attr("_stat_executable")(executable)
    if not force_refresh:
        cache = _attr("read_cli_version_cache")(path)
        cached = _attr("_extract_cached_cli_version")(cache.get(executable), resolved_path, mtime_ns, size)
        if cached:
            return cached
    try:
        version = _attr("cli_version")(executable, environment)
    except Exception:
        cache = _attr("read_cli_version_cache")(path)
        entry = cache.get(executable)
        if isinstance(entry, dict) and isinstance(entry.get("version"), str):
            return entry["version"]
        if isinstance(entry, str):
            return entry
        return "unknown"
    cache = _attr("read_cli_version_cache")(path)
    cache[executable] = _attr("_build_cli_version_entry")(executable, version)
    _attr("write_cli_version_cache")(cache, path)
    return version


def record_cli_version(
    executable: str,
    version: str,
    *,
    cache_path: Path | None = None,
) -> None:
    path = cache_path or _attr("default_cli_version_cache_path")()
    cache = _attr("read_cli_version_cache")(path)
    cache[executable] = _attr("_build_cli_version_entry")(executable, version)
    _attr("write_cli_version_cache")(cache, path)


def opencode_major_version(version: str | None) -> int:
    match = re.search(r"(?:opencode\s+)?v?(\d+)", version or "")
    if match:
        return int(match.group(1))
    return 1


def cached_catalog_entry(
    cache: dict[str, Any],
    engine: str,
    *,
    executable: str,
    version: str,
    max_age_seconds: float,
) -> dict[str, Any] | None:
    entry = cache.get("platforms", {}).get(engine)
    if not isinstance(entry, dict):
        return None
    catalog = entry.get("catalog")
    cached_at_epoch = entry.get("cached_at_epoch")
    if isinstance(catalog, dict) and any(
        not isinstance(item, dict)
        or not isinstance(item.get("id"), str)
        or re.search(r"\s", item["id"])
        or not all(key in item for key in _REQUIRED_CAPABILITY_KEYS)
        for item in catalog.get("models", [])
    ):
        return None  # Refresh legacy or pre-capability-schema catalogs.
    if (
        not isinstance(catalog, dict)
        or catalog.get("status") != "live"
        or catalog.get("executable") != executable
        or catalog.get("version") != version
        or not isinstance(cached_at_epoch, int | float)
    ):
        return None
    age_seconds = max(0.0, time.time() - float(cached_at_epoch))
    if age_seconds > max_age_seconds:
        return None
    result = dict(catalog)
    result["cache"] = {
        "status": "hit",
        "path": str(_attr("default_model_cache_path")()),
        "age_seconds": round(age_seconds, 3),
        "max_age_seconds": max_age_seconds,
    }
    return result


def store_catalog_in_cache(
    engine: str,
    catalog: dict[str, Any],
    *,
    cache_path: Path | None = None,
) -> None:
    if catalog.get("status") != "live":
        return
    path = cache_path or _attr("default_model_cache_path")()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    lock_path = path.with_suffix(f"{path.suffix}.lock")
    with lock_path.open("a+", encoding="utf-8") as lock_handle:
        lock_path.chmod(0o600)
        if fcntl is not None:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            cache = _attr("read_model_cache")(path)
            platforms = cache.setdefault("platforms", {})
            platforms[engine] = {
                "cached_at_epoch": time.time(),
                "catalog": catalog,
            }
            cache["updated_at"] = _attr("utc_now")()
            _attr("write_model_cache")(cache, path)
        finally:
            if fcntl is not None:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


def discover_engine_catalog(
    engine: str,
    *,
    refresh: bool = False,
    max_age_seconds: float = DEFAULT_CATALOG_MAX_AGE_SECONDS,
    cache_path: Path | None = None,
) -> dict[str, Any]:
    if engine not in CATALOG_ENGINES:
        raise _runner_error(f"unsupported catalog engine: {engine}", 4)
    executable = shutil.which(engine)
    if not executable:
        return _attr("discover_live_engine_catalog")(engine, refresh=refresh)
    environment = _attr("executor_environment")(engine)
    runner_error_cls = _attr("RunnerError", ValueError)
    try:
        if engine == "opencode":
            version = _attr("get_cached_cli_version")(executable, environment, force_refresh=refresh)
        else:
            version = _attr("cli_version")(executable, environment)
    except (OSError, runner_error_cls):
        return _attr("discover_live_engine_catalog")(engine, refresh=refresh, executable=executable)

    path = cache_path or _attr("default_model_cache_path")()
    if not refresh:
        cached = _attr("cached_catalog_entry")(
            _attr("read_model_cache")(path),
            engine,
            executable=executable,
            version=version,
            max_age_seconds=max_age_seconds,
        )
        if cached is not None:
            cached["cache"]["path"] = str(path)
            if engine == "claude":
                aliases = tuple(
                    m["id"] for m in cached.get("models", []) if isinstance(m, dict) and isinstance(m.get("id"), str)
                )
                observed = _observed_claude_resolved_ids(aliases)
                cached["models"] = [
                    {**m, "observed_resolved_ids": list(observed.get(m["id"], []))} for m in cached.get("models", [])
                ]
            return cached

    catalog = _attr("discover_live_engine_catalog")(
        engine,
        refresh=refresh,
        executable=executable,
        version=version,
    )
    catalog["cache"] = {
        "status": ("refreshed" if refresh else "miss"),
        "path": str(path),
        "age_seconds": 0,
        "max_age_seconds": max_age_seconds,
    }
    _attr("store_catalog_in_cache")(engine, catalog, cache_path=path)
    return catalog


def filtered_catalog(catalog: dict[str, Any], *, include_hidden: bool) -> dict[str, Any]:
    result = dict(catalog)
    result["models"] = [
        model for model in catalog.get("models", []) if include_hidden or not model.get("hidden", False)
    ]
    return result


def matching_catalog(catalog: dict[str, Any], patterns: list[str]) -> dict[str, Any]:
    if not patterns:
        return catalog
    normalized = [pattern.casefold() for pattern in patterns if pattern.strip()]
    result = dict(catalog)
    result["models"] = [
        model
        for model in catalog.get("models", [])
        if all(pattern in str(model.get("id", "")).casefold() for pattern in normalized)
    ]
    result["match"] = patterns
    if catalog.get("models") and not result["models"]:
        result["match_status"] = "no_matches"
    return result


def markdown_cell(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def print_model_table(catalogs: list[dict[str, Any]]) -> None:
    print("| Platform | Exact model ID | Default | Hidden | Options / status |")
    print("| --- | --- | --- | --- | --- |")
    for catalog in catalogs:
        models = catalog.get("models", [])
        if not models:
            detail = catalog.get("error") or catalog.get("status")
            print(
                f"| {markdown_cell(catalog['engine'])} | — | — | — | "
                f"{markdown_cell(catalog['status'])}: {markdown_cell(detail)} |"
            )
            continue
        for model in models:
            options: list[str] = []
            if model.get("reasoning_efforts"):
                options.append("effort=" + ",".join(model["reasoning_efforts"]))
            if model.get("service_tiers"):
                options.append("tier=" + ",".join(model["service_tiers"]))
            print(
                f"| {markdown_cell(catalog['engine'])} | "
                f"{markdown_cell(model['id'])} | "
                f"{'yes' if model.get('default') else ''} | "
                f"{'yes' if model.get('hidden') else ''} | "
                f"{markdown_cell('; '.join(options))} |"
            )


def models_main(argv: list[str] | None = None) -> int:
    args = _attr("parse_models_args")(argv)
    engines = list(dict.fromkeys(args.engine or CATALOG_ENGINES))
    catalogs = [
        _attr("matching_catalog")(
            _attr("filtered_catalog")(
                _attr("discover_engine_catalog")(engine, refresh=args.refresh),
                include_hidden=args.include_hidden,
            ),
            args.match,
        )
        for engine in engines
    ]
    payload = {
        "schema": MODEL_CATALOG_SCHEMA,
        "generated_at": _attr("utc_now")(),
        "platforms": catalogs,
    }
    if args.format == "json":
        print(json.dumps(payload, indent=2, ensure_ascii=True))
    else:
        _attr("print_model_table")(catalogs)
    return 0


def native_engine_for(model: str) -> str | None:
    """The engine whose first-party harness owns this model family (Claude, GPT, Gemini), or None.

    Those families always run in their own harness: Claude Code, Codex, Antigravity. OpenCode/OpenRouter
    is for families without one here: GLM, DeepSeek, Qwen, Kimi and the like. Open-weight GPT-OSS and
    Gemma are not the hosted families and stay allowed.
    """
    return _attr("families_module")().native_engine_for_model(model)


def enforce_native_route(engine: str, model: str) -> None:
    native = _attr("native_engine_for")(model) if engine == "opencode" else None
    if native:
        raise _runner_error(
            f"{model} belongs to a family with its own harness; run it with --engine {native}, not through "
            "OpenCode/OpenRouter. OpenCode is only for families without a native harness (GLM, DeepSeek, Qwen, "
            "Kimi, ...).",
            _attr("EXIT_ROUTE_NOT_ALLOWED", EXIT_ROUTE_NOT_ALLOWED),
        )


def families_module() -> Any:
    return _bundled_module("families")


def routes_module() -> Any:
    return _bundled_module("routes")


def load_model_families() -> dict[str, dict[str, Any]]:
    try:
        return _attr("families_module")().load_families(_attr("routes_module")().load_config())
    except (OSError, ValueError) as error:
        raise _runner_error(f"cannot load model families: {error}", 4) from error


def resolve_family_selector(engine: str, selector: str, available_models: list[str]) -> str | None:
    """`deepseek`, `gpt:luna`, `gemini:fast` -> the newest matching live ID; None when not a selector."""
    module = _attr("families_module")()
    families = _attr("load_model_families")()
    parsed = module.parse_selector(selector, families)
    is_bare_tier = False
    if not parsed:
        parsed = parse_bare_tier_selector(engine, selector, families)
        is_bare_tier = parsed is not None
    if not parsed:
        return None
    name, tier = parsed
    if families[name]["engine"] != engine:
        raise _runner_error(
            f"{selector!r} is a {families[name]['engine']} family; run it with --engine {families[name]['engine']}", 4
        )
    try:
        model = module.resolve(name, tier, families, available_models)
    except module.SelectorError as error:
        raise _runner_error(str(error), 14) from error
    canonical_selector = f"{name}:{tier}" if is_bare_tier else selector
    _attr("note_selector_advance")(canonical_selector, model)
    return model


def note_selector_advance(selector: str, model: str) -> None:
    """Tell the conductor when a selector now resolves to a different model than it did last time."""
    path = _attr("default_agent_cache_dir")() / "resolved-selectors-v1.json"
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with path.with_suffix(f"{path.suffix}.lock").open("a+", encoding="utf-8") as lock_handle:
            if fcntl is not None:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
            try:
                known = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                known = {}
            if not isinstance(known, dict):
                known = {}
            previous = known.get(selector)
            if previous == model:
                return
            if isinstance(previous, str):
                print(
                    f"AGENT_NOTE=model_advanced selector={selector} from={previous} to={model}",
                    file=sys.stderr,
                    flush=True,
                )
            known[selector] = model
            _attr("write_json_atomic")(path, known)
    except OSError:
        pass


def resume_pinned_model(args: argparse.Namespace) -> str | None:
    """A resumed session stays on the model it ran: a selector, or no --model, takes the recorded ID."""
    if not getattr(args, "resume_result", None):
        return args.model
    try:
        previous = json.loads(args.resume_result.expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return args.model  # validate_resume reports the unreadable baseline
    recorded = previous.get("model") if isinstance(previous, dict) else None
    if not isinstance(recorded, str) or previous.get("engine") != args.engine:
        return args.model
    if args.model is None or _attr("families_module")().parse_selector(args.model, _attr("load_model_families")()):
        return recorded
    return args.model


def preferred_model(engine: str) -> str:
    """The model an engine runs when none is given: its default route, else the built-in fallback."""
    try:
        route = _attr("routes_module")().engine_default(engine)
    except (OSError, ValueError):
        route = None
    return (route or {}).get("model") or _attr("PREFERRED_MODELS", PREFERRED_MODELS)[engine]


def split_opencode_model(engine: str | None, model: str | None) -> tuple[str | None, str | None]:
    """Split an inline OpenCode `#<variant>` suffix from `model`, returning `(base_model, variant)`."""
    if engine in (None, "opencode") and isinstance(model, str) and "#" in model:
        base_model, inline_variant = model.split("#", 1)
        return base_model, (inline_variant or None)
    return model, None


def select_live_model(
    engine: str,
    requested_model: str | None,
    catalog: dict[str, Any],
) -> tuple[str, str]:
    if catalog.get("status") != "live":
        detail = catalog.get("error") or catalog.get("status")
        exit_code = 13 if catalog.get("status") == "not_installed" else 11
        raise _runner_error(f"cannot retrieve live {engine} models: {detail}", exit_code)
    requested_model, _ = split_opencode_model(engine, requested_model)
    available_models = [model["id"] for model in catalog.get("models", []) if not model.get("hidden", False)]
    model, _ = split_opencode_model(engine, requested_model or _attr("preferred_model")(engine))
    assert model is not None
    if engine == "claude":
        model = normalize_claude_model_id(model)
    if model in available_models:
        reason = "exact_user_request" if requested_model else "validated_preference"
        return model, reason
    resolved = _attr("resolve_family_selector")(engine, model, available_models)
    if resolved:
        return resolved, "family_latest"
    if engine == "claude" and CLAUDE_MODEL_ID.match(model):
        return model, "unverified_claude_id"

    suggestions = difflib.get_close_matches(model, available_models, n=3, cutoff=0.35)
    suggestion_text = f" Closest live IDs: {', '.join(suggestions)}." if suggestions else ""
    preference_text = (
        "The policy preference is no longer available."
        if requested_model is None
        else "The requested ID is not available."
    )
    raise _runner_error(
        f"{preference_text} {engine} model: {model}.{suggestion_text} "
        f"Run `run_agent.py models --engine {engine}` and select an exact ID.",
        14,
    )


def executor_preflight(
    engine: str,
    requested_model: str | None,
    *,
    refresh: bool = False,
) -> tuple[str, str, list[str], str, str, dict[str, Any]]:
    requested_model, _ = split_opencode_model(engine, requested_model)
    if requested_model:
        _attr("enforce_native_route")(engine, requested_model)
    catalog = _attr("discover_engine_catalog")(engine, refresh=refresh)
    runner_error_cls = _attr("RunnerError", ValueError)
    try:
        model, selection_reason = _attr("select_live_model")(engine, requested_model, catalog)
    except runner_error_cls:
        if refresh or catalog.get("cache", {}).get("status") != "hit":
            raise
        catalog = _attr("discover_engine_catalog")(engine, refresh=True)
        model, selection_reason = _attr("select_live_model")(engine, requested_model, catalog)
    # A selector (or a config family) can resolve to a native family's ID, so check what will run too.
    _attr("enforce_native_route")(engine, model)
    executable = catalog.get("executable")
    if not isinstance(executable, str):
        raise _runner_error(f"{engine} is not on PATH", 13)
    available_models = [item["id"] for item in catalog.get("models", []) if not item.get("hidden", False)]
    return (
        executable,
        str(catalog.get("version") or "unknown"),
        available_models,
        model,
        selection_reason,
        catalog,
    )


_ROUTE_ENGINE_ALIASES = {
    "claude": "claude",
    "gemini": "agy",
    "antigravity": "agy",
    "openai": "codex",
    "openrouter": "opencode",
}
_PROVIDER_TO_ENGINE = {
    "claude": "claude",
    "codex": "codex",
    "antigravity": "agy",
    "agy": "agy",
    "gemini": "agy",
    "opencode": "opencode",
}
_SINGLE_WORD_ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_RESERVED_ROUTE_ALIAS_NAMES = frozenset({"claude", "codex", "agy", "gemini", "opencode", "antigravity", "all"})


_CLAUDE_PROFILE_MARKERS = (".claude.json", "projects")
_CODEX_PROFILE_MARKERS = ("auth.json", "config.toml", "sessions", "history.jsonl")
_AGY_PROFILE_MARKERS = (
    "antigravity-oauth-token",
    "antigravity",
    "antigravity-cli",
    "settings.json",
    "User",
    "antigravity-cli/antigravity-oauth-token",
)
_DISCOVERED_PROFILE_SPECS = (
    ("claude", "claude", "claude", _CLAUDE_PROFILE_MARKERS),
    ("codex", "codex", "codex", _CODEX_PROFILE_MARKERS),
    ("antigravity", "antigravity", "agy", _AGY_PROFILE_MARKERS),
)


def _resolve_path_against_home(raw: str | Path, *, home: Path | None = None) -> Path:
    base = Path(os.path.expanduser(str(home))) if home is not None else Path.home()
    text = str(raw).strip()
    if text == "~":
        expanded = base
    elif text.startswith("~/"):
        expanded = base / text[2:]
    else:
        expanded = Path(os.path.expanduser(text))
        if not expanded.is_absolute():
            expanded = base / expanded
    try:
        return expanded.resolve()
    except OSError:
        return Path(os.path.abspath(str(expanded)))


def _normalize_tags(*values: Any) -> list[str]:
    tags: list[str] = []
    seen: set[str] = set()
    for value in values:
        items = value if isinstance(value, (list, tuple, set)) else [value]
        for item in items:
            if not isinstance(item, str):
                continue
            cleaned = item.strip().lower()
            if cleaned and cleaned not in seen:
                seen.add(cleaned)
                tags.append(cleaned)
    return tags


def monitor_config_path() -> Path:
    raw = os.environ.get("MONITOR_CONFIG")
    if isinstance(raw, str) and raw.strip():
        return Path(raw.strip()).expanduser()
    return Path.home() / ".config" / "monitor" / "config.json"


def _load_raw_monitor_config(*, strict: bool = False) -> dict[str, Any]:
    cfg_path = monitor_config_path()
    try:
        raw = cfg_path.read_text(encoding="utf-8")
    except OSError as exc:
        if isinstance(exc, FileNotFoundError):
            if not strict:
                return {}
            try:
                repo_policy = _bundled_module("repo_policy")
                is_missing = getattr(repo_policy, "_is_missing_policy_file_error", None)
                if callable(is_missing) and is_missing(cfg_path, exc):
                    return {}
            except Exception:
                return {}
            raise ValueError(f"cannot read Monitor config {cfg_path}: {exc}") from exc
        if strict:
            raise ValueError(f"cannot read Monitor config {cfg_path}: {exc}") from exc
        return {}
    try:
        data = json.loads(raw)
    except ValueError as exc:
        if strict:
            raise ValueError(f"invalid JSON in Monitor config {cfg_path}: {exc}") from exc
        return {}
    if not isinstance(data, dict):
        if strict:
            raise ValueError(f"invalid Monitor config {cfg_path}: expected JSON object")
        return {}
    return data


def _first_nonempty_str(*values: Any) -> str | None:
    return next((v.strip() for v in values if isinstance(v, str) and v.strip()), None)


def _merged_account_env(account: dict[str, Any], global_env: dict[str, Any] | None) -> dict[str, str]:
    merged: dict[str, str] = {}
    for mapping in (global_env, account.get("env")):
        if not isinstance(mapping, dict):
            continue
        for key, value in mapping.items():
            if not isinstance(key, str):
                continue
            if value is None:
                merged.pop(key, None)
            elif isinstance(value, str) and value.strip():
                merged[key] = value.strip()
    return merged


def _normalize_account_record(
    raw: dict[str, Any], *, global_env: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    provider = str(raw.get("provider") or "").strip().lower()
    engine = str(raw.get("engine") or "").strip().lower() or _PROVIDER_TO_ENGINE.get(provider, "")
    if not engine:
        return None
    if not provider:
        provider = {"claude": "claude", "codex": "codex", "agy": "antigravity", "opencode": "opencode"}.get(engine, "")
    account_id = str(raw.get("id") or raw.get("account_id") or raw.get("accountId") or "").strip()
    raw_alias = raw.get("alias") or raw.get("account_alias") or raw.get("accountAlias")
    account_alias = raw_alias.strip() if isinstance(raw_alias, str) and raw_alias.strip() else None

    aliases: list[str] = []
    seen_aliases: set[str] = set()

    def add_alias(candidate: Any) -> None:
        if isinstance(candidate, str) and candidate.strip():
            cleaned = candidate.strip()
            if cleaned.lower() not in seen_aliases:
                seen_aliases.add(cleaned.lower())
                aliases.append(cleaned)

    add_alias(account_id)
    add_alias(account_alias)
    for extra in raw.get("aliases") or ():
        add_alias(extra)
    raw_route = raw.get("route")
    if isinstance(raw_route, str):
        route_tok = raw_route.strip()
        if (
            route_tok
            and _SINGLE_WORD_ALIAS_RE.fullmatch(route_tok)
            and route_tok.lower() not in _RESERVED_ROUTE_ALIAS_NAMES
        ):
            add_alias(route_tok)
            if account_alias is None:
                account_alias = route_tok

    merged_env = _merged_account_env(raw, global_env)
    billing_raw = raw.get("billing") or raw.get("billing_mode")
    billing_mode = billing_raw.strip() if isinstance(billing_raw, str) and billing_raw.strip() else None
    tags = _normalize_tags(raw.get("tags"), raw.get("category"))

    claude_config_dir: Path | None = None
    claude_account_home: Path | None = None
    codex_home: Path | None = None
    agy_home: Path | None = None
    agy_app_data_dir: Path | None = None

    caller_home = _resolve_path_against_home(Path.home())
    raw_home = merged_env.get("HOME")
    resolved_home = (
        _resolve_path_against_home(raw_home, home=caller_home)
        if isinstance(raw_home, str) and raw_home.strip()
        else None
    )
    base_home = resolved_home if resolved_home is not None else caller_home

    agy_typed_gemini_home = False
    if engine == "claude":
        default_claude_dir = base_home / ".claude"
        raw_cfg = _first_nonempty_str(
            raw.get("claudeConfigDir"),
            raw.get("claude_config_dir"),
            raw.get("configDir"),
            merged_env.get("CLAUDE_CONFIG_DIR"),
        )
        if resolved_home is not None and resolved_home != caller_home:
            claude_account_home = resolved_home
        if raw_cfg is not None:
            resolved_cfg = _resolve_path_against_home(raw_cfg, home=base_home)
            if resolved_cfg != default_claude_dir:
                claude_config_dir = resolved_cfg
        elif isinstance(raw.get("accountHome"), str) and raw["accountHome"].strip():
            resolved_acct = _resolve_path_against_home(raw["accountHome"], home=base_home)
            if resolved_acct != default_claude_dir:
                if resolved_acct.name == ".claude" and resolved_acct.parent != caller_home:
                    claude_account_home = claude_account_home or resolved_acct.parent
                else:
                    claude_config_dir = resolved_acct
    elif engine == "codex":
        raw_codex = _first_nonempty_str(raw.get("codexHome"), raw.get("codex_home"), merged_env.get("CODEX_HOME"))
        raw_acct = _first_nonempty_str(raw.get("accountHome"), raw.get("account_home"))
        if raw_codex is not None:
            codex_home = _resolve_path_against_home(raw_codex, home=base_home)
        elif resolved_home is not None:
            codex_home = resolved_home / ".codex"
        elif raw_acct is not None:
            codex_home = _resolve_path_against_home(raw_acct, home=base_home)
    elif engine == "agy":
        raw_agy_home = _first_nonempty_str(raw.get("agyHome"), raw.get("agy_home"))
        raw_env_gemini = _first_nonempty_str(merged_env.get("GEMINI_CLI_HOME"))
        raw_gemini = raw_agy_home or raw_env_gemini
        raw_app = _first_nonempty_str(
            raw.get("agyAppDataDir"), raw.get("agy_app_data_dir"), merged_env.get("ANTIGRAVITY_APP_DATA_DIR")
        )
        raw_acct = _first_nonempty_str(raw.get("accountHome"), raw.get("account_home"))
        if raw_gemini is not None:
            agy_home = _resolve_path_against_home(raw_gemini, home=base_home)
            agy_typed_gemini_home = bool(not raw_agy_home and raw_env_gemini)
            if raw_app is not None:
                agy_app_data_dir = _resolve_path_against_home(raw_app, home=base_home)
        elif raw_app is not None:
            app_path = _resolve_path_against_home(raw_app, home=base_home)
            agy_app_data_dir = app_path
            agy_home = app_path.parent if app_path.name.startswith("antigravity") else app_path
        elif resolved_home is not None:
            agy_home = resolved_home / ".gemini"
        elif raw_acct is not None:
            agy_home = _resolve_path_against_home(raw_acct, home=base_home)

    return {
        "account_id": account_id or account_alias or "",
        "account_alias": account_alias,
        "aliases": aliases,
        "provider": provider,
        "engine": engine,
        "billing_mode": billing_mode,
        "tags": tags,
        "claude_config_dir": claude_config_dir,
        "claude_account_home": claude_account_home,
        "codex_home": codex_home,
        "agy_home": agy_home,
        "agy_app_data_dir": agy_app_data_dir,
        "agy_typed_gemini_home": agy_typed_gemini_home,
    }


def _synthesized_account_record(
    account_id: str,
    *,
    provider: str,
    engine: str,
    claude_config_dir: Path | None = None,
    codex_home: Path | None = None,
    agy_home: Path | None = None,
    agy_app_data_dir: Path | None = None,
) -> dict[str, Any]:
    return {
        "account_id": account_id,
        "account_alias": None,
        "aliases": [],
        "provider": provider,
        "engine": engine,
        "billing_mode": None,
        "tags": [],
        "claude_config_dir": claude_config_dir,
        "claude_account_home": None,
        "codex_home": codex_home,
        "agy_home": agy_home,
        "agy_app_data_dir": agy_app_data_dir,
        "agy_typed_gemini_home": False,
    }


def _discover_synthesized_accounts() -> list[dict[str, Any]]:
    discovered: list[dict[str, Any]] = [
        _synthesized_account_record("claude", provider="claude", engine="claude"),
        _synthesized_account_record("codex", provider="codex", engine="codex"),
        _synthesized_account_record("antigravity", provider="antigravity", engine="agy"),
    ]
    home_dir = _resolve_path_against_home(Path.home())
    if not home_dir.is_dir():
        return discovered
    try:
        entries = [entry for entry in home_dir.iterdir() if entry.is_dir()]
    except OSError:
        return discovered
    for prefix, provider, engine, markers in _DISCOVERED_PROFILE_SPECS:
        pattern = re.compile(rf"^\.{re.escape(prefix)}-([\w-]+)$", re.ASCII)
        matched: list[tuple[str, Path]] = []
        for entry in entries:
            match = pattern.fullmatch(entry.name)
            if not match:
                continue
            if any((entry / marker).exists() for marker in markers):
                matched.append((match.group(1), _resolve_path_against_home(entry)))
        for name, resolved_entry in sorted(matched, key=lambda item: item[0]):
            acct_id = f"{prefix}-{name}"
            if engine == "claude":
                discovered.append(
                    _synthesized_account_record(
                        acct_id,
                        provider=provider,
                        engine=engine,
                        claude_config_dir=resolved_entry,
                    )
                )
            elif engine == "codex":
                discovered.append(
                    _synthesized_account_record(
                        acct_id,
                        provider=provider,
                        engine=engine,
                        codex_home=resolved_entry,
                    )
                )
            elif engine == "agy":
                discovered.append(
                    _synthesized_account_record(
                        acct_id,
                        provider=provider,
                        engine=engine,
                        agy_home=resolved_entry,
                        agy_app_data_dir=resolved_entry,
                    )
                )
    return discovered


def load_monitor_accounts(*, strict: bool = False) -> list[dict[str, Any]]:
    raw_cfg = _load_raw_monitor_config(strict=strict)
    global_env = raw_cfg.get("env") if isinstance(raw_cfg.get("env"), dict) else None
    raw_accounts = raw_cfg.get("accounts")
    if "accounts" in raw_cfg and not isinstance(raw_accounts, list):
        if strict:
            raise ValueError(f"invalid accounts list in Monitor config {monitor_config_path()}: expected array")
        raw_accounts = None
    accounts: list[dict[str, Any]] = []
    if isinstance(raw_accounts, list):
        for entry in raw_accounts:
            if not isinstance(entry, dict):
                continue
            normalized = _normalize_account_record(entry, global_env=global_env)
            if normalized is not None:
                accounts.append(normalized)
    if accounts:
        return accounts
    try:
        repo_policy = _bundled_module("repo_policy")
        loader = getattr(repo_policy, "load_configured_accounts", None)
        if callable(loader):
            loaded = loader(strict=strict)
            if isinstance(loaded, list):
                for entry in loaded:
                    if isinstance(entry, dict):
                        normalized = _normalize_account_record(entry, global_env=global_env)
                        if normalized is not None:
                            accounts.append(normalized)
    except Exception as exc:
        if strict:
            raise ValueError(str(exc)) from exc
    return accounts


def resolve_configured_account(identifier: str | None, *, strict: bool = False) -> dict[str, Any] | None:
    if not isinstance(identifier, str) or not identifier.strip():
        return None
    target = identifier.strip()
    lowered = target.lower()
    accounts = load_monitor_accounts(strict=strict)
    for acct in accounts:
        if acct["account_id"] == target or (acct["account_alias"] and acct["account_alias"] == target):
            return acct
    for acct in accounts:
        if target in acct["aliases"]:
            return acct
    for acct in accounts:
        if acct["account_id"].lower() == lowered or any(alias.lower() == lowered for alias in acct["aliases"]):
            return acct
    try:
        repo_policy = _bundled_module("repo_policy")
        resolver = getattr(repo_policy, "resolve_configured_account", None)
        if callable(resolver):
            found = resolver(target, strict=strict)
            if isinstance(found, dict):
                return _normalize_account_record(found)
    except Exception as exc:
        if strict:
            raise ValueError(str(exc)) from exc
    if not monitor_config_path().exists():
        synthesized = _discover_synthesized_accounts()
        for acct in synthesized:
            if acct["account_id"] == target:
                return acct
        for acct in synthesized:
            if acct["account_id"].lower() == lowered:
                return acct
    return None


_ENGINE_PIN_ENV_VARS: dict[str, tuple[str, str]] = {
    "claude": ("ORKEST_PINNED_CLAUDE_ACCOUNT", "ORKEST_CLAUDE_ACCOUNT_HOME"),
    "codex": ("ORKEST_PINNED_CODEX_ACCOUNT", "ORKEST_CODEX_ACCOUNT_HOME"),
    "agy": ("ORKEST_PINNED_AGY_ACCOUNT", "ORKEST_AGY_ACCOUNT_HOME"),
}


def _has_explicit_account_pin(
    engine: str,
    *,
    explicit_account: Any = False,
    account: Any = None,
    claude_config_dir: Any = None,
    claude_account_home: Any = None,
    codex_home: Any = None,
    agy_home: Any = None,
    agy_app_data_dir: Any = None,
    resume_result: Any = None,
    include_child_markers: bool = True,
) -> bool:
    """Return True when the run has an explicit account/profile pin for the active engine."""
    if explicit_account or account or resume_result:
        return True
    if engine == "claude" and (claude_config_dir or claude_account_home):
        return True
    if engine == "codex" and codex_home:
        return True
    if engine == "agy" and (agy_home or agy_app_data_dir):
        return True
    if include_child_markers:
        markers = _ENGINE_PIN_ENV_VARS.get(engine)
        if markers:
            pinned_key, home_key = markers
            if os.environ.get(pinned_key) == "1" or (os.environ.get(home_key) or "").strip():
                return True
    return False


def _derive_agy_profile_pair(
    gemini_home: Path | str | None,
    app_data_dir: Path | str | None,
    *,
    default_home: Path | None = None,
    infer_gemini_basename: bool = False,
) -> tuple[Path, Path]:
    """Derive the effective (GEMINI_CLI_HOME, ANTIGRAVITY_APP_DATA_DIR) pair using executor semantics."""
    fallback_home = _resolve_path_against_home(default_home or (Path.home() / ".gemini"))
    g_str = str(gemini_home).strip() if gemini_home is not None else ""
    a_str = str(app_data_dir).strip() if app_data_dir is not None else ""
    if g_str and a_str:
        return (_resolve_path_against_home(g_str), _resolve_path_against_home(a_str))
    if g_str:
        gp = Path(g_str).expanduser()
        if infer_gemini_basename and gp.name.startswith("antigravity"):
            return (_resolve_path_against_home(gp.parent), _resolve_path_against_home(gp))
        return (_resolve_path_against_home(gp), _resolve_path_against_home(gp / "antigravity-cli"))
    if a_str:
        ap = Path(a_str).expanduser()
        resolved_a = _resolve_path_against_home(ap)
        resolved_g = _resolve_path_against_home(ap.parent) if ap.name.startswith("antigravity") else fallback_home
        return (resolved_g, resolved_a)
    return (fallback_home, _resolve_path_against_home(fallback_home / "antigravity-cli"))


def _agy_paths_match(target_home: Path | str | None, target_app: Path | str | None) -> bool:
    """Return True when the given Antigravity home/app_data_dir resolves to the live host profile."""
    host_app = (os.environ.get("ANTIGRAVITY_APP_DATA_DIR") or "").strip() or None
    host_gemini = (os.environ.get("GEMINI_CLI_HOME") or "").strip() or None
    return _derive_agy_profile_pair(
        target_home,
        target_app,
        infer_gemini_basename=True,
    ) == _derive_agy_profile_pair(
        host_gemini,
        host_app,
        infer_gemini_basename=False,
    )


def _child_marker_switches_host_profile(engine: str) -> bool:
    """Return True when child-only ORKEST_* account markers select a profile different from the live host."""
    if engine == "claude":
        marker_home = (os.environ.get("ORKEST_CLAUDE_ACCOUNT_HOME") or "").strip()
        pinned = os.environ.get("ORKEST_PINNED_CLAUDE_ACCOUNT") == "1"
        if not marker_home and not pinned:
            return False
        target = (
            _resolve_path_against_home(marker_home) / ".claude"
            if marker_home
            else _resolve_path_against_home(Path.home() / ".claude")
        )
        host_raw = (os.environ.get("CLAUDE_CONFIG_DIR") or "").strip() or (Path.home() / ".claude")
        return target != _resolve_path_against_home(host_raw)
    if engine == "codex":
        marker_home = (os.environ.get("ORKEST_CODEX_ACCOUNT_HOME") or "").strip()
        pinned = os.environ.get("ORKEST_PINNED_CODEX_ACCOUNT") == "1"
        if not marker_home and not pinned:
            return False
        target = _resolve_path_against_home(marker_home or (Path.home() / ".codex"))
        host_raw = (os.environ.get("CODEX_HOME") or "").strip() or (Path.home() / ".codex")
        return target != _resolve_path_against_home(host_raw)
    if engine == "agy":
        marker_home = (os.environ.get("ORKEST_AGY_ACCOUNT_HOME") or "").strip()
        pinned = os.environ.get("ORKEST_PINNED_AGY_ACCOUNT") == "1"
        if not marker_home and not pinned:
            return False
        return not _agy_paths_match(marker_home or (Path.home() / ".gemini"), None)
    return False


def resolve_account_by_home(
    engine: str,
    *,
    claude_config_dir: Path | str | None = None,
    claude_account_home: Path | str | None = None,
    codex_home: Path | str | None = None,
    agy_home: Path | str | None = None,
    agy_app_data_dir: Path | str | None = None,
    include_child_markers: bool = True,
    strict: bool = False,
) -> dict[str, Any] | None:
    accounts = [acct for acct in load_monitor_accounts(strict=strict) if acct["engine"] == engine]
    if not accounts:
        return None
    caller_home = _resolve_path_against_home(Path.home())
    if engine == "claude":
        orkest_claude_home = (os.environ.get("ORKEST_CLAUDE_ACCOUNT_HOME") or "").strip()
        env_claude_dir = (os.environ.get("CLAUDE_CONFIG_DIR") or "").strip()
        if claude_config_dir is not None:
            target_dir = _resolve_path_against_home(claude_config_dir)
        elif claude_account_home is not None:
            target_dir = _resolve_path_against_home(claude_account_home) / ".claude"
        elif include_child_markers and orkest_claude_home:
            target_dir = _resolve_path_against_home(orkest_claude_home) / ".claude"
        elif include_child_markers and os.environ.get("ORKEST_PINNED_CLAUDE_ACCOUNT") == "1":
            target_dir = caller_home / ".claude"
        elif env_claude_dir:
            target_dir = _resolve_path_against_home(env_claude_dir)
        else:
            target_dir = caller_home / ".claude"
        for acct in accounts:
            acct_dir = (
                acct["claude_config_dir"]
                or ((acct["claude_account_home"] / ".claude") if acct["claude_account_home"] else None)
                or (caller_home / ".claude")
            )
            if _resolve_path_against_home(acct_dir) == target_dir:
                return acct
        return None
    if engine == "codex":
        orkest_codex_home = (os.environ.get("ORKEST_CODEX_ACCOUNT_HOME") or "").strip()
        if codex_home is not None and str(codex_home).strip():
            raw_codex: Path | str = codex_home
        elif include_child_markers and orkest_codex_home:
            raw_codex = orkest_codex_home
        elif include_child_markers and os.environ.get("ORKEST_PINNED_CODEX_ACCOUNT") == "1":
            raw_codex = caller_home / ".codex"
        else:
            raw_codex = (os.environ.get("CODEX_HOME") or "").strip() or (caller_home / ".codex")
        target_dir = _resolve_path_against_home(raw_codex)
        for acct in accounts:
            acct_dir = acct["codex_home"] or (caller_home / ".codex")
            if _resolve_path_against_home(acct_dir) == target_dir:
                return acct
        return None
    if engine == "agy":
        orkest_agy_home = (os.environ.get("ORKEST_AGY_ACCOUNT_HOME") or "").strip()
        default_agy_home = caller_home / ".gemini"
        explicit_home = str(agy_home).strip() if agy_home is not None and str(agy_home).strip() else ""
        explicit_app = (
            str(agy_app_data_dir).strip() if agy_app_data_dir is not None and str(agy_app_data_dir).strip() else ""
        )
        if explicit_home or explicit_app:
            sel_gemini: Path | str | None = explicit_home or None
            sel_app: Path | str | None = explicit_app or None
            target_infer = include_child_markers and bool(explicit_home) and not explicit_app
        elif include_child_markers and orkest_agy_home:
            sel_gemini = orkest_agy_home
            sel_app = None
            target_infer = True
        elif include_child_markers and os.environ.get("ORKEST_PINNED_AGY_ACCOUNT") == "1":
            sel_gemini = default_agy_home
            sel_app = None
            target_infer = False
        else:
            sel_gemini = (os.environ.get("GEMINI_CLI_HOME") or "").strip() or None
            sel_app = (os.environ.get("ANTIGRAVITY_APP_DATA_DIR") or "").strip() or None
            target_infer = False

        target_pair = _derive_agy_profile_pair(
            sel_gemini,
            sel_app,
            default_home=default_agy_home,
            infer_gemini_basename=target_infer,
        )
        acct_pairs = [
            (
                acct,
                _derive_agy_profile_pair(
                    acct.get("agy_home"),
                    acct.get("agy_app_data_dir"),
                    default_home=default_agy_home,
                    infer_gemini_basename=(
                        include_child_markers
                        and acct.get("agy_app_data_dir") is None
                        and acct.get("agy_home") is not None
                        and not acct.get("agy_typed_gemini_home")
                    ),
                ),
            )
            for acct in accounts
        ]
        for acct, acct_pair in acct_pairs:
            if acct_pair == target_pair:
                return acct
        for acct, acct_pair in acct_pairs:
            if acct_pair[1] == target_pair[1]:
                return acct
        if explicit_home and not explicit_app:
            resolved_explicit = _resolve_path_against_home(explicit_home)
            for acct, _acct_pair in acct_pairs:
                app_dir = acct.get("agy_app_data_dir")
                if app_dir is not None and _resolve_path_against_home(app_dir) == resolved_explicit:
                    return acct
        if not sel_app:
            for acct, acct_pair in acct_pairs:
                if acct.get("agy_app_data_dir") is None and acct_pair[0] == target_pair[0]:
                    return acct
        return None
    return None


def _check_policy_allowed(repo_policy: Any, cwd: Path | str, engine: str, acct: dict[str, Any]) -> bool:
    import inspect

    params = inspect.signature(repo_policy.check_execution_allowed).parameters
    accepts_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
    optional = {
        "account_id": acct.get("account_id") or None,
        "provider": acct.get("provider") or None,
        "billing_mode": acct.get("billing_mode") or None,
        "tags": acct.get("tags") or None,
        "account_alias": acct.get("account_alias") or None,
        "codex_home": acct.get("codex_home"),
        "agy_home": acct.get("agy_home"),
        "agy_app_data_dir": acct.get("agy_app_data_dir"),
        "strict": True,
    }
    kwargs = optional if accepts_kwargs else {k: v for k, v in optional.items() if k in params}
    allowed, _reason, _auto_dir = repo_policy.check_execution_allowed(
        cwd,
        engine,
        acct.get("claude_config_dir"),
        **kwargs,
    )
    return bool(allowed)


def select_auto_account(
    cwd: Path | str,
    engine: str,
    *,
    model: str | None = None,
    strict: bool = False,
) -> dict[str, Any] | None:
    """Select the highest-quota configured Monitor account for `engine` allowed by repository policy."""
    repo_policy = _bundled_module("repo_policy")
    candidates = [acct for acct in load_monitor_accounts(strict=strict) if acct["engine"] == engine]
    allowed_accounts = [acct for acct in candidates if _check_policy_allowed(repo_policy, cwd, engine, acct)]
    if not allowed_accounts:
        return None
    if len(allowed_accounts) == 1:
        return allowed_accounts[0]
    quota = _bundled_module("quota")
    view = quota.snapshot()
    if view is None:
        return allowed_accounts[0]
    lanes = quota.pool_lanes(engine, model or engine, view)
    if not lanes:
        return allowed_accounts[0]
    allowed_ids = {acct["account_id"] for acct in allowed_accounts if acct.get("account_id")}
    best_lane = quota.route_account_lane(
        lanes,
        engine=engine,
        model=model,
        allowed_account_ids=allowed_ids or None,
    )
    if best_lane is not None:
        best_id = str(best_lane.get("accountId") or "").strip()
        matched = next((acct for acct in allowed_accounts if acct.get("account_id") == best_id), None)
        if matched is not None:
            return matched
    return allowed_accounts[0]


def _normalize_route_engine(raw_engine: Any, *, strict: bool = False) -> str | None:
    if not isinstance(raw_engine, str):
        return None
    cleaned = raw_engine.strip().lower()
    if not cleaned:
        return None
    if cleaned in _ROUTE_ENGINE_ALIASES:
        return _ROUTE_ENGINE_ALIASES[cleaned]
    if cleaned in EXECUTION_ENGINES:
        return cleaned
    acct = resolve_configured_account(raw_engine.strip(), strict=strict)
    if acct is not None:
        return acct["engine"]
    return cleaned


def _route_account(route: dict[str, Any], *, strict: bool = False) -> tuple[dict[str, Any] | None, str | None]:
    for key in ("account", "alias", "accountId", "account_id", "accountAlias", "account_alias"):
        val = route.get(key)
        if isinstance(val, str) and val.strip():
            acct = resolve_configured_account(val.strip(), strict=strict)
            return acct, val.strip()
    raw_engine = route.get("engine")
    if isinstance(raw_engine, str) and raw_engine.strip():
        cleaned = raw_engine.strip().lower()
        if cleaned not in _ROUTE_ENGINE_ALIASES and cleaned not in EXECUTION_ENGINES:
            acct = resolve_configured_account(raw_engine.strip(), strict=strict)
            if acct is not None:
                return acct, raw_engine.strip()
    return None, None


def _route_claude_config_dir(route: dict[str, Any]) -> Path | None:
    explicit = route.get("claudeConfigDir") or route.get("claude_config_dir")
    if isinstance(explicit, str) and explicit.strip():
        return Path(explicit.strip()).expanduser()
    acct, _ = _route_account(route)
    if acct is not None and acct["engine"] == "claude":
        return acct["claude_config_dir"]
    return None


def _route_codex_home(route: dict[str, Any]) -> Path | None:
    explicit = route.get("codexHome") or route.get("codex_home")
    if isinstance(explicit, str) and explicit.strip():
        return Path(explicit.strip()).expanduser()
    acct, _ = _route_account(route)
    if acct is not None and acct["engine"] == "codex":
        return acct["codex_home"]
    return None


def _route_agy_home(route: dict[str, Any]) -> Path | None:
    explicit = route.get("agyHome") or route.get("agy_home")
    if isinstance(explicit, str) and explicit.strip():
        return Path(explicit.strip()).expanduser()
    acct, _ = _route_account(route)
    if acct is not None and acct["engine"] == "agy":
        return acct["agy_home"]
    return None


def resolve_route(args: argparse.Namespace) -> argparse.Namespace:
    """Fill engine, model, effort, variant, and account settings from --account, --route, or defaults."""
    module = _attr("routes_module")()
    try:
        routes = module.load_routes()
    except (OSError, ValueError) as error:
        raise _runner_error(f"cannot load routes: {error}", 4) from error

    requested_account = getattr(args, "account", None)
    explicit_account: dict[str, Any] | None = None
    if isinstance(requested_account, str) and requested_account.strip():
        try:
            explicit_account = resolve_configured_account(requested_account.strip(), strict=True)
        except ValueError as error:
            raise _runner_error(str(error), 2) from error
        if explicit_account is None:
            raise _runner_error(
                f"unknown --account {requested_account!r}: not found in Monitor config {monitor_config_path()}",
                4,
            )
        if args.engine and args.engine != explicit_account["engine"]:
            raise _runner_error(
                f"--account {requested_account!r} belongs to engine {explicit_account['engine']!r}, "
                f"not {args.engine!r}",
                4,
            )

    route = None
    if args.route:
        if args.route not in routes:
            raise _runner_error(f"unknown --route {args.route!r}; configured: {', '.join(sorted(routes))}", 4)
        route = routes[args.route]
        try:
            route_exec_engine = _normalize_route_engine(route.get("engine"), strict=True)
            route_acct_check, route_acct_ref = _route_account(route, strict=True)
        except ValueError as error:
            raise _runner_error(str(error), 2) from error
        if route_acct_ref and route_acct_check is None:
            raise _runner_error(
                f"route {args.route!r} references unknown account {route_acct_ref!r}",
                4,
            )
        if route_acct_check is not None:
            if route_exec_engine and route_exec_engine != route_acct_check["engine"]:
                raise _runner_error(
                    f"route {args.route!r} engine {route.get('engine')!r} contradicts account "
                    f"{route_acct_ref!r} ({route_acct_check['engine']!r})",
                    4,
                )
            route_exec_engine = route_acct_check["engine"]
        if args.engine and args.engine != route_exec_engine:
            route = None  # an explicit engine overrides the route entirely
        elif explicit_account is not None and explicit_account["engine"] != route_exec_engine:
            route = None  # an explicit account of another engine overrides the route
        elif (
            not args.engine
            and not args.model
            and explicit_account is None
            and route_exec_engine
            and not shutil.which(route_exec_engine)
        ):
            for alt in route.get("alternates") or ():
                try:
                    alt_exec_engine = (
                        _normalize_route_engine(alt.get("engine"), strict=True) if isinstance(alt, dict) else None
                    )
                except ValueError as error:
                    raise _runner_error(str(error), 2) from error
                if alt_exec_engine and shutil.which(alt_exec_engine):
                    route = alt
                    break
    if args.model and not args.engine and not args.route and explicit_account is None:
        base_model, _ = split_opencode_model(None, args.model)
        families = _attr("load_model_families")()
        parsed = _attr("families_module")().parse_selector(base_model, families)
        if parsed:
            args.engine = families[parsed[0]]["engine"]
        elif base_model:
            if base_model.lower().startswith(("openrouter/", "opencode/")):
                args.engine = "opencode"
            else:
                inferred = _attr("native_engine_for")(base_model)
                if inferred:
                    args.engine = inferred
    try:
        args.engine = (
            args.engine
            or (explicit_account["engine"] if explicit_account else None)
            or _normalize_route_engine((route or {}).get("engine"), strict=True)
            or _attr("DEFAULT_ENGINE", DEFAULT_ENGINE)
        )
    except ValueError as error:
        raise _runner_error(str(error), 2) from error
    route = route or module.engine_default(args.engine, routes)
    route_variant = None
    route_account: dict[str, Any] | None = None
    try:
        route_engine_norm = _normalize_route_engine(route.get("engine"), strict=True) if route else None
    except ValueError as error:
        raise _runner_error(str(error), 2) from error
    if route and route_engine_norm == args.engine:
        if args.model is None and args.route:
            args.model = route.get("model")
        model, _ = split_opencode_model(args.engine, args.model or route.get("model"))
        route_model, _ = split_opencode_model(args.engine, route.get("model"))
        if args.effort is None and route.get("effort") and model == route_model:
            args.effort = route["effort"]
        try:
            route_account, route_acct_ref = _route_account(route, strict=True)
        except ValueError as error:
            raise _runner_error(str(error), 2) from error
        if route_acct_ref and route_account is None:
            raise _runner_error(f"route {args.route or args.engine!r} references unknown account {route_acct_ref!r}", 4)
        if explicit_account is None:
            if args.engine == "claude" and getattr(args, "claude_config_dir", None) is None:
                route_claude_dir = _route_claude_config_dir(route)
                if route_claude_dir is not None:
                    args.claude_config_dir = route_claude_dir
            if args.engine == "codex" and getattr(args, "codex_home", None) is None:
                route_codex_dir = _route_codex_home(route)
                if route_codex_dir is not None:
                    args.codex_home = route_codex_dir
            if args.engine == "agy" and getattr(args, "agy_home", None) is None:
                route_agy_dir = _route_agy_home(route)
                if route_agy_dir is not None:
                    args.agy_home = route_agy_dir
        route_variant = route.get("variant")

    effective_account = explicit_account or route_account
    explicit_claude_dir = getattr(args, "claude_config_dir", None)
    if explicit_account is not None:
        if args.engine == "claude":
            acct_claude_dir = explicit_account["claude_config_dir"]
            if explicit_claude_dir is not None:
                expected_dir = (
                    acct_claude_dir
                    or (
                        (explicit_account["claude_account_home"] / ".claude")
                        if explicit_account["claude_account_home"]
                        else None
                    )
                    or (_resolve_path_against_home(Path.home()) / ".claude")
                )
                if _resolve_path_against_home(explicit_claude_dir) != _resolve_path_against_home(expected_dir):
                    raise _runner_error(
                        f"--account {requested_account!r} profile ({expected_dir}) contradicts "
                        f"--claude-config-dir '{explicit_claude_dir}'",
                        4,
                    )
            elif acct_claude_dir is not None:
                args.claude_config_dir = acct_claude_dir
        elif args.engine == "codex" and getattr(args, "codex_home", None) is None:
            args.codex_home = explicit_account["codex_home"]
        elif args.engine == "agy" and getattr(args, "agy_home", None) is None:
            args.agy_home = explicit_account["agy_home"]

    args.explicit_account = _has_explicit_account_pin(
        args.engine,
        explicit_account=(explicit_account is not None or route_account is not None),
        claude_config_dir=getattr(args, "claude_config_dir", None),
        claude_account_home=getattr(args, "claude_account_home", None),
        codex_home=getattr(args, "codex_home", None),
        agy_home=getattr(args, "agy_home", None),
        agy_app_data_dir=getattr(args, "agy_app_data_dir", None),
        include_child_markers=False,
    )

    if effective_account is None:
        try:
            effective_account = resolve_account_by_home(
                args.engine,
                claude_config_dir=getattr(args, "claude_config_dir", None),
                claude_account_home=getattr(args, "claude_account_home", None),
                codex_home=getattr(args, "codex_home", None),
                agy_home=getattr(args, "agy_home", None),
                agy_app_data_dir=getattr(args, "agy_app_data_dir", None),
                strict=True,
            )
        except ValueError as error:
            raise _runner_error(str(error), 2) from error

    if args.explicit_account and effective_account is not None:
        if args.engine == "claude" and getattr(args, "claude_account_home", None) is None:
            args.claude_account_home = effective_account["claude_account_home"]
        elif args.engine == "codex" and getattr(args, "codex_home", None) is None:
            args.codex_home = effective_account["codex_home"]
        elif args.engine == "agy":
            if getattr(args, "agy_home", None) is None:
                args.agy_home = effective_account["agy_home"]
            if getattr(args, "agy_app_data_dir", None) is None:
                args.agy_app_data_dir = effective_account["agy_app_data_dir"]
    else:
        args.claude_account_home = getattr(args, "claude_account_home", None)
        args.codex_home = getattr(args, "codex_home", None)
        args.agy_home = getattr(args, "agy_home", None)
        args.agy_app_data_dir = getattr(args, "agy_app_data_dir", None)
    for field in ("claude_config_dir", "claude_account_home", "codex_home", "agy_home", "agy_app_data_dir"):
        explicit_val = getattr(args, field, None)
        effective_val = (
            explicit_val
            if explicit_val is not None
            else (effective_account.get(field) if effective_account is not None else None)
        )
        setattr(args, f"effective_{field}", effective_val)
    if (
        args.engine == "agy"
        and getattr(args, "effective_agy_app_data_dir", None) is None
        and effective_account is not None
        and effective_account.get("agy_typed_gemini_home")
        and getattr(args, "effective_agy_home", None) is not None
    ):
        args.effective_agy_app_data_dir = args.effective_agy_home / "antigravity-cli"
    args.account_id = effective_account["account_id"] if effective_account else None
    args.account_alias = effective_account["account_alias"] if effective_account else None
    args.account_provider = effective_account["provider"] if effective_account else None
    args.account_tags = list(effective_account["tags"]) if effective_account else []
    args.account_billing = effective_account["billing_mode"] if effective_account else None

    if args.engine == "opencode":
        args.model, inline_variant = split_opencode_model("opencode", args.model)
        args.variant = (
            getattr(args, "variant", None) or inline_variant or getattr(args, "effort", None) or route_variant
        )
    args.resolved_route = args.route
    return args


def families_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="run_agent.py families",
        description="Show what each model family selector resolves to in the live catalogs.",
    )
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--refresh", action="store_true", help="Refresh the model catalogs first")
    parser.add_argument(
        "--audit",
        action="store_true",
        help="Check live catalogs and families.json for unmapped IDs and unresolved tiers",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero when --audit finds unmapped live models or unresolved tiers",
    )
    args = parser.parse_args(argv)
    families = _attr("load_model_families")()
    mod = _attr("families_module")()
    engines = sorted({family["engine"] for family in families.values() if isinstance(family.get("engine"), str)})
    catalog_records: dict[str, dict[str, Any]] = {}
    catalogs: dict[str, list[str]] = {}
    for engine in engines:
        catalog = _attr("discover_engine_catalog")(engine, refresh=args.refresh)
        catalog_records[engine] = catalog
        if catalog.get("status") == "live":
            catalogs[engine] = [m["id"] for m in catalog.get("models", []) if not m.get("hidden", False)]
    rows = mod.report(families, catalogs)
    if args.audit:
        audit_result = mod.audit(families, catalog_records)
        if args.format == "json":
            print(
                json.dumps(
                    {
                        "schema": "agent-executor.families-audit.v1",
                        **audit_result,
                        "families": rows,
                    },
                    indent=2,
                )
            )
            return 1 if (args.strict and audit_result["has_drift"]) else 0
        unresolved = audit_result["unresolved_tiers"]
        unmapped = audit_result["unmapped_models"]
        unavailable = audit_result["unavailable_engines"]
        print(
            f"Audit: {len(unresolved)} unresolved tier(s), "
            f"{len(unmapped)} unmapped live model(s)"
            + (f" ({len(unavailable)} unavailable engine(s): {', '.join(unavailable)})" if unavailable else "")
        )
        if unresolved:
            print("Unresolved tiers:")
            for item in unresolved:
                print(f"  {item['selector']} ({item['engine']}, target={item['target']!r}) -> None")
        if unmapped:
            print("Unmapped live catalog IDs:")
            for item in unmapped[:25]:
                print(f"  {item['engine']}: {item['id']}")
            if len(unmapped) > 25:
                print(f"  ... (+{len(unmapped) - 25} more)")
        if not unresolved and not unmapped:
            print("No drift detected across available catalogs.")
        return 1 if (args.strict and audit_result["has_drift"]) else 0

    if args.format == "json":
        print(json.dumps(rows, indent=2))
        return 0
    for row in rows:
        print(f"{row['family']} ({row['engine']}, default tier {row['default_tier']})")
        empty = "(no match)" if row["catalog"] == "live" else f"(no live {row['engine']} catalog)"
        for tier, model in row["resolved"].items():
            print(f"  {row['family']}:{tier:<10} {model or empty}")
    return 0


def routes_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="run_agent.py routes", description="Show the role routes in effect (defaults plus your config)."
    )
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    module = _attr("routes_module")()
    routes = module.load_routes()
    if args.format == "json":
        print(json.dumps({"config": str(module.config_path()), "routes": routes}, indent=2))
        return 0
    print(f"config: {module.config_path()}{'' if module.config_path().exists() else ' (not present: defaults only)'}")
    for role, route in routes.items():
        extra = " ".join(f"--{key} {value}" for key, value in route.items() if key in ("effort", "variant"))
        print(
            f"  {role:<15} --engine {route['engine']} --model {route.get('model', '(engine default)')} {extra}".rstrip()
        )
    return 0


def init_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="run_agent.py init", description="Write a starter route config.")
    parser.add_argument("--force", action="store_true", help="Replace an existing config")
    args = parser.parse_args(argv)
    module = _attr("routes_module")()
    path = module.config_path()
    if path.exists() and not args.force:
        print(f"{path} exists; pass --force to replace it")
        return 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(module.starter_config(), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}; edit the routes there")
    return 0
