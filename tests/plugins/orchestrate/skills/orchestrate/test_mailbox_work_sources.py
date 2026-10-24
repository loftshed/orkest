"""One discovery surface reads existing execution records without a second writable ledger."""

from __future__ import annotations

import contextlib
import io
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
import coordinator  # noqa: E402
import mailbox_work_sources as sources  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402


class WorkSourceTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name).resolve()
        self.base = self.folder / "cache" / "mailbox-v1"
        self.project = self.folder / "project"
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        self.directory = self.folder / "task"
        self.state = {
            "schema": sources.TASK_SCHEMA,
            "task_id": "managed-task",
            "repository": str(self.project),
            "status": "active",
            "created_at": "2026-10-01T00:00:00Z",
            "task_spec": {"objective": "Verify export storage"},
        }
        self.reader = mailbox.register(
            self.base, session="reader", harness="codex", cwd=str(self.project), pid=os.getpid()
        )
        environment = patch.dict(os.environ, {"AGENT_EXECUTOR_HOME": str(self.base.parent)})
        environment.start()
        self.addCleanup(environment.stop)

    def save(self):
        coordinator.save(self.directory, self.state)

    def test_saved_task_is_indexed_and_backend_is_the_only_source_of_state(self):
        self.save()
        index_path = self.base / "work" / "coordinator-index.json"
        before = index_path.read_bytes()
        (row,) = sources.records(self.base, self.reader)
        self.assertEqual((row["source"], row["state"], row["readOnly"]), ("coordinator", "active", True))
        self.assertNotIn("revision", row)
        self.assertEqual(row["route"]["command"][-3:], ["next", "--task-dir", str(self.directory)])
        self.state["status"] = "accepted"
        mailbox.write(self.directory / "task.json", self.state)
        (changed,) = sources.records(self.base, self.reader)
        self.assertEqual(changed["state"], "accepted")
        self.assertEqual(index_path.read_bytes(), before)
        self.assertNotIn("status", json.loads(before)["sources"]["managed-task"])

    def test_loading_historical_task_indexes_without_rewriting_it(self):
        mailbox.write(self.directory / "task.json", self.state)
        before = (self.directory / "task.json").read_bytes()
        self.assertEqual(sources.records(self.base, self.reader), [])
        coordinator.load(self.directory)
        self.assertEqual(sources.records(self.base, self.reader)[0]["id"], "coordinator-managed-task")
        self.assertEqual((self.directory / "task.json").read_bytes(), before)

    def test_registry_failure_never_rolls_back_or_hides_saved_task(self):
        adapter = coordinator.module("mailbox_work_sources")
        stderr = io.StringIO()
        with (
            patch.object(adapter, "register_coordinator", side_effect=ValueError("index full")),
            contextlib.redirect_stderr(stderr),
        ):
            self.save()
        self.assertEqual(mailbox.load(self.directory / "task.json")["status"], "active")
        self.assertIn("task is saved; board discovery registration failed: index full", stderr.getvalue())
        # Retrying a read repairs discovery without creating another task or dispatch.
        coordinator.load(self.directory)
        self.assertEqual(len(sources.records(self.base, self.reader)), 1)

    def test_changed_or_missing_task_is_visible_as_unavailable_not_another_tasks_state(self):
        self.save()
        for changed in (
            {**self.state, "task_id": "different"},
            {**self.state, "repository": str(self.folder / "other")},
        ):
            with self.subTest(changed=changed):
                mailbox.write(self.directory / "task.json", changed)
                (row,) = sources.records(self.base, self.reader)
                self.assertEqual((row["state"], row["recoveryNeeded"]), ("unavailable", "source_unavailable"))
                self.assertNotIn("Verify export storage", row["title"])
                self.assertEqual(row["route"]["command"], [])
                self.assertIn("Reconcile", row["next"])
        (self.directory / "task.json").unlink()
        self.assertEqual(sources.records(self.base, self.reader)[0]["state"], "unavailable")

    def test_project_filter_runs_before_source_files_are_opened(self):
        self.save()
        outsider = {**self.reader, "repo": "/elsewhere", "remotes": []}
        with patch.object(sources, "_coordinator", side_effect=AssertionError("must not read foreign source")):
            self.assertEqual(sources.records(self.base, outsider), [])

    def test_index_is_idempotent_bounded_and_rejects_identity_replacement(self):
        self.save()
        with self.assertRaisesRegex(mailbox.MailboxError, "another location"):
            sources.register_coordinator(self.base, self.folder / "replacement", self.state)
        with patch.object(sources, "MAX_SOURCES", 1):
            with self.assertRaisesRegex(mailbox.MailboxError, "full"):
                sources.register_coordinator(self.base, self.folder / "new", {**self.state, "task_id": "new"})
        (row,) = sources.records(self.base, self.reader)
        self.assertEqual(row["id"], "coordinator-managed-task")

    def test_oversized_legacy_note_does_not_hide_later_board_items(self):
        import mailbox_tasks
        import mailbox_work

        peer = {**self.reader, "focus": "😀" * 200}
        mailbox_tasks.save(self.base, peer, done="😀" * 160, next="😀" * 240, blocker="😀" * 160, refs="😀" * 240)
        self.save()
        page = mailbox_work.listing(self.base, self.reader)
        self.assertEqual({row["source"] for row in page["items"]}, {"legacy-note", "coordinator"})
        legacy = next(row for row in page["items"] if row["source"] == "legacy-note")
        self.assertIn("Oversized legacy summary", legacy["next"])
        self.assertLessEqual(len(json.dumps(page, ensure_ascii=True).encode()), 12 * 1024)
        original = json.loads(subprocess.check_output(legacy["route"]["command"], text=True))
        self.assertEqual(original["next"], "😀" * 240)


if __name__ == "__main__":
    unittest.main()
