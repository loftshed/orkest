from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[5] / "plugins" / "orchestrate" / "skills" / "orchestrate"
SCRIPTS_DIR = SKILL_DIR / "scripts"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REPO_PATHS = load_module("repo_paths_for_test", SCRIPTS_DIR / "repo_paths.py")
RENDERER = load_module("renderer_for_repo_paths_test", SCRIPTS_DIR / "render_brief.py")
RUNNER = load_module("runner_for_repo_paths_test", SCRIPTS_DIR / "run_agent.py")
AUDIT = RUNNER.bundled_module("workspace_audit")
SUPPORT = RUNNER.bundled_module("execution_support")
AUTO_CORRECT = RUNNER.bundled_module("auto_correct")


class RepoPathNormalizationTests(unittest.TestCase):
    def test_normalize_repo_paths_table(self) -> None:
        cases = (
            ([], False, []),
            (["src"], False, ["src"]),
            ([" src/jobs/ ", "src/jobs"], False, ["src/jobs"]),
            (["src/", "src//"], False, ["src"]),
            (["."], True, ["."]),
            ([".", "./", ".//", " ./ "], True, ["."]),
            ([""], False, None),
            (["  "], False, None),
            (["."], False, None),
            (["./"], False, None),
            ([".//"], False, None),
            (["/absolute/path"], False, None),
            ([".."], False, None),
            (["../outside"], False, None),
            (["src/../outside"], False, None),
            (["src/.."], False, None),
            ([".git"], False, None),
            ([".git/x"], False, None),
        )
        for values, allow_root, expected in cases:
            with self.subTest(values=values, allow_root=allow_root):
                if expected is None:
                    with self.assertRaises(ValueError) as raised:
                        REPO_PATHS.normalize_repo_paths(values, allow_root=allow_root)
                    self.assertIn(raised.exception.args[0], values)
                else:
                    self.assertEqual(
                        REPO_PATHS.normalize_repo_paths(values, allow_root=allow_root),
                        expected,
                    )

    def test_path_covered_by_prefixes_table(self) -> None:
        cases = (
            ("src/file.py", ["."], True, True),
            ("src", ["src"], True, True),
            ("src/file.py", ["src"], True, True),
            ("src2/file.py", ["src"], True, False),
            ("src", [], True, False),
            (".git", ["."], True, False),
            (".git/config", ["."], True, False),
            (".git/config", [".git"], True, False),
            (".git", ["."], False, True),
            (".git/config", [".git"], False, True),
        )
        for path, prefixes, exclude_git, expected in cases:
            with self.subTest(path=path, prefixes=prefixes, exclude_git=exclude_git):
                self.assertEqual(
                    REPO_PATHS.path_covered_by_prefixes(path, prefixes, exclude_git=exclude_git),
                    expected,
                )

    def test_existing_wrappers_preserve_parity_and_errors(self) -> None:
        cases = (
            (["src", "src/"], False, ["src"]),
            ([".", "./"], True, ["."]),
            ([""], True, None),
            (["./"], False, None),
            (["/absolute"], False, None),
            (["a/../b"], False, None),
            ([".git/x"], False, None),
        )
        for values, allow_root, expected in cases:
            with self.subTest(values=values, allow_root=allow_root):
                if expected is not None:
                    renderer_result = RENDERER.normalize_repo_paths(values, "paths", allow_root=allow_root)
                    audit_result = AUDIT.normalize_repo_paths(
                        values,
                        option="--allow-path",
                        allow_root=allow_root,
                    )
                    self.assertEqual(renderer_result, expected)
                    self.assertEqual(audit_result, expected)
                    continue

                with self.assertRaises(RENDERER.BriefSpecError) as renderer_error:
                    RENDERER.normalize_repo_paths(values, "paths", allow_root=allow_root)
                with self.assertRaises(RUNNER.RunnerError) as audit_error:
                    AUDIT.normalize_repo_paths(values, option="--allow-path", allow_root=allow_root)
                raw = values[0]
                self.assertEqual(
                    str(renderer_error.exception),
                    f"paths must contain non-root repository-relative paths: {raw!r}",
                )
                self.assertEqual(
                    str(audit_error.exception),
                    f"--allow-path must be a non-root repository-relative path: {raw!r}",
                )
                self.assertEqual(audit_error.exception.exit_code, 4)

    def test_existing_prefix_call_sites_keep_their_git_policy(self) -> None:
        self.assertFalse(AUDIT.path_is_allowed(".git/config", ["."]))
        self.assertFalse(SUPPORT._path_covered(".git/config", ["."]))
        self.assertTrue(AUTO_CORRECT.released(".git/config", ["."]))

    def test_each_caller_loads_by_file_without_the_scripts_directory_on_the_path(self) -> None:
        import subprocess
        import sys

        scripts = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
        program = (
            "import importlib.util, sys\n"
            "for name in sys.argv[2:]:\n"
            "    spec = importlib.util.spec_from_file_location('probe_' + name, sys.argv[1] + '/' + name + '.py')\n"
            "    module = importlib.util.module_from_spec(spec)\n"
            "    spec.loader.exec_module(module)\n"
        )
        callers = ["auto_correct", "execution_support", "workspace_audit", "render_brief"]
        result = subprocess.run(
            [sys.executable, "-I", "-c", program, str(scripts), *callers],
            cwd="/",
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
