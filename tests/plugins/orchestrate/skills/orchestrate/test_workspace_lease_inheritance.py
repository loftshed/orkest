"""Real runner/consultant inheritance; scratch repositories and artifacts are retained."""

from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
SPEC = importlib.util.spec_from_file_location("inheritance_support", SCRIPTS / "execution_support.py")
support = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(support)


class WorkspaceLeaseInheritanceTests(unittest.TestCase):
    def fixture(self):
        root = Path(tempfile.mkdtemp(prefix="orkest-inherited-lease-"))
        repo = root / "repo"
        repo.mkdir()
        for args in (
            ["init", "-b", "main"],
            ["config", "user.name", "Lease Test"],
            ["config", "user.email", "lease@example.invalid"],
        ):
            subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
        (repo / "tracked.txt").write_text("retained\n", encoding="utf-8")
        subprocess.run(["git", "add", "tracked.txt"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True)
        cache = root / "cache"
        for name in ("orchestrate", "agent-executor"):
            (cache / name / "worktree-locks-v1").mkdir(parents=True)
        home = root / "home"
        home.mkdir()
        binary = root / "bin"
        binary.mkdir()
        executor = binary / "claude"
        executor.write_text(
            f"#!{sys.executable}\n"
            "import json, os, pathlib, sys, time\n"
            "if '--version' in sys.argv:\n"
            "    print('claude fixture 1.0')\n"
            "    sys.exit(0)\n"
            "if '--help' in sys.argv:\n"
            "    print('  --effort <level> (low, medium, high, xhigh, max)')\n"
            "    sys.exit(0)\n"
            "sys.stdin.read()\n"
            "root = pathlib.Path(os.environ['LEASE_FIXTURE_ROOT'])\n"
            "(root / 'started').write_text(json.dumps({'pid': os.getpid()}))\n"
            "while not (root / 'release').exists(): time.sleep(0.01)\n"
            "(root / 'exited').write_text('executor exiting')\n"
            "print(json.dumps({'type':'result','subtype':'success','result':'FINDINGS: none'}))\n",
            encoding="utf-8",
        )
        executor.chmod(0o700)
        env = {
            **os.environ,
            "HOME": str(home),
            "XDG_CACHE_HOME": str(cache),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "AGENT_EXECUTOR_CONFIG": str(root / "absent-config.json"),
            "MONITOR_BIN": str(root / "absent-monitor"),
            "PATH": f"{binary}{os.pathsep}{os.environ['PATH']}",
            "LEASE_FIXTURE_ROOT": str(root),
        }
        for name in ("ORCHESTRATE_HOME", "AGENT_EXECUTOR_HOME", "AGENT_MAILBOX_SESSION", "AGENT_MAILBOX_PEER"):
            env.pop(name, None)
        return root, repo, cache, env

    def wait_file(self, path, runner):
        deadline = time.monotonic() + 15
        while not path.exists():
            if runner.poll() is not None:
                stdout, stderr = runner.communicate()
                self.fail(f"runner exited {runner.returncode} before executor: {stdout}\n{stderr}")
            if time.monotonic() > deadline:
                self.fail("test executor did not announce startup")
            time.sleep(0.01)

    def run_inheritance_case(self, consultation):
        root, repo, cache, env = self.fixture()
        brief = root / "brief.md"
        brief.write_text("Inspect the retained fixture.\n", encoding="utf-8")
        # Call the actual main()/execute() launch path. Disable only automatic cache pruning;
        # a test must never invoke a cleanup policy against any fixture or live cache.
        harness = (
            "import importlib.util, sys\n"
            "spec=importlib.util.spec_from_file_location('lease_test_runner',sys.argv[1])\n"
            "runner=importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)\n"
            "runner.auto_prune=lambda: None\n"
            "sys.argv=[sys.argv[1],*sys.argv[2:]]\n"
            "sys.exit(runner.main())\n"
        )
        if consultation:
            arguments = [
                "consult",
                "--read",
                str(repo),
                "--intent",
                "review",
                "--question",
                "Review this fixture.",
                "--engine",
                "claude",
                "--model",
                "sonnet",
                "--transport",
                "executor",
                "--allow-credits",
            ]
        else:
            arguments = [
                "--cwd",
                str(repo),
                "--brief",
                str(brief),
                "--allow-path",
                "tracked.txt",
                "--engine",
                "claude",
                "--model",
                "sonnet",
                "--transport",
                "executor",
                "--ignore-quota",
                "--heartbeat-seconds",
                "0",
                "--out-dir",
                str(root / "artifacts"),
            ]
        runner = subprocess.Popen(
            [sys.executable, "-B", "-c", harness, str(SCRIPTS / "run_agent.py"), *arguments],
            env=env,
            cwd=repo,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        executor_pid = None
        try:
            self.wait_file(root / "started", runner)
            executor_pid = json.loads((root / "started").read_text())["pid"]
            with patch.dict(os.environ, env, clear=True):
                if consultation:
                    with support.workspace_lease(repo, cache / "orchestrate", read_only=True):
                        pass  # The consultant holds shared ownership, so another reader coexists.
                with self.assertRaises(support.ContractError):
                    with support.workspace_lease(repo, cache / "orchestrate"):
                        self.fail("writer acquired during executor run")
                runner.kill()
                runner.communicate(timeout=5)
                # Only this test's executor is inspected/signalled. It survived its parent.
                os.kill(executor_pid, 0)
                with self.assertRaises(support.ContractError):
                    with support.workspace_lease(repo, cache / "agent-executor"):
                        self.fail("runner death released the executor's inherited lease")
                (root / "release").write_text("release\n", encoding="utf-8")
                deadline = time.monotonic() + 10
                while True:
                    try:
                        with support.workspace_lease(repo, cache / "orchestrate") as lease:
                            self.assertEqual(len(lease.descriptors), 2)
                        break
                    except support.ContractError:
                        if time.monotonic() > deadline:
                            self.fail("executor did not release its inherited lease on exit")
                        time.sleep(0.01)
                self.assertEqual((root / "exited").read_text(), "executor exiting")
        finally:
            (root / "release").write_text("release\n", encoding="utf-8")
            if runner.poll() is None:
                runner.kill()
            runner.communicate(timeout=5)
            # The normal path released the fake executor. A failed startup may still need a signal.
            if executor_pid is not None and not (root / "exited").exists():
                with contextlib.suppress(ProcessLookupError):
                    os.kill(executor_pid, signal.SIGKILL)

    def test_executor_keeps_all_leases_after_runner_sigkill(self):
        self.run_inheritance_case(False)

    def test_consultant_keeps_shared_leases_after_runner_sigkill(self):
        self.run_inheritance_case(True)


if __name__ == "__main__":
    unittest.main()
