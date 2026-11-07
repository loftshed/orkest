"""Herdr labels survive idle time and safely discover shared-daemon Codex panes."""

import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import agent_progress  # noqa: E402
import agent_terminal  # noqa: E402
import herdr_labels  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402

SESSION = "019a5da8-1234-5678-9abc-123456789012"


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        self.base = self.home / "mailbox-v1"
        self.enterContext(
            mock.patch.dict(
                os.environ,
                {
                    "AGENT_EXECUTOR_HOME": str(self.home),
                    "XDG_CONFIG_HOME": str(self.home),
                    "HERDR_BIN_PATH": "/fake/herdr",
                    "ORKEST_TEST_ALLOW_HERDR": "1",
                    "ORK_GLYPHS": "ascii",
                },
                clear=True,
            )
        )
        self.socket = self.home / "herdr/herdr.sock"
        self.socket.parent.mkdir()
        self.socket.touch()
        peer = mailbox.register(self.base, session=SESSION, harness="codex", cwd=str(self.home), pid=os.getpid())
        mailbox.annotate(self.base, SESSION, name="codex-ivory-elk-49")
        agent_progress.report(self.base, peer, goal="Ship labels", stage="working", task="Verify patch")
        self.panes = [
            {
                "pane_id": "w3:p2",
                "workspace_id": "w3",
                "agent": "codex",
                "agent_session": None,
                "terminal_title": "Work | " + SESSION,
            }
        ]
        self.calls = []

        original_run = subprocess.run

        def run(command, **kwargs):
            if command[0] != "/fake/herdr":
                return original_run(command, **kwargs)
            self.calls.append(command[1:])
            result = {"panes": self.panes} if command[1:3] == ["pane", "list"] else {}
            return subprocess.CompletedProcess(command, 0, json.dumps({"result": result}), "")

        self.enterContext(mock.patch.object(agent_terminal.subprocess, "run", side_effect=run))

    def peer(self):
        return mailbox.load(mailbox.peer_path(self.base, SESSION))

    def test_daemon_without_environment_binds_and_reports_once(self):
        self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        self.assertEqual(self.peer()["herdrPaneId"], "w3:p2")
        self.assertEqual(self.peer()["herdrWorkspaceId"], "w3")
        self.assertEqual([call[:2] for call in self.calls], [["pane", "list"], ["pane", "report-metadata"]])
        report = self.calls[-1]
        self.assertEqual(report[report.index("--display-agent") + 1], "[C] codex-ivory-elk-49")
        self.assertEqual(report[report.index("--title") + 1], "working · Verify patch")
        self.assertNotIn("--ttl-ms", report)
        mailbox.annotate(self.base, SESSION, herdrSyncedAt=0)
        self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        self.assertEqual([call[:2] for call in self.calls].count(["pane", "report-metadata"]), 1)

    def test_inherited_daemon_pane_is_not_the_sessions_pane(self):
        with mock.patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1", "HERDR_WORKSPACE_ID": "w1"}):
            self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
            self.assertEqual(self.peer()["herdrPaneId"], "w3:p2")
            self.assertEqual(self.peer()["herdrWorkspaceId"], "w3")
            self.assertEqual([call[:2] for call in self.calls], [["pane", "list"], ["pane", "report-metadata"]])
            self.socket.rename(self.home / "parked.sock")
            count = len(self.calls)
            self.assertFalse(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
            self.assertEqual(len(self.calls), count)
            self.assertIsNone(self.peer()["herdrPaneId"])

    def test_miss_cached_until_session_start_and_stale_binding_cleared(self):
        self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        self.panes = []
        self.assertFalse(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        self.assertIsNone(self.peer()["herdrPaneId"])
        self.assertTrue(self.peer()["herdrDiscoveryMissAt"])
        count = len(self.calls)
        self.assertFalse(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        self.assertEqual(len(self.calls), count)
        self.panes = [{"pane_id": "w2:p4", "workspace_id": "w2", "agent": "codex", "terminal_title": SESSION}]
        self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base, force=True))
        self.assertEqual(self.peer()["herdrWorkspaceId"], "w2")
        self.assertIsNone(self.peer()["herdrDiscoveryMissAt"])

    def test_binding_canonicalizes_stored_endpoints_without_republishing(self):
        self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        alias = self.home / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        alias_socket = str(alias / "herdr/herdr.sock")
        mailbox.annotate(
            self.base,
            SESSION,
            herdrEndpoint=alias_socket,
            herdrSyncedTarget={"endpoint": alias_socket, "pane": "w3:p2"},
        )
        self.calls.clear()
        with mock.patch.dict(os.environ, {"HERDR_SOCKET_PATH": alias_socket}):
            self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        self.assertEqual(self.peer()["herdrEndpoint"], str(self.socket))
        self.assertEqual(self.peer()["herdrSyncedTarget"], {"endpoint": str(self.socket), "pane": "w3:p2"})
        self.assertEqual(self.calls, [["pane", "list"]])

    def test_peer_and_room_lookup_match_endpoint_aliases_in_both_directions(self):
        import agent_statusline_tmux

        alias = self.home / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        alias_socket = str(alias / "herdr/herdr.sock")
        for stored, environment in ((alias_socket, str(self.socket)), (str(self.socket), alias_socket)):
            with self.subTest(stored=stored):
                mailbox.annotate(self.base, SESSION, herdrPaneId="w3:p2", herdrEndpoint=stored)
                mailbox.write(
                    self.base / "rooms/alias-room.json",
                    {"id": "alias-room", "herdrCoordinatorPaneId": "w3:p2", "herdrEndpoint": stored},
                )
                for session in (SESSION, None):
                    peer = agent_statusline_tmux._find_herdr_peer(self.base, session, "w3:p2", endpoint=environment)
                    self.assertEqual(peer["session"], SESSION)
                self.assertEqual(
                    agent_statusline_tmux._find_herdr_room(self.base, "w3:p2", endpoint=environment), "alias-room"
                )
        self.assertIsNone(
            agent_statusline_tmux._find_herdr_peer(self.base, SESSION, "w3:p2", endpoint=str(self.home / "other.sock"))
        )
        self.assertEqual(
            agent_statusline_tmux._find_herdr_room(self.base, "w3:p2", endpoint=str(self.home / "other.sock")), ""
        )

    def test_native_hook_rewrites_an_old_endpoint_alias_to_canonical_form(self):
        alias = self.home / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        alias_socket = str(alias / "herdr/herdr.sock")
        session = "native-gemini"
        mailbox.register(self.base, session=session, harness="gemini", cwd=str(self.home), pid=os.getpid())
        mailbox.annotate(self.base, session, herdrEndpoint=alias_socket)
        occupant = {
            "pane_id": "w1:p1",
            "agent_session": {"agent": "agy", "kind": "id", "value": session},
        }
        with (
            mock.patch.dict(
                os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1", "HERDR_SOCKET_PATH": alias_socket}
            ),
            mock.patch.object(agent_terminal, "verified_agent", return_value=occupant),
            mock.patch.object(mailbox, "harness_pid", return_value=os.getpid()),
        ):
            mailbox.hook({"session_id": session, "cwd": str(self.home)}, harness="gemini", event="Stop", base=self.base)
        peer = mailbox.load(mailbox.peer_path(self.base, session))
        self.assertEqual(peer["herdrEndpoint"], str(self.socket))
        self.assertEqual(peer["herdrSyncedTarget"], {"endpoint": str(self.socket), "pane": "w1:p1"})

    def test_socket_gate_does_not_invoke_herdr_and_clears_old_binding(self):
        self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        self.socket.rename(self.home / "parked.sock")
        count = len(self.calls)
        self.assertFalse(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        self.assertEqual(len(self.calls), count)
        self.assertIsNone(self.peer()["herdrPaneId"])
        self.assertIsNone(self.peer()["herdrEndpoint"])

    def test_duplicate_conflicting_and_non_codex_panes_are_rejected(self):
        for change in ("duplicate", "kind", "session"):
            with self.subTest(change=change):
                pane = {"pane_id": "w3:p2", "workspace_id": "w3", "agent": "codex", "terminal_title": SESSION}
                self.panes = [pane]
                if change == "duplicate":
                    self.panes.append({**pane, "pane_id": "w3:p3"})
                elif change == "kind":
                    pane["agent"] = "claude"
                else:
                    pane["agent_session"] = {"kind": "id", "agent": "codex", "value": "other"}
                self.assertFalse(agent_terminal.bind(SESSION, "codex", {}, base=self.base, force=True))
                self.assertIsNone(self.peer().get("herdrPaneId"))
        self.panes = [{"pane_id": "w2:p2", "agent": "codex", "terminal_title": SESSION}]
        self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base, force=True))
        self.assertEqual(self.peer()["herdrPaneId"], "w2:p2")

    def test_every_harness_reports_identity_and_clear_title_without_ttl(self):
        for harness, icon in (("claude", "[A]"), ("gemini", "[G]"), ("opencode", "[O]")):
            with self.subTest(harness=harness):
                session = "session-" + harness
                mailbox.register(self.base, session=session, harness=harness, cwd=str(self.home), pid=os.getpid())
                mailbox.annotate(self.base, session, name="ivory-elk-49")
                occupant = {
                    "pane_id": "w2:p9",
                    "workspace_id": "w2",
                    "agent_session": {"agent": harness, "kind": "id", "value": session, "source": "herdr:" + harness},
                }
                with (
                    mock.patch.dict(
                        os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1", "HERDR_WORKSPACE_ID": "w1"}
                    ),
                    mock.patch.object(agent_terminal, "verified_agent", return_value=occupant),
                ):
                    self.assertTrue(agent_terminal.bind(session, harness, {}, base=self.base))
                peer = mailbox.load(mailbox.peer_path(self.base, session))
                self.assertEqual((peer["herdrPaneId"], peer["herdrWorkspaceId"]), ("w2:p9", "w2"))
                report = self.calls[-1]
                self.assertEqual(report[report.index("--agent") + 1], harness)
                self.assertEqual(report[report.index("--display-agent") + 1], icon + " ivory-elk-49")
                self.assertIn("--clear-title", report)
                self.assertNotIn("--ttl-ms", report)

    def test_focused_status_checks_live_occupant_and_is_plain(self):
        import herdr_status

        self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        with (
            mock.patch.dict(os.environ, {"HERDR_ACTIVE_PANE_ID": "w3:p2"}),
            mock.patch.object(
                herdr_status.subprocess,
                "run",
                side_effect=lambda *a, **kw: subprocess.CompletedProcess(
                    [], 0, json.dumps({"result": {"pane": self.panes[0]}}), ""
                ),
            ),
        ):
            self.assertEqual(herdr_status.status(), "[C] codex-ivory-elk-49 · working · Verify patch")
            self.panes[0]["agent"] = None
            self.assertEqual(herdr_status.status(), "")

    def test_focused_status_matches_native_herdr_agent_kinds(self):
        import herdr_status

        for harness, kind, source, label in (
            ("claude", "claude", "claude", "[A] ivory-elk-49"),
            ("gemini", "agy", "antigravity_cli", "[G] ivory-elk-49"),
            ("opencode", "opencode", "opencode", "[O] ivory-elk-49"),
        ):
            with self.subTest(harness=harness):
                session = "native-" + harness
                mailbox.register(self.base, session=session, harness=harness, cwd=str(self.home), pid=os.getpid())
                mailbox.annotate(
                    self.base, session, name="ivory-elk-49", herdrPaneId="w1:p1", herdrEndpoint=str(self.socket)
                )
                pane = {
                    "pane_id": "w1:p1",
                    "agent": kind,
                    "agent_session": {"kind": "id", "agent": kind, "source": "herdr:" + source, "value": session},
                }
                with (
                    mock.patch.dict(os.environ, {"HERDR_ACTIVE_PANE_ID": "w1:p1"}),
                    mock.patch.object(
                        herdr_status.subprocess,
                        "run",
                        return_value=subprocess.CompletedProcess([], 0, json.dumps({"result": {"pane": pane}}), ""),
                    ),
                ):
                    self.assertEqual(herdr_status.status(), label)
                    pane["agent_session"]["agent"] = "codex"
                    with mock.patch.object(
                        herdr_status.subprocess,
                        "run",
                        return_value=subprocess.CompletedProcess([], 0, json.dumps({"result": {"pane": pane}}), ""),
                    ):
                        self.assertEqual(herdr_status.status(), "")

    def test_hook_misses_wait_until_next_session_start(self):
        import mailbox_hooks
        import repo_env

        self.panes = []
        payload = {"session_id": SESSION, "cwd": str(self.home)}
        with (
            mock.patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1", "HERDR_WORKSPACE_ID": "w1"}),
            mock.patch.object(mailbox_hooks, "_maybe_trigger_auto_update"),
            mock.patch.object(repo_env, "bootstrap_worktree_env"),
            mock.patch.object(mailbox, "harness_pid", return_value=os.getpid()),
        ):
            mailbox.hook(payload, harness="codex", event="SessionStart", base=self.base)
            self.assertTrue(self.peer()["herdrDiscoveryMissAt"])
            mailbox.hook(payload, harness="codex", event="Stop", base=self.base)
            mailbox.hook(payload, harness="codex", event="UserPromptSubmit", base=self.base)
            self.assertEqual(self.calls, [["pane", "list"]])
            self.assertIsNone(self.peer().get("herdrPaneId"))
            self.panes = [{"pane_id": "w3:p2", "agent": "codex", "terminal_title": SESSION}]
            mailbox.hook(payload, harness="codex", event="SessionStart", base=self.base)
            self.assertEqual(self.peer()["herdrPaneId"], "w3:p2")
            self.assertEqual(
                [call[:2] for call in self.calls], [["pane", "list"], ["pane", "list"], ["pane", "report-metadata"]]
            )
            mailbox.hook(payload, harness="codex", event="Stop", base=self.base)
            self.assertEqual([call[:2] for call in self.calls].count(["pane", "report-metadata"]), 1)

    def test_mid_turn_antigravity_steps_do_not_report(self):
        session = "gemini-session"
        mailbox.register(
            self.base, session=session, harness="gemini", cwd=str(self.home), pid=os.getpid(), state="busy"
        )
        occupant = {
            "pane_id": "w1:p1",
            "agent_session": {"agent": "agy", "source": "herdr:antigravity_cli", "kind": "id", "value": session},
        }
        with (
            mock.patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1"}),
            mock.patch.object(agent_terminal, "verified_agent", return_value=occupant),
            mock.patch.object(mailbox, "harness_pid", return_value=os.getpid()),
        ):
            for _ in range(5):
                mailbox.hook(
                    {"session_id": session, "cwd": str(self.home)},
                    harness="gemini",
                    event="PreInvocation",
                    base=self.base,
                )
            self.assertEqual(self.calls, [])
            mailbox.hook({"session_id": session, "cwd": str(self.home)}, harness="gemini", event="Stop", base=self.base)
        self.assertEqual([call[:2] for call in self.calls], [["pane", "report-metadata"]])
        self.assertEqual(mailbox.load(mailbox.peer_path(self.base, session))["state"], "idle")

    def test_moved_coordinator_updates_room_from_resolved_pane(self):
        import socket

        import room_store

        room = {
            "schema": "agent-executor.room.v1",
            "id": "moved-room",
            "cwd": str(self.home),
            "machine": socket.gethostname(),
            "swarm": {"maxAgents": 4, "maxDepth": 2},
            "conductor": {"engine": "codex", "session": {"id": SESSION}},
            "agents": [],
        }
        mailbox.write(self.base / "rooms/moved-room.json", room)
        self.panes[0].update(pane_id="w2:p9", workspace_id="w2")
        with (
            mock.patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1", "HERDR_WORKSPACE_ID": "w1"}),
            mock.patch.object(
                agent_terminal, "_resolve_structural_role", return_value=("moved-room", "Coordinator", True)
            ),
        ):
            self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
            self.assertTrue(agent_terminal.bind(SESSION, "codex", {}, base=self.base))
        stored = room_store.read_room(self.base, "moved-room")
        self.assertEqual((stored["herdrCoordinatorPaneId"], stored["herdrWorkspaceId"]), ("w2:p9", "w2"))
        self.assertEqual((self.peer()["herdrPaneId"], self.peer()["herdrWorkspaceId"]), ("w2:p9", "w2"))
        self.assertEqual(
            [call[:2] for call in self.calls], [["pane", "list"], ["pane", "report-metadata"], ["pane", "list"]]
        )

    def test_native_labels_yield_to_herdr_for_all_native_adapters(self):
        import agent_statusline

        for harness in ("claude", "gemini", "opencode"):
            session = "native-" + harness
            mailbox.register(self.base, session=session, harness=harness, cwd=str(self.home), pid=os.getpid())
            mailbox.annotate(self.base, session, name="snorfle-test-high-footer-aa", person="snorfle")
            argv = ["agent_statusline.py", "--native-status", "--session", session, "--harness", harness, "--plain"]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1"}),
                mock.patch.object(sys, "stdout", io.StringIO()) as output,
            ):
                self.assertEqual(agent_statusline.main(), 0)
                self.assertEqual(output.getvalue(), "")
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.dict(os.environ, {"HERDR_ENV": "0"}),
                mock.patch.object(sys, "stdout", io.StringIO()) as output,
            ):
                self.assertEqual(agent_statusline.main(), 0)
                self.assertTrue(output.getvalue().startswith("snorfle | "), output.getvalue())


class LabelTests(unittest.TestCase):
    def test_full_and_truncated_session_titles_strip_controls_and_reject_spoofs(self):
        for suffix in (SESSION, SESSION[:29] + "...", SESSION[:29] + "…"):
            self.assertEqual(
                herdr_labels.codex_title_session("thread | nested | \x1b[32m" + suffix + "\x1b[0m\x00", {SESSION}),
                SESSION,
            )
        for title in (SESSION + " | other", SESSION[:28] + "...", "x" + SESSION):
            self.assertIsNone(herdr_labels.codex_title_session(title, {SESSION}))
        collision = SESSION[:29] + "0000000"
        self.assertIsNone(herdr_labels.codex_title_session(SESSION[:29] + "...", {SESSION, collision}))
        self.assertEqual(herdr_labels.codex_title_session(SESSION, {SESSION, collision}), SESSION)

    def test_glyphs_and_limits_preserve_suffix(self):
        for tier, icon in (("nerd", ""), ("unicode", "⚙"), ("ascii", "[C]")):
            with mock.patch.dict(os.environ, {"ORK_GLYPHS": tier}):
                self.assertEqual(
                    herdr_labels.display_label({"harness": "codex", "name": "ivory-elk-49"}), icon + " ivory-elk-49"
                )
                label = herdr_labels.display_label({"harness": "codex", "name": "long-" * 30 + "elk-49"})
                self.assertEqual(len(label), 80)
                self.assertTrue(label.endswith("…k-49"))
        title = herdr_labels.work_title({"stage": "working", "task": "task-" * 30 + "end9"})
        self.assertEqual(len(title), 80)
        self.assertTrue(title.endswith("…end9"))


class StatusCommandTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        self.base = self.home / "mailbox-v1"
        self.binary = self.home / "herdr"
        # Keep the fake's startup independent of Python's import costs within the 100 ms lookup budget.
        self.binary.write_text(
            '#!/bin/sh\nif [ -n "${FAKE_DELAY:-}" ]; then sleep "$FAKE_DELAY"; fi\n'
            'printf \'{"result":{"pane":%s}}\\n\' "$FAKE_PANE"\n'
        )
        self.binary.chmod(0o755)
        self.env = {
            **os.environ,
            "AGENT_EXECUTOR_HOME": str(self.home),
            "HERDR_BIN_PATH": str(self.binary),
            "HERDR_ACTIVE_PANE_ID": "w3:p2",
            "HERDR_SOCKET_PATH": str(self.home / "fake.sock"),
            "ORK_GLYPHS": "nerd",
            "FAKE_PANE": json.dumps({"pane_id": "w3:p2", "agent": "codex", "terminal_title": SESSION}),
        }
        self.enterContext(mock.patch.dict(os.environ, self.env, clear=True))
        peer = mailbox.register(self.base, session=SESSION, harness="codex", cwd=str(self.home), pid=os.getpid())
        mailbox.annotate(
            self.base,
            SESSION,
            name="codex-ivory-elk-49",
            herdrPaneId="w3:p2",
            herdrEndpoint=str(self.home / "fake.sock"),
        )
        agent_progress.report(self.base, peer, goal="Ship labels", task="Verify patch", stage="working")

    def run_status(self, **extra):
        result = subprocess.run(
            ["node", str(SCRIPTS.parents[2] / "bin/ork.mjs"), "herdr-status"],
            env={**self.env, **extra},
            capture_output=True,
            text=True,
            timeout=2,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_cli_returns_plain_identity_or_empty(self):
        self.assertEqual(self.run_status(), " codex-ivory-elk-49 · working · Verify patch\n")
        self.assertEqual(self.run_status(FAKE_PANE='{"pane_id":"w3:p2","agent":null}'), "\n")
        self.assertEqual(
            self.run_status(FAKE_PANE='{"pane_id":"w3:p2","agent":"codex","terminal_title":"other"}'), "\n"
        )

    def test_cli_matches_stored_and_environment_endpoint_aliases_in_both_directions(self):
        alias = self.home / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        canonical_socket = str(self.home / "fake.sock")
        alias_socket = str(alias / "fake.sock")
        for stored, environment in ((alias_socket, canonical_socket), (canonical_socket, alias_socket)):
            with self.subTest(stored=stored):
                mailbox.annotate(self.base, SESSION, herdrEndpoint=stored)
                self.assertEqual(
                    self.run_status(HERDR_SOCKET_PATH=environment),
                    " codex-ivory-elk-49 · working · Verify patch\n",
                )
        self.assertEqual(self.run_status(HERDR_SOCKET_PATH=str(self.home / "other.sock")), "\n")

    def test_cli_success_and_timed_out_lookup_stay_within_budget(self):
        for extra, expected in (
            ({}, " codex-ivory-elk-49 · working · Verify patch\n"),
            ({"FAKE_DELAY": "1"}, "\n"),
        ):
            with self.subTest(extra=extra):
                start = time.monotonic()
                self.assertEqual(self.run_status(**extra), expected)
                self.assertLess(time.monotonic() - start, 0.3)


class SymlinkedTempStatusCommandTests(StatusCommandTests):
    """macOS temporary roots commonly use /var, a symlink to /private/var."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        alias = root / "alias"
        alias.symlink_to(root, target_is_directory=True)
        self.enterContext(mock.patch.object(tempfile, "tempdir", str(alias)))
        super().setUp()
