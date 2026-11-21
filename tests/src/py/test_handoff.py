"""Automatic handoff: StopFailure and quota-poll detection, successor choice, auto-appointment, the generation
fence, notices and settings, with a fake monitor, injected peers, rooms, launcher and clock."""

from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import _ork_fast_test_helpers as ORK_FAST  # noqa: E402
import test_run_agent as fixtures  # noqa: E402

RUNNER = fixtures.RUNNER
HANDOFF = RUNNER.bundled_module("handoff")
AUTHORITY = HANDOFF.authority()
SUCCESSION = HANDOFF.succession()
MAILBOX = HANDOFF.mailbox()
SCRIPTS = Path(MAILBOX.__file__).parent

LEAD, PEER, THIRD = "claude-lead-session", "claude-peer-session", "claude-third-session"
OPUS = "claude-opus-5-5"


def lane(account, pool="all", status="available", usable=80, surplus=10, stale=False):
    return {
        "accountId": account,
        "poolId": pool,
        "label": f"{account} · {pool}",
        "status": status,
        "availableNowPct": usable,
        "surplusPts": surplus,
        "subPoolOf": None,
        "stale": stale,
        "blockedUntil": None,
    }


def room(room_id="r1", session=LEAD, agents=None, authority=None):
    return {
        "id": room_id,
        "title": "Ship it",
        "conductor": {"session": {"id": session, "engine": "claude"}},
        "agents": agents or [],
        **({"authority": authority} if authority else {}),
    }


class HandoffTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.homes = {name: self.root / name for name in ("claude-a", "claude-b", "claude-c", "claude-w")}
        for home in self.homes.values():
            home.mkdir()
        self.repo = self.root / "repo"
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.repo)], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(self.repo),
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.invalid",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "start",
            ],
            check=True,
        )
        self.config = {
            "maxAgeSeconds": 180,
            "accounts": [
                {
                    "id": "claude-a",
                    "provider": "claude",
                    "billing": "personal",
                    "configDir": str(self.homes["claude-a"]),
                },
                {
                    "id": "claude-b",
                    "provider": "claude",
                    "billing": "personal",
                    "configDir": str(self.homes["claude-b"]),
                },
                {
                    "id": "claude-c",
                    "provider": "claude",
                    "billing": "personal",
                    "configDir": str(self.homes["claude-c"]),
                },
                {"id": "claude-w", "provider": "claude", "billing": "work", "configDir": str(self.homes["claude-w"])},
                {"id": "codex", "provider": "codex", "billing": "personal"},
            ],
        }
        self.lanes = [
            lane("claude-a", status="blocked", usable=0),
            lane("claude-b", usable=60, surplus=5),
            lane("claude-c", status="low", usable=5),
            lane("claude-w", usable=99, surplus=50),
            lane("codex", "codex", usable=40, surplus=1),
        ]
        cache = self.root / "monitor-cache"
        cache.mkdir()
        (cache / "snapshot.json").write_text("{}")
        monitor = self.root / "monitor"
        monitor.write_text(f"#!/bin/sh\ncat {self.root / 'view.json'}\n")
        monitor.chmod(0o755)
        self.environment = mock.patch.dict(
            os.environ,
            {
                "AGENT_EXECUTOR_HOME": str(self.root / "executor"),
                "ORCHESTRATE_CONFIG": str(self.root / "orkest-config.json"),
                "MONITOR_CONFIG": str(self.root / "monitor-config.json"),
                "MONITOR_CACHE_DIR": str(cache),
                "MONITOR_BIN": str(monitor),
            },
        )
        self.environment.start()
        os.environ.pop("ORCHESTRATE_HOME", None)
        os.environ.pop("ORKEST_HANDOFF_SUCCESSOR", None)
        self.write()
        self.base = MAILBOX.root()
        self.lead = self.register(LEAD, "claude-a")
        self.spawned: list[tuple[str, str]] = []
        self.delivered: list[tuple[str, str]] = []
        self.launched: list[tuple[list[str], dict[str, str]]] = []
        self.sleeps: list[float] = []
        self.routes = {
            "implementation": {
                "engine": "codex",
                "model": "gpt:luna",
                "alternates": [{"engine": "codex", "model": "gpt:sol"}],
            }
        }

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    # Fixtures

    def write(self) -> None:
        accounts = [
            {
                "id": a.get("id"),
                "provider": a["provider"],
                "billing": a.get("billing"),
                "label": a.get("id"),
                "configDir": a.get("configDir"),
            }
            for a in self.config["accounts"]
        ]
        view = {"schema": "monitor.snapshot.v1", "accounts": accounts, "lanes": self.lanes}
        (self.root / "view.json").write_text(json.dumps(view))
        (self.root / "monitor-config.json").write_text(json.dumps(self.config))

    def set_lane(self, account, **changes) -> None:
        if "usable" in changes:
            changes["availableNowPct"] = changes.pop("usable")
        self.lanes = [{**entry, **changes} if entry["accountId"] == account else entry for entry in self.lanes]
        self.write()

    def register(self, session, account, *, model=OPUS, state="idle", cwd=None):
        return MAILBOX.register(
            self.base,
            session=session,
            harness="claude",
            cwd=str(cwd or self.repo),
            pid=os.getpid(),
            state=state,
            model=model,
            account=str(self.homes[account]),
        )

    def spawn(self, session, event_id) -> None:
        self.spawned.append((session, event_id))

    def deliver(self, base, event, successor, text):
        self.delivered.append((successor["session"], text))
        return {"message": "m1", "wake": "sent"}

    def launcher(self, command, env):
        self.launched.append((command, env))
        return {"exitCode": 0, "output": "detached"}

    def stop_failure(self, session=LEAD, error="rate_limit", **extra):
        payload = {
            "hook_event_name": "StopFailure",
            "session_id": session,
            "cwd": str(self.repo),
            "transcript_path": str(self.root / "t.jsonl"),
            "error": error,
            "error_details": "429 Too Many Requests",
            **extra,
        }
        return HANDOFF.stop_failure(self.base, payload, session, "claude", spawn=self.spawn)

    def handoff(self, session=LEAD, rooms=None, **options):
        recorded = self.stop_failure(session)
        self.assertEqual(recorded["status"], "recorded", recorded)
        return HANDOFF.run(
            session,
            recorded["event"],
            **{
                "base": self.base,
                "rooms": lambda base, who: rooms if rooms is not None else [room(session=who)],
                "launcher": self.launcher,
                "deliver": self.deliver,
                "sleep": self.sleeps.append,
                **options,
            },
        )

    def accept(self, team, session):
        shown = AUTHORITY.show(team, "claude")
        return AUTHORITY.accept(
            team, AUTHORITY.member(session, "claude"), shown["authority"]["generation"], shown["state"]["digest"]
        )

    # Detection

    def test_repeated_stop_failures_record_one_event(self) -> None:
        first = self.stop_failure()
        self.assertEqual(first["status"], "recorded")
        self.assertEqual(self.stop_failure()["status"], "duplicate")
        self.assertEqual(self.stop_failure(error="billing_error")["status"], "duplicate")
        self.assertEqual(self.spawned, [(LEAD, first["event"])])
        event = json.loads((HANDOFF.session_dir(LEAD) / "event.json").read_text())
        self.assertEqual((event["reason"], event["source"], event["status"]), ("rate_limit", "StopFailure", "recorded"))
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            self.assertEqual(self.stop_failure()["status"], "recorded")
        self.assertEqual(len(self.spawned), 2)

    def test_other_errors_subagents_delegated_runs_and_run_peers_do_nothing(self) -> None:
        self.assertEqual(self.stop_failure(error="overloaded")["status"], "ignored")
        self.assertEqual(self.stop_failure(error=None)["status"], "ignored")
        self.assertEqual(self.stop_failure(agent_id="a1", agent_type="Explore")["status"], "ignored")
        payload = {"hook_event_name": "StopFailure", "session_id": LEAD, "error": "rate_limit"}
        self.assertEqual(HANDOFF.stop_failure(self.base, payload, LEAD, "codex", spawn=self.spawn)["status"], "ignored")
        for flags in ({"isSubagent": True}, {"delegatedRun": {"run": "x"}}):
            MAILBOX.annotate(self.base, LEAD, **flags)
            self.assertEqual(self.stop_failure()["status"], "ignored")
            MAILBOX.annotate(self.base, LEAD, **dict.fromkeys(flags))
        run_peer = {"session": "run-x-worker", "run": "x", "role": "worker"}
        self.assertEqual(
            HANDOFF.record_exhaustion(
                "run-x-worker", "claude", "rate_limit", source="StopFailure", peer=run_peer, spawn=self.spawn
            )["status"],
            "ignored",
        )
        # The documented field is `error`; `error_type` is accepted too.
        self.assertEqual(HANDOFF.error_type({"error_type": "billing_error"}), "billing_error")
        self.assertEqual(self.spawned, [])
        self.assertFalse(HANDOFF.session_dir(LEAD).joinpath("event.json").exists())

    def test_the_hook_records_stop_failure_quietly_and_never_raises(self) -> None:
        payload = {"hook_event_name": "StopFailure", "session_id": LEAD, "cwd": str(self.repo), "error": "rate_limit"}
        env = {**os.environ, "CLAUDE_CONFIG_DIR": str(self.homes["claude-a"]), "PYTEST_CURRENT_TEST": "1"}
        started = time.monotonic()
        self.assertIsNone(
            ORK_FAST.run_mailbox_hook(payload, harness="claude", base=self.base, pid=os.getpid(), env=env)
        )
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(json.loads((HANDOFF.session_dir(LEAD) / "event.json").read_text())["status"], "recorded")

        broken_scripts = self.root / "broken-scripts"
        broken_scripts.mkdir(exist_ok=True)
        (broken_scripts / "handoff.py").write_text('raise RuntimeError("boom")\n')
        broken_env = {**env, "ORKEST_SCRIPTS_DIR": str(broken_scripts)}
        self.assertIsNone(
            ORK_FAST.run_mailbox_hook(payload, harness="claude", base=self.base, pid=os.getpid(), env=broken_env)
        )
        self.assertIsNone(
            ORK_FAST.run_mailbox_hook(
                {**payload, "hook_event_name": "SomethingNew"},
                harness="claude",
                base=self.base,
                pid=os.getpid(),
                env=broken_env,
            )
        )
        turn = {"hook_event_name": "UserPromptSubmit", "session_id": LEAD, "cwd": str(self.repo)}
        ORK_FAST.run_mailbox_hook(
            turn, harness="claude", base=self.base, pid=os.getpid(), env=broken_env
        )  # a broken handoff never costs the turn

    def test_codex_and_antigravity_rely_on_the_periodic_quota_check(self) -> None:
        codex = MAILBOX.register(
            self.base,
            session="codex-lead",
            harness="codex",
            cwd=str(self.repo),
            pid=os.getpid(),
            state="idle",
            account="/x",
        )
        HANDOFF.poll(self.base, codex, spawn=self.spawn)
        self.assertEqual(self.spawned, [])  # codex has room
        self.set_lane("codex", status="blocked", usable=0)
        codex = MAILBOX.load(MAILBOX.peer_path(self.base, "codex-lead"))
        HANDOFF.poll(self.base, codex, spawn=self.spawn)
        self.assertEqual(self.spawned, [])  # checked a moment ago: at most every few minutes
        MAILBOX.annotate(self.base, "codex-lead", handoffCheckedAt=None)
        HANDOFF.poll(self.base, MAILBOX.load(MAILBOX.peer_path(self.base, "codex-lead")), spawn=self.spawn)
        self.assertEqual([session for session, _ in self.spawned], ["codex-lead"])
        HANDOFF.poll(self.base, self.lead, spawn=self.spawn)  # Claude has StopFailure instead
        self.assertEqual(len(self.spawned), 1)

    # Choosing a successor

    def choose(self, peers=None, lead_model=OPUS, **options):
        return HANDOFF.choose_successor(
            {
                "session": LEAD,
                "harness": "claude",
                "model": lead_model,
                "accountHome": str(self.homes["claude-a"]),
                "repo": self.lead["repo"],
            },
            view=SUCCESSION.fresh_view(),
            config=SUCCESSION.monitor_config(),
            peers=MAILBOX.peers(self.base) if peers is None else peers,
            options={"autoLaunch": True, "excludeAccounts": [], **options},
            routes=self.routes,
        )

    def test_a_live_idle_peer_on_another_account_in_the_same_context_comes_first(self) -> None:
        self.register(PEER, "claude-b")
        self.register("claude-work-peer", "claude-w")  # more room, but work
        self.register("claude-low-peer", "claude-c")  # same context, but low
        choice = self.choose()
        self.assertEqual(choice["refusals"], [])
        self.assertEqual((choice["account"], choice["status"], choice["context"]), ("claude-a", "blocked", "personal"))
        self.assertEqual(
            {key: choice["successor"][key] for key in ("kind", "session", "account", "pool")},
            {"kind": "peer", "session": PEER, "account": "claude-b", "pool": "claude-b:all"},
        )

    def test_a_busy_lower_tier_or_own_account_peer_is_not_chosen_and_a_launch_is(self) -> None:
        self.register("claude-busy", "claude-b", state="busy")
        self.register("claude-sonnet", "claude-b", model="claude-sonnet-5-5")
        self.register("claude-own", "claude-a")
        successor = self.choose()["successor"]
        self.assertEqual(successor["kind"], "launch")
        self.assertEqual((successor["account"], successor["engine"], successor["model"]), ("claude-b", "claude", OPUS))
        self.assertEqual(successor["configDir"], str(self.homes["claude-b"]))
        # A peer of a higher tier qualifies.
        self.register("claude-fable", "claude-b", model="claude-fable-5-2")
        self.assertEqual(self.choose()["successor"]["session"], "claude-fable")
        # The lead's own account never takes over, even with room on it.
        self.set_lane("claude-a", status="available", usable=99, surplus=90)
        self.set_lane("claude-b", status="blocked", usable=0)
        self.set_lane("codex", status="blocked", usable=0)
        choice = self.choose()
        self.assertIsNone(choice["successor"])
        self.assertIn("no pool on another personal account", choice["refusals"][0])

    def test_never_low_blocked_credits_work_or_excluded_pools(self) -> None:
        self.set_lane("claude-b", status="credits", usable=0)
        successor = self.choose()["successor"]
        self.assertEqual((successor["account"], successor["engine"], successor["model"]), ("codex", "codex", "gpt:sol"))
        refusal = self.choose(excludeAccounts=["codex"])["refusals"]
        self.assertEqual(len(refusal), 1)
        self.assertIn("no pool on another personal account is available now", refusal[0])
        self.set_lane("codex", stale=True)
        self.assertIsNone(self.choose()["successor"])
        self.assertIn("auto-launch is off", self.choose(autoLaunch=False)["refusals"][0])

    def test_an_unknown_billing_context_refuses_and_is_never_guessed(self) -> None:
        self.config["accounts"][0]["billing"] = None
        self.write()
        choice = self.choose()
        self.assertIsNone(choice["successor"])
        self.assertIn("billing context of account 'claude-a' is unknown", choice["refusals"][0])
        # An untagged other account is never a successor either.
        self.config["accounts"][0]["billing"] = "personal"
        for entry in self.config["accounts"][1:]:
            entry["billing"] = None if entry["id"] != "claude-w" else "work"
        self.write()
        self.register(PEER, "claude-b")
        self.assertIsNone(self.choose()["successor"])

    def test_model_tiers_are_capability_tiers_of_ids_and_selectors(self) -> None:
        self.assertTrue(HANDOFF.peer_tier_ok("claude-opus-5-5", "claude-fable-5-2"))
        self.assertTrue(HANDOFF.peer_tier_ok("opus", "claude-opus-5-5"))
        self.assertFalse(HANDOFF.peer_tier_ok("claude-opus-5-5", "claude-sonnet-5-5"))
        self.assertFalse(HANDOFF.peer_tier_ok(None, "claude-opus-5-5"))
        # Route selectors and other families rank by the runner's own capability tiers.
        self.assertTrue(HANDOFF.peer_tier_ok("claude-opus-5-5", "claude:best"))
        self.assertTrue(HANDOFF.peer_tier_ok("claude:frontier", "gpt-6-astra"))
        self.assertTrue(HANDOFF.peer_tier_ok("claude-opus-5-5", "gpt-5.4"))
        self.assertFalse(HANDOFF.peer_tier_ok("claude-opus-5-5", "gpt:luna"))
        # A cross-harness launch never downgrades an Opus lead to the engine's fast default.
        lead = {"harness": "claude", "model": "claude-opus-5-5"}
        self.assertEqual(HANDOFF.launch_models("codex", lead, self.routes), ["gpt:sol"])
        self.assertEqual(HANDOFF.launch_models("codex", {**lead, "model": "claude-fable-5-2"}, self.routes), [])

    # The handoff

    def test_a_room_conductor_with_no_team_is_fenced_and_a_live_peer_is_woken(self) -> None:
        self.register(PEER, "claude-b")
        event = self.handoff()
        self.assertEqual(event["status"], "handed-over", event)
        team = event["team"]
        self.assertEqual(team, "room-r1")
        record = AUTHORITY.load(AUTHORITY.team_dir(team))
        self.assertEqual((record["status"], record["lead"]["session"], record["generation"]), ("pending", PEER, 2))
        self.assertEqual([entry["event"] for entry in record["log"]], ["appoint", "takeover"])
        self.assertTrue(record["log"][-1]["standing"])
        self.assertEqual(record["handoff"]["from"]["session"], LEAD)
        # The old lead is fenced at once; the successor may not act until it accepts.
        with self.assertRaisesRegex(AUTHORITY.AuthorityError, "superseded"):
            AUTHORITY.check(record, LEAD, 1)
        with self.assertRaisesRegex(AUTHORITY.AuthorityError, "pending"):
            AUTHORITY.check(record, PEER, 2)
        [(to, text)] = self.delivered
        self.assertEqual(to, PEER)
        self.assertIn("authority.py show and accept", text)
        brief = (HANDOFF.session_dir(LEAD) / "brief.md").read_text()
        self.assertIn(f"accept --team {team} --session {PEER} --harness claude --expect-generation 2", brief)
        self.assertEqual(self.accept(team, PEER)["status"], "active")
        self.assertEqual(self.launched, [])
        self.assertIn("woken with the handoff note", event["notice"])

    def test_with_no_peer_one_fresh_headless_agent_is_launched_on_free_quota(self) -> None:
        event = self.handoff()
        self.assertEqual(event["status"], "handed-over", event)
        [(command, env)] = self.launched
        successor = f"handoff-{event['id']}"
        self.assertEqual(event["successor"]["session"], successor)
        self.assertEqual(env["ORKEST_HANDOFF_LAUNCH"], successor)
        self.assertNotIn("ORKEST_HANDOFF_SUCCESSOR", env)
        self.assertEqual(command[command.index("--engine") + 1], "claude")
        self.assertEqual(command[command.index("--transport") + 1], "executor")
        self.assertEqual(command[command.index("--claude-config-dir") + 1], str(self.homes["claude-b"]))
        self.assertNotIn("--allow-credits", command)
        self.assertNotIn("--ignore-quota", command)
        brief = Path(command[command.index("--brief") + 1])
        self.assertEqual(stat.S_IMODE(brief.stat().st_mode), 0o600)
        self.assertIn("show --team room-r1 --harness claude", brief.read_text())
        record = AUTHORITY.load(AUTHORITY.team_dir("room-r1"))
        self.assertEqual((record["status"], record["lead"]["session"]), ("pending", successor))
        self.assertIn("launched headless", event["notice"])

    def test_one_exhaustion_makes_at_most_one_successor_even_when_runs_race(self) -> None:
        recorded = self.stop_failure()
        results = []
        barrier = threading.Barrier(4)

        def attempt():
            barrier.wait()
            results.append(
                HANDOFF.run(
                    LEAD,
                    recorded["event"],
                    base=self.base,
                    rooms=lambda b, s: [room()],
                    launcher=self.launcher,
                    deliver=self.deliver,
                )
            )

        threads = [threading.Thread(target=attempt) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(result["status"] for result in results).count("skipped"), 3)
        self.assertEqual(len(self.launched), 1)
        # Racing hooks record one event; after the window the fenced old lead still gets no second successor.
        self.assertEqual(self.stop_failure()["status"], "duplicate")
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            self.assertEqual(self.stop_failure()["reason"], "already handed over")
        # Even a forged second event for the room cannot appoint again: the team now has another lead.
        HANDOFF.save_event(
            HANDOFF.session_dir(LEAD),
            {**json.loads((HANDOFF.session_dir(LEAD) / "event.json").read_text()), "id": "e2", "status": "recorded"},
        )
        again = HANDOFF.run(
            LEAD, "e2", base=self.base, rooms=lambda b, s: [room()], launcher=self.launcher, deliver=self.deliver
        )
        self.assertEqual(again["status"], "ignored")
        self.assertEqual(len(self.launched), 1)

    def test_racing_hooks_record_one_event(self) -> None:
        barrier = threading.Barrier(6)
        results = []

        def attempt():
            barrier.wait()
            results.append(self.stop_failure()["status"])

        threads = [threading.Thread(target=attempt) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(results), ["duplicate"] * 5 + ["recorded"])
        self.assertEqual(len(self.spawned), 1)

    def test_a_successor_that_runs_out_hands_over_again_up_to_the_chain_limit(self) -> None:
        self.register(PEER, "claude-b")
        self.assertEqual(self.handoff()["status"], "handed-over")
        self.accept("room-r1", PEER)
        # The successor runs out in turn: the default names its successor too, on a third account.
        self.set_lane("claude-b", status="blocked", usable=0)
        self.set_lane("claude-c", status="available", usable=70)
        self.register(THIRD, "claude-c")
        second = self.handoff(PEER, rooms=[])
        self.assertEqual(second["status"], "handed-over", second)
        self.assertEqual(second["chain"], {"origin": LEAD, "count": 2})
        record = AUTHORITY.load(AUTHORITY.team_dir("room-r1"))
        self.assertEqual((record["status"], record["lead"]["session"]), ("pending", THIRD))
        # The third successor has been handed over to three times from the original: it stops there.
        HANDOFF.write_private(
            HANDOFF.root() / "successors" / f"{THIRD}.json", json.dumps({"origin": LEAD, "count": 3, "team": "room-r1"})
        )
        self.accept("room-r1", THIRD)
        self.set_lane("claude-c", status="blocked", usable=0)
        third = self.handoff(THIRD, rooms=[])
        self.assertEqual(third["status"], "refused")
        self.assertIn("handed over 3 times already from session claude-lead-session", third["reasons"][0])
        self.assertIn(f"handoff.py show --session {THIRD}", third["notice"])
        self.assertEqual(AUTHORITY.load(AUTHORITY.team_dir("room-r1"))["lead"]["session"], THIRD)

    def test_a_rate_limit_with_room_left_is_no_handoff(self) -> None:
        self.set_lane("claude-a", status="available", usable=50)
        self.register(PEER, "claude-b")
        event = self.handoff()
        self.assertEqual(event["status"], "not-exhausted")
        self.assertNotIn("notice", event)
        self.assertIsNone(AUTHORITY.load(AUTHORITY.team_dir("room-r1")))
        self.assertEqual(self.delivered, [])

    def test_a_session_that_leads_nothing_is_left_alone(self) -> None:
        event = self.handoff(rooms=[])
        self.assertEqual((event["status"], event["reasons"]), ("ignored", ["not a team lead or room conductor"]))
        self.assertFalse((HANDOFF.session_dir(LEAD) / "note.md").exists())

    def test_a_user_team_without_a_standing_rule_needs_the_user(self) -> None:
        AUTHORITY.appoint(
            "team", {**AUTHORITY.member(LEAD, "claude"), "pool": "claude-a:all"}, repository=self.lead["repo"]
        )
        self.register(PEER, "claude-b")
        event = self.handoff(rooms=[])
        self.assertEqual(event["status"], "refused")
        self.assertIn("no standing takeover rule", event["reasons"][0])
        self.assertIn("appoint --team team --expect-generation 1 --lead-session SESSION", event["notice"])
        self.assertEqual(AUTHORITY.load(AUTHORITY.team_dir("team"))["status"], "active")

    def test_an_unknown_billing_context_refuses_and_tells_the_user(self) -> None:
        self.config["accounts"][0]["billing"] = None
        self.write()
        self.register(PEER, "claude-b")
        event = self.handoff()
        self.assertEqual(event["status"], "refused")
        self.assertIn("billing context", event["reasons"][0])
        self.assertIsNone(AUTHORITY.load(AUTHORITY.team_dir("room-r1")))
        other = self.register("claude-other", "claude-b", state="busy")
        notice = HANDOFF.notices(self.base, other)
        self.assertIn(f"{LEAD}) ran out of usage (rate_limit) and was not handed over", notice)
        self.assertIn(f"handoff.py show --session {LEAD}", notice)
        self.assertEqual(HANDOFF.notices(self.base, other), "")  # once per session
        elsewhere = self.root / "elsewhere"
        subprocess.run(["git", "init", "-q", str(elsewhere)], check=True)
        self.assertEqual(HANDOFF.notices(self.base, self.register("claude-elsewhere", "claude-b", cwd=elsewhere)), "")

    def test_the_next_turn_in_the_repository_shows_the_notice(self) -> None:
        with mock.patch.object(
            HANDOFF, "settings", return_value={"enabled": True, "autoLaunch": False, "excludeAccounts": []}
        ):
            event = self.handoff()
        self.assertIn("auto-launch is off", event["reasons"][0])
        self.register("claude-other", "claude-b", state="busy")
        payload = {"hook_event_name": "UserPromptSubmit", "session_id": "claude-other", "cwd": str(self.repo)}
        output = ORK_FAST.run_mailbox_hook(
            payload,
            harness="claude",
            base=self.base,
            pid=os.getpid(),
            env={**os.environ, "CLAUDE_CONFIG_DIR": str(self.homes["claude-b"]), "PYTEST_CURRENT_TEST": "1"},
        )
        self.assertIn(
            "was not handed over: no live idle session",
            (output or {}).get("hookSpecificOutput", {}).get("additionalContext", ""),
        )

    def test_the_note_holds_facts_only_and_is_private(self) -> None:
        (self.repo / "dirty.txt").write_text("x")
        MAILBOX.write(
            self.base / "progress" / f"{MAILBOX.session_key(LEAD)}.json",
            {
                "schema": "orchestrate.progress.v1",
                "session": LEAD,
                "goal": "Ship the handoff",
                "task": "tests",
                "stage": "working",
            },
        )
        task_dir = self.root / "task-1"
        task_dir.mkdir()
        (task_dir / "task.json").write_text(
            json.dumps(
                {
                    "schema": "agent-executor.task.v1",
                    "task_id": "t1",
                    "status": "active",
                    "repository": str(self.repo),
                    "task_spec": {"objective": "Write tests"},
                    "runs": [{"run_id": "run-1", "kind": "implementation", "engine": "codex", "status": "active"}],
                }
            )
        )
        agents = [{"id": "worker-1", "dispatch": {"taskDir": str(task_dir), "taskId": "t1"}}]
        event = self.handoff(rooms=[room(agents=agents)])
        note_path = HANDOFF.session_dir(LEAD) / "note.md"
        note = note_path.read_text()
        head = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"], capture_output=True, text=True
        ).stdout.strip()
        for fact in (
            "Recorded facts only",
            "- goal: Ship the handoff",
            "- Branch: main",
            f"- HEAD: {head}",
            "?? dirty.txt",
            "## Room r1",
            "Conductor binding: session claude-lead-session",
            "Task t1 for worker-1: active; Write tests; live runs: run-1 (implementation, codex, active)",
            "- Previous transcript: " + str(self.root / "t.jsonl"),
            "- Error: 429 Too Many Requests",
        ):
            self.assertIn(fact, note)
        self.assertEqual(stat.S_IMODE(note_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((HANDOFF.session_dir(LEAD) / "event.json").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(HANDOFF.session_dir(LEAD).stat().st_mode), 0o700)
        # The room's task joins the team, so the successor's show lists its live run.
        record = AUTHORITY.load(AUTHORITY.team_dir(event["team"]))
        self.assertEqual(record["tasks"], [str(task_dir.resolve())])

    # Review fixes: each of these fails on the first version of the handoff.

    def coordinator_task(self, name="task-1"):
        spec = self.root / f"{name}-spec.json"
        spec.write_text(
            json.dumps(
                {
                    "objective": "Fence it",
                    "repository_root": str(self.repo),
                    "current_state": "start",
                    "pre_existing_changes": [],
                    "plan": ["read"],
                    "allow_paths": ["README.md"],
                    "track_paths": [],
                    "development_checks": [],
                    "acceptance_criteria": ["done"],
                }
            )
        )
        task_dir = self.root / name
        self.coordinator("init", "--task-dir", str(task_dir), "--task-spec", str(spec), "--host", "claude", check=True)
        return task_dir

    def coordinator(self, *args, check=False):
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPTS / "coordinator.py"), *args],
            capture_output=True,
            text=True,
            check=check,
        )

    def store_room(self, room_id="r1", session=LEAD, **fields):
        stored = {"schema": "orkest.room.v1", **room(room_id, session), **fields}
        HANDOFF.module("room_store").put_room(self.base, stored)
        return stored

    def test_the_superseded_lead_is_refused_on_its_room_tasks_and_the_room_joins_the_team(self) -> None:
        (self.repo / "README.md").write_text("hi\n")
        task_dir = self.coordinator_task()
        self.store_room(agents=[{"id": "worker-1", "dispatch": {"taskDir": str(task_dir)}}])
        self.register(PEER, "claude-b")
        recorded = self.stop_failure()
        event = HANDOFF.run(LEAD, recorded["event"], base=self.base, deliver=self.deliver, sleep=self.sleeps.append)
        self.assertEqual(event["status"], "handed-over", event)
        self.assertEqual(json.loads((task_dir / "task.json").read_text())["authority"]["team"], "room-r1")
        self.assertEqual(HANDOFF.module("room_store").read_room(self.base, "r1")["authority"], "room-r1")
        capture = ["capture", "--task-dir", str(task_dir), "--path", str(self.repo / "README.md")]
        capture += ["--source-kind", "check", "--component", "probe", "--version", "1"]
        for flags in (["--lead-session", LEAD, "--lead-generation", "1"], []):
            refused = self.coordinator(*capture, *flags)
            self.assertEqual(refused.returncode, 2, refused.stdout)
            self.assertRegex(refused.stderr, "superseded|belongs to a team")
        # The successor acts once it has accepted.
        accepted = self.accept("room-r1", PEER)
        done = self.coordinator(*capture, "--lead-session", PEER, "--lead-generation", str(accepted["generation"]))
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_a_failed_delivery_and_the_room_behind_a_team_never_make_a_second_successor(self) -> None:
        AUTHORITY.appoint(
            "alpha",
            {**AUTHORITY.member(LEAD, "claude"), "pool": "claude-a:all"},
            deputy={"harness": "claude", "pool": "claude-b:all", "account": "claude-b"},
            standing={"statuses": ["blocked"], "seconds": 0},
            repository=self.lead["repo"],
        )
        self.register(PEER, "claude-b")
        self.register(THIRD, "claude-b")

        def broken(*_):
            raise RuntimeError("wake failed")

        first = self.handoff(rooms=[room(authority="alpha")], deliver=broken)
        self.assertEqual((first["status"], first["takenOver"]), ("failed", True), first)
        self.assertIn("is fenced: team alpha was taken over", first["notice"])
        self.assertIn("appoint --team alpha --expect-generation 2", first["notice"])
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            self.assertEqual(self.stop_failure()["reason"], "already handed over")
        HANDOFF.save_event(
            HANDOFF.session_dir(LEAD),
            {**json.loads((HANDOFF.session_dir(LEAD) / "event.json").read_text()), "id": "e2", "status": "recorded"},
        )
        again = HANDOFF.run(
            LEAD, "e2", base=self.base, rooms=lambda b, s: [room(authority="alpha")], deliver=self.deliver
        )
        self.assertEqual(again["status"], "ignored", again)
        self.assertIsNone(AUTHORITY.load(AUTHORITY.team_dir("room-r1")))
        self.assertEqual(self.delivered, [])

    def test_a_slow_handoff_is_neither_duplicated_nor_overwritten(self) -> None:
        recorded = self.stop_failure()
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        replaced = {}

        def slow_launch(command, env):
            with mock.patch.object(HANDOFF, "now", return_value=later):
                replaced["while running"] = self.stop_failure()
            # Past the stale-run window a new event replaces this one; this run must not write over it.
            directory = HANDOFF.session_dir(LEAD)
            HANDOFF.save_event(
                directory, {**json.loads((directory / "event.json").read_text()), "id": "e2", "status": "recorded"}
            )
            return self.launcher(command, env)

        finished = HANDOFF.run(
            LEAD,
            recorded["event"],
            base=self.base,
            rooms=lambda b, s: [room()],
            launcher=slow_launch,
            sleep=self.sleeps.append,
        )
        self.assertEqual(finished["status"], "handed-over")
        self.assertEqual(replaced["while running"]["reason"], "its handoff is still running")
        current = json.loads((HANDOFF.session_dir(LEAD) / "event.json").read_text())
        self.assertEqual((current["id"], current["status"]), ("e2", "recorded"))
        history = (HANDOFF.session_dir(LEAD) / "history.jsonl").read_text().splitlines()
        self.assertEqual(json.loads(history[-1])["status"], "handed-over")

    def test_a_refused_takeover_leaves_no_team_behind_and_a_later_one_still_works(self) -> None:
        # On credits a live lead can still act: the takeover refuses before anything is written.
        self.set_lane("claude-a", status="credits")
        with mock.patch.object(AUTHORITY, "appoint", wraps=AUTHORITY.appoint) as appointed:
            refused = self.handoff()
        appointed.assert_not_called()
        self.assertEqual(refused["status"], "refused", refused)
        self.assertIn("on credits only the user can approve", refused["reasons"][0])
        self.assertIsNone(AUTHORITY.load(AUTHORITY.team_dir("room-r1")))
        # A pool already past its reset refuses the same way.
        self.set_lane("claude-a", status="blocked", blockedUntil="2000-01-01T00:00:00Z")
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            self.assertIn("already reset", self.handoff()["reasons"][0])
        self.assertIsNone(AUTHORITY.load(AUTHORITY.team_dir("room-r1")))
        self.set_lane("claude-a", blockedUntil=None)
        with mock.patch.object(HANDOFF, "now", return_value=later + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)):
            self.assertEqual(self.handoff()["status"], "handed-over")

    def test_a_takeover_refused_after_the_appointment_is_undone(self) -> None:
        task_dir = self.coordinator_task()
        agents = [{"id": "worker-1", "dispatch": {"taskDir": str(task_dir)}}]
        with mock.patch.object(AUTHORITY, "takeover", side_effect=AUTHORITY.AuthorityError("lost a race")):
            event = self.handoff(rooms=[room(agents=agents)])
        self.assertEqual((event["status"], event["reasons"], event["team"]), ("refused", ["lost a race"], None))
        self.assertIsNone(AUTHORITY.load(AUTHORITY.team_dir("room-r1")))
        self.assertNotIn("authority", json.loads((task_dir / "task.json").read_text()))
        self.assertEqual(self.launched, [])

    def test_a_standing_rule_that_asks_for_quiet_waits_for_it(self) -> None:
        AUTHORITY.appoint(
            "quiet",
            {**AUTHORITY.member(LEAD, "claude"), "pool": "claude-a:all"},
            deputy={"harness": "claude", "pool": "claude-b:all", "account": "claude-b"},
            standing={"statuses": ["blocked"], "seconds": 300},
            repository=self.lead["repo"],
        )
        self.register(PEER, "claude-b")
        clock = [SUCCESSION.now()]

        def sleep(seconds):
            self.sleeps.append(seconds)
            clock[0] += dt.timedelta(seconds=seconds)

        with mock.patch.object(SUCCESSION, "now", side_effect=lambda: clock[0]):
            event = self.handoff(rooms=[], sleep=sleep)
        self.assertEqual(event["status"], "handed-over", event)
        self.assertGreater(sum(self.sleeps), 290)
        self.assertEqual(AUTHORITY.load(AUTHORITY.team_dir("quiet"))["lead"]["session"], PEER)

    def test_stale_or_unknown_monitor_data_refuses_with_a_notice_after_fresh_rechecks(self) -> None:
        self.set_lane("claude-a", status="available", usable=80, stale=True)
        event = self.handoff()
        self.assertEqual(event["status"], "refused", event)
        self.assertIn("stale or unknown", event["reasons"][0])
        self.assertIn("was not handed over", event["notice"])
        self.assertEqual(self.sleeps, list(HANDOFF.RECHECK_SECONDS))

    def test_monitor_lagging_behind_the_429_is_read_again_before_calling_it_a_burst(self) -> None:
        self.register(PEER, "claude-b")
        views = []

        def fetch():
            self.set_lane("claude-a", status="available" if not views else "blocked", usable=40 if not views else 0)
            views.append(1)
            return SUCCESSION.fresh_view()

        event = self.handoff(fetch=fetch)
        self.assertEqual(event["status"], "handed-over", event)
        self.assertEqual(self.sleeps, [HANDOFF.RECHECK_SECONDS[0]])
        # The forced refresh asks monitor to query the providers.
        with mock.patch.object(subprocess, "run", wraps=subprocess.run) as ran:
            self.assertIsNotNone(HANDOFF.refreshed_view())
        self.assertEqual(ran.call_args.args[0][1:], ["json", "--refresh"])

    def test_a_named_deputy_pool_and_malformed_config_are_honoured(self) -> None:
        self.lanes.append(lane("claude-b", "fable", status="low", usable=5))
        self.write()
        AUTHORITY.appoint(
            "pools",
            {**AUTHORITY.member(LEAD, "claude"), "pool": "claude-a:all"},
            deputy={"harness": "claude", "pool": "claude-b:fable", "account": "claude-b"},
            standing={"statuses": ["blocked"], "seconds": 0},
            repository=self.lead["repo"],
        )
        self.register(PEER, "claude-b")
        event = self.handoff(rooms=[])
        self.assertEqual(event["status"], "refused", event)
        self.assertEqual(AUTHORITY.load(AUTHORITY.team_dir("pools"))["lead"]["session"], LEAD)
        self.config["accounts"].append({"provider": "claude", "billing": "personal"})
        self.write()
        choice = self.choose()
        self.assertIn("an account without an id", choice["refusals"][0])

    def test_a_launch_needs_a_config_dir_a_free_checkout_and_its_root(self) -> None:
        # Without configDir the runner would run Claude's default profile and its quota check could misroute.
        del self.config["accounts"][1]["configDir"]
        self.write()
        self.assertEqual(self.choose()["successor"]["account"], "codex")
        # Even when the runner's quota check would happen to land on that account.
        quota = SUCCESSION.module("quota")
        routed = {"status": "available"}
        with mock.patch.object(
            quota,
            "check",
            side_effect=lambda engine, *_, **__: {**routed, "accountId": "claude-b" if engine == "claude" else "codex"},
        ):
            self.assertEqual(self.choose()["successor"]["account"], "codex")
        self.config["accounts"][1]["configDir"] = str(self.homes["claude-b"])
        self.write()
        # Another executor holding the checkout would make the launch fail after the fence: refuse first.
        support = HANDOFF.module("execution_support")
        with support.workspace_lease(self.repo, HANDOFF.module("runtime_paths").cache_home(), read_only=True):
            event = self.handoff()
        self.assertEqual(event["status"], "refused", event)
        self.assertIn("another executor owns the worktree", event["reasons"][0])
        self.assertIsNone(AUTHORITY.load(AUTHORITY.team_dir("room-r1")))
        self.assertEqual(self.launched, [])
        # A launch that still fails after the fence leaves the user a notice and the way back.
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            failed = self.handoff(launcher=lambda *_: {"exitCode": 27, "output": "busy"})
        self.assertEqual((failed["status"], failed["takenOver"]), ("failed", True), failed)
        self.assertIn("Nothing is continuing its work", failed["notice"])
        self.assertIn("appoint --team room-r1 --expect-generation 2", failed["notice"])

    def test_a_fresh_successor_chains_from_a_subdirectory_without_a_mailbox_record(self) -> None:
        subdir = self.repo / "sub"
        subdir.mkdir()
        HANDOFF.write_private(
            HANDOFF.root() / "successors" / "handoff-sub1.json",
            json.dumps(
                {"origin": LEAD, "count": 1, "team": "t-sub", "harness": "claude", "model": OPUS}
                | {"accountHome": str(self.homes["claude-a"])}
            ),
        )
        AUTHORITY.appoint(
            "t-sub",
            {**AUTHORITY.member("handoff-sub1", "claude"), "pool": "claude-a:all"},
            deputy={"harness": "claude", "pool": "claude-b:all", "account": "claude-b"},
            standing={"statuses": ["blocked"], "seconds": 0},
            repository=self.lead["repo"],
        )
        payload = {
            "hook_event_name": "StopFailure",
            "session_id": "native-x",
            "cwd": str(subdir),
            "error": "rate_limit",
        }
        with mock.patch.dict(os.environ, {"ORKEST_HANDOFF_SUCCESSOR": "handoff-sub1"}):
            recorded = HANDOFF.stop_failure(self.base, payload, "native-x", "claude", spawn=self.spawn)
        self.assertEqual(recorded["status"], "recorded", recorded)
        event = HANDOFF.run(
            "handoff-sub1", recorded["event"], base=self.base, rooms=lambda b, s: [], launcher=self.launcher
        )
        self.assertEqual(event["status"], "handed-over", event)
        [(command, _)] = self.launched
        self.assertEqual(command[command.index("--cwd") + 1], str(self.repo.resolve()))
        self.assertEqual(event["repo"], self.lead["repo"])

    def test_the_successor_identity_reaches_the_successor_alone(self) -> None:
        with mock.patch.dict(os.environ, {"ORKEST_HANDOFF_LAUNCH": "handoff-a", "ORKEST_HANDOFF_SUCCESSOR": "old"}):
            env = RUNNER.executor_environment("claude")
        self.assertEqual(env["ORKEST_HANDOFF_SUCCESSOR"], "handoff-a")
        self.assertNotIn("ORKEST_HANDOFF_LAUNCH", env)
        with mock.patch.dict(os.environ, {"ORKEST_HANDOFF_SUCCESSOR": "handoff-a"}):
            self.assertNotIn("ORKEST_HANDOFF_SUCCESSOR", RUNNER.executor_environment("codex"))
        HANDOFF.write_private(
            HANDOFF.root() / "successors" / "handoff-a.json", json.dumps({"origin": LEAD, "count": 1, "team": "t"})
        )
        codex = MAILBOX.register(
            self.base, session="codex-native", harness="codex", cwd=str(self.repo), pid=os.getpid(), account="/x"
        )
        codex = MAILBOX.annotate(self.base, "codex-native", delegatedRun="run-1")
        self.set_lane("codex", status="blocked", usable=0)
        child = {"session": "run-y-worker", "run": "y", "role": "worker", "harness": "claude"}
        with mock.patch.dict(os.environ, {"ORKEST_HANDOFF_SUCCESSOR": "handoff-a"}):
            # A delegated Codex successor still runs the periodic check, as itself.
            HANDOFF.poll(self.base, codex, spawn=self.spawn)
            spy_scripts = self.root / "handoff-spy-scripts"
            spy_scripts.mkdir(exist_ok=True)
            spy_log = self.root / "handoff-spy.jsonl"
            (spy_scripts / "handoff.py").write_text(
                textwrap.dedent(
                    f"""\
                    import json
                    def poll(base, me, **kwargs):
                        with open({str(spy_log)!r}, "a", encoding="utf-8") as fh:
                            fh.write(json.dumps({{"fn": "poll", "session": me.get("session")}}) + "\\n")
                        return None
                    def notices(base, me, **kwargs):
                        return ""
                    """
                )
            )
            MAILBOX.register(self.base, session="run-1-worker", harness="codex", cwd=str(self.repo), pid=os.getpid())
            MAILBOX.annotate(self.base, "run-1-worker", run="1", role="worker")
            turn = {"hook_event_name": "UserPromptSubmit", "session_id": "codex-native", "cwd": str(self.repo)}
            # Clear the poll cooldown left by HANDOFF.poll() above so the hook evaluates polling directly.
            MAILBOX.annotate(self.base, "codex-native", handoffCheckedAt=None)
            # Without ORKEST_HANDOFF_SUCCESSOR, a delegatedRun peer skips handoff.poll on UserPromptSubmit.
            env_without = {k: v for k, v in os.environ.items() if k != "ORKEST_HANDOFF_SUCCESSOR"} | {
                "CODEX_HOME": "/x",
                "AGENT_MAILBOX_SESSION": "run-1-worker",
                "ORKEST_SCRIPTS_DIR": str(spy_scripts),
                "PYTEST_CURRENT_TEST": "1",
            }
            ORK_FAST.run_mailbox_hook(turn, harness="codex", base=self.base, pid=os.getpid(), env=env_without)
            self.assertFalse(spy_log.exists())
            # With ORKEST_HANDOFF_SUCCESSOR, a delegatedRun peer runs handoff.poll on UserPromptSubmit.
            MAILBOX.annotate(self.base, "codex-native", handoffCheckedAt=None)
            env_with = {**env_without, "ORKEST_HANDOFF_SUCCESSOR": "handoff-a"}
            ORK_FAST.run_mailbox_hook(turn, harness="codex", base=self.base, pid=os.getpid(), env=env_with)
            self.assertTrue(spy_log.is_file())
            self.assertEqual(
                [json.loads(line)["session"] for line in spy_log.read_text().splitlines()], ["codex-native"]
            )
            # A worker of the successor is never taken for it.
            ignored = HANDOFF.record_exhaustion(
                "run-y-worker", "claude", "rate_limit", source="StopFailure", peer=child
            )
        self.assertEqual([session for session, _ in self.spawned], ["handoff-a"])
        self.assertEqual(ignored["status"], "ignored")
        self.assertEqual(
            HANDOFF.record_exhaustion("../x", "claude", "rate_limit", source="t", peer={"session": "x"})["status"],
            "ignored",
        )

    def test_notices_say_when_a_peer_was_not_woken_and_last_a_day_from_the_outcome(self) -> None:
        self.register(PEER, "claude-b")
        event = self.handoff(deliver=lambda *_: {"message": "m1", "wake": "queued", "wakeReason": "unrelated task"})
        self.assertIn("not woken (queued: unrelated task)", event["notice"])
        self.assertNotIn("woken with", event["notice"])
        start = HANDOFF.now()
        viewers = [self.register(f"claude-viewer-{index}", "claude-b", state="busy") for index in range(52)]
        self.assertTrue(HANDOFF.notices(self.base, viewers[0], start + dt.timedelta(hours=23)))
        for viewer in viewers[1:51]:
            HANDOFF.notices(self.base, viewer, start + dt.timedelta(hours=23))
        self.assertEqual(HANDOFF.notices(self.base, viewers[0], start + dt.timedelta(hours=23)), "")
        self.assertEqual(HANDOFF.notices(self.base, viewers[51], start + dt.timedelta(hours=25)), "")

    def test_a_notice_recorded_before_the_checkout_moved_names_the_current_script(self) -> None:
        self.register(PEER, "claude-b")
        self.handoff(deliver=lambda *_: {"message": "m1", "wake": "queued", "wakeReason": "unrelated task"})
        path = HANDOFF.session_dir(LEAD) / "event.json"
        event = json.loads(path.read_text())
        old = "/old/plugins/orchestrate/skills/orchestrate/scripts/handoff.py"
        event["notice"] = event["notice"].replace(HANDOFF.script("handoff.py"), old)
        path.write_text(json.dumps(event))
        self.assertIn(old, json.loads(path.read_text())["notice"])
        viewer = self.register("claude-viewer-moved", "claude-b", state="busy")
        shown = HANDOFF.notices(self.base, viewer)
        self.assertIn(HANDOFF.script("handoff.py"), shown)
        self.assertNotIn(old, shown)
        self.assertNotIn(old, HANDOFF.show(LEAD))
        # An old or partial event keeps its saved text.
        partial = {"notice": "saved text"}
        self.assertEqual(HANDOFF.current_notice(partial), "saved text")

    def test_a_conductor_rebound_away_from_a_room_no_longer_conducts_it(self) -> None:
        self.store_room("r-rebound", "new-conductor")
        stored = HANDOFF.module("room_store").read_room(self.base, "r-rebound")
        stored["conductor"]["previousSessions"] = [LEAD]
        HANDOFF.module("room_store").put_room(self.base, stored)
        self.assertEqual(HANDOFF.conducted_rooms(self.base, LEAD), [])
        self.assertEqual([r["id"] for r in HANDOFF.conducted_rooms(self.base, "new-conductor")], ["r-rebound"])

    def test_enable_and_disable_wait_for_the_handoff_lock(self) -> None:
        done = threading.Event()
        with HANDOFF.locked(HANDOFF.root()):
            thread = threading.Thread(target=lambda: (HANDOFF.set_enabled(False), done.set()))
            thread.start()
            self.assertFalse(done.wait(0.3))
        thread.join(5)
        self.assertTrue(done.is_set())
        self.assertFalse(HANDOFF.settings()["enabled"])

    # Settings and commands

    def cli(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = HANDOFF.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_opt_out_is_honoured_by_every_path(self) -> None:
        (self.root / "orkest-config.json").write_text(json.dumps({"auto_update": {"enabled": True}}))
        code, output, _ = self.cli("disable")
        self.assertEqual(code, 0)
        self.assertFalse(json.loads(output)["enabled"])
        saved = json.loads((self.root / "orkest-config.json").read_text())
        self.assertEqual(saved, {"auto_update": {"enabled": True}, "handoff": {"enabled": False}})
        self.assertEqual(self.stop_failure()["status"], "disabled")
        codex = MAILBOX.register(
            self.base, session="codex-lead", harness="codex", cwd=str(self.repo), pid=os.getpid(), account="/x"
        )
        self.set_lane("codex", status="blocked", usable=0)
        HANDOFF.poll(self.base, codex, spawn=self.spawn)
        self.assertEqual(self.spawned, [])
        HANDOFF.save_event(
            HANDOFF.session_dir(LEAD),
            {
                "id": "e1",
                "session": LEAD,
                "status": "recorded",
                "harness": "claude",
                "reason": "rate_limit",
                "repo": self.lead["repo"],
                "notice": "x",
            },
        )
        self.assertEqual(HANDOFF.run(LEAD, "e1", base=self.base, rooms=lambda b, s: [room()])["status"], "ignored")
        self.assertEqual(HANDOFF.notices(self.base, self.register("claude-other", "claude-b")), "")
        self.assertEqual(json.loads(self.cli("enable")[1])["enabled"], True)
        (self.root / "orkest-config.json").write_text(
            json.dumps({"handoff": {"autoLaunch": False, "excludeAccounts": ["codex", 3]}})
        )
        self.assertEqual(HANDOFF.settings(), {"enabled": True, "autoLaunch": False, "excludeAccounts": ["codex"]})

    def test_status_and_show(self) -> None:
        self.register(PEER, "claude-b")
        self.handoff()
        code, output, _ = self.cli("status")
        self.assertEqual(code, 0)
        status = json.loads(output)
        self.assertTrue(status["settings"]["enabled"])
        [entry] = status["events"]
        self.assertEqual((entry["session"], entry["status"], entry["successor"]), (LEAD, "handed-over", PEER))
        code, output, _ = self.cli("show", "--session", LEAD)
        self.assertEqual(code, 0)
        self.assertIn("# Handoff note for session claude-lead-session", output)
        self.assertIn('"status": "handed-over"', output)
        code, _, error = self.cli("show", "--session", "nobody")
        self.assertEqual(code, 2)
        self.assertIn("no handoff is recorded", error)

    # Review #2 regressions

    def team_with_standing_rule(self, team="alpha", seconds=0):
        return AUTHORITY.appoint(
            team,
            {**AUTHORITY.member(LEAD, "claude"), "pool": "claude-a:all"},
            deputy={"harness": "claude", "pool": "claude-b:all", "account": "claude-b"},
            standing={"statuses": ["blocked"], "seconds": seconds},
            repository=self.lead["repo"],
        )

    def test_a_running_handoff_without_a_recorded_runner_is_never_taken_as_gone(self) -> None:
        self.assertFalse(HANDOFF.runner_gone({}))
        self.assertFalse(HANDOFF.runner_gone({"runner": None}))
        self.assertFalse(HANDOFF.runner_gone({"runner": {"birth": "x"}}))
        self.assertFalse(HANDOFF.runner_gone({"runner": {"pid": True}}))
        self.assertFalse(HANDOFF.runner_gone({"runner": {"pid": os.getpid()}}))
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        self.assertTrue(HANDOFF.runner_gone({"runner": {"pid": dead.pid}}))
        # run() records its own process, start time included, when it claims the event.
        claimed = {}

        def watch(*_args, **_kwargs):
            claimed.update(json.loads((HANDOFF.session_dir(LEAD) / "event.json").read_text()))
            return {"status": "ignored", "reasons": ["test"]}

        recorded = self.stop_failure()
        with mock.patch.object(HANDOFF, "handoff", side_effect=watch):
            HANDOFF.run(LEAD, recorded["event"], base=self.base)
        self.assertEqual(claimed["runner"]["pid"], os.getpid())
        self.assertEqual(claimed["runner"]["birth"], MAILBOX.process_started(os.getpid()))

    def test_the_checkout_and_repository_are_kept_when_the_handoff_crashes(self) -> None:
        subdir = self.repo / "deep"
        subdir.mkdir()
        # A record with neither the checkout's root nor its repository: only Git knows them.
        recorded = HANDOFF.record_exhaustion(
            "bare", "claude", "rate_limit", source="t", peer={"session": "bare", "cwd": str(subdir)}, spawn=self.spawn
        )
        self.assertEqual(recorded["status"], "recorded", recorded)
        seen = {}

        def crash(event, **_):
            seen.update(json.loads((HANDOFF.session_dir("bare") / "event.json").read_text()))
            raise RuntimeError("after the takeover")

        with mock.patch.object(HANDOFF, "handoff", side_effect=crash):
            finished = HANDOFF.run("bare", recorded["event"], base=self.base)
        self.assertEqual((seen["checkout"], seen["repo"]), (str(self.repo.resolve()), self.lead["repo"]))
        self.assertEqual(finished["status"], "failed")
        self.assertEqual((finished["checkout"], finished["repo"]), (str(self.repo.resolve()), self.lead["repo"]))
        # So the repository's other sessions are told.
        self.assertIn("RuntimeError: after the takeover", HANDOFF.notices(self.base, self.register(PEER, "claude-b")))

    def test_an_existing_team_fences_its_rooms_and_a_refused_takeover_releases_only_that(self) -> None:
        self.team_with_standing_rule()
        task_dir = self.coordinator_task()
        self.store_room(agents=[{"id": "worker-1", "dispatch": {"taskDir": str(task_dir)}}])
        stored = HANDOFF.module("room_store").read_room(self.base, "r1")
        self.register(PEER, "claude-b")
        with (
            mock.patch.object(AUTHORITY, "takeover", side_effect=AUTHORITY.AuthorityError("lost a race")),
            mock.patch.object(SUCCESSION, "local_evidence", wraps=SUCCESSION.local_evidence) as judged,
            mock.patch.object(AUTHORITY, "withdraw", wraps=AUTHORITY.withdraw) as withdrawn,
        ):
            event = HANDOFF.run(
                LEAD,
                self.stop_failure()["event"],
                base=self.base,
                rooms=lambda *_: [stored],
                deliver=self.deliver,
                sleep=self.sleeps.append,
            )
        self.assertEqual((event["status"], event["reasons"], event["team"]), ("refused", ["lost a race"], "alpha"))
        # The evidence was judged on the tasks the fence was about to add.
        self.assertIn(str(task_dir.resolve()), judged.call_args.args[0]["tasks"])
        # The team the user appointed stays as it was: only what this handoff fenced is released.
        withdrawn.assert_not_called()
        record = AUTHORITY.load(AUTHORITY.team_dir("alpha"))
        self.assertEqual((record["generation"], record["lead"]["session"], record["tasks"]), (1, LEAD, []))
        self.assertEqual([entry["event"] for entry in record["log"]], ["appoint", "task", "unregister"])
        self.assertNotIn("authority", json.loads((task_dir / "task.json").read_text()))
        self.assertIsNone(HANDOFF.module("room_store").read_room(self.base, "r1").get("authority"))
        # Without the race the same team fences the room and its task, and takes over.
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            recorded = self.stop_failure()
        done = HANDOFF.run(
            LEAD, recorded["event"], base=self.base, rooms=lambda *_: [stored], deliver=self.deliver, sleep=id
        )
        self.assertEqual(done["status"], "handed-over", done)
        self.assertEqual(json.loads((task_dir / "task.json").read_text())["authority"]["team"], "alpha")
        self.assertEqual(HANDOFF.module("room_store").read_room(self.base, "r1")["authority"], "alpha")
        self.assertEqual(AUTHORITY.load(AUTHORITY.team_dir("alpha"))["tasks"], [str(task_dir.resolve())])

    def test_a_created_team_removed_after_a_refused_takeover_may_have_unregistered_tasks(self) -> None:
        AUTHORITY.appoint(
            "fresh",
            {**AUTHORITY.member(LEAD, "claude"), "pool": "claude-a:all"},
            deputy={"harness": "claude", "pool": "claude-b:all", "account": "claude-b"},
        )
        task_dir = self.coordinator_task()
        AUTHORITY.register_task("fresh", task_dir, LEAD, 1)
        AUTHORITY.unregister_tasks("fresh", [str(task_dir)], LEAD, 1)
        self.assertEqual(
            [entry["event"] for entry in AUTHORITY.load(AUTHORITY.team_dir("fresh"))["log"]],
            ["appoint", "task", "unregister"],
        )
        self.assertIsNone(AUTHORITY.withdraw("fresh", LEAD, 1, remove=True))
        self.assertIsNone(AUTHORITY.load(AUTHORITY.team_dir("fresh")))

    def test_peers_are_read_again_with_each_fresh_monitor_view(self) -> None:
        fetched = []

        def fetch():
            if fetched:  # the peer goes idle while monitor catches up with the 429
                self.register(PEER, "claude-b")
                self.set_lane("claude-a", status="blocked", usable=0)
            else:
                self.set_lane("claude-a", status="available", usable=40)
            fetched.append(1)
            return SUCCESSION.fresh_view()

        event = self.handoff(fetch=fetch)
        self.assertEqual(event["status"], "handed-over", event)
        self.assertEqual((event["successor"]["kind"], event["successor"]["session"]), ("peer", PEER))
        self.assertEqual(self.launched, [])

    def test_everything_is_read_again_after_waiting_for_the_lead_to_be_quiet(self) -> None:
        self.team_with_standing_rule("quiet", seconds=300)
        self.register(PEER, "claude-b")
        clock = [SUCCESSION.now()]

        def sleep(seconds):
            self.sleeps.append(seconds)
            clock[0] += dt.timedelta(seconds=seconds)
            if seconds > 200:  # the lead's pool resets during the wait
                self.set_lane("claude-a", status="available", usable=90)

        with mock.patch.object(SUCCESSION, "now", side_effect=lambda: clock[0]):
            event = self.handoff(rooms=[], sleep=sleep)
        self.assertEqual(event["status"], "not-exhausted", event)
        self.assertGreater(sum(self.sleeps), 290)
        record = AUTHORITY.load(AUTHORITY.team_dir("quiet"))
        self.assertEqual((record["generation"], record["lead"]["session"]), (1, LEAD))
        self.assertEqual(self.delivered, [])

    def test_the_checkout_is_checked_only_after_the_evidence_and_a_successor_waits_for_it(self) -> None:
        self.set_lane("claude-a", status="credits")
        with mock.patch.object(HANDOFF, "launch_problem", return_value=None) as checked:
            refused = self.handoff()
        self.assertEqual(refused["status"], "refused", refused)
        checked.assert_not_called()
        # A fresh successor's own run holds the checkout until it ends: its successor waits for the lease.
        HANDOFF.write_private(
            HANDOFF.root() / "successors" / f"{LEAD}.json", json.dumps({"origin": "first", "count": 1, "team": "x"})
        )
        self.set_lane("claude-a", status="blocked")
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with (
            mock.patch.object(HANDOFF, "now", return_value=later),
            mock.patch.object(HANDOFF, "launch_problem", return_value="busy") as checked,
        ):
            event = self.handoff()
        self.assertEqual((event["status"], event["reasons"]), ("refused", ["busy"]), event)
        self.assertEqual(checked.call_args.kwargs["wait"], HANDOFF.LEASE_WAIT_SECONDS)
        self.assertIsNone(AUTHORITY.load(AUTHORITY.team_dir("room-r1")))
        # Counted in polls through the injected sleep, never by the clock.
        polls = []
        support = HANDOFF.module("execution_support")
        with support.workspace_lease(self.repo, HANDOFF.module("runtime_paths").cache_home(), read_only=True):
            problem = HANDOFF.launch_problem(str(self.repo), wait=12, sleep=polls.append)
        self.assertIn("cannot start now", problem)
        self.assertEqual(polls, [HANDOFF.LEASE_POLL_SECONDS] * 3)

    def test_a_reappointed_successor_keeps_its_generation_until_the_takeover(self) -> None:
        self.register(PEER, "claude-b")
        self.assertEqual(self.handoff()["status"], "handed-over")
        accepted = self.accept("room-r1", PEER)["generation"]
        self.set_lane("claude-b", status="blocked", usable=0)
        self.set_lane("claude-c", status="available", usable=70)
        self.register(THIRD, "claude-c")
        with (
            mock.patch.object(AUTHORITY, "appoint", wraps=AUTHORITY.appoint) as appointed,
            mock.patch.object(AUTHORITY, "takeover", side_effect=AUTHORITY.AuthorityError("lost a race")),
        ):
            refused = self.handoff(PEER, rooms=[])
        appointed.assert_not_called()
        self.assertEqual((refused["status"], refused["generation"], refused["team"]), ("refused", accepted, "room-r1"))
        record = AUTHORITY.load(AUTHORITY.team_dir("room-r1"))
        self.assertEqual((record["generation"], record["lead"]["session"], record["deputy"]), (accepted, PEER, None))
        self.assertEqual([entry["event"] for entry in record["log"]][-2:], ["designate", "withdraw"])
        # The withdrawn designation still counts as the handoff's own: the next exhaustion is handed over.
        self.assertTrue(HANDOFF.handed_by_us(record, PEER))
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            second = self.handoff(PEER, rooms=[])
        self.assertEqual((second["status"], second["generation"]), ("handed-over", accepted + 1), second)

    def test_a_launch_that_lost_the_lease_is_tried_again(self) -> None:
        answers = [{"exitCode": 27, "output": "busy"}, {"exitCode": 0, "output": "detached"}]
        event = self.handoff(launcher=lambda *_: answers.pop(0))
        self.assertEqual(event["status"], "handed-over", event)
        self.assertEqual(event["delivery"]["attempts"], 2)
        self.assertEqual(self.sleeps[-1], HANDOFF.LAUNCH_RETRY_SECONDS[0])
        tries = []
        self.sleeps.clear()
        self.register("claude-other-lead", "claude-a")
        recorded = self.stop_failure("claude-other-lead")
        failed = HANDOFF.run(
            "claude-other-lead",
            recorded["event"],
            base=self.base,
            rooms=lambda *_: [room("r2", session="claude-other-lead")],
            launcher=lambda *_: tries.append(1) or {"exitCode": 27, "output": "busy"},
            sleep=self.sleeps.append,
        )
        self.assertEqual((failed["status"], failed["delivery"]["attempts"]), ("failed", 3), failed)
        self.assertEqual(len(tries), 3)
        self.assertEqual(self.sleeps[-2:], list(HANDOFF.LAUNCH_RETRY_SECONDS))
        self.assertIn("exit 27", failed["reasons"][0])

    def test_pending_antigravity_subagents_are_ignored_and_the_session_model_counts(self) -> None:
        self.assertEqual(HANDOFF.ignored_peer({"agySubagentPending": True}), "a subagent")
        ignored = HANDOFF.record_exhaustion(
            LEAD, "claude", "rate_limit", source="t", peer={**self.lead, "agySubagentPending": True}
        )
        self.assertEqual(ignored, {"status": "ignored", "reason": "a subagent"})
        # A peer whose current step runs a small model is still the capable session it is.
        MAILBOX.register(
            self.base,
            session=PEER,
            harness="claude",
            cwd=str(self.repo),
            pid=os.getpid(),
            state="idle",
            session_model=OPUS,
            step_model="claude-haiku-5-5",
            account=str(self.homes["claude-b"]),
        )
        peer = MAILBOX.load(MAILBOX.peer_path(self.base, PEER))
        peer["model"] = "claude-haiku-5-5"
        choice = self.choose(peers=[peer])
        self.assertEqual((choice["successor"]["session"], choice["successor"]["model"]), (PEER, OPUS))
        self.assertEqual(HANDOFF.session_model({"model": "m"}), "m")
        recorded = HANDOFF.record_exhaustion(
            THIRD,
            "claude",
            "rate_limit",
            source="t",
            peer={"session": THIRD, "sessionModel": OPUS, "model": "claude-haiku-5-5"},
            spawn=self.spawn,
        )
        event = json.loads((HANDOFF.session_dir(THIRD) / "event.json").read_text())
        self.assertEqual((recorded["status"], event["model"]), ("recorded", OPUS))

    def test_conducted_rooms_skips_inactive_closed_and_remote_rooms(self) -> None:
        self.store_room("active-local", session=LEAD)
        self.store_room("archived-room", session=LEAD, lifecycle="archived")
        self.store_room("cancelled-room", session=LEAD, lifecycle="cancelled")
        self.store_room("closed-at-room", session=LEAD, closedAt="2026-11-18T00:00:00Z")
        self.store_room("status-closed-room", session=LEAD, status="closed")
        self.store_room("status-cancelled-room", session=LEAD, status="cancelled")
        self.store_room("remote-room", session=LEAD, machine="other-host.local")
        self.store_room(
            "remote-binding-room",
            session=LEAD,
            conductor={"session": {"id": LEAD, "engine": "claude", "machine": "other-host.local"}},
        )
        self.assertEqual([r["id"] for r in HANDOFF.conducted_rooms(self.base, LEAD)], ["active-local"])

    def test_set_enabled_allows_empty_json_object_and_rejects_non_object(self) -> None:
        config_file = self.root / "orkest-config.json"
        config_file.write_text("{}\n")
        settings = HANDOFF.set_enabled(False)
        self.assertFalse(settings["enabled"])
        self.assertEqual(json.loads(config_file.read_text()), {"handoff": {"enabled": False}})
        config_file.write_text("[]\n")
        with self.assertRaisesRegex(ValueError, "not a JSON object"):
            HANDOFF.set_enabled(True)

    def test_chained_handoff_preserves_peer_session_for_note_evidence_and_deliver_peer(self) -> None:
        # A launched successor runs under native peer `native-chain-1` while its authority ID is `handoff-chain1`.
        native = self.register("native-chain-1", "claude-a")
        MAILBOX.annotate(self.base, native["session"], delegatedRun="run-launch-1")
        MAILBOX.write(
            self.base / "progress" / f"{MAILBOX.session_key(native['session'])}.json",
            {
                "schema": "orchestrate.progress.v1",
                "session": native["session"],
                "goal": "Chain handoff",
                "task": "Verify peerSession",
                "stage": "working",
            },
        )
        HANDOFF.write_private(
            HANDOFF.root() / "successors" / "handoff-chain1.json",
            json.dumps(
                {
                    "origin": LEAD,
                    "count": 1,
                    "team": "t-chain",
                    "harness": "claude",
                    "model": OPUS,
                    "accountHome": str(self.homes["claude-a"]),
                }
            ),
        )
        AUTHORITY.appoint(
            "t-chain",
            {**AUTHORITY.member("handoff-chain1", "claude"), "pool": "claude-a:all"},
            deputy={"harness": "claude", "pool": "claude-b:all", "account": "claude-b"},
            standing={"statuses": ["blocked", "credits"], "seconds": 0},
            repository=self.lead["repo"],
        )
        # Peer on claude-b has an unrelated focus/cwd: must still be chosen and woken via scope="cross-project".
        peer_b = self.register(PEER, "claude-b", state="idle")
        MAILBOX.annotate(self.base, peer_b["session"], focus="Unrelated focus", cwd=str(self.root / "other-cwd"))

        payload = {
            "hook_event_name": "StopFailure",
            "session_id": native["session"],
            "cwd": str(self.repo),
            "error": "rate_limit",
        }
        with mock.patch.dict(os.environ, {"ORKEST_HANDOFF_SUCCESSOR": "handoff-chain1"}):
            recorded = HANDOFF.stop_failure(self.base, payload, native["session"], "claude", spawn=self.spawn)
        self.assertEqual(recorded["status"], "recorded")
        stored_event = json.loads((HANDOFF.session_dir("handoff-chain1") / "event.json").read_text())
        self.assertEqual(stored_event.get("peerSession"), native["session"])

        # Real deliver_peer works with cross-project scope & native_unreachable, and on credits sees live native pid.
        self.set_lane("claude-a", status="credits", usable=0)
        refused_credits = HANDOFF.run(
            "handoff-chain1",
            recorded["event"],
            base=self.base,
            rooms=lambda *_: [],
            sleep=self.sleeps.append,
        )
        self.assertEqual(refused_credits["status"], "refused")
        self.assertIn("process is still running", refused_credits["reasons"][0])

        self.set_lane("claude-a", status="blocked", usable=0)
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with (
            mock.patch.dict(os.environ, {"ORKEST_HANDOFF_SUCCESSOR": "handoff-chain1"}),
            mock.patch.object(HANDOFF, "now", return_value=later),
        ):
            recorded2 = HANDOFF.record_exhaustion(
                native["session"],
                "claude",
                "rate_limit",
                source="StopFailure",
                peer=native,
                spawn=self.spawn,
            )
        # Remove the native peer record before delivery to ensure deliver_peer synthesizes a fallback sender.
        MAILBOX.peer_path(self.base, native["session"]).unlink()
        with mock.patch.object(MAILBOX, "delivery_wake", return_value={"status": "scheduled"}) as woken:
            delivered = HANDOFF.run(
                "handoff-chain1",
                recorded2["event"],
                base=self.base,
                rooms=lambda *_: [],
                sleep=self.sleeps.append,
            )
        self.assertEqual(delivered["status"], "handed-over", delivered)
        self.assertEqual(delivered["delivery"]["wake"], "scheduled")
        woken.assert_called_once()
        note = (HANDOFF.session_dir("handoff-chain1") / "note.md").read_text()
        self.assertIn("- goal: Chain handoff", note)
        self.assertIn("- task: Verify peerSession", note)

    # Chief quota exhaustion handover & OpenCode parity

    def write_chief(self, session=LEAD, **overrides):
        binding = {
            "schema": "ork.chief.v1",
            "session": session,
            "name": self.lead["name"],
            "engine": "claude",
            "model": OPUS,
            "cwd": str(self.repo),
            "machine": socket.gethostname(),
            "pid": os.getpid(),
            "pidBirth": MAILBOX.process_started(os.getpid()),
            "boundAt": HANDOFF.stamp(HANDOFF.now()),
            **overrides,
        }
        (self.base / "chief.json").write_text(json.dumps(binding) + "\n")
        return binding

    def test_blocked_chief_alone_produces_brief_ready_without_touching_chief_or_teams(self) -> None:
        self.assertEqual(HANDOFF.HARNESS_ENGINE.get("opencode"), "opencode")
        binding = self.write_chief()
        chief_before = (self.base / "chief.json").read_text()
        MAILBOX.write(
            self.base / "progress" / f"{MAILBOX.session_key(LEAD)}.json",
            {
                "schema": "orchestrate.progress.v1",
                "session": LEAD,
                "goal": "Coordinate wave1 rooms",
                "task": "Supervise builds",
                "stage": "working",
            },
        )
        event = self.handoff(rooms=[])
        self.assertEqual(event["status"], "brief-ready", event)
        self.assertIn("brief-ready", HANDOFF.FINAL)
        self.assertIsNone(event.get("team"))
        self.assertEqual(self.launched, [])
        self.assertEqual(self.delivered, [])
        self.assertEqual((self.base / "chief.json").read_text(), chief_before)
        authority_dir = AUTHORITY.cache_dir() / "authority-v1"
        self.assertEqual(list(authority_dir.glob("*")) if authority_dir.exists() else [], [])

        brief_path = Path(event["brief"])
        self.assertEqual(brief_path, HANDOFF.session_dir(LEAD) / "brief.md")
        self.assertEqual(stat.S_IMODE(brief_path.stat().st_mode), 0o600)
        brief_text = brief_path.read_text()
        for expected in (
            event["id"],
            event["recordedAt"],
            LEAD,
            binding["name"],
            binding["machine"],
            binding["boundAt"],
            str(self.repo.resolve()),
            OPUS,
            "claude-a",
            "claude-a:all",
            "blocked",
            "Coordinate wave1 rooms",
            "ork chief bind",
        ):
            self.assertIn(expected, brief_text)

        self.assertIn("Chief desk", event["notice"])
        self.assertIn("ork chief bind", event["notice"])
        self.assertIn(str(brief_path), event["notice"])
        other = self.register("claude-observer", "claude-b", state="busy")
        self.assertIn("ork chief bind", HANDOFF.notices(self.base, other))
        self.assertEqual(HANDOFF.notices(self.base, other), "")

        # Deduped retry within DEDUPE_SECONDS records only one event.
        self.assertEqual(self.stop_failure()["status"], "duplicate")

    def test_chief_preserves_available_stale_unknown_missing_billing_excluded_and_ambiguous(self) -> None:
        self.write_chief()
        # Available -> not-exhausted, no brief, no notice.
        self.set_lane("claude-a", status="available", usable=80)
        available = self.handoff(rooms=[])
        self.assertEqual(available["status"], "not-exhausted")
        self.assertNotIn("notice", available)
        self.assertFalse((HANDOFF.session_dir(LEAD) / "brief.md").exists())

        # Stale -> refused with notice.
        self.set_lane("claude-a", status="blocked", usable=0, stale=True)
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            stale = self.handoff(rooms=[])
        self.assertEqual(stale["status"], "refused")
        self.assertIn("stale or unknown", stale["reasons"][0])
        self.assertIn("notice", stale)

        # Unknown (monitor missing) -> refused.
        self.set_lane("claude-a", status="blocked", usable=0, stale=False)
        later = later + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            unknown = self.handoff(rooms=[], fetch=lambda: None)
        self.assertEqual(unknown["status"], "refused")
        self.assertIn("quota is unknown", unknown["reasons"][0])

        # Missing billing -> refused.
        self.config["accounts"][0]["billing"] = None
        self.write()
        later = later + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            no_billing = self.handoff(rooms=[])
        self.assertEqual(no_billing["status"], "refused")
        self.assertIn("billing context", no_billing["reasons"][0])

        # Excluded account leaves no eligible pool -> refused.
        self.config["accounts"][0]["billing"] = "personal"
        self.write()
        later = later + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with (
            mock.patch.object(HANDOFF, "now", return_value=later),
            mock.patch.object(
                HANDOFF,
                "settings",
                return_value={"enabled": True, "autoLaunch": True, "excludeAccounts": ["claude-b", "codex"]},
            ),
        ):
            excluded = self.handoff(rooms=[])
        self.assertEqual(excluded["status"], "refused")
        self.assertIn("no pool on another personal account", excluded["reasons"][0])

        # Multiple distinct Codex accounts with distinct CODEX_HOME pick highest-surplus allowed account.
        cx1 = self.root / "cx1"
        cx2 = self.root / "cx2"
        cx1.mkdir(exist_ok=True)
        cx2.mkdir(exist_ok=True)
        self.config["accounts"] = [
            {"id": "claude-a", "provider": "claude", "billing": "personal", "configDir": str(self.homes["claude-a"])},
            {
                "id": "codex-1",
                "provider": "codex",
                "billing": "personal",
                "tags": ["personal"],
                "env": {"CODEX_HOME": str(cx1)},
            },
            {
                "id": "codex-2",
                "provider": "codex",
                "billing": "personal",
                "tags": ["personal"],
                "env": {"CODEX_HOME": str(cx2)},
            },
        ]
        self.lanes = [
            lane("claude-a", status="blocked", usable=0),
            lane("codex-1", "codex", usable=90, surplus=30),
            lane("codex-2", "codex", usable=80, surplus=20),
        ]
        self.write()
        view_distinct = json.loads((self.root / "view.json").read_text())
        view_distinct["accounts"][1]["accountHome"] = str(cx1.resolve())
        view_distinct["accounts"][2]["accountHome"] = str(cx2.resolve())
        (self.root / "view.json").write_text(json.dumps(view_distinct))
        later = later + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            multi_codex = self.handoff(rooms=[])
        self.assertEqual(multi_codex["status"], "brief-ready", multi_codex)
        self.assertIn("codex-1", Path(multi_codex["brief"]).read_text())

        # Ambiguous fresh launch (two Codex accounts sharing the same CODEX_HOME) -> refused.
        self.config["accounts"][2]["env"]["CODEX_HOME"] = str(cx1)
        self.write()
        view_ambig = json.loads((self.root / "view.json").read_text())
        view_ambig["accounts"][1]["accountHome"] = str(cx1.resolve())
        view_ambig["accounts"][2]["accountHome"] = str(cx1.resolve())
        (self.root / "view.json").write_text(json.dumps(view_ambig))
        later = later + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            ambiguous = self.handoff(rooms=[])
        self.assertEqual(ambiguous["status"], "refused")
        self.assertIn("no pool on another personal account", ambiguous["reasons"][0])

    def test_stale_foreign_and_replaced_chief_bindings_are_ignored_and_grace_window_is_honored(self) -> None:
        # Foreign machine -> ignored.
        self.write_chief(machine="other-machine.local")
        self.assertEqual(self.handoff(rooms=[])["status"], "ignored")

        # Another session holds Chief -> ignored.
        self.write_chief(session="other-session")
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            self.assertEqual(self.handoff(rooms=[])["status"], "ignored")

        # Recycled PID (fresh lstart mismatch) -> ignored.
        self.write_chief(pidBirth="Thu Jan 01 00:00:00 1970")
        later = later + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            self.assertEqual(self.handoff(rooms=[])["status"], "ignored")

        # Unverified binding without PID/peer: within 600s grace -> brief-ready; after 600s -> ignored.
        MAILBOX.unregister(self.base, LEAD)
        later = later + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            self.write_chief(pid=None, pidBirth=None, boundAt=HANDOFF.stamp(later - dt.timedelta(seconds=120)))
            within_grace = HANDOFF.run(
                LEAD,
                HANDOFF.record_exhaustion(LEAD, "claude", "rate_limit", source="t", peer=self.lead, spawn=self.spawn)[
                    "event"
                ],
                base=self.base,
                rooms=lambda *_: [],
                sleep=self.sleeps.append,
            )
        self.assertEqual(within_grace["status"], "brief-ready", within_grace)

        later = later + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            self.write_chief(pid=None, pidBirth=None, boundAt=HANDOFF.stamp(later - dt.timedelta(seconds=601)))
            expired_grace = HANDOFF.run(
                LEAD,
                HANDOFF.record_exhaustion(LEAD, "claude", "rate_limit", source="t", peer=self.lead, spawn=self.spawn)[
                    "event"
                ],
                base=self.base,
                rooms=lambda *_: [],
                sleep=self.sleeps.append,
            )
        self.assertEqual(expired_grace["status"], "ignored")

        # Re-read right before publishing prevents a superseded Chief from emitting a stale notice.
        self.lead = self.register(LEAD, "claude-a")
        self.write_chief()

        def supersede_during_fetch():
            self.write_chief(session="new-chief")
            return SUCCESSION.fresh_view()

        later = later + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with mock.patch.object(HANDOFF, "now", return_value=later):
            superseded = self.handoff(rooms=[], fetch=supersede_during_fetch)
        self.assertEqual(superseded["status"], "ignored")
        self.assertNotIn("notice", superseded)

    def test_chief_plus_team_preserves_team_outcome_and_includes_chief_instructions(self) -> None:
        self.register(PEER, "claude-b")
        self.write_chief()
        chief_before = (self.base / "chief.json").read_text()
        event = self.handoff()
        self.assertEqual(event["status"], "handed-over", event)
        self.assertEqual(event["team"], "room-r1")
        self.assertEqual((self.base / "chief.json").read_text(), chief_before)
        record = AUTHORITY.load(AUTHORITY.team_dir("room-r1"))
        self.assertEqual((record["status"], record["lead"]["session"]), ("pending", PEER))
        brief_text = (HANDOFF.session_dir(LEAD) / "brief.md").read_text()
        self.assertIn("authority.py", brief_text)
        self.assertIn("## Chief desk", brief_text)
        self.assertIn("ork chief bind", brief_text)
        self.assertIn("Team room-r1 is pending", event["notice"])
        self.assertIn("ork chief bind", event["notice"])

    def test_existing_peer_successor_respects_repository_policy_for_authority_and_chief_brief(self) -> None:
        # Idle Codex peer has higher surplus than claude-b, but repo policy denies codex.
        self.set_lane("codex", status="available", usable=99, surplus=90)
        MAILBOX.register(
            self.base,
            session="codex-idle-peer",
            harness="codex",
            cwd=str(self.repo),
            pid=os.getpid(),
            model="gpt-6-luna",
            state="idle",
            account="/x",
        )
        self.register(PEER, "claude-b", state="idle")
        policy_path = self.root / "repo-policy.json"
        policy_path.write_text(
            json.dumps({"schema": "ork.policy.v1", "rules": [{"repo": str(self.repo), "deny": ["codex"]}]})
        )
        with mock.patch.dict(os.environ, {"ORKEST_POLICY_CONFIG": str(policy_path)}):
            # Authority handoff skips denied codex peer and chooses allowed claude-b peer.
            event = self.handoff()
            self.assertEqual(event["status"], "handed-over", event)
            self.assertEqual(event["successor"]["session"], PEER)

            # Chief brief also skips denied codex peer when choosing recommendation.
            chief_lead = "chief-policy-lead"
            chief_peer = self.register(chief_lead, "claude-a")
            self.write_chief(session=chief_lead)
            later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
            with mock.patch.object(HANDOFF, "now", return_value=later):
                recorded = HANDOFF.record_exhaustion(
                    chief_lead, "claude", "rate_limit", source="test", peer=chief_peer, spawn=self.spawn
                )
                self.assertEqual(recorded["status"], "recorded", recorded)
                chief_event = HANDOFF.run(
                    chief_lead,
                    recorded["event"],
                    base=self.base,
                    rooms=lambda *_: [],
                    sleep=self.sleeps.append,
                )
            self.assertEqual(chief_event["status"], "brief-ready", chief_event)
            brief_text = Path(chief_event["brief"]).read_text()
            self.assertNotIn("codex-idle-peer", brief_text)
            self.assertIn(PEER, brief_text)

    def test_live_chief_binding_parity_dead_pid_and_same_pid_replacement(self) -> None:
        # 1. Dead binding PID overrides a stale live-looking exact peer record.
        dead_pid = 99999999
        self.write_chief(pid=dead_pid, pidBirth=None)
        self.assertIsNone(HANDOFF.live_chief_binding(self.base, LEAD))

        # 2. Live PID with no exact peer past 600s grace: subagent/run peer does NOT replace,
        # while a live top-level peer (even sharedProcess=True) DOES replace.
        MAILBOX.unregister(self.base, LEAD)
        moment = HANDOFF.now()
        old_bound = HANDOFF.stamp(moment - dt.timedelta(seconds=700))
        self.write_chief(boundAt=old_bound)
        base_peer = {
            "schema": "agent-executor.peer.v1",
            "harness": "claude",
            "cwd": str(self.repo),
            "pid": os.getpid(),
            "startedAt": old_bound,
            "lastSeenAt": HANDOFF.stamp(moment),
        }
        sub_peer = {**base_peer, "session": "sub-1", "name": "sub", "isSubagent": True, "sharedProcess": True}
        run_peer = {**base_peer, "session": "run-1-worker", "name": "worker", "run": "1", "role": "worker"}
        self.assertIsNotNone(HANDOFF.live_chief_binding(self.base, LEAD, peers=[sub_peer, run_peer], moment=moment))

        replacement_peer = {
            **base_peer,
            "session": "new-top-level",
            "name": "new-chief",
            "sharedProcess": True,
        }
        self.assertIsNone(
            HANDOFF.live_chief_binding(self.base, LEAD, peers=[sub_peer, replacement_peer], moment=moment)
        )

    def test_midflight_rebind_between_brief_generation_and_publication_aborts_notice(self) -> None:
        # Case A: Rebind to another session right after brief.md is written, before publication under chief.lock.
        self.write_chief(revision=1)
        orig_write_private = HANDOFF.write_private

        def rebind_after_brief(path: Path, text: str) -> None:
            orig_write_private(path, text)
            if path.name == "brief.md":
                self.write_chief(session="new-chief", revision=2)

        with mock.patch.object(HANDOFF, "write_private", side_effect=rebind_after_brief):
            superseded = self.handoff(rooms=[])
        self.assertEqual(superseded["status"], "ignored", superseded)
        self.assertNotIn("notice", superseded)
        self.assertFalse((HANDOFF.session_dir(LEAD) / "brief.md").exists())

        # Case B: Same session rebinds with bumped revision right after brief.md is written.
        self.write_chief(session=LEAD, revision=1)

        def bump_revision_after_brief(path: Path, text: str) -> None:
            orig_write_private(path, text)
            if path.name == "brief.md":
                self.write_chief(session=LEAD, revision=2)

        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)
        with (
            mock.patch.object(HANDOFF, "now", return_value=later),
            mock.patch.object(HANDOFF, "write_private", side_effect=bump_revision_after_brief),
        ):
            bumped = self.handoff(rooms=[])
        self.assertEqual(bumped["status"], "ignored", bumped)
        self.assertNotIn("notice", bumped)
        self.assertFalse((HANDOFF.session_dir(LEAD) / "brief.md").exists())

    def test_chief_generation_survives_clear_rebind_for_brief_and_team_notice(self) -> None:
        # Clear + rebind same session with reused revision=1 but new generation UUID aborts brief-ready (#18).
        self.write_chief(session=LEAD, revision=1, generation="gen-uuid-1")
        orig_write_private = HANDOFF.write_private

        def clear_rebind_after_brief(path: Path, text: str) -> None:
            orig_write_private(path, text)
            if path.name == "brief.md":
                self.write_chief(session=LEAD, revision=1, generation="gen-uuid-2")

        with mock.patch.object(HANDOFF, "write_private", side_effect=clear_rebind_after_brief):
            superseded = self.handoff(rooms=[])
        self.assertEqual(superseded["status"], "ignored", superseded)
        self.assertNotIn("notice", superseded)
        self.assertFalse((HANDOFF.session_dir(LEAD) / "brief.md").exists())

        # Team handoff notice strips Chief recovery instructions if Chief cleared/rebound mid-flight (#18).
        self.register(PEER, "claude-b")
        self.write_chief(session=LEAD, revision=1, generation="gen-team-1")
        later = HANDOFF.now() + dt.timedelta(seconds=HANDOFF.DEDUPE_SECONDS + 1)

        def rebind_during_deliver(base, event, successor, text):
            self.write_chief(session="other-chief", revision=1, generation="gen-team-2")
            return self.deliver(base, event, successor, text)

        with mock.patch.object(HANDOFF, "now", return_value=later):
            team_event = self.handoff(deliver=rebind_during_deliver)
        self.assertEqual(team_event["status"], "handed-over", team_event)
        self.assertNotIn("chief", team_event)
        self.assertNotIn("chief.json", team_event["notice"])

    def test_aged_chief_peer_and_missing_pid_birth_respect_7day_and_600s_parity(self) -> None:
        # 1. Peer heartbeat older than 7 days with live non-shared PID is NOT live (#17).
        moment = HANDOFF.now()
        old_seen = HANDOFF.stamp(moment - dt.timedelta(days=8))
        self.write_chief(session=LEAD, pid=os.getpid(), pidBirth=MAILBOX.process_started(os.getpid()))
        aged_peer = {
            "schema": "agent-executor.peer.v1",
            "session": LEAD,
            "harness": "claude",
            "cwd": str(self.repo),
            "pid": os.getpid(),
            "pidBirth": MAILBOX.process_started(os.getpid()),
            "startedAt": old_seen,
            "lastSeenAt": old_seen,
        }
        self.assertIsNone(HANDOFF.live_chief_binding(self.base, LEAD, peers=[aged_peer], moment=moment))

        # 2. Exact-peer PID or pidBirth contradiction rejects binding (#17).
        fresh_seen = HANDOFF.stamp(moment - dt.timedelta(seconds=10))
        contradict_peer = {**aged_peer, "pid": os.getpid() + 1, "lastSeenAt": fresh_seen}
        self.assertIsNone(HANDOFF.live_chief_binding(self.base, LEAD, peers=[contradict_peer], moment=moment))

        # 3. Binding with pid & pidBirth when fresh process_started returns None expires after 600s grace.
        self.write_chief(
            session=LEAD,
            pid=os.getpid(),
            pidBirth="Mon Jan 01 00:00:00 2024",
            boundAt=HANDOFF.stamp(moment - dt.timedelta(seconds=700)),
        )
        with mock.patch.object(MAILBOX, "process_started", return_value=None):
            self.assertIsNone(HANDOFF.live_chief_binding(self.base, LEAD, peers=[aged_peer], moment=moment))

    def test_strict_policy_kwargs_and_non_claude_launcher_home_binding(self) -> None:
        # #8: choose_successor passes account_id, provider, billing_mode, strict=True to repo_policy.
        self.register(PEER, "claude-b")
        seen_calls: list[dict[str, object]] = []

        def strict_policy(cwd, engine, config_dir=None, **kwargs):
            seen_calls.append({"engine": engine, "config_dir": config_dir, **kwargs})
            if kwargs.get("account_id") == "claude-b":
                return (False, "denied by account_id", None)
            return (True, None, None)

        policy_mod = HANDOFF.module("repo_policy")
        with mock.patch.object(policy_mod, "check_execution_allowed", side_effect=strict_policy):
            event = self.handoff()
        self.assertTrue(any(c.get("strict") is True and c.get("account_id") == "claude-b" for c in seen_calls))
        # claude-b peer was denied by account_id; fell back to codex launch.
        self.assertEqual(event["status"], "handed-over", event)
        self.assertEqual(event["successor"]["account"], "codex")

        # #9: Codex launch binds CODEX_HOME to verified accountHome even when os.environ differs.
        private_codex = self.root / "private-codex-home"
        private_codex.mkdir()
        self.config["accounts"] = [
            {"id": "claude-a", "provider": "claude", "billing": "personal", "configDir": str(self.homes["claude-a"])},
            {"id": "codex", "provider": "codex", "billing": "personal", "env": {"CODEX_HOME": str(private_codex)}},
        ]
        self.lanes = [
            lane("claude-a", status="blocked", usable=0),
            lane("codex", "codex", usable=50, surplus=10),
        ]
        self.write()
        view_data = json.loads((self.root / "view.json").read_text())
        view_data["accounts"][1]["accountHome"] = str(private_codex)
        (self.root / "view.json").write_text(json.dumps(view_data))
        self.launched.clear()
        lead_codex_test = "lead-codex-launch"
        self.register(lead_codex_test, "claude-a")
        self.write_chief(session=lead_codex_test)
        codex_room = [
            {
                "id": "room-codex-launch",
                "title": "t",
                "objective": "o",
                "conductor": {"session": {"id": lead_codex_test}},
            }
        ]
        with mock.patch.dict(os.environ, {"CODEX_HOME": str(self.root / "wrong-codex")}):
            codex_event = self.handoff(session=lead_codex_test, rooms=codex_room)
        self.assertEqual(codex_event["status"], "handed-over", codex_event)
        self.assertEqual(self.launched[-1][1]["CODEX_HOME"], str(private_codex.resolve()))

        # #9: Explicit accountHome: None in Monitor view refuses non-Claude launch before takeover.
        view_data["accounts"][1]["accountHome"] = None
        (self.root / "view.json").write_text(json.dumps(view_data))
        lead_unverified = "lead-codex-unverified"
        self.register(lead_unverified, "claude-a")
        self.write_chief(session=lead_unverified)
        unverified_room = [
            {"id": "room-unverified", "title": "t", "objective": "o", "conductor": {"session": {"id": lead_unverified}}}
        ]
        refused_event = self.handoff(session=lead_unverified, rooms=unverified_room)
        self.assertEqual(refused_event["status"], "refused", refused_event)

    def test_claude_launch_profile_parity_chief_generation_capture_and_1d7_order(self) -> None:
        # #5: Relative configDir resolves against homedir, and default ~/.claude / unsetClaudeConfigDir strips CLAUDE_CONFIG_DIR.
        fake_home = self.root / "fake-home"
        default_claude = fake_home / ".claude"
        rel_claude = fake_home / "claude-b"
        default_claude.mkdir(parents=True)
        rel_claude.mkdir(parents=True)
        self.config["accounts"] = [
            {"id": "claude-a", "provider": "claude", "billing": "personal", "configDir": str(self.homes["claude-a"])},
            {"id": "claude-b", "provider": "claude", "billing": "personal", "configDir": "claude-b"},
        ]
        self.lanes = [
            lane("claude-a", status="blocked", usable=0),
            lane("claude-b", status="available", usable=90, surplus=50),
        ]
        self.write()
        view_rel = json.loads((self.root / "view.json").read_text())
        view_rel["accounts"][1]["configDir"] = str(rel_claude.resolve())
        (self.root / "view.json").write_text(json.dumps(view_rel))
        with mock.patch.object(Path, "home", return_value=fake_home):
            rel_choice = self.choose()
        self.assertEqual(rel_choice["successor"]["account"], "claude-b")
        self.assertEqual(rel_choice["successor"]["configDir"], str(rel_claude.resolve()))
        rel_cmd = HANDOFF.launch_command(
            {"checkout": str(self.repo), "cwd": str(self.repo)}, rel_choice["successor"], self.root / "b.md"
        )
        self.assertEqual(rel_cmd[rel_cmd.index("--claude-config-dir") + 1], str(rel_claude.resolve()))

        # Default ~/.claude (or unsetClaudeConfigDir: True) omits --claude-config-dir and pops CLAUDE_CONFIG_DIR from launch env.
        self.config["accounts"][0]["billing"] = "work"
        self.config["accounts"][1]["billing"] = "work"
        self.config["accounts"][1]["configDir"] = "~/.claude"
        self.write()
        view_data = json.loads((self.root / "view.json").read_text())
        view_data["accounts"][1]["unsetClaudeConfigDir"] = True
        view_data["lanes"] = [
            {**lane("claude-a", status="blocked", usable=0), "label": "claude-personal · all"},
            lane("claude-b", status="available", usable=90, surplus=50),
        ]
        (self.root / "view.json").write_text(json.dumps(view_data))
        with (
            mock.patch.object(Path, "home", return_value=fake_home),
            mock.patch.dict(os.environ, {"HOME": str(fake_home), "CLAUDE_CONFIG_DIR": "/stale/override"}),
        ):
            def_choice = self.choose()
            self.assertNotIn("configDir", def_choice["successor"])
            self.assertTrue(def_choice["successor"]["unsetClaudeConfigDir"])
            def_cmd = HANDOFF.launch_command(
                {"checkout": str(self.repo), "cwd": str(self.repo)},
                def_choice["successor"],
                self.root / "b.md",
            )
            self.assertNotIn("--claude-config-dir", def_cmd)
            self.launched.clear()
            self.register("lead-def-claude", "claude-a")
            def_room = [
                {
                    "id": "room-def-claude",
                    "title": "t",
                    "objective": "o",
                    "conductor": {"session": {"id": "lead-def-claude"}},
                }
            ]
            def_event = self.handoff(session="lead-def-claude", rooms=def_room)
        self.assertEqual(def_event["status"], "handed-over", def_event)
        self.assertNotIn("CLAUDE_CONFIG_DIR", self.launched[-1][1])

        # #3: Distinct account HOME on default-profile Claude carries HOME + ORKEST_PINNED_CLAUDE_ACCOUNT,
        # unsets CLAUDE_CONFIG_DIR, and scrubs caller ANTHROPIC_API_KEY / OAuth overrides in run_agent.
        second_home = self.root / "second-claude-home"
        (second_home / ".claude").mkdir(parents=True, exist_ok=True)
        self.config["accounts"][1] = {
            "id": "claude-b",
            "provider": "claude",
            "billing": "work",
            "configDir": "~/.claude",
            "env": {"HOME": str(second_home)},
        }
        self.write()
        view_data["accounts"][1] = {
            "id": "claude-b",
            "provider": "claude",
            "accountHome": str((second_home / ".claude").resolve()),
            "unsetClaudeConfigDir": True,
            "accountEnv": {"HOME": str(second_home.resolve())},
        }
        (self.root / "view.json").write_text(json.dumps(view_data))
        with (
            mock.patch.object(Path, "home", return_value=fake_home),
            mock.patch.dict(
                os.environ,
                {
                    "HOME": str(fake_home),
                    "CLAUDE_CONFIG_DIR": "/stale/override",
                    "ANTHROPIC_API_KEY": "sk-ant-caller",
                    "CLAUDE_CODE_OAUTH_TOKEN": "oauth-caller",
                },
            ),
        ):
            distinct_choice = self.choose()
            self.assertNotIn("configDir", distinct_choice["successor"])
            self.assertTrue(distinct_choice["successor"]["unsetClaudeConfigDir"])
            self.assertEqual(
                distinct_choice["successor"]["launchEnv"],
                {
                    "CLAUDE_CONFIG_DIR": None,
                    "ORKEST_CLAUDE_ACCOUNT_HOME": str(second_home.resolve()),
                    "ORKEST_PINNED_CLAUDE_ACCOUNT": "1",
                },
            )
            distinct_cmd = HANDOFF.launch_command(
                {"checkout": str(self.repo), "cwd": str(self.repo)},
                distinct_choice["successor"],
                self.root / "b.md",
            )
            self.assertNotIn("--claude-config-dir", distinct_cmd)
            self.launched.clear()
            self.register("lead-distinct-home", "claude-a")
            distinct_room = [
                {
                    "id": "room-distinct-home",
                    "title": "t",
                    "objective": "o",
                    "conductor": {"session": {"id": "lead-distinct-home"}},
                }
            ]
            distinct_event = self.handoff(session="lead-distinct-home", rooms=distinct_room)
        self.assertEqual(distinct_event["status"], "handed-over", distinct_event)
        launched_env = self.launched[-1][1]
        self.assertEqual(launched_env["HOME"], str(fake_home))
        self.assertEqual(launched_env["ORKEST_CLAUDE_ACCOUNT_HOME"], str(second_home.resolve()))
        self.assertEqual(launched_env["ORKEST_PINNED_CLAUDE_ACCOUNT"], "1")
        self.assertNotIn("CLAUDE_CONFIG_DIR", launched_env)
        with mock.patch.dict(os.environ, launched_env, clear=True):
            exec_env = RUNNER.executor_environment("claude", self.repo)
        self.assertEqual(exec_env["HOME"], str(second_home.resolve()))
        self.assertNotIn("CLAUDE_CONFIG_DIR", exec_env)
        self.assertNotIn("ORKEST_CLAUDE_ACCOUNT_HOME", exec_env)
        self.assertNotIn("ORKEST_PINNED_CLAUDE_ACCOUNT", exec_env)
        for key in RUNNER.CLAUDE_AUTH_ENV_OVERRIDES:
            self.assertNotIn(key, exec_env)

        # Restore default test config for remaining assertions.
        self.config["accounts"] = [
            {"id": "claude-a", "provider": "claude", "billing": "personal", "configDir": str(self.homes["claude-a"])},
            {"id": "claude-b", "provider": "claude", "billing": "personal", "configDir": str(self.homes["claude-b"])},
        ]
        self.write()

        # #14: Chief-only handoff captures original generation once and never adopts a replacement generation after quota retries.
        chief_only_lead = "lead-chief-rebind-retry"
        self.register(chief_only_lead, "claude-a")
        self.write_chief(session=chief_only_lead, revision=1, generation="gen-orig")
        fetch_calls = 0

        def fetch_with_rebind():
            nonlocal fetch_calls
            fetch_calls += 1
            if fetch_calls == 1:
                self.write_chief(session=chief_only_lead, revision=2, generation="gen-rebound")
            return json.loads((self.root / "view.json").read_text())

        rebound_chief_res = self.handoff(
            session=chief_only_lead,
            rooms=[],
            fetch=fetch_with_rebind,
            sleep=lambda _: None,
        )
        self.assertEqual(rebound_chief_res["status"], "ignored", rebound_chief_res)
        self.assertFalse((HANDOFF.session_dir(chief_only_lead) / "brief.md").exists())

        # #13: Team handoff strips stale Chief instructions from brief.md, note.md, AND event.json when Chief rebounds right after brief write.
        self.register(PEER, "claude-b")
        team_chief_lead = "lead-team-chief-strip"
        self.register(team_chief_lead, "claude-a")
        self.write_chief(session=team_chief_lead, revision=1, generation="gen-team-strip-1")
        strip_room = [
            {"id": "room-strip", "title": "t", "objective": "o", "conductor": {"session": {"id": team_chief_lead}}}
        ]

        def rebind_right_before_deliver(base, event, successor, text):
            self.write_chief(session="someone-else", revision=2, generation="gen-team-strip-2")
            return self.deliver(base, event, successor, text)

        team_res = self.handoff(
            session=team_chief_lead,
            rooms=strip_room,
            fetch=lambda: json.loads((self.root / "view.json").read_text()),
            deliver=rebind_right_before_deliver,
            sleep=lambda _: None,
        )
        self.assertEqual(team_res["status"], "handed-over", team_res)
        self.assertNotIn("chief", team_res)
        self.assertNotIn("ork chief bind", (HANDOFF.session_dir(team_chief_lead) / "brief.md").read_text())
        self.assertNotIn("ork chief bind", (HANDOFF.session_dir(team_chief_lead) / "note.md").read_text())

        # 1D #7: When PID birth cannot be verified after 600s grace, live_chief_binding returns None even with a live exact peer.
        moment = HANDOFF.now()
        self.write_chief(
            session=LEAD,
            pid=os.getpid(),
            pidBirth="Mon Jan 01 00:00:00 2024",
            boundAt=HANDOFF.stamp(moment - dt.timedelta(seconds=601)),
        )
        live_exact_peer = {
            "schema": "agent-executor.peer.v1",
            "session": LEAD,
            "harness": "claude",
            "cwd": str(self.repo),
            "pid": os.getpid(),
            "pidBirth": "Mon Jan 01 00:00:00 2024",
            "startedAt": HANDOFF.stamp(moment - dt.timedelta(seconds=10)),
            "lastSeenAt": HANDOFF.stamp(moment - dt.timedelta(seconds=5)),
            "live": True,
        }
        with mock.patch.object(MAILBOX, "process_started", return_value=None):
            self.assertIsNone(HANDOFF.live_chief_binding(self.base, LEAD, peers=[live_exact_peer], moment=moment))

    def test_claude_provider_home_keeps_workspace_lease_in_caller_home_and_json_view_binds_default_account(
        self,
    ) -> None:
        # #2: Monitor render.mjs jsonView preserves unsetClaudeConfigDir / claudeConfigDir / accountEnv into choose_successor.
        repo_root = Path(__file__).resolve().parents[3]
        render_mjs = repo_root / "src" / "lib" / "monitor" / "render.mjs"
        second_home = (self.root / "acct-second-home").resolve()
        (second_home / ".claude").mkdir(parents=True, exist_ok=True)
        caller_home = (self.root / "caller-real-home").resolve()
        caller_home.mkdir(parents=True, exist_ok=True)
        now_ms = int(time.time() * 1000)
        resets_ms = now_ms + 3600 * 1000
        raw_accounts = [
            {
                "id": "claude-a",
                "label": "claude-personal",
                "short": "CP",
                "provider": "claude",
                "billing": "personal",
                "configDir": str(self.homes["claude-a"]),
                "claudeConfigDir": str(self.homes["claude-a"]),
                "unsetClaudeConfigDir": False,
                "accountHome": str(self.homes["claude-a"]),
                "ok": True,
                "fetchedAt": now_ms,
                "windows": [
                    {
                        "id": "5h",
                        "label": "5h",
                        "kind": "short",
                        "usedPct": 100,
                        "remainingPct": 0,
                        "resetsAt": resets_ms,
                    }
                ],
                "pools": [{"id": "all", "label": "all", "families": ["claude"], "windowIds": ["5h"]}],
            },
            {
                "id": "claude-auto",
                "label": "claude-auto",
                "short": "CB",
                "provider": "claude",
                "billing": "personal",
                "configDir": None,
                "claudeConfigDir": None,
                "unsetClaudeConfigDir": True,
                "accountHome": str(second_home / ".claude"),
                "accountEnv": {"HOME": str(second_home)},
                "ok": True,
                "fetchedAt": now_ms,
                "windows": [
                    {
                        "id": "5h",
                        "label": "5h",
                        "kind": "short",
                        "usedPct": 10,
                        "remainingPct": 90,
                        "resetsAt": resets_ms,
                    }
                ],
                "pools": [{"id": "all", "label": "all", "families": ["claude"], "windowIds": ["5h"]}],
            },
        ]
        rendered = subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                (
                    f"import {{ jsonView }} from {json.dumps(render_mjs.as_uri())};"
                    "const accts = JSON.parse(process.argv[1]);"
                    "console.log(JSON.stringify(jsonView(accts)));"
                ),
                json.dumps(raw_accounts),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        serialized_view = json.loads(rendered.stdout)
        self.config["accounts"] = [
            {"id": "claude-a", "provider": "claude", "billing": "personal", "configDir": str(self.homes["claude-a"])},
            {"id": "claude-auto", "provider": "claude", "billing": "personal"},
        ]
        self.write()
        (self.root / "view.json").write_text(json.dumps(serialized_view))
        choice = self.choose()
        self.assertIsNotNone(choice["successor"], choice)
        self.assertEqual(choice["successor"]["account"], "claude-auto")
        self.assertTrue(choice["successor"]["unsetClaudeConfigDir"])
        self.assertEqual(
            choice["successor"]["launchEnv"],
            {
                "CLAUDE_CONFIG_DIR": None,
                "ORKEST_CLAUDE_ACCOUNT_HOME": str(second_home),
                "ORKEST_PINNED_CLAUDE_ACCOUNT": "1",
            },
        )

        # #1: run_agent.py acquires workspace_lease under caller HOME while claude child receives account HOME.
        bin_dir = self.root / "fake-bin"
        bin_dir.mkdir(exist_ok=True)
        captured_env_path = self.root / "captured-claude-env.json"
        fake_claude = bin_dir / "claude"
        fake_claude.write_text(
            textwrap.dedent(
                f"""\
                #!{sys.executable}
                import json, os
                from pathlib import Path
                Path({json.dumps(str(captured_env_path))}).write_text(
                    json.dumps(dict(os.environ)), encoding="utf-8"
                )
                report = (
                    "### STATUS\\n\\nCOMPLETE\\n\\n### FILES CHANGED\\n\\n- none\\n\\n"
                    "### COMMANDS RUN\\n\\n- none\\n\\n### VERIFICATION\\n\\n- ok\\n\\n"
                    "### RISKS OR BLOCKERS\\n\\n- none"
                )
                print(json.dumps({{"type": "result", "subtype": "success", "session_id": "s1", "result": report}}))
                """
            ),
            encoding="utf-8",
        )
        fake_claude.chmod(0o755)
        brief_file = self.root / "brief.md"
        brief_file.write_text("Inspect workspace only.", encoding="utf-8")
        child_env = {
            key: value
            for key, value in os.environ.items()
            if key
            not in {
                "ORCHESTRATE_HOME",
                "AGENT_EXECUTOR_HOME",
                "XDG_CACHE_HOME",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
            }
        }
        child_env.update(
            {
                "HOME": str(caller_home),
                "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
                "CLAUDE_CONFIG_DIR": "/stale/host/config",
                "ANTHROPIC_API_KEY": "sk-ant-stale",
                "ORKEST_PINNED_CLAUDE_ACCOUNT": "1",
                "ORKEST_CLAUDE_ACCOUNT_HOME": str(second_home),
            }
        )
        caller_cache = caller_home / ".cache" / "orchestrate"
        cmd = [
            sys.executable,
            str(SCRIPTS / "run_agent.py"),
            "--cwd",
            str(self.repo),
            "--brief",
            str(brief_file),
            "--engine",
            "claude",
            "--model",
            OPUS,
            "--transport",
            "executor",
            "--ignore-quota",
            "--out-dir",
            str(self.root / "run-out"),
        ]
        # Holding workspace_lease in caller_home blocks run_agent.py with LEASE_BUSY_EXIT (27).
        support = RUNNER.bundled_module("execution_support")
        with support.workspace_lease(self.repo, caller_cache):
            blocked = subprocess.run(cmd, env=child_env, capture_output=True, text=True, check=False)
        self.assertEqual(blocked.returncode, HANDOFF.LEASE_BUSY_EXIT, blocked.stderr)

        # Without contention, run_agent.py succeeds, writes lease under caller_home, and passes second_home to claude.
        succeeded = subprocess.run(cmd, env=child_env, capture_output=True, text=True, check=False)
        self.assertEqual(succeeded.returncode, 0, succeeded.stderr)
        self.assertTrue((caller_cache / "worktree-locks-v1").is_dir())
        self.assertFalse((second_home / ".cache").exists())
        claude_env = json.loads(captured_env_path.read_text(encoding="utf-8"))
        self.assertEqual(claude_env["HOME"], str(second_home))
        self.assertNotIn("CLAUDE_CONFIG_DIR", claude_env)
        self.assertNotIn("ORKEST_CLAUDE_ACCOUNT_HOME", claude_env)
        self.assertNotIn("ORKEST_PINNED_CLAUDE_ACCOUNT", claude_env)
        for key in RUNNER.CLAUDE_AUTH_ENV_OVERRIDES:
            self.assertNotIn(key, claude_env)


if __name__ == "__main__":
    unittest.main()
