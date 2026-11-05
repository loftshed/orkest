"""Herdr cold restore preserves display placement without treating arbitrary panes as owned."""

import json
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import herdr_swarm_restore as views  # noqa: E402


class FakeHerdr:
    def __init__(self, cli):
        self.cli = cli
        self.pane = {"pane_id": "w1:p2", "terminal_id": "new-terminal", "label": None}
        self.info = {
            "shell_pid": 100,
            "foreground_process_group_id": 100,
            "foreground_processes": [{"pid": 100, "name": "zsh", "argv": ["zsh"]}],
        }
        self.runs = []
        self.start = True

    def call(self, *args):
        if args[:2] == ("pane", "rename"):
            self.pane["label"] = args[3]
        elif args[:2] == ("pane", "run"):
            self.runs.append(args)
            if self.start:
                self.info["foreground_processes"] = [{"pid": 200, "name": "node", "argv": shlex.split(args[3])[2:]}]
        else:
            raise AssertionError(args)
        return {}

    def panes(self):
        return [self.pane] if self.pane else []

    def processes(self, _pane):
        return self.info


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.cli = self.base / "bin/ork.mjs"
        self.cli.parent.mkdir()
        self.cli.touch()
        self.env = {"HERDR_ENV": "1", "HERDR_SOCKET_PATH": str(self.base / "server.sock")}
        self.api = FakeHerdr(self.cli)
        self.state = views.prepare(self.base, "room-a", "w1:p2", self.cli, self.env, self.api)

    def test_empty_successful_cli_output_is_command_admission(self):
        api = views.Herdr("herdr", self.env)
        with mock.patch.object(views.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")):
            self.assertEqual(api.call("pane", "run", "w1:p2", "node view.mjs"), {})

    def test_snapshot_agents_are_not_counted_as_additional_panes(self):
        api = views.Herdr("herdr", self.env)
        snapshot = {"snapshot": {"panes": [self.api.pane], "agents": [self.api.pane]}}
        with mock.patch.object(api, "call", return_value=snapshot):
            self.assertEqual(api.panes(), [self.api.pane])

    def test_confirmation_error_remains_an_unconfirmed_launch(self):
        original = self.api.processes

        def inspect(pane):
            if self.api.runs:
                raise RuntimeError("temporary inspection failure")
            return original(pane)

        with mock.patch.object(self.api, "processes", side_effect=inspect):
            self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "launch_unknown")
        self.assertTrue(self.state.with_suffix(".pending").exists())

    def test_new_explicit_open_resets_previous_unconfirmed_launch(self):
        self.state.with_suffix(".pending").write_text(json.dumps({"shell_pid": 100}))
        self.state.with_suffix(".closed").touch()
        views.prepare(self.base, "room-a", "w1:p2", self.cli, self.env, self.api)
        self.assertFalse(self.state.with_suffix(".pending").exists())
        self.assertFalse(self.state.with_suffix(".closed").exists())
        self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "restored")

    def test_cold_restore_finds_label_after_pane_ids_change_and_is_idempotent(self):
        self.api.pane["pane_id"] = "w7:p9"
        self.assertEqual(views.restore(self.base, self.env, self.api), [{"room": "room-a", "status": "restored"}])
        self.assertEqual(self.api.runs[0][2], "w7:p9")
        self.assertEqual(
            views.restore(self.base, self.env, self.api), [{"room": "room-a", "status": "already_running"}]
        )
        self.assertEqual(len(self.api.runs), 1)

    def test_missing_busy_renamed_and_closed_panes_are_not_recreated(self):
        self.state.with_suffix(".closed").touch()
        self.assertEqual(views.restore(self.base, self.env, self.api), [])
        self.state.with_suffix(".closed").unlink()
        self.api.pane["label"] = "User terminal"
        self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "missing_pane")
        self.api.pane["label"] = views.load(self.state)["label"]
        self.api.info["foreground_processes"].append({"pid": 300, "name": "editor"})
        self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "busy_or_unknown")
        self.api.pane = None
        self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "missing_pane")
        self.assertEqual(self.api.runs, [])

    def test_handoff_keeps_a_running_view_and_other_servers_are_ignored(self):
        self.api.info["foreground_processes"] = [
            {
                "pid": 200,
                "name": "node",
                "argv": [
                    "node",
                    str(self.cli),
                    "horde",
                    "--attach-room",
                    "room-a",
                    "--view",
                ],
            }
        ]
        self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "already_running")
        self.assertEqual(
            views.restore(self.base, {**self.env, "HERDR_SOCKET_PATH": "/other/server.sock"}, self.api), []
        )
        self.assertEqual(self.api.runs, [])

    def test_admitted_input_is_not_claimed_as_started_or_submitted_twice(self):
        self.api.start = False
        with mock.patch.object(views.time, "monotonic", side_effect=[0, 4]):
            self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "submitted")
        self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "launch_pending")
        self.assertEqual(len(self.api.runs), 1)

    def test_upgrade_adopts_only_proven_legacy_views(self):
        self.state.unlink()
        rooms = self.base / "mailbox-v1/rooms"
        rooms.mkdir(parents=True)
        (rooms / "room-a.json").write_text(json.dumps({"id": "room-a", "herdrViewPaneId": "w1:p2"}))
        self.assertEqual(views.adopt(self.base, self.env, self.api, self.cli), [])
        self.api.info["foreground_processes"] = [
            {
                "pid": 200,
                "name": "node",
                "argv": [
                    "node",
                    str(self.cli),
                    "horde",
                    "--attach-room",
                    "room-a",
                    "--view",
                ],
            }
        ]
        self.assertEqual(
            views.adopt(self.base, self.env, self.api, self.cli), [{"room": "room-a", "status": "adopted"}]
        )
        self.assertEqual(views.adopt(self.base, self.env, self.api, self.cli), [])


if __name__ == "__main__":
    unittest.main()
