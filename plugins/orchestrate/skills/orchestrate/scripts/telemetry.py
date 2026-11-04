#!/usr/bin/env python3
"""Summarize local task outcomes by archetype and executor route."""

from __future__ import annotations

import argparse
import datetime as dt
import functools
import importlib.util
import json
import math
import os
import statistics
import time
from pathlib import Path
from typing import Any

Z_95 = 1.959963984540054
FAILURE_STATUSES = {"FAILED", "FAILURE", "VERIFICATION_FAILED", "PARTIAL"}
NON_QUALITY_OUTCOMES = {"dry_run", "preflight_failed", "provider_quota_exhausted"}
WINDOW_14D_SECONDS = 14 * 86400
DEGRADATION_MIN_QUALITY_RUNS = 5
DEGRADATION_MIN_DROP = 0.15


@functools.cache
def _runtime_paths() -> Any:
    path = Path(__file__).with_name("runtime_paths.py")
    spec = importlib.util.spec_from_file_location("orchestrate_runtime_paths", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load runtime_paths")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def default_runs_dir() -> Path:
    """Match run_agent.py's cache root and versioned result directory."""
    rt = _runtime_paths()
    primary = rt.cache_home() / "runs-v1"
    if primary.exists() or rt.env_first("ORCHESTRATE_HOME", "AGENT_EXECUTOR_HOME"):
        return primary
    xdg = os.environ.get("XDG_CACHE_HOME")
    cache_root = Path(xdg).expanduser() if xdg else Path.home() / ".cache"
    legacy_runs = cache_root / "agent-executor" / "runs-v1"
    if legacy_runs.exists():
        return legacy_runs
    return primary


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _field(result: dict[str, Any], key: str) -> Any:
    for source in (result, _mapping(result.get("route")), _mapping(result.get("request"))):
        value = source.get(key)
        if value is not None:
            return value
    return None


def _label(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("bound", value.get("effort"))
    if value is None or not str(value).strip():
        return "unspecified"
    return str(value).strip()


def _task_archetype(result: dict[str, Any]) -> str:
    for key in ("task_archetype", "role"):
        value = _field(result, key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return "unspecified"


def _requested_model(result: dict[str, Any]) -> str | None:
    for source in (result, _mapping(result.get("route")), _mapping(result.get("request"))):
        value = source.get("requested_model")
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _is_quality_run(result: dict[str, Any]) -> bool:
    """Exclude dry runs, preflight failures, and quota exhaustion from quality denominators."""
    if result.get("dry_run") is True:
        return False
    review = _mapping(result.get("review"))
    outcomes = (review.get("task_outcome"), result.get("task_outcome"), review.get("status"), result.get("status"))
    return not any(isinstance(value, str) and value.strip().lower() in NON_QUALITY_OUTCOMES for value in outcomes)


def _accepted(result: dict[str, Any]) -> bool:
    if not _is_quality_run(result):
        return False
    review = _mapping(result.get("review"))
    outcomes = (review.get("task_outcome"), result.get("task_outcome"), review.get("status"), result.get("status"))
    return any(isinstance(value, str) and value.strip().upper() in {"COMPLETE", "ACCEPTED"} for value in outcomes)


def _verification_failed(result: dict[str, Any]) -> bool:
    review = _mapping(result.get("review"))
    for verification in (result.get("verification"), review.get("verification")):
        if verification is False:
            return True
        if not isinstance(verification, dict):
            if isinstance(verification, str) and verification.strip().upper() in FAILURE_STATUSES:
                return True
            continue
        if verification.get("passed") is False:
            return True
        status = verification.get("status")
        if isinstance(status, str) and status.strip().upper() in FAILURE_STATUSES:
            return True
    return False


def _attempt_count(result: dict[str, Any]) -> int | None:
    attempts = result.get("attempts", result.get("executor_attempts"))
    if isinstance(attempts, list):
        return len(attempts)
    if type(attempts) is int and attempts >= 0:
        return attempts
    return None


def _first_pass(result: dict[str, Any], accepted: bool) -> bool:
    if not accepted or _verification_failed(result):
        return False
    attempts = _attempt_count(result)
    return not result.get("resumed_from") or attempts == 1


def _duration_ms(result: dict[str, Any]) -> float | None:
    timing = _mapping(result.get("timing"))
    candidates = (
        result.get("duration_ms"),
        result.get("elapsed_ms"),
        timing.get("duration_ms"),
    )
    for value in candidates:
        if type(value) in {int, float} and math.isfinite(value) and value >= 0:
            return float(value)
    seconds = result.get("duration_seconds")
    if type(seconds) in {int, float} and math.isfinite(seconds) and seconds >= 0:
        return float(seconds) * 1000
    return None


def _parse_timestamp(value: Any) -> float | None:
    if isinstance(value, dt.datetime):
        aware = value if value.tzinfo is not None else value.replace(tzinfo=dt.UTC)
        return aware.timestamp()
    if type(value) in {int, float} and math.isfinite(value):
        return float(value)
    if isinstance(value, str) and value.strip():
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = dt.datetime.fromisoformat(text)
        except ValueError:
            return None
        aware = parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=dt.UTC)
        return aware.timestamp()
    return None


def _run_timestamp(result: dict[str, Any]) -> float | None:
    timing = _mapping(result.get("timing"))
    request = _mapping(result.get("request"))
    for candidate in (
        result.get("completed_at"),
        result.get("finished_at"),
        timing.get("completed_at"),
        timing.get("finished_at"),
        result.get("started_at"),
        timing.get("started_at"),
        result.get("created_at"),
        request.get("created_at"),
        result.get("timestamp"),
        result.get("_mtime"),
    ):
        parsed = _parse_timestamp(candidate)
        if parsed is not None:
            return parsed
    return None


def wilson_lower_bound(successes: int, trials: int, z: float = Z_95) -> float | None:
    """Return the two-sided Wilson 95% lower bound, or None without observations."""
    if trials <= 0:
        return None
    rate = successes / trials
    z_squared = z * z
    denominator = 1 + z_squared / trials
    center = rate + z_squared / (2 * trials)
    margin = z * math.sqrt(rate * (1 - rate) / trials + z_squared / (4 * trials * trials))
    return max(0.0, (center - margin) / denominator)


def _read_results(runs_dir: Path) -> tuple[list[dict[str, Any]], int]:
    root = runs_dir.expanduser().resolve()
    results = []
    skipped = 0
    if not root.is_dir():
        return results, skipped
    for path in sorted(root.glob("*/result.json")):
        try:
            if path.is_symlink() or path.parent.is_symlink():
                skipped += 1
                continue
            resolved = path.resolve(strict=True)
            if resolved.parent.parent != root or not resolved.is_file():
                skipped += 1
                continue
            value = json.loads(resolved.read_text(encoding="utf-8"))
            mtime = resolved.parent.stat().st_mtime
        except (OSError, ValueError):
            skipped += 1
            continue
        if not isinstance(value, dict):
            skipped += 1
            continue
        value = dict(value)
        value.setdefault("_mtime", mtime)
        results.append(value)
    return results, skipped


def summarize_runs(
    runs_dir: Path | str,
    *,
    now: float | str | dt.datetime | None = None,
) -> dict[str, Any]:
    """Group result receipts by task archetype, engine, model, and effort."""
    now_ts = _parse_timestamp(now) if now is not None else None
    if now_ts is None:
        now_ts = time.time()
    results, skipped = _read_results(Path(runs_dir))
    groups: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
    for result in results:
        key = (
            _task_archetype(result),
            _label(_field(result, "engine")),
            _label(_field(result, "model")),
            _label(_field(result, "effort")),
        )
        groups.setdefault(key, []).append(result)

    rows = []
    for (archetype, engine, model, effort), values in sorted(groups.items()):
        run_count = len(values)
        quality_values = [value for value in values if _is_quality_run(value)]
        quality_run_count = len(quality_values)
        accepted_count = sum(_accepted(value) for value in quality_values)
        first_pass_count = sum(_first_pass(value, _accepted(value)) for value in quality_values)
        durations = [duration for value in values if (duration := _duration_ms(value)) is not None]
        first_pass_rate = round(first_pass_count / quality_run_count, 6) if quality_run_count else 0.0
        accepted_rate = round(accepted_count / quality_run_count, 6) if quality_run_count else 0.0
        bound = wilson_lower_bound(accepted_count, quality_run_count)

        quality_14d = [
            value
            for value in quality_values
            if (ts := _run_timestamp(value)) is not None and (now_ts - ts) <= WINDOW_14D_SECONDS
        ]
        rolling_14d_runs = len(quality_14d)
        rolling_14d_accepted = sum(_accepted(value) for value in quality_14d)
        rolling_14d_rate = round(rolling_14d_accepted / rolling_14d_runs, 6) if rolling_14d_runs > 0 else None
        rolling_14d_bound = wilson_lower_bound(rolling_14d_accepted, rolling_14d_runs)
        raw_drop = (accepted_rate - rolling_14d_rate) if rolling_14d_rate is not None else 0.0
        degradation_drop = round(raw_drop, 4)
        degraded = bool(
            rolling_14d_runs >= DEGRADATION_MIN_QUALITY_RUNS
            and rolling_14d_rate is not None
            and raw_drop >= DEGRADATION_MIN_DROP
        )

        rows.append(
            {
                "task_archetype": archetype,
                "engine": engine,
                "model": model,
                "effort": effort,
                "runs": run_count,
                "quality_runs": quality_run_count,
                "accepted_runs": accepted_count,
                "first_pass_runs": first_pass_count,
                "first_pass_rate": first_pass_rate,
                "accepted_rate": accepted_rate,
                "wilson_lb_95": round(bound, 6) if bound is not None else None,
                "rolling_14d_runs": rolling_14d_runs,
                "rolling_14d_success_rate": rolling_14d_rate,
                "rolling_14d_wilson_lower_bound": (
                    round(rolling_14d_bound, 6) if rolling_14d_bound is not None else None
                ),
                "degraded": degraded,
                "degradation_drop": degradation_drop,
                "median_duration_ms": round(statistics.median(durations), 3) if durations else None,
                "requested_models": sorted({model for value in values if (model := _requested_model(value))}),
            }
        )
    return {
        "schema": "agent-executor.telemetry.v1",
        "runs": len(results),
        "skipped_results": skipped,
        "groups": rows,
    }


def rank_candidates_by_telemetry(
    candidates: list[dict[str, Any]],
    task_archetype: str,
    *,
    summary: dict[str, Any] | None = None,
    runs_dir: Path | str | None = None,
    min_runs: int = 3,
    min_wilson_delta: float = 0.05,
) -> list[dict[str, Any]]:
    """Reorder healthy candidate slots only when sample and Wilson-delta gates are met, and demote degraded buckets."""
    if type(min_runs) is not int or min_runs < 1:
        raise ValueError("min_runs must be a positive integer")
    if (
        type(min_wilson_delta) not in {int, float}
        or not math.isfinite(min_wilson_delta)
        or not 0 <= min_wilson_delta <= 1
    ):
        raise ValueError("min_wilson_delta must be between zero and one")
    data = summary if summary is not None else summarize_runs(runs_dir or default_runs_dir())
    rows = data.get("groups", []) if isinstance(data, dict) else []
    ranked = []
    for original_index, candidate in enumerate(candidates):
        copy = dict(candidate)
        candidate_models = {str(candidate.get("model", ""))}
        candidate_models.update(str(value) for value in candidate.get("telemetry_models", []) if value)
        candidate_models.update(str(value) for value in candidate.get("requested_models", []) if value)
        candidate_effort = _label(candidate.get("effort")) if candidate.get("effort") is not None else None
        matches = [
            row
            for row in rows
            if isinstance(row, dict)
            and row.get("task_archetype") == task_archetype
            and row.get("engine") == candidate.get("engine")
            and (
                row.get("model") in candidate_models
                or bool(candidate_models.intersection(row.get("requested_models", [])))
            )
            and (candidate_effort is None or row.get("effort") == candidate_effort)
        ]
        trials = sum(
            row.get("quality_runs", row.get("runs", 0))
            for row in matches
            if type(row.get("quality_runs", row.get("runs"))) is int
            and row.get("quality_runs", row.get("runs", 0)) >= 0
        )
        successes = sum(
            row.get(
                "accepted_runs",
                round(row.get("accepted_rate", 0) * row.get("quality_runs", row.get("runs", 0))),
            )
            for row in matches
            if type(row.get("accepted_runs", row.get("accepted_rate"))) in {int, float}
        )
        first_pass = sum(
            row.get(
                "first_pass_runs",
                round(row.get("first_pass_rate", 0) * row.get("quality_runs", row.get("runs", 0))),
            )
            for row in matches
            if type(row.get("first_pass_runs", row.get("first_pass_rate"))) in {int, float}
        )
        degraded = any(bool(row.get("degraded")) for row in matches)
        bound = wilson_lower_bound(successes, trials) if trials else None
        # Recovery is the accepted share of attempts that were not completed on the first pass.
        recovery_opportunities = max(0, trials - first_pass)
        recovery_rate = max(0, successes - first_pass) / recovery_opportunities if recovery_opportunities else None
        copy["sample_count"] = trials if matches else None
        copy["wilson_lb_95"] = round(bound, 6) if bound is not None else None
        copy["recovery_rate"] = round(recovery_rate, 6) if recovery_rate is not None else None
        copy["degraded"] = degraded
        if not matches:
            status = "no_telemetry"
        elif degraded:
            status = "degraded"
        elif trials < min_runs:
            status = "insufficient_sample"
        else:
            status = "available"
        copy["telemetry_status"] = status
        copy["_telemetry_original_index"] = original_index
        ranked.append(copy)

    healthy_slots = [
        index
        for index, candidate in enumerate(ranked)
        if candidate.get("quota_pace") == "available"
        and not candidate.get("degraded")
        and candidate["sample_count"] is not None
        and candidate["sample_count"] >= min_runs
        and candidate["wilson_lb_95"] is not None
    ]
    for start in range(len(healthy_slots) - 1):
        best_offset = max(
            range(start, len(healthy_slots)),
            key=lambda offset: (
                ranked[healthy_slots[offset]]["wilson_lb_95"],
                -ranked[healthy_slots[offset]]["_telemetry_original_index"],
            ),
        )
        current = ranked[healthy_slots[start]]
        best = ranked[healthy_slots[best_offset]]
        if best["wilson_lb_95"] - current["wilson_lb_95"] > min_wilson_delta:
            ranked[healthy_slots[start]], ranked[healthy_slots[best_offset]] = best, current
    if any(candidate.get("degraded") for candidate in ranked):
        ranked = [c for c in ranked if not c.get("degraded")] + [c for c in ranked if c.get("degraded")]
    for candidate in ranked:
        candidate.pop("_telemetry_original_index", None)
    return ranked


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    summarize = commands.add_parser("summarize", help="summarize local result receipts")
    summarize.add_argument("--runs-dir", type=Path, default=default_runs_dir())
    summarize.add_argument("--format", choices=("json",), default="json")
    args = parser.parse_args(argv)
    print(json.dumps(summarize_runs(args.runs_dir), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
