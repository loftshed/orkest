"""Python displays distinguish worker reports from recorded conductor decisions.

Fixtures are retained by default: no teardown or exercised operation deletes files.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import agent_statusline as footer  # noqa: E402
import herdr_swarm_restore as views  # noqa: E402
import room_tasks  # noqa: E402


class StatusTruthTests(unittest.TestCase):
    def setUp(self):
        # Deliberately use mkdtemp without cleanup so fixtures remain available for inspection.
        self.root = Path(tempfile.mkdtemp(prefix="orkest-status-truth-"))

    def task_fixture(self, *, decision=None, status="finished", runner_status="completed"):
        directory = Path(tempfile.mkdtemp(prefix="task-", dir=self.root))
        task = {
            "schema": "agent-executor.task.v1",
            "task_id": "task-a",
            "repository": str(self.root),
            "task_spec": {"objective": "Verify reported work"},
            "runs": [
                {
                    "request_id": "request-a",
                    "run_id": "run-a",
                    "engine": "codex",
                    "transport": "native",
                    "status": status,
                    "runner_status": runner_status,
                }
            ],
            "decisions": [] if decision is None else [{"run_id": "run-a", "decision": decision}],
        }
        path = directory / "task.json"
        path.write_text(json.dumps(task))
        member = {
            "id": "worker-a",
            "engine": "codex",
            "status": "completed",
            "dispatch": {
                "taskDir": str(directory),
                "taskId": "task-a",
                "requestId": "request-a",
                "runId": "run-a",
                "transport": "native",
            },
        }
        room = {"id": "room-a", "cwd": str(self.root), "agents": [member]}
        return room, member, json.loads(path.read_text())

    def inventory_dimensions(self, room):
        directory = self.root / "mailbox-v1/rooms"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "room-a.json"
        path.write_text(json.dumps(room))
        api = mock.Mock()
        api.panes.return_value = []
        # Keep the unrelated Node/SQLite migration and sidecar lifecycle outside these tests.
        with mock.patch.object(views.room_store, "list_rooms", return_value=[json.loads(path.read_text())]):
            report = views.inventory(
                self.root,
                {"HERDR_SOCKET_PATH": str(self.root / "server.sock")},
                api,
                cli=SCRIPTS.parents[2] / "bin/ork.mjs",
            )
        self.assertEqual((report["status"], report["mode"]), ("ok", "read_only"))
        self.assertEqual(len(report["resources"]), 1)
        return report["resources"][0]["dimensions"]

    def test_recorded_decisions_reach_room_footer_and_inventory(self):
        for decision, state, execution, task_state in (
            (None, "review", "finished", "awaiting_verification"),
            ("accept", "accepted", "finished", "accepted"),
            ("supported", "supported", "finished", "supported"),
            ("reject", "rejected", "finished", "unaccepted"),
            ("takeover", "blocked", "blocked", "in_progress"),
        ):
            with self.subTest(decision=decision):
                room, member, task = self.task_fixture(decision=decision)
                projection = room_tasks.project(str(self.root), member, task)
                self.assertEqual(projection["status"], state)
                self.assertEqual(footer.room_task(room, member), {"title": "Verify reported work", "state": state})
                self.assertEqual(views._project_member_task(room, member), (execution, task_state))
                dimensions = self.inventory_dimensions(room)
                self.assertEqual((dimensions["executing_worker"], dimensions["accepted_task"]), (execution, task_state))

    def test_cancellation_survives_unsuccessful_runner_status(self):
        for runner_status in (None, "completed", "failed", "timed_out", "interrupted", "cancelled"):
            with self.subTest(runner_status=runner_status):
                room, member, task = self.task_fixture(status="cancelled", runner_status=runner_status)
                self.assertEqual(room_tasks.project(str(self.root), member, task)["status"], "cancelled")
                self.assertEqual(
                    footer.room_task(room, member), {"title": "Verify reported work", "state": "cancelled"}
                )

    def test_undecided_runs_keep_review_activity_and_failure_states(self):
        for status, runner_status, expected in (
            ("finished", None, "review"),
            ("finished", "failed", "failed"),
            ("finished", "timed_out", "failed"),
            ("reserved", None, "reserved"),
            ("active", None, "running"),
        ):
            with self.subTest(status=status, runner_status=runner_status):
                room, member, task = self.task_fixture(status=status, runner_status=runner_status)
                self.assertEqual(room_tasks.project(str(self.root), member, task)["status"], expected)
                self.assertEqual(footer.room_task(room, member), {"title": "Verify reported work", "state": expected})

    def test_inventory_fallback_distinguishes_reports_support_and_acceptance(self):
        for status, expected in (
            ("completed", "awaiting_verification"),
            ("complete", "awaiting_verification"),
            ("reported complete", "awaiting_verification"),
            ("stale", "awaiting_verification"),
            ("accepted", "accepted"),
            ("supported", "supported"),
        ):
            for field in ("status", "stage"):
                with self.subTest(status=status, field=field):
                    member = {"id": "worker-a", field: status}
                    room = {"id": "room-a", "cwd": str(self.root), "agents": [member]}
                    self.assertEqual(views._project_member_task(room, member), ("finished", expected))
                    dimensions = self.inventory_dimensions(room)
                    self.assertEqual(
                        (dimensions["executing_worker"], dimensions["accepted_task"]), ("finished", expected)
                    )

    def test_inventory_projects_untracked_and_answered_completion(self):
        for completion in ("untracked", "answered"):
            with self.subTest(completion=completion):
                member = {"id": "worker-a", "status": "reported complete", "completion": completion}
                room = {"id": "room-a", "cwd": str(self.root), "agents": [member]}
                self.assertEqual(views._project_member_task(room, member), ("finished", "untracked"))
        # Without provenance, or while still running, nothing changes.
        member = {"id": "worker-a", "status": "reported complete"}
        room = {"id": "room-a", "cwd": str(self.root), "agents": [member]}
        self.assertEqual(views._project_member_task(room, member), ("finished", "awaiting_verification"))
        member = {"id": "worker-a", "status": "running", "completion": "untracked"}
        self.assertEqual(views._project_member_task(room, member), ("executing", "in_progress"))

    def test_footer_renders_distinct_outcome_colors(self):
        for stage, color in (
            ("accepted", 114),
            ("supported", 80),
            ("stale", 176),
            ("failed", 203),
            ("rejected", 203),
            ("completed", 221),
            ("complete", 221),
            ("reported complete", 221),
            ("reported", 221),
        ):
            with self.subTest(stage=stage), mock.patch.dict("os.environ", {"NO_COLOR": "", "ORK_GLYPHS": "ascii"}):
                item = {
                    "name": "worker",
                    "model": "model",
                    "effort": "high",
                    "repo": "orkest",
                    "goal": "Verify work",
                    "task": "Review candidate",
                    "color": 31,
                    "stage": stage,
                }
                self.assertEqual(footer.field_colors(item)["stage"], color)
                self.assertIn(f"\033[38;5;{color};1m{stage}\033[0m", footer.ansi_line(item, 200, line=2))
                self.assertIn(f"#[fg=colour{color},bold]{stage}", footer.tmux_line(item, 200, line=2))


if __name__ == "__main__":
    unittest.main()
