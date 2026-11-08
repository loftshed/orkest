"""Native claims require hook evidence in both room readers, using isolated stores only."""

import concurrent.futures
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import mailbox_daemon  # noqa: E402
import mailbox_hooks  # noqa: E402
import mailbox_listener  # noqa: E402
import native_identity  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402
import room_store  # noqa: E402


class NativeIdentityTests(unittest.TestCase):
    def test_concurrent_first_hooks_share_one_key_and_keep_every_claim_verifiable(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary) / "mailbox-v1"
            sessions = [f"peer-{index}" for index in range(12)]
            for session in sessions:
                mailbox.register(base, session=session, harness="codex", cwd=temporary, pid=os.getpid())
            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                peers = list(
                    pool.map(
                        lambda session: mailbox.attest_native_sessions(base, session, "native-" + session), sessions
                    )
                )
            for peer in peers:
                self.assertEqual(mailbox.native_session_ids(peer, base), {peer["session"], "native-" + peer["session"]})
                self.assertEqual(mailbox.session_peer(base, "native-" + peer["session"])["session"], peer["session"])

    def test_node_and_python_agree_on_unicode_context_tampering_and_unavailable_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            # Exercise the hashed daemon directory as well as non-ASCII MAC serialization.
            base = Path(temporary) / "custom-mailbox"
            cwd = Path(temporary) / "répertoire-猫"
            cwd.mkdir()
            mailbox.register(base, session="owner", harness="claude", cwd=str(cwd), pid=os.getpid())
            genuine = mailbox.attest_native_sessions(base, "owner", "native-id")

            def identities(peer):
                result = subprocess.run(
                    [
                        room_store._node_binary(),
                        "--input-type=module",
                        "-e",
                        "import { sessionIdentities } from './plugins/orchestrate/lib/rooms.mjs'; "
                        "console.log(JSON.stringify(sessionIdentities(JSON.parse(process.argv[1]),process.argv[2])));",
                        json.dumps(peer),
                        str(base),
                    ],
                    cwd=SCRIPTS.parents[4],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                node = set(json.loads(result.stdout))
                python = mailbox.native_session_ids(peer, base)
                self.assertEqual(node, python)
                return node

            self.assertEqual(identities(genuine), {"owner", "native-id"})
            for field, changed in (
                ("session", "attacker"),
                ("harness", "codex"),
                ("machine", "another-machine"),
                ("cwd", temporary),
                ("checkout", temporary),
                ("accountHome", temporary),
                ("nativeSession", "forged"),
                ("nativeSessions", ["native-id", "forged"]),
                ("nativeSessionAttestation", "0" * 64),
            ):
                with self.subTest(field=field):
                    self.assertEqual(
                        identities({**genuine, field: changed}), {changed if field == "session" else "owner"}
                    )
            # Older clients may update display/presence fields without invalidating evidence.
            changed = mailbox.annotate(base, "owner", focus="new task", state="busy")
            self.assertEqual(identities(changed), {"owner", "native-id"})
            token_path = mailbox_daemon.daemon_base(base) / "token.txt"
            held_token = token_path.with_suffix(".held")
            token_path.rename(held_token)
            self.assertEqual(identities(genuine), {"owner"})
            held_token.rename(token_path)
            self.assertEqual(identities(genuine), {"owner", "native-id"})
            token_path.chmod(0o644)
            self.assertEqual(identities(genuine), {"owner"})
            token_path.chmod(0o600)
            self.assertEqual(identities(genuine), {"owner", "native-id"})
            token_path.rename(held_token)
            token_path.write_bytes(b"\xc1" * 43)
            token_path.chmod(0o600)
            self.assertEqual(identities(genuine), {"owner"})
            held_token.replace(token_path)
            self.assertEqual(identities(genuine), {"owner", "native-id"})


class NativeIdentityLifecycleTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.home = Path(temporary).resolve()
        self.base = self.home / "mailbox-v1"
        self.cwd = self.home / "repo"
        self.cwd.mkdir()
        self.enterContext(
            patch.dict(
                os.environ,
                {
                    "PATH": os.environ["PATH"],
                    "HOME": temporary,
                    "AGENT_EXECUTOR_HOME": temporary,
                    "ORCHESTRATE_HOME": temporary,
                    "ORCHESTRATE_MAILBOX_DIR": str(self.base),
                    "HERDR_ENV": "0",
                    "PYTEST_CURRENT_TEST": self.id(),
                },
                clear=True,
            )
        )
        self.enterContext(patch.object(mailbox, "harness_pid", return_value=os.getpid()))

    def register(self, session="owner", **fields):
        return mailbox.register(
            self.base, session=session, harness="claude", cwd=str(self.cwd), pid=os.getpid(), **fields
        )

    def assert_identities(self, peer, expected):
        result = subprocess.run(
            [
                room_store._node_binary(),
                "--input-type=module",
                "-e",
                "import { sessionIdentities } from './plugins/orchestrate/lib/rooms.mjs'; "
                "console.log(JSON.stringify(sessionIdentities(JSON.parse(process.argv[1]),process.argv[2])));",
                json.dumps(peer),
                str(self.base),
            ],
            cwd=SCRIPTS.parents[4],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(set(json.loads(result.stdout)), expected)
        self.assertEqual(mailbox.native_session_ids(peer, self.base), expected)

    def hook(self, session="owner", **payload):
        return mailbox_hooks.hook(
            {"session_id": session, "hook_event_name": "SessionStart", "cwd": str(self.cwd), **payload},
            harness="claude",
            base=self.base,
        )

    def test_bad_tokens_leave_hooks_resume_clear_and_listener_operational_but_unattested(self):
        for state in ("unreadable", "public", "symlink", "dangling-symlink", "corrupt", "non-ascii"):
            with self.subTest(state=state), tempfile.TemporaryDirectory(dir=self.home) as temporary:
                self.base = Path(temporary) / "mailbox-v1"
                self.enterContext(
                    patch.dict(
                        os.environ,
                        {
                            "AGENT_EXECUTOR_HOME": temporary,
                            "ORCHESTRATE_HOME": temporary,
                            "ORCHESTRATE_MAILBOX_DIR": str(self.base),
                        },
                    )
                )
                owner = self.register()
                owner = mailbox.attest_native_sessions(self.base, "owner", "native-owner")
                self.assert_identities(owner, {"owner", "native-owner"})
                promoted = room_store.put_room(
                    self.base,
                    {
                        "schema": "agent-executor.room.v1",
                        "id": "exact-owner",
                        "title": "Exact owner",
                        "cwd": str(self.cwd),
                        "machine": socket.gethostname(),
                        "createdAt": 1,
                        "updatedAt": 1,
                        "objective": "Keep exact resume working",
                        "swarm": {"maxAgents": 12, "maxDepth": 3},
                        "conductor": {
                            "id": "conductor",
                            "name": "conductor",
                            "role": "lead",
                            "engine": "claude",
                            "status": "idle",
                            "cwd": str(self.cwd),
                            "session": {"id": "owner", "machine": socket.gethostname()},
                        },
                        "agents": [],
                    },
                )
                token = mailbox_daemon.daemon_base(self.base) / "token.txt"
                if state in ("symlink", "dangling-symlink"):
                    target = token.with_suffix(".held")
                    token.rename(target)
                    token.symlink_to(target if state == "symlink" else target.with_suffix(".missing"))
                elif state == "corrupt":
                    token.write_text("corrupt\n")
                elif state == "non-ascii":
                    token.write_bytes(b"\xc1" * 43)
                else:
                    token.chmod(0o000 if state == "unreadable" else 0o644)
                # An explicit read failure also makes this deterministic under a root test runner.
                failure = patch.object(mailbox_daemon, "read_token", side_effect=PermissionError())
                with failure if state == "unreadable" else patch.dict(os.environ, {}):
                    self.assertEqual(native_identity.verified_native_ids(self.base, owner), [])
                    sender = mailbox.register(
                        self.base, session="sender", harness="codex", cwd=str(self.cwd), pid=os.getpid()
                    )
                    mailbox.send(
                        self.base,
                        sender=sender,
                        to="owner",
                        text="Mail survives failed signing",
                        wake=False,
                        scope="cross-project",
                    )
                    output = self.hook()
                    self.assertIn("Mail survives failed signing", json.dumps(output))
                    owner = mailbox.load(mailbox.peer_path(self.base, "owner"))
                    self.assertIsNone(owner.get("nativeSessionAttestation"))
                    self.assert_identities(owner, {"owner"})
                    with patch.dict(
                        os.environ,
                        {
                            "CLAUDE_CODE_SESSION_ID": "owner",
                            "ORKEST_RESUME_SWARM": "1",
                            "ORKEST_RESUME_TARGET": "owner",
                            "ORKEST_SWARM_ROOM": promoted["id"],
                        },
                    ):
                        context = mailbox_hooks.swarm_coordinator_context(self.base, owner)
                    self.assertIn("Keep exact resume working", json.dumps(output) + context)
                    self.assertEqual(
                        room_store.read_room(self.base, promoted["id"])["conductor"]["session"]["id"], "owner"
                    )
                    listener = mailbox_listener.StreamingSession(
                        SimpleNamespace(pid=os.getpid()), "claude", self.base, "listener"
                    )
                    listener.native_session = "native-listener"
                    listener.presence()
                    streamed = mailbox.load(mailbox.peer_path(self.base, "listener"))
                    self.assertIsNone(streamed.get("nativeSessionAttestation"))
                    self.assert_identities(streamed, {"listener"})
                    mailbox.write(
                        self.base / "cleared" / "old.json",
                        {**owner, "session": "old", "clearedAt": mailbox.stamp(), "clearedPid": os.getpid()},
                    )
                    successor = self.register("successor")
                    self.assertIn("Your earlier context", mailbox_hooks.adopt_cleared(self.base, successor))
                    successor = mailbox.load(mailbox.peer_path(self.base, "successor"))
                    self.assertEqual(successor["clearedFrom"], "old")
                    self.assertIsNone(successor.get("nativeSessionAttestation"))
                if state == "unreadable":
                    token.chmod(0o600)

    def test_listener_and_tool_refresh_keep_the_same_bound_context(self):
        for engine, harness in (("claude", "claude"), ("agy", "gemini")):
            with self.subTest(engine=engine):
                session = "stream-" + engine
                listener = mailbox_listener.StreamingSession(
                    SimpleNamespace(pid=os.getpid()), engine, self.base, session
                )
                listener.native_session = "native-" + engine
                listener.presence()
                before = mailbox.load(mailbox.peer_path(self.base, session))
                self.assertEqual(before.get("accountHome"), mailbox.account_home(harness))
                self.assertEqual(before.get("cwdSource"), "hook")
                after = mailbox.refresh(
                    self.base,
                    session=session,
                    harness=harness,
                    cwd=str(self.cwd),
                    pid=os.getpid(),
                    source="cli",
                    account=mailbox.account_home(harness),
                )
                self.assertEqual(after["cwd"], before["cwd"])
                self.assertEqual(after["nativeSessionAttestation"], before["nativeSessionAttestation"])
                self.assert_identities(after, {session, "native-" + engine})

    def test_tool_refresh_preserves_transcript_derived_profile_and_history(self):
        profile = self.home / ".claude-profile-b"
        transcript = profile / "projects/repo/owner.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.touch()
        self.hook(transcript_path=str(transcript))
        before = mailbox.attest_native_sessions(self.base, "owner", "previous-native", "owner")
        after = mailbox.refresh(
            self.base,
            session="owner",
            harness="claude",
            cwd=str(self.home),
            pid=os.getpid(),
            source="mcp",
            account=mailbox.account_home("claude"),
        )
        self.assertEqual(after["accountHome"], str(profile))
        self.assertEqual(after["cwd"], str(self.cwd))
        self.assertEqual(after["nativeSessionAttestation"], before["nativeSessionAttestation"])
        self.assert_identities(after, {"owner", "previous-native"})

    def test_register_resigns_changed_context_only_for_previously_verified_ids(self):
        self.register()
        original = mailbox.attest_native_sessions(self.base, "owner", "native-owner", "older-native")
        changed = mailbox.register(
            self.base,
            session="owner",
            harness="codex",
            cwd=str(self.home),
            pid=os.getpid(),
            account=str(self.home / ".codex"),
        )
        self.assertNotEqual(changed["nativeSessionAttestation"], original["nativeSessionAttestation"])
        self.assert_identities(changed, {"owner", "native-owner", "older-native"})
        # Neither a forged hint nor a rotated key may turn registration into evidence.
        forged = mailbox.annotate(self.base, "owner", nativeSessions=["forged-id"])
        for rotated, peer in ((False, forged), (True, original)):
            with self.subTest(peer=peer["nativeSessions"]):
                mailbox.write(mailbox.peer_path(self.base, "owner"), peer)
                if rotated:
                    token = mailbox_daemon.daemon_base(self.base) / "token.txt"
                    token.write_text("RotatedToken_0123456789abcdefghijklmnopqrstuvwxyz\n")
                refreshed = self.register(account=str(self.home / ".claude-new"))
                self.assert_identities(refreshed, {"owner"})

    def test_nonstring_scalar_fields_serialize_as_null_in_both_runtimes(self):
        self.register()
        original = mailbox.attest_native_sessions(self.base, "owner", "native-owner")
        for field in ("session", "harness", "machine", "cwd", "checkout", "accountHome", "nativeSession"):
            for value in ({"2": "a", "1": "b"}, ["bad"], 1.0, True):
                with self.subTest(field=field, value=value):
                    peer = {**original, field: value}
                    peer["nativeSessionAttestation"] = native_identity.sign_native_ids(self.base, peer)
                    self.assertIsNone(
                        json.loads(native_identity.identity_message(peer))[
                            1
                            + (
                                "session",
                                "harness",
                                "machine",
                                "cwd",
                                "checkout",
                                "accountHome",
                                "nativeSession",
                            ).index(field)
                        ]
                    )
                    self.assert_identities(peer, {"native-owner"} if field == "session" else {"owner", "native-owner"})


if __name__ == "__main__":
    unittest.main()
