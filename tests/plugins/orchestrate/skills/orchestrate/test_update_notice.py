"""Session start tells the user about an update they have not applied yet."""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(TESTS_DIR))
sys.path.insert(0, str(SCRIPTS))
import _ork_fast_test_helpers as fast  # noqa: E402
import peer_mailbox  # noqa: E402


class UpdateNoticeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.base = self.home / "mailbox-v1"
        self.base.mkdir()
        self.state = self.home / "auto-update-v1.json"
        self.bin_dir = self.home / "bin"
        self.bin_dir.mkdir()
        real_git = shutil.which("git") or "git"
        git_shim = self.bin_dir / "git"
        git_shim.write_text(
            "#!/bin/sh\n"
            'if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then\n'
            '  printf "%s\\n" "${ORK_TEST_GIT_HEAD:-aaa}"\n'
            "  exit 0\n"
            "fi\n"
            f'exec "{real_git}" "$@"\n',
            encoding="utf-8",
        )
        git_shim.chmod(0o755)
        self._counter = 0

    def _run_session_start(self, *, head="aaa", me=None):
        self._counter += 1
        session = f"update-notice-{self._counter}"
        env = {
            **os.environ,
            "PATH": f"{self.bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
            "ORK_TEST_GIT_HEAD": head,
        }
        if me and me.get("isSubagent"):
            peer_mailbox.register(self.base, session=session, harness="claude", cwd=str(self.home), pid=os.getpid())
            peer_mailbox.annotate(self.base, session, isSubagent=True)
        if me and me.get("delegatedRun"):
            run = peer_mailbox.open_run(
                self.base,
                f"update-notice-run-{self._counter}",
                worker_harness="claude",
                repository=self.home,
                result_path=self.home / f"result-{self._counter}.json",
                deadline=(dt.datetime.now(dt.UTC) + dt.timedelta(minutes=5)).isoformat(),
                worker_pid=os.getpid(),
            )
            env["AGENT_MAILBOX_SESSION"] = run["worker"]
        out = fast.run_mailbox_hook(
            {"session_id": session, "cwd": str(self.home)},
            harness="claude",
            event="SessionStart",
            base=self.base,
            cwd=self.home,
            env=env,
        )
        if not isinstance(out, dict):
            return ""
        return str((out.get("hookSpecificOutput") or {}).get("additionalContext") or "")

    def notice(self, state, head="aaa", me=None):
        self.state.write_text(json.dumps(state))
        return self._run_session_start(head=head, me=me)

    def test_names_the_update_and_how_to_apply_it(self):
        text = self.notice({"status": "update_available", "remoteSha": "bbb", "commitsBehind": 2})
        self.assertIn("2 new commits", text)
        self.assertIn("/update", text)

    def test_silent_when_already_current_or_nothing_is_waiting(self):
        for state in (
            {"status": "update_available", "remoteSha": "aaa"},
            {"status": "up_to_date"},
            {"status": "updated"},
        ):
            text = self.notice(state)
            self.assertNotIn("An Orkest update is available", text)
            self.assertNotIn("/update", text)

    def test_silent_for_subagents_and_delegated_runs(self):
        state = {"status": "update_available", "remoteSha": "bbb"}
        for me in ({"isSubagent": True}, {"delegatedRun": True}):
            text = self.notice(state, me=me)
            self.assertNotIn("An Orkest update is available", text)
            self.assertNotIn("/update", text)

    def test_silent_without_a_state_file(self):
        text = self._run_session_start()
        self.assertNotIn("An Orkest update is available", text)
        self.assertNotIn("/update", text)


if __name__ == "__main__":
    unittest.main()
