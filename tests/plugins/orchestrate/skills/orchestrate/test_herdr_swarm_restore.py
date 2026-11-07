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
            self.pane["label"] = args[3].strip()
        elif args[:2] == ("pane", "run"):
            self.runs.append(args)
            if self.start:
                self.info["foreground_processes"] = [{"pid": 200, "name": "node", "argv": shlex.split(args[3])[4:]}]
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

    def test_native_plugin_process_is_not_an_idle_shell(self):
        self.api.info["foreground_processes"] = [{"pid": 100, "name": "node"}]
        self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "busy_or_unknown")
        self.assertEqual(self.api.runs, [])

    def test_two_rooms_with_the_same_label_cannot_claim_one_recreated_pane(self):
        record = views.load(self.state)
        second = views.state_path(self.base, "room-b", self.env)
        views.save(second, {**record, "room": "room-b", "pane": "w2:p4", "terminal_id": "second"})
        self.api.pane["terminal_id"] = "recreated"
        results = views.restore(self.base, self.env, self.api, allow_recreated=True)
        self.assertEqual([outcome["status"] for outcome in results], ["missing_pane", "missing_pane"])
        self.assertEqual(self.api.runs, [])

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

    def test_cold_restore_rebinds_a_recreated_terminal_but_ordinary_lookup_does_not(self):
        self.api.pane.update({"pane_id": "w7:p9", "terminal_id": "recreated-terminal"})
        self.assertIsNone(views.locate(views.load(self.state), self.api.panes()))
        self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "missing_pane")
        self.assertEqual(views.restore(self.base, self.env, self.api, allow_recreated=True)[0]["status"], "restored")
        self.assertEqual(views.load(self.state)["terminal_id"], "recreated-terminal")
        self.assertEqual(views.locate(views.load(self.state), self.api.panes())["pane_id"], "w7:p9")

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
        (rooms / "room-a.json").write_text(
            json.dumps({"id": "room-a", "herdrViewPaneId": "w1:p2", "herdrEndpoint": "/other/server.sock"})
        )
        self.assertEqual(views.adopt(self.base, self.env, self.api, self.cli), [])
        (rooms / "room-a.json").write_text(
            json.dumps({"id": "room-a", "herdrViewPaneId": "w1:p2", "herdrEndpoint": views.endpoint(self.env)})
        )
        self.assertEqual(
            views.adopt(self.base, self.env, self.api, self.cli), [{"room": "room-a", "status": "adopted"}]
        )
        self.assertEqual(views.adopt(self.base, self.env, self.api, self.cli), [])

    def test_prepare_uses_room_title_label_and_disambiguates_duplicate_labels_by_terminal_id(self):
        rooms = self.base / "mailbox-v1/rooms"
        rooms.mkdir(parents=True, exist_ok=True)
        (rooms / "room-a.json").write_text(
            json.dumps({"id": "room-a", "title": "Refine Orkest coordinator delegation"})
        )
        views.prepare(self.base, "room-a", "w1:p2", self.cli, self.env, self.api)
        record = views.load(self.state)
        self.assertEqual(record["label"], "Swarm · Refine Orkest coordinator delegation")
        self.assertEqual(record["terminal_id"], "new-terminal")
        self.assertEqual(self.api.pane["label"], "Swarm · Refine Orkest coordinator delegation")
        duplicate_panes = [
            {
                "pane_id": "w1:p9",
                "terminal_id": "other-terminal",
                "label": "Swarm · Refine Orkest coordinator delegation",
            },
            {
                "pane_id": "w7:p9",
                "terminal_id": "new-terminal",
                "label": "Swarm · Refine Orkest coordinator delegation",
            },
        ]
        self.assertEqual(views.locate(record, duplicate_panes)["pane_id"], "w7:p9")
        self.assertIsNone(views.locate(record, [duplicate_panes[0]]))
        duplicate_panes[1].update(pane_id=record["pane"], terminal_id="recreated")
        self.assertIsNone(views.locate(record, duplicate_panes, allow_recreated=True))

    def test_prepare_and_locate_handle_72_char_space_boundary_and_legacy_trailing_spaces(self):
        rooms = self.base / "mailbox-v1/rooms"
        rooms.mkdir(parents=True, exist_ok=True)
        title = "Toggle compact usage meters (5h/weekly), add rich color differentiation to Orchestrator header"
        self.assertEqual(title[71], " ")
        (rooms / "room-a.json").write_text(json.dumps({"id": "room-a", "title": title}))
        views.prepare(self.base, "room-a", "w1:p2", self.cli, self.env, self.api)
        record = views.load(self.state)
        self.assertFalse(record["label"].endswith(" "))
        self.assertEqual(views.restore(self.base, self.env, self.api), [{"room": "room-a", "status": "restored"}])
        legacy_record = {**record, "label": f"{record['label']} "}
        self.assertEqual(views.locate(legacy_record, self.api.panes())["pane_id"], "w1:p2")

    def test_inventory_reconciles_five_dimensions_without_mutating_or_calling_restore(self):
        rooms = self.base / "mailbox-v1/rooms"
        peers = self.base / "mailbox-v1/peers"
        rooms.mkdir(parents=True, exist_ok=True)
        peers.mkdir(parents=True, exist_ok=True)
        (rooms / "room-a.json").write_text(
            json.dumps(
                {
                    "id": "room-a",
                    "title": "Audit Herdr Inventory",
                    "cwd": str(self.base),
                    "herdrEndpoint": views.endpoint(self.env),
                    "herdrCoordinatorPaneId": "w1:p1",
                    "herdrViewPaneId": "w1:p2",
                    "conductor": {
                        "engine": "codex",
                        "role": "lead",
                        "status": "running",
                        "session": {"id": "coord-session-1", "engine": "codex", "cwd": str(self.base)},
                    },
                    "agents": [
                        {
                            "id": "worker-1",
                            "engine": "claude",
                            "role": "worker",
                            "status": "completed",
                            "session": {"id": "worker-session-1", "engine": "claude", "cwd": str(self.base)},
                        }
                    ],
                }
            )
        )
        (peers / "coord-session-1.json").write_text(
            json.dumps(
                {
                    "schema": "orchestrate.peer.v1",
                    "session": "coord-session-1",
                    "harness": "codex",
                    "state": "busy",
                    "herdrPaneId": "w1:p1",
                    "herdrEndpoint": views.endpoint(self.env),
                }
            )
        )
        views.prepare(self.base, "room-a", "w1:p2", self.cli, self.env, self.api)
        coord_pane = {
            "pane_id": "w1:p1",
            "terminal_id": "coord-term",
            "label": "snorfle · working",
            "agent_session": {"kind": "id", "value": "coord-session-1", "agent": "codex"},
        }
        with mock.patch.object(self.api, "panes", return_value=[coord_pane, self.api.pane]):
            report = views.inventory(self.base, self.env, self.api, cli=self.cli)
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["mode"], "read_only")
        self.assertEqual(self.api.runs, [])

        by_kind = {(item["kind"], item.get("member")): item for item in report["resources"]}
        view_item = by_kind[("swarm_view", None)]
        self.assertTrue(view_item["retained_idle_shell"])
        self.assertEqual(view_item["matching_strength"], "terminal_id")
        self.assertEqual(
            view_item["dimensions"],
            {
                "pane_existence": "present",
                "available_shell": "idle_shell",
                "live_agent_conversation": "none",
                "executing_worker": "none",
                "accepted_task": "untracked",
            },
        )

        coord_item = by_kind[("room_member", "conductor")]
        self.assertEqual(
            coord_item["dimensions"],
            {
                "pane_existence": "present",
                "available_shell": "idle_shell",
                "live_agent_conversation": "verified_in_pane",
                "executing_worker": "executing",
                "accepted_task": "in_progress",
            },
        )

        worker_item = by_kind[("room_member", "worker-1")]
        self.assertEqual(
            worker_item["dimensions"],
            {
                "pane_existence": "not_bound",
                "available_shell": "unavailable",
                "live_agent_conversation": "none",
                "executing_worker": "finished",
                "accepted_task": "accepted",
            },
        )


if __name__ == "__main__":
    unittest.main()
