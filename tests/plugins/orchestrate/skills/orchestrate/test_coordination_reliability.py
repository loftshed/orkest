"""Coordination reliability: room reads, lock identity, idempotent deliveries, liveness and activity parity."""

from __future__ import annotations

import datetime as dt
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import test_run_agent as fixtures

REPO = Path(__file__).resolve().parents[5]
SCRIPTS = REPO / "plugins/orchestrate/skills/orchestrate/scripts"
ROOMS_MJS = REPO / "plugins/orchestrate/lib/rooms.mjs"
sys.path.insert(0, str(SCRIPTS))
import agent_progress  # noqa: E402
import mailbox_hooks  # noqa: E402
import mailbox_status  # noqa: E402
import mailbox_store  # noqa: E402
import peer_mailbox as mailbox  # noqa: E402
import room_store  # noqa: E402
import room_tasks  # noqa: E402

RUNNER = fixtures.RUNNER


def canonical_room(room_id: str, session: str, cwd: Path, **extra) -> dict:
    return {
        "schema": "agent-executor.room.v1",
        "id": room_id,
        "cwd": str(cwd),
        "machine": socket.gethostname(),
        "agents": [],
        "conductor": {
            "engine": "codex",
            "session": {"id": session, "engine": "codex", "machine": socket.gethostname(), "cwd": str(cwd)},
        },
        **extra,
    }


def dead_pid() -> int:
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    return child.pid


class Scratch(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()
        self.base = self.home / "mailbox-v1"
        self.base.mkdir()
        room_store._CACHE.clear()
        self.addCleanup(room_store._CACHE.clear)


class RoomStoreReaderTests(Scratch):
    def test_direct_reader_matches_the_node_bridge_without_starting_node(self):
        room_store.put_room(self.base, canonical_room("room-a", "sess-a", self.home))
        room_store.put_room(self.base, canonical_room("room-b", "sess-b", self.home, title="Second"))
        self.assertTrue(room_store.sqlite_qualified())
        bridge_list = room_store._invoke(self.base, "list")
        bridge_get = room_store._invoke(self.base, "get", "room-b")
        room_store._CACHE.clear()
        with mock.patch.object(room_store, "_invoke", side_effect=AssertionError("Node bridge started")):
            self.assertEqual(room_store.list_rooms(self.base), bridge_list)
            room_store._CACHE.clear()
            self.assertEqual(room_store.read_room(self.base, "room-b"), bridge_get)
            self.assertIsNone(room_store.read_room(self.base, "room-missing"))

    def test_reader_falls_back_to_the_bridge_when_it_cannot_answer(self):
        room_store.put_room(self.base, canonical_room("room-a", "sess-a", self.home))
        self.assertIsNotNone(room_store._direct_rows(self.base))
        with mock.patch.dict(os.environ, {"ORKEST_ROOM_STORE_BRIDGE": "1"}):
            self.assertIsNone(room_store._direct_rows(self.base))
        with mock.patch.object(room_store, "sqlite_qualified", return_value=False):
            self.assertIsNone(room_store._direct_rows(self.base))
        # A legacy file still needs the Node import, so Python never reads around it.
        (self.base / "rooms").mkdir(exist_ok=True)
        (self.base / "rooms" / "legacy.json").write_text(
            json.dumps(canonical_room("legacy", "sess-l", self.home)), encoding="utf-8"
        )
        self.assertIsNone(room_store._direct_rows(self.base))
        self.assertEqual({room["id"] for room in room_store.list_rooms(self.base)}, {"room-a", "legacy"})

    def test_only_sqlite_builds_with_the_wal_reset_fix_qualify(self):
        for version, expected in (
            ((3, 42, 0), False),
            ((3, 44, 5), False),
            ((3, 44, 6), True),
            ((3, 50, 6), False),
            ((3, 50, 7), True),
            ((3, 51, 2), False),
            ((3, 51, 3), True),
            ((3, 54, 1), True),
        ):
            self.assertEqual(room_store.sqlite_qualified(version), expected, version)

    def test_rooms_index_follows_create_close_and_delete(self):
        index = self.base / "rooms-index.json"
        room_store.put_room(self.base, canonical_room("room-a", "sess-a", self.home))
        entries = json.loads(index.read_text(encoding="utf-8"))
        self.assertEqual(entries["schema"], "orkest.rooms-index.v1")
        self.assertEqual(
            [(room["id"], room["closed"], room["sessions"]) for room in entries["rooms"]],
            [("room-a", False, ["sess-a"])],
        )
        room_store.set_metadata(self.base, "room-a", closedAt="2026-11-18T00:00:00Z")
        self.assertTrue(json.loads(index.read_text(encoding="utf-8"))["rooms"][0]["closed"])
        room_store.delete_room(self.base, "room-a")
        self.assertEqual(json.loads(index.read_text(encoding="utf-8"))["rooms"], [])

    def test_racy_ns_guard_bypasses_cache_within_2s_and_trusts_cache_afterward(self):
        room_store.put_room(self.base, canonical_room("room-racy", "sess-r", self.home, title="Initial"))
        room_store._CACHE.clear()
        room_store.list_rooms(self.base)
        # Within 2s (_RACY_NS), cache trust is bypassed and SQLite is re-read.
        with mock.patch.object(room_store, "_direct_rows", wraps=room_store._direct_rows) as direct_spy:
            self.assertEqual(room_store.read_room(self.base, "room-racy")["title"], "Initial")
            self.assertEqual(direct_spy.call_count, 1)
            # Once > 2s past file mtime/ctime, _CACHE read trust kicks in and avoids re-reading SQLite.
            future_ns = time.time_ns() + room_store._RACY_NS + 1_000_000_000
            with mock.patch.object(room_store.time, "time_ns", return_value=future_ns):
                self.assertEqual(room_store.read_room(self.base, "room-racy")["title"], "Initial")
                self.assertEqual(room_store.list_rooms(self.base)[0]["title"], "Initial")
            self.assertEqual(direct_spy.call_count, 1)


class LockIdentityTests(Scratch):
    def test_a_waiter_on_an_unlinked_lock_moves_to_the_inode_at_the_path(self):
        path = self.base / "peers" / "peer.json"
        lock = path.with_suffix(".lock")
        holder_entered = threading.Event()
        release = threading.Event()
        observed = {}

        def holder():
            with mailbox.locked(path):
                holder_entered.set()
                release.wait(5)

        def waiter():
            with mailbox.locked(path):
                observed["inode"] = os.stat(lock).st_ino
                observed["entered"] = time.monotonic()

        first = threading.Thread(target=holder)
        first.start()
        self.assertTrue(holder_entered.wait(5))
        orphan = os.stat(lock).st_ino
        second = threading.Thread(target=waiter)
        second.start()
        time.sleep(0.1)
        lock.unlink()  # a pruner removing the idle-looking file while the waiter blocks on its inode
        release.set()
        first.join(5)
        second.join(5)
        self.assertIn("inode", observed)
        self.assertTrue(lock.exists())
        self.assertEqual(observed["inode"], os.stat(lock).st_ino)
        self.assertNotEqual(observed["inode"], orphan)

    def test_stale_lock_reaping_cannot_remove_a_held_lock_and_acquisition_touches_it(self):
        path = self.base / "peers" / "peer.json"
        lock = path.with_suffix(".lock")
        path.parent.mkdir(parents=True)
        lock.touch()
        os.utime(lock, (0, 0))
        with mailbox.locked(path):
            self.assertGreater(lock.stat().st_mtime, time.time() - 60)
            self.assertFalse(mailbox._unlink_stale_lock(lock, min_age_seconds=-1))
        self.assertTrue(lock.exists())

    def test_unregister_waits_for_the_peer_lock(self):
        mailbox.register(self.base, session="lock-peer", harness="codex", cwd=str(self.home), pid=os.getpid())
        path = mailbox.peer_path(self.base, "lock-peer")
        entered = threading.Event()
        release = threading.Event()
        done = threading.Event()

        def holder():
            with mailbox.locked(path):
                entered.set()
                release.wait(5)

        thread = threading.Thread(target=holder)
        thread.start()
        self.assertTrue(entered.wait(5))
        remover = threading.Thread(target=lambda: (mailbox.unregister(self.base, "lock-peer"), done.set()))
        remover.start()
        self.assertFalse(done.wait(0.2), "unregister removed a peer while another writer held its lock")
        self.assertTrue(path.exists())
        release.set()
        thread.join(5)
        remover.join(5)
        self.assertTrue(done.is_set())
        self.assertFalse(path.exists())

    def test_acquire_lock_recreates_deleted_parent_directory(self):
        lock_path = self.base / "inbox" / "ephemeral-session" / "msg.lock"
        calls = {"n": 0}
        real_open = os.open

        def flaky_open(path, flags, mode=0o777):
            calls["n"] += 1
            if calls["n"] == 1:
                raise FileNotFoundError("reaped parent")
            return real_open(path, flags, mode)

        with mock.patch.object(mailbox_store.os, "open", side_effect=flaky_open):
            fd = mailbox_store.acquire_lock(lock_path)
            os.close(fd)
        self.assertGreaterEqual(calls["n"], 2)
        self.assertTrue(lock_path.is_file())


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / "event.json"
        self.hook = self.root / "hook.sh"
        self.events = RUNNER.bundled_module("events_bus")

    def publish(self, *, hook=None):
        return self.events.publish_completion_event(
            result={"status": "completed", "repository": str(self.root)},
            result_path=self.root / "result.json",
            event_path=self.path,
            notification_mode="desktop",
            completion_hook=hook,
        )

    def test_republishing_never_repeats_a_sent_delivery_or_drops_one(self):
        sent = {"kind": "desktop", "status": "sent", "provider": "freedesktop"}
        with mock.patch.object(self.events, "send_desktop_notification", return_value=sent) as notify:
            self.publish()
            self.events.acknowledge_completion_event(self.events.read_completion_event(self.path))
            acknowledged = self.events.read_completion_event(self.path)["acknowledged_at"]
            event = self.publish()
        self.assertEqual(notify.call_count, 1)
        self.assertEqual(event["deliveries"], [sent])
        current = self.events.read_completion_event(self.path)
        self.assertEqual(current["deliveries"], [sent])
        self.assertEqual(current["acknowledged_at"], acknowledged)

    def test_a_failed_channel_is_retried_and_other_channels_are_kept(self):
        failed = {"kind": "desktop", "status": "failed", "provider": "freedesktop", "error": "no bus"}
        sent = {"kind": "desktop", "status": "sent", "provider": "freedesktop"}
        hook_sent = {"kind": "hook", "status": "sent", "path": str(self.hook)}
        with (
            mock.patch.object(self.events, "send_desktop_notification", side_effect=[failed, sent]) as notify,
            mock.patch.object(self.events, "run_completion_hook", return_value=hook_sent) as hook,
        ):
            self.publish(hook=self.hook)
            self.publish(hook=self.hook)
        self.assertEqual(notify.call_count, 2)
        self.assertEqual(hook.call_count, 1)
        self.assertEqual(self.events.read_completion_event(self.path)["deliveries"], [sent, hook_sent])

    def test_merge_keeps_the_first_sent_outcome_per_channel(self):
        sent = {"kind": "hook", "status": "sent", "path": "/a"}
        self.assertEqual(
            self.events.merge_deliveries([sent], [{"kind": "hook", "status": "failed", "path": "/a"}]), [sent]
        )

    def test_merge_completion_event_preserves_acknowledged_at_from_fields_when_current_is_none(self):
        self.publish()
        merged = self.events._merge_completion_event(
            self.path, {"acknowledged_at": "2026-11-18T12:00:00Z"}, initial=True
        )
        self.assertEqual(merged["acknowledged_at"], "2026-11-18T12:00:00Z")
        self.assertEqual(self.events.read_completion_event(self.path)["acknowledged_at"], "2026-11-18T12:00:00Z")


class LivenessParityTests(Scratch):
    CONSTANTS = {
        "MAX_PEER_AGE_MS": mailbox_store.MAX_AGE,
        "UNKNOWN_PID_TTL_MS": mailbox_store.UNKNOWN_PID_TTL,
        "SHARED_PROCESS_IDLE_TTL_MS": mailbox_store.SHARED_PROCESS_IDLE_TTL,
        "SHARED_PROCESS_WAITING_TTL_MS": mailbox_store.SHARED_PROCESS_WAITING_TTL,
        "SHARED_PROCESS_BUSY_TTL_MS": mailbox_store.SHARED_PROCESS_BUSY_TTL,
    }

    def test_ttl_constants_match_rooms_mjs(self):
        script = (
            f"import * as rooms from {json.dumps(ROOMS_MJS.as_uri())};"
            f"console.log(JSON.stringify(Object.fromEntries({json.dumps(list(self.CONSTANTS))}.map((k) => [k, rooms[k]]))));"
        )
        output = json.loads(
            subprocess.run(
                ["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True
            ).stdout
        )
        for name, value in self.CONSTANTS.items():
            self.assertEqual(output[name], value.total_seconds() * 1000, name)

    def test_is_live_matches_node_except_the_deliberate_own_process_split(self):
        now = dt.datetime.now(dt.UTC)

        def stamp(age: dt.timedelta) -> str:
            return (now - age).strftime("%Y-%m-%dT%H:%M:%SZ")

        alive, dead = os.getpid(), dead_pid()
        birth = mailbox.process_started(alive)
        base = {"schema": "agent-executor.peer.v1", "session": "s", "name": "n", "harness": "codex", "cwd": "/"}
        cases = {
            "dead": {"pid": dead},
            "unknown-pid-fresh": {"age": dt.timedelta(hours=1)},
            "unknown-pid-expired": {"age": dt.timedelta(hours=3)},
            "shared-idle-fresh": {"pid": alive, "sharedProcess": True, "state": "idle", "age": dt.timedelta(hours=2)},
            "shared-idle-expired": {"pid": alive, "sharedProcess": True, "state": "idle", "age": dt.timedelta(hours=4)},
            "shared-busy-fresh": {
                "pid": alive,
                "sharedProcess": True,
                "state": "busy",
                "age": dt.timedelta(minutes=10),
            },
            "shared-busy-expired": {"pid": alive, "sharedProcess": True, "state": "busy", "age": dt.timedelta(hours=1)},
            "shared-waiting-fresh": {
                "pid": alive,
                "sharedProcess": True,
                "state": "waiting",
                "age": dt.timedelta(hours=2),
            },
            "shared-waiting-expired": {
                "pid": alive,
                "sharedProcess": True,
                "state": "waiting",
                "age": dt.timedelta(hours=4),
            },
            "reused-pid": {"pid": alive, "pidBirth": "Thu Jan  1 00:00:00 1970", "age": dt.timedelta(minutes=1)},
            "own-process-recent": {"pid": alive, "pidBirth": birth, "age": dt.timedelta(days=1)},
            "own-process-past-max-age": {"pid": alive, "pidBirth": birth, "age": dt.timedelta(days=8)},
            "no-stamps": {"pid": alive, "noStamps": True},
        }
        peers = {}
        for name, case in cases.items():
            peer = {**base, **{k: v for k, v in case.items() if k not in {"age", "noStamps"}}}
            if not case.get("noStamps"):
                peer["startedAt"] = peer["lastSeenAt"] = stamp(case.get("age", dt.timedelta(0)))
            peers[name] = peer
        script = (
            f"import {{ isPeerLive }} from {json.dumps(ROOMS_MJS.as_uri())};"
            "const peers = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));"
        ).replace("require('node:fs')", "(await import('node:fs'))")
        script += (
            f"const now = {int(now.timestamp() * 1000)};"
            "console.log(JSON.stringify(Object.fromEntries(Object.entries(peers).map(([k, p]) => [k, isPeerLive(p, now)]))));"
        )
        node = json.loads(
            subprocess.run(
                ["node", "--input-type=module", "-e", script],
                input=json.dumps(peers),
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )
        python = {name: mailbox.is_live(peer, now) for name, peer in peers.items()}
        expected = {
            "dead": False,
            "unknown-pid-fresh": True,
            "unknown-pid-expired": False,
            "shared-idle-fresh": True,
            "shared-idle-expired": False,
            "shared-busy-fresh": True,
            "shared-busy-expired": False,
            "shared-waiting-fresh": True,
            "shared-waiting-expired": False,
            "reused-pid": False,
            "own-process-recent": True,
            "own-process-past-max-age": True,
            "no-stamps": False,
        }
        self.assertEqual(python, expected)
        # Rooms stop counting an open session after seven days; the mailbox keeps it reachable (deliberate).
        self.assertEqual(node, {**expected, "own-process-past-max-age": False})


class SubagentProgressTests(Scratch):
    def setUp(self):
        super().setUp()
        self.checkout = self.home / "checkout"
        self.checkout.mkdir()
        self.alias = self.home / "alias"
        self.alias.symlink_to(self.checkout)
        self.enterContext(mock.patch.dict(os.environ, {"ORKEST_READONLY_RUN": "1", "HERDR_ENV": ""}))
        self.enterContext(mock.patch.object(mailbox, "harness_pid", return_value=os.getpid()))
        mailbox.register(self.base, session="parent-1", harness="claude", cwd=str(self.alias), pid=os.getpid())

    def hook(self, event: str) -> None:
        payload = {"session_id": "parent-1", "agent_id": "child-1", "agent_type": "Explore", "cwd": str(self.alias)}
        mailbox.hook(payload, harness="claude", event=event, base=self.base)

    def test_subagent_progress_is_locked_resolved_and_accepted_by_the_reader(self):
        locked_paths = []
        original = mailbox_hooks._MB.locked

        def recording(path):
            locked_paths.append(Path(path))
            return original(path)

        with mock.patch.object(mailbox_hooks._MB, "locked", side_effect=recording):
            self.hook("SubagentStart")
        record = agent_progress.record_path(self.base, "subagent-child-1")
        self.assertIn(record, locked_paths)
        row = json.loads(record.read_text(encoding="utf-8"))
        self.assertEqual(row["checkout"], str(self.checkout))
        peer = mailbox.load(mailbox.peer_path(self.base, "subagent-child-1"))
        accepted = agent_progress.read(self.base, peer)
        self.assertEqual((accepted["stage"], accepted["role"]), ("working", "scout"))

        locked_paths.clear()
        with mock.patch.object(mailbox_hooks._MB, "locked", side_effect=recording):
            self.hook("SubagentStop")
        self.assertIn(record, locked_paths)
        row = json.loads(record.read_text(encoding="utf-8"))
        self.assertEqual((row["stage"], row["checkout"]), ("complete", str(self.checkout)))

    def test_progress_cli_resolves_a_native_alias_to_its_mailbox_peer(self):
        mailbox.attest_native_sessions(self.base, "parent-1", "native-parent")
        resolved = agent_progress.resolve_peer(self.base, "native-parent")
        self.assertEqual(resolved["session"], "parent-1")
        self.assertIsNone(agent_progress.resolve_peer(self.base, "nobody"))


class ActivityTests(Scratch):
    def task(self, status: str, decisions=()) -> tuple[dict, dict]:
        member = {
            "id": "w1",
            "engine": "codex",
            "dispatch": {"taskDir": str(self.home), "taskId": "t1", "requestId": "r1", "transport": "executor"},
        }
        task = {
            "schema": "agent-executor.task.v1",
            "task_id": "t1",
            "repository": str(self.home),
            "runs": [
                {"run_id": "run-1", "request_id": "r1", "engine": "codex", "transport": "executor", "status": status}
            ],
            "decisions": list(decisions),
        }
        return member, task

    def test_review_is_a_finished_run_not_active_work(self):
        member, task = self.task("finished")
        projection = room_tasks.project(str(self.home), member, task)
        self.assertEqual((projection["status"], projection["runtimeState"]), ("review", "stopped"))
        self.assertFalse(room_tasks.is_active(projection))
        member, task = self.task("active")
        projection = room_tasks.project(str(self.home), member, task)
        self.assertEqual((projection["status"], projection["runtimeState"]), ("running", "running"))
        self.assertTrue(room_tasks.is_active(projection))

    def test_reconnection_summary_does_not_count_review_as_active(self):
        room = {"agents": [{"id": "a", "status": "review"}, {"id": "b", "status": "running"}]}
        summary = mailbox_hooks._format_swarm_reconnection_summary(room, "room-1", "conductor")
        self.assertIn("(1 active,", summary)


class StatusCacheTests(Scratch):
    def test_unchanged_peer_files_are_not_reread_and_presence_stays_wall_clock_fresh(self):
        mailbox_status._PEER_CACHE.clear()
        self.addCleanup(mailbox_status._PEER_CACHE.clear)
        checkout = self.home / "project"
        subprocess.run(["git", "init", "-q", str(checkout)], check=True)
        me = mailbox.register(self.base, session="me", harness="codex", cwd=str(checkout), pid=os.getpid())
        mailbox.register(self.base, session="other", harness="codex", cwd=str(checkout), pid=os.getpid())
        for path in (self.base / "peers").glob("*.json"):
            os.utime(path, (time.time() - 60, time.time() - 60))
        original = mailbox.load
        with mock.patch.object(mailbox_status.mailbox, "load", side_effect=original) as load:
            with mock.patch.object(mailbox_status.mailbox, "is_live", return_value=True):
                first = mailbox_status.snapshot(self.base, me)
            reads = load.call_count
            with mock.patch.object(mailbox_status.mailbox, "is_live", return_value=False):
                second = mailbox_status.snapshot(self.base, me)
            peer_reads = [call for call in load.call_args_list[reads:] if "peers" in str(call.args[0])]
        self.assertEqual(peer_reads, [])
        self.assertEqual({row["presence"] for row in first["agents"]}, {"present"})
        self.assertEqual({row["presence"] for row in second["agents"]}, {"not_present"})
        # A changed file is read again.
        other = mailbox.peer_path(self.base, "other")
        mailbox.annotate(self.base, "other", focus="changed focus")
        os.utime(other, (time.time() - 60, time.time() - 60))
        third = mailbox_status.snapshot(self.base, me)
        self.assertIn("changed focus", {row["focus"] for row in third["agents"]})


if __name__ == "__main__":
    unittest.main()
