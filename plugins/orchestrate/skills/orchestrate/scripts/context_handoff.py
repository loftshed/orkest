"""Choose model and context before a native or executor handoff, and keep settings provenance honest.

`HOST_CAPABILITIES` states, per native host, what Orkest has evidence for: whether the host's own
agent tool can be asked for a model, effort or context; whether Orkest can intercept that launch;
whether it can observe the settings the host actually used; and whether it can interrupt the child.
Each entry is `supported`, `unsupported` or `unverified`; unverified is never advertised as parity.

`evaluate_handoff` is a decision record, not a launcher. Unknown task classification keeps the task
with the conductor (or asks one bounded question); it is never permission to delegate.

Settings provenance keeps `requested`, `resolved` and `observed` apart. A requested or inherited
value is not an observation, and a resolved alias is not proof that the host used it.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

SUPPORTED = "supported"
UNSUPPORTED = "unsupported"
UNVERIFIED = "unverified"
CAPABILITY_STATES = frozenset({SUPPORTED, UNSUPPORTED, UNVERIFIED})
CAPABILITIES = (
    "request_model",
    "request_effort",
    "request_fresh_context",
    "request_fork_context",
    "fork_model_override",
    "intercept_launch",
    "observe_settings",
    "interrupt",
)


def _cap(state: str, note: str) -> dict[str, str]:
    return {"status": state, "note": note}


HOST_CAPABILITIES: dict[str, dict[str, dict[str, str]]] = {
    "claude": {
        "request_model": _cap(SUPPORTED, "The Agent tool takes a model argument."),
        "request_effort": _cap(UNVERIFIED, "Some Agent tool builds take an effort argument; not qualified here."),
        "request_fresh_context": _cap(SUPPORTED, "A named subagent type starts without the parent's history."),
        "request_fork_context": _cap(SUPPORTED, "The fork subagent type inherits the parent conversation."),
        "fork_model_override": _cap(UNSUPPORTED, "A fork always runs on the parent's model; an override is ignored."),
        "intercept_launch": _cap(UNSUPPORTED, "The host calls its own tool; Orkest records, it cannot gate it."),
        "observe_settings": _cap(UNVERIFIED, "Subagent transcripts may name a model; not a qualified observation."),
        "interrupt": _cap(UNVERIFIED, "The host can stop its own task; Orkest cannot confirm it."),
    },
    "codex": {
        "request_model": _cap(UNVERIFIED, "Native thread spawning with a model override is not qualified."),
        "request_effort": _cap(UNVERIFIED, "Native thread spawning with an effort override is not qualified."),
        "request_fresh_context": _cap(UNVERIFIED, "Not qualified for native child threads."),
        "request_fork_context": _cap(UNVERIFIED, "Not qualified for native child threads."),
        "fork_model_override": _cap(UNVERIFIED, "Not qualified for native child threads."),
        "intercept_launch": _cap(UNSUPPORTED, "The host calls its own tool; Orkest records, it cannot gate it."),
        "observe_settings": _cap(SUPPORTED, "The thread store records each thread's model and effort."),
        "interrupt": _cap(UNVERIFIED, "Not qualified for native child threads."),
    },
    "agy": {
        "request_model": _cap(UNVERIFIED, "Native subagent model selection is not qualified."),
        "request_effort": _cap(UNSUPPORTED, "Effort is part of the model slug; no separate native request."),
        "request_fresh_context": _cap(UNVERIFIED, "Not qualified for native subagents."),
        "request_fork_context": _cap(UNVERIFIED, "Not qualified for native subagents."),
        "fork_model_override": _cap(UNVERIFIED, "Not qualified for native subagents."),
        "intercept_launch": _cap(UNSUPPORTED, "The host calls its own tool; Orkest records, it cannot gate it."),
        "observe_settings": _cap(UNVERIFIED, "Transcript settings may name a model; not a qualified observation."),
        "interrupt": _cap(UNVERIFIED, "Not qualified for native subagents."),
    },
    "opencode": {
        "request_model": _cap(UNVERIFIED, "Native task model selection is not qualified."),
        "request_effort": _cap(UNVERIFIED, "Variants are not qualified for native tasks."),
        "request_fresh_context": _cap(UNVERIFIED, "Not qualified for native tasks."),
        "request_fork_context": _cap(UNVERIFIED, "Not qualified for native tasks."),
        "fork_model_override": _cap(UNVERIFIED, "Not qualified for native tasks."),
        "intercept_launch": _cap(UNSUPPORTED, "The host calls its own tool; Orkest records, it cannot gate it."),
        "observe_settings": _cap(UNVERIFIED, "Not qualified for native tasks."),
        "interrupt": _cap(UNVERIFIED, "Not qualified for native tasks."),
    },
}

TASK_LEVELS = ("low", "medium", "high")
CONTEXT_MODES = ("fresh", "fork")


def host_capability(host: str, capability: str) -> dict[str, str]:
    """One capability's status; an unknown host or capability is unverified, never supported."""
    if capability not in CAPABILITIES:
        raise ValueError(f"unknown host capability: {capability}")
    entry = HOST_CAPABILITIES.get(host, {}).get(capability)
    return dict(entry) if entry else _cap(UNVERIFIED, f"No capability record for host {host!r}.")


def capability_matrix(host: str | None = None) -> dict[str, Any]:
    hosts = [host] if host else sorted(HOST_CAPABILITIES)
    return {
        "schema": "orkest.host-capabilities.v1",
        "hosts": {name: {cap: host_capability(name, cap) for cap in CAPABILITIES} for name in hosts},
    }


def _level(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if value not in TASK_LEVELS:
        raise ValueError(f"{field} must be one of {', '.join(TASK_LEVELS)}")
    return value


def evaluate_handoff(packet: dict[str, Any]) -> dict[str, Any]:
    """Decide keep, ask or delegate, and fresh or fork context, from a bounded packet.

    Packet fields: `host`; `task` {classification, portable, independently_checkable, difficulty,
    handoff_value, question}; `candidate` {engine, model, effort, native}; `quota` {available};
    `context` {needs_history, reason, mode}; `host_model` (the model a fork would inherit).
    """
    if not isinstance(packet, dict):
        raise ValueError("handoff packet must be an object")
    host = packet.get("host")
    task = packet.get("task") if isinstance(packet.get("task"), dict) else {}
    candidate = packet.get("candidate") if isinstance(packet.get("candidate"), dict) else {}
    quota = packet.get("quota") if isinstance(packet.get("quota"), dict) else {}
    context = packet.get("context") if isinstance(packet.get("context"), dict) else {}
    difficulty = _level(task.get("difficulty"), "task.difficulty")
    value = _level(task.get("handoff_value"), "task.handoff_value")
    reasons: list[str] = []
    missing: list[str] = []
    gaps: list[dict[str, Any]] = []
    tradeoffs: list[str] = []

    def result(decision: str, **extra: Any) -> dict[str, Any]:
        return {
            "schema": "orkest.handoff-decision.v1",
            "decision": decision,
            "host": host,
            "reasons": reasons,
            "missing_evidence": missing,
            "capability_gaps": gaps,
            "tradeoffs": tradeoffs,
            "billing_switch": False,
            **extra,
        }

    classification = task.get("classification")
    if classification in (None, "", "unknown"):
        reasons.append("Task classification is unknown; that is not permission to delegate.")
        if isinstance(task.get("question"), str) and task["question"].strip():
            return result("ask", question=task["question"].strip())
        return result("keep")
    for field, label in (("portable", "portable"), ("independently_checkable", "independently checkable")):
        if task.get(field) is None:
            missing.append(f"task.{field}")
        elif task[field] is False:
            reasons.append(f"The task is not {label}; keep it with the conductor.")
    if missing:
        reasons.append("Portability and acceptance evidence are required before delegating.")
        return result("keep")
    if reasons:
        return result("keep")
    if quota.get("available") is False:
        reasons.append("No usable quota for the candidate; keep the task or choose another candidate.")
        return result("keep")
    if quota.get("available") is None:
        missing.append("quota.available")
    if difficulty == "low" and value == "low":
        reasons.append("Low difficulty and low handoff value: transfer and review would cost more than the work.")
        return result("keep")
    if not candidate.get("model") or not candidate.get("engine"):
        reasons.append("A handoff needs a selected engine and model.")
        return result("keep")

    needs_history = bool(context.get("needs_history"))
    mode = context.get("mode") or ("fork" if needs_history else "fresh")
    if mode not in CONTEXT_MODES:
        raise ValueError("context.mode must be fresh or fork")
    context_reason = context.get("reason") if isinstance(context.get("reason"), str) else None
    if mode == "fork" and not (context_reason and context_reason.strip()):
        reasons.append("A full-history fork must record why the worker needs conversational dependencies.")
        return result("ask", question="Which conversational dependency requires a full-history fork?")
    if mode == "fresh":
        tradeoffs.append("Fresh context: the bounded brief and its artifacts must carry everything the worker needs.")
    else:
        tradeoffs.append(f"Full-history fork: {context_reason.strip()}")

    native = bool(candidate.get("native"))
    model_applied = True
    if native:
        if mode == "fork":
            override = host_capability(host, "fork_model_override")
            if override["status"] != SUPPORTED and candidate["model"] != packet.get("host_model"):
                model_applied = False
                tradeoffs.append(
                    f"The fork inherits the host model ({packet.get('host_model') or 'unknown'}); "
                    f"the requested {candidate['model']} cannot be applied. {override['note']}"
                )
        for capability, wanted in (("request_model", True), ("request_effort", bool(candidate.get("effort")))):
            if not wanted or (mode == "fork" and capability == "request_model"):
                continue
            state = host_capability(host, capability)
            if state["status"] != SUPPORTED:
                if capability == "request_model":
                    model_applied = False
                gaps.append({"capability": capability, **state})
        observe = host_capability(host, "observe_settings")
        if observe["status"] != SUPPORTED:
            gaps.append({"capability": "observe_settings", **observe})
        intercept = host_capability(host, "intercept_launch")
        if intercept["status"] != SUPPORTED:
            gaps.append({"capability": "intercept_launch", **intercept})
    supported_route = None
    if native and not model_applied:
        supported_route = {
            "transport": "executor",
            "engine": candidate["engine"],
            "model": candidate["model"],
            "note": "An executor run applies the exact model under the existing account authorization; "
            "it does not switch billing context automatically.",
        }
    return result(
        "delegate",
        context_mode=mode,
        context_reason=context_reason.strip() if context_reason else None,
        model_override_applied=model_applied,
        requires_confirmation=not model_applied,
        supported_route=supported_route,
        candidate={key: candidate.get(key) for key in ("engine", "model", "effort", "native")},
    )


def _stamp(at: str | None) -> str:
    return at or dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def settings_provenance(
    *,
    requested_model: str | None,
    requested_effort: str | None,
    requested_source: str,
    resolved_model: str | None,
    resolved_effort: str | None,
    resolved_source: str,
    at: str | None = None,
) -> dict[str, Any]:
    """Requested and resolved settings at dispatch; `observed` stays null until a host reports it."""
    moment = _stamp(at)
    return {
        "requested": {
            "model": requested_model,
            "effort": requested_effort,
            "source": requested_source,
            "at": moment,
        },
        "resolved": {
            "model": resolved_model,
            "effort": resolved_effort,
            "source": resolved_source,
            "at": moment,
        },
        "observed": None,
        "mismatch": [],
    }


def record_observation(
    provenance: dict[str, Any] | None,
    *,
    model: str | None,
    effort: str | None,
    source: str,
    at: str | None = None,
) -> dict[str, Any]:
    """Add what the host actually reported. Missing values stay missing; differences are listed."""
    if not isinstance(source, str) or not source.strip():
        raise ValueError("an observation needs its source")
    if model is None and effort is None:
        raise ValueError("an observation needs an observed model or effort")
    record = dict(provenance or {"requested": None, "resolved": None})
    record["observed"] = {"model": model, "effort": effort, "source": source.strip(), "at": _stamp(at)}
    resolved = record.get("resolved") or {}
    mismatch = []
    for field, observed in (("model", model), ("effort", effort)):
        expected = resolved.get(field)
        if observed is not None and expected is not None and observed != expected:
            mismatch.append({"field": field, "resolved": expected, "observed": observed})
    record["mismatch"] = mismatch
    return record


def display_settings(provenance: dict[str, Any] | None) -> dict[str, Any]:
    """The value to show and what it is. Only an observation is labelled observed."""
    record = provenance or {}
    for label in ("observed", "resolved", "requested"):
        entry = record.get(label)
        if isinstance(entry, dict) and (entry.get("model") or entry.get("effort")):
            source = entry.get("source")
            if label == "requested" and source == "inherited":
                label = "inherited"
            return {"model": entry.get("model"), "effort": entry.get("effort"), "basis": label, "source": source}
    return {"model": None, "effort": None, "basis": "unknown", "source": None}


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json
    import sys
    from pathlib import Path

    parser = argparse.ArgumentParser(description="Host capabilities and handoff decisions; no model is invoked.")
    commands = parser.add_subparsers(dest="command", required=True)
    capabilities = commands.add_parser("capabilities", help="print the host capability matrix")
    capabilities.add_argument("--host", choices=sorted(HOST_CAPABILITIES))
    evaluate = commands.add_parser("evaluate", help="decide keep, ask or delegate for a handoff packet")
    evaluate.add_argument("--packet", required=True, help="JSON packet file, or '-' for stdin")
    args = parser.parse_args(argv)
    try:
        if args.command == "capabilities":
            result = capability_matrix(args.host)
        else:
            raw = sys.stdin.read() if args.packet == "-" else Path(args.packet).read_text(encoding="utf-8")
            result = evaluate_handoff(json.loads(raw))
    except (OSError, ValueError) as error:
        print(f"handoff: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
