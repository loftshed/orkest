from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

# Tests mirror the repository layout under tests/, so the skill under test sits at the same
# relative path below plugins/.
SKILL_DIR = Path(__file__).resolve().parents[5] / "plugins" / "orchestrate" / "skills" / "orchestrate"
SCRIPT = SKILL_DIR / "scripts" / "render_brief.py"
SPEC = importlib.util.spec_from_file_location("agent_executor_brief_renderer", SCRIPT)
assert SPEC and SPEC.loader
RENDERER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RENDERER)

RUNNER_SCRIPT = SKILL_DIR / "scripts" / "run_agent.py"
RUNNER_SPEC = importlib.util.spec_from_file_location("agent_executor_runner_for_brief_renderer", RUNNER_SCRIPT)
assert RUNNER_SPEC and RUNNER_SPEC.loader
RUNNER = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(RUNNER)


def brief_spec() -> dict[str, object]:
    return {
        "objective": "Add the bounded implementation.",
        "repository_root": "/tmp/example-repository",
        "current_state": "The focused test exposes the missing behavior.",
        "pre_existing_changes": ["src/unrelated.py"],
        "plan": ["Implement the focused change.", "Add a regression test."],
        "allow_paths": ["src/jobs", "tests/jobs"],
        "track_paths": ["plans/generated-handoff.md"],
        "development_checks": ["python3 -m unittest tests.test_jobs"],
        "acceptance_criteria": ["The regression test passes."],
    }


class BriefRendererTests(unittest.TestCase):
    def test_context_packet_preserves_failed_attempts_and_versioned_evidence(self) -> None:
        spec = brief_spec()
        spec["context_packet"] = {
            "decisions": ["Keep the existing public API."],
            "failed_attempts": ["Cancellation alone did not stop the callback."],
            "versions": ["client 2.4.1"],
            "evidence": ["tests/race.py: observed callback after cancellation"],
        }
        rendered = RENDERER.render_brief(spec)
        self.assertIn("Failed attempts:\n- Cancellation alone did not stop the callback.", rendered)
        self.assertIn("Versions:\n- client 2.4.1", rendered)
        self.assertEqual(RUNNER.brief_report_contract_violations(rendered), [])

    def test_renders_complete_runner_compliant_brief(self) -> None:
        rendered = RENDERER.render_brief(brief_spec())
        self.assertIn("# Objective\n\nAdd the bounded implementation.", rendered)
        self.assertNotIn("senior-specialist", rendered)
        self.assertIn("Use independent judgment within the approved scope", rendered)
        self.assertIn("relaxed, friendly, and natural", rendered)
        self.assertIn("do not run full test or visual suites between every individual move", rendered)
        self.assertNotIn("trusted senior specialist", RUNNER.REPORT_CONTRACT)
        self.assertIn("evidence-backed BLOCKED status", RUNNER.REPORT_CONTRACT)
        self.assertEqual(
            RENDERER.REPORT_HEADINGS, ("STATUS", "FILES CHANGED", "COMMANDS RUN", "VERIFICATION", "RISKS OR BLOCKERS")
        )
        positions = [rendered.index(f"### {heading}") for heading in RENDERER.REPORT_HEADINGS]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(sum(rendered.count(f"### {heading}") for heading in RENDERER.REPORT_HEADINGS), 5)

    def test_brief_carries_command_boundary_guidance(self) -> None:
        brief = RENDERER.render_brief(brief_spec())
        self.assertIn("Command boundaries:", brief)
        self.assertIn("its own standalone command", brief)
        self.assertIn("instead of head/tail pipes", brief)
        self.assertIn("coordinator.py capture, verify-evidence, review", brief)
        self.assertIn("exact absolute path of the installed orchestrate skill", brief)
        self.assertIn("do not ask for broader trust", brief)
        self.assertIn("pass this rule on", brief)

    def test_auto_correct_rounds_are_validated_and_leave_the_brief_unchanged(self) -> None:
        self.assertNotIn("auto_correct", RENDERER.validate_spec(brief_spec()))
        spec = {**brief_spec(), "auto_correct": 2}
        self.assertEqual(RENDERER.validate_spec(spec)["auto_correct"], 2)
        self.assertEqual(RENDERER.render_brief(spec), RENDERER.render_brief(brief_spec()))
        for value in (3, -1, "1", True):
            with self.subTest(value=value), self.assertRaisesRegex(RENDERER.BriefSpecError, "auto_correct must be"):
                RENDERER.validate_spec({**brief_spec(), "auto_correct": value})

    def test_protect_paths_are_normalized_and_leave_the_brief_unchanged(self) -> None:
        self.assertNotIn("protect_paths", RENDERER.validate_spec(brief_spec()))
        spec = {**brief_spec(), "protect_paths": ["tests/test_x.py", "tests/fixtures/"]}
        self.assertEqual(RENDERER.validate_spec(spec)["protect_paths"], ["tests/test_x.py", "tests/fixtures"])
        self.assertEqual(RENDERER.render_brief(spec), RENDERER.render_brief(brief_spec()))
        for value in (["../outside"], ["/absolute"], ["."], "tests"):
            with self.subTest(value=value), self.assertRaises(RENDERER.BriefSpecError):
                RENDERER.validate_spec({**brief_spec(), "protect_paths": value})

    def test_rendered_brief_passes_the_runner_preflight_parser(self) -> None:
        self.assertEqual(
            RUNNER.brief_report_contract_violations(RENDERER.render_brief(brief_spec())),
            [],
        )

    def test_rejects_missing_required_fields(self) -> None:
        spec = brief_spec()
        del spec["objective"]
        with self.assertRaisesRegex(RENDERER.BriefSpecError, "missing required fields: objective"):
            RENDERER.render_brief(spec)

    def test_effective_scope_matches_normalized_runner_path_inputs(self) -> None:
        spec = brief_spec()
        spec["allow_paths"] = ["src/jobs/", "src/jobs", "tests/jobs"]
        spec["track_paths"] = ["plans/generated-handoff.md", "src/jobs/output.json"]
        rendered = RENDERER.render_brief(spec)
        self.assertIn("- src/jobs\n- tests/jobs\n- plans/generated-handoff.md\n- src/jobs/output.json", rendered)
        self.assertIn("Runner `--allow-path` prefixes:\n- src/jobs\n- tests/jobs", rendered)
        self.assertIn(
            "Runner `--track-path` deliverables:\n- plans/generated-handoff.md\n- src/jobs/output.json", rendered
        )

    def test_rejects_invalid_scope_path(self) -> None:
        spec = brief_spec()
        spec["allow_paths"] = ["../outside"]
        with self.assertRaisesRegex(RENDERER.BriefSpecError, "repository-relative"):
            RENDERER.render_brief(spec)

    def test_worker_owned_scope_allows_repo_root_and_optional_plan(self) -> None:
        spec = brief_spec()
        spec["allow_paths"] = ["."]
        del spec["plan"]
        spec["scope_hints"] = ["src/jobs", "tests/jobs"]
        validated = RENDERER.validate_spec(spec)
        self.assertEqual(validated["scope_owner"], "worker")
        self.assertEqual(validated["allow_paths"], ["."])
        self.assertEqual(validated["plan"], [])
        self.assertEqual(validated["scope_hints"], ["src/jobs", "tests/jobs"])
        rendered = RENDERER.render_brief(spec)
        self.assertIn("You own the implementation plan, architectural decisions, and file scope", rendered)
        self.assertIn("Scope owner: worker (full repository write scope `.`", rendered)
        self.assertIn("Conductor starting-path hints (non-binding):\n- src/jobs\n- tests/jobs", rendered)
        self.assertEqual(RUNNER.brief_report_contract_violations(rendered), [])

    def test_upward_delegation_automatically_widens_narrow_scope_and_preserves_hints(self) -> None:
        spec = brief_spec()
        spec["conductor_model"] = "claude-sonnet-4-6"
        spec["worker_model"] = "gpt-6-astra"
        validated = RENDERER.validate_spec(spec)
        self.assertEqual(validated["scope_owner"], "worker")
        self.assertEqual(validated["allow_paths"], ["."])
        self.assertEqual(validated["scope_hints"], ["src/jobs", "tests/jobs"])
        rendered = RENDERER.render_brief(spec)
        self.assertIn("Treat the steps below from the dispatching conductor as starting guidance", rendered)
        self.assertIn("Conductor starting-path hints (non-binding):\n- src/jobs\n- tests/jobs", rendered)
        self.assertEqual(RUNNER.brief_report_contract_violations(rendered), [])

        # Read-only specs stay read-only even when conductor_model < worker_model:
        read_only = brief_spec()
        read_only["allow_paths"] = []
        read_only["track_paths"] = []
        read_only["conductor_model"] = "haiku"
        read_only["worker_model"] = "gpt-6-astra"
        validated_ro = RENDERER.validate_spec(read_only)
        self.assertEqual(validated_ro["scope_owner"], "conductor")
        self.assertEqual(validated_ro["allow_paths"], [])


class RepositoryPathTests(unittest.TestCase):
    def test_root_spellings_and_blanks_are_refused_unless_the_root_is_allowed(self):
        for value in (".", "./", ".//", " ./ ", "", "   "):
            with self.subTest(value=value), self.assertRaises(RENDERER.BriefSpecError):
                RENDERER.normalize_repo_paths([value], "protect_paths")
        for value in (".", "./", ".//", " ./ "):
            with self.subTest(root=value):
                self.assertEqual(RENDERER.normalize_repo_paths([value], "allow_paths", allow_root=True), ["."])
        for value in ("", "   "):
            with self.subTest(blank=value), self.assertRaises(RENDERER.BriefSpecError):
                RENDERER.normalize_repo_paths([value], "allow_paths", allow_root=True)


class MinimumHandoffTests(unittest.TestCase):
    def test_optional_handoff_fields_leave_existing_briefs_unchanged(self) -> None:
        plain = RENDERER.render_brief(brief_spec())
        self.assertNotIn("Source revision", plain)
        self.assertNotIn("# Evidence references", plain)
        self.assertNotIn("# Context mode", plain)
        fresh = RENDERER.render_brief({**brief_spec(), "context_mode": "fresh"})
        self.assertEqual(fresh, plain)

    def test_brief_carries_source_revision_and_retrievable_evidence(self) -> None:
        spec = {**brief_spec(), "source_revision": "19ec6f7", "evidence_refs": ["/tmp/artifacts/ci.log"]}
        brief = RENDERER.render_brief(spec)
        self.assertIn("- Source revision: 19ec6f7", brief)
        self.assertIn("# Evidence references", brief)
        self.assertIn("- /tmp/artifacts/ci.log", brief)
        self.assertEqual(RENDERER.validate_spec(spec)["source_revision"], "19ec6f7")

    def test_full_history_fork_records_its_reason(self) -> None:
        with self.assertRaisesRegex(RENDERER.BriefSpecError, "context_reason"):
            RENDERER.validate_spec({**brief_spec(), "context_mode": "fork"})
        with self.assertRaisesRegex(RENDERER.BriefSpecError, "context_mode"):
            RENDERER.validate_spec({**brief_spec(), "context_mode": "partial"})
        brief = RENDERER.render_brief(
            {**brief_spec(), "context_mode": "fork", "context_reason": "It must reuse the agreed API decisions."}
        )
        self.assertIn("Full-history fork: It must reuse the agreed API decisions.", brief)


if __name__ == "__main__":
    unittest.main()
