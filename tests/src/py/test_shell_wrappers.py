"""The shell wrappers keep what the user already had: aliases, edited legacy blocks (issue 233 stage 1)."""

from __future__ import annotations

import os
import pty
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[3] / "src/py"
sys.path.insert(0, str(SCRIPTS))

import install_mailbox as installer  # noqa: E402

ZSH = shutil.which("zsh")
STUB = '#!/bin/sh\nprintf "%s FOO=%s ARGV:" "$(basename "$0")" "${FOO:-}" >> "$STUB_LOG"\nprintf " [%s]" "$@" >> "$STUB_LOG"\nprintf "\\n" >> "$STUB_LOG"\n'


class WrapperBehaviourTests(unittest.TestCase):
    """Source the generated orkest.sh in a real zsh with stub harnesses, as a fresh shell would."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("claude", "codex", "agy", "ork", "mine", "opencode"):
            stub = self.bin / name
            stub.write_text(STUB)
            stub.chmod(0o755)
        self.log = self.root / "stub.log"
        self.script = self.root / "orkest.sh"
        self.script.write_text(installer.shell_wrapper_script(home=self.root, monitor_config={}), encoding="utf-8")

    def run_zsh(self, body: str, *, interactive: bool = False) -> list[str]:
        self.log.write_text("")
        env = {
            "HOME": str(self.root),
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "STUB_LOG": str(self.log),
            "TERM": "dumb",
        }
        command = [ZSH, "-f", "-c", body]
        if interactive:
            master, slave = pty.openpty()
            try:
                subprocess.run(command, env=env, stdin=slave, stdout=slave, stderr=slave, check=False, timeout=30)
            finally:
                os.close(master)
                os.close(slave)
        else:
            subprocess.run(command, env=env, capture_output=True, check=False, timeout=30, text=True)
        return self.log.read_text().splitlines()

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_two_setups_keep_effective_argv_in_a_fresh_shell_with_edited_legacy_rc(self) -> None:
        rc = self.root / ".zshrc"
        rc.write_text(
            "alias codex='codex --model sample'\n"
            "# Interactive harnesses get an Orkest footer; automation and management commands stay direct.\n"
            "alias claude='claude --permission-mode plan'\n"
            "unalias codex claude agy 2>/dev/null\n"
            "alias oopencode='ork label -- opencode'\n"
        )
        args = self.root / "commands.zsh"
        args.write_text("claude hello\ncodex exec go\n")
        with mock.patch("builtins.print"):
            for _ in range(2):
                installer.install_shell_wrappers(self.root, ork_cli=self.root / "none.mjs")
                self.assertEqual(
                    self.run_zsh(f". {rc}; . {args}", interactive=True),
                    [
                        "ork FOO= ARGV: [label] [--] [claude] [--permission-mode] [plan] [hello]",
                        "codex FOO= ARGV: [--model] [sample] [exec] [go]",
                    ],
                )

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_an_earlier_alias_keeps_its_flags_on_a_direct_launch(self) -> None:
        lines = self.run_zsh(
            f"alias claude='claude --my-flag'; alias codex='codex -c x=1'; . {self.script}; "
            "claude hello; claude --version; codex exec go"
        )
        self.assertEqual(
            lines,
            [
                "claude FOO= ARGV: [--my-flag] [hello]",
                "claude FOO= ARGV: [--my-flag] [--version]",
                "codex FOO= ARGV: [-c] [x=1] [exec] [go]",
            ],
        )

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_an_earlier_alias_keeps_its_flags_on_an_interactive_launch(self) -> None:
        lines = self.run_zsh(
            f"alias claude='claude --my-flag'; alias agy='agy --user-flag'; . {self.script}; claude hello; agy go",
            interactive=True,
        )
        self.assertEqual(
            lines,
            [
                "ork FOO= ARGV: [label] [--] [claude] [--my-flag] [--permission-mode] [auto] [hello]",
                "ork FOO= ARGV: [label] [--] [agy] [--user-flag] [--dangerously-skip-permissions] [go]",
            ],
        )

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_agy_without_an_alias_is_unchanged(self) -> None:
        lines = self.run_zsh(f". {self.script}; agy go; claude hi", interactive=False)
        self.assertEqual(
            lines,
            [
                "agy FOO= ARGV: [--dangerously-skip-permissions] [go]",
                "claude FOO= ARGV: [hi]",
            ],
        )

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_an_alias_pointing_at_another_command_and_an_env_prefix_are_kept(self) -> None:
        lines = self.run_zsh(
            f"alias claude='mine --as-claude'; alias codex='FOO=7 codex'; . {self.script}; claude hi; codex go"
        )
        self.assertEqual(
            lines,
            ["mine FOO= ARGV: [--as-claude] [hi]", "codex FOO=7 ARGV: [go]"],
        )

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_sourcing_twice_and_a_later_alias_keep_the_first_alias(self) -> None:
        lines = self.run_zsh(f"alias claude='claude --my-flag'; . {self.script}; . {self.script}; claude hello")
        self.assertEqual(lines, ["claude FOO= ARGV: [--my-flag] [hello]"])

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_compound_alias_keeps_native_zsh_behavior_after_resourcing(self) -> None:
        launch = self.root / "launch.zsh"
        launch.write_text("claude hello\n")
        lines = self.run_zsh(
            f"""alias claude='mine "two words" && claude --x'
. {self.script}
. {self.script}
. {launch}
"""
        )
        self.assertEqual(lines, ["mine FOO= ARGV: [two words]", "claude FOO= ARGV: [--x] [hello]"])

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_plain_looking_alias_can_invoke_a_shell_function(self) -> None:
        launch = self.root / "launch.zsh"
        launch.write_text("claude hello\n")
        lines = self.run_zsh(
            f"""local_runner() {{ command mine --from-function "$@"; }}
alias claude='local_runner --user'
. {self.script}
. {self.script}
. {launch}
"""
        )
        self.assertEqual(lines, ["mine FOO= ARGV: [--from-function] [--user] [hello]"])

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_stock_footer_shortcuts_forward_harness_flags_after_resourcing(self) -> None:
        launch = self.root / "launch.zsh"
        launch.write_text("ocodex a\noclaude b\noagy c\noopencode d\n")
        self.assertEqual(
            self.run_zsh(
                f"""alias codex='codex --model custom'
alias claude='claude --permission-mode plan'
alias opencode='opencode --profile personal'
alias oclaude='ork label -- claude'
. {self.script}
. {self.script}
. {launch}
"""
            ),
            [
                "ork FOO= ARGV: [label] [--] [codex] [--model] [custom] [a]",
                "ork FOO= ARGV: [label] [--] [claude] [--permission-mode] [plan] [b]",
                "ork FOO= ARGV: [label] [--] [agy] [--dangerously-skip-permissions] [c]",
                "ork FOO= ARGV: [label] [--] [opencode] [--profile] [personal] [d]",
            ],
        )

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_personal_footer_aliases_and_functions_survive_legacy_upgrade(self) -> None:
        rc = self.root / ".zshrc"
        rc.write_text(
            "alias ocodex='mine --custom'\n"
            'oclaude() { command mine --plan "$@"; }\n'
            "# Interactive harnesses get an Orkest footer; automation and management commands stay direct.\n"
            "alias oagy='mine --agy'\n"
            "alias oopencode='mine --open'\n"
            + "".join(f"alias {name}='{body}'\n" for name, body in installer.LEGACY_FOOTERS.items())
        )
        launch = self.root / "launch.zsh"
        launch.write_text("ocodex a\noclaude b\noagy c\noopencode d\n")
        with mock.patch("builtins.print"):
            for _ in range(2):
                installer.install_shell_wrappers(self.root, ork_cli=self.root / "none.mjs")
                self.assertEqual(
                    self.run_zsh(f". {rc}; . {self.script}; . {launch}"),
                    [
                        "mine FOO= ARGV: [--custom] [a]",
                        "mine FOO= ARGV: [--plan] [b]",
                        "mine FOO= ARGV: [--agy] [c]",
                        "mine FOO= ARGV: [--open] [d]",
                    ],
                )

    @unittest.skipUnless(ZSH, "zsh is needed to run the wrappers")
    def test_custom_account_aliases_keep_their_own_flags(self) -> None:
        accounts = [
            {"provider": provider, "alias": alias}
            for provider, alias in (("claude", "cw"), ("codex", "cx"), ("antigravity", "aw"))
        ]
        self.script.write_text(installer.shell_wrapper_script(home=self.root, monitor_config={"accounts": accounts}))
        for alias in ("cw", "cx", "aw"):
            (self.bin / alias).write_text(STUB)
            (self.bin / alias).chmod(0o755)
        lines = self.run_zsh(
            f"alias cw='cw --permission-mode plan'; alias cx='cx --work'; alias aw='aw --work'; "
            f". {self.script}; cw hello; cx hello; aw hello",
            interactive=True,
        )
        self.assertEqual(
            lines,
            [
                "ork FOO= ARGV: [label] [--] [cw] [--permission-mode] [plan] [hello]",
                "ork FOO= ARGV: [label] [--] [cx] [--work] [hello]",
                "ork FOO= ARGV: [label] [--] [aw] [--work] [--dangerously-skip-permissions] [hello]",
            ],
        )


class LegacyBlockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.zshrc = self.home / ".zshrc"
        script = installer.shell_wrapper_script(home=self.home, monitor_config={})
        marker = "# Interactive harnesses get an Orkest footer"
        self.generated = script[script.index(marker) : script.index("# Preserve personal shortcuts")] + "".join(
            f"alias {name}='{body}'\n" for name, body in installer.LEGACY_FOOTERS.items()
        )

    def install(self) -> str:
        with mock.patch("builtins.print") as printed:
            installer.install_shell_wrappers(self.home, ork_cli=self.home / "none.mjs")
        return "\n".join(str(call.args[0]) for call in printed.call_args_list if call.args)

    def test_a_user_edit_inside_the_managed_rc_block_survives_refresh(self) -> None:
        self.install()
        text = self.zshrc.read_text().replace(
            installer.MANAGED_ZSHRC_START, installer.MANAGED_ZSHRC_START + "\nalias codex='codex --model custom'"
        )
        self.zshrc.write_text(text)
        self.install()
        self.assertEqual(text, self.zshrc.read_text())

    def test_an_untouched_legacy_block_is_replaced_as_before(self) -> None:
        self.zshrc.write_text(f"export A=1\n{self.generated}export B=2\n", encoding="utf-8")
        self.install()
        text = self.zshrc.read_text()
        self.assertIn("export A=1\n", text)
        self.assertIn("export B=2\n", text)
        self.assertEqual(text.count(installer.MANAGED_ZSHRC_START), 1)
        self.assertNotIn("_orkest_interactive()", text)

    def test_user_lines_inside_an_edited_legacy_block_survive_two_setup_passes(self) -> None:
        lines = self.generated.splitlines(keepends=True)
        edited = (
            lines[0]
            + "alias claude='claude --my-flag --model opus'\n"
            + "mine() { echo 'user function'; }\n"
            + "".join(lines[1:])
        )
        original = f"export A=1\n{edited}export B=2\n"
        self.zshrc.write_text(original, encoding="utf-8")
        first = self.install()
        text = self.zshrc.read_text()
        self.assertTrue(text.startswith("export A=1\n"))
        self.assertIn("export B=2\n", text)
        self.assertIn("alias claude='claude --my-flag --model opus'\n", text)
        self.assertIn("mine() { echo 'user function'; }\n", text)
        self.assertEqual(text.count(installer.MANAGED_ZSHRC_START), 1)
        self.assertIn("preserved user lines", first)
        self.install()
        self.assertEqual(self.zshrc.read_text(), text, "a second pass changes nothing")


if __name__ == "__main__":
    unittest.main()
