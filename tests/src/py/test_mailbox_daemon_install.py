"""Direct HTTP installation, preservation, rollback and operational CLI behavior."""

from __future__ import annotations

import contextlib
import io
import json
import os
import shlex
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import _ork_fast_test_helpers as ORK_FAST  # noqa: E402
import test_mailbox  # noqa: E402

SCRIPTS = test_mailbox.SCRIPTS
sys.path.insert(0, str(SCRIPTS))
import install_mailbox as installer  # noqa: E402 -- shipped integration API
import mailbox_daemon as daemon  # noqa: E402 -- disposable service lifecycle
import peer_mailbox as mailbox  # noqa: E402 -- native hook identity


class TestMailboxDaemonInstall(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mailbox-install-", ignore_cleanup_errors=True)
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir()
        self.base = Path(self.temp.name) / "cache/mailbox-v1"
        self.fast_bin = ORK_FAST.find_ork_fast_bin()
        self.addCleanup(self.temp.cleanup)
        self.environment = mock.patch.dict(
            os.environ,
            {
                "AGENT_EXECUTOR_HOME": str(self.base.parent),
                "ORCHESTRATE_HOME": str(self.base.parent),
                "MONITOR_CACHE_DIR": str(Path(self.temp.name) / "monitor-cache"),
                "ORK_FAST_BIN": str(self.fast_bin),
                "XDG_CONFIG_HOME": str(self.home / ".config"),
                "CODEX_HOME": str(self.home / ".codex"),
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        herdr = mock.patch.object(installer, "_herdr_binary", return_value=None)
        herdr.start()
        self.addCleanup(herdr.stop)
        self.home_patch = mock.patch.object(Path, "home", return_value=self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)
        self.addCleanup(self.stop)
        self.paths = {
            "claude": self.home / ".claude.json",
            "codex": self.home / ".codex/config.toml",
            "agy": self.home / ".gemini/config/mcp_config.json",
            "opencode": self.home / ".config/opencode/opencode.jsonc",
        }
        (self.home / ".claude").mkdir()
        for path in self.paths.values():
            path.parent.mkdir(parents=True, exist_ok=True)
        self.paths["claude"].write_text(
            '{"model":"keep", "mcpServers":{"other":{"url":"https://example.invalid"},"peer-mailbox":{"command":"python3","args":["old"],"customOption":7}}}\n'
        )
        self.paths["codex"].write_text(
            '# user preference\nmodel="keep"\n\n[mcp_servers.peer-mailbox]\n# mailbox note\ncommand="python3"\nargs=["old"]\n\n[mcp_servers.peer-mailbox.tools.unrelated]\napproval_mode="prompt"\n\n[unrelated]\nvalue=7\n'
        )
        self.paths["agy"].write_text(
            '{"otherSetting":7,"mcpServers":{"other":{"command":"keep"},"peer-mailbox":{"command":"old","args":[]}}}'
        )
        self.paths["opencode"].write_text(
            '{// user comment\n"model":"keep", "mcp":{"servers":{"other":{"type":"local","command":["keep"]},"peer-mailbox":{"type":"local","command":["old"],},},},}'
        )
        for path in self.paths.values():
            path.chmod(0o644)

    def stop(self):
        with contextlib.suppress(OSError, mailbox.MailboxError):
            daemon.stop_service(self.base)

    def install(self, stdio=False, **options):
        with mock.patch.object(
            installer.shutil,
            "which",
            side_effect=lambda name: (
                "/synthetic/bin/" + name if name in {"claude", "codex", "agy", "opencode"} else None
            ),
        ):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                installer.install(stdio=stdio, verify=False, **options)
            return output.getvalue()

    def test_orkest_command_approval_is_opt_in_and_survives_setup_refresh(self):
        settings = self.home / ".claude/settings.json"
        rules_file = self.home / ".codex/rules/orkest-commands.rules"
        self.assertIn("--trust-orkest-commands", self.install(stdio=True))
        self.assertNotIn("permissions", json.loads(settings.read_text()))
        self.assertFalse(rules_file.exists())
        self.install(stdio=True, trust_orkest_commands=True)
        rules = json.loads(settings.read_text())["permissions"]["allow"]
        self.assertIn("Bash(ork rooms:*)", rules)
        self.assertTrue(rules_file.is_file())
        self.assertIn("ork rooms *", installer.read_json_config(self.paths["opencode"])["permission"]["bash"])
        self.install(stdio=True)
        self.assertEqual(json.loads(settings.read_text())["permissions"]["allow"], rules)
        self.install(stdio=True, untrust_orkest_commands=True)
        self.assertEqual(json.loads(settings.read_text())["permissions"]["allow"], [])
        self.assertFalse(rules_file.exists())

    def test_actual_four_host_http_config_and_protected_backups(self):
        before = {key: path.read_bytes() for key, path in self.paths.items()}
        output = self.install()
        state = daemon.owned_state(self.base)
        self.assertIsNotNone(state)
        token = daemon.read_token(self.base)
        self.assertNotIn(token, output)
        claude = installer.read_json_config(self.paths["claude"])
        codex = tomllib.loads(self.paths["codex"].read_text())
        agy = installer.read_json_config(self.paths["agy"])
        opencode = installer.read_json_config(self.paths["opencode"])
        self.assertEqual(claude["model"], "keep")
        self.assertEqual(claude["mcpServers"]["other"], {"url": "https://example.invalid"})
        self.assertEqual(claude["mcpServers"]["peer-mailbox"]["customOption"], 7)
        c = codex["mcp_servers"]["peer-mailbox"]
        self.assertEqual((c["url"], c["http_headers"]["Authorization"]), (state["url"], "Bearer " + token))
        self.assertNotIn("command", c)
        self.assertNotIn("args", c)
        self.assertNotIn("env", c)
        self.assertEqual(c["tools"]["unrelated"], {"approval_mode": "prompt"})
        self.assertEqual(codex["unrelated"], {"value": 7})
        self.assertIn("# user preference", self.paths["codex"].read_text())
        self.assertIn("# mailbox note", self.paths["codex"].read_text())
        self.assertIn("// user comment", self.paths["opencode"].read_text())
        self.assertEqual(agy["mcpServers"]["peer-mailbox"]["serverUrl"], state["url"])
        self.assertEqual(opencode["mcp"]["peer-mailbox"]["type"], "remote")
        self.assertEqual(opencode["mcp"]["other"], {"type": "local", "command": ["keep"]})
        self.assertNotIn("servers", opencode["mcp"])
        for name, path in self.paths.items():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            backups = list(path.parent.glob(path.name + ".mailbox-bak.*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), before[name])
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(daemon.get_mode(self.base), "http")
        rows = installer.configuration_status(self.home, {"claude", "codex", "agy", "opencode"}, base=self.base)
        self.assertTrue(all(row["configured"] for row in rows.values()), rows)
        hooks = json.loads((self.home / ".gemini/config/hooks.json").read_text())["peer-mailbox"]
        self.assertEqual(set(hooks), set(installer.AGY_EVENTS))
        self.assertEqual(
            hooks["Stop"][0]["command"],
            shlex.join([str(self.fast_bin), "mailbox-hook", "--harness", "gemini", "--event", "Stop"]),
        )
        claude_hooks = json.loads((self.home / ".claude/settings.json").read_text())["hooks"]["Stop"][0]["hooks"]
        self.assertEqual(
            claude_hooks[0]["command"],
            shlex.join([str(self.fast_bin), "mailbox-hook", "--harness", "claude"]),
        )
        codex_hooks = json.loads((self.home / ".codex/hooks.json").read_text())["hooks"]["Stop"][0]["hooks"]
        self.assertEqual(
            codex_hooks[0]["command"],
            shlex.join([str(self.fast_bin), "mailbox-hook", "--harness", "codex"]),
        )
        (self.home / ".gemini/config/hooks.json").write_text("{}")
        stale = installer.configuration_status(self.home, {"agy"}, base=self.base)["agy"]
        self.assertIn("Stop mailbox hook missing or stale", stale["issues"])
        installer.install_agy_hooks(
            self.home / ".gemini/config/hooks.json", self.home / ".agents/skills/orchestrate/scripts/peer_mailbox.py"
        )
        before_again = {key: path.read_bytes() for key, path in self.paths.items()}
        self.install()
        self.assertEqual(daemon.owned_state(self.base)["pid"], state["pid"])
        self.assertEqual({key: path.read_bytes() for key, path in self.paths.items()}, before_again)
        self.assertTrue(
            all(len(list(path.parent.glob(path.name + ".mailbox-bak.*"))) == 1 for path in self.paths.values())
        )

    def test_stdio_rollback_removes_auth_and_preserves_unrelated_settings(self):
        self.install()
        self.install(stdio=True)
        expected = str(SCRIPTS / "mailbox_mcp.py")
        claude = installer.read_json_config(self.paths["claude"])["mcpServers"]["peer-mailbox"]
        codex = tomllib.loads(self.paths["codex"].read_text())["mcp_servers"]["peer-mailbox"]
        agy = installer.read_json_config(self.paths["agy"])["mcpServers"]["peer-mailbox"]
        opencode = installer.read_json_config(self.paths["opencode"])["mcp"]["peer-mailbox"]
        for value in (claude, codex, agy):
            self.assertEqual((value["command"], value["args"]), ("python3", [expected]))
        self.assertEqual(opencode["command"], ["python3", expected])
        for value in (claude, codex, agy, opencode):
            self.assertNotIn("headers", value)
            self.assertNotIn("http_headers", value)
            self.assertNotIn("url", value)
            self.assertNotIn("serverUrl", value)
        self.assertIn("// user comment", self.paths["opencode"].read_text())
        self.assertEqual(daemon.get_mode(self.base), "stdio")

    def test_dry_run_never_starts_service_or_rewrites_config(self):
        before = {key: path.read_bytes() for key, path in self.paths.items()}
        with (
            mock.patch.object(installer.shutil, "which", return_value="/synthetic/bin/tool"),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            installer.install(dry_run=True, verify=False)
        self.assertEqual({key: path.read_bytes() for key, path in self.paths.items()}, before)
        self.assertIsNone(daemon.load_state(self.base))

    def test_hub_upgrade_preserves_old_content_and_profiles(self):
        hub = self.home / ".agents/skills/orchestrate"
        (hub / "scripts").mkdir(parents=True)
        (hub / "scripts/mailbox_mcp.py").write_text("old entry")
        (hub / "notes.txt").write_text("keep old content")
        profile = self.home / ".claude-personal"
        profile.mkdir()
        (profile / "settings.json").write_text('{"custom":"keep"}')
        self.install()
        self.assertEqual(hub.resolve(), SCRIPTS.parents[1] / "plugins/orchestrate/skills/orchestrate")
        self.assertEqual(next(hub.parent.glob("orchestrate.mailbox-bak.*/notes.txt")).read_text(), "keep old content")
        self.assertEqual(json.loads((profile / "settings.json").read_text())["custom"], "keep")
        self.assertEqual(
            installer.read_json_config(profile / ".claude.json")["mcpServers"]["peer-mailbox"]["url"],
            daemon.owned_state(self.base)["url"],
        )

    def test_daemon_cli_status_start_restart_stop_is_isolated(self):
        cli = SCRIPTS / "run_agent.py"

        def run(command):
            result = subprocess.run(
                [sys.executable, "-B", str(cli), "mailbox", "daemon", command, "--root", str(self.base), "--json"],
                capture_output=True,
                text=True,
                env=os.environ,
                timeout=12,
            )
            return result, json.loads(result.stdout)

        result, status = run("status")
        self.assertEqual((result.returncode, status["status"]), (1, "stopped"))
        self.assertIsNone(daemon.load_state(self.base))
        result, first = run("start")
        self.assertEqual(result.returncode, 0)
        result, second = run("restart")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(second["url"], first["url"])
        self.assertNotEqual(second["instance"], first["instance"])
        result, stop = run("stop")
        self.assertEqual((result.returncode, stop["status"]), (0, "stopped"))

    def _hook_env(self):
        return {**os.environ, "HOME": str(self.home)}

    def test_http_hook_identity_hint_is_short_and_not_repeated(self):
        self.install()
        project = Path(self.temp.name) / "project"
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        payload = {"hook_event_name": "SessionStart", "session_id": "native-hook", "cwd": str(project)}
        first = ORK_FAST.run_mailbox_hook(
            payload, harness="codex", base=self.base, pid=os.getpid(), env=self._hook_env()
        )
        current = daemon.owned_state(self.base)
        later = ORK_FAST.run_mailbox_hook(
            {**payload, "hook_event_name": "UserPromptSubmit"},
            harness="codex",
            base=self.base,
            pid=os.getpid(),
            env=self._hook_env(),
        )
        self.assertIn("HTTP peer mailbox session: native-hook", first["hookSpecificOutput"]["additionalContext"])
        self.assertIsNone(later)
        self.assertEqual(daemon.owned_state(self.base)["pid"], current["pid"])
        self.assertEqual(mailbox.load(mailbox.peer_path(self.base, "native-hook"))["cwd"], str(project))

    def test_hook_failure_does_not_hide_durable_mail_and_stop_skips_bootstrap(self):
        daemon.set_mode(self.base, "http")
        # Write malformed state.json so ensure_running inside ork-fast fails with MailboxError immediately.
        invalid_state = daemon.daemon_base(self.base) / "state.json"
        invalid_state.write_text("{}\n", encoding="utf-8")
        invalid_state.chmod(0o600)
        project = Path(self.temp.name) / "project"
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        payload = {"hook_event_name": "UserPromptSubmit", "session_id": "hook-reader", "cwd": str(project)}
        sender = mailbox.register(self.base, session="hook-sender", harness="claude", cwd=str(project), pid=os.getpid())
        mailbox.register(self.base, session="hook-reader", harness="codex", cwd=str(project), pid=os.getpid())
        mailbox.send(self.base, sender=sender, to="hook-reader", text="durable fallback")
        first = ORK_FAST.run_mailbox_hook(
            payload, harness="codex", base=self.base, pid=os.getpid(), env=self._hook_env()
        )
        second = ORK_FAST.run_mailbox_hook(
            payload, harness="codex", base=self.base, pid=os.getpid(), env=self._hook_env()
        )
        stop = ORK_FAST.run_mailbox_hook(
            {**payload, "hook_event_name": "Stop"},
            harness="codex",
            base=self.base,
            pid=os.getpid(),
            env=self._hook_env(),
        )
        self.assertIn("durable fallback", first["hookSpecificOutput"]["additionalContext"])
        self.assertIn("HTTP mailbox is unavailable", first["hookSpecificOutput"]["additionalContext"])
        self.assertIsNone(second)
        self.assertIsNone(stop)
        self.assertTrue(mailbox.messages(self.base, "hook-reader", unread_only=False)[0]["readAt"])

    def test_resume_announces_native_identity_again_and_login_startup_is_protected(self):
        self.install()
        project = Path(self.temp.name) / "project"
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        payload = {"hook_event_name": "SessionStart", "session_id": "resume-reader", "cwd": str(project)}
        ORK_FAST.run_mailbox_hook(payload, harness="codex", base=self.base, pid=os.getpid(), env=self._hook_env())
        resumed = ORK_FAST.run_mailbox_hook(
            payload, harness="codex", base=self.base, pid=os.getpid(), env=self._hook_env()
        )
        self.assertIn("HTTP peer mailbox session: resume-reader", resumed["hookSpecificOutput"]["additionalContext"])
        if sys.platform == "darwin":
            import plistlib

            path = self.home / "Library/LaunchAgents/dev.loftshed.agent-mailbox.plist"
            config = plistlib.loads(path.read_bytes())
            self.assertTrue(config["RunAtLoad"])
            self.assertEqual(config["ProgramArguments"][2], "serve")
            self.assertEqual(config["EnvironmentVariables"]["PATH"], os.environ["PATH"])
            self.assertEqual(config["EnvironmentVariables"]["CODEX_HOME"], str(self.home / ".codex"))
            self.assertEqual(config["ProgramArguments"][-3:], ["--root", str(self.base), "--json"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_config_write_refuses_observed_concurrent_change(self):
        from mailbox_configuration import write_private

        path = self.paths["claude"]
        before = path.read_text()
        concurrent = '{"model":"concurrent preference"}\n'
        path.write_text(concurrent)
        with self.assertRaisesRegex(ValueError, "changed concurrently"):
            write_private(path, '{"model":"replacement"}\n', expected=before)
        self.assertEqual(path.read_text(), concurrent)

    def test_opencode_server_named_servers_is_preserved(self):
        original = {"type": "local", "command": ["srv"]}
        self.paths["opencode"].write_text(json.dumps({"mcp": {"servers": original}}))
        self.install()
        entries = installer.read_json_config(self.paths["opencode"])["mcp"]
        self.assertEqual(entries["servers"], original)
        self.assertEqual(entries["peer-mailbox"]["type"], "remote")

    def test_codex_inline_and_dotted_transport_migration(self):
        from mailbox_configuration import set_toml_server

        desired = {"url": "http://127.0.0.1:50000/mcp", "http_headers": {"Authorization": "Bearer synthetic"}}
        fixtures = [
            'mcp_servers = { peer-mailbox = { command="old" }, other={command="keep"} } # note\n',
            'mcp_servers.peer-mailbox = { command="old" } # note\n',
            'mcp_servers.peer-mailbox.command = "old" # note\nmodel="keep"\n',
            '[mcp_servers]\npeer-mailbox={command="old"} # note\nother={command="keep"}\n',
        ]
        for fixture in fixtures:
            with self.subTest(fixture=fixture):
                result = set_toml_server(fixture, desired)
                data = tomllib.loads(result)
                self.assertEqual(data["mcp_servers"]["peer-mailbox"], desired)
                self.assertIn("# note", result)
                if "other" in data["mcp_servers"]:
                    self.assertEqual(data["mcp_servers"]["other"], {"command": "keep"})

    def test_codex_profile_mcp_settings_are_preserved(self):
        from mailbox_configuration import set_toml_server

        fixtures = [
            "mcp_servers.peer-mailbox.enabled = false\n",
            "mcp_servers.peer-mailbox = { enabled = false }\n",
            "mcp_servers = { peer-mailbox = { enabled = false } }\n",
        ]
        desired = {"url": "http://127.0.0.1:50000/mcp"}
        for fixture in fixtures:
            fixture = "[profiles.personal]\n" + fixture
            with self.subTest(fixture=fixture):
                before = tomllib.loads(fixture)
                result = tomllib.loads(set_toml_server(fixture, desired))
                self.assertEqual(result["profiles"], before["profiles"])
                self.assertEqual(result["mcp_servers"]["peer-mailbox"], desired)

    def test_install_verify_defers_codex_hook_trust_when_flag_absent(self):
        with (
            mock.patch.object(
                installer.shutil,
                "which",
                side_effect=lambda name: (
                    "/synthetic/bin/" + name if name in {"claude", "codex", "agy", "opencode"} else None
                ),
            ),
            mock.patch.object(
                installer,
                "check",
                return_value={
                    "round_trips": ["a -> b"],
                    "evidence": "/tmp/evidence",
                    "codex_hook_trust": "pending_review",
                },
            ) as mocked_check,
        ):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                installer.install(stdio=True, verify=True, trust_codex_hooks=False)
        mocked_check.assert_called_once_with(require_codex_hook_trust=False)
        self.assertIn("Codex mailbox hooks are pending review", output.getvalue())

        with (
            mock.patch.object(
                installer.shutil,
                "which",
                side_effect=lambda name: (
                    "/synthetic/bin/" + name if name in {"claude", "codex", "agy", "opencode"} else None
                ),
            ),
            mock.patch.object(installer, "trust_codex") as mocked_trust,
            mock.patch.object(
                installer,
                "check",
                return_value={
                    "round_trips": ["a -> b"],
                    "evidence": "/tmp/evidence",
                    "codex_hook_trust": "verified",
                },
            ) as mocked_check,
        ):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                installer.install(stdio=True, verify=True, trust_codex_hooks=True)
        mocked_trust.assert_called_once()
        mocked_check.assert_called_once_with(require_codex_hook_trust=True)
        self.assertNotIn("pending review", output.getvalue())

    def test_install_defers_stale_daemon_upgrade_when_active_waits_remain_and_restarts_when_idle(self):
        import http.client
        import urllib.parse

        self.install()
        initial = daemon.owned_state(self.base)
        self.assertIsNotNone(initial)
        token = daemon.read_token(self.base)
        project = Path(self.temp.name) / "wait-project"
        project.mkdir(exist_ok=True)
        mailbox.register(self.base, session="wait-peer", harness="codex", cwd=str(project), pid=os.getpid())

        parsed = urllib.parse.urlparse(initial["url"])
        conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=6)
        try:
            wait_req = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "wait",
                    "arguments": {"session": "wait-peer", "timeoutSeconds": 3},
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientCapabilities": {},
                        "io.modelcontextprotocol/clientInfo": {"name": "install-test", "version": "1"},
                    },
                },
            }
            conn.request(
                "POST",
                "/mcp",
                json.dumps(wait_req),
                {
                    "Authorization": "Bearer " + token,
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2026-07-28",
                    "Mcp-Method": "tools/call",
                    "Mcp-Name": "wait",
                },
            )
            import time

            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                health = daemon.check_daemon(initial["url"], token)
                if health and health.get("activeWaits", 0) >= 1:
                    break
                time.sleep(0.02)
            self.assertEqual(daemon.check_daemon(initial["url"], token)["activeWaits"], 1)

            with (
                mock.patch.object(daemon, "runtime_revision", return_value="0000000000000000"),
                mock.patch.object(daemon, "stop_service", wraps=daemon.stop_service) as spy_stop,
            ):
                self.install()
            spy_stop.assert_called_once_with(self.base, if_idle=True, expected_instance=initial["instance"])
            still_running = daemon.owned_state(self.base)
            self.assertEqual(still_running["instance"], initial["instance"])
            self.assertEqual(still_running["pid"], initial["pid"])
            resp = conn.getresponse()
            resp.read()
        finally:
            conn.close()

        # Once idle, stale-revision install stops the old instance and starts a fresh one.
        with (
            mock.patch.object(daemon, "runtime_revision", return_value="0000000000000000"),
            mock.patch.object(daemon, "stop_service", wraps=daemon.stop_service) as spy_stop_idle,
        ):
            self.install()
        spy_stop_idle.assert_called_once_with(self.base, if_idle=True, expected_instance=initial["instance"])
        restarted = daemon.owned_state(self.base)
        self.assertNotEqual(restarted["instance"], initial["instance"])
