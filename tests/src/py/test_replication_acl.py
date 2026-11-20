"""Exercise pairing and serving through private peer ACLs without starting SSH."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "src/py"))
import replication_acl as acl  # noqa: E402
from replication_cli import load_peer  # noqa: E402
from replication_protocol import SyncError  # noqa: E402

PAIR = {
    "schema": "ork.sync.peer.v1",
    "origin": "remote",
    "epoch": "epoch",
    "scopes": ["project"],
    "host": "other",
    "ssh_config": None,
}


class PermissionsTests(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        self.file = self.root / "config" / "sync-peers" / "work.json"

    def assert_denied(self, message):
        for operation in (lambda: load_peer(self.file), lambda: acl.save_pair(self.file, PAIR)):
            with self.assertRaisesRegex(SyncError, message):
                operation()

    def test_secure_pair_written_by_previous_version_is_reused(self):
        self.file.parent.mkdir(parents=True, mode=0o700)
        self.file.write_text(json.dumps(PAIR) + "\n")
        self.file.chmod(0o600)
        original = self.file.stat()
        acl.save_pair(self.file, PAIR)
        self.assertEqual(load_peer(self.file)[0].scopes, frozenset(["project"]))
        self.assertEqual(self.file.stat().st_ino, original.st_ino)
        with self.assertRaisesRegex(SyncError, "peer_already_paired"):
            acl.save_pair(self.file, {**PAIR, "scopes": ["other"]})

    def test_unsafe_files_and_directories_refuse_reads_and_repeat_pairing(self):
        acl.save_pair(self.file, PAIR)
        for path, mode, message in [
            (self.file, 0o640, "unsafe_peer_file"),
            (self.file.parent, 0o750, "unsafe_peer_directory"),
            (self.file.parent.parent, 0o770, "unsafe_peer_directory"),
        ]:
            previous = path.stat().st_mode & 0o777
            path.chmod(mode)
            try:
                self.assert_denied(message)
            finally:
                path.chmod(previous)

    def test_symlinked_record_is_rejected(self):
        acl.save_pair(self.file, PAIR)
        target = self.file.rename(self.root / "original.json")
        self.file.symlink_to(target)
        self.assert_denied("unsafe_peer_file")
        self.assertEqual(json.loads(target.read_text()), PAIR)

    def test_symlinked_directory_is_rejected_at_each_user_config_level(self):
        acl.save_pair(self.file, PAIR)
        for directory in (self.file.parent, self.file.parent.parent):
            with self.subTest(directory=directory):
                destination = directory.rename(directory.with_name("retained"))
                directory.symlink_to(destination, target_is_directory=True)
                self.assert_denied("unsafe_peer_directory")
                directory.rename(directory.with_name("retained-link"))
                destination.rename(directory)

    def test_fifo_denied_before_read_and_wrong_owner_denied(self):
        self.file.parent.mkdir(parents=True, mode=0o700)
        os.mkfifo(self.file, 0o600)
        self.assert_denied("unsafe_peer_file")
        self.file.rename(self.root / "retained-fifo")
        acl.save_pair(self.file, PAIR)
        # Different effective users cannot safely authorize from this owner's directory.
        with patch.object(acl.os, "geteuid", return_value=os.geteuid() + 1):
            self.assert_denied("unsafe_peer_directory")

    def test_wrong_record_owner_is_denied_even_in_a_private_directory(self):
        acl.save_pair(self.file, PAIR)
        stat_file = self.file.stat()
        real_fstat = os.fstat

        def foreign_record(fd):
            info = real_fstat(fd)
            if (info.st_dev, info.st_ino) == (stat_file.st_dev, stat_file.st_ino):
                return SimpleNamespace(st_uid=os.geteuid() + 1, st_mode=info.st_mode)
            return info

        with patch.object(acl.os, "fstat", side_effect=foreign_record):
            self.assert_denied("unsafe_peer_file")

    def test_public_serve_rejects_unsafe_acl_before_reading_request(self):
        d = self.root / "config/orchestrate/sync-peers"
        d.mkdir(mode=0o700, parents=True)
        path = d / "work.json"
        path.write_text(json.dumps(PAIR) + "\n")
        path.chmod(0o644)
        result = subprocess.run(
            [sys.executable, str(ROOT / "src/py/replication_cli.py"), "serve", "--peer", "work"],
            input=b"",
            capture_output=True,
            timeout=5,
            env={**os.environ, "XDG_CONFIG_HOME": str(self.root / "config"), "SSH_ORIGINAL_COMMAND": "ork sync serve"},
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"unsafe_peer_file", result.stderr)
        self.assertEqual(result.stdout, b"")
