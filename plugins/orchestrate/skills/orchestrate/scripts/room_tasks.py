#!/usr/bin/env python3
"""Project coordinator task records for room and footer displays."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

RUN_FIELDS = (
    "run_id",
    "request_id",
    "status",
    "runner_status",
    "engine",
    "transport",
    "result_path",
    "mailbox",
    "model",
    "effort",
    "native_handle",
    "recovery",
)
STATES = {"reserved": "reserved", "active": "running", "finished": "review", "cancelled": "cancelled"}
VERDICTS = {"accept": "completed", "supported": "completed", "reject": "rejected", "takeover": "blocked"}


def project(cwd: str, member: dict[str, Any], task: dict[str, Any]) -> dict[str, Any]:
    binding = member["dispatch"]
    if task.get("schema") != "agent-executor.task.v1" or task.get("task_id") != binding["taskId"]:
        raise ValueError("Task identity changed")
    if Path(task["repository"]).resolve(strict=True) != Path(cwd).resolve(strict=True):
        raise ValueError("Task identity changed")
    matches = [run for run in task["runs"] if isinstance(run, dict) and run.get("request_id") == binding["requestId"]]
    if len(matches) != 1:
        raise ValueError("Dispatch has no unique recorded run; retry the same dispatch to recover")
    run = matches[0]
    if not isinstance(run.get("run_id"), str) or not run["run_id"]:
        raise ValueError("Run identity changed")
    if binding.get("runId") and run["run_id"] != binding["runId"]:
        raise ValueError("Run identity changed")
    if run.get("engine") != member.get("engine") or run.get("transport") != binding.get("transport"):
        raise ValueError("Run executor differs from room member")
    decisions = [
        decision
        for decision in task["decisions"]
        if isinstance(decision, dict) and decision.get("run_id") == run["run_id"]
    ]
    verdict = (decisions[-1].get("decision") if decisions else None) or "pending"
    state = STATES.get(run.get("status"), "unknown")
    if run.get("runner_status") and run["runner_status"] != "completed":
        state = "failed"
    state = VERDICTS.get(verdict, state)
    spec = task.get("task_spec")
    return {
        "run": run,
        "status": state,
        "verdict": verdict,
        "observedAt": task.get("updated_at"),
        "objective": spec.get("objective") if isinstance(spec, dict) else None,
    }


def compact(task: dict[str, Any]) -> dict[str, Any]:
    runs, decisions = task["runs"], task["decisions"]
    if not isinstance(runs, list) or not isinstance(decisions, list):
        raise ValueError("Task runs and decisions must be lists")
    result = {key: task[key] for key in ("schema", "task_id", "repository", "updated_at") if key in task}
    spec = task.get("task_spec")
    if isinstance(spec, dict):
        result["task_spec"] = {"objective": spec.get("objective")}
    result["runs"] = [{key: run[key] for key in RUN_FIELDS if key in run} for run in runs if isinstance(run, dict)]
    result["decisions"] = [
        {key: decision[key] for key in ("run_id", "decision") if key in decision}
        for decision in decisions
        if isinstance(decision, dict)
    ]
    return result


def snapshot(request: dict[str, Any]) -> dict[str, Any]:
    tasks = request.get("tasks", {})
    errors = request.get("errors", {})
    members = {}
    for member in request["members"]:
        directory = member["dispatch"]["taskDir"]
        if directory not in tasks and directory not in errors:
            try:
                import coordinator

                tasks[directory] = compact(coordinator.load(Path(directory).resolve()))
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
                errors[directory] = str(error)
        try:
            if directory in errors:
                raise ValueError(errors[directory])
            members[member["id"]] = {"projection": project(request["cwd"], member, tasks[directory])}
        except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
            members[member["id"]] = {"error": str(error)}
    return {"tasks": tasks, "members": members}


if __name__ == "__main__":
    print(json.dumps(snapshot(json.load(sys.stdin))))
