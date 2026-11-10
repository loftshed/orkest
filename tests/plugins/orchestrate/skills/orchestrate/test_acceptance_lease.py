"""Acceptance binds evidence and its saved decision to one real workspace lease."""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
SPEC = importlib.util.spec_from_file_location("acceptance_coordinator", SCRIPTS / "coordinator.py")
assert SPEC is not None and SPEC.loader is not None
COORDINATOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = COORDINATOR
SPEC.loader.exec_module(COORDINATOR)


class AcceptanceLeaseTests(unittest.TestCase):
    def setUp(self):
        # Deliberately retained: no TemporaryDirectory or teardown deletion.
        self.root = Path(tempfile.mkdtemp(prefix="ork-acceptance-retained-"))
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Acceptance Test")
        self.git("config", "user.email", "acceptance@example.invalid")
        (self.repo / "tracked.txt").write_text("verified content\n")
        self.git("add", ".")
        self.git("commit", "-m", "candidate")
        self.cache = self.root / "cache"
        self.directory = self.root / "task"
        self.directory.mkdir()
        self.result = {
            "status": "completed",
            "tracked_paths": [],
            "git_after": COORDINATOR.RUNNER.git_state(self.repo, []),
            "git_identity_after": COORDINATOR.RUNNER.git_identity(self.repo),
        }
        result_path = self.root / "result.json"
        result_path.write_text(json.dumps(self.result))
        self.run = {
            "run_id": "candidate-run",
            "kind": "implementation",
            "status": "finished",
            "result_path": str(result_path),
            "result_sha256": COORDINATOR.digest(result_path),
        }
        self.state = {
            "repository": str(self.repo),
            "task_spec": {"acceptance_criteria": ["verified"]},
            "evidence_policy": "host_receipts_required",
            "runs": [self.run],
            "decisions": [],
            "status": "reviewing",
        }
        self.args = argparse.Namespace(run_id="candidate-run", decision="accept", evidence=None, review_id="review")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, stderr=subprocess.PIPE, text=True).strip()

    def assert_locked(self):
        with self.assertRaisesRegex(ValueError, "another executor owns"):
            with COORDINATOR.SUPPORT.workspace_lease(self.repo, self.cache):
                self.fail("acceptance did not hold its workspace lease")

    def test_evidence_validation_and_save_hold_the_same_lease(self):
        observed = []
        original_save = COORDINATOR.save

        def receipt(*_args, **_kwargs):
            self.assert_locked()
            observed.append("evidence")
            return {"review_id": "review", "owner": "conductor"}

        def save(directory, state):
            self.assert_locked()
            observed.append("save")
            original_save(directory, state)

        with (
            mock.patch.object(COORDINATOR.RUNNER, "default_agent_cache_dir", return_value=self.cache),
            mock.patch.object(COORDINATOR.EVIDENCE, "receipt", side_effect=receipt),
            mock.patch.object(COORDINATOR, "save", side_effect=save),
            mock.patch.object(COORDINATOR, "index_work"),
        ):
            record = COORDINATOR.review(self.args, self.directory, self.state)
        self.assertEqual(observed, ["evidence", "save"])
        self.assertEqual(
            record["candidate"],
            {
                "fingerprint": self.result["git_after"]["fingerprint"],
                "git_identity": self.result["git_identity_after"],
            },
        )
        saved = json.loads((self.directory / "task.json").read_text())
        self.assertEqual(saved["status"], "accepted")
        self.assertEqual(saved["decisions"], [record])
        with COORDINATOR.SUPPORT.workspace_lease(self.repo, self.cache):
            pass

    def test_legacy_source_evidence_is_actually_validated_under_lease(self):
        self.state["evidence_policy"] = "legacy"
        artifact = self.root / "artifact.txt"
        artifact.write_text("observed verification")
        evidence = self.root / "evidence.json"
        evidence.write_text(
            json.dumps(
                {
                    "conclusion": "Candidate satisfies the criterion",
                    "criteria": ["verified"],
                    "versions": {"candidate": "one"},
                    "sources": [
                        {
                            "location": "local verification",
                            "component": "candidate",
                            "version": "one",
                            "retrieved_at": COORDINATOR.RUNNER.utc_now(),
                            "artifact": str(artifact),
                            "sha256": COORDINATOR.digest(artifact),
                        }
                    ],
                }
            )
        )
        self.args.evidence = evidence
        original_check = COORDINATOR.check_evidence

        def check(path):
            self.assert_locked()
            return original_check(path)

        with (
            mock.patch.object(COORDINATOR.RUNNER, "default_agent_cache_dir", return_value=self.cache),
            mock.patch.object(COORDINATOR, "check_evidence", side_effect=check),
            mock.patch.object(COORDINATOR, "index_work"),
        ):
            record = COORDINATOR.review(self.args, self.directory, self.state)
        saved = json.loads((self.directory / "task.json").read_text())
        self.assertEqual(saved["status"], "accepted")
        self.assertEqual(record["evidence"]["sha256"], COORDINATOR.digest(evidence))

    def test_workspace_change_during_evidence_validation_refuses_acceptance(self):
        def receipt(*_args, **_kwargs):
            self.assert_locked()
            # Leases are cooperative; a non-cooperating edit must still be detected.
            (self.repo / "tracked.txt").write_text("changed after verification\n")
            return {"review_id": "review", "owner": "conductor"}

        with (
            mock.patch.object(COORDINATOR.RUNNER, "default_agent_cache_dir", return_value=self.cache),
            mock.patch.object(COORDINATOR.EVIDENCE, "receipt", side_effect=receipt),
            mock.patch.object(COORDINATOR, "save") as save,
        ):
            with self.assertRaisesRegex(COORDINATOR.CoordinationError, "workspace changed"):
                COORDINATOR.review(self.args, self.directory, self.state)
        save.assert_not_called()
        self.assertEqual(self.state["status"], "reviewing")
        self.assertEqual(self.state["decisions"], [])


if __name__ == "__main__":
    unittest.main()
