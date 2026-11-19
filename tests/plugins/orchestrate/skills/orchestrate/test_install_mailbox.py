"""User-visible mailbox setup, preservation and scoped hook trust."""

from __future__ import annotations

import io
import json
import os
import plistlib
import pty
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import tomllib
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))
SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import _ork_fast_test_helpers as ORK_FAST  # noqa: E402
import check_mailbox  # noqa: E402 -- exercise the shipped verifier
import install_mailbox as installer  # noqa: E402 -- exercise the shipped installer
import mailbox_daemon  # noqa: E402 -- exercise daemon transport mode
import mailbox_mcp  # noqa: E402 -- the server defines the installed tool catalog
import peer_mailbox as mailbox  # noqa: E402 -- inspect peer state on disk

ZSH = shutil.which("zsh")


class InstallMailboxTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.object(sys.stdin, "isatty", return_value=False))
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.fast_bin = ORK_FAST.find_ork_fast_bin()
        herdr_patch = mock.patch.object(installer, "_herdr_binary", return_value=None)
        self.herdr_binary = herdr_patch.start()
        self.addCleanup(herdr_patch.stop)
        environment = mock.patch.dict(
            installer.os.environ,
            {"HERDR_ENV": "0", "HERDR_CONFIG_PATH": "", "ORK_FAST_BIN": str(self.fast_bin)},
        )
        environment.start()
        self.addCleanup(environment.stop)
        self.path = self.base / "settings.json"
        self.script = Path("/home/example/skill hub/peer_mailbox.py")

    def test_herdr_ui_is_offered_only_on_a_tty_and_preserves_explicit_settings(self):
        config = self.base / "config.toml"
        original = "[ui]\nshow_agent_labels_on_pane_borders = false\ntab_bar_right = []\n"
        config.write_text(original)
        with (
            mock.patch.object(sys.stdin, "isatty", return_value=True),
            mock.patch("builtins.input", side_effect=AssertionError("unexpected prompt")),
        ):
            self.assertFalse(installer._offer_herdr_ui(config))
        self.assertEqual(config.read_text(), original)
        config.write_text('[keys]\nprefix = "ctrl+a"\n')
        with mock.patch("builtins.input", side_effect=AssertionError("non-TTY prompt")):
            self.assertFalse(installer._offer_herdr_ui(config))
        with (
            mock.patch.object(sys.stdin, "isatty", return_value=True),
            mock.patch("builtins.input", side_effect=["n", ""]),
        ):
            self.assertFalse(installer._offer_herdr_ui(config))
        self.assertEqual(tomllib.loads(config.read_text()), {"keys": {"prefix": "ctrl+a"}})
        with (
            mock.patch.object(sys.stdin, "isatty", return_value=True),
            mock.patch("builtins.input", side_effect=["y", "yes"]),
        ):
            self.assertTrue(installer._offer_herdr_ui(config))
        parsed = tomllib.loads(config.read_text())
        self.assertEqual(parsed["keys"], {"prefix": "ctrl+a"})
        self.assertEqual(
            parsed["ui"],
            {
                "show_agent_labels_on_pane_borders": True,
                "tab_bar_right": [
                    {"type": "command", "command": "ork herdr-status", "interval_seconds": 1, "timeout_seconds": 1}
                ],
            },
        )

    def test_herdr_ui_inserts_into_existing_table_without_changing_other_tables(self):
        config = self.base / "config.toml"
        config.write_text("[ui] # keep\npane_gaps = false\n[ui.sidebar]\nwidth = 20\n")
        with (
            mock.patch.object(sys.stdin, "isatty", return_value=True),
            mock.patch("builtins.input", side_effect=["y", "n"]),
        ):
            self.assertTrue(installer._offer_herdr_ui(config))
        self.assertEqual(
            tomllib.loads(config.read_text()),
            {"ui": {"pane_gaps": False, "show_agent_labels_on_pane_borders": True, "sidebar": {"width": 20}}},
        )

    def test_installer_suite_defaults_to_noninteractive_even_on_a_pty(self):
        master, slave = pty.openpty()
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    "-m",
                    "unittest",
                    "test_install_mailbox.InstallMailboxTests.test_herdr_enabled_refresh_preserves_existing_shortcut_and_reads_manifest_again",
                ],
                cwd=Path(__file__).parent,
                stdin=slave,
                capture_output=True,
                text=True,
                timeout=10,
                env={**os.environ, "HERDR_ENV": "0"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("[y/N]", result.stdout)
        finally:
            os.close(slave)
            os.close(master)

    def test_jsonc_comments_and_trailing_commas_preserve_strings(self):
        path = self.base / "config.jsonc"
        path.write_text('{// note\n"url":"https://example.test/a/*b*/", /* comment */ "literal":",}", "items":[1,],}')
        self.assertEqual(
            installer.read_json_config(path), {"url": "https://example.test/a/*b*/", "literal": ",}", "items": [1]}
        )

    def test_antigravity_hooks_are_flat_named_group_and_preserve_other_groups(self):
        self.path.write_text('{"vibe-island":{"Stop":[{"type":"command","command":"keep"}]}}\n')
        self.assertTrue(installer.install_agy_hooks(self.path, self.script))
        settings = json.loads(self.path.read_text())
        self.assertEqual(settings["vibe-island"], {"Stop": [{"type": "command", "command": "keep"}]})
        self.assertEqual(set(settings["peer-mailbox"]), set(installer.AGY_EVENTS))
        self.assertEqual(
            settings["peer-mailbox"]["PreInvocation"],
            [
                {
                    "type": "command",
                    "command": shlex.join(
                        [str(self.fast_bin), "mailbox-hook", "--harness", "gemini", "--event", "PreInvocation"]
                    ),
                    "timeout": 10,
                }
            ],
        )
        self.assertFalse(installer.install_agy_hooks(self.path, self.script))
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_hooks_preserve_other_settings_and_back_up_the_previous_contents(self):
        original = '{"permissions":{"deny":["Bash(rm *)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"other-tool stop"}]}]}}\n'
        self.path.write_text(original)
        installer.install_hooks(self.path, self.script, "codex")
        settings = json.loads(self.path.read_text())
        self.assertEqual(settings["permissions"], {"deny": ["Bash(rm *)"]})
        self.assertEqual(settings["hooks"]["Stop"][0], {"hooks": [{"type": "command", "command": "other-tool stop"}]})
        self.assertEqual(
            settings["hooks"]["SessionStart"],
            [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": shlex.join([str(self.fast_bin), "mailbox-hook", "--harness", "codex"]),
                            "timeout": 10,
                        }
                    ]
                }
            ],
        )
        self.assertEqual(settings["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"], 3)
        self.assertEqual([p.read_text() for p in self.base.glob("settings.json.mailbox-bak.*")], [original])

    def test_reinstall_does_not_duplicate_hooks_or_rewrite_files(self):
        installer.install_hooks(self.path, self.script, "claude")
        before = self.path.read_bytes()
        self.assertFalse(installer.install_hooks(self.path, self.script, "claude"))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(len(json.loads(before)["hooks"]["Stop"]), 1)

    def test_old_mailbox_hooks_are_updated_to_orchestrate_and_preserve_other_hooks(self):
        old = "/home/example/.agents/skills/agent-executor/scripts/peer_mailbox.py"
        legacy_wrapper = (
            f"[ -x /tmp/old/ork-fast ] && exec /tmp/old/ork-fast mailbox-hook --harness codex "
            f"--fallback-script {old}; exec python3 {old} hook --harness codex"
        )
        new = Path("/home/example/.agents/skills/orchestrate/scripts/peer_mailbox.py")
        original = json.dumps(
            {
                "hooks": {
                    "Stop": [
                        {
                            "hooks": [
                                {"type": "command", "command": f"python3 {old} hook --harness codex"},
                                {"type": "command", "command": "other-tool stop"},
                            ]
                        }
                    ],
                    "SessionStart": [
                        {
                            "hooks": [
                                {"type": "command", "command": legacy_wrapper},
                            ]
                        }
                    ],
                }
            }
        )
        self.path.write_text(original)

        installer.install_hooks(self.path, new, "codex")

        expected = shlex.join([str(self.fast_bin), "mailbox-hook", "--harness", "codex"])
        hooks = json.loads(self.path.read_text())["hooks"]
        self.assertEqual(
            [entry["command"] for entry in hooks["Stop"][0]["hooks"]],
            [expected, "other-tool stop"],
        )
        self.assertEqual(
            [entry["command"] for entry in hooks["SessionStart"][0]["hooks"]],
            [expected],
        )
        self.assertEqual([p.read_text() for p in self.base.glob("settings.json.mailbox-bak.*")], [original])
        self.assertFalse(installer.install_hooks(self.path, new, "codex"))

    def test_native_plugin_can_create_hub_without_removing_old_content(self):
        skill = self.base / "plugin/skills/agent-executor"
        (skill / "scripts").mkdir(parents=True)
        (skill / "scripts/mailbox_mcp.py").write_text("# server")
        hub = self.base / "hub"
        hub.mkdir()
        (hub / "notes.txt").write_text("keep this")
        installer.ensure_hub(hub, skill, dry_run=True)
        self.assertFalse(hub.is_symlink())
        installer.ensure_hub(hub, skill)
        self.assertEqual(hub.resolve(), skill.resolve())
        self.assertEqual(next(self.base.glob("hub.mailbox-bak.*/notes.txt")).read_text(), "keep this")
        installer.ensure_hub(hub, skill)
        self.assertEqual(len(list(self.base.glob("hub.mailbox-bak.*"))), 1)

    def test_codex_rules_allow_only_absolute_orkest_bookkeeping_commands(self):
        home = self.base / "home"
        hub = home / ".agents/skills/orchestrate/scripts"
        hub.mkdir(parents=True)
        codex = home / ".codex"
        with mock.patch.object(installer.shutil, "which", return_value=None):
            content = installer.codex_rules(home, hub)
            self.assertTrue(installer.install_codex_rules(codex, home, hub, dry_run=True))
            self.assertFalse((codex / "rules").exists())
            self.assertTrue(installer.install_codex_rules(codex, home, hub))
            self.assertFalse(installer.install_codex_rules(codex, home, hub))
        rules = codex / "rules/orkest.rules"
        self.assertEqual(rules.read_text(), content)
        self.assertFalse((codex / "rules/default.rules").exists())
        self.assertIn(str(hub / "agent_progress.py"), content)
        self.assertIn(str(SCRIPTS.resolve() / "run_agent.py"), content)
        self.assertNotIn('"plugins/orchestrate', content)
        for blocked in (
            '"dispatch"',
            '"launch"',
            '"prune"',
            '"hook"',
            '"--apply"',
            '"--task-spec"',
            '"bind"',
            '"update"',
        ):
            self.assertNotIn(blocked, content)
        codex_binary = installer.shutil.which("codex")
        if not codex_binary:
            self.skipTest("codex is not installed")

        def decision(*command: str) -> str | None:
            result = subprocess.run(
                [codex_binary, "execpolicy", "check", "--rules", str(rules), *command],
                capture_output=True,
                text=True,
                check=True,
            )
            return json.loads(result.stdout).get("decision")

        progress = str(hub / "agent_progress.py")
        runner = str(SCRIPTS.resolve() / "run_agent.py")
        self.assertEqual(decision("python3", progress, "--session", "s", "--stage", "working"), "allow")
        self.assertEqual(decision("python3", runner, "mailbox", "inbox", "--session", "s"), "allow")
        self.assertEqual(decision("python3", runner, "events", "wait", "e", "--messages"), "allow")
        self.assertEqual(decision("ork", "rooms", "show", "--room", "r"), "allow")
        self.assertEqual(decision(installer.sys.executable, runner, "mailbox", "inbox"), "allow")
        self.assertIsNone(decision("python3", runner, "--task-spec", "spec.json"))
        self.assertIsNone(decision("python3", runner, "mailbox", "prune"))
        self.assertIsNone(decision("ork", "rooms", "dispatch", "--room", "r"))
        for command in (
            ("ork", "update", "--check"),
            ("ork", "policy", "status", "deny", "codex"),
            ("ork", "rooms", "bind", "--room", "r", "--member", "m", "--session", "s"),
            ("ork", "rooms", "objective", "--room", "r", "--objective", "x"),
            ("ork", "cleanup", "status"),
            ("python3", runner, "events", "--ack-all"),
        ):
            self.assertIsNone(decision(*command), command)
        self.assertIsNone(decision("python3", "plugins/orchestrate/skills/orchestrate/scripts/agent_progress.py"))

    def test_codex_permissions_cover_only_known_mailbox_tools_and_are_idempotent(self):
        self.assertEqual(set(installer.TOOLS), {tool["name"] for tool in mailbox_mcp.TOOLS})
        server = {"tools": {"send": {"approval_mode": "approve"}, "unrelated": {"approval_mode": "prompt"}}}
        edits = installer.codex_tool_edits(server)
        self.assertEqual(
            {edit["keyPath"] for edit in edits},
            {f"mcp_servers.peer-mailbox.tools.{tool}.approval_mode" for tool in mailbox_mcp.TOOL_NAMES - {"send"}},
        )
        self.assertTrue(all(edit["value"] == "approve" for edit in edits))
        self.assertEqual(server["tools"]["unrelated"], {"approval_mode": "prompt"})
        configured = {"tools": {tool: {"approval_mode": "approve"} for tool in installer.TOOLS}}
        self.assertEqual(installer.codex_tool_edits(configured), [])

    def test_diagnostics_detect_missing_task_permission_and_repair_covers_it(self):
        from unittest.mock import patch

        config = self.base / ".codex/config.toml"
        config.parent.mkdir()
        original = '[mcp_servers.peer-mailbox]\ncommand = "python3"\n'
        config.write_text(original)
        with patch.dict("os.environ", {"CODEX_HOME": str(config.parent)}):
            missing = installer.configuration_status(self.base, {"codex"})["codex"]["issues"]
            self.assertIn("Codex mailbox tasks needs scoped tool permission", missing)
            edits = installer.codex_tool_edits({})
            task_edit = next(edit for edit in edits if edit["keyPath"].endswith(".tasks.approval_mode"))
            self.assertEqual(task_edit["value"], "approve")
            config.write_text(original + '\n[mcp_servers.peer-mailbox.tools.tasks]\napproval_mode = "approve"\n')
            repaired = installer.configuration_status(self.base, {"codex"})["codex"]["issues"]
            self.assertNotIn("Codex mailbox tasks needs scoped tool permission", repaired)

    def test_diagnostics_explain_missing_registration_and_delivery_hooks(self):
        status = installer.configuration_status(self.base, {"claude"})
        self.assertFalse(status["claude"]["configured"])
        self.assertIn("mailbox configuration could not be read", status["claude"]["issues"])
        self.assertIn("mailbox turn hooks missing or unreadable", status["claude"]["issues"])

    def test_diagnostics_require_direct_opencode_configuration(self):
        from unittest.mock import patch

        config = self.base / ".config/opencode/opencode.jsonc"
        config.parent.mkdir(parents=True)
        config.write_text(
            json.dumps(
                {
                    "mcp": {
                        "servers": {
                            "peer-mailbox": {
                                "command": [
                                    "python3",
                                    str(self.base / ".agents/skills/orchestrate/scripts/mailbox_mcp.py"),
                                ]
                            }
                        }
                    }
                }
            )
        )
        with patch.dict("os.environ", {"XDG_CONFIG_HOME": str(self.base / ".config")}):
            status = installer.configuration_status(self.base, {"opencode"})["opencode"]
            self.assertFalse(status["configured"])
            self.assertIn("legacy OpenCode nested MCP map; rerun messaging repair", status["issues"])
            entries = json.loads(config.read_text())["mcp"]["servers"]
            entries["peer-mailbox"].update(type="local", timeout=660000)
            config.write_text(json.dumps({"mcp": entries}))
            self.assertTrue(installer.configuration_status(self.base, {"opencode"})["opencode"]["configured"])

    def test_dry_run_leaves_settings_intact_then_real_install_adds_delivery(self):
        self.path.write_text('{"model":"example"}\n')
        installer.install_hooks(self.path, self.script, "claude", dry_run=True)
        self.assertEqual(self.path.read_text(), '{"model":"example"}\n')
        installer.install_hooks(self.path, self.script, "claude")
        self.assertEqual(
            set(json.loads(self.path.read_text())["hooks"]),
            {"SessionStart", "SessionEnd", "Stop", "UserPromptSubmit", "SubagentStart", "SubagentStop", "StopFailure"},
        )
        # StopFailure starts an automatic handoff; a second install changes nothing.
        stop_failure = json.loads(self.path.read_text())["hooks"]["StopFailure"]
        self.assertEqual([entry["timeout"] for group in stop_failure for entry in group["hooks"]], [10])
        before = self.path.read_text()
        self.assertFalse(installer.install_hooks(self.path, self.script, "claude"))
        self.assertEqual(self.path.read_text(), before)

    def test_wait_timeout_preserves_comments_and_unrelated_configuration(self):
        self.path = self.base / "config.toml"
        self.path.write_text(
            '# user comment\nmodel = "example"\n\n[mcp_servers.peer-mailbox]\ncommand = "python3"\nargs = ["mailbox_mcp.py"]\n\n[other]\nvalue = 7\n'
        )
        installer.set_codex_timeout(self.path)
        self.assertEqual(
            self.path.read_text(),
            '# user comment\nmodel = "example"\n\n[mcp_servers.peer-mailbox]\ntool_timeout_sec = 660\ncommand = "python3"\nargs = ["mailbox_mcp.py"]\n\n[other]\nvalue = 7\n',
        )
        before = self.path.read_bytes()
        installer.set_codex_timeout(self.path)
        self.assertEqual(self.path.read_bytes(), before)

    def test_trust_selects_only_our_four_exact_commands(self):
        command = shlex.join([str(self.fast_bin), "mailbox-hook", "--harness", "codex"])
        hooks = [
            {
                "key": event,
                "eventName": event,
                "handlerType": "command",
                "sourcePath": str(self.path),
                "command": command,
                "currentHash": "sha256:" + event,
            }
            for event in ["sessionStart", "userPromptSubmit", "stop", "sessionEnd"]
        ]
        hooks.append(
            {
                "key": "unrelated",
                "eventName": "stop",
                "handlerType": "command",
                "sourcePath": str(self.path),
                "command": "unrelated hook",
                "currentHash": "sha256:unrelated",
            }
        )
        self.assertEqual(
            installer.mailbox_hook_updates({"data": [{"hooks": hooks}]}, self.script, self.path),
            {
                "sessionStart": {"trusted_hash": "sha256:sessionStart"},
                "userPromptSubmit": {"trusted_hash": "sha256:userPromptSubmit"},
                "stop": {"trusted_hash": "sha256:stop"},
                "sessionEnd": {"trusted_hash": "sha256:sessionEnd"},
            },
        )
        for bad_cmd in (
            command + " ; run something else",
            f"{command} --fallback-script /tmp/peer_mailbox.py",
            f"[ -x {self.fast_bin} ] && exec {command}; exec python3 /tmp/peer_mailbox.py hook --harness codex",
            "python3 /tmp/peer_mailbox.py hook --harness codex",
        ):
            mutated = [dict(h) for h in hooks]
            mutated[0]["command"] = bad_cmd
            with self.subTest(bad_cmd=bad_cmd), self.assertRaisesRegex(ValueError, "exactly four"):
                installer.mailbox_hook_updates({"data": [{"hooks": mutated}]}, self.script, self.path)

    def test_shell_wrappers_generate_orkest_sh_and_wire_zshrc_idempotently(self):
        ork_cli = self.base / "bin/ork.mjs"
        ork_cli.parent.mkdir(parents=True)
        ork_cli.write_text("#!/usr/bin/env node\n")
        (self.base / ".claude").mkdir()
        (self.base / ".codex/skills").mkdir(parents=True)
        legacy_skill = self.base / ".codex/skills/agent-executor"
        legacy_skill.mkdir(parents=True)
        zshrc = self.base / ".zshrc"
        zshrc.write_text("export EXAMPLE=1\n")

        self.assertTrue(installer.install_shell_wrappers(self.base, ork_cli, dry_run=True))
        self.assertFalse((self.base / ".config/orchestrate/orkest.sh").exists())
        self.assertTrue(legacy_skill.exists())
        self.assertEqual(zshrc.read_text(), "export EXAMPLE=1\n")

        self.assertTrue(installer.install_shell_wrappers(self.base, ork_cli))
        wrapper = self.base / ".config/orchestrate/orkest.sh"
        self.assertTrue(wrapper.is_file())
        self.assertFalse(legacy_skill.exists())
        canonical = self.base / ".config/orkest/shell.zsh"
        self.assertIn('command ork label -- agy --dangerously-skip-permissions "$@"', canonical.read_text())
        self.assertIn('command ork agy --dangerously-skip-permissions "$@"', canonical.read_text())
        self.assertNotIn("--remote-control", canonical.read_text())
        # The installer-owned orkest.sh only sources the canonical file; .zshrc keeps one inclusion.
        self.assertIn(str(canonical), wrapper.read_text())
        self.assertNotIn("command ork label", wrapper.read_text())
        self.assertEqual(zshrc.read_text().count(installer.MANAGED_ZSHRC_START), 1)
        self.assertEqual((self.base / ".local/bin/ork").resolve(), ork_cli.resolve())
        self.assertTrue((self.base / ".claude/commands/swarm.md").is_file())
        self.assertTrue((self.base / ".claude/commands/cleanup.md").is_file())
        self.assertTrue((self.base / ".agents/skills/swarm/SKILL.md").is_file())
        self.assertTrue((self.base / ".agents/skills/cleanup/SKILL.md").is_file())
        self.assertEqual((self.base / ".codex/skills/swarm").resolve(), (self.base / ".agents/skills/swarm").resolve())
        self.assertEqual(
            (self.base / ".codex/skills/cleanup").resolve(), (self.base / ".agents/skills/cleanup").resolve()
        )
        self.assertIn(installer.MANAGED_ZSHRC_BLOCK, zshrc.read_text())
        self.assertIn("export EXAMPLE=1\n", zshrc.read_text())

        before_zshrc = zshrc.read_bytes()
        self.assertFalse(installer.install_shell_wrappers(self.base, ork_cli))
        self.assertEqual(zshrc.read_bytes(), before_zshrc)

    def test_side_command_and_skill_registration_when_present_in_plugin_root(self):
        plugin_root = self.base / "plugin-root"
        ork_cli = plugin_root / "bin/ork.mjs"
        ork_cli.parent.mkdir(parents=True)
        ork_cli.write_text("#!/usr/bin/env node\n")
        (plugin_root / "commands").mkdir(parents=True)
        (plugin_root / "commands/side.md").write_text("---\ndescription: Toggle side view\n---\n")
        (plugin_root / "commands/update.md").write_text("---\ndescription: Update Orkest\n---\n")

        (self.base / ".claude/skills/side").mkdir(parents=True, exist_ok=True)
        (self.base / ".claude-work/skills/side").mkdir(parents=True, exist_ok=True)
        (self.base / ".gemini/antigravity/skills/side").mkdir(parents=True, exist_ok=True)
        (self.base / ".codex/skills").mkdir(parents=True, exist_ok=True)
        (self.base / ".gemini/config/skills").mkdir(parents=True, exist_ok=True)
        (self.base / ".config/opencode/skills").mkdir(parents=True, exist_ok=True)

        self.assertTrue(installer.install_shell_wrappers(self.base, ork_cli))
        self.assertTrue((self.base / ".claude/commands/side.md").is_file())
        self.assertTrue((self.base / ".claude-work/commands/side.md").is_file())
        self.assertTrue((self.base / ".claude/commands/update.md").is_file())
        self.assertTrue((self.base / ".claude-work/commands/update.md").is_file())
        hub_side = (self.base / ".agents/skills/side").resolve()
        hub_update = (self.base / ".agents/skills/update").resolve()
        self.assertTrue((hub_side / "SKILL.md").is_file())
        self.assertTrue((hub_update / "SKILL.md").is_file())
        for dup_link in (
            self.base / ".claude/skills/side",
            self.base / ".claude-work/skills/side",
            self.base / ".gemini/antigravity/skills/side",
            self.base / ".claude/skills/update",
            self.base / ".claude-work/skills/update",
            self.base / ".gemini/antigravity/skills/update",
        ):
            self.assertFalse(dup_link.exists() or dup_link.is_symlink(), f"expected duplicate removed at {dup_link}")
        for skill_link in (
            self.base / ".codex/skills/side",
            self.base / ".gemini/config/skills/side",
            self.base / ".config/opencode/skills/side",
        ):
            self.assertTrue(skill_link.is_symlink(), f"expected symlink at {skill_link}")
            self.assertEqual(skill_link.resolve(), hub_side)
        for update_link in (
            self.base / ".codex/skills/update",
            self.base / ".gemini/config/skills/update",
            self.base / ".config/opencode/skills/update",
        ):
            self.assertTrue(update_link.is_symlink(), f"expected symlink at {update_link}")
            self.assertEqual(update_link.resolve(), hub_update)

    def test_chief_command_and_skill_registration_from_plugin_root(self):
        plugin_root = self.base / "plugin-root"
        command = "---\ndescription: Take the Chief desk\n---\n\n[orkest-chief-command: $ARGUMENTS]\n"
        skill = "---\nname: chief\ndescription: Act as Ork Chief\n---\n\n# Chief\n"
        (plugin_root / "commands").mkdir(parents=True)
        (plugin_root / "commands/chief.md").write_text(command)
        (plugin_root / "skills/chief").mkdir(parents=True)
        (plugin_root / "skills/chief/SKILL.md").write_text(skill)
        (self.base / ".claude/skills/chief").mkdir(parents=True)
        (self.base / ".claude-work/skills").mkdir(parents=True)
        (self.base / ".claude-work/skills/chief").symlink_to(self.base / ".claude/skills/chief")
        (self.base / ".gemini/antigravity/skills/chief").mkdir(parents=True)
        for parent in (".codex/skills", ".gemini/config/skills", ".config/opencode/skills"):
            (self.base / parent).mkdir(parents=True)

        with redirect_stdout(io.StringIO()):
            self.assertTrue(installer.install_chief_command(self.base, plugin_root=plugin_root, dry_run=True))
            self.assertTrue(installer.install_chief_skill(self.base, plugin_root=plugin_root, dry_run=True))
        self.assertFalse((self.base / ".claude/commands/chief.md").exists())
        self.assertFalse((self.base / ".agents/skills/chief").exists())

        with redirect_stdout(io.StringIO()):
            self.assertTrue(installer.install_chief_command(self.base, plugin_root=plugin_root))
            self.assertTrue(installer.install_chief_skill(self.base, plugin_root=plugin_root))
        for claude_dir in (".claude", ".claude-work"):
            self.assertEqual((self.base / claude_dir / "commands/chief.md").read_text(), command)
        hub = self.base / ".agents/skills/chief"
        self.assertEqual((hub / "SKILL.md").read_text(), skill)
        for duplicate in (".claude/skills/chief", ".claude-work/skills/chief", ".gemini/antigravity/skills/chief"):
            path = self.base / duplicate
            self.assertFalse(path.exists() or path.is_symlink(), f"expected duplicate removed at {path}")
        for parent in (".codex/skills", ".gemini/config/skills", ".config/opencode/skills"):
            link = self.base / parent / "chief"
            self.assertTrue(link.is_symlink(), f"expected symlink at {link}")
            self.assertEqual(link.resolve(), hub.resolve())

        with redirect_stdout(io.StringIO()):
            self.assertFalse(installer.install_chief_command(self.base, plugin_root=plugin_root))
            self.assertFalse(installer.install_chief_skill(self.base, plugin_root=plugin_root))

    def test_shell_wrappers_install_bundled_chief_command_and_skill(self):
        plugin_root = Path(installer.__file__).resolve().parents[3]
        self.assertTrue((plugin_root / "commands/chief.md").is_file())
        self.assertTrue((plugin_root / "skills/chief/SKILL.md").is_file())
        (self.base / ".claude").mkdir()
        (self.base / ".codex").mkdir()
        ork_cli = self.base / "plugin-without-chief/bin/ork.mjs"
        ork_cli.parent.mkdir(parents=True)
        ork_cli.write_text("#!/usr/bin/env node\n")

        with redirect_stdout(io.StringIO()):
            self.assertTrue(installer.install_shell_wrappers(self.base, ork_cli))
        self.assertEqual(
            (self.base / ".claude/commands/chief.md").read_text(),
            (plugin_root / "commands/chief.md").read_text(encoding="utf-8"),
        )
        self.assertEqual(
            (self.base / ".agents/skills/chief/SKILL.md").read_text(),
            (plugin_root / "skills/chief/SKILL.md").read_text(encoding="utf-8"),
        )
        self.assertEqual((self.base / ".codex/skills/chief").resolve(), (self.base / ".agents/skills/chief").resolve())
        self.assertFalse((self.base / ".claude/skills/chief").exists())

    def test_backup_rotation_keeps_newest_and_prunes_inactive_daemon_runtimes(self):
        import os
        import time

        target = self.base / "settings.json"
        for idx in range(3):
            target.write_text(f'{{"rev": {idx}}}\n')
            installer.backup(target, keep_backups=1)
        backups = list(self.base.glob("settings.json.mailbox-bak.*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), '{"rev": 2}\n')

        mailbox_root = self.base / "cache/mailbox-v1"
        daemon_dir = self.base / "cache/mailbox-daemon-v1"
        runtimes_dir = daemon_dir / "runtimes"
        active_rt = runtimes_dir / "rev-active"
        recent_rt = runtimes_dir / "rev-recent"
        stale_rt = runtimes_dir / "rev-stale"
        for rt in (active_rt, recent_rt, stale_rt):
            rt.mkdir(parents=True)
            (rt / "mailbox_daemon.py").write_text("# daemon\n")
        (daemon_dir / "state.json").write_text(json.dumps({"runtimeRevision": "rev-active"}))
        old_mtime = time.time() - 3600
        os.utime(stale_rt, (old_mtime, old_mtime))

        pruned_dry = installer.prune_daemon_runtimes(mailbox_root, grace_seconds=900, dry_run=True)
        self.assertEqual(pruned_dry, [stale_rt])
        self.assertTrue(stale_rt.exists())

        pruned = installer.prune_daemon_runtimes(mailbox_root, grace_seconds=900, dry_run=False)
        self.assertEqual(pruned, [stale_rt])
        self.assertFalse(stale_rt.exists())
        self.assertTrue(active_rt.exists())
        self.assertTrue(recent_rt.exists())

    def _write_swarm_toggle_stub(self) -> tuple[Path, Path]:
        stub_dir = self.base / "stub-scripts"
        stub_dir.mkdir(exist_ok=True)
        log_path = self.base / "swarm-toggle-calls.jsonl"
        (stub_dir / "agent_statusline_tmux.py").write_text(
            textwrap.dedent(
                """\
                import json, os, sys
                from pathlib import Path
                log = Path(os.environ["SWARM_STUB_LOG"])
                with log.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(sys.argv[1:]) + "\\n")
                print(os.environ["SWARM_STUB_RESULT"])
                """
            )
        )
        return stub_dir, log_path

    def test_swarm_command_context_toggles_swarm_view_on_slash_command(self):
        stub_dir, log_path = self._write_swarm_toggle_stub()
        sid = "11111111-2222-4333-8444-555555555555"

        opened_out = ORK_FAST.run_mailbox_hook(
            {"hook_event_name": "UserPromptSubmit", "session_id": sid, "cwd": str(self.base), "prompt": "/swarm"},
            harness="claude",
            base=self.base,
            env={
                "ORKEST_SCRIPTS_DIR": str(stub_dir),
                "SWARM_STUB_LOG": str(log_path),
                "SWARM_STUB_RESULT": json.dumps(
                    {"status": "opened", "room": "room-123", "socket": "orkest-label-abcdef012345"}
                ),
            },
        )
        self.assertEqual(
            opened_out, {"decision": "block", "reason": "Orkest Swarm View pane is now opened (room room-123)."}
        )

        closed_out = ORK_FAST.run_mailbox_hook(
            {
                "hook_event_name": "UserPromptSubmit",
                "session_id": sid,
                "cwd": str(self.base),
                "prompt": "[orkest-swarm-command: close]\nIf the `/swarm` turn hook...",
            },
            harness="claude",
            base=self.base,
            env={
                "ORKEST_SCRIPTS_DIR": str(stub_dir),
                "SWARM_STUB_LOG": str(log_path),
                "SWARM_STUB_RESULT": json.dumps(
                    {"status": "closed", "room": "room-123", "socket": "orkest-label-abcdef012345"}
                ),
            },
        )
        self.assertEqual(
            closed_out, {"decision": "block", "reason": "Orkest Swarm View pane is now closed (room room-123)."}
        )

        calls = [json.loads(line) for line in log_path.read_text().splitlines()]
        self.assertEqual(calls[0][:2], ["--toggle-swarm", "toggle"])
        self.assertEqual(calls[1][:2], ["--toggle-swarm", "close"])

    def test_hook_intercepts_bare_swarm_with_zero_tokens_and_allows_goal(self):
        stub_dir, log_path = self._write_swarm_toggle_stub()
        mb_base = self.base / "mailbox-v1"
        claude_sid = "11111111-2222-4333-8444-555555555555"
        agy_sid = "66666666-7777-4888-8999-aaaaaaaaaaaa"
        stub_env = {
            "ORKEST_SCRIPTS_DIR": str(stub_dir),
            "SWARM_STUB_LOG": str(log_path),
            "SWARM_STUB_RESULT": json.dumps(
                {"status": "opened", "room": "room-777", "socket": "orkest-label-abcdef012345"}
            ),
        }

        # 1. Bare /swarm in Claude Code / Codex blocks the turn before calling the model (0 tokens).
        claude_res = ORK_FAST.run_mailbox_hook(
            {
                "hook_event_name": "UserPromptSubmit",
                "session_id": claude_sid,
                "cwd": str(self.base),
                "prompt": "/swarm",
            },
            harness="claude",
            base=mb_base,
            env=stub_env,
        )
        self.assertEqual(
            claude_res,
            {"decision": "block", "reason": "Orkest Swarm View pane is now opened (room room-777)."},
        )
        self.assertEqual(mailbox.load(mailbox.peer_path(mb_base, claude_sid))["state"], "idle")

        # 2. Bare /horde in Antigravity (PreInvocation with lastUserInput) terminates before model call.
        agy_res = ORK_FAST.run_mailbox_hook(
            {
                "conversationId": agy_sid,
                "invocationNum": 1,
                "workspacePaths": [str(self.base)],
                "lastUserInput": "/horde",
            },
            harness="gemini",
            base=mb_base,
            env=stub_env,
        )
        self.assertEqual(
            agy_res,
            {
                "injectSteps": [
                    {
                        "systemMessage": {
                            "systemMessage": "",
                            "metadata": {"user_markdown": "Orkest Swarm View pane is now opened (room room-777)."},
                        }
                    }
                ],
                "terminationBehavior": "terminate",
            },
        )
        self.assertEqual(mailbox.load(mailbox.peer_path(mb_base, agy_sid))["state"], "idle")

        # 3. /swarm <goal> opens the pane AND proceeds into the model turn with the goal context.
        log_path.unlink(missing_ok=True)
        goal_res = ORK_FAST.run_mailbox_hook(
            {
                "hook_event_name": "UserPromptSubmit",
                "session_id": claude_sid,
                "cwd": str(self.base),
                "prompt": "/swarm build the auth module",
            },
            harness="claude",
            base=mb_base,
            env=stub_env,
        )
        goal_calls = [json.loads(line) for line in log_path.read_text().splitlines()]
        self.assertEqual(goal_calls[-1][:2], ["--toggle-swarm", "open"])
        self.assertIn("hookSpecificOutput", goal_res)
        self.assertIn(
            "Proceed with the user's swarm objective: build the auth module",
            goal_res["hookSpecificOutput"]["additionalContext"],
        )

    def test_uninstall_shell_removes_only_links_resolving_to_its_own_checkout(self):
        plugin = self.base / "checkout/plugins/orchestrate"
        script = plugin / "uninstall.sh"
        helper = plugin / "skills/orchestrate/scripts/install_mailbox.py"
        helper.parent.mkdir(parents=True)
        helper.write_text("import sys\nassert sys.argv[1:] == ['--remove-herdr']\n")
        script.write_text((SCRIPTS.parents[2] / "uninstall.sh").read_text())
        for foreign in (False, True):
            with self.subTest(foreign=foreign):
                home = self.base / ("foreign-home" if foreign else "owned-home")
                target = self.base / "other-checkout/skills/orchestrate" if foreign else helper.parents[1]
                target.mkdir(parents=True, exist_ok=True)
                hub = home / ".agents/skills/orchestrate"
                hub.parent.mkdir(parents=True)
                hub.symlink_to(target, target_is_directory=True)
                harness = home / ".codex/skills/orchestrate"
                harness.parent.mkdir(parents=True)
                harness.symlink_to(hub, target_is_directory=True)
                direct = home / ".claude/skills/orchestrate"
                direct.parent.mkdir(parents=True)
                direct.symlink_to(target, target_is_directory=True)
                real_directory = home / ".gemini/config/skills/orchestrate"
                real_directory.mkdir(parents=True)
                (real_directory / "keep.txt").write_text("keep")
                result = subprocess.run(
                    ["sh", str(script)],
                    env={**installer.os.environ, "HOME": str(home)},
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                for link in (hub, harness, direct):
                    self.assertEqual(link.is_symlink(), foreign, str(link))
                self.assertEqual((real_directory / "keep.txt").read_text(), "keep")

    def herdr_source(self):
        root = self.base / "source"
        cli = root / "plugins/renamed-plugin/bin/ork.mjs"
        cli.parent.mkdir(parents=True, exist_ok=True)
        cli.write_text("// test CLI\n")
        (root / "herdr-plugin.toml").write_text('id = "orkest.swarms"\n')
        return root.resolve(), cli

    def herdr_reply(self, entries):
        return mock.Mock(returncode=0, stdout=json.dumps({"result": {"plugins": entries}}), stderr="")

    def test_herdr_fresh_install_uses_official_registry_api_without_existing_private_registry(self):
        root, cli = self.herdr_source()
        self.herdr_binary.return_value = "herdr-test"
        with mock.patch.object(
            installer.subprocess, "run", side_effect=[self.herdr_reply([]), self.herdr_reply([])]
        ) as run:
            self.assertTrue(installer.install_herdr_integration(self.base, cli))
        self.assertEqual(run.call_args_list[1].args[0], ["herdr-test", "plugin", "link", str(root), "--enabled"])
        self.assertIn('command = "orkest.swarms.toggle"', (self.base / ".config/herdr/config.toml").read_text())
        self.assertFalse((self.base / ".config/herdr/plugins.json").exists())

    def test_herdr_refresh_preserves_disabled_registration_and_user_shortcut(self):
        root, cli = self.herdr_source()
        self.herdr_binary.return_value = "herdr-test"
        config = self.base / ".config/herdr/config.toml"
        config.parent.mkdir(parents=True)
        original = "[[keys.command]]\nkey = 'ctrl+alt+s'\ncommand = 'my-action'\n"
        config.write_text(original)
        entry = {"plugin_id": "orkest.swarms", "plugin_root": str(root), "source": {"kind": "local"}, "enabled": False}
        with mock.patch.object(
            installer.subprocess, "run", side_effect=[self.herdr_reply([entry]), self.herdr_reply([])]
        ) as run:
            installer.install_herdr_integration(self.base, cli)
        self.assertEqual(run.call_args_list[1].args[0][-1], "--disabled")
        self.assertEqual(config.read_text(), original)

    def test_herdr_enabled_refresh_preserves_existing_shortcut_and_reads_manifest_again(self):
        root, cli = self.herdr_source()
        self.herdr_binary.return_value = "herdr-test"
        config = self.base / ".config/herdr/config.toml"
        config.parent.mkdir(parents=True)
        original = "[[keys.command]]\nkey = 'ctrl+alt+s'\ncommand = 'my-action'\n"
        config.write_text(original)
        entry = {"plugin_id": "orkest.swarms", "plugin_root": str(root), "source": {"kind": "local"}, "enabled": True}
        with mock.patch.object(
            installer.subprocess, "run", side_effect=[self.herdr_reply([entry]), self.herdr_reply([])]
        ):
            installer.install_herdr_integration(self.base, cli)
        self.assertEqual(config.read_text(), original)

    def test_herdr_dry_run_and_foreign_registration_do_not_mutate(self):
        root, cli = self.herdr_source()
        self.herdr_binary.return_value = "herdr-test"
        with mock.patch.object(installer.subprocess, "run", return_value=self.herdr_reply([])) as run:
            self.assertTrue(installer.install_herdr_integration(self.base, cli, dry_run=True))
            self.assertEqual(run.call_count, 1)
        self.assertFalse((self.base / ".config/herdr").exists())
        entry = {
            "plugin_id": "orkest.swarms",
            "plugin_root": str(root / "another-install"),
            "source": {"kind": "local"},
        }
        with mock.patch.object(installer.subprocess, "run", return_value=self.herdr_reply([entry])) as run:
            self.assertFalse(installer.install_herdr_integration(self.base, cli))
            self.assertFalse(installer.uninstall_herdr_integration(self.base, cli))
            self.assertEqual(run.call_count, 2)

    def test_herdr_uninstall_removes_only_owned_registration_and_exact_managed_shortcut(self):
        root, cli = self.herdr_source()
        self.herdr_binary.return_value = "herdr-test"
        config = self.base / ".config/herdr/config.toml"
        config.parent.mkdir(parents=True)
        original = "onboarding = false\n"
        config.write_text(original + installer.HERDR_SHORTCUT_BLOCK)
        state = self.base / ".config/herdr/plugin-state"
        state.write_text("keep")
        entry = {"plugin_id": "orkest.swarms", "plugin_root": str(root), "source": {"kind": "local"}}
        with mock.patch.object(
            installer.subprocess, "run", side_effect=[self.herdr_reply([entry]), self.herdr_reply([])]
        ) as run:
            self.assertTrue(installer.uninstall_herdr_integration(self.base, cli))
        self.assertEqual(run.call_args_list[1].args[0], ["herdr-test", "plugin", "unlink", "orkest.swarms"])
        self.assertEqual(config.read_text(), original)
        self.assertEqual(state.read_text(), "keep")

    def test_herdr_respects_explicit_config_path(self):
        _root, cli = self.herdr_source()
        self.herdr_binary.return_value = "herdr-test"
        config = self.base / "custom-herdr/config.toml"
        with (
            mock.patch.dict(installer.os.environ, {"HERDR_CONFIG_PATH": str(config)}),
            mock.patch.object(
                installer.subprocess, "run", side_effect=[self.herdr_reply([]), self.herdr_reply([])]
            ) as run,
        ):
            installer.install_herdr_integration(self.base, cli)
        self.assertIn('command = "orkest.swarms.toggle"', config.read_text())
        self.assertEqual(run.call_args.kwargs["env"]["HERDR_CONFIG_PATH"], str(config))
        self.assertFalse((self.base / ".config/herdr/config.toml").exists())

    def test_herdr_update_adopts_live_views_only_for_enabled_registration(self):
        root, cli = self.herdr_source()
        helper = cli.parent.parent / "skills/orchestrate/scripts/herdr_swarm_restore.py"
        helper.parent.mkdir(parents=True)
        helper.write_text("# fake helper\n")
        self.herdr_binary.return_value = "herdr-test"
        for enabled in (True, False):
            entry = {
                "plugin_id": "orkest.swarms",
                "plugin_root": str(root),
                "source": {"kind": "local"},
                "enabled": enabled,
            }
            replies = [self.herdr_reply([entry]), self.herdr_reply([])]
            if enabled:
                replies.append(mock.Mock(returncode=0, stdout='{"status":"adopted"}', stderr=""))
            with (
                mock.patch.dict(installer.os.environ, {"HERDR_ENV": "1"}),
                mock.patch.object(installer.subprocess, "run", side_effect=replies) as run,
            ):
                self.assertTrue(installer.install_herdr_integration(self.base, cli))
                self.assertEqual(run.call_count, 3 if enabled else 2)
                if enabled:
                    self.assertEqual(run.call_args.args[0][-1], "--adopt")
                    self.assertEqual(run.call_args.kwargs["env"]["HERDR_BIN_PATH"], "herdr-test")

    def test_herdr_unreadable_registry_is_left_unchanged(self):
        _root, cli = self.herdr_source()
        self.herdr_binary.return_value = "herdr-test"
        with mock.patch.object(
            installer.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="not JSON", stderr="")
        ):
            with self.assertRaisesRegex(RuntimeError, "unreadable plugin list"):
                installer.install_herdr_integration(self.base, cli)
        self.assertFalse((self.base / ".config/herdr/config.toml").exists())

    def test_herdr_registration_error_is_reported_without_writing_shortcut(self):
        _root, cli = self.herdr_source()
        self.herdr_binary.return_value = "herdr-test"
        with mock.patch.object(
            installer.subprocess, "run", return_value=mock.Mock(returncode=1, stderr="refused", stdout="")
        ):
            with self.assertRaisesRegex(RuntimeError, "refused"):
                installer.install_herdr_integration(self.base, cli)
        self.assertFalse((self.base / ".config/herdr/config.toml").exists())

    def test_orchestrate_skill_links_cover_installed_harnesses_and_skip_marketplace_claude_cache(self):
        hub = self.base / ".agents/skills/orchestrate"
        hub.mkdir(parents=True)
        (hub / "SKILL.md").write_text("---\nname: orchestrate\n---\n")
        for d in (
            self.base / ".codex",
            self.base / ".gemini/config",
            self.base / ".config/opencode",
            self.base / ".claude",
            self.base / ".claude-work",
            self.base / ".claude-plugin-managed/plugins/cache/orkest/orchestrate/0.66.0",
        ):
            d.mkdir(parents=True)
        self.assertTrue(installer.install_orchestrate_skill_links(self.base, dry_run=True))
        self.assertFalse((self.base / ".codex/skills/orchestrate").exists())
        self.assertTrue(installer.install_orchestrate_skill_links(self.base))
        for linked in (
            self.base / ".codex/skills/orchestrate",
            self.base / ".gemini/config/skills/orchestrate",
            self.base / ".config/opencode/skills/orchestrate",
            self.base / ".claude/skills/orchestrate",
            self.base / ".claude-work/skills/orchestrate",
        ):
            self.assertTrue(linked.is_symlink(), str(linked))
            self.assertEqual(linked.resolve(), hub.resolve())
        self.assertFalse((self.base / ".claude-plugin-managed/skills/orchestrate").exists())
        self.assertFalse(installer.install_orchestrate_skill_links(self.base))

    def test_install_herdr_skill_links_across_harnesses_with_repo_fallback(self):
        root, cli = self.herdr_source()
        repo_skill = root / ".agents/skills/herdr/SKILL.md"
        repo_skill.parent.mkdir(parents=True)
        repo_skill.write_text("---\nname: herdr\ndescription: Control Herdr.\n---\n# Herdr\n")
        for d in (
            self.base / ".codex",
            self.base / ".gemini/config",
            self.base / ".config/opencode",
            self.base / ".claude",
            self.base / ".claude-personal",
        ):
            d.mkdir(parents=True)
        self.assertTrue(installer.install_herdr_skill(self.base, ork_cli=cli, dry_run=True))
        self.assertFalse((self.base / ".agents/skills/herdr/SKILL.md").exists())
        self.assertTrue(installer.install_herdr_skill(self.base, ork_cli=cli))
        hub = self.base / ".agents/skills/herdr"
        self.assertTrue((hub / "SKILL.md").is_file())
        for linked in (
            self.base / ".codex/skills/herdr",
            self.base / ".gemini/config/skills/herdr",
            self.base / ".config/opencode/skills/herdr",
            self.base / ".claude/skills/herdr",
            self.base / ".claude-personal/skills/herdr",
        ):
            self.assertTrue(linked.is_symlink(), str(linked))
            self.assertEqual(linked.resolve(), hub.resolve())
        self.assertFalse(installer.install_herdr_skill(self.base, ork_cli=cli))

    def test_statusline_wrappers_upgrade_claude_and_agy_settings(self):
        fast_bin = self.base / ".cache/orchestrate/bin/ork-fast"
        agy_settings = self.base / ".gemini/antigravity-cli/settings.json"
        agy_settings.parent.mkdir(parents=True)
        agy_settings.write_text(
            json.dumps(
                {
                    "statusLine": {
                        "type": "command",
                        "command": "python3 ~/.agents/skills/orchestrate/scripts/agent_statusline.py --native-status",
                        "stack_with_default": True,
                    }
                }
            )
        )
        self.assertTrue(installer.install_agy_statusline(agy_settings, fast_bin=fast_bin, home=self.base))
        agy_updated = json.loads(agy_settings.read_text())
        self.assertIs(agy_updated["statusLine"]["stack_with_default"], False)
        self.assertEqual(
            agy_updated["statusLine"]["command"],
            shlex.join([str(fast_bin), "statusline", "--native-status"]),
        )
        self.assertNotIn("agent_statusline.py", agy_updated["statusLine"]["command"])
        self.assertNotIn("--fallback-script", agy_updated["statusLine"]["command"])
        self.assertFalse(installer.install_agy_statusline(agy_settings, fast_bin=fast_bin, home=self.base))

        claude_settings = self.base / ".claude/settings.json"
        claude_settings.parent.mkdir(parents=True)
        claude_settings.write_text(
            json.dumps(
                {
                    "statusLine": {
                        "type": "command",
                        "command": (
                            "[ -x /old/ork-fast ] && exec /old/ork-fast statusline --harness claude "
                            "--fallback-script /old/agent_statusline.py; "
                            f"exec python3 {self.base}/.agents/skills/orchestrate/scripts/agent_statusline.py --harness claude"
                        ),
                    }
                }
            )
        )
        self.assertTrue(installer.install_claude_statusline(claude_settings, fast_bin=fast_bin, home=self.base))
        claude_updated = json.loads(claude_settings.read_text())
        self.assertEqual(
            claude_updated["statusLine"]["command"],
            shlex.join([str(fast_bin), "statusline", "--harness", "claude"]),
        )
        self.assertNotIn("--fallback-script", claude_updated["statusLine"]["command"])
        self.assertNotIn("[ -x ", claude_updated["statusLine"]["command"])
        self.assertFalse(installer.install_claude_statusline(claude_settings, fast_bin=fast_bin, home=self.base))

    def test_upgrade_statusline_command_preserves_flags_when_stripping_fallback_script(self):
        fast_bin = self.base / ".cache/orchestrate/bin/ork-fast"
        self.assertEqual(
            installer.upgrade_statusline_command(
                f"{fast_bin} statusline --harness codex --fallback-script /old/agent_statusline.py",
                fast_bin=fast_bin,
                home=self.base,
            ),
            shlex.join([str(fast_bin), "statusline", "--harness", "codex"]),
        )

    def test_ensure_ork_fast_is_mandatory_and_ignores_ork_disable_fast(self):
        cache_dir = self.base / "empty-cache"
        with (
            mock.patch.dict(
                installer.os.environ,
                {"XDG_CACHE_HOME": str(cache_dir), "ORK_DISABLE_FAST": "1", "ORK_FAST_BIN": ""},
            ),
            mock.patch.object(installer, "_build_local_ork_fast", return_value=False),
            mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("offline")),
        ):
            with self.assertRaisesRegex(RuntimeError, "ork-fast binary is required"):
                installer.ensure_ork_fast(home=self.base)
            # runtime_paths.ork_fast_bin still honors ORK_FAST_BIN / compiled bin even if ORK_DISABLE_FAST=1.
            self.assertEqual(
                installer.runtime_paths.ork_fast_bin(env={"ORK_DISABLE_FAST": "1", "ORK_FAST_BIN": str(self.fast_bin)}),
                self.fast_bin,
            )

    def test_ensure_macos_hud_handles_non_darwin_dry_run_cache_hash_and_missing_xcrun(self):
        cache_dir = self.base / "hud-cache"
        env = {"XDG_CACHE_HOME": str(cache_dir)}
        expected_bin = cache_dir / "orchestrate" / "macos" / "OrkestHUD.app" / "Contents" / "MacOS" / "OrkestHUD"

        with mock.patch.object(installer.sys, "platform", "linux"):
            self.assertIsNone(installer.ensure_macos_hud(home=self.base, env=env))

        with (
            mock.patch.object(installer.sys, "platform", "darwin"),
            redirect_stdout(io.StringIO()) as buf,
        ):
            self.assertEqual(installer.ensure_macos_hud(dry_run=True, home=self.base, env=env), expected_bin)
            self.assertIn("would ensure OrkestHUD.app", buf.getvalue())

        plugin_root = self.base / "plugin"
        macos_dir = plugin_root / "macos"
        macos_dir.mkdir(parents=True)
        build_sh = macos_dir / "build.sh"
        hud_swift = macos_dir / "hud.swift"
        build_sh.write_text("#!/bin/sh\necho build\n")
        hud_swift.write_text("// swift hud v1\n")

        with (
            mock.patch.object(installer.sys, "platform", "darwin"),
            mock.patch.object(installer.shutil, "which", return_value=None),
        ):
            self.assertIsNone(installer.ensure_macos_hud(plugin_root, home=self.base, env=env))

        def fake_build(argv, **kwargs):
            expected_bin.parent.mkdir(parents=True, exist_ok=True)
            expected_bin.write_text("#!/bin/sh\n")
            expected_bin.chmod(0o755)
            info_plist = expected_bin.parents[1] / "Info.plist"
            info_plist.write_bytes(plistlib.dumps({"OrkestHUDBuildHash": kwargs["env"]["ORKEST_HUD_BUILD_HASH"]}))
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with (
            mock.patch.object(installer.sys, "platform", "darwin"),
            mock.patch.object(installer.shutil, "which", return_value="/usr/bin/xcrun"),
            mock.patch.object(installer.subprocess, "run", side_effect=fake_build) as run_mock,
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(installer.ensure_macos_hud(plugin_root, home=self.base, env=env), expected_bin)
            self.assertEqual(run_mock.call_count, 1)
            # Second call with identical sources hits Info.plist build hash cache and skips rebuild.
            self.assertEqual(installer.ensure_macos_hud(plugin_root, home=self.base, env=env), expected_bin)
            self.assertEqual(run_mock.call_count, 1)
            # Editing hud.swift invalidates the hash and triggers one rebuild.
            hud_swift.write_text("// swift hud v2\n")
            self.assertEqual(installer.ensure_macos_hud(plugin_root, home=self.base, env=env), expected_bin)
            self.assertEqual(run_mock.call_count, 2)

    def test_fast_bin_validation_in_install_and_shell_wrappers(self):
        ork_cli = self.base / "bin/ork.mjs"
        ork_cli.parent.mkdir(parents=True)
        ork_cli.write_text("#!/usr/bin/env node\n")

        missing = self.base / "ork-fast-missing"
        directory = self.base / "ork-fast-dir"
        directory.mkdir()
        non_exec = self.base / "ork-fast-nonexec"
        non_exec.write_text("#!/bin/sh\n")
        non_exec.chmod(0o644)
        wrong_name = self.base / "not-ork-fast"
        wrong_name.write_text("#!/bin/sh\n")
        wrong_name.chmod(0o755)
        symlink_wrong_target = self.base / "ork-fast-link"
        symlink_wrong_target.symlink_to(wrong_name)

        for bad in (missing, directory, non_exec, wrong_name, symlink_wrong_target):
            with self.subTest(bad=bad.name):
                with self.assertRaises(ValueError):
                    installer.install_shell_wrappers(self.base, ork_cli, fast_bin=bad, dry_run=True)
                with self.assertRaises(ValueError):
                    installer.install(dry_run=True, verify=False, fast_bin=bad)

        good = self.base / "ork-fast-custom"
        good.write_text("#!/bin/sh\n")
        good.chmod(0o755)
        with (
            mock.patch.object(Path, "home", return_value=self.base),
            mock.patch.object(installer.shutil, "which", return_value=None),
            redirect_stdout(io.StringIO()),
        ):
            self.assertTrue(installer.install_shell_wrappers(self.base, ork_cli, fast_bin=good, dry_run=True))
            installer.install(dry_run=True, verify=False, fast_bin=good)

    def test_delegated_run_cannot_self_trust_codex_hooks(self):
        for env in ({"ORKEST_DELEGATED_RUN": "1"}, {"AGENT_EXECUTOR_RUN_ID": "run-123"}):
            with self.subTest(env=env), mock.patch.dict(installer.os.environ, env):
                with self.assertRaisesRegex(ValueError, "delegated agent runs cannot self-trust Codex hooks"):
                    installer.install(dry_run=True, trust_codex_hooks=True, verify=False)
                # Without trust_codex_hooks=True, install does not trigger the guard.
                with (
                    mock.patch.object(Path, "home", return_value=self.base),
                    mock.patch.object(installer.shutil, "which", return_value=None),
                    redirect_stdout(io.StringIO()),
                ):
                    installer.install(dry_run=True, trust_codex_hooks=False, verify=False)

    def test_check_mailbox_allows_pending_codex_hook_trust_only_when_not_required(self):
        cache_dir = self.base / "cache"
        codex_home = self.base / ".codex"
        codex_home.mkdir()
        (codex_home / "config.toml").write_text("[mcp_servers.peer-mailbox]\ncommand = 'python3'\n")
        inboxes: dict[str, list[dict[str, str | None]]] = {}
        counter = 0

        def dispatch_tool(session: str, tool: str, args: dict) -> dict:
            nonlocal counter
            if tool in ("register", "peers"):
                return {"content": [{"type": "text", "text": "[]"}], "structuredContent": {"peers": []}}
            if tool == "send":
                counter += 1
                msg_id = f"msg-{counter}"
                inboxes.setdefault(args["to"], []).append(
                    {"id": msg_id, "from": session, "text": args["text"], "replyTo": args.get("replyTo")}
                )
                return {
                    "content": [{"type": "text", "text": json.dumps({"id": msg_id})}],
                    "structuredContent": {"id": msg_id},
                }
            if tool == "inbox":
                msgs = list(inboxes.get(session, []))
                if not args.get("_http"):
                    inboxes[session] = []
                text = (
                    "\n".join(f"<peer-message>{m['text']}</peer-message>" for m in msgs)
                    if msgs
                    else "no unread peer messages"
                )
                return {"content": [{"type": "text", "text": text}], "structuredContent": {"messages": msgs}}
            if tool == "ack":
                acked = set(args["ids"])
                inboxes[session] = [m for m in inboxes.get(session, []) if m["id"] not in acked]
                return {"content": [], "structuredContent": {}}
            if tool == "wait":
                matches = [m for m in inboxes.get(session, []) if m.get("replyTo") == args.get("replyTo")]
                text = "\n".join(f"<peer-message>{m['text']}</peer-message>" for m in matches)
                return {"content": [{"type": "text", "text": text}], "structuredContent": {"messages": matches}}
            raise AssertionError(f"unexpected tool {tool}")

        class FakeRpcClient:
            def __init__(self, command, env=None):
                self.command = command

            def write(self, _value):
                pass

            def request(self, method, params):
                if method == "initialize":
                    return {}
                if method == "thread/start":
                    return {"thread": {"id": "codex-thread"}}
                if method == "mcpServer/tool/call":
                    return dispatch_tool(params["threadId"], params["tool"], params["arguments"])
                if method == "tools/call":
                    meta = params["_meta"]
                    sid = meta.get("sessionId") or meta.get("ai.opencode/sessionID")
                    return dispatch_tool(sid, params["name"], params["arguments"])
                raise AssertionError(f"unexpected rpc method {method}")

            def close(self):
                pass

        class FakeHttpConnection:
            def __init__(self, *_args, **_kwargs):
                self.payload = b"{}"

            def request(self, _method, _path, body, _headers):
                req = json.loads(body)
                params = req["params"]
                args = {**params["arguments"], "_http": True}
                res = dispatch_tool(args["session"], params["name"], args)
                self.payload = json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": res}).encode("utf-8")

            def getresponse(self):
                return mock.Mock(status=200, read=lambda: self.payload)

            def close(self):
                pass

        pending_error = RuntimeError(
            "Codex mailbox hooks need review: use /hooks or doctor --repair-messaging --trust-codex-hooks"
        )
        with (
            mock.patch.dict(os.environ, {"XDG_CACHE_HOME": str(cache_dir), "CODEX_HOME": str(codex_home)}),
            mock.patch.object(Path, "home", return_value=self.base),
            mock.patch.object(
                installer,
                "configuration_status",
                return_value={"codex": {"configured": True, "issues": []}},
            ),
            mock.patch.object(check_mailbox.shutil, "which", return_value="/usr/bin/codex"),
            mock.patch.object(check_mailbox, "RpcClient", FakeRpcClient),
            mock.patch("http.client.HTTPConnection", FakeHttpConnection),
            mock.patch.object(
                mailbox_daemon, "ensure_running", return_value={"url": "http://127.0.0.1:49999/mcp", "pid": 1}
            ),
            mock.patch.object(mailbox_daemon, "read_token", return_value="tok"),
            mock.patch.object(mailbox_daemon, "stop_service"),
        ):
            with (
                mock.patch.object(mailbox_daemon, "get_mode", return_value="stdio"),
                mock.patch.object(check_mailbox, "_verify_codex_hook_trust", side_effect=pending_error),
            ):
                with self.assertRaisesRegex(RuntimeError, "Codex mailbox hooks need review"):
                    check_mailbox.check()
                stdio_report = check_mailbox.check(require_codex_hook_trust=False)
                self.assertEqual(stdio_report["codex_hook_trust"], "pending_review")
                self.assertEqual(len(stdio_report["round_trips"]), 12)

            inboxes.clear()
            with (
                mock.patch.object(mailbox_daemon, "get_mode", return_value="http"),
                mock.patch.object(check_mailbox, "_verify_codex_hook_trust", side_effect=pending_error),
            ):
                with self.assertRaisesRegex(RuntimeError, "Codex mailbox hooks need review"):
                    check_mailbox.check()
                http_report = check_mailbox.check(require_codex_hook_trust=False)
                self.assertEqual(http_report["codex_hook_trust"], "pending_review")
                self.assertEqual(len(http_report["round_trips"]), 12)

            with (
                mock.patch.object(mailbox_daemon, "get_mode", return_value="stdio"),
                mock.patch.object(
                    check_mailbox,
                    "_verify_codex_hook_trust",
                    side_effect=ValueError("Expected exactly four mailbox hooks"),
                ),
            ):
                with self.assertRaisesRegex(ValueError, "exactly four"):
                    check_mailbox.check(require_codex_hook_trust=False)

    def test_custom_wrapper_aliases_reject_zsh_hooks_and_special_namespaces(self):
        rejected = [
            "precmd",  # cspell:ignore precmd
            "preexec",  # cspell:ignore preexec
            "chpwd",  # cspell:ignore chpwd
            "periodic",
            "zshexit",  # cspell:ignore zshexit
            "zshaddhistory",  # cspell:ignore zshaddhistory
            "zsh_directory_name",
            "PROMPT_COMMAND",
            "command_not_found_handle",
            "command_not_found_handler",
            "_private_helper",
            "TRAPINT",
            "trap_exit",
            "chpwd_functions",
            "custom_FUNCTIONS",
        ]
        monitor_config = {
            "accounts": [
                {"id": f"acct-{idx}", "provider": "claude", "alias": name}
                for idx, name in enumerate([*rejected, "claude-alt"])
            ]
            + [{"id": "acct-route", "provider": "codex", "route": "precmd_functions"}]
        }
        aliases = installer._custom_wrapper_aliases(self.base, monitor_config=monitor_config)
        self.assertEqual(aliases, [("claude-alt", "claude")])


class AccountFederationTests(unittest.TestCase):
    """Per-profile federation: account_profile_targets, sync_account_profiles and the narrow CLI modes."""

    URL = "http://127.0.0.1:49152/mcp"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.config_path = self.base / "monitor.json"
        environment = {"HOME": str(self.base), "MONITOR_CONFIG": str(self.config_path), "HERDR_ENV": "0"}
        patcher = mock.patch.dict(installer.os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in (
            "CODEX_HOME",
            "XDG_CONFIG_HOME",
            "CLAUDE_CONFIG_DIR",
            "ORKEST_DELEGATED_RUN",
            "AGENT_EXECUTOR_RUN_ID",
        ):
            self.enterContext(mock.patch.dict(installer.os.environ)).pop(name, None)
        self.enterContext(mock.patch.object(Path, "home", return_value=self.base))
        self.enterContext(mock.patch.object(installer.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"))
        self.enterContext(mock.patch.object(installer.mailbox, "root", return_value=self.base / "mailbox"))
        self.ensure = self.enterContext(
            mock.patch.object(installer.mailbox_daemon, "ensure_running", return_value={"url": self.URL})
        )
        self.enterContext(mock.patch.object(installer.mailbox_daemon, "read_token", return_value="tok-secret"))
        self.fast_bin = ORK_FAST.find_ork_fast_bin()

    def accounts(self):
        home = self.base
        shared = home / ".antigravity-shared"
        return [
            {"id": "claude-a", "provider": "claude", "configDir": str(home / ".claude-a")},
            {"id": "claude-b", "provider": "claude", "configDir": "~/.claude-b"},
            {"id": "claude-odd", "provider": "claude", "configDir": str(home / "odd dir" / ".claude")},
            {"id": "claude-empty", "provider": "claude", "configDir": str(home / "elsewhere" / "empty")},
            {"id": "claude-dup", "provider": "claude", "configDir": str(home / ".claude-a")},
            {"id": "codex-a", "provider": "codex", "env": {"CODEX_HOME": str(home / ".codex-a")}},
            {"id": "codex-b", "provider": "codex", "env": {"CODEX_HOME": "~/.codex-b"}},
            {"id": "codex-c", "provider": "codex", "env": {"CODEX_HOME": str(home / "x y" / "codex")}},
            {
                "id": "agy-a",
                "provider": "antigravity",
                "env": {"ANTIGRAVITY_APP_DATA_DIR": str(shared), "GEMINI_CLI_HOME": str(shared)},
            },
            {
                "id": "agy-b",
                "provider": "antigravity",
                "env": {"ANTIGRAVITY_APP_DATA_DIR": str(shared), "GEMINI_CLI_HOME": str(shared)},
            },
            {
                "id": "agy-c",
                "provider": "antigravity",
                "env": {
                    "ANTIGRAVITY_APP_DATA_DIR": str(home / ".antigravity-c"),
                    "GEMINI_CLI_HOME": str(home / ".antigravity-c"),
                },
            },
            *(
                {
                    "id": f"oc-{name}",
                    "provider": "opencode",
                    "env": {"XDG_CONFIG_HOME": str(home / f".opencode-{name}" / "config")},
                }
                for name in "abc"
            ),
        ]

    def seed(self, accounts=None):
        accounts = self.accounts() if accounts is None else accounts
        self.config_path.write_text(json.dumps({"accounts": accounts, "policy": {"keep": True}}))
        (self.base / ".claude").mkdir()
        (self.base / ".claude-b").mkdir()
        (self.base / ".claude-b/settings.json").write_text('{"theme": "dark"}\n')
        (self.base / ".codex-a").mkdir()
        (self.base / ".codex-a/config.toml").write_text('# keep me\n[mcp_servers.other]\ncommand = "x"\n')
        oc = self.base / ".opencode-a/config/opencode"
        oc.mkdir(parents=True)
        (oc / "opencode.jsonc").write_text('{\n  // keep\n  "mcp": {"other": {"type": "local", "command": ["x"]}}\n}\n')
        return accounts

    def snapshot(self):
        state = {}
        for root, dirs, files in os.walk(self.base):
            for name in [*dirs, *files]:
                path = Path(root) / name
                stat = path.lstat()
                state[str(path)] = (stat.st_mode, stat.st_mtime_ns, path.read_bytes() if path.is_file() else None)
        return state

    def sync(self, **kwargs):
        with redirect_stdout(io.StringIO()), mock.patch.object(sys, "stderr", io.StringIO()):
            return installer.sync_account_profiles(
                self.base, json.loads(self.config_path.read_text()), fast_bin=self.fast_bin, **kwargs
            )

    def test_targets_union_legacy_and_accounts_and_deduplicate_canonical_paths(self):
        self.seed()
        targets = installer.account_profile_targets(self.base, json.loads(self.config_path.read_text()))
        by_main = {str(t["main"]): t for t in targets if "main" in t}
        self.assertEqual(by_main[str(self.base / ".claude.json")]["ids"], [])
        self.assertEqual(by_main[str(self.base / ".claude-a/.claude.json")]["ids"], ["claude-a", "claude-dup"])
        # A custom directory whose basename is .claude is not the default profile.
        self.assertIn(str(self.base / "odd dir/.claude/.claude.json"), by_main)
        self.assertIn(str(self.base / "elsewhere/empty/.claude.json"), by_main)
        self.assertEqual(
            by_main[str(self.base / ".antigravity-shared/.gemini/config/mcp_config.json")]["ids"], ["agy-a", "agy-b"]
        )
        self.assertIn(str(self.base / ".codex/config.toml"), by_main)
        self.assertIn(str(self.base / "x y/codex/config.toml"), by_main)
        self.assertIn(str(self.base / ".opencode-a/config/opencode/opencode.jsonc"), by_main)
        self.assertIn(str(self.base / ".opencode-b/config/opencode/opencode.json"), by_main)

    def test_invalid_configured_profiles_error_per_account_without_dropping_others(self):
        (self.base / "real").mkdir()
        (self.base / "link").symlink_to(self.base / "real")
        accounts = [
            {"id": "rel", "provider": "claude", "configDir": "relative/dir"},
            {"id": "home", "provider": "codex", "env": {"CODEX_HOME": "~"}},
            {"id": "sym", "provider": "claude", "configDir": str(self.base / "link/inner")},
            {"id": "ok", "provider": "claude", "configDir": str(self.base / ".claude-ok")},
        ]
        self.config_path.write_text(json.dumps({"accounts": accounts}))
        result = self.sync()
        self.assertEqual({e["id"] for e in result["errors"]}, {"rel", "home", "sym"})
        self.assertTrue(any(p["id"] == "ok" and p["status"] == "changed" for p in result["profiles"]))
        self.assertTrue((self.base / ".claude-ok/.claude.json").is_file())
        self.assertFalse((self.base / "real/inner").exists())

    def test_federation_registers_both_services_per_profile_on_one_endpoint_and_is_idempotent(self):
        self.seed()
        launcher = self.base / ".local/bin/monitor"
        launcher.parent.mkdir(parents=True)
        launcher.write_text("#!/bin/sh\n")
        launcher.chmod(0o755)
        (self.base / ".claude-b/settings.json").write_text(
            '{"theme": "dark", "enabledPlugins": {"monitor@orkest": true}}\n'
        )
        first = self.sync()
        self.assertEqual(first["errors"], [])
        for profile in (".claude-a", ".claude-b", "odd dir/.claude", "elsewhere/empty"):
            config = json.loads((self.base / profile / ".claude.json").read_text())
            self.assertEqual(config["mcpServers"]["peer-mailbox"]["url"], self.URL, profile)
            self.assertEqual(("monitor" in config["mcpServers"]), profile != ".claude-b", profile)
            settings = json.loads((self.base / profile / "settings.json").read_text())
            self.assertIn("Stop", settings["hooks"])
        self.assertEqual(json.loads((self.base / ".claude-b/settings.json").read_text())["theme"], "dark")
        for home in (".codex-a", ".codex-b", "x y/codex"):
            parsed = tomllib.loads((self.base / home / "config.toml").read_text())
            self.assertEqual(parsed["mcp_servers"]["peer-mailbox"]["url"], self.URL)
            self.assertIn("monitor", parsed["mcp_servers"])
            self.assertTrue((self.base / home / "hooks.json").is_file())
            self.assertTrue((self.base / home / "rules/orkest.rules").is_file())
        text = (self.base / ".codex-a/config.toml").read_text()
        self.assertIn("# keep me", text)
        self.assertEqual(tomllib.loads(text)["mcp_servers"]["other"], {"command": "x"})
        for root in (".antigravity-shared", ".antigravity-c"):
            cfg = self.base / root / ".gemini/config"
            self.assertEqual(
                json.loads((cfg / "mcp_config.json").read_text())["mcpServers"]["peer-mailbox"]["serverUrl"], self.URL
            )
            self.assertIn("peer-mailbox", json.loads((cfg / "hooks.json").read_text()))
        for name in "abc":
            directory = self.base / f".opencode-{name}/config/opencode"
            # Backups share the prefix and glob order is filesystem-dependent; read the live config only.
            found = next(path for path in (directory / "opencode.jsonc", directory / "opencode.json") if path.is_file())
            self.assertIn(self.URL, found.read_text())
            self.assertIn('"monitor"', found.read_text())
        self.assertIn("// keep", (self.base / ".opencode-a/config/opencode/opencode.jsonc").read_text())
        # Shared AGY root: exactly one profile target, listed for both accounts.
        agy = [p for p in first["profiles"] if p["provider"] == "antigravity" and p["id"] in {"agy-a", "agy-b"}]
        self.assertEqual({p["home"] for p in agy}, {str(self.base / ".antigravity-shared")})
        before = self.snapshot()
        second = self.sync()
        self.assertEqual(second["errors"], [])
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(all(p["status"] in {"current", "unavailable"} for p in second["profiles"]))

    def test_gate_hook_is_mirrored_only_where_the_user_already_opted_in(self):
        import gate

        self.seed()
        self.sync()
        for profile in (".claude-a", ".claude-b"):
            self.assertNotIn("PreToolUse", json.loads((self.base / profile / "settings.json").read_text())["hooks"])
        default = self.base / ".claude/settings.json"
        default.write_text(
            json.dumps(gate.updated({}, "claude", Path(gate.__file__).resolve(), fast_bin=self.fast_bin))
        )
        self.sync()
        for profile in (".claude-a", ".claude-b", "odd dir/.claude"):
            settings = json.loads((self.base / profile / "settings.json").read_text())
            commands = [h["command"] for g in settings["hooks"]["PreToolUse"] for h in g["hooks"]]
            self.assertEqual(len([c for c in commands if "gate-hook" in c]), 1, profile)
        self.assertEqual(json.loads((self.base / ".claude-b/settings.json").read_text())["theme"], "dark")
        before = self.snapshot()
        self.sync()
        self.assertEqual(self.snapshot(), before)

    def test_delegated_runs_cannot_self_trust_through_federation(self):
        self.seed()
        before = self.snapshot()
        with mock.patch.dict(installer.os.environ, {"ORKEST_DELEGATED_RUN": "1"}):
            with self.assertRaisesRegex(ValueError, "cannot self-trust"):
                installer.sync_account_profiles(self.base, {}, trust_codex_hooks=True, dry_run=True)
            with self.assertRaisesRegex(ValueError, "cannot self-trust"):
                installer.apply_profile_target(
                    {"harness": "codex", "home": self.base / ".codex", "main": self.base / ".codex/config.toml"},
                    self.base, self.base, fast_bin=self.fast_bin, dry_run=True, stdio=True,
                    daemon_url="", daemon_token="", trust_codex_hooks=True,
                )  # fmt: skip
            # Without the trust request a delegated run still federates, and never trusts.
            self.assertEqual(self.sync()["errors"], [])
        self.assertNotEqual(self.snapshot(), before)
        for home in (".codex-a", ".codex-b"):
            self.assertNotIn("trusted_hash", (self.base / home / "config.toml").read_text())

    def test_ordinary_install_uses_the_same_targets_monitor_semantics_and_isolation(self):
        self.seed()
        launcher = self.base / ".local/bin/monitor"
        launcher.parent.mkdir(parents=True)
        launcher.write_text("#!/bin/sh\n")
        launcher.chmod(0o755)
        (self.base / ".claude-b/settings.json").write_text(
            '{"theme": "dark", "enabledPlugins": {"monitor@orkest": true}}\n'
        )
        (self.base / ".claude-a").mkdir()
        (self.base / ".claude-a/.credentials.json").write_text("secret-a")
        for name in (
            "ensure_hub", "ensure_macos_hud", "approve_orkest_commands", "install_shell_wrappers",
            "sync_installed_runtimes_and_caches", "install_login_startup", "prune_daemon_runtimes",
        ):  # fmt: skip
            self.enterContext(mock.patch.object(installer, name))
        self.enterContext(mock.patch.object(installer, "ensure_ork_fast", return_value=self.fast_bin))
        self.enterContext(mock.patch.object(installer.mailbox_daemon, "set_mode"))
        self.enterContext(mock.patch.object(installer.mailbox_daemon, "runtime_revision", return_value="r"))
        self.ensure.return_value = {"url": self.URL, "runtimeRevision": "r"}
        with redirect_stdout(io.StringIO()), mock.patch.object(sys, "stderr", io.StringIO()):
            installer.install(verify=False, fast_bin=self.fast_bin)
        urls = set()
        for profile in (".claude-a", ".claude-b", "odd dir/.claude", "elsewhere/empty"):
            servers = json.loads((self.base / profile / ".claude.json").read_text())["mcpServers"]
            urls.add(servers["peer-mailbox"]["url"])
            self.assertEqual("monitor" in servers, profile != ".claude-b", profile)
        for home in (".codex-a", ".codex-b", "x y/codex"):
            urls.add(
                tomllib.loads((self.base / home / "config.toml").read_text())["mcp_servers"]["peer-mailbox"]["url"]
            )
        self.assertEqual(urls, {self.URL})
        # Credentials stay with their own profile; no other profile receives them.
        self.assertEqual(sorted(p.parent.name for p in self.base.rglob(".credentials.json")), [".claude-a"])
        self.assertNotIn("secret-a", "".join(p.read_text() for p in self.base.rglob(".claude.json")))

    def test_dry_run_changes_nothing_and_never_touches_the_daemon(self):
        self.seed()
        before = self.snapshot()
        self.ensure.side_effect = AssertionError("daemon must not start in a dry run")
        with mock.patch.object(installer.subprocess, "run", side_effect=AssertionError("no subprocess")):
            result = self.sync(dry_run=True)
        self.assertEqual(self.snapshot(), before)
        self.assertIn("would-change", {p["status"] for p in result["profiles"]})
        self.assertNotIn("tok-secret", json.dumps(result))

    def test_absent_binary_and_malformed_config_do_not_hide_other_profiles(self):
        self.seed()
        (self.base / ".claude-a").mkdir()
        (self.base / ".claude-a/.claude.json").write_text("{not json")
        real_which = installer.shutil.which
        with mock.patch.object(
            installer.shutil, "which", side_effect=lambda n: None if n == "opencode" else real_which(n)
        ):
            result = self.sync()
        statuses = {(p["id"]): p["status"] for p in result["profiles"]}
        self.assertEqual(statuses["oc-a"], "unavailable")
        self.assertEqual(statuses["claude-a"], "error")
        self.assertEqual((self.base / ".claude-a/.claude.json").read_text(), "{not json")
        self.assertEqual(statuses["codex-b"], "changed")
        self.assertTrue(any(e["id"] == "claude-a" for e in result["errors"]))

    def test_cli_modes_emit_one_json_object_and_reject_trust_changes(self):
        self.seed()
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.object(sys, "stderr", io.StringIO()):
            code = installer.main(["--account-sync", "--json", "--dry-run", "--fast-bin", str(self.fast_bin)])
        payload = json.loads(out.getvalue())
        self.assertEqual((code, payload["schema"], payload["dryRun"]), (0, "ork.account.sync.v1", True))
        self.assertEqual(payload["shell"]["status"], "would-change")
        with mock.patch.object(sys, "stderr", io.StringIO()), self.assertRaises(SystemExit):
            installer.main(["--account-sync", "--trust-codex-hooks"])
        # --shell-sync touches only wrapper artifacts.
        with redirect_stdout(io.StringIO()), mock.patch.object(sys, "stderr", io.StringIO()):
            installer.main(["--shell-sync", "--json"])
        self.assertTrue((self.base / ".config/orkest/shell.zsh").is_file())
        self.assertFalse((self.base / ".codex-a/hooks.json").exists())
        self.assertFalse((self.base / ".agents").exists())

    def test_shell_artifacts_refuse_foreign_files(self):
        canonical = self.base / ".config/orkest/shell.zsh"
        canonical.parent.mkdir(parents=True)
        canonical.write_text("# mine\n")
        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, "does not own"):
            installer.sync_shell_artifacts(self.base)
        self.assertEqual(canonical.read_text(), "# mine\n")

    @unittest.skipUnless(ZSH, "zsh is required")
    def test_zsh_functions_follow_accounts_and_removal_only_drops_that_function(self):
        bin_dir = self.base / "fakebin"
        bin_dir.mkdir()
        for name in ("claude", "codex"):
            (bin_dir / name).write_text(f'#!/bin/sh\necho "RAN {name} $*"\n')
            (bin_dir / name).chmod(0o755)
        (bin_dir / "ork").write_text('#!/bin/sh\necho FOOTER\nshift 2\nexec "$@"\n')
        (bin_dir / "ork").chmod(0o755)
        accounts = [
            {"id": "claude-w", "provider": "claude", "alias": "claude-w", "route": "claude-w"},
            {"id": "codex-w", "provider": "codex", "alias": "codex-w", "route": "codex-w"},
        ]
        config = {"accounts": accounts}
        with redirect_stdout(io.StringIO()):
            installer.sync_shell_artifacts(self.base, monitor_config=config)
        for name in ("claude-w", "codex-w"):
            (bin_dir / name).write_text(f'#!/bin/sh\necho "RAN {name} $*"\n')
            (bin_dir / name).chmod(0o755)
        shell = self.base / ".config/orkest/shell.zsh"

        def run(command, tty):
            env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(self.base)}
            if not tty:
                return subprocess.run(
                    [ZSH, "-f", "-c", f"source {shlex.quote(str(shell))}; {command}"],
                    capture_output=True, text=True, env=env, timeout=20,
                ).stdout  # fmt: skip
            master, slave = pty.openpty()
            process = subprocess.Popen(
                [ZSH, "-f", "-c", f"source {shlex.quote(str(shell))}; {command}"],
                stdin=slave, stdout=slave, stderr=slave, env=env,
            )  # fmt: skip
            os.close(slave)
            chunks = b""
            while True:
                try:
                    data = os.read(master, 4096)
                except OSError:
                    break
                if not data:
                    break
                chunks += data
            process.wait(timeout=20)
            os.close(master)
            return chunks.decode()

        interactive = run("claude-w hello", tty=True)
        self.assertEqual(interactive.count("FOOTER"), 1, interactive)
        self.assertIn("RAN claude-w", interactive)
        self.assertNotIn("FOOTER", run("claude-w mcp list", tty=True))
        self.assertNotIn("FOOTER", run("claude-w hello", tty=False))
        self.assertIn("RAN claude-w mcp list", run("claude-w mcp list", tty=False))
        with redirect_stdout(io.StringIO()):
            installer.sync_shell_artifacts(self.base, monitor_config={"accounts": accounts[1:]})
        self.assertIn("function", run("whence -w codex-w", tty=False))
        self.assertNotIn("function", run("whence -w claude-w", tty=False))

    def test_profiles_with_different_homes_exchange_and_acknowledge_messages(self):
        mailbox_root = self.base / "mb-integration"
        alpha, beta = self.base / ".claude-alpha", self.base / ".codex-beta"
        peers = {}
        sleepers = [subprocess.Popen(["sleep", "60"]) for _ in range(2)]
        for sleeper in sleepers:
            self.addCleanup(sleeper.wait)
            self.addCleanup(sleeper.kill)
        for session, harness, account, pid in (
            ("alpha", "claude", alpha, sleepers[0].pid),
            ("beta", "codex", beta, sleepers[1].pid),
        ):
            peers[session] = mailbox.register(
                mailbox_root,
                session=session,
                harness=harness,
                cwd=str(self.base),
                pid=pid,
                account=str(account),
            )
        sent = mailbox.send(
            mailbox_root, sender=mailbox.sender_address(peers["alpha"]), to=peers["beta"]["name"], text="ping", kind="update", wake=False, scope="cross-project"
        )  # fmt: skip
        inbox = mailbox.messages(mailbox_root, "beta")
        self.assertEqual([m["text"] for m in inbox], ["ping"])
        self.assertEqual(mailbox.mark_read(mailbox_root, "beta", [inbox[0]["id"]]), [inbox[0]["id"]])
        mailbox.send(
            mailbox_root, sender=mailbox.sender_address(peers["beta"]), to=peers["alpha"]["name"], text="pong", kind="update", wake=False, scope="cross-project"
        )  # fmt: skip
        back = mailbox.messages(mailbox_root, "alpha")
        self.assertEqual([m["text"] for m in back], ["pong"])
        self.assertEqual(mailbox.mark_read(mailbox_root, "alpha", [back[0]["id"]]), [back[0]["id"]])
        self.assertEqual(mailbox.messages(mailbox_root, "alpha"), [])
        self.assertTrue(sent)


if __name__ == "__main__":
    unittest.main()
