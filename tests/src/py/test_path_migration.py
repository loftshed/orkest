"""Issue 233 stage 0: scoped, backed-up, idempotent, recoverable path migration."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[3] / "src/py"
sys.path.insert(0, str(SCRIPTS))
import install_mailbox as installer  # noqa: E402 -- the shipped installer hook
import path_migration as pm  # noqa: E402 -- exercise the shipped module

OLD = "plugins/orchestrate/skills/orchestrate/scripts"


class Fixture(unittest.TestCase):
    root_name = "checkout"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name).resolve()
        self.base = base
        self.home = base / "home"
        self.root = base / self.root_name
        for rel in (OLD, "plugins/orchestrate/bin", "plugins/orchestrate/skills/chief"):
            (self.root / rel).mkdir(parents=True)
        (self.root / "package.json").write_text("{}")
        (self.root / "plugins/orchestrate/bin/ork.mjs").write_text("//")
        (self.root / OLD / "peer_mailbox.py").write_text("#")
        (self.home / ".local/bin").mkdir(parents=True)
        (self.home / ".local/bin/ork").symlink_to(self.root / "plugins/orchestrate/bin/ork.mjs")
        (self.home / ".local/bin/unrelated").symlink_to("/usr/bin/env")
        (self.home / ".agents/skills").mkdir(parents=True)
        (self.home / ".agents/skills/orchestrate").symlink_to(self.root / "plugins/orchestrate/skills/orchestrate")
        self.profiles = []
        for name in (".claude", ".claude-work"):
            profile = self.home / name
            (profile / "commands").mkdir(parents=True)
            (profile / "skills").mkdir()
            (profile / "skills/chief").symlink_to(self.root / "plugins/orchestrate/skills/chief")
            self.profiles.append(profile)
            settings = {
                "note": f"user text mentions {self.root}/{OLD}/peer_mailbox.py",
                "env": {"X": f"{self.root}/{OLD}/peer_mailbox.py"},
                "hooks": {
                    "Stop": [
                        {"command": f"python3 {self.root}/{OLD}/peer_mailbox.py --x"},
                        {"command": f"python3 {self.home}/.agents/skills/orchestrate/scripts/peer_mailbox.py"},
                    ]
                },
                "other": "/opt/else/plugins/orchestrate/skills/orchestrate/scripts/a.py",
            }
            (profile / "settings.json").write_text(json.dumps(settings, indent=1) + "\n")
        (self.profiles[0] / "commands/swarm.md").write_text(f"run `{self.root}/{OLD}/peer_mailbox.py`.\nuser text\n")
        (self.profiles[0] / "commands/mine.md").write_text(f"my own: {self.root}/{OLD}/peer_mailbox.py\n")

    def land_new_layout(self):
        (self.root / "src/py").mkdir(parents=True)
        (self.root / "src/py/peer_mailbox.py").write_text("#")
        (self.root / "src/bin").mkdir()
        (self.root / "src/bin/ork.mjs").write_text("//")
        (self.root / "adapters/skills/chief").mkdir(parents=True)
        (self.root / "adapters/skills/orchestrate").mkdir()

    def snapshot(self):
        out = {}
        for p in sorted(self.home.rglob("*")):
            out[str(p)] = str(p.readlink()) if p.is_symlink() else p.read_bytes() if p.is_file() else ""
        return out


class PathMigrationTests(Fixture):
    def test_stage_four_retains_skill_prose_and_maps_runtime_data(self):
        skill = self.root / "plugins/orchestrate/skills/orchestrate"
        (skill / "SKILL.md").write_text("skill")
        rules = pm.build_rules(self.home, [self.root])
        self.assertIsNone(pm._map(rules, str(skill / "references/mailbox.md")))
        for directory in (skill, self.home / ".agents/skills/orchestrate"):
            previous = str(directory / "references/model-registry.json")
            self.assertEqual(pm._map(rules, previous), (previous, str(self.root / "references/model-registry.json")))

    def test_canonical_cli_runs_after_skill_shim_retirement(self):
        import subprocess

        root = SCRIPTS.parents[1]
        skill = root / "adapters/skills/orchestrate"
        self.assertTrue((skill / "SKILL.md").is_file())
        self.assertFalse((skill / "scripts/run_agent.py").exists())
        self.assertFalse((root / "plugins/orchestrate/skills/orchestrate/scripts/run_agent.py").exists())
        result = subprocess.run(
            [sys.executable, "-I", str(SCRIPTS / "run_agent.py"), "--help"], check=True, capture_output=True
        )
        self.assertIn(b"usage:", result.stdout)
        self.assertNotIn(b"moved to", result.stderr)

    def test_statusline_migration_preserves_other_opencode_plugin_links(self):
        plugins = self.home / ".config/opencode/plugins"
        plugins.mkdir(parents=True)
        previous = self.root / "plugins/orchestrate/opencode/agent-statusline"
        canonical = self.root / "adapters/opencode/agent-statusline"
        canonical.mkdir(parents=True)
        owned = plugins / "orkest-agent-statusline"
        custom = plugins / "my-statusline"
        owned.symlink_to(previous)
        custom.symlink_to(previous)
        report = pm.apply(self.home, roots=[self.root])
        self.assertEqual(owned.readlink(), canonical)
        self.assertEqual(custom.readlink(), previous)
        pm.restore(Path(report["backup"]))
        self.assertEqual(owned.readlink(), previous)

    def test_uninspectable_configs_are_reported_and_preserved(self):
        self.land_new_layout()
        binary, oversized = [profile / "settings.json" for profile in self.profiles]
        binary.write_bytes(b"\xff")
        oversized.write_bytes(b" " * (pm.MAX_TEXT_BYTES + 1))
        report = pm.apply(self.home, roots=[self.root])
        blocked = {entry["path"]: entry["reason"] for entry in report["changes"] if entry["status"] == "blocked"}
        self.assertEqual(blocked[str(binary)], "not inspected: invalid UTF-8")
        self.assertIn("size limit", blocked[str(oversized)])
        self.assertEqual(binary.read_bytes(), b"\xff")
        self.assertEqual(oversized.read_bytes(), b" " * (pm.MAX_TEXT_BYTES + 1))

    def test_dry_run_lists_exact_paths_without_side_effects(self):
        before = self.snapshot()
        report = pm.discover(self.home, roots=[self.root])
        self.assertEqual(self.snapshot(), before)
        expected = {
            str(self.home / ".local/bin/ork"),
            str(self.home / ".agents/skills/orchestrate"),
            *(str(p / "skills/chief") for p in self.profiles),
            *(str(p / "settings.json") for p in self.profiles),
            str(self.profiles[0] / "commands/swarm.md"),
        }
        self.assertEqual({c["path"] for c in report["changes"]}, expected)
        self.assertEqual((report["ready"], report["pending"], report["blocked"]), (0, len(expected), 0))
        text = pm.render(report)
        for path in expected:
            self.assertIn(path, text)
        self.assertIn(f"{self.root}/src/py/peer_mailbox.py (missing)", text)

    def test_apply_before_layout_lands_changes_nothing(self):
        before = self.snapshot()
        result = pm.apply(self.home, roots=[self.root])
        self.assertEqual((result["applied"], result["backup"]), (0, None))
        self.assertEqual(self.snapshot(), before)

    def test_apply_rewrites_owned_values_only_backs_up_and_is_idempotent(self):
        self.land_new_layout()
        result = pm.apply(self.home, roots=[self.root])
        self.assertEqual(result["ready"], result["applied"])
        self.assertEqual((self.home / ".local/bin/ork").readlink(), self.root / "src/bin/ork.mjs")
        self.assertEqual((self.profiles[1] / "skills/chief").readlink(), self.root / "adapters/skills/chief")
        settings = json.loads((self.profiles[1] / "settings.json").read_text())
        commands = [h["command"] for h in settings["hooks"]["Stop"]]
        self.assertEqual(commands[0], f"python3 {self.root}/src/py/peer_mailbox.py --x")
        self.assertEqual(commands[1], f"python3 {self.root}/src/py/peer_mailbox.py")
        self.assertIn("plugins/orchestrate", settings["note"])  # user-authored values are untouched
        self.assertIn("plugins/orchestrate", settings["env"]["X"])
        self.assertIn("/opt/else/plugins/orchestrate", settings["other"])
        self.assertEqual(
            (self.profiles[0] / "commands/swarm.md").read_text(),
            f"run `{self.root}/src/py/peer_mailbox.py`.\nuser text\n",
        )
        self.assertIn(OLD, (self.profiles[0] / "commands/mine.md").read_text())
        self.assertEqual((self.home / ".local/bin/unrelated").readlink(), Path("/usr/bin/env"))
        backup = Path(result["backup"])
        self.assertEqual(oct(backup.stat().st_mode & 0o777), "0o700")
        self.assertEqual(json.loads((backup / "manifest.json").read_text())["state"], "applied")
        self.assertIn(OLD, next((backup / "files").glob("*settings.json")).read_text())
        second = pm.apply(self.home, roots=[self.root])
        self.assertEqual((second["total"], second["applied"], second["backup"]), (0, 0, None))

    def test_monitor_modules_and_both_bin_trees_follow_their_shared_runtime_locations(self):
        monitor = {
            "mcpServers": {
                "monitor": {
                    "command": "node",
                    "args": [f"{self.root}/plugins/monitor/bin/monitor.mjs", "mcp"],
                }
            },
            "hooks": {
                "Stop": [
                    {"command": f"node {self.root}/plugins/monitor/lib/policy.mjs"},
                    {"command": f"node {self.root}/plugins/orchestrate/lib/policy.mjs"},
                    {"command": f"node {self.root}/plugins/orchestrate/bin/ork.mjs quota"},
                ]
            },
            "note": f"user text names {self.root}/plugins/monitor/lib/policy.mjs",
        }
        path = self.profiles[0] / "settings.json"
        path.write_text(json.dumps(monitor))
        before = path.read_bytes()
        # Nothing moves until the destination files exist, even for rules whose neighbours already moved.
        self.land_new_layout()
        (self.root / "src/lib").mkdir()
        (self.root / "src/lib/policy.mjs").write_text("//orchestrate")
        pm.apply(self.home, roots=[self.root])
        settings = json.loads(path.read_text())
        self.assertEqual(settings["mcpServers"]["monitor"]["args"][0], f"{self.root}/plugins/monitor/bin/monitor.mjs")
        self.assertEqual(settings["hooks"]["Stop"][0]["command"], f"node {self.root}/plugins/monitor/lib/policy.mjs")
        self.assertEqual(settings["hooks"]["Stop"][1]["command"], f"node {self.root}/src/lib/policy.mjs")
        self.assertEqual(settings["hooks"]["Stop"][2]["command"], f"node {self.root}/src/bin/ork.mjs quota")
        # The monitor files land: the same references now resolve to monitor's own library and bin.
        (self.root / "src/lib/monitor").mkdir()
        (self.root / "src/lib/monitor/policy.mjs").write_text("//monitor")
        (self.root / "src/bin/monitor.mjs").write_text("//")
        result = pm.apply(self.home, roots=[self.root])
        settings = json.loads(path.read_text())
        self.assertEqual(settings["mcpServers"]["monitor"]["args"], [f"{self.root}/src/bin/monitor.mjs", "mcp"])
        self.assertEqual(settings["hooks"]["Stop"][0]["command"], f"node {self.root}/src/lib/monitor/policy.mjs")
        self.assertEqual(settings["hooks"]["Stop"][1]["command"], f"node {self.root}/src/lib/policy.mjs")
        self.assertIn("plugins/monitor/lib/policy.mjs", settings["note"])
        self.assertEqual(pm.restore(Path(result["backup"])), 1)
        self.assertNotEqual(path.read_bytes(), before)  # the first apply's rewrite is separate history
        restored = json.loads(path.read_text())
        self.assertEqual(restored["mcpServers"]["monitor"]["args"][0], f"{self.root}/plugins/monitor/bin/monitor.mjs")
        self.assertEqual(restored["hooks"]["Stop"][0]["command"], f"node {self.root}/plugins/monitor/lib/policy.mjs")
        self.assertEqual(restored["hooks"]["Stop"][1]["command"], f"node {self.root}/src/lib/policy.mjs")

    def test_missing_or_dangling_destinations_are_skipped(self):
        self.land_new_layout()
        (self.root / "src/py/peer_mailbox.py").unlink()
        (self.root / "src/py/peer_mailbox.py").symlink_to(self.root / "nowhere")  # dangling
        result = pm.apply(self.home, roots=[self.root])
        self.assertIn(OLD, (self.profiles[0] / "commands/swarm.md").read_text())
        self.assertEqual(result["ready"], 4)  # ork, hub and two chief links only

    def test_only_complete_references_match(self):
        self.land_new_layout()
        extra = {
            "hooks": {
                "Stop": [
                    {"command": f"x /prefix{self.root}/{OLD}/peer_mailbox.py"},
                    {"command": f"x {self.root}/{OLD}/peer_mailbox.pyc"},
                    {"command": f"x '{self.root}/{OLD}/peer_mailbox.py'"},
                ]
            }
        }
        path = self.profiles[0] / "settings.json"
        path.write_text(json.dumps(extra))
        pm.apply(self.home, roots=[self.root])
        commands = [h["command"] for h in json.loads(path.read_text())["hooks"]["Stop"]]
        self.assertEqual(commands[0], extra["hooks"]["Stop"][0]["command"])
        self.assertEqual(commands[1], extra["hooks"]["Stop"][1]["command"])
        self.assertEqual(commands[2], f"x '{self.root}/src/py/peer_mailbox.py'")

    def test_temp_symlink_never_unlinks_a_user_file(self):
        self.land_new_layout()
        link = self.home / ".local/bin/ork"
        with mock.patch.object(pm.secrets, "token_hex", return_value="aaaa"):
            (link.parent / ".ork.orkest-aaaa").write_text("user data")
            with self.assertRaises(pm.MigrationError):
                pm._set_symlink(link, str(self.root / "src/bin/ork.mjs"), os.readlink(link))
        self.assertEqual((link.parent / ".ork.orkest-aaaa").read_text(), "user data")
        self.assertEqual(link.readlink(), self.root / "plugins/orchestrate/bin/ork.mjs")

    def test_symlink_changed_by_user_midway_is_not_overwritten(self):
        self.land_new_layout()
        link = self.home / ".local/bin/ork"
        with self.assertRaises(pm.MigrationError):
            pm._set_symlink(link, str(self.root / "src/bin/ork.mjs"), "/some/other/target")
        self.assertEqual(link.readlink(), self.root / "plugins/orchestrate/bin/ork.mjs")
        self.assertEqual([p.name for p in link.parent.iterdir() if "orkest-" in p.name], [])

    def test_hard_linked_and_outside_home_files_are_blocked(self):
        self.land_new_layout()
        settings = self.profiles[1] / "settings.json"
        os.link(settings, self.base / "hardlink-copy")
        outside = self.base / "dotfiles"
        outside.mkdir()
        target = outside / "settings.json"
        target.write_text(self.profiles[0].joinpath("settings.json").read_text())
        self.profiles[0].joinpath("settings.json").unlink()
        self.profiles[0].joinpath("settings.json").symlink_to(target)
        before = (settings.read_bytes(), target.read_bytes())
        report = pm.discover(self.home, roots=[self.root])
        blocked = {c["path"]: c["reason"] for c in report["changes"] if c["status"] == "blocked"}
        self.assertEqual(blocked[str(settings)], "hard-linked file")
        self.assertEqual(blocked[str(self.profiles[0] / "settings.json")], "resolves outside home")
        pm.apply(self.home, roots=[self.root])
        self.assertEqual((settings.read_bytes(), target.read_bytes()), before)

    def test_environment_overrides_outside_home_are_ignored(self):
        outside = self.base / "elsewhere"
        outside.mkdir()
        with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(outside), "CODEX_HOME": str(outside)}):
            self.assertNotIn(outside, pm.claude_profiles(self.home))
            self.assertNotIn(outside / "hooks.json", [p for p, _ in pm.text_files(self.home, [self.root])])

    def test_restore_returns_original_state(self):
        self.land_new_layout()
        landed = self.snapshot()
        result = pm.apply(self.home, roots=[self.root])
        self.assertNotEqual(self.snapshot(), landed)
        self.assertEqual(pm.restore(Path(result["backup"])), result["applied"])
        after = {k: v for k, v in self.snapshot().items() if "/.local/share" not in k}
        self.assertEqual(after, {k: v for k, v in landed.items() if k in after})
        self.assertEqual(pm.restore(Path(result["backup"])), 0)  # idempotent

    def test_restore_refuses_when_user_edited_afterwards(self):
        self.land_new_layout()
        result = pm.apply(self.home, roots=[self.root])
        settings = self.profiles[0] / "settings.json"
        settings.write_text(settings.read_text() + "\n")
        link = self.home / ".local/bin/ork"
        snapshot = self.snapshot()
        with self.assertRaises(pm.MigrationError):
            pm.restore(Path(result["backup"]))
        self.assertEqual(self.snapshot(), snapshot)  # all-or-nothing: the unedited link stayed migrated
        self.assertEqual(link.readlink(), self.root / "src/bin/ork.mjs")

    def test_partial_failure_rolls_back_and_manifest_records_it(self):
        self.land_new_layout()
        before = self.snapshot()
        real = pm._atomic_write
        calls = []

        def flaky(path, data, expect):
            calls.append(path)
            if len(calls) == 2:
                raise OSError("disk full")
            return real(path, data, expect)

        with mock.patch.object(pm, "_atomic_write", side_effect=flaky), self.assertRaises(OSError):
            pm.apply(self.home, roots=[self.root])
        after = {k: v for k, v in self.snapshot().items() if "/.local/share" not in k}
        self.assertEqual(after, {k: v for k, v in before.items() if k in after})
        manifest = json.loads(
            next((self.home / ".local/share/orchestrate/backups").glob("*/manifest.json")).read_text()
        )
        self.assertEqual(manifest["state"], "rolled-back")

    def test_backup_digest_mismatch_aborts_before_any_change(self):
        self.land_new_layout()
        before = self.snapshot()

        def corrupt(src, dst):
            Path(dst).write_text("corrupt")

        with mock.patch.object(pm.shutil, "copyfile", side_effect=corrupt), self.assertRaises(pm.MigrationError):
            pm.apply(self.home, roots=[self.root])
        after = {k: v for k, v in self.snapshot().items() if "/.local/share" not in k}
        self.assertEqual(after, {k: v for k, v in before.items() if k in after})

    def test_cli_report_is_read_only_and_install_dry_run_lists_paths(self):
        before = self.snapshot()
        with redirect_stdout(io.StringIO()) as out:
            self.assertEqual(pm.main(["--home", str(self.home), "--root", str(self.root), "--json"]), 0)
        self.assertEqual(json.loads(out.getvalue())["schema"], pm.SCHEMA)
        with redirect_stdout(io.StringIO()) as out, mock.patch.object(pm, "find_root", return_value=self.root):
            installer.migrate_legacy_paths(self.home, dry_run=True)
        self.assertIn(str(self.profiles[1] / "settings.json"), out.getvalue())
        self.assertIn("(missing)", out.getvalue())
        self.assertEqual(pm.summary(self.home)["ready"], 0)
        self.assertEqual(self.snapshot(), before)


class SpacedRootTests(Fixture):
    root_name = "my checkout"

    def test_roots_with_spaces_migrate_when_quoted(self):
        self.land_new_layout()
        path = self.profiles[0] / "settings.json"
        path.write_text(json.dumps({"hooks": {"Stop": [{"command": f"python3 '{self.root}/{OLD}/peer_mailbox.py'"}]}}))
        pm.apply(self.home, roots=[self.root])
        command = json.loads(path.read_text())["hooks"]["Stop"][0]["command"]
        self.assertEqual(command, f"python3 '{self.root}/src/py/peer_mailbox.py'")


if __name__ == "__main__":
    unittest.main()
