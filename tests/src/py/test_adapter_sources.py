"""One tracked source per generated command and skill, installed byte for byte, never over user content."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "src/py"))

import install_mailbox as installer  # noqa: E402

COMMANDS = REPO_ROOT / "adapters/claude/commands"
SKILLS = REPO_ROOT / "adapters/skills"
DIGESTS = json.loads((REPO_ROOT / "adapters/owned-digests.json").read_text())


def quiet(function, *args, **kwargs):
    with contextlib.redirect_stdout(io.StringIO()):
        return function(*args, **kwargs)


def install(home, **kwargs):
    return quiet(installer.install_adapter_commands, home, **kwargs), quiet(
        installer.install_adapter_skills, home, **kwargs
    )


class AdapterSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        for directory in (".claude", ".claude-work", ".codex", ".gemini/config", ".config/opencode"):
            (self.home / directory).mkdir(parents=True)

    def test_every_advertised_name_has_exactly_one_tracked_source(self):
        tracked = subprocess.run(
            ["git", "ls-files", "--", "*.md"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
        ).stdout.split()
        for name in installer.ADAPTER_COMMANDS:
            sources = [p for p in tracked if p.endswith(f"/commands/{name}.md")]
            self.assertEqual([f"adapters/claude/commands/{name}.md"], sources)
        for name in installer.ADAPTER_SKILLS:
            sources = [p for p in tracked if p.endswith(f"/skills/{name}/SKILL.md")]
            self.assertEqual([f"adapters/skills/{name}/SKILL.md"], sources)
        self.assertEqual(sorted(installer.ADAPTER_COMMANDS), sorted(p.stem for p in COMMANDS.glob("*.md")))
        self.assertEqual(sorted(installer.ADAPTER_SKILLS), sorted(p.parent.name for p in SKILLS.glob("*/SKILL.md")))

    def test_installer_embeds_no_command_or_skill_body(self):
        text = (REPO_ROOT / "src/py/install_mailbox.py").read_text()
        self.assertNotRegex(text, r"_(COMMAND|SKILL)_TEXT")
        self.assertFalse(hasattr(installer, "SWARM_COMMAND_TEXT"))

    def test_current_sources_are_listed_as_known_shipped_bodies(self):
        # When a source changes, add its digest to adapters/owned-digests.json so upgrades keep recognizing it.
        for name in installer.ADAPTER_COMMANDS:
            digest = hashlib.sha256((COMMANDS / f"{name}.md").read_bytes()).hexdigest()
            self.assertIn(digest, DIGESTS["commands"][name], name)
        for name in installer.ADAPTER_SKILLS:
            digest = hashlib.sha256((SKILLS / name / "SKILL.md").read_bytes()).hexdigest()
            self.assertIn(digest, DIGESTS["skills"][name], name)

    def test_fresh_install_is_byte_equal_to_sources_and_idempotent(self):
        self.assertEqual((True, True), install(self.home))
        for name in installer.ADAPTER_COMMANDS:
            for profile in (".claude", ".claude-work"):
                self.assertEqual(
                    (COMMANDS / f"{name}.md").read_bytes(), (self.home / profile / f"commands/{name}.md").read_bytes()
                )
        for name in installer.ADAPTER_SKILLS:
            self.assertEqual(
                (SKILLS / name / "SKILL.md").read_bytes(), (self.home / f".agents/skills/{name}/SKILL.md").read_bytes()
            )
        self.assertEqual((False, False), install(self.home))
        self.assertEqual((False, False), install(self.home))

    def test_dry_run_writes_nothing(self):
        self.assertEqual((True, True), install(self.home, dry_run=True))
        self.assertEqual([], list(self.home.glob(".claude*/commands")))
        self.assertFalse((self.home / ".agents").exists())
        self.assertFalse((self.home / installer.INSTALLED_DIGESTS).exists())

    def test_edited_and_foreign_files_survive_repeat_installs(self):
        commands = self.home / ".claude/commands"
        commands.mkdir()
        # Edited: the current body plus appended instructions that keep the original marker.
        edited = (COMMANDS / "swarm.md").read_text() + "\nAlso ping me when done.\n"
        (commands / "swarm.md").write_text(edited)
        # Custom file that merely mentions Orkest and carries a marker-like line.
        custom = "My Orkest notes\n[orkest-cleanup-command: $ARGUMENTS]\n"
        (commands / "cleanup.md").write_text(custom)
        (commands / "mine.md").write_text("user command\n")
        (commands / "ork-alias.md").write_text("legacy alias\n")
        hub = self.home / ".agents/skills/side"
        hub.mkdir(parents=True)
        edited_skill = (SKILLS / "side/SKILL.md").read_text() + "\nlocal rule\n"
        (hub / "SKILL.md").write_text(edited_skill)
        (self.home / ".agents/skills/update").mkdir()
        (self.home / ".agents/skills/update/SKILL.md").write_text("---\nname: update\n---\nOrkest, mine\n")

        for _ in range(3):
            install(self.home)
            self.assertEqual(edited.encode(), (commands / "swarm.md").read_bytes())
            self.assertEqual(custom.encode(), (commands / "cleanup.md").read_bytes())
            self.assertEqual("user command\n", (commands / "mine.md").read_text())
            self.assertEqual("legacy alias\n", (commands / "ork-alias.md").read_text())
            self.assertEqual(edited_skill.encode(), (hub / "SKILL.md").read_bytes())
            self.assertIn("mine", (self.home / ".agents/skills/update/SKILL.md").read_text())
        self.assertEqual([], list(commands.glob("*.mailbox-bak.*")))

    def test_legacy_python_generated_bodies_upgrade_in_place(self):
        # The body the Python installer wrote before this change (commit 39b53fb) for /swarm, /cleanup and the
        # side skill is replaced; the digests come from `git show` so no second copy lives in the repository.
        revision = "39b53fb"
        source = subprocess.run(
            ["git", "show", f"{revision}:plugins/orchestrate/skills/orchestrate/scripts/install_mailbox.py"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        if source.returncode:
            self.skipTest("history is not available")
        import ast

        constants = {}
        for node in ast.parse(source.stdout).body:
            if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "").endswith("_TEXT"):
                constants[node.targets[0].id] = ast.literal_eval(node.value)
        commands = self.home / ".claude/commands"
        commands.mkdir()
        (commands / "swarm.md").write_text(constants["SWARM_COMMAND_TEXT"])
        (commands / "cleanup.md").write_text(constants["CLEANUP_COMMAND_TEXT"])
        hub = self.home / ".agents/skills/side"
        hub.mkdir(parents=True)
        (hub / "SKILL.md").write_text(constants["SIDE_SKILL_TEXT"])
        for _ in range(2):
            install(self.home)
            self.assertEqual((COMMANDS / "swarm.md").read_bytes(), (commands / "swarm.md").read_bytes())
            self.assertEqual((COMMANDS / "cleanup.md").read_bytes(), (commands / "cleanup.md").read_bytes())
            self.assertEqual((SKILLS / "side/SKILL.md").read_bytes(), (hub / "SKILL.md").read_bytes())

    def test_existing_shipped_files_upgrade_without_receipts_and_keep_later_edits(self):
        release = self.home / "next-release"
        targets = {
            COMMANDS / "swarm.md": self.home / ".claude/commands/swarm.md",
            SKILLS / "side/SKILL.md": self.home / ".agents/skills/side/SKILL.md",
        }
        for source, target in targets.items():
            target.parent.mkdir(parents=True)
            target.write_bytes(source.read_bytes())
            updated = release / source.relative_to(REPO_ROOT)
            updated.parent.mkdir(parents=True)
            updated.write_bytes(source.read_bytes() + b"\nNext release instructions.\n")

        install(self.home)
        receipts = installer._recorded_digests(self.home)
        for target in targets.values():
            self.assertNotIn(str(target), receipts)
        install(self.home, plugin_root=release)
        for source, target in targets.items():
            self.assertEqual((release / source.relative_to(REPO_ROOT)).read_bytes(), target.read_bytes())
            target.write_bytes(target.read_bytes() + b"Project-specific instructions.\n")
        for _ in range(2):
            install(self.home)
            for source, target in targets.items():
                expected = (release / source.relative_to(REPO_ROOT)).read_bytes() + b"Project-specific instructions.\n"
                self.assertEqual(expected, target.read_bytes())

    def test_previously_installed_body_is_recognized_through_the_recorded_digest(self):
        install(self.home)
        target = self.home / ".claude/commands/swarm.md"
        # Simulate an earlier release of this installer: its body is not in the shipped list, but was recorded.
        previous = "---\ndescription: from a future release\n---\nbody\n"
        target.write_text(previous)
        installer._record_digest(self.home, target, hashlib.sha256(previous.encode()).hexdigest())
        install(self.home)
        self.assertEqual((COMMANDS / "swarm.md").read_bytes(), target.read_bytes())
        # The same text without a recorded digest is treated as the user's.
        target.write_text(previous)
        install(self.home)
        self.assertEqual(previous, target.read_text())

    def test_symlinks_and_real_skill_directories_are_never_followed_or_removed(self):
        foreign = self.home / "dotfiles"
        foreign.mkdir()
        (foreign / "swarm.md").write_text("[orkest-swarm-command: $ARGUMENTS]\nmine\n")
        commands = self.home / ".claude/commands"
        commands.mkdir()
        (commands / "swarm.md").symlink_to(foreign / "swarm.md")
        # A foreign symlinked hub and a real user directory standing in for a duplicate skill link.
        (foreign / "hub").mkdir()
        (foreign / "hub/SKILL.md").write_text("mine\n")
        (self.home / ".agents/skills").mkdir(parents=True)
        (self.home / ".agents/skills/side").symlink_to(foreign / "hub")
        real = self.home / ".claude/skills/chief"
        real.mkdir(parents=True)
        (real / "SKILL.md").write_text("user chief\n")
        foreign_link = self.home / ".claude-work/skills/update"
        foreign_link.parent.mkdir(parents=True)
        foreign_link.symlink_to(foreign)
        codex_foreign = self.home / ".codex/skills/swarm"
        codex_foreign.parent.mkdir()
        codex_foreign.symlink_to(foreign)

        for _ in range(2):
            install(self.home)
            self.assertTrue((commands / "swarm.md").is_symlink())
            self.assertIn("mine", (foreign / "swarm.md").read_text())
            self.assertEqual("mine\n", (foreign / "hub/SKILL.md").read_text())
            self.assertEqual("user chief\n", (real / "SKILL.md").read_text())
            for link in (foreign_link, codex_foreign):
                self.assertTrue(link.is_symlink())
                self.assertEqual(link.readlink(), foreign)
                self.assertTrue(link.samefile(foreign))
        self.assertEqual([], list((self.home / ".codex/skills").glob("*.mailbox-bak.*")))

    def test_owned_duplicate_links_are_removed_and_aliases_survive(self):
        install(self.home)
        hub = self.home / ".agents/skills/side"
        duplicate = self.home / ".claude/skills/side"
        duplicate.parent.mkdir(parents=True)
        duplicate.symlink_to(hub)
        alias = self.home / ".codex/skills/side-alias"
        alias.parent.mkdir(exist_ok=True)
        alias.symlink_to(hub)
        install(self.home)
        self.assertFalse(duplicate.is_symlink())
        self.assertTrue(alias.is_symlink())


if __name__ == "__main__":
    unittest.main()
