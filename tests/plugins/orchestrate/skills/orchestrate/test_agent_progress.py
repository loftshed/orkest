"""Session reports fill the footer without inventing ownership, freshness or completion."""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import agent_progress as progress  # noqa: E402
import agent_statusline as statusline  # noqa: E402
import mailbox_daemon  # noqa: E402
import mailbox_work as work  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402


class ProgressTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.base = self.home / "mailbox-v1"
        self.cwd = self.home / "project"
        subprocess.run(["git", "init", "-q", str(self.cwd)], check=True)
        self.peer = mailbox.register(
            self.base, session="progress-session", harness="codex", cwd=str(self.cwd), pid=os.getpid()
        )
        self.environment = {**os.environ, "AGENT_EXECUTOR_HOME": str(self.home)}

    def command(self, *arguments):
        return subprocess.run(
            [
                "node",
                str(SCRIPTS.parents[2] / "bin/ork.mjs"),
                "progress",
                "--session",
                self.peer["session"],
                *arguments,
            ],
            env=self.environment,
            text=True,
            capture_output=True,
            check=False,
        )

    def fields(self):
        with patch.object(mailbox, "root", return_value=self.base):
            return statusline.identity(self.peer["session"], "codex")

    def report(self, stage="working", task="Fix parser"):
        return progress.report(self.base, self.peer, goal="Ship export", task=task, stage=stage)

    def test_one_command_fills_work_fields_and_partial_updates_preserve_the_context(self):
        before = self.fields()
        self.assertEqual((before["goal"], before["task"], before["stage"]), ("not set", "not set", "not set"))
        result = self.command("--goal", "Ship export", "--task", "Fix parser", "--stage", "working")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.command("--stage", "testing").returncode, 0)
        item = self.fields()
        self.assertEqual(
            (item["goal"], item["task"], item["stage"], item["statusHealth"]),
            ("Ship export", "Fix parser", "testing", "fresh"),
        )
        confirmation = self.command()
        self.assertEqual(json.loads(confirmation.stdout)["task"], "Fix parser")
        self.assertFalse((self.base / "work/board.json").exists())

    def test_old_reports_are_visible_as_stale_and_confirmation_restores_freshness(self):
        old = mailbox.now() - dt.timedelta(minutes=31)
        with patch.object(mailbox, "now", return_value=old):
            self.report("testing")
        item = self.fields()
        self.assertEqual((item["stage"], item["statusHealth"]), ("testing (stale)", "stale"))
        self.assertEqual(self.command().returncode, 0)
        self.assertEqual(self.fields()["stage"], "testing")
        with patch.object(mailbox, "now", return_value=old):
            self.report("complete")
        self.assertEqual(self.fields()["stage"], "complete")

    def test_changing_tasks_requires_a_new_stage_and_invalid_updates_preserve_the_report(self):
        self.report("complete")
        self.assertEqual(self.command("--task", "Repair renderer").returncode, 2)
        self.assertEqual((self.fields()["task"], self.fields()["stage"]), ("Fix parser", "complete"))
        self.assertEqual(self.command("--goal", "").returncode, 2)
        self.assertEqual(self.command("--task", "Repair renderer", "--stage", "planning").returncode, 0)
        self.assertEqual((self.fields()["task"], self.fields()["stage"]), ("Repair renderer", "planning"))

    def test_context_cannot_follow_a_session_into_another_checkout_or_account(self):
        self.report()
        self.assertEqual(self.fields()["goal"], "Ship export")
        mailbox.register(
            self.base, session=self.peer["session"], harness="codex", cwd=str(self.home / "elsewhere"), pid=os.getpid()
        )
        self.assertEqual(self.fields()["goal"], "not set")
        self.assertEqual(self.command("--stage", "testing").returncode, 2)
        mailbox.register(
            self.base,
            session=self.peer["session"],
            harness="codex",
            cwd=str(self.cwd),
            pid=os.getpid(),
            account=str(self.home / "other-account"),
        )
        self.assertEqual(self.fields()["task"], "not set")

    def test_workboard_blockers_and_review_override_reported_phase(self):
        item = work.mutate(
            self.base,
            self.peer,
            action="create",
            key="parser",
            title="Fix parser",
            scope="Parser",
            acceptance="Export works",
        )["item"]
        item = work.mutate(self.base, self.peer, action="claim", item=item["id"], revision=item["revision"])["item"]
        self.report("testing")
        self.assertEqual(self.fields()["stage"], "testing")
        item = work.mutate(
            self.base,
            self.peer,
            action="checkpoint",
            item=item["id"],
            revision=item["revision"],
            blocker="Needs fixture",
        )["item"]
        self.report("complete")
        self.assertEqual(self.fields()["stage"], "blocked")
        item = work.mutate(
            self.base, self.peer, action="checkpoint", item=item["id"], revision=item["revision"], blocker=""
        )["item"]
        work.mutate(
            self.base,
            self.peer,
            action="submit",
            item=item["id"],
            revision=item["revision"],
            evidence="Parser patch",
            verification="Focused regression passes",
        )
        self.assertEqual(self.fields()["stage"], "review")

    def test_a_different_assignment_does_not_inherit_the_previous_goal(self):
        self.report()
        item = work.mutate(
            self.base,
            self.peer,
            action="create",
            key="other",
            title="Repair renderer",
            scope="Renderer",
            acceptance="Readable output",
        )["item"]
        work.mutate(self.base, self.peer, action="claim", item=item["id"], revision=item["revision"])
        current = self.fields()
        self.assertEqual(
            (current["goal"], current["task"], current["stage"]), ("not set", "Repair renderer", "claimed")
        )
        self.assertIn("out of date", progress.reminder(self.base, self.peer))

    def test_released_or_accepted_work_cannot_return_as_a_standalone_report(self):
        for finish in ("release", "accept"):
            with self.subTest(finish=finish):
                item = work.mutate(
                    self.base,
                    self.peer,
                    action="create",
                    key=finish,
                    title="Fix parser",
                    scope="Parser",
                    acceptance="Export works",
                )["item"]
                item = work.mutate(self.base, self.peer, action="claim", item=item["id"], revision=item["revision"])[
                    "item"
                ]
                self.report("testing")
                self.assertEqual(self.fields()["stage"], "testing")
                if finish == "accept":
                    item = work.mutate(
                        self.base,
                        self.peer,
                        action="submit",
                        item=item["id"],
                        revision=item["revision"],
                        evidence="Parser patch",
                        verification="Regression passes",
                    )["item"]
                work.mutate(
                    self.base, self.peer, action=finish, item=item["id"], revision=item["revision"], note="Reviewed"
                )
                current = self.fields()
                self.assertEqual(
                    (current["goal"], current["task"], current["stage"]), ("not set", "not set", "not set")
                )
                self.assertEqual(self.command("--stage", "working").returncode, 2)
                self.assertIn("out of date", progress.reminder(self.base, self.peer))

    def test_a_new_item_with_the_same_title_requires_fresh_context(self):
        for key in ("first", "second"):
            item = work.mutate(
                self.base,
                self.peer,
                action="create",
                key=key,
                title="Fix parser",
                scope="Parser",
                acceptance="Export works",
            )["item"]
            item = work.mutate(self.base, self.peer, action="claim", item=item["id"], revision=item["revision"])["item"]
            if key == "first":
                self.report("testing")
                work.mutate(
                    self.base,
                    self.peer,
                    action="release",
                    item=item["id"],
                    revision=item["revision"],
                    note="Reassigned",
                )
        current = self.fields()
        self.assertEqual((current["goal"], current["task"], current["stage"]), ("not set", "Fix parser", "claimed"))
        self.assertIn("out of date", progress.reminder(self.base, self.peer))
        self.assertEqual(self.command("--stage", "working").returncode, 2)
        result = self.command("--goal", "Ship import", "--task", "Fix parser", "--stage", "planning")
        self.assertEqual(result.returncode, 0, result.stderr)
        current = self.fields()
        self.assertEqual(
            (current["goal"], current["task"], current["stage"]), ("Ship import", "Fix parser", "planning")
        )

    def test_turn_hooks_remind_each_harness_but_never_extend_a_turn_or_mark_it_complete(self):
        for harness in ("claude", "codex", "gemini"):
            with (
                self.subTest(harness=harness),
                patch.object(mailbox, "harness_pid", return_value=os.getpid()),
                patch.object(mailbox_daemon, "get_mode", return_value="stdio"),
            ):
                session = f"hook-{harness}"
                payload = {"session_id": session, "cwd": str(self.cwd)}
                started = mailbox.hook(payload, harness=harness, event="SessionStart", base=self.base)
                self.assertIn("--goal 'overall goal' --task 'current task' --stage working", str(started))
                peer = mailbox.load(mailbox.peer_path(self.base, session))
                progress.report(self.base, peer, goal="Ship export", task="Fix parser", stage="working")
                stopped = mailbox.hook(payload, harness=harness, event="Stop", base=self.base)
                self.assertIn(stopped, (None, {}))
                self.assertEqual(progress.read(self.base, peer)["stage"], "working")
                old = mailbox.now() - dt.timedelta(minutes=31)
                with patch.object(mailbox, "now", return_value=old):
                    progress.report(self.base, peer, goal="Ship export", task="Fix parser", stage="working")
                peer = mailbox.annotate(self.base, session, progressReminderAt=mailbox.stamp(old))
                event = "PreInvocation" if harness == "gemini" else "UserPromptSubmit"
                reminded = mailbox.hook(payload, harness=harness, event=event, base=self.base)
                self.assertIn("footer progress is stale", str(reminded))
                self.assertEqual(progress.reminder(self.base, mailbox.load(mailbox.peer_path(self.base, session))), "")


if __name__ == "__main__":
    unittest.main()
