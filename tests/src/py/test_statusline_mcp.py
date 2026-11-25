"""`ork-fast statusline-mcp` draws the Orkest agent bar in Codex's custom status line over stdio MCP."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS = Path(__file__).resolve().parents[3] / "src/py"
sys.path.insert(0, str(TESTS_DIR))
sys.path.insert(0, str(SCRIPTS))
import _ork_fast_test_helpers as fast  # noqa: E402
import agent_progress  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402

URI = "ui://orkest/statusline"
STATE_KEY = "com.openai/codex-statusline-state"
SESSION = "019a5da8-1234-5678-9abc-123456789012"
UNKNOWN = "019a5da8-0000-7000-8000-000000000000"
READ_BUDGET = 0.3


def snapshot(thread_id: str) -> dict:
    return {
        "app": {"cli_version": "0.171.0", "display_mode": "standard"},
        "config": {"statusline_items": []},
        "account": {"rate_limits": []},
        "thread": {
            "id": thread_id,
            "name": None,
            "agent": {"state": "working"},
            "model": {"display_name": "GPT-5.5", "id": "gpt-5.5", "provider": "openai", "reasoning_level": "high"},
            "workspace": {"cwd": "/tmp"},
            "usage": {"context": {"used_percentage": 12}},
        },
    }


def texts(node) -> list[str]:
    """Every leaf string in a UI tree, in order."""
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        return [leaf for child in node.get("children", []) for leaf in texts(child)]
    return []


class Provider:
    """One long-lived provider process, driven like Codex drives it."""

    def __init__(self, env: dict[str, str]):
        self.process = subprocess.Popen(
            [str(fast.find_ork_fast_bin()), "statusline-mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
        )
        self.next_id = 0

    def request(self, method: str, params: dict | None = None) -> tuple[dict, float]:
        self.next_id += 1
        message = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            message["params"] = params
        started = time.monotonic()
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        elapsed = time.monotonic() - started
        reply = json.loads(line)
        assert reply["id"] == self.next_id, reply
        return reply, elapsed

    def notify(self, method: str) -> None:
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
        self.process.stdin.flush()

    def read(self, thread_id: str) -> tuple[object, float]:
        reply, elapsed = self.request("resources/read", {"uri": URI, "_meta": {STATE_KEY: snapshot(thread_id)}})
        [content] = reply["result"]["contents"]
        assert (content["uri"], content["mimeType"]) == (URI, "application/json"), content
        return json.loads(content["text"]), elapsed

    def close(self) -> None:
        self.process.stdin.close()
        self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


class StatuslineProviderTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        self.base = self.home / "mailbox-v1"
        peer = mailbox.register(self.base, session=SESSION, harness="codex", cwd=str(self.home), pid=os.getpid())
        mailbox.annotate(self.base, SESSION, name="snorfle-test-high-footer-aa", person="snorfle")
        agent_progress.report(self.base, peer, goal="Ship labels", stage="working", task="Verify patch")
        # Only what Codex forwards (see install_mailbox.CODEX_STATUSLINE_ENV): never the live session.
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.home),
            "AGENT_EXECUTOR_HOME": str(self.home),
            "ORCHESTRATE_HOME": str(self.home),
            "ORK_GLYPHS": "ascii",
            "TMUX_TMPDIR": str(self.home / "tmux"),
        }

    def start(self, **extra: str) -> Provider:
        provider = Provider({**self.env, **extra})
        self.addCleanup(provider.close)
        return provider

    def assertFast(self, elapsed: float) -> None:
        self.assertLess(elapsed, READ_BUDGET, f"read took {elapsed * 1000:.0f} ms")

    def test_registered_session_gets_the_identity_bar_and_unknown_the_minimal_row(self):
        provider = self.start()
        init, _ = provider.request(
            "initialize",
            {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "codex", "version": "0"}},
        )
        self.assertEqual(init["result"]["serverInfo"]["name"], "orkest-statusline")
        self.assertIn("resources", init["result"]["capabilities"])
        provider.notify("notifications/initialized")
        tools, _ = provider.request("tools/list")
        [tool] = tools["result"]["tools"]
        self.assertEqual(tool["name"], "statusline")
        self.assertEqual(tool["_meta"]["openai/ui"]["entrypoints"], [{"type": "statusline", "resourceUri": URI}])

        tree, elapsed = provider.read(SESSION)
        self.assertFast(elapsed)
        self.assertEqual(tree["type"], "row")
        bar = "".join(texts(tree)).strip()
        repo = self.home.name
        self.assertEqual(
            bar,
            f"snorfle | gpt-5.5 / high | repo : {repo} | stage : working | goal : Ship labels | task : Verify patch",
        )
        swatch = tree["children"][0]
        self.assertRegex(swatch["props"]["background"], r"^#[0-9a-f]{6}$")
        name = next(child for child in tree["children"] if texts(child) == ["snorfle"])
        self.assertEqual(name["props"]["color"], swatch["props"]["background"])
        self.assertEqual(name["props"]["weight"], "bold")

        unknown, elapsed = provider.read(UNKNOWN)
        self.assertFast(elapsed)
        self.assertEqual(texts(unknown), ["GPT-5.5 high", "working"])
        self.assertEqual(unknown["children"][0]["props"]["color"], "status-model")

        # A read never fails Codex's poll: even an empty snapshot answers with a tree.
        reply, _ = provider.request("resources/read", {"uri": URI})
        self.assertIn("result", reply)
        other, _ = provider.request("resources/read", {"uri": "ui://other/footer"})
        self.assertEqual(other["error"]["code"], -32602)

    def test_session_under_the_private_tmux_footer_clears_the_codex_bar(self):
        server = "orkest-label-0123456789ab"
        provider = self.start(
            ORKEST_TERMINAL_SERVER=server,
            ORKEST_TERMINAL_HARNESS="codex",
            TMUX=f"/tmp/tmux-{os.getuid()}/{server},4242,0",
            TMUX_PANE="%3",
        )
        tree, elapsed = provider.read(SESSION)
        self.assertFast(elapsed)
        self.assertIsNone(tree)
        tree, _ = provider.read(UNKNOWN)
        self.assertIsNone(tree)

    def poll_until(self, provider: Provider, thread_id: str, expected) -> object:
        """Poll like Codex (a read, then a pause) until the cached bar catches up with the mailbox."""
        deadline = time.monotonic() + 5
        while True:
            tree, elapsed = provider.read(thread_id)
            self.assertFast(elapsed)
            if expected(tree) or time.monotonic() > deadline:
                return tree
            time.sleep(0.2)

    def test_recorded_footer_server_clears_the_bar_until_the_session_moves_to_herdr(self):
        server = "orkest-label-abcdefabcdef"
        mailbox.annotate(self.base, SESSION, terminalServer=server)
        provider = self.start()
        tree, _ = provider.read(SESSION)
        self.assertIsNotNone(tree, "a recorded server with no live socket draws no footer")

        sockets = self.home / "tmux" / f"tmux-{os.getuid()}"
        sockets.mkdir(parents=True)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(listener.close)
        listener.bind(str(sockets / server))
        self.assertIsNone(self.poll_until(provider, SESSION, lambda tree: tree is None))

        mailbox.annotate(self.base, SESSION, herdrPaneId="w1:p2")
        tree = self.poll_until(provider, SESSION, lambda tree: tree is not None)
        self.assertTrue("".join(texts(tree)).strip().startswith("snorfle | "), tree)

    def test_progress_changes_reach_a_polled_bar(self):
        provider = self.start()
        tree, _ = provider.read(SESSION)
        self.assertIn("task : Verify patch", "".join(texts(tree)))
        peer = mailbox.load(mailbox.peer_path(self.base, SESSION))
        agent_progress.report(self.base, peer, goal="Ship labels", stage="testing", task="Run the suite")
        tree = self.poll_until(provider, SESSION, lambda tree: "Run the suite" in "".join(texts(tree)))
        self.assertIn("stage : testing | goal : Ship labels | task : Run the suite", "".join(texts(tree)))

    def test_reads_stay_fast_over_a_polling_burst(self):
        provider = self.start()
        timings = [provider.read(SESSION)[1] for _ in range(20)]
        self.assertLess(max(timings), READ_BUDGET, timings)


if __name__ == "__main__":
    unittest.main()
