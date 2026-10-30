"""A wrapped terminal follows its visible native session without guessing from shared processes."""

from __future__ import annotations

import json
import os
import pty
import re
import secrets
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import time
import unittest
import uuid
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import agent_progress as progress  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402


@unittest.skipUnless(shutil.which("tmux"), "native pane binding requires tmux")
class TerminalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.base = self.home / "mailbox-v1"
        self.server = "orkest-label-" + secrets.token_hex(6)
        self.tmux = ["tmux", "-L", self.server]
        subprocess.run([*self.tmux, "-f", "/dev/null", "new-session", "-d", "--", "sleep", "120"], check=True)
        self.addCleanup(lambda: subprocess.run([*self.tmux, "kill-server"], capture_output=True, check=False))
        socket = subprocess.check_output([*self.tmux, "display-message", "-p", "#{socket_path}"], text=True).strip()
        self.environment = {**os.environ, "AGENT_EXECUTOR_HOME": str(self.home)}
        for key in ("ORKEST_TERMINAL_SERVER", "ORKEST_TERMINAL_HARNESS", "TMUX", "TMUX_PANE"):
            self.environment.pop(key, None)
        self.native = {
            **self.environment,
            "ORKEST_TERMINAL_SERVER": self.server,
            "TMUX": socket + ",123,0",
            "TMUX_PANE": "%0",
        }

    def peer(self, session, harness):
        mailbox.register(self.base, session=session, harness=harness, cwd=str(self.home), pid=os.getpid())
        mailbox.annotate(self.base, session, name="snorfle-test-high-footer-aa")

    def native_status(self, harness, session, *, clear=False, extra_environment=None):
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(SCRIPTS / "agent_statusline.py"),
                "--native-status",
                "--harness",
                harness,
                *(["--clear-terminal", session] if clear else []),
            ],
            input=json.dumps({"session_id": session, "model": {"id": "runtime-model"}, "effort": {"level": "high"}}),
            env={**self.native, "ORKEST_TERMINAL_HARNESS": harness, **(extra_environment or {})},
            capture_output=True,
            text=True,
            check=True,
        ).stdout

    def footer(self, harness):
        output = subprocess.check_output(
            [
                sys.executable,
                "-B",
                str(SCRIPTS / "agent_statusline.py"),
                "--terminal-pane",
                "%0",
                "--tmux-server",
                self.server,
                "--harness",
                harness,
                "--json",
                "--width",
                "200",
            ],
            env=self.environment,
            text=True,
        )
        return json.loads(output) if output else None

    def test_native_integrations_are_silent_and_feed_the_same_outer_footer(self):
        for harness in ("claude", "gemini", "opencode"):
            with self.subTest(harness=harness):
                session = "visible-" + harness
                self.peer(session, harness)
                self.assertEqual(self.native_status(harness, session), "")
                item = self.footer(harness)
                self.assertEqual(
                    (item["name"], item["model"], item["effort"]),
                    ("snorfle-test-high-footer-aa", "runtime-model", "high"),
                )

    def test_binding_before_registration_does_not_create_presence(self):
        self.assertEqual(self.native_status("claude", "not-registered"), "")
        self.assertIsNone(self.footer("claude"))
        self.assertFalse(mailbox.peer_path(self.base, "not-registered").exists())
        self.peer("not-registered", "claude")
        self.assertEqual(self.footer("claude")["name"], "snorfle-test-high-footer-aa")

    def test_session_switches_and_late_cleanup_cannot_clear_the_new_session(self):
        for session in ("first", "second"):
            self.peer(session, "opencode")
            mailbox.annotate(self.base, session, name="agent-" + session)
            self.native_status("opencode", session)
        self.native_status("opencode", "first", clear=True)
        self.assertEqual(self.footer("opencode")["name"], "agent-second")
        self.native_status("opencode", "second", clear=True)
        self.assertIsNone(self.footer("opencode"))

    def test_a_nested_terminal_or_other_harness_cannot_replace_the_binding(self):
        self.peer("main", "claude")
        self.native_status("claude", "main")
        self.peer("other", "gemini")
        self.native_status("gemini", "other", extra_environment={"ORKEST_TERMINAL_HARNESS": "claude"})
        self.assertEqual(self.footer("claude")["name"], "snorfle-test-high-footer-aa")
        self.native_status("claude", "other", extra_environment={"TMUX": "/tmp/another-server,1,0"})
        self.assertEqual(self.footer("claude")["model"], "runtime-model")
        self.assertIsNone(self.footer("gemini"))

    def test_plain_launches_keep_the_native_display_without_touching_a_pane(self):
        self.peer("plain", "claude")
        output = subprocess.check_output(
            [
                sys.executable,
                "-B",
                str(SCRIPTS / "agent_statusline.py"),
                "--session",
                "plain",
                "--harness",
                "claude",
                "--plain",
                "--native-status",
                "--width",
                "200",
            ],
            env=self.environment,
            text=True,
        )
        self.assertEqual(
            output, "snorfle-test-high-footer-aa | — / — | stage : not set | goal : not set | task : not set\n"
        )
        self.assertIsNone(self.footer("claude"))

    def test_reading_another_session_inside_a_wrapper_does_not_rebind_it(self):
        self.peer("visible", "claude")
        self.peer("inspected", "claude")
        mailbox.annotate(self.base, "inspected", name="other-agent")
        self.native_status("claude", "visible")
        output = subprocess.check_output(
            [
                sys.executable,
                "-B",
                str(SCRIPTS / "agent_statusline.py"),
                "--session",
                "inspected",
                "--harness",
                "claude",
                "--json",
            ],
            env={**self.native, "ORKEST_TERMINAL_HARNESS": "claude"},
            text=True,
        )
        self.assertEqual(json.loads(output)["name"], "other-agent")
        self.assertEqual(self.footer("claude")["name"], "snorfle-test-high-footer-aa")

    def test_all_four_launchers_render_the_same_outer_footer(self):
        for executable, harness in (
            ("codex", "codex"),
            ("claude", "claude"),
            ("agy", "gemini"),
            ("opencode", "opencode"),
        ):
            with self.subTest(harness=harness):
                session = str(uuid.uuid4())
                peer = mailbox.register(
                    self.base,
                    session=session,
                    harness=harness,
                    cwd=str(self.home),
                    pid=os.getpid(),
                    account=str(self.home),
                    model="fixture-model",
                    effort="high",
                )
                progress.report(self.base, peer, goal="Verify launch", task="Render wrapper", stage="testing")
                info = self.home / (executable + ".json")
                binary = self.home / executable
                binary.write_text(
                    "#!" + sys.executable + "\n"
                    "import json, os, subprocess, sys\nfrom pathlib import Path\n"
                    "arguments = sys.argv[1:]\n"
                    + (
                        "sys.stdout.write(" + repr("\033]2;" + session + "\007") + ")\noutput = ''\n"
                        if harness == "codex"
                        else "output = subprocess.check_output("
                        + repr(
                            [
                                sys.executable,
                                str(SCRIPTS / "agent_statusline.py"),
                                "--native-status",
                                "--session",
                                session,
                                "--harness",
                                harness,
                                "--json",
                            ]
                        )
                        + ", text=True)\n"
                    )
                    + "Path("
                    + repr(str(info))
                    + ").write_text(json.dumps({'socket': os.environ['TMUX'].split(',')[0], "
                    "'arguments': arguments, 'nativeOutput': output}))\n"
                    "print('Harness content', flush=True)\n"
                    "while os.read(0, 1024): pass\n"
                )
                binary.chmod(0o755)
                environment = {**self.environment, "CODEX_HOME": str(self.home), "TERM": "xterm-256color"}
                environment.pop("NO_COLOR", None)
                pid, master = pty.fork()
                if pid == 0:
                    termios.tcsetwinsize(0, (30, 200))
                    os.execvpe(
                        "node",
                        [
                            "node",
                            str(SCRIPTS.parents[2] / "bin/ork.mjs"),
                            "label",
                            "--",
                            str(binary),
                            "--model",
                            "fixture-model",
                        ],
                        environment,
                    )
                output = b""
                try:
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        if select.select([master], [], [], 0.1)[0]:
                            output += os.read(master, 65536)
                        plain = re.sub(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\(B)", b"", output)
                        if b"task : Render wrapper" in plain:
                            break
                    self.assertIn(b"Harness content", plain)
                    self.assertIn(b"stage : testing | goal : Verify launch | task : Render wrapper", plain)
                    launched = json.loads(info.read_text())
                    self.assertEqual(launched["nativeOutput"], "")
                    expected = ["--model", "fixture-model"]
                    if harness == "codex":
                        expected = ["-c", 'tui.terminal_title=["session-id"]', *expected]
                    self.assertEqual(launched["arguments"], expected)
                finally:
                    if info.exists():
                        socket = json.loads(info.read_text())["socket"]
                        subprocess.run(["tmux", "-S", socket, "kill-server"], capture_output=True, check=False)
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
