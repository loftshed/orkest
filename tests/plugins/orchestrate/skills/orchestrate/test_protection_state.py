"""Unit coverage for the executor and native routes' shared protection-state builder."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import test_run_agent as fixtures

AUTO_CORRECT = fixtures.RUNNER.bundled_module("auto_correct")


class ProtectionStateTests(unittest.TestCase):
    def repository(self, directory: str, files: tuple[str, ...]) -> Path:
        repo = Path(os.path.realpath(directory))
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        for name in files:
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("content\n", encoding="utf-8")
        return repo

    def state(self, repo: Path, **overrides):
        values = {
            "repo": repo,
            "verify_commands": ["sh allowed/check.sh"],
            "protect_entries": [],
            "saved": {},
            "earlier_steers": [],
            "is_resume": False,
            "changed_paths_before_resume": set(),
            "gate_fingerprint": lambda path: f"fingerprint:{path.relative_to(repo).as_posix()}",
            "enforce_on_first_turn": True,
        }
        values.update(overrides)
        return AUTO_CORRECT.protection_state(**values)

    def test_first_turn_enforcement_differs_between_routes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = self.repository(directory, ("allowed/check.sh", "allowed/expected.txt"))
            executor = self.state(repo, protect_entries=["allowed/expected.txt"], enforce_on_first_turn=True)
            native = self.state(repo, protect_entries=["allowed/expected.txt"], enforce_on_first_turn=False)

        self.assertEqual(executor["gate_candidates"], ["allowed/check.sh"])
        self.assertEqual(executor["protect_paths"], ["allowed/expected.txt"])
        self.assertEqual(executor["gate_files"], ["allowed/expected.txt"])
        self.assertEqual(native["gate_candidates"], executor["gate_candidates"])
        self.assertEqual(native["protect_paths"], executor["protect_paths"])
        self.assertEqual(native["gate_files"], [])

    def test_resume_merges_saved_candidates_and_protection_and_reuses_fingerprints(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = self.repository(
                directory,
                (
                    "allowed/old-check.sh",
                    "allowed/check.sh",
                    "allowed/saved.txt",
                    "allowed/fresh.txt",
                ),
            )
            state = self.state(
                repo,
                protect_entries=["allowed/fresh.txt"],
                saved={
                    "gate_candidates": ["allowed/old-check.sh"],
                    "protect_paths": ["allowed/saved.txt"],
                    "protect_fingerprints": {"allowed/saved.txt": "saved-fingerprint"},
                },
                is_resume=True,
                gate_fingerprint=lambda path: f"current:{path.relative_to(repo).as_posix()}",
            )

        self.assertEqual(state["gate_candidates"], ["allowed/old-check.sh", "allowed/check.sh"])
        self.assertEqual(state["protect_paths"], ["allowed/saved.txt", "allowed/fresh.txt"])
        self.assertEqual(
            state["protect_fingerprints"],
            {
                "allowed/saved.txt": "saved-fingerprint",
                "allowed/fresh.txt": "current:allowed/fresh.txt",
            },
        )
        self.assertEqual(
            state["gate_files"],
            ["allowed/old-check.sh", "allowed/check.sh", "allowed/saved.txt", "allowed/fresh.txt"],
        )

    def test_changed_before_resume_candidates_are_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = self.repository(directory, ("allowed/check.sh", "allowed/old-check.sh"))
            state = self.state(
                repo,
                saved={"gate_candidates": ["allowed/old-check.sh"]},
                is_resume=True,
                changed_paths_before_resume={"allowed/check.sh", "allowed/old-check.sh"},
            )

        self.assertEqual(state["gate_candidates"], [])
        self.assertEqual(state["gate_files"], [])

    def test_fresh_entries_covered_by_saved_protection_are_not_reexpanded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = self.repository(directory, ("allowed/protected/child.txt",))
            state = self.state(
                repo,
                protect_entries=["allowed/protected/child.txt"],
                saved={
                    "protect_paths": ["allowed/protected"],
                    "protect_fingerprints": {"allowed/protected": "saved-directory-fingerprint"},
                },
                is_resume=True,
            )

        self.assertEqual(state["protect_paths"], ["allowed/protected"])
        self.assertEqual(state["protect_fingerprints"], {"allowed/protected": "saved-directory-fingerprint"})

    def test_saved_and_earlier_steer_releases_are_preserved_and_excluded_from_gates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = self.repository(directory, ("allowed/check.sh", "allowed/old-check.sh"))
            state = self.state(
                repo,
                saved={
                    "gate_candidates": ["allowed/old-check.sh"],
                    "released_paths": ["allowed/old-check.sh"],
                },
                earlier_steers=[{"added_allow_paths": ["allowed/check.sh"]}],
                is_resume=True,
            )

        self.assertEqual(state["released_paths"], ["allowed/old-check.sh", "allowed/check.sh"])
        self.assertEqual(state["gate_candidates"], ["allowed/old-check.sh", "allowed/check.sh"])
        self.assertEqual(state["gate_files"], [])


if __name__ == "__main__":
    unittest.main()
