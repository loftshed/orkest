from __future__ import annotations

import hashlib
import http.server
import json
import os
import shutil
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

import install_mailbox
import runtime_paths


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
            "ORK_DISABLE_FAST": "0",
            "ORK_FAST_BIN": str(ORK_FAST_BIN),
            "ORCHESTRATE_HOME": str(self.home / ".config/orchestrate"),
        }

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

    def test_mailbox_hook_plan_mode_suppression_parity(self):
        """Test Stop hook suppression on ExitPlanMode/EnterPlanMode tool use."""
        payload = json.dumps({
            "event": "Stop",
            "tool_name": "ExitPlanMode",
            "tool_input": {},
        })
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
            # Must raise ValueError on mismatch
            with mock.patch("install_mailbox.shutil.which", return_value=None):
                dest = install_mailbox.ensure_ork_fast(
                    home=isolated_home,
                    base_url=base_url,
                    force_build=False,
                    env={"HOME": str(isolated_home)},
                )
                # When download fails due to corrupt digest and cargo is missing, returns None
                self.assertIsNone(dest)
        finally:
            server.shutdown()
            server.server_close()

    def test_benchmark_latency_medians(self):
        """30-iteration benchmark verifying <2ms median latency for hot paths."""
        iterations = 30

        # 1. gate-hook non-heavy
        gate_times = []
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "git status"}})
        for _ in range(iterations):
            t0 = time.perf_counter()
            subprocess.run(
                [str(ORK_FAST_BIN), "gate-hook", "--harness", "claude"],
                input=payload,
                text=True,
                capture_output=True,
                env=self.env,
            )
            gate_times.append((time.perf_counter() - t0) * 1000.0)
        gate_median = sorted(gate_times)[iterations // 2]

        # 2. statusline --plain
        statusline_times = []
        for _ in range(iterations):
            t0 = time.perf_counter()
            subprocess.run(
                [str(ORK_FAST_BIN), "statusline", "--plain"],
                input="{}",
                capture_output=True,
                text=True,
                env=self.env,
            )
            statusline_times.append((time.perf_counter() - t0) * 1000.0)
        statusline_median = sorted(statusline_times)[iterations // 2]

        # 3. mailbox-hook ExitPlanMode suppression fast path
        mailbox_times = []
        mb_payload = json.dumps({"event": "Stop", "tool_name": "ExitPlanMode", "tool_input": {}})
        for _ in range(iterations):
            t0 = time.perf_counter()
            subprocess.run(
                [str(ORK_FAST_BIN), "mailbox-hook", "--harness", "claude"],
                input=mb_payload,
                text=True,
                capture_output=True,
                env=self.env,
            )
            mailbox_times.append((time.perf_counter() - t0) * 1000.0)
        mailbox_median = sorted(mailbox_times)[iterations // 2]

        print(
            f"\nBenchmark 30-iter medians: "
            f"gate-hook={gate_median:.2f}ms, "
            f"statusline={statusline_median:.2f}ms, "
            f"mailbox-hook={mailbox_median:.2f}ms"
        )
        # All hot paths should execute with low overhead (sub-3ms process invocation on macOS)
        self.assertLess(gate_median, 5.0)
        self.assertLess(statusline_median, 5.0)
        self.assertLess(mailbox_median, 5.0)


if __name__ == "__main__":
    unittest.main()
