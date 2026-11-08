"""Regression coverage for the protection boundaries found by the PR 128 review."""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest import mock

import test_coordination as coordination
import test_run_agent as fixtures

RUNNER = fixtures.RUNNER
CORRECTOR = RUNNER.bundled_module("auto_correct")


def seed(fixture, files):
    for path, content in files.items():
        fixture.repository.write(path, content)
        fixture.repository.git("add", "-f", path)
    fixture.repository.git("commit", "-qm", "protection setup")


def rounds_env(fixture, contents):
    return {
        "FAKE_ROUNDS": json.dumps(contents),
        "FAKE_ROUNDS_COUNT": str(fixture.external_path / "round-count.txt"),
    }


def edit(path, content):
    return {"FAKE_OUTPUT": path, "FAKE_CONTENT": content}


class ProtectionRunnerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.RunnerIntegrationTests()
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()

    def test_parent_and_root_links_do_not_widen_directory_protection(self):
        f = self.fixture
        seed(f, {"allowed/gates/check.sh": "exit 0\n", "allowed/work/v1/data.txt": "broken\n"})
        root = f.repository.path
        (root / "allowed/gates/up").symlink_to("..")
        (root / "allowed/gates/root_link").symlink_to("../..")
        (root / "allowed/work/current").symlink_to("v1")
        f.repository.git("add", "allowed")
        f.repository.git("commit", "-qm", "ancestor links")
        self.assertEqual(
            CORRECTOR.protected_paths(["allowed/gates"], root),
            ["allowed/gates", "allowed/gates/root_link", "allowed/gates/up"],
        )
        code, result, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=["sh allowed/gates/check.sh"],
            extra_args=["--auto-correct", "1", "--protect-path", "allowed/gates"],
            extra_env=edit("allowed/work/v1/data.txt", "fixed\n"),
        )
        self.assertEqual((code, result["status"], result["scope_violations"]), (0, "completed", []))

    def test_released_children_can_create_or_remove_directory_shells(self):
        root = self.fixture.repository.path
        for case in ("create", "remove", "missing"):
            with self.subTest(case=case):
                gate = root / case
                child = gate / "sub/child.txt"
                if case != "missing":
                    gate.mkdir()
                    (gate / "keep.txt").write_text("keep\n")
                if case == "remove":
                    child.parent.mkdir()
                    child.write_text("old\n")
                baseline = RUNNER.gate_fingerprint(gate)
                if case == "remove":
                    child.parent.rename(root / "removed-sub")
                else:
                    child.parent.mkdir(parents=True)
                    child.write_text("new\n")
                self.assertFalse(RUNNER.gate_changed(gate, baseline, releases=[child]))
                self.assertTrue(RUNNER.gate_changed(gate, baseline, releases=[]))
                (gate / "keep.txt").write_text("tampered\n")
                self.assertTrue(RUNNER.gate_changed(gate, baseline, releases=[child]))

    def test_resumed_releases_never_follow_a_released_link_to_its_gate(self):
        f = self.fixture
        for source in ("legacy", "zero-round"):
            with self.subTest(source=source):
                prefix = f"allowed/{source}"
                seed(f, {f"{prefix}/real-check.sh": "exit 1\n"})
                (f.repository.path / prefix / "check.sh").symlink_to("real-check.sh")
                f.repository.git("add", prefix)
                f.repository.git("commit", "-qm", "resume link")
                _, first, folder, *_ = f.run_main(
                    engine="codex",
                    allow_path="allowed",
                    verify_commands=[f"sh {prefix}/check.sh"],
                    extra_args=["--auto-correct", "1" if source == "legacy" else "0"],
                    extra_env={"FAKE_NO_CHANGE": "1"},
                )
                if source == "legacy":
                    first["auto_correct"]["released_paths"] = [f"{prefix}/check.sh"]
                else:
                    first["steering"] = {
                        "steers": [{"status": "accepted", "added_allow_paths": [f"{prefix}/check.sh"]}]
                    }
                (folder / "result.json").write_text(json.dumps(first))
                code, result, *_ = f.run_main(
                    engine="codex",
                    allow_path="allowed",
                    verify_commands=[f"sh {prefix}/check.sh"],
                    extra_args=[
                        "--session",
                        first["session_id"],
                        "--resume-result",
                        str(folder / "result.json"),
                        "--auto-correct",
                        "1",
                    ],
                    extra_env=edit(f"{prefix}/real-check.sh", "exit 0\n"),
                )
                self.assertEqual((code, result["status"]), (22, "scope_violation"))
                self.assertEqual(result["scope_violations"], [f"gate-edit:{prefix}/real-check.sh"])
                self.assertEqual(result["auto_correct"]["released_paths"], [f"{prefix}/check.sh"])

    def test_protected_directory_records_nested_symlink_targets(self):
        f = self.fixture
        seed(f, {"allowed/real-check.sh": "exit 1\n", "allowed/output.txt": "broken\n"})
        gates = f.repository.path / "allowed/gates/nested"
        gates.mkdir(parents=True)
        (gates / "check.sh").symlink_to("../../real-check.sh")
        f.repository.git("add", "allowed/gates")
        f.repository.git("commit", "-qm", "nested symlink")
        code, result, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=['eval "sh allowed/gates/nested/check.sh"'],
            extra_args=["--auto-correct", "1", "--protect-path", "allowed/gates"],
            extra_env=rounds_env(
                f, [edit("allowed/output.txt", "attempt\n"), edit("allowed/real-check.sh", "exit 0\n")]
            ),
        )
        self.assertEqual((code, result["status"]), (22, "scope_violation"))
        self.assertIn("gate-edit:allowed/real-check.sh", result["scope_violations"])

    def test_intermediate_directory_symlink_is_protected(self):
        f = self.fixture
        seed(f, {"allowed/real/check.sh": "exit 1\n", "allowed/pass/check.sh": "exit 0\n"})
        (f.repository.path / "allowed/dir1").symlink_to("dir2")
        (f.repository.path / "allowed/dir2").symlink_to("real")
        f.repository.git("add", "allowed/dir1", "allowed/dir2")
        f.repository.git("commit", "-qm", "directory symlink chain")
        self.assertEqual(
            CORRECTOR.gate_paths(["sh allowed/dir1/check.sh"], f.repository.path),
            ["allowed/dir1", "allowed/dir2", "allowed/real/check.sh"],
        )
        executor = f.external_path / "codex"
        executor.rename(f.external_path / "codex-real")
        executor.write_text(
            '#!/bin/sh\n"$(dirname "$0")/codex-real" "$@"; rc=$?\n'
            'if [ "$1" = exec ] && [ "$2" = resume ]; then ln -snf pass allowed/dir2; fi\nexit $rc\n'
        )
        executor.chmod(0o755)
        code, result, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=["sh allowed/dir1/check.sh"],
            extra_args=["--auto-correct", "1"],
            extra_env=rounds_env(f, [edit("allowed/output.txt", "attempt\n"), {"FAKE_NO_CHANGE": "1"}]),
        )
        self.assertEqual((code, result["status"]), (22, "scope_violation"))
        self.assertEqual(result["scope_violations"], ["gate-edit:allowed/dir2"])

    def test_protected_file_changed_on_first_turn_fails_before_verification(self):
        f = self.fixture
        seed(f, {"allowed/expected.txt": "strict\n", "allowed/output.txt": "broken\n", "allowed/flag.txt": "no\n"})
        code, result, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=["cmp -s allowed/expected.txt allowed/output.txt && grep -qx yes allowed/flag.txt"],
            extra_args=["--auto-correct", "1", "--protect-path", "allowed/expected.txt"],
            extra_env=rounds_env(f, [edit("allowed/expected.txt", "broken\n"), edit("allowed/flag.txt", "yes\n")]),
        )
        self.assertEqual((code, result["status"]), (22, "scope_violation"))
        self.assertEqual(result["scope_violations"], ["gate-edit:allowed/expected.txt"])
        self.assertEqual(result["verification"]["status"], "skipped")

    def test_task_baseline_survives_resume_without_expect_task_changes(self):
        f = self.fixture
        seed(f, {"allowed/output.txt": "initial\n"})
        _, first, first_dir, *_ = f.run_main(
            engine="codex", allow_path="allowed", extra_env=edit("allowed/output.txt", "wip\n")
        )
        _, second, second_dir, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            extra_args=["--session", first["session_id"], "--resume-result", str(first_dir / "result.json")],
            extra_env=edit("allowed/output.txt", "initial\n"),
        )
        code, result, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            expect_changes=True,
            extra_args=[
                "--session",
                second["session_id"],
                "--resume-result",
                str(second_dir / "result.json"),
                "--expect-task-changes",
            ],
            extra_env={"FAKE_NO_CHANGE": "1"},
        )
        self.assertEqual((code, result["status"]), (20, "no_changes"))
        self.assertEqual(second["task_git_before"], first["git_before"])

    def test_protection_and_release_survive_resume_with_zero_rounds(self):
        f = self.fixture
        seed(
            f,
            {
                "allowed/output.txt": "initial\n",
                "allowed/expected.txt": "strict\n",
                "allowed/check.sh": "grep -qx fixed allowed/output.txt\n",
            },
        )
        _, first, first_dir, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=["sh allowed/check.sh"],
            extra_args=["--auto-correct", "1", "--protect-path", "allowed/expected.txt"],
            extra_env={"FAKE_NO_CHANGE": "1"},
        )
        # A prior audited steer released this gate. The intermediate run must carry that authority.
        first["auto_correct"]["released_paths"] = ["allowed/check.sh"]
        (first_dir / "result.json").write_text(json.dumps(first))
        _, second, second_dir, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=["sh allowed/check.sh"],
            extra_args=[
                "--session",
                first["session_id"],
                "--resume-result",
                str(first_dir / "result.json"),
                "--auto-correct",
                "0",
            ],
            extra_env=edit("allowed/output.txt", "broken\n"),
        )
        code, result, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=["sh allowed/check.sh"],
            extra_args=[
                "--session",
                second["session_id"],
                "--resume-result",
                str(second_dir / "result.json"),
                "--auto-correct",
                "1",
            ],
            extra_env=rounds_env(
                f, [edit("allowed/output.txt", "still-broken\n"), edit("allowed/check.sh", "exit 0\n")]
            ),
        )
        self.assertEqual((code, result["status"]), (0, "completed"))
        self.assertEqual(result["auto_correct"]["protect_paths"], ["allowed/expected.txt"])
        self.assertEqual(result["auto_correct"]["released_paths"], ["allowed/check.sh"])

    def test_process_substitution_does_not_turn_following_arguments_into_programs(self):
        f = self.fixture
        seed(f, {"allowed/helper.txt": "old\n", "allowed/output.txt": "wrong\n"})
        command = "bash -c 'diff -u <(printf \"fixed\\n\") allowed/output.txt'"
        code, result, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=[command],
            extra_args=["--auto-correct", "1"],
            extra_env=rounds_env(f, [edit("allowed/helper.txt", "new\n"), edit("allowed/output.txt", "fixed\n")]),
        )
        self.assertEqual((code, result["status"]), (0, "completed"))
        self.assertEqual(CORRECTOR.gate_paths([command], f.repository.path), [])
        seed(f, {"allowed/check.sh": "exit 0\n"})
        self.assertEqual(
            CORRECTOR.gate_paths(["diff <(sh allowed/check.sh) allowed/output.txt"], f.repository.path),
            ["allowed/check.sh"],
        )

    def test_syntax_check_flags_leave_the_input_editable(self):
        f = self.fixture
        seed(
            f,
            {
                "allowed/app.js": "const x = ;\n",
                "allowed/app.rb": "x = 1\n",
                "allowed/app.pl": "my $x = 1;\n",
                "allowed/helper.txt": "old\n",
            },
        )
        for command in (
            "node --check allowed/app.js",
            "node -c allowed/app.js",
            "ruby -c allowed/app.rb",
            "perl -c allowed/app.pl",
        ):
            with self.subTest(command=command):
                self.assertEqual(CORRECTOR.gate_paths([command], f.repository.path), [])
        code, result, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=["node --check allowed/app.js"],
            extra_args=["--auto-correct", "1"],
            extra_env=rounds_env(f, [edit("allowed/helper.txt", "new\n"), edit("allowed/app.js", "const x = 1;\n")]),
        )
        self.assertEqual((code, result["status"]), (0, "completed"))
        self.assertEqual(CORRECTOR.gate_paths(["node allowed/app.js"], f.repository.path), ["allowed/app.js"])

    def test_symlinked_parent_of_missing_or_directory_operand_is_not_a_gate(self):
        f = self.fixture
        seed(
            f,
            {
                "allowed/v1/placeholder.txt": "v1\n",
                "allowed/v2/generated.sh": "exit 0\n",
                "allowed/helper.txt": "old\n",
            },
        )
        (f.repository.path / "allowed/current").symlink_to("v1")
        f.repository.git("add", "allowed/current")
        f.repository.git("commit", "-qm", "symlink setup")
        command = "sh allowed/current/generated.sh"
        self.assertEqual(CORRECTOR.gate_paths([command, "node allowed/current"], f.repository.path), [])
        executor = f.external_path / "codex"
        executor.rename(f.external_path / "codex-real")
        executor.write_text(
            '#!/bin/sh\n"$(dirname "$0")/codex-real" "$@"; rc=$?\n'
            'if [ "$1" = exec ] && [ "$2" = resume ]; then ln -snf v2 allowed/current; fi\nexit $rc\n'
        )
        executor.chmod(0o755)
        code, result, *_ = f.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=[command],
            extra_args=["--auto-correct", "1"],
            extra_env=rounds_env(f, [edit("allowed/helper.txt", "new\n"), {"FAKE_NO_CHANGE": "1"}]),
        )
        self.assertEqual((code, result["status"]), (0, "completed"))


class ProtectionSteerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.SteerTests()
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()

    def steer(self, job, path, during_round=None):
        f = self.fixture
        self.assertTrue(f.wait_until(lambda: job["resume_started"].exists(), timeout=20))
        if during_round is not None:
            during_round()
        code, output = f.steer(job["event_id"], "Fix the named gate.", "--allow-path", path)
        self.assertEqual(code, 0)
        values = dict(line.split("=", 1) for line in output.splitlines() if line.startswith("AGENT_"))
        f.wait_event(values["AGENT_EVENT_ID"])
        self.steered_result_path = Path(values["AGENT_RESULT"])
        return json.loads(self.steered_result_path.read_text())

    def assert_check_stays_protected(self, released, *, command="sh allowed/check.sh", protect=(), plant=False):
        f = self.fixture
        seed(f, {"allowed/check.sh": "exit 1\n", "allowed/tests/one.txt": "old\n"})
        (f.repository.path / "allowed/gate_a.sh").symlink_to("check.sh")
        (f.repository.path / "allowed/tests/ref.sh").symlink_to("../check.sh")
        f.repository.git("add", "allowed")
        f.repository.git("commit", "-qm", "release links")
        job = f.launch_auto_correct(
            [edit("allowed/output.txt", "attempt\n"), edit("allowed/check.sh", "exit 0\n")],
            command,
            extra_args=tuple(arg for path in protect for arg in ("--protect-path", path)),
        )

        def plant_link():
            child = f.repository.path / "allowed/tests/one.txt"
            child.rename(f.external_path / "original-child")
            child.symlink_to("../check.sh")

        result = self.steer(job, released, plant_link if plant else None)
        self.assertEqual((result["exit_code"], result["status"]), (22, "scope_violation"))
        self.assertIn("gate-edit:allowed/check.sh", result["scope_violations"])
        self.assertNotIn("allowed/check.sh", result["auto_correct"]["released_paths"])

    def test_releasing_link_does_not_release_a_directly_named_gate(self):
        self.assert_check_stays_protected("allowed/gate_a.sh", command="sh allowed/gate_a.sh && sh allowed/check.sh")

    def test_releasing_link_does_not_release_an_explicit_protect_entry(self):
        self.assert_check_stays_protected(
            "allowed/gate_a.sh", command="sh allowed/gate_a.sh", protect=("allowed/check.sh",)
        )

    def test_releasing_directory_does_not_follow_its_inner_links(self):
        self.assert_check_stays_protected("allowed/tests", protect=("allowed/tests",))

    def test_worker_planted_link_cannot_release_the_check_program(self):
        self.assert_check_stays_protected("allowed/tests/one.txt", protect=("allowed/tests",), plant=True)

    def test_released_child_can_be_created_in_a_new_subdirectory(self):
        f = self.fixture
        seed(f, {"allowed/tests/keep.txt": "keep\n"})
        job = f.launch_auto_correct(
            [edit("allowed/output.txt", "attempt\n"), edit("allowed/tests/new/sub/child.txt", "fixed\n")],
            "grep -qx fixed allowed/tests/new/sub/child.txt",
            extra_args=("--protect-path", "allowed/tests"),
        )
        result = self.steer(job, "allowed/tests/new/sub/child.txt")
        self.assertEqual((result["exit_code"], result["status"], result["scope_violations"]), (0, "completed", []))

    def test_resume_keeps_a_worker_planted_link_release_lexical(self):
        f = self.fixture
        seed(f, {"allowed/tests/child.txt": "old\n", "allowed/target.txt": "work\n"})
        job = f.launch_auto_correct(
            [edit("allowed/output.txt", "attempt\n"), edit("allowed/target.txt", "fixed\n")],
            "grep -qx fixed allowed/target.txt",
            extra_args=("--protect-path", "allowed/tests"),
        )

        def plant_link():
            child = f.repository.path / "allowed/tests/child.txt"
            child.rename(f.external_path / "original-child")
            child.symlink_to("../target.txt")

        result = self.steer(job, "allowed/tests/child.txt", plant_link)
        self.assertEqual((result["exit_code"], result["status"]), (0, "completed"))
        self.assertEqual(result["auto_correct"]["released_paths"], ["allowed/tests/child.txt"])
        self.assertNotIn("gate_links", result["auto_correct"])
        runner = fixtures.RunnerIntegrationTests()
        runner.__dict__.update(f.__dict__)
        code, resumed, *_ = runner.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=["grep -qx fixed allowed/target.txt"],
            extra_args=[
                "--session",
                result["session_id"],
                "--resume-result",
                str(self.steered_result_path),
                "--protect-path",
                "allowed/tests",
            ],
            extra_env=edit("allowed/output.txt", "resumed\n"),
        )
        self.assertEqual((code, resumed["status"]), (0, "completed"), resumed.get("error"))
        self.assertEqual(resumed["auto_correct"]["released_paths"], ["allowed/tests/child.txt"])

    def test_release_of_one_child_keeps_siblings_protected_against_original_baseline(self):
        f = self.fixture
        seed(f, {"allowed/tests/one.txt": "old\n", "allowed/tests/two.txt": "keep\n"})
        job = f.launch_auto_correct(
            [edit("allowed/output.txt", "attempt\n"), edit("allowed/tests/one.txt", "fixed\n")],
            "grep -qx fixed allowed/tests/one.txt",
            extra_args=("--protect-path", "allowed/tests"),
        )
        result = self.steer(job, "allowed/tests/one.txt")
        self.assertEqual((result["exit_code"], result["status"], result["scope_violations"]), (0, "completed", []))
        # Carry the original baseline into a resume, where a sibling edit still fails.
        runner = fixtures.RunnerIntegrationTests()
        runner.__dict__.update(f.__dict__)
        code, resumed, *_ = runner.run_main(
            engine="codex",
            allow_path="allowed",
            verify_commands=["grep -qx fixed allowed/tests/one.txt"],
            extra_args=["--session", result["session_id"], "--resume-result", str(self.steered_result_path)],
            extra_env=edit("allowed/tests/two.txt", "weakened\n"),
        )
        self.assertEqual((code, resumed["status"]), (22, "scope_violation"), resumed.get("error"))
        self.assertEqual(resumed["scope_violations"], ["gate-edit:allowed/tests"])

    def test_releasing_a_symlink_gate_keeps_its_target_protected(self):
        f = self.fixture
        seed(f, {"allowed/real-check.sh": "exit 1\n"})
        (f.repository.path / "allowed/check.sh").symlink_to("real-check.sh")
        f.repository.git("add", "allowed/check.sh")
        f.repository.git("commit", "-qm", "symlink gate")
        job = f.launch_auto_correct(
            [edit("allowed/output.txt", "attempt\n"), edit("allowed/check.sh", "exit 0\n")],
            "sh allowed/check.sh",
        )
        result = self.steer(job, "allowed/check.sh")
        self.assertEqual(
            (result["exit_code"], result["status"], result["scope_violations"]),
            (22, "scope_violation", ["gate-edit:allowed/real-check.sh"]),
        )
        self.assertEqual(result["auto_correct"]["released_paths"], ["allowed/check.sh"])

    def test_retargeting_a_released_link_never_frees_its_old_target(self):
        f = self.fixture
        seed(f, {"allowed/real-check.sh": "exit 1\n", "allowed/pass-check.sh": "exit 0\n"})
        link = f.repository.path / "allowed/check.sh"
        link.symlink_to("real-check.sh")
        f.repository.git("add", "allowed/check.sh")
        f.repository.git("commit", "-qm", "symlink gate")
        job = f.launch_auto_correct(
            [edit("allowed/output.txt", "attempt\n"), edit("allowed/real-check.sh", "exit 0\n")],
            "sh allowed/check.sh",
        )

        def retarget():
            link.rename(f.external_path / "original-link")
            link.symlink_to("pass-check.sh")

        result = self.steer(job, "allowed/check.sh", retarget)
        self.assertEqual(
            (result["exit_code"], result["status"], result["scope_violations"]),
            (22, "scope_violation", ["gate-edit:allowed/real-check.sh"]),
        )
        self.assertEqual(result["auto_correct"]["released_paths"], ["allowed/check.sh"])


class ProtectionCoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.coordinator = coordination.CoordinatorTests()
        self.coordinator.setUp()
        self.fixture = self.coordinator.fixture

    def tearDown(self):
        self.coordinator.tearDown()

    def result(self, run):
        return coordination.COORDINATOR.read(Path(run["result_path"]))

    def test_native_resume_never_follows_saved_or_zero_round_released_links(self):
        for source in ("saved", "legacy", "zero-round"):
            with self.subTest(source=source):
                if source != "saved":
                    self.tearDown()
                    self.setUp()
                c, f = self.coordinator, self.fixture
                seed(f, {"allowed/real-check.sh": "exit 1\n"})
                (f.repository.path / "allowed/check.sh").symlink_to("real-check.sh")
                f.repository.git("add", "allowed/check.sh")
                f.repository.git("commit", "-qm", "native resume link")
                code, run = c.call(
                    "dispatch",
                    "--kind",
                    "implementation",
                    "--request-id",
                    "impl",
                    "--transport",
                    "native",
                    "--engine",
                    "claude",
                    "--model",
                    "claude-opus-4-6",
                    "--billing-mode",
                    "subscription",
                    "--verify-command",
                    "sh allowed/check.sh",
                    "--auto-correct",
                    "0" if source == "zero-round" else "1",
                )
                self.assertEqual(code, 0, run)
                code, finished = c.native_round(run, "impl", {}, "none", handle="session")
                self.assertEqual(code, 0, finished)
                first = self.result(finished)
                if source != "zero-round":
                    first["auto_correct"]["released_paths"] = ["allowed/check.sh"]
                else:
                    first["steering"] = {"steers": [{"status": "accepted", "added_allow_paths": ["allowed/check.sh"]}]}
                Path(finished["result_path"]).write_text(json.dumps(first))
                # Model an earlier runner's recorded result, including its collection digest.
                state = coordination.COORDINATOR.load(c.directory)
                recorded = next(item for item in state["runs"] if item["run_id"] == run["run_id"])
                coordination.COORDINATOR.import_result(recorded, state)
                coordination.COORDINATOR.save(c.directory, state)
                proof = c.reviewed_evidence()
                code, run = c.call(
                    "dispatch",
                    "--kind",
                    "correction",
                    "--transport",
                    "native",
                    "--request-id",
                    "corr",
                    "--review-id",
                    proof,
                    "--auto-correct",
                    "1",
                )
                self.assertEqual(code, 0, run)
                code, finished = c.native_round(
                    run, "corr", {"allowed/real-check.sh": "exit 0\n"}, "allowed/real-check.sh", handle="session"
                )
                result = self.result(finished)
                self.assertEqual((result["exit_code"], result["status"]), (22, "scope_violation"), (code, finished))
                self.assertEqual(result["scope_violations"], ["gate-edit:allowed/real-check.sh"])
                self.assertEqual(result["auto_correct"]["released_paths"], ["allowed/check.sh"])

    def test_executor_correction_protects_its_first_turn(self):
        c, f = self.coordinator, self.fixture
        seed(
            f,
            {
                "allowed/check.sh": "cmp -s allowed/expected.txt allowed/output.txt\n",
                "allowed/expected.txt": "strict\n",
            },
        )
        env = rounds_env(
            f,
            [
                edit("allowed/output.txt", "broken\n"),
                edit("allowed/output.txt", "still-broken\n"),
                edit("allowed/expected.txt", "still-broken\n"),
            ],
        )
        with mock.patch.dict(os.environ, env):
            code, _ = c.start(
                "impl",
                "implementation",
                "--verify-command",
                "sh allowed/check.sh",
                "--protect-path",
                "allowed/expected.txt",
                "--auto-correct",
                "1",
            )
        self.assertEqual(code, 0)
        proof = c.reviewed_evidence()
        with mock.patch.dict(os.environ, env):
            code, run = c.call("dispatch", "--kind", "correction", "--request-id", "corr", "--review-id", proof)
        self.assertEqual(code, 0)
        result = self.result(run)
        self.assertEqual((result["exit_code"], result["status"]), (22, "scope_violation"))
        self.assertEqual(result["scope_violations"], ["gate-edit:allowed/expected.txt"])

    def test_executor_correction_cannot_rewrite_an_inherited_gate_on_its_first_turn(self):
        c, f = self.coordinator, self.fixture
        seed(f, {"allowed/check.sh": "grep -qx fixed allowed/output.txt\n"})
        env = rounds_env(
            f,
            [
                edit("allowed/output.txt", "broken\n"),
                edit("allowed/output.txt", "still-broken\n"),
                edit("allowed/check.sh", "exit 0\n"),
            ],
        )
        with mock.patch.dict(os.environ, env):
            code, _ = c.start(
                "impl", "implementation", "--verify-command", "sh allowed/check.sh", "--auto-correct", "1"
            )
        self.assertEqual(code, 0)
        proof = c.reviewed_evidence()
        with mock.patch.dict(os.environ, env):
            code, run = c.call("dispatch", "--kind", "correction", "--request-id", "corr", "--review-id", proof)
        self.assertEqual(code, 0)
        result = self.result(run)
        self.assertEqual((result["exit_code"], result["status"]), (22, "scope_violation"))
        self.assertEqual(result["scope_violations"], ["gate-edit:allowed/check.sh"])
        self.assertEqual(result["verification"]["status"], "skipped")

    def test_native_correction_keeps_original_protected_baseline(self):
        c, f = self.coordinator, self.fixture
        seed(f, {"allowed/expected.txt": "strict\n", "allowed/output.txt": "broken\n", "allowed/flag.txt": "no\n"})
        code, run = c.call(
            "dispatch",
            "--kind",
            "implementation",
            "--request-id",
            "impl",
            "--transport",
            "native",
            "--engine",
            "claude",
            "--model",
            "claude-opus-4-6",
            "--billing-mode",
            "subscription",
            "--verify-command",
            "cmp -s allowed/expected.txt allowed/output.txt && grep -qx yes allowed/flag.txt",
            "--protect-path",
            "allowed/expected.txt",
            "--auto-correct",
            "1",
        )
        self.assertEqual(code, 0)
        _, finished = c.native_round(
            run, "impl", {"allowed/expected.txt": "broken\n"}, "allowed/expected.txt", handle="s"
        )
        proof = c.reviewed_evidence()
        code, run = c.call(
            "dispatch", "--kind", "correction", "--transport", "native", "--request-id", "corr", "--review-id", proof
        )
        self.assertEqual(code, 0)
        _, finished = c.native_round(run, "corr", {"allowed/flag.txt": "yes\n"}, "allowed/flag.txt", handle="s")
        result = self.result(finished)
        self.assertEqual((result["exit_code"], result["status"]), (22, "scope_violation"))
        self.assertEqual(result["scope_violations"], ["gate-edit:allowed/expected.txt"])

    def test_reverify_new_gate_is_protected_on_executor_and_native_correction(self):
        for transport in ("executor", "native"):
            with self.subTest(transport=transport):
                if transport == "native":
                    self.tearDown()
                    self.setUp()
                c, f = self.coordinator, self.fixture
                seed(
                    f,
                    {
                        "allowed/check_a.sh": "grep -qx fixed allowed/output.txt\n",
                        "allowed/check_b.sh": "grep -qx fixed allowed/output.txt\n",
                    },
                )
                env = rounds_env(
                    f,
                    [
                        edit("allowed/output.txt", "broken\n"),
                        edit("allowed/output.txt", "still-broken\n"),
                        edit("allowed/check_b.sh", "exit 0\n"),
                    ],
                )
                if transport == "native":
                    _, implementation = c.call(
                        "dispatch",
                        "--kind",
                        "implementation",
                        "--request-id",
                        "impl",
                        "--transport",
                        "native",
                        "--engine",
                        "claude",
                        "--model",
                        "claude-opus-4-6",
                        "--billing-mode",
                        "subscription",
                        "--verify-command",
                        "sh allowed/check_a.sh",
                        "--auto-correct",
                        "1",
                    )
                    _, implementation = c.native_round(
                        implementation, "impl", {"allowed/output.txt": "broken\n"}, "allowed/output.txt"
                    )
                else:
                    with mock.patch.dict(os.environ, env):
                        _, implementation = c.start(
                            "impl", "implementation", "--verify-command", "sh allowed/check_a.sh", "--auto-correct", "1"
                        )
                code, _ = c.call(
                    "reverify",
                    "--run-id",
                    implementation["run_id"],
                    "--request-id",
                    "rev",
                    "--verify-command",
                    "sh allowed/check_b.sh",
                    "--reason",
                    "switch gate",
                )
                self.assertEqual(code, 0)
                proof = c.reviewed_evidence()
                with mock.patch.dict(os.environ, env):
                    code, run = c.call(
                        "dispatch",
                        "--kind",
                        "correction",
                        "--request-id",
                        "corr",
                        "--review-id",
                        proof,
                        "--transport",
                        transport,
                    )
                self.assertEqual(code, 0)
                if transport == "native":
                    _, run = c.native_round(
                        run, "corr", {"allowed/check_b.sh": "exit 0\n"}, "allowed/check_b.sh", handle="impl-session"
                    )
                result = self.result(run)
                self.assertEqual((result["exit_code"], result["status"]), (22, "scope_violation"))
                self.assertEqual(
                    result["auto_correct"]["gate_candidates"], ["allowed/check_a.sh", "allowed/check_b.sh"]
                )
                self.assertEqual(result["scope_violations"], ["gate-edit:allowed/check_b.sh"])
