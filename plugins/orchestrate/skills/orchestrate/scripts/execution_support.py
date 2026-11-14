"""Small execution contracts shared by the runner and its conductor."""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import json
import os
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:
    fcntl = None


def _load_repo_paths() -> Any:
    """Load the shared path rules by file. These scripts are loaded by path from a copied directory,
    so a sibling is not importable by name unless a caller happened to put it on `sys.path`."""
    spec = importlib.util.spec_from_file_location(
        "agent_executor_repo_paths", Path(__file__).with_name("repo_paths.py")
    )
    if spec is None or spec.loader is None:
        raise ImportError("could not load repository path rules")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_REPO_PATHS = _load_repo_paths()


def _load_families_mod() -> Any:
    """Load shared family rules by file alongside repo_paths."""
    spec = importlib.util.spec_from_file_location("agent_executor_families", Path(__file__).with_name("families.py"))
    if spec is None or spec.loader is None:
        raise ImportError("could not load family rules")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_FAMILIES = _load_families_mod()


class ContractError(ValueError):
    pass


class LeaseDescriptor(int):
    """An existing caller's primary descriptor, plus the full set for pass_fds."""

    def __new__(cls, descriptors: list[int]) -> LeaseDescriptor:
        instance = super().__new__(cls, descriptors[0])
        instance.descriptors = tuple(descriptors)
        return instance


def lease_roots(cache: Path) -> list[Path]:
    """Bridge existing well-known roots, preserving a nested namespace."""
    cache = cache.resolve()
    roots = {cache}
    if not (os.environ.get("ORCHESTRATE_HOME") or os.environ.get("AGENT_EXECUTOR_HOME")):
        for base in (cache, *cache.parents):
            if base.name in {"orchestrate", "agent-executor"}:
                other = base.parent / ("agent-executor" if base.name == "orchestrate" else "orchestrate")
                # Workspace locks establish whether the sibling is an active lease root.
                if (other / "worktree-locks-v1").is_dir():
                    roots.add((other / cache.relative_to(base)).resolve())
                break
    return sorted(roots, key=str)


@contextlib.contextmanager
def workspace_lease(repository: Path, cache: Path, *, read_only: bool = False) -> Iterator[int]:
    """Allow concurrent readers or one writer across all active lease roots.

    Callers explicitly pass every descriptor to executor and consultant children
    to extend ownership across parent death. A surviving descendant may keep the
    advisory lease until it exits; descriptors are closed, never explicitly unlocked.

    Keep the lock file in place. Unlinking a flock file allows another process to
    acquire a different inode while an existing holder still owns the old one.
    This does not stop editors or other tools from changing the workspace.
    """
    if fcntl is None:
        raise ContractError("workspace leases require POSIX flock on this platform")
    repository = repository.resolve()
    key = hashlib.sha256(os.fsencode(str(repository))).hexdigest()
    descriptors = []
    try:
        for root in lease_roots(cache):
            directory = root / "worktree-locks-v1"
            if directory == repository or repository in directory.parents:
                raise ContractError("the executor cache must be outside the repository")
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor = os.open(directory / (key + ".lock"), os.O_CREAT | os.O_RDWR, 0o600)
            descriptors.append(descriptor)
            try:
                fcntl.flock(descriptor, (fcntl.LOCK_SH if read_only else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ContractError(f"another executor owns the worktree: {repository}") from exc
        yield LeaseDescriptor(descriptors)
    finally:
        # Never unlink or explicitly unlock an inode another holder may share.
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _catalog_record(catalog: dict[str, Any], model: str) -> dict[str, Any]:
    if not isinstance(catalog, dict):
        return {}
    return next((item for item in catalog.get("models", []) if isinstance(item, dict) and item.get("id") == model), {})


def _record_supported_efforts(record: dict[str, Any]) -> list[str]:
    if not record:
        return []
    raw = record.get("supported_efforts")
    if not isinstance(raw, list):
        raw = record.get("reasoning_efforts", [])
    return [str(item).strip().lower() for item in raw if isinstance(item, str) and item.strip()]


def bind_effort(engine: str, model: str, requested: str | None, catalog: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "requested": requested,
        "bound": None,
        "binding": "cli_default_or_config",
        "observed": None,
    }
    record = _catalog_record(catalog, model)
    if engine == "codex" and requested is not None:
        supported = _record_supported_efforts(record)
        if requested not in supported:
            raise ContractError(f"effort {requested!r} is not advertised for {model}; supported: {supported}")
        result.update(bound=requested, binding="model_reasoning_effort")
    elif engine == "agy":
        # Exact catalog-validated slugs work on old and new AGY versions. Never
        # silently change the user's selected model to satisfy an effort request.
        suffixes = _FAMILIES.effort_suffixes()
        if record:
            if record.get("composite") or (record.get("effort_slug") is None and not _record_supported_efforts(record)):
                bound = None
            else:
                bound = record.get("effort_slug")
        else:
            head, sep, tail = model.rpartition("-")
            bound = tail.lower() if (sep and head and tail.lower() in suffixes) else None
        if requested is not None and requested != bound:
            suffix_text = ", ".join(f"-{s}" for s in suffixes)
            raise ContractError(f"AGY effort must match an exact catalog model ending in one of: {suffix_text}")
        if bound:
            result.update(bound=bound, binding="catalog_model_slug")
    elif engine == "claude" and requested is not None:
        supported = _record_supported_efforts(record) or list(_FAMILIES.claude_default_efforts())
        if requested not in supported:
            raise ContractError(f"Claude effort must be one of {', '.join(supported)}")
        result.update(bound=requested, binding="claude --effort")
    elif engine == "opencode" and requested is not None:
        supported = _record_supported_efforts(record)
        variants = record.get("variants") if isinstance(record.get("variants"), list) else []
        allowed = list(dict.fromkeys([*supported, *[str(v).lower() for v in variants if isinstance(v, str)]]))
        if allowed and requested.lower() not in allowed:
            raise ContractError(
                f"effort/variant {requested!r} is not supported for {model}; supported: {', '.join(allowed)}"
            )
        result.update(bound=requested, binding="opencode_variant")
    elif requested is not None:
        raise ContractError("--effort is supported for Codex, AGY and Claude; use --variant for OpenCode")
    return result


CONSULTATION_FIELDS = ("question", "decision_needed", "observations", "attempts", "versions", "hypotheses")


def validate_consultation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError("consultation request must be an object")
    unknown = set(value) - set(CONSULTATION_FIELDS)
    if unknown:
        raise ContractError("unknown consultation fields: " + ", ".join(sorted(unknown)))
    for field in CONSULTATION_FIELDS:
        entry = value.get(field)
        if field in ("question", "decision_needed"):
            if not isinstance(entry, str) or not entry.strip():
                raise ContractError(f"consultation {field} must be a nonempty string")
        elif not isinstance(entry, list) or any(not isinstance(item, str) or not item.strip() for item in entry):
            raise ContractError(f"consultation {field} must be an array of nonempty strings")
    if not value["observations"] or not value["hypotheses"]:
        raise ContractError("consultation needs observations and at least one hypothesis")
    if len(json.dumps(value).encode()) > 16 * 1024:
        raise ContractError("consultation request exceeds 16 KiB")
    return {field: value[field] for field in CONSULTATION_FIELDS}


def consultation_from_report(report: str, outcome: str | None) -> dict[str, Any]:
    """A worker may request advice. It cannot approve it or mark evidence verified."""
    blocks = list(re.finditer(r"(?ms)^```consultation-request\s*\n(.*?)^```\s*$", report))
    if not blocks:
        return {"status": "not_requested", "request": None, "error": None}
    try:
        if len(blocks) != 1:
            raise ContractError("expected one consultation-request block")
        risk = list(re.finditer(r"(?im)^(?:#{1,6}\s+)?RISKS OR BLOCKERS\s*$", report))
        if not risk or blocks[0].start() < risk[-1].end():
            raise ContractError("consultation request must be under RISKS OR BLOCKERS")
        if outcome not in {"blocked", "failed"}:
            raise ContractError("consultation requests require a BLOCKED or FAILED outcome")
        request = validate_consultation(json.loads(blocks[0].group(1)))
        return {"status": "requested", "request": request, "error": None}
    except (ValueError, TypeError) as exc:
        return {"status": "invalid", "request": None, "error": str(exc)}


RESUMABLE_STATUSES = {
    "completed",
    "blocked",
    "failed",
    "no_changes",
    "verification_failed",
    "malformed_report",
    "timed_out",
    "empty_output",
    "steered",
}


SELECTOR_TIERS: dict[str, int] = _FAMILIES.selector_capability_tiers()


def model_capability_tier(model: str | None) -> int | None:
    """Return a coarse capability tier (1=fast/lightweight .. 4=apex frontier), or None when unknown."""
    return _FAMILIES.capability_tier(model)


def is_upward_delegation(conductor_model: str | None, worker_model: str | None) -> bool:
    """True when a lower-tier conductor dispatches to a higher-tier worker."""
    conductor_tier = model_capability_tier(conductor_model)
    worker_tier = model_capability_tier(worker_model)
    if conductor_tier is None or worker_tier is None:
        return False
    return conductor_tier < worker_tier


def _path_covered(path: str, prefixes: list[str]) -> bool:
    return _REPO_PATHS.path_covered_by_prefixes(path, prefixes)


def validate_resume(previous: dict[str, Any], expected: dict[str, Any]) -> None:
    if not isinstance(previous, dict):
        raise ContractError("resume baseline must be a JSON object")
    if previous.get("schema") != "agent-executor.result.v2":
        raise ContractError("resume baseline is not an agent-executor result")
    if previous.get("status") not in RESUMABLE_STATUSES:
        raise ContractError("this runner outcome requires conductor investigation before resumption")
    if not isinstance(previous.get("session_id"), str) or not previous["session_id"].strip():
        raise ContractError("resume baseline has no session_id")
    if previous.get("scope_violations") or previous.get("history_violations"):
        raise ContractError("cannot resume a result with scope or history violations")
    for field, value in expected.items():
        if field == "executor_version":
            continue
        actual = previous.get(field)
        if field == "effort":
            actual = (actual or {}).get("bound")
        if field == "allowed_paths":
            prev_paths = actual if isinstance(actual, list) else []
            new_paths = value if isinstance(value, list) else []
            if prev_paths != new_paths and (
                not new_paths or not all(_path_covered(str(p), new_paths) for p in prev_paths)
            ):
                raise ContractError(f"resume result does not match {field}")
            continue
        if actual != value:
            raise ContractError(f"resume result does not match {field}")
