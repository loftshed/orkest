"""Interactive work survives sessions while ownership and acceptance remain revision checked."""

from __future__ import annotations

import json
import multiprocessing
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import mailbox_work as work  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402


def competing_claim(base, peer, item, barrier, results):
    barrier.wait(timeout=10)
    try:
        claimed = work.mutate(Path(base), peer, action="claim", item=item, revision=1)
        results.put(("claimed", claimed["item"]["owner"]["session"]))
    except mailbox.MailboxError as error:
        results.put(("conflict", str(error)))


class WorkTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.lead = self.peer("integrator")
        self.worker = self.peer("worker")
        self.other = self.peer("other")

    def peer(self, session, repo="/example/project", remotes=None):
        peer = mailbox.register(self.base, session=session, harness="codex", cwd=str(SCRIPTS), pid=os.getpid())
        peer.update(repo=repo, remotes=["project-remote"] if remotes is None else remotes)
        mailbox.write(mailbox.peer_path(self.base, session), peer)
        return peer

    def create(self, **kwargs):
        return work.mutate(
            self.base,
            self.lead,
            action="create",
            **{
                "key": "repair",
                "title": "Repair export",
                "scope": "Export serializer",
                "acceptance": "Empty exports remain valid",
                **kwargs,
            },
        )["item"]

    def change(self, item, actor, action, **kwargs):
        return work.mutate(self.base, actor, action=action, item=item["id"], revision=item["revision"], **kwargs)[
            "item"
        ]

    def read(self, item, actor=None):
        return work.listing(self.base, actor or self.lead, item=item["id"])["items"][0]

    def submit(self, item, actor=None):
        return self.change(
            item, actor or self.worker, "submit", evidence="commit abc123", verification="6 focused tests pass"
        )

    def test_only_one_simultaneous_claim_wins(self):
        item = self.create()
        context = multiprocessing.get_context("spawn")
        barrier, results = context.Barrier(2), context.Queue()
        processes = [
            context.Process(target=competing_claim, args=(str(self.base), peer, item["id"], barrier, results))
            for peer in (self.worker, self.other)
        ]
        try:
            for process in processes:
                process.start()
            received = [results.get(timeout=15), results.get(timeout=15)]
            for process in processes:
                process.join(timeout=10)
                self.assertEqual(process.exitcode, 0)
            self.assertEqual(sorted(r[0] for r in received), ["claimed", "conflict"])
            winner = next(r[1] for r in received if r[0] == "claimed")
            saved = self.read(item)
            self.assertEqual([saved["state"], saved["revision"], saved["owner"]["session"]], ["claimed", 2, winner])
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=5)
            results.close()

    def test_creation_retry_returns_same_current_item_after_integrator_disappears(self):
        item = self.create(integrator="other")
        claimed = self.change(item, self.worker, "claim")
        mailbox.unregister(self.base, "other")
        replay = work.mutate(
            self.base,
            self.lead,
            action="create",
            key="repair",
            title="Repair export",
            scope="Export serializer",
            acceptance="Empty exports remain valid",
            integrator="other",
        )
        self.assertEqual(
            [replay["replayed"], replay["item"]["id"], replay["item"]["revision"]],
            [True, item["id"], claimed["revision"]],
        )
        with self.assertRaisesRegex(mailbox.MailboxError, "different fields"):
            self.create(integrator="other", title="Another change")
        self.assertEqual(len(work.listing(self.base, self.lead)["items"]), 1)

    def test_dependencies_unlock_only_after_integrator_accepts_submitted_revision(self):
        prerequisite = self.create()
        dependent = self.create(key="followup", title="Use repaired export", dependencies=[prerequisite["id"]])
        self.assertEqual([dependent["ready"], dependent["unmetDependencies"]], [False, [prerequisite["id"]]])
        with self.assertRaisesRegex(mailbox.MailboxError, "dependencies"):
            self.change(dependent, self.other, "claim")
        claimed = self.change(prerequisite, self.worker, "claim")
        review = self.submit(claimed)
        with self.assertRaisesRegex(mailbox.MailboxError, "dependencies"):
            self.change(dependent, self.other, "claim")
        with self.assertRaisesRegex(mailbox.MailboxError, "integrator"):
            self.change(review, self.other, "accept")
        with self.assertRaisesRegex(mailbox.MailboxError, "revision conflict"):
            self.change(claimed, self.lead, "accept")
        accepted = self.change(review, self.lead, "accept")
        self.assertEqual([accepted["state"], self.read(dependent)["ready"]], ["accepted", True])
        self.assertEqual(self.change(dependent, self.other, "claim")["owner"]["session"], "other")
        with self.assertRaisesRegex(mailbox.MailboxError, "terminal"):
            self.change(accepted, self.worker, "release")

    def test_review_freezes_evidence_and_changes_need_resubmission(self):
        item = self.change(self.create(), self.worker, "claim")
        for details in ({}, {"evidence": "commit abc123"}, {"evidence": "", "verification": "Tests pass"}):
            with self.subTest(details=details), self.assertRaises(mailbox.MailboxError):
                self.change(item, self.worker, "submit", **details)
        review = self.submit(item)
        with self.assertRaisesRegex(mailbox.MailboxError, "freezes review"):
            self.change(review, self.worker, "checkpoint", evidence="another commit")
        changed = self.change(review, self.lead, "request_changes", note="Add an empty-file case")
        self.assertEqual(
            [changed["state"], changed["owner"]["session"], changed["note"]],
            ["claimed", "worker", "Add an empty-file case"],
        )
        with self.assertRaisesRegex(mailbox.MailboxError, "review"):
            self.change(changed, self.lead, "accept")
        accepted = self.change(self.submit(changed), self.lead, "accept")
        self.assertEqual([accepted["state"], accepted["evidence"]], ["accepted", "commit abc123"])

    def test_blocked_owner_retains_claim_until_explicit_release(self):
        item = self.change(self.create(), self.worker, "claim")
        blocked = self.change(item, self.worker, "checkpoint", blocker="Waiting on fixture", next_step="Re-run case")
        self.assertEqual([blocked["state"], blocked["owner"]["session"]], ["blocked", "worker"])
        with self.assertRaisesRegex(mailbox.MailboxError, "claimed"):
            self.change(blocked, self.other, "claim")
        resumed = self.change(blocked, self.worker, "checkpoint", blocker="")
        released = self.change(resumed, self.worker, "release", note="Handing off fixture work")
        self.assertEqual([released["state"], released["owner"], released["next"]], ["open", None, "Re-run case"])
        self.assertEqual(self.change(released, self.other, "claim")["owner"]["session"], "other")

    def test_absence_never_reassigns_and_recovery_fences_old_owner(self):
        item = self.change(self.create(), self.worker, "claim")
        item = self.change(item, self.worker, "checkpoint", next_step="Review saved diff", evidence="commit abc123")
        with self.assertRaisesRegex(mailbox.MailboxError, "absent owner"):
            self.change(item, self.lead, "recover", note="Inspected checkout and child processes")
        mailbox.unregister(self.base, "worker")
        absent = self.read(item)
        self.assertEqual(
            [absent["state"], absent["owner"]["session"], absent["recoveryNeeded"]],
            ["claimed", "worker", "owner_absent"],
        )
        with self.assertRaisesRegex(mailbox.MailboxError, "integrator"):
            self.change(absent, self.other, "recover", note="Inspected checkout")
        with self.assertRaisesRegex(mailbox.MailboxError, "note"):
            self.change(absent, self.lead, "recover")
        recovered = self.change(absent, self.lead, "recover", note="No children or leases; inspected saved diff")
        self.assertEqual(
            [
                recovered["state"],
                recovered["owner"],
                recovered["next"],
                recovered["recovery"]["previousOwner"]["session"],
            ],
            ["open", None, "Review saved diff", "worker"],
        )
        with self.assertRaisesRegex(mailbox.MailboxError, "revision conflict"):
            self.submit(item)
        replacement = self.change(recovered, self.other, "claim")
        with self.assertRaisesRegex(mailbox.MailboxError, "owner"):
            self.change(replacement, self.worker, "checkpoint", next_step="Old writer returned")
        self.assertEqual(self.read(item)["owner"]["session"], "other")

    def test_integrator_handoff_survives_departure_and_fences_predecessor(self):
        item = self.change(self.create(), self.worker, "claim")
        offered = self.change(item, self.lead, "offer_transfer", successor="other", note="Review the saved diff")
        self.assertEqual(offered["integrator"]["session"], "integrator")
        mailbox.unregister(self.base, "integrator")
        self.assertEqual(self.read(item, self.worker)["recoveryNeeded"], "integrator_absent")
        with self.assertRaisesRegex(mailbox.MailboxError, "no integrator handoff"):
            self.change(offered, self.worker, "accept_transfer")
        successor = self.change(offered, self.other, "accept_transfer")
        self.assertEqual(
            [successor["integrator"]["session"], successor["transfer"], successor["recoveryNeeded"]],
            ["other", None, None],
        )
        review = self.submit(successor)
        with self.assertRaisesRegex(mailbox.MailboxError, "integrator"):
            self.change(review, self.lead, "accept")
        self.assertEqual(self.change(review, self.other, "accept")["state"], "accepted")

    def test_dead_integrator_is_explicit_and_never_silently_reassigned(self):
        item = self.create()
        mailbox.unregister(self.base, "integrator")
        current = self.read(item, self.worker)
        self.assertEqual(
            [current["integratorPresent"], current["recoveryNeeded"], current["ready"]],
            [False, "integrator_absent", False],
        )
        with self.assertRaisesRegex(mailbox.MailboxError, "integrator is absent"):
            self.change(current, self.worker, "claim")
        with self.assertRaisesRegex(mailbox.MailboxError, "integrator"):
            self.change(current, self.other, "offer_transfer", successor="worker")

    def test_clones_share_items_without_exposing_other_project_work(self):
        item = self.create()
        clone = self.peer("clone", repo="/example/clone", remotes=["extra-remote", "project-remote"])
        outsider = self.peer("outsider", repo="/example/unrelated", remotes=["another-remote"])
        found = work.listing(self.base, clone)["items"]
        self.assertEqual([i["title"] for i in found], ["Repair export"])
        self.assertNotIn("project", found[0])
        self.assertNotIn("fingerprint", found[0])
        self.assertEqual(work.listing(self.base, outsider)["items"], [])
        for action in ("claim", "accept"):
            with self.assertRaisesRegex(mailbox.MailboxError, "not found in this project"):
                self.change(item, outsider, action)
        with self.assertRaisesRegex(mailbox.MailboxError, "not found in this project"):
            work.mutate(
                self.base,
                outsider,
                action="create",
                key="x",
                title="Other work",
                scope="Other",
                acceptance="Other case",
                dependencies=[item["id"]],
            )
        with self.assertRaises(mailbox.MailboxError):
            self.create(key="bad-role", integrator="outsider")
        self.assertEqual(self.change(item, clone, "claim")["owner"]["session"], "clone")

    def test_dependencies_cannot_reference_missing_items_or_be_rewritten(self):
        with self.assertRaisesRegex(mailbox.MailboxError, "not found"):
            self.create(dependencies=["does-not-exist"])
        item = self.create()
        with self.assertRaisesRegex(mailbox.MailboxError, "immutable"):
            self.change(item, self.worker, "claim", dependencies=[])
        self.assertEqual([self.read(item)["dependencies"], self.read(item)["revision"]], [[], 1])

    def test_failed_mutation_preserves_bytes_and_capacity_does_not_prune(self):
        item = self.create()
        path = self.base / "work" / "board.json"
        before = path.read_bytes()
        with self.assertRaisesRegex(mailbox.MailboxError, "revision conflict"):
            work.mutate(self.base, self.worker, action="claim", item=item["id"], revision=0)
        self.assertEqual(path.read_bytes(), before)
        with patch.object(work, "MAX_ITEMS", 1), self.assertRaisesRegex(mailbox.MailboxError, "capacity"):
            self.create(key="full")
        self.assertEqual([i["title"] for i in work.listing(self.base, self.lead)["items"]], ["Repair export"])
        self.assertEqual(path.read_bytes(), before)
        with patch.object(work, "PAGE_BYTES", 100), self.assertRaisesRegex(mailbox.MailboxError, "capacity"):
            self.change(item, self.worker, "claim")
        self.assertEqual(path.read_bytes(), before)

    def test_bounded_unicode_pages_preserve_all_items(self):
        for number in range(8):
            self.create(key=f"item-{number}", title="界" * 120, scope="界" * 240, acceptance="界" * 240)
        seen, offset = [], 0
        while True:
            page = work.listing(self.base, self.lead, limit=50, offset=offset)
            self.assertLessEqual(len(json.dumps(page, ensure_ascii=True).encode()), 12 * 1024)
            seen.extend(item["id"] for item in page["items"])
            if not page["has_more"]:
                break
            self.assertGreater(page["next_offset"], offset)
            offset = page["next_offset"]
        self.assertEqual(len(set(seen)), 8)
        self.assertEqual(len(seen), 8)

    def test_bad_storage_does_not_become_an_empty_board(self):
        item = self.create()
        path = self.base / "work" / "board.json"
        path.write_text('{"schema":')
        with self.assertRaisesRegex(mailbox.MailboxError, "unreadable"):
            self.change(item, self.worker, "claim")
        self.assertEqual(path.read_text(), '{"schema":')

    def test_creation_keys_follow_project_scope_when_a_session_changes_projects(self):
        original = self.create()
        changed = self.peer("integrator", repo="/example/other", remotes=["different-remote"])
        another = work.mutate(
            self.base,
            changed,
            action="create",
            key="repair",
            title="Other export",
            scope="Other serializer",
            acceptance="Other case",
        )["item"]
        self.assertEqual([i["title"] for i in work.listing(self.base, changed)["items"]], ["Other export"])
        self.assertNotEqual(original["id"], another["id"])
        self.assertEqual([i["title"] for i in work.listing(self.base, self.worker)["items"]], ["Repair export"])

    def test_transfer_acceptance_requires_the_current_offer_revision(self):
        item = self.create()
        offered = self.change(item, self.lead, "offer_transfer", successor="worker")
        replaced = self.change(offered, self.lead, "offer_transfer", successor="other")
        with self.assertRaisesRegex(mailbox.MailboxError, "revision conflict"):
            self.change(offered, self.worker, "accept_transfer")
        with self.assertRaisesRegex(mailbox.MailboxError, "no integrator handoff"):
            self.change(replaced, self.worker, "accept_transfer")
        self.assertEqual(self.change(replaced, self.other, "accept_transfer")["integrator"]["session"], "other")

    def test_mutation_reserves_space_for_later_absence_and_store_growth_is_atomic(self):
        item = self.create()
        path = self.base / "work" / "board.json"
        current_size = len(json.dumps({"items": [item], "has_more": True, "next_offset": 1024}).encode())
        with patch.object(work, "PAGE_BYTES", current_size + 10):
            with self.assertRaisesRegex(mailbox.MailboxError, "response capacity"):
                self.create(key="edge")
        self.assertEqual([i["id"] for i in work.listing(self.base, self.lead)["items"]], [item["id"]])
        before = path.read_bytes()
        with patch.object(work, "STORE_BYTES", len(before) + 20):
            with self.assertRaisesRegex(mailbox.MailboxError, "capacity"):
                self.create(key="more")
        self.assertEqual(path.read_bytes(), before)

    def test_non_git_sessions_and_run_sessions_cannot_create_unreachable_work(self):
        for peer, reason in (
            (self.lead | {"repo": None, "remotes": []}, "Git project"),
            (self.lead | {"run": "example-run", "role": "worker"}, "conductor"),
        ):
            with self.subTest(reason=reason):
                if reason == "Git project":
                    with self.assertRaisesRegex(mailbox.MailboxError, reason):
                        work.listing(self.base, peer)
                with self.assertRaisesRegex(mailbox.MailboxError, reason):
                    work.mutate(
                        self.base, peer, action="create", key="x", title="Task", scope="Scope", acceptance="Done"
                    )
        self.assertEqual(self.create()["title"], "Repair export")

    def test_one_read_view_routes_sources_and_keeps_one_page_budget(self):
        item = self.create()
        external = [
            {
                "id": "coordinator-job",
                "title": "Managed export",
                "source": "coordinator",
                "readOnly": True,
                "updatedAt": "9999-01-01T00:00:00Z",
                "evidence": "界" * 600,
            },
            {
                "id": "legacy-card",
                "title": "Saved checkpoint",
                "source": "legacy_note",
                "readOnly": True,
                "updatedAt": "9998-01-01T00:00:00Z",
                "evidence": "界" * 600,
            },
        ]
        adapter = SimpleNamespace(
            records=lambda base, me, item=None: [r for r in external if item is None or r["id"] == item]
        )
        with patch.dict(sys.modules, {"mailbox_work_sources": adapter}):
            first = work.listing(self.base, self.lead, limit=1)
            second = work.listing(self.base, self.lead, limit=1, offset=first["next_offset"])
            third = work.listing(self.base, self.lead, limit=1, offset=second["next_offset"])
            self.assertEqual(
                [first["items"][0]["title"], second["items"][0]["title"], third["items"][0]["title"]],
                ["Managed export", "Saved checkpoint", "Repair export"],
            )
            self.assertEqual([third["items"][0]["source"], third["items"][0]["readOnly"]], ["interactive", False])
            self.assertFalse(third["has_more"])
            page = work.listing(self.base, self.lead, limit=50)
            self.assertLessEqual(len(json.dumps(page, ensure_ascii=True).encode()), 12 * 1024)
            self.assertEqual(
                work.listing(self.base, self.lead, item="coordinator-job")["items"][0]["title"], "Managed export"
            )
            with self.assertRaisesRegex(mailbox.MailboxError, "not found in this project"):
                work.listing(self.base, self.lead, item="coordinator-missing")
            worker = self.worker | {"run": "example-run", "role": "worker"}
            self.assertEqual(self.read(item, worker)["title"], "Repair export")

    def test_read_only_sources_cannot_gain_parallel_mutations_or_dependencies(self):
        for item in ("coordinator-job", "legacy-card"):
            with self.subTest(item=item):
                with self.assertRaisesRegex(mailbox.MailboxError, "source's route"):
                    work.mutate(self.base, self.lead, action="accept", item=item, revision=1)
                with self.assertRaisesRegex(mailbox.MailboxError, "cross-source dependencies"):
                    self.create(dependencies=[item])
        self.assertEqual(self.create()["source"], "interactive")

    def test_shares_active_work_and_help_board_hint_for_completed_long_idle_sessions(self):
        import datetime as dt

        import agent_progress

        item = self.change(self.create(), self.worker, "claim")
        self.assertTrue(work.shares_active_work(self.base, self.lead, self.worker))
        self.assertFalse(work.shares_active_work(self.base, self.lead, self.other))
        # While paired on active work, direct sends between integrator and owner are treated as same-task even with different focus.
        mailbox.set_focus(self.base, self.lead["session"], "Integrating export")
        mailbox.set_focus(self.base, self.worker["session"], "Implementing serializer")
        mailbox.set_focus(self.base, self.other["session"], "Unrelated docs cleanup")
        lead = mailbox.load(mailbox.peer_path(self.base, self.lead["session"]))
        worker = mailbox.load(mailbox.peer_path(self.base, self.worker["session"]))
        other = mailbox.load(mailbox.peer_path(self.base, self.other["session"]))
        self.assertFalse(mailbox.unrelated_task(self.base, lead, worker))
        self.assertTrue(mailbox.unrelated_task(self.base, lead, other))
        accepted = self.change(self.submit(item), self.lead, "accept")
        self.assertEqual(accepted["state"], "accepted")
        self.assertFalse(work.shares_active_work(self.base, self.lead, self.worker))

        # Open a ready help item on the board and verify help_board_hint only surfaces for completed + long-idle peers.
        help_item = self.create(key="help-item", title="Add focused serializer edge-case test")
        self.assertEqual(work.help_board_hint(self.base, other, previous=other), "")
        agent_progress.report(self.base, other, goal="Docs cleanup", task="Update README", stage="working")
        self.assertEqual(work.help_board_hint(self.base, other, previous=other), "")
        agent_progress.report(self.base, other, goal="Docs cleanup", task="Update README", stage="complete")
        # Just completed (< HELP_BOARD_IDLE_SECONDS): still quiet.
        self.assertEqual(work.help_board_hint(self.base, other, previous=other), "")

        long_ago = mailbox.now() - dt.timedelta(seconds=work.HELP_BOARD_IDLE_SECONDS + 60)
        with patch.object(mailbox, "now", return_value=long_ago):
            agent_progress.report(self.base, other, goal="Docs cleanup", task="Update README", stage="complete")
            idle_previous = {**other, "state": "idle", "lastSeenAt": mailbox.stamp()}
        hint = work.help_board_hint(self.base, other, previous=idle_previous)
        self.assertIn("Help board:", hint)
        self.assertIn(help_item["id"], hint)
        self.assertIn("Add focused serializer edge-case test", hint)


if __name__ == "__main__":
    unittest.main()
