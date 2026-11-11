"""Session start tells the user about an update they have not applied yet."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import mailbox_hooks  # noqa: E402
import peer_mailbox  # noqa: E402,F401


class UpdateNoticeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name) / "mailbox-v1"
        self.base.mkdir()
        self.state = Path(temp.name) / "auto-update-v1.json"

    def notice(self, state, head="aaa", me=None):
        self.state.write_text(json.dumps(state))
        done = subprocess.CompletedProcess([], 0, stdout=f"{head}\n")
        with mock.patch.object(mailbox_hooks.subprocess, "run", return_value=done):
            return mailbox_hooks._update_notice(self.base, me or {})

    def test_names_the_update_and_how_to_apply_it(self):
        text = self.notice({"status": "update_available", "remoteSha": "bbb", "commitsBehind": 2})
        self.assertIn("2 new commits", text)
        self.assertIn("/update", text)

    def test_silent_when_already_current_or_nothing_is_waiting(self):
        self.assertEqual(self.notice({"status": "update_available", "remoteSha": "aaa"}), "")
        self.assertEqual(self.notice({"status": "up_to_date"}), "")
        self.assertEqual(self.notice({"status": "updated"}), "")

    def test_silent_for_subagents_and_delegated_runs(self):
        state = {"status": "update_available", "remoteSha": "bbb"}
        self.assertEqual(self.notice(state, me={"isSubagent": True}), "")
        self.assertEqual(self.notice(state, me={"delegatedRun": True}), "")

    def test_silent_without_a_state_file(self):
        self.assertEqual(mailbox_hooks._update_notice(self.base, {}), "")


if __name__ == "__main__":
    unittest.main()
