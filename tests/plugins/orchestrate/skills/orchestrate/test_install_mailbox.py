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
            set(json.loads(self.path.read_text())["hooks"]),
            {"SessionStart", "SessionEnd", "Stop", "UserPromptSubmit", "SubagentStart", "SubagentStop"},
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
        self.assertIn('command ork label -- agy --dangerously-skip-permissions "$@"', wrapper.read_text())
        self.assertIn('command ork agy --dangerously-skip-permissions "$@"', wrapper.read_text())
        self.assertNotIn("--remote-control", wrapper.read_text())
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

    def test_hook_intercepts_bare_swarm_with_zero_tokens_and_allows_goal(self):
        from unittest.mock import patch

        import peer_mailbox as mailbox

        claude_sid = "11111111-2222-4333-8444-555555555555"
        agy_sid = "66666666-7777-4888-8999-aaaaaaaaaaaa"
        with patch(
            "agent_statusline_tmux.toggle_swarm_view",
            return_value={"status": "opened", "room": "room-777", "socket": "orkest-label-abcdef012345"},
        ) as mocked:
            # 1. Bare /swarm in Claude Code / Codex blocks the turn before calling the model (0 tokens).
            claude_res = mailbox.hook(
                {
                    "hook_event_name": "UserPromptSubmit",
                    "session_id": claude_sid,
                    "cwd": str(self.base),
                    "prompt": "/swarm",
                },
                harness="claude",
                base=self.base,
            )
            self.assertEqual(
                claude_res,
                {"decision": "block", "reason": "Orkest Swarm View pane is now opened (room room-777)."},
            )
            self.assertEqual(mailbox.load(mailbox.peer_path(self.base, claude_sid))["state"], "idle")

            # 2. Bare /horde in Antigravity (PreInvocation with lastUserInput) terminates before model call.
            agy_res = mailbox.hook(
                {
                    "conversationId": agy_sid,
                    "invocationNum": 1,
                    "workspacePaths": [str(self.base)],
                    "lastUserInput": "/horde",
                },
                harness="gemini",
                base=self.base,
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
            self.assertEqual(mailbox.load(mailbox.peer_path(self.base, agy_sid))["state"], "idle")

            # 3. /swarm <goal> opens the pane AND proceeds into the model turn with the goal context.
            mocked.reset_mock()
            goal_res = mailbox.hook(
                {
                    "hook_event_name": "UserPromptSubmit",
                    "session_id": claude_sid,
                    "cwd": str(self.base),
                    "prompt": "/swarm build the auth module",
                },
                harness="claude",
                base=self.base,
            )
            self.assertEqual(mocked.call_args.args[0], "open")
            self.assertIn("hookSpecificOutput", goal_res)
            self.assertIn(
                "Proceed with the user's swarm objective: build the auth module",
                goal_res["hookSpecificOutput"]["additionalContext"],
            )

    def test_install_herdr_integration_configures_ctrl_alt_s_shortcut(self):
        import json

        herdr_dir = self.base / ".config/herdr"
        herdr_dir.mkdir(parents=True, exist_ok=True)
        cfg = herdr_dir / "config.toml"
        cfg.write_text("onboarding = false\n", encoding="utf-8")
        plugins_json = herdr_dir / "plugins.json"
        plugins_json.write_text("[]\n", encoding="utf-8")

        changed = installer.install_herdr_integration(self.base)
        self.assertTrue(changed)
        cfg_text = cfg.read_text(encoding="utf-8")
        self.assertIn('key = "ctrl+alt+s"', cfg_text)
        self.assertIn('command = "orkest.swarms.toggle"', cfg_text)
        entries = json.loads(plugins_json.read_text(encoding="utf-8"))
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["plugin_id"], "orkest.swarms")
        action_ids = {a["id"] for a in entries[0]["actions"]}
        self.assertIn("toggle", action_ids)


if __name__ == "__main__":
    unittest.main()
