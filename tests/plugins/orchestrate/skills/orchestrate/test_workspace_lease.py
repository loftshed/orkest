"""Lease contract tests. Real fixtures are deliberately retained, never deleted."""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
SPEC = importlib.util.spec_from_file_location("lease_support", SCRIPTS / "execution_support.py")
support = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(support)


class WorkspaceLeaseTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="orkest-python-lease-"))
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.primary = self.root / "orchestrate"
        self.legacy = self.root / "agent-executor"
        for root in (self.primary, self.legacy):
            (root / "worktree-locks-v1").mkdir(parents=True)
        self.environment = patch.dict(os.environ)
        self.environment.start()
        os.environ.pop("ORCHESTRATE_HOME", None)
        os.environ.pop("AGENT_EXECUTOR_HOME", None)
        self.addCleanup(self.environment.stop)

    def test_sorted_multi_root_descriptors_keep_integer_api(self):
        with support.workspace_lease(self.workspace, self.primary) as lease:
            self.assertIsInstance(lease, int)
            self.assertEqual(len(lease.descriptors), 2)
            self.assertEqual(lease, lease.descriptors[0])
            self.assertFalse(any(os.get_inheritable(fd) for fd in lease.descriptors))
            roots = [str(Path(os.readlink(f"/proc/self/fd/{fd}")).parents[1]) for fd in lease.descriptors]
            self.assertEqual(roots, [str(self.legacy), str(self.primary)])
        with support.workspace_lease(self.workspace, self.legacy) as lease:
            self.assertEqual(len(lease.descriptors), 2)

    def test_partial_failure_closes_previous_descriptors_and_preserves_files(self):
        os.environ["ORCHESTRATE_HOME"] = str(self.primary)
        with support.workspace_lease(self.workspace, self.primary):
            os.environ.pop("ORCHESTRATE_HOME")
            with self.assertRaises(support.ContractError):
                with support.workspace_lease(self.workspace, self.legacy):
                    self.fail("writer acquired twice")
            os.environ["ORCHESTRATE_HOME"] = str(self.legacy)
            with support.workspace_lease(self.workspace, self.legacy) as lease:
                self.assertEqual(len(lease.descriptors), 1)
        self.assertEqual(len(list((self.primary / "worktree-locks-v1").glob("*.lock"))), 1)
        self.assertEqual(len(list((self.legacy / "worktree-locks-v1").glob("*.lock"))), 1)

    def test_coordinator_namespace_bridges_roots_but_is_independent_of_workspace(self):
        with support.workspace_lease(self.workspace, self.primary / "coordinator-locks") as lease:
            self.assertEqual(len(lease.descriptors), 2)
            with self.assertRaises(support.ContractError):
                with support.workspace_lease(self.workspace, self.legacy / "coordinator-locks"):
                    self.fail("namespace acquired twice")
            with support.workspace_lease(self.workspace, self.primary) as workspace:
                self.assertEqual(len(workspace.descriptors), 2)

    def test_shared_readers_exclude_writer_with_alias(self):
        alias = self.root / "alias"
        alias.symlink_to(self.workspace, target_is_directory=True)
        with support.workspace_lease(self.workspace, self.primary, read_only=True):
            with support.workspace_lease(alias, self.legacy, read_only=True) as lease:
                self.assertEqual(len(lease.descriptors), 2)
                with self.assertRaises(support.ContractError):
                    with support.workspace_lease(alias, self.primary):
                        self.fail("writer acquired with readers")
        with support.workspace_lease(alias, self.primary) as lease:
            self.assertEqual(len(lease.descriptors), 2)


if __name__ == "__main__":
    unittest.main()
