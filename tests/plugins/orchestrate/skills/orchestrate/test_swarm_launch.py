"""A real Stooges terminal launches once, shows live work, and reconnects without another agent."""

from __future__ import annotations

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
            home = Path(temporary)
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
                "room = re.search(r'Room: ([^\\n]+)', sys.argv[-1]).group(1)\n"
                "subprocess.run(['node', " + repr(str(CLI)) + ", 'rooms', 'bind', '--room', room, "
                "'--member', 'conductor', '--engine', "
                + repr(engine)
                + ", '--session', '11111111-2222-4333-8444-555555555555'], "
                "check=True, stdout=subprocess.DEVNULL)\n"
                "sys.stdout.write('\\033]2;11111111-2222-4333-8444-555555555555\\007')\n"
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
                "Path(" + repr(str(launched)) + ").write_text(json.dumps({'room': room, 'pid': os.getpid(), "
                "'socket': os.environ['TMUX'].split(',')[0], 'prompt': sys.argv[-1], 'flags': sys.argv[1:-1]}))\n"
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
                os.write(master, b"Redirect the investigation\n")
                wait_for(lambda _: received.exists() and received.read_text() == "Redirect the investigation\n", master)
                self.assertEqual(received.read_text(), "Redirect the investigation\n")
                room = info["room"]
                command("add", "--room", room, "--team", engine + ":host-default")
                command("lead", "--room", room, "--member", "host-default-1", "--objective", "Investigate cache")
                command("add", "--room", room, "--parent", "host-default-1", "--team", "agy:flash")
                wait_for(lambda output: b"host-default-1" in output and b"flash-1" in output, master)
                subprocess.run([*tmux, "select-pane", "-t", "%1"], check=True)
                progress.report(base, peer, goal="Repair cache", task="Inspect cache recovery", stage="testing")
                wait_for(
                    lambda output: b"task : Inspect cache recovery" in output,
                    master,
                    refresh=lambda: subprocess.run([*tmux, "refresh-client", "-S"], check=True),
                )
                os.write(master, b"\x02d")
                wait_for(lambda output: b"Reattach with: ork stooges --attach-room" in output, master)
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
                for file in (base / "rooms").glob("*.json"):
                    key = str(base.resolve()) + "/" + file.stem
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


if __name__ == "__main__":
    unittest.main()
