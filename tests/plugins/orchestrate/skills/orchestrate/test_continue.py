"""Bounded follow-up tasks keep the audited executor session and room history."""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest import mock

import test_coordination as fixtures

COORDINATOR = fixtures.COORDINATOR
RUNNER = fixtures.RUNNER
ROOM_TASKS = RUNNER.bundled_module("room_tasks")


class ContinueTests(unittest.TestCase):
    setUp = fixtures.CoordinatorTests.setUp
    tearDown = fixtures.CoordinatorTests.tearDown
    call = fixtures.CoordinatorTests.call
    start = fixtures.CoordinatorTests.start
    evidence = fixtures.CoordinatorTests.evidence
    reviewed_evidence = fixtures.CoordinatorTests.reviewed_evidence

    def follow(self, request="follow", *extra):
        return self.call(
            "dispatch",
            "--kind",
            "continue",
            "--request-id",
            request,
            "--task-spec",
            str(self.spec_path),
            *extra,
        )

    def reviewed(self, run, decision="reject"):
        self.assertEqual(self.call("review", "--run-id", run["run_id"], "--decision", decision)[0], 0)

    def new_spec(self):
        self.spec.update(
            objective="Write the second bounded output",
            allow_paths=["followup"],
            track_paths=["followup/output.txt"],
            acceptance_criteria=["Second output passes its own gate"],
        )
        self.spec_path.write_text(json.dumps(self.spec))

    def test_continue_inherits_executor_and_uses_a_new_spec_review_and_audit(self):
        code, first = self.start("first", "implementation", "--timeout", "20m")
        self.assertEqual((code, first["runner_status"]), (0, "completed"))
        proof = self.reviewed_evidence()
        self.assertEqual(
            self.call("review", "--run-id", first["run_id"], "--decision", "accept", "--review-id", proof)[0], 0
        )
        legacy = COORDINATOR.load(self.directory)
        legacy["runs"][0].pop("task_spec")
        legacy["limits"].pop("continues")
        COORDINATOR.save(self.directory, legacy)
        self.new_spec()
        with mock.patch.dict(os.environ, {"FAKE_OUTPUT": "followup/output.txt", "FAKE_CONTENT": "second\n"}):
            code, run = self.follow("second", "--verify-command", "grep -qx second followup/output.txt")
        self.assertEqual((code, run["runner_status"], run["timeout"]), (0, "completed", "20m"), run)
        result = COORDINATOR.read(Path(run["result_path"]))
        self.assertEqual(
            (result["engine"], result["model"], result["effort"]["bound"], result["session_id"]),
            ("codex", "gpt-5.6-luna", "low", "codex-thread-1"),
        )
        self.assertEqual(result["resumed_from"], first["result_path"])
        self.assertEqual(result["allowed_paths"], ["followup", "followup/output.txt"])
        self.assertEqual(result["tracked_paths"], ["followup/output.txt"])
        self.assertEqual(result["verification"]["status"], "passed")
        self.assertEqual(result["run_delta"]["changed_paths"], ["followup/output.txt"])
        self.assertNotIn("task_git_before", result)
        state = COORDINATOR.load(self.directory)
        self.assertEqual((state["status"], len(state["runs"]), len(state["decisions"])), ("active", 2, 1))
        self.assertEqual(state["runs"][0]["task_spec"]["objective"], "Write the approved output")
        self.assertEqual(state["runs"][1]["task_spec"]["objective"], "Write the second bounded output")
        code, error = self.call("review", "--run-id", run["run_id"], "--decision", "accept", "--review-id", proof)
        self.assertEqual(code, 2)
        self.assertIn("every criterion", error)
        proof = self.reviewed_evidence()
        code, decision = self.call("review", "--run-id", run["run_id"], "--decision", "accept", "--review-id", proof)
        self.assertEqual((code, decision["decision"]), (0, "accept"))
        code, duplicate = self.follow("second")
        self.assertEqual((code, duplicate["run_id"]), (0, run["run_id"]))

    def test_continue_after_reverification_inherits_the_executor_and_timeout(self):
        _, first = self.start("first", "implementation", "--timeout", "20m")
        code, checked = self.call(
            "reverify",
            "--run-id",
            first["run_id"],
            "--request-id",
            "recheck",
            "--reason",
            "Check the produced output",
            "--verify-command",
            "test -f allowed/output.txt",
        )
        self.assertEqual((code, checked["runner_status"]), (0, "completed"), checked)
        state = COORDINATOR.load(self.directory)
        member = {
            "engine": "codex",
            "dispatch": {
                "taskId": state["task_id"],
                "requestId": "first",
                "runId": first["run_id"],
                "transport": "executor",
            },
        }
        projected = ROOM_TASKS.project(str(self.fixture.repository.path), member, ROOM_TASKS.compact(state))
        self.assertEqual((projected["run"]["request_id"], projected["status"]), ("recheck", "review"))
        self.reviewed(checked)
        self.new_spec()
        with mock.patch.dict(os.environ, {"FAKE_OUTPUT": "followup/output.txt"}):
            code, run = self.follow()
        self.assertEqual(
            (code, run["runner_status"], run["transport"], run["timeout"]), (0, "completed", "executor", "20m"), run
        )

    def test_continue_refuses_no_session_and_unreviewed_or_unfinished_runs(self):
        code, error = self.follow()
        self.assertEqual(code, 2)
        self.assertIn("finished and reviewed", error)
        _, run = self.start()
        code, error = self.follow()
        self.assertEqual(code, 2)
        self.assertIn("finished and reviewed", error)
        self.reviewed(run)
        state = COORDINATOR.load(self.directory)
        state["runs"][0]["status"] = "active"
        COORDINATOR.save(self.directory, state)
        code, error = self.follow()
        self.assertEqual(code, 2)
        self.assertIn("unresolved dispatch", error)
        self.assertIn("continue requires the previous run to be finished and reviewed", error)
        state["runs"][0]["status"] = "finished"
        result = COORDINATOR.read(Path(run["result_path"]))
        result["session_id"] = None
        RUNNER.write_json_atomic(Path(run["result_path"]), result)
        state["runs"][0]["result_sha256"] = COORDINATOR.digest(Path(run["result_path"]))
        COORDINATOR.save(self.directory, state)
        code, error = self.follow()
        self.assertEqual(code, 2)
        self.assertIn("session id", error)

    def test_default_three_continues_are_bounded_independently_of_correction(self):
        _, run = self.start()
        proof = self.reviewed_evidence()
        with mock.patch.dict(os.environ, {"FAKE_CONTENT": "correction\n"}):
            code, run = self.call("dispatch", "--kind", "correction", "--request-id", "correct", "--review-id", proof)
        self.assertEqual((code, run["runner_status"]), (0, "completed"))
        self.spec.update(allow_paths=[], track_paths=[])
        self.spec_path.write_text(json.dumps(self.spec))
        for index in range(3):
            self.reviewed(run)
            with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
                code, run = self.follow(f"follow-{index}")
            self.assertEqual((code, run["runner_status"]), (0, "completed"), run)
        self.reviewed(run)
        code, error = self.follow("fourth")
        self.assertEqual(code, 2)
        self.assertIn("continue budget exhausted (3", error)
        code, error = self.call(
            "dispatch", "--kind", "correction", "--request-id", "correct-again", "--review-id", proof
        )
        self.assertEqual(code, 2)
        self.assertIn("one correction", error)

    def test_first_dispatch_override_allows_six_and_cannot_be_raised_later(self):
        code, error = self.start("bad", "implementation", "--max-continues", "7")
        self.assertEqual(code, 2)
        self.assertIn("hard ceiling 6", error)
        code, run = self.start("first", "implementation", "--max-continues", "6")
        self.assertEqual((code, run["runner_status"]), (0, "completed"))
        self.reviewed(run)
        code, error = self.follow("raise", "--max-continues", "6")
        self.assertEqual(code, 2)
        self.assertIn("first dispatch", error)
        self.spec.update(allow_paths=[], track_paths=[])
        self.spec_path.write_text(json.dumps(self.spec))
        for index in range(6):
            with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
                code, run = self.follow(f"follow-{index}")
            self.assertEqual((code, run["runner_status"]), (0, "completed"), run)
            self.reviewed(run)
        code, error = self.follow("seventh")
        self.assertEqual(code, 2)
        self.assertIn("continue budget exhausted (6", error)

    def test_high_caps_allow_every_continue_and_preserve_correction_headroom(self):
        for source, cap, allowance in (("dispatch", 5, 5), ("init", 6, 5), ("spec", 5, 5), ("spec", 6, 12)):
            with self.subTest(source=source):
                self.directory = self.fixture.external_path / f"cap-{source}-{cap}"
                self.spec.pop("max_continues", None)
                if source == "spec":
                    self.spec["max_continues"] = cap
                self.spec.update(allow_paths=[], track_paths=[])
                self.spec_path.write_text(json.dumps(self.spec))
                options = ["--max-continues", str(cap)] if source == "init" else []
                code, state = self.call(
                    "init",
                    "--task-spec",
                    str(self.spec_path),
                    "--host",
                    "claude",
                    "--invocation-allowance",
                    str(allowance),
                    *options,
                )
                self.assertEqual(code, 0, state)
                options = ["--max-continues", str(cap)] if source == "dispatch" else []
                with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
                    code, run = self.start("first", "implementation", *options)
                    self.assertEqual(code, 0, run)
                    self.assertEqual(COORDINATOR.load(self.directory)["budget"]["limit"], max(allowance, 2 + cap))
                    for index in range(cap):
                        self.reviewed(run)
                        code, run = self.follow(f"continue-{index}")
                        self.assertEqual(code, 0, run)
                        self.assertEqual(run["runner_status"], "completed")
                    proof = self.reviewed_evidence()
                    code, corrected = self.call(
                        "dispatch", "--kind", "correction", "--request-id", "correction", "--review-id", proof
                    )
                    self.assertEqual(code, 0, corrected)
                    self.assertEqual(corrected["runner_status"], "completed")
                self.reviewed(corrected)
                code, error = self.follow("beyond-cap")
                self.assertEqual(code, 2)
                self.assertIn(f"continue budget exhausted ({cap}", error)

    def test_projection_excludes_same_engine_consultations_and_other_member_chains(self):
        _, first = self.start()
        proof = self.reviewed_evidence()
        code, decision = self.call("review", "--run-id", first["run_id"], "--decision", "accept", "--review-id", proof)
        self.assertEqual((code, decision["decision"]), (0, "accept"))
        state = COORDINATOR.load(self.directory)
        member = {
            "engine": "codex",
            "dispatch": {
                "taskId": state["task_id"],
                "requestId": first["request_id"],
                "runId": first["run_id"],
                "transport": "executor",
            },
        }
        for kind in ("consultation", "implementation"):
            state["runs"].append(
                {
                    **first,
                    "kind": kind,
                    "run_id": kind,
                    "request_id": kind,
                    "resume_result": first["result_path"],
                    "result_path": f"/other/{kind}.json",
                    "task_spec": {"objective": "Other member objective"},
                }
            )
            state["decisions"].append({"run_id": kind, "decision": "reject"})
        state["runs"].append(
            {
                **state["runs"][-1],
                "run_id": "other-continue",
                "request_id": "other-continue",
                "kind": "continue",
                "resume_result": "/other/implementation.json",
            }
        )
        projected = ROOM_TASKS.project(str(self.fixture.repository.path), member, ROOM_TASKS.compact(state))
        self.assertEqual(
            (projected["run"]["run_id"], projected["status"], projected["verdict"], projected["objective"]),
            (first["run_id"], "accepted", "accept", "Write the approved output"),
        )
        self.assertEqual([run["run_id"] for run in projected["history"]], [first["run_id"]])

    def test_init_and_spec_caps_are_validated_and_zero_is_bounded(self):
        for value in (-1, 7):
            self.directory = self.fixture.external_path / f"invalid-{value}"
            code, error = self.call(
                "init", "--task-spec", str(self.spec_path), "--host", "claude", "--max-continues", str(value)
            )
            self.assertEqual(code, 2)
            self.assertIn("hard ceiling 6", error)
        for value in (True, "4", -1, 7):
            with self.assertRaisesRegex(ValueError, "hard ceiling 6"):
                RUNNER.brief_renderer_module().validate_spec({**self.spec, "max_continues": value})
        self.spec["max_continues"] = 4
        self.spec_path.write_text(json.dumps(self.spec))
        self.directory = self.fixture.external_path / "spec-cap"
        code, state = self.call("init", "--task-spec", str(self.spec_path), "--host", "claude")
        self.assertEqual((code, state["limits"]["continues"]), (0, 4))
        self.directory = self.fixture.external_path / "cli-cap"
        code, state = self.call("init", "--task-spec", str(self.spec_path), "--host", "claude", "--max-continues", "0")
        self.assertEqual((code, state["limits"]["continues"]), (0, 0))
        _, run = self.start()
        self.reviewed(run)
        code, error = self.follow()
        self.assertEqual(code, 2)
        self.assertIn("continue budget exhausted (0", error)

    def test_continue_audits_scope_and_refuses_an_unsafe_baseline(self):
        _, run = self.start()
        self.reviewed(run)
        self.new_spec()
        with mock.patch.dict(os.environ, {"FAKE_OUTPUT": "outside/output.txt"}):
            code, run = self.follow()
        self.assertEqual((code, run["runner_status"]), (0, "scope_violation"), run)
        result = COORDINATOR.read(Path(run["result_path"]))
        self.assertIn("outside/output.txt", result["scope_violations"])
        self.reviewed(run)
        code, error = self.follow("unsafe-resume")
        self.assertEqual(code, 2)
        self.assertIn("investigation", error)

    def test_continue_has_its_own_verification_gates_and_default_timeout(self):
        _, first = self.start()
        self.reviewed(first)
        self.new_spec()
        with mock.patch.dict(os.environ, {"FAKE_OUTPUT": "followup/output.txt"}):
            code, run = self.follow("failed-gate", "--verify-command", "false")
        self.assertEqual((code, run["runner_status"]), (0, "verification_failed"), run)
        self.assertNotIn("--timeout", run["command"])
        result = COORDINATOR.read(Path(run["result_path"]))
        self.assertEqual(result["verification"]["status"], "failed")
        self.reviewed(run)
        self.spec.update(allow_paths=[], track_paths=[])
        self.spec_path.write_text(json.dumps(self.spec))
        with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
            code, run = self.follow("next-phase")
        self.assertEqual((code, run["runner_status"], run["verification_commands"]), (0, "completed", []), run)

    def test_continue_requires_a_new_spec_and_refuses_executor_and_repository_overrides(self):
        _, first = self.start()
        self.reviewed(first)
        code, error = self.call("dispatch", "--kind", "continue", "--request-id", "missing-spec")
        self.assertEqual(code, 2)
        self.assertIn("new --task-spec", error)
        code, error = self.follow("override", "--engine", "agy", "--model", "gemini-3.8-flash-medium")
        self.assertEqual(code, 2)
        self.assertIn("inherits engine", error)
        self.spec["repository_root"] = str(self.fixture.external_path)
        self.spec_path.write_text(json.dumps(self.spec))
        code, error = self.follow("other-checkout")
        self.assertEqual(code, 2)
        self.assertIn("repository differs", error)

    def test_latest_request_projection_and_legacy_record(self):
        _, first = self.start()
        self.reviewed(first)
        self.spec.update(allow_paths=[], track_paths=[], objective="Review the next phase")
        self.spec_path.write_text(json.dumps(self.spec))
        with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
            code, run = self.follow()
        self.assertEqual((code, run["runner_status"]), (0, "completed"))
        state = COORDINATOR.load(self.directory)
        member = {
            "engine": "codex",
            "dispatch": {
                "taskId": state["task_id"],
                "requestId": first["request_id"],
                "runId": first["run_id"],
                "transport": "executor",
            },
        }
        state["runs"][-1]["status"] = "active"
        projected = ROOM_TASKS.project(str(self.fixture.repository.path), member, ROOM_TASKS.compact(state))
        self.assertEqual(
            (projected["run"]["request_id"], projected["status"], projected["objective"]),
            ("follow", "running", "Review the next phase"),
        )
        self.assertEqual([run["request_id"] for run in projected["history"]], ["implement", "follow"])
        state["runs"] = [first]
        first.pop("task_spec")
        state["task_spec"] = {"objective": "Legacy objective"}
        projected = ROOM_TASKS.project(str(self.fixture.repository.path), member, ROOM_TASKS.compact(state))
        self.assertEqual(
            (projected["run"]["request_id"], projected["status"], projected["objective"]),
            ("implement", "rejected", "Legacy objective"),
        )

    def native_finish(self, run, event, output):
        packet = self.fixture.external_path / "native-packet.json"
        report = self.fixture.external_path / "native-report.txt"
        packet.write_text(json.dumps({"native_handle": "native-session"}))
        code, attached = self.call("native-attach", "--run-id", run["run_id"], "--packet", str(packet))
        self.assertEqual((code, attached["status"]), (0, "active"))
        destination = self.fixture.repository.path / output
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text("native output\n")
        report.write_text(
            "### STATUS\nCOMPLETE\n### FILES CHANGED\noutput\n### COMMANDS RUN\nnone\n### VERIFICATION\nHost gate\n### RISKS OR BLOCKERS\nnone\n"
        )
        packet.write_text(
            json.dumps(
                {
                    "native_handle": "native-session",
                    "event_id": event,
                    "terminal": True,
                    "tool_status": "completed",
                    "report_path": str(report),
                }
            )
        )
        code, finished = self.call("native-complete", "--run-id", run["run_id"], "--packet", str(packet))
        self.assertEqual(code, 0, finished)
        return finished

    def test_native_continue_reattaches_same_handle_and_audits_new_scope(self):
        code, first = self.call(
            "dispatch",
            "--kind",
            "implementation",
            "--request-id",
            "native-first",
            "--transport",
            "native",
            "--engine",
            "claude",
            "--model",
            "claude-sonnet-5",
            "--effort",
            "high",
        )
        self.assertEqual(code, 0, first)
        guards = [first]
        try:
            first = self.native_finish(first, "event-1", "allowed/output.txt")
            self.assertEqual(first["runner_status"], "completed")
            self.reviewed(first)
            self.new_spec()
            code, run = self.follow("native-follow", "--verify-command", "test -f followup/output.txt")
            self.assertEqual(code, 0, run)
            guards.append(run)
            self.assertEqual(
                (run["required_native_handle"], run["native_instructions"]["session"], run["effort"]),
                ("native-session", "native-session", "high"),
            )
            packet = self.fixture.external_path / "wrong-handle.json"
            packet.write_text(json.dumps({"native_handle": "different-session"}))
            code, error = self.call("native-attach", "--run-id", run["run_id"], "--packet", str(packet))
            self.assertEqual(code, 2)
            self.assertIn("original session", error)
            run = self.native_finish(run, "event-2", "followup/output.txt")
            self.assertEqual(run["runner_status"], "completed")
            result = COORDINATOR.read(Path(run["result_path"]))
            self.assertEqual(
                (
                    result["session_id"],
                    result["allowed_paths"],
                    result["run_delta"]["changed_paths"],
                    result["verification"]["status"],
                ),
                ("native-session", ["followup", "followup/output.txt"], ["followup/output.txt"], "passed"),
            )
            self.assertNotIn("task_git_before", result)
        finally:
            for run in guards:
                if COORDINATOR.NATIVE.process_state(run) == "active":
                    os.kill(run["pid"], 15)
