from __future__ import annotations

import argparse
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[3] / "src/py"


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

    def test_resolve_route_supports_custom_aliases_account_fields_and_cli_account_across_providers(self) -> None:
        monitor_cfg = self.root / "monitor-config.json"
        claude_alt_dir = self.root / ".claude-alt"
        codex_alt_home = self.root / ".codex-alt"
        agy_alt_home = self.root / ".gemini-alt"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "claude-work",
                            "provider": "claude",
                            "alias": "claude-work",
                            "tags": ["work"],
                            "configDir": str(self.root / ".claude"),
                        },
                        {
                            "id": "claude-alt-id",
                            "provider": "claude",
                            "alias": "claude-alt",
                            "tags": ["personal", "client-acme"],
                            "configDir": str(claude_alt_dir),
                        },
                        {
                            "id": "codex-alt-id",
                            "provider": "codex",
                            "alias": "codex-alt",
                            "tags": ["work"],
                            "env": {"CODEX_HOME": str(codex_alt_home)},
                        },
                        {
                            "id": "agy-alt-id",
                            "provider": "antigravity",
                            "route": "agy-alt",
                            "tags": ["personal"],
                            "env": {"GEMINI_CLI_HOME": str(agy_alt_home)},
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        cfg_file = self.root / "routes-accounts.json"
        cfg_file.write_text(
            json.dumps(
                {
                    "routes": {
                        "alt-fast": {
                            "engine": "claude-alt",
                            "model": "claude:fast",
                            "effort": "low",
                        },
                        "work-balanced": {
                            "engine": "claude",
                            "account": "claude-work",
                            "model": "claude:balanced",
                            "effort": "medium",
                        },
                        "codex-team": {
                            "engine": "codex",
                            "alias": "codex-alt",
                            "model": "gpt:sol",
                        },
                        "agy-solo": {
                            "engine": "agy-alt",
                            "model": "gemini:fast",
                        },
                    }
                }
            ),
            encoding="utf-8",
        )
        with mock.patch.dict(
            os.environ,
            {"ORCHESTRATE_CONFIG": str(cfg_file), "MONITOR_CONFIG": str(monitor_cfg)},
        ):
            args_alt = argparse.Namespace(
                route="alt-fast",
                engine=None,
                model=None,
                effort=None,
                variant=None,
                claude_config_dir=None,
            )
            resolved_alt = RUNNER._MODEL_ROUTING_MOD.resolve_route(args_alt)
            self.assertEqual(resolved_alt.engine, "claude")
            self.assertEqual(resolved_alt.model, "claude:fast")
            self.assertEqual(resolved_alt.effort, "low")
            self.assertEqual(resolved_alt.claude_config_dir, claude_alt_dir.resolve())
            self.assertEqual(resolved_alt.account_id, "claude-alt-id")
            self.assertEqual(resolved_alt.account_alias, "claude-alt")
            self.assertEqual(resolved_alt.account_tags, ["personal", "client-acme"])

            args_work = argparse.Namespace(
                route="work-balanced",
                engine="claude",
                model=None,
                effort=None,
                variant=None,
                claude_config_dir=None,
            )
            resolved_work = RUNNER._MODEL_ROUTING_MOD.resolve_route(args_work)
            self.assertEqual(resolved_work.engine, "claude")
            self.assertEqual(resolved_work.model, "claude:balanced")
            self.assertEqual(resolved_work.account_id, "claude-work")
            self.assertEqual(resolved_work.claude_config_dir, (self.root / ".claude").resolve())

            args_codex = argparse.Namespace(
                route="codex-team",
                engine=None,
                model=None,
                effort=None,
                variant=None,
            )
            resolved_codex = RUNNER._MODEL_ROUTING_MOD.resolve_route(args_codex)
            self.assertEqual(resolved_codex.engine, "codex")
            self.assertEqual(resolved_codex.account_id, "codex-alt-id")
            self.assertEqual(resolved_codex.codex_home, codex_alt_home.resolve())

            args_agy = argparse.Namespace(
                route="agy-solo",
                engine=None,
                model=None,
                effort=None,
                variant=None,
            )
            resolved_agy = RUNNER._MODEL_ROUTING_MOD.resolve_route(args_agy)
            self.assertEqual(resolved_agy.engine, "agy")
            self.assertEqual(resolved_agy.account_id, "agy-alt-id")
            self.assertEqual(resolved_agy.agy_home, agy_alt_home.resolve())

            # CLI --account resolves engine, isolated home, id, and tags directly.
            args_cli = argparse.Namespace(
                route=None,
                engine=None,
                model="claude:balanced",
                effort=None,
                variant=None,
                account="claude-alt",
                claude_config_dir=None,
            )
            resolved_cli = RUNNER._MODEL_ROUTING_MOD.resolve_route(args_cli)
            self.assertEqual(resolved_cli.engine, "claude")
            self.assertEqual(resolved_cli.claude_config_dir, claude_alt_dir.resolve())
            self.assertEqual(resolved_cli.account_id, "claude-alt-id")

            # Contradictory --engine or unknown --account fails closed with exit code 4.
            with self.assertRaises(RUNNER.RunnerError) as bad_acct:
                RUNNER._MODEL_ROUTING_MOD.resolve_route(
                    argparse.Namespace(
                        route=None, engine=None, model=None, effort=None, variant=None, account="missing"
                    )
                )
            self.assertEqual(bad_acct.exception.exit_code, 4)

            with self.assertRaises(RUNNER.RunnerError) as bad_eng:
                RUNNER._MODEL_ROUTING_MOD.resolve_route(
                    argparse.Namespace(
                        route=None, engine="codex", model=None, effort=None, variant=None, account="claude-alt"
                    )
                )
            self.assertEqual(bad_eng.exception.exit_code, 4)

    def test_resolve_route_preserves_account_dir_on_model_override_while_respecting_explicit_dir(self) -> None:
        monitor_cfg = self.root / "monitor-config-override.json"
        alt_dir = self.root / ".claude-alt"
        default_dir = self.root / ".claude-default"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "claude-alt", "provider": "claude", "alias": "claude-alt", "configDir": str(alt_dir)},
                        {"id": "claude-main", "provider": "claude", "configDir": str(default_dir)},
                    ]
                }
            ),
            encoding="utf-8",
        )
        cfg_file = self.root / "routes-alt.json"
        cfg_file.write_text(
            json.dumps(
                {
                    "routes": {
                        "claude-alt": {
                            "engine": "claude-alt",
                            "model": "claude:fast",
                            "effort": "low",
                        },
                        "alt-or-main": {
                            "engine": "claude",
                            "account": "claude-alt",
                            "model": "claude:fast",
                            "effort": "low",
                            "alternates": [
                                {
                                    "engine": "claude",
                                    "model": "claude:balanced",
                                    "effort": "medium",
                                }
                            ],
                        },
                    }
                }
            ),
            encoding="utf-8",
        )
        with mock.patch.dict(
            os.environ,
            {"ORCHESTRATE_CONFIG": str(cfg_file), "MONITOR_CONFIG": str(monitor_cfg)},
        ):
            args_override = argparse.Namespace(
                route="alt-or-main",
                engine=None,
                model="claude:balanced",
                effort=None,
                variant=None,
                claude_config_dir=None,
            )
            resolved_override = RUNNER._MODEL_ROUTING_MOD.resolve_route(args_override)
            self.assertEqual(resolved_override.engine, "claude")
            self.assertEqual(resolved_override.model, "claude:balanced")
            self.assertIsNone(resolved_override.effort)
            self.assertEqual(resolved_override.claude_config_dir, alt_dir.resolve())

            args_alt = argparse.Namespace(
                route="claude-alt",
                engine=None,
                model="claude:balanced",
                effort=None,
                variant=None,
                claude_config_dir=None,
            )
            resolved_alt = RUNNER._MODEL_ROUTING_MOD.resolve_route(args_alt)
            self.assertEqual(resolved_alt.engine, "claude")
            self.assertEqual(resolved_alt.model, "claude:balanced")
            self.assertEqual(resolved_alt.claude_config_dir, alt_dir.resolve())

            args_explicit = argparse.Namespace(
                route="alt-or-main",
                engine="claude",
                model="claude:fast",
                effort=None,
                variant=None,
                claude_config_dir=default_dir,
            )
            resolved_explicit = RUNNER._MODEL_ROUTING_MOD.resolve_route(args_explicit)
            self.assertEqual(resolved_explicit.claude_config_dir, default_dir)

            args_primary = argparse.Namespace(
                route="alt-or-main",
                engine="claude",
                model=None,
                effort=None,
                variant=None,
                claude_config_dir=None,
            )
            resolved_primary = RUNNER._MODEL_ROUTING_MOD.resolve_route(args_primary)
            self.assertEqual(resolved_primary.model, "claude:fast")
            self.assertEqual(resolved_primary.claude_config_dir, alt_dir.resolve())

    def test_resolve_account_by_home_and_synthesized_defaults_without_monitor_config(self) -> None:
        routing = RUNNER._MODEL_ROUTING_MOD
        missing_cfg = self.root / "missing-monitor-config.json"
        empty_routes = self.root / "empty-routes.json"
        empty_routes.write_text(json.dumps({"routes": {}}), encoding="utf-8")

        with mock.patch.dict(
            os.environ,
            {"MONITOR_CONFIG": str(missing_cfg), "ORCHESTRATE_CONFIG": str(empty_routes)},
        ):
            for selector, expected_engine in (
                ("codex", "codex"),
                ("claude", "claude"),
                ("antigravity", "agy"),
                ("Codex", "codex"),
            ):
                acct = routing.resolve_configured_account(selector)
                self.assertIsNotNone(acct)
                assert acct is not None
                self.assertEqual(acct["engine"], expected_engine)
                self.assertEqual(acct["account_id"], selector.lower())
                self.assertIsNone(acct["codex_home"])
                self.assertIsNone(acct["agy_home"])
            self.assertIsNone(routing.resolve_configured_account("unknown-acct"))

            resolved = routing.resolve_route(
                argparse.Namespace(route=None, engine=None, model=None, effort=None, variant=None, account="codex")
            )
            self.assertEqual(resolved.engine, "codex")
            self.assertTrue(resolved.explicit_account)

        # When monitor config exists and has no matching account, built-in names must not be synthesized.
        present_cfg = self.root / "present-monitor-config.json"
        codex_alt = self.root / ".codex-alt"
        agy_home = self.root / ".gemini"
        agy_app_work = agy_home / "antigravity-work"
        agy_app_other = agy_home / "antigravity-other"
        present_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "codex-default", "provider": "codex", "tags": ["work"]},
                        {"id": "codex-alt", "provider": "codex", "codexHome": str(codex_alt), "tags": ["personal"]},
                        {
                            "id": "agy-default",
                            "provider": "antigravity",
                            "tags": ["default"],
                            "env": {"GEMINI_CLI_HOME": str(agy_home)},
                        },
                        {
                            "id": "agy-work",
                            "provider": "antigravity",
                            "tags": ["work"],
                            "env": {
                                "GEMINI_CLI_HOME": str(agy_home),
                                "ANTIGRAVITY_APP_DATA_DIR": str(agy_app_work),
                            },
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        with (
            mock.patch.object(Path, "home", return_value=self.root),
            mock.patch.dict(
                os.environ,
                {
                    "MONITOR_CONFIG": str(present_cfg),
                    "CODEX_HOME": "",
                    "ORKEST_CODEX_ACCOUNT_HOME": "",
                    "GEMINI_CLI_HOME": "",
                    "ANTIGRAVITY_APP_DATA_DIR": "",
                    "ORKEST_AGY_ACCOUNT_HOME": "",
                },
            ),
        ):
            self.assertIsNone(routing.resolve_configured_account("codex"))
            # Implicit default ~/.codex resolves codex-default; env overrides resolve codex-alt.
            self.assertEqual(routing.resolve_account_by_home("codex")["account_id"], "codex-default")
            with mock.patch.dict(os.environ, {"CODEX_HOME": str(codex_alt)}):
                self.assertEqual(routing.resolve_account_by_home("codex")["account_id"], "codex-alt")
            with mock.patch.dict(os.environ, {"ORKEST_CODEX_ACCOUNT_HOME": str(codex_alt)}):
                self.assertEqual(routing.resolve_account_by_home("codex")["account_id"], "codex-alt")

            # Implicit default ~/.gemini resolves agy-default; exact ANTIGRAVITY_APP_DATA_DIR wins over parent strip.
            self.assertEqual(routing.resolve_account_by_home("agy")["account_id"], "agy-default")
            with mock.patch.dict(os.environ, {"ANTIGRAVITY_APP_DATA_DIR": str(agy_app_work)}):
                self.assertEqual(routing.resolve_account_by_home("agy")["account_id"], "agy-work")
            with mock.patch.dict(os.environ, {"ANTIGRAVITY_APP_DATA_DIR": str(agy_app_other)}):
                self.assertIsNone(routing.resolve_account_by_home("agy"))

    def test_claude_config_dir_resolves_against_account_effective_home(self) -> None:
        routing = RUNNER._MODEL_ROUTING_MOD
        acct_home = self.root / "acct-home"
        rel_cfg_dir = acct_home / ".claude-work"
        acct_home.mkdir(parents=True, exist_ok=True)
        rel_cfg_dir.mkdir(parents=True, exist_ok=True)
        monitor_cfg = self.root / "monitor-home-rel.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "claude-rel-work",
                            "provider": "claude",
                            "env": {
                                "HOME": str(acct_home),
                                "CLAUDE_CONFIG_DIR": ".claude-work",
                            },
                        },
                        {
                            "id": "claude-rel-default",
                            "provider": "claude",
                            "env": {
                                "HOME": str(acct_home),
                                "CLAUDE_CONFIG_DIR": ".claude",
                            },
                        },
                        {
                            "id": "claude-tilde-work",
                            "provider": "claude",
                            "env": {
                                "HOME": str(acct_home),
                                "CLAUDE_CONFIG_DIR": "~/.claude-work",
                            },
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        with mock.patch.dict(os.environ, {"MONITOR_CONFIG": str(monitor_cfg)}):
            rel_work = routing.resolve_configured_account("claude-rel-work")
            self.assertIsNotNone(rel_work)
            assert rel_work is not None
            self.assertEqual(rel_work["claude_account_home"], acct_home.resolve())
            self.assertEqual(rel_work["claude_config_dir"], rel_cfg_dir.resolve())

            rel_default = routing.resolve_configured_account("claude-rel-default")
            self.assertIsNotNone(rel_default)
            assert rel_default is not None
            self.assertEqual(rel_default["claude_account_home"], acct_home.resolve())
            self.assertIsNone(rel_default["claude_config_dir"])

            tilde_work = routing.resolve_configured_account("claude-tilde-work")
            self.assertIsNotNone(tilde_work)
            assert tilde_work is not None
            self.assertEqual(tilde_work["claude_account_home"], acct_home.resolve())
            self.assertEqual(tilde_work["claude_config_dir"], rel_cfg_dir.resolve())

    def test_discovers_multi_account_profiles_when_monitor_config_absent(self) -> None:
        routing = RUNNER._MODEL_ROUTING_MOD
        missing_cfg = self.root / "absent-monitor.json"
        claude_work = self.root / ".claude-work"
        claude_work.mkdir()
        (claude_work / ".claude.json").write_text("{}", encoding="utf-8")
        claude_empty = self.root / ".claude-empty"
        claude_empty.mkdir()

        codex_personal = self.root / ".codex-personal"
        codex_personal.mkdir()
        (codex_personal / "auth.json").write_text("{}", encoding="utf-8")
        codex_empty = self.root / ".codex-empty"
        codex_empty.mkdir()

        agy_work = self.root / ".antigravity-work"
        (agy_work / "antigravity-cli").mkdir(parents=True)
        (agy_work / "antigravity-cli" / "antigravity-oauth-token").write_text("tok", encoding="utf-8")
        agy_empty = self.root / ".antigravity-empty"
        agy_empty.mkdir()

        with (
            mock.patch.object(Path, "home", return_value=self.root),
            mock.patch.dict(os.environ, {"MONITOR_CONFIG": str(missing_cfg)}),
        ):
            acct_claude = routing.resolve_configured_account("claude-work")
            self.assertIsNotNone(acct_claude)
            assert acct_claude is not None
            self.assertEqual(acct_claude["engine"], "claude")
            self.assertEqual(acct_claude["claude_config_dir"], claude_work.resolve())
            self.assertIsNone(routing.resolve_configured_account("claude-empty"))

            acct_codex = routing.resolve_configured_account("codex-personal")
            self.assertIsNotNone(acct_codex)
            assert acct_codex is not None
            self.assertEqual(acct_codex["engine"], "codex")
            self.assertEqual(acct_codex["codex_home"], codex_personal.resolve())
            self.assertIsNone(routing.resolve_configured_account("codex-empty"))

            acct_agy = routing.resolve_configured_account("antigravity-work")
            self.assertIsNotNone(acct_agy)
            assert acct_agy is not None
            self.assertEqual(acct_agy["engine"], "agy")
            self.assertEqual(acct_agy["agy_app_data_dir"], agy_work.resolve())
            self.assertEqual(acct_agy["agy_home"], agy_work.resolve())
            self.assertIsNone(routing.resolve_configured_account("antigravity-empty"))

            resolved_agy = routing.resolve_route(
                argparse.Namespace(
                    route=None, engine=None, model=None, effort=None, variant=None, account="antigravity-work"
                )
            )
            self.assertEqual(resolved_agy.engine, "agy")
            self.assertEqual(resolved_agy.agy_app_data_dir, agy_work.resolve())
            self.assertEqual(resolved_agy.agy_home, agy_work.resolve())
            agy_env = RUNNER.executor_environment(
                "agy",
                agy_home=resolved_agy.agy_home,
                agy_app_data_dir=resolved_agy.agy_app_data_dir,
                pinned_account=True,
            )
            self.assertEqual(agy_env["ANTIGRAVITY_APP_DATA_DIR"], str(agy_work.resolve()))
            self.assertEqual(agy_env["GEMINI_CLI_HOME"], str(agy_work.resolve()))

    def test_route_alias_grammar_reserved_names_and_tilde_base_home_parity(self) -> None:
        routing = RUNNER._MODEL_ROUTING_MOD
        repo_policy = RUNNER.bundled_module("repo_policy")
        acct_home = self.root / "acct-base-home"
        sub_claude = acct_home / "custom-claude"
        sub_claude.mkdir(parents=True, exist_ok=True)
        sub_codex = acct_home / "custom-codex"
        sub_codex.mkdir(parents=True, exist_ok=True)

        monitor_cfg = self.root / "monitor-parity.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "acct-bad-underscore",
                            "provider": "claude",
                            "route": "_blue",
                            "configDir": str(self.root / "c1"),
                        },
                        {
                            "id": "acct-reserved-all",
                            "provider": "codex",
                            "route": "ALL",
                            "codexHome": str(self.root / "x1"),
                        },
                        {
                            "id": "acct-reserved-gemini",
                            "provider": "antigravity",
                            "route": "gemini",
                            "env": {"GEMINI_CLI_HOME": str(self.root / "g1")},
                        },
                        {
                            "id": "acct-valid-dot",
                            "provider": "claude",
                            "route": "blue.1_ok-2",
                            "env": {"HOME": str(acct_home)},
                            "configDir": "~/custom-claude",
                        },
                        {
                            "id": "acct-codex-tilde",
                            "provider": "codex",
                            "env": {"HOME": str(acct_home), "CODEX_HOME": "~/custom-codex"},
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        with (
            mock.patch.object(Path, "home", return_value=self.root),
            mock.patch.dict(os.environ, {"MONITOR_CONFIG": str(monitor_cfg)}),
        ):
            self.assertIsNone(routing.resolve_configured_account("_blue"))
            self.assertIsNone(routing.resolve_configured_account("all"))
            self.assertIsNone(routing.resolve_configured_account("ALL"))
            self.assertIsNone(routing.resolve_configured_account("gemini"))
            valid = routing.resolve_configured_account("blue.1_ok-2")
            self.assertIsNotNone(valid)
            assert valid is not None
            self.assertEqual(valid["account_id"], "acct-valid-dot")
            self.assertEqual(valid["claude_config_dir"], sub_claude.resolve())

            self.assertIsNone(
                repo_policy.resolve_configured_account("_blue", home=self.root, monitor_config_path=monitor_cfg)
            )
            self.assertIsNone(
                repo_policy.resolve_configured_account("all", home=self.root, monitor_config_path=monitor_cfg)
            )
            self.assertIsNone(
                repo_policy.resolve_configured_account("gemini", home=self.root, monitor_config_path=monitor_cfg)
            )
            rp_valid = repo_policy.resolve_configured_account(
                "blue.1_ok-2", home=self.root, monitor_config_path=monitor_cfg
            )
            self.assertIsNotNone(rp_valid)
            assert rp_valid is not None
            self.assertEqual(rp_valid["id"], "acct-valid-dot")

            # ~ in configDir and CODEX_HOME expands against account env.HOME (base_home), not caller home.
            rp_by_claude_dir = repo_policy.resolve_configured_account(
                claude_config_dir=sub_claude, home=self.root, monitor_config_path=monitor_cfg
            )
            self.assertIsNotNone(rp_by_claude_dir)
            assert rp_by_claude_dir is not None
            self.assertEqual(rp_by_claude_dir["id"], "acct-valid-dot")

            rp_by_codex_home = repo_policy.resolve_configured_account(
                codex_home=sub_codex, home=self.root, monitor_config_path=monitor_cfg
            )
            self.assertIsNotNone(rp_by_codex_home)
            assert rp_by_codex_home is not None
            self.assertEqual(rp_by_codex_home["id"], "acct-codex-tilde")

    def test_resolve_account_by_home_child_marker_precedence_and_native_exclusion(self) -> None:
        routing = RUNNER._MODEL_ROUTING_MOD
        base_home = self.root / "base-home"
        red_home = self.root / "red-home"
        alt_claude = self.root / ".claude-alt"
        alt_codex = self.root / ".codex-alt"
        alt_agy_app = base_home / ".gemini" / "antigravity-alt"
        for directory in (
            base_home / ".claude",
            red_home / ".claude",
            alt_claude,
            alt_codex,
            alt_agy_app,
        ):
            directory.mkdir(parents=True, exist_ok=True)

        monitor_cfg = self.root / "monitor-child-markers.json"
        monitor_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {"id": "claude-base", "provider": "claude", "tags": ["personal"]},
                        {"id": "claude-alt", "provider": "claude", "configDir": str(alt_claude)},
                        {
                            "id": "claude-red",
                            "provider": "claude",
                            "tags": ["work"],
                            "configDir": "~/.claude",
                            "env": {"HOME": str(red_home)},
                        },
                        {"id": "codex-base", "provider": "codex"},
                        {"id": "codex-alt", "provider": "codex", "codexHome": str(alt_codex)},
                        {"id": "agy-base", "provider": "antigravity", "tags": ["personal"]},
                        {
                            "id": "agy-alt",
                            "provider": "antigravity",
                            "tags": ["work"],
                            "env": {"ANTIGRAVITY_APP_DATA_DIR": str(alt_agy_app)},
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        base_env = {
            "HOME": str(base_home),
            "MONITOR_CONFIG": str(monitor_cfg),
            "CLAUDE_CONFIG_DIR": "",
            "ORKEST_CLAUDE_ACCOUNT_HOME": "",
            "ORKEST_PINNED_CLAUDE_ACCOUNT": "",
            "CODEX_HOME": "",
            "ORKEST_CODEX_ACCOUNT_HOME": "",
            "ORKEST_PINNED_CODEX_ACCOUNT": "",
            "ANTIGRAVITY_APP_DATA_DIR": "",
            "GEMINI_CLI_HOME": "",
            "ORKEST_AGY_ACCOUNT_HOME": "",
            "ORKEST_PINNED_AGY_ACCOUNT": "",
        }
        with mock.patch.object(Path, "home", return_value=base_home):
            # 1. ORKEST_CLAUDE_ACCOUNT_HOME beats stale CLAUDE_CONFIG_DIR; include_child_markers=False ignores ORKEST_*.
            with mock.patch.dict(
                os.environ,
                {
                    **base_env,
                    "CLAUDE_CONFIG_DIR": str(alt_claude),
                    "ORKEST_PINNED_CLAUDE_ACCOUNT": "1",
                    "ORKEST_CLAUDE_ACCOUNT_HOME": str(red_home),
                },
            ):
                self.assertEqual(routing.resolve_account_by_home("claude")["account_id"], "claude-red")
                self.assertEqual(
                    routing.resolve_account_by_home("claude", include_child_markers=False)["account_id"],
                    "claude-alt",
                )

            # 2. ORKEST_PINNED_CLAUDE_ACCOUNT=1 beats stale CLAUDE_CONFIG_DIR and resolves base default ~/.claude.
            with mock.patch.dict(
                os.environ,
                {
                    **base_env,
                    "CLAUDE_CONFIG_DIR": str(alt_claude),
                    "ORKEST_PINNED_CLAUDE_ACCOUNT": "1",
                },
            ):
                self.assertEqual(routing.resolve_account_by_home("claude")["account_id"], "claude-base")
                self.assertEqual(
                    routing.resolve_account_by_home("claude", include_child_markers=False)["account_id"],
                    "claude-alt",
                )

            # 3. Codex and Agy child markers override stale host vars when include_child_markers=True, not False.
            with mock.patch.dict(
                os.environ,
                {
                    **base_env,
                    "CODEX_HOME": str(alt_codex),
                    "ORKEST_PINNED_CODEX_ACCOUNT": "1",
                    "ANTIGRAVITY_APP_DATA_DIR": str(alt_agy_app),
                    "ORKEST_PINNED_AGY_ACCOUNT": "1",
                },
            ):
                self.assertEqual(routing.resolve_account_by_home("codex")["account_id"], "codex-base")
                self.assertEqual(
                    routing.resolve_account_by_home("codex", include_child_markers=False)["account_id"],
                    "codex-alt",
                )
                self.assertEqual(routing.resolve_account_by_home("agy")["account_id"], "agy-base")
                self.assertEqual(
                    routing.resolve_account_by_home("agy", include_child_markers=False)["account_id"],
                    "agy-alt",
                )

            with mock.patch.dict(
                os.environ,
                {
                    **base_env,
                    "ORKEST_AGY_ACCOUNT_HOME": str(alt_agy_app),
                    "ANTIGRAVITY_APP_DATA_DIR": "",
                },
            ):
                self.assertEqual(routing.resolve_account_by_home("agy")["account_id"], "agy-alt")
                self.assertEqual(
                    routing.resolve_account_by_home("agy", include_child_markers=False)["account_id"],
                    "agy-base",
                )

            # 4. Implicit ANTIGRAVITY_APP_DATA_DIR populates effective_* without setting explicit_account=True.
            with mock.patch.dict(os.environ, {**base_env, "ANTIGRAVITY_APP_DATA_DIR": str(alt_agy_app)}):
                resolved = routing.resolve_route(
                    argparse.Namespace(route=None, engine="agy", model=None, effort=None, variant=None, account=None)
                )
                self.assertFalse(resolved.explicit_account)
                self.assertIsNone(resolved.agy_app_data_dir)
                self.assertEqual(resolved.effective_agy_app_data_dir, alt_agy_app.resolve())
                self.assertEqual(resolved.account_id, "agy-alt")

    def test_derive_agy_profile_pair_catches_shared_app_data_vs_marker_home_mismatch(self) -> None:
        routing = RUNNER._MODEL_ROUTING_MOD
        host_dir = self.root / "host"
        shared_dir = self.root / "shared"
        host_dir.mkdir()
        shared_dir.mkdir()
        with mock.patch.dict(
            os.environ,
            {
                "GEMINI_CLI_HOME": str(host_dir),
                "ANTIGRAVITY_APP_DATA_DIR": str(shared_dir),
                "ORKEST_AGY_ACCOUNT_HOME": str(shared_dir),
            },
        ):
            self.assertEqual(
                routing._derive_agy_profile_pair(shared_dir, None),
                (shared_dir.resolve(), (shared_dir / "antigravity-cli").resolve()),
            )
            self.assertEqual(
                routing._derive_agy_profile_pair(host_dir, shared_dir),
                (host_dir.resolve(), shared_dir.resolve()),
            )
            self.assertFalse(routing._agy_paths_match(shared_dir, None))
            self.assertTrue(routing._agy_paths_match(host_dir, shared_dir))
            self.assertTrue(routing._child_marker_switches_host_profile("agy"))

        team_dir = self.root / "profiles" / "antigravity-team"
        team_dir.mkdir(parents=True, exist_ok=True)
        with mock.patch.dict(
            os.environ,
            {
                "GEMINI_CLI_HOME": str(team_dir),
                "ANTIGRAVITY_APP_DATA_DIR": "",
                "ORKEST_AGY_ACCOUNT_HOME": str(team_dir),
            },
        ):
            self.assertEqual(
                routing._derive_agy_profile_pair(team_dir, None, infer_gemini_basename=False),
                (team_dir.resolve(), (team_dir / "antigravity-cli").resolve()),
            )
            self.assertEqual(
                routing._derive_agy_profile_pair(team_dir, None, infer_gemini_basename=True),
                (team_dir.parent.resolve(), team_dir.resolve()),
            )
            self.assertFalse(routing._agy_paths_match(team_dir, None))
            self.assertTrue(routing._child_marker_switches_host_profile("agy"))

        resolved_codex = routing.resolve_route(
            argparse.Namespace(
                route=None,
                engine="codex",
                model=None,
                effort=None,
                variant=None,
                account=None,
                claude_config_dir=Path("/other"),
            )
        )
        self.assertFalse(resolved_codex.explicit_account)

    def test_resolve_account_by_home_shared_gemini_home_default_vs_green_and_basename_only_team(self) -> None:
        routing = RUNNER._MODEL_ROUTING_MOD
        repo_policy = RUNNER.bundled_module("repo_policy")
        base_home = self.root / "caller-home"
        gemini_default = base_home / ".gemini"
        green_app = gemini_default / "antigravity-green"
        profiles_dir = self.root / "profiles"
        team_dir = profiles_dir / "antigravity-team"
        for d in (gemini_default, green_app, team_dir):
            d.mkdir(parents=True, exist_ok=True)

        # 1. [green, default] sharing ~/.gemini: native default must resolve default, not green.
        cfg_shared = self.root / "monitor-agy-shared-default.json"
        cfg_shared.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "agy-green",
                            "provider": "antigravity",
                            "tags": ["work"],
                            "env": {"GEMINI_CLI_HOME": str(gemini_default), "ANTIGRAVITY_APP_DATA_DIR": str(green_app)},
                        },
                        {"id": "agy-default", "provider": "antigravity", "tags": ["personal"]},
                    ]
                }
            ),
            encoding="utf-8",
        )
        clean_agy = {
            "HOME": str(base_home),
            "MONITOR_CONFIG": str(cfg_shared),
            "GEMINI_CLI_HOME": "",
            "ANTIGRAVITY_APP_DATA_DIR": "",
            "ORKEST_AGY_ACCOUNT_HOME": "",
            "ORKEST_PINNED_AGY_ACCOUNT": "",
        }
        with mock.patch.object(Path, "home", return_value=base_home), mock.patch.dict(os.environ, clean_agy):
            self.assertEqual(
                routing.resolve_account_by_home("agy", include_child_markers=False)["account_id"],
                "agy-default",
            )
            with mock.patch.dict(
                os.environ,
                {"ANTIGRAVITY_APP_DATA_DIR": str(green_app), "ORKEST_PINNED_AGY_ACCOUNT": "1"},
            ):
                self.assertEqual(routing.resolve_account_by_home("agy")["account_id"], "agy-default")

        # Without agy-default configured, green must NOT falsely match default ~/.gemini.
        cfg_green_only = self.root / "monitor-agy-green-only.json"
        cfg_green_only.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "agy-green",
                            "provider": "antigravity",
                            "tags": ["work"],
                            "env": {"GEMINI_CLI_HOME": str(gemini_default), "ANTIGRAVITY_APP_DATA_DIR": str(green_app)},
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        with (
            mock.patch.object(Path, "home", return_value=base_home),
            mock.patch.dict(os.environ, {**clean_agy, "MONITOR_CONFIG": str(cfg_green_only)}),
        ):
            self.assertIsNone(routing.resolve_account_by_home("agy", include_child_markers=False))
            self.assertIsNone(
                repo_policy.resolve_configured_account(
                    agy_home=gemini_default, home=base_home, monitor_config_path=cfg_green_only
                )
            )

        # 2. [acct_parent(/profiles), acct_team(/profiles/antigravity-team)]: native keeps antigravity-team!
        cfg_team = self.root / "monitor-agy-team-vs-parent.json"
        cfg_team.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "agy-parent",
                            "provider": "antigravity",
                            "tags": ["personal"],
                            "env": {"GEMINI_CLI_HOME": str(profiles_dir)},
                        },
                        {
                            "id": "agy-team",
                            "provider": "antigravity",
                            "tags": ["work"],
                            "env": {"GEMINI_CLI_HOME": str(team_dir)},
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        with (
            mock.patch.object(Path, "home", return_value=base_home),
            mock.patch.dict(
                os.environ,
                {
                    **clean_agy,
                    "MONITOR_CONFIG": str(cfg_team),
                    "GEMINI_CLI_HOME": str(team_dir),
                },
            ),
        ):
            self.assertEqual(
                routing.resolve_account_by_home("agy", include_child_markers=False)["account_id"],
                "agy-team",
            )
            self.assertEqual(routing.resolve_account_by_home("agy")["account_id"], "agy-team")
            with mock.patch.dict(os.environ, {"ORKEST_AGY_ACCOUNT_HOME": str(team_dir)}):
                self.assertNotEqual(
                    (routing.resolve_account_by_home("agy") or {}).get("account_id"),
                    "agy-team",
                )
            resolved_team = routing.resolve_route(
                argparse.Namespace(route=None, engine="agy", model=None, effort=None, variant=None, account=None)
            )
            self.assertEqual(resolved_team.account_id, "agy-team")
            self.assertEqual(resolved_team.effective_agy_home, team_dir.resolve())
            self.assertEqual(resolved_team.effective_agy_app_data_dir, (team_dir / "antigravity-cli").resolve())
            alt_live_app = self.root / "alternate" / "live"
            alt_live_app.mkdir(parents=True, exist_ok=True)
            with mock.patch.dict(os.environ, {"ANTIGRAVITY_APP_DATA_DIR": str(alt_live_app)}):
                self.assertIsNone(routing.resolve_account_by_home("agy"))

        # 3. Relative ORKEST_AGY_ACCOUNT_HOME resolves against Path.home() in both routing and executor_environment.
        caller_profiles = base_home / "profiles"
        caller_profiles.mkdir(parents=True, exist_ok=True)
        with (
            mock.patch.object(Path, "home", return_value=base_home),
            mock.patch.dict(
                os.environ,
                {
                    **clean_agy,
                    "GEMINI_CLI_HOME": str(caller_profiles),
                    "ORKEST_AGY_ACCOUNT_HOME": "profiles",
                },
            ),
        ):
            self.assertFalse(routing._child_marker_switches_host_profile("agy"))
            exec_env = RUNNER.executor_environment("agy")
            self.assertEqual(exec_env.get("GEMINI_CLI_HOME"), str(caller_profiles.resolve()))
            self.assertEqual(
                exec_env.get("ANTIGRAVITY_APP_DATA_DIR"), str((caller_profiles / "antigravity-cli").resolve())
            )

    def test_repo_policy_typed_agy_selector_and_effective_app_data_matching(self) -> None:
        repo_policy = RUNNER.bundled_module("repo_policy")
        repo_dir = self.root / "repo-typed-agy"
        repo_dir.mkdir(exist_ok=True)
        shared_dir = self.root / "shared"
        profiles_dir = self.root / "profiles-typed"
        team_dir = profiles_dir / "antigravity-team"
        team_app = team_dir / "antigravity-cli"
        for d in (shared_dir, team_app):
            d.mkdir(parents=True, exist_ok=True)

        home_acct = {"id": "home", "provider": "antigravity", "env": {"GEMINI_CLI_HOME": str(shared_dir)}}
        app_acct = {"id": "app", "provider": "antigravity", "env": {"ANTIGRAVITY_APP_DATA_DIR": str(shared_dir)}}
        for accounts_order in ([home_acct, app_acct], [app_acct, home_acct]):
            cfg = self.root / f"monitor-typed-{accounts_order[0]['id']}.json"
            cfg.write_text(json.dumps({"accounts": accounts_order}), encoding="utf-8")
            deny_app = {"repo_policies": [{"path": str(repo_dir), "deny": ["account:app"]}]}
            deny_home = {"repo_policies": [{"path": str(repo_dir), "deny": ["account:home"]}]}

            ok_app_denied, _, _ = repo_policy.check_execution_allowed(
                repo_dir,
                "agy",
                config=deny_app,
                home=self.root,
                monitor_config_path=cfg,
                env={"HOME": str(self.root), "ANTIGRAVITY_APP_DATA_DIR": str(shared_dir)},
                strict=True,
            )
            self.assertFalse(ok_app_denied)

            ok_home_allowed_on_app, _, _ = repo_policy.check_execution_allowed(
                repo_dir,
                "agy",
                config=deny_home,
                home=self.root,
                monitor_config_path=cfg,
                env={"HOME": str(self.root), "ANTIGRAVITY_APP_DATA_DIR": str(shared_dir)},
                strict=True,
            )
            self.assertTrue(ok_home_allowed_on_app)

            ok_home_denied_on_home, _, _ = repo_policy.check_execution_allowed(
                repo_dir,
                "agy",
                config=deny_home,
                home=self.root,
                monitor_config_path=cfg,
                env={"HOME": str(self.root), "GEMINI_CLI_HOME": str(shared_dir)},
                strict=True,
            )
            self.assertFalse(ok_home_denied_on_home)

        parent_acct = {"id": "parent", "provider": "antigravity", "env": {"GEMINI_CLI_HOME": str(profiles_dir)}}
        team_app_acct = {
            "id": "team_app",
            "provider": "antigravity",
            "env": {"ANTIGRAVITY_APP_DATA_DIR": str(team_app)},
        }
        for accounts_order in ([parent_acct, team_app_acct], [team_app_acct, parent_acct]):
            cfg = self.root / f"monitor-team-app-{accounts_order[0]['id']}.json"
            cfg.write_text(json.dumps({"accounts": accounts_order}), encoding="utf-8")
            deny_team = {"repo_policies": [{"path": str(repo_dir), "deny": ["account:team_app"]}]}
            ok_team, _, _ = repo_policy.check_execution_allowed(
                repo_dir,
                "agy",
                config=deny_team,
                home=self.root,
                monitor_config_path=cfg,
                env={"HOME": str(self.root), "GEMINI_CLI_HOME": str(team_dir)},
                strict=True,
            )
            self.assertFalse(ok_team)

        # Global config["env"] merges into accounts (account overrides global), and top-level agyAppDataDir is honored.
        global_cfg = self.root / "monitor-global-env-merge.json"
        override_app = self.root / "override-app"
        override_app.mkdir(parents=True, exist_ok=True)
        global_cfg.write_text(
            json.dumps(
                {
                    "env": {"GEMINI_CLI_HOME": str(shared_dir)},
                    "accounts": [
                        {"id": "inherited-home", "provider": "antigravity"},
                        {"id": "top-app", "provider": "antigravity", "agyAppDataDir": str(override_app)},
                    ],
                }
            ),
            encoding="utf-8",
        )
        ok_global_denied, _, _ = repo_policy.check_execution_allowed(
            repo_dir,
            "agy",
            config={"repo_policies": [{"path": str(repo_dir), "deny": ["account:inherited-home"]}]},
            home=self.root,
            monitor_config_path=global_cfg,
            env={"HOME": str(self.root), "GEMINI_CLI_HOME": str(shared_dir)},
            strict=True,
        )
        self.assertFalse(ok_global_denied)
        ok_top_app_denied, _, _ = repo_policy.check_execution_allowed(
            repo_dir,
            "agy",
            config={"repo_policies": [{"path": str(repo_dir), "deny": ["account:top-app"]}]},
            home=self.root,
            monitor_config_path=global_cfg,
            env={"HOME": str(self.root), "ANTIGRAVITY_APP_DATA_DIR": str(override_app)},
            strict=True,
        )
        self.assertFalse(ok_top_app_denied)

        # Global env merge null/blank/trim semantics & camelCase-first parity across model_routing and repo_policy.
        routing = RUNNER._MODEL_ROUTING_MOD
        camel_dir = self.root / "camel-app"
        snake_dir = self.root / "snake-app"
        camel_dir.mkdir(parents=True, exist_ok=True)
        snake_dir.mkdir(parents=True, exist_ok=True)
        parity_cfg = self.root / "monitor-env-null-and-camel.json"
        parity_cfg.write_text(
            json.dumps(
                {
                    "env": {"GEMINI_CLI_HOME": f"  {shared_dir}  "},
                    "accounts": [
                        {"id": "blank-keeps-global", "provider": "antigravity", "env": {"GEMINI_CLI_HOME": ""}},
                        {"id": "null-clears-global", "provider": "antigravity", "env": {"GEMINI_CLI_HOME": None}},
                        {
                            "id": "camel-wins",
                            "provider": "antigravity",
                            "agyAppDataDir": str(camel_dir),
                            "agy_app_data_dir": str(snake_dir),
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        with (
            mock.patch.object(Path, "home", return_value=self.root),
            mock.patch.dict(
                os.environ,
                {
                    "HOME": str(self.root),
                    "MONITOR_CONFIG": str(parity_cfg),
                    "GEMINI_CLI_HOME": "",
                    "ANTIGRAVITY_APP_DATA_DIR": "",
                    "ORKEST_AGY_ACCOUNT_HOME": "",
                    "ORKEST_PINNED_AGY_ACCOUNT": "",
                },
            ),
        ):
            self.assertEqual(
                routing.resolve_account_by_home("agy", agy_home=shared_dir)["account_id"],
                "blank-keeps-global",
            )
            self.assertEqual(
                routing.resolve_account_by_home("agy", include_child_markers=False)["account_id"],
                "null-clears-global",
            )
            self.assertEqual(
                repo_policy.resolve_configured_account(
                    agy_home=shared_dir, home=self.root, monitor_config_path=parity_cfg
                )["id"],
                "blank-keeps-global",
            )
            self.assertEqual(
                repo_policy.resolve_configured_account(
                    agy_home=self.root / ".gemini", home=self.root, monitor_config_path=parity_cfg
                )["id"],
                "null-clears-global",
            )
            self.assertEqual(
                routing.resolve_configured_account("camel-wins")["agy_app_data_dir"],
                camel_dir.resolve(),
            )
            self.assertEqual(
                repo_policy.resolve_configured_account(
                    agy_app_data_dir=camel_dir, home=self.root, monitor_config_path=parity_cfg
                )["id"],
                "camel-wins",
            )
            self.assertIsNone(
                repo_policy.resolve_configured_account(
                    agy_app_data_dir=snake_dir, home=self.root, monitor_config_path=parity_cfg
                )
            )

        # claude_config_dir / claudeConfigDir take precedence over configDir and env.CLAUDE_CONFIG_DIR
        # in both selector_or_paths matching and check_execution_allowed's returned auto_claude_dir.
        claude_caller_home = self.root / "claude-caller-home"
        default_claude = claude_caller_home / ".claude"
        denied_claude = claude_caller_home / ".claude-denied"
        default_claude.mkdir(parents=True, exist_ok=True)
        denied_claude.mkdir(parents=True, exist_ok=True)
        claude_precedence_cfg = self.root / "monitor-claude-precedence.json"
        claude_precedence_cfg.write_text(
            json.dumps(
                {
                    "accounts": [
                        {
                            "id": "team",
                            "provider": "claude",
                            "claude_config_dir": str(default_claude),
                            "env": {"CLAUDE_CONFIG_DIR": str(denied_claude)},
                        },
                        {
                            "id": "blocked",
                            "provider": "claude",
                            "claudeConfigDir": str(denied_claude),
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        self.assertEqual(
            repo_policy.resolve_configured_account(
                {
                    "provider": "claude",
                    "claude_config_dir": str(default_claude),
                    "configDir": str(denied_claude),
                },
                home=claude_caller_home,
                monitor_config_path=claude_precedence_cfg,
            )["id"],
            "team",
        )
        ok_team, reason_team, auto_claude_dir = repo_policy.check_execution_allowed(
            repo_dir,
            "claude",
            config={"repo_policies": [{"path": str(repo_dir), "deny": ["account:blocked"]}]},
            home=claude_caller_home,
            monitor_config_path=claude_precedence_cfg,
            env={"HOME": str(claude_caller_home)},
            strict=True,
        )
        self.assertTrue(ok_team, reason_team)
        self.assertEqual(auto_claude_dir, default_claude)
        self.assertNotEqual(auto_claude_dir, denied_claude)


if __name__ == "__main__":
    unittest.main()
