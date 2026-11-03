"""User-visible mailbox setup, preservation and scoped hook trust."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import install_mailbox as installer  # noqa: E402 -- exercise the shipped installer
import mailbox_mcp  # noqa: E402 -- the server defines the installed tool catalog


class InstallMailboxTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.path = self.base / "settings.json"
        self.script = Path("/home/example/skill hub/peer_mailbox.py")

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
                    "command": "python3 '/home/example/skill hub/peer_mailbox.py' hook --harness gemini --event PreInvocation",
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
                            "command": "python3 '/home/example/skill hub/peer_mailbox.py' hook --harness codex",
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
                    ]
                }
            }
        )
        self.path.write_text(original)

        installer.install_hooks(self.path, new, "codex")

        hooks = json.loads(self.path.read_text())["hooks"]
        self.assertEqual(
            [entry["command"] for entry in hooks["Stop"][0]["hooks"]],
            [f"python3 {new} hook --harness codex", "other-tool stop"],
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
            set(json.loads(self.path.read_text())["hooks"]), {"SessionStart", "SessionEnd", "Stop", "UserPromptSubmit"}
        )

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
        command = "python3 '/home/example/skill hub/peer_mailbox.py' hook --harness codex"
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
        hooks[0]["command"] += " ; run something else"
        with self.assertRaisesRegex(ValueError, "exactly four"):
            installer.mailbox_hook_updates({"data": [{"hooks": hooks}]}, self.script, self.path)

    def test_shell_wrappers_generate_orkest_sh_and_wire_zshrc_idempotently(self):
        ork_cli = self.base / "bin/ork.mjs"
        ork_cli.parent.mkdir(parents=True)
        ork_cli.write_text("#!/usr/bin/env node\n")
        (self.base / ".claude").mkdir()
        (self.base / ".codex").mkdir()
        zshrc = self.base / ".zshrc"
        zshrc.write_text("export EXAMPLE=1\n")

        self.assertTrue(installer.install_shell_wrappers(self.base, ork_cli, dry_run=True))
        self.assertFalse((self.base / ".config/agent-executor/orkest.sh").exists())
        self.assertEqual(zshrc.read_text(), "export EXAMPLE=1\n")

        self.assertTrue(installer.install_shell_wrappers(self.base, ork_cli))
        wrapper = self.base / ".config/agent-executor/orkest.sh"
        self.assertTrue(wrapper.is_file())
        self.assertIn('command ork label -- agy --dangerously-skip-permissions "$@"', wrapper.read_text())
        self.assertIn('command ork agy --dangerously-skip-permissions "$@"', wrapper.read_text())
        self.assertNotIn("--remote-control", wrapper.read_text())
        self.assertEqual((self.base / ".local/bin/ork").resolve(), ork_cli.resolve())
        self.assertTrue((self.base / ".claude/commands/swarm.md").is_file())
        self.assertTrue((self.base / ".agents/skills/swarm/SKILL.md").is_file())
        self.assertEqual((self.base / ".codex/skills/swarm").resolve(), (self.base / ".agents/skills/swarm").resolve())
        self.assertIn(installer.MANAGED_ZSHRC_BLOCK, zshrc.read_text())
        self.assertIn("export EXAMPLE=1\n", zshrc.read_text())

        before_zshrc = zshrc.read_bytes()
        self.assertFalse(installer.install_shell_wrappers(self.base, ork_cli))
        self.assertEqual(zshrc.read_bytes(), before_zshrc)

    def test_swarm_command_context_toggles_swarm_view_on_slash_command(self):
        from unittest.mock import patch

        import peer_mailbox as mailbox

        me = {"session": "11111111-2222-4333-8444-555555555555", "harness": "claude", "cwd": str(self.base)}
        with patch(
            "agent_statusline_tmux.toggle_swarm_view",
            return_value={"status": "opened", "room": "room-123", "socket": "orkest-label-abcdef012345"},
        ) as mocked:
            out = mailbox.swarm_command_context(self.base, me, {"prompt": "/swarm"}, "UserPromptSubmit", mid_turn=False)
            self.assertIn("now opened (room room-123)", out)
            mocked.assert_called_once()
        with patch(
            "agent_statusline_tmux.toggle_swarm_view",
            return_value={"status": "closed", "room": "room-123", "socket": "orkest-label-abcdef012345"},
        ) as mocked:
            out = mailbox.swarm_command_context(
                self.base,
                me,
                {"prompt": "[orkest-swarm-command: close]\nIf the `/swarm` turn hook..."},
                "UserPromptSubmit",
                mid_turn=False,
            )
            self.assertIn("now closed (room room-123)", out)
            self.assertEqual(mocked.call_args.args[0], "close")


if __name__ == "__main__":
    unittest.main()
