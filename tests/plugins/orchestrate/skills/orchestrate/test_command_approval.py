"""Opt-in approval of Orkest's own commands in temporary harness profiles."""

from __future__ import annotations

import contextlib
import io
import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import command_approval as approval  # noqa: E402 -- exercise the shipped module
import install_mailbox as installer  # noqa: E402 -- and its installer entry point

ALL = {"claude", "codex", "agy", "opencode"}
EXECUTABLE = "/opt/example/bin/python3"


def claude_allows(rules: list[str], command: str) -> bool:
    """Claude Code's literal `Bash(prefix:*)` match: the prefix alone or followed by a space."""
    for rule in rules:
        if rule.startswith("Bash(") and rule.endswith(":*)"):
            prefix = rule[5:-3]
            if command == prefix or command.startswith(prefix + " "):
                return True
    return False


def agy_allows(rules: list[str], command: str) -> bool:
    for rule in rules:
        if rule.startswith("command(") and rule.endswith(")"):
            prefix = rule[8:-1].split()
            if command.split()[: len(prefix)] == prefix:
                return True
    return False


def opencode_allows(rules: dict, command: str) -> bool:
    """OpenCode's last-matching-pattern rule, with a trailing ` *` also matching the bare prefix."""
    decision = None
    for pattern, effect in rules.items():
        regex = "".join(".*" if char == "*" else "." if char == "?" else re.escape(char) for char in pattern)
        if pattern.endswith(" *"):
            regex = regex[: -len(re.escape(" ") + ".*")] + "( .*)?"
        if re.fullmatch(regex, command, re.S):
            decision = effect
    return decision == "allow"


class CommandApprovalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "home"
        self.checkout = self.root / "checkout/plugins/orchestrate"
        self.source = self.checkout / "skills/orchestrate/scripts"
        self.source.mkdir(parents=True)
        (self.checkout / "bin").mkdir()
        (self.checkout / "bin/ork.mjs").write_text("")
        self.hub = self.home / ".agents/skills/orchestrate"
        self.hub.parent.mkdir(parents=True)
        self.hub.symlink_to(self.source.parent)
        for skills in (".claude/skills", ".codex/skills", ".config/opencode/skills", ".gemini/config/skills"):
            (self.home / skills).mkdir(parents=True)
            (self.home / skills / "orchestrate").symlink_to(self.hub)
        (self.home / ".gemini/antigravity-cli").mkdir(parents=True)
        self.codex = self.home / ".codex"
        self.claude = self.home / ".claude/settings.json"
        self.agy = self.home / ".gemini/antigravity-cli/settings.json"
        self.opencode = self.home / ".config/opencode/opencode.jsonc"
        self.state = self.home / ".config/orchestrate" / approval.STATE_NAME
        self.which = {"ork": str(self.home / ".local/bin/ork"), "python3": "/usr/bin/python3", "node": None}

    def scope(self):
        return approval.build_scope(
            self.home,
            self.hub / "scripts",
            source=self.source,
            which=self.which.get,
            executable=EXECUTABLE,
            environ={},
        )

    def run_approval(self, *, harnesses=ALL, **options):
        scope = self.scope()
        found = approval.targets(
            scope,
            harnesses=harnesses,
            claude_profiles=[self.home / ".claude"],
            codex_home=self.codex,
            agy_settings=self.agy,
            opencode_config=self.opencode,
            home=self.home,
        )
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = approval.apply(scope, found, state_path=self.state, **options)
        return result, output.getvalue()

    def snapshot(self) -> dict[str, str]:
        return {
            str(path.relative_to(self.home)): path.read_text()
            for path in sorted(self.home.rglob("*"))
            if path.is_file() and not path.is_symlink()
        }

    def claude_rules(self) -> list[str]:
        return json.loads(self.claude.read_text())["permissions"]["allow"]

    def opencode_rules(self) -> dict:
        return installer.read_json_config(self.opencode)["permission"]["bash"]

    def test_default_install_grants_nothing_and_dry_run_previews_without_writing(self):
        self.claude.write_text('{"model": "keep"}\n')
        before = self.snapshot()
        enabled, output = self.run_approval()
        self.assertFalse(enabled)
        self.assertIn("--trust-orkest-commands", output)
        self.assertEqual(self.snapshot(), before)

        enabled, output = self.run_approval(opt_in=True, dry_run=True)
        self.assertTrue(enabled)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.state.exists())
        self.assertIn("gate status", output)
        self.assertIn("--allow-credits", output)
        for name in ("Codex", "Claude (.claude)", "Antigravity", "OpenCode"):
            self.assertIn(f"would approve Orkest commands in {name}", output)
        self.assertRegex(output, r"Claude \(\.claude\): \+\d+ -0 rules")
        # A dry run still does not opt in, so the next plain setup leaves everything alone.
        self.assertFalse(self.run_approval()[0])
        self.assertEqual(self.snapshot(), before)

    def test_opt_in_preserves_settings_comments_and_backups_and_repeats_cleanly(self):
        self.claude.write_text(
            json.dumps({"model": "keep", "permissions": {"allow": ["Bash(git status:*)"], "deny": ["Bash(rm:*)"]}})
        )
        self.opencode.write_text(
            '{\n  // keep this comment\n  "model": "x",\n  "permission": {\n    "edit": "ask",\n'
            '    "bash": "ask", // and this one\n  },\n}\n'
        )
        old_backup = self.claude.with_name("settings.json.mailbox-bak.1")
        old_backup.write_text("previous")

        enabled, output = self.run_approval(opt_in=True)
        self.assertTrue(enabled)
        self.assertIn("Approving Orkest commands", output)
        claude = json.loads(self.claude.read_text())
        self.assertEqual(claude["model"], "keep")
        self.assertEqual(claude["permissions"]["deny"], ["Bash(rm:*)"])
        self.assertEqual(claude["permissions"]["allow"][0], "Bash(git status:*)")
        self.assertEqual(len(claude["permissions"]["allow"]), len(set(claude["permissions"]["allow"])))
        text = self.opencode.read_text()
        self.assertIn("// keep this comment", text)
        self.assertIn("// and this one", text)
        config = installer.read_json_config(self.opencode)
        self.assertEqual(config["model"], "x")
        self.assertEqual(config["permission"]["edit"], "ask")
        self.assertEqual(next(iter(config["permission"]["bash"].items())), ("*", "ask"))
        self.assertTrue((self.codex / "rules" / approval.CODEX_RULES_NAME).is_file())
        self.assertIn("permissions", json.loads(self.agy.read_text()))
        self.assertEqual(old_backup.read_text(), "previous")
        self.assertEqual(len(list(self.claude.parent.glob("settings.json" + approval.BACKUP_MARK + "*"))), 1)
        self.assertEqual(json.loads(self.state.read_text())["enabled"], True)

        # A later setup refresh without the flag keeps the approval and changes nothing.
        after = self.snapshot()
        enabled, output = self.run_approval()
        self.assertTrue(enabled)
        self.assertNotIn("✓", output)
        self.assertEqual(self.snapshot(), after)
        self.assertTrue(self.run_approval(opt_in=True)[0])
        self.assertEqual(self.snapshot(), after)

    def test_rules_cover_orkest_entry_points_and_path_variants_but_nothing_generic(self):
        self.run_approval(opt_in=True)
        hub = self.hub / "scripts"
        cli = self.checkout / "bin/ork.mjs"
        allowed = [
            "ork rooms dispatch --room r",
            "ork hall list",
            "ork horde --view --attach-room r",
            "ork progress --session s --stage working",
            "ork gate status",
            "ork update",
            f"{self.home}/.local/bin/ork rooms show --room r",
            f"node {cli} hall list",
            f"{cli} quota --json",
            f"python3 {hub}/run_agent.py mailbox inbox --session s",
            f"python3 {hub}/run_agent.py --cwd /repo --task-spec s.json",
            f"python3 {self.source}/coordinator.py dispatch --task-dir t",
            f"{EXECUTABLE} {hub}/agent_progress.py --session s",
            f"/usr/bin/python3 {hub}/peer_mailbox.py inbox",
        ]
        own_skill = "python3 {}/skills/orchestrate/scripts/run_agent.py doctor"
        denied = [
            "ork",
            "ork horde",
            "ork horde --engine claude --harness-arg=--dangerously-skip-permissions",
            "ork gate -- rm -rf /",
            "ork gate --heavy -- make",
            "ork label -- claude --dangerously-skip-permissions",
            "ork codex",
            "ork claude --harness-arg=--dangerously-skip-permissions",
            "orkx rooms list",
            "python3 -c 'print(1)'",
            "python3",
            "node -e 1",
            "bash -c 'ork rooms list'",
            f"python3 {hub}/run_agent.py probe -- rm -rf /",
            f"python3 {hub}/run_agent.py listen --engine claude -- --dangerously-skip-permissions",
            f"python3 {hub}/gate.py -- rm -rf /",
            f"python3 {hub}/consult.py",
            f"python3 {hub}/run_agent.py.evil",
            "python3 plugins/orchestrate/skills/orchestrate/scripts/run_agent.py",
            f"python3 {self.root}/elsewhere/run_agent.py",
        ]
        claude = self.claude_rules()
        agy = json.loads(self.agy.read_text())["permissions"]["allow"]
        opencode = self.opencode_rules()
        for command in allowed:
            self.assertTrue(claude_allows(claude, command), command)
            self.assertTrue(agy_allows(agy, command), command)
            self.assertTrue(opencode_allows(opencode, command), command)
        for command in denied:
            self.assertFalse(claude_allows(claude, command), command)
            self.assertFalse(agy_allows(agy, command), command)
            self.assertFalse(opencode_allows(opencode, command), command)
        # Each harness also gets the `<skill-directory>` it shows its agents.
        self.assertTrue(claude_allows(claude, own_skill.format(self.home / ".claude")))
        self.assertTrue(agy_allows(agy, own_skill.format(self.home / ".gemini/config")))
        self.assertTrue(opencode_allows(opencode, own_skill.format(self.home / ".config/opencode")))
        self.assertFalse(agy_allows(agy, own_skill.format(self.home / ".claude")))
        for broad in ("Bash(ork:*)", "Bash(python3:*)", "Bash(node:*)", "Bash(*)"):
            self.assertNotIn(broad, claude)

        codex = shutil.which("codex")
        if not codex:
            self.skipTest("codex is not installed")
        rules = self.codex / "rules" / approval.CODEX_RULES_NAME

        def decision(command: str) -> str | None:
            result = subprocess.run(
                [codex, "execpolicy", "check", "--rules", str(rules), *shlex.split(command)],
                capture_output=True,
                text=True,
                check=True,
            )
            return json.loads(result.stdout).get("decision")

        for command in allowed:
            self.assertEqual(decision(command), "allow", command)
        for command in denied:
            self.assertIsNone(decision(command), command)

    def test_symlinked_settings_keep_the_link_and_edit_its_target(self):
        dotfiles = self.root / "dotfiles/claude-settings.json"
        dotfiles.parent.mkdir()
        dotfiles.write_text('{"theme": "dark"}\n')
        self.claude.symlink_to(dotfiles)
        self.run_approval(opt_in=True, harnesses={"claude"})
        self.assertTrue(self.claude.is_symlink())
        self.assertEqual(self.claude.resolve(), dotfiles.resolve())
        self.assertEqual(json.loads(dotfiles.read_text())["theme"], "dark")
        self.assertTrue(claude_allows(json.loads(dotfiles.read_text())["permissions"]["allow"], "ork rooms list"))
        self.assertEqual(len(list(dotfiles.parent.glob("claude-settings.json" + approval.BACKUP_MARK + "*"))), 1)

    def test_refresh_replaces_stale_paths_and_revoke_removes_only_orkest_rules(self):
        self.claude.write_text(json.dumps({"permissions": {"allow": ["Bash(ork rooms:*)", "Bash(git status:*)"]}}))
        self.run_approval(opt_in=True)
        old = f"Bash(python3 {self.source}/run_agent.py consult:*)"
        self.assertIn(old, self.claude_rules())

        # The checkout moved: the next refresh drops the old paths and adds the new ones.
        moved = self.root / "moved/plugins/orchestrate"
        shutil.move(self.root / "checkout", self.root / "moved")
        self.source = moved / "skills/orchestrate/scripts"
        self.checkout = moved
        self.hub.unlink()
        self.hub.symlink_to(self.source.parent)
        self.run_approval()
        rules = self.claude_rules()
        self.assertNotIn(old, rules)
        self.assertIn(f"Bash(python3 {self.source.resolve()}/run_agent.py consult:*)", rules)
        self.assertEqual(rules[:2], ["Bash(ork rooms:*)", "Bash(git status:*)"])
        self.assertEqual(len(rules), len(set(rules)))

        enabled, output = self.run_approval(revoke=True)
        self.assertFalse(enabled)
        self.assertIn("removed", output)
        # The user's own rules, including one that matches an Orkest command, stay.
        self.assertEqual(self.claude_rules(), ["Bash(ork rooms:*)", "Bash(git status:*)"])
        self.assertEqual(json.loads(self.agy.read_text())["permissions"]["allow"], [])
        self.assertEqual(self.opencode_rules(), {})
        self.assertFalse((self.codex / "rules" / approval.CODEX_RULES_NAME).exists())
        # One copy from the refresh that rewrote the rules, one for the retired file; Codex loads neither.
        self.assertEqual(len(list((self.codex / "rules").glob("*" + approval.BACKUP_MARK + "*"))), 2)
        self.assertEqual(list((self.codex / "rules").glob("*.rules")), [])
        self.assertFalse(json.loads(self.state.read_text())["enabled"])
        before = self.snapshot()
        self.assertFalse(self.run_approval()[0])
        self.assertEqual(self.snapshot(), before)

    def test_uninstalled_harness_and_unexpected_shapes_are_left_unchanged(self):
        self.agy.write_text('{"permissions": {"allow": {"not": "a list"}}}\n')
        self.opencode.write_text('{"permission": {"bash": {"ork rooms *": "deny"}}}\n')
        enabled, output = self.run_approval(opt_in=True, harnesses={"agy", "opencode"})
        self.assertTrue(enabled)
        self.assertIn("Antigravity: left unchanged", output)
        self.assertEqual(self.agy.read_text(), '{"permissions": {"allow": {"not": "a list"}}}\n')
        self.assertFalse(self.claude.exists())
        self.assertFalse(self.codex.joinpath("rules").exists())
        rules = self.opencode_rules()
        self.assertEqual(rules["ork rooms *"], "deny")
        self.assertFalse(opencode_allows(rules, "ork rooms list"))
        self.assertTrue(opencode_allows(rules, "ork hall list"))
        self.run_approval(revoke=True)
        self.assertEqual(self.opencode_rules(), {"ork rooms *": "deny"})

    def test_approval_leaves_orkest_policy_and_credit_settings_alone(self):
        route = self.home / ".config/orchestrate/config.json"
        route.parent.mkdir(parents=True)
        route.write_text('{"credits": {"allow": false}}\n')
        self.run_approval(opt_in=True)
        self.assertEqual(route.read_text(), '{"credits": {"allow": false}}\n')
        changed = set(self.snapshot())
        expected = {
            ".claude/settings.json",
            ".codex/rules/" + approval.CODEX_RULES_NAME,
            ".config/opencode/opencode.jsonc",
            ".config/orchestrate/config.json",
            ".config/orchestrate/" + approval.STATE_NAME,
            ".gemini/antigravity-cli/settings.json",
        }
        self.assertEqual(changed, expected)
        for text in self.snapshot().values():
            self.assertNotIn("allow-credits", text.replace("--allow-credits)", ""))

    def test_installer_flags_are_explicit_and_exclusive(self):
        with mock.patch.object(installer, "install") as install:
            self.assertEqual(installer.main(["--trust-orkest-commands"]), 0)
        self.assertTrue(install.call_args.kwargs["trust_orkest_commands"])
        self.assertFalse(install.call_args.kwargs["untrust_orkest_commands"])
        with mock.patch.object(installer, "install") as install:
            installer.main([])
        self.assertFalse(install.call_args.kwargs["trust_orkest_commands"])
        with (
            mock.patch.object(installer, "install"),
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit),
        ):
            installer.main(["--trust-orkest-commands", "--untrust-orkest-commands"])

    def test_comment_only_jsonc_and_symlinked_home_bin_are_handled_cleanly(self):
        self.opencode.write_text("// user comment\n")
        self.agy.write_text("/* empty */\n")
        real_bin = self.root / "real-home/.local/bin"
        real_bin.mkdir(parents=True)
        link_home_local = self.home / ".local"
        link_home_local.mkdir(exist_ok=True)
        (link_home_local / "bin").symlink_to(real_bin)
        enabled, _ = self.run_approval(opt_in=True, harnesses={"agy", "opencode"})
        self.assertTrue(enabled)
        self.assertIn("// user comment", self.opencode.read_text())
        self.assertIn("ork rooms *", self.opencode_rules())
        self.assertIn(f"{real_bin.resolve()}/ork", self.scope().ork_programs)


if __name__ == "__main__":
    unittest.main()
