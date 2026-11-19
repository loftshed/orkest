"""The retired Claude Code / Codex plugin install is reported, never removed (issue 233 stage 1)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[5] / "plugins/orchestrate/skills/orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))

import install_mailbox as installer  # noqa: E402
import legacy_plugin  # noqa: E402


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


class LegacyPluginTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        patcher = mock.patch.dict("os.environ", {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("CLAUDE_CONFIG_DIR", "CODEX_HOME"):
            __import__("os").environ.pop(name, None)

    def tree(self) -> list[str]:
        return sorted(str(p.relative_to(self.home)) for p in self.home.rglob("*"))

    def test_a_clean_machine_reports_nothing(self) -> None:
        (self.home / ".claude").mkdir()
        write_json(self.home / ".claude/settings.json", {"enabledPlugins": {"other@elsewhere": True}})
        self.assertEqual(legacy_plugin.discover(self.home), [])
        self.assertEqual(legacy_plugin.render([]), "")

    def test_enabled_installed_and_registered_are_each_found(self) -> None:
        write_json(self.home / ".claude/settings.json", {"enabledPlugins": {"monitor@orkest": True}})
        write_json(
            self.home / ".claude-work/plugins/installed_plugins.json",
            {"version": 2, "plugins": {"orchestrate@orkest": [{"scope": "user"}], "x@y": []}},
        )
        write_json(self.home / ".claude-market/plugins/known_marketplaces.json", {"orkest": {}})
        write_json(
            self.home / ".claude-extra/settings.json",
            {"extraKnownMarketplaces": {"orkest": {"source": {"source": "directory", "path": "."}}}},
        )
        found = {Path(e["profile"]).name: e for e in legacy_plugin.discover(self.home)}
        self.assertEqual(set(found), {".claude", ".claude-work", ".claude-market", ".claude-extra"})
        self.assertEqual(found[".claude"]["plugins"], ["monitor@orkest"])
        self.assertFalse(found[".claude"]["marketplace"])
        self.assertEqual(found[".claude-work"]["plugins"], ["orchestrate@orkest"])
        self.assertTrue(found[".claude-market"]["marketplace"])
        self.assertEqual(found[".claude-market"]["plugins"], [])
        self.assertTrue(found[".claude-extra"]["marketplace"])

    def test_the_exact_removal_commands_are_printed_per_profile(self) -> None:
        write_json(
            self.home / ".claude/settings.json",
            {"enabledPlugins": {"orchestrate@orkest": True, "monitor@orkest": False}},
        )
        write_json(self.home / ".claude/plugins/known_marketplaces.json", {"orkest": {}})
        write_json(self.home / ".claude-work/settings.json", {"enabledPlugins": {"monitor@orkest": True}})
        entries = legacy_plugin.discover(self.home)
        by_name = {Path(e["profile"]).name: e for e in entries}
        self.assertEqual(
            legacy_plugin.removal_commands(by_name[".claude"]),
            [
                "claude plugin uninstall monitor@orkest",
                "claude plugin uninstall orchestrate@orkest",
                "claude plugin marketplace remove orkest",
            ],
        )
        self.assertEqual(
            legacy_plugin.removal_commands(by_name[".claude-work"]),
            [f"CLAUDE_CONFIG_DIR={self.home}/.claude-work claude plugin uninstall monitor@orkest"],
        )
        text = legacy_plugin.render(entries)
        self.assertIn("claude plugin marketplace remove orkest", text)
        self.assertIn("Nothing was uninstalled", text)

    def test_codex_plugin_tables_are_reported_without_a_command(self) -> None:
        codex = self.home / ".codex"
        codex.mkdir()
        (codex / "config.toml").write_text(
            '[plugins."monitor@orkest"]\nenabled = true\n\n[plugins."other@x"]\nenabled = true\n',
            encoding="utf-8",
        )
        (entry,) = legacy_plugin.discover(self.home)
        self.assertEqual((entry["harness"], entry["plugins"]), ("codex", ["monitor@orkest"]))
        self.assertEqual(legacy_plugin.removal_commands(entry), [])
        self.assertIn("config.toml", legacy_plugin.render([entry]))

    def test_discovery_and_reporting_never_modify_anything(self) -> None:
        write_json(self.home / ".claude/settings.json", {"enabledPlugins": {"monitor@orkest": True}})
        write_json(self.home / ".claude/plugins/installed_plugins.json", {"plugins": {"monitor@orkest": []}})
        (self.home / ".claude/plugins/cache/orkest/monitor/0.19.0").mkdir(parents=True)
        before = {p: p.read_bytes() for p in self.home.rglob("*") if p.is_file()}
        names = self.tree()
        with mock.patch("builtins.print") as printed:
            entries = installer.report_legacy_plugin(self.home)
        self.assertEqual(len(entries), 1)
        printed.assert_called_once()
        self.assertEqual(self.tree(), names)
        self.assertEqual({p: p.read_bytes() for p in self.home.rglob("*") if p.is_file()}, before)

    def test_the_installer_keeps_a_profile_with_the_old_cache_linked_and_untouched(self) -> None:
        hub = self.home / ".agents/skills/orchestrate"
        hub.mkdir(parents=True)
        (hub / "SKILL.md").write_text("---\nname: orchestrate\n---\n")
        cache = self.home / ".claude-old/plugins/cache/orkest/orchestrate/0.91.1"
        cache.mkdir(parents=True)
        (cache / "kept.txt").write_text("legacy copy\n")
        installer.install_orchestrate_skill_links(self.home)
        self.assertTrue((self.home / ".claude-old/skills/orchestrate").is_symlink())
        self.assertEqual((cache / "kept.txt").read_text(), "legacy copy\n")
        installer.sync_installed_runtimes(self.home, dry_run=False)
        self.assertEqual((cache / "kept.txt").read_text(), "legacy copy\n")
        self.assertEqual([p.name for p in cache.iterdir()], ["kept.txt"])


class ProductVersionTests(unittest.TestCase):
    def test_the_version_is_the_root_package_json(self) -> None:
        root = SCRIPTS.parents[4]
        expected = json.loads((root / "package.json").read_text())["version"]
        self.assertEqual(installer.product_root(), root)
        self.assertEqual(installer.product_version(), expected)

    def test_ork_fast_is_looked_up_under_the_product_tag_then_the_legacy_orchestrate_tag(self) -> None:
        self.assertEqual(
            installer.ork_fast_release_bases("0.92.0"),
            [
                "https://github.com/loftshed/orkest/releases/download/v0.92.0",
                "https://github.com/loftshed/orkest/releases/download/orchestrate--v0.92.0",
            ],
        )
        self.assertEqual(
            installer.ork_fast_release_bases("0.92.0", "https://example.invalid/x"), ["https://example.invalid/x"]
        )

    def test_a_missing_product_tag_falls_back_to_the_legacy_one(self) -> None:
        attempts: list[str] = []

        def fake(base: str, *_args: object) -> bool:
            attempts.append(base)
            return base.endswith("orchestrate--v0.91.1")

        with mock.patch.object(installer, "_download_ork_fast", side_effect=fake):
            self.assertTrue(
                any(
                    installer._download_ork_fast(base, "x86_64-unknown-linux-gnu", "0.91.1", Path("d"), Path("m"))
                    for base in installer.ork_fast_release_bases("0.91.1")
                )
            )
        self.assertEqual(
            attempts,
            [
                "https://github.com/loftshed/orkest/releases/download/v0.91.1",
                "https://github.com/loftshed/orkest/releases/download/orchestrate--v0.91.1",
            ],
        )


if __name__ == "__main__":
    unittest.main()
