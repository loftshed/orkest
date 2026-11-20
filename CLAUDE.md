# CLAUDE.md

Guidance for Claude Code in this repository.

## The repository

`loftshed/orkest` is one product: the `ork` CLI, the mailbox daemon and coordinator, the Swarm View TUI, quota monitoring, a Rust fast path, and thin adapters for each harness. It is **not** a Claude Code plugin: there is no plugin manifest or plugin cache. `install.sh` links the skills, writes the commands and registers monitor's MCP server for every harness, and everything calls `ork` on `PATH`. `plugins/orchestrate` and `plugins/monitor` are source directories of that one product, released under one version.

## Commands

```sh
corepack pnpm install   # dev tools, plus the git hooks
corepack pnpm check     # the lint gate (scripts/check.sh); CI runs the same script
corepack pnpm test      # Vitest for JavaScript, unittest for the orchestrate Python (scripts/test.sh)
corepack pnpm readme    # regenerate the README's command lists and screenshots (scripts/readme.js)
node scripts/release.js plan   # what the next release would publish
```

Both scripts call `./node_modules/.bin` directly, so they work without pnpm on PATH. Single steps: `corepack pnpm validate` (skills, commands and path references), `lint`, `lint:fix`, `format`, `format:check`, `markdownlint`, `spell`.

## Workflow

- **Issue-board driven delivery:** Track work as detailed, self-contained issues on the board (`gh issue` / the shared Orkest workboard) rather than accumulating unrelated changes into a single large branch.
- **Lead delegation & small PRs:** Assign a lead Orkest agent to monitor the board, delegate bounded issues to workers in isolated worktrees, and merge focused pull requests.
- **Batch by risk:** small related fixes may share one branch and one CI run, as one conventional commit per issue, merged with **rebase** (`gh pr merge --rebase`) so each subject becomes its own changelog line. A feature, or anything touching leases, policy or the verification path, gets its own pull request, merged with squash. Details: [docs/releases.md](docs/releases.md#merging).
- **Project skills:** [`.agents/skills/herdr`](.agents/skills/herdr/SKILL.md) (linked into [`.claude/skills/herdr`](.claude/skills/herdr) and enabled via `skillOverrides` in [`.claude/settings.json`](.claude/settings.json)) is automatically available across Claude Code, Codex, Antigravity, and OpenCode when working in this repository or inside a Herdr session (`HERDR_ENV=1`).

## Rules for changes

- **Never edit the version.** It lives in the root `package.json`. Write conventional commit subjects (`feat(monitor): …`, `fix: …`, `refactor!: …`); CI releases on `main` and writes the version (and its copies), the root `CHANGELOG.md` heading and the `vX.Y.Z` tag. Notes under `## Unreleased` in the root `CHANGELOG.md` replace the generated ones. Details: [docs/releases.md](docs/releases.md).
- **Tests go in `tests/`**, at the same relative path as the code they cover, never inside `plugins/`, so a source directory holds only what runs. JavaScript tests are `*-test.js` files run by Vitest. Files under `tests/**/fixtures/` are captured output; keep them byte-for-byte.
- **Runtime code is ESM `.mjs`.** Prefer Node built-ins: `ork update` is a plain git fast-forward and hooks run on every turn, so a dependency would need `install.sh` and `ork update` to install it. Repository tooling in `scripts/` is `.js`. When a script checks whether it is the entry point, compare real paths, since plugins are often started through symlinks.
- **Let the gate decide style.** ESLint, Prettier, markdownlint, cspell, ruff and shellcheck run on commit and in CI. Fix what a rule reports instead of disabling it; an unavoidable inline disable carries a `-- reason`. New words go in [`project-words.txt`](project-words.txt).
- **Harness-facing text calls `ork` (or `monitor`) on `PATH`**, never `${CLAUDE_PLUGIN_ROOT}`, which the validator rejects. `${CLAUDE_SKILL_DIR}` is a skill feature and stays, quoted wherever a shell expands it; the validator fails when it, or a file a command names, points at a missing file.
- **Regenerate the README, don't hand-edit its generated parts.** The `<!-- generated:… -->` blocks and `docs/images/` come from the code; after changing an `ork` command, a slash command or the terminal UI, run `corepack pnpm readme` and commit the result. The gate fails while they are stale. Details: [docs/readme.md](docs/readme.md).
- **Keep documentation short.** Say what the reader needs to do or know, once. Put gotchas under a Troubleshooting heading.
- **Follow the TUI design system.** Terminal UI changes in `src/lib/tui-*.mjs` and `horde-view.mjs` follow [docs/terminal-ui.md](docs/terminal-ui.md) and can be visually compared with [docs/tui-visual-testing.md](docs/tui-visual-testing.md).

## Hooks

- `.husky/pre-commit` runs the lint gate. `.husky/pre-push` hands off to the pre-push hook in the global `core.hooksPath`, which husky would otherwise bypass.
- [`.claude/hooks/lint-changed.mjs`](.claude/hooks/lint-changed.mjs) collects each session's Write/Edit targets and fixes and formats them together when Claude stops. It leaves unrelated dirty files and Git staging alone, and sends remaining problems back with bounded retries. Shell edits and interrupted turns still need the normal lint gate.

## Tooling notes

- pnpm avoids resolving package versions published in the last 24 hours.
- The ruff version is pinned once, in `scripts/check.sh`.
