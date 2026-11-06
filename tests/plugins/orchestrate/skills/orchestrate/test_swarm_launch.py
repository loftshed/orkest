"""A real Stooges terminal launches once, shows live work, and reconnects without another agent."""

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
import subprocess
import sys
import tempfile
import termios
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
CLI = SCRIPTS.parents[2] / "bin/ork.mjs"
sys.path.insert(0, str(SCRIPTS))
import agent_progress as progress  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402
import room_store  # noqa: E402
import swarm_status  # noqa: E402


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
                mock.patch.object(agent_statusline_tmux, "_herdr_active", return_value=False),
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
            binary.write_text(
                "#!" + sys.executable + "\n"
                "import json, os, re, subprocess, sys\nfrom pathlib import Path\n"
                "room = os.environ.get('ORKEST_SWARM_ROOM') or re.search(r'Room: ([^\\n]+)', sys.argv[-1]).group(1)\n"
                + (
                    "hook_out = json.loads(subprocess.check_output(["
                    + repr(sys.executable)
                    + ", "
                    + repr(str(SCRIPTS / "peer_mailbox.py"))
                    + ", 'hook', '--harness', "
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
                            sys.executable,
                            str(SCRIPTS / "agent_statusline.py"),
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
                "PATH": str(home) + os.pathsep + os.environ["PATH"],
                "TERM": "xterm-256color",
                "CODEX_HOME": str(home),
                "MONITOR_CACHE_DIR": str(home / "monitor"),
            }
            for key in ("HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH"):
                environment.pop(key, None)
            clients = []

            def launch(arguments, command="stooges"):
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
            peer = mailbox.annotate(base, current_session, herdrPaneId="w1:p1", herdrWorkspaceId="w1")
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

    def test_new_coordinator_reuses_its_existing_herdr_view_pane_for_a_new_room(self):
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
            self.assertEqual(opened["pane"], old_view)
            state = json.loads((home / "herdr-state.json").read_text())
            self.assertEqual(len([call for call in state["calls"] if call[:2] == ["pane", "split"]]), 1)
            self.assertIn(["pane", "send-keys", old_view, "q"], state["calls"])
            self.assertIn(f"AGENT_EXECUTOR_HOME={home}", state["runs"][-1]["command"])
            self.assertIsNone(room_store.read_room(base, "previous-room").get("herdrViewPaneId"))
            self.assertEqual(room_store.read_room(base, opened["room"])["herdrViewPaneId"], old_view)
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
            self.assertNotIn(["pane", "send-keys", old_view, "q"], state["calls"])
            self.assertEqual(room_store.read_room(base, "previous-room")["herdrViewPaneId"], old_view)

    def test_explicitly_attached_room_keeps_its_original_coordinator_and_workers(self):
        import agent_statusline_tmux

        with self._reused_pane_room() as (home, base, previous, session):
            opened = agent_statusline_tmux.toggle_swarm_view(
                "open", room=previous["id"], session_id=session, harness="codex", cwd=str(home), base=base
            )
            self.assertEqual(opened["room"], previous["id"])
            persisted = room_store.read_room(base, "previous-room")
            self.assertEqual(persisted["conductor"], previous["conductor"])
            self.assertEqual(persisted["agents"], previous["agents"])
            self.assertEqual(persisted["messages"], previous["messages"])

    def test_resume_alias_reuses_the_previous_room_instead_of_creating_another(self):
        import agent_statusline_tmux

        with self._reused_pane_room() as (home, base, previous, session):
            mailbox.annotate(base, session, aliases=[previous["conductor"]["session"]["id"]])
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
            "if args[:2] == ['pane', 'split']:\n"
            "    pane_id = f\"w1:p{state['next_id']}\"\n"
            "    state['next_id'] += 1\n"
            "    state['panes'].append(pane_id)\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'ok': True, 'result': {'pane': {'pane_id': pane_id}}}))\n"
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
            "    print(json.dumps({'ok': True, 'result': {'pane': {'pane_id': target}}}))\n"
            "elif args[:2] == ['pane', 'close']:\n"
            "    target = args[args.index('--pane') + 1] if '--pane' in args else args[2]\n"
            "    if target in state['panes']:\n"
            "        state['panes'].remove(target)\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'ok': True}))\n"
            "else:\n"
            "    state_path.write_text(json.dumps(state))\n"
            "    print(json.dumps({'ok': True}))\n"
        )
        herdr_bin.chmod(0o755)
        return herdr_bin

    @unittest.skipUnless(shutil.which("tmux"), "Herdr coordinator launch requires tmux")
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
            binary.write_text(
                "#!" + sys.executable + "\n"
                "import json, os, subprocess, sys, time\nfrom pathlib import Path\n"
                "hook_out = json.loads(subprocess.check_output(["
                + repr(sys.executable)
                + ", "
                + repr(str(SCRIPTS / "peer_mailbox.py"))
                + ", 'hook', '--harness', 'claude'], input=json.dumps({"
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
            server = None
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
                server = info["server"]
                self.assertTrue(info["tmux"])
                self.assertRegex(server, r"^orkest-label-[0-9a-f]{12}$")
                self.assertEqual(info["harness"], "claude")
                self.assertEqual(info["herdr_pane"], "w1:p1")
                options = ["tmux", "-L", server, "show-option", "-t", "orkest", "-v"]
                status_format = subprocess.check_output([*options, "status-format[0]"], text=True)
                self.assertIn("agent_statusline.py", status_format)
                self.assertIn("--terminal-pane", status_format)
                self.assertEqual(subprocess.check_output([*options, "status-position"], text=True).strip(), "bottom")
                self.assertEqual(subprocess.check_output([*options, "destroy-unattached"], text=True).strip(), "on")
                self.assertEqual(
                    len(
                        subprocess.check_output(
                            ["tmux", "-L", server, "list-panes", "-t", "orkest"], text=True
                        ).splitlines()
                    ),
                    1,
                )

                peer_record = mailbox.load(mailbox.peer_path(base, session_id))
                self.assertEqual(peer_record["herdrPaneId"], "w1:p1")
                self.assertEqual(peer_record["herdrWorkspaceId"], "w1")

                state = json.loads(state_file.read_text())
                self.assertIn("w1:p2", state["panes"])
                self.assertTrue(
                    any(
                        call[:2] == ["pane", "split"] and "--no-focus" in call and "--direction" in call
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
                finally:
                    os.environ.clear()
                    os.environ.update(old_environ)
            finally:
                if server:
                    subprocess.run(["tmux", "-L", server, "kill-server"], capture_output=True, check=False)
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
            agent_statusline_tmux.extract_resumed_session_id(["plaude", "-r", sid]),
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

    def test_resumed_session_reconnects_to_previous_swarm_room_and_history(self):
        import agent_statusline_tmux
        import mailbox_hooks

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

            me = mailbox.register(
                base,
                session=session_id,
                harness="claude",
                cwd=str(home),
                pid=os.getpid(),
                account=str(home),
            )
            old_env = os.environ.get("ORKEST_SWARM_ROOM")
            try:
                os.environ.pop("ORKEST_SWARM_ROOM", None)
                summary = mailbox_hooks.swarm_coordinator_context(base, me, "UserPromptSubmit")
                self.assertIn("Reconnected to swarm room room-newer (Active Horde)", summary)
                self.assertIn("Objective: Ship wave 65.", summary)
                self.assertIn("2 total (1 active, 1 completed, 0 blocked/failed)", summary)

                # Subsequent turns in the same process/terminal do not repeat the reconnection banner
                me_reloaded = mailbox.load(mailbox.peer_path(base, session_id))
                second = mailbox_hooks.swarm_coordinator_context(base, me_reloaded, "UserPromptSubmit")
                self.assertEqual(second, "")

                # A /clear handover session with aliases inherits and rebinds the swarm room
                cleared_sid = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee"
                cleared_me = mailbox.register(
                    base,
                    session=cleared_sid,
                    harness="claude",
                    cwd=str(home),
                    pid=os.getpid() + 1,
                    account=str(home),
                )
                cleared_me = mailbox.annotate(base, cleared_sid, aliases=[session_id], clearedFrom=session_id)
                cleared_summary = mailbox_hooks.swarm_coordinator_context(base, cleared_me, "SessionStart")
                self.assertIn("Reconnected to swarm room room-newer (Active Horde)", cleared_summary)
                updated_room = room_store.read_room(base, "room-newer")
                self.assertEqual(updated_room["conductor"]["session"]["id"], cleared_sid)
                self.assertIn(session_id, updated_room["conductor"]["previousSessions"])
            finally:
                if old_env is not None:
                    os.environ["ORKEST_SWARM_ROOM"] = old_env

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
            mailbox.annotate(base, parent["session"], herdrPaneId="w1:p1", lastSeenAt="2026-11-04T05:00:00Z")
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
                lastSeenAt="2026-11-04T05:05:00Z",
            )
            found_via_subagent = agent_statusline_tmux._find_herdr_peer(base, "child-session-2222", "w1:p1")
            self.assertIsNotNone(found_via_subagent)
            self.assertEqual(found_via_subagent["session"], "parent-session-1111")
            found = agent_statusline_tmux._find_herdr_peer(base, None, "w1:p1")
            self.assertIsNotNone(found)
            self.assertEqual(found["session"], "parent-session-1111")

    def test_agy_subagent_detection_and_clear_handover_transfer(self):
        import agent_progress
        import mailbox_hooks

        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
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
            self.assertEqual(
                mailbox_hooks._agy_subagent_info(str(sub_transcript)),
                (True, "11111111-2222-3333-4444-555555555555"),
            )
            self.assertEqual(mailbox_hooks._agy_subagent_info(str(top_transcript)), (False, None))

            # Verify adopt_cleared transfers focus, progress, and board.json references
            old_sid = "old-session-aaaa-1111"
            new_sid = "new-session-bbbb-2222"
            old_peer = mailbox.register(base, session=old_sid, harness="claude", cwd=str(home), pid=os.getpid())
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
            mailbox_hooks._end_session(base, old_sid, pid=os.getpid(), reason="clear")
            new_peer = mailbox.register(base, session=new_sid, harness="claude", cwd=str(home), pid=os.getpid())
            temp_name = new_peer["name"]
            notice = mailbox_hooks.adopt_cleared(base, new_peer)
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
        import mailbox_hooks

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

            me = mailbox.register(
                base,
                session=session_id,
                harness="claude",
                cwd=str(home),
                pid=os.getpid(),
                account=str(home),
            )
            old_env = os.environ.get("ORKEST_SWARM_ROOM")
            try:
                os.environ["ORKEST_SWARM_ROOM"] = "room-advisor"
                # Turn 1: Initial reconnection banner
                first = mailbox_hooks.swarm_coordinator_context(base, me, "UserPromptSubmit")
                self.assertIn("Reconnected to swarm room room-advisor", first)

                # Turn 2: Emits Swarm next step advisor for reviewable run r1
                me2 = mailbox.load(mailbox.peer_path(base, session_id))
                second = mailbox_hooks.swarm_coordinator_context(base, me2, "UserPromptSubmit")
                self.assertIn("Swarm next step (room room-advisor", second)
                self.assertIn("[review] w1 finished run r1", second)

                # Turn 3 with unchanged state: deduplicated by swarmNextDigest -> returns ""
                me3 = mailbox.load(mailbox.peer_path(base, session_id))
                third = mailbox_hooks.swarm_coordinator_context(base, me3, "UserPromptSubmit")
                self.assertEqual(third, "")

                # Add a queued agent -> digest changes -> advisor fires again
                room["agents"].append({"id": "w2", "role": "worker", "engine": "claude", "status": "queued"})
                mailbox.write(base / "rooms" / "room-advisor.json", room)
                me4 = mailbox.load(mailbox.peer_path(base, session_id))
                fourth = mailbox_hooks.swarm_coordinator_context(base, me4, "UserPromptSubmit")
                self.assertIn("Swarm next step (room room-advisor", fourth)

                # If conductor.md was missing on Turn 1 and is written later, the next turn delivers it
                # without repeating the reconnection summary that Turn 1 already emitted
                brief_dir = base / "swarm-briefs" / "room-advisor"
                brief_dir.mkdir(parents=True, exist_ok=True)
                (brief_dir / "conductor.md").write_text(
                    "Coordinator brief for YOUR_ACTUAL_SESSION_ID\nRoute every action:",
                    encoding="utf-8",
                )
                me5 = mailbox.load(mailbox.peer_path(base, session_id))
                fifth = mailbox_hooks.swarm_coordinator_context(base, me5, "UserPromptSubmit")
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
                cli_me = mailbox.register(
                    base,
                    session=cli_session,
                    harness="claude",
                    cwd=str(home),
                    pid=os.getpid(),
                    account=str(home),
                )
                os.environ["ORKEST_SWARM_ROOM"] = "room-cli-brief"
                start_out = mailbox_hooks.swarm_coordinator_context(base, cli_me, "SessionStart")
                self.assertEqual(start_out, "")
                cli_me2 = mailbox.load(mailbox.peer_path(base, cli_session))
                self.assertEqual(cli_me2.get("swarmBriefed"), "room-cli-brief")
                prompt_out = mailbox_hooks.swarm_coordinator_context(base, cli_me2, "UserPromptSubmit")
                self.assertNotIn("Coordinator brief for", prompt_out)
                self.assertEqual(prompt_out, "")
            finally:
                if old_env is not None:
                    os.environ["ORKEST_SWARM_ROOM"] = old_env
                else:
                    os.environ.pop("ORKEST_SWARM_ROOM", None)

    def test_side_command_hook_blocks_claude_prompt_and_stop_skips_turn_extended_spam(self):
        import mailbox_hooks

        with tempfile.TemporaryDirectory(prefix="ork-side-hook-") as tmp:
            home = Path(tmp).resolve()
            base = home / "mailbox-v1"
            session_id = "claude-main-session-1"
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
            out = mailbox_hooks.hook(payload, harness="claude", event="UserPromptSubmit", base=base)
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
            stop_out = mailbox_hooks.hook(
                {"session_id": session_id, "cwd": str(home), "hook_event_name": "Stop"},
                harness="claude",
                event="Stop",
                base=base,
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
            stop_out_2 = mailbox_hooks.hook(
                {"session_id": session_id, "cwd": str(home), "hook_event_name": "Stop"},
                harness="claude",
                event="Stop",
                base=base,
            )
            self.assertIsNotNone(stop_out_2)
            fb_dir = mailbox.feedback_module().directory(base)
            feedback_files = list(fb_dir.glob("*.json")) if fb_dir and fb_dir.exists() else []
            self.assertEqual(len(feedback_files), 1)


if __name__ == "__main__":
    unittest.main()
