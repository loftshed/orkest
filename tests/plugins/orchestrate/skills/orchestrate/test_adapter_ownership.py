"""Ownership checks shared by the plugin retirement and adapter relocation releases."""

from __future__ import annotations

import contextlib
import io
import os
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / "plugins/orchestrate/skills/orchestrate/scripts"))

import install_mailbox as installer  # noqa: E402


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        self.home = self.root / "home"
        self.commands = self.home / ".claude/commands"
        self.commands.mkdir(parents=True)
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def install(self, content):
        return installer._install_claude_command(self.home, "chief", content)

    def test_two_upgrades_from_shipped_files_preserve_local_changes(self):
        old_paths = ("commands/chief.md", "skills/chief/SKILL.md")
        old = [
            subprocess.check_output(["git", "show", f"orchestrate--v0.91.1:plugins/orchestrate/{path}"], cwd=ROOT)
            for path in old_paths
        ]
        installed = [self.commands / "chief.md", self.home / ".agents/skills/chief/SKILL.md"]
        edited = self.home / ".claude-custom/commands/chief.md"
        edited.parent.mkdir(parents=True)
        custom = old[0] + b"\nProject-specific instruction.\n"
        edited.write_bytes(custom)
        for target, body in zip(installed, old, strict=True):
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        release = self.root / "release/plugins/orchestrate"
        cli = release / "bin/ork.mjs"
        cli.parent.mkdir(parents=True)
        cli.write_text("")
        for revision in ("retirement", "relocation"):
            updated = [body + f"\n{revision}\n".encode() for body in old]
            for relative, canonical, body in zip(
                old_paths, ("claude/commands/chief.md", "skills/chief/SKILL.md"), updated, strict=True
            ):
                for source in (release / relative, self.root / "release/adapters" / canonical):
                    source.parent.mkdir(parents=True, exist_ok=True)
                    source.write_bytes(body)
            for _ in range(2):
                installer.install_shell_wrappers(self.home, cli)
                self.assertEqual([p.read_bytes() for p in installed], updated)
                self.assertEqual(edited.read_bytes(), custom)

    def test_nonregular_destinations_survive_reinstall(self):
        target = self.commands / "chief.md"

        def check(mode):
            original = target.lstat()
            for _ in range(2):
                self.assertFalse(self.install("new"))
                current = target.lstat()
                self.assertEqual((mode, original.st_ino), (stat.S_IFMT(current.st_mode), current.st_ino))

        os.mkfifo(target)
        check(stat.S_IFIFO)
        target.rename(self.root / "original.fifo")
        target.mkdir()
        check(stat.S_IFDIR)
        target.rename(self.root / "original-directory")
        with socket.socket(socket.AF_UNIX) as sock, contextlib.chdir(self.commands):
            sock.bind("chief.md")
            check(stat.S_IFSOCK)

    def test_racing_editor_wins_updates_and_creations(self):
        target = self.commands / "chief.md"
        original_write = installer.configuration.write_private
        for preinstall in (False, True):
            if preinstall:
                target.rename(self.root / "earlier-user-file")
                self.install("old release")

            def race(path, text, **kwargs):
                if path == target:
                    path.write_bytes(b"concurrent user edit")
                return original_write(path, text, **kwargs)

            with mock.patch.object(installer.configuration, "write_private", side_effect=race):
                self.assertFalse(self.install("new release"))
            self.assertEqual(target.read_bytes(), b"concurrent user edit")
