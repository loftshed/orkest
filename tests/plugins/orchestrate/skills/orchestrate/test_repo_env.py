from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins" / "orchestrate" / "skills" / "orchestrate" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import mailbox_hooks  # noqa: E402
import peer_mailbox  # noqa: E402
import repo_env  # noqa: E402

SPEC = importlib.util.spec_from_file_location("agent_executor_runner_env_test", SCRIPTS / "run_agent.py")
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
    )


class RepoEnvPropagationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="ork-repo-env-")
        self.root = Path(self.temp.name)
        self.main_repo = self.root / "repo"
        self.main_repo.mkdir()
        _git(self.main_repo, "init", "-q")
        _git(self.main_repo, "config", "user.name", "loftshed")
        _git(self.main_repo, "config", "user.email", "36140992+loftshed@users.noreply.github.com")
        (self.main_repo / ".gitignore").write_text(
            ".env\n.env.*\n!.env.example\nconfig/*.local.json\n", encoding="utf-8"
        )
        (self.main_repo / ".env.example").write_text("APP_PORT=3000\n", encoding="utf-8")
        _git(self.main_repo, "add", ".gitignore", ".env.example")
        _git(self.main_repo, "commit", "-qm", "chore: initial commit")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_linked_worktree_bootstrap_copies_untracked_dotenv_and_worktreeinclude_safely(self) -> None:
        outside = self.root / "outside-secret.txt"
        outside.write_text("outside\n", encoding="utf-8")
        (self.main_repo / ".env").write_text('APP_PORT=4100\nDB_URL="postgres://localhost/dev"\n', encoding="utf-8")
        (self.main_repo / ".env.local").write_text("APP_PORT=4200\n", encoding="utf-8")
        (self.main_repo / ".env.skip").write_text("SKIP=1\n", encoding="utf-8")
        (self.main_repo / ".env.escape").symlink_to(outside)
        (self.main_repo / "config").mkdir()
        (self.main_repo / "config" / "app.local.json").write_text('{"feature":true}\n', encoding="utf-8")
        (self.main_repo / ".worktreeinclude").write_text(
            "config/*.local.json\n!.env.skip\n../outside-secret.txt\n.git/config\n",
            encoding="utf-8",
        )

        linked = self.root / "wt-worker"
        _git(self.main_repo, "worktree", "add", "-q", "-b", "feat/worker", str(linked), "HEAD")

        copied = repo_env.bootstrap_worktree_env(linked)
        self.assertEqual(copied, [".env", ".env.local", "config/app.local.json"])
        self.assertEqual((linked / ".env").stat().st_mode & 0o777, 0o600)
        self.assertEqual((linked / ".env.local").stat().st_mode & 0o777, 0o600)
        self.assertFalse((linked / ".env.skip").exists())
        self.assertFalse((linked / ".env.escape").exists())

        (linked / ".env.local").write_text("APP_PORT=9999\n", encoding="utf-8")
        self.assertEqual(repo_env.bootstrap_worktree_env(linked, overwrite=False), [])
        self.assertEqual((linked / ".env.local").read_text(encoding="utf-8"), "APP_PORT=9999\n")

    def test_executor_environment_and_verification_apply_safe_dotenv_defaults_and_respect_isolation(self) -> None:
        # Tracked .env in a cloned repo must never auto-inject into process environments.
        tracked_repo = self.root / "tracked-repo"
        tracked_repo.mkdir()
        _git(tracked_repo, "init", "-q")
        _git(tracked_repo, "config", "user.name", "loftshed")
        _git(tracked_repo, "config", "user.email", "36140992+loftshed@users.noreply.github.com")
        (tracked_repo / ".env").write_text("TRACKED_INJECT=bad\n", encoding="utf-8")
        _git(tracked_repo, "add", ".env")
        _git(tracked_repo, "commit", "-qm", "chore: tracked env")
        self.assertNotIn("TRACKED_INJECT", RUNNER.executor_environment("codex", tracked_repo))

        (self.main_repo / ".env").write_text(
            "\n".join(
                [
                    "export APP_PORT=4100",
                    'DB_URL="postgres://localhost/main"',
                    "LITERAL_CMD='$(echo should_not_run)'",
                    'MULTILINE="first\\nsecond"',
                    "CALLER_WINS=from_dotenv",
                    "PATH=/malicious/bin",
                    "NODE_OPTIONS=--require=/tmp/bad.js",
                    "LD_PRELOAD=/tmp/bad.so",
                    "GIT_SSH_COMMAND=evil",
                    "ANTHROPIC_BASE_URL=https://evil.example",
                    "OPENAI_BASE_URL=https://evil.example",
                    "ANTHROPIC_API_KEY=sk-ant-from-dotenv",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        (self.main_repo / ".env.local").write_text("APP_PORT=4200 # local override\n", encoding="utf-8")

        linked = self.root / "wt-exec"
        _git(self.main_repo, "worktree", "add", "-q", "-b", "feat/exec", str(linked), "HEAD")

        clean_env = {
            k: v
            for k, v in os.environ.items()
            if k
            not in {
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_BASE_URL",
                "APP_PORT",
                "DB_URL",
                "GIT_SSH_COMMAND",
                "LD_PRELOAD",
                "LITERAL_CMD",
                "MULTILINE",
                "NODE_OPTIONS",
                "OPENAI_BASE_URL",
            }
        }
        clean_env["CALLER_WINS"] = "from_caller"
        with mock.patch.dict(os.environ, clean_env, clear=True):
            codex_env = RUNNER.executor_environment("codex", linked)
            self.assertEqual(codex_env["APP_PORT"], "4200")
            self.assertEqual(codex_env["DB_URL"], "postgres://localhost/main")
            self.assertEqual(codex_env["LITERAL_CMD"], "$(echo should_not_run)")
            self.assertEqual(codex_env["MULTILINE"], "first\nsecond")
            self.assertEqual(codex_env["CALLER_WINS"], "from_caller")
            self.assertEqual(codex_env["PATH"], clean_env["PATH"])
            self.assertNotIn("NODE_OPTIONS", codex_env)
            self.assertNotIn("LD_PRELOAD", codex_env)
            self.assertNotIn("GIT_SSH_COMMAND", codex_env)
            self.assertNotIn("ANTHROPIC_BASE_URL", codex_env)
            self.assertNotIn("OPENAI_BASE_URL", codex_env)

            plaude_env = RUNNER.executor_environment(
                "claude",
                linked,
                claude_config_dir=self.root / ".claude-personal",
            )
            self.assertEqual(plaude_env["APP_PORT"], "4200")
            self.assertNotIn("ANTHROPIC_API_KEY", plaude_env)

            out_dir = self.root / "verify-out"
            out_dir.mkdir()
            audit = RUNNER.bundled_module("workspace_audit")
            verification = audit.run_verification_commands(
                ['test "$APP_PORT" = "4200" && test "$DB_URL" = "postgres://localhost/main"'],
                repo=linked,
                out_dir=out_dir,
                timeout_seconds=10,
            )
            self.assertEqual(verification["status"], "passed")

    def test_session_start_and_subagent_start_hooks_materialize_worktree_and_export_claude_env_file(self) -> None:
        (self.main_repo / ".env").write_text(
            'SERVICE_URL=http://127.0.0.1:4321\nQUOTE_TEST="it\'s $(literal)"\nANTHROPIC_API_KEY=sk-ant-dotenv\n',
            encoding="utf-8",
        )
        linked = self.root / "wt-hook"
        _git(self.main_repo, "worktree", "add", "-q", "-b", "feat/hook", str(linked), "HEAD")

        mailbox_base = self.root / "mailbox-v1"
        claude_env_file = self.root / "claude-session-env.sh"

        # Read-only runs (ORKEST_READONLY_RUN=1) never write files into a shared linked worktree.
        sub_payload = {
            "hook_event_name": "SubagentStart",
            "session_id": "parent-claude-1",
            "agent_id": "sub-wt-1",
            "agent_type": "Explore",
            "cwd": str(linked),
        }
        with mock.patch.dict(
            os.environ,
            {"ORCHESTRATE_HOME": str(self.root), "ORKEST_READONLY_RUN": "1"},
            clear=False,
        ):
            peer_mailbox.hook(sub_payload, harness="claude", base=mailbox_base)
        self.assertFalse((linked / ".env").exists())

        # Writer/interactive SubagentStart materializes missing .env into the native subagent worktree.
        with mock.patch.dict(os.environ, {"ORCHESTRATE_HOME": str(self.root)}, clear=False):
            os.environ.pop("ORKEST_READONLY_RUN", None)
            peer_mailbox.hook(sub_payload, harness="claude", base=mailbox_base)
        self.assertTrue((linked / ".env").is_file())
        self.assertEqual((linked / ".env").stat().st_mode & 0o777, 0o600)

        # SessionStart on an isolated Claude profile exports safe keys to $CLAUDE_ENV_FILE while scrubbing auth keys.
        isolated_env = {
            k: v for k, v in os.environ.items() if k not in {"SERVICE_URL", "QUOTE_TEST", "ANTHROPIC_API_KEY"}
        }
        isolated_env["ORCHESTRATE_HOME"] = str(self.root)
        isolated_env["CLAUDE_ENV_FILE"] = str(claude_env_file)
        isolated_env["CLAUDE_CONFIG_DIR"] = str(self.root / ".claude-personal")
        session_payload = {
            "hook_event_name": "SessionStart",
            "session_id": "session-claude-wt-1",
            "cwd": str(linked),
        }
        with (
            mock.patch.dict(os.environ, isolated_env, clear=True),
            mock.patch.object(mailbox_hooks, "_maybe_trigger_auto_update"),
        ):
            peer_mailbox.hook(session_payload, harness="claude", base=mailbox_base)
        self.assertEqual(claude_env_file.stat().st_mode & 0o777, 0o600)
        text = claude_env_file.read_text(encoding="utf-8")
        self.assertNotIn("ANTHROPIC_API_KEY", text)
        sourced = subprocess.run(
            ["/bin/sh", "-c", '. "$1" && printf "%s\\n%s" "$SERVICE_URL" "$QUOTE_TEST"', "--", str(claude_env_file)],
            check=True,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
        )
        self.assertEqual(sourced.stdout, "http://127.0.0.1:4321\nit's $(literal)")

        # Second call is idempotent and appends nothing.
        self.assertEqual(repo_env.export_claude_env_file(linked, environ=isolated_env), [])


if __name__ == "__main__":
    unittest.main()
