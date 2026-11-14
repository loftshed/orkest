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
import mailbox_wake  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402
import room_store  # noqa: E402
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

    def test_runtime_paths_config_home_and_set_home_env(self) -> None:
        xdg = self.root / "xdg-config"
        primary = xdg / "orchestrate"
        legacy = xdg / "agent-executor"
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(xdg)}, clear=True):
            self.assertEqual(runtime_paths.config_home(), primary)
            legacy.mkdir(parents=True, exist_ok=True)
            (legacy / "config.json").write_text("{}")
            self.assertEqual(runtime_paths.config_home(), legacy)
            self.assertEqual(runtime_paths.config_path(), legacy / "config.json")
            primary.mkdir(parents=True, exist_ok=True)
            (primary / "config.json").write_text("{}")
            self.assertEqual(runtime_paths.config_home(), primary)
            self.assertEqual(runtime_paths.config_path(), primary / "config.json")
        env: dict[str, str] = {}
        returned = runtime_paths.set_home_env(env, self.root / "custom-home")
        self.assertIs(returned, env)
        self.assertEqual(env["ORCHESTRATE_HOME"], str(self.root / "custom-home"))
        self.assertEqual(env["AGENT_EXECUTOR_HOME"], str(self.root / "custom-home"))


class PeerAliasAndPruneSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / "mailbox-v1"
        self.cwd = str(self.root / "project")
        subprocess.run(["git", "init", "-q", self.cwd], check=True)

    def test_resolve_accepts_bare_person_alias(self) -> None:
        sender = mailbox.register(
            self.base, session="00000000-0000-0000-0000-000000000001", harness="codex", cwd=self.cwd, pid=os.getpid()
        )
        target = mailbox.register(
            self.base, session="00000000-0000-0000-0000-000000000002", harness="claude", cwd=self.cwd, pid=os.getpid()
        )
        resolved = mailbox.resolve(self.base, target["person"], sender=sender)
        self.assertEqual(resolved["session"], target["session"])

    def test_prune_respects_lock_grace_window_and_active_flock_and_prunes_rooms_briefs_progress_and_board(self) -> None:
        import fcntl

        peers_dir = self.base / "peers"
        peers_dir.mkdir(parents=True, exist_ok=True)
        fresh_lock = peers_dir / "fresh-orphan.lock"
        fresh_lock.write_text("")
        held_old_lock = peers_dir / "held-orphan.lock"
        held_old_lock.write_text("")
        free_old_lock = peers_dir / "free-orphan.lock"
        free_old_lock.write_text("")
        old_time = time.time() - (mailbox.MAX_AGE.total_seconds() + 3600)
        os.utime(held_old_lock, (old_time, old_time))
        os.utime(free_old_lock, (old_time, old_time))

        # Stale room, orphaned brief, stale progress, and terminal workboard item
        dead_room = self.base / "rooms" / "dead-room.json"
        mailbox.write(
            dead_room,
            {
                "schema": "agent-executor.room.v1",
                "id": "dead-room",
                "conductor": {"session": {"id": "dead-session"}},
                "agents": [],
            },
        )
        os.utime(dead_room, (old_time, old_time))

        live_peer = mailbox.register(
            self.base, session="00000000-0000-0000-0000-000000000099", harness="codex", cwd=self.cwd, pid=os.getpid()
        )
        live_room = self.base / "rooms" / "live-room.json"
        mailbox.write(
            live_room,
            {
                "schema": "agent-executor.room.v1",
                "id": "live-room",
                "conductor": {"session": {"id": live_peer["session"]}},
                "agents": [],
            },
        )
        os.utime(live_room, (old_time, old_time))

        orphan_brief = self.base.parent / "swarm-briefs" / "dead-room"
        orphan_brief.mkdir(parents=True, exist_ok=True)
        (orphan_brief / "brief.md").write_text("old brief")
        os.utime(orphan_brief, (old_time, old_time))

        live_brief = self.base.parent / "swarm-briefs" / "live-room"
        live_brief.mkdir(parents=True, exist_ok=True)
        (live_brief / "brief.md").write_text("keep live room brief")
        os.utime(live_brief, (old_time, old_time))

        stale_progress = self.base / "progress" / "dead-peer.json"
        old_stamp = mailbox.stamp(mailbox.now() - mailbox.MAX_AGE * 2)
        mailbox.write(stale_progress, {"session": "dead-peer", "stage": "complete", "updatedAt": old_stamp})
        os.utime(stale_progress, (old_time, old_time))

        board_path = self.base / "work" / "board.json"
        mailbox.write(
            board_path,
            {
                "schema": "agent-executor.workboard.v1",
                "items": [
                    {"id": "old-done", "status": "accepted", "updatedAt": old_stamp},
                    {"id": "old-abandoned", "status": "abandoned", "updatedAt": old_stamp},
                    {"id": "active-open", "status": "open", "updatedAt": old_stamp},
                ],
            },
        )

        fd = os.open(held_old_lock, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            mailbox.prune(self.base)
            self.assertTrue(fresh_lock.exists(), "fresh lock within 15m grace window must not be unlinked")
            self.assertTrue(held_old_lock.exists(), "actively held lock must not be unlinked")
            self.assertFalse(free_old_lock.exists(), "stale unlocked lock should be unlinked")
        finally:
            os.close(fd)

        self.assertIsNone(room_store.read_room(self.base, "dead-room"))
        self.assertEqual(
            room_store.read_room(self.base, "live-room")["conductor"]["session"]["id"], live_peer["session"]
        )
        self.assertFalse(dead_room.exists())
        self.assertFalse(live_room.exists())
        self.assertFalse(orphan_brief.exists())
        self.assertTrue(live_brief.exists())
        self.assertFalse(stale_progress.exists())
        board = mailbox.load(board_path)
        self.assertEqual([item["id"] for item in board["items"]], ["active-open"])


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


class SqliteSharedRoomTests(unittest.TestCase):
    def test_shared_room_is_detected_after_import_and_rebinding(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            mailbox.register(base, session="new", harness="claude", cwd=temporary, pid=os.getpid())
            mailbox.attest_native_sessions(base, "new", "first")
            room_store.put_room(
                base,
                {
                    "id": "shared",
                    "cwd": temporary,
                    "conductor": {"session": {"id": "first"}},
                    "agents": [{"id": "worker", "mailboxSession": "second"}],
                },
            )
            self.assertTrue(mailbox.shares_swarm_room(base, {"session": "first"}, {"session": "second"}))
            room_store.rebind(base, "shared", "conductor", "new")
            self.assertFalse(mailbox.shares_swarm_room(base, {"session": "first"}, {"session": "second"}))
            self.assertTrue(mailbox.shares_swarm_room(base, {"session": "new"}, {"session": "second"}))


class AntigravityOrchestratorHookTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.temp_root = Path(temporary.name)
        self.base = self.temp_root / "mailbox-v1"
        self.cwd = str(self.temp_root / "project")
        subprocess.run(["git", "init", "-q", self.cwd], check=True)
        self.session = "11111111-1111-4111-8111-1111111111aa"
        self.gemini_home = self.temp_root / "home" / ".gemini"
        self.transcript = (
            self.gemini_home
            / "antigravity-cli"
            / "brain"
            / self.session
            / ".system_generated"
            / "logs"
            / "transcript.jsonl"
        )
        self.transcript.parent.mkdir(parents=True, exist_ok=True)
        self.colleague = mailbox.register(
            self.base, session="colleague-1", harness="codex", cwd=self.cwd, pid=os.getpid()
        )

    def write_transcript(self, entries: list[dict[str, object]]) -> None:
        self.transcript.write_text(
            "".join(json.dumps(entry) + "\n" for entry in entries),
            encoding="utf-8",
        )

    def test_transcript_model_reads_planner_response_and_settings_change(self):
        self.write_transcript(
            [
                {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan this"},
                {
                    "type": "PLANNER_RESPONSE",
                    "model": "gemini-pro-orchestrator",
                    "source": "MODEL",
                    "tool_calls": [{"name": "exit_plan_mode"}],
                },
                {"type": "GENERIC", "source": "MODEL"},
                {"type": "SYSTEM_MESSAGE", "content": "Plan mode is off"},
                {"type": "PLANNER_RESPONSE", "model": "gemini-flash-worker-agy", "source": "MODEL", "tool_calls": []},
                {"type": "PLANNER_RESPONSE", "model": "gemini-4-hydrogen-xhigh", "source": "MODEL", "tool_calls": []},
            ]
        )
        self.assertEqual(
            mailbox.transcript_model({"transcriptPath": str(self.transcript)}),
            "gemini-pro-orchestrator",
        )

        # A new USER_INPUT before Turn 2 writes a PLANNER_RESPONSE should not leak the Turn 1 worker model.
        self.write_transcript(
            [
                {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan this"},
                {
                    "type": "PLANNER_RESPONSE",
                    "model": "gemini-pro-orchestrator",
                    "source": "MODEL",
                    "tool_calls": [{"name": "exit_plan_mode"}],
                },
                {"type": "PLANNER_RESPONSE", "model": "gemini-flash-worker-agy", "source": "MODEL"},
                {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Follow up"},
            ]
        )
        self.assertEqual(
            mailbox.transcript_model({}, str(self.transcript)),
            "gemini-pro-orchestrator",
        )

        # Once Turn 2 writes a concrete non-orchestrator PLANNER_RESPONSE without exit_plan_mode, honor it.
        self.write_transcript(
            [
                {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan this"},
                {
                    "type": "PLANNER_RESPONSE",
                    "model": "gemini-pro-orchestrator",
                    "source": "MODEL",
                    "tool_calls": [{"name": "exit_plan_mode"}],
                },
                {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Switched turn"},
                {"type": "PLANNER_RESPONSE", "model": "gemini-4-hydrogen-high", "source": "MODEL"},
            ]
        )
        self.assertEqual(
            mailbox.transcript_model({"transcriptPath": str(self.transcript)}),
            "gemini-4-hydrogen-high",
        )

        # An explicit USER_SETTINGS_CHANGE overrides prior exit_plan_mode.
        self.write_transcript(
            [
                {
                    "type": "PLANNER_RESPONSE",
                    "model": "gemini-pro-orchestrator",
                    "source": "MODEL",
                    "tool_calls": [{"name": "exit_plan_mode"}],
                },
                {"type": "USER_SETTINGS_CHANGE", "model": "gemini-4-carbon-high"},
            ]
        )
        self.assertEqual(
            mailbox.transcript_model({"transcriptPath": str(self.transcript)}),
            "gemini-4-carbon-high",
        )

    def test_sticky_orchestrator_identity_across_worker_steps_and_transcript_fallback(self):
        self.write_transcript(
            [
                {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan task"},
                {"type": "PLANNER_RESPONSE", "model": "gemini-pro-orchestrator", "source": "MODEL"},
            ]
        )
        env = {"HOME": str(self.temp_root / "home")}
        base_payload = {"conversationId": self.session, "workspacePaths": [self.cwd]}
        with (
            patch.dict(os.environ, env, clear=True),
            patch.object(mailbox, "harness_pid", return_value=os.getpid()),
        ):
            # Payload omits transcriptPath and uses modelName="auto"; fallback resolves transcript before model lookup.
            mailbox.hook({**base_payload, "modelName": "auto"}, event="SessionStart", harness="gemini", base=self.base)
            initial = mailbox.load(mailbox.peer_path(self.base, self.session))
            self.assertEqual(initial["model"], "gemini-pro-orchestrator")
            self.assertIn("gemini-pro-orchestrator", initial["name"])
            stable_name = initial["name"]

            # Exit plan mode, enter execution phase with transient worker models.
            self.write_transcript(
                [
                    {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan task"},
                    {
                        "type": "PLANNER_RESPONSE",
                        "model": "gemini-pro-orchestrator",
                        "source": "MODEL",
                        "tool_calls": [{"name": "exit_plan_mode"}],
                    },
                    {"type": "GENERIC", "source": "MODEL"},
                    {"type": "SYSTEM_MESSAGE", "content": "Plan mode is off"},
                ]
            )
            mailbox.hook(
                {**base_payload, "model": "gemini-flash-worker-agy", "invocationNum": 2},
                event="PreInvocation",
                harness="gemini",
                base=self.base,
            )
            mid_flash = mailbox.load(mailbox.peer_path(self.base, self.session))
            self.assertEqual(mid_flash["model"], "gemini-pro-orchestrator")
            self.assertEqual(mid_flash["name"], stable_name)
            self.assertEqual(mid_flash["announcedName"], stable_name)
            self.assertEqual(mid_flash.get("aliases", []), [])
            self.assertEqual(mid_flash["executionModel"], "gemini-flash-worker-agy")

            mailbox.hook(
                {**base_payload, "model": "gemini-4-hydrogen-xhigh", "invocationNum": 3},
                event="PreInvocation",
                harness="gemini",
                base=self.base,
            )
            mid_hydrogen = mailbox.load(mailbox.peer_path(self.base, self.session))
            self.assertEqual(mid_hydrogen["model"], "gemini-pro-orchestrator")
            self.assertEqual(mid_hydrogen["name"], stable_name)
            self.assertEqual(mid_hydrogen["executionModel"], "gemini-4-hydrogen-xhigh")

            # Long execution turns that push exit_plan_mode out of the tail window preserve orchestrator identity.
            self.write_transcript(
                [
                    {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan task"},
                    {
                        "type": "PLANNER_RESPONSE",
                        "model": "gemini-pro-orchestrator",
                        "source": "MODEL",
                        "tool_calls": [{"name": "exit_plan_mode"}],
                    },
                    {"type": "GENERIC", "source": "MODEL", "content": "x" * (mailbox._TRANSCRIPT_TAIL_BYTES + 2048)},
                    {"type": "PLANNER_RESPONSE", "model": "gemini-flash-worker-agy", "source": "MODEL"},
                    {"type": "GENERIC", "source": "MODEL"},
                ]
            )
            mailbox.hook(
                {**base_payload, "model": "gemini-flash-worker-agy", "invocationNum": 4},
                event="PreInvocation",
                harness="gemini",
                base=self.base,
            )
            long_turn = mailbox.load(mailbox.peer_path(self.base, self.session))
            self.assertEqual(long_turn["model"], "gemini-pro-orchestrator")
            self.assertEqual(long_turn["name"], stable_name)
            self.assertEqual(long_turn["executionModel"], "gemini-flash-worker-agy")

            # Returning to planner on the next USER_INPUT clears executionModel.
            self.write_transcript(
                [
                    {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Next request"},
                ]
            )
            mailbox.hook(
                {**base_payload, "model": "gemini-pro-orchestrator", "invocationNum": 4},
                event="PreInvocation",
                harness="gemini",
                base=self.base,
            )
            resumed = mailbox.load(mailbox.peer_path(self.base, self.session))
            self.assertEqual(resumed["model"], "gemini-pro-orchestrator")
            self.assertIsNone(resumed.get("executionModel"))

            # Minimal hook fallback when no transcript file exists on disk preserves orchestrator model.
            self.transcript.unlink()
            mailbox.hook(
                {**base_payload, "model": "gemini-4-hydrogen-xhigh", "invocationNum": 5},
                event="PreInvocation",
                harness="gemini",
                base=self.base,
            )
            no_transcript = mailbox.load(mailbox.peer_path(self.base, self.session))
            self.assertEqual(no_transcript["model"], "gemini-pro-orchestrator")
            self.assertEqual(no_transcript["name"], stable_name)
            self.assertEqual(no_transcript["executionModel"], "gemini-4-hydrogen-xhigh")

    def test_stop_during_exit_plan_mode_leaves_unread_mail_for_execution_preinvocation(self):
        self.write_transcript(
            [
                {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan task"},
                {"type": "PLANNER_RESPONSE", "model": "gemini-pro-orchestrator", "source": "MODEL"},
            ]
        )
        base_payload = {
            "conversationId": self.session,
            "workspacePaths": [self.cwd],
            "transcriptPath": str(self.transcript),
        }
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(mailbox, "harness_pid", return_value=os.getpid()),
            patch.object(mailbox_wake, "wake", return_value={"status": "queued", "phase": "not-sent"}),
        ):
            mailbox.hook(
                {**base_payload, "model": "gemini-pro-orchestrator"},
                event="SessionStart",
                harness="gemini",
                base=self.base,
            )
            mailbox.hook(
                {**base_payload, "model": "gemini-pro-orchestrator", "invocationNum": 1},
                event="PreInvocation",
                harness="gemini",
                base=self.base,
            )
            mailbox.send(self.base, sender=self.colleague, to=self.session, text="urgent: wait for me")
            self.write_transcript(
                [
                    {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan task"},
                    {
                        "type": "PLANNER_RESPONSE",
                        "model": "gemini-pro-orchestrator",
                        "source": "MODEL",
                        "tool_calls": [{"name": "exit_plan_mode"}],
                    },
                    {"type": "GENERIC", "source": "MODEL"},
                    {"type": "EPHEMERAL_MESSAGE", "content": "notice"},
                ]
            )
            stop_result = mailbox.hook(
                {**base_payload, "terminationReason": "NO_TOOL_CALL"},
                event="Stop",
                harness="gemini",
                base=self.base,
            )
            self.assertEqual(stop_result, {})
            self.assertEqual(len(mailbox.incoming(self.base, self.session)), 1)

            self.write_transcript(
                [
                    {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan task"},
                    {
                        "type": "PLANNER_RESPONSE",
                        "model": "gemini-pro-orchestrator",
                        "source": "MODEL",
                        "tool_calls": [{"name": "exit_plan_mode"}],
                    },
                    {"type": "GENERIC", "source": "MODEL"},
                    {"type": "SYSTEM_MESSAGE", "content": "Plan mode is off"},
                ]
            )
            exec_step = mailbox.hook(
                {**base_payload, "model": "gemini-flash-worker-agy", "invocationNum": 2},
                event="PreInvocation",
                harness="gemini",
                base=self.base,
            )
            self.assertIn("urgent: wait for me", exec_step["injectSteps"][0]["ephemeralMessage"])
            self.assertEqual(mailbox.incoming(self.base, self.session), [])
            peer = mailbox.load(mailbox.peer_path(self.base, self.session))
            self.assertEqual(peer["model"], "gemini-pro-orchestrator")
            self.assertEqual(peer["executionModel"], "gemini-flash-worker-agy")

            # Execute -> Plan Review hand-back via enter_plan_mode also suppresses Stop continue.
            mailbox.send(self.base, sender=self.colleague, to=self.session, text="hold on enter plan mode")
            self.write_transcript(
                [
                    {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan task"},
                    {
                        "type": "PLANNER_RESPONSE",
                        "model": "gemini-pro-orchestrator",
                        "source": "MODEL",
                        "tool_calls": [{"name": "exit_plan_mode"}],
                    },
                    {"type": "GENERIC", "source": "MODEL"},
                    {
                        "type": "PLANNER_RESPONSE",
                        "model": "gemini-flash-worker-agy",
                        "source": "MODEL",
                        "tool_calls": [{"name": "enter_plan_mode"}],
                    },
                    {"type": "GENERIC", "source": "MODEL"},
                ]
            )
            enter_plan_stop = mailbox.hook(
                {**base_payload, "terminationReason": "NO_TOOL_CALL"},
                event="Stop",
                harness="gemini",
                base=self.base,
            )
            self.assertEqual(enter_plan_stop, {})
            self.assertEqual(len(mailbox.incoming(self.base, self.session)), 1)

    def test_explicit_user_input_model_switch_updates_peer_model(self):
        self.write_transcript(
            [
                {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan task"},
                {
                    "type": "PLANNER_RESPONSE",
                    "model": "gemini-pro-orchestrator",
                    "source": "MODEL",
                    "tool_calls": [{"name": "exit_plan_mode"}],
                },
            ]
        )
        base_payload = {
            "conversationId": self.session,
            "workspacePaths": [self.cwd],
            "transcriptPath": str(self.transcript),
        }
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(mailbox, "harness_pid", return_value=os.getpid()),
        ):
            mailbox.hook(
                {**base_payload, "model": "gemini-pro-orchestrator"},
                event="SessionStart",
                harness="gemini",
                base=self.base,
            )
            mailbox.hook(
                {**base_payload, "model": "gemini-flash-worker-agy", "invocationNum": 1},
                event="PreInvocation",
                harness="gemini",
                base=self.base,
            )
            self.assertEqual(
                mailbox.load(mailbox.peer_path(self.base, self.session))["model"], "gemini-pro-orchestrator"
            )

            # New USER_INPUT without exit_plan_mode + explicit model change updates the peer model cleanly.
            self.write_transcript(
                [
                    {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "Plan task"},
                    {
                        "type": "PLANNER_RESPONSE",
                        "model": "gemini-pro-orchestrator",
                        "source": "MODEL",
                        "tool_calls": [{"name": "exit_plan_mode"}],
                    },
                    {"type": "USER_INPUT", "source": "USER_EXPLICIT", "content": "/model gemini-4-hydrogen-high"},
                ]
            )
            mailbox.hook(
                {**base_payload, "model": "gemini-4-hydrogen-high", "invocationNum": 2},
                event="PreInvocation",
                harness="gemini",
                base=self.base,
            )
            switched = mailbox.load(mailbox.peer_path(self.base, self.session))
            self.assertEqual(switched["model"], "gemini-4-hydrogen-high")
            self.assertIsNone(switched.get("executionModel"))

    def test_session_model_and_step_model_separation_across_harnesses(self):
        harness_cases = [
            ("claude", "claude-opus-4-6", "claude-haiku-4-5", "claude-sonnet-4-6"),
            ("codex", "gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"),
            (
                "opencode",
                "openrouter/z-ai/glm-5.3-flash",
                "openrouter/deepseek/deepseek-v4-flash",
                "openrouter/qwen/qwen3-coder",
            ),
        ]
        for harness, initial_model, transient_model, switched_model in harness_cases:
            with self.subTest(harness=harness):
                session_id = f"session-{harness}-1"
                session_key_field = "session_id"
                base_payload = {
                    session_key_field: session_id,
                    "cwd": self.cwd,
                }
                with (
                    patch.dict(os.environ, {}, clear=True),
                    patch.object(mailbox, "harness_pid", return_value=os.getpid()),
                ):
                    mailbox.hook(
                        {**base_payload, "model": initial_model},
                        event="SessionStart",
                        harness=harness,
                        base=self.base,
                    )
                    started = mailbox.load(mailbox.peer_path(self.base, session_id))
                    initial_name = started["name"]
                    self.assertEqual(started["model"], initial_model)
                    self.assertEqual(started["sessionModel"], initial_model)
                    self.assertEqual(started["stepModel"], initial_model)

                    # Mid-turn step model must not rename the peer or overwrite sticky sessionModel.
                    mailbox.hook(
                        {**base_payload, "model": transient_model},
                        event="PreInvocation",
                        harness=harness,
                        base=self.base,
                    )
                    mid = mailbox.load(mailbox.peer_path(self.base, session_id))
                    self.assertEqual(mid["name"], initial_name)
                    self.assertEqual(mid["model"], initial_model)
                    self.assertEqual(mid["sessionModel"], initial_model)
                    self.assertEqual(mid["stepModel"], transient_model)
                    self.assertEqual(mid["executionModel"], transient_model)

                    # Explicit new user prompt on switched_model updates sticky sessionModel cleanly.
                    mailbox.hook(
                        {**base_payload, "model": switched_model},
                        event="UserPromptSubmit",
                        harness=harness,
                        base=self.base,
                    )
                    switched = mailbox.load(mailbox.peer_path(self.base, session_id))
                    self.assertEqual(switched["model"], switched_model)
                    self.assertEqual(switched["sessionModel"], switched_model)
                    self.assertEqual(switched["stepModel"], switched_model)
                    self.assertIsNone(switched.get("executionModel"))


if __name__ == "__main__":
    unittest.main()
