"""Host capability matrix, handoff evaluation and settings provenance."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts/context_handoff.py"
SPEC = importlib.util.spec_from_file_location("agent_executor_handoff", SCRIPT)
assert SPEC and SPEC.loader
HANDOFF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HANDOFF)


def packet(**overrides):
    value = {
        "host": "claude",
        "host_model": "claude-opus-5-5",
        "task": {
            "classification": "implementation",
            "portable": True,
            "independently_checkable": True,
            "difficulty": "medium",
            "handoff_value": "high",
        },
        "candidate": {"engine": "claude", "model": "claude-haiku-5-5", "native": True},
        "quota": {"available": True},
        "context": {"needs_history": False},
    }
    for key, item in overrides.items():
        value[key] = {**value[key], **item} if isinstance(value.get(key), dict) else item
    return value


class CapabilityMatrixTests(unittest.TestCase):
    def test_every_host_states_every_capability(self):
        matrix = HANDOFF.capability_matrix()
        self.assertEqual(set(matrix["hosts"]), {"claude", "codex", "agy", "opencode"})
        for capabilities in matrix["hosts"].values():
            self.assertEqual(set(capabilities), set(HANDOFF.CAPABILITIES))
            for entry in capabilities.values():
                self.assertIn(entry["status"], HANDOFF.CAPABILITY_STATES)
                self.assertTrue(entry["note"])

    def test_no_host_claims_it_can_intercept_a_direct_native_launch(self):
        for host in HANDOFF.HOST_CAPABILITIES:
            self.assertEqual(HANDOFF.host_capability(host, "intercept_launch")["status"], "unsupported")

    def test_unknown_hosts_are_unverified_never_supported(self):
        self.assertEqual(HANDOFF.host_capability("newhost", "request_model")["status"], "unverified")
        with self.assertRaises(ValueError):
            HANDOFF.host_capability("claude", "teleport")


class EvaluateHandoffTests(unittest.TestCase):
    def test_unknown_classification_keeps_the_task_or_asks_once(self):
        kept = HANDOFF.evaluate_handoff(packet(task={"classification": "unknown"}))
        self.assertEqual(kept["decision"], "keep")
        self.assertIn("not permission to delegate", kept["reasons"][0])
        asked = HANDOFF.evaluate_handoff(packet(task={"classification": None, "question": "Is this a refactor?"}))
        self.assertEqual((asked["decision"], asked["question"]), ("ask", "Is this a refactor?"))

    def test_portability_and_acceptance_evidence_are_required(self):
        missing = HANDOFF.evaluate_handoff(packet(task={"portable": None}))
        self.assertEqual(missing["decision"], "keep")
        self.assertIn("task.portable", missing["missing_evidence"])
        unchecked = HANDOFF.evaluate_handoff(packet(task={"independently_checkable": False}))
        self.assertEqual(unchecked["decision"], "keep")

    def test_unavailable_quota_keeps_and_unknown_quota_is_recorded_missing(self):
        self.assertEqual(HANDOFF.evaluate_handoff(packet(quota={"available": False}))["decision"], "keep")
        unknown = HANDOFF.evaluate_handoff(packet(quota={"available": None}))
        self.assertEqual(unknown["decision"], "delegate")
        self.assertIn("quota.available", unknown["missing_evidence"])

    def test_low_value_low_difficulty_work_stays_with_the_conductor(self):
        decision = HANDOFF.evaluate_handoff(packet(task={"difficulty": "low", "handoff_value": "low"}))
        self.assertEqual(decision["decision"], "keep")

    def test_fresh_context_applies_the_selected_native_model(self):
        decision = HANDOFF.evaluate_handoff(packet())
        self.assertEqual(decision["decision"], "delegate")
        self.assertEqual(decision["context_mode"], "fresh")
        self.assertTrue(decision["model_override_applied"])
        self.assertFalse(decision["requires_confirmation"])
        self.assertFalse(decision["billing_switch"])
        gaps = {gap["capability"] for gap in decision["capability_gaps"]}
        self.assertEqual(gaps, {"observe_settings", "intercept_launch"})

    def test_full_history_fork_exposes_the_inherited_model_before_launch(self):
        no_reason = HANDOFF.evaluate_handoff(packet(context={"needs_history": True}))
        self.assertEqual(no_reason["decision"], "ask")
        decision = HANDOFF.evaluate_handoff(
            packet(context={"needs_history": True, "reason": "It depends on the agreed migration plan."})
        )
        self.assertEqual((decision["decision"], decision["context_mode"]), ("delegate", "fork"))
        self.assertFalse(decision["model_override_applied"])
        self.assertTrue(decision["requires_confirmation"])
        self.assertTrue(any("inherits the host model" in item for item in decision["tradeoffs"]))
        self.assertEqual(decision["supported_route"]["transport"], "executor")
        same_model = HANDOFF.evaluate_handoff(
            packet(
                candidate={"model": "claude-opus-5-5"},
                context={"needs_history": True, "reason": "It depends on the plan."},
            )
        )
        self.assertTrue(same_model["model_override_applied"])

    def test_unverified_native_model_requests_offer_a_supported_route(self):
        decision = HANDOFF.evaluate_handoff(
            packet(host="codex", candidate={"engine": "codex", "model": "gpt-5.5", "native": True})
        )
        self.assertFalse(decision["model_override_applied"])
        self.assertIn("request_model", {gap["capability"] for gap in decision["capability_gaps"]})
        self.assertEqual(decision["supported_route"]["engine"], "codex")
        self.assertFalse(decision["billing_switch"])


class ProvenanceTests(unittest.TestCase):
    def provenance(self, source="dispatch"):
        return HANDOFF.settings_provenance(
            requested_model="sonnet",
            requested_effort="high",
            requested_source=source,
            resolved_model="claude-sonnet-5-5",
            resolved_effort="high",
            resolved_source="coordinator",
            at="2026-11-18T00:00:00Z",
        )

    def test_requested_and_resolved_are_never_observed(self):
        record = self.provenance()
        self.assertIsNone(record["observed"])
        self.assertEqual(HANDOFF.display_settings(record)["basis"], "resolved")
        requested_only = {**record, "resolved": None}
        self.assertEqual(HANDOFF.display_settings(requested_only)["basis"], "requested")
        inherited = {**self.provenance("inherited"), "resolved": None}
        self.assertEqual(HANDOFF.display_settings(inherited)["basis"], "inherited")
        self.assertEqual(HANDOFF.display_settings(None)["basis"], "unknown")

    def test_an_observation_mismatch_is_visible(self):
        record = HANDOFF.record_observation(
            self.provenance(), model="claude-haiku-5-5", effort=None, source="host", at="2026-11-18T00:01:00Z"
        )
        self.assertEqual(record["observed"]["model"], "claude-haiku-5-5")
        self.assertIsNone(record["observed"]["effort"])
        self.assertEqual(
            record["mismatch"], [{"field": "model", "resolved": "claude-sonnet-5-5", "observed": "claude-haiku-5-5"}]
        )
        self.assertEqual(record["requested"]["model"], "sonnet")
        self.assertEqual(HANDOFF.display_settings(record)["basis"], "observed")

    def test_an_observation_needs_a_source_and_a_value(self):
        with self.assertRaises(ValueError):
            HANDOFF.record_observation(self.provenance(), model="x", effort=None, source="")
        with self.assertRaises(ValueError):
            HANDOFF.record_observation(self.provenance(), model=None, effort=None, source="host")


class HandoffCliTests(unittest.TestCase):
    def test_cli_prints_capabilities_and_decisions(self):
        import contextlib
        import io
        import json
        import tempfile

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(HANDOFF.main(["capabilities", "--host", "claude"]), 0)
        self.assertEqual(set(json.loads(output.getvalue())["hosts"]), {"claude"})
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(packet(task={"classification": "unknown"}), handle)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(HANDOFF.main(["evaluate", "--packet", handle.name]), 0)
        self.assertEqual(json.loads(output.getvalue())["decision"], "keep")
        Path(handle.name).unlink()


if __name__ == "__main__":
    unittest.main()
