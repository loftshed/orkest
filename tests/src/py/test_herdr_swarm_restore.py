"""Herdr cold restore preserves display placement without treating arbitrary panes as owned."""

import datetime
import json
import os
import shlex
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[3] / "src/py"
sys.path.insert(0, str(SCRIPTS))
import herdr_swarm_restore as views  # noqa: E402
import orca_context  # noqa: E402
import orca_swarm_restore  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402
import room_store  # noqa: E402

PANE_CLOSED_SCRIPT = "src/py/herdr_swarm_restore.py"


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

    def _second_view_in_tab(self):
        """Save a second room's view in another pane of the first view's tab, with per-pane processes."""
        record = views.load(self.state)
        second = views.state_path(self.base, "room-b", self.env)
        other = {
            "pane_id": "w1:p3",
            "terminal_id": "second",
            "label": "Swarm · Other work",
            "tab_id": "t1",
            "workspace_id": "w1",
        }
        views.save(
            second, {**record, "room": "room-b", "pane": "w1:p3", "terminal_id": "second", "label": other["label"]}
        )
        self.api.pane.update(tab_id="t1", workspace_id="w1")
        idle = self.api.info
        processes = {"w1:p2": json.loads(json.dumps(idle)), "w1:p3": json.loads(json.dumps(idle))}

        def call(*args):
            if args[:2] == ("pane", "run"):
                self.api.runs.append(args)
                argv = shlex.split(args[3])[4:]
                processes[args[2]]["foreground_processes"] = [{"pid": 200, "name": "node", "argv": argv}]
                return {}
            return FakeHerdr.call(self.api, *args)

        self.enterContext(mock.patch.object(self.api, "panes", return_value=[self.api.pane, other]))
        self.enterContext(mock.patch.object(self.api, "processes", side_effect=processes.__getitem__))
        self.enterContext(mock.patch.object(self.api, "call", side_effect=call))
        return other, processes

    def test_saved_views_sharing_a_tab_each_restore_into_their_own_pane(self):
        # Two coordinators in one tab each had a view before an upgrade. After a Herdr restart both
        # panes come back as idle shells; restoring into its own pane adds no pane, so neither blocks.
        self._second_view_in_tab()
        outcomes = views.restore(self.base, self.env, self.api)
        self.assertEqual(
            sorted(outcomes, key=lambda outcome: outcome["room"]),
            [{"room": "room-a", "status": "restored"}, {"room": "room-b", "status": "restored"}],
        )
        self.assertEqual(sorted(run[2] for run in self.api.runs), ["w1:p2", "w1:p3"])

    def test_only_a_running_view_occupies_a_tab_for_a_new_split(self):
        other, processes = self._second_view_in_tab()
        tab = views.tab_swarm_views(self.base, self.env, self.api, self.api.pane, [self.api.pane, other], self.cli)
        self.assertEqual(tab, {})
        processes["w1:p3"]["foreground_processes"] = [
            {"pid": 300, "name": "node", "argv": ["node", str(self.cli), "horde", "--attach-room", "room-b", "--view"]}
        ]
        tab = views.tab_swarm_views(self.base, self.env, self.api, self.api.pane, [self.api.pane, other], self.cli)
        self.assertEqual(tab, {"w1:p3": "room-b"})
        message = str(views.TabOccupied(set(tab.values())))
        self.assertIn("room room-b", message)
        self.assertIn("`ork swarm close --room room-b`", message)

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

    def test_restore_matches_aliased_endpoints_and_stores_canonical_path_after_move(self):
        alias = self.base / "alias"
        alias.symlink_to(self.base.resolve(), target_is_directory=True)
        alias_socket = str(alias / "server.sock")
        canonical_socket = str((self.base / "server.sock").resolve())
        for stored, environment in ((alias_socket, canonical_socket), (canonical_socket, alias_socket)):
            with self.subTest(stored=stored):
                record = views.load(self.state)
                views.save(self.state, {**record, "endpoint": stored, "pane": "old-pane"})
                outcomes = views.restore(self.base, {**self.env, "HERDR_SOCKET_PATH": environment}, self.api)
                self.assertEqual(outcomes[0]["room"], "room-a")
                self.assertIn(outcomes[0]["status"], ("restored", "already_running"))
                self.assertEqual(views.load(self.state)["endpoint"], canonical_socket)

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

    def _pane_closed_env(self, pane):
        payload = {"event": "pane_closed", "data": {"type": "pane_closed", "pane_id": pane, "workspace_id": "w1"}}
        return {
            **self.env,
            "HERDR_PLUGIN_ID": "orkest.swarms",
            "HERDR_PLUGIN_EVENT": "pane.closed",
            "HERDR_PLUGIN_EVENT_JSON": json.dumps(payload),
        }

    def test_closing_the_view_pane_in_herdr_keeps_it_closed(self):
        # The close_pane keybinding or `herdr pane close`: Herdr emits pane.closed after removing the pane.
        env = self._pane_closed_env("w1:p2")
        self.assertEqual(views.closed_pane_id(env), "w1:p2")
        self.api.pane = None
        self.assertEqual(
            views.record_pane_closed(self.base, env, self.api, "w1:p2"), [{"room": "room-a", "status": "closed"}]
        )
        self.assertTrue(self.state.with_suffix(".closed").exists())
        self.assertFalse(views.saved_open(self.state, "room-a", self.env))
        self.assertEqual(
            views.record_pane_closed(self.base, env, self.api, "w1:p2"),
            [{"room": "room-a", "status": "already_closed"}],
        )
        # The pane coming back later (a recreated label match on cold start) is not restored either.
        self.api.pane = {"pane_id": "w1:p2", "terminal_id": "other", "label": views.load(self.state)["label"]}
        self.assertEqual(views.restore(self.base, self.env, self.api, allow_recreated=True), [])
        self.assertEqual(self.api.runs, [])

    def test_herdr_restart_or_crash_without_pane_closed_keeps_the_saved_view(self):
        # A server stop, restart or crash emits no pane.closed; the pane comes back for session restore.
        self.assertIsNone(views.closed_pane_id(self.env))
        self.assertIsNone(views.closed_pane_id({**self.env, "HERDR_PLUGIN_EVENT": "startup"}))
        self.assertIsNone(views.closed_pane_id({**self._pane_closed_env("w1:p2"), "HERDR_PLUGIN_EVENT_JSON": "{"}))
        self.api.pane["label"] = views.load(self.state)["label"]
        self.assertEqual(views.restore(self.base, self.env, self.api)[0]["status"], "restored")
        self.assertFalse(self.state.with_suffix(".closed").exists())

    def test_pane_closed_only_marks_a_verified_closed_view_pane(self):
        # Another pane closing is not this view closing.
        self.assertEqual(views.record_pane_closed(self.base, self.env, self.api, "w1:p7"), [])
        # Still in the live snapshot: not closed.
        self.assertEqual(
            views.record_pane_closed(self.base, self.env, self.api, "w1:p2"),
            [{"room": "room-a", "status": "still_open"}],
        )
        # A server that cannot answer is going away; never a user close.
        with mock.patch.object(self.api, "panes", side_effect=RuntimeError("Herdr api snapshot failed")):
            self.assertEqual(
                views.record_pane_closed(self.base, self.env, self.api, "w1:p2"),
                [{"room": "room-a", "status": "unverified"}],
            )
        # A record for another Herdr server with the same pane ID is not touched.
        self.api.pane = None
        other = {**self.env, "HERDR_SOCKET_PATH": str(self.base / "other.sock")}
        self.assertEqual(views.record_pane_closed(self.base, other, self.api, "w1:p2"), [])
        self.assertFalse(self.state.with_suffix(".closed").exists())
        self.assertTrue(views.saved_open(self.state, "room-a", self.env))

    def test_pane_closed_hook_runs_from_the_plugin_manifest(self):
        import tomllib

        manifest = tomllib.loads((SCRIPTS.parents[1] / "herdr-plugin.toml").read_text())
        hooks = [hook for hook in manifest.get("events", []) if hook.get("on") == "pane.closed"]
        self.assertEqual(hooks, [{"on": "pane.closed", "command": ["python3", PANE_CLOSED_SCRIPT, "--pane-closed"]}])
        # Run the manifest command the way Herdr does: cwd is the plugin root, the event rides in the env.
        herdr = self.base / "herdr"
        herdr.write_text(
            "#!" + sys.executable + "\nimport json, sys\n"
            "assert sys.argv[1:] == ['api', 'snapshot'], sys.argv\n"
            "print(json.dumps({'result': {'snapshot': {'panes': [{'pane_id': 'w1:p1'}]}}}))\n"
        )
        herdr.chmod(0o755)
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(self.base),
            "ORCHESTRATE_HOME": str(self.base),
            "HERDR_ENV": "1",
            "HERDR_BIN_PATH": str(herdr),
            **self._pane_closed_env("w1:p2"),
        }
        command = [sys.executable if part == "python3" else part for part in hooks[0]["command"]]
        result = subprocess.run(
            command, cwd=SCRIPTS.parents[1], env=env, capture_output=True, text=True, timeout=30, check=True
        )
        self.assertEqual(json.loads(result.stdout)["views"], [{"room": "room-a", "status": "closed"}])
        self.assertTrue(self.state.with_suffix(".closed").exists())

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
        alias = self.base / "alias"
        alias.symlink_to(self.base.resolve(), target_is_directory=True)
        alias_socket = str(alias / "server.sock")
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
                    "herdrEndpoint": alias_socket,
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
                    "herdrEndpoint": alias_socket,
                }
            )
        )
        views.prepare(self.base, "room-a", "w1:p2", self.cli, self.env, self.api)
        views.save(self.state, {**views.load(self.state), "endpoint": alias_socket})
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
                "accepted_task": "awaiting_verification",
            },
        )

    def test_plain_view_record_and_command_stay_free_of_chief_mode(self):
        self.assertNotIn("chief", views.load(self.state))
        words = shlex.split(views.command(self.cli, "room-a", self.state, self.base, self.env))
        self.assertNotIn("ORKEST_CHIEF_VIEW=1", words)
        self.assertEqual(words[-4:], ["horde", "--attach-room", "room-a", "--view"])

    def test_chief_view_restores_in_chief_mode_with_the_exact_view_argv(self):
        views.prepare(self.base, "room-a", "w1:p2", self.cli, self.env, self.api, chief=True)
        self.assertIs(views.load(self.state)["chief"], True)
        self.api.start = False
        views.restore(self.base, self.env, self.api)
        words = shlex.split(self.api.runs[0][3])
        self.assertIn("ORKEST_CHIEF_VIEW=1", words[:5])
        self.assertEqual(words[-4:], ["horde", "--attach-room", "room-a", "--view"])
        node = words.index("ORKEST_CHIEF_VIEW=1") + 1
        info = {"foreground_processes": [{"pid": 200, "name": "node", "argv": words[node:]}]}
        self.assertTrue(views.view_process(info, self.cli, "room-a"))


class ChiefSessionTests(unittest.TestCase):
    def setUp(self):
        import agent_statusline_tmux

        self.tmux = agent_statusline_tmux
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def write(self, data):
        (self.base / "chief.json").write_text(json.dumps(data))

    def test_live_chief_json_identifies_the_chief_session(self):
        self.assertIsNone(self.tmux._chief_session(self.base))
        self.write({"schema": "ork.chief.v1", "session": "chief-1", "pid": os.getpid()})
        self.assertEqual(self.tmux._chief_session(self.base), "chief-1")
        self.assertTrue(self.tmux._is_chief_session(self.base, "chief-1"))
        self.assertFalse(self.tmux._is_chief_session(self.base, "someone-else"))
        self.assertFalse(self.tmux._is_chief_session(self.base, None))

    def test_dead_or_malformed_chief_json_is_ignored(self):
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        self.write({"schema": "ork.chief.v1", "session": "chief-1", "pid": dead.pid})
        self.assertIsNone(self.tmux._chief_session(self.base))
        (self.base / "chief.json").write_text("{not json")
        self.assertIsNone(self.tmux._chief_session(self.base))
        self.write({"session": "   "})
        self.assertIsNone(self.tmux._chief_session(self.base))

    def test_chief_session_validates_machine_pid_birth_and_bound_at_grace(self):
        # Foreign machine is never treated as local Chief.
        self.write(
            {
                "schema": "ork.chief.v1",
                "session": "chief-remote",
                "machine": "remote-host-other",
                "pid": os.getpid(),
            }
        )
        self.assertIsNone(self.tmux._chief_session(self.base))

        # Recycled PID (mismatched pidBirth) with no live peer is rejected.
        self.write(
            {
                "schema": "ork.chief.v1",
                "session": "chief-recycled",
                "machine": socket.gethostname(),
                "pid": os.getpid(),
                "pidBirth": "1999-01-01T00:00:00Z",
            }
        )
        self.assertIsNone(self.tmux._chief_session(self.base))

        # Unverified binding without PID/peer is trusted within 10m boundAt grace, rejected after.
        now = datetime.datetime.now(datetime.UTC)
        self.write(
            {
                "schema": "ork.chief.v1",
                "session": "chief-fresh",
                "boundAt": (now - datetime.timedelta(seconds=60)).isoformat().replace("+00:00", "Z"),
            }
        )
        self.assertEqual(self.tmux._chief_session(self.base), "chief-fresh")
        self.write(
            {
                "schema": "ork.chief.v1",
                "session": "chief-expired",
                "boundAt": (now - datetime.timedelta(minutes=20)).isoformat().replace("+00:00", "Z"),
            }
        )
        self.assertIsNone(self.tmux._chief_session(self.base))


class OrcaSwarmRestoreHardeningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.base = self.home / "mailbox-v1"
        self.base.mkdir(parents=True, exist_ok=True)

    def test_automatic_orca_open_requires_saved_open_intent(self):
        env = {"ORCA_PANE_KEY": "pane-1", "ORCA_TERMINAL_HANDLE": "term_coord"}
        state = orca_context.view_path("room-1", self.home)
        record = {"schema": orca_context.VIEW_SCHEMA, "room": "room-1", "environment": "", "terminalId": "term_view"}

        def run(command, **_kwargs):
            self.assertEqual(command[2], "list")
            return subprocess.CompletedProcess(
                command, 0, stdout=json.dumps({"result": {"terminals": [{"handle": "term_view"}]}}), stderr=""
            )

        def restore():
            return orca_swarm_restore.toggle(
                "open", base=self.base, room="room-1", respect_closed=True, env=env, run=run
            )

        with mock.patch.object(orca_context, "resolve_cli", return_value="/opt/orca/orca-ide"):
            self.assertEqual(restore()["status"], "already_closed")
            orca_context.save(state, {**record, "closed": True})
            self.assertEqual(restore()["status"], "already_closed")
            orca_context.save(state, {**record, "closed": False})
            opened = restore()
            self.assertEqual((opened["status"], opened["pane"]), ("already_open", "term_view"))

    def test_view_command_and_chief_toggle_without_room(self):
        cmd_room = orca_swarm_restore.view_command("room-1", self.home / "state.json", chief=False)
        self.assertIn("--attach-room room-1 --view", cmd_room)
        self.assertNotIn("ORKEST_CHIEF_VIEW=1", cmd_room)

        cmd_chief = orca_swarm_restore.view_command("", self.home / "chief.json", chief=True)
        self.assertIn("ORKEST_CHIEF_VIEW=1", cmd_chief)
        self.assertIn("--view --chief", cmd_chief)
        self.assertNotIn("--attach-room", cmd_chief)

        live = {"term_coord"}

        def run(command, **kwargs):
            verb = command[2]
            if verb == "list":
                result = {"terminals": [{"handle": h} for h in sorted(live)]}
            elif verb == "split":
                live.add("term_chief_view")
                result = {"split": {"handle": "term_chief_view"}}
            elif verb == "close":
                live.discard(command[command.index("--terminal") + 1])
                result = {"close": {"handle": "term_chief_view"}}
            else:
                result = {}
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps({"result": result}), stderr="")

        env = {
            **os.environ,
            "HOME": str(self.home),
            "ORCHESTRATE_HOME": str(self.home),
            "ORCA_PANE_KEY": "pane-chief",
            "ORCA_TERMINAL_HANDLE": "term_coord",
        }
        with mock.patch.object(orca_context, "resolve_cli", return_value="/opt/orca/orca-ide"):
            opened = orca_swarm_restore.toggle("toggle", base=self.base, chief=True, env=env, run=run)
            self.assertEqual(opened["status"], "opened")
            self.assertTrue(opened["chief"])
            state = orca_context.load(orca_context.view_path(orca_swarm_restore.CHIEF_VIEW_KEY, self.home))
            self.assertTrue(state["chief"])
            self.assertEqual(state["room"], "")
            live.discard("term_chief_view")
            restored = orca_swarm_restore.restore(self.home, env=env, run=run)
            self.assertEqual(restored, [{"room": "", "status": "restored", "chief": True}])

    def test_peer_and_room_for_terminal_filter_stale_run_env_and_inactive_rooms(self):
        mailbox.register(self.base, session="old-peer", harness="claude", cwd=str(self.home), pid=os.getpid())
        mailbox.annotate(self.base, "old-peer", orcaTerminalHandle="term_1", orcaEnvironment="ssh:other")
        mailbox.register(self.base, session="run-r1-worker", harness="claude", cwd=str(self.home), pid=os.getpid())
        mailbox.annotate(self.base, "run-r1-worker", orcaTerminalHandle="term_1", run="r1")
        mailbox.register(self.base, session="live-peer", harness="claude", cwd=str(self.home), pid=os.getpid())
        mailbox.annotate(self.base, "live-peer", orcaTerminalHandle="term_1")
        chosen = orca_swarm_restore._peer_for_terminal(self.base, "term_1", environment="")
        self.assertEqual(chosen["session"], "live-peer")

        room_store.put_room(
            self.base,
            {
                "schema": "agent-executor.room.v1",
                "id": "room-arch",
                "lifecycle": "archived",
                "archivedAt": 100,
                "orcaCoordinatorTerminalId": "term_1",
                "agents": [],
            },
        )
        room_store.put_room(
            self.base,
            {
                "schema": "agent-executor.room.v1",
                "id": "room-active",
                "lifecycle": "active",
                "orcaCoordinatorTerminalId": "term_1",
                "agents": [],
            },
        )
        self.assertEqual(orca_swarm_restore._room_for_terminal(self.base, "term_1"), "room-active")


if __name__ == "__main__":
    unittest.main()
