"""Durable, deduplicated continuation requests and their route through the wake path."""

from __future__ import annotations

import datetime as dt
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS = Path(__file__).resolve().parents[3] / "src/py"
sys.path.insert(0, str(TESTS_DIR))
sys.path.insert(0, str(SCRIPTS))
import _ork_fast_test_helpers as fast  # noqa: E402
import continuation_requests as CR  # noqa: E402
import peer_mailbox  # noqa: E402
import room_store  # noqa: E402
import wake_recovery  # noqa: E402

NOTIFY = peer_mailbox.notify


class Recorder:
    def __init__(self):
        self.notices = []
        self.wakes = []

    def notify(self, base, peer, text, **extra):
        message = NOTIFY(base, peer, text, **extra)
        self.notices.append(message)
        return message

    def wake(self, base, peer, message_id, scope):
        self.wakes.append((peer["session"], message_id))
        return {"status": "scheduled", "phase": "submitted"}


class ContinuationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name) / "mailbox-v1"
        self.base.mkdir()
        self.repo = Path(self.temporary.name) / "repo"
        self.repo.mkdir()
        self.task_dir = Path(self.temporary.name) / "task"
        self.task_dir.mkdir()
        self.spec = {"objective": "Fix the cache", "acceptance_criteria": ["tests pass"]}
        self.write_task(runs=[])
        self.coordinator = peer_mailbox.register(
            self.base, session="coord-1", harness="claude", cwd=str(self.repo), pid=os.getpid(), state="idle"
        )
        self.room = {
            "schema": "agent-executor.room.v1",
            "id": "room-a",
            "cwd": str(self.repo),
            "machine": socket.gethostname(),
            "swarm": {"maxAgents": 8, "maxDepth": 3},
            "conductor": {
                "engine": "claude",
                "role": "lead",
                "session": {
                    "id": "coord-1",
                    "engine": "claude",
                    "machine": socket.gethostname(),
                    "cwd": str(self.repo),
                },
            },
            "agents": [
                {"id": "haiku-1", "engine": "claude", "model": "haiku", "parent": "conductor", "status": "queued"},
                {
                    "id": "luna-1",
                    "engine": "codex",
                    "model": "luna",
                    "parent": "conductor",
                    "status": "unknown",
                    "dispatch": {
                        "taskDir": str(self.task_dir),
                        "taskId": "task-a",
                        "requestId": "req-1",
                        "transport": "executor",
                    },
                },
            ],
            "messages": [],
            "createdAt": 1,
            "updatedAt": 1,
        }
        room_store.put_room(self.base, self.room)
        self.patch_env = mock.patch.dict(os.environ, {"ORKEST_CONTINUATION_HOSTS": "claude"})
        self.patch_env.start()
        self.addCleanup(self.patch_env.stop)

    def write_task(self, *, runs, decisions=(), status="active", spec=None, deadline=None):
        (self.task_dir / "task.json").write_text(
            json.dumps(
                {
                    "schema": "agent-executor.task.v1",
                    "task_id": "task-a",
                    "status": status,
                    "task_spec": spec or self.spec,
                    "deadline": deadline or (dt.datetime.now(dt.UTC) + dt.timedelta(hours=1)).isoformat(),
                    "runs": list(runs),
                    "decisions": list(decisions),
                    "budget": {"limit": 5, "used": 1, "reserved": {}},
                }
            )
        )

    def revision(self):
        return CR.input_revision(self.spec)

    def task_request(self, reason):
        return CR.request(
            self.base,
            room="room-a",
            member="luna-1",
            task_dir=str(self.task_dir),
            task_id="task-a",
            revision=self.revision(),
            reason=reason,
        )

    def set_room(self, **fields):
        room_store.set_metadata(self.base, "room-a", **fields)

    def test_stop_completion_and_reconciliation_share_one_request(self):
        first, created = self.task_request("stop")
        second, joined = self.task_request("worker_terminal")
        third, _ = self.task_request("reconcile")
        self.assertTrue(created)
        self.assertFalse(joined)
        self.assertEqual(first["key"], second["key"])
        self.assertEqual(third["reasons"], ["stop", "worker_terminal", "reconcile"])
        self.assertEqual(len(CR.load_all(self.base)), 1)

    def test_concurrent_requests_fold_into_one(self):
        threads = [threading.Thread(target=self.task_request, args=(reason,)) for reason in CR.REASONS * 3]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(CR.load_all(self.base)), 1)

    def test_two_hosts_cannot_both_reserve(self):
        entry, _ = self.task_request("stop")
        reserved = CR.reserve(self.base, entry["key"], "coord-1")
        self.assertEqual((reserved["status"], reserved["reserved_by"]), ("reserved", "coord-1"))
        self.assertEqual(CR.reserve(self.base, entry["key"], "coord-1")["status"], "reserved")
        with self.assertRaisesRegex(ValueError, "cannot be reserved again"):
            CR.reserve(self.base, entry["key"], "coord-2")

    def test_pause_or_archive_before_reservation_blocks_dispatch(self):
        entry, _ = self.task_request("stop")
        conductor = dict(self.room["conductor"], paused=True)
        self.set_room(conductor=conductor)
        paused = CR.reserve(self.base, entry["key"], "coord-1")
        self.assertEqual(paused["status"], "paused")
        self.assertIsNone(paused.get("reserved_by"))
        self.set_room(conductor=self.room["conductor"], lifecycle="archived")
        self.assertEqual(CR.reconcile(self.base), [])  # still paused: the room is archived
        self.set_room(lifecycle="cancelled")
        CR.reconcile(self.base)
        self.assertEqual(CR.load_all(self.base)[entry["key"]]["status"], "cancelled")

    def test_a_cleared_pause_requests_again_without_launching(self):
        entry, _ = self.task_request("stop")
        self.set_room(conductor=dict(self.room["conductor"], paused=True))
        CR.reconcile(self.base)
        self.assertEqual(CR.load_all(self.base)[entry["key"]]["status"], "paused")
        self.set_room(conductor=self.room["conductor"])
        CR.reconcile(self.base)
        self.assertEqual(CR.load_all(self.base)[entry["key"]]["status"], "requested")

    def test_stale_input_revision_cannot_be_reserved(self):
        entry, _ = self.task_request("stop")
        self.write_task(runs=[], spec={**self.spec, "objective": "A changed objective"})
        stale = CR.reserve(self.base, entry["key"], "coord-1")
        self.assertEqual(stale["status"], "superseded")
        newer, created = CR.request(
            self.base,
            room="room-a",
            member="luna-1",
            task_dir=str(self.task_dir),
            revision=CR.input_revision({**self.spec, "objective": "A changed objective"}),
            reason="stop",
        )
        self.assertTrue(created)
        self.assertNotEqual(newer["key"], entry["key"])

    def test_a_newer_revision_supersedes_an_unreserved_request(self):
        entry, _ = self.task_request("stop")
        CR.request(self.base, room="room-a", task_dir=str(self.task_dir), revision="other", reason="stop")
        self.assertEqual(CR.load_all(self.base)[entry["key"]]["status"], "superseded")

    def test_reconcile_follows_the_bound_run_through_attachment_running_and_acceptance(self):
        entry, _ = self.task_request("stop")
        CR.reserve(self.base, entry["key"], "coord-1")
        CR.bind(self.base, entry["key"], "coord-1", "req-2")
        with self.assertRaisesRegex(ValueError, "another dispatch"):
            CR.bind(self.base, entry["key"], "coord-1", "req-3")

        def state():
            return CR.load_all(self.base)[entry["key"]]["status"]

        CR.reconcile(self.base)
        self.assertEqual(state(), "reserved")  # crash before launch: no run yet, still within the TTL
        run = {"run_id": "r2", "request_id": "req-2", "status": "reserved", "transport": "native"}
        self.write_task(runs=[run])
        CR.reconcile(self.base)
        self.assertEqual(state(), "awaiting_attachment")  # launched, not yet attached
        self.write_task(runs=[{**run, "status": "active", "native_handle": "h-1"}])
        CR.reconcile(self.base)
        self.assertEqual(state(), "running")
        self.write_task(runs=[{**run, "status": "finished", "native_handle": "h-1"}])
        CR.reconcile(self.base)
        self.assertEqual(state(), "awaiting_acceptance")  # completed before acknowledgement
        self.write_task(
            runs=[{**run, "status": "finished", "native_handle": "h-1"}],
            decisions=[{"run_id": "r2", "decision": "accept"}],
        )
        CR.reconcile(self.base)
        self.assertEqual(state(), "completed")
        # A delivered-twice completion neither reopens the request nor adds another.
        self.task_request("worker_terminal")
        self.assertEqual(len(CR.load_all(self.base)), 1)
        self.assertEqual(state(), "completed")

    def test_an_uncertain_launch_is_recovery_work(self):
        entry, _ = self.task_request("stop")
        CR.reserve(self.base, entry["key"], "coord-1")
        CR.bind(self.base, entry["key"], "coord-1", "req-2")
        self.write_task(runs=[{"run_id": "r2", "request_id": "req-2", "status": "uncertain", "recovery": "unknown"}])
        CR.reconcile(self.base)
        stored = CR.load_all(self.base)[entry["key"]]
        self.assertEqual((stored["status"], stored["stop_reason"]), ("recovery_needed", "unknown"))
        with self.assertRaises(ValueError):
            CR.reserve(self.base, entry["key"], "coord-1")

    def test_a_reservation_without_any_run_needs_an_operator_after_its_ttl(self):
        entry, _ = self.task_request("stop")
        CR.reserve(self.base, entry["key"], "coord-1")
        later = peer_mailbox.now() + CR.RESERVATION_TTL + dt.timedelta(seconds=5)
        CR.reconcile(self.base, moment=later)
        self.assertEqual(CR.load_all(self.base)[entry["key"]]["status"], "recovery_needed")

    def test_delivery_uses_the_mailbox_wake_path_once_per_unread_hint(self):
        entry, _ = self.task_request("stop")
        recorder = Recorder()
        outcomes = CR.deliver_due(self.base, notify=recorder.notify, wake=recorder.wake)
        self.assertEqual([outcome["status"] for outcome in outcomes], ["delivered"])
        self.assertEqual(recorder.wakes, [("coord-1", recorder.notices[0]["id"])])
        self.assertIn(entry["key"], recorder.notices[0]["text"])
        self.assertEqual(recorder.notices[0]["continuation"], entry["key"])
        # The hint is still unread: no second notice; wake_recovery retries the wake itself.
        later = peer_mailbox.now() + dt.timedelta(hours=1)
        CR.deliver_due(self.base, moment=later, notify=recorder.notify, wake=recorder.wake)
        self.assertEqual(len(recorder.notices), 1)
        stored = CR.load_all(self.base)[entry["key"]]
        self.assertEqual((stored["deliveries"], stored["availability"]), (1, "enabled"))

    def test_read_hints_are_bounded_then_exhausted(self):
        entry, _ = self.task_request("stop")
        recorder = Recorder()
        moment = peer_mailbox.now()
        for _ in range(CR.MAX_DELIVERIES + 1):
            CR.deliver_due(self.base, moment=moment, notify=recorder.notify, wake=recorder.wake)
            peer_mailbox.take(self.base, "coord-1")
            moment += dt.timedelta(hours=1)
        stored = CR.load_all(self.base)[entry["key"]]
        self.assertEqual(len(recorder.notices), CR.MAX_DELIVERIES)
        self.assertEqual(stored["status"], "exhausted")
        self.assertTrue(stored["stop_reason"])

    def test_an_unqualified_host_gets_a_manual_resume_path_instead_of_automation(self):
        entry, _ = self.task_request("stop")
        recorder = Recorder()
        outcomes = CR.deliver_due(self.base, notify=recorder.notify, wake=recorder.wake, hosts=frozenset())
        self.assertEqual(outcomes[0]["availability"], "unavailable")
        self.assertEqual(recorder.notices, [])
        stored = CR.load_all(self.base)[entry["key"]]
        self.assertEqual(stored["status"], "requested")
        self.assertEqual(stored["manual_resume"], "ork rooms show --room room-a")

    def test_disabling_stops_new_requests_but_keeps_existing_ones(self):
        entry, _ = self.task_request("stop")
        with mock.patch.dict(os.environ, {"ORKEST_CONTINUATION": "0"}):
            self.assertEqual(
                CR.request(self.base, room="room-a", revision="different", reason="stop"),
                (None, False),
            )
            joined, created = self.task_request("worker_terminal")
        self.assertFalse(created)
        self.assertEqual(joined["key"], entry["key"])
        self.assertEqual(len(CR.load_all(self.base)), 1)

    def test_worker_terminal_requests_only_for_active_room_tasks(self):
        state = {"task_id": "task-a", "task_spec": self.spec}
        created = CR.request_for_terminal(self.base, self.task_dir, state, {"generation": None})
        self.assertEqual((created["room"], created["member"]), ("room-a", "luna-1"))
        self.assertEqual(created["reasons"], ["worker_terminal"])
        self.assertIsNone(CR.request_for_terminal(self.base, Path("/elsewhere"), state, {}))
        self.set_room(lifecycle="archived")
        CR.cancel(self.base, created["key"], "test reset")
        other = {**state, "task_spec": {"objective": "other"}}
        self.assertIsNone(CR.request_for_terminal(self.base, self.task_dir, other, {}))

    def test_stop_with_queued_work_reaches_one_reservation_through_the_real_hook_path(self):
        # Before: a Stop with queued room work and no incoming mail produced no continuation at all.
        self.write_task(runs=[{"run_id": "r1", "request_id": "req-1", "status": "finished"}])
        env = {**os.environ, "ORKEST_SWARM_ROOM": "room-a"}
        payload = {"session_id": "coord-1", "cwd": str(self.repo)}
        fast.run_mailbox_hook(payload, harness="claude", event="Stop", base=self.base, cwd=self.repo, env=env)
        created = list(CR.load_all(self.base).values())
        fast.run_mailbox_hook(payload, harness="claude", event="Stop", base=self.base, cwd=self.repo, env=env)
        again = list(CR.load_all(self.base).values())
        self.assertEqual(len(created), 2)  # the queued member, and the finished run awaiting review
        self.assertEqual({entry["key"] for entry in again}, {entry["key"] for entry in created})
        self.assertEqual(len(CR.load_all(self.base)), 2)
        recorder = Recorder()
        with (
            mock.patch.object(peer_mailbox, "notify", recorder.notify),
            mock.patch.object(peer_mailbox, "delivery_wake", recorder.wake),
        ):
            wake_recovery.continuation_pass(self.base)
        self.assertEqual(len(recorder.wakes), 2)
        reserved = [CR.reserve(self.base, entry["key"], "coord-1") for entry in created]
        self.assertEqual({entry["status"] for entry in reserved}, {"reserved"})
        with self.assertRaises(ValueError):
            CR.reserve(self.base, created[0]["key"], "coord-other")

    def test_stop_hook_uses_the_room_remembered_at_turn_start(self):
        env = {k: v for k, v in os.environ.items() if k != "ORKEST_SWARM_ROOM"}
        payload = {"session_id": "coord-1", "cwd": str(self.repo)}
        fast.run_mailbox_hook(payload, harness="claude", event="Stop", base=self.base, cwd=self.repo, env=env)
        self.assertEqual(CR.load_all(self.base), {})
        fast.run_mailbox_hook(payload, harness="claude", event="SessionStart", base=self.base, cwd=self.repo, env=env)
        fast.run_mailbox_hook(
            payload, harness="claude", event="UserPromptSubmit", base=self.base, cwd=self.repo, env=env
        )
        me = peer_mailbox.load(peer_mailbox.peer_path(self.base, "coord-1"))
        self.assertEqual(me["continuationRoom"], "room-a")
        fast.run_mailbox_hook(payload, harness="claude", event="Stop", base=self.base, cwd=self.repo, env=env)
        self.assertEqual(len(CR.load_all(self.base)), 1)

    def test_stop_hook_ignores_archived_rooms_and_non_owners(self):
        peer_mailbox.register(self.base, session="stranger", harness="claude", cwd=str(self.repo), pid=os.getpid())
        env = {**os.environ, "ORKEST_SWARM_ROOM": "room-a"}
        fast.run_mailbox_hook(
            {"session_id": "stranger", "cwd": str(self.repo)},
            harness="claude",
            event="Stop",
            base=self.base,
            cwd=self.repo,
            env=env,
        )
        self.assertEqual(CR.load_all(self.base), {})
        self.set_room(lifecycle="archived")
        fast.run_mailbox_hook(
            {"session_id": "coord-1", "cwd": str(self.repo)},
            harness="claude",
            event="Stop",
            base=self.base,
            cwd=self.repo,
            env=env,
        )
        self.assertEqual(CR.load_all(self.base), {})

    def test_finished_requests_expire_after_a_week_but_open_ones_stay(self):
        done, _ = self.task_request("stop")
        CR.cancel(self.base, done["key"], "operator")
        open_entry, _ = CR.request(self.base, room="room-a", revision="queued", reason="stop")
        CR.reconcile(self.base, moment=peer_mailbox.now() + dt.timedelta(days=8))
        self.assertEqual(set(CR.load_all(self.base)), {open_entry["key"]})

    def test_run_id_separates_retries_while_keeping_legacy_key_compatible(self):
        self.assertEqual(
            CR.request_key("room-a", str(self.task_dir), 1, self.revision()),
            CR.request_key("room-a", str(self.task_dir), 1, self.revision(), run_id=None),
        )
        run1 = {"run_id": "r1", "generation": 1, "status": "finished"}
        run2 = {"run_id": "r2", "generation": 1, "status": "finished"}
        state = {"task_id": "task-a", "task_spec": self.spec, "runs": [run1]}
        first = CR.request_for_terminal(self.base, self.task_dir, state, run1)
        CR.reserve(self.base, first["key"], "coord-1")
        CR.bind(self.base, first["key"], "coord-1", "req-1")
        self.write_task(
            runs=[{**run1, "request_id": "req-1"}],
            decisions=[{"run_id": "r1", "decision": "reject"}],
        )
        CR.reconcile(self.base)
        # Re-open for run 2 (correction) on the same spec: must not collide with run 1.
        second = CR.request_for_terminal(self.base, self.task_dir, state, run2)
        self.assertNotEqual(first["key"], second["key"])
        self.assertEqual(second["status"], "requested")

    def test_task_dir_none_queued_reservation_transitions_cleanly(self):
        me = peer_mailbox.load(peer_mailbox.peer_path(self.base, "coord-1"))
        [queued_req] = CR.request_at_stop(self.base, me, self.room)
        self.assertIsNone(queued_req["task_dir"])
        CR.reserve(self.base, queued_req["key"], "coord-1")

        # Pausing the room transitions the reserved task_dir=None request to paused rather than recovery_needed.
        self.set_room(conductor=dict(self.room["conductor"], paused=True))
        later = peer_mailbox.now() + CR.RESERVATION_TTL + dt.timedelta(seconds=30)
        CR.reconcile(self.base, moment=later)
        self.assertEqual(CR.load_all(self.base)[queued_req["key"]]["status"], "paused")

        # Unpausing restores requested, then dispatching haiku-1 completes the reserved request.
        self.set_room(conductor=self.room["conductor"])
        CR.reconcile(self.base)
        self.assertEqual(CR.load_all(self.base)[queued_req["key"]]["status"], "requested")
        CR.reserve(self.base, queued_req["key"], "coord-1")
        agents = [
            {**a, "status": "running", "dispatch": {"taskDir": str(self.task_dir)}} if a["id"] == "haiku-1" else a
            for a in self.room["agents"]
        ]
        self.set_room(agents=agents)
        CR.reconcile(self.base)
        self.assertEqual(CR.load_all(self.base)[queued_req["key"]]["status"], "completed")

        # When a room is cancelled while a task_dir=None request is reserved, reconcile cancels it.
        self.set_room(
            agents=[
                {"id": "coord-1", "kind": "conductor", "status": "running", "parent": None},
                {"id": "sonnet-1", "kind": "agent", "status": "queued", "parent": "conductor"},
            ]
        )
        [second] = CR.request_at_stop(self.base, me, room_store.read_room(self.base, "room-a"))
        CR.reserve(self.base, second["key"], "coord-1")
        self.set_room(lifecycle="cancelled")
        CR.reconcile(self.base)
        self.assertEqual(CR.load_all(self.base)[second["key"]]["status"], "cancelled")

    def test_team_authority_generation_routing_and_reserve_ownership(self):
        import authority

        cache_dir = Path(self.temporary.name) / "cache"
        auth_dir = cache_dir / "authority-v1" / "team-a"
        auth_dir.mkdir(parents=True)
        record = {
            "schema": authority.SCHEMA,
            "team": "team-a",
            "generation": 1,
            "status": "active",
            "lead": {"session": "coord-1", "harness": "claude"},
            "tasks": [],
            "log": [],
        }
        authority.save(auth_dir, dict(record))
        self.set_room(authority="team-a")
        peer_mailbox.register(
            self.base, session="coord-2", harness="claude", cwd=str(self.repo), pid=os.getpid(), state="idle"
        )
        with mock.patch.dict(os.environ, {"AGENT_EXECUTOR_HOME": str(cache_dir)}):
            me = peer_mailbox.load(peer_mailbox.peer_path(self.base, "coord-1"))
            room = room_store.read_room(self.base, "room-a")
            self.write_task(runs=[{"run_id": "r1", "request_id": "req-1", "status": "finished"}])
            created = CR.request_at_stop(self.base, me, room)
            self.assertTrue(all(item["authority_generation"] == 1 for item in created))
            entry = created[0]

            # Non-lead session cannot reserve.
            with self.assertRaisesRegex(ValueError, "not the current owner/lead"):
                CR.reserve(self.base, entry["key"], "coord-2")

            # After authority shifts to coord-2 (generation 2), _owner_peer routes to coord-2 (never coord-1),
            # old coord-1 cannot reserve, and coord-2 sees the old generation-1 request superseded.
            authority.save(
                auth_dir,
                {**record, "generation": 2, "lead": {"session": "coord-2", "harness": "claude"}},
            )
            self.assertEqual(CR._owner_peer(self.base, entry)["session"], "coord-2")
            with self.assertRaisesRegex(ValueError, "not the current owner/lead"):
                CR.reserve(self.base, entry["key"], "coord-1")
            superseded = CR.reserve(self.base, entry["key"], "coord-2")
            self.assertEqual(superseded["status"], "superseded")

            # If coord-2 goes offline, _owner_peer does NOT fall back to superseded coord-1.
            peer_mailbox.unregister(self.base, "coord-2")
            self.assertIsNone(CR._owner_peer(self.base, entry))

            # Withdrawn authority cancels open requests.
            entry2, _ = CR.request(
                self.base, room="room-a", generation=2, revision=CR.input_revision(["haiku-1"]), reason="stop"
            )
            authority.save(auth_dir, {**record, "generation": 2, "status": "withdrawn"})
            CR.reconcile(self.base)
            self.assertEqual(CR.load_all(self.base)[entry2["key"]]["status"], "cancelled")

    def test_room_for_task_prefers_active_room_over_archived(self):
        archived = {
            **self.room,
            "id": "room-archived",
            "lifecycle": "archived",
            "updatedAt": 9999999999999,
        }
        room_store.put_room(self.base, archived)
        found = CR._room_for_task(self.base, str(self.task_dir))
        self.assertIsNotNone(found)
        self.assertEqual(found[0]["id"], "room-a")


class RoomFenceTests(unittest.TestCase):
    """Archived and cancelled rooms are history: not adopted, not pruned by age."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def put(self, room_id, **fields):
        room_store.put_room(
            self.base,
            {
                "schema": "agent-executor.room.v1",
                "id": room_id,
                "cwd": self.temporary.name,
                "agents": [],
                "updatedAt": 1000,
                **fields,
            },
        )

    def test_age_prune_keeps_archived_and_cancelled_history(self):
        self.put("legacy-old")
        self.put("archived-old", lifecycle="archived")
        self.put("cancelled-old", lifecycle="cancelled")
        # The store stamps every write, so judge the rooms from a month later.
        later = peer_mailbox.time.time() + 30 * 86400
        with mock.patch.object(peer_mailbox.time, "time", return_value=later):
            peer_mailbox._prune_rooms_and_briefs(self.base, peer_mailbox.now())
        remaining = {room["id"] for room in room_store.list_rooms(self.base)}
        self.assertEqual(remaining, {"archived-old", "cancelled-old"})

    def test_session_discovery_never_adopts_an_archived_room(self):
        import agent_statusline_tmux

        peer_mailbox.register(
            self.base, session="coord-9", harness="claude", cwd=self.temporary.name, pid=os.getpid(), state="idle"
        )
        binding = {"id": "coord-9", "engine": "claude", "machine": socket.gethostname(), "cwd": self.temporary.name}
        self.put(
            "room-live",
            swarm={"maxAgents": 4, "maxDepth": 2},
            machine=socket.gethostname(),
            conductor={"engine": "claude", "role": "lead", "session": binding},
        )
        found = agent_statusline_tmux.find_session_swarm_room(
            self.base, "coord-9", harness="claude", cwd=self.temporary.name
        )
        self.assertEqual((found or {}).get("id"), "room-live")
        room_store.set_metadata(self.base, "room-live", lifecycle="archived")
        self.assertIsNone(
            agent_statusline_tmux.find_session_swarm_room(
                self.base, "coord-9", harness="claude", cwd=self.temporary.name
            )
        )

    def test_lifecycle_helpers_default_legacy_rooms_to_active(self):
        self.assertEqual(room_store.room_lifecycle({}), "active")
        self.assertEqual(room_store.room_lifecycle({"lifecycle": "bogus"}), "active")
        self.assertFalse(room_store.is_active_room({"lifecycle": "archived"}))


if __name__ == "__main__":
    unittest.main()
