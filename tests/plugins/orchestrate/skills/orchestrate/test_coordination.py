from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import test_run_agent as fixtures

RUNNER = fixtures.RUNNER
SUPPORT = RUNNER.bundled_module("execution_support")
USAGE = RUNNER.bundled_module("usage")
COORDINATOR = RUNNER.bundled_module("coordinator")
MAILBOX = RUNNER.bundled_module("peer_mailbox")
AUTO_CORRECT = RUNNER.bundled_module("auto_correct")


def sample_usage(input_tokens=1000, cached=400, writes=100, output=200):
    return {
        "input_tokens": input_tokens,
        "cached_input_tokens": cached,
        "cache_write_input_tokens": writes,
        "output_tokens": output,
        "reasoning_output_tokens": 80,
    }


def usage_stream(*snapshots):
    return "\n".join(json.dumps({"type": "turn.completed", "usage": value}) for value in snapshots)


class UsageTests(unittest.TestCase):
    def test_captured_agy_envelope_yields_report_usage_and_exact_session(self):
        text = (Path(__file__).parent / "fixtures/agy-1.2.6-stream.jsonl").read_text()
        report, session, status = RUNNER.parse_agy_output(text)
        self.assertEqual((session, status), ("00000000-0000-4000-8000-000000000001", "success"))
        raw, extracted = RUNNER.extract_raw_final_report(report)
        self.assertEqual(RUNNER.parse_reported_outcome(raw, extracted), "blocked")
        usage = USAGE.normalize_usage("agy", text)
        self.assertEqual(usage["cumulative"]["input_tokens"], 1000)
        self.assertEqual(usage["cumulative"]["thinking_tokens"], 60)
        self.assertEqual(usage["status"], "unknown")

    def test_agy_keeps_cumulative_and_step_snapshots_separate_without_guessing_billing(self):
        events = [
            {"type": "init", "model": "gemini-3.8-flash-medium"},
            {"type": "step_update", "conversation_id": "s", "step_index": 1, "usage": {"input_tokens": 20}},
            {"type": "step_update", "conversation_id": "s", "step_index": 1, "usage": {"input_tokens": 278}},
            {
                "type": "result",
                "conversation_id": "s",
                "usage": {"input_tokens": 278, "cache_read_tokens": 30214, "output_tokens": 4, "total_tokens": 282},
            },
        ]
        text = "\n".join(json.dumps(event) for event in events)
        usage = USAGE.normalize_usage("agy", text)
        self.assertEqual(usage["status"], "unknown")
        self.assertEqual(usage["cumulative"]["input_tokens"], 278)
        self.assertEqual(len(usage["step_snapshots"]), 1)
        self.assertEqual(usage["step_snapshots"][0]["usage"]["input_tokens"], 278)
        self.assertEqual(usage["model_observations"][0]["meaning"], "configured_not_backend_resolved")
        self.assertIn(
            "separate_process_resume_counter_scope_unverified",
            USAGE.normalize_usage("agy", text, resumed=True, baseline=usage["cumulative"])["gaps"],
        )

    def test_tariff_estimates_expire_and_do_not_guess_long_context_tiers(self):
        registry = json.loads((fixtures.SKILL_DIR / "references/model-registry.json").read_text())
        now = dt.datetime(2026, 10, 17, 16, tzinfo=dt.UTC)
        usage = USAGE.normalize_usage("codex", usage_stream(sample_usage()))
        estimate = USAGE.estimate_tariff(usage, "gpt-5.6-luna", registry, billing_mode="subscription", now=now)
        self.assertEqual((estimate["estimated_usd"], estimate["actual_charge_usd"]), (0.000373, None))
        week_old = USAGE.estimate_tariff(
            usage, "gpt-5.6-luna", registry, billing_mode="api", now=now + dt.timedelta(days=7)
        )
        self.assertEqual(week_old["estimated_usd"], 0.000373)
        expired = USAGE.estimate_tariff(
            usage, "gpt-5.6-luna", registry, billing_mode="api", now=now + dt.timedelta(days=31)
        )
        self.assertEqual(expired["gaps"], ["tariff_requires_live_refresh"])
        slug = USAGE.estimate_tariff(usage, "gemini-3.8-flash-high", registry, billing_mode="api", now=now)
        self.assertNotIn("model_has_no_verified_tariff", slug["gaps"])
        long = USAGE.normalize_usage("codex", usage_stream(sample_usage(300000)))
        unresolved = USAGE.estimate_tariff(long, "gpt-5.6-luna", registry, billing_mode="api", now=now)
        self.assertEqual(
            (unresolved["estimated_usd"], unresolved["gaps"]), (None, ["per_request_tariff_tier_not_resolved"])
        )

    def test_codex_uses_last_snapshot_and_counts_reasoning_once(self):
        result = USAGE.normalize_usage("codex", usage_stream(sample_usage(800), sample_usage()))
        self.assertEqual(result["totals"], {"fresh_input": 500, "cache_read": 400, "cache_write": 100, "output": 200})
        self.assertEqual(result["cumulative"]["input_tokens"], 1000)

    def test_resume_requires_a_baseline_and_reports_only_new_usage(self):
        text = usage_stream(sample_usage(1600, 600, 200, 300))
        unknown = USAGE.normalize_usage("codex", text, resumed=True)
        self.assertEqual(unknown["status"], "unknown")
        delta = USAGE.normalize_usage("codex", text, resumed=True, baseline=sample_usage())
        self.assertEqual(delta["totals"], {"fresh_input": 300, "cache_read": 200, "cache_write": 100, "output": 100})

    def test_unknown_writes_impossible_inputs_and_reset_counters_remain_unknown(self):
        raw = sample_usage()
        del raw["cache_write_input_tokens"]
        result = USAGE.normalize_usage("codex", usage_stream(raw))
        self.assertEqual(result["totals"], {"fresh_input": None, "cache_read": 400, "cache_write": None, "output": 200})
        impossible = USAGE.normalize_usage("codex", usage_stream(sample_usage(10)))
        self.assertEqual(impossible["status"], "partial")
        self.assertIsNone(impossible["totals"]["fresh_input"])
        reset = USAGE.normalize_usage(
            "codex", usage_stream(sample_usage(10, 1, 1, 1)), resumed=True, baseline=sample_usage()
        )
        self.assertEqual(reset["status"], "unknown")

    def test_raw_counter_reset_cannot_look_like_positive_fresh_usage(self):
        result = USAGE.normalize_usage(
            "codex",
            usage_stream(sample_usage(9000, 1000, 0, 300)),
            resumed=True,
            baseline=sample_usage(10000, 9000, 500, 200),
        )
        self.assertEqual(
            result["totals"], {"fresh_input": None, "cache_read": None, "cache_write": None, "output": None}
        )
        self.assertIn("cumulative_counters_reset", result["gaps"])

    def test_opencode_deduplicates_steps_and_adds_separate_reasoning(self):
        event = {
            "type": "step_finish",
            "sessionID": "s",
            "part": {
                "id": "a",
                "messageID": "m",
                "cost": 0.02,
                "tokens": {"input": 500, "cache": {"read": 400, "write": 100}, "output": 120, "reasoning": 80},
            },
        }
        result = USAGE.normalize_usage("opencode", json.dumps(event) + "\n" + json.dumps(event))
        self.assertEqual(result["totals"], {"fresh_input": 500, "cache_read": 400, "cache_write": 100, "output": 200})
        self.assertEqual(result["native_cost_usd"], 0.02)
        del event["part"]["id"]
        self.assertEqual(USAGE.normalize_usage("opencode", json.dumps(event))["status"], "unknown")

    def test_missing_attempt_usage_never_becomes_free_work(self):
        known = USAGE.normalize_usage("codex", usage_stream(sample_usage()))
        unknown = USAGE.normalize_usage("agy", "Plain report")
        result = USAGE.combine_attempts([known, unknown])
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["attempts"][0]["totals"]["output"], 200)
        self.assertEqual(
            unknown["totals"], {"fresh_input": None, "cache_read": None, "cache_write": None, "output": None}
        )

    def test_claude_resumed_cost_is_delta_consistent_with_cumulative_tokens(self):
        def result(cost, input_tokens, cache_read, cache_write, output):
            return json.dumps(
                {
                    "type": "result",
                    "usage": {
                        "input_tokens": input_tokens,
                        "cache_read_input_tokens": cache_read,
                        "cache_creation_input_tokens": cache_write,
                        "output_tokens": output,
                    },
                    "total_cost_usd": cost,
                }
            )

        first = USAGE.normalize_usage("claude", result(0.40, 100, 10, 5, 20))
        legacy = USAGE.normalize_usage(
            "claude",
            result(0.65, 140, 12, 6, 25),
            resumed=True,
            baseline=first["cumulative"],
            baseline_cost=first["native_cost_usd"],
        )
        self.assertEqual(legacy["totals"], {"fresh_input": 40, "cache_read": 2, "cache_write": 1, "output": 5})
        self.assertEqual(legacy["native_cost_usd"], 0.65)
        second = USAGE.normalize_usage(
            "claude",
            result(0.65, 140, 12, 6, 25),
            resumed=True,
            baseline=first["cumulative"],
            baseline_cost=first["native_cost_usd"],
            delta_accounting=True,
        )
        third = USAGE.normalize_usage(
            "claude",
            result(0.85, 180, 15, 7, 30),
            resumed=True,
            baseline=second["cumulative"],
            baseline_cost=0.65,
            delta_accounting=True,
        )

        combined = USAGE.combine_attempts([first, second, third])
        self.assertEqual(combined["totals"], {"fresh_input": 180, "cache_read": 15, "cache_write": 7, "output": 30})
        self.assertEqual(combined["native_cost_usd"], 0.85)


class ExecutionExtensionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.RunnerIntegrationTests()
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()

    def test_catalog_effort_binds_to_cli_and_invalid_value_stops_before_execution(self):
        code, result, _, _, capture = self.fixture.run_main(extra_args=["--effort", "low"])
        self.assertEqual((code, result["effort"]["bound"]), (0, "low"))
        self.assertIn('model_reasoning_effort="low"', capture["argv"])
        self.assertIsNone(result["effort"]["observed"])
        code, result, _, _, capture = self.fixture.run_main(extra_args=["--effort", "made-up"])
        self.assertEqual((code, result["status"]), (4, "preflight_failed"))
        self.assertEqual(capture, {})

    def test_tabbed_agy_catalog_uses_exact_id_and_effort_conflicts_fail(self):
        code, result, _, _, _ = self.fixture.run_main(engine="agy", extra_args=["--effort", "medium"])
        self.assertEqual((code, result["model"], result["effort"]["bound"]), (0, "gemini-3.8-flash-medium", "medium"))
        code, result, _, _, capture = self.fixture.run_main(engine="agy", extra_args=["--effort", "high"])
        self.assertEqual((code, result["status"], capture), (4, "preflight_failed", {}))

    def test_agy_terminal_failure_cannot_be_overridden_by_complete_report(self):
        with mock.patch.dict(os.environ, {"FAKE_AGY_STATUS": "error"}):
            code, result, _, _, capture = self.fixture.run_main(engine="agy")
        self.assertEqual((result["status"], result["provider_terminal_status"]), ("failed", "error"))
        self.assertIn("stream-json", capture["argv"])

    def test_resume_preserves_identity_and_derives_a_usage_delta(self):
        with mock.patch.dict(os.environ, {"FAKE_CODEX_USAGE": json.dumps([sample_usage()])}):
            code, first, directory, _, _ = self.fixture.run_main(
                no_change=True, expect_changes=False, allow_path=None, extra_args=["--effort", "low"]
            )
        with mock.patch.dict(os.environ, {"FAKE_CODEX_USAGE": json.dumps([sample_usage(1600, 600, 200, 300)])}):
            code, result, _, _, _ = self.fixture.run_main(
                no_change=True,
                expect_changes=False,
                allow_path=None,
                session=first["session_id"],
                extra_args=["--effort", "low", "--resume-result", str(directory / "result.json")],
            )
        self.assertEqual(code, 0)
        self.assertEqual(
            result["usage"]["totals"], {"fresh_input": 300, "cache_read": 200, "cache_write": 100, "output": 100}
        )
        code, result, _, _, capture = self.fixture.run_main(
            no_change=True,
            expect_changes=False,
            allow_path=None,
            session=first["session_id"],
            extra_args=["--effort", "high", "--resume-result", str(directory / "result.json")],
        )
        self.assertEqual((code, result["status"], capture), (4, "preflight_failed", {}))

    def test_workspace_lease_survives_parent_release_until_child_exits(self):
        cache = self.fixture.external_path / "locks"
        repository = self.fixture.repository.path
        with SUPPORT.workspace_lease(repository, cache) as descriptor:
            child = subprocess.Popen(
                [sys.executable, "-c", "import sys,time; print('ready', flush=True); time.sleep(10)"],
                stdout=subprocess.PIPE,
                text=True,
                pass_fds=(descriptor,),
            )
            self.assertEqual(child.stdout.readline().strip(), "ready")
        try:
            with self.assertRaisesRegex(SUPPORT.ContractError, "another executor"):
                with SUPPORT.workspace_lease(repository, cache):
                    self.fail("concurrent lease was granted")
        finally:
            child.terminate()
            child.wait()
            child.stdout.close()
        with SUPPORT.workspace_lease(repository, cache):
            code, result, _, _, _ = self.fixture.run_main()
        self.assertEqual((code, result["status"]), (0, "completed"))

    def test_expired_deadline_does_not_launch_verification(self):
        marker = self.fixture.repository.path / "should-not-exist"
        result = RUNNER.run_verification_commands(
            [f"touch '{marker}'"],
            repo=self.fixture.repository.path,
            out_dir=self.fixture.external_path,
            timeout_seconds=10,
            deadline="2000-01-01T00:00:00+00:00",
        )
        self.assertEqual((result["status"], result["completed_count"], marker.exists()), ("timed_out", 0, False))

    def test_python_verification_subprocess_imports_do_not_write_bytecode(self):
        (self.fixture.repository.path / "helper.py").write_text("VALUE = 1\n")
        code, result, _, _, _ = self.fixture.run_main(
            extra_args=["--verify-command", 'python3 -c "import helper; assert helper.VALUE == 1"']
        )
        self.assertEqual((code, result["status"], result["verification"]["status"]), (0, "completed", "passed"))
        self.assertEqual(result["run_delta"]["changed_paths"], ["allowed/output.txt"])


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.RunnerIntegrationTests()
        self.fixture.setUp()
        self.directory = self.fixture.external_path / "task"
        self.spec = {
            "objective": "Write the approved output",
            "repository_root": str(self.fixture.repository.path),
            "current_state": "Output is missing",
            "pre_existing_changes": [],
            "plan": ["Write allowed/output.txt"],
            "allow_paths": ["allowed"],
            "track_paths": [],
            "development_checks": [],
            "acceptance_criteria": ["Output contains the approved content"],
        }
        self.spec_path = self.fixture.external_path / "spec.json"
        self.spec_path.write_text(json.dumps(self.spec))
        self.packet = self.fixture.external_path / "packet.json"
        self.packet.write_text(
            json.dumps(
                {
                    "question": "Does cancellation prevent the callback?",
                    "decision_needed": "Choose a race guard",
                    "observations": ["Callback ran after cancellation"],
                    "attempts": ["Cancellation alone failed"],
                    "versions": ["client 2"],
                    "hypotheses": ["Queued callbacks survive cancellation", "Another request emitted the callback"],
                }
            )
        )
        self.environment = mock.patch.dict(
            os.environ,
            {
                "PATH": f"{self.fixture.external_path}{os.pathsep}{os.environ['PATH']}",
                "XDG_CACHE_HOME": str(self.fixture.external_path / "cache"),
                "FAKE_CAPTURE": str(self.fixture.external_path / "capture.json"),
            },
        )
        self.environment.start()
        for key in (
            "AGENT_MAILBOX_SESSION",
            "HERDR_ENV",
            "HERDR_PANE_ID",
            "HERDR_WORKSPACE_ID",
            "ORKEST_TERMINAL_SERVER",
            "ORKEST_SWARM_ROOM",
            "ORKEST_TEST_ALLOW_HERDR",
        ):
            os.environ.pop(key, None)
        self.assertEqual(self.call("init", "--task-spec", str(self.spec_path), "--host", "claude")[0], 0)

    def tearDown(self):
        self.environment.stop()
        self.fixture.tearDown()

    def call(self, action, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = COORDINATOR.main([action, "--task-dir", str(self.directory), *args])
        return code, json.loads(stdout.getvalue()) if code == 0 else stderr.getvalue()

    def start(self, request="implement", kind="implementation", *extra):
        return self.call(
            "dispatch",
            "--kind",
            kind,
            "--request-id",
            request,
            "--engine",
            "codex",
            "--model",
            "gpt-5.6-luna",
            "--effort",
            "low",
            *extra,
        )

    def evidence(self):
        artifact = self.fixture.external_path / "evidence.txt"
        artifact.write_text("Observed trace and focused check output\n")
        path = self.fixture.external_path / "evidence.json"
        path.write_text(
            json.dumps(
                {
                    "conclusion": "Use a request identity guard based on the observed callback order",
                    "versions": {"client": "2"},
                    "criteria": self.spec["acceptance_criteria"],
                    "sources": [
                        {
                            "location": "local test trace",
                            "component": "client",
                            "version": "2",
                            "retrieved_at": RUNNER.utc_now(),
                            "artifact": str(artifact),
                            "sha256": COORDINATOR.digest(artifact),
                        }
                    ],
                }
            )
        )
        return path

    def reviewed_evidence(self):
        self.evidence()
        version_file = self.fixture.external_path / "version.txt"
        version_file.write_text("client 2\n")
        _, version = self.call(
            "capture",
            "--path",
            str(version_file),
            "--source-kind",
            "version",
            "--component",
            "client",
            "--version",
            "2",
        )
        _, source = self.call(
            "capture",
            "--path",
            str(self.fixture.external_path / "evidence.txt"),
            "--source-kind",
            "observation",
            "--component",
            "client",
            "--version",
            "2",
        )
        packet = self.fixture.external_path / "review-packet.json"
        packet.write_text(
            json.dumps(
                {
                    "question": "Does the fixture trace support the correction?",
                    "conclusion": "Use the observed trace",
                    "owner": "test conductor",
                    "invalidation_trigger": "client version or source changes",
                    "versions": {"client": "2"},
                    "version_sources": {"client": version["source_id"]},
                    "claims": [
                        {
                            "kind": "observation",
                            "statement": "The fixture produced a trace",
                            "citations": [
                                {"source_id": source["source_id"], "excerpt": "Observed trace and focused check output"}
                            ],
                        }
                    ],
                    "criteria": [{"criterion": self.spec["acceptance_criteria"][0], "claim_indexes": [0]}],
                    "gaps": [],
                }
            )
        )
        code, receipt = self.call("verify-evidence", "--packet", str(packet))
        self.assertEqual(code, 0, receipt)
        return receipt["review_id"]

    def test_duplicate_dispatch_and_recovery_do_not_relaunch_work(self):
        code, run = self.start()
        self.assertEqual((code, run["status"], run["runner_status"]), (0, "finished", "completed"))
        marker = self.fixture.external_path / "capture.json"
        original_time = marker.stat().st_mtime_ns
        state = COORDINATOR.load(self.directory)
        state["runs"][0]["status"] = "dispatching"
        COORDINATOR.save(self.directory, state)
        code, recovered = self.call("recover")
        self.assertEqual(recovered["runs"][0]["status"], "finished")
        code, duplicate = self.start()
        self.assertEqual((code, duplicate["run_id"], marker.stat().st_mtime_ns), (0, run["run_id"], original_time))

    def test_crash_without_result_is_uncertain_and_never_retried(self):
        state = COORDINATOR.load(self.directory)
        state["runs"].append(
            {
                "run_id": "reserved",
                "request_id": "implement",
                "kind": "implementation",
                "status": "dispatching",
                "result_path": str(self.directory / "missing-result.json"),
            }
        )
        COORDINATOR.save(self.directory, state)
        code, run = self.start()
        self.assertEqual((code, run["status"]), (0, "uncertain"))
        code, error = self.start("another")
        self.assertEqual(code, 2)
        self.assertIn("unresolved dispatch", error)

    def test_blocked_consulted_and_corrected_runs_keep_separate_outcomes(self):
        with mock.patch.dict(os.environ, {"FAKE_REPORT_STATUS": "BLOCKED"}):
            code, blocked = self.start()
        self.assertEqual(blocked["runner_status"], "blocked")
        with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
            code, consultation = self.start("consult", "consultation", "--packet", str(self.packet))
        self.assertEqual(consultation["runner_status"], "completed")
        proof = self.reviewed_evidence()
        self.assertEqual(
            self.call("review", "--run-id", consultation["run_id"], "--decision", "supported", "--review-id", proof)[0],
            0,
        )
        with mock.patch.dict(os.environ, {"FAKE_CONTENT": "corrected output\n"}):
            code, corrected = self.call(
                "dispatch", "--kind", "correction", "--request-id", "repair", "--review-id", proof
            )
        self.assertEqual((code, corrected["runner_status"]), (0, "completed"))
        self.assertNotIn("--timeout", corrected["command"])
        result = COORDINATOR.read(Path(corrected["result_path"]))
        self.assertEqual(
            (result["session_id"], result["effort"]["bound"], result["resumed_from"]),
            ("codex-thread-1", "low", blocked["result_path"]),
        )
        self.assertEqual(COORDINATOR.read(Path(blocked["result_path"]))["status"], "blocked")
        code, error = self.call(
            "dispatch", "--kind", "correction", "--request-id", "repair-again", "--review-id", proof
        )
        self.assertEqual(code, 2)
        self.assertIn("one correction", error)

    def test_acceptance_requires_current_untampered_evidence_and_workspace(self):
        _, run = self.start()
        proof = self.reviewed_evidence()
        artifact = self.fixture.external_path / "evidence.txt"
        artifact.write_text("Changed after review")
        code, error = self.call("review", "--run-id", run["run_id"], "--decision", "accept", "--review-id", proof)
        self.assertEqual(code, 2)
        self.assertIn("changed", error)
        proof = self.reviewed_evidence()
        code, decision = self.call("review", "--run-id", run["run_id"], "--decision", "accept", "--review-id", proof)
        self.assertEqual(
            (code, decision["decision"], COORDINATOR.load(self.directory)["status"]), (0, "accept", "accepted")
        )

    def test_allowance_counts_all_attempts_and_ack_requires_review(self):
        state = COORDINATOR.load(self.directory)
        state["budget"]["limit"] = 1
        COORDINATOR.save(self.directory, state)
        _, run = self.start()
        self.assertEqual(self.call("ack", "--run-id", run["run_id"], "--event-id", run["event_id"])[0], 2)
        self.assertEqual(self.call("review", "--run-id", run["run_id"], "--decision", "reject")[0], 0)
        self.assertEqual(self.call("ack", "--run-id", run["run_id"], "--event-id", "wrong")[0], 2)
        self.assertEqual(self.call("ack", "--run-id", run["run_id"], "--event-id", run["event_id"])[0], 0)
        code, error = self.start("consult", "consultation", "--packet", str(self.packet))
        self.assertEqual(code, 2)
        self.assertIn("allowance exhausted", error)
        self.assertEqual(COORDINATOR.load(self.directory)["budget"]["used"], 1)

    def test_live_process_recovery_does_not_mark_active_work_stopped(self):
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            state = COORDINATOR.load(self.directory)
            state["runs"].append(
                {
                    "run_id": "running",
                    "request_id": "running",
                    "kind": "implementation",
                    "status": "dispatching",
                    "result_path": str(self.directory / "missing-result.json"),
                    "pid": process.pid,
                    "process_identity": COORDINATOR.NATIVE.process_identity(process.pid),
                }
            )
            COORDINATOR.save(self.directory, state)
            code, state = self.call("recover")
            self.assertEqual((code, state["runs"][0]["status"]), (0, "active"))
            self.assertEqual(self.call("next")[1]["action"], "wait")
            state["deadline"] = "2000-01-01T00:00:00+00:00"
            COORDINATOR.save(self.directory, state)
            self.assertEqual(self.call("next")[1]["action"], "interrupt")
        finally:
            process.terminate()
            process.wait()

    def test_reverification_preserves_failed_result_and_does_not_spend_model_allowance(self):
        code, failed = self.start("work", "implementation", "--verify-command", "exit 1")
        self.assertEqual((code, failed["runner_status"]), (0, "verification_failed"))
        original = Path(failed["result_path"]).read_bytes()
        code, checked = self.call(
            "reverify",
            "--run-id",
            failed["run_id"],
            "--request-id",
            "check-1",
            "--reason",
            "The supplied gate exited unconditionally; check the requested artifact",
            "--verify-command",
            "test -f allowed/output.txt",
        )
        self.assertEqual((code, checked["runner_status"]), (0, "completed"))
        self.assertEqual(Path(failed["result_path"]).read_bytes(), original)
        self.assertEqual(COORDINATOR.load(self.directory)["budget"]["used"], 1)
        result = COORDINATOR.read(Path(checked["result_path"]))
        self.assertEqual(result["usage"]["totals"], {"fresh_input": 0, "cache_read": 0, "cache_write": 0, "output": 0})
        self.assertFalse(result["model_invoked"])
        code, duplicate = self.call(
            "reverify", "--run-id", failed["run_id"], "--request-id", "check-1", "--reason", "same check"
        )
        self.assertEqual((code, duplicate["run_id"]), (0, checked["run_id"]))

    def test_reverification_cannot_hide_a_mutating_check(self):
        _, work = self.start()
        code, checked = self.call(
            "reverify",
            "--run-id",
            work["run_id"],
            "--request-id",
            "bad-check",
            "--reason",
            "Exercise mutation rejection",
            "--verify-command",
            "printf changed > allowed/output.txt",
        )
        self.assertEqual((code, checked["runner_status"]), (0, "verification_mutation"))

    def test_investigation_can_start_without_a_hypothesis_and_is_audited_read_only(self):
        with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
            code, run = self.start("explore", "investigation")
        self.assertEqual((code, run["runner_status"]), (0, "completed"))
        result = json.loads(Path(run["result_path"]).read_text())
        self.assertEqual((result["allowed_paths"], result["expected_changes"]), ([], False))
        code, writing = self.start("bad-explore", "investigation")
        self.assertEqual((code, writing["runner_status"]), (0, "scope_violation"))

    def test_claude_cli_dispatch_is_supported_when_host_is_not_claude(self):
        state = COORDINATOR.load(self.directory)
        state["host"] = "codex"
        COORDINATOR.save(self.directory, state)
        with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
            code, run = self.call(
                "dispatch",
                "--kind",
                "investigation",
                "--request-id",
                "claude-research",
                "--engine",
                "claude",
                "--model",
                "sonnet",
            )
        self.assertEqual((code, run["runner_status"]), (0, "completed"))

    def test_readonly_observation_commands_remain_available_under_dispatch_lock(self):
        with SUPPORT.workspace_lease(self.directory, RUNNER.default_agent_cache_dir() / "coordinator-locks"):
            code, shown = self.call("show")
            self.assertEqual((code, shown["status"]), (0, "active"))
            self.assertEqual(self.call("next")[1]["action"], "continue")

    def test_two_investigators_run_concurrently_and_prevent_a_writer(self):
        directory = self.fixture.external_path
        release = directory / "release"
        runs = []
        try:
            for index in range(2):
                started = directory / f"started-{index}"
                with mock.patch.dict(
                    os.environ,
                    {
                        "FAKE_NO_CHANGE": "1",
                        "FAKE_BLOCK": "1",
                        "FAKE_RELEASE": str(release),
                        "FAKE_STARTED": str(started),
                    },
                ):
                    code, run = self.start(f"reader-{index}", "investigation", "--background")
                self.assertEqual((code, run["status"]), (0, "active"))
                runs.append(run)
                until = time.monotonic() + 5
                while not started.exists() and time.monotonic() < until:
                    time.sleep(0.02)
                self.assertTrue(started.exists())
                self.assertEqual(started.read_text(), "started")
            code, error = self.start("writer", "implementation")
            self.assertEqual(code, 2)
            self.assertIn("only active read-only runs can overlap", error)
        finally:
            release.touch()
            for run in runs:
                result = list(
                    RUNNER.wait_for_completion_events(
                        [Path(run["event_path"])], repository=None, timeout_seconds=10, poll_seconds=0.02
                    )
                )[0]
                self.assertEqual(result["status"], "completed")
        self.assertEqual(self.call("recover")[1]["budget"]["used"], 2)

    def test_consultant_keeps_original_context_and_prior_results(self):
        state = COORDINATOR.load(self.directory)
        state["task_spec"]["scope_owner"] = "worker"
        state["task_spec"]["allow_paths"] = ["."]
        state["task_spec"]["effective_scope"] = ["."]
        state["task_spec"]["context_packet"] = {"decisions": ["Keep the public API"], "evidence": ["Original trace"]}
        COORDINATOR.save(self.directory, state)
        with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
            _, investigation = self.start("explore", "investigation")
            code, run = self.start("consult", "consultation", "--packet", str(self.packet))
        self.assertEqual((code, run["runner_status"]), (0, "completed"))
        inv_spec = json.loads((Path(investigation["result_path"]).parent.parent / "task-spec.json").read_text())
        self.assertEqual(inv_spec["scope_owner"], "conductor")
        self.assertEqual(inv_spec["allow_paths"], [])
        self.assertEqual(RUNNER.brief_renderer_module().validate_spec(inv_spec)["effective_scope"], [])
        spec = json.loads((Path(run["result_path"]).parent.parent / "task-spec.json").read_text())
        self.assertEqual(spec["scope_owner"], "conductor")
        self.assertEqual(spec["allow_paths"], [])
        self.assertEqual(RUNNER.brief_renderer_module().validate_spec(spec)["effective_scope"], [])
        self.assertEqual(spec["context_packet"]["decisions"][0], "Keep the public API")
        self.assertEqual(
            spec["context_packet"]["evidence"],
            [
                "Original trace",
                "Callback ran after cancellation",
                "Prior investigation result: " + investigation["result_path"],
            ],
        )

    def test_reader_leases_allow_multiple_readers_and_exclude_writers(self):
        with tempfile.TemporaryDirectory() as cache:
            with SUPPORT.workspace_lease(self.directory, Path(cache), read_only=True):
                with SUPPORT.workspace_lease(self.directory, Path(cache), read_only=True):
                    with self.assertRaisesRegex(SUPPORT.ContractError, "another executor"):
                        with SUPPORT.workspace_lease(self.directory, Path(cache)):
                            self.fail("a writer was granted beside readers")
            with SUPPORT.workspace_lease(self.directory, Path(cache)):
                with self.assertRaisesRegex(SUPPORT.ContractError, "another executor"):
                    with SUPPORT.workspace_lease(self.directory, Path(cache), read_only=True):
                        self.fail("a reader was granted beside a writer")
            with SUPPORT.workspace_lease(self.directory, Path(cache), read_only=True):
                pass

    def test_native_host_handoff_holds_lease_and_audits_before_review(self):
        code, run = self.call(
            "dispatch",
            "--kind",
            "implementation",
            "--request-id",
            "native-1",
            "--transport",
            "native",
            "--engine",
            "claude",
            "--model",
            "claude-sonnet-5",
            "--effort",
            "high",
            "--verify-command",
            "test -f allowed/output.txt",
        )
        self.assertEqual(code, 0, run)
        mailbox = run["mailbox"]
        worker = MAILBOX.load(MAILBOX.peer_path(MAILBOX.root(), mailbox["worker"]))
        conductor = MAILBOX.load(MAILBOX.peer_path(MAILBOX.root(), mailbox["conductor"]))
        question = MAILBOX.send(
            MAILBOX.root(),
            sender=worker,
            to=mailbox["conductor"],
            text="Should I trace the callback?",
            kind="question",
            client_id="q1",
        )
        response = self.call("next")[1]
        self.assertEqual((response["action"], response["mailbox"]), ("respond", mailbox["conductor"]))
        self.assertEqual(response["messages"][0]["id"], question["id"])
        answer = MAILBOX.send(
            MAILBOX.root(),
            sender=conductor,
            to=mailbox["worker"],
            text="Yes, inspect its cancellation path.",
            kind="reply",
            client_id="a1",
            reply_to="q1",
        )
        self.assertEqual(
            MAILBOX.wait(MAILBOX.root(), mailbox["worker"], timeout=0.1, reply_to="q1")["messages"][0]["text"],
            answer["text"],
        )
        MAILBOX.send(
            MAILBOX.root(),
            sender=worker,
            to=mailbox["conductor"],
            text="Audit report is ready.",
            kind="update",
            client_id="ready-update",
        )
        packet = self.fixture.external_path / "native.json"
        try:
            instructions = run["native_instructions"]
            self.assertEqual(run["status"], "reserved")
            self.assertIn("native agent/thread tools", instructions["communication"])
            native_brief = Path(instructions["brief_path"]).read_text()
            self.assertIn("Write the approved output", native_brief)
            self.assertIn("# Native communication", native_brief)
            self.assertNotIn("mailbox ask", native_brief)
            with self.assertRaisesRegex(SUPPORT.ContractError, "another executor"):
                with SUPPORT.workspace_lease(self.fixture.repository.path, RUNNER.default_agent_cache_dir()):
                    self.fail("lease should belong to the native guard")
            packet.write_text(json.dumps({"native_handle": "native-test-session"}))
            self.assertEqual(self.call("native-attach", "--run-id", run["run_id"], "--packet", str(packet))[0], 0)
            native = MAILBOX.register(
                MAILBOX.root(), session="native-test-session", harness="codex", cwd=str(self.fixture.repository.path)
            )
            self.assertEqual(MAILBOX.mark_delegated(MAILBOX.root(), native).get("delegatedRun"), mailbox["run"])
            (self.fixture.repository.path / "allowed").mkdir(exist_ok=True)
            (self.fixture.repository.path / "allowed/output.txt").write_text("native output\n")
            report = self.fixture.external_path / "native-report.txt"
            report.write_text(
                "### STATUS\nCOMPLETE\n### FILES CHANGED\nallowed/output.txt\n### COMMANDS RUN\nnone\n### VERIFICATION\nHost will check output.\n### RISKS OR BLOCKERS\nnone\n"
            )
            packet.write_text(
                json.dumps(
                    {
                        "native_handle": "native-test-session",
                        "event_id": "native-completion-1",
                        "terminal": True,
                        "tool_status": "completed",
                        "report_path": str(report),
                    }
                )
            )
            code, finished = self.call("native-complete", "--run-id", run["run_id"], "--packet", str(packet))
            self.assertEqual(code, 0, finished)
            self.assertEqual((code, finished["runner_status"]), (0, "completed"), finished)
            result = COORDINATOR.read(Path(finished["result_path"]))
            self.assertEqual(result["mailbox"], mailbox)
            review_message = self.call("next")[1]
            self.assertEqual((review_message["action"], review_message["run_status"]), ("review_message", "completed"))
            with mock.patch.object(COORDINATOR.RUNNER, "deadline_remaining", return_value=0):
                self.assertEqual(self.call("next")[1]["action"], "review_message")
            with self.assertRaisesRegex(MAILBOX.MailboxError, "run is closed"):
                MAILBOX.send(
                    MAILBOX.root(),
                    sender=conductor,
                    to=mailbox["worker"],
                    text="Late message",
                    kind="update",
                    client_id="late",
                )
            self.assertEqual(result["verification"]["status"], "passed")
            self.assertIsNone(result["resolved_model"])
            self.assertIsNone(result["effort"]["observed"])
            self.assertEqual(
                self.call("dispatch", "--kind", "implementation", "--request-id", "native-1", "--transport", "native")[
                    1
                ]["run_id"],
                run["run_id"],
            )
        finally:
            if COORDINATOR.NATIVE.process_state(run) == "active":
                os.kill(run["pid"], 15)

    def test_live_worker_question_wakes_event_wait_and_coordinator_next(self):
        executable = self.fixture.external_path / "codex"
        source = executable.read_text()
        source = source.replace(
            "    prompt = sys.stdin.read()",
            """    prompt = sys.stdin.read()
    answer = subprocess.run([sys.executable, os.environ['FAKE_MAILBOX_RUNNER'], 'mailbox', 'ask',
                             '--id', 'which-version', '--text', 'Which client version?', '--timeout', '10'],
                            capture_output=True, text=True, check=True)
    pathlib.Path(os.environ['FAKE_ANSWER']).write_text(answer.stdout)
""",
        )
        executable.write_text(source)
        answer_path = self.fixture.external_path / "answer.json"
        with mock.patch.dict(
            os.environ,
            {"FAKE_NO_CHANGE": "1", "FAKE_MAILBOX_RUNNER": str(fixtures.SCRIPT), "FAKE_ANSWER": str(answer_path)},
        ):
            code, run = self.start("live", "investigation", "--background")
        self.assertEqual((code, run["status"]), (0, "active"))
        watched = subprocess.run(
            [
                sys.executable,
                "-B",
                str(fixtures.SCRIPT),
                "events",
                "wait",
                run["event_path"],
                "--messages",
                "--timeout",
                "10s",
                "--poll-seconds",
                ".02",
            ],
            capture_output=True,
            text=True,
            timeout=12,
        )
        self.assertEqual(watched.returncode, 0, watched.stderr)
        signal = json.loads(watched.stdout)
        self.assertEqual(signal["messages"][0]["text"], "Which client version?")
        self.assertEqual(signal["mailbox"], run["mailbox"]["conductor"])
        response = self.call("next")[1]
        self.assertEqual((response["action"], response["mailbox"]), ("respond", run["mailbox"]["conductor"]))
        reply = subprocess.run(
            [
                sys.executable,
                "-B",
                str(fixtures.SCRIPT),
                "mailbox",
                "send",
                "--session",
                run["mailbox"]["conductor"],
                "--to",
                run["mailbox"]["worker"],
                "--kind",
                "reply",
                "--id",
                "version-answer",
                "--reply-to",
                "which-version",
                "--text",
                "Client 2",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(reply.returncode, 0, reply.stderr)
        completed = list(
            RUNNER.wait_for_completion_events(
                [Path(run["event_path"])], repository=None, timeout_seconds=10, poll_seconds=0.02
            )
        )[0]
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(json.loads(answer_path.read_text())["messages"][0]["text"], "Client 2")
        self.assertEqual(self.call("recover")[1]["budget"]["used"], 1)

    def test_claim_cannot_verify_an_excerpt_absent_from_the_source(self):
        self.reviewed_evidence()
        path = self.fixture.external_path / "review-packet.json"
        packet = COORDINATOR.read(path)
        packet["claims"][0]["citations"][0]["excerpt"] = "invented vendor assertion"
        path.write_text(json.dumps(packet))
        code, error = self.call("verify-evidence", "--packet", str(path))
        self.assertEqual(code, 2)
        self.assertIn("absent", error)

    def test_raw_audit_capture_does_not_invalidate_check_projection_of_same_result(self):
        _, run = self.start("check", "implementation", "--verify-command", "printf checked")
        code, check = self.call("capture-checks", "--run-id", run["run_id"], "--component", "client", "--version", "2")
        self.assertEqual(code, 0, check)
        code, audit = self.call(
            "capture",
            "--path",
            run["result_path"],
            "--source-kind",
            "observation",
            "--component",
            "client",
            "--version",
            "2",
        )
        self.assertEqual(code, 0, audit)
        state = COORDINATOR.load(self.directory)
        source = state["evidence"]["sources"][check["source_id"]]
        self.assertIn("checked", COORDINATOR.EVIDENCE.validate_source(source, state, RUNNER))
        self.assertIsNone(source["invalidated"])

    def test_consultation_budget_deadline_and_native_boundary_are_enforced(self):
        with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
            for index in range(3):
                code, run = self.start("consult" + str(index), "consultation", "--packet", str(self.packet))
                self.assertEqual((code, run["runner_status"]), (0, "completed"))
        code, error = self.start("fourth", "consultation", "--packet", str(self.packet))
        self.assertEqual(code, 2)
        self.assertIn("budget exhausted", error)
        state = COORDINATOR.load(self.directory)
        state["deadline"] = "2000-01-01T00:00:00+00:00"
        COORDINATOR.save(self.directory, state)
        code, error = self.start()
        self.assertEqual(code, 2)
        self.assertIn("deadline exhausted", error)
        route = COORDINATOR.choose_route(
            {
                "host": "codex",
                "engine": "codex",
                "model": "gpt-6-astra",
                "context_portable": True,
                "independent_acceptance": True,
                "handoff_worthwhile": True,
            }
        )
        self.assertEqual(route, {"action": "delegate", "owner": "fresh_worker", "transport": "native"})

    def test_stale_or_wrong_version_sources_are_not_verified(self):
        proof = self.evidence()
        value = COORDINATOR.read(proof)
        value["sources"][0]["version"] = "3"
        proof.write_text(json.dumps(value))
        with self.assertRaisesRegex(COORDINATOR.CoordinationError, "observed version"):
            COORDINATOR.check_evidence(proof)
        value["sources"][0]["version"] = "2"
        value["sources"][0]["retrieved_at"] = "2000-01-01T00:00:00+00:00"
        proof.write_text(json.dumps(value))
        with self.assertRaisesRegex(COORDINATOR.CoordinationError, "stale"):
            COORDINATOR.check_evidence(proof)

    def test_consultation_request_is_advice_only_and_rejects_approval_fields(self):
        packet = self.packet.read_text()
        report = "### RISKS OR BLOCKERS\n```consultation-request\n" + packet + "\n```\n"
        self.assertEqual(SUPPORT.consultation_from_report(report, "blocked")["status"], "requested")
        self.assertEqual(SUPPORT.consultation_from_report(report, "complete")["status"], "invalid")
        value = json.loads(packet)
        value["verified"] = True
        with self.assertRaisesRegex(SUPPORT.ContractError, "unknown consultation fields"):
            SUPPORT.validate_consultation(value)

    def test_long_consultation_is_validated_before_display_truncation(self):
        packet = COORDINATOR.read(self.packet)
        packet["observations"] = ["trace " * 1200]
        report = (
            "### STATUS\nBLOCKED\n### FILES CHANGED\nnone\n### COMMANDS RUN\nnone\n### VERIFICATION\nnone\n### RISKS OR BLOCKERS\n```consultation-request\n"
            + json.dumps(packet)
            + "\n```\n"
        )
        raw, extracted = RUNNER.extract_raw_final_report(report)
        self.assertEqual(RUNNER.report_contract_violations(raw, extracted), [])
        self.assertEqual(
            SUPPORT.consultation_from_report(raw, "blocked")["request"]["question"],
            "Does cancellation prevent the callback?",
        )
        self.assertLessEqual(len(RUNNER.bound_final_message(raw)), 4000)

    def test_model_capability_tier_and_upward_delegation(self):
        self.assertEqual(SUPPORT.model_capability_tier("haiku"), 1)
        self.assertEqual(SUPPORT.model_capability_tier("claude-haiku-4-5"), 1)
        self.assertEqual(SUPPORT.model_capability_tier("gpt-6-luna"), 1)
        self.assertEqual(SUPPORT.model_capability_tier("gemini-3.8-flash-medium"), 1)
        self.assertEqual(SUPPORT.model_capability_tier("sonnet"), 2)
        self.assertEqual(SUPPORT.model_capability_tier("claude-sonnet-4-6"), 2)
        self.assertEqual(SUPPORT.model_capability_tier("gpt-5.6-terra"), 2)
        self.assertEqual(SUPPORT.model_capability_tier("opus"), 3)
        self.assertEqual(SUPPORT.model_capability_tier("gpt-6-sol"), 3)
        self.assertEqual(SUPPORT.model_capability_tier("gemini-3.1-pro-high"), 3)
        self.assertEqual(SUPPORT.model_capability_tier("gemini-4-argon-high"), 3)
        self.assertEqual(SUPPORT.model_capability_tier("gpt-6-astra"), 4)
        self.assertEqual(SUPPORT.model_capability_tier("fable"), 4)

        self.assertTrue(SUPPORT.is_upward_delegation("haiku", "sonnet"))
        self.assertTrue(SUPPORT.is_upward_delegation("sonnet", "gpt-6-astra"))
        self.assertTrue(SUPPORT.is_upward_delegation("claude-sonnet-4-6", "opus"))
        self.assertTrue(SUPPORT.is_upward_delegation("sonnet", "gemini-4-argon-high"))
        self.assertFalse(SUPPORT.is_upward_delegation("gpt-6-astra", "sonnet"))
        self.assertFalse(SUPPORT.is_upward_delegation("gpt-6-astra", "gpt-6-astra"))
        self.assertFalse(SUPPORT.is_upward_delegation(None, "gpt-6-astra"))

    def test_coordinator_dispatch_widens_scope_on_upward_delegation(self):
        with mock.patch.dict(
            os.environ,
            {
                "FAKE_OUTPUT": "outside/unplanned.py",
                "FAKE_AGY_MODELS": "gemini-4-argon-high\tGemini 4 Argon (High)",
            },
        ):
            code, run = self.call(
                "dispatch",
                "--kind",
                "implementation",
                "--request-id",
                "upward-impl",
                "--engine",
                "agy",
                "--model",
                "gemini-4-argon-high",
                "--conductor-model",
                "sonnet",
            )
        self.assertEqual(code, 0, run)
        self.assertEqual(run["runner_status"], "completed")
        self.assertEqual(run["scope_owner"], "worker")
        self.assertEqual(run["conductor_model"], "sonnet")
        result = json.loads(Path(run["result_path"]).read_text(encoding="utf-8"))
        self.assertEqual(result["allowed_paths"], ["."])
        self.assertEqual(result["scope_owner"], "worker")
        self.assertEqual(result["scope_hints"], ["allowed"])
        self.assertEqual(result["scope_violations"], [])

    def test_dispatch_without_timeout_keeps_the_runner_default(self):
        code, run = self.start()
        self.assertEqual(code, 0, run)
        self.assertNotIn("--timeout", run["command"])
        self.assertNotIn("timeout", COORDINATOR.load(self.directory)["runs"][0])

    def test_dispatch_timeout_reaches_the_runner_when_the_task_budget_allows_it(self):
        # 90m exceeds the default 1h deadline, so the task needs a longer --time-budget first.
        self.directory = self.fixture.external_path / "long-task"
        init = ("init", "--task-spec", str(self.spec_path), "--host", "claude", "--time-budget")
        code, error = self.call(*init, "soon")
        self.assertEqual(code, 2)
        self.assertIn("invalid --time-budget", error)
        self.assertEqual(self.call(*init, "2h")[0], 0)
        with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
            code, run = self.call(
                "dispatch",
                "--kind",
                "investigation",
                "--request-id",
                "long-read",
                "--engine",
                "agy",
                "--model",
                "gemini-3.8-flash-medium",
                "--timeout",
                "90m",
            )
        self.assertEqual(code, 0, run)
        self.assertEqual((run["runner_status"], run["timeout"]), ("completed", "90m"))
        self.assertEqual(run["command"][run["command"].index("--timeout") + 1], "90m")
        argv = json.loads((self.fixture.external_path / "capture.json").read_text())["argv"]
        self.assertEqual(argv[argv.index("--print-timeout") + 1], "5490s")

    def test_timeout_is_validated_and_refused_beyond_the_task_deadline(self):
        before = COORDINATOR.load(self.directory)
        for value, message in (
            ("soon", "invalid --timeout"),
            ("0m", "invalid --timeout"),
            ("2h", "--timeout 2h exceeds the task's remaining"),
        ):
            code, error = self.start("timed", "implementation", "--timeout", value)
            self.assertEqual(code, 2)
            self.assertIn(message, error)
        code, error = self.call(
            "dispatch",
            "--kind",
            "implementation",
            "--request-id",
            "native-timed",
            "--transport",
            "native",
            "--engine",
            "claude",
            "--model",
            "claude-sonnet-5",
            "--timeout",
            "25m",
        )
        self.assertEqual(code, 2)
        self.assertIn("a native run ends at the task deadline", error)
        after = COORDINATOR.load(self.directory)
        self.assertEqual((after["runs"], after["budget"]), ([], before["budget"]))
        self.assertFalse((self.directory / "runs").exists())

    def test_correction_inherits_the_timeout_only_while_it_fits_the_deadline(self):
        with mock.patch.dict(os.environ, {"FAKE_REPORT_STATUS": "BLOCKED"}):
            code, blocked = self.start("implement", "implementation", "--timeout", "25m")
        self.assertEqual((code, blocked["runner_status"], blocked["timeout"]), (0, "blocked", "25m"))
        proof = self.reviewed_evidence()
        state = COORDINATOR.load(self.directory)
        deadline = state["deadline"]
        state["deadline"] = (dt.datetime.now(dt.UTC) + dt.timedelta(minutes=10)).isoformat()
        COORDINATOR.save(self.directory, state)
        correction = ("dispatch", "--kind", "correction", "--request-id", "repair", "--review-id", proof)
        code, error = self.call(*correction)
        self.assertEqual(code, 2)
        self.assertIn("inherited --timeout 25m exceeds the task's remaining", error)
        state = COORDINATOR.load(self.directory)
        state["deadline"] = deadline
        COORDINATOR.save(self.directory, state)
        with mock.patch.dict(os.environ, {"FAKE_CONTENT": "corrected output\n"}):
            code, corrected = self.call(*correction)
        self.assertEqual((code, corrected["runner_status"], corrected["timeout"]), (0, "completed", "25m"))
        self.assertEqual(corrected["command"][corrected["command"].index("--timeout") + 1], "25m")

    def test_correction_can_replace_the_inherited_timeout(self):
        with mock.patch.dict(os.environ, {"FAKE_REPORT_STATUS": "BLOCKED"}):
            code, blocked = self.start("implement", "implementation", "--timeout", "25m")
        self.assertEqual(code, 0, blocked)
        proof = self.reviewed_evidence()
        state = COORDINATOR.load(self.directory)
        state["deadline"] = (dt.datetime.now(dt.UTC) + dt.timedelta(minutes=10)).isoformat()
        COORDINATOR.save(self.directory, state)
        with mock.patch.dict(os.environ, {"FAKE_CONTENT": "corrected output\n"}):
            code, corrected = self.call(
                "dispatch", "--kind", "correction", "--request-id", "repair", "--review-id", proof, "--timeout", "5m"
            )
        self.assertEqual((code, corrected["runner_status"], corrected["timeout"]), (0, "completed", "5m"))
        self.assertEqual(corrected["command"][corrected["command"].index("--timeout") + 1], "5m")

    def test_auto_correct_rounds_run_before_the_report_and_keep_the_correction_allowance(self):
        gate = "grep -q fixed allowed/output.txt"
        # Implementation: fails, then its round fixes it. Correction: fails again, then its own round fixes it.
        contents = ["broken\n", "fixed\n", "broken again\n", "fixed at last\n"]
        rounds = {
            "FAKE_ROUNDS": json.dumps([{"FAKE_CONTENT": content} for content in contents]),
            "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / "rounds.txt"),
        }
        with mock.patch.dict(os.environ, rounds):
            code, run = self.start("implement", "implementation", "--verify-command", gate, "--auto-correct", "1")
        self.assertEqual((code, run["runner_status"], run["auto_correct"]), (0, "completed", 1), run)
        self.assertEqual(run["command"][run["command"].index("--auto-correct") + 1], "1")
        result = COORDINATOR.read(Path(run["result_path"]))
        self.assertEqual((result["auto_correct"]["outcome"], result["auto_correct"]["rounds_used"]), ("passed", 1))
        state = COORDINATOR.load(self.directory)
        self.assertEqual((len(state["runs"]), state["budget"]["used"]), (1, 1))
        # The rounds were not a correction: the one correction is still available, and it inherits them.
        proof = self.reviewed_evidence()
        with mock.patch.dict(os.environ, rounds):
            code, corrected = self.call(
                "dispatch", "--kind", "correction", "--request-id", "repair", "--review-id", proof
            )
        self.assertEqual((code, corrected["runner_status"], corrected["auto_correct"]), (0, "completed", 1), corrected)
        self.assertEqual(corrected["command"][corrected["command"].index("--auto-correct") + 1], "1")
        rounds_run = COORDINATOR.read(Path(corrected["result_path"]))["auto_correct"]
        self.assertEqual((rounds_run["outcome"], rounds_run["rounds_used"]), ("passed", 1))
        self.assertIn("AUTO-CORRECT ROUND 1 OF 1", rounds_run["rounds"][0]["prompt"])
        self.assertEqual((self.fixture.repository.path / "allowed/output.txt").read_text(), "fixed at last\n")
        self.assertEqual(COORDINATOR.load(self.directory)["budget"]["used"], 2)

    def test_an_explicit_zero_is_recorded_and_a_correction_inherits_it(self):
        state = COORDINATOR.load(self.directory)
        state["task_spec"]["auto_correct"] = 2
        COORDINATOR.save(self.directory, state)
        gate = "grep -qx fixed allowed/output.txt"
        counter = self.fixture.external_path / "rounds.txt"
        rounds = {
            "FAKE_ROUNDS": json.dumps([{"FAKE_CONTENT": "broken\n"}, {"FAKE_CONTENT": "broken again\n"}]),
            "FAKE_ROUNDS_COUNT": str(counter),
        }
        with mock.patch.dict(os.environ, rounds):
            code, run = self.start("implement", "implementation", "--verify-command", gate, "--auto-correct", "0")
        self.assertEqual((code, run["runner_status"], run["auto_correct"]), (0, "verification_failed", 0), run)
        self.assertNotIn("auto_correct", COORDINATOR.read(Path(run["result_path"])))
        proof = self.reviewed_evidence()
        with mock.patch.dict(os.environ, rounds):
            code, corrected = self.call(
                "dispatch", "--kind", "correction", "--request-id", "repair", "--review-id", proof
            )
        self.assertEqual((code, corrected["runner_status"], corrected["auto_correct"]), (0, "verification_failed", 0))
        self.assertEqual(corrected["command"][corrected["command"].index("--auto-correct") + 1], "0")
        self.assertNotIn("auto_correct", COORDINATOR.read(Path(corrected["result_path"])))
        # One executor turn each: the spec's 2 rounds never applied.
        self.assertEqual(counter.read_text(), "2")

    def test_reverify_keeps_the_implementation_auto_correct_opt_out_for_correction(self):
        state = COORDINATOR.load(self.directory)
        state["task_spec"]["auto_correct"] = 2
        COORDINATOR.save(self.directory, state)
        gate = "grep -qx fixed allowed/output.txt"
        implementation_counter = self.fixture.external_path / "reverify-implementation-rounds.txt"
        implementation_env = {
            "FAKE_ROUNDS": json.dumps([{"FAKE_CONTENT": "broken\n"}]),
            "FAKE_ROUNDS_COUNT": str(implementation_counter),
        }
        with mock.patch.dict(os.environ, implementation_env):
            code, failed = self.start(
                "reverify-work", "implementation", "--verify-command", gate, "--auto-correct", "0"
            )
        self.assertEqual((code, failed["runner_status"], failed["auto_correct"]), (0, "verification_failed", 0))
        code, checked = self.call(
            "reverify", "--run-id", failed["run_id"], "--request-id", "recheck", "--reason", "repeat the gate"
        )
        self.assertEqual((code, checked["runner_status"]), (0, "verification_failed"))

        proof = self.reviewed_evidence()
        correction_counter = self.fixture.external_path / "reverify-correction-rounds.txt"
        correction_env = {
            "FAKE_ROUNDS": json.dumps([{"FAKE_CONTENT": "still broken\n"}]),
            "FAKE_ROUNDS_COUNT": str(correction_counter),
        }
        with mock.patch.dict(os.environ, correction_env):
            code, corrected = self.call(
                "dispatch", "--kind", "correction", "--request-id", "reverify-repair", "--review-id", proof
            )
        self.assertEqual((code, corrected["runner_status"], corrected["auto_correct"]), (0, "verification_failed", 0))
        self.assertEqual(corrected["command"][corrected["command"].index("--auto-correct") + 1], "0")
        self.assertEqual(correction_counter.read_text(), "1")

    def test_resumed_correction_does_not_protect_a_deliverable_created_by_implementation(self):
        state = COORDINATOR.load(self.directory)
        state["task_spec"]["allow_paths"] = ["dist"]
        COORDINATOR.save(self.directory, state)
        gate = "grep -qx fixed dist/bundle.js"
        implementation_counter = self.fixture.external_path / "deliverable-implementation-rounds.txt"
        implementation_env = {
            "FAKE_ROUNDS": json.dumps(
                [
                    {"FAKE_OUTPUT": "dist/bundle.js", "FAKE_CONTENT": "broken\n"},
                    {"FAKE_OUTPUT": "dist/helper.js", "FAKE_CONTENT": "helper\n"},
                ]
            ),
            "FAKE_ROUNDS_COUNT": str(implementation_counter),
        }
        with mock.patch.dict(os.environ, implementation_env):
            code, failed = self.start(
                "deliverable-work", "implementation", "--verify-command", gate, "--auto-correct", "1"
            )
        self.assertEqual((code, failed["runner_status"]), (0, "verification_failed"), failed)
        self.assertTrue((self.fixture.repository.path / "dist/bundle.js").is_file())

        proof = self.reviewed_evidence()
        correction_counter = self.fixture.external_path / "deliverable-correction-rounds.txt"
        correction_env = {
            "FAKE_ROUNDS": json.dumps(
                [
                    {"FAKE_OUTPUT": "dist/helper.js", "FAKE_CONTENT": "helper fixed\n"},
                    {"FAKE_OUTPUT": "dist/bundle.js", "FAKE_CONTENT": "fixed\n"},
                ]
            ),
            "FAKE_ROUNDS_COUNT": str(correction_counter),
        }
        with mock.patch.dict(os.environ, correction_env):
            code, corrected = self.call(
                "dispatch", "--kind", "correction", "--request-id", "deliverable-repair", "--review-id", proof
            )
        self.assertEqual((code, corrected["runner_status"]), (0, "completed"), corrected)
        result = COORDINATOR.read(Path(corrected["result_path"]))
        self.assertEqual(result["auto_correct"]["rounds"][0]["gate_files"], [])
        self.assertEqual(result["scope_violations"], [])

    def test_a_correction_keeps_rounds_taken_from_the_task_spec(self):
        state = COORDINATOR.load(self.directory)
        state["task_spec"]["auto_correct"] = 1
        COORDINATOR.save(self.directory, state)
        gate = "grep -qx fixed allowed/output.txt"
        broken = {
            "FAKE_ROUNDS": json.dumps([{"FAKE_CONTENT": "broken\n"}]),
            "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / "spec-work-rounds.txt"),
        }
        with mock.patch.dict(os.environ, broken):
            code, failed = self.start("spec-work", "implementation", "--verify-command", gate)
        self.assertEqual((code, failed["runner_status"]), (0, "verification_failed"), failed)
        self.assertNotIn("--auto-correct", failed["command"])
        proof = self.reviewed_evidence()
        fixed = {
            "FAKE_ROUNDS": json.dumps([{"FAKE_CONTENT": "fixed\n"}]),
            "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / "spec-repair-rounds.txt"),
        }
        with mock.patch.dict(os.environ, fixed):
            code, corrected = self.call(
                "dispatch", "--kind", "correction", "--request-id", "spec-repair", "--review-id", proof
            )
        self.assertEqual((code, corrected["runner_status"]), (0, "completed"), corrected)
        self.assertNotIn("--auto-correct", corrected["command"])
        self.assertEqual(COORDINATOR.read(Path(corrected["result_path"]))["auto_correct"]["source"], "task_spec")

    def test_a_correction_after_a_converted_round_need_not_change_files(self):
        gate = "grep -qx fixed allowed/output.txt"
        # Round 0 fails the gate; round 1 fixes the output but returns a malformed report.
        rounds = {
            "FAKE_ROUNDS": json.dumps(
                [{"FAKE_CONTENT": "broken\n"}, {"FAKE_CONTENT": "fixed\n", "FAKE_REPORT_TEXT": "done"}]
            ),
            "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / "converted-rounds.txt"),
        }
        with mock.patch.dict(os.environ, rounds):
            code, failed = self.start(
                "converted-work", "implementation", "--verify-command", gate, "--auto-correct", "1"
            )
        self.assertEqual((code, failed["runner_status"]), (0, "verification_failed"), failed)
        self.assertEqual(
            COORDINATOR.read(Path(failed["result_path"]))["auto_correct"]["converted_from"], "malformed_report"
        )
        proof = self.reviewed_evidence()
        with mock.patch.dict(os.environ, {"FAKE_NO_CHANGE": "1"}):
            code, corrected = self.call(
                "dispatch", "--kind", "correction", "--request-id", "converted-repair", "--review-id", proof
            )
        # Changes are still required, of the task as a whole: the converted round's fix counts.
        self.assertIn("--expect-changes", corrected["command"])
        self.assertIn("--expect-task-changes", corrected["command"])
        self.assertEqual((code, corrected["runner_status"]), (0, "completed"), corrected)
        result = COORDINATOR.read(Path(corrected["result_path"]))
        self.assertEqual(result["task_git_before"], COORDINATOR.read(Path(failed["result_path"]))["git_before"])
        self.assertEqual((result["workspace_changed"], result["task_workspace_changed"]), (False, True))

    def undo_on_resume(self):
        """Make the fake codex delete allowed/broken.txt at the start of every resumed turn."""
        fake = self.fixture.external_path / "codex"
        fake.rename(self.fixture.external_path / "codex-real")
        fake.write_text(
            "#!/bin/sh\n"
            'if [ "$1" = exec ] && [ "$2" = resume ]; then rm -f allowed/broken.txt; fi\n'
            'exec "$(dirname "$0")/codex-real" "$@"\n'
        )
        fake.chmod(0o700)

    def test_a_correction_that_leaves_the_task_unchanged_ends_no_changes(self):
        # Argon N4: the work is undone, by a converted round or by the correction itself, and the
        # correction adds nothing. Judged against where the implementation began, nothing changed.
        gate = "test ! -f allowed/broken.txt"
        wip = {"FAKE_OUTPUT": "allowed/broken.txt", "FAKE_CONTENT": "wip\n"}
        cases = (
            (
                "a converted round undid it",
                [wip, {"FAKE_NO_CHANGE": "1", "FAKE_MALFORMED": "1"}, {"FAKE_NO_CHANGE": "1"}],
                1,
            ),
            ("the correction undid it", [wip, {"FAKE_NO_CHANGE": "1"}], 0),
        )
        for name, contents, rounds in cases:
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                self.undo_on_resume()
                environment = {
                    "FAKE_ROUNDS": json.dumps(contents),
                    "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / "undo-rounds.txt"),
                }
                with mock.patch.dict(os.environ, environment):
                    code, failed = self.start(
                        "undo-work", "implementation", "--verify-command", gate, "--auto-correct", str(rounds)
                    )
                    self.assertEqual((code, failed["runner_status"]), (0, "verification_failed"), failed)
                    proof = self.reviewed_evidence()
                    code, corrected = self.call(
                        "dispatch", "--kind", "correction", "--request-id", "undo-repair", "--review-id", proof
                    )
                self.assertEqual((code, corrected["runner_status"]), (0, "no_changes"), corrected)
                result = COORDINATOR.read(Path(corrected["result_path"]))
                self.assertEqual((result["exit_code"], result["task_workspace_changed"]), (20, False))
                code, error = self.call(
                    "review",
                    "--run-id",
                    corrected["run_id"],
                    "--decision",
                    "accept",
                    "--review-id",
                    self.reviewed_evidence(),
                )
                self.assertEqual(code, 2)
                self.assertIn("only a completed, audited run", error)

    def test_a_no_op_correction_after_a_converted_round_without_a_fix_still_runs_and_fails_the_gates(self):
        gate = "grep -qx fixed allowed/output.txt"
        environment = {
            "FAKE_ROUNDS": json.dumps(
                [{"FAKE_CONTENT": "broken\n"}, {"FAKE_NO_CHANGE": "1", "FAKE_MALFORMED": "1"}, {"FAKE_NO_CHANGE": "1"}]
            ),
            "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / "no-op-rounds.txt"),
        }
        with mock.patch.dict(os.environ, environment):
            code, failed = self.start("no-op-work", "implementation", "--verify-command", gate, "--auto-correct", "1")
            self.assertEqual((code, failed["runner_status"]), (0, "verification_failed"), failed)
            proof = self.reviewed_evidence()
            code, corrected = self.call(
                "dispatch",
                "--kind",
                "correction",
                "--request-id",
                "no-op-repair",
                "--review-id",
                proof,
                "--auto-correct",
                "0",
            )
        # The task changed (the broken output), so the turn is judged by its gates, which still fail.
        self.assertIn("--expect-task-changes", corrected["command"])
        self.assertEqual((code, corrected["runner_status"]), (0, "verification_failed"), corrected)

    def test_protect_paths_reach_the_runner_and_a_correction_inherits_them(self):
        self.fixture.repository.write("allowed/expected.txt", "fixed\n")
        self.fixture.repository.git("add", "allowed/expected.txt")
        self.fixture.repository.git("commit", "-qm", "expected output")
        gate = "cmp -s allowed/expected.txt allowed/output.txt"
        broken = {"FAKE_CONTENT": "broken\n"}
        weaken = {"FAKE_OUTPUT": "allowed/expected.txt", "FAKE_CONTENT": "broken\n"}
        environment = {
            "FAKE_ROUNDS": json.dumps([broken, broken, broken, weaken]),
            "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / "protect-rounds.txt"),
        }
        with mock.patch.dict(os.environ, environment):
            code, failed = self.start(
                "protect-work",
                "implementation",
                "--verify-command",
                gate,
                "--auto-correct",
                "1",
                "--protect-path",
                "allowed/expected.txt/",
            )
            self.assertEqual(
                (code, failed["runner_status"], failed["protect_paths"]),
                (0, "verification_failed", ["allowed/expected.txt"]),
            )
            spec = COORDINATOR.read(Path(failed["result_path"]).parent.parent / "task-spec.json")
            self.assertEqual(spec["protect_paths"], ["allowed/expected.txt"])
            record = COORDINATOR.read(Path(failed["result_path"]))["auto_correct"]
            self.assertEqual(
                (record["protect_paths"], record["rounds"][0]["gate_files"]), (["allowed/expected.txt"],) * 2
            )
            proof = self.reviewed_evidence()
            code, corrected = self.call(
                "dispatch", "--kind", "correction", "--request-id", "protect-repair", "--review-id", proof
            )
        self.assertEqual((code, corrected["protect_paths"]), (0, ["allowed/expected.txt"]), corrected)
        self.assertEqual(corrected["runner_status"], "scope_violation")
        self.assertEqual(
            COORDINATOR.read(Path(corrected["result_path"]))["scope_violations"], ["gate-edit:allowed/expected.txt"]
        )
        self.tearDown()
        self.setUp()
        code, error = self.start("bad-protect", "implementation", "--protect-path", "../outside")
        self.assertEqual(code, 2)
        self.assertIn("repository-relative", error)
        code, error = self.start("explore", "investigation", "--protect-path", "allowed/expected.txt")
        self.assertEqual(code, 2)
        self.assertIn("read-only dispatches have no auto-correct rounds", error)

    def test_auto_correct_is_validated_and_needs_gates(self):
        for extra, message in (
            (("--verify-command", "exit 0", "--auto-correct", "3"), "from 0 to 2"),
            (("--auto-correct", "1"), "requires --verify-command"),
        ):
            code, error = self.start("work", "implementation", *extra)
            self.assertEqual(code, 2)
            self.assertIn(message, error)
        code, error = self.start("explore", "investigation", "--auto-correct", "1")
        self.assertEqual(code, 2)
        self.assertIn("no verification gates to auto-correct", error)
        code, error = self.start("explore-zero", "investigation", "--auto-correct", "0")
        self.assertEqual(code, 2)
        self.assertIn("no verification gates to auto-correct", error)
        self.assertEqual(COORDINATOR.load(self.directory)["runs"], [])
        # The spec's rounds are a default for work with gates, inert without them.
        state = COORDINATOR.load(self.directory)
        state["task_spec"]["auto_correct"] = 2
        COORDINATOR.save(self.directory, state)
        code, run = self.start("work", "implementation")
        self.assertEqual((code, run["runner_status"]), (0, "completed"), run)
        self.assertNotIn("auto_correct", run)
        self.assertNotIn("--auto-correct", run["command"])
        self.assertNotIn("auto_correct", COORDINATOR.read(Path(run["result_path"])))

    def test_reverify_refuses_a_run_whose_last_round_broke_down(self):
        gate = "grep -q fixed allowed/output.txt"
        rounds = {
            "FAKE_ROUNDS": json.dumps(
                [
                    {"FAKE_CONTENT": "broken\n"},
                    {"FAKE_CONTENT": "fixed\n", "FAKE_REPORT_STATUS": "FAILED"},
                    {"FAKE_CONTENT": "fixed again\n"},
                ]
            ),
            "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / "rounds.txt"),
        }
        with mock.patch.dict(os.environ, rounds):
            code, run = self.start("implement", "implementation", "--verify-command", gate, "--auto-correct", "1")
        self.assertEqual((code, run["runner_status"]), (0, "verification_failed"), run)
        self.assertEqual(COORDINATOR.read(Path(run["result_path"]))["auto_correct"]["converted_from"], "failed")
        # The report and gate results predate the failed round's change, so a recheck cannot judge the work.
        code, error = self.call("reverify", "--run-id", run["run_id"], "--request-id", "check-1", "--reason", "recheck")
        self.assertEqual(code, 2)
        self.assertIn("dispatch the bounded correction", error)
        proof = self.reviewed_evidence()
        with mock.patch.dict(os.environ, rounds):
            code, corrected = self.call(
                "dispatch", "--kind", "correction", "--request-id", "repair", "--review-id", proof
            )
        self.assertEqual((code, corrected["runner_status"]), (0, "completed"), corrected)

    def test_a_round_that_undoes_all_work_ends_no_changes_and_cannot_be_rechecked(self):
        fake = self.fixture.external_path / "codex"
        fake.rename(self.fixture.external_path / "codex-real")
        fake.write_text(
            "#!/bin/sh\n"
            '"$(dirname "$0")/codex-real" "$@"; status=$?\n'
            'if [ "$1" = exec ] && [ "$2" = resume ]; then rm -rf allowed; fi\n'
            'exit "$status"\n'
        )
        fake.chmod(0o700)
        rounds = {
            "FAKE_ROUNDS": json.dumps([{"FAKE_CONTENT": "broken\n"}, {"FAKE_NO_CHANGE": "1"}]),
            "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / "rounds.txt"),
        }
        gate = "! grep -q broken allowed/output.txt 2>/dev/null"
        with mock.patch.dict(os.environ, rounds):
            code, run = self.start("implement", "implementation", "--verify-command", gate, "--auto-correct", "1")
        self.assertEqual((code, run["runner_status"]), (0, "no_changes"), run)
        result = COORDINATOR.read(Path(run["result_path"]))
        self.assertEqual((result["exit_code"], result["run_delta"]["changed_paths"]), (20, []))
        code, error = self.call("reverify", "--run-id", run["run_id"], "--request-id", "check-1", "--reason", "recheck")
        self.assertEqual(code, 2)
        self.assertIn("cannot repair a failed executor report", error)

    def test_native_auto_correct_returns_the_failed_gate_as_the_suggested_correction(self):
        gate = "grep -qx fixed allowed/output.txt"
        code, run = self.call(
            "dispatch",
            "--kind",
            "implementation",
            "--request-id",
            "native-1",
            "--transport",
            "native",
            "--engine",
            "claude",
            "--model",
            "claude-sonnet-5",
            "--verify-command",
            gate,
            "--auto-correct",
            "2",
        )
        self.assertEqual((code, run["auto_correct"]), (0, 2), run)
        packet = self.fixture.external_path / "native.json"
        try:
            packet.write_text(json.dumps({"native_handle": "native-test-session"}))
            self.assertEqual(self.call("native-attach", "--run-id", run["run_id"], "--packet", str(packet))[0], 0)
            (self.fixture.repository.path / "allowed").mkdir(exist_ok=True)
            (self.fixture.repository.path / "allowed/output.txt").write_text("broken\n")
            report = self.fixture.external_path / "native-report.txt"
            report.write_text(
                "### STATUS\nCOMPLETE\n### FILES CHANGED\nallowed/output.txt\n### COMMANDS RUN\nnone\n"
                "### VERIFICATION\nHost will check output.\n### RISKS OR BLOCKERS\nnone\n"
            )
            packet.write_text(
                json.dumps(
                    {
                        "native_handle": "native-test-session",
                        "event_id": "native-completion-1",
                        "terminal": True,
                        "tool_status": "completed",
                        "report_path": str(report),
                    }
                )
            )
            code, finished = self.call("native-complete", "--run-id", run["run_id"], "--packet", str(packet))
            self.assertEqual((code, finished["runner_status"]), (0, "verification_failed"), finished)
            suggestion = finished["suggested_correction"]
            self.assertIn(f"Gate 1 of 1 failed with exit code 1:\n\n    {gate}", suggestion)
            self.assertIn("Fix exactly these problems; change nothing else.", suggestion)
            result = COORDINATOR.read(Path(finished["result_path"]))
            self.assertEqual(
                {key: result["auto_correct"][key] for key in ("mode", "rounds_used", "outcome")},
                {"mode": "native", "rounds_used": 0, "outcome": "handed_to_host"},
            )
            self.assertEqual(result["auto_correct"]["suggested_correction"], suggestion)
            self.assertEqual(COORDINATOR.load(self.directory)["budget"]["used"], 1)
        finally:
            if COORDINATOR.NATIVE.process_state(run) == "active":
                os.kill(run["pid"], 15)

    def native_round(self, run, name, edits, files_changed, handle=None, remove=()):
        """Attach a native run, apply the worker's edits, and complete it with a COMPLETE report."""
        handle = handle or f"{name}-session"
        packet = self.fixture.external_path / f"{name}.json"
        packet.write_text(json.dumps({"native_handle": handle}))
        self.assertEqual(self.call("native-attach", "--run-id", run["run_id"], "--packet", str(packet))[0], 0)
        for relative, content in edits.items():
            target = self.fixture.repository.path / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        for relative in remove:
            (self.fixture.repository.path / relative).unlink()
        report = self.fixture.external_path / f"{name}-report.txt"
        report.write_text(
            f"### STATUS\nCOMPLETE\n### FILES CHANGED\n{files_changed}\n### COMMANDS RUN\nnone\n"
            "### VERIFICATION\nHost will check output.\n### RISKS OR BLOCKERS\nnone\n"
        )
        packet.write_text(
            json.dumps(
                {
                    "native_handle": handle,
                    "event_id": f"{name}-completion",
                    "terminal": True,
                    "tool_status": "completed",
                    "report_path": str(report),
                }
            )
        )
        return self.call("native-complete", "--run-id", run["run_id"], "--packet", str(packet))

    def test_native_initial_run_may_change_the_gate_scripts_it_runs(self):
        # The first handoff's edits are the work under test, as on the executor path.
        script = self.fixture.repository.path / "allowed/check.sh"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text("exit 1\n")
        self.fixture.repository.git("add", "allowed/check.sh")
        self.fixture.repository.git("commit", "-qm", "gate script")
        code, run = self.call(
            "dispatch",
            "--kind",
            "implementation",
            "--request-id",
            "native-initial",
            "--transport",
            "native",
            "--engine",
            "claude",
            "--model",
            "claude-sonnet-5",
            "--verify-command",
            "sh allowed/check.sh",
            "--auto-correct",
            "1",
        )
        self.assertEqual(code, 0, run)
        try:
            code, finished = self.native_round(
                run, "native-initial", {"allowed/check.sh": "exit 0\n"}, "allowed/check.sh"
            )
            self.assertEqual((code, finished["runner_status"]), (0, "completed"), finished)
            result = COORDINATOR.read(Path(finished["result_path"]))
            self.assertEqual(result["scope_violations"], [])
            self.assertEqual(result["auto_correct"]["gate_candidates"], ["allowed/check.sh"])
        finally:
            if COORDINATOR.NATIVE.process_state(run) == "active":
                os.kill(run["pid"], 15)

    def test_native_correction_rejects_a_gate_edit_before_running_the_gate(self):
        state = COORDINATOR.load(self.directory)
        state["task_spec"]["allow_paths"] = ["."]
        COORDINATOR.save(self.directory, state)
        gate_path = self.fixture.repository.path / "allowed/check.sh"
        gate_path.parent.mkdir(parents=True, exist_ok=True)
        gate_path.write_text("grep -qx fixed allowed/output.txt\n")
        self.fixture.repository.git("add", "allowed/check.sh")
        self.fixture.repository.git("commit", "-qm", "native gate")
        marker = self.fixture.external_path / "tampered-gate-ran"
        code, run = self.call(
            "dispatch",
            "--kind",
            "implementation",
            "--request-id",
            "native-gate-work",
            "--transport",
            "native",
            "--engine",
            "claude",
            "--model",
            "claude-sonnet-5",
            "--verify-command",
            "sh allowed/check.sh",
            "--auto-correct",
            "1",
        )
        self.assertEqual((code, run["auto_correct"]), (0, 1), run)
        correction = None
        try:
            code, finished = self.native_round(
                run, "native-gate-work", {"allowed/output.txt": "broken\n"}, "allowed/output.txt"
            )
            self.assertEqual((code, finished["runner_status"]), (0, "verification_failed"), finished)
            proof = self.reviewed_evidence()
            code, correction = self.call(
                "dispatch",
                "--kind",
                "correction",
                "--request-id",
                "native-gate-repair",
                "--review-id",
                proof,
                "--transport",
                "native",
            )
            self.assertEqual(code, 0, correction)
            # The worker "fixes" the gate instead of the output; the tampered gate would leave a marker.
            tampered = f"touch {marker}\nexit 0\n"
            code, repaired = self.native_round(
                correction,
                "native-gate-repair",
                {"allowed/check.sh": tampered},
                "allowed/check.sh",
                handle="native-gate-work-session",
            )
            self.assertEqual((code, repaired["runner_status"]), (0, "scope_violation"), repaired)
            result = COORDINATOR.read(Path(repaired["result_path"]))
            self.assertEqual(result["scope_violations"], ["gate-edit:allowed/check.sh"])
            self.assertEqual(result["verification"]["status"], "skipped")
            self.assertFalse(marker.exists(), "a changed gate program must never run")
        finally:
            for active in (run, correction):
                if active and active.get("pid") and COORDINATOR.NATIVE.process_state(active) == "active":
                    os.kill(active["pid"], 15)

    def native_dispatch(self, request, *extra):
        return self.call(
            "dispatch",
            "--kind",
            "implementation",
            "--request-id",
            request,
            "--transport",
            "native",
            "--engine",
            "claude",
            "--model",
            "claude-sonnet-5",
            "--verify-command",
            "grep -qx fixed allowed/output.txt",
            "--auto-correct",
            "1",
            *extra,
        )

    def native_correction(self, request):
        proof = self.reviewed_evidence()
        return self.call(
            "dispatch", "--kind", "correction", "--request-id", request, "--review-id", proof, "--transport", "native"
        )

    def test_native_correction_keeps_protect_paths_and_is_judged_with_its_implementation(self):
        for index, (name, edits, remove, status) in enumerate(
            (
                # Editing a listed file fails the correction before any gate runs.
                ("protected", {"allowed/expected.txt": "broken\n"}, (), "scope_violation"),
                # Undoing the implementation's work leaves the task unchanged.
                ("undone", {}, ("allowed/output.txt",), "no_changes"),
            )
        ):
            with self.subTest(name):
                if index:
                    self.tearDown()
                    self.setUp()
                self.fixture.repository.write("allowed/expected.txt", "fixed\n")
                self.fixture.repository.git("add", "allowed/expected.txt")
                self.fixture.repository.git("commit", "-qm", "expected output")
                run = correction = None
                try:
                    code, run = self.native_dispatch(f"native-{name}", "--protect-path", "allowed/expected.txt")
                    self.assertEqual(code, 0, run)
                    code, finished = self.native_round(
                        run, f"native-{name}", {"allowed/output.txt": "broken\n"}, "allowed/output.txt"
                    )
                    self.assertEqual((code, finished["runner_status"]), (0, "verification_failed"), finished)
                    suggestion = finished["suggested_correction"]
                    self.assertIn("Do not change the gate's own files: allowed/expected.txt.", suggestion)
                    self.assertIn(AUTO_CORRECT.BLOCKED_GUIDANCE, suggestion)
                    code, correction = self.native_correction(f"native-{name}-repair")
                    self.assertEqual((code, correction["protect_paths"]), (0, ["allowed/expected.txt"]), correction)
                    code, repaired = self.native_round(
                        correction,
                        f"native-{name}-repair",
                        edits,
                        "allowed/output.txt",
                        handle=f"native-{name}-session",
                        remove=remove,
                    )
                    self.assertEqual((code, repaired["runner_status"]), (0, status), repaired)
                    result = COORDINATOR.read(Path(repaired["result_path"]))
                    self.assertEqual(
                        result["task_git_before"], COORDINATOR.read(Path(finished["result_path"]))["git_before"]
                    )
                    if status == "scope_violation":
                        self.assertEqual(result["scope_violations"], ["gate-edit:allowed/expected.txt"])
                finally:
                    for active in (run, correction):
                        if active and active.get("pid") and COORDINATOR.NATIVE.process_state(active) == "active":
                            os.kill(active["pid"], 15)

    def test_background_completion_event_auto_settles_coordinator_task(self):
        code, run = self.start("bg-auto-settle", "implementation", "--background")
        self.assertEqual(code, 0, run)
        self.assertEqual(run["status"], "active")
        result_path = Path(run["result_path"])
        event_path = Path(run["event_path"])
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            state = COORDINATOR.load(self.directory)
            latest = state["runs"][-1]
            if latest["status"] == "finished" and event_path.is_file():
                break
            time.sleep(0.05)
        state = COORDINATOR.load(self.directory)
        latest = state["runs"][-1]
        self.assertTrue(result_path.is_file())
        self.assertTrue(event_path.is_file())
        self.assertEqual(latest["status"], "finished")
        self.assertEqual(latest["runner_status"], "completed")
        event_data = json.loads(event_path.read_text(encoding="utf-8"))
        self.assertEqual(event_data.get("task_dir"), str(self.directory.resolve()))

    def test_subagent_start_and_stop_hooks_register_and_complete_native_subagent(self):
        hooks = RUNNER.bundled_module("mailbox_hooks")
        base = self.fixture.external_path / "mailbox-subagents"
        parent_sid = "claude-lead-session-100"
        MAILBOX.register(
            base,
            session=parent_sid,
            harness="claude",
            cwd=str(self.fixture.repository.path),
            pid=os.getpid(),
        )
        start_out = hooks.hook(
            {
                "session_id": parent_sid,
                "cwd": str(self.fixture.repository.path),
                "hook_event_name": "SubagentStart",
                "agent_id": "agent_abc_123456",
                "agent_type": "Explore",
                "model": "claude-haiku-4-5",
            },
            harness="claude",
            event="SubagentStart",
            base=base,
        )
        self.assertEqual(start_out, {})
        sub_sid = "subagent-agent_abc_123456"
        sub_peer = MAILBOX.load(MAILBOX.peer_path(base, sub_sid))
        self.assertIsNotNone(sub_peer)
        self.assertTrue(sub_peer.get("isSubagent"))
        self.assertEqual(sub_peer.get("parentSession"), parent_sid)
        self.assertEqual(sub_peer.get("focus"), "native Explore")
        prog_path = base / "progress" / f"{MAILBOX.session_key(sub_sid)}.json"
        self.assertTrue(prog_path.is_file())
        prog_data = MAILBOX.load(prog_path)
        self.assertEqual(prog_data.get("stage"), "working")
        self.assertEqual(prog_data.get("goal"), "Native Explore")

        stop_out = hooks.hook(
            {
                "session_id": parent_sid,
                "cwd": str(self.fixture.repository.path),
                "hook_event_name": "SubagentStop",
                "agent_id": "agent_abc_123456",
                "agent_type": "Explore",
            },
            harness="claude",
            event="SubagentStop",
            base=base,
        )
        self.assertEqual(stop_out, {})
        prog_after = MAILBOX.load(prog_path)
        self.assertEqual(prog_after.get("stage"), "complete")
        sub_peer_after = MAILBOX.load(MAILBOX.peer_path(base, sub_sid))
        self.assertIsNone(sub_peer_after)


class CompletionEventConcurrencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "event.json"
        self.events = RUNNER.bundled_module("events_bus")

    def publish(self, notification_mode="desktop"):
        return self.events.publish_completion_event(
            result={"status": "completed", "repository": str(self.root)},
            result_path=self.root / "result.json",
            event_path=self.path,
            notification_mode=notification_mode,
            completion_hook=None,
        )

    def test_stale_and_repeated_acknowledgements_preserve_deliveries_and_first_timestamp(self):
        stale = None

        def notify(event):
            nonlocal stale
            stale = self.events.read_completion_event(self.path)
            # An external notifier can acquire the lock itself: publication released it.
            with Path(f"{self.path}.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(lock, fcntl.LOCK_UN)
            return {"kind": "desktop", "status": "sent"}

        with mock.patch.object(self.events, "send_desktop_notification", side_effect=notify):
            self.publish()
        with mock.patch.object(self.events, "_utc_now", return_value="first-ack"):
            self.events.acknowledge_completion_event(stale)
        with mock.patch.object(self.events, "_utc_now", return_value="later-ack"):
            self.events.acknowledge_completion_event(stale)
        current = self.events.read_completion_event(self.path)
        self.assertEqual(current["acknowledged_at"], "first-ack")
        self.assertEqual(current["deliveries"], [{"kind": "desktop", "status": "sent"}])

    def test_notification_result_write_serializes_with_acknowledgement(self):
        writing = threading.Event()
        release = threading.Event()
        ack_started = threading.Event()
        errors = []
        original_write = self.events._write_json_atomic

        def write(path, payload):
            if threading.current_thread().name == "notifier" and payload.get("deliveries"):
                writing.set()
                if not release.wait(5):
                    raise RuntimeError("notification write barrier timed out")
            original_write(path, payload)

        def run(action):
            try:
                action()
            except BaseException as error:
                errors.append(error)

        def acknowledge():
            stale = self.events.read_completion_event(self.path)
            ack_started.set()
            self.events.acknowledge_completion_event(stale)

        with (
            mock.patch.object(self.events, "_write_json_atomic", side_effect=write),
            mock.patch.object(
                self.events, "send_desktop_notification", return_value={"kind": "desktop", "status": "sent"}
            ),
        ):
            notifier = threading.Thread(target=lambda: run(self.publish), name="notifier")
            notifier.start()
            acknowledger = None
            try:
                self.assertTrue(writing.wait(5), "notifier did not reach its final write")
                with Path(f"{self.path}.lock").open("a") as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acknowledger = threading.Thread(target=lambda: run(acknowledge))
                acknowledger.start()
                self.assertTrue(ack_started.wait(5), "acknowledger did not reach the barrier")
            finally:
                release.set()
                notifier.join(5)
                if acknowledger is not None:
                    acknowledger.join(5)
            self.assertFalse(notifier.is_alive())
            self.assertFalse(acknowledger.is_alive())
        self.assertEqual(errors, [])
        current = self.events.read_completion_event(self.path)
        self.assertIsNotNone(current["acknowledged_at"])
        self.assertEqual(current["deliveries"], [{"kind": "desktop", "status": "sent"}])

    def test_acknowledgement_during_notification_survives_a_late_result_and_republish(self):
        def notify(event):
            self.events.acknowledge_completion_event(self.events.read_completion_event(self.path))
            return {"kind": "desktop", "status": "failed"}

        with (
            mock.patch.object(self.events, "_utc_now", return_value="first-ack"),
            mock.patch.object(self.events, "send_desktop_notification", side_effect=notify),
        ):
            result = self.publish()
        self.assertEqual(result["acknowledged_at"], "first-ack")
        with mock.patch.object(self.events, "_utc_now", return_value="later"):
            self.publish(notification_mode="none")
        self.assertEqual(self.events.read_completion_event(self.path)["acknowledged_at"], "first-ack")


if __name__ == "__main__":
    unittest.main()
