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
CLAUDE_MODEL_ALIASES = ("opus", "sonnet", "haiku", "fable")
CLAUDE_MODEL_ID = re.compile(r"^claude-[a-z0-9][a-z0-9.\-]*(\[1m\])?$")
EXIT_ROUTE_NOT_ALLOWED = 17
DEFAULT_CATALOG_MAX_AGE_SECONDS = 24 * 60 * 60
MODEL_CATALOG_SCHEMA = "agent-executor.models.v1"
MODEL_CACHE_SCHEMA = "agent-executor.model-cache.v1"

_NATIVE_FAMILIES = (
    ("claude", {"anthropic"}, {"claude", "opus", "sonnet", "haiku", "fable"}),
    ("codex", {"openai"}, {"gpt", "chatgpt", "codex"}),
    ("agy", {"google", "google-ai-studio", "google-vertex", "vertex"}, {"gemini"}),
)

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
    return {
        "id": model_id,
        "display_name": item.get("displayName") or model_id,
        "description": item.get("description") or "",
        "default": bool(item.get("isDefault", False)),
        "hidden": bool(item.get("hidden", False)),
        "reasoning_efforts": reasoning_efforts,
        "default_reasoning_effort": item.get("defaultReasoningEffort"),
        "service_tiers": service_tiers,
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


def simple_model_records(lines: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line in lines.splitlines():
        model_id, _, display_name = line.strip().partition("\t")
        if not model_id or re.search(r"\s", model_id) or model_id in seen:
            continue
        seen.add(model_id)
        records.append(
            {
                "id": model_id,
                "display_name": display_name.strip() or model_id,
                "description": "",
                "default": False,
                "hidden": False,
                "reasoning_efforts": [],
                "default_reasoning_effort": None,
                "service_tiers": [],
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
            # No safe model-list command: offer the tier aliases (never invoke Claude to discover models).
            return {
                "engine": engine,
                "status": "live",
                "source": "claude aliases (Claude Code has no model-list command)",
                "executable": executable,
                "version": version,
                "discovered_at": discovered_at,
                "models": [
                    {"id": alias, "name": f"Claude {alias.title()} (current)", "hidden": False}
                    for alias in CLAUDE_MODEL_ALIASES
                ],
                "error": None,
            }
        if engine == "codex":
            models = _attr("codex_model_records")(executable, environment)
            source = "codex app-server model/list"
        elif engine == "agy":
            output = _attr("run_checked")([executable, "models"], timeout=60, environment=environment).stdout.decode(
                "utf-8", errors="replace"
            )
            models = _attr("simple_model_records")(output)
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
            models = _attr("simple_model_records")(output)
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
        not isinstance(item, dict) or not isinstance(item.get("id"), str) or re.search(r"\s", item["id"])
        for item in catalog.get("models", [])
    ):
        return None  # Refresh catalogs written by the pre-column-aware parser.
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
    if not refresh and engine != "claude":
        cached = _attr("cached_catalog_entry")(
            _attr("read_model_cache")(path),
            engine,
            executable=executable,
            version=version,
            max_age_seconds=max_age_seconds,
        )
        if cached is not None:
            cached["cache"]["path"] = str(path)
            return cached

    catalog = _attr("discover_live_engine_catalog")(
        engine,
        refresh=refresh,
        executable=executable,
        version=version,
    )
    catalog["cache"] = {
        "status": ("not_applicable" if engine == "claude" else ("refreshed" if refresh else "miss")),
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
    segments = model.lower().split("/")
    tokens = re.split(r"[-_.:~]", segments[-1])
    if "gemma" in tokens or any(a == "gpt" and b == "oss" for a, b in zip(tokens, tokens[1:], strict=False)):
        return None
    for engine, providers, names in _NATIVE_FAMILIES:
        if any(segment in providers for segment in segments[:-1]):
            return engine
        for index, token in enumerate(tokens):
            if token in names and not (token == "gpt" and index + 1 < len(tokens) and tokens[index + 1] == "oss"):
                return engine
    return None


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
    _attr("note_selector_advance")(selector, model)
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


def resolve_route(args: argparse.Namespace) -> argparse.Namespace:
    """Fill engine, model, effort and variant from --route, or from the engine's default route."""
    module = _attr("routes_module")()
    try:
        routes = module.load_routes()
    except (OSError, ValueError) as error:
        raise _runner_error(f"cannot load routes: {error}", 4) from error
    route = None
    if args.route:
        if args.route not in routes:
            raise _runner_error(f"unknown --route {args.route!r}; configured: {', '.join(sorted(routes))}", 4)
        route = routes[args.route]
        if args.engine and args.engine != route["engine"]:
            route = None  # an explicit engine overrides the route entirely
        elif not args.engine and not args.model and route.get("engine") and not shutil.which(route["engine"]):
            for alt in route.get("alternates") or ():
                if isinstance(alt, dict) and alt.get("engine") and shutil.which(str(alt["engine"])):
                    route = alt
                    break
    if args.model and not args.engine and not args.route:
        base_model, _ = split_opencode_model(None, args.model)
        families = _attr("load_model_families")()
        parsed = _attr("families_module")().parse_selector(base_model, families)
        if parsed:
            args.engine = families[parsed[0]]["engine"]
    args.engine = args.engine or (route or {}).get("engine") or _attr("DEFAULT_ENGINE", DEFAULT_ENGINE)
    route = route or module.engine_default(args.engine, routes)
    route_variant = None
    if route and route.get("engine") == args.engine:
        if args.model is None and args.route:
            args.model = route.get("model")
        model, _ = split_opencode_model(args.engine, args.model or route.get("model"))
        route_model, _ = split_opencode_model(args.engine, route.get("model"))
        if args.effort is None and route.get("effort") and model == route_model:
            args.effort = route["effort"]
        route_variant = route.get("variant")
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
    args = parser.parse_args(argv)
    families = _attr("load_model_families")()
    catalogs: dict[str, list[str]] = {}
    for engine in sorted({family["engine"] for family in families.values()}):
        catalog = _attr("discover_engine_catalog")(engine, refresh=args.refresh)
        if catalog.get("status") == "live":
            catalogs[engine] = [m["id"] for m in catalog.get("models", []) if not m.get("hidden", False)]
    rows = _attr("families_module")().report(families, catalogs)
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
