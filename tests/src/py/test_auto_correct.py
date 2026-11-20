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
    def repository(self, directory: str, files: tuple[str, ...]) -> Path:
        repo = Path(directory).resolve()
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        (repo / ".gitignore").write_text(".venv/\nbuild/\nnode_modules/\n")
        for name in files:
            (repo / name).parent.mkdir(parents=True, exist_ok=True)
            (repo / name).write_text("x\n")
        return repo

    def test_gate_names_survive_common_shell_shapes_and_symlink_chains(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            files = (".venv/bin/pytest", "gate/check.sh", "d1/a.sh", "d2/b.sh", "real.sh", "build/check.sh")
            repo = self.repository(directory, (*files, "real-dir/check.sh", "allowed/build.sh", "allowed/check.sh"))
            (repo / "mid.sh").symlink_to("real.sh")
            (repo / "chain.sh").symlink_to("mid.sh")
            (repo / "to-ignored.sh").symlink_to("build/check.sh")
            (repo / "dir-link").symlink_to("real-dir")
            cases = {
                "env FOO=1 .venv/bin/pytest": [".venv/bin/pytest"],
                "{ .venv/bin/pytest; }": [".venv/bin/pytest"],
                "sh -c .venv/bin/pytest": [".venv/bin/pytest"],
                'FOO="line1\nline2" .venv/bin/pytest': [".venv/bin/pytest"],
                # A newline ends a command like `;` does, and a prefix's option values are not the program.
                "set -e\n.venv/bin/pytest": [".venv/bin/pytest"],
                "env -u FOO .venv/bin/pytest": [".venv/bin/pytest"],
                "timeout -k 5 30 .venv/bin/pytest": [".venv/bin/pytest"],
                "/usr/bin/env -i .venv/bin/pytest && nice -n 5 ./gate/check.sh": [".venv/bin/pytest", "gate/check.sh"],
                "cd -P gate && sh check.sh": ["gate/check.sh"],
                "(cd gate) && cd d2 && sh b.sh": ["d2/b.sh"],
                "cd d1\ncd ../d2\nsh b.sh": ["d2/b.sh"],
                # Each subshell's cd is its own: check.sh is only gate/check.sh, never allowed/check.sh.
                "(cd allowed && sh build.sh) && (cd gate && sh check.sh)": ["allowed/build.sh", "gate/check.sh"],
                "pushd gate && sh check.sh && popd && sh d1/a.sh": ["gate/check.sh", "d1/a.sh"],
                'sh -c "(./gate/check.sh)"': ["gate/check.sh"],
                "sh chain.sh": ["chain.sh", "mid.sh", "real.sh"],
                "sh to-ignored.sh": ["to-ignored.sh", "build/check.sh"],
                # A script reached through a symlinked directory protects the link and the file Git tracks.
                "sh dir-link/check.sh": ["dir-link", "real-dir/check.sh"],
                # A file a command only reads is not the gate: the worker's output here.
                "grep -qx fixed dir-link/check.sh": [],
            }
            for command, expected in cases.items():
                with self.subTest(command=command):
                    self.assertEqual(AUTO_CORRECT.gate_paths([command], repo), expected)

    def test_an_absolute_gate_name_through_a_symlinked_prefix_is_still_a_gate_file(self) -> None:
        # macOS temporary directories live under /var, a symlink to /private/var.
        with tempfile.TemporaryDirectory() as directory:
            real = Path(directory) / "real"
            real.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=real, check=True)
            (real / "config.toml").write_text("x\n")
            (real / "check.sh").write_text("x\n")
            (real / "linked.sh").symlink_to("check.sh")
            alias = Path(directory) / "alias"
            alias.symlink_to(real)
            commands = [f"{alias}/check.sh --config={alias}/config.toml", f"sh {alias}/linked.sh"]
            self.assertEqual(AUTO_CORRECT.gate_paths(commands, alias), ["check.sh", "linked.sh"])

    def test_wrapper_operands_cd_dash_and_substitution_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = self.repository(directory, ("allowed/check.sh", "allowed/check.py", "sub/x", "other/x"))
            for name in ("time", "env", "timeout", "nice"):
                (repo / "allowed" / name).write_text("exit 1\n")
            cases = {
                **{f"./allowed/{name}": [f"allowed/{name}"] for name in ("time", "env", "timeout", "nice")},
                "./allowed/env sh allowed/check.sh": ["allowed/env"],
                f"{repo}/allowed/env sh allowed/check.sh": ["allowed/env"],
                'env -S "python3 -u" allowed/check.py': ["allowed/check.py"],
                "env --split-string='FOO=1' ./allowed/check.sh": ["allowed/check.sh"],
                'env -S "env -S python3" allowed/check.py': ["allowed/check.py"],
                'env -C allowed -S "python3 -u" check.py': ["allowed/check.py"],
                "cd sub && pwd >/dev/null && cd - >/dev/null && sh allowed/check.sh": ["allowed/check.sh"],
                "cd allowed; cd ../sub; cd -; sh check.sh": ["allowed/check.sh"],
                "cd allowed; (cd ../other); cd -; sh allowed/check.sh": ["allowed/check.sh"],
                'test "$(printf "%s" "a\\"b")" = "a\\"b" && sh allowed/check.sh': ["allowed/check.sh"],
                "out=$(\ncd allowed # 1) step\nsh check.sh\n)": ["allowed/check.sh"],
                # A # in the middle of a word is literal, so the following command still runs.
                "out=$(printf foo#bar; sh allowed/check.sh)": ["allowed/check.sh"],
                "out=$(printf foo\\ #bar; sh allowed/check.sh)": ["allowed/check.sh"],
            }
            for command, expected in cases.items():
                with self.subTest(command=command):
                    self.assertEqual(AUTO_CORRECT.gate_paths([command], repo), expected)

    def test_documented_indirect_forms_need_explicit_protect_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = self.repository(
                directory,
                (
                    "allowed/check.sh",
                    "allowed/check.js",
                    "allowed/check.ts",
                    "allowed/check.rb",
                    "allowed/check.ps1",
                    "allowed/check-gate",
                ),
            )
            cases = {
                'eval "sh allowed/check.sh"': "allowed/check.sh",
                "find allowed -name check.sh -exec sh {} +": "allowed/check.sh",
                'printf "allowed/check.sh\\n" | xargs sh': "allowed/check.sh",
                'bash <<< "sh allowed/check.sh"': "allowed/check.sh",
                "builtin . allowed/check.sh": "allowed/check.sh",
                "(cd allowed && case x in *) ;; esac && sh check.sh)": "allowed/check.sh",
                "cd allowed && bun check-gate": "allowed/check-gate",
                "bun -c bunfig.toml allowed/check.ts": "allowed/check.ts",
                "deno run --ext ts allowed/check.ts": "allowed/check.ts",
                "deno run --env-file .env allowed/check.ts": "allowed/check.ts",
                "node --env-file-if-exists .env allowed/check.js": "allowed/check.js",
                "node --disable-warning DEP0001 allowed/check.js": "allowed/check.js",
                "bun --cwd allowed check.ts": "allowed/check.ts",
                "bun --cwd=allowed check.ts": "allowed/check.ts",
                "ruby -C allowed check.rb": "allowed/check.rb",
                "ruby -Callowed check.rb": "allowed/check.rb",
                "pwsh -wd allowed check.ps1": "allowed/check.ps1",
                "pwsh -WorkingDirectory allowed -File check.ps1": "allowed/check.ps1",
                "pwsh < allowed/check.ps1": "allowed/check.ps1",
                'pwsh -c "./allowed/check.ps1"': "allowed/check.ps1",
            }
            for command, gate in cases.items():
                with self.subTest(command=command):
                    self.assertEqual(AUTO_CORRECT.gate_paths([command], repo), [])
                    self.assertEqual(AUTO_CORRECT.protected_paths([gate], repo), [gate])

    def test_gate_files_are_the_programs_and_scripts_the_commands_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            files = ("tools/gen.py", "tests/test_x.py", "data/in.json", "gate/check.sh", "scripts/env.sh")
            repo = self.repository(directory, (*files, "build/gate.log", "x.js", "x.rb", "x.pl", "x.ts", "x.ps1"))
            for name in (".venv/bin/pytest", "node_modules/vitest/vitest.mjs"):
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text("x\n")
            (repo / "node_modules/.bin").mkdir()
            (repo / "node_modules/.bin/vitest").symlink_to("../vitest/vitest.mjs")
            (repo / "build/latest.log").symlink_to("gate.log")
            commands = [
                "python3 tools/gen.py apply --dry-run data/in.json && ruff check src tests",
                "pytest tests/test_x.py --rootdir=. < data/in.json;cat missing.txt",
                "lint .git/config /etc/passwd ../outside && sh ../outside.sh",
            ]
            self.assertEqual(AUTO_CORRECT.gate_paths(commands, repo), ["tools/gen.py"])
            shapes = {
                "cd gate && sh check.sh": ["gate/check.sh"],
                "bash -lc 'cd gate; sh ./check.sh' && sh -c \"python3 tools/gen.py\"": [
                    "gate/check.sh",
                    "tools/gen.py",
                ],
                "bash -o pipefail -e gate/check.sh": ["gate/check.sh"],
                # Arguments are never gate files: test files, data, logs, a `-c` that is not a shell's.
                "FORCE=1 .venv/bin/pytest tests/test_x.py > build/gate.log": [".venv/bin/pytest"],
                "grep -x fixed out.txt > build/gate.log && wc -c build/gate.log": [],
                "grep -x fixed out.txt > build/latest.log": [],
                "cd gate && ../node_modules/.bin/vitest run": [
                    "node_modules/.bin/vitest",
                    "node_modules/vitest/vitest.mjs",
                ],
                "npx vitest run && make test": [],
                # The first operand after an interpreter's options is its script.
                "python3 -W ignore -u tools/gen.py apply x": ["tools/gen.py"],
                "python3 -m pytest tests/test_x.py; python3 -c 'print(1)' tools/gen.py": [],
                "node -r ./x.js tools/gen.py; node -e 'x' x.js; node --test x.js": ["tools/gen.py"],
                "ruby -I lib x.rb && perl -Ilib x.pl && perl -ne 'print' x.pl": ["x.rb", "x.pl"],
                "deno run -A x.ts && deno test x.ts && bun x.ts && bun test": ["x.ts"],
                "pwsh -NoProfile -File x.ps1; pwsh -Command 'x'": ["x.ps1"],
                ". scripts/env.sh && source scripts/env.sh && sh < gate/check.sh": ["scripts/env.sh", "gate/check.sh"],
                # A here-document is data; a command substitution runs a command.
                "python3 - <<'EOF'\nimport tools.gen\nEOF\ntest \"$(./gate/check.sh)\" = ok": ["gate/check.sh"],
                # Like a directory, a glob or an expansion names the work under test.
                "for f in gate/*.sh; do sh $f; done": [],
                # An unbalanced quote still reads the words before it.
                "sh 'gate/check.sh": ["gate/check.sh"],
            }
            for command, expected in shapes.items():
                with self.subTest(command=command):
                    self.assertEqual(AUTO_CORRECT.gate_paths([command], repo), expected)

    def test_explicit_protect_paths_are_gate_files_whatever_their_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = self.repository(directory, ("tests/test_x.py", "real-dir/check.sh", "build/gate.log"))
            (repo / "dir-link").symlink_to("real-dir")
            (repo / "build/latest.log").symlink_to("gate.log")
            entries = ["tests/test_x.py", "tests", "missing.txt", "dir-link/check.sh", "build/latest.log"]
            self.assertEqual(
                AUTO_CORRECT.protected_paths(entries, repo),
                [
                    "tests/test_x.py",
                    "tests",
                    "missing.txt",
                    "dir-link",
                    "real-dir/check.sh",
                    "build/latest.log",
                    "build/gate.log",
                ],
            )

    def test_a_steer_releases_the_paths_it_names_and_everything_under_them(self) -> None:
        released = AUTO_CORRECT.released
        self.assertTrue(released("allowed/check.sh", ["allowed"]))
        self.assertTrue(released("allowed/check.sh", ["allowed/check.sh"]))
        self.assertTrue(released("gate/check.sh", ["."]))
        self.assertFalse(released("allowed/check.sh", ["allow"]))
        self.assertFalse(released("allowed/check.sh", []))

    def test_link_cycles_are_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = self.repository(directory, ("gates/check.sh", "gates/sibling.sh"))
            (repo / "gates/loop").symlink_to(".")
            (repo / "alias").symlink_to("gates")
            (repo / "cycle1").symlink_to("cycle2")
            (repo / "cycle2").symlink_to("cycle1")
            self.assertEqual(AUTO_CORRECT.protected_paths(["gates"], repo), ["gates", "gates/loop"])
            self.assertEqual(AUTO_CORRECT.protected_paths(["cycle1"], repo), ["cycle1", "cycle2"])
            self.assertEqual(AUTO_CORRECT.protected_paths(["alias"], repo), ["alias", "gates", "gates/loop"])

    def test_releases_are_exactly_the_named_paths_and_never_follow_links(self) -> None:
        release = AUTO_CORRECT.release_paths
        self.assertEqual(release(["alias/check.sh"]), ["alias/check.sh"])
        self.assertEqual(release(["alias", "alias", "gates/link.sh"]), ["alias", "gates/link.sh"])
        self.assertEqual(release(["alias.sh", "."]), ["."])
        self.assertEqual(release([]), [])

    def test_directory_gate_baselines_exclude_released_children_but_keep_modes_and_siblings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = self.repository(directory, ("gates/one.txt", "gates/two.txt"))
            path = repo / "gates"
            baseline = RUNNER.gate_fingerprint(path)
            (path / "one.txt").write_text("released\n")
            releases = [path / "one.txt"]
            self.assertFalse(RUNNER.gate_changed(path, baseline, releases=releases))
            self.assertTrue(RUNNER.gate_changed(path, baseline, releases=[]))
            (path / "new.txt").write_text("unreleased addition\n")
            self.assertTrue(RUNNER.gate_changed(path, baseline, releases=releases))
            releases.append(path / "new.txt")
            self.assertFalse(RUNNER.gate_changed(path, baseline, releases=releases))
            (path / "two.txt").chmod(0o700)
            self.assertTrue(RUNNER.gate_changed(path, baseline, releases=releases))

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

        detached = command("--auto-correct", "2", "--protect-path", "tests/a.py", "--protect-path", "tests/b")
        self.assertEqual(detached[detached.index("--auto-correct") + 1], "2")
        self.assertEqual(
            [detached[index + 1] for index, word in enumerate(detached) if word == "--protect-path"],
            ["tests/a.py", "tests/b"],
        )
        resumed = command("--expect-changes", "--expect-task-changes", "--session", "s", "--resume-result", "r.json")
        self.assertIn("--expect-task-changes", resumed)
        for flag in ("--auto-correct", "--protect-path", "--expect-task-changes"):
            self.assertNotIn(flag, command())

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
        # A wrong check goes to review: the guidance follows the gate files and closes the message.
        guidance = (
            "If a check itself is wrong, do not change it; stop and report BLOCKED with the evidence that the "
            "check, not the work, is at fault."
        )
        self.assertTrue(message.endswith(f"A round that changes them fails the run.\n{guidance}"))
        timed_out = {**failure, "status": "timed_out", "duration_seconds": 600.0, "stdout_tail": []}
        quiet = AUTO_CORRECT.correction_message(timed_out, {"command_count": 2}, gates=[])
        self.assertIn("timed out after 600.0 s", quiet)
        self.assertIn("The command printed nothing.", quiet)
        self.assertNotIn("gate's own files", quiet)
        self.assertTrue(quiet.endswith(f"{AUTO_CORRECT.INSTRUCTION}\n{guidance}"))


class UsageCostSourceTests(unittest.TestCase):
    def test_a_correction_after_reverify_takes_its_cost_baseline_from_the_rechecked_run(self):
        with tempfile.TemporaryDirectory() as directory:
            implementation = {"model_invoked": True, "usage": {"native_cost_usd": 0.65}, "executor_attempts": []}
            implementation_path = Path(directory) / "implementation.json"
            implementation_path.write_text(json.dumps(implementation), encoding="utf-8")
            reverify = {
                **implementation,
                "model_invoked": False,
                "usage": {"native_cost_usd": 0},
                "verification_of": {"path": str(implementation_path)},
            }
            self.assertEqual(RUNNER.usage_cost_source(reverify), implementation)
            self.assertIs(RUNNER.usage_cost_source(implementation), implementation)
            self.assertIsNone(RUNNER.usage_cost_source(None))
            # A recheck whose original result is gone gives no baseline rather than a wrong zero.
            implementation_path.unlink()
            self.assertIsNone(RUNNER.usage_cost_source(reverify))


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
                self.assertEqual(record["converted_from"], reason)
                [entry] = record["rounds"]
                self.assertEqual(entry["status"], reason)
                self.assertEqual(entry["verification"]["status"], "skipped")
                self.assertEqual(result["verification"]["status"], "failed")

    def test_a_blocked_round_surfaces_its_report_and_consultation_request(self) -> None:
        request = {
            "question": "Which date form does the schema allow for a [?] reading?",
            "decision_needed": "Choose the EDTF form",
            "observations": ["The gate rejects 1850 for a [?] reading"],
            "attempts": ["Wrote 1850"],
            "versions": ["gen.py 4"],
            "hypotheses": ["The schema wants 1850?"],
        }
        blocked = (
            "### STATUS\nBLOCKED\n\n### FILES CHANGED\n- none\n\n### COMMANDS RUN\n- none\n\n"
            "### VERIFICATION\n- not run\n\n### RISKS OR BLOCKERS\n- needs a decision\n\n"
            f"```consultation-request\n{json.dumps(request)}\n```\n"
        )
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "broken\n"}, {"FAKE_CONTENT": "broken again\n", "FAKE_REPORT_TEXT": blocked}], rounds=2
        )
        self.assertEqual((code, result["status"], result["reported_outcome"], len(runs)), (24, "blocked", "blocked", 2))
        self.assertTrue(result["final_message"].startswith("### STATUS\nBLOCKED"))
        self.assertEqual(result["consultation"]["status"], "requested")
        self.assertEqual(result["consultation"]["request"]["decision_needed"], "Choose the EDTF form")
        record = result["auto_correct"]
        self.assertEqual((record["stop_reason"], record["converted_from"]), ("blocked", None))

    def test_a_round_that_undoes_the_work_ends_no_changes(self) -> None:
        fake = self.fixture.external_path / "codex"
        fake.rename(self.fixture.external_path / "codex-real")
        fake.write_text(
            "#!/bin/sh\n"
            '"$(dirname "$0")/codex-real" "$@"; status=$?\n'
            'if [ "$1" = exec ] && [ "$2" = resume ]; then rm -rf allowed; fi\n'
            'exit "$status"\n'
        )
        fake.chmod(0o700)
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "broken\n"}, {"FAKE_NO_CHANGE": "1"}], rounds=1
        )
        self.assertEqual((code, result["status"], result["run_delta"]["changed_paths"]), (20, "no_changes", []))
        self.assertEqual(
            (result["auto_correct"]["stop_reason"], result["auto_correct"]["converted_from"]), ("no_changes", None)
        )

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
        self.assertIn(AUTO_CORRECT.BLOCKED_GUIDANCE, runs[1]["stdin"])

    def test_gate_files_reached_through_cd_shells_symlinks_and_ignored_programs_are_protected(self) -> None:
        shapes = (
            (
                "cd",
                {"allowed/gate/check.sh": "grep -qx fixed ../output.txt\n"},
                "cd allowed/gate && sh check.sh",
                "allowed/gate/check.sh",
            ),
            ("sh -c", {"allowed/check.sh": f"{GATE}\n"}, "sh -c 'sh allowed/check.sh'", "allowed/check.sh"),
            ("symlink", {"allowed/real-check.sh": f"{GATE}\n"}, "sh allowed/check.sh", "allowed/real-check.sh"),
            ("ignored program", {".gitignore": "plans/\n.venv/\n"}, "./.venv/bin/check", ".venv/bin/check"),
            # A newline separates commands; a prefix's option values are not the program.
            ("after a newline", {".gitignore": "plans/\n.venv/\n"}, "set -e\n.venv/bin/check", ".venv/bin/check"),
            ("after env -u", {".gitignore": "plans/\n.venv/\n"}, "env -u FOO .venv/bin/check", ".venv/bin/check"),
            ("after timeout", {".gitignore": "plans/\n.venv/\n"}, "timeout 30 .venv/bin/check", ".venv/bin/check"),
            (
                "cd on a later line",
                {"allowed/d1/a.sh": "exit 0\n", "allowed/d2/b.sh": "grep -qx fixed ../output.txt\n"},
                "cd allowed/d1\ncd ../d2\nsh b.sh",
                "allowed/d2/b.sh",
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
                if ".venv/" in files.get(".gitignore", ""):
                    program = self.fixture.repository.path / ".venv/bin/check"
                    program.parent.mkdir(parents=True)
                    program.write_text(f"#!/bin/sh\n{GATE}\n")
                    program.chmod(0o755)
                code, result, _out, _summary, runs = self.run_rounds(
                    [{"FAKE_CONTENT": "broken\n"}, {"FAKE_OUTPUT": edited, "FAKE_CONTENT": "exit 0\n"}],
                    rounds=1,
                    verify=[gate],
                )
                self.assertEqual((code, result["status"], len(runs)), (22, "scope_violation", 2))
                self.assertEqual(result["scope_violations"], [f"gate-edit:{edited}"])
                self.assertEqual(result["auto_correct"]["stop_reason"], "gate_files_changed")

    def test_files_a_glob_matches_stay_editable(self) -> None:
        self.commit({"allowed/b.txt": "needs-update\n"})
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "x\n"}, {"FAKE_OUTPUT": "allowed/b.txt", "FAKE_CONTENT": "done\n"}],
            rounds=1,
            verify=["! grep -q needs-update allowed/*.txt"],
        )
        self.assertEqual((code, result["status"], len(runs)), (0, "completed", 2))
        self.assertEqual(result["auto_correct"]["rounds"][0]["gate_files"], [])

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

    def test_files_a_gate_only_reads_or_writes_stay_editable(self) -> None:
        # Argon N1: a `-c` that is no shell's, an ignored log reached through a symlink, and a file a later
        # subshell's cd does not reach. None is a gate file, so the worker's fix to each stands.
        cases = (
            ("wc -c", "grep -x fixed allowed/output.txt > build/gate.log && wc -c build/gate.log"),
            ("symlinked log", "grep -x fixed allowed/output.txt > build/latest.log"),
        )
        for name, gate in cases:
            with self.subTest(name):
                self.fixture.tearDown()
                self.fixture.setUp()
                self.commit({".gitignore": "plans/\nbuild/\n", "build/.keep": ""})
                (self.fixture.repository.path / "build/gate.log").write_text("stale\n")
                os.symlink("gate.log", self.fixture.repository.path / "build/latest.log")
                self.rerun_gate_after_each_round(gate)
                code, result, _out, _summary, runs = self.run_rounds(
                    [{"FAKE_CONTENT": "broken\n"}, {"FAKE_CONTENT": "fixed\n"}], rounds=1, verify=[gate]
                )
                self.assertEqual((code, result["status"], len(runs)), (0, "completed", 2), result["scope_violations"])
                self.assertEqual(result["auto_correct"]["rounds"][0]["gate_files"], [])
        self.fixture.tearDown()
        self.fixture.setUp()
        self.commit(
            {
                "allowed/build.sh": "exit 0\n",
                "allowed/check.sh": "broken\n",
                "gate/check.sh": "grep -qx fixed ../allowed/check.sh\n",
            }
        )
        code, result, _out, _summary, runs = self.run_rounds(
            [
                {"FAKE_OUTPUT": "allowed/build.sh", "FAKE_CONTENT": "# built\nexit 0\n"},
                {"FAKE_OUTPUT": "allowed/check.sh", "FAKE_CONTENT": "fixed\n"},
            ],
            rounds=1,
            verify=["(cd allowed && sh build.sh) && (cd gate && sh check.sh)"],
        )
        self.assertEqual((code, result["status"], len(runs)), (0, "completed", 2), result["scope_violations"])
        # allowed/build.sh is a gate script the run itself changed, so it is the work under test.
        self.assertEqual(result["auto_correct"]["gate_candidates"], ["allowed/build.sh", "gate/check.sh"])
        self.assertEqual(result["auto_correct"]["rounds"][0]["gate_files"], ["gate/check.sh"])

    def test_retargeting_a_symlinked_directory_on_the_way_to_a_gate_fails_the_run(self) -> None:
        # Argon N2: `sh allowed/dir-link/check.sh` also depends on the link; pointing it at a passing copy
        # changes the gate without touching the script it used to run.
        self.commit({"allowed/real-dir/check.sh": f"{GATE}\n", "allowed/pass-dir/check.sh": "exit 0\n"})
        os.symlink("real-dir", self.fixture.repository.path / "allowed/dir-link")
        self.fixture.repository.git("add", "allowed/dir-link")
        self.fixture.repository.git("commit", "-qm", "link")
        fake = self.fixture.external_path / "codex"
        fake.rename(self.fixture.external_path / "codex-real")
        fake.write_text(
            "#!/bin/sh\n"
            '"$(dirname "$0")/codex-real" "$@"; status=$?\n'
            'if [ "$1" = exec ] && [ "$2" = resume ]; then ln -snf pass-dir allowed/dir-link; fi\n'
            'exit "$status"\n'
        )
        fake.chmod(0o700)
        code, result, _out, _summary, runs = self.run_rounds(
            [{"FAKE_CONTENT": "broken\n"}, {"FAKE_NO_CHANGE": "1"}], rounds=1, verify=["sh allowed/dir-link/check.sh"]
        )
        self.assertEqual((code, result["status"], len(runs)), (22, "scope_violation", 2))
        self.assertEqual(result["scope_violations"], ["gate-edit:allowed/dir-link"])
        self.assertEqual(
            result["auto_correct"]["rounds"][0]["gate_files"], ["allowed/dir-link", "allowed/real-dir/check.sh"]
        )

    def test_protect_paths_keep_a_round_off_files_the_gates_only_read(self) -> None:
        gate = "cmp -s allowed/expected.txt allowed/output.txt"
        broken = {"FAKE_CONTENT": "broken\n"}
        weaken = {"FAKE_OUTPUT": "allowed/expected.txt", "FAKE_CONTENT": "broken\n"}
        # A file the gate reads, a test file named as an argument, stays fixable unless it is listed.
        self.commit({"allowed/expected.txt": "fixed\n"})
        code, result, _out, _summary, runs = self.run_rounds([broken, weaken], rounds=1, verify=[gate])
        self.assertEqual((code, result["status"]), (0, "completed"))
        self.assertEqual(result["auto_correct"]["protect_paths"], [])
        for name, arguments, spec in (
            ("cli", ["--protect-path", "allowed/expected.txt"], None),
            ("task spec", [], self.task_spec(protect_paths=["allowed/expected.txt"])),
        ):
            with self.subTest(name):
                self.fixture.repository.git("checkout", "-q", "--", ".")
                self.reset()
                code, result, _out, _summary, runs = self.run_rounds(
                    [broken, weaken], rounds=1, verify=[gate], extra_args=arguments, task_spec=spec
                )
                self.assertEqual((code, result["status"]), (22, "scope_violation"))
                self.assertEqual(result["scope_violations"], ["gate-edit:allowed/expected.txt"])
                record = result["auto_correct"]
                self.assertEqual(
                    (record["protect_paths"], record["stop_reason"]), (["allowed/expected.txt"], "gate_files_changed")
                )
                self.assertIn("Do not change the gate's own files: allowed/expected.txt.", runs[1]["stdin"])

    def test_protect_paths_hold_for_ignored_files_directories_and_files_the_run_changed(self) -> None:
        cases = (
            # An ignored file outside the allowed paths: scope cannot see it, the protection can.
            (
                "ignored",
                "build/expected.txt",
                "cmp -s build/expected.txt allowed/output.txt",
                [{"FAKE_CONTENT": "broken\n"}, {"FAKE_OUTPUT": "build/expected.txt", "FAKE_CONTENT": "broken\n"}],
                "build/expected.txt",
            ),
            # A new file under a protected directory changes the directory.
            (
                "directory",
                "allowed/fixtures",
                GATE,
                [{"FAKE_CONTENT": "broken\n"}, {"FAKE_OUTPUT": "allowed/fixtures/new.txt", "FAKE_CONTENT": "x\n"}],
                "allowed/fixtures",
            ),
            # The first handoff changed it, which would release a derived gate file, not a listed one.
            (
                "changed by the run",
                "allowed/output.txt",
                GATE,
                [{"FAKE_CONTENT": "broken\n"}, {"FAKE_CONTENT": "fixed\n"}],
                "allowed/output.txt",
            ),
        )
        for name, protect, gate, rounds, edited in cases:
            with self.subTest(name):
                self.fixture.tearDown()
                self.fixture.setUp()
                self.commit({".gitignore": "plans/\nbuild/\n", "allowed/fixtures/a.txt": "a\n"})
                (self.fixture.repository.path / "build").mkdir()
                (self.fixture.repository.path / "build/expected.txt").write_text("fixed\n")
                code, result, _out, _summary, runs = self.run_rounds(
                    rounds, rounds=1, verify=[gate], extra_args=["--protect-path", protect]
                )
                expected_turns = 1 if name == "changed by the run" else 2
                self.assertEqual((code, result["status"], len(runs)), (22, "scope_violation", expected_turns))
                self.assertEqual(result["scope_violations"], [f"gate-edit:{edited}"])

    def test_a_resumed_run_can_judge_its_changes_from_where_the_task_began(self) -> None:
        for arguments, message in (
            (["--expect-task-changes"], "requires --expect-changes and --resume-result"),
            (["--expect-task-changes", "--session", "s"], "requires --expect-changes and --resume-result"),
        ):
            with self.subTest(arguments=arguments), self.assertRaisesRegex(RUNNER.RunnerError, message):
                self.fixture.run_main(verify_commands=[GATE], extra_args=arguments)
        # The first run leaves the fix in place but fails its report.
        code, first, first_dir, _summary, _capture = self.fixture.run_main(
            verify_commands=[GATE], report_status="FAILED", extra_env={"FAKE_CONTENT": "fixed\n"}
        )
        self.assertEqual((code, first["status"]), (1, "failed"))
        resume = ["--resume-result", str(first_dir / "result.json")]
        # Judged from its own start, a turn that changes nothing has no changes.
        code, plain, _out, _summary, _capture = self.fixture.run_main(
            verify_commands=[GATE], no_change=True, session=first["session_id"], extra_args=resume
        )
        self.assertEqual((code, plain["status"]), (20, "no_changes"))
        self.assertEqual(plain["task_git_before"], first["git_before"])
        # Judged from where the task began, the earlier fix counts: the turn completes once the gates pass.
        code, task, task_dir, _summary, _capture = self.fixture.run_main(
            verify_commands=[GATE],
            no_change=True,
            session=first["session_id"],
            extra_args=[*resume, "--expect-task-changes"],
        )
        self.assertEqual((code, task["status"]), (0, "completed"))
        self.assertEqual(task["task_git_before"], first["git_before"])
        self.assertEqual((task["workspace_changed"], task["task_workspace_changed"]), (False, True))
        # A later resume keeps the task's first snapshot, so undoing the work ends no_changes.
        fake = self.fixture.external_path / "codex"
        fake.rename(self.fixture.external_path / "codex-real")
        fake.write_text(
            "#!/bin/sh\n"
            '"$(dirname "$0")/codex-real" "$@"; status=$?\n'
            'if [ "$1" = exec ] && [ "$2" = resume ]; then rm -rf allowed; fi\n'
            'exit "$status"\n'
        )
        fake.chmod(0o700)
        code, undone, _out, _summary, _capture = self.fixture.run_main(
            verify_commands=[GATE],
            no_change=True,
            session=first["session_id"],
            extra_args=["--resume-result", str(task_dir / "result.json"), "--expect-task-changes"],
        )
        self.assertEqual((code, undone["status"]), (20, "no_changes"))
        self.assertEqual(undone["task_git_before"], first["git_before"])
        self.assertEqual((undone["workspace_changed"], undone["task_workspace_changed"]), (True, False))


if __name__ == "__main__":
    unittest.main()
