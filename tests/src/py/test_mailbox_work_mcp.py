"""Exercise workboard contracts through real HTTP and the public CLI parser."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_mailbox_daemon

sys.path.insert(0, str(test_mailbox_daemon.SCRIPTS))
import mailbox_mcp as mcp  # noqa: E402 -- import the deployed entry point
import peer_mailbox as mailbox  # noqa: E402 -- fixture setup and CLI entry point


class WorkInterfaceTests(unittest.TestCase):
    def http_client(self):
        client = test_mailbox_daemon.TestMailboxDaemon()
        client.setUp()
        self.addCleanup(client.tearDown)
        client.start()
        client.peer("integrator")
        client.peer("worker", "claude")
        client.peer("outsider", cwd=client.other)
        return client

    def create_fields(self, key="export"):
        return {
            "action": "create",
            "key": key,
            "title": "Repair export",
            "scope": "Export serializer",
            "acceptance": "Empty exports retain their headers",
        }

    def assert_tool_error(self, response, expected):
        status, value, _ = response
        self.assertEqual(status, 200, value)
        self.assertTrue(value["result"]["isError"], value)
        self.assertIn(expected, value["result"]["content"][0]["text"])

    def test_http_cross_session_workflow_checks_revision_project_and_acceptance(self):
        client = self.http_client()
        created = client.body(client.call("work", self.create_fields(), session="integrator"))
        item = created["item"]
        identifier = item["id"]
        self.assertEqual((item["state"], item["integrator"]["session"]), ("open", "integrator"))
        replay = client.body(client.call("work", self.create_fields(), session="integrator"))
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["item"]["id"], identifier)
        self.assertEqual(client.body(client.call("board", session="outsider"))["items"], [])
        self.assert_tool_error(client.call("board", {"item": identifier}, session="outsider"), "not found")
        self.assert_tool_error(
            client.call("work", {"action": "claim", "item": identifier, "revision": 1}, session="outsider"),
            "not found",
        )
        claimed = client.body(
            client.call("work", {"action": "claim", "item": identifier, "revision": 1}, session="worker")
        )["item"]
        self.assertEqual((claimed["owner"]["session"], claimed["state"]), ("worker", "claimed"))
        self.assert_tool_error(
            client.call(
                "work",
                {"action": "checkpoint", "item": identifier, "revision": 1, "next": "Stale update"},
                session="worker",
            ),
            "revision conflict",
        )
        checkpoint = client.body(
            client.call(
                "work",
                {
                    "action": "checkpoint",
                    "item": identifier,
                    "revision": claimed["revision"],
                    "next": "Verify empty export",
                },
                session="worker",
            )
        )["item"]
        self.assertEqual(checkpoint["next"], "Verify empty export")
        review = client.body(
            client.call(
                "work",
                {
                    "action": "submit",
                    "item": identifier,
                    "revision": checkpoint["revision"],
                    "evidence": "Serializer patch and fixture",
                    "verification": "Focused export tests pass",
                },
                session="worker",
            )
        )["item"]
        self.assertEqual(review["state"], "review")
        self.assert_tool_error(
            client.call(
                "work", {"action": "accept", "item": identifier, "revision": review["revision"]}, session="worker"
            ),
            "integrator",
        )
        accepted = client.body(
            client.call(
                "work",
                {"action": "accept", "item": identifier, "revision": review["revision"], "note": "Verified headers"},
                session="integrator",
            )
        )["item"]
        self.assertEqual(accepted["state"], "accepted")
        current = client.body(client.call("board", {"item": identifier}, session="worker"))
        self.assertEqual(current["items"], [accepted])
        self.assertFalse(current["has_more"])
        self.assertIsNone(current["next_offset"])
        self.assertEqual(mailbox.incoming(client.base, "worker"), [])
        self.assertEqual(mailbox.incoming(client.base, "integrator"), [])

    def test_http_catalog_schema_validation_and_paging(self):
        client = self.http_client()
        catalog = {tool["name"]: tool for tool in client.rpc("tools/list")[1]["result"]["tools"]}
        board, work = catalog["board"], catalog["work"]
        self.assertTrue(board["annotations"]["readOnlyHint"])
        self.assertFalse(work["annotations"]["readOnlyHint"])
        self.assertFalse(work["annotations"]["openWorldHint"])
        self.assertEqual(board["inputSchema"]["properties"]["limit"]["default"], 10)
        for field in (
            "key",
            "scope",
            "acceptance",
            "next",
            "blocker",
            "evidence",
            "verification",
            "note",
            "integrator",
            "successor",
        ):
            self.assertTrue(work["inputSchema"]["properties"][field]["description"], field)
        self.assertIn("revision", work["outputSchema"]["properties"]["item"]["properties"])
        for name, arguments, error in (
            ("board", {"limit": 51}, "allowed range"),
            ("board", {"offset": -1}, "allowed range"),
            ("board", {"scope": "cross-project"}, "unknown argument"),
            ("work", {}, "missing argument"),
            ("work", {"action": "dispatch"}, "must be one of"),
            ("work", {"action": "claim", "revision": True}, "integer"),
            ("work", {**self.create_fields(), "title": "x" * 121}, "length"),
            ("work", {**self.create_fields(), "dependencies": ["x"] * 17}, "number of entries"),
            ("work", {"action": "checkpoint", "next": "x" * 241}, "length"),
        ):
            with self.subTest(name=name, arguments=arguments):
                self.assert_tool_error(client.call(name, arguments, session="integrator"), error)
        ids = {
            client.body(client.call("work", self.create_fields(key), session="integrator"))["item"]["id"]
            for key in ("export", "import")
        }
        first = client.body(client.call("board", {"limit": 1}, session="worker"))
        second = client.body(client.call("board", {"limit": 1, "offset": first["next_offset"]}, session="worker"))
        self.assertEqual({first["items"][0]["id"], second["items"][0]["id"]}, ids)
        self.assertTrue(first["has_more"])
        self.assertFalse(second["has_more"])
        self.assertLess(len(mailbox.render_work(first)), 1200)

    def test_cli_create_claim_checkpoint_and_board(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(mailbox, "root", return_value=Path(temporary)):

            def cli(*args):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    status = mailbox.main([*args, "--session", "cli-author", "--harness", "codex", "--format", "json"])
                self.assertEqual(status, 0, output.getvalue())
                return json.loads(output.getvalue())

            item = cli(
                "work",
                "create",
                "--key",
                "export",
                "--title",
                "Repair export",
                "--scope",
                "Serializer",
                "--acceptance",
                "Headers retained",
            )["item"]
            claimed = cli("work", "claim", "--item", item["id"], "--revision", str(item["revision"]))["item"]
            checkpoint = cli(
                "work",
                "checkpoint",
                "--item",
                item["id"],
                "--revision",
                str(claimed["revision"]),
                "--next",
                "Review fixture",
            )["item"]
            self.assertEqual(checkpoint["next"], "Review fixture")
            self.assertEqual(cli("board", "--item", item["id"])["items"], [checkpoint])

    def test_http_board_projects_live_backend_and_legacy_without_duplicate_focus_cards(self):
        import coordinator
        import mailbox_work_sources

        client = self.http_client()
        client.body(client.call("focus", {"text": "Export owner"}, session="integrator"))
        self.assertEqual(client.body(client.call("board", session="integrator"))["items"], [])
        client.body(
            client.call(
                "focus",
                {"text": "Old export task", "next": "Inspect saved patch", "refs": "branch fix/export"},
                session="worker",
            )
        )
        directory = (Path(client.temp.name) / "managed task").resolve()
        directory.mkdir()
        state = {
            "schema": coordinator.SCHEMA,
            "task_id": "managed-export",
            "repository": str(client.project),
            "status": "active",
            "created_at": mailbox.stamp(),
            "task_spec": {"objective": "Verify export"},
            "runs": [],
            "decisions": [],
        }
        mailbox.write(directory / "task.json", state)
        mailbox_work_sources.register_coordinator(client.base, directory, state)
        response = client.call("board", session="integrator")
        rows = client.body(response)["items"]
        self.assertEqual({row["source"] for row in rows}, {"coordinator", "legacy-note"})
        managed = next(row for row in rows if row["source"] == "coordinator")
        legacy = next(row for row in rows if row["source"] == "legacy-note")
        self.assertEqual((legacy["next"], legacy["evidence"]), ("Inspect saved patch", "branch fix/export"))
        self.assertEqual(Path(legacy["checkout"]), client.project.resolve())
        for row in rows:
            self.assertTrue(row["readOnly"])
            self.assertFalse(row["ready"])
            self.assertNotIn("revision", row)
            self.assertLessEqual(set(row), set(mcp.WORK_SOURCE_OUTPUT["properties"]))
            self.assertLessEqual(set(mcp.WORK_SOURCE_OUTPUT["required"]), set(row))
        self.assertEqual(managed["route"]["command"][-2:], ["--task-dir", str(directory)])
        self.assertIn("Source: coordinator (read-only)", response[1]["result"]["content"][0]["text"])
        self.assertIn("managed by the coordinator", response[1]["result"]["content"][0]["text"])
        self.assertNotIn("Owner: unclaimed", response[1]["result"]["content"][0]["text"])
        self.assertIn("'" + str(directory) + "'", response[1]["result"]["content"][0]["text"])
        state["status"] = "conductor_takeover"
        mailbox.write(directory / "task.json", state)
        fresh = client.body(client.call("board", {"item": managed["id"]}, session="worker"))["items"][0]
        self.assertEqual(fresh["state"], "conductor_takeover")
        self.assert_tool_error(
            client.call("work", {"action": "accept", "item": managed["id"], "revision": 1}, session="integrator"),
            "read-only",
        )
        self.assertEqual(mailbox.load(directory / "task.json")["status"], "conductor_takeover")
        self.assertEqual(client.body(client.call("board", session="outsider"))["items"], [])

    def test_installer_uses_the_live_tool_catalog(self):
        import install_mailbox

        self.assertEqual(set(install_mailbox.TOOLS), mcp.TOOL_NAMES)
        self.assertTrue({"board", "work"} <= set(install_mailbox.TOOLS))


if __name__ == "__main__":
    unittest.main()
