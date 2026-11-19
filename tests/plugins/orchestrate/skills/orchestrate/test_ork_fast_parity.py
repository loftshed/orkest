from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import http.server
import json
import os
import socket
import socketserver
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

REPO_ROOT = Path(__file__).resolve().parents[5]
SCRIPTS = REPO_ROOT / "plugins/orchestrate/skills/orchestrate/scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import _ork_fast_test_helpers as ORK_FAST  # noqa: E402
import handoff  # noqa: E402 -- exercise shipped Chief liveness parity
import install_mailbox  # noqa: E402 -- exercise the shipped installer
import mailbox_store  # noqa: E402 -- exercise shipped process birth helper
import mailbox_wake  # noqa: E402 -- exercise exact wake notice formatting
import peer_mailbox  # noqa: E402 -- exercise shipped peer storage helpers
import room_store  # noqa: E402 -- rooms written through the shipped Node store
import runtime_paths  # noqa: E402 -- exercise shipped path helpers

ORK_FAST_BIN = ORK_FAST.find_ork_fast_bin()


class TestOrkFastIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global ORK_FAST_BIN
        candidate = REPO_ROOT / "crates/ork-fast/target/release/ork-fast"
        if not candidate.is_file() and not ORK_FAST_BIN.is_file():
            subprocess.run(
                ["cargo", "build", "--manifest-path", str(REPO_ROOT / "crates/ork-fast/Cargo.toml"), "--release"],
                check=True,
                capture_output=True,
            )
        ORK_FAST_BIN = ORK_FAST.find_ork_fast_bin()
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
            "ORK_FAST_BIN": str(ORK_FAST_BIN),
            "ORCHESTRATE_HOME": str(self.home / ".config/orchestrate"),
            "ORKEST_SCRIPTS_DIR": str(SCRIPTS),
            "ORKEST_PLUGIN_ROOT": str(REPO_ROOT / "plugins/orchestrate"),
            "ORKEST_TEST_MODE": "1",
            "ORKEST_TEST_HARNESS_PID": str(os.getpid()),
            "PYTEST_CURRENT_TEST": "ork-fast-integration",
        }
        self.env.pop("AGENT_EXECUTOR_HOME", None)
        self.env.pop("NO_COLOR", None)
        self.env.pop("ORKEST_HANDOFF_SUCCESSOR", None)

    def test_gate_hook_non_heavy_heavy_and_fallback_flag(self):
        """Test gate-hook allows non-heavy commands, denies heavy ones across harnesses, and accepts --fallback-script."""
        gate_dir = self.home / "gate"
        env = {**self.env, "AGENT_GATE_DIR": str(gate_dir)}
        allow_proc = subprocess.run(
            [str(ORK_FAST_BIN), "gate-hook", "--harness", "claude", "--fallback-script", str(SCRIPTS / "gate.py")],
            input=json.dumps({"tool_name": "Bash", "tool_input": {"command": "git status"}}),
            text=True,
            capture_output=True,
            env=env,
        )
        self.assertEqual((allow_proc.returncode, allow_proc.stdout.strip()), (0, ""))

        claude = ORK_FAST.run_gate_hook(
            {"tool_name": "Bash", "tool_input": {"command": "yarn test"}},
            harness="claude",
            gate_dir=gate_dir,
            env=env,
        )
        self.assertEqual(claude["hookSpecificOutput"]["permissionDecision"], "deny")

        codex = ORK_FAST.run_gate_hook(
            {"tool_name": "Bash", "tool_input": {"command": ["bash", "-lc", "npx vitest run"]}},
            harness="codex",
            gate_dir=gate_dir,
            env=env,
        )
        self.assertEqual(codex["hookSpecificOutput"]["permissionDecision"], "deny")

        gemini = ORK_FAST.run_gate_hook(
            {"toolCall": {"name": "run_command", "args": {"CommandLine": "tsc --noEmit"}}},
            harness="gemini",
            gate_dir=gate_dir,
            env=env,
        )
        self.assertEqual(gemini["decision"], "deny")

        bad_proc = subprocess.run(
            [str(ORK_FAST_BIN), "gate-hook", "--harness", "claude"],
            input="{not valid json",
            text=True,
            capture_output=True,
            env=env,
        )
        self.assertEqual((bad_proc.returncode, bad_proc.stdout), (0, ""))

    def test_gate_hook_bypass_commands(self):
        """Test gated wrapped commands and focused tests are allowed cleanly."""
        gate_dir = self.home / "gate"
        for command in ("ork gate --heavy -- yarn test", "vitest related src/a.ts", "git commit -m 'yarn test'"):
            with self.subTest(command=command):
                self.assertIsNone(
                    ORK_FAST.run_gate_hook(
                        {"tool_name": "Bash", "tool_input": {"command": command}},
                        harness="claude",
                        gate_dir=gate_dir,
                        env=self.env,
                    )
                )

    def test_lease_holder_acquisition_exclusion_and_release(self):
        """Test lease-holder acquisition, busy exclusion, and release on stdin EOF."""
        target_dir = self.home / "worktree"
        target_dir.mkdir()

        proc1 = subprocess.Popen(
            [str(ORK_FAST_BIN), "lease-holder", str(target_dir), "--namespace", "test-ns"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=self.env,
        )
        try:
            data1 = json.loads(proc1.stdout.readline())
            self.assertEqual(data1.get("status"), "acquired")

            proc2 = subprocess.run(
                [str(ORK_FAST_BIN), "lease-holder", str(target_dir), "--namespace", "test-ns"],
                capture_output=True,
                text=True,
                env=self.env,
            )
            self.assertEqual(proc2.returncode, 0)
            self.assertEqual(json.loads(proc2.stdout).get("status"), "busy")

            proc1.stdin.close()
            proc1.stdout.close()
            proc1.stderr.close()
            proc1.wait(timeout=2)
            self.assertEqual(proc1.returncode, 0)

            proc3 = subprocess.Popen(
                [str(ORK_FAST_BIN), "lease-holder", str(target_dir), "--namespace", "test-ns"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=self.env,
            )
            try:
                data3 = json.loads(proc3.stdout.readline())
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
        """Test lease-holder resolves nonexistent leaf paths identically to lease_holder.py."""
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

    def test_statusline_empty_modes(self):
        """Test ork-fast statusline rendering across --plain, --json, --tmux when unbound."""
        for flag in ("--plain", "--json", "--tmux"):
            proc = ORK_FAST.run_statusline(
                flag,
                "--fallback-script",
                str(self.home / "unused-fallback.py"),
                stdin_data="{}",
                env=self.env,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            if flag == "--json":
                parsed = json.loads(proc.stdout) if proc.stdout.strip() else {}
                self.assertEqual(parsed, {})
            elif flag == "--tmux":
                self.assertEqual(proc.stdout.strip(), "Orkest: waiting for agent")
            else:
                self.assertEqual(proc.stdout.strip(), "")

    def test_statusline_populated_fixture(self):
        """Test ork-fast statusline on populated peer + fresh/stale progress fixtures."""
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
                stdin_payload = {"session_id": session_id, "terminal_width": 110}

                json_proc = ORK_FAST.run_statusline(
                    "--harness", "claude", "--json", stdin_data=stdin_payload, env=self.env, check=True
                )
                data = json.loads(json_proc.stdout)
                self.assertEqual(data["name"], "iron-aurora")
                self.assertEqual(data["fullName"], "iron-aurora-ab")
                self.assertEqual(data["role"], "builder")
                self.assertEqual(data["goal"], "Ship issue 201")
                self.assertEqual(data["task"], "Fix statusline parity")
                self.assertEqual(data["stage"], f"{stage} (stale)" if label_case == "stale" else stage)
                self.assertEqual(data["statusHealth"], label_case)

                plain_proc = ORK_FAST.run_statusline(
                    "--harness", "claude", "--plain", stdin_data=stdin_payload, env=self.env, check=True
                )
                self.assertIn("iron-aurora", plain_proc.stdout)
                self.assertIn("repo : orkest", plain_proc.stdout)
                self.assertIn("Ship issue", plain_proc.stdout)

                tmux_proc = ORK_FAST.run_statusline(
                    "--harness", "claude", "--tmux", stdin_data=stdin_payload, env=self.env, check=True
                )
                self.assertIn("#[", tmux_proc.stdout)

                native_proc = ORK_FAST.run_statusline(
                    "--harness", "claude", "--native-status", stdin_data=stdin_payload, env=self.env, check=True
                )
                self.assertIn("iron", native_proc.stdout)

    def test_statusline_chief_focus(self):
        """Test ork-fast statusline resolves live vs stale Chief focus captions."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        (mailbox_root / "peers").mkdir(parents=True)
        checkout_dir = self.home / "repo"
        checkout_dir.mkdir(parents=True)
        resolved_checkout = str(checkout_dir.resolve())
        session_id = "sess-chief-focus-parity"
        s_key = peer_mailbox.session_key(session_id)
        now_stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        chief_focus = "Ork Chief — machine-wide master orchestrator"

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
            "focus": chief_focus,
            "startedAt": now_stamp,
            "lastSeenAt": now_stamp,
        }
        (mailbox_root / "peers" / f"{s_key}.json").write_text(json.dumps(peer_record), encoding="utf-8")
        stdin_payload = {"session_id": session_id, "terminal_width": 120}

        scenarios = (
            ("missing_chief_json", None, "not set"),
            ("other_chief_session", {"schema": "ork.chief.v1", "session": "other-session"}, "not set"),
            ("matching_chief_session", {"schema": "ork.chief.v1", "session": session_id}, chief_focus),
            (
                "matching_chief_session_with_generation",
                {"schema": "ork.chief.v1", "session": session_id, "generation": "gen-1"},
                chief_focus,
            ),
        )
        for label_case, chief_doc, expected_task in scenarios:
            with self.subTest(case=label_case):
                chief_path = mailbox_root / "chief.json"
                if chief_doc is None:
                    chief_path.unlink(missing_ok=True)
                else:
                    chief_path.write_text(json.dumps(chief_doc), encoding="utf-8")
                rust_json = ORK_FAST.statusline_identity(
                    session_id, "claude", payload=stdin_payload, base=mailbox_root, env=self.env
                )
                self.assertEqual(rust_json["task"], expected_task)

    def test_chief_liveness_aged_non_shared_exact_peer_parity(self):
        """Test 8-day-old non-shared Chief exact peer with verified live PID fails closed in Python & Rust."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        (mailbox_root / "peers").mkdir(parents=True)
        checkout_dir = self.home / "repo"
        checkout_dir.mkdir(parents=True)
        resolved_checkout = str(checkout_dir.resolve())
        session_id = "sess-chief-aged-parity"
        s_key = peer_mailbox.session_key(session_id)
        pid = os.getpid()
        pid_birth = mailbox_store.process_started(pid)
        self.assertTrue(pid_birth)
        host = socket.gethostname()
        now = dt.datetime.now(dt.UTC)
        aged_stamp = (now - dt.timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%SZ")
        fresh_stamp = (now - dt.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        chief_focus = "Ork Chief — machine-wide master orchestrator"
        stdin_payload = {"session_id": session_id, "terminal_width": 120}

        peer_record = {
            "schema": "agent-executor.peer.v1",
            "session": session_id,
            "name": "iron-aurora-ab",
            "harness": "claude",
            "machine": host,
            "cwd": resolved_checkout,
            "checkout": resolved_checkout,
            "repo": str(self.home / "repos" / "orkest"),
            "sessionModel": "claude-sonnet-4-6",
            "effort": "high",
            "state": "idle",
            "sharedProcess": False,
            "pid": pid,
            "pidBirth": pid_birth,
            "focus": chief_focus,
            "startedAt": aged_stamp,
            "lastSeenAt": aged_stamp,
        }
        peer_file = mailbox_root / "peers" / f"{s_key}.json"
        peer_file.write_text(json.dumps(peer_record), encoding="utf-8")

        chief_doc = {
            "schema": "ork.chief.v1",
            "session": session_id,
            "machine": host,
            "pid": pid,
            "pidBirth": pid_birth,
            "boundAt": aged_stamp,
        }
        chief_file = mailbox_root / "chief.json"
        chief_file.write_text(json.dumps(chief_doc), encoding="utf-8")

        self.assertIsNone(handoff.live_chief_binding(mailbox_root, session_id))
        aged_rust = ORK_FAST.statusline_identity(
            session_id, "claude", payload=stdin_payload, base=mailbox_root, env=self.env
        )
        self.assertEqual(aged_rust["task"], "not set")

        # Control: 1-day-old heartbeat with the same verified live PID is live in both.
        peer_record["lastSeenAt"] = fresh_stamp
        peer_file.write_text(json.dumps(peer_record), encoding="utf-8")
        self.assertIsNotNone(handoff.live_chief_binding(mailbox_root, session_id))
        fresh_rust = ORK_FAST.statusline_identity(
            session_id, "claude", payload=stdin_payload, base=mailbox_root, env=self.env
        )
        self.assertEqual(fresh_rust["task"], chief_focus)

        # Symlinked chief.json must fail closed in Rust without following the symlink.
        target_chief = self.home / "outside-chief.json"
        target_chief.write_text(json.dumps(chief_doc), encoding="utf-8")
        chief_file.unlink()
        chief_file.symlink_to(target_chief)
        symlink_rust = ORK_FAST.statusline_identity(
            session_id, "claude", payload=stdin_payload, base=mailbox_root, env=self.env
        )
        self.assertEqual(symlink_rust["task"], "not set")

    def test_mailbox_hook_stop_preinvocation_and_unread_delivery(self):
        """Test Stop state->idle + gemini lastStopReason, PreInvocation mid-turn + agy pending classification, and unread inbox delivery."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        (mailbox_root / "peers").mkdir(parents=True)
        session_id = "sess-mailbox-parity-1"
        s_key = peer_mailbox.session_key(session_id)
        peer_file = mailbox_root / "peers" / f"{s_key}.json"
        old_stamp = (dt.datetime.now(dt.UTC) - dt.timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
        checkout_dir = self.home / "repo"
        checkout_dir.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(checkout_dir)], check=True, capture_output=True)
        expected_repo = str((checkout_dir / ".git").resolve())

        peer_record = {
            "schema": "agent-executor.peer.v1",
            "session": session_id,
            "name": "cobalt-nova-cd",
            "announcedName": "cobalt-nova-cd",
            "harness": "gemini",
            "cwd": str(checkout_dir.resolve()),
            "checkout": str(checkout_dir.resolve()),
            "repo": expected_repo,
            "remotes": [],
            "model": "gemini-3.8-flash-high",
            "state": "busy",
            "pid": os.getpid(),
            "startedAt": old_stamp,
            "lastSeenAt": old_stamp,
        }
        peer_file.write_text(json.dumps(peer_record), encoding="utf-8")

        # Seed deterministic registered name and announcedName before asserting steady-state {}.
        ORK_FAST.run_mailbox_hook(
            {
                "session_id": session_id,
                "cwd": str(checkout_dir.resolve()),
                "workspacePaths": [str(checkout_dir.resolve())],
                "prompt": "warm up",
            },
            harness="gemini",
            event="PreInvocation",
            base=mailbox_root,
            env=self.env,
        )
        warm = json.loads(peer_file.read_text(encoding="utf-8"))
        warm["lastSeenAt"] = old_stamp
        peer_file.write_text(json.dumps(warm), encoding="utf-8")

        # 1. PreInvocation steady state updates lastSeenAt cleanly with empty {}.
        pre_out = ORK_FAST.run_mailbox_hook(
            {
                "session_id": session_id,
                "cwd": str(checkout_dir.resolve()),
                "workspacePaths": [str(checkout_dir.resolve())],
                "prompt": "continue work",
            },
            harness="gemini",
            event="PreInvocation",
            base=mailbox_root,
            env=self.env,
        )
        self.assertEqual(pre_out, {})
        after_pre = json.loads(peer_file.read_text(encoding="utf-8"))
        self.assertEqual(after_pre["state"], "busy")
        self.assertNotEqual(after_pre["lastSeenAt"], old_stamp)

        # 1b. Delayed Gemini subagent classification: missing evidence -> agySubagentPending -> transcript/SQLite resolves
        gemini_home = self.home / ".gemini"
        brain_dir = gemini_home / "antigravity-cli" / "brain"
        brain_dir.mkdir(parents=True, exist_ok=True)
        sub_env = {**self.env, "GEMINI_CLI_HOME": str(gemini_home)}

        pending_sid = "sess-mailbox-pending-1"
        pending_key = peer_mailbox.session_key(pending_sid)
        pending_file = mailbox_root / "peers" / f"{pending_key}.json"
        sub_transcript = self.home / "sub-transcript.jsonl"
        sub_transcript.write_text(
            json.dumps({"step_index": 0, "type": "EPHEMERAL_MESSAGE", "content": "warming up"}) + "\n",
            encoding="utf-8",
        )
        # First hook with missing parent evidence marks agySubagentPending=True without mis-tagging isSubagent
        ORK_FAST.run_mailbox_hook(
            {
                "conversationId": pending_sid,
                "invocationNum": 1,
                "transcriptPath": str(sub_transcript),
                "workspacePaths": [str(checkout_dir.resolve())],
            },
            harness="gemini",
            event="PreInvocation",
            base=mailbox_root,
            env=sub_env,
        )
        pending_initial = json.loads(pending_file.read_text(encoding="utf-8"))
        self.assertTrue(pending_initial.get("agySubagentPending"))
        self.assertFalse(pending_initial.get("isSubagent"))

        # Second hook adds structured opening SYSTEM_MESSAGE -> resolves isSubagent, parentSession, clears pending
        with sub_transcript.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "step_index": 1,
                        "type": "SYSTEM_MESSAGE",
                        "content": (
                            "<SYSTEM_MESSAGE>\n"
                            f"[Message] timestamp=2026-11-15T00:00:00Z sender={session_id} priority=HIGH content=work"
                        ),
                    }
                )
                + "\n"
            )
        ORK_FAST.run_mailbox_hook(
            {
                "conversationId": pending_sid,
                "invocationNum": 1,
                "transcriptPath": str(sub_transcript),
                "cwd": str(checkout_dir.resolve()),
            },
            harness="gemini",
            event="PreInvocation",
            base=mailbox_root,
            env=sub_env,
        )
        classified_pending = json.loads(pending_file.read_text(encoding="utf-8"))
        self.assertTrue(classified_pending.get("isSubagent"))
        self.assertEqual(classified_pending.get("parentSession"), session_id)
        self.assertIsNone(classified_pending.get("agySubagentPending"))

        # SQLite conversation_parents fixture resolves delayed child without needing SYSTEM_MESSAGE
        db_path = gemini_home / "antigravity-cli" / "conversation_summaries.db"
        sqlite_child_sid = "sess-mailbox-sqlite-child-1"
        with contextlib.closing(sqlite3.connect(db_path)) as con, con:
            con.execute(
                "CREATE TABLE conversation_summaries ("
                "conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT)"
            )
            con.execute("CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT)")
            con.execute("INSERT INTO conversation_parents VALUES (?, ?)", (sqlite_child_sid, session_id))
        ORK_FAST.run_mailbox_hook(
            {
                "conversationId": sqlite_child_sid,
                "workspacePaths": [str(checkout_dir.resolve())],
            },
            harness="gemini",
            event="SessionStart",
            base=mailbox_root,
            env=sub_env,
        )
        sqlite_child = json.loads(
            (mailbox_root / "peers" / f"{peer_mailbox.session_key(sqlite_child_sid)}.json").read_text(encoding="utf-8")
        )
        self.assertTrue(sqlite_child.get("isSubagent"))
        self.assertEqual(sqlite_child.get("parentSession"), session_id)
        self.assertIsNone(sqlite_child.get("agySubagentPending"))

        # Parent hook banner must list non-subagent colleague while hiding confirmed and still-pending children
        still_pending_sid = "sess-mailbox-still-pending-1"
        still_pending_file = mailbox_root / "peers" / f"{peer_mailbox.session_key(still_pending_sid)}.json"
        still_pending_transcript = self.home / "still-pending-transcript.jsonl"
        still_pending_transcript.write_text(
            json.dumps({"step_index": 0, "type": "EPHEMERAL_MESSAGE", "content": "warming up"}) + "\n",
            encoding="utf-8",
        )
        ORK_FAST.run_mailbox_hook(
            {
                "conversationId": still_pending_sid,
                "invocationNum": 1,
                "transcriptPath": str(still_pending_transcript),
                "workspacePaths": [str(checkout_dir.resolve())],
            },
            harness="gemini",
            event="PreInvocation",
            base=mailbox_root,
            env=sub_env,
        )
        still_pending = json.loads(still_pending_file.read_text(encoding="utf-8"))
        self.assertTrue(still_pending.get("agySubagentPending"))
        self.assertFalse(still_pending.get("isSubagent"))

        colleague_sid = "sess-mailbox-colleague-1"
        colleague_file = mailbox_root / "peers" / f"{peer_mailbox.session_key(colleague_sid)}.json"
        colleague_record = {
            **peer_record,
            "session": colleague_sid,
            "name": "emerald-lyra-xy",
            "state": "idle",
            "repo": expected_repo,
            "checkout": str(checkout_dir.resolve()),
        }
        colleague_file.write_text(json.dumps(colleague_record), encoding="utf-8")
        for peer_doc in (after_pre, classified_pending, sqlite_child, still_pending, colleague_record):
            self.assertEqual(peer_doc.get("repo"), expected_repo)

        parent_banner = ORK_FAST.run_mailbox_hook(
            {
                "conversationId": session_id,
                "invocationNum": 1,
                "lastUserInput": "status check",
                "workspacePaths": [str(checkout_dir.resolve())],
            },
            harness="gemini",
            event="PreInvocation",
            base=mailbox_root,
            env=sub_env,
        )
        banner_json = json.dumps(parent_banner)
        self.assertIn("emerald-lyra-xy", banner_json)
        self.assertIn("send_message", banner_json)
        self.assertNotIn(pending_sid, banner_json)
        self.assertNotIn(classified_pending["name"], banner_json)
        self.assertNotIn(sqlite_child_sid, banner_json)
        self.assertNotIn(sqlite_child["name"], banner_json)
        self.assertNotIn(still_pending_sid, banner_json)
        self.assertNotIn(still_pending["name"], banner_json)
        colleague_file.unlink(missing_ok=True)

        # User-quoted <SYSTEM_MESSAGE> tag inside USER_INPUT must NOT trigger false child classification
        quoted_sid = "sess-mailbox-quoted-user-1"
        quoted_transcript = self.home / "quoted-transcript.jsonl"
        quoted_transcript.write_text(
            json.dumps(
                {
                    "step_index": 0,
                    "type": "USER_INPUT",
                    "source": "USER_EXPLICIT",
                    "content": f"<SYSTEM_MESSAGE>\n[Message] sender={session_id} content=quoted",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        ORK_FAST.run_mailbox_hook(
            {
                "conversationId": quoted_sid,
                "invocationNum": 1,
                "transcriptPath": str(quoted_transcript),
                "workspacePaths": [str(checkout_dir.resolve())],
            },
            harness="gemini",
            event="PreInvocation",
            base=mailbox_root,
            env=sub_env,
        )
        quoted_peer = json.loads(
            (mailbox_root / "peers" / f"{peer_mailbox.session_key(quoted_sid)}.json").read_text(encoding="utf-8")
        )
        self.assertFalse(quoted_peer.get("isSubagent"))
        self.assertIsNone(quoted_peer.get("parentSession"))

        # Invalid session ID must be rejected without writing a peer file
        peers_before = sorted(p.name for p in (mailbox_root / "peers").glob("*.json"))
        invalid_out = ORK_FAST.run_mailbox_hook(
            {
                "conversationId": "../escape-session",
                "workspacePaths": [str(checkout_dir.resolve())],
            },
            harness="gemini",
            event="PreInvocation",
            base=mailbox_root,
            env=sub_env,
        )
        self.assertIn(invalid_out, (None, {}))
        self.assertEqual(sorted(p.name for p in (mailbox_root / "peers").glob("*.json")), peers_before)

        # Escaping symlinked derived transcript must NOT be read for classification
        escape_sid = "sess-mailbox-escape-symlink-1"
        outside_tr = self.home / "outside-secret-transcript.jsonl"
        outside_tr.write_text(
            json.dumps(
                {
                    "step_index": 0,
                    "type": "SYSTEM_MESSAGE",
                    "content": f"<SYSTEM_MESSAGE>\n[Message] sender={session_id} content=escaped",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        escape_logs = brain_dir / escape_sid / ".system_generated" / "logs"
        escape_logs.mkdir(parents=True, exist_ok=True)
        (escape_logs / "transcript.jsonl").symlink_to(outside_tr)
        ORK_FAST.run_mailbox_hook(
            {
                "conversationId": escape_sid,
                "invocationNum": 1,
                "workspacePaths": [str(checkout_dir.resolve())],
            },
            harness="gemini",
            event="PreInvocation",
            base=mailbox_root,
            env=sub_env,
        )
        escape_peer = json.loads(
            (mailbox_root / "peers" / f"{peer_mailbox.session_key(escape_sid)}.json").read_text(encoding="utf-8")
        )
        self.assertFalse(escape_peer.get("isSubagent"))
        self.assertIsNone(escape_peer.get("parentSession"))

        # 2. Stop transitions busy -> idle and sets gemini lastStopReason
        stop_out = ORK_FAST.run_mailbox_hook(
            {"session_id": session_id, "terminationReason": "end_turn"},
            harness="gemini",
            event="Stop",
            base=mailbox_root,
            env=self.env,
        )
        self.assertEqual(stop_out, {})
        after_stop = json.loads(peer_file.read_text(encoding="utf-8"))
        self.assertEqual(after_stop["state"], "idle")
        self.assertEqual(after_stop.get("lastStopReason"), "end_turn")

        # 3. Unread message in inbox/<key>/ is delivered natively on both PreInvocation and Stop
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
            delivered = ORK_FAST.run_mailbox_hook(
                {"session_id": session_id, "cwd": str(checkout_dir.resolve())},
                harness="gemini",
                event=ev,
                base=mailbox_root,
                env=self.env,
            )
            if ev == "Stop":
                self.assertEqual(delivered.get("decision"), "continue")
                self.assertIn("check new instructions", delivered.get("reason", ""))
            else:
                text = json.dumps(delivered)
                self.assertIn("check new instructions", text)

    def test_mailbox_hook_room_obligations_follow_the_rooms_index(self):
        """ork-fast reads rooms-index.json (republished by Node room commits) and rooms.db for coordinator obligations."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        (mailbox_root / "peers").mkdir(parents=True)
        session_id = "sess-room-index-1"
        checkout_dir = self.home / "repo"
        checkout_dir.mkdir(parents=True)
        stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        peer_file = mailbox_root / "peers" / f"{peer_mailbox.session_key(session_id)}.json"
        peer_file.write_text(
            json.dumps(
                {
                    "schema": "agent-executor.peer.v1",
                    "session": session_id,
                    "name": "cobalt-nova-cd",
                    "announcedName": "cobalt-nova-cd",
                    "harness": "gemini",
                    "cwd": str(checkout_dir.resolve()),
                    "checkout": str(checkout_dir.resolve()),
                    "repo": str(checkout_dir.resolve()),
                    "remotes": [],
                    "model": "gemini-3.8-flash-high",
                    "state": "busy",
                    "pid": os.getpid(),
                    "startedAt": stamp,
                    "lastSeenAt": stamp,
                }
            ),
            encoding="utf-8",
        )

        def invoke_pre(*, state: str = "busy", mid_turn: bool = True):
            current = json.loads(peer_file.read_text(encoding="utf-8"))
            current["state"] = state
            peer_file.write_text(json.dumps(current), encoding="utf-8")
            payload = {
                "conversationId": session_id,
                "workspacePaths": [str(checkout_dir.resolve())],
                "invocationNum": 2 if mid_turn else 1,
            }
            if not mid_turn:
                payload["lastUserInput"] = "continue"
            return ORK_FAST.run_mailbox_hook(
                payload,
                harness="gemini",
                event="PreInvocation",
                base=mailbox_root,
                env=self.env,
            )

        # Warm up so solo self-name announcement settles before testing room index fast path.
        warm_out = invoke_pre()
        self.assertIn("Your agent name is", json.dumps(warm_out))
        self.assertEqual(invoke_pre(), {}, "no rooms: stay on fast path with empty JSON")
        room_store.put_room(
            mailbox_root,
            {
                "schema": "agent-executor.room.v1",
                "id": "index-room",
                "title": "Index Room",
                "swarm": {"maxAgents": 8, "maxDepth": 3},
                "objective": "Ship index room",
                "cwd": str(checkout_dir.resolve()),
                "machine": socket.gethostname(),
                "agents": [{"id": "w1", "role": "worker", "engine": "claude", "status": "queued"}],
                "conductor": {
                    "engine": "agy",
                    "session": {
                        "id": session_id,
                        "engine": "agy",
                        "machine": socket.gethostname(),
                        "cwd": str(checkout_dir.resolve()),
                    },
                },
            },
        )
        self.assertFalse((mailbox_root / "rooms").exists(), "the room lives only in rooms.db")
        open_out = invoke_pre(state="idle", mid_turn=False)
        self.assertIn("index-room", json.dumps(open_out), "open room bound to session emits reconnection banner")

        room_store.set_metadata(mailbox_root, "index-room", closedAt=stamp)
        self.assertEqual(invoke_pre(), {}, "closed room has no coordinator obligations")

        room_store.put_room(
            mailbox_root,
            {
                "schema": "agent-executor.room.v1",
                "id": "cancelled-room",
                "lifecycle": "cancelled",
                "objective": "Cancelled room",
                "cwd": str(checkout_dir.resolve()),
                "machine": socket.gethostname(),
                "agents": [],
                "conductor": {"engine": "agy", "session": {"id": session_id, "engine": "agy"}},
            },
        )
        self.assertEqual(invoke_pre(), {}, "cancelled lifecycle room stays on fast path")

    def test_mailbox_hook_plan_mode_suppression(self):
        """Test Stop hook suppression on ExitPlanMode/EnterPlanMode tool use."""
        for tool_name in ("ExitPlanMode", "EnterPlanMode"):
            with self.subTest(tool_name=tool_name):
                out = ORK_FAST.run_mailbox_hook(
                    {"event": "Stop", "tool_name": tool_name, "tool_input": {}},
                    harness="claude",
                    base=runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1",
                    env=self.env,
                )
                self.assertIsNone(out)

    def test_mailbox_hook_session_start_initializes_peer(self):
        """Test SessionStart natively initializes the peer registration record on disk."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        repo = self.home / "repo"
        repo.mkdir(parents=True)
        ORK_FAST.run_mailbox_hook(
            {"hook_event_name": "SessionStart", "session_id": "test-session-123", "cwd": str(repo)},
            harness="claude",
            base=mailbox_root,
            env=self.env,
        )
        peer = peer_mailbox.load(peer_mailbox.peer_path(mailbox_root, "test-session-123"))
        self.assertIsNotNone(peer)
        self.assertEqual(peer["harness"], "claude")
        self.assertEqual(Path(peer["cwd"]).resolve(), repo.resolve())

    def test_mailbox_hook_solo_self_name_announcement(self):
        """Solo sessions announce their name once, re-announce on rename, suppress run/delegated/subagent, and stay quiet on Stop."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        session = "sess-solo-announce-1"
        repo_dir = (self.home / "repo").resolve()
        peer_file = self._fast_peer(mailbox_root, session)

        # 1st UserPromptSubmit announces registered self-name and records announcedName.
        first = ORK_FAST.run_mailbox_hook(
            {"hook_event_name": "UserPromptSubmit", "session_id": session, "cwd": str(repo_dir), "prompt": "hi"},
            harness="claude",
            base=mailbox_root,
            env=self.env,
        )
        registered_doc = json.loads(peer_file.read_text(encoding="utf-8"))
        assigned = registered_doc["name"]
        first_ctx = (first or {}).get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn(f"Your agent name is {assigned}", first_ctx)
        self.assertEqual(registered_doc.get("announcedName"), assigned)

        # 2nd UserPromptSubmit is quiet.
        second = ORK_FAST.run_mailbox_hook(
            {"hook_event_name": "UserPromptSubmit", "session_id": session, "cwd": str(repo_dir), "prompt": "next"},
            harness="claude",
            base=mailbox_root,
            env=self.env,
        )
        self.assertIsNone(second)

        # Model change triggers deterministic rename, announces once, then quiet again.
        third = ORK_FAST.run_mailbox_hook(
            {
                "hook_event_name": "UserPromptSubmit",
                "session_id": session,
                "cwd": str(repo_dir),
                "model": "claude-sonnet-5-5",
                "prompt": "after rename",
            },
            harness="claude",
            base=mailbox_root,
            env=self.env,
        )
        renamed = json.loads(peer_file.read_text(encoding="utf-8"))["name"]
        self.assertNotEqual(renamed, assigned)
        third_ctx = (third or {}).get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn(f"Your agent name is {renamed}", third_ctx)
        fourth = ORK_FAST.run_mailbox_hook(
            {
                "hook_event_name": "UserPromptSubmit",
                "session_id": session,
                "cwd": str(repo_dir),
                "model": "claude-sonnet-5-5",
                "prompt": "quiet again",
            },
            harness="claude",
            base=mailbox_root,
            env=self.env,
        )
        self.assertIsNone(fourth)

        # Create an active run peer so mark_delegated treats delegated sessions as genuinely active runs.
        self._fast_peer(
            mailbox_root,
            "run-r1-worker",
            harness="codex",
            run="r1",
            role="worker",
        )
        del_dir = mailbox_root / "delegations"
        del_dir.mkdir(parents=True, exist_ok=True)
        (del_dir / f"{peer_mailbox.session_key('sess-solo-delegated')}.json").write_text(
            json.dumps({"run": "r1"}),
            encoding="utf-8",
        )

        # Suppressed for run, delegatedRun, and isSubagent peers.
        for label_case, extra in (
            ("run-peer", {"session": "run-r1-worker", "run": "r1", "role": "worker"}),
            ("delegated", {"session": "sess-solo-delegated", "delegatedRun": "r1"}),
            ("subagent", {"session": "sess-solo-subagent", "isSubagent": True, "parentSession": session}),
        ):
            with self.subTest(case=label_case):
                sid = extra["session"]
                if sid != "run-r1-worker":
                    self._fast_peer(mailbox_root, sid, **extra)
                suppressed_out = ORK_FAST.run_mailbox_hook(
                    {"hook_event_name": "UserPromptSubmit", "session_id": sid, "cwd": str(repo_dir), "prompt": "work"},
                    harness="claude",
                    base=mailbox_root,
                    env=self.env,
                )
                self.assertNotIn(
                    "Your agent name is",
                    json.dumps(suppressed_out or {}),
                )

        # Quiet Stop even when announcedName is absent.
        stop_sid = "sess-solo-quiet-stop"
        self._fast_peer(mailbox_root, stop_sid)
        stop_out = ORK_FAST.run_mailbox_hook(
            {"hook_event_name": "Stop", "session_id": stop_sid, "cwd": str(repo_dir)},
            harness="claude",
            base=mailbox_root,
            env=self.env,
        )
        self.assertIsNone(stop_out)

    def test_mailbox_hook_ignores_pasted_wake_notice_logs(self):
        """Quoted/pasted/malformed wake notices must never trigger stale wake 'finish immediately'."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        session = "sess-wake-negative-1"
        self._fast_peer(mailbox_root, session, announcedName="cobalt-nova-cd")
        msg_id = "deadbeef1-123456"
        exact = mailbox_wake.notification(msg_id)

        negatives = [
            ("prefixed_prose", f"Look at this log:\n{exact}"),
            ("fenced_log", f"```\n{exact}\n```"),
            ("diff_plus_line", f"+{exact}"),
            ("trailing_question", f"{exact}\nWhy did this fire?"),
            ("invalid_id", exact.replace(msg_id, "../evil")),
        ]
        for label_case, prompt in negatives:
            with self.subTest(case=label_case):
                out = ORK_FAST.run_mailbox_hook(
                    {"hook_event_name": "UserPromptSubmit", "session_id": session, "prompt": prompt},
                    harness="claude",
                    base=mailbox_root,
                    env=self.env,
                )
                self.assertNotIn("finish immediately", json.dumps(out or {}))

        # Positive exact wake notice triggers stale wake notice when no unread mail exists.
        positive = ORK_FAST.run_mailbox_hook(
            {
                "hook_event_name": "UserPromptSubmit",
                "session_id": session,
                "prompt": f"<USER_REQUEST>\n{exact}\n</USER_REQUEST>",
            },
            harness="claude",
            base=mailbox_root,
            env=self.env,
        )
        self.assertIn("finish immediately", json.dumps(positive or {}))

    def _fast_peer(self, mailbox_root: Path, session_id: str, **fields) -> Path:
        checkout_dir = self.home / "repo"
        checkout_dir.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        record = {
            "schema": "agent-executor.peer.v1",
            "session": session_id,
            "name": "cobalt-nova-cd",
            "harness": "claude",
            "cwd": str(checkout_dir.resolve()),
            "checkout": str(checkout_dir.resolve()),
            "repo": str(checkout_dir.resolve()),
            "remotes": [],
            "model": "claude-opus-5-5",
            "state": "busy",
            "pid": os.getpid(),
            "startedAt": stamp,
            "lastSeenAt": stamp,
            **fields,
        }
        peer_file = mailbox_root / "peers" / f"{peer_mailbox.session_key(session_id)}.json"
        peer_file.parent.mkdir(parents=True, exist_ok=True)
        peer_file.write_text(json.dumps(record), encoding="utf-8")
        return peer_file

    def test_mailbox_hook_handoff_and_authority_obligations(self):
        """Test native fast Stop transitions, delegatedRun skip, and pending authority offer delivery."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        session = "sess-handoff-fast"
        peer_file = self._fast_peer(mailbox_root, session)

        # Plain top-level busy peer transitions busy -> idle quietly on Stop.
        out = ORK_FAST.run_mailbox_hook(
            {"session_id": session},
            harness="claude",
            event="Stop",
            base=mailbox_root,
            env=self.env,
        )
        self.assertIsNone(out)
        self.assertEqual(json.loads(peer_file.read_text(encoding="utf-8"))["state"], "idle")

        # Non-delegated peer receiving an authority handover offer sees it natively on UserPromptSubmit.
        cache = runtime_paths.cache_home(env=self.env, home=self.home)
        team_dir = cache / "authority-v1" / "mine"
        team_dir.mkdir(parents=True, exist_ok=True)
        (team_dir / "authority.json").write_text(
            json.dumps(
                {
                    "schema": "orchestrate.authority.v1",
                    "team": "mine",
                    "status": "active",
                    "generation": 1,
                    "lead": {"session": "someone"},
                    "deputy": {"session": session, "harness": "claude"},
                    "offer": {"to": {"session": session, "harness": "claude"}},
                }
            ),
            encoding="utf-8",
        )
        offer_out = ORK_FAST.run_mailbox_hook(
            {"hook_event_name": "UserPromptSubmit", "session_id": session},
            harness="claude",
            base=mailbox_root,
            env=self.env,
        )
        self.assertIn(
            "offered you the handover",
            (offer_out or {}).get("hookSpecificOutput", {}).get("additionalContext", ""),
        )

    def test_mailbox_hook_stop_failure_records_handoff_event(self):
        """StopFailure through ork-fast natively records the handoff event with expected metadata."""
        mailbox_root = runtime_paths.cache_home(env=self.env, home=self.home) / "mailbox-v1"
        session = "sess-stop-failure-rust"
        self._fast_peer(mailbox_root, session)
        payload = {
            "hook_event_name": "StopFailure",
            "session_id": session,
            "cwd": str((self.home / "repo").resolve()),
            "error": "rate_limit",
            "error_details": "429",
        }
        out = ORK_FAST.run_mailbox_hook(
            payload,
            harness="claude",
            base=mailbox_root,
            env=self.env,
        )
        self.assertIsNone(out)
        handoff_dir = runtime_paths.cache_home(env=self.env, home=self.home) / "handoffs-v1"
        event = json.loads((handoff_dir / peer_mailbox.session_key(session) / "event.json").read_text(encoding="utf-8"))
        self.assertEqual(
            {key: event[key] for key in ("status", "reason", "source", "harness", "details", "model")},
            {
                "status": "recorded",
                "reason": "rate_limit",
                "source": "StopFailure",
                "harness": "claude",
                "details": "429",
                "model": "claude-opus-5-5",
            },
        )

    def test_ensure_ork_fast_download_and_verify(self):
        """Test downloading ork-fast with strict SHA-256 verification and atomic replace."""
        target = install_mailbox.target_triple()
        if not target:
            self.skipTest("unsupported target triple for mock download")

        dummy_binary_content = b"#!/bin/sh\necho ork-fast-test\n"
        computed_sha = hashlib.sha256(dummy_binary_content).hexdigest()
        binary_name = f"ork-fast-{target}"
        sha_content = f"{computed_sha}  {binary_name}\n"

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
                pass

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
        """Verify ork-fast hot paths remain well below the 25ms latency ceiling."""
        gate_payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "git status"}})
        mb_payload = json.dumps({"event": "Stop", "tool_name": "ExitPlanMode", "tool_input": {}})

        cases = [
            ("gate-hook", [str(ORK_FAST_BIN), "gate-hook", "--harness", "claude"], gate_payload),
            ("statusline", [str(ORK_FAST_BIN), "statusline", "--plain"], "{}"),
            ("mailbox-hook", [str(ORK_FAST_BIN), "mailbox-hook", "--harness", "claude"], mb_payload),
        ]

        parts = []
        for label, fast_cmd, stdin_data in cases:
            fast_ms = self._median_ms(fast_cmd, stdin_data)
            parts.append(f"{label}={fast_ms:.2f}ms")
            self.assertLess(fast_ms, 25.0, f"{label}: ork-fast ({fast_ms:.2f}ms) exceeded 25ms ceiling")

        print("\nBenchmark 15-iter medians: " + ", ".join(parts))


UUID_SESSION = "019a5da8-4321-5678-9abc-123456789012"
FAKE_HERDR = """#!/bin/sh
[ -n "$FAKE_HERDR_LOG" ] && echo "$@" >> "$FAKE_HERDR_LOG"
[ -n "$FAKE_HERDR_DELAY" ] && sleep "$FAKE_HERDR_DELAY"
[ "$1 $2" = "pane current" ] || exit 2
[ "$3" = "--pane" ] || exit 2
cat "$FAKE_HERDR_PANE"
"""


class TestHerdrStatusParity(unittest.TestCase):
    """`ork-fast herdr-status` must match scripts/herdr_status.py byte for byte, with exit zero."""

    @classmethod
    def setUpClass(cls):
        cls.binary = ORK_FAST.find_ork_fast_bin()
        cls.python_script = SCRIPTS / "herdr_status.py"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.checkout = self.root / "repo"
        self.checkout.mkdir()
        self.socket = self.root / "herdr" / "herdr.sock"
        self.socket.parent.mkdir()
        self.socket.touch()
        self.herdr = self.root / "bin" / "herdr"
        self.herdr.parent.mkdir()
        self.herdr.write_text(FAKE_HERDR)
        self.herdr.chmod(0o755)
        self.pane_file = self.root / "pane.json"
        self.base = self.base_for(self.home)
        for sub in ("peers", "progress", "rooms"):
            (self.base / sub).mkdir(parents=True)
        self.env = self.make_env(self.home)
        self.set_pane({"pane_id": "w1:p1", "agent": "claude", "agent_session": self.ref("claude", "sess-a")})

    # -- fixtures ---------------------------------------------------------------------------------

    @staticmethod
    def base_for(home: Path) -> Path:
        return home / ".config/orchestrate/mailbox-v1"

    def make_env(self, home: Path, **extra) -> dict[str, str]:
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("HERDR_", "ORKEST_SWARM", "ORK_GLYPHS", "FAKE_HERDR"))
        }
        env.update(
            HOME=str(home),
            XDG_CACHE_HOME=str(home / ".cache"),
            XDG_CONFIG_HOME=str(home / ".config"),
            ORCHESTRATE_HOME=str(home / ".config/orchestrate"),
            ORKEST_SCRIPTS_DIR=str(SCRIPTS),
            ORKEST_PLUGIN_ROOT=str(REPO_ROOT / "plugins/orchestrate"),
            ORKEST_TEST_MODE="1",
            ORKEST_TEST_HARNESS_PID=str(os.getpid()),
            HERDR_ACTIVE_PANE_ID="w1:p1",
            HERDR_BIN_PATH=str(self.herdr),
            HERDR_SOCKET_PATH=str(self.socket),
            FAKE_HERDR_PANE=str(self.pane_file),
            ORK_GLYPHS="ascii",
        )
        env.pop("AGENT_EXECUTOR_HOME", None)
        env.pop("PYTHONPATH", None)
        env.update(extra)
        return env

    @staticmethod
    def ref(agent: str, value: str) -> dict:
        return {"kind": "id", "agent": agent, "value": value}

    def set_pane(self, pane, *, raw: str | None = None):
        self.pane_file.write_text(raw if raw is not None else json.dumps({"result": {"pane": pane}}))

    def peer(self, session="sess-a", *, harness="claude", name="ivory-elk-49", base=None, filename=None, **fields):
        stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        record = {
            "schema": "agent-executor.peer.v1",
            "session": session,
            "name": name,
            "harness": harness,
            "cwd": str(self.checkout),
            "checkout": str(self.checkout),
            "pid": os.getpid(),
            "startedAt": stamp,
            "lastSeenAt": stamp,
            "herdrPaneId": "w1:p1",
            "herdrEndpoint": str(self.socket),
        }
        record.update(fields)
        record = {key: value for key, value in record.items() if value is not ...}
        target = (base or self.base) / "peers" / (filename or peer_mailbox.session_key(session) + ".json")
        target.write_text(json.dumps(record), encoding="utf-8")
        return record

    def progress(self, peer, *, stage="working", task="Verify patch", base=None):
        stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        record = {
            "schema": "orchestrate.progress.v1",
            "session": peer["session"],
            "harness": peer["harness"],
            "machine": socket.gethostname(),
            "accountHome": None,
            "checkout": str(self.checkout),
            "goal": "Ship it",
            "task": task,
            "stage": stage,
            "updatedAt": stamp,
        }
        path = (base or self.base) / "progress" / (peer_mailbox.session_key(peer["session"]) + ".json")
        path.write_text(json.dumps(record), encoding="utf-8")

    def room(self, room_id, session, harness="claude", member="conductor", base=None, bound=None):
        bound = str(bound or self.checkout)
        engine = {"claude": "claude", "codex": "codex"}[harness]
        record = {
            "schema": "agent-executor.room.v1",
            "id": room_id,
            "cwd": str(self.checkout),
            "machine": socket.gethostname(),
            "swarm": {"maxAgents": 4, "maxDepth": 2},
            "conductor": {"engine": engine, "session": {"id": session, "cwd": bound}},
            "agents": [],
        }
        if member != "conductor":
            record["conductor"] = {"engine": engine, "session": {"id": "someone-else"}}
            record["agents"] = [
                {"id": member, "role": "lead", "engine": engine, "session": {"id": session, "cwd": bound}}
            ]
        (base or self.base).joinpath("rooms", f"{room_id}.json").write_text(json.dumps(record), encoding="utf-8")

    # -- runners ----------------------------------------------------------------------------------

    def run_python(self, *args, env=None):
        return subprocess.run(
            [sys.executable, "-B", str(self.python_script), *args],
            env=env or self.env,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )

    def run_rust(self, *args, env=None):
        return subprocess.run(
            [str(self.binary), "herdr-status", *args],
            env=env or self.env,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )

    def assert_parity(self, expected: str | None = None, *, env=None):
        python, rust = self.run_python(env=env), self.run_rust(env=env)
        self.assertEqual((rust.stdout, rust.returncode), (python.stdout, python.returncode), rust.stderr)
        self.assertEqual(rust.returncode, 0)
        self.assertEqual(rust.stdout.count("\n"), 1)
        if expected is not None:
            self.assertEqual(rust.stdout, expected + "\n")
        return rust.stdout

    # -- tests ------------------------------------------------------------------------------------

    def test_herdr_status_explicit_ref_label_and_work_title(self):
        peer = self.peer()
        self.progress(peer)
        self.assert_parity("[A] ivory-elk-49 · working · Verify patch")

    def test_herdr_status_without_progress_is_just_the_label(self):
        self.peer()
        self.assert_parity("[A] ivory-elk-49")

    def test_herdr_status_glyph_tiers_and_harness_mapping(self):
        self.peer()
        for tier, glyph in (("ascii", "[A]"), ("unicode", "✳"), ("nerd", ""), ("bogus", "✳")):
            with self.subTest(tier=tier):
                self.assert_parity(f"{glyph} ivory-elk-49", env=self.make_env(self.home, ORK_GLYPHS=tier))
        self.set_pane({"pane_id": "w1:p1", "agent": "agy", "agent_session": self.ref("agy", "sess-g")})
        self.peer("sess-g", harness="gemini", name="gem-1")
        self.assert_parity("[G] gem-1")
        self.set_pane({"pane_id": "w1:p1", "agent": "agy", "agent_session": self.ref("agy", "sess-a")})
        self.assert_parity("")

    def test_herdr_status_no_active_pane_or_missing_cli(self):
        self.peer()
        env = self.make_env(self.home, HERDR_ACTIVE_PANE_ID="  ")
        self.assert_parity("", env=env)
        env = self.make_env(self.home)
        del env["HERDR_ACTIVE_PANE_ID"]
        self.assert_parity("", env=env)
        for binary in (str(self.root / "missing" / "herdr"), str(self.root)):
            with self.subTest(binary=binary):
                self.assert_parity(
                    "", env=self.make_env(self.home, HERDR_BIN_PATH=binary, PATH=str(self.root / "none"))
                )
        env = self.make_env(self.home, PATH=f"{self.herdr.parent}:/usr/bin:/bin")
        del env["HERDR_BIN_PATH"]
        self.assert_parity("[A] ivory-elk-49", env=env)
        env["PATH"] = str(self.root / "none")
        self.assert_parity("", env=env)

    def test_herdr_status_malformed_or_odd_cli_output(self):
        self.peer()
        for raw in (
            "",
            "not json",
            "[]",
            "null",
            '{"result": null}',
            '{"result": []}',
            '{"result": {"pane": []}}',
            '{"result": {"pane": {"agent": "claude", "agent_session": "x"}}}',
            "{" * 5000,
        ):
            with self.subTest(raw=raw[:20]):
                self.set_pane(None, raw=raw)
                self.assert_parity("")

    def test_herdr_status_missing_agent_or_wrong_ref(self):
        self.peer()
        for pane in (
            {"pane_id": "w1:p1"},
            {"pane_id": "w1:p1", "agent": None},
            {"pane_id": "w1:p1", "agent": "claude"},
            {
                "pane_id": "w1:p1",
                "agent": "claude",
                "agent_session": {"kind": "name", "agent": "claude", "value": "sess-a"},
            },
            {"pane_id": "w1:p1", "agent": "claude", "agent_session": self.ref("codex", "sess-a")},
            {"pane_id": "w1:p1", "agent": "claude", "agent_session": self.ref("claude", "other")},
            {
                "pane_id": "w1:p1",
                "agent": "claude",
                "agent_session": {"kind": "id", "agent": "claude", "value": ["sess-a"]},
            },
            {"pane_id": "w1:p1", "agent": ["claude"], "agent_session": self.ref("claude", "sess-a")},
            {"pane_id": "w9:p9", "agent": "claude", "agent_session": self.ref("claude", "sess-a")},
        ):
            with self.subTest(pane=pane):
                self.set_pane(pane)
                self.assert_parity("")

    def test_herdr_status_ambiguous_matches_print_nothing(self):
        self.peer(filename="one.json")
        self.assert_parity("[A] ivory-elk-49")
        self.peer(name="other-name", filename="two.json")
        self.assert_parity("")

    def test_herdr_status_delegated_subagent_expired_and_bad_records(self):
        base = self.peer()
        cases = {
            "delegated": {"delegatedRun": True},
            "subagent": {"isSubagent": True},
            "dead pid": {"pid": self.dead_pid()},
            "stale seen": {"pid": ..., "lastSeenAt": "2020-01-01T00:00:00Z"},
            "other pane": {"herdrPaneId": "w1:p2"},
            "no pane": {"herdrPaneId": ...},
            "no endpoint": {"herdrEndpoint": ...},
            "bad name": {"name": 5},
            "bad stamp": {"lastSeenAt": "yesterday"},
        }
        for label, fields in cases.items():
            with self.subTest(case=label):
                self.peer(**fields)
                self.assert_parity("")
        self.peer(delegatedRun=False, isSubagent=False)
        self.assert_parity("[A] ivory-elk-49")
        (self.base / "peers" / "garbage.json").write_text("{not json")
        (self.base / "peers" / "list.json").write_text("[]")
        self.assert_parity("[A] ivory-elk-49")
        self.assertIsNotNone(base)

    @staticmethod
    def dead_pid() -> int:
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait()
        return child.pid

    def test_herdr_status_codex_title_fallback_unicode_and_ascii_ellipsis(self):
        self.peer(UUID_SESSION, harness="codex", name="codex-ivory-elk-49")
        pane = {"pane_id": "w1:p1", "agent": "codex"}
        expected = "[C] codex-ivory-elk-49"
        titles = {
            "full": f"Resumed | {UUID_SESSION}",
            "bare": UUID_SESSION,
            "unicode ellipsis": f"Some | pipes | {UUID_SESSION[: 36 - 7]}…",
            "ascii ellipsis": f"Some work | {UUID_SESSION[: 36 - 7]}...",
            "wrong prefix": "Work | 019a5da8-4321-5678-9abc-99999...",
            "no session": "just a title",
            "uppercase": f"Work | {UUID_SESSION.upper()}",
        }
        misses = {"wrong prefix", "no session", "uppercase"}
        for label, title in titles.items():
            with self.subTest(title=label):
                self.set_pane({**pane, "terminal_title": title})
                self.assert_parity("" if label in misses else expected)
        # An explicit reference disables the title fallback entirely.
        self.set_pane({**pane, "terminal_title": titles["full"], "agent_session": self.ref("codex", "other")})
        self.assert_parity("")
        # A second Codex peer sharing the prefix makes the short title ambiguous.
        self.peer("019a5da8-4321-5678-9abc-123450000000", harness="codex", name="codex-other", herdrPaneId="w9:p9")
        self.set_pane({**pane, "terminal_title": titles["unicode ellipsis"]})
        self.assert_parity("")

    def test_herdr_status_endpoint_symlinks_and_mismatches(self):
        alias = self.root / "alias"
        alias.symlink_to(self.socket.parent)
        self.peer(herdrEndpoint=str(alias / "herdr.sock"))
        self.assert_parity("[A] ivory-elk-49")
        self.peer(herdrEndpoint=str(self.root / "elsewhere" / "herdr.sock"))
        self.assert_parity("")
        self.peer(herdrEndpoint=str(self.socket) + "/../herdr.sock")
        self.assert_parity("[A] ivory-elk-49")
        self.peer(herdrEndpoint=7)
        self.assert_parity("")
        # With no socket variable the default endpoint comes from XDG_CONFIG_HOME and HERDR_SESSION.
        session_sock = self.home / ".config/herdr/sessions/work/herdr.sock"
        session_sock.parent.mkdir(parents=True)
        self.peer(herdrEndpoint=str(session_sock))
        env = self.make_env(self.home, HERDR_SESSION="work")
        del env["HERDR_SOCKET_PATH"]
        self.assert_parity("[A] ivory-elk-49", env=env)
        del env["HERDR_SESSION"]
        self.assert_parity("", env=env)

    def test_herdr_status_room_scope_and_structural_roles(self):
        peer = self.peer()
        self.progress(peer)
        self.room("room-a", "sess-a")
        self.assert_parity("[A] ivory-elk-49 · Coordinator · working · Verify patch")
        env = self.make_env(self.home, ORKEST_SWARM_ROOM="room-a")
        self.assert_parity("[A] ivory-elk-49 · Coordinator · working · Verify patch", env=env)
        # Scoping to another room removes the role but is not a peer rejection rule.
        env = self.make_env(self.home, ORKEST_SWARM_ROOM="room-b")
        self.assert_parity("[A] ivory-elk-49 · working · Verify patch", env=env)
        self.room("room-a", "sess-a", member="builder")
        self.assert_parity("[A] ivory-elk-49 · Lead · working · Verify patch")
        # A room bound from a different checkout confers no role.
        self.room("room-a", "sess-a", member="builder", bound=self.root / "else")
        self.assert_parity("[A] ivory-elk-49 · working · Verify patch")

    def test_herdr_status_progress_filtering_and_sanitising(self):
        peer = self.peer(name="x\x1b[31mred\x1b[0m​ name")
        self.progress(peer, task="a\tb\nc " + "z" * 100)
        self.assert_parity()
        self.progress(peer, stage="complete", task="done")
        self.assert_parity("[A] x red name · complete · done".replace("x red", "xred"))
        path = self.base / "progress" / (peer_mailbox.session_key("sess-a") + ".json")
        path.write_text("x" * 9000)
        self.assert_parity("[A] xred name")

    def test_herdr_status_independent_profiles(self):
        other_home = self.root / "home2"
        other_base = self.base_for(other_home)
        for sub in ("peers", "progress", "rooms"):
            (other_base / sub).mkdir(parents=True)
        self.peer(name="profile-one")
        self.peer(name="profile-two", base=other_base)
        self.assert_parity("[A] profile-one")
        self.assert_parity("[A] profile-two", env=self.make_env(other_home))
        empty = self.root / "home3"
        (empty / ".config/orchestrate/mailbox-v1").mkdir(parents=True)
        self.assert_parity("", env=self.make_env(empty))

    def test_herdr_status_delayed_cli_is_bounded(self):
        self.peer()
        env = self.make_env(self.home, FAKE_HERDR_DELAY="0.03")
        self.assert_parity("[A] ivory-elk-49", env=env)
        env = self.make_env(self.home, FAKE_HERDR_DELAY="0.6")
        started = time.monotonic()
        rust = self.run_rust(env=env)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual((rust.stdout, rust.returncode), ("\n", 0))
        self.assert_parity("", env=env)

    def test_herdr_status_stalled_pid_lookup_reaps_its_process_group(self):
        self.peer(pidBirth="unused")
        marker = self.root / "probe-pid"
        ps = self.herdr.parent / "ps"
        ps.write_text('#!/bin/sh\necho $$ > "$PROBE_PID"\nexec sleep 20\n')
        ps.chmod(0o755)
        env = self.make_env(self.home, PATH=f"{ps.parent}:{os.environ['PATH']}", PROBE_PID=str(marker))
        started = time.monotonic()
        rust = self.run_rust(env=env)
        elapsed = time.monotonic() - started
        self.assertEqual((rust.stdout, rust.returncode), ("\n", 0))
        self.assertLess(elapsed, 0.5)
        self.assertTrue(marker.exists())
        # The probe is a grandchild. It may briefly await reaping by the host init.
        state = subprocess.run(
            ["ps", "-o", "stat=", "-p", marker.read_text().strip()], capture_output=True, text=True, check=False
        ).stdout.strip()
        self.assertTrue(not state or state.startswith("Z"), state)

    def test_herdr_status_never_writes(self):
        self.peer()
        before = sorted((p, p.stat().st_mtime_ns) for p in self.root.rglob("*") if p.is_file())
        self.run_rust()
        after = sorted((p, p.stat().st_mtime_ns) for p in self.root.rglob("*") if p.is_file())
        self.assertEqual(before, after)

    def test_herdr_status_fifo_peer_file_does_not_block(self):
        self.peer()
        os.mkfifo(self.base / "peers" / "pipe.json")
        started = time.monotonic()
        rust = self.run_rust()
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(rust.returncode, 0)
        self.assertEqual(rust.stdout.count("\n"), 1)

    def test_herdr_status_unknown_flags_use_python_exactly_once(self):
        self.peer()
        log = self.root / "herdr.log"
        env = self.make_env(self.home, FAKE_HERDR_LOG=str(log))
        for args in (["--wat"], ["--fallback-script", str(self.python_script), "--wat"], ["extra"]):
            with self.subTest(args=args):
                log.write_text("")
                rust = self.run_rust(*args, env=env)
                python = self.run_python(*args, env=env)
                self.assertEqual((rust.stdout, rust.returncode), ("[A] ivory-elk-49\n", 0))
                self.assertEqual((rust.stdout, rust.returncode), (python.stdout, python.returncode))
                # One Rust-driven fallback plus one direct Python run: a single CLI call each.
                self.assertEqual(len(log.read_text().splitlines()), 2)
        # With no script reachable the answer is still exactly one line, success.
        env["ORKEST_SCRIPTS_DIR"] = str(self.root / "no-scripts")
        env["ORKEST_PLUGIN_ROOT"] = str(self.root / "no-plugin")
        rust = subprocess.run(
            [str(self.binary), "herdr-status", "--fallback-script", str(self.root / "missing.py"), "--wat"],
            env=env,
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(rust.returncode, 0)
        self.assertEqual(rust.stdout.count("\n"), 1)

    def test_herdr_status_native_fallback_is_byte_exact_and_runs_python_once(self):
        runs = self.root / "runs"
        script = self.root / "fallback" / "herdr_status.py"
        script.parent.mkdir()
        script.write_text(
            f"import sys\nopen({str(runs)!r}, 'a').write('x')\n"
            "print('usage: one'); print('two', *sys.argv[1:]); sys.stderr.write('oops\\n'); sys.exit(3)\n"
        )
        rust = subprocess.run(
            [str(self.binary), "herdr-status", "--fallback-script", str(script), "--wat", "x y"],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual((rust.stdout, rust.stderr, rust.returncode), ("usage: one\ntwo --wat x y\n", "oops\n", 3))
        self.assertEqual(runs.read_text(), "x")

    def test_herdr_status_native_fallback_script_must_be_trusted(self):
        runs = self.root / "runs"
        body = f"open({str(runs)!r}, 'a').write('x')\nprint('PYTHON')\n"
        good = self.root / "good" / "herdr_status.py"
        good.parent.mkdir()
        good.write_text(body)
        writable = self.root / "writable" / "herdr_status.py"
        writable.parent.mkdir()
        writable.write_text(body)
        writable.chmod(0o666)
        linked = self.root / "linked" / "herdr_status.py"
        linked.parent.mkdir()
        linked.symlink_to(good)
        misnamed = self.root / "good" / "other.py"
        misnamed.write_text(body)
        env = {**self.env, "ORKEST_SCRIPTS_DIR": str(self.root / "none"), "ORKEST_PLUGIN_ROOT": str(self.root / "none")}
        for bad in (writable, linked, misnamed):
            with self.subTest(script=bad.name, parent=bad.parent.name):
                proc = subprocess.run(
                    [str(self.binary), "herdr-status", "--fallback-script", str(bad), "--wat"],
                    env=env,
                    cwd=self.root,
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=False,
                )
                self.assertEqual((proc.stdout, proc.returncode), ("\n", 0))
        self.assertFalse(runs.exists())
        proc = subprocess.run(
            [str(self.binary), "herdr-status", "--fallback-script", str(good), "--wat"],
            env=env,
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(proc.stdout, "PYTHON\n")

    def test_herdr_status_timeout_samples_stay_under_the_ceiling(self):
        """Wall time of timed-out lookups: 180 ms budget plus cold start, far below any caller timeout."""
        self.peer()
        hung = self.root / "bin" / "hung"
        hung.write_text("#!/bin/sh\nsleep 30\n")
        hung.chmod(0o755)
        results = {}
        for label, extra in (
            ("cli sleeps 0.6s", {"FAKE_HERDR_DELAY": "0.6"}),
            ("cli sleeps 30s", {"HERDR_BIN_PATH": str(hung)}),
            ("cli sleeps 0.09s (within 100ms cap)", {"FAKE_HERDR_DELAY": "0.09"}),
        ):
            env = self.make_env(self.home, **extra)
            values = []
            for _ in range(10):
                started = time.perf_counter()
                proc = self.run_rust(env=env)
                values.append(time.perf_counter() - started)
                self.assertEqual(proc.returncode, 0)
            results[label] = values
        for label, values in results.items():
            print(
                f"\nherdr-status {label}: min {min(values) * 1000:.0f} ms, "
                f"median {statistics.median(values) * 1000:.0f} ms, max {max(values) * 1000:.0f} ms"
            )
        for label in ("cli sleeps 0.6s", "cli sleeps 30s"):
            self.assertGreater(min(results[label]), 0.09, label)
            self.assertLess(max(results[label]), 0.18, label)

    def test_herdr_status_ordinary_misses_never_start_python(self):
        marker = self.root / "python-ran"
        fake = self.root / "fallback" / "herdr_status.py"
        fake.parent.mkdir()
        fake.write_text(f"open({str(marker)!r}, 'w').close()\nprint('PYTHON')\n")
        self.set_pane({"pane_id": "w1:p1"})
        rust = self.run_rust("--fallback-script", str(fake))
        self.assertEqual((rust.stdout, rust.returncode), ("\n", 0))
        self.assertFalse(marker.exists())

    def test_herdr_status_old_binary_lacks_the_subcommand(self):
        """Pre-Wave-3 binaries print usage to stdout and exit 1: the signal ork.mjs uses to choose Python."""
        proc = subprocess.run(
            [str(self.binary), "no-such-subcommand"], capture_output=True, text=True, timeout=20, check=False
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("unrecognized subcommand", proc.stderr)
        self.assertIn("herdr-status", proc.stdout)

    def test_herdr_status_cold_launch_overhead_is_separate_from_the_internal_budget(self):
        self.peer()
        samples = {"hit": [], "miss": []}
        miss_env = self.make_env(self.home, HERDR_ACTIVE_PANE_ID="")
        for _ in range(15):
            for label, env in (("hit", self.env), ("miss", miss_env)):
                started = time.perf_counter()
                proc = self.run_rust(env=env)
                samples[label].append(time.perf_counter() - started)
                self.assertEqual(proc.returncode, 0)
        for label, values in samples.items():
            median = statistics.median(values)
            print(f"\nherdr-status {label}: median {median * 1000:.1f} ms, max {max(values) * 1000:.1f} ms")
            # Process start-up plus the lookup stays far below the 180 ms operation budget.
            self.assertLess(median, 0.18, label)
            self.assertLess(max(values), 0.6, label)


if __name__ == "__main__":
    unittest.main()
