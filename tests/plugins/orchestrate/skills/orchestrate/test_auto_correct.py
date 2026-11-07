from __future__ import annotations

import datetime as dt
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import test_run_agent as fixtures

RUNNER = fixtures.RUNNER
AUTO_CORRECT = RUNNER.bundled_module("auto_correct")
GATE = "grep -qx fixed allowed/output.txt"


class AutoCorrectUnitTests(unittest.TestCase):
    def test_gate_files_are_existing_repository_files_named_in_the_commands(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            files = (
                "tools/gen.py",
                "tests/test_x.py",
                "data/in.json",
                "config.toml",
                "gate/check.sh",
                "suite/a.sh",
                "suite/b.sh",
                "real-check.sh",
                "build/gate.log",
            )
            for name in files:
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text("x\n")
            (repo / ".gitignore").write_text("build/\n")
            (repo / "link-check.sh").symlink_to("real-check.sh")
            commands = [
                "python3 tools/gen.py apply --dry-run && ruff check src tests",
                "pytest tests/test_x.py --rootdir=. < data/in.json;cat missing.txt",
                "lint .git/config /etc/passwd ../outside",
            ]
            self.assertEqual(
                AUTO_CORRECT.gate_paths(commands, repo), ["tools/gen.py", "tests/test_x.py", "data/in.json"]
            )
            shapes = {
                # Relative names after a cd resolve against its target.
                "cd gate && sh check.sh": ["gate/check.sh"],
                # The command inside sh -c / bash -lc names files too.
                "bash -lc 'cd gate; sh ./check.sh' && sh -c \"python3 tools/gen.py\"": [
                    "gate/check.sh",
                    "tools/gen.py",
                ],
                # A symlinked script protects the link and its target.
                "sh link-check.sh": ["link-check.sh", "real-check.sh"],
                # A glob protects what it matches.
                "for f in suite/*.sh; do sh $f; done": ["suite/a.sh", "suite/b.sh"],
                # Git-ignored names are output the gate writes, not the gate.
                "sh tools/gen.py > build/gate.log": ["tools/gen.py"],
                # An unbalanced quote falls back to whitespace words rather than failing the run.
                f"check --config={repo}/config.toml 'x": ["config.toml"],
            }
            for command, expected in shapes.items():
                with self.subTest(command=command):
                    self.assertEqual(AUTO_CORRECT.gate_paths([command], repo), expected)

    def test_a_round_never_runs_past_the_deadline_less_the_gates(self) -> None:
        budget = AUTO_CORRECT.round_budget
        self.assertEqual(budget(executor_seconds_left=600, deadline_left=None, gate_seconds=30), 600)
        self.assertEqual(budget(executor_seconds_left=600, deadline_left=100, gate_seconds=30), 70)
        self.assertEqual(budget(executor_seconds_left=50, deadline_left=1000, gate_seconds=30), 50)

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
        allow_path: str = "allowed",
        extra_env: dict[str, str] | None = None,
    ) -> tuple[int, dict, Path, str, list[dict]]:
        run = self.fixture.run_index + 1
        log = self.fixture.external_path / f"invocations-{run}.jsonl"
        code, result, out_dir, summary, _capture = self.fixture.run_main(
            engine=engine,
            verify_commands=[GATE] if verify is None else verify,
            task_spec=task_spec,
            allow_path=None if task_spec else allow_path,
            extra_args=[*(["--auto-correct", str(rounds)] if rounds is not None else []), *(extra_args or [])],
            extra_env={
                "FAKE_ROUNDS": json.dumps(contents),
                "FAKE_ROUNDS_COUNT": str(self.fixture.external_path / f"rounds-{run}.txt"),
                "FAKE_CAPTURE_LOG": str(log),
                **(extra_env or {}),
            },
        )
        invocations = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return code, result, out_dir, summary, invocations

    def reset(self) -> None:
        self.fixture.repository.git("clean", "-fdq")

    def commit(self, files: dict[str, str]) -> None:
        for name, content in files.items():
            self.fixture.repository.write(name, content)
            self.fixture.repository.git("add", "-f", name)
        self.fixture.repository.git("commit", "-qm", "gate")

    def rerun_gate_after_each_round(self, gate: str) -> None:
        """Make the fake codex run the gate after a resumed turn, as a worker checking its fix would."""
        fake = self.fixture.external_path / "codex"
        fake.rename(self.fixture.external_path / "codex-real")
        fake.write_text(
            "#!/bin/sh\n"
            '"$(dirname "$0")/codex-real" "$@"; status=$?\n'
            f'if [ "$1" = exec ] && [ "$2" = resume ]; then sh -c {shlex.quote(gate)} || true; fi\n'
            'exit "$status"\n'
        )
        fake.chmod(0o700)

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
            ("opencode", 1, ["broken\n", "fixed\n"], ["--session", "ses_opencode_1"]),
            ("agy", 1, ["broken\n", "fixed\n"], ["--conversation", "11111111-1111-1111-1111-111111111111"]),
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
                    # Each engine gets the correction turn the way it got the brief.
                    if engine == "opencode":
                        prompt_file = invocation["argv"][invocation["argv"].index("--file") + 1]
                        self.assertEqual(Path(prompt_file).name, f"round-{number}-brief.txt")
                        prompt = Path(prompt_file).read_text()
                    elif engine == "agy":
                        prompt = next(arg for arg in invocation["argv"] if arg.startswith("--print="))[
                            len("--print=") :
                        ]
                    else:
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
                self.assertEqual(Path(attempts[0]["stdout_path"]).name, "attempt-1-stdout.txt")
                self.assertTrue(Path(attempts[0]["stdout_path"]).read_text())
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

    def test_an_admitted_round_that_runs_out_of_time_still_ends_verification_failed(self) -> None:
        # A shorter floor keeps the test fast; the round is admitted, then capped short of the deadline.
        soon = (dt.datetime.now(dt.UTC) + dt.timedelta(seconds=8)).isoformat()
        with mock.patch.object(AUTO_CORRECT, "MIN_ROUND_SECONDS", 1.0):
            code, result, _out, _summary, runs = self.run_rounds(
                [{"FAKE_CONTENT": "broken\n"}, {"FAKE_CONTENT": "fixed\n"}],
                rounds=1,
                extra_args=["--deadline", soon],
                extra_env={"FAKE_RESUME_SLEEP": "60"},
            )
        self.assertEqual((code, result["status"]), (25, "verification_failed"))
        record = result["auto_correct"]
        self.assertEqual((record["outcome"], record["stop_reason"]), ("stopped", "timed_out"))
        [entry] = record["rounds"]
        self.assertEqual((entry["status"], entry["timed_out"]), ("timed_out", True))
        self.assertLess(entry["timeout_seconds"], 8)
        self.assertLess(entry["executor_seconds"], 8)
        # The result keeps the last good handoff: its report and its gate results.
        self.assertTrue(result["report_contract_valid"])
        self.assertTrue(result["final_message"].startswith("### STATUS"))
        self.assertEqual(result["verification"]["status"], "failed")
        self.assertEqual(
            result["verification"]["commands"][0]["stdout_path"],
            record["initial_verification"]["commands"][0]["stdout_path"],
        )

    def test_a_round_that_fails_or_breaks_the_report_never_leaves_the_run_worse(self) -> None:
        for update, reason in (
            ({"FAKE_MALFORMED": "1"}, "malformed_report"),
            ({"FAKE_REPORT_STATUS": "FAILED"}, "failed"),
        ):
            with self.subTest(reason=reason):
                self.reset()
                code, result, _out, _summary, runs = self.run_rounds(
                    [{"FAKE_CONTENT": "broken\n"}, {"FAKE_CONTENT": "fixed\n", **update}], rounds=2
                )
                self.assertEqual((code, result["status"], len(runs)), (25, "verification_failed", 2))
                self.assertEqual((result["reported_outcome"], result["report_contract_valid"]), ("complete", True))
                record = result["auto_correct"]
                self.assertEqual(
                    (record["outcome"], record["stop_reason"], record["rounds_used"]), ("stopped", reason, 1)
                )
                [entry] = record["rounds"]
                self.assertEqual(entry["status"], reason)
                self.assertEqual(entry["verification"]["status"], "skipped")
                self.assertEqual(result["verification"]["status"], "failed")

    def test_native_transport_hands_the_correction_to_the_host_instead_of_looping(self) -> None:
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "broken\n"}], rounds=2, extra_args=["--host", "codex"]
        )
        self.assertEqual((code, result["status"], runs), (0, "native_handoff", []))
        self.assertEqual(result["auto_correct"], {"max_rounds": 2, "source": "cli", "mode": "native", "rounds": []})
        self.assertIn("Auto-correct is not run for native transport", result["native_instructions"])
        self.assertIn("Fix exactly these problems; change nothing else.", result["native_instructions"])

    def test_a_round_that_edits_a_gate_file_fails_the_run(self) -> None:
        self.commit({"allowed/check.sh": f"{GATE}\n"})
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

    def test_gate_files_reached_through_cd_shells_symlinks_and_globs_are_protected(self) -> None:
        shapes = (
            (
                "cd",
                {"allowed/gate/check.sh": "grep -qx fixed ../output.txt\n"},
                "cd allowed/gate && sh check.sh",
                "allowed/gate/check.sh",
            ),
            ("sh -c", {"allowed/check.sh": f"{GATE}\n"}, "sh -c 'sh allowed/check.sh'", "allowed/check.sh"),
            ("symlink", {"allowed/real-check.sh": f"{GATE}\n"}, "sh allowed/check.sh", "allowed/real-check.sh"),
            (
                "glob",
                {"allowed/tests/t.sh": f"{GATE}\n"},
                "for f in allowed/tests/*.sh; do sh $f || exit 1; done",
                "allowed/tests/t.sh",
            ),
        )
        for shape, files, gate, edited in shapes:
            with self.subTest(shape=shape):
                self.fixture.tearDown()
                self.fixture.setUp()
                self.commit(files)
                if shape == "symlink":
                    os.symlink("real-check.sh", self.fixture.repository.path / "allowed/check.sh")
                    self.fixture.repository.git("add", "allowed/check.sh")
                    self.fixture.repository.git("commit", "-qm", "link")
                code, result, _out, _summary, runs = self.run_rounds(
                    [{"FAKE_CONTENT": "broken\n"}, {"FAKE_OUTPUT": edited, "FAKE_CONTENT": "exit 0\n"}],
                    rounds=1,
                    verify=[gate],
                )
                self.assertEqual((code, result["status"], len(runs)), (22, "scope_violation", 2))
                self.assertEqual(result["scope_violations"], [f"gate-edit:{edited}"])
                self.assertEqual(result["auto_correct"]["stop_reason"], "gate_files_changed")

    def test_files_the_gate_writes_are_not_gate_files(self) -> None:
        # The gate logs to an ignored file that did not exist before the run; the worker re-runs the gate.
        # A log left by an earlier run exists before this one too: being ignored keeps it out of the gate.
        self.commit({".gitignore": "plans/\nbuild/\n", "build/.keep": ""})
        (self.fixture.repository.path / "build/gate.log").write_text("stale\n")
        gate = "grep -x fixed allowed/output.txt > build/gate.log"
        self.rerun_gate_after_each_round(gate)
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "broken\n"}, {"FAKE_CONTENT": "fixed\n"}], rounds=1, verify=[gate]
        )
        self.assertEqual((code, result["status"], len(runs)), (0, "completed", 2))
        self.assertEqual(result["auto_correct"]["rounds"][0]["gate_files"], [])
        self.assertTrue((self.fixture.repository.path / "build/gate.log").is_file())

    def test_a_gate_script_is_protected_while_the_workers_own_payload_stays_editable(self) -> None:
        # The requester's shape: an interpreter outside the repository, a gate script, the worker's payload.
        script = "import json, sys\nsys.exit(0 if json.load(open(sys.argv[3])).get('ok') else 1)\n"
        gate = f"{shlex.quote(sys.executable)} tools/gen.py apply --dry-run out/payload.json"
        broken = {"FAKE_OUTPUT": "out/payload.json", "FAKE_CONTENT": '{"ok": false}'}
        for name, fix, expected in (
            ("payload fixed", {"FAKE_OUTPUT": "out/payload.json", "FAKE_CONTENT": '{"ok": true}'}, (0, "completed")),
            (
                "gate edited",
                {"FAKE_OUTPUT": "tools/gen.py", "FAKE_CONTENT": "raise SystemExit(0)\n"},
                (22, "scope_violation"),
            ),
        ):
            with self.subTest(name):
                self.fixture.tearDown()
                self.fixture.setUp()
                self.commit({"tools/gen.py": script})
                code, result, _out, _summary, _runs = self.run_rounds(
                    [broken, fix], rounds=1, verify=[gate], allow_path="."
                )
                self.assertEqual((code, result["status"]), expected)
                self.assertEqual(result["auto_correct"]["rounds"][0]["gate_files"], ["tools/gen.py"])
                if code:
                    self.assertEqual(result["scope_violations"], ["gate-edit:tools/gen.py"])

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
