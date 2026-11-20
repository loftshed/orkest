"""Run two public CLI installations against isolated stores and a deterministic SSH channel."""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = next(base for base in Path(__file__).resolve().parents if (base / "scripts/test.sh").is_file())
CLI = ROOT / "src/bin/ork.mjs"
RUNTIME = ROOT / "src/py"


class TwoHostCliTests(unittest.TestCase):
    def test_pair_rejects_private_scope_before_creating_a_store_or_contacting_ssh(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ssh = root / "ssh"
            ssh.write_text('#!/bin/sh\ntouch "$HOME/contact"\nexit 1\n')
            ssh.chmod(0o700)
            env = {
                "HOME": temp,
                "ORCHESTRATE_HOME": str(root / "cache"),
                "XDG_CONFIG_HOME": str(root / "config"),
                "PATH": temp + os.pathsep + os.environ["PATH"],
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            result = subprocess.run(
                [
                    "node",
                    CLI,
                    "sync",
                    "pair",
                    "--scope",
                    "local:private",
                    "--peer",
                    "other",
                    "--host",
                    "remote",
                    "--origin",
                    "other",
                    "--epoch",
                    "epoch",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("private_scope", result.stderr)
            self.assertFalse((root / "contact").exists())
            self.assertFalse((root / "cache" / "mailbox-v1").exists())
            self.assertFalse((root / "config" / "orchestrate" / "sync-peers" / "other.json").exists())

    def test_opposite_pulls_preserve_owners_scopes_and_cursors(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            # A real sshd supplies the forced-command identity via the matched authorized key.
            # This test substitutes its byte channel only. Both ends run the production CLI.
            ssh = root / "ssh"
            ssh.write_text(
                f"#!{sys.executable}\n"
                "import os,sys\nfrom pathlib import Path\n"
                "host,command=sys.argv[-2:]\n"
                "assert command=='ork sync serve' and host in ('a','b')\n"
                "source=os.environ['TEST_HOST']\n"
                "assert host!=source\n"
                "base=Path(os.environ['TEST_PROFILES'])/host\n"
                "os.environ.update(HOME=str(base),ORCHESTRATE_HOME=str(base/'cache'),"
                "XDG_CONFIG_HOME=str(base/'config'),SSH_ORIGINAL_COMMAND=command)\n"
                "os.execvp('node',['node',os.environ['TEST_CLI'],'sync','serve','--peer',source])\n"
            )
            ssh.chmod(0o700)

            def environment(host):
                base = root / host
                base.mkdir(exist_ok=True)
                return {
                    "HOME": str(base),
                    "ORCHESTRATE_HOME": str(base / "cache"),
                    "XDG_CONFIG_HOME": str(base / "config"),
                    "PATH": os.pathsep.join((str(root), os.environ["PATH"])),
                    "TEST_CLI": str(CLI),
                    "TEST_PROFILES": str(root),
                    "TEST_HOST": host,
                    "PYTHONDONTWRITEBYTECODE": "1",
                }

            exits = []
            projections = []

            def sync(host, *args):
                result = subprocess.run(
                    ["node", CLI, "sync", *args], env=environment(host), timeout=20, capture_output=True, check=True
                )
                exits.append((host, args[0], result.returncode))
                return json.loads(result.stdout)

            streams = {host: sync(host, "identity", "--scope", "room:a") for host in ("a", "b")}
            for owner, other in (("a", "b"), ("b", "a")):
                stream = streams[other]
                sync(
                    owner,
                    "pair",
                    "--peer",
                    other,
                    "--host",
                    other,
                    "--origin",
                    stream["origin"],
                    "--epoch",
                    stream["epoch"],
                    "--scope",
                    "room:a",
                    "--scope",
                    "room:b",
                )
                env = environment(owner)
                env["PYTHONPATH"] = str(RUNTIME)
                subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        "from pathlib import Path; import os,room_store; "
                        "room_store.put_room(Path(os.environ['ORCHESTRATE_HOME'])/'mailbox-v1', "
                        "{'id':os.environ['TEST_HOST'],'cwd':'/host/private/path','agents':[]})",
                    ],
                    env=env,
                    check=True,
                    timeout=20,
                )

            for receiver, source in (("b", "a"), ("a", "b")):
                scope = "room:" + source
                args = ("pull", "--peer", source, "--scope", scope)
                first = sync(receiver, *args)
                self.assertEqual(first["through"], 1)
                self.assertTrue(first["caught_up"])
                self.assertEqual(sync(receiver, *args), first)
                view = sync(
                    receiver, "view", "--peer", source, "--scope", scope, "--kind", "room.summary", "--entity", source
                )
                self.assertEqual(view["seq"], 1)
                self.assertNotIn("/host/private/path", json.dumps(view))
                db_path = root / receiver / "cache/mailbox-v1/rooms.db"
                with sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True) as db:
                    stored = db.execute(
                        "SELECT c.origin,c.epoch,c.through,v.entity,v.seq FROM outbox_cursors c "
                        "JOIN outbox_views v USING(origin,epoch,scope) "
                        "WHERE c.peer=? AND c.scope=? AND v.kind='room.summary'",
                        (source, scope),
                    ).fetchall()
                self.assertEqual(stored, [(streams[source]["origin"], streams[source]["epoch"], 1, source, 1)])
                projections.append({"receiver": receiver, "scope": scope, "cursor_and_entity": stored[0]})

            if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
                receipt = {"platform": sys.platform, "commands": exits, "projections": projections}
                with Path(summary).open("a", encoding="utf-8") as out:
                    out.write("### Two-host CLI replication over the test byte channel\n\n")
                    out.write("```json\n" + json.dumps(receipt, indent=2) + "\n```\n")
