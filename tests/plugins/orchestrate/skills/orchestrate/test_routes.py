from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins" / "orchestrate" / "skills" / "orchestrate" / "scripts"


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"orchestrate_test_{name}", SCRIPTS / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RUNTIME_PATHS = load("runtime_paths")
ROUTES = load("routes")


class RoutesConfigPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_env_first_prefers_orchestrate_with_agent_executor_fallback(self) -> None:
        env = {"ORCHESTRATE_CONFIG": "/new/config.json", "AGENT_EXECUTOR_CONFIG": "/old/config.json"}
        self.assertEqual(
            RUNTIME_PATHS.env_first("ORCHESTRATE_CONFIG", "AGENT_EXECUTOR_CONFIG", env=env),
            "/new/config.json",
        )
        self.assertEqual(
            RUNTIME_PATHS.env_first(
                "ORCHESTRATE_CONFIG",
                "AGENT_EXECUTOR_CONFIG",
                env={"ORCHESTRATE_CONFIG": "", "AGENT_EXECUTOR_CONFIG": "/old/config.json"},
            ),
            "/old/config.json",
        )
        self.assertIsNone(RUNTIME_PATHS.env_first("ORCHESTRATE_CONFIG", "AGENT_EXECUTOR_CONFIG", env={}))

    def test_config_path_honors_orchestrate_config_over_agent_executor_config(self) -> None:
        new_cfg = self.root / "orchestrate-custom.json"
        old_cfg = self.root / "legacy-custom.json"
        with mock.patch.dict(
            os.environ,
            {"ORCHESTRATE_CONFIG": str(new_cfg), "AGENT_EXECUTOR_CONFIG": str(old_cfg)},
            clear=True,
        ):
            self.assertEqual(ROUTES.config_path(), new_cfg)
        with mock.patch.dict(os.environ, {"AGENT_EXECUTOR_CONFIG": str(old_cfg)}, clear=True):
            self.assertEqual(ROUTES.config_path(), old_cfg)

    def test_config_path_falls_back_to_existing_legacy_file_and_defaults_to_orchestrate(self) -> None:
        xdg = self.root / "xdg-config"
        preferred = xdg / "orchestrate" / "config.json"
        legacy = xdg / "agent-executor" / "config.json"
        with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": str(xdg)}, clear=True):
            self.assertEqual(ROUTES.config_path(), preferred)
            legacy.parent.mkdir(parents=True, exist_ok=True)
            legacy.write_text(
                json.dumps({"routes": {"implementation": {"engine": "codex", "model": "gpt:luna"}}}),
                encoding="utf-8",
            )
            self.assertEqual(ROUTES.config_path(), legacy)
            self.assertEqual(ROUTES.load_routes()["implementation"]["model"], "gpt:luna")

            preferred.parent.mkdir(parents=True, exist_ok=True)
            preferred.write_text(
                json.dumps({"routes": {"implementation": {"engine": "codex", "model": "gpt:sol"}}}),
                encoding="utf-8",
            )
            self.assertEqual(ROUTES.config_path(), preferred)
            self.assertEqual(ROUTES.load_routes()["implementation"]["model"], "gpt:sol")


if __name__ == "__main__":
    unittest.main()
