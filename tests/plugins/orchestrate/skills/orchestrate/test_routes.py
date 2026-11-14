from __future__ import annotations

import argparse
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
FAMILIES = load("families")
RUNNER = load("run_agent")


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


class ModelRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(
            os.environ,
            {
                "AGENT_EXECUTOR_CONFIG": str(self.root / "absent-config.json"),
                "ORCHESTRATE_CONFIG": "",
                "AGENT_EXECUTOR_HOME": str(self.root / "cache"),
                "XDG_CACHE_HOME": str(self.root / "xdg-cache"),
            },
        )
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.temp.cleanup()

    def test_agy_bare_tier_aliases_resolve_carbon_hydrogen_and_orchestrator(self) -> None:
        rules = FAMILIES.load_families()
        bare_cases = {
            "carbon": ("gemini", "carbon"),
            "carbon-medium": ("gemini", "carbon"),
            "carbon-low": ("gemini", "carbon-low"),
            "carbon-high": ("gemini", "carbon-high"),
            "hydrogen": ("gemini", "hydrogen"),
            "hydrogen-medium": ("gemini", "hydrogen"),
            "hydrogen-low": ("gemini", "hydrogen-low"),
            "hydrogen-high": ("gemini", "hydrogen-high"),
            "hydrogen-xhigh": ("gemini", "hydrogen-xhigh"),
            "orchestrator": ("gemini", "orchestrator"),
            "orchestrator-carbon": ("gemini", "orchestrator"),
            "orchestrator-argon": ("gemini", "orchestrator-argon"),
        }
        for alias, expected in bare_cases.items():
            with self.subTest(alias=alias):
                self.assertEqual(RUNNER.parse_bare_tier_selector("agy", alias, rules), expected)

        catalog = {
            "status": "live",
            "models": [
                {"id": model_id}
                for model_id in (
                    "gemini-4-carbon-low",
                    "gemini-4-carbon-medium",
                    "gemini-4-carbon-high",
                    "gemini-4-hydrogen-low",
                    "gemini-4-hydrogen-medium",
                    "gemini-4-hydrogen-high",
                    "gemini-4-hydrogen-xhigh",
                    "gemini-pro-orchestrator",
                    "gemini-pro-orchestrator-argon",
                )
            ],
        }
        resolved_cases = {
            "carbon": "gemini-4-carbon-medium",
            "carbon-medium": "gemini-4-carbon-medium",
            "carbon-high": "gemini-4-carbon-high",
            "hydrogen": "gemini-4-hydrogen-medium",
            "hydrogen-medium": "gemini-4-hydrogen-medium",
            "hydrogen-xhigh": "gemini-4-hydrogen-xhigh",
            "orchestrator": "gemini-pro-orchestrator",
            "orchestrator-carbon": "gemini-pro-orchestrator",
            "orchestrator-argon": "gemini-pro-orchestrator-argon",
        }
        with mock.patch.object(RUNNER, "note_selector_advance"):
            for alias, expected_model in resolved_cases.items():
                with self.subTest(alias=alias):
                    self.assertEqual(
                        RUNNER.select_live_model("agy", alias, catalog),
                        (expected_model, "family_latest"),
                    )

        for alias in ("carbon", "carbon-medium", "hydrogen", "hydrogen-medium", "orchestrator", "orchestrator-carbon"):
            args = argparse.Namespace(route=None, engine=None, model=alias, effort=None, variant=None)
            resolved = RUNNER._MODEL_ROUTING_MOD.resolve_route(args)
            self.assertEqual(resolved.engine, "agy")

    def test_opencode_refuses_carbon_hydrogen_and_orchestrator_models_with_exit_17(self) -> None:
        native_models = (
            "carbon",
            "carbon-medium",
            "gemini-4-carbon-high",
            "openrouter/google/gemini-4-carbon-high",
            "hydrogen",
            "hydrogen-medium",
            "gemini-4-hydrogen-xhigh",
            "openrouter/google/gemini-4-hydrogen-xhigh",
            "orchestrator",
            "orchestrator-carbon",
            "gemini-pro-orchestrator",
            "gemini-pro-orchestrator-argon",
            "openrouter/google/gemini-pro-orchestrator",
        )
        for model in native_models:
            with self.subTest(model=model):
                self.assertEqual(RUNNER.native_engine_for(model), "agy")
                with self.assertRaises(RUNNER.RunnerError) as enforce_exc:
                    RUNNER.enforce_native_route("opencode", model)
                self.assertEqual(enforce_exc.exception.exit_code, 17)
                with self.assertRaises(RUNNER.RunnerError) as preflight_exc:
                    RUNNER.executor_preflight("opencode", model)
                self.assertEqual(preflight_exc.exception.exit_code, 17)

    def test_bind_effort_uses_normalized_catalog_and_composite_metadata_across_engines(self) -> None:
        support = load("execution_support")
        codex_cat = {
            "models": [{"id": "gpt-6.1-sol", "supported_efforts": ["low", "high"]}],
        }
        self.assertEqual(
            support.bind_effort("codex", "gpt-6.1-sol", "high", codex_cat),
            {"requested": "high", "bound": "high", "binding": "model_reasoning_effort", "observed": None},
        )
        with self.assertRaises(support.ContractError):
            support.bind_effort("codex", "gpt-6.1-sol", "xhigh", codex_cat)

        agy_cat = {
            "models": [
                {
                    "id": "gemini-4-carbon-high",
                    "effort_slug": "high",
                    "supported_efforts": ["low", "high"],
                    "composite": False,
                },
                {
                    "id": "gemini-pro-orchestrator",
                    "effort_slug": None,
                    "supported_efforts": [],
                    "composite": True,
                },
            ]
        }
        self.assertEqual(
            support.bind_effort("agy", "gemini-4-carbon-high", "high", agy_cat),
            {"requested": "high", "bound": "high", "binding": "catalog_model_slug", "observed": None},
        )
        with self.assertRaises(support.ContractError):
            support.bind_effort("agy", "gemini-4-carbon-high", "low", agy_cat)
        self.assertEqual(
            support.bind_effort("agy", "gemini-pro-orchestrator", None, agy_cat),
            {"requested": None, "bound": None, "binding": "cli_default_or_config", "observed": None},
        )
        with self.assertRaises(support.ContractError):
            support.bind_effort("agy", "gemini-pro-orchestrator", "high", agy_cat)

        claude_cat = {"models": [{"id": "opus", "supported_efforts": ["low", "medium", "high", "max"]}]}
        self.assertEqual(
            support.bind_effort("claude", "opus", "max", claude_cat),
            {"requested": "max", "bound": "max", "binding": "claude --effort", "observed": None},
        )
        with self.assertRaises(support.ContractError):
            support.bind_effort("claude", "opus", "xhigh", claude_cat)

        opencode_cat = {
            "models": [
                {
                    "id": "openrouter/deepseek/deepseek-v4-flash",
                    "supported_efforts": ["low", "high"],
                    "variants": ["turbo"],
                }
            ]
        }
        self.assertEqual(
            support.bind_effort("opencode", "openrouter/deepseek/deepseek-v4-flash", "turbo", opencode_cat),
            {"requested": "turbo", "bound": "turbo", "binding": "opencode_variant", "observed": None},
        )
        with self.assertRaises(support.ContractError):
            support.bind_effort("opencode", "openrouter/deepseek/deepseek-v4-flash", "extreme", opencode_cat)


if __name__ == "__main__":
    unittest.main()
