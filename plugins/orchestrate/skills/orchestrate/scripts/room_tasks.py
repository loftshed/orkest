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
    "kind",
    "task_spec",
    "resume_result",
    "resumed_from",
    "verification_of",
    "parent_run_id",
)
STATES = {"reserved": "reserved", "active": "running", "finished": "review", "cancelled": "cancelled"}
VERDICTS = {"accept": "completed", "supported": "completed", "reject": "rejected", "takeover": "blocked"}


def project(cwd: str, member: dict[str, Any], task: dict[str, Any]) -> dict[str, Any]:
    binding = member["dispatch"]
    if task.get("schema") != "agent-executor.task.v1" or task.get("task_id") != binding["taskId"]:
        raise ValueError("Task identity changed")
    expected_cwd = member.get("cwd") if isinstance(member.get("cwd"), str) and member["cwd"] else cwd
    if Path(task["repository"]).resolve(strict=True) != Path(expected_cwd).resolve(strict=True):
        raise ValueError("Task identity changed")
    matches = [run for run in task["runs"] if isinstance(run, dict) and run.get("request_id") == binding["requestId"]]
    if len(matches) != 1:
        raise ValueError("Dispatch has no unique recorded run; retry the same dispatch to recover")
    anchor = matches[0]
    if not isinstance(anchor.get("run_id"), str) or not anchor["run_id"]:
        raise ValueError("Run identity changed")
    if binding.get("runId") and anchor["run_id"] != binding["runId"]:
        raise ValueError("Run identity changed")
    if anchor.get("engine") != member.get("engine") or anchor.get("transport") != binding.get("transport"):
        raise ValueError("Run executor differs from room member")
    candidates = [
        run
        for run in task["runs"]
        if isinstance(run, dict)
        and run.get("engine") == member.get("engine")
        and run.get("transport") in {binding.get("transport"), "host_checks"}
    ]
    by_id = {run["run_id"]: run for run in candidates}
    by_result = {run["result_path"]: run for run in candidates if run.get("result_path")}
    chain = {anchor["run_id"]}
    while True:
        size = len(chain)
        for run in candidates:
            if run.get("kind") not in {"continue", "correction", "verification"}:
                continue
            parent = by_id.get(run.get("verification_of") or run.get("parent_run_id")) or by_result.get(
                run.get("resume_result") or run.get("resumed_from")
            )
            if parent and (run["run_id"] in chain or parent["run_id"] in chain):
                chain.update((run["run_id"], parent["run_id"]))
        if len(chain) == size:
            break
    history = [run for run in candidates if run["run_id"] in chain]
    run = history[-1]
    if not isinstance(run.get("run_id"), str) or not run["run_id"]:
        raise ValueError("Run identity changed")
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
    spec = run.get("task_spec", task.get("task_spec"))
    return {
        "run": run,
        "status": state,
        "verdict": verdict,
        "observedAt": task.get("updated_at"),
        "objective": spec.get("objective") if isinstance(spec, dict) else None,
        "history": history,
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
