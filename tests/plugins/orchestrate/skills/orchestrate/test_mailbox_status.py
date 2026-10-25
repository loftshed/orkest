"""Read project status and wait for changes without joining, messaging or changing task state."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

import test_mailbox_daemon

SCRIPTS = test_mailbox_daemon.SCRIPTS
sys.path.insert(0, str(SCRIPTS))
import mailbox_status as status  # noqa: E402
import mailbox_work as work  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402


class StatusTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name).resolve()
        self.base = self.folder / "cache" / "mailbox-v1"
        self.project = self.folder / "project"
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        self.reader = mailbox.workspace(str(self.project))
        self.lead = self.peer("lead")
        self.worker = self.peer("worker")
        self.item = work.mutate(
            self.base,
            self.lead,
            action="create",
            key="repair",
            title="Repair export",
            scope="Parser",
            acceptance="Empty input works",
        )["item"]
        self.item = work.mutate(self.base, self.worker, action="claim", item=self.item["id"], revision=1)["item"]

    def peer(self, session):
        return mailbox.register(self.base, session=session, harness="codex", cwd=str(self.project), pid=os.getpid())

    def checkpoint(self, **details):
        self.item = work.mutate(
            self.base, self.worker, action="checkpoint", item=self.item["id"], revision=self.item["revision"], **details
        )["item"]

    def test_snapshot_filters_scope_agent_channel_and_reports_actual_checkpoint(self):
        mailbox.annotate(self.base, "worker", channels=["export"], focus="Check empty input", state="busy")
        self.checkpoint(next_step="Run parser regression", blocker="Need fixture")
        outsider = {**self.worker, "session": "outsider", "repo": "/another-project", "remotes": []}
        mailbox.write(mailbox.peer_path(self.base, "outsider"), outsider)
        view = status.snapshot(self.base, self.reader, channel="export")
        self.assertEqual([p["session"] for p in view["agents"]], ["worker"])
        self.assertEqual((view["agents"][0]["state"], view["agents"][0]["focus"]), ("busy", "Check empty input"))
        self.assertEqual(
            [(i["title"], i["state"], i["blocker"], i["next"]) for i in view["items"]],
            [("Repair export", "blocked", "Need fixture", "Run parser regression")],
        )
        self.assertEqual(status.snapshot(self.base, self.reader, agent="outsider")["total_count"], 0)
        self.assertEqual(
            status.snapshot(self.base, self.reader, agent=self.worker["name"])["items"][0]["owner"], "worker"
        )

    def test_heartbeats_do_not_trigger_updates_but_off_page_work_changes_do(self):
        first = status.snapshot(self.base, self.reader, limit=1)
        mailbox.annotate(self.base, "worker", lastSeenAt=mailbox.stamp())  # fresh, so presence holds
        self.assertEqual(status.snapshot(self.base, self.reader, limit=1)["cursor"], first["cursor"])
        self.checkpoint(next_step="Review final patch")
        changed = status.observe(self.base, self.reader, since=first["cursor"], timeout=0.1, limit=1)
        self.assertEqual(changed["status"], "changed")
        self.assertEqual(changed["items"], [])  # the changed item is beyond this page, but is not missed
        self.assertNotEqual(changed["cursor"], first["cursor"])

    def test_wait_returns_one_change_and_timeout_and_cancellation_are_non_consuming(self):
        cursor = status.snapshot(self.base, self.reader)["cursor"]
        stop = threading.Event()
        output = []
        thread = threading.Thread(
            target=lambda: output.append(
                status.observe(self.base, self.reader, since=cursor, timeout=4, cancelled=stop)
            )
        )
        thread.start()
        try:
            self.checkpoint(blocker="Review required")
            thread.join(timeout=4)
            self.assertFalse(thread.is_alive())
            self.assertEqual(output[0]["status"], "changed")
            cursor = output[0]["cursor"]
            unchanged = status.observe(self.base, self.reader, since=cursor, timeout=0.02)
            self.assertEqual((unchanged["status"], unchanged["cursor"]), ("timed_out", cursor))
            stop.set()
            self.assertEqual(
                status.observe(self.base, self.reader, since=cursor, cancelled=stop)["status"], "cancelled"
            )
            self.assertEqual(work.listing(self.base, self.reader)["items"][0]["state"], "blocked")
            self.assertFalse((self.base / "inbox").exists())
        finally:
            stop.set()
            thread.join(timeout=4)

    def test_missing_presence_does_not_turn_unfinished_work_into_complete(self):
        mailbox.unregister(self.base, "worker")
        view = status.snapshot(self.base, self.reader, agent="worker")
        self.assertEqual(view["agents"], [])
        self.assertEqual((view["items"][0]["state"], view["items"][0]["recoveryNeeded"]), ("claimed", "owner_absent"))

    def test_paging_bounds_unicode_and_preserves_every_record(self):
        for index in range(18):
            peer = self.peer(f"peer-{index}")
            mailbox.annotate(self.base, peer["session"], focus="😀" * 200)
        offset, seen = 0, []
        while True:
            view = status.snapshot(self.base, self.reader, limit=50, offset=offset)
            self.assertLessEqual(len(json.dumps(view, ensure_ascii=True).encode()), 12 * 1024)
            seen.extend(peer["session"] for peer in view["agents"])
            seen.extend(item["id"] for item in view["items"])
            if not view["has_more"]:
                break
            offset = view["next_offset"]
        self.assertEqual(len(seen), 21)
        self.assertEqual(len(set(seen)), 21)

    def test_cli_observer_does_not_register_even_with_inherited_session(self):
        env = {**os.environ, "AGENT_EXECUTOR_HOME": str(self.base.parent), "AGENT_MAILBOX_SESSION": "observer"}
        command = [
            sys.executable,
            "-B",
            str(SCRIPTS / "run_agent.py"),
            "mailbox",
            "board",
            "--view",
            "status",
            "--agent",
            "worker",
            "--format",
            "json",
        ]
        view = json.loads(subprocess.check_output(command, cwd=self.project, env=env, text=True))
        self.assertEqual((view["status"], view["items"][0]["title"]), ("snapshot", "Repair export"))
        self.assertFalse(mailbox.peer_path(self.base, "observer").exists())
        timed = json.loads(
            subprocess.check_output(
                command + ["--since", view["cursor"], "--timeout", "0.02"], cwd=self.project, env=env, text=True
            )
        )
        self.assertEqual(timed["status"], "timed_out")

    def test_invalid_cursor_and_timeout_fail_before_status_is_read(self):
        for parameters in ({"since": "bad"}, {"timeout": 601}, {"timeout": float("nan")}, {"timeout": 0}):
            with self.subTest(parameters=parameters), self.assertRaises(mailbox.MailboxError):
                status.observe(self.base, self.reader, **parameters)
        self.assertEqual(status.observe(self.base, self.reader)["items"][0]["title"], "Repair export")


class StatusHTTPTests(unittest.TestCase):
    def test_existing_board_tool_serves_status_and_rejects_ambiguous_filters(self):
        client = test_mailbox_daemon.TestMailboxDaemon()
        client.setUp()
        self.addCleanup(client.tearDown)
        client.start()
        client.peer("observer")
        worker = client.peer("worker", "claude")
        mailbox.set_focus(client.base, worker["session"], "Verify export")
        work.mutate(
            client.base,
            worker,
            action="create",
            key="report",
            title="Verify export",
            scope="Export",
            acceptance="Check passes",
        )
        view = client.body(client.call("board", {"view": "status", "agent": "worker"}, session="observer"))
        self.assertEqual([(p["session"], p["focus"]) for p in view["agents"]], [("worker", "Verify export")])
        self.assertEqual(view["status"], "snapshot")
        self.assertEqual(view["items"][0]["title"], "Verify export")
        import mailbox_mcp

        self.assertEqual(set(view["items"][0]), set(mailbox_mcp.STATUS_ITEM_OUTPUT["properties"]))
        self.assertEqual(set(view["agents"][0]), set(mailbox_mcp.STATUS_AGENT_OUTPUT["properties"]))
        invalid = client.call("board", {"agent": "worker"}, session="observer")[1]["result"]
        self.assertTrue(invalid["isError"])
        self.assertIn("view=status", invalid["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
