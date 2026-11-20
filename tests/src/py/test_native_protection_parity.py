"""Characterize native gate protection beside the executor-route cases."""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

import test_auto_correct_protection as protection
import test_coordination as coordination

COORDINATOR = coordination.COORDINATOR
RUNNER = coordination.RUNNER


class NativeProtectionParityTests(unittest.TestCase):
    def setUp(self):
        self.coordinator = coordination.CoordinatorTests()
        self.coordinator.setUp()
        self.fixture = self.coordinator.fixture
        self.active_runs = []

    def tearDown(self):
        for run in self.active_runs:
            if COORDINATOR.NATIVE.process_state(run) == "active":
                os.kill(run["pid"], 15)
        self.coordinator.tearDown()

    def dispatch_native(self, kind, request, *extra):
        args = [
            "dispatch",
            "--kind",
            kind,
            "--request-id",
            request,
            "--transport",
            "native",
        ]
        if kind == "implementation":
            args.extend(("--engine", "claude", "--model", "claude-sonnet-5"))
        args.extend(extra)
        code, run = self.coordinator.call(*args)
        self.assertEqual(code, 0, run)
        self.active_runs.append(run)
        return run

    def native_round(self, run, name, edits, files_changed, *, handle=None):
        code, finished = self.coordinator.native_round(run, name, edits, files_changed, handle=handle)
        self.assertEqual(code, 0, finished)
        return finished

    def result(self, run):
        return COORDINATOR.read(Path(run["result_path"]))

    def rewrite_recorded_result(self, run, change):
        path = Path(run["result_path"])
        result = json.loads(path.read_text())
        change(result)
        path.write_text(json.dumps(result))
        state = COORDINATOR.load(self.coordinator.directory)
        recorded = next(item for item in state["runs"] if item["run_id"] == run["run_id"])
        COORDINATOR.import_result(recorded, state)
        COORDINATOR.save(self.coordinator.directory, state)
        return result

    def correction(self, request, *extra):
        proof = self.coordinator.reviewed_evidence()
        run = self.dispatch_native("correction", request, "--review-id", str(proof), *extra)
        return run

    def test_protected_file_first_turn_edit_is_seen_by_the_following_native_correction(self):
        protection.seed(
            self.fixture,
            {
                "allowed/expected.txt": "strict\n",
                "allowed/output.txt": "broken\n",
                "allowed/flag.txt": "no\n",
            },
        )
        run = self.dispatch_native(
            "implementation",
            "native-protected-first-turn",
            "--verify-command",
            "cmp -s allowed/expected.txt allowed/output.txt && grep -qx yes allowed/flag.txt",
            "--protect-path",
            "allowed/expected.txt",
            "--auto-correct",
            "1",
        )
        first = self.native_round(
            run,
            "native-protected-first-turn",
            {"allowed/expected.txt": "broken\n"},
            "allowed/expected.txt",
        )
        first_result = self.result(first)
        # DRIFT(#152): the executor rejects this first-turn edit as scope_violation before verification in
        # test_protected_file_changed_on_first_turn_fails_before_verification; native runs the gate first.
        self.assertEqual(
            (first_result["exit_code"], first_result["status"], first_result["verification"]["status"]),
            (25, "verification_failed", "failed"),
        )

        correction = self.correction("native-protected-following-correction")
        repaired = self.native_round(
            correction,
            "native-protected-following-correction",
            {"allowed/flag.txt": "yes\n"},
            "allowed/flag.txt",
            handle=first_result["session_id"],
        )
        repaired_result = self.result(repaired)
        # DRIFT(#152): the executor test above stops on the first turn; native detects that same edit on correction.
        self.assertEqual(
            (
                repaired_result["exit_code"],
                repaired_result["status"],
                repaired_result["verification"]["status"],
                repaired_result["scope_violations"],
            ),
            (22, "scope_violation", "skipped", ["gate-edit:allowed/expected.txt"]),
        )

    def test_released_protected_path_is_omitted_from_suggested_correction_gates(self):
        protection.seed(
            self.fixture,
            {
                "allowed/check.sh": "grep -qx fixed allowed/output.txt\n",
                "allowed/expected.txt": "strict\n",
                "allowed/output.txt": "broken\n",
            },
        )
        run = self.dispatch_native(
            "implementation",
            "native-released-correction-gate",
            "--verify-command",
            "sh allowed/check.sh",
            "--protect-path",
            "allowed/expected.txt",
            "--auto-correct",
            "1",
        )
        first = self.native_round(
            run,
            "native-released-correction-gate",
            {"allowed/output.txt": "attempt\n"},
            "allowed/output.txt",
        )
        first_result = self.result(first)
        self.assertEqual(first_result["status"], "verification_failed")
        self.rewrite_recorded_result(
            first,
            lambda result: result["auto_correct"].update(released_paths=["allowed/expected.txt"]),
        )

        correction = self.correction("native-released-correction-gate-resume")
        failed = self.native_round(
            correction,
            "native-released-correction-gate-resume",
            {"allowed/output.txt": "still-broken\n"},
            "allowed/output.txt",
            handle=first_result["session_id"],
        )
        result = self.result(failed)
        self.assertEqual(result["status"], "verification_failed")
        self.assertEqual(result["auto_correct"]["released_paths"], ["allowed/expected.txt"])
        suggestion = result["auto_correct"]["suggested_correction"]
        self.assertIsNotNone(suggestion)
        self.assertIn("Do not change the gate's own files: allowed/check.sh.", suggestion)
        self.assertNotIn("allowed/expected.txt", suggestion)

    def test_zero_round_native_correction_carries_task_baseline_protection_and_releases(self):
        # The coordinator permits one correction, so the zero-round correction is the last native segment.
        protection.seed(
            self.fixture,
            {
                "allowed/output.txt": "initial\n",
                "allowed/expected.txt": "strict\n",
                "allowed/check.sh": "grep -qx fixed allowed/output.txt\n",
            },
        )
        first_run = self.dispatch_native(
            "implementation",
            "native-zero-round-source",
            "--verify-command",
            "sh allowed/check.sh",
            "--protect-path",
            "allowed/expected.txt",
            "--auto-correct",
            "1",
        )
        first = self.native_round(
            first_run,
            "native-zero-round-source",
            {"allowed/output.txt": "attempt\n"},
            "allowed/output.txt",
        )
        first_result = self.result(first)
        self.assertEqual(first_result["status"], "verification_failed")
        self.rewrite_recorded_result(
            first,
            lambda value: value["auto_correct"].update(released_paths=["allowed/check.sh"]),
        )

        intermediate = self.correction("native-zero-round-intermediate", "--auto-correct", "0")
        middle = self.native_round(
            intermediate,
            "native-zero-round-intermediate",
            {"allowed/output.txt": "still-broken\n"},
            "allowed/output.txt",
            handle=first_result["session_id"],
        )
        middle_result = self.result(middle)
        self.assertEqual(middle_result["task_git_before"], first_result["git_before"])
        self.assertEqual(
            (
                middle_result["auto_correct"]["max_rounds"],
                middle_result["auto_correct"]["protect_paths"],
                middle_result["auto_correct"]["released_paths"],
            ),
            (0, ["allowed/expected.txt"], ["allowed/check.sh"]),
        )

    def test_legacy_steer_release_resumes_without_saved_auto_correct_state(self):
        protection.seed(
            self.fixture,
            {"allowed/output.txt": "initial\n", "allowed/check.sh": "exit 1\n"},
        )
        first_run = self.dispatch_native(
            "implementation",
            "native-legacy-steer-source",
            "--verify-command",
            "sh allowed/check.sh",
        )
        first = self.native_round(
            first_run,
            "native-legacy-steer-source",
            {"allowed/output.txt": "attempt\n"},
            "allowed/output.txt",
        )
        first_result = self.result(first)
        self.assertNotIn("auto_correct", first_result)

        def add_legacy_steer(result):
            result["steering"] = {"steers": [{"status": "accepted", "added_allow_paths": ["allowed/check.sh"]}]}

        self.rewrite_recorded_result(first, add_legacy_steer)
        correction = self.correction("native-legacy-steer-resume", "--auto-correct", "1")
        resumed = self.native_round(
            correction,
            "native-legacy-steer-resume",
            {"allowed/check.sh": "exit 0\n"},
            "allowed/check.sh",
            handle=first_result["session_id"],
        )
        resumed_result = self.result(resumed)
        self.assertEqual((resumed_result["status"], resumed_result["scope_violations"]), ("completed", []))
        self.assertEqual(resumed_result["auto_correct"]["released_paths"], ["allowed/check.sh"])

    def test_legacy_opaque_directory_fingerprint_still_fails_closed_on_native_resume(self):
        protection.seed(
            self.fixture,
            {
                "allowed/output.txt": "initial\n",
                "allowed/tests/one.txt": "old\n",
                "allowed/tests/two.txt": "keep\n",
            },
        )
        first_run = self.dispatch_native(
            "implementation",
            "native-legacy-directory-source",
            "--verify-command",
            "grep -qx fixed allowed/output.txt",
            "--protect-path",
            "allowed/tests",
            "--auto-correct",
            "1",
        )
        first = self.native_round(
            first_run,
            "native-legacy-directory-source",
            {"allowed/output.txt": "attempt\n"},
            "allowed/output.txt",
        )
        first_result = self.result(first)
        self.assertEqual(first_result["status"], "verification_failed")

        directory = self.fixture.repository.path / "allowed/tests"

        def convert_to_legacy_fingerprint(result):
            result["auto_correct"]["protect_fingerprints"]["allowed/tests"] = RUNNER.path_fingerprint(directory)

        self.rewrite_recorded_result(first, convert_to_legacy_fingerprint)
        correction = self.correction("native-legacy-directory-resume")
        resumed = self.native_round(
            correction,
            "native-legacy-directory-resume",
            {"allowed/tests/two.txt": "weakened\n"},
            "allowed/tests/two.txt",
            handle=first_result["session_id"],
        )
        resumed_result = self.result(resumed)
        self.assertEqual(
            (resumed_result["exit_code"], resumed_result["status"], resumed_result["verification"]["status"]),
            (22, "scope_violation", "skipped"),
        )
        self.assertEqual(resumed_result["scope_violations"], ["gate-edit:allowed/tests"])

    def test_native_continue_resets_gate_candidates_protection_and_releases(self):
        protection.seed(
            self.fixture,
            {
                "allowed/check.sh": "grep -qx first allowed/output.txt\n",
                "allowed/expected.txt": "locked\n",
                "allowed/output.txt": "initial\n",
            },
        )
        first_run = self.dispatch_native(
            "implementation",
            "native-continue-source",
            "--verify-command",
            "sh allowed/check.sh",
            "--protect-path",
            "allowed/expected.txt",
            "--auto-correct",
            "1",
        )
        first = self.native_round(
            first_run,
            "native-continue-source",
            {"allowed/output.txt": "first\n"},
            "allowed/output.txt",
        )
        first_result = self.result(first)
        self.assertEqual(first_result["status"], "completed")
        self.rewrite_recorded_result(
            first,
            lambda value: value["auto_correct"].update(released_paths=["allowed/check.sh"]),
        )
        self.assertEqual(self.coordinator.call("review", "--run-id", first["run_id"], "--decision", "reject")[0], 0)

        self.coordinator.spec.update(
            objective="Write a fresh follow-up output",
            allow_paths=["followup"],
            track_paths=["followup/output.txt"],
            acceptance_criteria=["The follow-up output is written"],
        )
        self.coordinator.spec.pop("protect_paths", None)
        self.coordinator.spec_path.write_text(json.dumps(self.coordinator.spec))
        code, continued = self.coordinator.call(
            "dispatch",
            "--kind",
            "continue",
            "--request-id",
            "native-continue-followup",
            "--task-spec",
            str(self.coordinator.spec_path),
            "--transport",
            "native",
            "--verify-command",
            "false",
            "--auto-correct",
            "1",
        )
        self.assertEqual(code, 0, continued)
        self.active_runs.append(continued)
        finished = self.native_round(
            continued,
            "native-continue-followup",
            {"followup/output.txt": "next\n"},
            "followup/output.txt",
            handle=first_result["session_id"],
        )
        result = self.result(finished)
        self.assertEqual(
            (
                result["auto_correct"]["gate_candidates"],
                result["auto_correct"]["protect_paths"],
                result["auto_correct"]["released_paths"],
            ),
            ([], [], []),
        )
        self.assertNotIn("task_git_before", result)


# DRIFT(#152) assertions in this file:
# - test_protected_file_first_turn_edit_is_seen_by_the_following_native_correction pins native's
#   verification_failed first turn and later correction-time scope_violation. The executor test
#   test_protected_file_changed_on_first_turn_fails_before_verification stops at first-turn scope_violation.
