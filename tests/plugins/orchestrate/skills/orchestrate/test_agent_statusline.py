"""The footer displays only identity and work recorded for its own session."""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import mailbox_tasks  # noqa: E402
import mailbox_work  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402

STATUSLINE = SCRIPTS / "agent_statusline.py"


class AgentStatuslineTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.base = self.home / "mailbox-v1"
        self.environment = {**os.environ, "AGENT_EXECUTOR_HOME": str(self.home)}
        self.environment.pop("NO_COLOR", None)
        self.peer("claude-123", "snorfle-opus-high-project-23", "claude")
        self.peer("gemini-456", "snoobix-gemini-low-project-56", "gemini")

    def peer(self, session, name, harness, pid=None, **fields):
        peer = {
            "schema": mailbox.PEER_SCHEMA,
            "session": session,
            "name": name,
            "harness": harness,
            "pid": pid or os.getpid(),
            "cwd": str(self.home),
            "checkout": str(self.home),
            "repo": str(self.home / ".git"),
            "remotes": [],
            "startedAt": mailbox.stamp(),
            "lastSeenAt": mailbox.stamp(),
            **fields,
        }
        mailbox.write(mailbox.peer_path(self.base, session), peer)
        return peer

    def run_status(self, *args, payload=None, environment=None):
        return subprocess.run(
            [sys.executable, "-B", str(STATUSLINE), *args],
            input=json.dumps(payload) if payload is not None else "",
            capture_output=True,
            text=True,
            env=environment or self.environment,
            check=True,
        ).stdout

    def fields(self, session="claude-123"):
        return json.loads(self.run_status("--session", session, "--json", "--width", "200"))

    def room(self, *, title="Build a footer", session="claude-123", name="room-a", dispatch=None):
        member = {
            "id": "agent-1",
            "engine": "claude",
            "model": "opus",
            "session": {"id": session, "engine": "claude", "machine": socket.gethostname(), "cwd": str(self.home)},
        }
        if dispatch:
            member["dispatch"] = dispatch
        mailbox.write(
            self.base / "rooms" / f"{name}.json",
            {
                "schema": "agent-executor.room.v1",
                "id": name,
                "title": title,
                "cwd": str(self.home),
                "machine": socket.gethostname(),
                "agents": [member],
                "conductor": {},
            },
        )

    def test_claude_and_antigravity_show_their_own_identity_and_runtime_settings(self):
        line = self.run_status(
            "--plain",
            "--width",
            "200",
            payload={"session_id": "claude-123", "model": {"id": "opus-4"}, "effort": {"level": "high"}},
        )
        self.assertEqual(
            line, "snorfle-opus-high-project-23 | opus-4 / high | stage : not set | goal : not set | task : not set\n"
        )
        line = self.run_status(
            "--plain",
            "--width",
            "200",
            payload={"conversation_id": "gemini-456", "model": {"id": "gemini-pro", "effort": "low"}},
        )
        self.assertEqual(
            line,
            "snoobix-gemini-low-project-56 | gemini-pro / low | stage : not set | goal : not set | task : not set\n",
        )

    def test_color_is_stable_and_no_color_is_respected(self):
        colored = self.run_status("--width", "200", payload={"session_id": "claude-123"})
        self.assertRegex(colored, r"^\x1b\[0m   \x1b\[38;5;[0-9]+;1m(snorfle-opus-high-project-23)\x1b\[0m")
        self.assertRegex(colored, r"   \x1b\[48;5;[0-9]+m( +)\x1b\[0m\n$")
        self.assertEqual(colored, self.run_status("--width", "200", payload={"session_id": "claude-123"}))
        self.assertNotIn(
            "\x1b",
            self.run_status(payload={"session_id": "claude-123"}, environment={**self.environment, "NO_COLOR": "1"}),
        )

    def test_renamed_agent_and_changed_fields_are_read_on_refresh(self):
        self.peer(
            "claude-123", "snorfle-opus-max-project-23", "claude", model="opus", effort="max", focus="Review docs"
        )
        fields = self.fields()
        self.assertEqual(
            (fields["name"], fields["model"], fields["effort"], fields["task"], fields["stage"]),
            ("snorfle-opus-max-project-23", "opus", "max", "Review docs", "not set"),
        )

    def test_codex_uses_its_own_runtime_model_and_effort_from_its_account(self):
        account = self.home / "codex-account"
        account.mkdir()
        with sqlite3.connect(account / "state_5.sqlite") as database:
            database.execute("CREATE TABLE threads (id TEXT, model TEXT, reasoning_effort TEXT)")
            database.executemany(
                "INSERT INTO threads VALUES (?, ?, ?)",
                [("codex-789", "gpt-6", "max"), ("other", "gpt-other", "low")],
            )
        self.peer("codex-789", "blip-gpt-high-project-89", "codex", accountHome=str(account))
        fields = self.fields("codex-789")
        self.assertEqual((fields["model"], fields["effort"]), ("gpt-6", "max"))
        with sqlite3.connect(account / "state_5.sqlite") as database:
            database.execute("UPDATE threads SET reasoning_effort = 'medium' WHERE id = 'codex-789'")
        self.assertEqual(self.fields("codex-789")["effort"], "medium")

    def test_workboard_assignment_reflects_claim_block_and_review(self):
        peer = mailbox.load(mailbox.peer_path(self.base, "claude-123"))
        created = mailbox_work.mutate(
            self.base,
            peer,
            action="create",
            key="footer",
            title="Render the status line",
            scope="Terminal",
            acceptance="Fields visible",
        )["item"]
        claimed = mailbox_work.mutate(
            self.base, peer, action="claim", item=created["id"], revision=created["revision"]
        )["item"]
        self.room()
        fields = self.fields()
        self.assertEqual(
            (fields["goal"], fields["task"], fields["stage"]), ("Build a footer", "Render the status line", "claimed")
        )
        blocked = mailbox_work.mutate(
            self.base,
            peer,
            action="checkpoint",
            item=claimed["id"],
            revision=claimed["revision"],
            blocker="Waiting for a decision",
        )["item"]
        self.assertEqual(self.fields()["stage"], "blocked")
        unblocked = mailbox_work.mutate(
            self.base, peer, action="checkpoint", item=blocked["id"], revision=blocked["revision"], blocker=""
        )["item"]
        mailbox_work.mutate(
            self.base,
            peer,
            action="submit",
            item=unblocked["id"],
            revision=unblocked["revision"],
            evidence="Change is ready",
            verification="Focused checks pass",
        )
        self.assertEqual(self.fields()["stage"], "review")

    def test_room_task_uses_exact_run_and_verdict(self):
        directory = self.home / "task"
        binding = {
            "taskDir": str(directory),
            "taskId": "task-a",
            "requestId": "request-a",
            "runId": "run-a",
            "transport": "native",
        }
        self.room(dispatch=binding)
        task = {
            "schema": "agent-executor.task.v1",
            "task_id": "task-a",
            "repository": str(self.home),
            "task_spec": {"objective": "Test the footer"},
            "runs": [
                {
                    "request_id": "request-a",
                    "run_id": "run-a",
                    "engine": "claude",
                    "transport": "native",
                    "status": "finished",
                    "runner_status": "completed",
                }
            ],
            "decisions": [],
        }
        task["runs"].insert(0, "unrelated malformed run")
        task["decisions"].append("unrelated malformed decision")
        mailbox.write(directory / "task.json", task)
        self.assertEqual((self.fields()["task"], self.fields()["stage"]), ("Test the footer", "review"))
        task["decisions"].append({"run_id": "run-a", "decision": "accept"})
        mailbox.write(directory / "task.json", task)
        self.assertEqual(self.fields()["stage"], "completed")
        task["runs"].pop(0)
        task["decisions"].clear()
        task["runs"][0]["runner_status"] = "failed"
        mailbox.write(directory / "task.json", task)
        self.assertEqual(self.fields()["stage"], "failed")
        task["decisions"].append({"run_id": "run-a", "decision": "reject"})
        mailbox.write(directory / "task.json", task)
        self.assertEqual(self.fields()["stage"], "rejected")
        task["decisions"].append({"run_id": "run-a", "decision": "takeover"})
        mailbox.write(directory / "task.json", task)
        self.assertEqual(self.fields()["stage"], "blocked")
        task["runs"][0]["run_id"] = "different"
        mailbox.write(directory / "task.json", task)
        self.assertEqual((self.fields()["task"], self.fields()["stage"]), ("not set", "not set"))

    def test_ambiguous_rooms_and_tasks_do_not_choose_a_winner(self):
        self.room(title="First goal")
        self.room(title="Another goal", name="room-b")
        fields = self.fields()
        self.assertEqual((fields["goal"], fields["task"], fields["stage"]), ("multiple rooms", "not set", "not set"))

        peer = mailbox.load(mailbox.peer_path(self.base, "claude-123"))
        for index in range(2):
            created = mailbox_work.mutate(
                self.base,
                peer,
                action="create",
                key=f"task-{index}",
                title=f"Task {index}",
                scope="Terminal",
                acceptance="Visible",
            )["item"]
            mailbox_work.mutate(self.base, peer, action="claim", item=created["id"], revision=created["revision"])
        fields = self.fields()
        self.assertEqual((fields["task"], fields["stage"]), ("multiple tasks", "varies"))

    def test_saved_note_must_match_this_sessions_focus(self):
        peer = self.peer("claude-123", "snorfle-opus-high-project-23", "claude", focus="Review docs")
        mailbox_tasks.save(self.base, peer, status="blocked", blocker="Waiting for review")
        self.assertEqual((self.fields()["task"], self.fields()["stage"]), ("Review docs", "blocked"))
        self.peer("claude-123", "snorfle-opus-high-project-23", "claude", focus="Build a footer")
        self.assertEqual((self.fields()["task"], self.fields()["stage"]), ("Build a footer", "not set"))

    def test_width_and_untrusted_terminal_text_are_safe(self):
        self.peer(
            "claude-123",
            "snorfle-opus-high-project-23",
            "claude",
            model="a-very-long-model-version",
            effort="medium",
            focus="A long task with #() and \x1b[2J escape",
        )
        self.room(title="An overarching goal that is much longer than usual")
        line = self.run_status("--session", "claude-123", "--width", "80", "--plain").strip()
        self.assertLessEqual(len(line), 80)
        self.assertIn("stage : ", line)
        self.assertIn("goal : ", line)
        self.assertIn("task : ", line)
        self.assertIn("-23", line)
        self.assertNotIn("\x1b", line)
        narrow = self.run_status("--session", "claude-123", "--width", "32", "--plain").strip()
        self.assertLessEqual(len(narrow), 32)
        tmux = self.run_status(
            "--session", "claude-123", "--width", "200", "--tmux", environment={**self.environment, "NO_COLOR": "1"}
        )
        self.assertIn("##()", tmux)
        self.assertNotIn("\x1b", tmux)

    def test_missing_invalid_or_wrong_harness_does_not_guess(self):
        self.assertEqual(self.run_status("--plain", payload={"session_id": "other"}), "")
        self.assertEqual(self.run_status("--plain", payload={"session_id": "../claude-123"}), "")
        self.assertEqual(self.run_status("--harness", "gemini", payload={"session_id": "claude-123"}), "")
        self.assertEqual(self.run_status("--plain", payload=[]), "")
        self.peer("invalid-name", "name\x1b[2J", "claude")
        self.assertEqual(self.run_status("--session", "invalid-name"), "")

    def test_pane_matching_requires_exactly_one_live_codex_peer(self):
        self.peer("codex-789", "blip-gpt-high-project-89", "codex", os.getpid())
        line = self.run_status("--pane-pid", str(os.getpid()), "--harness", "codex", "--plain", "--width", "200")
        self.assertTrue(line.startswith("blip-gpt-high-project-89 | "))
        self.peer("codex-999", "zog-gpt-low-project-99", "codex", os.getpid())
        self.assertEqual(self.run_status("--pane-pid", str(os.getpid()), "--harness", "codex", "--plain"), "")

    def test_visible_codex_thread_selects_its_identity_on_a_shared_daemon(self):
        first = "01a18d2e-cd95-7043-bc95-2339f2faf78e"
        second = "01a18d61-329d-7170-af88-c965f50e6366"
        for session, name in ((first, "blip-gpt-high-project-8e"), (second, "zog-gpt-low-project-66")):
            self.peer(session, name, "codex", pid=99999999, accountHome=str(self.home))
        binary = self.home / "tmux"
        binary.write_text('#!/bin/sh\ncat "$TEST_PANE_TITLE"\n')
        binary.chmod(0o755)
        title = self.home / "title"
        environment = {
            **self.environment,
            "PATH": str(self.home) + os.pathsep + os.environ["PATH"],
            "TEST_PANE_TITLE": str(title),
        }
        arguments = (
            "--codex-pane",
            "%0",
            "--tmux-server",
            "private",
            "--codex-home",
            str(self.home),
            "--harness",
            "codex",
            "--json",
            "--width",
            "200",
        )
        title.write_text(first[:29] + "...")
        self.assertEqual(
            json.loads(self.run_status(*arguments, environment=environment))["name"], "blip-gpt-high-project-8e"
        )
        title.write_text(second)
        self.assertEqual(
            json.loads(self.run_status(*arguments, environment=environment))["name"], "zog-gpt-low-project-66"
        )
        title.write_text(first[:29] + "...")
        self.peer(first[:29] + "0000000", "conflicting-peer", "codex", accountHome=str(self.home))
        self.assertEqual(self.run_status(*arguments, environment=environment), "")
        title.write_text("not a native thread ID")
        self.assertEqual(self.run_status(*arguments, environment=environment), "")
        title.write_text(second)
        self.peer(second, "other-account", "codex", accountHome=str(self.home / "different-account"))
        self.assertEqual(self.run_status(*arguments, environment=environment), "")


if __name__ == "__main__":
    unittest.main()
