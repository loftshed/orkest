"""Tests for Issue #51 (Herdr-safe short agent names) and Issue #55 (Mailbox DX aliases and receive wait-seconds)."""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import peer_mailbox as mailbox  # noqa: E402
import runtime_paths  # noqa: E402


class ShortAgentNameTests(unittest.TestCase):
    def test_short_agent_name_format_and_pattern(self):
        slug = mailbox.short_agent_name("gribble", "orkest", "01a18ee1-01dd-72f0-9dc2-30ef80bb0f6a")
        self.assertEqual(slug, "gribble-orkest-6a")
        self.assertLessEqual(len(slug), 32)
        self.assertRegex(slug, r"^[a-z][a-z0-9_-]{0,31}$")
        self.assertTrue(re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", slug))

    def test_short_agent_name_deterministic(self):
        slug1 = mailbox.short_agent_name("klonko", "my-repo", "session-1234abcd")
        slug2 = mailbox.short_agent_name("klonko", "my-repo", "session-1234abcd")
        self.assertEqual(slug1, slug2)

    def test_short_agent_name_sanitizes_dots_and_invalid_chars(self):
        slug = mailbox.short_agent_name("Agent.Name", "Repo.V1.2@feat", "session-76")
        self.assertNotIn(".", slug)
        self.assertNotIn("@", slug)
        self.assertTrue(slug.islower())
        self.assertTrue(re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", slug))

    def test_short_agent_name_truncates_middle_repo_preserving_hex_suffix(self):
        # Very long repo name that forces truncation under 32 chars
        long_repo = "an-extremely-long-repository-name-that-definitely-exceeds-thirty-two-chars"
        slug = mailbox.short_agent_name("blorbo", long_repo, "session-76")
        self.assertLessEqual(len(slug), 32)
        self.assertTrue(slug.startswith("blorbo-"))
        self.assertTrue(slug.endswith("-76"))
        self.assertTrue(re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", slug))

    def test_short_agent_name_empty_or_special_inputs(self):
        slug = mailbox.short_agent_name("", "", "12345678")
        self.assertLessEqual(len(slug), 32)
        self.assertTrue(re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", slug))

        # Person starting with digit or dash
        slug_num = mailbox.short_agent_name("99problems", "repo", "abcd")
        self.assertRegex(slug_num, r"^[a-z]")
        self.assertTrue(re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", slug_num))


class PeerRecordIdentityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name) / "mailbox-v1"
        self.cwd = str(Path(temporary.name) / "project")
        subprocess.run(["git", "init", "-q", self.cwd], check=True)

    def test_register_includes_short_name_and_preserves_full_name(self):
        peer = mailbox.register(
            self.base,
            session="01a18ee1-01dd-72f0-9dc2-30ef80bb0f6a",
            harness="codex",
            cwd=self.cwd,
            model="gpt-5.6-sol",
        )
        self.assertIn("name", peer)
        self.assertIn("shortName", peer)
        self.assertLessEqual(len(peer["shortName"]), 32)
        self.assertTrue(re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", peer["shortName"]))
        self.assertTrue(peer["name"].startswith(peer["person"]))
        self.assertTrue(peer["shortName"].startswith(peer["person"]))


class MailboxCliDxTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name) / "mailbox-v1"
        self.cwd = str(Path(temporary.name) / "project")
        subprocess.run(["git", "init", "-q", self.cwd], check=True)
        self.session_a = "00000000-0000-0000-0000-00000000000a"
        self.session_b = "00000000-0000-0000-0000-00000000000b"
        self.peer_a = mailbox.register(self.base, session=self.session_a, harness="codex", cwd=self.cwd)
        self.peer_b = mailbox.register(self.base, session=self.session_b, harness="claude", cwd=self.cwd)

    def run_cli(self, *args: str) -> tuple[int, str]:
        with (
            patch.object(mailbox, "root", return_value=self.base),
            patch("os.getcwd", return_value=self.cwd),
            patch("sys.stdout", new_callable=io.StringIO) as out,
        ):
            code = mailbox.main(list(args))
            return code, out.getvalue()

    def test_name_subcommand_supports_short_flag(self):
        code, out_full = self.run_cli("name")
        self.assertEqual(code, 0)
        full_name = out_full.strip()
        self.assertTrue(len(full_name) > 0)

        code, out_short = self.run_cli("name", "--short")
        self.assertEqual(code, 0)
        short_name = out_short.strip()
        self.assertLessEqual(len(short_name), 32)
        self.assertTrue(re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", short_name))

    def test_send_accepts_body_and_message_aliases(self):
        # Test --body alias
        code, out = self.run_cli(
            "send",
            "--session",
            self.session_a,
            "--to",
            self.session_b,
            "--body",
            "hello from body alias",
            "--format",
            "json",
        )
        self.assertEqual(code, 0)
        parsed = json.loads(out)
        self.assertIn("id", parsed)

        # Receive it via receive subcommand
        code, out = self.run_cli("receive", "--session", self.session_b, "--format", "json")
        self.assertEqual(code, 0)
        received = json.loads(out)
        self.assertEqual(len(received["messages"]), 1)
        self.assertEqual(received["messages"][0]["text"], "hello from body alias")

        # Test --message alias
        code, out = self.run_cli(
            "send",
            "--session",
            self.session_a,
            "--to",
            self.session_b,
            "--message",
            "hello from message alias",
            "--format",
            "json",
        )
        self.assertEqual(code, 0)

        # Receive it via inbox subcommand
        code, out = self.run_cli("inbox", "--session", self.session_b, "--format", "json")
        self.assertEqual(code, 0)
        received = json.loads(out)
        self.assertEqual(len(received["messages"]), 1)
        self.assertEqual(received["messages"][0]["text"], "hello from message alias")

    def test_receive_wait_seconds_immediate_return_if_mail_present(self):
        mailbox.send(self.base, sender=self.peer_a, to=self.session_b, text="immediate message")
        started = time.monotonic()
        code, out = self.run_cli(
            "receive",
            "--session",
            self.session_b,
            "--wait-seconds",
            "5.0",
            "--format",
            "json",
        )
        elapsed = time.monotonic() - started
        self.assertEqual(code, 0)
        self.assertLess(elapsed, 2.0)
        received = json.loads(out)
        self.assertEqual(len(received["messages"]), 1)
        self.assertEqual(received["messages"][0]["text"], "immediate message")

    def test_receive_wait_seconds_times_out_when_empty(self):
        started = time.monotonic()
        code, out = self.run_cli(
            "receive",
            "--session",
            self.session_b,
            "--wait-seconds",
            "0.2",
            "--format",
            "json",
        )
        elapsed = time.monotonic() - started
        self.assertEqual(code, 12)
        self.assertGreaterEqual(elapsed, 0.2)
        parsed = json.loads(out)
        self.assertEqual(parsed.get("status"), "timed_out")

    def test_receive_wait_seconds_receives_concurrent_message(self):
        def deliver_later():
            time.sleep(0.15)
            mailbox.send(self.base, sender=self.peer_a, to=self.session_b, text="concurrent mail")

        sender_thread = threading.Thread(target=deliver_later)
        sender_thread.start()
        try:
            code, out = self.run_cli(
                "receive",
                "--session",
                self.session_b,
                "--wait-seconds",
                "2.0",
                "--format",
                "json",
            )
            self.assertEqual(code, 0)
            parsed = json.loads(out)
            self.assertEqual(len(parsed["messages"]), 1)
            self.assertEqual(parsed["messages"][0]["text"], "concurrent mail")
        finally:
            sender_thread.join()


class PeerMailboxRootTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_root_honors_orchestrate_home_with_agent_executor_home_fallback(self) -> None:
        orchestrate_home = self.root / "orchestrate-home"
        legacy_home = self.root / "legacy-home"
        with patch.dict(
            os.environ,
            {"ORCHESTRATE_HOME": str(orchestrate_home), "AGENT_EXECUTOR_HOME": str(legacy_home)},
            clear=True,
        ):
            self.assertEqual(mailbox.root(), orchestrate_home / "mailbox-v1")
        with patch.dict(os.environ, {"AGENT_EXECUTOR_HOME": str(legacy_home)}, clear=True):
            self.assertEqual(mailbox.root(), legacy_home / "mailbox-v1")

    def test_root_preserves_existing_legacy_cache_until_orchestrate_cache_exists(self) -> None:
        xdg = self.root / "xdg-cache"
        preferred = xdg / "orchestrate"
        legacy = xdg / "agent-executor"
        with patch.dict(os.environ, {"XDG_CACHE_HOME": str(xdg)}, clear=True):
            self.assertEqual(runtime_paths.cache_home(), preferred)
            self.assertEqual(mailbox.root(), preferred / "mailbox-v1")

            legacy.mkdir(parents=True, exist_ok=True)
            self.assertEqual(runtime_paths.cache_home(), legacy)
            self.assertEqual(mailbox.root(), legacy / "mailbox-v1")

            preferred.mkdir(parents=True, exist_ok=True)
            self.assertEqual(runtime_paths.cache_home(), preferred)
            self.assertEqual(mailbox.root(), preferred / "mailbox-v1")


class MailboxModuleDecompositionTests(unittest.TestCase):
    def test_extracted_modules_reexport_cleanly_through_peer_mailbox(self) -> None:
        import mailbox_cli
        import mailbox_hooks
        import mailbox_store

        for symbol in ("locked", "load", "write", "base_dir", "peer_path", "inbox_dir", "short_agent_name"):
            self.assertIs(getattr(mailbox, symbol), getattr(mailbox_store, symbol))
        for symbol in (
            "adopt_cleared",
            "offer_cleared_lead",
            "succession_notice",
            "swarm_coordinator_context",
            "swarm_command_context",
            "hook",
        ):
            self.assertIs(getattr(mailbox, symbol), getattr(mailbox_hooks, symbol))
        for symbol in ("session_arg", "caller", "table", "render_work", "build_parser"):
            self.assertIs(getattr(mailbox, symbol), getattr(mailbox_cli, symbol))
        self.assertFalse(hasattr(mailbox, "session_identity"))


if __name__ == "__main__":
    unittest.main()
