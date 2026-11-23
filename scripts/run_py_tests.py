#!/usr/bin/env python3
"""Run orchestrate Python unittest modules in bounded parallel workers."""

from __future__ import annotations

import concurrent.futures
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TESTS_DIR = Path("tests/src/py")
AGENT_ENV = Path("tests/helpers/agent-env.txt")


def without_agent_session(env: dict[str, str]) -> dict[str, str]:
    """Drop the agent session this run may have been started from; see AGENT_ENV."""
    lines = (line.strip() for line in AGENT_ENV.read_text(encoding="utf-8").splitlines())
    patterns = [line for line in lines if line and not line.startswith("#")]
    kept = {line[1:] for line in patterns if line.startswith("!")}

    def matches(name: str, pattern: str) -> bool:
        return name.startswith(pattern[:-1]) if pattern.endswith("*") else name == pattern

    return {
        name: value
        for name, value in env.items()
        if name in kept or not any(matches(name, pattern) for pattern in patterns)
    }


def run_test_file(test_file: Path, env: dict[str, str]) -> tuple[Path, int, float, str, str]:
    print(f"[START] {test_file.name}", flush=True)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="ork-python-profile-") as home:
        # Each module exercises its own fallback paths, including through real child processes.
        profile = {
            **env,
            "HOME": home,
            "XDG_CONFIG_HOME": str(Path(home, ".config")),
            "XDG_CACHE_HOME": str(Path(home, ".cache")),
            "XDG_STATE_HOME": str(Path(home, ".local", "state")),
            "XDG_DATA_HOME": str(Path(home, ".local", "share")),
        }
        completed = subprocess.run(
            [sys.executable, "-B", "-m", "unittest", str(test_file)],
            capture_output=True,
            text=True,
            env=profile,
            check=False,
        )
    elapsed = time.monotonic() - started
    return test_file, completed.returncode, elapsed, completed.stdout, completed.stderr


def main() -> int:
    test_files = sorted(TESTS_DIR.glob("test_*.py"))
    if not test_files:
        print(f"No test files found under {TESTS_DIR}", file=sys.stderr)
        return 1

    tests_root = str(TESTS_DIR.resolve())
    existing_pythonpath = os.environ.get("PYTHONPATH", "")
    env = {
        **without_agent_session(dict(os.environ)),
        "PYTHONPATH": f"{tests_root}{os.pathsep}{existing_pythonpath}" if existing_pythonpath else tests_root,
    }
    workers = min(3 if sys.platform == "darwin" else 8, os.cpu_count() or 4)
    print(f"Running {len(test_files)} Python test files across {workers} workers...", flush=True)
    failures: list[tuple[Path, int, float, str, str]] = []
    started = time.monotonic()

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(run_test_file, path, env) for path in test_files]
        for future in concurrent.futures.as_completed(futures):
            test_file, returncode, elapsed, stdout, stderr = future.result()
            status = "PASS" if returncode == 0 else f"FAIL (exit {returncode})"
            print(f"[{status}] {test_file.name} ({elapsed:.1f}s)", flush=True)
            if returncode != 0:
                failures.append((test_file, returncode, elapsed, stdout, stderr))

    total_elapsed = time.monotonic() - started
    if failures:
        for test_file, returncode, _, stdout, stderr in sorted(failures, key=lambda item: item[0].name):
            print(f"\n=== {test_file} (exit {returncode}) ===", file=sys.stderr)
            if stdout:
                print(stdout, file=sys.stderr, end="" if stdout.endswith("\n") else "\n")
            if stderr:
                print(stderr, file=sys.stderr, end="" if stderr.endswith("\n") else "\n")
        print(f"\n{len(failures)}/{len(test_files)} Python test files failed in {total_elapsed:.1f}s.", file=sys.stderr)
        return 1

    print(f"All {len(test_files)} Python test files passed in {total_elapsed:.1f}s.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
