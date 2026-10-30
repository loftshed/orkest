#!/usr/bin/env python3
"""Render a runner-compatible execution brief from a concise JSON task spec."""

from __future__ import annotations

import argparse
import functools
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

REPORT_HEADINGS = (
    "STATUS",
    "FILES CHANGED",
    "COMMANDS RUN",
    "VERIFICATION",
    "RISKS OR BLOCKERS",
)
REQUIRED_FIELDS = (
    "objective",
    "repository_root",
    "current_state",
    "pre_existing_changes",
    "plan",
    "allow_paths",
    "track_paths",
    "development_checks",
    "acceptance_criteria",
)
COMMON_CONSTRAINTS = (
    "Follow all applicable AGENTS.md and repository instructions.",
    "Preserve unrelated and pre-existing user changes.",
    "Do not change public behavior outside the objective.",
    "Do not add dependencies unless the plan explicitly requires them.",
    "Do not edit checklists, completion plans, or status claims unless an exact file and evidence requirement appear in the approved scope.",
    "Do not commit, push, merge, reset, clean, stash, checkout, switch branches, create worktrees, or share/publish the session.",
    "The allowed paths constrain writes, not relevant read-only investigation. Follow evidence across repository files and applicable documentation within the objective.",
    "Bring senior-specialist craft and independent judgment to the objective; keep communication with the conductor or peers relaxed, friendly, and natural when asking about missing context or needed scope changes, and continue independent work when possible. Report BLOCKED only when the missing answer prevents useful progress.",
)


class BriefSpecError(ValueError):
    """Raised when a task spec cannot produce a safe standalone brief."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", required=True, help="JSON spec file, or '-' for stdin")
    parser.add_argument(
        "--output",
        default="-",
        help="Rendered Markdown destination, or '-' for stdout (default: '-')",
    )
    return parser.parse_args(argv)


def read_json(source: str) -> dict[str, Any]:
    raw = sys.stdin.read() if source == "-" else Path(source).expanduser().read_text(encoding="utf-8")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BriefSpecError(f"invalid JSON: {exc.msg}") from exc
    if not isinstance(value, dict):
        raise BriefSpecError("spec must be a JSON object")
    return value


def require_text(spec: dict[str, Any], field: str) -> str:
    value = spec.get(field)
    if not isinstance(value, str) or not value.strip():
        raise BriefSpecError(f"{field} must be a non-empty string")
    return value.strip()


def require_text_list(spec: dict[str, Any], field: str) -> list[str]:
    value = spec.get(field)
    if not isinstance(value, list):
        raise BriefSpecError(f"{field} must be a JSON array")
    rendered: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            raise BriefSpecError(f"{field}[{index}] must be a non-empty string")
        rendered.append(item.strip())
    return rendered


def normalize_repo_paths(values: list[str], field: str, *, allow_root: bool = False) -> list[str]:
    normalized: list[str] = []
    for value in values:
        stripped = value.strip()
        if allow_root and stripped == ".":
            if "." not in normalized:
                normalized.append(".")
            continue
        candidate = Path(value)
        if (
            candidate.is_absolute()
            or stripped in {"", "."}
            or ".." in candidate.parts
            or (candidate.parts and candidate.parts[0] == ".git")
        ):
            raise BriefSpecError(f"{field} must contain non-root repository-relative paths: {value!r}")
        clean = candidate.as_posix().rstrip("/")
        if clean not in normalized:
            normalized.append(clean)
    return normalized


@functools.cache
def _support_module() -> Any:
    path = Path(__file__).with_name("execution_support.py")
    spec = importlib.util.spec_from_file_location("agent_executor_brief_support", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def markdown_list(values: list[str], *, empty: str = "none") -> str:
    if not values:
        return f"- {empty}"
    return "\n".join(f"- {value}" for value in values)


def numbered_list(values: list[str]) -> str:
    return "\n".join(f"{index}. {value}" for index, value in enumerate(values, 1))


def validate_spec(spec: dict[str, Any]) -> dict[str, Any]:
    base_missing = [field for field in REQUIRED_FIELDS if field != "plan" and field not in spec]
    if base_missing:
        if "plan" not in spec:
            base_missing.insert(REQUIRED_FIELDS.index("plan"), "plan")
        raise BriefSpecError("missing required fields: " + ", ".join(base_missing))

    repository_root = Path(require_text(spec, "repository_root")).expanduser()
    if not repository_root.is_absolute():
        raise BriefSpecError("repository_root must be an absolute path")

    scope_owner_raw = spec.get("scope_owner")
    if scope_owner_raw is not None and scope_owner_raw not in {"conductor", "worker"}:
        raise BriefSpecError("scope_owner must be 'conductor' or 'worker'")

    conductor_model = require_text(spec, "conductor_model") if spec.get("conductor_model") is not None else None
    worker_model = require_text(spec, "worker_model") if spec.get("worker_model") is not None else None
    explicit_scope_hints = (
        normalize_repo_paths(require_text_list(spec, "scope_hints"), "scope_hints", allow_root=False)
        if "scope_hints" in spec and spec.get("scope_hints") is not None
        else []
    )

    raw_allow_paths = normalize_repo_paths(require_text_list(spec, "allow_paths"), "allow_paths", allow_root=True)
    track_paths = normalize_repo_paths(require_text_list(spec, "track_paths"), "track_paths", allow_root=False)
    support = _support_module()
    upward = bool(support and support.is_upward_delegation(conductor_model, worker_model))
    has_root_allow = "." in raw_allow_paths
    is_mutating = bool(raw_allow_paths or track_paths or scope_owner_raw == "worker")
    worker_owned = scope_owner_raw == "worker" or (
        scope_owner_raw is None and (has_root_allow or (upward and is_mutating))
    )

    if worker_owned:
        scope_owner = "worker"
        narrow_paths = [path for path in raw_allow_paths if path != "."]
        scope_hints = list(dict.fromkeys([*explicit_scope_hints, *narrow_paths]))
        allow_paths = ["."]
    else:
        scope_owner = "conductor"
        scope_hints = explicit_scope_hints
        allow_paths = ["."] if has_root_allow else raw_allow_paths

    if "plan" not in spec or spec.get("plan") is None:
        if scope_owner != "worker":
            raise BriefSpecError("missing required fields: plan")
        plan: list[str] = []
    else:
        plan = require_text_list(spec, "plan")
        if not plan and scope_owner != "worker":
            raise BriefSpecError("plan must contain at least one step")

    criteria = require_text_list(spec, "acceptance_criteria")
    if not criteria:
        raise BriefSpecError("acceptance_criteria must contain at least one item")

    effective_scope = list(dict.fromkeys([*allow_paths, *track_paths]))
    packet = spec.get("context_packet", {})
    if not isinstance(packet, dict):
        raise BriefSpecError("context_packet must be a JSON object")
    packet_fields = ("decisions", "failed_attempts", "evidence", "versions")
    if set(packet) - set(packet_fields):
        raise BriefSpecError("unknown context_packet fields")
    packet = {field: require_text_list(packet, field) for field in packet_fields if field in packet}
    result: dict[str, Any] = {
        "objective": require_text(spec, "objective"),
        "repository_root": str(repository_root),
        "current_state": require_text(spec, "current_state"),
        "pre_existing_changes": require_text_list(spec, "pre_existing_changes"),
        "plan": plan,
        "allow_paths": allow_paths,
        "track_paths": track_paths,
        "effective_scope": effective_scope,
        "scope_owner": scope_owner,
        "scope_hints": scope_hints,
        "development_checks": require_text_list(spec, "development_checks"),
        "acceptance_criteria": criteria,
        "context_packet": packet,
    }
    if conductor_model:
        result["conductor_model"] = conductor_model
    if worker_model:
        result["worker_model"] = worker_model
    return result


def render_brief(spec: dict[str, Any]) -> str:
    """Validate *spec* and return a complete, runner-compatible Markdown brief."""
    values = validate_spec(spec)
    packet = ""
    if values["context_packet"]:
        packet = (
            "\n# Context to preserve\n\n"
            + "\n\n".join(
                field.replace("_", " ").capitalize() + ":\n" + markdown_list(entries)
                for field, entries in values["context_packet"].items()
            )
            + "\n"
        )
    if values.get("scope_owner") == "worker":
        if values["plan"]:
            plan_block = (
                "You own the implementation approach, architectural decisions, and file scope needed to achieve the "
                "objective and acceptance criteria. Treat the steps below from the dispatching conductor as starting "
                "guidance and context rather than rigid restrictions—adapt the plan or modify additional repository "
                "files as the codebase requires:\n\n" + numbered_list(values["plan"])
            )
        else:
            plan_block = (
                "1. You own the implementation plan, architectural decisions, and file scope. Inspect the repository, "
                "choose the cleanest design and files to create or modify, and verify against the acceptance criteria."
            )
        hints_block = (
            f"\n- Conductor starting-path hints (non-binding):\n{markdown_list(values['scope_hints'])}"
            if values.get("scope_hints")
            else ""
        )
        scope_intro = (
            "- Scope owner: worker (full repository write scope `.`; choose the files to create or modify to achieve "
            f"the objective while preserving unrelated pre-existing changes).{hints_block}\n"
        )
    else:
        plan_block = numbered_list(values["plan"])
        scope_intro = ""
    return (
        f"""# Objective

{values["objective"]}

# Repository and current state

- Repository root: {values["repository_root"]}
- Relevant implementation already present: {values["current_state"]}
- Pre-existing working-tree changes to preserve:
{markdown_list(values["pre_existing_changes"])}
{packet}

# Approved plan

{plan_block}

# Allowed scope

{scope_intro}- May modify or create only these effective paths (tracked deliverables included):
{markdown_list(values["effective_scope"], empty="none; this is a read-only brief")}
- Runner `--allow-path` prefixes:
{markdown_list(values["allow_paths"])}
- Runner `--track-path` deliverables:
{markdown_list(values["track_paths"])}
- May run the focused development checks below and ordinary inspection or tooling needed for the approved plan.

# Mutation budget

- Git history, branch, stash, and worktrees: no changes.
- External systems and publication: no writes unless the user explicitly authorized an exact destination and payload.
- Destructive actions: none unless the approved objective explicitly requires and identifies them.
- Secrets and unrelated private files: no access.

# Constraints

{markdown_list(list(COMMON_CONSTRAINTS))}

# Development checks

Batch related moves and use these focused commands while implementing (do not run full test or visual suites between every individual move) and address failures caused by this task:

{numbered_list(values["development_checks"]) if values["development_checks"] else "No development checks were supplied; explain why in the final report."}

The conductor runs authoritative final-state gates separately with runner `--verify-command` values after this executor exits. Do not claim that those runner-owned commands passed.

# Acceptance criteria

{markdown_list(values["acceptance_criteria"])}

# Final response

Return the compact execution report using exactly these five headings, exactly once and in this order:

### STATUS

Put exactly one of `COMPLETE`, `BLOCKED`, or `FAILED` on the first non-empty line.

### FILES CHANGED

### COMMANDS RUN

### VERIFICATION

### RISKS OR BLOCKERS

Do not add alternative headings such as `SUMMARY`, `CHANGES`, or `RISKS`. Do not paste complete files or raw logs.
""".rstrip()
        + "\n"
    )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        rendered = render_brief(read_json(args.spec))
    except (BriefSpecError, OSError) as exc:
        print(f"brief renderer error: {exc}", file=sys.stderr)
        return 2
    if args.output == "-":
        sys.stdout.write(rendered)
    else:
        destination = Path(args.output).expanduser()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
