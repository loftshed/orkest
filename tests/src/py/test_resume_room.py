"""Resume ownership survives the original process and its mailbox registration."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[3] / "src/py"
TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))
sys.path.insert(0, str(SCRIPTS))
import _ork_fast_test_helpers as ORK_FAST  # noqa: E402
import agent_statusline_tmux as terminal  # noqa: E402
import agent_terminal  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402
import room_store  # noqa: E402
import swarm_status  # noqa: E402

CLI = SCRIPTS.parents[1] / "src/bin/ork.mjs"


class ResumeRoomTests(unittest.TestCase):
    def environment(self, home):
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("ORKEST_", "HERDR_", "AGENT_MAILBOX_"))
        }
        environment.update(
            HOME=str(home),
            AGENT_EXECUTOR_HOME=str(home),
            ORCHESTRATE_HOME=str(home),
            CLAUDE_CONFIG_DIR=str(home / ".claude"),
            CODEX_HOME=str(home / ".codex"),
            GEMINI_CLI_HOME=str(home / ".gemini"),
            HERDR_ENV="0",
            PYTHONPATH=str(SCRIPTS),
            ORKEST_NODE_BIN=room_store._node_binary(),
            ORKEST_SCRIPTS_DIR=str(SCRIPTS),
            ORKEST_PLUGIN_ROOT=str(SCRIPTS.parents[1] / "plugins/orchestrate"),
            ORK_FAST_BIN=str(ORK_FAST.find_ork_fast_bin()),
        )
        return environment

    def _hook_notice(self, base, peer_or_sid, harness="claude", event="SessionStart", *, env=None, cwd=None):
        sid = peer_or_sid["session"] if isinstance(peer_or_sid, dict) else peer_or_sid
        peer_cwd = peer_or_sid.get("cwd") if isinstance(peer_or_sid, dict) else None
        resolved_cwd = str(cwd or peer_cwd or base.parent)
        if harness == "gemini":
            payload = {"conversationId": sid, "workspacePaths": [resolved_cwd]}
            if event == "PreInvocation":
                payload.update({"invocationNum": 1, "lastUserInput": "hi"})
        else:
            payload = {"hook_event_name": event, "session_id": sid, "cwd": resolved_cwd}
        output = ORK_FAST.run_mailbox_hook(
            payload,
            harness=harness,
            event=event if harness == "gemini" else None,
            base=base,
            pid=os.getpid(),
            env=env,
        )
        if not output:
            return ""
        if "hookSpecificOutput" in output:
            return output["hookSpecificOutput"].get("additionalContext", "")
        if "injectSteps" in output:
            return "\n".join(step["ephemeralMessage"] for step in output["injectSteps"] if "ephemeralMessage" in step)
        return ""

    def test_new_process_resumes_after_session_end_removed_old_peer(self):
        initial = """
import json, os, subprocess
from pathlib import Path
import peer_mailbox as mailbox, room_store
base = mailbox.root()
harness = os.environ['TEST_HARNESS']
mailbox.register(base, session='old-native', harness=harness,
                 cwd=os.environ['HOME'], pid=os.getpid(), account=os.environ['HOME'])
result = subprocess.run([room_store._node_binary(), os.environ['TEST_CLI'], 'hall', 'promote',
                         '--session', 'old-native', '--cwd', os.environ['HOME'],
                         '--objective', 'Finish the resume repair'], check=True, capture_output=True, text=True)
room = json.loads(result.stdout)['room']
end_env = {**os.environ, 'ORKEST_TEST_MODE': '1', 'ORKEST_TEST_HARNESS_PID': str(os.getpid())}
end_cmd = [os.environ['ORK_FAST_BIN'], 'mailbox-hook', '--harness', harness]
if harness == 'gemini':
    end_cmd.extend(['--event', 'SessionEnd'])
    end_payload = {'conversationId': 'old-native', 'workspacePaths': [os.environ['HOME']], 'reason': 'closed'}
else:
    end_payload = {'hook_event_name': 'SessionEnd', 'session_id': 'old-native', 'cwd': os.environ['HOME'], 'reason': 'closed'}
subprocess.run(end_cmd, input=json.dumps(end_payload), env=end_env, check=True, capture_output=True, text=True)
print(json.dumps({'room': room['id'], 'oldPeerExists': mailbox.peer_path(base, 'old-native').exists()}))
"""
        resumed = """
import json, os, subprocess
import peer_mailbox as mailbox, room_store, swarm_status
base = mailbox.root()
harness = os.environ['TEST_HARNESS']
peer = mailbox.register(base, session='new-native', harness=harness,
                        cwd=os.environ['HOME'], pid=os.getpid(), account=os.environ['HOME'])
peer = mailbox.annotate(base, peer['session'], model='resume-model', focus='Restore the coordinator header')
hook_env = {**os.environ, 'ORKEST_TEST_MODE': '1', 'ORKEST_TEST_HARNESS_PID': str(os.getpid())}
hook_cmd = [os.environ['ORK_FAST_BIN'], 'mailbox-hook', '--harness', harness]
if harness == 'gemini':
    hook_cmd.extend(['--event', 'SessionStart'])
    hook_payload = {'conversationId': 'new-native', 'workspacePaths': [os.environ['HOME']]}
else:
    hook_payload = {'hook_event_name': 'SessionStart', 'session_id': 'new-native', 'cwd': os.environ['HOME']}
hook_proc = subprocess.run(hook_cmd, input=json.dumps(hook_payload), env=hook_env, check=True, capture_output=True, text=True)
hook_out = json.loads(hook_proc.stdout) if hook_proc.stdout.strip() else {}
if 'hookSpecificOutput' in hook_out:
    notice = hook_out['hookSpecificOutput'].get('additionalContext', '')
elif 'injectSteps' in hook_out:
    notice = '\\n'.join(s['ephemeralMessage'] for s in hook_out['injectSteps'] if 'ephemeralMessage' in s)
else:
    notice = ''
peer = mailbox.load(mailbox.peer_path(base, 'new-native'))
rooms = room_store.list_rooms(base)
room = room_store.read_room(base, os.environ['TEST_ROOM'])
node_code = '''import { observeRoom } from './src/lib/rooms.mjs';
import { HordeView } from './src/lib/horde-view.mjs';
const room = await observeRoom(process.env.TEST_ROOM, {root: process.env.AGENT_EXECUTOR_HOME + '/mailbox-v1', discoverNativePeers: false});
process.stdout.write(JSON.stringify({progress: room.conductor.progress, header: new HordeView(room, {color: false}).render(160).join(String.fromCharCode(10))}));'''
view = subprocess.run([room_store._node_binary(), '--input-type=module', '-e', node_code],
                      env=os.environ, check=False, capture_output=True, text=True)
if view.returncode: raise RuntimeError(view.stderr)
print(json.dumps({'rooms': [r['id'] for r in rooms], 'room': room, 'notice': notice,
                  'name': peer['name'], 'view': json.loads(view.stdout), 'status': swarm_status.snapshot(room, base)}))
"""
        for harness in ("claude", "codex", "gemini"):
            for mode in ("target", "room"):
                with self.subTest(harness=harness, mode=mode), tempfile.TemporaryDirectory() as temporary:
                    home = Path(temporary).resolve()
                    environment = self.environment(home)
                    environment.update(TEST_HARNESS=harness, TEST_CLI=str(CLI))
                    first = subprocess.run(
                        [sys.executable, "-c", initial], env=environment, check=True, capture_output=True, text=True
                    )
                    previous = json.loads(first.stdout)
                    self.assertFalse(previous["oldPeerExists"])
                    environment.update(TEST_ROOM=previous["room"], ORKEST_RESUME_SWARM="1")
                    environment["ORKEST_RESUME_TARGET" if mode == "target" else "ORKEST_SWARM_ROOM"] = (
                        "old-native" if mode == "target" else previous["room"]
                    )
                    second = subprocess.run(
                        [sys.executable, "-c", resumed], env=environment, check=False, capture_output=True, text=True
                    )
                    self.assertEqual(second.returncode, 0, second.stderr)
                    result = json.loads(second.stdout)
                    self.assertEqual(result["rooms"], [previous["room"]])
                    self.assertEqual(result["room"]["conductor"]["session"]["id"], "new-native")
                    self.assertIn("old-native", result["room"]["conductor"]["previousSessions"])
                    self.assertIn("Finish the resume repair", result["notice"])
                    self.assertEqual(result["status"]["conductor"]["name"], "noxox")
                    self.assertEqual(result["view"]["progress"]["name"], result["name"])
                    self.assertEqual(result["view"]["progress"]["model"], "resume-model")
                    self.assertEqual(result["view"]["progress"]["task"], "Restore the coordinator header")
                    self.assertNotIn("Coordinator session unavailable", result["view"]["header"])
                    self.assertIn("resume-model", result["view"]["header"])
                    self.assertEqual(result["status"]["conductor"]["model"], "resume-model")
                    self.assertEqual(result["status"]["conductor"]["task"], "Restore the coordinator header")

    def room(self, base, home, session="native-id"):
        return room_store.put_room(
            base,
            {
                "schema": "agent-executor.room.v1",
                "id": "existing-room",
                "cwd": str(home),
                "machine": socket.gethostname(),
                "swarm": {"maxAgents": 12, "maxDepth": 3},
                "title": "Resume repair",
                "objective": "Keep this room",
                "agents": [],
                "conductor": {
                    "engine": "claude",
                    "role": "lead",
                    "status": "idle",
                    "session": {"id": session, "engine": "claude", "cwd": str(home), "machine": socket.gethostname()},
                },
            },
        )

    def test_all_python_consumers_resolve_attested_identity_and_ignore_alias_collisions(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            base = home / "mailbox-v1"
            peer = mailbox.register(base, session="mailbox-id", harness="claude", cwd=str(home), pid=os.getpid())
            peer = mailbox.annotate(
                base,
                peer["session"],
                nativeSession="native-id",
                nativeSessions=["native-id"],
                model="test-model",
                focus="Keep the header",
                herdrPaneId="%1",
            )
            peer = mailbox.attest_native_sessions(base, peer["session"], "native-id")
            for session, changes in (
                ("subagent", {"isSubagent": True}),
                ("delegated", {"delegatedRun": "run-x"}),
                ("other-repo", {"cwd": str(base), "checkout": str(base)}),
                ("free-alias", {"aliases": ["native-id"], "nativeSessions": []}),
            ):
                mailbox.register(base, session=session, harness="claude", cwd=str(home), pid=os.getpid())
                mailbox.annotate(
                    base,
                    session,
                    nativeSessions=["native-id"],
                    **{key: value for key, value in changes.items() if key != "nativeSessions"},
                )
                if "nativeSessions" in changes:
                    mailbox.annotate(base, session, nativeSessions=changes["nativeSessions"])
            room = self.room(base, home)
            self.assertEqual(
                mailbox.session_peer(base, "native-id", harness="claude", cwd=str(home))["session"], "mailbox-id"
            )
            bound = ORK_FAST.statusline_identity(peer["session"], "claude", base=base, env=self.environment(home))
            self.assertEqual((bound["fullName"], bound["goal"]), (peer["name"], "Resume repair"))
            self.assertEqual(swarm_status.snapshot(room, base)["conductor"]["name"], peer["person"])
            self.assertTrue(mailbox._room_has_live_member(base, room))
            self.assertTrue(
                mailbox._room_has_live_member(
                    base,
                    {"cwd": str(home), "conductor": {"mailboxSession": "native-id", "engine": "claude"}, "agents": []},
                )
            )
            self.assertEqual(
                agent_terminal._resolve_structural_role(base, peer["session"], "claude", peer),
                ("existing-room", "Coordinator", True),
            )
            self.assertEqual(
                ORK_FAST.statusline_identity(
                    "native-id",
                    "claude",
                    payload={"cwd": str(home)},
                    base=base,
                    env=self.environment(home),
                )["model"],
                "test-model",
            )
            self._hook_notice(
                base,
                "free-alias",
                harness="claude",
                event="SessionStart",
                env={**self.environment(home), "CLAUDE_CODE_SESSION_ID": "native-id"},
                cwd=home,
            )
            self.assertEqual(
                mailbox.session_peer(base, "native-id", harness="claude", cwd=str(home))["session"], "mailbox-id"
            )

    def test_legacy_peer_is_attested_on_next_hook_and_reattaches_for_every_harness(self):
        for harness, variable in (
            ("claude", "CLAUDE_CODE_SESSION_ID"),
            ("codex", "CODEX_THREAD_ID"),
            ("gemini", "ANTIGRAVITY_CONVERSATION_ID"),
        ):
            with self.subTest(harness=harness), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                base = home / "mailbox-v1"
                mailbox.register(base, session="legacy-mailbox", harness=harness, cwd=temporary, pid=os.getpid())
                legacy = mailbox.annotate(
                    base, "legacy-mailbox", nativeSession="native-id", nativeSessions=["forged-history", "native-id"]
                )
                room = self.room(base, home)
                engine = "agy" if harness == "gemini" else harness
                room["conductor"]["engine"] = engine
                room["conductor"]["session"]["engine"] = engine
                room = room_store.put_room(base, room)
                self.assertIsNone(mailbox.session_peer(base, "native-id"))
                environment = {**self.environment(home), variable: "native-id", "ORKEST_SWARM_ROOM": room["id"]}
                notice = self._hook_notice(
                    base, legacy, harness=harness, event="SessionStart", env=environment, cwd=temporary
                )
                self.assertIn("Swarm", notice)
                self.assertEqual(mailbox.session_peer(base, "native-id")["session"], "legacy-mailbox")
                self.assertIsNone(mailbox.session_peer(base, "forged-history"))
                self.assertEqual(room_store.read_room(base, room["id"])["conductor"]["session"]["id"], "legacy-mailbox")

    def test_unambiguous_forged_native_claim_cannot_rebind_or_read_room(self):
        for kind in ("missing", "fake", "copied", "tampered"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                base = home / "mailbox-v1"
                mailbox.register(base, session="owner", harness="claude", cwd=temporary, pid=os.getpid())
                owner = mailbox.attest_native_sessions(base, "owner", "genuine-native")
                mailbox.register(base, session="attacker", harness="claude", cwd=temporary, pid=os.getpid())
                attacker = mailbox.annotate(base, "attacker", nativeSession="native-id", nativeSessions=["native-id"])
                if kind == "fake":
                    attacker = mailbox.annotate(base, "attacker", nativeSessionAttestation="a" * 64)
                elif kind == "copied":
                    attacker = mailbox.annotate(
                        base, "attacker", nativeSessionAttestation=owner["nativeSessionAttestation"]
                    )
                elif kind == "tampered":
                    mailbox.attest_native_sessions(base, "attacker", "own-native")
                    attacker = mailbox.annotate(base, "attacker", nativeSessions=["own-native", "native-id"])
                room = self.room(base, home)
                self.assertEqual(mailbox.session_peer(base, "genuine-native")["session"], "owner")
                self.assertIsNone(mailbox.session_peer(base, "native-id"))
                self.assertIsNone(terminal.find_session_swarm_room(base, "attacker", harness="claude", cwd=temporary))
                self.assertIsNone(terminal.rebind_session_swarm_room(base, room["id"], "conductor", "attacker"))
                environment = {**self.environment(home), "ORKEST_SWARM_ROOM": room["id"]}
                attacker_notice = self._hook_notice(
                    base, attacker, harness="claude", event="SessionStart", env=environment, cwd=temporary
                )
                self.assertNotIn("Keep this room", attacker_notice)
                self.assertNotIn("Resume repair", attacker_notice)
                self.assertEqual(room_store.read_room(base, room["id"]), room)

    def test_stale_room_environment_falls_back_to_live_promotion(self):
        for status in ("missing", "closed"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                base = home / "mailbox-v1"
                peer = mailbox.register(base, session="new-session", harness="claude", cwd=str(home), pid=os.getpid())
                if status == "closed":
                    room = self.room(base, home)
                    room["status"] = "closed"
                    room_store.put_room(base, room)
                environment = self.environment(home)
                environment.update(ORKEST_RESUME_SWARM="1", ORKEST_SWARM_ROOM="existing-room")
                notice = self._hook_notice(
                    base, peer, harness="claude", event="SessionStart", env=environment, cwd=home
                )
                live = [r for r in room_store.list_rooms(base) if r.get("status") != "closed"]
                self.assertEqual(len(live), 1)
                self.assertEqual(live[0]["conductor"]["session"]["id"], "new-session")
                self.assertIn("Swarm", notice)

    def test_dead_peer_in_a_reused_herdr_pane_is_not_selected(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary) / "mailbox-v1"
            mailbox.register(base, session="dead", harness="claude", cwd=temporary, pid=99999999)
            mailbox.annotate(base, "dead", herdrPaneId="%1")
            self.assertIsNone(terminal._find_herdr_peer(base, None, "%1"))
            self.assertIsNone(terminal._find_herdr_peer(base, "dead", "%1"))

    def test_live_owner_cannot_be_replaced_by_a_forged_identity_or_resume(self):
        for field in ("aliases", "nativeSessions"):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                base = home / "mailbox-v1"
                mailbox.register(base, session="owner", harness="claude", cwd=temporary, pid=os.getpid())
                attacker = mailbox.register(base, session="attacker", harness="claude", cwd=temporary, pid=os.getpid())
                room = self.room(base, home, "unattested-native")
                room["promotion"] = {"session": "owner"}
                room["conductor"]["previousSessions"] = ["owner"]
                room = room_store.put_room(base, room)
                attacker = mailbox.annotate(base, "attacker", **{field: ["unattested-native"]})
                self.assertIsNone(
                    terminal.find_session_swarm_room(
                        base, "attacker", harness="claude", cwd=temporary, only_room=room["id"]
                    )
                )
                self.assertIsNone(terminal.rebind_session_swarm_room(base, room["id"], "conductor", "attacker"))
                environment = self.environment(home)
                environment.update(ORKEST_RESUME_SWARM="1", ORKEST_SWARM_ROOM=room["id"])
                notice = self._hook_notice(
                    base, attacker, harness="claude", event="SessionStart", env=environment, cwd=temporary
                )
                self.assertIn("Swarm", notice)
                self.assertEqual(room_store.read_room(base, room["id"]), room)
                separate = [r for r in room_store.list_rooms(base) if r["id"] != room["id"]]
                self.assertEqual(len(separate), 1)
                self.assertEqual(separate[0]["conductor"]["session"]["id"], "attacker")

    def test_launcher_preserves_resume_target_for_hooks_without_the_old_peer(self):
        for harness, command in (
            ("claude", ["claude", "--resume", "old-native"]),
            ("codex", ["codex", "--model", "gpt", "resume", "old-native"]),
            ("gemini", ["agy", "--conversation=old-native"]),
        ):
            with self.subTest(harness=harness), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                base = home / "mailbox-v1"
                existing = self.room(base, home, "old-native")
                engine = "agy" if harness == "gemini" else harness
                existing["conductor"]["engine"] = engine
                existing["conductor"]["session"]["engine"] = engine
                room_store.put_room(base, existing)
                environment = self.environment(home)
                environment.update(HERDR_ENV="1", HERDR_PANE_ID="%1", HERDR_SOCKET_PATH=str(home / "fake.sock"))
                captured = {}

                def launch(_binary, argv, env, captured=captured):
                    captured.update(argv=argv, env=env)
                    raise SystemExit(0)

                with (
                    patch.dict(os.environ, environment, clear=True),
                    patch.object(sys.stdin, "isatty", return_value=True),
                    patch.object(sys.stdout, "isatty", return_value=True),
                    patch.object(terminal.shutil, "which", return_value="/fake"),
                    patch.object(terminal, "_open_herdr_swarm_view", return_value="%2"),
                    patch.object(terminal.os, "execvpe", side_effect=launch),
                    patch.object(terminal.os, "chdir"),
                ):
                    with self.assertRaises(SystemExit):
                        terminal.main(["--resume-swarm", "--cwd", str(home), "--", *command])
                expected = (
                    [command[0], "-c", 'tui.terminal_title=["thread-title","session-id"]', *command[1:]]
                    if harness == "codex"
                    else command
                )
                self.assertEqual(captured["argv"], expected)
                self.assertEqual(captured["env"]["ORKEST_SWARM_ROOM"], "existing-room")
                self.assertEqual(captured["env"]["ORKEST_RESUME_TARGET"], "old-native")
                self.assertEqual(captured["env"]["ORKEST_RESUME_SWARM"], "1")

    def test_resume_launch_leaves_live_room_metadata_and_environment_alone(self):
        for inherited in (False, True):
            with self.subTest(inherited=inherited), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                base = home / "mailbox-v1"
                mailbox.register(base, session="live-owner", harness="claude", cwd=temporary, pid=os.getpid())
                room = self.room(base, home, "live-owner")
                room.update(herdrCoordinatorPaneId="%1", herdrViewPaneId="%10")
                room = room_store.put_room(base, room)
                environment = self.environment(home)
                environment.update(HERDR_ENV="1", HERDR_PANE_ID="%2", HERDR_SOCKET_PATH=str(home / "fake.sock"))
                if inherited:
                    environment["ORKEST_SWARM_ROOM"] = room["id"]
                captured = {}

                def launch(_binary, argv, env, captured=captured):
                    captured.update(argv=argv, env=env)
                    raise SystemExit(0)

                def open_view(*_args, **kwargs):
                    terminal._update_room_metadata(kwargs["base"], kwargs["room"], herdrViewPaneId="%20")
                    return "%20"

                with (
                    patch.dict(os.environ, environment, clear=True),
                    patch.object(sys.stdin, "isatty", return_value=True),
                    patch.object(sys.stdout, "isatty", return_value=True),
                    patch.object(terminal.shutil, "which", return_value="/fake"),
                    patch.object(terminal, "_open_herdr_swarm_view", side_effect=open_view),
                    patch.object(terminal.os, "execvpe", side_effect=launch),
                    patch.object(terminal.os, "chdir"),
                ):
                    with self.assertRaises(SystemExit):
                        terminal.main(["--resume-swarm", "--cwd", temporary, "--", "claude", "--resume", "live-owner"])
                self.assertEqual(captured["argv"], ["claude", "--resume", "live-owner"])
                self.assertIsNone(captured["env"].get("ORKEST_SWARM_ROOM"), "launcher exported the live room")
                self.assertEqual(room_store.read_room(base, room["id"]), room)
                peer = mailbox.register(base, session="resumer", harness="claude", cwd=temporary, pid=os.getpid())
                # Simulate a stale inherited room too: the hook must safely use a separate room.
                child_env = {**captured["env"], "ORKEST_SWARM_ROOM": room["id"], "HERDR_ENV": "0"}
                notice = self._hook_notice(
                    base, peer, harness="claude", event="SessionStart", env=child_env, cwd=temporary
                )
                self.assertIn("Swarm", notice)
                self.assertEqual(room_store.read_room(base, room["id"]), room)
                self.assertEqual(len(room_store.list_rooms(base)), 2)

    def test_dead_previous_id_does_not_match_a_room_with_a_live_owner(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            base = home / "mailbox-v1"
            mailbox.register(base, session="current", harness="claude", cwd=temporary, pid=os.getpid())
            room = self.room(base, home, "current")
            room["conductor"]["previousSessions"] = ["dead-original"]
            room_store.put_room(base, room)
            self.assertIsNone(terminal.find_session_swarm_room(base, "dead-original", harness="claude", cwd=temporary))
            self.assertEqual(
                terminal.find_session_swarm_room(base, "current", harness="claude", cwd=temporary)["id"], room["id"]
            )

    def test_native_collision_preserves_recorded_owner_and_denies_ambiguous_claimants(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            base = home / "mailbox-v1"
            owner = mailbox.register(base, session="owner", harness="claude", cwd=temporary, pid=os.getpid())
            mailbox.annotate(base, "owner", model="owner-model")
            owner = mailbox.attest_native_sessions(base, "owner", "native-id")
            attacker = mailbox.register(base, session="attacker", harness="claude", cwd=temporary, pid=os.getpid())
            attacker = mailbox.annotate(base, "attacker", nativeSessions=["native-id"])
            room = self.room(base, home)
            room["promotion"] = {"session": "owner"}
            room = room_store.put_room(base, room)
            owner_ident = ORK_FAST.statusline_identity(
                owner["session"], "claude", base=base, env=self.environment(home)
            )
            self.assertEqual((owner_ident["fullName"], owner_ident["goal"]), (owner["name"], "Resume repair"))
            self.assertEqual(
                agent_terminal._resolve_structural_role(base, owner["session"], "claude", owner),
                (room["id"], "Coordinator", True),
            )
            self.assertEqual(swarm_status.snapshot(room, base)["conductor"]["model"], "owner-model")
            self.assertTrue(mailbox._room_has_live_member(base, room))
            self.assertIsNone(terminal.find_session_swarm_room(base, "attacker", harness="claude", cwd=temporary))
            for explicit in (False, True):
                environment = self.environment(home)
                if explicit:
                    environment["ORKEST_SWARM_ROOM"] = room["id"]
                attacker_notice = self._hook_notice(
                    base, attacker, harness="claude", event="SessionStart", env=environment, cwd=temporary
                )
                self.assertNotIn("Keep this room", attacker_notice)
                self.assertNotIn("Resume repair", attacker_notice)
            self.assertEqual(room_store.read_room(base, room["id"]), room)
            mailbox.attest_native_sessions(base, "attacker", "native-id")
            del room["promotion"]
            room = room_store.put_room(base, room)
            self.assertIsNone(terminal.find_session_swarm_room(base, "attacker", harness="claude", cwd=temporary))
            self.assertIsNone(terminal.rebind_session_swarm_room(base, room["id"], "conductor", "owner"))
            self.assertEqual(room_store.read_room(base, room["id"]), room)

    def test_non_owner_cannot_match_or_read_a_live_lead_brief(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            base = home / "mailbox-v1"
            lead = mailbox.register(base, session="lead-owner", harness="claude", cwd=temporary, pid=os.getpid())
            attacker = mailbox.register(base, session="attacker", harness="claude", cwd=temporary, pid=os.getpid())
            attacker = mailbox.annotate(base, "attacker", nativeSessions=["lead-owner"])
            room = self.room(base, home, "absent-conductor")
            room["agents"] = [
                {
                    **room["conductor"],
                    "id": "lead-1",
                    "objective": "Private lead objective",
                    "session": {
                        "id": "lead-owner",
                        "engine": "claude",
                        "cwd": temporary,
                        "machine": socket.gethostname(),
                    },
                }
            ]
            room = room_store.put_room(base, room)
            self.assertIsNone(terminal.find_session_swarm_room(base, "attacker", harness="claude", cwd=temporary))
            environment = self.environment(home)
            environment["ORKEST_SWARM_ROOM"] = room["id"]
            self.assertNotIn(
                "Private lead objective",
                self._hook_notice(
                    base, attacker, harness="claude", event="SessionStart", env=environment, cwd=temporary
                ),
            )
            self.assertIn(
                "Private lead objective",
                self._hook_notice(base, lead, harness="claude", event="SessionStart", env=environment, cwd=temporary),
            )
            self.assertEqual(room_store.read_room(base, room["id"]), room)

    def test_lead_brief_is_withheld_when_owner_repair_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            base = home / "mailbox-v1"
            lead = mailbox.register(base, session="lead-owner", harness="claude", cwd=temporary, pid=os.getpid())
            lead = mailbox.attest_native_sessions(base, "lead-owner", "native-lead")
            room = self.room(base, home, "absent-conductor")
            room["agents"] = [
                {
                    **room["conductor"],
                    "id": "lead-1",
                    "objective": "Private lead objective",
                    "session": {
                        "id": "native-lead",
                        "engine": "claude",
                        "cwd": temporary,
                        "machine": socket.gethostname(),
                    },
                }
            ]
            room = room_store.put_room(base, room)
            broken_checkout = home / "broken-checkout"
            broken_plugin = broken_checkout / "plugins/orchestrate"
            (broken_plugin / "skills/orchestrate/scripts").mkdir(parents=True)
            (broken_checkout / "src/bin").mkdir(parents=True)
            (broken_checkout / "src/bin/ork.mjs").write_text("\n")
            (broken_checkout / "src/bin/room-store.mjs").write_text(
                "if (process.argv[2] === 'rebind') process.exit(1);\n"
            )
            environment = self.environment(home)
            environment["ORKEST_SWARM_ROOM"] = room["id"]
            failing_env = {
                **environment,
                "ORKEST_PLUGIN_ROOT": str(broken_plugin),
                "ORKEST_SCRIPTS_DIR": str(broken_plugin / "skills/orchestrate/scripts"),
            }
            self.assertNotIn(
                "Private lead objective",
                self._hook_notice(base, lead, harness="claude", event="SessionStart", env=failing_env, cwd=temporary),
            )
            self.assertIn(
                "Private lead objective",
                self._hook_notice(base, lead, harness="claude", event="SessionStart", env=environment, cwd=temporary),
            )
            self.assertEqual(room_store.read_room(base, room["id"])["agents"][0]["session"]["id"], "lead-owner")

    def test_hooks_refuse_foreign_room_and_binding_machines(self):
        for where in ("room", "binding"):
            with self.subTest(where=where), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                base = home / "mailbox-v1"
                peer = mailbox.register(base, session="owner", harness="claude", cwd=temporary, pid=os.getpid())
                room = self.room(base, home, "owner")
                target = room if where == "room" else room["conductor"]["session"]
                target["machine"] = "foreign-host"
                room = room_store.put_room(base, room)
                environment = self.environment(home)
                environment["ORKEST_SWARM_ROOM"] = room["id"]
                foreign_notice = self._hook_notice(
                    base, peer, harness="claude", event="SessionStart", env=environment, cwd=temporary
                )
                self.assertNotIn("Keep this room", foreign_notice)
                self.assertNotIn("Resume repair", foreign_notice)
                self.assertIsNone(terminal.find_session_swarm_room(base, "owner", harness="claude", cwd=temporary))
                self.assertEqual(room_store.read_room(base, room["id"]), room)

    def test_cancelled_and_archived_rooms_are_skipped_by_orca_room_lookup(self):
        import orca_swarm_restore

        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            base = home / "mailbox-v1"
            for rid, lifecycle in (("r-arch", "archived"), ("r-canc", "cancelled")):
                room_store.put_room(
                    base,
                    {
                        "schema": "agent-executor.room.v1",
                        "id": rid,
                        "lifecycle": lifecycle,
                        "orcaCoordinatorTerminalId": "term_shared",
                        "agents": [],
                    },
                )
            self.assertEqual(orca_swarm_restore._room_for_terminal(base, "term_shared"), "")
