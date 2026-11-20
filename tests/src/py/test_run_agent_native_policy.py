from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[3] / "src/py" / "run_agent.py"

os.environ["MONITOR_BIN"] = str(Path(__file__).parent / "no-monitor")
os.environ["AGENT_EXECUTOR_CONFIG"] = str(Path(tempfile.mkdtemp()) / "absent-config.json")
os.environ.pop("AGENT_EXECUTOR_HOME", None)
os.environ["XDG_CACHE_HOME"] = tempfile.mkdtemp()

SPEC = importlib.util.spec_from_file_location("agent_executor_runner_native_policy", SCRIPT)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class RunAgentNativePolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="run-agent-native-policy-")
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "native@example.test"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "Native Policy Test"], cwd=self.repo, check=True)
        (self.repo / "README.md").write_text("# repo\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-qm", "init"], cwd=self.repo, check=True)
        self.monitor_cfg = self.root / "monitor-config.json"
        self.brief = self.root / "brief.md"
        self.brief.write_text("Inspect policy behavior.\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_monitor_config(self, accounts: list[dict[str, object]]) -> None:
        self.monitor_cfg.write_text(json.dumps({"accounts": accounts}), encoding="utf-8")

    def _base_env(self, **extra: str) -> dict[str, str]:
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(self.home),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "AGENT_EXECUTOR_CONFIG": str(self.root / "absent-config.json"),
            "ORCHESTRATE_CONFIG": "",
            "MONITOR_CONFIG": str(self.monitor_cfg),
            "CLAUDECODE": "1",
        }
        for host_keys in RUNNER.HOST_MARKERS.values():
            for key in host_keys:
                env.setdefault(key, "")
        env["CLAUDECODE"] = "1"
        env.update(extra)
        return env

    def _write_policy(self, deny: list[str]) -> None:
        policy_dir = self.repo / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": deny}), encoding="utf-8")

    def _run_main(self, argv: list[str]) -> int:
        with mock.patch.object(sys, "argv", [str(SCRIPT), *argv]):
            return RUNNER.main()

    def test_native_handoff_checks_host_claude_config_dir_and_symlink_to_tagged_account(self) -> None:
        alt_dir = self.home / ".claude-alt"
        alt_dir.mkdir(parents=True, exist_ok=True)
        alt_link = self.home / ".claude-custom-alias"
        alt_link.symlink_to(alt_dir)
        self._write_monitor_config(
            [
                {
                    "id": "claude-default",
                    "provider": "claude",
                    "tags": ["work"],
                    "configDir": str(self.home / ".claude"),
                },
                {
                    "id": "claude-alt",
                    "provider": "claude",
                    "alias": "claude-alt",
                    "tags": ["personal", "client-a"],
                    "configDir": str(alt_dir),
                },
            ]
        )
        self._write_policy(["tag:client-a"])

        for env_dir in (alt_dir, alt_link):
            with self.subTest(claude_config_dir=str(env_dir)):
                env = self._base_env(CLAUDE_CONFIG_DIR=str(env_dir))
                with mock.patch.dict(os.environ, env, clear=True), self.assertRaises(RUNNER.RunnerError) as raised:
                    self._run_main(
                        [
                            "--cwd",
                            str(self.repo),
                            "--brief",
                            str(self.brief),
                            "--engine",
                            "claude",
                            "--transport",
                            "native",
                        ]
                    )
                self.assertEqual(raised.exception.exit_code, 2)
                self.assertIn("client-a", str(raised.exception))

                # Auto transport also fails closed when host is denied and ORCHESTRATE_AUTO_ACCOUNT is unset.
                with mock.patch.dict(os.environ, env, clear=True), self.assertRaises(RUNNER.RunnerError) as raised_auto:
                    self._run_main(
                        [
                            "--cwd",
                            str(self.repo),
                            "--brief",
                            str(self.brief),
                            "--engine",
                            "claude",
                        ]
                    )
                self.assertEqual(raised_auto.exception.exit_code, 2)
                self.assertIn("client-a", str(raised_auto.exception))

    def test_native_handoff_allows_alt_host_when_only_work_tag_is_denied(self) -> None:
        alt_dir = self.home / ".claude-alt"
        alt_dir.mkdir(parents=True, exist_ok=True)
        self._write_monitor_config(
            [
                {
                    "id": "claude-default",
                    "provider": "claude",
                    "tags": ["work"],
                    "configDir": str(self.home / ".claude"),
                },
                {
                    "id": "claude-alt",
                    "provider": "claude",
                    "alias": "claude-alt",
                    "tags": ["personal"],
                    "configDir": str(alt_dir),
                },
            ]
        )
        self._write_policy(["claude-work"])
        out_dir = self.root / "out-alt-ok"
        env = self._base_env(CLAUDE_CONFIG_DIR=str(alt_dir))
        stdout = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(stdout):
            code = self._run_main(
                [
                    "--cwd",
                    str(self.repo),
                    "--brief",
                    str(self.brief),
                    "--engine",
                    "claude",
                    "--transport",
                    "native",
                    "--out-dir",
                    str(out_dir),
                ]
            )
        self.assertEqual(code, 0)
        result = json.loads((out_dir / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "native_handoff")
        self.assertEqual(result["transport"], "native")

    def test_work_host_with_auto_account_refuses_explicit_native_and_selects_highest_quota_account(self) -> None:
        alt_low_dir = self.home / ".claude-alt-low"
        alt_high_dir = self.home / ".claude-alt-high"
        alt_low_dir.mkdir(parents=True, exist_ok=True)
        alt_high_dir.mkdir(parents=True, exist_ok=True)
        self._write_monitor_config(
            [
                {
                    "id": "claude-default",
                    "provider": "claude",
                    "tags": ["work"],
                    "configDir": str(self.home / ".claude"),
                },
                {
                    "id": "claude-alt-low",
                    "provider": "claude",
                    "alias": "claude-alt-low",
                    "tags": ["personal"],
                    "configDir": str(alt_low_dir),
                },
                {
                    "id": "claude-alt-high",
                    "provider": "claude",
                    "alias": "claude-alt-high",
                    "tags": ["personal"],
                    "configDir": str(alt_high_dir),
                },
            ]
        )
        fake_view = {
            "schema": "monitor.snapshot.v1",
            "accounts": [
                {"id": "claude-default", "provider": "claude", "configDir": str(self.home / ".claude")},
                {"id": "claude-alt-low", "provider": "claude", "configDir": str(alt_low_dir)},
                {"id": "claude-alt-high", "provider": "claude", "configDir": str(alt_high_dir)},
            ],
            "lanes": [
                {
                    "accountId": "claude-alt-low",
                    "poolId": "all",
                    "label": "Claude alt low",
                    "status": "available",
                    "availableNowPct": 40,
                    "surplusPts": 5,
                    "stale": False,
                },
                {
                    "accountId": "claude-alt-high",
                    "poolId": "all",
                    "label": "Claude alt high",
                    "status": "available",
                    "availableNowPct": 90,
                    "surplusPts": 45,
                    "stale": False,
                },
            ],
        }
        fake_monitor = self.root / "fake-monitor"
        fake_monitor.write_text(f"#!/bin/sh\ncat <<'EOF'\n{json.dumps(fake_view)}\nEOF\n", encoding="utf-8")
        fake_monitor.chmod(0o755)
        self._write_policy(["tag:work"])
        env = self._base_env(ORCHESTRATE_AUTO_ACCOUNT="1", MONITOR_BIN=str(fake_monitor))
        env.pop("CLAUDE_CONFIG_DIR", None)

        # 1. Explicit --transport native refuses instead of assigning another account to work host.
        with mock.patch.dict(os.environ, env, clear=True), self.assertRaises(RUNNER.RunnerError) as raised:
            self._run_main(
                [
                    "--cwd",
                    str(self.repo),
                    "--brief",
                    str(self.brief),
                    "--engine",
                    "claude",
                    "--transport",
                    "native",
                ]
            )
        self.assertEqual(raised.exception.exit_code, 4)
        self.assertIn("--transport executor", str(raised.exception))

        # 2. Direct native_handoff call also refuses profile switch without mutating args.claude_config_dir.
        args_direct = RUNNER.parse_args(
            [
                "--cwd",
                str(self.repo),
                "--brief",
                str(self.brief),
                "--engine",
                "claude",
            ]
        )
        with mock.patch.dict(os.environ, env, clear=True), self.assertRaises(RUNNER.RunnerError) as direct_err:
            RUNNER.native_handoff(args_direct, "claude")
        self.assertEqual(direct_err.exception.exit_code, 4)
        self.assertIsNone(args_direct.claude_config_dir)

        # 3. --transport auto switches cleanly to executor with highest-quota allowed configured account.
        captured_execute: dict[str, object] = {}

        def fake_execute(exec_args, *, lease=None):
            captured_execute["claude_config_dir"] = exec_args.claude_config_dir
            captured_execute["account_id"] = getattr(exec_args, "account_id", None)
            captured_execute["lease"] = lease
            return 0

        with (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(RUNNER, "auto_prune"),
            mock.patch.object(RUNNER, "execute", side_effect=fake_execute),
        ):
            code = self._run_main(
                [
                    "--cwd",
                    str(self.repo),
                    "--brief",
                    str(self.brief),
                    "--engine",
                    "claude",
                ]
            )
        self.assertEqual(code, 0)
        self.assertEqual(captured_execute["claude_config_dir"], alt_high_dir.resolve())
        self.assertEqual(captured_execute["account_id"], "claude-alt-high")

    def test_native_agy_policy_ignores_orkest_agy_account_home_and_rejects_switch(self) -> None:
        gemini_home = self.home / ".gemini"
        work_app = gemini_home / "antigravity-work"
        personal_app = gemini_home / "antigravity-personal"
        work_app.mkdir(parents=True, exist_ok=True)
        personal_app.mkdir(parents=True, exist_ok=True)
        self._write_monitor_config(
            [
                {
                    "id": "agy-work",
                    "provider": "antigravity",
                    "tags": ["work"],
                    "env": {"GEMINI_CLI_HOME": str(gemini_home), "ANTIGRAVITY_APP_DATA_DIR": str(work_app)},
                },
                {
                    "id": "agy-personal",
                    "provider": "antigravity",
                    "tags": ["personal"],
                    "env": {"GEMINI_CLI_HOME": str(gemini_home), "ANTIGRAVITY_APP_DATA_DIR": str(personal_app)},
                },
            ]
        )
        self._write_policy(["tag:work"])
        env = self._base_env(
            CLAUDECODE="",
            ANTIGRAVITY_CONVERSATION_ID="agy-conv-1",
            GEMINI_CLI_HOME=str(gemini_home),
            ANTIGRAVITY_APP_DATA_DIR=str(work_app),
            ORKEST_AGY_ACCOUNT_HOME=str(personal_app),
        )
        with mock.patch.object(Path, "home", return_value=self.home), mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RUNNER.RunnerError) as raised:
                self._run_main(
                    [
                        "--cwd",
                        str(self.repo),
                        "--brief",
                        str(self.brief),
                        "--engine",
                        "agy",
                        "--model",
                        "gemini-3.8-flash-medium",
                        "--transport",
                        "native",
                    ]
                )
            self.assertEqual(raised.exception.exit_code, 4)

            captured_execute: dict[str, object] = {}

            def fake_execute(exec_args, *, lease=None):
                captured_execute["effective_agy_app_data_dir"] = getattr(exec_args, "effective_agy_app_data_dir", None)
                captured_execute["account_id"] = getattr(exec_args, "account_id", None)
                return 0

            with (
                mock.patch.object(RUNNER, "auto_prune"),
                mock.patch.object(RUNNER, "execute", side_effect=fake_execute),
            ):
                code = self._run_main(
                    [
                        "--cwd",
                        str(self.repo),
                        "--brief",
                        str(self.brief),
                        "--engine",
                        "agy",
                        "--model",
                        "gemini-3.8-flash-medium",
                    ]
                )
            self.assertEqual(code, 0)
            self.assertEqual(captured_execute["effective_agy_app_data_dir"], personal_app.resolve())
            self.assertEqual(captured_execute["account_id"], "agy-personal")

            args_direct = RUNNER.parse_args(
                [
                    "--cwd",
                    str(self.repo),
                    "--brief",
                    str(self.brief),
                    "--engine",
                    "agy",
                    "--model",
                    "gemini-3.8-flash-medium",
                    "--transport",
                    "native",
                ]
            )
            with (
                mock.patch.object(RUNNER._MODEL_ROUTING_MOD, "_child_marker_switches_host_profile", return_value=False),
                self.assertRaises(RUNNER.RunnerError) as direct_err,
            ):
                RUNNER.native_handoff(args_direct, "agy")
            self.assertEqual(direct_err.exception.exit_code, 2)
            self.assertIn("work", str(direct_err.exception))

    def test_native_claude_policy_ignores_child_marker_when_host_differs(self) -> None:
        work_dir = self.home / ".claude-work"
        personal_home = self.home / "personal-home"
        work_dir.mkdir(parents=True, exist_ok=True)
        (personal_home / ".claude").mkdir(parents=True, exist_ok=True)
        self._write_monitor_config(
            [
                {"id": "claude-work", "provider": "claude", "tags": ["work"], "configDir": str(work_dir)},
                {
                    "id": "claude-personal",
                    "provider": "claude",
                    "tags": ["personal"],
                    "configDir": "~/.claude",
                    "env": {"HOME": str(personal_home)},
                },
            ]
        )
        self._write_policy(["tag:work"])
        env = self._base_env(
            CLAUDE_CONFIG_DIR=str(work_dir),
            ORKEST_PINNED_CLAUDE_ACCOUNT="1",
            ORKEST_CLAUDE_ACCOUNT_HOME=str(personal_home),
        )
        with mock.patch.object(Path, "home", return_value=self.home), mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RUNNER.RunnerError) as raised:
                self._run_main(
                    [
                        "--cwd",
                        str(self.repo),
                        "--brief",
                        str(self.brief),
                        "--engine",
                        "claude",
                        "--transport",
                        "native",
                    ]
                )
            self.assertEqual(raised.exception.exit_code, 4)

            args_direct = RUNNER.parse_args(
                [
                    "--cwd",
                    str(self.repo),
                    "--brief",
                    str(self.brief),
                    "--engine",
                    "claude",
                    "--transport",
                    "native",
                ]
            )
            with (
                mock.patch.object(RUNNER._MODEL_ROUTING_MOD, "_child_marker_switches_host_profile", return_value=False),
                self.assertRaises(RUNNER.RunnerError) as direct_err,
            ):
                RUNNER.native_handoff(args_direct, "claude")
            self.assertEqual(direct_err.exception.exit_code, 2)
            self.assertIn("work", str(direct_err.exception))

    def test_native_agy_host_antigravity_basename_gemini_home_with_matching_child_marker_switches_to_executor(
        self,
    ) -> None:
        team_dir = self.home / "profiles" / "antigravity-team"
        team_dir.mkdir(parents=True, exist_ok=True)
        env = self._base_env(
            CLAUDECODE="",
            ANTIGRAVITY_CONVERSATION_ID="agy-conv-1",
            GEMINI_CLI_HOME=str(team_dir),
            ANTIGRAVITY_APP_DATA_DIR="",
            ORKEST_AGY_ACCOUNT_HOME=str(team_dir),
        )
        with mock.patch.object(Path, "home", return_value=self.home), mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RUNNER.RunnerError) as raised:
                self._run_main(
                    [
                        "--cwd",
                        str(self.repo),
                        "--brief",
                        str(self.brief),
                        "--engine",
                        "agy",
                        "--model",
                        "gemini-3.8-flash-medium",
                        "--transport",
                        "native",
                    ]
                )
            self.assertEqual(raised.exception.exit_code, 4)

            called_executor: list[str] = []

            def fake_execute(exec_args, *, lease=None):
                called_executor.append(exec_args.engine)
                return 0

            with (
                mock.patch.object(RUNNER, "auto_prune"),
                mock.patch.object(RUNNER, "execute", side_effect=fake_execute),
            ):
                code = self._run_main(
                    [
                        "--cwd",
                        str(self.repo),
                        "--brief",
                        str(self.brief),
                        "--engine",
                        "agy",
                        "--model",
                        "gemini-3.8-flash-medium",
                    ]
                )
            self.assertEqual(code, 0)
            self.assertEqual(called_executor, ["agy"])

    def test_native_agy_shared_gemini_home_prefers_default_and_basename_only_team_matches_native(self) -> None:
        gemini_default = self.home / ".gemini"
        green_app = gemini_default / "antigravity-green"
        profiles_dir = self.home / "profiles"
        team_dir = profiles_dir / "antigravity-team"
        for d in (gemini_default, green_app, team_dir):
            d.mkdir(parents=True, exist_ok=True)
        self._write_policy(["tag:work"])

        # 1. [green(work), default(personal)] sharing ~/.gemini: native default succeeds.
        self._write_monitor_config(
            [
                {
                    "id": "agy-green",
                    "provider": "antigravity",
                    "tags": ["work"],
                    "env": {"GEMINI_CLI_HOME": str(gemini_default), "ANTIGRAVITY_APP_DATA_DIR": str(green_app)},
                },
                {"id": "agy-default", "provider": "antigravity", "tags": ["personal"]},
            ]
        )
        out_dir = self.root / "out-agy-default-ok"
        env_default = self._base_env(CLAUDECODE="", ANTIGRAVITY_CONVERSATION_ID="agy-conv-def")
        stdout = io.StringIO()
        with (
            mock.patch.object(Path, "home", return_value=self.home),
            mock.patch.dict(os.environ, env_default, clear=True),
            contextlib.redirect_stdout(stdout),
        ):
            code = self._run_main(
                [
                    "--cwd",
                    str(self.repo),
                    "--brief",
                    str(self.brief),
                    "--engine",
                    "agy",
                    "--model",
                    "gemini-3.8-flash-medium",
                    "--transport",
                    "native",
                    "--out-dir",
                    str(out_dir),
                ]
            )
        self.assertEqual(code, 0)
        self.assertEqual(json.loads((out_dir / "result.json").read_text(encoding="utf-8"))["status"], "native_handoff")

        # 2. [parent(personal, /profiles), team(work, /profiles/antigravity-team)]: native host on team is denied.
        self._write_monitor_config(
            [
                {
                    "id": "agy-parent",
                    "provider": "antigravity",
                    "tags": ["personal"],
                    "env": {"GEMINI_CLI_HOME": str(profiles_dir)},
                },
                {
                    "id": "agy-team",
                    "provider": "antigravity",
                    "tags": ["work"],
                    "env": {"GEMINI_CLI_HOME": str(team_dir)},
                },
            ]
        )
        env_team = self._base_env(
            CLAUDECODE="",
            ANTIGRAVITY_CONVERSATION_ID="agy-conv-team",
            GEMINI_CLI_HOME=str(team_dir),
        )
        with (
            mock.patch.object(Path, "home", return_value=self.home),
            mock.patch.dict(os.environ, env_team, clear=True),
            self.assertRaises(RUNNER.RunnerError) as denied,
        ):
            self._run_main(
                [
                    "--cwd",
                    str(self.repo),
                    "--brief",
                    str(self.brief),
                    "--engine",
                    "agy",
                    "--model",
                    "gemini-3.8-flash-medium",
                    "--transport",
                    "native",
                ]
            )
        self.assertEqual(denied.exception.exit_code, 2)
        self.assertIn("work", str(denied.exception))


if __name__ == "__main__":
    unittest.main()
