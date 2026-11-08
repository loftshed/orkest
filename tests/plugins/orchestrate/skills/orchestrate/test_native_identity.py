"""Native claims require hook evidence in both room readers, using isolated stores only."""

import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import mailbox_daemon  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
