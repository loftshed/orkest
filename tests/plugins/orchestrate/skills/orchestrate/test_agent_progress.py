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
        self.enterContext(patch.object(mailbox, "claude_session_dirs", return_value=[]))
        self.cwd = self.home / "project"
        subprocess.run(["git", "init", "-q", str(self.cwd)], check=True)
        self.peer = mailbox.register(
            self.base, session="progress-session", harness="codex", cwd=str(self.cwd), pid=os.getpid()
        )
        self.environment = {**os.environ, "AGENT_EXECUTOR_HOME": str(self.home)}

    def command(self, *arguments, direct=False):
        executable = (
            [sys.executable, str(SCRIPTS / "agent_progress.py")]
            if direct
            else ["node", str(SCRIPTS.parents[2] / "bin/ork.mjs"), "progress"]
        )
        return subprocess.run(
            [
                *executable,
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

    def test_both_clis_refuse_another_live_process_even_with_its_session_in_the_environment(self):
        self.report()
        path = progress.record_path(self.base, self.peer["session"])
        previous = path.read_bytes()
        with subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE) as owner:
            mailbox.register(self.base, session=self.peer["session"], harness="codex", cwd=str(self.cwd), pid=owner.pid)
            self.environment["AGENT_MAILBOX_SESSION"] = self.peer["session"]
            for direct in (False, True):
                with self.subTest(direct=direct):
                    result = self.command("--goal", "Overwrite owner", "--stage", "complete", direct=direct)
                    self.assertEqual(result.returncode, 2, result.stdout)
                    self.assertIn(self.peer["session"], result.stderr)
                    self.assertIn("not owned by this process", result.stderr)
                    self.assertEqual(path.read_bytes(), previous)

    def test_shell_descendants_can_update_each_harness_and_native_subagents(self):
        mailbox.register(self.base, session="parent", harness="codex", cwd=str(self.cwd), pid=os.getpid())
        for harness in ("claude", "codex", "gemini", "opencode"):
            with self.subTest(harness=harness):
                peer = mailbox.register(
                    self.base, session=self.peer["session"], harness=harness, cwd=str(self.cwd), pid=os.getpid()
                )
                for subagent in (False, True):
                    mailbox.annotate(self.base, peer["session"], isSubagent=subagent, parentSession="parent")
                    result = subprocess.run(
                        [
                            "bash",
                            "-c",
                            '"$@"',
                            "progress-shell",
                            "node",
                            str(SCRIPTS.parents[2] / "bin/ork.mjs"),
                            "progress",
                            "--session",
                            peer["session"],
                            "--goal",
                            "Ship export",
                            "--task",
                            "Fix parser",
                            "--stage",
                            "testing",
                        ],
                        env=self.environment,
                        text=True,
                        capture_output=True,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(progress.read(self.base, peer)["stage"], "testing")

    def test_dead_unknown_and_recycled_pids_do_not_lock_out_resumed_sessions(self):
        with subprocess.Popen([sys.executable, "-c", "pass"]) as ended:
            ended.wait(timeout=5)
        for pid, birth in ((None, None), (ended.pid, "old"), (os.getpid(), "previous process")):
            with self.subTest(pid=pid, birth=birth):
                mailbox.annotate(self.base, self.peer["session"], pid=pid, pidBirth=birth)
                result = self.command("--goal", "Resume export", "--task", "Fix parser", "--stage", "working")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["goal"], "Resume export")

    def test_macos_process_table_allows_descendants_and_rejects_other_live_owners(self):
        peer = {**self.peer, "pid": 400, "pidBirth": "birth"}
        for table, allowed in (("200 300\n300 400\n400 1\n", True), ("200 300\n300 1\n400 1\n", False)):
            with (
                self.subTest(table=table),
                patch.object(progress.sys, "platform", "darwin"),
                patch.object(progress.os, "getpid", return_value=100),
                patch.object(progress.os, "getppid", return_value=200),
                patch.object(mailbox, "pid_alive", return_value=True),
                patch.object(mailbox, "process_started", return_value="birth"),
                patch.object(progress.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, table)),
            ):
                if allowed:
                    row = progress.report(self.base, peer, goal="Ship export", task="Fix parser", stage="working")
                    self.assertEqual(row["task"], "Fix parser")
                else:
                    with self.assertRaisesRegex(mailbox.MailboxError, "progress-session.*not owned"):
                        progress.report(self.base, peer, goal="Overwrite owner", task="Other", stage="complete")
                    self.assertEqual(progress.read(self.base, peer)["task"], "Fix parser")

    def test_missing_ps_never_grants_an_unverified_live_owner_but_own_process_still_works(self):
        with (
            patch.object(progress.sys, "platform", "darwin"),
            patch.object(mailbox, "pid_alive", return_value=True),
            patch.object(mailbox, "process_started", return_value=None),
            patch.object(progress.subprocess, "run", side_effect=FileNotFoundError("ps unavailable")),
        ):
            self.assertEqual(self.report()["stage"], "working")
            for birth in (None, "birth"):
                peer = {**self.peer, "pid": 999999, "pidBirth": birth}
                with self.assertRaisesRegex(
                    mailbox.MailboxError, "progress-session.*could not verify process ancestry"
                ):
                    progress.report(self.base, peer, goal="Overwrite owner", task="Other", stage="complete")
            self.assertEqual(progress.read(self.base, self.peer)["stage"], "working")

    def test_linux_descendants_work_without_ps(self):
        # Two hops, with a comm containing spaces and parentheses, exercises the /proc walk.
        with (
            patch.object(progress.sys, "platform", "linux"),
            patch.object(progress.os, "getpid", return_value=100),
            patch.object(progress.os, "getppid", return_value=200),
            patch.object(Path, "read_text", side_effect=["200 (a tricky) name) S 300", "300 (shell) S 400"]),
            patch.object(progress.subprocess, "run", side_effect=FileNotFoundError("ps unavailable")),
        ):
            self.assertEqual(progress.caller_descends_from(400), True)

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
        for harness in ("claude", "codex", "gemini", "opencode"):
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

    def test_turn_hook_ignores_a_progress_refusal(self):
        with (
            patch.object(mailbox, "harness_pid", return_value=os.getpid()),
            patch.object(mailbox_daemon, "get_mode", return_value="stdio"),
            patch.object(
                progress, "reminder", side_effect=mailbox.MailboxError("session is not owned by this process")
            ),
        ):
            result = mailbox.hook(
                {"session_id": self.peer["session"], "cwd": str(self.cwd)},
                harness="codex",
                event="UserPromptSubmit",
                base=self.base,
            )
        self.assertNotIn("not owned by this process", str(result))
        self.assertEqual(mailbox.load(mailbox.peer_path(self.base, self.peer["session"]))["state"], "busy")

    def test_workforce_roles_normalize_aliases_persist_across_updates_and_clear(self):
        reported = progress.report(
            self.base,
            self.peer,
            goal="Ship swarm cards",
            task="Explore statusline",
            stage="planning",
            role="investigator",
        )
        self.assertEqual(reported["role"], "scout")
        self.assertEqual(progress.read(self.base, self.peer)["role"], "scout")

        updated = progress.report(self.base, self.peer, goal=None, task=None, stage="working")
        self.assertEqual(updated["role"], "scout")

        switched = progress.report(self.base, self.peer, goal=None, task=None, stage="working", role="implementer")
        self.assertEqual(switched["role"], "builder")

        cleared = progress.report(self.base, self.peer, goal=None, task=None, stage="testing", role="none")
        self.assertNotIn("role", cleared)
        self.assertIsNone(progress.read(self.base, self.peer).get("role"))


if __name__ == "__main__":
    unittest.main()
