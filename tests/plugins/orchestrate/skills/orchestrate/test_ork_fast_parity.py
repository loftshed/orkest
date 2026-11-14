from __future__ import annotations

import datetime as dt
import hashlib
import http.server
import json
import os
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[5]
ORK_FAST_BIN = REPO_ROOT / "crates/ork-fast/target/release/ork-fast"
SCRIPTS = REPO_ROOT / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))

import install_mailbox  # noqa: E402 -- exercise the shipped installer
import peer_mailbox  # noqa: E402 -- exercise the shipped mailbox hooks
import runtime_paths  # noqa: E402 -- exercise shipped path helpers


class TestOrkFastParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not ORK_FAST_BIN.is_file():
            # Build release binary if missing
            subprocess.run(
                ["cargo", "build", "--manifest-path", str(REPO_ROOT / "crates/ork-fast/Cargo.toml"), "--release"],
                check=True,
                capture_output=True,
            )
        assert ORK_FAST_BIN.is_file(), f"ork-fast binary missing at {ORK_FAST_BIN}"

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.home = Path(self.temp_dir.name) / "home"
        self.home.mkdir(parents=True)
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "XDG_CACHE_HOME": str(self.home / ".cache"),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "ORK_DISABLE_FAST": "0",
            "ORK_FAST_BIN": str(ORK_FAST_BIN),
            "ORCHESTRATE_HOME": str(self.home / ".config/orchestrate"),
        }
        self.env.pop("AGENT_EXECUTOR_HOME", None)
        self.env.pop("NO_COLOR", None)

    def test_gate_hook_non_heavy_parity(self):
        """Test non-heavy commands are allowed identically by Python and Rust."""
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "git status"}})
        py_proc = subprocess.run(
            [sys.executable, str(SCRIPTS / "gate.py"), "hook", "--harness", "claude"],
            input=payload,
            text=True,
            capture_output=True,
            env=self.env,
        )
        rust_proc = subprocess.run(
            [str(ORK_FAST_BIN), "gate-hook", "--harness", "claude", "--fallback-script", str(SCRIPTS / "gate.py")],
            input=payload,
            text=True,
            capture_output=True,
            env=self.env,
        )
        self.assertEqual(py_proc.returncode, rust_proc.returncode)
        self.assertEqual(py_proc.stdout.strip(), rust_proc.stdout.strip())

    def test_gate_hook_bypass_parity(self):
        """Test gated wrapped commands (e.g. ork gate --heavy --) are allowed identically."""
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "ork gate --heavy -- yarn test"}})
        py_proc = subprocess.run(
            [sys.executable, str(SCRIPTS / "gate.py"), "hook", "--harness", "claude"],
            input=payload,
            text=True,
            capture_output=True,
            env=self.env,
        )
        rust_proc = subprocess.run(
            [str(ORK_FAST_BIN), "gate-hook", "--harness", "claude", "--fallback-script", str(SCRIPTS / "gate.py")],
            input=payload,
            text=True,
            capture_output=True,
            env=self.env,
        )
        self.assertEqual(py_proc.returncode, 0)
        self.assertEqual(rust_proc.returncode, 0)
        self.assertEqual(py_proc.stdout.strip(), "")
        self.assertEqual(rust_proc.stdout.strip(), "")

    def test_lease_holder_parity(self):
        """Test lease-holder acquisition, busy exclusion, and release on stdin EOF."""
        target_dir = self.home / "worktree"
        target_dir.mkdir()

        # 1. Acquire with ork-fast
        proc1 = subprocess.Popen(
            [str(ORK_FAST_BIN), "lease-holder", str(target_dir), "--namespace", "test-ns"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=self.env,
        )
        try:
            line1 = proc1.stdout.readline()
            data1 = json.loads(line1)
            self.assertEqual(data1.get("status"), "acquired")

            # 2. Try second acquire while first holds it -> busy
            proc2 = subprocess.run(
                [str(ORK_FAST_BIN), "lease-holder", str(target_dir), "--namespace", "test-ns"],
                capture_output=True,
                text=True,
                env=self.env,
            )
            self.assertEqual(proc2.returncode, 0)
            data2 = json.loads(proc2.stdout)
            self.assertEqual(data2.get("status"), "busy")

            # 3. Close stdin of first holder -> releases and exits 0
            proc1.stdin.close()
            proc1.stdout.close()
            proc1.stderr.close()
            proc1.wait(timeout=2)
            self.assertEqual(proc1.returncode, 0)

            # 4. Now acquire should succeed again
            proc3 = subprocess.Popen(
                [str(ORK_FAST_BIN), "lease-holder", str(target_dir), "--namespace", "test-ns"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=self.env,
            )
            try:
                line3 = proc3.stdout.readline()
                data3 = json.loads(line3)
                self.assertEqual(data3.get("status"), "acquired")
            finally:
                proc3.stdin.close()
                proc3.stdout.close()
                proc3.stderr.close()
                proc3.wait(timeout=2)
        finally:
            if proc1.poll() is None:
                proc1.kill()
                proc1.wait()

    def test_lease_holder_nonexistent_leaf_parity(self):
        """Test lease-holder resolves nonexistent leaf paths identically to Python."""
        missing_leaf = self.home / "existing-parent" / "nonexistent-worktree-leaf"
        missing_leaf.parent.mkdir(parents=True)

        proc1 = subprocess.Popen(
            [str(ORK_FAST_BIN), "lease-holder", str(missing_leaf), "--namespace", "leaf-ns"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=self.env,
        )
        try:
            data1 = json.loads(proc1.stdout.readline())
            self.assertEqual(data1.get("status"), "acquired")

            py_proc = subprocess.run(
                [sys.executable, str(SCRIPTS / "lease_holder.py"), str(missing_leaf), "--namespace", "leaf-ns"],
                capture_output=True,
                text=True,
                env=self.env,
            )
            self.assertEqual(py_proc.returncode, 0)
            self.assertEqual(json.loads(py_proc.stdout).get("status"), "busy")
        finally:
            if proc1.stdin and not proc1.stdin.closed:
                proc1.stdin.close()
            if proc1.stdout:
                proc1.stdout.close()
            if proc1.stderr:
                proc1.stderr.close()
            proc1.wait(timeout=2)

    def test_statusline_parity(self):
        """Test statusline rendering across --plain, --json, --tmux."""
        for flag in ("--plain", "--json", "--tmux"):
            py_proc = subprocess.run(
                [sys.executable, str(SCRIPTS / "agent_statusline.py"), flag],
                input="{}",
                capture_output=True,
                text=True,
                env=self.env,
            )
            rust_proc = subprocess.run(
                [
                    str(ORK_FAST_BIN),
                    "statusline",
                    flag,
                    "--fallback-script",
                    str(SCRIPTS / "agent_statusline.py"),
                ],
                input="{}",
                capture_output=True,
                text=True,
                env=self.env,
            )
            self.assertEqual(py_proc.returncode, rust_proc.returncode)
            if flag == "--json":
                py_out = json.loads(py_proc.stdout) if py_proc.stdout.strip() else {}
                rust_out = json.loads(rust_proc.stdout) if rust_proc.stdout.strip() else {}
                self.assertEqual(py_out, rust_out)
            else:
                self.assertEqual(py_proc.stdout.strip(), rust_proc.stdout.strip())

    def test_statusline_populated_fixture_parity(self):
        """Compare Python and Rust statusline on populated peer + fresh/stale progress fixtures."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        (mailbox_root / "peers").mkdir(parents=True)
        (mailbox_root / "progress").mkdir(parents=True)

        checkout_dir = self.home / "repo" / "wt-201"
        checkout_dir.mkdir(parents=True)
        resolved_checkout = str(checkout_dir.resolve())
        session_id = "sess-status-parity-1"
        s_key = peer_mailbox.session_key(session_id)
        now_stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

        peer_record = {
            "schema": "agent-executor.peer.v1",
            "session": session_id,
            "name": "iron-aurora-ab",
            "harness": "claude",
            "cwd": resolved_checkout,
            "checkout": resolved_checkout,
            "repo": str(self.home / "repos" / "orkest"),
            "sessionModel": "claude-sonnet-4-6",
            "effort": "high",
            "state": "busy",
            "pid": os.getpid(),
            "startedAt": now_stamp,
            "lastSeenAt": now_stamp,
        }
        (mailbox_root / "peers" / f"{s_key}.json").write_text(json.dumps(peer_record), encoding="utf-8")

        stale_stamp = (dt.datetime.now(dt.UTC) - dt.timedelta(minutes=45)).strftime("%Y-%m-%dT%H:%M:%SZ")
        for label_case, stamp, stage in (
            ("fresh", now_stamp, "testing"),
            ("stale", stale_stamp, "working"),
        ):
            with self.subTest(case=label_case):
                progress_record = {
                    "schema": "orchestrate.progress.v1",
                    "session": session_id,
                    "harness": "claude",
                    "machine": socket.gethostname(),
                    "accountHome": None,
                    "checkout": resolved_checkout,
                    "role": "builder",
                    "goal": "Ship issue 201",
                    "task": "Fix statusline parity",
                    "stage": stage,
                    "updatedAt": stamp,
                }
                (mailbox_root / "progress" / f"{s_key}.json").write_text(json.dumps(progress_record), encoding="utf-8")
                stdin_payload = json.dumps({"session_id": session_id, "terminal_width": 110})
                for extra_flags in (["--json"], ["--plain"], ["--tmux"], ["--native-status"]):
                    py_proc = subprocess.run(
                        [sys.executable, str(SCRIPTS / "agent_statusline.py"), "--harness", "claude", *extra_flags],
                        input=stdin_payload,
                        capture_output=True,
                        text=True,
                        env=self.env,
                    )
                    rust_proc = subprocess.run(
                        [
                            str(ORK_FAST_BIN),
                            "statusline",
                            "--harness",
                            "claude",
                            "--fallback-script",
                            str(SCRIPTS / "agent_statusline.py"),
                            *extra_flags,
                        ],
                        input=stdin_payload,
                        capture_output=True,
                        text=True,
                        env=self.env,
                    )
                    self.assertEqual(py_proc.returncode, rust_proc.returncode)
                    if "--json" in extra_flags:
                        self.assertEqual(json.loads(py_proc.stdout), json.loads(rust_proc.stdout))
                    else:
                        self.assertEqual(py_proc.stdout, rust_proc.stdout)

    def test_mailbox_hook_stop_preinvocation_and_unread_parity(self):
        """Test Stop state->idle + gemini lastStopReason, PreInvocation mid-turn, and unread inbox delegation."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        (mailbox_root / "peers").mkdir(parents=True)
        session_id = "sess-mailbox-parity-1"
        s_key = peer_mailbox.session_key(session_id)
        peer_file = mailbox_root / "peers" / f"{s_key}.json"
        old_stamp = (dt.datetime.now(dt.UTC) - dt.timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
        checkout_dir = self.home / "repo"
        checkout_dir.mkdir(parents=True)

        peer_record = {
            "schema": "agent-executor.peer.v1",
            "session": session_id,
            "name": "cobalt-nova-cd",
            "harness": "gemini",
            "cwd": str(checkout_dir.resolve()),
            "checkout": str(checkout_dir.resolve()),
            "repo": str(checkout_dir.resolve()),
            "remotes": [],
            "model": "gemini-3.8-flash-high",
            "state": "busy",
            "pid": os.getpid(),
            "startedAt": old_stamp,
            "lastSeenAt": old_stamp,
        }
        peer_file.write_text(json.dumps(peer_record), encoding="utf-8")

        # 1. PreInvocation mid-turn fast-path updates lastSeenAt cleanly
        pre_proc = subprocess.run(
            [
                str(ORK_FAST_BIN),
                "mailbox-hook",
                "--harness",
                "gemini",
                "--event",
                "PreInvocation",
                "--fallback-script",
                str(SCRIPTS / "peer_mailbox.py"),
            ],
            input=json.dumps({"session_id": session_id, "prompt": "continue work"}),
            text=True,
            capture_output=True,
            env=self.env,
        )
        self.assertEqual(pre_proc.returncode, 0)
        self.assertEqual(pre_proc.stdout.strip(), "")
        after_pre = json.loads(peer_file.read_text(encoding="utf-8"))
        self.assertEqual(after_pre["state"], "busy")
        self.assertNotEqual(after_pre["lastSeenAt"], old_stamp)

        # 2. Stop transitions busy -> idle and sets gemini lastStopReason
        stop_proc = subprocess.run(
            [
                str(ORK_FAST_BIN),
                "mailbox-hook",
                "--harness",
                "gemini",
                "--event",
                "Stop",
                "--fallback-script",
                str(SCRIPTS / "peer_mailbox.py"),
            ],
            input=json.dumps({"session_id": session_id, "terminationReason": "end_turn"}),
            text=True,
            capture_output=True,
            env=self.env,
        )
        self.assertEqual(stop_proc.returncode, 0)
        self.assertEqual(stop_proc.stdout.strip(), "")
        after_stop = json.loads(peer_file.read_text(encoding="utf-8"))
        self.assertEqual(after_stop["state"], "idle")
        self.assertEqual(after_stop.get("lastStopReason"), "end_turn")

        # 3. Unread message in inbox/<key>/ must delegate on both PreInvocation and Stop
        inbox_dir = mailbox_root / "inbox" / s_key
        inbox_dir.mkdir(parents=True)
        for idx, ev in enumerate(("PreInvocation", "Stop"), start=1):
            after_stop["state"] = "busy"
            after_stop.pop("lastStopReason", None)
            peer_file.write_text(json.dumps(after_stop), encoding="utf-8")
            msg_id = f"deadbeef{idx}-123456"
            (inbox_dir / f"{msg_id}.json").write_text(
                json.dumps(
                    {
                        "schema": "agent-executor.mail.v1",
                        "id": msg_id,
                        "sentAt": old_stamp,
                        "from": {
                            "session": "coord-1",
                            "name": "coordinator",
                            "harness": "claude",
                            "cwd": str(checkout_dir.resolve()),
                            "checkout": str(checkout_dir.resolve()),
                            "repo": str(checkout_dir.resolve()),
                            "remotes": [],
                        },
                        "to": {"session": session_id, "name": "cobalt-nova-cd", "harness": "gemini"},
                        "scope": "cross-project",
                        "text": "check new instructions",
                    }
                ),
                encoding="utf-8",
            )
            delegated = subprocess.run(
                [
                    str(ORK_FAST_BIN),
                    "mailbox-hook",
                    "--harness",
                    "gemini",
                    "--event",
                    ev,
                    "--fallback-script",
                    str(SCRIPTS / "peer_mailbox.py"),
                ],
                input=json.dumps({"session_id": session_id, "cwd": str(checkout_dir.resolve())}),
                text=True,
                capture_output=True,
                env=self.env,
            )
            self.assertEqual(delegated.returncode, 0)
            self.assertIn("check new instructions", delegated.stdout)

    def test_mailbox_hook_plan_mode_suppression_parity(self):
        """Test Stop hook suppression on ExitPlanMode/EnterPlanMode tool use."""
        payload = json.dumps(
            {
                "event": "Stop",
                "tool_name": "ExitPlanMode",
                "tool_input": {},
            }
        )
        rust_proc = subprocess.run(
            [
                str(ORK_FAST_BIN),
                "mailbox-hook",
                "--harness",
                "claude",
                "--fallback-script",
                str(SCRIPTS / "peer_mailbox.py"),
            ],
            input=payload,
            text=True,
            capture_output=True,
            env=self.env,
        )
        self.assertEqual(rust_proc.returncode, 0)
        self.assertEqual(rust_proc.stdout.strip(), "")

    def test_mailbox_hook_delegation_to_fallback(self):
        """Test fallback script delegation when slow path (SessionStart) is requested."""
        payload = json.dumps({"session_id": "test-session-123"})
        rust_proc = subprocess.run(
            [
                str(ORK_FAST_BIN),
                "mailbox-hook",
                "--harness",
                "claude",
                "--event",
                "SessionStart",
                "--fallback-script",
                str(SCRIPTS / "peer_mailbox.py"),
            ],
            input=payload,
            text=True,
            capture_output=True,
            env=self.env,
        )
        # Even if SessionStart does no-op or writes session, it completes without error
        self.assertEqual(rust_proc.returncode, 0)

    def test_ensure_ork_fast_download_and_verify(self):
        """Test downloading ork-fast with strict SHA-256 verification and atomic replace."""
        target = install_mailbox.target_triple()
        if not target:
            self.skipTest("unsupported target triple for mock download")

        dummy_binary_content = b"#!/bin/sh\necho ork-fast-test\n"
        computed_sha = hashlib.sha256(dummy_binary_content).hexdigest()
        binary_name = f"ork-fast-{target}"
        sha_content = f"{computed_sha}  {binary_name}\n"

        # Set up simple in-process HTTP server
        class MockHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/SHA256SUMS":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain")
                    self.end_headers()
                    self.wfile.write(sha_content.encode("utf-8"))
                elif self.path == f"/{binary_name}":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.end_headers()
                    self.wfile.write(dummy_binary_content)
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, format, *args):
                pass  # suppress HTTP logging

        server = socketserver.TCPServer(("127.0.0.1", 0), MockHandler)
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever)
        t.daemon = True
        t.start()
        try:
            base_url = f"http://127.0.0.1:{port}"
            isolated_home = self.home / "download_test"
            isolated_home.mkdir()
            dest = install_mailbox.ensure_ork_fast(
                home=isolated_home,
                base_url=base_url,
                force_build=False,
                env={"HOME": str(isolated_home)},
            )
            self.assertIsNotNone(dest)
            self.assertTrue(dest.is_file())
            self.assertEqual(dest.read_bytes(), dummy_binary_content)
            meta_file = dest.with_name("ork-fast.meta.json")
            self.assertTrue(meta_file.is_file())
            meta = json.loads(meta_file.read_text())
            self.assertEqual(meta.get("sha256"), computed_sha)
        finally:
            server.shutdown()
            server.server_close()

    def test_ensure_ork_fast_corrupt_digest_rejected(self):
        """Test corrupt digest raises ValueError and aborts installation."""
        target = install_mailbox.target_triple()
        if not target:
            self.skipTest("unsupported target triple for mock download")

        dummy_binary_content = b"corrupt binary"
        bad_sha = "0000000000000000000000000000000000000000000000000000000000000000"
        binary_name = f"ork-fast-{target}"
        sha_content = f"{bad_sha}  {binary_name}\n"

        class MockHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/SHA256SUMS":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(sha_content.encode("utf-8"))
                elif self.path == f"/{binary_name}":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(dummy_binary_content)
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, format, *args):
                pass

        server = socketserver.TCPServer(("127.0.0.1", 0), MockHandler)
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever)
        t.daemon = True
        t.start()
        try:
            base_url = f"http://127.0.0.1:{port}"
            isolated_home = self.home / "corrupt_test"
            isolated_home.mkdir()
            # Must raise ValueError on mismatch rather than silently falling back
            with mock.patch("install_mailbox.shutil.which", return_value=None):
                with self.assertRaisesRegex(ValueError, "SHA-256 digest mismatch"):
                    install_mailbox.ensure_ork_fast(
                        home=isolated_home,
                        base_url=base_url,
                        force_build=False,
                        env={"HOME": str(isolated_home)},
                    )
            self.assertFalse((isolated_home / ".cache/orchestrate/bin/ork-fast").exists())
            self.assertFalse((isolated_home / "Library/Caches/orchestrate/bin/ork-fast").exists())
        finally:
            server.shutdown()
            server.server_close()

    def _median_ms(self, cmd: list[str], stdin_data: str, iterations: int = 15) -> float:
        subprocess.run(cmd, input=stdin_data, text=True, capture_output=True, env=self.env, check=True)
        samples = []
        for _ in range(iterations):
            t0 = time.perf_counter()
            subprocess.run(cmd, input=stdin_data, text=True, capture_output=True, env=self.env, check=True)
            samples.append((time.perf_counter() - t0) * 1000.0)
        return sorted(samples)[iterations // 2]

    def test_benchmark_latency_medians(self):
        """Verify ork-fast hot paths are at least 2x faster than Python fallbacks."""
        gate_payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "git status"}})
        mb_payload = json.dumps({"event": "Stop", "tool_name": "ExitPlanMode", "tool_input": {}})

        cases = [
            (
                "gate-hook",
                [str(ORK_FAST_BIN), "gate-hook", "--harness", "claude"],
                [sys.executable, str(SCRIPTS / "gate.py"), "hook", "--harness", "claude"],
                gate_payload,
            ),
            (
                "statusline",
                [str(ORK_FAST_BIN), "statusline", "--plain"],
                [sys.executable, str(SCRIPTS / "agent_statusline.py"), "--plain"],
                "{}",
            ),
            (
                "mailbox-hook",
                [str(ORK_FAST_BIN), "mailbox-hook", "--harness", "claude"],
                [sys.executable, str(SCRIPTS / "peer_mailbox.py"), "hook", "--harness", "claude"],
                mb_payload,
            ),
        ]

        parts = []
        for label, fast_cmd, py_cmd, stdin_data in cases:
            fast_ms = self._median_ms(fast_cmd, stdin_data)
            py_ms = self._median_ms(py_cmd, stdin_data)
            parts.append(f"{label}={fast_ms:.2f}ms (py={py_ms:.2f}ms)")
            self.assertLess(
                fast_ms, py_ms * 0.5, f"{label}: ork-fast ({fast_ms:.2f}ms) not < 0.5x python ({py_ms:.2f}ms)"
            )
            self.assertLess(fast_ms, 25.0, f"{label}: ork-fast ({fast_ms:.2f}ms) exceeded 25ms ceiling")

        print("\nBenchmark 15-iter medians: " + ", ".join(parts))


if __name__ == "__main__":
    unittest.main()
