"""`run_agent.py consult`: one question, one answer, no permission to act. Fake CLIs stand in for every engine."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SKILL_DIR = Path(__file__).resolve().parents[5] / "plugins" / "orchestrate" / "skills" / "orchestrate"
if str(SKILL_DIR / "scripts") not in sys.path:
    sys.path.insert(0, str(SKILL_DIR / "scripts"))
SCRIPT = SKILL_DIR / "scripts" / "run_agent.py"
# Never query real subscription accounts through monitor, and use the bundled routes only.
os.environ["MONITOR_BIN"] = str(Path(__file__).parent / "no-monitor")
os.environ["AGENT_EXECUTOR_CONFIG"] = str(Path(tempfile.mkdtemp()) / "absent-config.json")
SPEC = importlib.util.spec_from_file_location("agent_executor_runner", SCRIPT)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)
CONSULT = RUNNER.bundled_module("consult")

ANSWER = """Thinking it through.

### ANSWER

Use a shared lock file; unlinking it races.

### UNCERTAINTY

I could not verify the kernel version; on 5.x the semantics differ.
"""

FINDINGS = """### FINDINGS

- high: lock.py:3 unlinks the lock while held.

### EVIDENCE

lock.py:3 `os.unlink(path)` runs before `close`.

### UNCERTAINTY

Did not check callers outside the repository.
"""

COMMON = r"""
import json
import os
import pathlib
import sys

def capture(extra=None):
    payload = {"argv": sys.argv[1:], "cwd": os.getcwd(), "env": {k: v for k, v in os.environ.items() if k.startswith(("OPENCODE", "CLAUDE", "TERM", "NO_COLOR", "ANTIGRAVITY", "GEMINI"))}}
    if extra:
        payload.update(extra)
    pathlib.Path(os.environ["FAKE_CAPTURE"]).write_text(json.dumps(payload), encoding="utf-8")

def response():
    return os.environ.get("FAKE_RESPONSE", pathlib.Path(os.environ["FAKE_ANSWER_FILE"]).read_text(encoding="utf-8"))

def finish():
    if os.environ.get("FAKE_WRITE_FILE"):
        # A misbehaving consultant: writes into its working directory.
        pathlib.Path(os.environ["FAKE_WRITE_FILE"]).write_text("oops\n", encoding="utf-8")
    if os.environ.get("FAKE_STDERR"):
        print(os.environ["FAKE_STDERR"], file=sys.stderr)
    raise SystemExit(int(os.environ.get("FAKE_EXIT", "0")))
"""

FAKE_CODEX = (
    "#!/usr/bin/env python3\n"
    + COMMON
    + r"""
if "--version" in sys.argv:
    print("codex-cli test 0.0")
elif sys.argv[1:3] == ["app-server", "--stdio"]:
    for line in sys.stdin:
        request = json.loads(line)
        if request.get("method") == "initialize":
            print(json.dumps({"id": request["id"], "result": {}}), flush=True)
        elif request.get("method") == "model/list":
            efforts = [{"reasoningEffort": e} for e in ("low", "medium", "high", "max")]
            data = [
                {"id": "gpt-5.6-sol", "displayName": "Sol", "isDefault": False, "hidden": False, "supportedReasoningEfforts": efforts},
                {"id": "gpt-5.6-luna", "displayName": "Luna", "isDefault": True, "hidden": False, "supportedReasoningEfforts": efforts},
            ]
            print(json.dumps({"id": request["id"], "result": {"data": data, "nextCursor": None}}), flush=True)
else:
    prompt = sys.stdin.read()
    output_index = sys.argv.index("--output-last-message") + 1
    pathlib.Path(sys.argv[output_index]).write_text(response(), encoding="utf-8")
    capture({"stdin": prompt})
    print(json.dumps({"type": "thread.started", "thread_id": "codex-thread-7"}))
    print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 120, "cached_input_tokens": 20, "output_tokens": 30}}))
    finish()
"""
)

FAKE_CLAUDE = (
    "#!/usr/bin/env python3\n"
    + COMMON
    + r"""
if "--version" in sys.argv:
    print("claude test 0.0")
elif "-p" in sys.argv:
    prompt = sys.stdin.read()
    capture({"stdin": prompt})
    session = sys.argv[sys.argv.index("--resume") + 1] if "--resume" in sys.argv else "claude-session-9"
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "session_id": session,
                      "result": response(), "total_cost_usd": 0.05,
                      "modelUsage": {"claude-opus-4-9": {"inputTokens": 10}},
                      "usage": {"input_tokens": 10, "cache_read_input_tokens": 5, "cache_creation_input_tokens": 1, "output_tokens": 4}}))
    finish()
else:
    pathlib.Path(os.environ["FAKE_UNSAFE_CALL"]).write_text("called\n", encoding="utf-8")
    raise SystemExit(99)
"""
)

FAKE_AGY = (
    "#!/usr/bin/env python3\n"
    + COMMON
    + r"""
if "--version" in sys.argv:
    print("agy test 1.3.0")
elif len(sys.argv) > 1 and sys.argv[1] == "models":
    print("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)")
else:
    stream_input = [json.loads(line) for line in sys.stdin.read().splitlines() if line.strip()]
    log_index = sys.argv.index("--log-file") + 1
    pathlib.Path(sys.argv[log_index]).write_text("Created conversation 22222222-2222-2222-2222-222222222222\n", encoding="utf-8")
    capture({"stream_input": stream_input})
    model = sys.argv[sys.argv.index("--model") + 1]
    print(json.dumps({"type": "init", "conversation_id": "22222222-2222-2222-2222-222222222222", "model": model}))
    print(json.dumps({"type": "result", "status": os.environ.get("FAKE_AGY_STATUS", "success"), "conversation_id": "22222222-2222-2222-2222-222222222222", "response": response(), "error": os.environ.get("FAKE_AGY_ERROR", ""), "usage": {"input_tokens": 50, "output_tokens": 9, "cache_read_tokens": 0, "total_tokens": 59}, "denied_actions": json.loads(os.environ.get("FAKE_AGY_DENIED", "[]"))}))
    finish()
"""
)

FAKE_OPENCODE = (
    "#!/usr/bin/env python3\n"
    + COMMON
    + r"""
if "--version" in sys.argv:
    print("2.0.30")
elif len(sys.argv) > 1 and sys.argv[1] == "models":
    print("openrouter/~z-ai/glm-flash-latest\nopenrouter/deepseek/deepseek-v4-flash")
else:
    attached = pathlib.Path(sys.argv[sys.argv.index("--file") + 1]).read_text(encoding="utf-8")
    capture({"attached": attached})
    print(json.dumps({"type": "text", "sessionID": "ses_consult_1", "part": {"type": "text", "text": response()}}))
    finish()
"""
)


class ConsultTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="consult-test-")
        self.root = Path(self.temporary.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, source in (
            ("codex", FAKE_CODEX),
            ("claude", FAKE_CLAUDE),
            ("agy", FAKE_AGY),
            ("opencode", FAKE_OPENCODE),
        ):
            path = self.bin / name
            path.write_text(source, encoding="utf-8")
            path.chmod(0o700)
        self.answer_file = self.root / "answer.md"
        self.answer_file.write_text(ANSWER, encoding="utf-8")
        self.capture_path = self.root / "capture.json"
        self.unsafe_path = self.root / "unsafe-call"
        self.run_index = 0
        self.repository = self.root / "repo"
        self.repository.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "consult@example.test")
        self.git("config", "user.name", "Consult Test")
        (self.repository / "lock.py").write_text(
            "import os\n\ndef release(path):\n    os.unlink(path)\n", encoding="utf-8"
        )
        self.git("add", "lock.py")
        self.git("commit", "-qm", "initial")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.repository, check=True, capture_output=True, text=True).stdout

    def environment(self, **extra: str) -> dict[str, str]:
        # Each run gets a fresh cache so catalogs, events and consult directories never cross tests.
        self.run_index += 1
        env = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "XDG_CACHE_HOME": str(self.root / f"cache-{self.run_index}"),
            "FAKE_CAPTURE": str(self.capture_path),
            "FAKE_ANSWER_FILE": str(self.answer_file),
            "FAKE_UNSAFE_CALL": str(self.unsafe_path),
        }
        # A test process may itself run inside a harness; the host is decided per test.
        for host_keys in RUNNER.HOST_MARKERS.values():
            for key in host_keys:
                env.setdefault(key, "")
        env.update(extra)
        return env

    def consult(self, *argv: str, env: dict[str, str] | None = None) -> tuple[int, dict, str]:
        output = io.StringIO()
        with (
            mock.patch.dict(os.environ, env or self.environment()),
            mock.patch.object(sys, "argv", [str(SCRIPT), "consult", *argv]),
            contextlib.redirect_stdout(output),
        ):
            try:
                code = RUNNER.main()
            except RUNNER.RunnerError as error:
                return error.exit_code, {"error": str(error)}, output.getvalue()
        text = output.getvalue()
        result_line = next((line for line in text.splitlines() if line.startswith("AGENT_RESULT=")), None)
        if result_line:
            result_path = result_line.split("=", 1)[1]
        else:
            # --format json prints the result itself instead of the AGENT_* lines.
            try:
                result_path = json.loads(text).get("result_path")
            except ValueError:
                result_path = None
        # A detached consultation announces its result path before the background job writes it.
        result = (
            json.loads(Path(result_path).read_text(encoding="utf-8"))
            if result_path and Path(result_path).exists()
            else {}
        )
        return code, result, text

    def capture(self) -> dict:
        return json.loads(self.capture_path.read_text(encoding="utf-8"))

    def test_consultant_does_not_inherit_supervisor_mailbox_identity(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "AGENT_MAILBOX_SESSION": "supervisor-a",
                "AGENT_MAILBOX_LISTENER_SESSION": "supervisor-a",
                "AGENT_MAILBOX_PEER": "other-actor",
            },
        ):
            environment = CONSULT.consult_environment("claude", self.repository, None, "worker-a", reading=True)
        self.assertNotIn("AGENT_MAILBOX_SESSION", environment)
        self.assertNotIn("AGENT_MAILBOX_LISTENER_SESSION", environment)
        self.assertNotIn("AGENT_MAILBOX_PEER", environment)
        self.assertEqual(environment["CLAUDE_CODE_SESSION_ID"], "worker-a")

    def test_consultation_records_its_supervisor_and_result_for_swarm_discovery(self) -> None:
        env = self.environment(AGENT_MAILBOX_SESSION="supervisor-a", ORKEST_SWARM_ROOM="room-a")
        code, result, _ = self.consult("--question", "Why?", env=env)
        self.assertEqual(code, 0)
        records = list(
            (Path(env["XDG_CACHE_HOME"]) / "orchestrate/mailbox-v1/consultations/supervisor-a").glob("*.json")
        )
        self.assertEqual(len(records), 1)
        record = json.loads(records[0].read_text())
        self.assertEqual(record["parent_session"], "supervisor-a")
        self.assertEqual(record["room_id"], "room-a")
        self.assertEqual(record["result_path"], result["result_path"])
        self.assertEqual(record["model"], result["model"])
        self.assertEqual(record["engine"], "codex")
        self.assertGreater(record["pid"], 0)

    def test_default_route_asks_codex_read_only_and_returns_the_structured_answer(self) -> None:
        attachment = self.root / "lock.py"
        attachment.write_text("def lock():\n    ```not a fence```\n", encoding="utf-8")
        code, result, summary = self.consult(
            "--question",
            "Should the lock file be unlinked?",
            "--context",
            "We use flock on macOS.",
            "--attach",
            str(attachment),
        )
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(
            (result["status"], result["intent"], result["transport"], result["engine"]),
            ("answered", "question", "executor", "codex"),
        )
        self.assertEqual(
            (result["model"], result["effort"]["bound"], result["route"]), ("gpt-5.6-sol", "high", "consultation")
        )
        self.assertEqual(result["model_preflight"], "live_family_resolved")
        self.assertEqual(result["answer"], "Use a shared lock file; unlinking it races.")
        self.assertIn("kernel version", result["uncertainty"])
        self.assertEqual(result["sections"], {"ANSWER": result["answer"], "UNCERTAINTY": result["uncertainty"]})
        self.assertEqual(
            (result["answer_format"], result["writes_allowed"], result["timeout"]), ("structured", False, "10m")
        )
        self.assertEqual(result["session_id"], "codex-thread-7")
        self.assertEqual(result["usage"]["totals"]["output"], 30)
        self.assertEqual(
            result["attachments"], [{"name": "lock.py", "path": str(attachment), "bytes": attachment.stat().st_size}]
        )
        self.assertIsNone(result["repository_delta"], "a question reads no repository")
        capture = self.capture()
        argv = capture["argv"]
        self.assertEqual(argv[:2], ["exec", "-C"])
        self.assertEqual(argv[2], result["workspace"])
        self.assertIn("--skip-git-repo-check", argv)
        self.assertIn('sandbox_mode="read-only"', argv)
        self.assertIn('approval_policy="never"', argv)
        self.assertIn('model_reasoning_effort="high"', argv)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", argv)
        self.assertEqual(sorted(os.listdir(result["workspace"])), [], "the consultant works in an empty workspace")
        prompt = capture["stdin"]
        self.assertIn("## Question\n\nShould the lock file be unlinked?", prompt)
        self.assertIn("## Context\n\nWe use flock on macOS.", prompt)
        self.assertIn("### lock.py\n\n````\ndef lock():", prompt, "a fence longer than the content's backticks")
        self.assertNotIn(str(attachment), prompt, "host paths stay out of the prompt")
        self.assertIn("You are answering one focused question for a colleague agent.", prompt)
        self.assertNotIn("trusted specialist", prompt)
        self.assertIn("no permission to edit files", prompt)
        self.assertIn("### UNCERTAINTY", prompt)
        self.assertIn("AGENT_CONSULT_STATUS=answered", summary)
        self.assertIn("AGENT_MODEL=gpt-5.6-sol", summary)
        self.assertIn("--- ANSWER ---\nUse a shared lock file; unlinking it races.\n--- UNCERTAINTY ---", summary)

    def test_claude_host_hands_a_claude_question_to_native_tools(self) -> None:
        env = self.environment(CLAUDECODE="1")
        code, result, summary = self.consult("--question", "Which lock?", "--model", "opus", env=env)
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(
            (result["status"], result["transport"], result["host"], result["engine"]),
            ("native_handoff", "native", "claude", "claude"),
        )
        self.assertFalse(self.unsafe_path.exists(), "no CLI copy of Claude may be launched for a native question")
        self.assertFalse(self.capture_path.exists())
        self.assertIn("## Question\n\nWhich lock?", Path(result["prompt_path"]).read_text(encoding="utf-8"))
        self.assertIsNone(result["answer"])
        self.assertIn("AGENT_CONSULT_STATUS=native_handoff", summary)
        self.assertIn("Agent tool", summary)
        self.assertIn("--transport executor", summary)

    def test_transport_executor_runs_claude_code_without_tools_or_mcp(self) -> None:
        env = self.environment(
            CLAUDECODE="1", CLAUDE_CODE_MESSAGING_TOKEN="host-secret", CLAUDE_CONFIG_DIR="/host/profile"
        )
        code, result, _summary = self.consult(
            "--question", "Which lock?", "--model", "opus", "--effort", "xhigh", "--transport", "executor", env=env
        )
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(
            (result["status"], result["transport"], result["engine"], result["model"]),
            ("answered", "executor", "claude", "opus"),
        )
        self.assertEqual(result["model_observed"], ["claude-opus-4-9"])
        self.assertEqual(result["session_id"], "claude-session-9")
        capture = self.capture()
        argv = capture["argv"]
        self.assertEqual(argv[argv.index("--tools") + 1], "", "no built-in tools")
        self.assertIn("--strict-mcp-config", argv)
        self.assertNotIn("bypassPermissions", argv)
        self.assertNotIn("--add-dir", argv)
        self.assertEqual(argv[argv.index("--effort") + 1], "xhigh")
        self.assertIn("--session-id", argv)
        self.assertEqual(capture["env"].get("CLAUDECODE"), None, "the host session never leaks into the consultant")
        self.assertEqual(capture["env"].get("CLAUDE_CODE_MESSAGING_TOKEN"), None)
        self.assertEqual(
            capture["env"].get("CLAUDE_CONFIG_DIR"), None, "the default profile answers unless one is chosen"
        )

    def test_a_chosen_claude_profile_is_a_billing_boundary_native_tools_cannot_cross(self) -> None:
        profile = self.root / "other-profile"
        profile.mkdir()
        env = self.environment(CLAUDECODE="1")
        code, result, _summary = self.consult(
            "--question", "Which lock?", "--model", "opus", "--claude-config-dir", str(profile), env=env
        )
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(
            (result["status"], result["transport"], result["claude_config_dir"]), ("answered", "executor", str(profile))
        )
        self.assertEqual(self.capture()["env"].get("CLAUDE_CONFIG_DIR"), str(profile))

    def test_transport_native_needs_a_host_that_runs_the_model(self) -> None:
        code, result, _summary = self.consult("--question", "Which lock?", "--model", "opus", "--transport", "native")
        self.assertEqual(code, 4)
        self.assertIn("--transport native", result["error"])

    def test_engine_is_inferred_from_the_model_family(self) -> None:
        code, result, _summary = self.consult("--question", "Which lock?", "--model", "gemini-3.8-flash-medium")
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(
            (result["engine"], result["model"], result["model_observed"]),
            ("agy", "gemini-3.8-flash-medium", ["gemini-3.8-flash-medium"]),
        )
        self.assertEqual(result["effort"]["bound"], "medium")
        argv = self.capture()["argv"]
        self.assertEqual(argv[argv.index("--mode") + 1], "plan")
        self.assertNotIn("--dangerously-skip-permissions", argv)
        self.assertIn("--new-project", argv)
        self.assertNotIn("--add-dir", argv)
        self.assertEqual(self.capture()["stream_input"][0]["event"], "user")
        self.assertEqual(result["session_id"], "22222222-2222-2222-2222-222222222222")

    def test_opencode_uses_the_read_only_plan_agent_without_auto_approval(self) -> None:
        code, result, _summary = self.consult("--question", "Which lock?", "--model", "glm:flash")
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(
            (result["engine"], result["model"], result["variant"]),
            ("opencode", "openrouter/~z-ai/glm-flash-latest", "high"),
        )
        capture = self.capture()
        argv = capture["argv"]
        self.assertEqual(argv[argv.index("--agent") + 1], "plan")
        self.assertNotIn("--auto", argv)
        self.assertIn("--standalone", argv, "the shared background service would ignore this run's configuration")
        config = json.loads(capture["env"]["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(config["mcp"], {})
        self.assertFalse(any(config["tools"].values()), "a question runs with no tools at all")
        self.assertTrue({"read", "glob", "grep", "write", "shell", "execute"} <= set(config["tools"]))
        self.assertEqual(capture["env"]["OPENCODE_DISABLE_PROJECT_CONFIG"], "1")
        self.assertEqual(argv[argv.index("--model") + 1], "openrouter/~z-ai/glm-flash-latest#high")
        self.assertEqual(json.loads(capture["env"]["OPENCODE_PERMISSION"])["bash"], "deny")
        self.assertIn("## Question\n\nWhich lock?", capture["attached"])
        self.assertEqual(result["session_id"], "ses_consult_1")

    def test_hosted_models_never_go_through_opencode(self) -> None:
        code, result, _summary = self.consult(
            "--question", "Which lock?", "--model", "openrouter/anthropic/claude-opus-4", "--engine", "opencode"
        )
        self.assertEqual(code, 17)
        self.assertIn("--engine claude", result["error"])

    def test_follow_up_resumes_the_session_and_pins_what_answered(self) -> None:
        code, first, _summary = self.consult("--question", "Which lock?", "--model", "gpt-5.6-luna", "--effort", "low")
        self.assertEqual(code, 0, first.get("error"))
        code, second, _summary = self.consult("--question", "And on Linux?", "--follow-up", first["result_path"])
        self.assertEqual(code, 0, second.get("error"))
        self.assertEqual(
            (second["status"], second["model"], second["effort"]["bound"]), ("answered", "gpt-5.6-luna", "low")
        )
        self.assertEqual(second["follow_up_of"], first["result_path"])
        argv = self.capture()["argv"]
        self.assertEqual(argv[:3], ["exec", "resume", "codex-thread-7"])
        self.assertIn('sandbox_mode="read-only"', argv)
        self.assertIn("# Follow-up to the consultation", self.capture()["stdin"])
        self.assertEqual(
            second["usage"]["totals"]["output"], 0, "a resumed Codex session reports usage since the baseline"
        )
        for refused_args, expected in (
            (["--model", "gpt-5.6-sol"], "stays on gpt-5.6-luna"),
            (["--effort", "max"], "stays on effort low"),
            (["--intent", "review"], "keeps the question intent"),
            (["--read", str(self.repository)], "keeps the repository"),
        ):
            with self.subTest(refused=refused_args):
                code, refused, _summary = self.consult(
                    "--question", "And on Linux?", "--follow-up", first["result_path"], *refused_args
                )
                self.assertEqual(code, 4)
                self.assertIn(expected, refused["error"])

    def test_follow_up_reuses_the_workspace_the_session_started_in(self) -> None:
        code, first, _summary = self.consult("--question", "Which lock?", "--model", "glm:flash")
        self.assertEqual(code, 0, first.get("error"))
        code, second, _summary = self.consult("--question", "Why?", "--follow-up", first["result_path"])
        self.assertEqual(code, 0, second.get("error"))
        self.assertEqual(second["workspace"], first["workspace"])
        self.assertEqual(self.capture()["cwd"], first["workspace"])
        self.assertEqual(self.capture()["argv"][:3], ["run", "--session", "ses_consult_1"])

    def test_attachments_refuse_secret_names_directories_symlinks_binaries_and_oversize_files(self) -> None:
        secret = self.root / "server.key"
        secret.write_text("not really\n", encoding="utf-8")
        cases: list[tuple[Path, str]] = [(secret, "holds credentials")]
        ssh = self.root / ".ssh"
        ssh.mkdir()
        (ssh / "config").write_text("Host x\n", encoding="utf-8")
        cases.append((ssh / "config", "holds credentials"))
        link = self.root / "harmless.txt"
        link.symlink_to(secret)
        cases.append((link, "holds credentials"))
        binary = self.root / "image.bin"
        binary.write_bytes(b"\x89PNG\x00\x00")
        cases.append((binary, "looks binary"))
        huge = self.root / "huge.log"
        huge.write_text("x" * (CONSULT.MAX_ATTACHMENT_BYTES + 1), encoding="utf-8")
        cases.append((huge, "KiB"))
        for path, message in cases:
            with self.subTest(path=path.name):
                code, result, _ = self.consult("--question", "Why?", "--attach", str(path))
                self.assertEqual(code, 4)
                self.assertIn(message, result["error"])
        self.assertFalse(self.capture_path.exists(), "nothing reaches a model when the inputs are refused")

    def test_an_unstructured_reply_is_still_the_answer(self) -> None:
        env = self.environment(FAKE_RESPONSE="Just unlink it after closing the descriptor.")
        code, result, summary = self.consult("--question", "Why?", "--model", "gpt-5.6-luna", env=env)
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(
            (result["answer"], result["uncertainty"], result["answer_format"]),
            (
                "Just unlink it after closing the descriptor.",
                None,
                "unstructured",
            ),
        )
        self.assertIn("(the consultant gave no such section)", summary)

    def test_provider_quota_and_ordinary_failures_keep_their_exit_codes(self) -> None:
        env = self.environment(FAKE_EXIT="1", FAKE_STDERR="error: rate limit exceeded for this account")
        code, result, _ = self.consult("--question", "Why?", "--model", "gpt-5.6-luna", env=env)
        self.assertEqual((code, result["status"]), (16, "provider_quota_exhausted"))
        env = self.environment(FAKE_EXIT="2", FAKE_STDERR="boom")
        code, result, _ = self.consult("--question", "Why?", "--model", "gpt-5.6-luna", env=env)
        self.assertEqual((code, result["status"], result["answer"]), (1, "failed", None))
        self.assertEqual(result["stderr_tail"], ["boom"])
        env = self.environment(
            FAKE_AGY_STATUS="error", FAKE_AGY_ERROR="RESOURCE_EXHAUSTED (code 429)", FAKE_RESPONSE=""
        )
        code, result, _ = self.consult("--question", "Why?", "--model", "gemini-3.8-flash-medium", env=env)
        self.assertEqual((code, result["status"]), (16, "provider_quota_exhausted"))

    def test_dry_run_resolves_everything_without_calling_a_model(self) -> None:
        code, result, summary = self.consult(
            "--question", "Why?", "--model", "gpt-5.6-luna", "--dry-run", "--format", "json"
        )
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(result["status"], "dry_run")
        self.assertIn('sandbox_mode="read-only"', result["command"])
        self.assertFalse(self.capture_path.exists())
        self.assertEqual(json.loads(summary)["status"], "dry_run")

    def test_repeated_models_collapse_duplicates_and_write_separate_json_results(self) -> None:
        preflight_models = []
        quota_models = []
        original_preflight = CONSULT.preflight
        original_quota_gate = RUNNER.quota_gate

        def track_preflight(request):
            preflight_models.append(request["requested_model"])
            return original_preflight(request)

        def track_quota(engine, model, **kwargs):
            quota_models.append((engine, model))
            return original_quota_gate(engine, model, **kwargs)

        with (
            mock.patch.object(CONSULT, "preflight", side_effect=track_preflight),
            mock.patch.object(RUNNER, "quota_gate", side_effect=track_quota),
        ):
            code, panel, output = self.consult(
                "--question",
                "Why?",
                "--model",
                "gpt:sol",
                "--model",
                "gpt:luna,gpt:sol",
                "--format",
                "json",
            )

        self.assertEqual(code, 0)
        encoded = json.loads(output)
        self.assertTrue(encoded["panel"])
        self.assertEqual(encoded["result_path"], panel["result_path"])
        consultants = panel["consultants"]
        self.assertEqual([result["requested_model"] for result in consultants], ["gpt:sol", "gpt:luna"])
        self.assertEqual([result["status"] for result in consultants], ["answered", "answered"])
        paths = [Path(result["result_path"]) for result in consultants]
        self.assertEqual(len(set(paths)), 2)
        self.assertTrue(all(path.is_file() for path in paths))
        self.assertCountEqual(preflight_models, ["gpt:sol", "gpt:luna"])
        self.assertCountEqual(quota_models, [("codex", "gpt-5.6-sol"), ("codex", "gpt-5.6-luna")])
        saved_panel = json.loads(Path(panel["result_path"]).read_text(encoding="utf-8"))
        self.assertTrue(saved_panel["panel"])
        self.assertEqual(
            [(result["result_path"], result["status"]) for result in saved_panel["consultants"]],
            [(result["result_path"], result["status"]) for result in consultants],
        )

    def test_comma_separated_models_print_labeled_answers_in_input_order(self) -> None:
        code, panel, output = self.consult("--question", "Why?", "--model", "gpt:sol,gpt:luna", "--format", "text")
        self.assertEqual(code, 0)
        self.assertTrue(panel["panel"])
        first = output.index("--- CONSULTANT 1 BEGIN ---")
        second = output.index("--- CONSULTANT 2 BEGIN ---")
        self.assertLess(first, second)
        first_block, second_block = output[first:second], output[second:]
        self.assertIn("MODEL=gpt-5.6-sol", first_block)
        self.assertIn("ENGINE=codex", first_block)
        self.assertIn("STATUS=answered", first_block)
        self.assertIn("--- ANSWER ---\nUse a shared lock file; unlinking it races.", first_block)
        self.assertIn(
            "--- UNCERTAINTY ---\nI could not verify the kernel version; on 5.x the semantics differ.", first_block
        )
        self.assertIn("MODEL=gpt-5.6-luna", second_block)
        self.assertIn("ENGINE=codex", second_block)
        self.assertIn("STATUS=answered", second_block)
        self.assertIn("--- ANSWER ---\nUse a shared lock file; unlinking it races.", second_block)

    def test_panel_reads_stdin_once_and_sends_the_same_question_to_each_model(self) -> None:
        with mock.patch("sys.stdin", io.StringIO("Which lock file?\n")):
            code, panel, _output = self.consult(
                "--question", "-", "--model", "gpt-5.6-sol,gpt-5.6-luna", "--format", "json"
            )
        self.assertEqual(code, 0, panel)
        self.assertEqual([result["question"] for result in panel["consultants"]], ["Which lock file?"] * 2)
        prompts = [Path(result["prompt_path"]).read_text(encoding="utf-8") for result in panel["consultants"]]
        self.assertEqual(prompts[0], prompts[1])

    def test_a_quota_refusal_does_not_stop_another_panel_consultant(self) -> None:
        quota_models = []
        original_quota_gate = RUNNER.quota_gate

        def refuse_sol(engine, model, **kwargs):
            quota_models.append(model)
            if model == "gpt-5.6-sol":
                raise RUNNER.RunnerError("quota exhausted for sol", 15)
            return original_quota_gate(engine, model, **kwargs)

        with mock.patch.object(RUNNER, "quota_gate", side_effect=refuse_sol):
            code, panel, output = self.consult(
                "--question", "Why?", "--model", "gpt-5.6-sol,gpt-5.6-luna", "--format", "text"
            )

        self.assertEqual(code, 0)
        self.assertEqual([result["status"] for result in panel["consultants"]], ["refused", "answered"])
        self.assertEqual(panel["consultants"][0]["error"], "quota exhausted for sol")
        self.assertIn("STATUS=refused", output)
        self.assertIn("ERROR=quota exhausted for sol", output)
        self.assertIn("Use a shared lock file; unlinking it races.", output)
        self.assertCountEqual(quota_models, ["gpt-5.6-sol", "gpt-5.6-luna"])

    def test_repository_policy_is_checked_for_every_panel_consultant(self) -> None:
        checked = []

        def deny_sol(_cwd, engine, _claude_config_dir=None):
            checked.append(engine)
            if len(checked) == 1:
                raise RUNNER.RunnerError("Harness 'codex' is denied by repository policy", 2)

        with mock.patch.object(RUNNER, "enforce_repo_policy", side_effect=deny_sol):
            code, panel, output = self.consult(
                "--question", "Why?", "--model", "gpt-5.6-sol,gpt-5.6-luna", "--format", "text"
            )

        self.assertEqual(len(checked), 2)
        self.assertEqual(code, 0)
        self.assertEqual(sorted(result["status"] for result in panel["consultants"]), ["answered", "refused"])
        self.assertIn("denied by repository policy", output)

    def test_a_single_consultation_is_refused_by_repository_policy_before_it_runs(self) -> None:
        denied = RUNNER.RunnerError("Harness 'codex' is denied by repository policy", 2)
        with (
            mock.patch.object(RUNNER, "enforce_repo_policy", side_effect=denied) as policy,
            mock.patch.object(CONSULT, "perform") as perform,
            self.assertRaises(RUNNER.RunnerError) as raised,
        ):
            CONSULT.main(["--question", "Why?", "--model", "gpt-5.6-luna"])

        self.assertEqual(raised.exception.exit_code, 2)
        policy.assert_called_once()
        perform.assert_not_called()

    def test_enforce_policy_propagates_returned_claude_config_dir_and_preserves_explicit_profile(self) -> None:
        auto_dir = self.root / "auto-alt"
        auto_dir.mkdir()
        env = self.environment(CLAUDE_CODE_SESSION_ID="host-claude")

        with mock.patch.object(RUNNER, "enforce_repo_policy", return_value=auto_dir) as policy:
            code, result, _ = self.consult("--question", "Why?", "--model", "opus", "--format", "text", env=env)

        self.assertEqual(code, 0, result)
        policy.assert_called_once()
        self.assertEqual(result["status"], "answered")
        self.assertEqual(result["transport"], "executor")
        self.assertEqual(result["claude_config_dir"], str(auto_dir))
        capture = json.loads(self.capture_path.read_text(encoding="utf-8"))
        self.assertEqual(capture["env"].get("CLAUDE_CONFIG_DIR"), str(auto_dir))

        explicit_dir = self.root / "explicit-alt"
        explicit_dir.mkdir()
        with mock.patch.object(RUNNER, "enforce_repo_policy", return_value=None):
            code2, result2, _ = self.consult(
                "--question",
                "Why?",
                "--model",
                "opus",
                "--claude-config-dir",
                str(explicit_dir),
                "--format",
                "text",
                env=env,
            )

        self.assertEqual(code2, 0, result2)
        self.assertEqual(result2["claude_config_dir"], str(explicit_dir))
        capture2 = json.loads(self.capture_path.read_text(encoding="utf-8"))
        self.assertEqual(capture2["env"].get("CLAUDE_CONFIG_DIR"), str(explicit_dir))

    def test_native_transport_verifies_effective_host_profile_and_rejects_profile_switch(self) -> None:
        work_dir = self.root / ".claude"
        work_dir.mkdir(exist_ok=True)
        alt_dir = self.root / ".claude-alt"
        alt_dir.mkdir(exist_ok=True)
        monitor_cfg = self.root / "monitor-consult-native.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "claude-work", "provider": "claude", "tags": ["work"], "configDir": str(work_dir)},
                        {
                            "id": "claude-alt",
                            "provider": "claude",
                            "alias": "claude-alt",
                            "tags": ["personal"],
                            "configDir": str(alt_dir),
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        work_env = self.environment(CLAUDECODE="1", HOME=str(self.root), MONITOR_CONFIG=str(monitor_cfg))
        work_env.pop("CLAUDE_CONFIG_DIR", None)

        # 1. Explicit --transport native with explicit alt dir on a work host is refused
        code, result, _ = self.consult(
            "--question",
            "Why?",
            "--model",
            "opus",
            "--transport",
            "native",
            "--claude-config-dir",
            str(alt_dir),
            env=work_env,
        )
        self.assertEqual(code, 4)
        self.assertIn("--transport native", result["error"])

        # 2. Explicit --transport native on a work host whose work profile is denied fails even if ORCHESTRATE_AUTO_ACCOUNT=1
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["claude-work"]}), encoding="utf-8")
        try:
            auto_work_env = {**work_env, "ORCHESTRATE_AUTO_ACCOUNT": "1"}
            code_native, res_native, _ = self.consult(
                "--question",
                "Why?",
                "--model",
                "opus",
                "--read",
                str(self.repository),
                "--transport",
                "native",
                env=auto_work_env,
            )
            self.assertEqual(code_native, 4)
            self.assertIn("--transport native", res_native["error"])

            # 3. auto transport on the same denied work host reroutes to executor with allowed alt account
            code_auto, res_auto, _ = self.consult(
                "--question",
                "Why?",
                "--model",
                "opus",
                "--read",
                str(self.repository),
                env=auto_work_env,
            )
            self.assertEqual(code_auto, 0, res_auto)
            self.assertEqual(res_auto["transport"], "executor")
            self.assertEqual(res_auto["claude_config_dir"], str(alt_dir))
            self.assertEqual(res_auto["account_id"], "claude-alt")

            # 4. Host actually running on alt CLAUDE_CONFIG_DIR is allowed for native transport
            alt_host_env = {**work_env, "CLAUDE_CONFIG_DIR": str(alt_dir)}
            code_alt, res_alt, _ = self.consult(
                "--question",
                "Why?",
                "--model",
                "opus",
                "--read",
                str(self.repository),
                "--transport",
                "native",
                env=alt_host_env,
            )
            self.assertEqual(code_alt, 0, res_alt)
            self.assertEqual(res_alt["status"], "native_handoff")
        finally:
            (policy_dir / "policy.json").unlink(missing_ok=True)

    def test_follow_up_refuses_denied_original_profile_instead_of_swapping_accounts(self) -> None:
        work_dir = self.root / ".claude"
        work_dir.mkdir(exist_ok=True)
        alt_dir = self.root / ".claude-alt"
        alt_dir.mkdir(exist_ok=True)
        monitor_cfg = self.root / "monitor-consult-followup.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "claude-work", "provider": "claude", "tags": ["work"], "configDir": str(work_dir)},
                        {
                            "id": "claude-alt",
                            "provider": "claude",
                            "alias": "claude-alt",
                            "tags": ["personal"],
                            "configDir": str(alt_dir),
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        env = self.environment(HOME=str(self.root), MONITOR_CONFIG=str(monitor_cfg))
        env.pop("CLAUDE_CONFIG_DIR", None)

        code, first, _ = self.consult(
            "--question",
            "Which lock?",
            "--model",
            "opus",
            "--read",
            str(self.repository),
            env=env,
        )
        self.assertEqual(code, 0, first)
        self.assertIsNone(first["claude_config_dir"])

        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["claude-work"]}), encoding="utf-8")
        try:
            auto_env = {**env, "ORCHESTRATE_AUTO_ACCOUNT": "1"}
            code2, refused, _ = self.consult(
                "--question",
                "Follow up?",
                "--follow-up",
                first["result_path"],
                env=auto_env,
            )
            self.assertEqual(code2, 2)
            self.assertIn("fresh consultation", refused["error"])
        finally:
            (policy_dir / "policy.json").unlink(missing_ok=True)

    def test_repo_policy_enforces_account_and_tag_denials_and_cli_rejects_contradictory_account(self) -> None:
        repo_policy = RUNNER.bundled_module("repo_policy")
        work_dir = self.root / ".claude"
        alt_dir = self.root / ".claude-alt"
        monitor_cfg = self.root / "monitor-policy-tags.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "claude-work", "provider": "claude", "tags": ["work"], "configDir": str(work_dir)},
                        {
                            "id": "claude-alt",
                            "provider": "claude",
                            "alias": "claude-alt",
                            "tags": ["personal", "client-a"],
                            "configDir": str(alt_dir),
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        cfg = {"repo_policies": [{"path": str(self.repository), "deny": ["claude-work", "tag:client-a"]}]}
        ok1, msg1, _ = repo_policy.check_execution_allowed(
            self.repository,
            "claude",
            alt_dir,
            config=cfg,
            home=self.root,
            monitor_config_path=monitor_cfg,
            strict=True,
        )
        self.assertFalse(ok1)
        self.assertIn("client-a", msg1 or "")

        ok2, msg2, _ = repo_policy.check_execution_allowed(
            self.repository,
            "claude",
            work_dir,
            config=cfg,
            home=self.root,
            monitor_config_path=monitor_cfg,
            strict=True,
        )
        self.assertFalse(ok2)
        self.assertIn("claude-work", msg2 or "")

        # CLI --account contradicting --claude-config-dir fails closed.
        code_bad, res_bad, _ = self.consult(
            "--question",
            "Why?",
            "--account",
            "claude-alt",
            "--claude-config-dir",
            str(work_dir),
            env=self.environment(HOME=str(self.root), MONITOR_CONFIG=str(monitor_cfg)),
        )
        self.assertEqual(code_bad, 4)
        self.assertIn("contradicts", res_bad["error"])

    def test_enforce_policy_isolates_returned_claude_config_dir_per_panel_member(self) -> None:
        auto_dir = self.root / "panel-auto-alt"
        auto_dir.mkdir()

        def policy_for_member(_cwd, engine, claude_config_dir=None, **_kwargs):
            if engine == "claude":
                return auto_dir
            return None

        with mock.patch.object(RUNNER, "enforce_repo_policy", side_effect=policy_for_member):
            code, panel, _ = self.consult("--question", "Why?", "--model", "opus,gpt-5.6-luna", "--format", "json")

        self.assertEqual(code, 0, panel)
        by_engine = {member["engine"]: member for member in panel["consultants"]}
        self.assertEqual(by_engine["claude"]["claude_config_dir"], str(auto_dir))
        self.assertIsNone(by_engine["codex"]["claude_config_dir"])

    def test_all_failed_panel_uses_the_first_consultants_exit_code(self) -> None:
        def refuse_both(_engine, model, **_kwargs):
            code = 15 if model == "gpt-5.6-sol" else 18
            raise RUNNER.RunnerError(f"refused {model}", code)

        with mock.patch.object(RUNNER, "quota_gate", side_effect=refuse_both):
            code, panel, _output = self.consult(
                "--question", "Why?", "--model", "gpt-5.6-sol,gpt-5.6-luna", "--format", "json"
            )
        self.assertEqual(code, 15)
        self.assertEqual(panel["exit_code"], 15)
        self.assertEqual([result["exit_code"] for result in panel["consultants"]], [15, 18])
        self.assertEqual([result["status"] for result in panel["consultants"]], ["refused", "refused"])

    def test_panel_rejects_follow_up_detach_and_native_handoff_before_preflight(self) -> None:
        previous = self.root / "previous-result.json"
        previous.write_text(
            json.dumps(
                {
                    "schema": CONSULT.RESULT_SCHEMA,
                    "status": "answered",
                    "transport": "executor",
                    "session_id": "session-1",
                    "engine": "codex",
                    "model": "gpt-5.6-sol",
                }
            ),
            encoding="utf-8",
        )
        with mock.patch.object(CONSULT, "preflight", side_effect=AssertionError("preflight must not run")):
            code, result, _ = self.consult(
                "--question",
                "Why?",
                "--model",
                "gpt-5.6-sol,gpt-5.6-luna",
                "--follow-up",
                str(previous),
            )
            self.assertEqual(code, 4)
            self.assertIn("--follow-up", result["error"])

            code, result, _ = self.consult("--question", "Why?", "--model", "gpt-5.6-sol,gpt-5.6-luna", "--detach")
            self.assertEqual(code, 4)
            self.assertIn("--detach", result["error"])

            code, result, _ = self.consult(
                "--question",
                "Why?",
                "--model",
                "gpt-5.6-sol,gpt-5.6-luna",
                env=self.environment(CODEX_THREAD_ID="caller-session"),
            )
            self.assertEqual(code, 4)
            self.assertIn("executor transport", result["error"])
        self.assertFalse(self.capture_path.exists())

    def test_detached_consultation_runs_the_resolved_model_and_publishes_an_event(self) -> None:
        env = self.environment(AGENT_MAILBOX_SESSION="detached-supervisor")
        code, _result, summary = self.consult(
            "--question", "Why?", "--model", "gpt:luna", "--detach", "--notify", "none", env=env
        )
        self.assertEqual(code, 0)
        lines = dict(line.split("=", 1) for line in summary.splitlines() if "=" in line)
        self.assertEqual(lines["AGENT_JOB_STATUS"], "started")
        request = json.loads((Path(lines["AGENT_JOB"]).parent / "request.json").read_text(encoding="utf-8"))
        self.assertEqual(
            (request["model"], request["requested_model"]), ("gpt-5.6-luna", "gpt:luna"), "resolved before detaching"
        )
        self.assertEqual(request["parent_session"], "detached-supervisor")
        event_path = Path(lines["AGENT_EVENT"])
        result_path = Path(lines["AGENT_RESULT"])
        deadline = time.monotonic() + 30
        while not event_path.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(event_path.exists(), "the background consultation must publish its event")
        event = json.loads(event_path.read_text(encoding="utf-8"))
        self.assertEqual(
            (event["status"], event["task_outcome"], event["result_path"]), ("answered", "answered", str(result_path))
        )
        result = json.loads(result_path.read_text(encoding="utf-8"))
        self.assertEqual(
            (result["answer"], result["model"], result["requested_model"]),
            ("Use a shared lock file; unlinking it races.", "gpt-5.6-luna", "gpt:luna"),
        )
        output = io.StringIO()
        with mock.patch.dict(os.environ, env), contextlib.redirect_stdout(output):
            self.assertEqual(RUNNER.events_main(["wait", str(event_path), "--timeout", "5s"]), 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "answered")

    def test_investigate_reads_the_repository_and_returns_findings_with_evidence(self) -> None:
        env = self.environment(FAKE_RESPONSE=FINDINGS)
        code, result, summary = self.consult(
            "--question",
            "Why does the lease break?",
            "--read",
            str(self.repository),
            "--model",
            "gpt-5.6-luna",
            env=env,
        )
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(
            (result["intent"], result["read"], result["workspace"], result["timeout"]),
            ("investigate", str(self.repository), str(self.repository), "20m"),
        )
        self.assertEqual(result["sections"]["FINDINGS"], "- high: lock.py:3 unlinks the lock while held.")
        self.assertIn("os.unlink", result["sections"]["EVIDENCE"])
        self.assertEqual((result["answer"], result["answer_format"]), (result["sections"]["FINDINGS"], "structured"))
        self.assertEqual(result["repository_delta"], {"changed_paths": [], "tracked_paths_changed": []})
        self.assertIn("read tools", result["tool_policy"])
        capture = self.capture()
        self.assertEqual(capture["cwd"], str(self.repository))
        self.assertEqual(capture["argv"][:3], ["exec", "-C", str(self.repository)])
        self.assertIn('sandbox_mode="read-only"', capture["argv"])
        self.assertIn(f"investigating why something happens in the repository at {self.repository}", capture["stdin"])
        self.assertIn("### FINDINGS", capture["stdin"])
        self.assertIn("--- FINDINGS ---", summary)
        self.assertIn("--- EVIDENCE ---", summary)

    def test_review_captures_the_diff_and_reads_with_claude_read_tools_only(self) -> None:
        (self.repository / "lock.py").write_text("import os\n\ndef release(path):\n    pass\n", encoding="utf-8")
        (self.repository / "notes.md").write_text("untracked\n", encoding="utf-8")
        env = self.environment(FAKE_RESPONSE=FINDINGS)
        code, result, _summary = self.consult(
            "--question",
            "Is this change safe?",
            "--intent",
            "review",
            "--read",
            str(self.repository),
            "--diff",
            "--attach",
            str(self.repository / "notes.md"),
            "--model",
            "opus",
            env=env,
        )
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual((result["intent"], result["diff_ref"]), ("review", "HEAD"))
        capture = self.capture()
        argv = capture["argv"]
        self.assertEqual(argv[argv.index("--tools") + 1], "Read,Grep,Glob")
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(capture["cwd"], str(self.repository))
        prompt = capture["stdin"]
        self.assertIn("## Change under review (git diff HEAD)", prompt)
        self.assertIn("?? notes.md", prompt)
        self.assertIn("-    os.unlink(path)\n+    pass", prompt)
        self.assertIn("### notes.md\n", prompt, "attachments inside the repository are labelled by relative path")
        self.assertIn("report findings, do not fix them", prompt)

    def test_read_intents_need_a_repository_and_diff_needs_read(self) -> None:
        code, result, _ = self.consult("--question", "Why?", "--intent", "investigate")
        self.assertEqual(code, 4)
        self.assertIn("needs --read", result["error"])
        code, result, _ = self.consult("--question", "Why?", "--diff")
        self.assertEqual(code, 4)
        self.assertIn("--diff needs --read", result["error"])
        code, result, _ = self.consult("--question", "Why?", "--read", str(self.root / "missing"))
        self.assertEqual(code, 4)

    def test_a_repository_change_during_reading_is_reported_not_judged(self) -> None:
        env = self.environment(FAKE_RESPONSE=FINDINGS, FAKE_WRITE_FILE=str(self.repository / "scratch.txt"))
        code, result, summary = self.consult(
            "--question", "Why?", "--read", str(self.repository), "--model", "gpt-5.6-luna", env=env
        )
        self.assertEqual(code, 0, result.get("error"))
        self.assertEqual(result["status"], "answered")
        self.assertEqual(result["repository_delta"]["changed_paths"], ["scratch.txt"])
        self.assertIn("AGENT_NOTE=repository_changed_during_consultation", summary)

    def test_a_reader_waits_for_no_one_but_is_refused_while_a_writer_holds_the_repository(self) -> None:
        support = RUNNER.bundled_module("execution_support")
        env = self.environment(FAKE_RESPONSE=FINDINGS)
        with (
            mock.patch.dict(os.environ, env),
            support.workspace_lease(self.repository, RUNNER.default_agent_cache_dir()),
        ):
            code, result, _ = self.consult(
                "--question", "Why?", "--read", str(self.repository), "--model", "gpt-5.6-luna", env=env
            )
        self.assertEqual(code, 27)
        self.assertIn("another executor owns the worktree", result["error"])

    def test_antigravity_denied_action_is_explained_and_the_session_can_be_nudged(self) -> None:
        env = self.environment(
            FAKE_RESPONSE="", FAKE_AGY_DENIED='[{"action": "command", "display_name": "RunCommand"}]'
        )
        code, result, summary = self.consult(
            "--question", "Why?", "--read", str(self.repository), "--model", "gemini-3.8-flash-medium", env=env
        )
        self.assertEqual((code, result["status"], result["denied_actions"]), (3, "empty_output", ["RunCommand"]))
        self.assertIn("denying RunCommand", result["error"])
        self.assertIn("AGENT_ERROR=Antigravity ended the turn", summary)
        self.assertIn("You cannot run commands", self.capture()["stream_input"][0]["message"]["content"])
        env = self.environment(FAKE_RESPONSE=FINDINGS)
        code, nudged, _ = self.consult(
            "--question", "Answer from what you read.", "--follow-up", result["result_path"], env=env
        )
        self.assertEqual((code, nudged["status"], nudged["read"]), (0, "answered", str(self.repository)))
        self.assertEqual(self.capture()["argv"][:2], ["--conversation", "22222222-2222-2222-2222-222222222222"])

    def test_opencode_reading_keeps_only_the_read_tools(self) -> None:
        env = self.environment(FAKE_RESPONSE=FINDINGS)
        code, result, _ = self.consult(
            "--question", "Why?", "--read", str(self.repository), "--model", "glm:flash", env=env
        )
        self.assertEqual(code, 0, result.get("error"))
        config = json.loads(self.capture()["env"]["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual([name for name, enabled in config["tools"].items() if enabled], [])
        self.assertTrue(
            {"read", "glob", "grep"}.isdisjoint(config["tools"]), "read tools stay at their default, enabled"
        )
        self.assertFalse(config["tools"]["write"] or config["tools"]["shell"] or config["tools"]["execute"])
        self.assertEqual(self.capture()["cwd"], str(self.repository))

    def test_artifacts_never_land_inside_the_repository_being_read(self) -> None:
        code, result, _ = self.consult(
            "--question",
            "Why?",
            "--read",
            str(self.repository),
            "--model",
            "gpt-5.6-luna",
            "--out-dir",
            str(self.repository / "consult-out"),
        )
        self.assertEqual(code, 4)
        self.assertIn("--out-dir must be outside the --read repository", result["error"])
        self.assertFalse((self.repository / "consult-out").exists())

    def test_follow_up_refuses_a_session_whose_workspace_is_gone(self) -> None:
        code, first, _ = self.consult("--question", "Which lock?", "--model", "glm:flash")
        self.assertEqual(code, 0, first.get("error"))
        shutil.rmtree(first["workspace"])
        code, result, _ = self.consult("--question", "Why?", "--follow-up", first["result_path"])
        self.assertEqual(code, 4)
        self.assertIn("no longer exists", result["error"])

    def test_detached_reading_consultation_belongs_to_its_repository(self) -> None:
        env = self.environment(FAKE_RESPONSE=FINDINGS)
        code, _result, summary = self.consult(
            "--question",
            "Why?",
            "--read",
            str(self.repository),
            "--model",
            "gpt-5.6-luna",
            "--detach",
            "--notify",
            "none",
            env=env,
        )
        self.assertEqual(code, 0)
        lines = dict(line.split("=", 1) for line in summary.splitlines() if "=" in line)
        self.assertEqual(
            json.loads(Path(lines["AGENT_JOB"]).read_text(encoding="utf-8"))["repository"], str(self.repository)
        )
        output = io.StringIO()
        with mock.patch.dict(os.environ, env), contextlib.redirect_stdout(output):
            self.assertEqual(
                RUNNER.events_main(["wait", lines["AGENT_EVENT"], "--cwd", str(self.repository), "--timeout", "30s"]), 0
            )
        signal = json.loads(output.getvalue())
        self.assertEqual((signal["status"], signal["repository"]), ("answered", str(self.repository)))

    def test_only_codex_is_offered_read_only_commands(self) -> None:
        env = self.environment(FAKE_RESPONSE=FINDINGS)
        self.consult("--question", "Why?", "--read", str(self.repository), "--model", "gpt-5.6-luna", env=env)
        self.assertIn("run read-only commands there", self.capture()["stdin"])
        env = self.environment(FAKE_RESPONSE=FINDINGS)
        self.consult("--question", "Why?", "--read", str(self.repository), "--model", "opus", env=env)
        self.assertIn("You cannot run commands", self.capture()["stdin"])

    def test_parse_sections_tolerates_decoration_and_ignores_fenced_headings(self) -> None:
        sections, shape = CONSULT.parse_sections("preamble\n**ANSWER**\nyes\n\n## Uncertainty:\nnone\n", "question")
        self.assertEqual((sections, shape), ({"ANSWER": "yes", "UNCERTAINTY": "none"}, "structured"))
        sections, shape = CONSULT.parse_sections("### ANSWER\nyes, because of X\n", "question")
        self.assertEqual((sections, shape), ({"ANSWER": "yes, because of X"}, "partial"))
        quoted = (
            "### ANSWER\nThe contract says:\n```\n### ANSWER\n### UNCERTAINTY\n```\nso use it.\n### UNCERTAINTY\nnone\n"
        )
        sections, shape = CONSULT.parse_sections(quoted, "question")
        self.assertEqual(shape, "structured")
        self.assertTrue(
            sections["ANSWER"].startswith("The contract says:") and sections["ANSWER"].endswith("so use it.")
        )
        self.assertEqual(sections["UNCERTAINTY"], "none")
        sections, shape = CONSULT.parse_sections(FINDINGS, "review")
        self.assertEqual((shape, list(sections)), ("structured", ["FINDINGS", "EVIDENCE", "UNCERTAINTY"]))

    def test_codex_consult_disables_configured_mcp_servers_and_strips_host_session_env(self) -> None:
        codex_home = self.root / "codex-home"
        codex_home.mkdir()
        (codex_home / "config.toml").write_text(
            '[mcp_servers.peer-mailbox]\ncommand = "python3"\n[mcp_servers."my.srv"]\ncommand = "python3"\n',
            encoding="utf-8",
        )
        proj_codex = self.repository / ".codex"
        proj_codex.mkdir()
        (proj_codex / "config.toml").write_text('[mcp_servers.repo-srv]\ncommand = "python3"\n', encoding="utf-8")
        env = self.environment(
            CODEX_HOME=str(codex_home),
            ANTIGRAVITY_CONVERSATION_ID="host-conv",
            ANTIGRAVITY_LS_ADDRESS="127.0.0.1:9999",
            ANTIGRAVITY_CSRF_TOKEN="secret",
            CODEX_THREAD_ID="host-thread",
            OPENCODE_SESSION_ID="host-opencode",
            CLAUDE_CODE_SESSION_ID="host-claude",
        )
        code, result, _summary = self.consult(
            "--question",
            "Check MCP isolation",
            "--read",
            str(self.repository),
            "--model",
            "gpt-5.6-luna",
            "--transport",
            "executor",
            env=env,
        )
        self.assertEqual(code, 0, result.get("error"))
        argv = self.capture()["argv"]
        self.assertIn("features.plugins=false", argv)
        self.assertIn("features.apps=false", argv)
        self.assertIn(
            'mcp_servers={"my.srv"={enabled=false},"peer-mailbox"={enabled=false},"repo-srv"={enabled=false}}',
            argv,
        )
        exec_env = RUNNER.executor_environment("codex", self.repository)
        with mock.patch.dict(os.environ, env):
            filtered = RUNNER.executor_environment("codex", self.repository)
        for leaked in (
            "ANTIGRAVITY_CONVERSATION_ID",
            "ANTIGRAVITY_LS_ADDRESS",
            "ANTIGRAVITY_CSRF_TOKEN",
            "CODEX_THREAD_ID",
            "OPENCODE_SESSION_ID",
            "CLAUDE_CODE_SESSION_ID",
        ):
            self.assertNotIn(leaked, filtered)
        self.assertEqual(filtered.get("CODEX_HOME"), str(codex_home))
        del exec_env

    def test_web_flag_and_web_research_route_enable_search_tools_and_url_citations(self) -> None:
        code, result, _summary = self.consult(
            "--question",
            "What changed in the latest release?",
            "--model",
            "opus",
            "--web",
            "--transport",
            "executor",
        )
        self.assertEqual(code, 0, result.get("error"))
        self.assertTrue(result["web"])
        capture = self.capture()
        argv = capture["argv"]
        self.assertEqual(argv[argv.index("--tools") + 1], "WebSearch,WebFetch")
        self.assertIn("cite URLs for external facts", capture["stdin"])

        env = self.environment(FAKE_RESPONSE=FINDINGS)
        code, result, _summary = self.consult(
            "--question",
            "Compare repo against upstream docs",
            "--read",
            str(self.repository),
            "--model",
            "opus",
            "--web",
            "--transport",
            "executor",
            env=env,
        )
        self.assertEqual(code, 0, result.get("error"))
        argv = self.capture()["argv"]
        self.assertEqual(argv[argv.index("--tools") + 1], "Read,Grep,Glob,WebSearch,WebFetch")

        code, result, _summary = self.consult(
            "--question",
            "Check latest benchmark results",
            "--model",
            "gpt-5.6-sol",
            "--route",
            "web-research",
            "--transport",
            "executor",
        )
        self.assertEqual(code, 0, result.get("error"))
        self.assertTrue(result["web"])
        self.assertIn("--search", self.capture()["argv"])
        self.assertIn("cite URLs for external facts", self.capture()["stdin"])

    def test_saved_request_rechecks_repo_policy_before_dispatch(self) -> None:
        request_path = self.root / "saved-request.json"
        request_payload = {
            "schema": CONSULT.REQUEST_SCHEMA,
            "intent": "investigate",
            "question": "Check lock safety",
            "context": None,
            "attachments": [],
            "change": None,
            "read": str(self.repository),
            "engine": "codex",
            "model": "gpt-5.6-sol",
            "requested_model": "gpt:sol",
            "effort": "high",
            "variant": None,
            "route": "consultation",
            "transport": "executor",
            "host": None,
            "billing_mode": "unknown",
            "timeout": "1m",
            "allow_credits": False,
            "ignore_quota": False,
            "web": False,
            "claude_config_dir": None,
        }
        request_path.write_text(json.dumps(request_payload), encoding="utf-8")
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["codex"]}), encoding="utf-8")
        try:
            env = self.environment()
            with mock.patch.dict(os.environ, env):
                event_path = RUNNER.prepare_completion_event_path()
                with (
                    mock.patch.object(CONSULT, "_perform") as perform_inner,
                    self.assertRaises(RUNNER.RunnerError) as raised,
                ):
                    CONSULT.main(
                        [
                            "--request",
                            str(request_path),
                            "--out-dir",
                            str(self.root / "child-run"),
                            "--completion-event",
                            str(event_path),
                        ]
                    )
            self.assertEqual(raised.exception.exit_code, 2)
            self.assertIn("denied", str(raised.exception))
            perform_inner.assert_not_called()
            self.assertTrue((self.root / "child-run" / "result.json").is_file())
            self.assertTrue(event_path.is_file())
        finally:
            (policy_dir / "policy.json").unlink(missing_ok=True)

    def test_native_transport_accepts_explicit_default_work_profile_and_rejects_personal_symlink_to_work(self) -> None:
        work_dir = self.root / ".claude"
        work_dir.mkdir(exist_ok=True)
        alt_link = self.root / ".claude-alt-symlink"
        alt_link.symlink_to(work_dir)
        monitor_cfg = self.root / "monitor-consult-symlink.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "claude-work", "provider": "claude", "tags": ["work"], "configDir": str(work_dir)},
                    ]
                }
            ),
            encoding="utf-8",
        )

        # 1. With CLAUDE_CONFIG_DIR unset, explicit --claude-config-dir ~/.claude matches host default for --transport native
        work_env = self.environment(CLAUDECODE="1", HOME=str(self.root), MONITOR_CONFIG=str(monitor_cfg))
        work_env.pop("CLAUDE_CONFIG_DIR", None)
        self.assertTrue(CONSULT._claude_profile_dirs_match("~/.claude", None))
        with mock.patch.dict(os.environ, work_env, clear=True):
            self.assertTrue(CONSULT._claude_profile_dirs_match(work_dir, None))
            code, res, _ = self.consult(
                "--question",
                "Why?",
                "--model",
                "opus",
                "--transport",
                "native",
                "--claude-config-dir",
                str(work_dir),
                env=work_env,
            )
        self.assertEqual(code, 0, res)
        self.assertEqual(res["status"], "native_handoff")

        # 2. A custom-named symlink pointing to ~/.claude cannot bypass claude-work denial
        repo_policy = RUNNER.bundled_module("repo_policy")
        cfg = {"repo_policies": [{"path": str(self.repository), "deny": ["claude-work"]}]}
        allowed, reason, _ = repo_policy.check_execution_allowed(
            self.repository,
            "claude",
            alt_link,
            config=cfg,
            home=self.root,
            monitor_config_path=monitor_cfg,
            strict=True,
        )
        self.assertFalse(allowed)
        self.assertIn("claude-work", reason or "")

    def test_detached_without_read_rechecks_originating_repo_policy_in_child(self) -> None:
        orig_cwd = Path.cwd()
        policy_dir = self.repository / ".orkest"
        env = self.environment()
        captured_popen: dict[str, object] = {}

        class _FakeProc:
            pid = 42424

            @staticmethod
            def wait() -> int:
                return 0

        real_popen = subprocess.Popen

        def fake_popen(cmd, **kwargs):
            if isinstance(cmd, (list, tuple)) and any("run_agent.py" in str(part) for part in cmd):
                captured_popen["cmd"] = cmd
                captured_popen["cwd"] = kwargs.get("cwd")
                return _FakeProc()
            return real_popen(cmd, **kwargs)

        try:
            os.chdir(self.repository)
            with (
                mock.patch.dict(os.environ, env),
                mock.patch.object(CONSULT.subprocess, "Popen", side_effect=fake_popen),
                mock.patch.object(
                    sys,
                    "argv",
                    [
                        str(SCRIPT),
                        "consult",
                        "--question",
                        "Why?",
                        "--model",
                        "gpt:luna",
                        "--detach",
                        "--notify",
                        "none",
                    ],
                ),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                code = RUNNER.main()
            self.assertEqual(code, 0)

            job_dir = Path(str(captured_popen["cwd"]))
            self.assertNotEqual(job_dir.resolve(), self.repository.resolve())
            request_path = job_dir / "request.json"
            saved_request = json.loads(request_path.read_text(encoding="utf-8"))
            self.assertIsNone(saved_request["read"])
            self.assertEqual(saved_request["policy_cwd"], str(self.repository.resolve()))

            # Originating repo adds a deny rule AFTER detached submission; child starts in job_dir outside the repo.
            policy_dir.mkdir(exist_ok=True)
            (policy_dir / "policy.json").write_text(json.dumps({"deny": ["codex"]}), encoding="utf-8")

            os.chdir(job_dir)
            cmd_args = list(captured_popen["cmd"])  # [python, run_agent.py, consult, ...]
            consult_argv = cmd_args[cmd_args.index("consult") + 1 :]
            with (
                mock.patch.dict(os.environ, env),
                mock.patch.object(CONSULT, "_perform") as perform_inner,
                self.assertRaises(RUNNER.RunnerError) as raised,
            ):
                CONSULT.main(consult_argv)
            self.assertEqual(raised.exception.exit_code, 2)
            self.assertIn("denied", str(raised.exception))
            perform_inner.assert_not_called()
            result = json.loads((job_dir / "run" / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "failed")
            self.assertIn("denied", result["error"])
            event_path = Path(consult_argv[consult_argv.index("--completion-event") + 1])
            self.assertTrue(event_path.is_file())
        finally:
            os.chdir(orig_cwd)
            (policy_dir / "policy.json").unlink(missing_ok=True)

    def test_repo_policy_strict_fails_closed_on_unreadable_local_policy_even_when_exists_returns_false(self) -> None:
        repo_policy = RUNNER.bundled_module("repo_policy")
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        policy_file = policy_dir / "policy.json"
        policy_file.write_text(json.dumps({"deny": ["codex"]}), encoding="utf-8")

        # Simulate Python 3.15 EACCES where Path.exists()/is_symlink() return False while read_text raises EACCES
        orig_read_text = Path.read_text

        def fake_read_text(path_self: Path, *args, **kwargs):
            if path_self == policy_file:
                raise PermissionError(13, "Permission denied", str(path_self))
            return orig_read_text(path_self, *args, **kwargs)

        with (
            mock.patch.object(Path, "exists", return_value=False),
            mock.patch.object(Path, "is_symlink", return_value=False),
            mock.patch.object(Path, "read_text", fake_read_text),
            self.assertRaises(repo_policy.PolicyConfigError),
        ):
            repo_policy.check_execution_allowed(
                self.repository,
                "codex",
                home=self.root,
                strict=True,
            )

        # Also fail closed if FileNotFoundError occurs while os.lstat on .orkest raises PermissionError
        orig_lstat = os.lstat

        def fake_file_not_found(path_self: Path, *args, **kwargs):
            if path_self == policy_file:
                raise FileNotFoundError(2, "No such file", str(path_self))
            return orig_read_text(path_self, *args, **kwargs)

        def fake_lstat(target, *args, **kwargs):
            if Path(target) == policy_dir:
                raise PermissionError(13, "Permission denied", str(target))
            return orig_lstat(target, *args, **kwargs)

        with (
            mock.patch.object(Path, "read_text", fake_file_not_found),
            mock.patch.object(os, "lstat", fake_lstat),
            self.assertRaises(repo_policy.PolicyConfigError),
        ):
            repo_policy.check_execution_allowed(
                self.repository,
                "codex",
                home=self.root,
                strict=True,
            )

        # Real filesystem chmod 0o000 on .orkest and non-directory .orkest also fail closed when non-root
        if os.geteuid() != 0:
            policy_dir.chmod(0o000)
            try:
                with self.assertRaises(repo_policy.PolicyConfigError):
                    repo_policy.check_execution_allowed(
                        self.repository,
                        "codex",
                        home=self.root,
                        strict=True,
                    )
            finally:
                policy_dir.chmod(0o755)

        policy_file.unlink()
        policy_dir.rmdir()
        policy_dir.write_text("not-a-directory", encoding="utf-8")
        try:
            with self.assertRaises(repo_policy.PolicyConfigError):
                repo_policy.check_execution_allowed(
                    self.repository,
                    "codex",
                    home=self.root,
                    strict=True,
                )
        finally:
            policy_dir.unlink()

    def test_explicit_default_account_pin_switches_host_profile_and_strips_inherited_env(self) -> None:
        alt_codex = self.root / ".codex-alt"
        alt_claude = self.root / ".claude-alt"
        work_agy = self.root / ".gemini" / "antigravity-work"
        personal_agy = self.root / ".gemini" / "antigravity-personal"
        for directory in (alt_codex, alt_claude, work_agy, personal_agy):
            directory.mkdir(parents=True, exist_ok=True)
        monitor_cfg = self.root / "monitor-pin.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "codex-default", "provider": "codex"},
                        {"id": "codex-alt", "provider": "codex", "codexHome": str(alt_codex)},
                        {"id": "claude-default", "provider": "claude"},
                        {"id": "claude-alt", "provider": "claude", "configDir": str(alt_claude)},
                        {"id": "agy-default", "provider": "antigravity"},
                        {
                            "id": "agy-work",
                            "provider": "antigravity",
                            "env": {"ANTIGRAVITY_APP_DATA_DIR": str(work_agy)},
                        },
                        {
                            "id": "agy-personal",
                            "provider": "antigravity",
                            "env": {"ANTIGRAVITY_APP_DATA_DIR": str(personal_agy)},
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )

        # 1. Host on alt CODEX_HOME + --account codex-default switches profile -> native rejected, auto uses executor,
        #    and consult_environment receives pinned_account=True so ORKEST_CODEX_ACCOUNT_HOME=/red is not applied.
        codex_env = self.environment(
            HOME=str(self.root),
            MONITOR_CONFIG=str(monitor_cfg),
            CODEX_THREAD_ID="codex-host-thread",
            CODEX_HOME=str(alt_codex),
            ORKEST_CODEX_ACCOUNT_HOME=str(alt_codex),
        )
        with mock.patch.dict(os.environ, codex_env, clear=True):
            self.assertTrue(
                CONSULT._route_switches_host_profile({"engine": "codex", "codex_home": None, "explicit_account": True})
            )
            code_native, res_native, _ = self.consult(
                "--question",
                "Why?",
                "--account",
                "codex-default",
                "--model",
                "gpt:luna",
                "--transport",
                "native",
                env=codex_env,
            )
        self.assertEqual(code_native, 4)
        self.assertIn("--transport executor", res_native["error"])

        seen_envs: list[dict[str, str]] = []
        orig_consult_env = CONSULT.consult_environment

        def spy_consult_env(*args, **kwargs):
            env_out = orig_consult_env(*args, **kwargs)
            seen_envs.append({"pinned": str(kwargs.get("pinned_account")), "codex_home": env_out.get("CODEX_HOME", "")})
            return env_out

        with (
            mock.patch.dict(os.environ, codex_env, clear=True),
            mock.patch.object(CONSULT, "consult_environment", side_effect=spy_consult_env),
        ):
            code_auto, res_auto, _ = self.consult(
                "--question",
                "Why?",
                "--account",
                "codex-default",
                "--model",
                "gpt:luna",
                env=codex_env,
            )
        self.assertEqual(code_auto, 0, res_auto)
        self.assertEqual(res_auto["transport"], "executor")
        self.assertTrue(res_auto["explicit_account"])
        self.assertEqual(seen_envs, [{"pinned": "True", "codex_home": ""}])

        # 2. Host on alt CLAUDE_CONFIG_DIR + --account claude-default switches profile -> native rejected.
        claude_env = self.environment(
            HOME=str(self.root),
            MONITOR_CONFIG=str(monitor_cfg),
            CLAUDECODE="1",
            CLAUDE_CONFIG_DIR=str(alt_claude),
        )
        with mock.patch.dict(os.environ, claude_env, clear=True):
            self.assertTrue(
                CONSULT._route_switches_host_profile(
                    {"engine": "claude", "claude_config_dir": None, "explicit_account": True}
                )
            )
            code_claude, res_claude, _ = self.consult(
                "--question",
                "Why?",
                "--account",
                "claude-default",
                "--model",
                "opus",
                "--transport",
                "native",
                env=claude_env,
            )
        self.assertEqual(code_claude, 4)
        self.assertIn("--transport executor", res_claude["error"])

        # 3. Agy host on antigravity-work: explicit default, agy-personal switch profile, agy-work matches host.
        agy_env = self.environment(
            HOME=str(self.root),
            MONITOR_CONFIG=str(monitor_cfg),
            ANTIGRAVITY_CONVERSATION_ID="agy-host-conv",
            GEMINI_CLI_HOME=str(self.root / ".gemini"),
            ANTIGRAVITY_APP_DATA_DIR=str(work_agy),
        )
        with mock.patch.dict(os.environ, agy_env, clear=True):
            self.assertTrue(
                CONSULT._route_switches_host_profile(
                    {"engine": "agy", "agy_home": None, "agy_app_data_dir": None, "explicit_account": True}
                )
            )
            self.assertTrue(
                CONSULT._route_switches_host_profile(
                    {
                        "engine": "agy",
                        "agy_home": str(self.root / ".gemini"),
                        "agy_app_data_dir": str(personal_agy),
                        "explicit_account": True,
                    }
                )
            )
            self.assertFalse(
                CONSULT._route_switches_host_profile(
                    {
                        "engine": "agy",
                        "agy_home": str(self.root / ".gemini"),
                        "agy_app_data_dir": str(work_agy),
                        "explicit_account": True,
                    }
                )
            )
            code_agy_native, res_agy_native, _ = self.consult(
                "--question",
                "Why?",
                "--account",
                "agy-default",
                "--model",
                "gemini-3.8-flash-medium",
                "--transport",
                "native",
                env=agy_env,
            )
            self.assertEqual(code_agy_native, 4)
            self.assertIn("--transport executor", res_agy_native["error"])

            code_agy_same, res_agy_same, _ = self.consult(
                "--question",
                "Why?",
                "--account",
                "agy-work",
                "--model",
                "gemini-3.8-flash-medium",
                "--transport",
                "native",
                env=agy_env,
            )
            self.assertEqual(code_agy_same, 0, res_agy_same)
            self.assertEqual(res_agy_same["status"], "native_handoff")

    def test_auto_account_fallback_pins_request_switches_transport_and_detached_env(self) -> None:
        alt_codex = self.root / ".codex-work"
        alt_codex.mkdir(parents=True, exist_ok=True)
        monitor_cfg = self.root / "monitor-auto-pin.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "codex-default", "provider": "codex"},
                        {
                            "id": "codex-work",
                            "provider": "codex",
                            "tags": ["work"],
                            "codexHome": str(alt_codex),
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["tag:work"]}), encoding="utf-8")
        host_env = self.environment(
            HOME=str(self.root),
            MONITOR_CONFIG=str(monitor_cfg),
            ORCHESTRATE_AUTO_ACCOUNT="1",
            CODEX_THREAD_ID="codex-host-1",
            CODEX_HOME=str(alt_codex),
        )
        try:
            with mock.patch.dict(os.environ, host_env, clear=True):
                code_native, res_native, _ = self.consult(
                    "--read",
                    str(self.repository),
                    "--question",
                    "Why?",
                    "--model",
                    "gpt:luna",
                    "--transport",
                    "native",
                    env=host_env,
                )
            self.assertEqual(code_native, 4)
            self.assertIn("--transport executor", res_native["error"])

            seen_envs: list[dict[str, str]] = []
            orig_consult_env = CONSULT.consult_environment

            def spy_consult_env(*args, **kwargs):
                env_out = orig_consult_env(*args, **kwargs)
                seen_envs.append(
                    {"pinned": str(kwargs.get("pinned_account")), "codex_home": env_out.get("CODEX_HOME", "")}
                )
                return env_out

            with (
                mock.patch.dict(os.environ, host_env, clear=True),
                mock.patch.object(CONSULT, "consult_environment", side_effect=spy_consult_env),
            ):
                code_auto, res_auto, _ = self.consult(
                    "--read",
                    str(self.repository),
                    "--question",
                    "Why?",
                    "--model",
                    "gpt:luna",
                    env=host_env,
                )
            self.assertEqual(code_auto, 0, res_auto)
            self.assertEqual(res_auto["transport"], "executor")
            self.assertTrue(res_auto["explicit_account"])
            self.assertEqual(res_auto["account_id"], "codex-default")
            self.assertEqual(seen_envs, [{"pinned": "True", "codex_home": ""}])

            # Detached launch propagates ORKEST_PINNED_CODEX_ACCOUNT=1 and strips stale ORKEST_CODEX_ACCOUNT_HOME.
            captured_popen_env: dict[str, str] = {}

            class _FakeProc:
                pid = 43434

                @staticmethod
                def wait() -> int:
                    return 0

            real_popen = subprocess.Popen

            def fake_popen(cmd, *popen_args, **kwargs):
                if isinstance(cmd, (list, tuple)) and any("run_agent.py" in str(part) for part in cmd):
                    captured_popen_env.update(kwargs.get("env") or {})
                    return _FakeProc()
                return real_popen(cmd, *popen_args, **kwargs)

            detach_env = {**host_env, "ORKEST_CODEX_ACCOUNT_HOME": str(alt_codex)}
            with (
                mock.patch.dict(os.environ, detach_env, clear=True),
                mock.patch.object(CONSULT.subprocess, "Popen", side_effect=fake_popen),
                mock.patch.object(
                    sys,
                    "argv",
                    [
                        str(SCRIPT),
                        "consult",
                        "--read",
                        str(self.repository),
                        "--question",
                        "Why?",
                        "--account",
                        "codex-default",
                        "--model",
                        "gpt:luna",
                        "--detach",
                        "--notify",
                        "none",
                    ],
                ),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(RUNNER.main(), 0)
            self.assertEqual(captured_popen_env.get("ORKEST_PINNED_CODEX_ACCOUNT"), "1")
            self.assertNotIn("ORKEST_CODEX_ACCOUNT_HOME", captured_popen_env)
        finally:
            shutil.rmtree(policy_dir, ignore_errors=True)

    def test_native_agy_policy_prefers_app_data_dir_and_auto_fallback_clears_stale_homes(self) -> None:
        gemini_home = self.root / ".gemini"
        work_app = gemini_home / "antigravity-work"
        work_app.mkdir(parents=True, exist_ok=True)
        monitor_cfg = self.root / "monitor-agy-consult.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "agy-default", "provider": "antigravity"},
                        {
                            "id": "agy-work",
                            "provider": "antigravity",
                            "tags": ["work"],
                            "env": {
                                "GEMINI_CLI_HOME": str(gemini_home),
                                "ANTIGRAVITY_APP_DATA_DIR": str(work_app),
                            },
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["tag:work"]}), encoding="utf-8")
        agy_env = self.environment(
            HOME=str(self.root),
            MONITOR_CONFIG=str(monitor_cfg),
            ANTIGRAVITY_CONVERSATION_ID="agy-host-1",
            GEMINI_CLI_HOME=str(gemini_home),
            ANTIGRAVITY_APP_DATA_DIR=str(work_app),
        )
        try:
            with mock.patch.dict(os.environ, agy_env, clear=True):
                code_denied, res_denied, _ = self.consult(
                    "--read",
                    str(self.repository),
                    "--question",
                    "Why?",
                    "--model",
                    "gemini-3.8-flash-medium",
                    env=agy_env,
                )
            self.assertEqual(code_denied, 2)
            self.assertIn("work", res_denied["error"])

            auto_env = {**agy_env, "ORCHESTRATE_AUTO_ACCOUNT": "1"}
            with mock.patch.dict(os.environ, auto_env, clear=True):
                code_auto, res_auto, _ = self.consult(
                    "--read",
                    str(self.repository),
                    "--question",
                    "Why?",
                    "--model",
                    "gemini-3.8-flash-medium",
                    env=auto_env,
                )
            self.assertEqual(code_auto, 0, res_auto)
            self.assertEqual(res_auto["transport"], "executor")
            self.assertTrue(res_auto["explicit_account"])
            self.assertEqual(res_auto["account_id"], "agy-default")
        finally:
            shutil.rmtree(policy_dir, ignore_errors=True)

    def test_child_agy_marker_forces_executor_and_native_policy_uses_host_app_data_dir(self) -> None:
        gemini_home = self.root / ".gemini"
        work_app = gemini_home / "antigravity-work"
        personal_app = gemini_home / "antigravity-personal"
        work_app.mkdir(parents=True, exist_ok=True)
        personal_app.mkdir(parents=True, exist_ok=True)
        monitor_cfg = self.root / "monitor-agy-child-marker.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "agy-work",
                            "provider": "antigravity",
                            "tags": ["work"],
                            "env": {"GEMINI_CLI_HOME": str(gemini_home), "ANTIGRAVITY_APP_DATA_DIR": str(work_app)},
                        },
                        {
                            "id": "agy-personal",
                            "provider": "antigravity",
                            "tags": ["personal"],
                            "env": {
                                "GEMINI_CLI_HOME": str(gemini_home),
                                "ANTIGRAVITY_APP_DATA_DIR": str(personal_app),
                            },
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["tag:work"]}), encoding="utf-8")
        env = self.environment(
            HOME=str(self.root),
            MONITOR_CONFIG=str(monitor_cfg),
            ANTIGRAVITY_CONVERSATION_ID="agy-host-1",
            GEMINI_CLI_HOME=str(gemini_home),
            ANTIGRAVITY_APP_DATA_DIR=str(work_app),
            ORKEST_AGY_ACCOUNT_HOME=str(personal_app),
        )
        try:
            with mock.patch.object(Path, "home", return_value=self.root):
                # 1. --transport native refuses switching away from host ANTIGRAVITY_APP_DATA_DIR.
                code_native, res_native, _ = self.consult(
                    "--read",
                    str(self.repository),
                    "--question",
                    "Why?",
                    "--model",
                    "gemini-3.8-flash-medium",
                    "--transport",
                    "native",
                    env=env,
                )
                self.assertEqual(code_native, 4)
                self.assertIn("--transport executor", res_native["error"])

                # 2. --transport auto switches to executor and applies ORKEST_AGY_ACCOUNT_HOME.
                code_auto, res_auto, _ = self.consult(
                    "--read",
                    str(self.repository),
                    "--question",
                    "Why?",
                    "--model",
                    "gemini-3.8-flash-medium",
                    env=env,
                )
                self.assertEqual(code_auto, 0, res_auto)
                self.assertEqual(res_auto["transport"], "executor")
                self.assertEqual(self.capture()["env"].get("ANTIGRAVITY_APP_DATA_DIR"), str(personal_app))

                # 3. Remaining native policy check evaluates host ANTIGRAVITY_APP_DATA_DIR, never ORKEST_AGY_ACCOUNT_HOME.
                with (
                    mock.patch.dict(os.environ, env, clear=True),
                    mock.patch.object(
                        RUNNER._MODEL_ROUTING_MOD, "_child_marker_switches_host_profile", return_value=False
                    ),
                    self.assertRaises(RUNNER.RunnerError) as raised,
                ):
                    CONSULT.enforce_policy(
                        {
                            "engine": "agy",
                            "model": "gemini-3.8-flash-medium",
                            "transport": "native",
                            "read": str(self.repository),
                        },
                        transport_mode="native",
                    )
                self.assertEqual(raised.exception.exit_code, 2)
                self.assertIn("work", str(raised.exception))
        finally:
            shutil.rmtree(policy_dir, ignore_errors=True)

    def test_implicit_antigravity_app_data_dir_survives_consult_env_and_allows_auto_account(self) -> None:
        gemini_home = self.root / ".gemini"
        work_app = gemini_home / "antigravity-work"
        personal_app = gemini_home / "antigravity-personal"
        work_app.mkdir(parents=True, exist_ok=True)
        personal_app.mkdir(parents=True, exist_ok=True)
        monitor_cfg = self.root / "monitor-agy-implicit-consult.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "agy-work",
                            "provider": "antigravity",
                            "tags": ["work"],
                            "env": {"GEMINI_CLI_HOME": str(gemini_home), "ANTIGRAVITY_APP_DATA_DIR": str(work_app)},
                        },
                        {
                            "id": "agy-personal",
                            "provider": "antigravity",
                            "tags": ["personal"],
                            "env": {
                                "GEMINI_CLI_HOME": str(gemini_home),
                                "ANTIGRAVITY_APP_DATA_DIR": str(personal_app),
                            },
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        fake_view = {
            "schema": "monitor.snapshot.v1",
            "accounts": [
                {"id": "agy-work", "provider": "antigravity"},
                {"id": "agy-personal", "provider": "antigravity"},
            ],
            "lanes": [
                {
                    "accountId": "agy-personal",
                    "poolId": "all",
                    "label": "Agy personal",
                    "status": "available",
                    "availableNowPct": 80,
                    "surplusPts": 25,
                    "stale": False,
                }
            ],
        }
        fake_monitor = self.root / "fake-monitor-agy-consult"
        fake_monitor.write_text(f"#!/bin/sh\ncat <<'EOF'\n{json.dumps(fake_view)}\nEOF\n", encoding="utf-8")
        fake_monitor.chmod(0o755)

        # 1. Without --account, ANTIGRAVITY_APP_DATA_DIR survives HOST_SESSION_ENV into consult_environment.
        ok_env = self.environment(
            HOME=str(self.root),
            MONITOR_CONFIG=str(monitor_cfg),
            GEMINI_CLI_HOME=str(gemini_home),
            ANTIGRAVITY_APP_DATA_DIR=str(personal_app),
        )
        with mock.patch.object(Path, "home", return_value=self.root):
            code, res, _ = self.consult(
                "--question",
                "Why?",
                "--model",
                "gemini-3.8-flash-medium",
                env=ok_env,
            )
            self.assertEqual(code, 0, res)
            self.assertFalse(res["explicit_account"])
            self.assertEqual(self.capture()["env"].get("ANTIGRAVITY_APP_DATA_DIR"), str(personal_app))

        # 2. When implicit ANTIGRAVITY_APP_DATA_DIR is denied, ORCHESTRATE_AUTO_ACCOUNT=1 still switches to agy-personal.
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["tag:work"]}), encoding="utf-8")
        auto_env = self.environment(
            HOME=str(self.root),
            MONITOR_CONFIG=str(monitor_cfg),
            MONITOR_BIN=str(fake_monitor),
            ORCHESTRATE_AUTO_ACCOUNT="1",
            GEMINI_CLI_HOME=str(gemini_home),
            ANTIGRAVITY_APP_DATA_DIR=str(work_app),
        )
        try:
            with mock.patch.object(Path, "home", return_value=self.root):
                code_auto, res_auto, _ = self.consult(
                    "--read",
                    str(self.repository),
                    "--question",
                    "Why?",
                    "--model",
                    "gemini-3.8-flash-medium",
                    env=auto_env,
                )
            self.assertEqual(code_auto, 0, res_auto)
            self.assertTrue(res_auto["explicit_account"])
            self.assertEqual(res_auto["account_id"], "agy-personal")
            self.assertEqual(self.capture()["env"].get("ANTIGRAVITY_APP_DATA_DIR"), str(personal_app))
        finally:
            shutil.rmtree(policy_dir, ignore_errors=True)

    def test_detached_claude_handoff_markers_enforce_successor_policy_over_stale_claude_config_dir(self) -> None:
        base_home = self.root / "claude-base"
        red_home = self.root / "claude-red"
        (base_home / ".claude").mkdir(parents=True, exist_ok=True)
        (red_home / ".claude").mkdir(parents=True, exist_ok=True)
        monitor_cfg = self.root / "monitor-claude-handoff-consult.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "claude-base", "provider": "claude", "tags": ["personal"]},
                        {
                            "id": "claude-red",
                            "provider": "claude",
                            "tags": ["work"],
                            "configDir": "~/.claude",
                            "env": {"HOME": str(red_home)},
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["tag:work"]}), encoding="utf-8")
        env = self.environment(
            HOME=str(base_home),
            MONITOR_CONFIG=str(monitor_cfg),
            CLAUDE_CONFIG_DIR=str(base_home / ".claude"),
            ORKEST_PINNED_CLAUDE_ACCOUNT="1",
            ORKEST_CLAUDE_ACCOUNT_HOME=str(red_home),
            ORCHESTRATE_AUTO_ACCOUNT="1",
        )
        try:
            with mock.patch.object(Path, "home", return_value=base_home):
                code, res, _ = self.consult(
                    "--read",
                    str(self.repository),
                    "--question",
                    "Why?",
                    "--model",
                    "opus",
                    env=env,
                )
            self.assertEqual(code, 2)
            self.assertIn("tag:work", res["error"])
            self.assertFalse(self.capture_path.exists())
        finally:
            shutil.rmtree(policy_dir, ignore_errors=True)

    def test_agy_shared_dir_marker_switches_and_unrelated_claude_marker_allows_codex_auto_account(self) -> None:
        host_dir = self.root / "host"
        shared_dir = self.root / "shared"
        team_gemini = self.root / "profiles" / "antigravity-team"
        green_app = self.root / "apps" / "green"
        work_codex = self.root / ".codex-work"
        personal_codex = self.root / ".codex-personal"
        for directory in (host_dir, shared_dir, team_gemini, green_app, work_codex, personal_codex):
            directory.mkdir(parents=True, exist_ok=True)

        # 1. Host ANTIGRAVITY_APP_DATA_DIR=/shared + GEMINI_CLI_HOME=/host vs ORKEST_AGY_ACCOUNT_HOME=/shared.
        shared_env = self.environment(
            HOME=str(self.root),
            ANTIGRAVITY_CONVERSATION_ID="agy-host-1",
            GEMINI_CLI_HOME=str(host_dir),
            ANTIGRAVITY_APP_DATA_DIR=str(shared_dir),
            ORKEST_AGY_ACCOUNT_HOME=str(shared_dir),
        )
        code_native, res_native, _ = self.consult(
            "--question",
            "Why?",
            "--model",
            "gemini-3.8-flash-medium",
            "--transport",
            "native",
            env=shared_env,
        )
        self.assertEqual(code_native, 4)
        self.assertIn("--transport executor", res_native["error"])

        code_auto, res_auto, _ = self.consult(
            "--question",
            "Why?",
            "--model",
            "gemini-3.8-flash-medium",
            env=shared_env,
        )
        self.assertEqual(code_auto, 0, res_auto)
        self.assertEqual(res_auto["transport"], "executor")
        self.assertEqual(self.capture()["env"].get("GEMINI_CLI_HOME"), str(shared_dir))
        self.assertEqual(self.capture()["env"].get("ANTIGRAVITY_APP_DATA_DIR"), str(shared_dir / "antigravity-cli"))

        # 2. Explicit account with GEMINI_CLI_HOME=/profiles/antigravity-team and ANTIGRAVITY_APP_DATA_DIR=/apps/green.
        monitor_cfg = self.root / "monitor-consult-followup4.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "agy-team",
                            "provider": "antigravity",
                            "env": {
                                "GEMINI_CLI_HOME": str(team_gemini),
                                "ANTIGRAVITY_APP_DATA_DIR": str(green_app),
                            },
                        },
                        {
                            "id": "codex-work",
                            "provider": "codex",
                            "tags": ["work"],
                            "codexHome": str(work_codex),
                        },
                        {
                            "id": "codex-personal",
                            "provider": "codex",
                            "tags": ["personal"],
                            "codexHome": str(personal_codex),
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        team_env = self.environment(HOME=str(self.root), MONITOR_CONFIG=str(monitor_cfg))
        code_team, res_team, _ = self.consult(
            "--question",
            "Why?",
            "--account",
            "agy-team",
            "--model",
            "gemini-3.8-flash-medium",
            env=team_env,
        )
        self.assertEqual(code_team, 0, res_team)
        self.assertEqual(self.capture()["env"].get("GEMINI_CLI_HOME"), str(team_gemini))
        self.assertEqual(self.capture()["env"].get("ANTIGRAVITY_APP_DATA_DIR"), str(green_app))

        # 3. Unrelated ORKEST_CLAUDE_ACCOUNT_HOME does not block codex ORCHESTRATE_AUTO_ACCOUNT=1 fallback.
        fake_view = {
            "schema": "monitor.snapshot.v1",
            "accounts": [
                {"id": "codex-work", "provider": "codex"},
                {"id": "codex-personal", "provider": "codex"},
            ],
            "lanes": [
                {
                    "accountId": "codex-personal",
                    "poolId": "all",
                    "label": "Codex personal",
                    "status": "available",
                    "availableNowPct": 90,
                    "surplusPts": 40,
                    "stale": False,
                }
            ],
        }
        fake_monitor = self.root / "fake-monitor-codex-pin-scope"
        fake_monitor.write_text(f"#!/bin/sh\ncat <<'EOF'\n{json.dumps(fake_view)}\nEOF\n", encoding="utf-8")
        fake_monitor.chmod(0o755)
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["tag:work"]}), encoding="utf-8")
        codex_env = self.environment(
            HOME=str(self.root),
            MONITOR_CONFIG=str(monitor_cfg),
            MONITOR_BIN=str(fake_monitor),
            ORCHESTRATE_AUTO_ACCOUNT="1",
            CODEX_HOME=str(work_codex),
            ORKEST_PINNED_CLAUDE_ACCOUNT="1",
            ORKEST_CLAUDE_ACCOUNT_HOME=str(self.root / "unrelated-claude"),
        )
        try:
            code_codex, res_codex, _ = self.consult(
                "--read",
                str(self.repository),
                "--question",
                "Why?",
                "--model",
                "gpt:luna",
                env=codex_env,
            )
            self.assertEqual(code_codex, 0, res_codex)
            self.assertEqual(res_codex["account_id"], "codex-personal")

            # 4. Passing --claude-config-dir /other on Codex still allows ORCHESTRATE_AUTO_ACCOUNT=1 fallback.
            codex_claude_flag_env = self.environment(
                HOME=str(self.root),
                MONITOR_CONFIG=str(monitor_cfg),
                MONITOR_BIN=str(fake_monitor),
                ORCHESTRATE_AUTO_ACCOUNT="1",
                CODEX_HOME=str(work_codex),
            )
            code_codex_flag, res_codex_flag, _ = self.consult(
                "--read",
                str(self.repository),
                "--question",
                "Why?",
                "--model",
                "gpt:luna",
                "--claude-config-dir",
                str(self.root / "other-claude"),
                env=codex_claude_flag_env,
            )
            self.assertEqual(code_codex_flag, 0, res_codex_flag)
            self.assertEqual(res_codex_flag["account_id"], "codex-personal")
        finally:
            shutil.rmtree(policy_dir, ignore_errors=True)

        # 5. Host GEMINI_CLI_HOME=/profiles/antigravity-team vs ORKEST_AGY_ACCOUNT_HOME=/profiles/antigravity-team.
        team_host_env = self.environment(
            HOME=str(self.root),
            ANTIGRAVITY_CONVERSATION_ID="agy-host-team",
            GEMINI_CLI_HOME=str(team_gemini),
            ANTIGRAVITY_APP_DATA_DIR="",
            ORKEST_AGY_ACCOUNT_HOME=str(team_gemini),
        )
        code_team_native, res_team_native, _ = self.consult(
            "--question",
            "Why?",
            "--model",
            "gemini-3.8-flash-medium",
            "--transport",
            "native",
            env=team_host_env,
        )
        self.assertEqual(code_team_native, 4)
        self.assertIn("--transport executor", res_team_native["error"])

        code_team_auto, res_team_auto, _ = self.consult(
            "--question",
            "Why?",
            "--model",
            "gemini-3.8-flash-medium",
            env=team_host_env,
        )
        self.assertEqual(code_team_auto, 0, res_team_auto)
        self.assertEqual(res_team_auto["transport"], "executor")
        self.assertEqual(self.capture()["env"].get("GEMINI_CLI_HOME"), str(team_gemini.parent))
        self.assertEqual(self.capture()["env"].get("ANTIGRAVITY_APP_DATA_DIR"), str(team_gemini))

        # 6. Shared GEMINI_CLI_HOME [green(work), default(personal)] allows native default;
        #    [parent(personal), team(work, /profiles/antigravity-team)] denies native on team.
        caller_home = self.root / "caller-home-consult"
        default_gemini = caller_home / ".gemini"
        green_app2 = default_gemini / "antigravity-green"
        default_gemini.mkdir(parents=True, exist_ok=True)
        green_app2.mkdir(parents=True, exist_ok=True)
        cfg_shared_consult = self.root / "monitor-consult-shared-green-default.json"
        cfg_shared_consult.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "agy-green",
                            "provider": "antigravity",
                            "tags": ["work"],
                            "env": {
                                "GEMINI_CLI_HOME": str(default_gemini),
                                "ANTIGRAVITY_APP_DATA_DIR": str(green_app2),
                            },
                        },
                        {"id": "agy-default", "provider": "antigravity", "tags": ["personal"]},
                    ]
                }
            ),
            encoding="utf-8",
        )
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["tag:work"]}), encoding="utf-8")
        try:
            with mock.patch.object(Path, "home", return_value=caller_home):
                env_def = self.environment(
                    HOME=str(caller_home),
                    MONITOR_CONFIG=str(cfg_shared_consult),
                    ANTIGRAVITY_CONVERSATION_ID="agy-host-def",
                )
                code_def, res_def, _ = self.consult(
                    "--read",
                    str(self.repository),
                    "--question",
                    "Why?",
                    "--model",
                    "gemini-3.8-flash-medium",
                    "--transport",
                    "native",
                    env=env_def,
                )
                self.assertEqual(code_def, 0, res_def)
                self.assertEqual(res_def["status"], "native_handoff")

            cfg_team_consult = self.root / "monitor-consult-team-parent.json"
            cfg_team_consult.write_text(
                json.dumps(
                    {
                        "accounts": [
                            {
                                "id": "agy-parent",
                                "provider": "antigravity",
                                "tags": ["personal"],
                                "env": {"GEMINI_CLI_HOME": str(team_gemini.parent)},
                            },
                            {
                                "id": "agy-team",
                                "provider": "antigravity",
                                "tags": ["work"],
                                "env": {"GEMINI_CLI_HOME": str(team_gemini)},
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )
            env_team_denied = self.environment(
                HOME=str(caller_home),
                MONITOR_CONFIG=str(cfg_team_consult),
                ANTIGRAVITY_CONVERSATION_ID="agy-host-team",
                GEMINI_CLI_HOME=str(team_gemini),
                ANTIGRAVITY_APP_DATA_DIR="",
                ORKEST_AGY_ACCOUNT_HOME="",
            )
            code_denied, res_denied, _ = self.consult(
                "--read",
                str(self.repository),
                "--question",
                "Why?",
                "--model",
                "gemini-3.8-flash-medium",
                "--transport",
                "native",
                env=env_team_denied,
            )
            self.assertEqual(code_denied, 2)
            self.assertIn("tag:work", res_denied["error"])
        finally:
            shutil.rmtree(policy_dir, ignore_errors=True)

        # 7. Single typed GEMINI_CLI_HOME=/profiles/antigravity-team preserves verbatim GEMINI_CLI_HOME in executor.
        cfg_single_team = self.root / "monitor-consult-single-team.json"
        cfg_single_team.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "agy-team-single",
                            "provider": "antigravity",
                            "env": {"GEMINI_CLI_HOME": str(team_gemini)},
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        env_single_team = self.environment(
            HOME=str(caller_home),
            MONITOR_CONFIG=str(cfg_single_team),
            GEMINI_CLI_HOME=str(team_gemini),
            ANTIGRAVITY_APP_DATA_DIR="",
            ORKEST_AGY_ACCOUNT_HOME="",
        )
        code_single, res_single, _ = self.consult(
            "--question",
            "Why?",
            "--model",
            "gemini-3.8-flash-medium",
            env=env_single_team,
        )
        self.assertEqual(code_single, 0, res_single)
        self.assertEqual(res_single["account_id"], "agy-team-single")
        self.assertEqual(self.capture()["env"].get("GEMINI_CLI_HOME"), str(team_gemini))
        self.assertEqual(self.capture()["env"].get("ANTIGRAVITY_APP_DATA_DIR"), str(team_gemini / "antigravity-cli"))

        # 8. Single team account + live GEMINI_CLI_HOME + ANTIGRAVITY_APP_DATA_DIR=/alternate/live preserves live pair.
        alt_live_app = self.root / "alternate" / "live"
        alt_live_app.mkdir(parents=True, exist_ok=True)
        env_alt_live = self.environment(
            HOME=str(caller_home),
            MONITOR_CONFIG=str(cfg_single_team),
            GEMINI_CLI_HOME=str(team_gemini),
            ANTIGRAVITY_APP_DATA_DIR=str(alt_live_app),
        )
        code_alt_live, res_alt_live, _ = self.consult(
            "--question",
            "Why?",
            "--model",
            "gemini-3.8-flash-medium",
            env=env_alt_live,
        )
        self.assertEqual(code_alt_live, 0, res_alt_live)
        self.assertIsNone(res_alt_live["account_id"])
        self.assertEqual(self.capture()["env"].get("GEMINI_CLI_HOME"), str(team_gemini))
        self.assertEqual(self.capture()["env"].get("ANTIGRAVITY_APP_DATA_DIR"), str(alt_live_app))

    def test_claude_config_dir_precedence_over_env_claude_config_dir_in_policy_and_consult(self) -> None:
        caller_home = self.root / "claude-precedence-home"
        default_claude = caller_home / ".claude"
        denied_dir = caller_home / ".claude-denied"
        default_claude.mkdir(parents=True, exist_ok=True)
        denied_dir.mkdir(parents=True, exist_ok=True)
        monitor_cfg = self.root / "monitor-consult-claude-precedence.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "team",
                            "provider": "claude",
                            "claude_config_dir": str(default_claude),
                            "env": {"CLAUDE_CONFIG_DIR": str(denied_dir)},
                        },
                        {
                            "id": "blocked",
                            "provider": "claude",
                            "claudeConfigDir": str(denied_dir),
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        policy_dir = self.repository / ".orkest"
        policy_dir.mkdir(exist_ok=True)
        (policy_dir / "policy.json").write_text(json.dumps({"deny": ["account:blocked"]}), encoding="utf-8")
        try:
            env = self.environment(HOME=str(caller_home), MONITOR_CONFIG=str(monitor_cfg))
            env.pop("CLAUDE_CONFIG_DIR", None)
            code, res, _ = self.consult(
                "--read",
                str(self.repository),
                "--question",
                "Why?",
                "--model",
                "opus",
                env=env,
            )
            self.assertEqual(code, 0, res)
            self.assertEqual(res["status"], "answered")
            self.assertIn(res["claude_config_dir"], (None, str(default_claude)))
            self.assertNotEqual(res["claude_config_dir"], str(denied_dir))
            captured_env = self.capture()["env"]
            self.assertIn(captured_env.get("CLAUDE_CONFIG_DIR"), (None, str(default_claude)))
            self.assertNotEqual(captured_env.get("CLAUDE_CONFIG_DIR"), str(denied_dir))
        finally:
            shutil.rmtree(policy_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
