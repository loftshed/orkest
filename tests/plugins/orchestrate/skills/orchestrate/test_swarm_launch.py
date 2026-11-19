"""A real Horde terminal launches once, shows live work, and reconnects without another agent."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import pty
import re
import select
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import termios
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
CLI = SCRIPTS.parents[2] / "bin/ork.mjs"
TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))
sys.path.insert(0, str(SCRIPTS))
import _ork_fast_test_helpers as ORK_FAST  # noqa: E402
import agent_progress as progress  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402
import room_store  # noqa: E402
import swarm_status  # noqa: E402


def setUpModule():
    # Exercise private tmux by default, including when the test runner lives inside Herdr.
    # Herdr cases supply their own binary, socket and pane context.
    unittest.enterModuleContext(
        patch.dict(
            os.environ,
            {
                "HERDR_ENV": "0",
                "ORK_FAST_BIN": str(ORK_FAST.find_ork_fast_bin()),
            },
        )
    )


class SwarmStatusTests(unittest.TestCase):
    def test_only_live_sessions_in_the_bound_checkout_supply_progress(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            base = home / "mailbox-v1"
            peer = mailbox.register(base, session="real-lead", harness="codex", cwd=str(home), pid=os.getpid())
            progress.report(base, peer, goal="Repair cache", task="Trace invalidation", stage="working")
            room = {
                "cwd": str(home),
                "conductor": {"session": {"id": "real-lead", "engine": "codex", "machine": socket.gethostname()}},
                "agents": [],
            }
            item = swarm_status.snapshot(room, base)["conductor"]
            self.assertEqual(
                (item["goal"], item["task"], item["stage"]), ("Repair cache", "Trace invalidation", "working")
            )
            for key, value in (("machine", "another-host"), ("engine", "claude"), ("id", "missing-peer")):
                with self.subTest(key=key):
                    changed = json.loads(json.dumps(room))
                    changed["conductor"]["session"][key] = value
                    self.assertEqual(swarm_status.snapshot(changed, base), {})
            room["cwd"] = str(home / "another-checkout")
            self.assertEqual(swarm_status.snapshot(room, base), {})

    def test_update_room_metadata_uses_sqlite_and_explicit_room_overrides_tmux_option(self):
        from unittest import mock

        import agent_statusline_tmux

        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            base = home / "mailbox-v1"
            room_path = base / "rooms" / "room-explicit.json"
            room_path.parent.mkdir(parents=True, exist_ok=True)
            room_path.write_text(json.dumps({"roomId": "room-explicit", "name": "Explicit Room"}))

            with agent_statusline_tmux._node_room_lock(room_path):
                self.assertTrue(Path(f"{room_path}.lock").is_dir())
            self.assertFalse(Path(f"{room_path}.lock").exists())

            updated = agent_statusline_tmux._update_room_metadata(base, "room-explicit", updatedByPython="yes")
            self.assertIsNotNone(updated)
            self.assertFalse(Path(f"{room_path}.lock").exists())
            self.assertEqual(room_store.read_room(base, "room-explicit").get("updatedByPython"), "yes")

            def fake_run(cmd, **_kwargs):
                if "@orkest_coordinator_pane" in cmd:
                    return subprocess.CompletedProcess(cmd, 0, stdout="%0\n", stderr="")
                if "@orkest_room" in cmd:
                    return subprocess.CompletedProcess(cmd, 0, stdout="stale-room-from-tmux\n", stderr="")
                if "list-panes" in cmd:
                    return subprocess.CompletedProcess(cmd, 0, stdout="%0\n", stderr="")
                return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

            with (
                mock.patch.object(agent_statusline_tmux.shutil, "which", return_value="/usr/bin/tmux"),
                mock.patch.object(agent_statusline_tmux, "_discover_socket", return_value="orkest-test-sock"),
                mock.patch.object(agent_statusline_tmux.subprocess, "run", side_effect=fake_run),
            ):
                result = agent_statusline_tmux.toggle_swarm_view("close", room="room-explicit", base=base)
                self.assertEqual(
                    result,
                    {"status": "already_closed", "room": "room-explicit", "socket": "orkest-test-sock"},
                )


@unittest.skipUnless(shutil.which("tmux") and shutil.which("node"), "interactive launch requires tmux and Node")
class SwarmLaunchTests(unittest.TestCase):
    def test_codex_conversation_and_reconnect(self):
        self.check_conversation("codex", "codex", shortcut=True)

    def test_claude_conversation_and_reconnect(self):
        self.check_conversation("claude", "claude")

    def test_agy_conversation_and_reconnect(self):
        self.check_conversation("agy", "gemini")

    def test_opencode_conversation_and_reconnect(self):
        self.check_conversation("opencode", "opencode")

    def check_conversation(self, engine, harness, *, shortcut=False):
        with tempfile.TemporaryDirectory(prefix="ork-swarm-launch-") as temporary:
            home = Path(temporary).resolve()
            base = home / "mailbox-v1"
            binary = home / engine
            launched = home / "launched.json"
            received = home / "received.txt"
            peer = mailbox.register(
                base,
                session="11111111-2222-4333-8444-555555555555",
                harness=harness,
                cwd=str(home),
                pid=os.getpid(),
                account=str(home),
            )
            mailbox.annotate(base, peer["session"], name="example-gpt-test-high-cache-aa")
            progress.report(base, peer, goal="Repair cache", task="Plan the swarm", stage="planning")
            fast_bin = ORK_FAST.find_ork_fast_bin()
            binary.write_text(
                "#!" + sys.executable + "\n"
                "import json, os, re, subprocess, sys\nfrom pathlib import Path\n"
                "room = os.environ.get('ORKEST_SWARM_ROOM') or re.search(r'Room: ([^\\n]+)', sys.argv[-1]).group(1)\n"
                + (
                    "hook_out = json.loads(subprocess.check_output(["
                    + repr(str(fast_bin))
                    + ", 'mailbox-hook', '--harness', "
                    + repr(harness)
                    + "], input=json.dumps({'hook_event_name': 'UserPromptSubmit', 'session_id': "
                    + repr(peer["session"])
                    + ", 'cwd': "
                    + repr(str(home))
                    + "}), text=True))\n"
                    "prompt = hook_out['hookSpecificOutput']['additionalContext']\n"
                    "flags = sys.argv[1:]\n"
                    if shortcut
                    else "subprocess.run(['node', "
                    + repr(str(CLI))
                    + ", 'rooms', 'bind', '--room', room, '--member', 'conductor', '--engine', "
                    + repr(engine)
                    + ", '--session', '11111111-2222-4333-8444-555555555555'], "
                    "check=True, stdout=subprocess.DEVNULL)\n"
                    "prompt = sys.argv[-1]\n"
                    "flags = sys.argv[1:-1]\n"
                )
                + "sys.stdout.write('\\033]2;11111111-2222-4333-8444-555555555555\\007')\n"
                + (
                    ""
                    if engine == "codex"
                    else "subprocess.run("
                    + repr(
                        [
                            str(fast_bin),
                            "statusline",
                            "--native-status",
                            "--session",
                            peer["session"],
                            "--harness",
                            harness,
                        ]
                    )
                    + ", check=True, stdout=subprocess.DEVNULL)\n"
                )
                + "print('Coordinator conversation ready', flush=True)\n"
                "launch_file = Path(" + repr(str(launched)) + ")\n"
                "launch_temp = launch_file.with_suffix('.tmp')\n"
                "launch_temp.write_text(json.dumps({'room': room, 'pid': os.getpid(), "
                "'socket': os.environ['TMUX'].split(',')[0], 'prompt': prompt, 'flags': flags}))\n"
                "launch_temp.replace(launch_file)\n"
                "while True:\n"
                "    value = os.read(0, 4096)\n"
                "    if not value: break\n"
                "    Path(" + repr(str(received)) + ").write_bytes(value)\n"
            )
            binary.chmod(0o755)
            environment = {
                **os.environ,
                "AGENT_EXECUTOR_HOME": str(home),
                "ORCHESTRATE_HOME": str(home),
                "ORK_FAST_BIN": str(fast_bin),
                "PATH": str(home) + os.pathsep + os.environ["PATH"],
                "TERM": "xterm-256color",
                "CODEX_HOME": str(home),
                "MONITOR_CACHE_DIR": str(home / "monitor"),
            }
            for key in ("HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH"):
                environment.pop(key, None)
            clients = []

            def launch(arguments, command="horde"):
                pid, master = pty.fork()
                if pid == 0:
                    termios.tcsetwinsize(0, (34, 200))
                    os.execvpe("node", ["node", str(CLI), command, *arguments], environment)
                clients.append((pid, master))
                return pid, master

            def wait_for(condition, master, seconds=10, refresh=None):
                deadline = time.monotonic() + seconds
                output = b""
                refreshed = 0.0
                while time.monotonic() < deadline:
                    if refresh and time.monotonic() - refreshed >= 1:
                        refresh()
                        refreshed = time.monotonic()
                    if select.select([master], [], [], 0.05)[0]:
                        try:
                            output += os.read(master, 65536)
                        except OSError:
                            break
                    plain = re.sub(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\(B)", b"", output)
                    if condition(plain):
                        return output
                Path("/tmp/orkest-swarm-terminal-failure.log").write_bytes(output)
                self.fail("Timed out waiting for terminal state: " + repr(output[:1500]) + repr(output[-1500:]))

            def command(*arguments):
                return json.loads(
                    subprocess.check_output(["node", str(CLI), "rooms", *arguments], env=environment, text=True)
                )

            try:
                objective = "Fix cache $(touch SHOULD_NOT_EXIST)"
                if shortcut:
                    _, master = launch(["--cwd", str(home)], command=engine)
                else:
                    _, master = launch([objective, "--engine", engine, "--cwd", str(home)])
                wait_for(lambda _: launched.exists(), master)
                info = json.loads(launched.read_text())
                tmux = ["tmux", "-S", info["socket"]]
                if shortcut:
                    self.assertEqual(command("show", "--room", info["room"])["objective"], "")
                    self.assertIn("If the user has already supplied their goal", info["prompt"])
                else:
                    self.assertIn("Overall objective: " + objective, info["prompt"])
                self.assertEqual(
                    info["flags"],
                    {
                        "codex": ["-c", 'tui.terminal_title=["session-id"]'],
                        "claude": [],
                        "agy": ["--prompt-interactive"],
                        "opencode": ["--prompt"],
                    }[engine],
                )
                self.assertFalse((home / "SHOULD_NOT_EXIST").exists())
                wait_for(lambda output: b"Swarm" in output and b"Plan the swarm" in output, master)
                panes = subprocess.check_output([*tmux, "list-panes", "-F", "#{pane_id}"], text=True).splitlines()
                self.assertEqual(panes, ["%0", "%1"])
                if shortcut:
                    import agent_statusline_tmux

                    closed = agent_statusline_tmux.toggle_swarm_view(
                        "toggle", socket=Path(info["socket"]).name, room=info["room"], base=base
                    )
                    self.assertEqual(closed["status"], "closed")
                    self.assertEqual(
                        subprocess.check_output([*tmux, "list-panes", "-F", "#{pane_id}"], text=True).splitlines(),
                        ["%0"],
                    )
                    reopened = agent_statusline_tmux.toggle_swarm_view(
                        "toggle", socket=Path(info["socket"]).name, room=info["room"], base=base
                    )
                    self.assertEqual(reopened["status"], "opened")
                    panes = subprocess.check_output([*tmux, "list-panes", "-F", "#{pane_id}"], text=True).splitlines()
                    self.assertEqual(len(panes), 2)
                os.write(master, b"Redirect the investigation\n")
                wait_for(lambda _: received.exists() and received.read_text() == "Redirect the investigation\n", master)
                self.assertEqual(received.read_text(), "Redirect the investigation\n")
                room = info["room"]
                command("add", "--room", room, "--team", engine + ":host-default")
                command("lead", "--room", room, "--member", "host-default-1", "--objective", "Investigate cache")
                command("add", "--room", room, "--parent", "host-default-1", "--team", "agy:flash")
                wait_for(lambda output: b"host-default-1" in output and b"flash-1" in output, master)
                subprocess.run([*tmux, "select-pane", "-t", panes[-1]], check=True)
                progress.report(base, peer, goal="Repair cache", task="Inspect cache recovery", stage="testing")
                wait_for(
                    lambda output: b"task : Inspect cache recovery" in output,
                    master,
                    refresh=lambda: subprocess.run([*tmux, "refresh-client", "-S"], check=True),
                )
                os.write(master, b"\x02d")
                wait_for(lambda output: b"Reattach with: ork horde --attach-room" in output, master)
                _, reattached = launch(["--attach-room", room])
                wait_for(
                    lambda output: b"Coordinator conversation ready" in output and b"flash-1" in output, reattached
                )
                self.assertEqual(json.loads(launched.read_text())["pid"], info["pid"])
                os.write(reattached, b"\x02d")
                wait_for(lambda output: b"detached" in output, reattached)
                subprocess.run([*tmux, "kill-pane", "-t", "%0"], check=True)
                _, ended = launch(["--attach-room", room])
                wait_for(lambda output: b"no live coordinator terminal" in output, ended)
            finally:
                # These room files and private servers were created only by this test.
                for saved_room in room_store.list_rooms(base):
                    key = str(base.resolve()) + "/" + saved_room["id"]
                    server = "orkest-label-" + hashlib.sha256(key.encode()).hexdigest()[:12]
                    subprocess.run(["tmux", "-L", server, "kill-server"], capture_output=True, check=False)
                for pid, master in clients:
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if os.waitpid(pid, os.WNOHANG)[0]:
                            break
                        time.sleep(0.05)
                    else:
                        os.kill(pid, signal.SIGTERM)
                        os.waitpid(pid, 0)
                    os.close(master)


@unittest.skipUnless(shutil.which("node"), "Herdr swarm launch requires Node")
class HerdrSwarmLaunchTests(unittest.TestCase):
    @contextlib.contextmanager
    def _reused_pane_room(self):
        from unittest import mock

        with tempfile.TemporaryDirectory(prefix="ork-herdr-reused-pane-") as temporary:
            home = Path(temporary).resolve()
            base = home / "mailbox-v1"
            self._write_fake_herdr(home, home / "herdr-state.json")
            previous_session = "previous-coordinator-session"
            current_session = "current-coordinator-session"
            room = {
                "schema": "agent-executor.room.v1",
                "id": "previous-room",
                "title": "Previous task",
                "objective": "Finish previous task",
                "cwd": str(home),
                "machine": socket.gethostname(),
                "swarm": {"maxAgents": 16, "maxDepth": 4},
                "createdAt": 1000,
                "updatedAt": 2000,
                "conductor": {
                    "engine": "codex",
                    "role": "lead",
                    "status": "awaiting session",
                    "session": {
                        "id": previous_session,
                        "engine": "codex",
                        "machine": socket.gethostname(),
                        "cwd": str(home),
                    },
                },
                "agents": [{"id": "previous-worker", "engine": "claude", "status": "completed"}],
                "messages": [{"from": "previous-worker", "text": "Previous result"}],
                "herdrCoordinatorPaneId": "w1:p1",
                "herdrWorkspaceId": "w1",
            }
            mailbox.write(base / "rooms" / "previous-room.json", room)
            peer = mailbox.register(base, session=current_session, harness="codex", cwd=str(home), pid=os.getpid())
            peer = mailbox.annotate(
                base,
                current_session,
                herdrPaneId="w1:p1",
                herdrWorkspaceId="w1",
                herdrEndpoint=str(home / "herdr.sock"),
            )
            progress.report(base, peer, goal="Current task", task="Inspect current changes", stage="working")
            environment = {
                **os.environ,
                "AGENT_EXECUTOR_HOME": str(home),
                "PATH": str(home) + os.pathsep + os.environ["PATH"],
                "HERDR_ENV": "1",
                "HERDR_BIN_PATH": str(home / "herdr"),
                "HERDR_SOCKET_PATH": str(home / "herdr.sock"),
                "HERDR_PANE_ID": "w1:p1",
                "HERDR_WORKSPACE_ID": "w1",
                "ORKEST_TEST_ALLOW_HERDR": "1",
            }
            for key in ("ORKEST_SWARM_ROOM", "ORKEST_TERMINAL_SERVER", "ORKEST_TERMINAL_HARNESS", "TMUX", "TMUX_PANE"):
                environment.pop(key, None)
            with mock.patch.dict(os.environ, environment, clear=True):
                yield home, base, room, current_session

    def test_fresh_codex_session_does_not_inherit_a_previous_room_from_its_reused_pane(self):
        import agent_statusline_tmux

        with self._reused_pane_room() as (home, base, previous, session):
            old_content = room_store.read_room(base, "previous-room")
            opened = agent_statusline_tmux.toggle_swarm_view(
                "open", session_id=session, harness="codex", cwd=str(home), base=base
            )
            self.assertEqual(opened["status"], "opened")
            self.assertNotEqual(opened["room"], previous["id"])
            current = room_store.read_room(base, opened["room"])
            self.assertEqual(current["conductor"]["session"]["id"], session)
            self.assertEqual(current["herdrCoordinatorPaneId"], "w1:p1")
            self.assertEqual(swarm_status.snapshot(current, base)["conductor"]["task"], "Inspect current changes")
            self.assertEqual(room_store.read_room(base, "previous-room"), old_content)
            reopened = agent_statusline_tmux.toggle_swarm_view(
                "open", session_id=session, harness="codex", cwd=str(home), base=base
            )
            self.assertEqual(reopened["room"], opened["room"])
            self.assertEqual(reopened["status"], "already_open")

    def test_shortcut_uses_the_native_conversation_when_old_mailbox_records_share_its_pane(self):
        import agent_statusline_tmux

        with self._reused_pane_room() as (home, base, previous, _session):
            state = home / "herdr-state.json"
            fixture = json.loads(state.read_text())
            fixture["agent_session"] = {"kind": "id", "value": "fresh-native-session", "agent": "codex"}
            state.write_text(json.dumps(fixture))
            closed = agent_statusline_tmux.toggle_swarm_view("close", cwd=str(home), base=base)
            self.assertEqual(closed["status"], "already_closed")
            self.assertEqual([room["id"] for room in room_store.list_rooms(base)], [previous["id"]])
            opened = agent_statusline_tmux.toggle_swarm_view("open", cwd=str(home), base=base)
            room = room_store.read_room(base, opened["room"])
            self.assertEqual(room["conductor"]["session"]["id"], "fresh-native-session")

    def test_new_coordinator_replaces_its_previous_room_view_after_opening_the_new_one(self):
        import agent_statusline_tmux
        import herdr_swarm_restore

        with self._reused_pane_room() as (home, base, previous, session):
            environment = dict(os.environ)
            herdr = str(home / "herdr")
            old_view = agent_statusline_tmux._open_herdr_swarm_view(
                herdr,
                room=previous["id"],
                cwd=str(home),
                coordinator_pane="w1:p1",
                workspace_id="w1",
                environment=environment,
                base=base,
            )
            self.assertEqual(old_view, "w1:p2")
            opened = agent_statusline_tmux.toggle_swarm_view(
                "open", session_id=session, harness="codex", cwd=str(home), base=base
            )
            self.assertEqual(opened["status"], "opened")
            self.assertNotEqual(opened["room"], previous["id"])
            state = json.loads((home / "herdr-state.json").read_text())
            self.assertNotIn(old_view, state["panes"])
            self.assertIn(opened["pane"], state["panes"])
            self.assertIn(["pane", "close", old_view], state["calls"])
            self.assertIsNone(room_store.read_room(base, "previous-room").get("herdrViewPaneId"))
            self.assertEqual(room_store.read_room(base, opened["room"])["herdrViewPaneId"], opened["pane"])
            old_state = herdr_swarm_restore.state_path(base.parent, previous["id"], environment)
            self.assertTrue(old_state.with_suffix(".closed").exists())

    def test_new_coordinator_does_not_take_another_coordinators_herdr_view(self):
        import agent_statusline_tmux

        with self._reused_pane_room() as (home, base, previous, session):
            environment = dict(os.environ)
            herdr = str(home / "herdr")
            old_view = agent_statusline_tmux._open_herdr_swarm_view(
                herdr,
                room=previous["id"],
                cwd=str(home),
                coordinator_pane="w1:p99",
                workspace_id="w1",
                environment=environment,
                base=base,
            )
            self.assertEqual(old_view, "w1:p2")
            opened = agent_statusline_tmux.toggle_swarm_view(
                "open", session_id=session, harness="codex", cwd=str(home), base=base
            )
            self.assertEqual(opened["status"], "opened")
            self.assertEqual(opened["pane"], "w1:p3")
            state = json.loads((home / "herdr-state.json").read_text())
            self.assertIn(old_view, state["panes"])
            self.assertEqual(room_store.read_room(base, "previous-room")["herdrViewPaneId"], old_view)

    def test_explicitly_attached_room_keeps_its_original_coordinator_and_workers(self):
        import agent_statusline_tmux

        with self._reused_pane_room() as (home, base, previous, session):
            os.environ["HERDR_PANE_ID"] = "w1:p99"
            opened = agent_statusline_tmux.toggle_swarm_view(
                "open", room=previous["id"], session_id=session, harness="codex", cwd=str(home), base=base
            )
            self.assertEqual(opened["room"], previous["id"])
            persisted = room_store.read_room(base, "previous-room")
            self.assertEqual(persisted["herdrCoordinatorPaneId"], "w1:p1")
            self.assertEqual(persisted["conductor"], previous["conductor"])
            self.assertEqual(persisted["agents"], previous["agents"])
            self.assertEqual(persisted["messages"], previous["messages"])

    def test_attested_native_identity_reuses_the_previous_room_instead_of_creating_another(self):
        import agent_statusline_tmux

        with self._reused_pane_room() as (home, base, previous, session):
            mailbox.attest_native_sessions(base, session, previous["conductor"]["session"]["id"])
            opened = agent_statusline_tmux.toggle_swarm_view(
                "open", session_id=session, harness="codex", cwd=str(home), base=base
            )
            self.assertEqual(opened["room"], previous["id"])
            persisted = room_store.read_room(base, "previous-room")
            self.assertEqual(persisted["agents"], previous["agents"])
            self.assertEqual(persisted["messages"], previous["messages"])

    def _write_fake_herdr(self, home: Path, state_file: Path) -> Path:
        state_file.write_text(
            json.dumps(
                {
                    "next_id": 2,
                    "panes": ["w1:p1", "w1:p99"],
                    "calls": [],
                    "runs": [],
                }
            )
        )
        herdr_bin = home / "herdr"
        herdr_bin.write_text(
            "#!" + sys.executable + "\n"
            "import json, shlex, sys\nfrom pathlib import Path\n"
            "state_path = Path(" + repr(str(state_file)) + ")\n"
            "state = json.loads(state_path.read_text())\n"
            "args = sys.argv[1:]\n"
            "state['calls'].append(args)\n"
            "if args[:3] == ['plugin', 'pane', 'open']:\n"
            "    pane_id = 'w1:p' + str(state['next_id'])\n"
            "    state['next_id'] += 1\n"
            "    state['panes'].append(pane_id)\n"
            "    room = next(v.split('=',1)[1] for v in args if v.startswith('ORKEST_SWARM_ROOM='))\n"
            "    state['runs'].append({'pane': pane_id, 'command': 'env node ' + "
            + repr(str(CLI.resolve()))
            + " + ' horde --attach-room ' + room + ' --view'})\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'result': {'type': 'plugin_pane_opened', 'plugin_pane': {'plugin_id': 'orkest.swarms', 'entrypoint': 'room', 'pane': {'pane_id': pane_id}}}}))\n"
            "elif args[:2] == ['pane', 'rename']:\n"
            "    state.setdefault('labels', {})[args[2]] = args[3]\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'result': {'type': 'ok'}}))\n"
            "elif args[:2] == ['api', 'snapshot']:\n"
            "    panes = [{'pane_id': p, 'terminal_id': p, 'label': state.get('labels', {}).get(p)} for p in state['panes']]\n"
            "    print(json.dumps({'result': {'snapshot': {'panes': panes}}}))\n"
            "elif args[:2] == ['pane', 'process-info']:\n"
            "    pane = args[args.index('--pane') + 1]\n"
            "    run = next((r for r in reversed(state['runs']) if r['pane'] == pane), None)\n"
            "    argv = shlex.split(run['command'])[1:] if run else ['zsh']\n"
            "    while run and argv and '=' in argv[0]:\n"
            "        argv.pop(0)\n"
            "    info = {'shell_pid': 100, 'foreground_process_group_id': 100, 'foreground_processes': [{'pid': 200 if run else 100, 'name': 'node' if run else 'zsh', 'argv': argv}]}\n"
            "    print(json.dumps({'result': {'process_info': info}}))\n"
            "elif args[:2] == ['pane', 'run']:\n"
            "    state['runs'].append({'pane': args[2], 'command': args[3]})\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'ok': True}))\n"
            "elif args[:2] == ['pane', 'send-keys']:\n"
            "    if args[3:] == ['q']:\n"
            "        state['runs'] = [run for run in state['runs'] if run['pane'] != args[2]]\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'ok': True}))\n"
            "elif args[:2] == ['pane', 'list']:\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'ok': True, 'result': {'panes': [{'pane_id': p} for p in state['panes']]}}))\n"
            "elif args[:2] == ['pane', 'current']:\n"
            "    target = args[args.index('--pane') + 1] if '--pane' in args else 'w1:p1'\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    if target not in state['panes']:\n"
            "        sys.exit(1)\n"
            "    print(json.dumps({'ok': True, 'result': {'pane': {'pane_id': target, 'agent_session': state.get('agent_session')}}}))\n"
            "elif args[:2] == ['pane', 'close']:\n"
            "    target = args[args.index('--pane') + 1] if '--pane' in args else args[2]\n"
            "    if target in state['panes']:\n"
            "        state['panes'].remove(target)\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'ok': True}))\n"
            "elif args[:2] == ['agent', 'get'] and state.get('agent_session'):\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'ok': True, 'result': {'type': 'agent_info', 'agent': {'agent': 'antigravity', 'agent_session': {'kind': 'id', 'value': state['agent_session']}}}}))\n"
            "else:\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'ok': True}))\n"
        )
        herdr_bin.chmod(0o755)
        return herdr_bin

    def test_herdr_launch_and_toggle_swarm_view(self):
        import agent_statusline_tmux

        with tempfile.TemporaryDirectory(prefix="ork-herdr-swarm-") as temporary:
            home = Path(temporary).resolve()
            base = home / "mailbox-v1"
            state_file = home / "herdr-state.json"
            self._write_fake_herdr(home, state_file)
            launched = home / "launched.json"
            binary = home / "claude"
            session_id = "22222222-3333-4444-8555-666666666666"
            mailbox.register(
                base,
                session=session_id,
                harness="claude",
                cwd=str(home),
                pid=os.getpid(),
                account=str(home),
            )
            fast_bin = ORK_FAST.find_ork_fast_bin()
            binary.write_text(
                "#!" + sys.executable + "\n"
                "import json, os, subprocess, sys, time\nfrom pathlib import Path\n"
                "hook_out = json.loads(subprocess.check_output(["
                + repr(str(fast_bin))
                + ", 'mailbox-hook', '--harness', 'claude'], input=json.dumps({"
                "'hook_event_name': 'UserPromptSubmit', 'session_id': "
                + repr(session_id)
                + ", 'cwd': "
                + repr(str(home))
                + "}), text=True))\n"
                "Path(" + repr(str(launched)) + ").write_text(json.dumps({"
                "'room': os.environ.get('ORKEST_SWARM_ROOM'), "
                "'tmux': os.environ.get('TMUX'), "
                "'server': os.environ.get('ORKEST_TERMINAL_SERVER'), "
                "'harness': os.environ.get('ORKEST_TERMINAL_HARNESS'), "
                "'herdr_pane': os.environ.get('HERDR_PANE_ID'), "
                "'flags': sys.argv[1:], "
                "'prompt': hook_out['hookSpecificOutput']['additionalContext']"
                "}))\n"
                "print('Herdr coordinator ready', flush=True)\n"
                "time.sleep(10)\n"
            )
            binary.chmod(0o755)
            environment = {
                **os.environ,
                "AGENT_EXECUTOR_HOME": str(home),
                "PATH": str(home) + os.pathsep + os.environ["PATH"],
                "TERM": "xterm-256color",
                "HERDR_ENV": "1",
                "HERDR_BIN_PATH": str(home / "herdr"),
                "ORKEST_TEST_ALLOW_HERDR": "1",
                "HERDR_PANE_ID": "w1:p1",
                "HERDR_WORKSPACE_ID": "w1",
            }
            for key in ("ORKEST_SWARM_ROOM", "ORKEST_TERMINAL_SERVER", "ORKEST_TERMINAL_HARNESS", "TMUX", "TMUX_PANE"):
                environment.pop(key, None)
            pid, master = pty.fork()
            if pid == 0:
                termios.tcsetwinsize(0, (34, 160))
                os.execvpe("node", ["node", str(CLI), "claude", "--cwd", str(home)], environment)
            try:
                output = b""
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if select.select([master], [], [], 0.05)[0]:
                        try:
                            chunk = os.read(master, 65536)
                            if not chunk:
                                break
                            output += chunk
                        except OSError:
                            break
                    if launched.exists():
                        break
                self.assertTrue(launched.exists(), f"Herdr coordinator did not launch: {output[-4000:]!r}")
                info = json.loads(launched.read_text())
                room_id = info["room"]
                self.assertIsNotNone(room_id)
                self.assertIsNone(info["server"])
                self.assertIsNone(info["tmux"])
                self.assertEqual(info["harness"], "claude")
                self.assertEqual(info["herdr_pane"], "w1:p1")

                peer_record = mailbox.load(mailbox.peer_path(base, session_id))
                self.assertEqual(peer_record["herdrPaneId"], "w1:p1")
                self.assertEqual(peer_record["herdrWorkspaceId"], "w1")

                state = json.loads(state_file.read_text())
                self.assertIn("w1:p2", state["panes"])
                self.assertTrue(
                    any(
                        call[:3] == ["plugin", "pane", "open"] and "--no-focus" in call and "--target-pane" in call
                        for call in state["calls"]
                    )
                )
                self.assertEqual(len(state["runs"]), 1)
                self.assertEqual(state["runs"][0]["pane"], "w1:p2")
                self.assertIn(f"horde --attach-room {room_id} --view", state["runs"][0]["command"])

                room_data = room_store.read_room(base, room_id)
                self.assertEqual(room_data["herdrViewPaneId"], "w1:p2")
                self.assertEqual(room_data["herdrCoordinatorPaneId"], "w1:p1")

                old_environ = os.environ.copy()
                try:
                    os.environ.clear()
                    os.environ.update(environment)
                    already_open = agent_statusline_tmux.toggle_swarm_view("open", base=base)
                    self.assertEqual(
                        already_open,
                        {"status": "already_open", "room": room_id, "backend": "herdr", "pane": "w1:p2"},
                    )

                    closed = agent_statusline_tmux.toggle_swarm_view("toggle", base=base)
                    self.assertEqual(
                        closed,
                        {"status": "closed", "room": room_id, "backend": "herdr", "pane": "w1:p2"},
                    )
                    state = json.loads(state_file.read_text())
                    self.assertNotIn("w1:p2", state["panes"])
                    self.assertIn("w1:p99", state["panes"])
                    room_data = room_store.read_room(base, room_id)
                    self.assertNotIn("herdrViewPaneId", room_data)

                    already_closed = agent_statusline_tmux.toggle_swarm_view("close", base=base)
                    self.assertEqual(
                        already_closed,
                        {"status": "already_closed", "room": room_id, "backend": "herdr"},
                    )
                    state = json.loads(state_file.read_text())
                    self.assertIn("w1:p99", state["panes"])

                    reopened = agent_statusline_tmux.toggle_swarm_view("toggle", base=base)
                    self.assertEqual(
                        reopened,
                        {"status": "opened", "room": room_id, "backend": "herdr", "pane": "w1:p3"},
                    )
                    room_data = room_store.read_room(base, room_id)
                    self.assertEqual(room_data["herdrViewPaneId"], "w1:p3")
                    import herdr_swarm_restore as restoration

                    reopened_state = restoration.state_path(base.parent, room_id, environment)
                    self.assertFalse(reopened_state.with_suffix(".closed").exists())
                    self.assertFalse(reopened_state.with_suffix(".pending").exists())
                finally:
                    os.environ.clear()
                    os.environ.update(old_environ)
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

    def test_extract_resumed_session_id_across_harnesses(self):
        import agent_statusline_tmux

        sid = "11111111-2222-4333-8444-555555555555"
        self.assertEqual(
            agent_statusline_tmux.extract_resumed_session_id(["claude", "--resume", sid]),
            sid,
        )
        self.assertEqual(
            agent_statusline_tmux.extract_resumed_session_id(["claude-alt", "-r", sid]),
            sid,
        )
        self.assertEqual(
            agent_statusline_tmux.extract_resumed_session_id(["claude", f"--session-id={sid}"]),
            sid,
        )
        self.assertEqual(
            agent_statusline_tmux.extract_resumed_session_id(["codex", "resume", sid]),
            sid,
        )
        self.assertEqual(
            agent_statusline_tmux.extract_resumed_session_id(["agy", "--conversation", sid]),
            sid,
        )
        self.assertEqual(
            agent_statusline_tmux.extract_resumed_session_id(["opencode", "-s", sid]),
            sid,
        )
        self.assertIsNone(agent_statusline_tmux.extract_resumed_session_id(["claude", "--resume"]))
        self.assertIsNone(agent_statusline_tmux.extract_resumed_session_id(["codex", "resume", "--last"]))

    def test_shell_wrapper_script_generates_dynamic_aliases_without_hardcoded_names(self):
        import install_mailbox

        with tempfile.TemporaryDirectory(prefix="ork-wrappers-") as temporary:
            home = Path(temporary)
            cfg = home / ".config" / "monitor" / "config.json"
            cfg.parent.mkdir(parents=True, exist_ok=True)
            cfg.write_text(
                json.dumps(
                    {
                        "accounts": [
                            {"id": "claude-default", "provider": "claude", "route": "claude"},
                            {
                                "id": "claude-alt-id",
                                "provider": "claude",
                                "alias": "claude-alt",
                                "configDir": str(home / ".claude-alt"),
                            },
                            {"id": "codex-alt-id", "provider": "codex", "route": "codex-alt"},
                            {"id": "agy-alt-id", "provider": "antigravity", "alias": "agy-alt"},
                            {"id": "bad-reserved", "provider": "claude", "alias": "git"},
                            {"id": "bad-chars", "provider": "claude", "alias": "bad alias;rm"},
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"MONITOR_CONFIG": ""}, clear=False):
                script = install_mailbox.shell_wrapper_script(home=home)
            self.assertIn("unalias codex claude agy claude-alt codex-alt agy-alt 2>/dev/null", script)
            self.assertIn("claude-alt() {", script)
            self.assertIn("command ork label -- claude-alt", script)
            self.assertIn("codex-alt() {", script)
            self.assertIn("command ork label -- codex-alt", script)
            self.assertIn("agy-alt() {", script)
            self.assertIn("command ork label -- agy-alt --dangerously-skip-permissions", script)
            self.assertNotIn("git() {", script)
            self.assertNotIn("bad alias", script)

    def test_ork_label_resolves_builtin_configured_aliases_and_provider_headers(self):
        import agent_statusline_tmux

        with tempfile.TemporaryDirectory(prefix="ork-label-resolve-") as temporary:
            root = Path(temporary)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            header_wrapper = bin_dir / "custom-claude-bin"
            header_wrapper.write_text(
                '#!/bin/sh\n# orkest-account-provider: claude\nexec claude "$@"\n',
                encoding="utf-8",
            )
            header_wrapper.chmod(0o755)
            header_agy = bin_dir / "custom-agy-bin"
            header_agy.write_text(
                '#!/bin/sh\n# orkest-account-provider: antigravity\nexec agy "$@"\n',
                encoding="utf-8",
            )
            header_agy.chmod(0o755)
            cfg = root / "monitor-config.json"
            cfg.write_text(
                json.dumps(
                    {
                        "accounts": [
                            {"id": "claude-alt-id", "provider": "claude", "alias": "claude-alt"},
                            {"id": "codex-alt-id", "provider": "codex", "route": "codex-alt"},
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"MONITOR_CONFIG": str(cfg), "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}"},
            ):
                self.assertEqual(agent_statusline_tmux._resolve_label_harness("codex"), "codex")
                self.assertEqual(agent_statusline_tmux._resolve_label_harness("claude"), "claude")
                self.assertEqual(agent_statusline_tmux._resolve_label_harness("agy"), "gemini")
                self.assertEqual(agent_statusline_tmux._resolve_label_harness("gemini"), "gemini")
                self.assertEqual(agent_statusline_tmux._resolve_label_harness("opencode"), "opencode")
                self.assertEqual(agent_statusline_tmux._resolve_label_harness("claude-alt"), "claude")
                self.assertEqual(agent_statusline_tmux._resolve_label_harness("codex-alt"), "codex")
                self.assertEqual(agent_statusline_tmux._resolve_label_harness("custom-claude-bin"), "claude")
                self.assertEqual(agent_statusline_tmux._resolve_label_harness("custom-agy-bin"), "gemini")
                self.assertIsNone(agent_statusline_tmux._resolve_label_harness("unknown-tool"))

    def test_resumed_session_reconnects_to_previous_swarm_room_and_history(self):
        import agent_statusline_tmux

        with tempfile.TemporaryDirectory(prefix="ork-swarm-resume-") as temporary:
            home = Path(temporary).resolve()
            base = home / "mailbox-v1"
            (base / "rooms").mkdir(parents=True, exist_ok=True)
            session_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
            host = socket.gethostname()

            older_room = {
                "schema": "agent-executor.room.v1",
                "id": "room-older",
                "title": "Older Horde",
                "cwd": str(home),
                "machine": host,
                "swarm": {"maxAgents": 16, "maxDepth": 4},
                "objective": "Ship older feature",
                "updatedAt": 1000,
                "conductor": {
                    "engine": "claude",
                    "role": "lead",
                    "status": "active",
                    "session": {"id": session_id, "engine": "claude", "machine": host, "cwd": str(home)},
                },
                "agents": [],
            }
            newer_room = {
                "schema": "agent-executor.room.v1",
                "id": "room-newer",
                "title": "Active Horde",
                "cwd": str(home),
                "machine": host,
                "swarm": {"maxAgents": 16, "maxDepth": 4},
                "objective": "Ship wave 65",
                "updatedAt": 2000,
                "conductor": {
                    "engine": "claude",
                    "role": "lead",
                    "status": "active",
                    "session": {"id": session_id, "engine": "claude", "machine": host, "cwd": str(home)},
                },
                "agents": [
                    {"id": "w1", "role": "worker", "engine": "claude", "status": "running"},
                    {"id": "w2", "role": "worker", "engine": "codex", "status": "completed"},
                ],
            }
            mailbox.write(base / "rooms" / "room-older.json", older_room)
            mailbox.write(base / "rooms" / "room-newer.json", newer_room)

            matched = agent_statusline_tmux.find_session_swarm_room(base, session_id, harness="claude", cwd=str(home))
            self.assertIsNotNone(matched)
            self.assertEqual(matched["id"], "room-newer")
            self.assertEqual(matched["_matchedMemberId"], "conductor")

            mailbox.register(
                base,
                session=session_id,
                harness="claude",
                cwd=str(home),
                pid=os.getpid(),
                account=str(home),
            )
            clean_env = {k: v for k, v in os.environ.items() if k != "ORKEST_SWARM_ROOM"}
            clean_env.update({"HOME": str(home), "CLAUDE_CONFIG_DIR": str(home)})

            first_out = ORK_FAST.run_mailbox_hook(
                {"hook_event_name": "UserPromptSubmit", "session_id": session_id, "cwd": str(home)},
                harness="claude",
                base=base,
                pid=os.getpid(),
                env=clean_env,
            )
            summary = (first_out or {}).get("hookSpecificOutput", {}).get("additionalContext", "")
            self.assertIn("Reconnected to swarm room room-newer (Active Horde)", summary)
            self.assertIn("Objective: Ship wave 65.", summary)
            self.assertIn("2 total (1 active, 1 completed, 0 blocked/failed)", summary)

            # Subsequent turns in the same process/terminal do not repeat the reconnection banner
            second_out = ORK_FAST.run_mailbox_hook(
                {"hook_event_name": "UserPromptSubmit", "session_id": session_id, "cwd": str(home)},
                harness="claude",
                base=base,
                pid=os.getpid(),
                env=clean_env,
            )
            second = (second_out or {}).get("hookSpecificOutput", {}).get("additionalContext", "")
            self.assertNotIn("Reconnected to swarm room room-newer", second)
            self.assertNotIn("Objective: Ship wave 65.", second)

            # A /clear handover session with aliases inherits and rebinds the swarm room
            cleared_sid = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee"
            mailbox.register(
                base,
                session=cleared_sid,
                harness="claude",
                cwd=str(home),
                pid=os.getpid() + 1,
                account=str(home),
            )
            mailbox.unregister(base, session_id)
            mailbox.attest_native_sessions(base, cleared_sid, session_id)
            # Registered under another pid, so record this process's start time too; a stale
            # pidBirth makes the peer look dead wherever pid + 1 is a live process (macOS CI).
            mailbox.annotate(
                base,
                cleared_sid,
                clearedFrom=session_id,
                pid=os.getpid(),
                pidBirth=mailbox.process_started(os.getpid()),
            )
            cleared_out = ORK_FAST.run_mailbox_hook(
                {"hook_event_name": "SessionStart", "session_id": cleared_sid, "cwd": str(home)},
                harness="claude",
                base=base,
                pid=os.getpid(),
                env=clean_env,
            )
            cleared_summary = (cleared_out or {}).get("hookSpecificOutput", {}).get("additionalContext", "")
            self.assertIn("Reconnected to swarm room room-newer (Active Horde)", cleared_summary)
            updated_room = room_store.read_room(base, "room-newer")
            self.assertEqual(updated_room["conductor"]["session"]["id"], cleared_sid)
            self.assertIn(session_id, updated_room["conductor"]["previousSessions"])

    def test_extract_resumed_session_id_ignores_codex_sandbox_flag(self):
        import agent_statusline_tmux

        self.assertIsNone(
            agent_statusline_tmux.extract_resumed_session_id(["codex", "-s", "workspace-write", "--model", "gpt-5.5"])
        )
        self.assertIsNone(agent_statusline_tmux.extract_resumed_session_id(["codex", "-s=read-only"]))
        self.assertEqual(
            agent_statusline_tmux.extract_resumed_session_id(["opencode", "-s", "ses_abc_123-xyz"]),
            "ses_abc_123-xyz",
        )

    def test_find_herdr_peer_skips_subagents_and_delegated_runs(self):
        import agent_statusline_tmux

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "mailbox-v1"
            parent = mailbox.register(
                base,
                session="parent-session-1111",
                harness="gemini",
                cwd=tmp,
                pid=os.getpid(),
            )
            mailbox.annotate(base, parent["session"], herdrPaneId="w1:p1", lastSeenAt=mailbox.stamp())
            child = mailbox.register(
                base,
                session="child-session-2222",
                harness="gemini",
                cwd=tmp,
                pid=os.getpid(),
            )
            mailbox.annotate(
                base,
                child["session"],
                herdrPaneId="w1:p1",
                isSubagent=True,
                lastSeenAt=mailbox.stamp(),
            )
            found_via_subagent = agent_statusline_tmux._find_herdr_peer(base, "child-session-2222", "w1:p1")
            self.assertIsNotNone(found_via_subagent)
            self.assertEqual(found_via_subagent["session"], "parent-session-1111")
            found = agent_statusline_tmux._find_herdr_peer(base, None, "w1:p1")
            self.assertIsNotNone(found)
            self.assertEqual(found["session"], "parent-session-1111")

    def test_herdr_pane_lookups_are_scoped_to_the_server_and_live_session(self):
        from unittest import mock

        import agent_statusline_tmux

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "mailbox-v1"
            for session, endpoint in (
                ("other-session", "/tmp/other-herdr.sock"),
                ("our-session", "/tmp/our-herdr.sock"),
            ):
                mailbox.register(base, session=session, harness="codex", cwd=tmp)
                mailbox.annotate(base, session, herdrPaneId="w1:p1", herdrEndpoint=endpoint)
                mailbox.write(
                    base / "rooms" / f"{session}.json",
                    {"id": session, "herdrCoordinatorPaneId": "w1:p1", "herdrEndpoint": endpoint},
                )
            peer = agent_statusline_tmux._find_herdr_peer(base, None, "w1:p1", endpoint="/tmp/our-herdr.sock")
            self.assertEqual(peer["session"], "our-session")
            self.assertEqual(
                agent_statusline_tmux._find_herdr_room(base, "w1:p1", endpoint="/tmp/our-herdr.sock"),
                "our-session",
            )
            self.assertIsNone(
                agent_statusline_tmux._find_herdr_peer(base, None, "w1:p1", endpoint="/tmp/missing-herdr.sock")
            )
            agent = {"agent_session": {"kind": "id", "value": "our-session"}, "agent_status": "idle"}
            response = subprocess.CompletedProcess(
                ["herdr", "agent", "get", "w1:p1"],
                0,
                stdout=json.dumps({"result": {"type": "agent_info", "agent": agent}}),
                stderr="",
            )
            with mock.patch.object(agent_statusline_tmux.subprocess, "run", return_value=response):
                self.assertTrue(agent_statusline_tmux.verified_agent("herdr", "w1:p1", {"our-session"}))
                self.assertFalse(agent_statusline_tmux.verified_agent("herdr", "w1:p1", {"other-session"}))

    def test_agy_subagent_detection_and_clear_handover_transfer(self):
        import agent_progress

        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve()
            base = home / "mailbox-v1"
            sub_transcript = home / "subagent.jsonl"
            sub_transcript.write_text(
                json.dumps(
                    {
                        "step_index": 0,
                        "type": "SYSTEM_MESSAGE",
                        "content": "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-04T05:00:00Z sender=11111111-2222-3333-4444-555555555555 priority=HIGH content=Build feature",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            top_transcript = home / "toplevel.jsonl"
            top_transcript.write_text(
                json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "content": "Hello"})
                + "\n",
                encoding="utf-8",
            )
            agy_env = {**os.environ, "HOME": str(home), "GEMINI_CLI_HOME": str(home / ".gemini")}
            ORK_FAST.run_mailbox_hook(
                {
                    "conversationId": "agy-sub-detect",
                    "workspacePaths": [str(home)],
                    "transcriptPath": str(sub_transcript),
                },
                harness="gemini",
                event="SessionStart",
                base=base,
                pid=os.getpid(),
                env=agy_env,
            )
            sub_peer = mailbox.load(mailbox.peer_path(base, "agy-sub-detect"))
            self.assertTrue(sub_peer.get("isSubagent"))
            self.assertEqual(sub_peer.get("parentSession"), "11111111-2222-3333-4444-555555555555")

            ORK_FAST.run_mailbox_hook(
                {
                    "conversationId": "agy-top-detect",
                    "workspacePaths": [str(home)],
                    "transcriptPath": str(top_transcript),
                },
                harness="gemini",
                event="SessionStart",
                base=base,
                pid=os.getpid(),
                env=agy_env,
            )
            top_peer = mailbox.load(mailbox.peer_path(base, "agy-top-detect"))
            self.assertFalse(top_peer.get("isSubagent"))
            self.assertIsNone(top_peer.get("parentSession"))

            # Verify SessionEnd(reason="clear") + SessionStart adopts and transfers focus, progress, and board.json references
            old_sid = "old-session-aaaa-1111"
            new_sid = "new-session-bbbb-2222"
            claude_env = {**os.environ, "HOME": str(home), "CLAUDE_CONFIG_DIR": str(home / ".claude")}
            old_peer = mailbox.register(
                base,
                session=old_sid,
                harness="claude",
                cwd=str(home),
                pid=os.getpid(),
                account=str(home / ".claude"),
            )
            old_peer = mailbox.annotate(base, old_sid, focus="wave-70")

            agent_progress.report(base, old_peer, goal="Fix clear", task="Transfer state", stage="working")
            board_path = base / "work" / "board.json"
            mailbox.write(
                board_path,
                {
                    "schema": 1,
                    "items": [
                        {
                            "id": "W1",
                            "creator": {"session": old_sid, "name": old_peer["name"]},
                            "integrator": {"session": old_sid, "name": old_peer["name"]},
                            "owner": {"session": old_sid, "name": old_peer["name"]},
                            "transfer": {"session": old_sid, "name": old_peer["name"]},
                        }
                    ],
                },
            )
            ORK_FAST.run_mailbox_hook(
                {"hook_event_name": "SessionEnd", "session_id": old_sid, "cwd": str(home), "reason": "clear"},
                harness="claude",
                base=base,
                pid=os.getpid(),
                env=claude_env,
            )
            new_peer = mailbox.register(
                base,
                session=new_sid,
                harness="claude",
                cwd=str(home),
                pid=os.getpid(),
                account=str(home / ".claude"),
            )
            temp_name = new_peer["name"]
            start_out = ORK_FAST.run_mailbox_hook(
                {"hook_event_name": "SessionStart", "session_id": new_sid, "cwd": str(home), "source": "clear"},
                harness="claude",
                base=base,
                pid=os.getpid(),
                env=claude_env,
            )
            notice = (start_out or {}).get("hookSpecificOutput", {}).get("additionalContext", "")
            self.assertIn(old_sid, notice)
            adopted = mailbox.load(mailbox.peer_path(base, new_sid))
            self.assertEqual(adopted.get("clearedFrom"), old_sid)
            self.assertEqual(adopted.get("focus"), "wave-70")
            self.assertEqual(adopted.get("person"), old_peer.get("person"))
            if temp_name != adopted.get("name"):
                self.assertNotIn(temp_name, adopted.get("aliases", []))
            copied_progress = agent_progress.read(base, adopted)
            self.assertIsNotNone(copied_progress)
            self.assertEqual(copied_progress["session"], new_sid)
            self.assertEqual(copied_progress["goal"], "Fix clear")
            updated_board = mailbox.load(board_path)
            item = updated_board["items"][0]
            self.assertEqual(item["creator"]["session"], new_sid)
            self.assertEqual(item["creator"]["name"], adopted["name"])
            self.assertEqual(item["integrator"]["session"], new_sid)
            self.assertEqual(item["owner"]["session"], new_sid)
            self.assertEqual(item["transfer"]["session"], new_sid)

    def test_swarm_next_digest_advisor_deduplicates_and_auto_recovers(self):
        with tempfile.TemporaryDirectory(prefix="ork-swarm-advisor-") as tmp:
            home = Path(tmp).resolve()
            base = home / "mailbox-v1"
            (base / "rooms").mkdir(parents=True, exist_ok=True)
            session_id = "conductor-session-1234"
            host = socket.gethostname()

            task_dir = home / "task-w1"
            (task_dir / "runs" / "r1" / "artifacts").mkdir(parents=True, exist_ok=True)
            result_path = task_dir / "runs" / "r1" / "artifacts" / "result.json"
            task_state = {
                "schema": "agent-executor.task.v1",
                "task_id": "t1",
                "repository": str(home),
                "host": "claude",
                "status": "active",
                "runs": [
                    {
                        "run_id": "r1",
                        "request_id": "req-1",
                        "kind": "implementation",
                        "status": "finished",
                        "runner_status": "completed",
                        "engine": "codex",
                        "model": "gpt-5.6-sol",
                        "result_path": str(result_path),
                    }
                ],
                "decisions": [],
            }
            mailbox.write(task_dir / "task.json", task_state)

            room = {
                "schema": "agent-executor.room.v1",
                "id": "room-advisor",
                "title": "Advisor Room",
                "cwd": str(home),
                "machine": host,
                "swarm": {"maxAgents": 8, "maxDepth": 3},
                "objective": "Ship advisor",
                "updatedAt": 3000,
                "conductor": {
                    "engine": "claude",
                    "role": "lead",
                    "status": "active",
                    "session": {"id": session_id, "engine": "claude", "machine": host, "cwd": str(home)},
                },
                "agents": [
                    {
                        "id": "w1",
                        "role": "worker",
                        "engine": "codex",
                        "status": "review",
                        "dispatch": {"taskDir": str(task_dir), "runId": "r1"},
                    }
                ],
            }
            mailbox.write(base / "rooms" / "room-advisor.json", room)

            mailbox.register(
                base,
                session=session_id,
                harness="claude",
                cwd=str(home),
                pid=os.getpid(),
                account=str(home),
            )
            hook_env = {
                **os.environ,
                "HOME": str(home),
                "CLAUDE_CONFIG_DIR": str(home),
                "ORKEST_SWARM_ROOM": "room-advisor",
            }

            def run_turn(sid, event="UserPromptSubmit", room_id="room-advisor"):
                out = ORK_FAST.run_mailbox_hook(
                    {"hook_event_name": event, "session_id": sid, "cwd": str(home)},
                    harness="claude",
                    base=base,
                    pid=os.getpid(),
                    env={**hook_env, "ORKEST_SWARM_ROOM": room_id},
                )
                return (out or {}).get("hookSpecificOutput", {}).get("additionalContext", "")

            # Turn 1: Initial reconnection banner
            first = run_turn(session_id)
            self.assertIn("Reconnected to swarm room room-advisor", first)

            # Turn 2: Emits Swarm next step advisor for reviewable run r1
            second = run_turn(session_id)
            self.assertIn("Swarm next step (room room-advisor", second)
            self.assertIn("[review] w1 finished run r1", second)

            # Turn 3 with unchanged state: deduplicated by swarmNextDigest -> no repeated advisor
            third = run_turn(session_id)
            self.assertNotIn("Swarm next step (room room-advisor", third)
            self.assertNotIn("Reconnected to swarm room room-advisor", third)

            # Add a queued agent -> digest changes -> advisor fires again
            room["agents"].append({"id": "w2", "role": "worker", "engine": "claude", "status": "queued"})
            mailbox.write(base / "rooms" / "room-advisor.json", room)
            fourth = run_turn(session_id)
            self.assertIn("Swarm next step (room room-advisor", fourth)

            # If conductor.md was missing on Turn 1 and is written later, the next turn delivers it
            # without repeating the reconnection summary that Turn 1 already emitted
            brief_dir = base / "swarm-briefs" / "room-advisor"
            brief_dir.mkdir(parents=True, exist_ok=True)
            (brief_dir / "conductor.md").write_text(
                "Coordinator brief for YOUR_ACTUAL_SESSION_ID\nRoute every action:",
                encoding="utf-8",
            )
            fifth = run_turn(session_id)
            self.assertIn("Coordinator brief for conductor-session-1234", fifth)
            self.assertIn("Route every action:", fifth)
            self.assertNotIn("Reconnected to swarm room room-advisor", fifth)

            # Unbound room with objective and conductor.md: SessionStart followed by UserPromptSubmit
            # marks swarmBriefed on SessionStart so the CLI-launched brief is not double-delivered
            unbound_room = {
                "id": "room-cli-brief",
                "title": "CLI brief room",
                "objective": "Ship feature once",
                "cwd": str(home),
                "swarm": {"maxAgents": 12, "maxDepth": 3},
                "conductor": {"engine": "claude", "role": "lead"},
                "agents": [],
            }
            mailbox.write(base / "rooms" / "room-cli-brief.json", unbound_room)
            cli_brief_dir = base / "swarm-briefs" / "room-cli-brief"
            cli_brief_dir.mkdir(parents=True, exist_ok=True)
            (cli_brief_dir / "conductor.md").write_text(
                "Coordinator brief for YOUR_ACTUAL_SESSION_ID\nRoute every action:",
                encoding="utf-8",
            )
            cli_session = "conductor-cli-launch-1"
            mailbox.register(
                base,
                session=cli_session,
                harness="claude",
                cwd=str(home),
                pid=os.getpid(),
                account=str(home),
            )
            start_out = run_turn(cli_session, event="SessionStart", room_id="room-cli-brief")
            self.assertNotIn("Coordinator brief for", start_out)
            cli_me2 = mailbox.load(mailbox.peer_path(base, cli_session))
            self.assertEqual(cli_me2.get("swarmBriefed"), "room-cli-brief")
            prompt_out = run_turn(cli_session, event="UserPromptSubmit", room_id="room-cli-brief")
            self.assertNotIn("Coordinator brief for", prompt_out)

    def test_side_command_hook_blocks_claude_prompt_and_stop_skips_turn_extended_spam(self):
        with tempfile.TemporaryDirectory(prefix="ork-side-hook-") as tmp:
            home = Path(tmp).resolve()
            base = home / "mailbox-v1"
            session_id = "claude-main-session-1"
            hook_env = {**os.environ, "HOME": str(home), "CLAUDE_CONFIG_DIR": str(home)}
            mailbox.register(
                base,
                session=session_id,
                harness="claude",
                cwd=str(home),
                pid=os.getpid(),
                account=str(home),
            )
            payload = {
                "session_id": session_id,
                "cwd": str(home),
                "hook_event_name": "UserPromptSubmit",
                "prompt": "/side --dry-run ask: why does token refresh retry twice?",
            }
            out = ORK_FAST.run_mailbox_hook(payload, harness="claude", base=base, pid=os.getpid(), env=hook_env)
            self.assertIsNotNone(out)
            self.assertEqual(out.get("decision"), "block")
            self.assertIn("Would investigate side mission", out.get("reason", ""))

            # Parent session inbox must remain completely untouched
            inbox_files = list(mailbox.inbox_dir(base, session_id).glob("*.json"))
            self.assertEqual(inbox_files, [])

            # Repeated Stop deliveries must deduplicate into at most 1 turn_extended feedback report
            mailbox.register(
                base,
                session=session_id,
                harness="claude",
                cwd=str(home),
                pid=os.getpid(),
                state="busy",
                account=str(home),
            )
            sender = mailbox.register(
                base,
                session="peer-sender-2",
                harness="codex",
                cwd=str(home),
                pid=os.getpid(),
                account=str(home),
            )
            mailbox.send(
                base,
                sender=sender,
                to=session_id,
                text="Quick update from peer 1",
                scope="cross-project",
            )
            stop_out = ORK_FAST.run_mailbox_hook(
                {"session_id": session_id, "cwd": str(home), "hook_event_name": "Stop"},
                harness="claude",
                base=base,
                pid=os.getpid(),
                env=hook_env,
            )
            self.assertIsNotNone(stop_out)
            self.assertEqual(stop_out.get("decision"), "block")
            mailbox.send(
                base,
                sender=sender,
                to=session_id,
                text="Another longer update from peer 2",
                scope="cross-project",
            )
            stop_out_2 = ORK_FAST.run_mailbox_hook(
                {"session_id": session_id, "cwd": str(home), "hook_event_name": "Stop"},
                harness="claude",
                base=base,
                pid=os.getpid(),
                env=hook_env,
            )
            self.assertIsNotNone(stop_out_2)
            fb_dir = mailbox.feedback_module().directory(base)
            feedback_files = list(fb_dir.glob("*.json")) if fb_dir and fb_dir.exists() else []
            self.assertEqual(len(feedback_files), 1)

    def test_agy_subagent_launch_never_promotes_or_reopens_swarm_view(self):
        with tempfile.TemporaryDirectory(prefix="ork-agy-subagent-") as tmp:
            home = Path(tmp).resolve()
            base = home / "mailbox-v1"
            account = home / ".gemini"
            state_file = home / "herdr-state.json"
            herdr_bin = self._write_fake_herdr(home, state_file)
            brain_dir = account / "antigravity-cli" / "brain"
            db_path = account / "antigravity-cli" / "conversation_summaries.db"
            db_path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(db_path) as con:
                con.execute(
                    "CREATE TABLE conversation_summaries ("
                    "conversation_id TEXT PRIMARY KEY, "
                    "parent_conversation_id TEXT NOT NULL DEFAULT '', "
                    "nesting_depth INTEGER NOT NULL DEFAULT 0, "
                    "agent_name TEXT NOT NULL DEFAULT '')"
                )
                con.execute(
                    "CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL)"
                )

            parent_sid = "11111111-2222-4333-8444-555555555555"
            state_doc = json.loads(state_file.read_text())
            state_doc["agent_session"] = parent_sid
            state_file.write_text(json.dumps(state_doc))
            room_id = "room-parent-agy"
            cwd = str(home)
            mailbox.register(
                base,
                session=parent_sid,
                harness="gemini",
                cwd=cwd,
                pid=os.getpid(),
                state="busy",
                account=str(account),
            )
            mailbox.annotate(
                base,
                parent_sid,
                herdrPaneId="w1:p1",
                herdrWorkspaceId="w1",
                herdrEndpoint=str(home / "herdr.sock"),
                herdrBinary=str(herdr_bin),
            )
            room_store.put_room(
                base,
                {
                    "schema": "agent-executor.room.v1",
                    "id": room_id,
                    "cwd": cwd,
                    "machine": socket.gethostname(),
                    "swarm": {"maxAgents": 12, "maxDepth": 3},
                    "title": "",
                    "objective": "",
                    "agents": [],
                    "herdrCoordinatorPaneId": "w1:p1",
                    "herdrViewPaneId": "w1:p2",
                    "herdrEndpoint": str(home / "herdr.sock"),
                    "conductor": {
                        "engine": "agy",
                        "role": "lead",
                        "status": "working",
                        "session": {"id": parent_sid, "engine": "agy", "cwd": cwd, "machine": socket.gethostname()},
                    },
                },
            )

            env = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": str(home),
                "GEMINI_CLI_HOME": str(account),
                "AGENT_EXECUTOR_HOME": str(home),
                "ORCHESTRATE_HOME": str(home),
                "HERDR_ENV": "1",
                "HERDR_PANE_ID": "w1:p1",
                "HERDR_WORKSPACE_ID": "w1",
                "HERDR_BIN_PATH": str(herdr_bin),
                "HERDR_SOCKET_PATH": str(home / "herdr.sock"),
                "ORKEST_RESUME_SWARM": "1",
                "ORKEST_SWARM_ROOM": room_id,
            }

            # A. SQLite parent lineage catches subagent even when transcript only has EPHEMERAL_MESSAGE
            sub_a = "aaaa1111-2222-4333-8444-555555555551"
            with sqlite3.connect(db_path) as con:
                con.execute(
                    "INSERT INTO conversation_summaries VALUES (?, ?, 1, 'hyd-worker')",
                    (sub_a, parent_sid),
                )
            t_a = brain_dir / sub_a / ".system_generated" / "logs" / "transcript.jsonl"
            t_a.parent.mkdir(parents=True, exist_ok=True)
            t_a.write_text(
                json.dumps({"step_index": 0, "type": "EPHEMERAL_MESSAGE", "content": "hi"}) + "\n",
                encoding="utf-8",
            )
            ORK_FAST.run_mailbox_hook(
                {"conversationId": sub_a, "workspacePaths": [cwd], "transcriptPath": str(t_a)},
                harness="gemini",
                event="SessionStart",
                base=base,
                pid=os.getpid(),
                env=env,
                allow_herdr=True,
            )
            ORK_FAST.run_mailbox_hook(
                {
                    "conversationId": sub_a,
                    "invocationNum": 1,
                    "workspacePaths": [cwd],
                    "transcriptPath": str(t_a),
                },
                harness="gemini",
                event="PreInvocation",
                base=base,
                pid=os.getpid(),
                env=env,
                allow_herdr=True,
            )
            peer_a = mailbox.load(mailbox.peer_path(base, sub_a))
            self.assertTrue(peer_a.get("isSubagent"))
            self.assertEqual(peer_a.get("parentSession"), parent_sid)
            self.assertEqual(peer_a.get("focus"), "native hyd-worker")
            self.assertIsNone(peer_a.get("herdrPaneId"))
            self.assertIsNone(peer_a.get("agySubagentPending"))
            prog_a = mailbox.load(base / "progress" / f"{mailbox.session_key(sub_a)}.json")
            self.assertIsNotNone(prog_a)
            self.assertEqual(prog_a.get("stage"), "working")
            self.assertEqual(prog_a.get("goal"), "Native hyd-worker")
            ORK_FAST.run_mailbox_hook(
                {
                    "conversationId": sub_a,
                    "terminationReason": "NO_TOOL_CALL",
                    "workspacePaths": [cwd],
                    "transcriptPath": str(t_a),
                },
                harness="gemini",
                event="Stop",
                base=base,
                pid=os.getpid(),
                env=env,
                allow_herdr=True,
            )
            prog_a_done = mailbox.load(base / "progress" / f"{mailbox.session_key(sub_a)}.json")
            self.assertEqual(prog_a_done.get("stage"), "complete")
            herdr_calls = json.loads(state_file.read_text())["calls"]
            self.assertTrue(any(c[:3] == ["pane", "report-metadata", "w1:p1"] for c in herdr_calls))

            # B. Co-hosted busy parent transcript with invoke_subagent classifies subagent without SQLite
            sub_b = "bbbb1111-2222-4333-8444-555555555552"
            parent_t = brain_dir / parent_sid / ".system_generated" / "logs" / "transcript.jsonl"
            parent_t.parent.mkdir(parents=True, exist_ok=True)
            parent_t.write_text(
                json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "content": "go"})
                + "\n"
                + json.dumps(
                    {
                        "step_index": 1,
                        "type": "PLANNER_RESPONSE",
                        "tool_calls": [{"name": "invoke_subagent", "args": {"Role": "Scout"}}],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            ORK_FAST.run_mailbox_hook(
                {"conversationId": sub_b, "workspacePaths": [cwd]},
                harness="gemini",
                event="SessionStart",
                base=base,
                pid=os.getpid(),
                env=env,
                allow_herdr=True,
            )
            peer_b = mailbox.load(mailbox.peer_path(base, sub_b))
            self.assertTrue(peer_b.get("isSubagent"))
            self.assertEqual(peer_b.get("parentSession"), parent_sid)

            # C. Delayed transcript without invoke_subagent tool call marks agySubagentPending, then resolves
            parent_t.write_text(
                json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "content": "next"})
                + "\n",
                encoding="utf-8",
            )
            sub_c = "cccc1111-2222-4333-8444-555555555553"
            t_c = brain_dir / sub_c / ".system_generated" / "logs" / "transcript.jsonl"
            t_c.parent.mkdir(parents=True, exist_ok=True)
            t_c.write_text(
                json.dumps({"step_index": 0, "type": "EPHEMERAL_MESSAGE", "content": "ephemeral"}) + "\n",
                encoding="utf-8",
            )
            ORK_FAST.run_mailbox_hook(
                {"conversationId": sub_c, "workspacePaths": [cwd], "transcriptPath": str(t_c)},
                harness="gemini",
                event="SessionStart",
                base=base,
                pid=os.getpid(),
                env=env,
                allow_herdr=True,
            )
            peer_c0 = mailbox.load(mailbox.peer_path(base, sub_c))
            self.assertTrue(peer_c0.get("agySubagentPending"))
            self.assertFalse(peer_c0.get("isSubagent"))

            with t_c.open("a", encoding="utf-8") as handle:
                handle.write(
                    json.dumps(
                        {
                            "step_index": 1,
                            "type": "SYSTEM_MESSAGE",
                            "content": (
                                "<SYSTEM_MESSAGE>\n"
                                f"[Message] timestamp=2026-11-15T00:00:00Z sender={parent_sid} "
                                "priority=HIGH content=inspect"
                            ),
                        }
                    )
                    + "\n"
                )
            ORK_FAST.run_mailbox_hook(
                {
                    "conversationId": sub_c,
                    "invocationNum": 1,
                    "workspacePaths": [cwd],
                    "transcriptPath": str(t_c),
                },
                harness="gemini",
                event="PreInvocation",
                base=base,
                pid=os.getpid(),
                env=env,
                allow_herdr=True,
            )
            peer_c1 = mailbox.load(mailbox.peer_path(base, sub_c))
            self.assertTrue(peer_c1.get("isSubagent"))
            self.assertEqual(peer_c1.get("parentSession"), parent_sid)
            self.assertIsNone(peer_c1.get("agySubagentPending"))

            final_calls = json.loads(state_file.read_text())["calls"]
            self.assertEqual([c for c in final_calls if c[:3] == ["plugin", "pane", "open"]], [])
            self.assertEqual([r["id"] for r in room_store.list_rooms(base)], [room_id])

    def test_resumed_agy_parent_records_auto_reconnect_and_respects_closed_marker(self):
        import agent_statusline_tmux
        import herdr_swarm_restore

        with tempfile.TemporaryDirectory(prefix="ork-agy-reconnect-") as tmp:
            home = Path(tmp).resolve()
            base = home / "mailbox-v1"
            account = home / ".gemini"
            state_file = home / "herdr-state.json"
            herdr_bin = self._write_fake_herdr(home, state_file)
            parent_sid = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee"
            room_id = "room-agy-resume"
            cwd = str(home)
            sock_path = str(home / "herdr.sock")

            parent_t = (
                account / "antigravity-cli" / "brain" / parent_sid / ".system_generated" / "logs" / "transcript.jsonl"
            )
            parent_t.parent.mkdir(parents=True, exist_ok=True)
            parent_t.write_text(
                json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "content": "work"})
                + "\n",
                encoding="utf-8",
            )
            mailbox.register(base, session=parent_sid, harness="gemini", cwd=cwd, pid=os.getpid(), account=str(account))
            room_store.put_room(
                base,
                {
                    "schema": "agent-executor.room.v1",
                    "id": room_id,
                    "cwd": cwd,
                    "machine": socket.gethostname(),
                    "swarm": {"maxAgents": 12, "maxDepth": 3},
                    "title": "New swarm",
                    "objective": "",
                    "agents": [],
                    "herdrCoordinatorPaneId": "w1:p1",
                    "herdrEndpoint": sock_path,
                    "conductor": {
                        "engine": "agy",
                        "role": "lead",
                        "status": "working",
                        "session": {"id": parent_sid, "engine": "agy", "cwd": cwd, "machine": socket.gethostname()},
                    },
                },
            )
            env = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": str(home),
                "GEMINI_CLI_HOME": str(account),
                "AGENT_EXECUTOR_HOME": str(home),
                "ORCHESTRATE_HOME": str(home),
                "HERDR_ENV": "1",
                "HERDR_PANE_ID": "w1:p1",
                "HERDR_WORKSPACE_ID": "w1",
                "HERDR_BIN_PATH": str(herdr_bin),
                "HERDR_SOCKET_PATH": sock_path,
                "ORKEST_TEST_ALLOW_HERDR": "1",
                "ORKEST_RESUME_SWARM": "1",
                "ORKEST_SWARM_ROOM": room_id,
            }
            with (
                patch.dict(os.environ, env, clear=True),
                patch.object(mailbox, "harness_pid", return_value=os.getpid()),
            ):
                # Turn 1 opens the view pane once and persists swarmAutoReconnected even with empty objective/agents
                ORK_FAST.run_mailbox_hook(
                    {"conversationId": parent_sid, "workspacePaths": [cwd], "transcriptPath": str(parent_t)},
                    harness="gemini",
                    event="SessionStart",
                    base=base,
                    pid=os.getpid(),
                    env=env,
                    allow_herdr=True,
                )
                first_calls = json.loads(state_file.read_text())["calls"]
                open_calls = [c for c in first_calls if c[:3] == ["plugin", "pane", "open"]]
                self.assertEqual(len(open_calls), 1)
                peer_after_start = mailbox.load(mailbox.peer_path(base, parent_sid))
                self.assertEqual(peer_after_start.get("swarmAutoReconnected"), f"{room_id}:w1:p1")

                # Explicit close writes .closed marker
                closed = agent_statusline_tmux.toggle_swarm_view("close", room=room_id, base=base)
                self.assertEqual(closed["status"], "closed")
                view_state = herdr_swarm_restore.state_path(home, room_id, env)
                self.assertTrue(view_state.with_suffix(".closed").exists())

                # Turn 2 after Stop -> PreInvocation must not reopen view
                ORK_FAST.run_mailbox_hook(
                    {
                        "conversationId": parent_sid,
                        "terminationReason": "NO_TOOL_CALL",
                        "workspacePaths": [cwd],
                        "transcriptPath": str(parent_t),
                    },
                    harness="gemini",
                    event="Stop",
                    base=base,
                    pid=os.getpid(),
                    env=env,
                    allow_herdr=True,
                )
                ORK_FAST.run_mailbox_hook(
                    {
                        "conversationId": parent_sid,
                        "invocationNum": 2,
                        "workspacePaths": [cwd],
                        "transcriptPath": str(parent_t),
                    },
                    harness="gemini",
                    event="PreInvocation",
                    base=base,
                    pid=os.getpid(),
                    env=env,
                    allow_herdr=True,
                )
                calls_after_wake = json.loads(state_file.read_text())["calls"]
                self.assertEqual(len([c for c in calls_after_wake if c[:3] == ["plugin", "pane", "open"]]), 1)

                # Even if swarmAutoReconnected is reset, respect_closed=True still honors the user's .closed marker
                mailbox.annotate(base, parent_sid, swarmAutoReconnected=None)
                ORK_FAST.run_mailbox_hook(
                    {"conversationId": parent_sid, "workspacePaths": [cwd], "transcriptPath": str(parent_t)},
                    harness="gemini",
                    event="SessionStart",
                    base=base,
                    pid=os.getpid(),
                    env=env,
                    allow_herdr=True,
                )
                calls_after_reset = json.loads(state_file.read_text())["calls"]
                self.assertEqual(len([c for c in calls_after_reset if c[:3] == ["plugin", "pane", "open"]]), 1)

                # Explicit user open clears .closed and reopens the view pane
                reopened = agent_statusline_tmux.toggle_swarm_view("open", room=room_id, base=base)
                self.assertEqual(reopened["status"], "opened")
                calls_after_explicit = json.loads(state_file.read_text())["calls"]
                self.assertEqual(len([c for c in calls_after_explicit if c[:3] == ["plugin", "pane", "open"]]), 2)
                self.assertFalse(view_state.with_suffix(".closed").exists())

    def test_herdr_toggle_maps_subagent_pane_session_back_to_parent_room(self):
        import agent_statusline_tmux

        with tempfile.TemporaryDirectory(prefix="ork-herdr-sub-toggle-") as tmp:
            home = Path(tmp).resolve()
            base = home / "mailbox-v1"
            state_file = home / "herdr-state.json"
            herdr_bin = self._write_fake_herdr(home, state_file)
            parent_sid = "parent-agy-1111"
            sub_sid = "subagent-agy-2222"
            sock_path = str(home / "herdr.sock")

            mailbox.register(base, session=parent_sid, harness="gemini", cwd=str(home), pid=os.getpid())
            mailbox.annotate(base, parent_sid, herdrPaneId="w1:p1", herdrEndpoint=sock_path)
            mailbox.register(base, session=sub_sid, harness="gemini", cwd=str(home), pid=os.getpid())
            mailbox.annotate(base, sub_sid, isSubagent=True, parentSession=parent_sid)

            env = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": str(home),
                "AGENT_EXECUTOR_HOME": str(home),
                "ORCHESTRATE_HOME": str(home),
                "HERDR_ENV": "1",
                "HERDR_PANE_ID": "w1:p1",
                "HERDR_WORKSPACE_ID": "w1",
                "HERDR_BIN_PATH": str(herdr_bin),
                "HERDR_SOCKET_PATH": sock_path,
                "ORKEST_TEST_ALLOW_HERDR": "1",
            }
            with patch.dict(os.environ, env, clear=True):
                opened = agent_statusline_tmux.toggle_swarm_view("open", session_id=parent_sid, base=base)
                self.assertEqual(opened["status"], "opened")
                parent_room_id = opened["room"]

                # Simulate Herdr hook reporting the subagent conversation ID onto the parent's pane
                fake_state = json.loads(state_file.read_text())
                fake_state["agent_session"] = {"kind": "id", "agent": "agy", "value": sub_sid}
                state_file.write_text(json.dumps(fake_state))

                toggled = agent_statusline_tmux.toggle_swarm_view("toggle", base=base)
                self.assertEqual(toggled["status"], "closed")
                self.assertEqual(toggled["room"], parent_room_id)
                self.assertEqual([r["id"] for r in room_store.list_rooms(base)], [parent_room_id])


if __name__ == "__main__":
    unittest.main()
