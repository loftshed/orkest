"""An interrupted task produces one useful notice, without treating silence as a confirmed exit."""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import mailbox_channels as channels  # noqa: E402
import mailbox_presence as presence  # noqa: E402
import mailbox_tasks as tasks  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402


class PresenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name) / "mailbox-v1"
        self.cwd = str(Path(temporary.name) / "project")
        subprocess.run(["git", "init", "-q", self.cwd], check=True)
        self.child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        self.addCleanup(self.stop_child)
        self.owner = self.peer("author", pid=self.child.pid)
        self.reader = self.peer("reader")
        mailbox.set_focus(self.base, "author", "Repair export", task_details={"next": "Review PR #8"})

    def peer(self, session, *, pid=None, cwd=None):
        return mailbox.register(
            self.base, session=session, harness="codex", cwd=cwd or self.cwd, pid=pid or os.getpid()
        )

    def stop_child(self):
        if self.child.poll() is None:
            self.child.kill()
        self.child.wait()

    def notice(self, session="reader"):
        [notice] = mailbox.incoming(self.base, session)
        return notice

    def test_killed_process_notifies_once_and_keeps_the_checkpoint(self):
        self.stop_child()
        presence.reconcile(self.base)
        notice = self.notice()
        self.assertIn("its recorded process exited; the cause is unknown", notice["text"])
        self.assertIn("Last saved task: Repair export. Next: Review PR #8.", notice["text"])
        self.assertEqual([notice["kind"], notice["wake"], notice["presenceNotice"]], ["notice", False, True])
        mailbox.mark_read(self.base, "reader", [notice["id"]])
        for _ in range(2):
            presence.reconcile(self.base)
        self.assertEqual(mailbox.incoming(self.base, "reader"), [])
        self.assertEqual(len(mailbox.messages(self.base, "reader", unread_only=False)), 1)
        [note] = tasks.listing(self.base, self.reader)["tasks"]
        self.assertEqual([note["ownerPresent"], note["status"], note["next"]], [False, "active", "Review PR #8"])

    def test_named_channels_notify_only_related_project_peers(self):
        channels.update(self.base, "author", join=["exports"])
        channels.update(self.base, "reader", join=["exports"])
        self.peer("other-task")
        channels.update(self.base, "other-task", join=["imports"])
        self.peer("other-project", cwd=str(Path(self.cwd).parent / "unrelated"))
        channels.update(self.base, "other-project", join=["exports"])
        self.stop_child()
        # Ordinary discovery must not delete the evidence before the daemon notices.
        mailbox.peers(self.base)
        self.assertIn("Repair export", self.notice()["text"])
        self.assertEqual(mailbox.incoming(self.base, "other-task"), [])
        self.assertEqual(mailbox.incoming(self.base, "other-project"), [])

    def test_shared_host_silence_is_uncertain_and_a_busy_session_stays_present(self):
        owner = self.peer("author")
        mailbox.annotate(
            self.base,
            "author",
            state="busy",
            lastSeenAt=mailbox.stamp(mailbox.now() - dt.timedelta(hours=4)),
        )
        presence.reconcile(self.base)
        self.assertIn("author", [p["session"] for p in mailbox.peers(self.base)])
        self.assertEqual(mailbox.incoming(self.base, "reader"), [])
        mailbox.annotate(self.base, "author", state="idle")
        presence.reconcile(self.base)
        self.assertIn("presence expired; a process exit is not confirmed", self.notice()["text"])
        self.assertEqual(mailbox.pid_alive(owner["pid"]), True)

    def test_read_unanswered_request_notifies_even_without_an_unfinished_task(self):
        mailbox.set_focus(self.base, "author", "Repair export", task_details={"status": "complete"})
        question = mailbox.send(self.base, sender=self.reader, to="author", text="Did the build pass?")
        mailbox.take(self.base, "author")
        self.peer("bystander")
        self.stop_child()
        presence.reconcile(self.base)
        notice = self.notice()
        self.assertEqual(notice["replyTo"], question["id"])
        self.assertIn("1 request(s) may be unfinished", notice["text"])
        self.assertNotIn("Last saved task", notice["text"])
        self.assertEqual(mailbox.incoming(self.base, "bystander"), [])

    def test_answered_requests_and_completed_tasks_do_not_send_departure_noise(self):
        question = mailbox.send(self.base, sender=self.reader, to="author", text="Did the build pass?")
        mailbox.take(self.base, "author")
        mailbox.send(self.base, sender=self.owner, to="reader", text="Yes", reply_to=question["id"])
        mailbox.set_focus(self.base, "author", "Repair export", task_details={"status": "complete"})
        self.stop_child()
        presence.reconcile(self.base)
        self.assertEqual([m["text"] for m in mailbox.incoming(self.base, "reader")], ["Yes"])

    def test_cross_project_requester_does_not_receive_private_task_context(self):
        outsider = self.peer("outside", cwd=str(Path(self.cwd).parent / "elsewhere"))
        question = mailbox.send(self.base, sender=outsider, to="author", text="Can you respond?", scope="cross-project")
        self.stop_child()
        presence.reconcile(self.base)
        notice = self.notice("outside")
        self.assertEqual(notice["replyTo"], question["id"])
        self.assertIn("process exited", notice["text"])
        self.assertNotIn("Repair export", notice["text"])
        self.assertNotIn("Review PR #8", notice["text"])

    def test_partial_delivery_replays_without_reopening_acknowledged_mail(self):
        self.peer("second-reader")
        self.stop_child()
        write = mailbox.write

        def fail_second(path, value):
            if path.parent == mailbox.inbox_dir(self.base, "second-reader"):
                raise OSError("simulated full disk")
            write(path, value)

        with patch.object(mailbox, "write", side_effect=fail_second), self.assertRaises(OSError):
            presence.reconcile(self.base)
        first = self.notice()
        mailbox.mark_read(self.base, "reader", [first["id"]])
        presence.reconcile(self.base)
        self.assertEqual(mailbox.incoming(self.base, "reader"), [])
        self.assertEqual(len(mailbox.messages(self.base, "reader", unread_only=False)), 1)
        self.assertIn("Repair export", self.notice("second-reader")["text"])

    def test_concurrent_discovery_and_monitoring_emit_one_notice(self):
        self.stop_child()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(operation, self.base) for operation in (presence.reconcile, mailbox.peers)]
            for future in futures:
                future.result(timeout=10)
        self.assertIn("Repair export", self.notice()["text"])

    def test_resumed_owner_cancels_undelivered_absence(self):
        self.stop_child()
        with patch.object(presence, "deliver", side_effect=OSError("interrupted")), self.assertRaises(OSError):
            mailbox.peers(self.base)
        self.peer("author")
        presence.reconcile(self.base)
        self.assertIn("author", [p["session"] for p in mailbox.peers(self.base)])
        self.assertEqual(mailbox.incoming(self.base, "reader"), [])

    def test_replayed_checkpoint_does_not_follow_a_recipient_into_another_project(self):
        self.stop_child()
        with patch.object(presence, "deliver", side_effect=OSError("interrupted")), self.assertRaises(OSError):
            mailbox.peers(self.base)
        self.peer("reader", cwd=str(Path(self.cwd).parent / "unrelated"))
        presence.reconcile(self.base)
        self.assertEqual(mailbox.messages(self.base, "reader"), [])
        self.assertEqual(tasks.listing(self.base, self.owner)["tasks"][0]["next"], "Review PR #8")

    def test_a_reused_process_id_is_a_confirmed_exit(self):
        mailbox.annotate(self.base, "author", pid=os.getpid(), pidBirth="old process start")
        presence.reconcile(self.base)
        self.assertIn("process exited and its process ID was reused", self.notice()["text"])

    def test_notices_wait_until_next_turn_and_normal_session_end_still_reports_unread_mail(self):
        self.stop_child()
        presence.reconcile(self.base)
        with patch.object(mailbox, "harness_pid", return_value=os.getpid()):
            stopped = mailbox.hook(
                {"session_id": "reader", "cwd": self.cwd}, harness="codex", event="Stop", base=self.base
            )
        self.assertIsNone(stopped)
        self.assertIn("Repair export", self.notice()["text"])
        with patch.object(mailbox, "harness_pid", return_value=os.getpid()):
            started = mailbox.hook(
                {"session_id": "reader", "cwd": self.cwd}, harness="codex", event="UserPromptSubmit", base=self.base
            )
        self.assertIn("Repair export", str(started))
        self.assertEqual(mailbox.incoming(self.base, "reader"), [])
        self.owner = self.peer("author")
        mailbox.send(self.base, sender=self.reader, to="author", text="One more question")
        mailbox.end_session(self.base, "author", reason="prompt_input_exit", pid=os.getpid())
        presence.reconcile(self.base)
        self.assertIn("ended (prompt_input_exit) without reading your message", self.notice()["text"])

    def test_event_receipts_expire_after_seven_days(self):
        self.stop_child()
        presence.reconcile(self.base)
        self.assertIn("Repair export", self.notice()["text"])
        [event] = list((self.base / "presence-events").glob("*.json"))
        later = mailbox.now() + dt.timedelta(days=8)
        with patch.object(mailbox, "now", return_value=later):
            presence.deliver(self.base)
        self.assertFalse(event.exists())


if __name__ == "__main__":
    unittest.main()
