"""A wrapped terminal follows its visible native session without guessing from shared processes."""

from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import os
import pty
import re
import secrets
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import termios
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import agent_progress as progress  # noqa: E402
import agent_statusline  # noqa: E402
import agent_terminal  # noqa: E402
import mailbox_hooks  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402
import room_store  # noqa: E402


class HerdrMetadataTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ork-herdr-metadata-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()
        self.base = self.home / "mailbox-v1"
        environment = {
            **os.environ,
            "AGENT_EXECUTOR_HOME": str(self.home),
            "CODEX_HOME": str(self.home),
            "HERDR_ENV": "1",
            "HERDR_PANE_ID": "w1:p1",
            "HERDR_WORKSPACE_ID": "w1",
            "HERDR_SOCKET_PATH": str(self.home / "server.sock"),
            "ORKEST_TERMINAL_HARNESS": "codex",
            "ORKEST_TEST_ALLOW_HERDR": "1",
            "ORK_GLYPHS": "ascii",
        }
        for key in ("ORKEST_TERMINAL_SERVER", "TMUX", "TMUX_PANE", "ORKEST_SWARM_ROOM", "HERDR_BIN_PATH"):
            environment.pop(key, None)
        self.enterContext(mock.patch.dict(os.environ, environment, clear=True))
        self.metadata = {}
        self.reports = []
        original_run = subprocess.run
        original_which = shutil.which

        def fake_run(command, **kwargs):
            if command[:3] == ["/fake/herdr", "agent", "get"]:
                ref = {"agent": "codex", "source": "herdr:codex", "kind": "id", "value": self.agent_session}
                agent = {"agent_session": ref}
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps({"result": {"type": "agent_info", "agent": agent}}), stderr=""
                )
            if command[:2] != ["/fake/herdr", "pane"]:
                return original_run(command, **kwargs)
            if command[2] == "list":
                return subprocess.CompletedProcess(command, 0, stdout='{"result":{"panes":[]}}', stderr="")
            self.reports.append(command)
            if command[2] != "report-metadata" or command[3].startswith("--"):
                return subprocess.CompletedProcess(command, 2, stdout="", stderr="unknown option")
            self.metadata[command[3]] = {
                "title": command[command.index("--title") + 1],
                "display_agent": command[command.index("--display-agent") + 1],
            }
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        self.enterContext(mock.patch.object(agent_terminal.subprocess, "run", side_effect=fake_run))
        self.enterContext(
            mock.patch.object(
                agent_terminal.shutil,
                "which",
                side_effect=lambda command: "/fake/herdr" if command == "herdr" else original_which(command),
            )
        )
        self.enterContext(mock.patch.object(mailbox_hooks, "_maybe_trigger_auto_update"))
        self.enterContext(mock.patch.object(mailbox, "harness_pid", return_value=os.getpid()))
        self.session = "codex-resume-session-2222"
        self.agent_session = self.session
        peer = mailbox.register(
            self.base,
            session=self.session,
            harness="codex",
            cwd=str(self.home),
            model="fixture-model",
            effort="medium",
            account=str(self.home),
            pid=os.getpid(),
        )
        peer = mailbox.annotate(
            self.base,
            self.session,
            person="snorfle",
            name="snorfle-fixture-model-medium-project-aa",
            nativeName="snorfle-fixture-model-medium-project-aa",
            nativeNameSource="explicit",
        )
        progress.report(self.base, peer, goal="Inspect changes", task="Review current changes", stage="working")

    def test_same_display_text_is_published_again_when_a_session_moves_to_another_pane(self):
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model"}))
        os.environ["HERDR_PANE_ID"] = "w1:p2"
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model"}))
        self.assertEqual(
            self.metadata.get("w1:p2"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )

    def test_codex_resume_hook_republishes_metadata_after_same_pane_restoration(self):
        payload = {
            "session_id": self.session,
            "hook_event_name": "SessionStart",
            "source": "resume",
            "cwd": str(self.home),
            "model": "fixture-model",
            "effort": "medium",
        }
        mailbox.hook(payload, harness="codex", base=self.base)
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )
        self.metadata.clear()
        mailbox.hook(payload, harness="codex", base=self.base)
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )

    def test_unchanged_turn_metadata_is_cached_for_the_same_endpoint_and_pane(self):
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model"}))
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model"}))
        self.assertEqual(
            self.metadata["w1:p1"],
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )
        self.assertEqual(len(self.reports), 1)
        stored = mailbox.load(mailbox.peer_path(self.base, self.session))
        self.assertEqual(stored["herdrSyncedTarget"], {"endpoint": str(self.home / "server.sock"), "pane": "w1:p1"})
        self.assertNotIn("--ttl-ms", self.reports[0])
        self.assertIn("--seq", self.reports[0])
        self.assertEqual(self.reports[0][self.reports[0].index("--agent") + 1], "codex")

    def test_metadata_needs_no_expiry_refresh_and_skips_a_reused_pane(self):
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model"}))
        mailbox.annotate(self.base, self.session, herdrSyncedAt=0)
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model"}))
        self.assertEqual(len(self.reports), 1)
        self.agent_session = "another-session"
        self.assertFalse(agent_terminal.bind(self.session, "codex", {"model": "fixture-model"}, force=True))
        self.assertEqual(len(self.reports), 1)

    def test_another_endpoint_gets_the_same_session_metadata(self):
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model"}))
        self.metadata.clear()
        os.environ["HERDR_SOCKET_PATH"] = str(self.home / "another-server.sock")
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model"}))
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )
        self.assertEqual(len(self.reports), 2)

    def test_subagent_hooks_leave_parent_pane_metadata_untouched(self):
        payload = {
            "session_id": self.session,
            "hook_event_name": "SessionStart",
            "source": "resume",
            "cwd": str(self.home),
            "model": "fixture-model",
            "effort": "medium",
        }
        mailbox.annotate(self.base, self.session, isSubagent=True)
        mailbox.hook(payload, harness="codex", base=self.base)
        self.assertEqual(self.metadata, {})
        mailbox.annotate(self.base, self.session, isSubagent=False)
        mailbox.hook(payload, harness="codex", base=self.base)
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )

    def test_delegated_worker_hooks_leave_parent_pane_metadata_untouched(self):
        with mock.patch.object(mailbox, "detect_harness", return_value="claude"):
            run = mailbox.open_run(
                self.base,
                "metadata-worker",
                worker_harness="codex",
                repository=self.home,
                result_path=self.home / "result.json",
                deadline=(dt.datetime.now(dt.UTC) + dt.timedelta(minutes=5)).isoformat(),
                worker_pid=os.getpid(),
            )
        os.environ["AGENT_MAILBOX_SESSION"] = run["worker"]
        payload = {
            "session_id": self.session,
            "hook_event_name": "SessionStart",
            "cwd": str(self.home),
            "model": "fixture-model",
            "effort": "medium",
        }
        mailbox.hook(payload, harness="codex", base=self.base)
        self.assertEqual(self.metadata, {})
        os.environ.pop("AGENT_MAILBOX_SESSION")
        mailbox.hook(payload, harness="codex", base=self.base)
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )

    def test_refresh_cli_keeps_identity_and_does_not_change_workforce_role(self):
        peer = mailbox.load(mailbox.peer_path(self.base, self.session))
        progress.report(
            self.base, peer, goal="Inspect changes", task="Review current changes", stage="working", role="builder"
        )
        room = {
            "schema": "agent-executor.room.v1",
            "id": "promoted-room",
            "cwd": str(self.home),
            "machine": socket.gethostname(),
            "swarm": {"maxAgents": 16, "maxDepth": 4},
            "updatedAt": 1000,
            "conductor": {
                "engine": "codex",
                "role": "lead",
                "session": {
                    "id": self.session,
                    "engine": "codex",
                    "machine": socket.gethostname(),
                    "cwd": str(self.home),
                },
            },
            "agents": [],
        }
        mailbox.write(self.base / "rooms" / "promoted-room.json", room)
        another = {**room, "id": "another-room", "updatedAt": 2000}
        another_path = self.base / "rooms" / "another-room.json"
        mailbox.write(another_path, another)
        another_content = room_store.read_room(self.base, "another-room")
        os.environ["ORKEST_SWARM_ROOM"] = "promoted-room"
        agent_terminal.bind(self.session, "codex", {})
        argv = [
            "agent_statusline.py",
            "--native-status",
            "--refresh-terminal",
            "--session",
            self.session,
            "--harness",
            "codex",
            "--json",
        ]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(sys, "stdout", io.StringIO()):
            self.assertEqual(agent_statusline.main(), 0)
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )
        self.assertEqual(progress.read(self.base, peer)["role"], "builder")
        self.assertEqual(room_store.read_room(self.base, "another-room"), another_content)

    def test_a_resume_alias_is_not_presented_as_an_exact_coordinator_binding(self):
        mailbox.annotate(self.base, self.session, aliases=["previous-coordinator"])
        room = {
            "schema": "agent-executor.room.v1",
            "id": "previous-room",
            "cwd": str(self.home),
            "machine": socket.gethostname(),
            "swarm": {"maxAgents": 16, "maxDepth": 4},
            "conductor": {
                "engine": "codex",
                "role": "lead",
                "session": {"id": "previous-coordinator", "engine": "codex"},
            },
            "agents": [],
        }
        mailbox.write(self.base / "rooms" / "previous-room.json", room)
        self.assertTrue(agent_terminal.bind(self.session, "codex", {}))
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )

    def test_a_top_level_lead_does_not_replace_the_root_coordinators_pane(self):
        room = {
            "schema": "agent-executor.room.v1",
            "id": "parent-room",
            "cwd": str(self.home),
            "machine": socket.gethostname(),
            "swarm": {"maxAgents": 16, "maxDepth": 4},
            "conductor": {"engine": "codex", "session": {"id": "root-coordinator"}},
            "herdrCoordinatorPaneId": "w1:p-root",
            "agents": [
                {
                    "id": "subswarm-lead",
                    "engine": "codex",
                    "role": "lead",
                    "session": {"id": self.session, "engine": "codex", "cwd": str(self.home)},
                }
            ],
        }
        room_path = self.base / "rooms" / "parent-room.json"
        mailbox.write(room_path, room)
        original = room_store.read_room(self.base, room["id"])
        self.assertTrue(agent_terminal.bind(self.session, "codex", {}))
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )
        self.assertEqual(room_store.read_room(self.base, room["id"]), original)

    def test_a_binding_in_another_checkout_does_not_supply_role_or_room_metadata(self):
        room = {
            "schema": "agent-executor.room.v1",
            "id": "another-checkout-room",
            "cwd": str(self.home / "another-checkout"),
            "machine": socket.gethostname(),
            "swarm": {"maxAgents": 16, "maxDepth": 4},
            "conductor": {
                "engine": "codex",
                "role": "lead",
                "session": {"id": self.session, "engine": "codex", "cwd": str(self.home / "another-checkout")},
            },
            "herdrCoordinatorPaneId": "w2:p1",
            "agents": [],
        }
        room_path = self.base / "rooms" / "another-checkout-room.json"
        mailbox.write(room_path, room)
        original = room_store.read_room(self.base, room["id"])
        self.assertTrue(agent_terminal.bind(self.session, "codex", {}))
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )
        self.assertEqual(room_store.read_room(self.base, room["id"]), original)

    def test_parent_pane_aggregates_children_without_marking_parent_working_or_stealing_parent_model(self):
        mailbox.annotate(self.base, self.session, state="idle")
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model", "effort": "medium"}))
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )

        # Start a subagent without explicit model in payload (should NOT inherit parent transcript model)
        parent_transcript = self.home / "parent-transcript.jsonl"
        parent_transcript.write_text(json.dumps({"model": "parent-transcript-model"}) + "\n")
        start_payload = {
            "session_id": self.session,
            "hook_event_name": "SubagentStart",
            "agent_id": "sub-1",
            "agent_type": "research",
            "cwd": str(self.home),
            "transcript_path": str(parent_transcript),
        }
        mailbox.hook(start_payload, harness="codex", event="SubagentStart", base=self.base)
        sub_peer = mailbox.load(mailbox.peer_path(self.base, "subagent-sub-1"))
        self.assertIsNone(sub_peer.get("model"))
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )
        # Parent peer state remains idle so mailbox wakes are not blocked
        parent_peer = mailbox.load(mailbox.peer_path(self.base, self.session))
        self.assertEqual(parent_peer.get("state"), "idle")

        # Start a second subagent with explicit runtime model and effort
        start_payload_2 = {
            "session_id": self.session,
            "hook_event_name": "SubagentStart",
            "agent_id": "sub-2",
            "agent_type": "self",
            "cwd": str(self.home),
            "model": "gpt-6-sol",
            "effort": "high",
        }
        mailbox.hook(start_payload_2, harness="codex", event="SubagentStart", base=self.base)
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )

        # Subagent in another checkout or account is excluded from parent pane count
        other_sub = mailbox.register(
            self.base,
            session="subagent-other-checkout",
            harness="codex",
            cwd=str(self.home / "other-checkout"),
            state="busy",
            account=str(self.home),
            pid=os.getpid(),
        )
        mailbox.annotate(
            self.base,
            other_sub["session"],
            isSubagent=True,
            parentSession=self.session,
        )
        agent_terminal.refresh_parent_pane(self.base, self.session)
        self.assertEqual(
            agent_terminal.aggregate_children(self.base, mailbox.load(mailbox.peer_path(self.base, self.session)))[
                "count"
            ],
            2,
        )

        # Stop both subagents -> count clears and ordinary display_agent text is restored
        for sub_id in ("sub-1", "sub-2"):
            mailbox.hook(
                {
                    "session_id": self.session,
                    "hook_event_name": "SubagentStop",
                    "agent_id": sub_id,
                    "cwd": str(self.home),
                },
                harness="codex",
                event="SubagentStop",
                base=self.base,
            )
        self.assertEqual(
            self.metadata.get("w1:p1"),
            {
                "title": "working · Review current changes",
                "display_agent": "[C] snorfle-fixture-model-medium-project-aa",
            },
        )

    def test_only_presentation_changes_trigger_resync(self):
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model", "effort": "medium"}))
        self.assertEqual(len(self.reports), 1)
        # Effort and provenance alone do not change the visible name or work.
        mailbox.annotate(self.base, self.session, effort="high")
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model", "effort": "high"}))
        self.assertEqual(len(self.reports), 1)
        # Runtime provenance also leaves presentation unchanged.
        mailbox.annotate(self.base, self.session, modelSource="runtime")
        self.assertTrue(agent_terminal.bind(self.session, "codex", {"model": "fixture-model", "effort": "high"}))
        self.assertEqual(len(self.reports), 1)


@unittest.skipUnless(shutil.which("tmux"), "native pane binding requires tmux")
class TerminalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.base = self.home / "mailbox-v1"
        self.server = "orkest-label-" + secrets.token_hex(6)
        self.tmux = ["tmux", "-L", self.server]
        subprocess.run([*self.tmux, "-f", "/dev/null", "new-session", "-d", "--", "sleep", "120"], check=True)
        self.addCleanup(lambda: subprocess.run([*self.tmux, "kill-server"], capture_output=True, check=False))
        socket = subprocess.check_output([*self.tmux, "display-message", "-p", "#{socket_path}"], text=True).strip()
        self.environment = {**os.environ, "AGENT_EXECUTOR_HOME": str(self.home), "XDG_CONFIG_HOME": str(self.home)}
        for key in (
            "ORKEST_TERMINAL_SERVER",
            "ORKEST_TERMINAL_HARNESS",
            "TMUX",
            "TMUX_PANE",
            "HERDR_ENV",
            "HERDR_PANE_ID",
            "HERDR_WORKSPACE_ID",
            "HERDR_SOCKET_PATH",
            "HERDR_BIN_PATH",
        ):
            self.environment.pop(key, None)
        self.native = {
            **self.environment,
            "ORKEST_TERMINAL_SERVER": self.server,
            "TMUX": socket + ",123,0",
            "TMUX_PANE": "%0",
        }

    def peer(self, session, harness):
        mailbox.register(self.base, session=session, harness=harness, cwd=str(self.home), pid=os.getpid())
        mailbox.annotate(self.base, session, name="snorfle-test-high-footer-aa")

    def native_status(self, harness, session, *, clear=False, extra_environment=None):
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(SCRIPTS / "agent_statusline.py"),
                "--native-status",
                "--harness",
                harness,
                *(["--clear-terminal", session] if clear else []),
            ],
            input=json.dumps({"session_id": session, "model": {"id": "runtime-model"}, "effort": {"level": "high"}}),
            env={**self.native, "ORKEST_TERMINAL_HARNESS": harness, **(extra_environment or {})},
            capture_output=True,
            text=True,
            check=True,
        ).stdout

    def footer(self, harness):
        output = subprocess.check_output(
            [
                sys.executable,
                "-B",
                str(SCRIPTS / "agent_statusline.py"),
                "--terminal-pane",
                "%0",
                "--tmux-server",
                self.server,
                "--harness",
                harness,
                "--json",
                "--width",
                "200",
            ],
            env=self.environment,
            text=True,
        )
        return json.loads(output) if output else None

    def test_native_integrations_are_silent_and_feed_the_same_outer_footer(self):
        for harness in ("claude", "gemini", "opencode"):
            with self.subTest(harness=harness):
                session = "visible-" + harness
                self.peer(session, harness)
                self.assertEqual(self.native_status(harness, session), "")
                item = self.footer(harness)
                self.assertEqual(
                    (item["name"], item["fullName"], item["model"], item["effort"]),
                    ("snorfle", "snorfle-test-high-footer-aa", "runtime-model", "high"),
                )

    def test_binding_before_registration_does_not_create_presence(self):
        self.assertEqual(self.native_status("claude", "not-registered"), "")
        self.assertIsNone(self.footer("claude"))
        self.assertFalse(mailbox.peer_path(self.base, "not-registered").exists())
        self.peer("not-registered", "claude")
        self.assertEqual(self.footer("claude")["name"], "snorfle")

    def test_session_switches_and_late_cleanup_cannot_clear_the_new_session(self):
        for session in ("first", "second"):
            self.peer(session, "opencode")
            mailbox.annotate(self.base, session, name="agent-" + session)
            self.native_status("opencode", session)
        self.native_status("opencode", "first", clear=True)
        self.assertEqual(self.footer("opencode")["fullName"], "agent-second")
        self.native_status("opencode", "second", clear=True)
        self.assertIsNone(self.footer("opencode"))

    def test_a_nested_terminal_or_other_harness_cannot_replace_the_binding(self):
        self.peer("main", "claude")
        self.native_status("claude", "main")
        self.peer("other", "gemini")
        self.native_status("gemini", "other", extra_environment={"ORKEST_TERMINAL_HARNESS": "claude"})
        self.assertEqual(self.footer("claude")["name"], "snorfle")
        self.native_status("claude", "other", extra_environment={"TMUX": "/tmp/another-server,1,0"})
        self.assertEqual(self.footer("claude")["model"], "runtime-model")
        self.assertIsNone(self.footer("gemini"))

    def test_plain_launches_keep_the_native_display_without_touching_a_pane(self):
        self.peer("plain", "claude")
        output = subprocess.check_output(
            [
                sys.executable,
                "-B",
                str(SCRIPTS / "agent_statusline.py"),
                "--session",
                "plain",
                "--harness",
                "claude",
                "--plain",
                "--native-status",
                "--width",
                "200",
            ],
            env=self.environment,
            text=True,
        )
        self.assertEqual(
            output,
            f"snorfle | — / — | repo : {self.home.name} | stage : not set | goal : not set | task : not set\n",
        )
        self.assertIsNone(self.footer("claude"))

    def test_reading_another_session_inside_a_wrapper_does_not_rebind_it(self):
        self.peer("visible", "claude")
        self.peer("inspected", "claude")
        mailbox.annotate(self.base, "inspected", name="other-agent")
        self.native_status("claude", "visible")
        output = subprocess.check_output(
            [
                sys.executable,
                "-B",
                str(SCRIPTS / "agent_statusline.py"),
                "--session",
                "inspected",
                "--harness",
                "claude",
                "--json",
            ],
            env={**self.native, "ORKEST_TERMINAL_HARNESS": "claude"},
            text=True,
        )
        self.assertEqual(json.loads(output)["name"], "other-agent")
        self.assertEqual(self.footer("claude")["name"], "snorfle")

    def test_all_four_launchers_render_the_same_outer_footer(self):
        for executable, harness in (
            ("codex", "codex"),
            ("claude", "claude"),
            ("agy", "gemini"),
            ("opencode", "opencode"),
        ):
            with self.subTest(harness=harness):
                session = str(uuid.uuid4())
                peer = mailbox.register(
                    self.base,
                    session=session,
                    harness=harness,
                    cwd=str(self.home),
                    pid=os.getpid(),
                    account=str(self.home),
                    model="fixture-model",
                    effort="high",
                )
                progress.report(self.base, peer, goal="Verify launch", task="Render wrapper", stage="testing")
                info = self.home / (executable + ".json")
                binary = self.home / executable
                binary.write_text(
                    "#!" + sys.executable + "\n"
                    "import json, os, subprocess, sys\nfrom pathlib import Path\n"
                    "arguments = sys.argv[1:]\n"
                    + (
                        "sys.stdout.write(" + repr("\033]2;" + session + "\007") + ")\noutput = ''\n"
                        if harness == "codex"
                        else "output = subprocess.check_output("
                        + repr(
                            [
                                sys.executable,
                                str(SCRIPTS / "agent_statusline.py"),
                                "--native-status",
                                "--session",
                                session,
                                "--harness",
                                harness,
                                "--json",
                            ]
                        )
                        + ", text=True)\n"
                    )
                    + "Path("
                    + repr(str(info))
                    + ").write_text(json.dumps({'socket': os.environ['TMUX'].split(',')[0], "
                    "'arguments': arguments, 'nativeOutput': output}))\n"
                    "print('Harness content', flush=True)\n"
                    "while os.read(0, 1024): pass\n"
                )
                binary.chmod(0o755)
                environment = {**self.environment, "CODEX_HOME": str(self.home), "TERM": "xterm-256color"}
                environment.pop("NO_COLOR", None)
                pid, master = pty.fork()
                if pid == 0:
                    termios.tcsetwinsize(0, (30, 200))
                    os.execvpe(
                        "node",
                        [
                            "node",
                            str(SCRIPTS.parents[2] / "bin/ork.mjs"),
                            "label",
                            "--",
                            str(binary),
                            "--model",
                            "fixture-model",
                        ],
                        environment,
                    )
                output = b""
                try:
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        if select.select([master], [], [], 0.1)[0]:
                            output += os.read(master, 65536)
                        plain = re.sub(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\(B)", b"", output)
                        if b"task : Render wrapper" in plain:
                            break
                    self.assertIn(b"Harness content", plain)
                    self.assertIn(b"stage : testing | goal : Verify launch | task : Render wrapper", plain)
                    launched = json.loads(info.read_text())
                    self.assertEqual(launched["nativeOutput"], "")
                    expected = ["--model", "fixture-model"]
                    if harness == "codex":
                        expected = ["-c", 'tui.terminal_title=["session-id"]', *expected]
                    self.assertEqual(launched["arguments"], expected)
                finally:
                    if info.exists():
                        socket = json.loads(info.read_text())["socket"]
                        subprocess.run(["tmux", "-S", socket, "kill-server"], capture_output=True, check=False)
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if os.waitpid(pid, os.WNOHANG)[0]:
                            break
                        time.sleep(0.05)
                    else:
                        os.kill(pid, signal.SIGTERM)
                        os.waitpid(pid, 0)
                    os.close(master)

    def test_herdr_context_and_bind_annotate_peer_without_tmux(self):
        session = "herdr-session"
        self.peer(session, "claude")
        herdr_env = {
            **self.environment,
            "HERDR_ENV": "1",
            "HERDR_PANE_ID": "w1:p4",
            "HERDR_WORKSPACE_ID": "w1",
            "HERDR_SOCKET_PATH": str(self.home / "herdr.sock"),
            "ORKEST_TERMINAL_HARNESS": "claude",
        }
        old_environ = os.environ.copy()
        try:
            os.environ.clear()
            os.environ.update(herdr_env)
            self.assertEqual(agent_terminal.herdr_context("claude"), ("w1:p4", "w1"))
            self.assertIsNone(agent_terminal.herdr_context("gemini"))
            with mock.patch.object(agent_terminal.shutil, "which", return_value=None):
                self.assertTrue(agent_terminal.bind(session, "claude", {"model": "claude-sonnet"}))
        finally:
            os.environ.clear()
            os.environ.update(old_environ)
        stored = mailbox.load(mailbox.peer_path(self.base, session))
        self.assertEqual(stored["herdrPaneId"], "w1:p4")
        self.assertEqual(stored["herdrWorkspaceId"], "w1")
        self.assertEqual(stored["herdrEndpoint"], str((self.home / "herdr.sock").resolve()))
        self.assertNotIn("herdrSocket", stored)
        self.assertNotIn("terminalServer", stored)

    def test_tmux_binding_clears_stale_herdr_target(self):
        session = "moved-outside-herdr"
        self.peer(session, "codex")
        mailbox.annotate(
            self.base,
            session,
            herdrPaneId="w1:p1",
            herdrWorkspaceId="w1",
            herdrEndpoint="/tmp/old-herdr.sock",
            herdrBinary="/usr/bin/herdr",
        )
        with mock.patch.dict(os.environ, {**self.native, "ORKEST_TERMINAL_HARNESS": "codex"}, clear=True):
            self.assertTrue(agent_terminal.bind(session, "codex", {"model": "gpt-6-sol"}, base=self.base))
        stored = mailbox.load(mailbox.peer_path(self.base, session))
        self.assertEqual(stored["terminalServer"], self.server)
        self.assertIsNone(stored["herdrPaneId"])
        self.assertIsNone(stored["herdrEndpoint"])

    def test_herdr_bind_syncs_pane_metadata_and_refuses_subagents(self):
        from unittest import mock

        session = "herdr-sync-session"
        self.peer(session, "claude")
        peer_data = mailbox.load(mailbox.peer_path(self.base, session))
        progress.report(self.base, peer_data, goal="Ship Herdr", task="Sync title", stage="working", role="Builder")
        herdr_env = {
            **self.environment,
            "HERDR_ENV": "1",
            "HERDR_PANE_ID": "w1:p9",
            "HERDR_WORKSPACE_ID": "w1",
            "HERDR_SOCKET_PATH": str(self.home / "herdr.sock"),
            "ORKEST_TERMINAL_HARNESS": "claude",
        }
        calls: list[list[str]] = []

        def fake_run(cmd, **kwargs):
            calls.append(list(cmd))
            if cmd[1:3] == ["agent", "get"]:
                ref = {"agent": "claude", "source": "herdr:claude", "kind": "id", "value": session}
                return subprocess.CompletedProcess(
                    cmd,
                    0,
                    stdout=json.dumps({"result": {"type": "agent_info", "agent": {"agent_session": ref}}}),
                    stderr="",
                )
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        old_environ = os.environ.copy()
        try:
            os.environ.clear()
            os.environ.update(herdr_env)
            with (
                mock.patch.object(agent_terminal.shutil, "which", return_value="/usr/local/bin/herdr"),
                mock.patch.object(agent_terminal.subprocess, "run", side_effect=fake_run),
            ):
                self.assertTrue(agent_terminal.bind(session, "claude", {"model": "claude-sonnet"}))
                # Second bind with unchanged title does not re-run herdr pane report-metadata
                self.assertTrue(agent_terminal.bind(session, "claude", {"model": "claude-sonnet"}))
            reports = [call for call in calls if call[1:3] == ["pane", "report-metadata"]]
            self.assertEqual(len(reports), 1)
            self.assertNotIn("--ttl-ms", reports[0])
            self.assertEqual(reports[0][reports[0].index("--agent") + 1], "claude")
            self.assertEqual(reports[0][reports[0].index("--title") + 1], "working · Sync title")
            self.assertEqual(reports[0][reports[0].index("--display-agent") + 1], " snorfle-test-high-footer-aa")
            stored = mailbox.load(mailbox.peer_path(self.base, session))
            self.assertEqual(stored["herdrSyncedTitle"], "working · Sync title| snorfle-test-high-footer-aa")
            self.assertEqual(stored["herdrBinary"], "/usr/local/bin/herdr")

            # Herdr draws the label, so the native statusline emits no duplicate.
            herdr_status_out = subprocess.check_output(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPTS / "agent_statusline.py"),
                    "--native-status",
                    "--session",
                    session,
                    "--harness",
                    "claude",
                    "--json",
                    "--width",
                    "120",
                ],
                env={**herdr_env, "HERDR_BIN_PATH": "/nonexistent/herdr"},
                text=True,
            )
            self.assertEqual(herdr_status_out, "")

            # Subagent peer is refused by bind()
            sub_session = "herdr-subagent"
            self.peer(sub_session, "gemini")
            mailbox.annotate(self.base, sub_session, isSubagent=True)
            os.environ["ORKEST_TERMINAL_HARNESS"] = "gemini"
            self.assertFalse(agent_terminal.bind(sub_session, "gemini", {"model": "gemini-pro"}))
            sub_stored = mailbox.load(mailbox.peer_path(self.base, sub_session))
            self.assertNotIn("herdrPaneId", sub_stored)
        finally:
            os.environ.clear()
            os.environ.update(old_environ)

    def test_herdr_launch_runs_agent_directly(self):
        info = self.home / "herdr-claude.json"
        binary = self.home / "claude"
        binary.write_text(
            "#!" + sys.executable + "\n"
            "import json, os, sys\nfrom pathlib import Path\n"
            "Path(" + repr(str(info)) + ").write_text(json.dumps({"
            "'tmux': os.environ.get('TMUX'), "
            "'server': os.environ.get('ORKEST_TERMINAL_SERVER'), "
            "'harness': os.environ.get('ORKEST_TERMINAL_HARNESS'), "
            "'agent_hint': os.environ.get('HERDR_AGENT'), "
            "'herdr_pane': os.environ.get('HERDR_PANE_ID'), "
            "'args': sys.argv[1:]"
            "}))\n"
            "print('Herdr wrapped launch ready', flush=True)\n"
        )
        binary.chmod(0o755)
        environment = {
            **self.environment,
            "HERDR_ENV": "1",
            "HERDR_PANE_ID": "w1:p1",
            "HERDR_WORKSPACE_ID": "w1",
            "TMUX": "/tmp/outer-tmux,42,0",
            "TMUX_PANE": "%3",
            "ORKEST_TERMINAL_SERVER": "orkest-label-0123456789ab",
            "TERM": "xterm-256color",
        }
        pid, master = pty.fork()
        if pid == 0:
            termios.tcsetwinsize(0, (30, 120))
            os.execvpe(
                "node",
                [
                    "node",
                    str(SCRIPTS.parents[2] / "bin/ork.mjs"),
                    "label",
                    "--",
                    str(binary),
                    "--model",
                    "fixture-model",
                ],
                environment,
            )
        output = b""
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(master, 65536)
                        if not chunk:
                            break
                        output += chunk
                    except OSError:
                        break
                if info.exists():
                    break
            self.assertTrue(info.exists(), f"Wrapped launch did not write info: {output!r}")
            launched = json.loads(info.read_text())
            self.assertIsNone(launched["tmux"])
            self.assertIsNone(launched["server"])
            self.assertEqual(launched["harness"], "claude")
            self.assertIsNone(launched["agent_hint"])
            self.assertEqual(launched["herdr_pane"], "w1:p1")
            self.assertEqual(launched["args"], ["--model", "fixture-model"])
        finally:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
                time.sleep(0.05)
            else:
                os.kill(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
            os.close(master)

    def test_herdr_launch_preserves_codex_and_antigravity_identity(self):
        for binary_name, harness in (
            ("codex", "codex"),
            ("agy", "gemini"),
        ):
            with self.subTest(harness=harness):
                info = self.home / f"herdr-{binary_name}.json"
                binary = self.home / binary_name
                binary.write_text(
                    "#!" + sys.executable + "\n"
                    "import json, os, sys, time\nfrom pathlib import Path\n"
                    "Path(" + repr(str(info)) + ").write_text(json.dumps({"
                    "'tmux': os.environ.get('TMUX'), "
                    "'server': os.environ.get('ORKEST_TERMINAL_SERVER'), "
                    "'harness': os.environ.get('ORKEST_TERMINAL_HARNESS'), "
                    "'agent_hint': os.environ.get('HERDR_AGENT'), "
                    "'herdr_pane': os.environ.get('HERDR_PANE_ID'), "
                    "'args': sys.argv[1:]"
                    "}))\n"
                    "time.sleep(10)\n"
                )
                binary.chmod(0o755)
                environment = {
                    **self.environment,
                    "PATH": str(self.home) + os.pathsep + os.environ["PATH"],
                    "HERDR_ENV": "1",
                    "HERDR_PANE_ID": "w1:p1",
                    "HERDR_WORKSPACE_ID": "w1",
                    "TERM": "xterm-256color",
                }
                pid, master = pty.fork()
                if pid == 0:
                    termios.tcsetwinsize(0, (30, 120))
                    os.execvpe(
                        "node",
                        ["node", str(SCRIPTS.parents[2] / "bin/ork.mjs"), "label", "--", str(binary)],
                        environment,
                    )
                try:
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline and not info.exists():
                        if select.select([master], [], [], 0.1)[0]:
                            with contextlib.suppress(OSError):
                                os.read(master, 65536)
                    self.assertTrue(info.exists(), f"{binary_name} did not start in the wrapped terminal")
                    launched = json.loads(info.read_text())
                    self.assertIsNone(launched["tmux"])
                    self.assertIsNone(launched["server"])
                    self.assertEqual(launched["harness"], harness)
                    self.assertIsNone(launched["agent_hint"])
                    self.assertEqual(launched["herdr_pane"], "w1:p1")
                    self.assertEqual(
                        launched["args"],
                        ["-c", 'tui.terminal_title=["thread-title","session-id"]'] if harness == "codex" else [],
                    )
                finally:
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if os.waitpid(pid, os.WNOHANG)[0]:
                            break
                        time.sleep(0.05)
                    else:
                        os.kill(pid, signal.SIGTERM)
                        os.waitpid(pid, 0)
                    os.close(master)


if __name__ == "__main__":
    unittest.main()
