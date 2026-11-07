from __future__ import annotations

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

import test_run_agent as fixtures

RUNNER = fixtures.RUNNER
AUTO_CORRECT = RUNNER.bundled_module("auto_correct")
GATE = "grep -qx fixed allowed/output.txt"


class AutoCorrectUnitTests(unittest.TestCase):
    def test_gate_files_are_existing_repository_files_named_in_the_commands(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            for name in ("tools/gen.py", "tests/test_x.py", "data/in.json", "config.toml"):
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text("x\n")
            (repo / ".git").mkdir()
            (repo / ".git/config").write_text("")
            commands = [
                "python3 tools/gen.py apply --dry-run && ruff check src tests",
                "pytest tests/test_x.py --rootdir=. < data/in.json;cat missing.txt",
                "lint .git/config /etc/passwd ../outside",
            ]
            self.assertEqual(
                AUTO_CORRECT.gate_paths(commands, repo),
                ["tools/gen.py", "tests/test_x.py", "data/in.json"],
            )
            # A named file the run already changed is the work under test, not the gate.
            self.assertEqual(
                AUTO_CORRECT.gate_paths(commands, repo, changed=["data/in.json"]), ["tools/gen.py", "tests/test_x.py"]
            )
            # An unbalanced quote falls back to whitespace words rather than failing the run.
            self.assertEqual(AUTO_CORRECT.gate_paths([f"check --config={repo}/config.toml 'x"], repo), ["config.toml"])

    def test_rounds_come_from_the_cli_then_the_task_spec_and_need_a_gate(self) -> None:
        effective = AUTO_CORRECT.effective_rounds
        self.assertEqual(effective(None, None, [GATE]), (0, None))
        self.assertEqual(effective(None, {"auto_correct": 2}, [GATE]), (2, "task_spec"))
        self.assertEqual(effective(1, {"auto_correct": 2}, [GATE]), (1, "cli"))
        self.assertEqual(effective(0, {"auto_correct": 2}, [GATE]), (0, None))
        self.assertEqual(effective(None, {"auto_correct": 2}, []), (0, None))
        for value in (-1, 3, True, "1", 1.0):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "from 0 to 2"):
                AUTO_CORRECT.validate_rounds(value, name="--auto-correct")

    def test_a_detached_job_passes_its_rounds_to_its_runner(self) -> None:
        def command(*extra: str) -> list[str]:
            args = RUNNER.parse_args(["--brief", "brief.md", "--engine", "codex", "--verify-command", GATE, *extra])
            return RUNNER.detached_runner_command(
                args,
                repo=Path("/repository"),
                brief_path=Path("/job/brief.txt"),
                task_spec_path=None,
                run_dir=Path("/job/run"),
                event_path=Path("/events/event.json"),
                notification_mode="none",
                completion_hook=None,
            )

        detached = command("--auto-correct", "2")
        self.assertEqual(detached[detached.index("--auto-correct") + 1], "2")
        self.assertNotIn("--auto-correct", command())

    def test_a_round_that_cannot_fit_is_refused(self) -> None:
        refusal = AUTO_CORRECT.round_refusal
        self.assertIsNone(refusal(executor_seconds_left=600, deadline_left=None, gate_seconds=30))
        self.assertEqual(refusal(executor_seconds_left=59, deadline_left=None, gate_seconds=0), "timeout")
        self.assertEqual(refusal(executor_seconds_left=600, deadline_left=80, gate_seconds=30), "deadline")
        self.assertIsNone(refusal(executor_seconds_left=600, deadline_left=91, gate_seconds=30))

    def test_correction_message_carries_the_failure_and_the_instruction(self) -> None:
        failure = {
            "index": 2,
            "command": GATE,
            "status": "failed",
            "exit_code": 3,
            "stdout_tail": ["first", "second"],
            "stderr_tail": [],
        }
        message = AUTO_CORRECT.correction_message(
            failure, {"command_count": 2, "commands": [failure]}, gates=["tools/gen.py"]
        )
        self.assertIn("Gate 2 of 2 failed with exit code 3:", message)
        self.assertIn(f"    {GATE}", message)
        self.assertIn("Last 2 lines of stdout:\n    first\n    second", message)
        self.assertNotIn("stderr", message)
        self.assertIn("Fix exactly these problems; change nothing else.", message)
        self.assertIn("Do not change the gate's own files: tools/gen.py.", message)
        timed_out = {**failure, "status": "timed_out", "duration_seconds": 600.0, "stdout_tail": []}
        quiet = AUTO_CORRECT.correction_message(timed_out, {"command_count": 2}, gates=[])
        self.assertIn("timed out after 600.0 s", quiet)
        self.assertIn("The command printed nothing.", quiet)
        self.assertNotIn("gate's own files", quiet)


class AutoCorrectRunnerTests(unittest.TestCase):
    """The runner resumes the same executor session for each round; fake executors stand in for the CLIs."""

    def setUp(self) -> None:
        self.fixture = fixtures.RunnerIntegrationTests()
        self.fixture.setUp()

    def tearDown(self) -> None:
        self.fixture.tearDown()

    def run_rounds(
        self,
        contents: list[dict[str, str]],
        *,
        rounds: int | None = None,
        verify: list[str] | None = None,
        engine: str = "codex",
        extra_args: list[str] | None = None,
        task_spec: dict | None = None,
    ) -> tuple[int, dict, Path, str, list[dict]]:
        run = self.fixture.run_index + 1
        log = self.fixture.external_path / f"invocations-{run}.jsonl"
        code, result, out_dir, summary, _capture = self.fixture.run_main(
            engine=engine,
            verify_commands=[GATE] if verify is None else verify,
            task_spec=task_spec,
            allow_path=None if task_spec else "allowed",
            extra_args=[*(["--auto-correct", str(rounds)] if rounds is not None else []), *(extra_args or [])],
            extra_env={
                "FAKE_ROUNDS": json.dumps(contents),
                "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / f"rounds-{run}.txt"),
                "FAKE_CAPTURE_LOG": str(log),
            },
        )
        invocations = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return code, result, out_dir, summary, invocations

    def reset(self) -> None:
        self.fixture.repository.git("clean", "-fdq")

    def task_spec(self, **fields: object) -> dict:
        return {
            "objective": "Write the fixed output",
            "repository_root": str(self.fixture.repository.path),
            "current_state": "Output is missing",
            "pre_existing_changes": [],
            "plan": ["Write allowed/output.txt"],
            "allow_paths": ["allowed"],
            "track_paths": [],
            "development_checks": [],
            "acceptance_criteria": ["allowed/output.txt says fixed"],
            **fields,
        }

    def test_a_failed_gate_resumes_the_same_session_until_it_passes(self) -> None:
        cases = (
            ("codex", 1, ["broken\n", "fixed\n"], ["exec", "resume", "codex-thread-1"]),
            ("codex", 2, ["broken\n", "still broken\n", "fixed\n"], ["exec", "resume", "codex-thread-1"]),
            ("claude", 2, ["broken\n", "fixed\n"], ["--resume", "claude-session-1"]),
        )
        for engine, rounds, contents, resume in cases:
            with self.subTest(engine=engine, rounds=rounds, passes_on=len(contents) - 1):
                self.reset()
                code, result, out_dir, summary, runs = self.run_rounds(
                    [{"FAKE_CONTENT": content} for content in contents], rounds=rounds, engine=engine
                )
                self.assertEqual((code, result["status"], result["verification"]["status"]), (0, "completed", "passed"))
                record = result["auto_correct"]
                used = len(contents) - 1
                self.assertEqual(
                    (record["outcome"], record["rounds_used"], record["max_rounds"], record["source"]),
                    ("passed", used, rounds, "cli"),
                )
                self.assertEqual(record["initial_verification"]["status"], "failed")
                compact = {"max_rounds": rounds, "rounds_used": used, "outcome": "passed"}
                self.assertIn("AGENT_AUTO_CORRECT=" + json.dumps(compact, separators=(",", ":")), summary)
                self.assertEqual(len(runs), len(contents))
                self.assertNotIn(resume[-1], " ".join(runs[0]["argv"]))
                for number, (entry, invocation) in enumerate(zip(record["rounds"], runs[1:], strict=True), 1):
                    joined = " ".join(invocation["argv"])
                    self.assertIn(" ".join(resume), joined)
                    prompt = invocation["stdin"]
                    self.assertIn(f"AUTO-CORRECT ROUND {number} OF {rounds} FROM THE RUNNER", prompt)
                    self.assertIn(f"Gate 1 of 1 failed with exit code 1:\n\n    {GATE}", prompt)
                    self.assertIn("Fix exactly these problems; change nothing else.", prompt)
                    self.assertIn("EXECUTION AND REPORT CONTRACT", prompt)
                    self.assertEqual(entry["prompt"], Path(entry["prompt_path"]).read_text())
                    self.assertEqual(entry["prompt"], prompt)
                    self.assertEqual(
                        entry["trigger"], {"index": 1, "command": GATE, "status": "failed", "exit_code": 1}
                    )
                    self.assertEqual(entry["session_id"], resume[-1])
                    self.assertEqual(entry["run_delta"]["changed_paths"], ["allowed/output.txt"])
                    for field in ("started_at", "finished_at"):
                        self.assertTrue(entry[field])
                    for field in ("duration_seconds", "executor_seconds", "verification_seconds", "timeout_seconds"):
                        self.assertGreaterEqual(entry[field], 0)
                    self.assertEqual(entry["status"], "completed" if number == used else "verification_failed")
                    self.assertEqual(entry["verification"]["status"], "passed" if number == used else "failed")
                # Earlier rounds keep their own artifacts; the canonical names hold the final round.
                gate_log = Path(record["initial_verification"]["commands"][0]["stdout_path"])
                self.assertEqual(gate_log.name, "round-0-verification-01.stdout.txt")
                self.assertTrue(gate_log.is_file())
                self.assertEqual(Path(result["verification"]["commands"][0]["stdout_path"]).parent, out_dir.resolve())
                attempts = result["executor_attempts"]
                self.assertEqual([attempt["attempt"] for attempt in attempts], list(range(1, len(contents) + 1)))
                self.assertEqual(Path(attempts[0]["final_output_path"]).name, "attempt-1-final-output.txt")
                self.assertIn("### STATUS", Path(attempts[0]["final_output_path"]).read_text())
                self.assertEqual(len(result["usage"]["attempts"]), len(contents))
                self.assertEqual(result["run_delta"]["changed_paths"], ["allowed/output.txt"])
                self.assertTrue(result["final_message"].startswith("### STATUS"))

    def test_running_out_of_rounds_fails_verification_with_every_round_recorded(self) -> None:
        code, result, _out, summary, runs = self.run_rounds([{"FAKE_CONTENT": "broken\n"}], rounds=2)
        self.assertEqual((code, result["status"], result["task_outcome"]), (25, "verification_failed", "failed"))
        record = result["auto_correct"]
        self.assertEqual((record["outcome"], record["rounds_used"], record["refused_reason"]), ("exhausted", 2, None))
        self.assertEqual(len(runs), 3)
        self.assertEqual([entry["round"] for entry in record["rounds"]], [1, 2])
        for entry in record["rounds"]:
            self.assertEqual((entry["status"], entry["verification"]["status"]), ("verification_failed", "failed"))
            self.assertIn("AUTO-CORRECT ROUND", entry["prompt"])
            self.assertTrue(Path(entry["verification"]["commands"][0]["stdout_path"]).is_file())
        self.assertEqual(
            Path(record["rounds"][0]["verification"]["commands"][0]["stdout_path"]).name,
            "round-1-verification-01.stdout.txt",
        )
        self.assertEqual(result["verification"]["status"], "failed")
        self.assertIn("AGENT_STATUS=verification_failed", summary)

    def test_zero_rounds_or_no_option_leave_the_run_unchanged(self) -> None:
        baseline = None
        for rounds in (None, 0):
            with self.subTest(rounds=rounds):
                self.reset()
                code, result, out_dir, summary, runs = self.run_rounds([{"FAKE_CONTENT": "broken\n"}], rounds=rounds)
                self.assertEqual((code, result["status"]), (25, "verification_failed"))
                self.assertNotIn("auto_correct", result)
                self.assertNotIn("AGENT_AUTO_CORRECT", summary)
                self.assertNotIn("AUTO-CORRECT", runs[0]["stdin"])
                self.assertEqual((len(runs), len(result["executor_attempts"])), (1, 1))
                self.assertFalse(
                    [path.name for path in out_dir.iterdir() if path.name.startswith(("round-", "attempt-"))]
                )
                shape = (sorted(result), result["verification"]["commands"][0]["stdout_path"].replace(str(out_dir), ""))
                baseline = baseline or shape
                self.assertEqual(shape, baseline)
        self.reset()
        # A task spec's rounds are inert without a gate, and the runner refuses a CLI request it cannot honor.
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "broken\n"}], verify=[], task_spec=self.task_spec(auto_correct=2)
        )
        self.assertEqual((code, result["status"], len(runs)), (0, "completed", 1))
        self.assertNotIn("auto_correct", result)
        for arguments, message in ((["--auto-correct", "3"], "from 0 to 2"), (["--auto-correct", "1"], "requires")):
            with self.subTest(arguments=arguments), self.assertRaisesRegex(RUNNER.RunnerError, message) as caught:
                self.fixture.run_main(verify_commands=[] if message == "requires" else [GATE], extra_args=arguments)
            self.assertEqual(caught.exception.exit_code, 4)

    def test_the_task_spec_declares_rounds_and_the_cli_overrides_it(self) -> None:
        spec = self.task_spec(auto_correct=1)
        code, result, _out, _summary, runs = self.run_rounds([{"FAKE_CONTENT": "broken\n"}], task_spec=spec)
        self.assertEqual((code, len(runs)), (25, 2))
        self.assertEqual((result["auto_correct"]["source"], result["auto_correct"]["rounds_used"]), ("task_spec", 1))
        self.reset()
        code, result, _out, _summary, runs = self.run_rounds([{"FAKE_CONTENT": "broken\n"}], task_spec=spec, rounds=0)
        self.assertEqual((code, len(runs)), (25, 1))
        self.assertNotIn("auto_correct", result)

    def test_rounds_share_the_timeout_and_one_that_cannot_fit_is_refused(self) -> None:
        soon = (dt.datetime.now(dt.UTC) + dt.timedelta(seconds=45)).isoformat()
        for arguments, reason in ((["--timeout", "30s"], "timeout"), (["--deadline", soon], "deadline")):
            with self.subTest(reason=reason):
                self.reset()
                code, result, _out, _summary, runs = self.run_rounds(
                    [{"FAKE_CONTENT": "broken\n"}, {"FAKE_CONTENT": "fixed\n"}], rounds=2, extra_args=arguments
                )
                self.assertEqual((code, result["status"], len(runs)), (25, "verification_failed", 1))
                record = result["auto_correct"]
                self.assertEqual(
                    (record["outcome"], record["refused_reason"], record["rounds"]), ("refused", reason, [])
                )
        self.reset()
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "broken\n"}, {"FAKE_CONTENT": "fixed\n"}], rounds=1, extra_args=["--timeout", "2m"]
        )
        self.assertEqual((code, len(runs)), (0, 2))
        [entry] = result["auto_correct"]["rounds"]
        # The round gets what the first handoff left of the 2m executor budget.
        self.assertLess(entry["timeout_seconds"], 120)
        self.assertGreater(entry["timeout_seconds"], 60)
        self.assertLessEqual(result["auto_correct"]["executor_seconds"], 120)

    def test_native_transport_hands_the_correction_to_the_host_instead_of_looping(self) -> None:
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "broken\n"}], rounds=2, extra_args=["--host", "codex"]
        )
        self.assertEqual((code, result["status"], runs), (0, "native_handoff", []))
        self.assertEqual(result["auto_correct"], {"max_rounds": 2, "source": "cli", "mode": "native", "rounds": []})
        self.assertIn("Auto-correct is not run for native transport", result["native_instructions"])
        self.assertIn("Fix exactly these problems; change nothing else.", result["native_instructions"])

    def test_a_round_that_edits_a_gate_file_fails_the_run(self) -> None:
        repository = self.fixture.repository
        repository.write("allowed/check.sh", f"{GATE}\n")
        repository.git("add", "allowed/check.sh")
        repository.git("commit", "-qm", "gate")
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "broken\n"}, {"FAKE_OUTPUT": "allowed/check.sh", "FAKE_CONTENT": "exit 0\n"}],
            rounds=2,
            verify=["sh allowed/check.sh"],
        )
        self.assertEqual((code, result["status"], len(runs)), (22, "scope_violation", 2))
        self.assertEqual(result["scope_violations"], ["gate-edit:allowed/check.sh"])
        self.assertEqual(result["verification"]["status"], "skipped")
        record = result["auto_correct"]
        self.assertEqual(
            (record["outcome"], record["stop_reason"], record["rounds_used"]), ("stopped", "gate_files_changed", 1)
        )
        [entry] = record["rounds"]
        self.assertEqual(
            (entry["gate_files"], entry["gate_files_changed"]), (["allowed/check.sh"], ["allowed/check.sh"])
        )
        self.assertIn("Do not change the gate's own files: allowed/check.sh.", runs[1]["stdin"])

    def test_a_scope_violation_in_a_correction_round_fails_the_combined_run(self) -> None:
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "broken\n"}, {"FAKE_OUTPUT": "outside.txt", "FAKE_CONTENT": "fixed\n"}], rounds=2
        )
        self.assertEqual((code, result["status"], len(runs)), (22, "scope_violation", 2))
        self.assertEqual(result["scope_violations"], ["outside.txt"])
        self.assertEqual(result["run_delta"]["changed_paths"], ["allowed/output.txt", "outside.txt"])
        record = result["auto_correct"]
        self.assertEqual((record["outcome"], record["stop_reason"]), ("stopped", "scope_violation"))
        self.assertEqual(record["rounds"][0]["run_delta"]["changed_paths"], ["outside.txt"])
        self.assertEqual(result["verification"]["status"], "skipped")


if __name__ == "__main__":
    unittest.main()
