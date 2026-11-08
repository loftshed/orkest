# Orkest

Run Claude Code, Codex, Antigravity, and OpenCode together on one codebase without losing track of
who's doing what, burning the wrong account's quota, or stepping on each other's files.

You work in your normal harness CLI. Orkest sits beside it: a live swarm tree for native subagents
and cross-harness workers, isolated git worktrees for side tasks and background jobs, per-repo
account guardrails, live subscription quota tracking, and a shared test gate so parallel agents
don't thrash your machine.

```text
 ┌ Swarm · Fix stale cache invalidation                    2 active · 1✓ · 3/12 slots ┐
 │Orchestrator: atlas · folder: payments-api (feat/cache-ttl) · claude                │
 │⠼ claude-opus-4-6 / high | working · step 2/4 · live                                │
 │Coordinate cache invalidation fix and review worker patches                         │
 └────────────────────────────────────────────────────────────────────────────────────┘
 Quota [u]  CW 84%·62%  ·  CX 71%  ·  AG Gemini 91%
 │ payments-api · 3 agents · ~/src/payments-api
 │ ┌ 1 birch (lead)                                                 FOCUS wt:ttl-race ┐
 ├─│Patch TTL race in Redis store and add regression test                             │
 │ │⠼ [builder] gpt-6-astra / high | working · step 2/4 · live                        │
 │ └──────────────────────────────────────────────────────────────────────────────────┘
 │  │ ┌ 2 cedar                                                 payments-api ↳ birch  ┐
 │  └─│Cold-review eviction ordering diff against main                                │
 │    │⠼ [reviewer] gemini-3.1-pro / high | review · step 4/4 · live                  │
 │    └───────────────────────────────────────────────────────────────────────────────┘
 └─ ✓ 3 maple [scout] · payments-api · Trace stale read path across worker replicas
 Services [v]  2 running · :5173 vite (payments-api) · :5432 docker postgres:16
```

## Quick start

From any repository:

```sh
ork claude     # or: ork codex, ork agy, ork opencode
```

That opens your harness with room tracking attached, using a tmux footer outside Herdr. Inside any session,
toggle the live Swarm View split pane with `/swarm` (or `ork swarm`).

You can also kick off a swarm with an initial objective or team preset:

```sh
ork horde "Find out why the cache goes stale and prepare a tested fix"
ork horde --preset bug-court "Race condition in session refresh"
```

## Everyday workflows

### Live Swarm View (`/swarm`)

Run `/swarm` inside a session (or `ork horde --attach-room <id> --view` from another terminal) to
open the live tree beside your conversation:

- Watch native subagents (`Agent`, `invoke_subagent`) and delegated cross-harness workers update in
  real time, grouped by folder and disposable worktree (`wt:<slug>`).
- Press `1`–`9` or `↑`/`↓` to select an agent, `o` to jump straight to its Herdr or tmux pane, `c`
  to collapse or hide finished agents, and `g` for the room log.
- Press `u` to expand live quota windows across accounts, `v` to inspect running dev servers,
  ports, and Docker containers tied to the workspace, and `U` to pull Orkest updates when notified.

### Side missions from the same tab (`/side` / `ork side`)

When you notice an unrelated bug or have a tangential question mid-session, fire it off without
derailing your main agent's context window or dirtying the active checkout:

```sh
# Spin up an isolated worktree (.worktrees/wt-side-*) and a background worker
/side "fix the off-by-one error in pagination"

# Run a read-only background scout (triggered by --investigate, ask:, or a trailing ?)
/side "why does token refresh retry twice?"

# Park a note on the project workboard for later (0 tokens, 0 background processes)
/side --later "flatten the retry helper after this PR lands"

# File a GitHub issue labeled for the background factory
/side --issue "support dark mode in the status modal"
```

Every `/side` run executes outside your current conversation and tracks its status in the Swarm
View and `ork next` without interrupting your active turn.

### Second opinions & autonomous worktrees (`consult`, `foundry`, `smelter`, `ork next`)

Keep same-vendor subagents on their native tools, and use Orkest when you want a different frontier
model or an isolated worktree pipeline:

- **`consult` — read-only second opinions:** Ask another model to review a branch or investigate a
  bug in its engine's no-write sandbox without handing over file ownership.

  ```sh
  python3 ~/.agents/skills/orchestrate/scripts/run_agent.py consult --intent review \
    --read . --diff origin/main \
    --question "Any race conditions or missed edge cases?" --model gpt:sol
  ```

- **`ork foundry` — spare-quota issue factory:** Picks up ready GitHub issues (`Depends on #N`
  aware) when [`monitor`](plugins/monitor/README.md) shows surplus subscription quota that would
  otherwise expire at rollover, provisions disposable `.worktrees/` checkouts, and dispatches
  bounded workers.
- **`ork smelter` — verification & cold-review merge queue:** Rebases finished worktrees, audits
  changed file scope and blast radius, runs the heavy test gate, gets a cross-vendor cold review,
  and fast-forwards or opens a PR.
- **`ork next` — closed-loop reconciler:** Steps or loops through housekeeping, smelter merges,
  bounded self-repair on failed checks, and fresh foundry dispatches, stopping with exit code `4`
  only when a high-blast-radius change or conflict needs your sign-off.

  ```sh
  ork next status
  ork next step
  ork smelter run --strategy local
  ```

### Per-repo harness guardrails (`ork policy`)

Keep work accounts off personal repos and unapproved models off work repos. Policy rules live in
your local config (or `.orkest/policy.json`) and block disallowed dispatches before a CLI is ever
spawned:

```sh
ork policy deny claude-work      # e.g. on a personal repo, never bill the work profile
ork policy deny opencode         # e.g. on a work repo, block open-weight OpenRouter routes
ork policy show
```

### Quota monitoring (`monitor`) & shared test gates (`ork gate`)

- **`monitor` (`ork quota`):** Reads remaining 5-hour and weekly quota windows, reset times, and
  credit balances from your installed CLIs (`claude`, `codex`, `agy`) with zero token cost. Includes
  a terminal view (`monitor`, `monitor watch`), a macOS menu bar app, a KDE Plasma widget, and an
  MCP server (`get_usage`, `recommend`) so coordinators route work to the account with the most
  headroom.
- **`ork gate`:** Serializes test suites, builds, and typechecks across concurrent agents on the
  same machine. Focused runs share two lightweight slots; `--heavy` waits for an exclusive lock,
  caps Jest/Vitest workers at 2, runs at `nice 10`, and saves full failure logs so no agent reruns
  a whole suite just to read output that scrolled away.

  ```sh
  ork gate -- ./node_modules/.bin/vitest run tests/cache-test.js
  ork gate --heavy -- pnpm test
  ```

### Auto-updates & cleanup (`ork update`, `/cleanup`)

Orkest runs directly from your local git checkout—no build step or npm publish required:

```sh
ork update                       # fast-forward clean main, refresh hooks, migrate legacy paths
ork cleanup status               # preview stale worktrees, locks, backups, and old runtimes
ork cleanup run --migrate-legacy # prune expired artifacts and atomically migrate legacy dirs
```

You can also run `/update` or `/cleanup` directly from your chat prompt, or press `U` in the Swarm
View when an update notification appears.

## Plugins

The repository ships two plugins. Their READMEs cover full CLI flags, routing tables, and setup:

| Plugin                                         | Version | What it does                                                       |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------ |
| [`orchestrate`](plugins/orchestrate/README.md) | 0.75.0  | Coordinator conversations, swarms, delegation and shared work.     |
| [`monitor`](plugins/monitor/README.md)         | 0.18.0  | Account quota, reset times, credit balances and spending guidance. |

## Install

Requires Git, Node.js 26.13+ (Active LTS), Python 3.11+, `tmux`, and at least one installed, authenticated
harness CLI (`claude`, `codex`, `agy`, or `opencode`).

```sh
mkdir -p ~/src
git clone https://github.com/loftshed/orkest.git ~/src/orkest
cd ~/src/orkest

# Install orchestrate skills, peer-mailbox MCP server, hooks, and the ork CLI
./plugins/orchestrate/install.sh
mkdir -p ~/.local/bin
ln -sf "$PWD/plugins/orchestrate/bin/ork.mjs" ~/.local/bin/ork

# Install monitor CLI, MCP server, and macOS menu bar app (pass --no-app for CLI only)
./plugins/monitor/install.sh
monitor mcp-install
```

Make sure `~/.local/bin` is on your `PATH`. Run `ork setup --trust-codex-hooks` (or approve `/hooks`
once in Codex) to enable turn hooks. Inside Herdr, Codex uses its terminal session title to bind
shared app-server hooks to the correct pane. Herdr draws persistent agent names for every harness;
`ork setup` offers optional border labels and an `ork herdr-status` tab bar entry. See
[Herdr agent labels](docs/herdr.md#agent-labels-and-focused-status) and
[terminal footer setup](plugins/orchestrate/README.md#agent-status-in-terminal-footers) if you want
the status bar outside `ork` launches.

For automatic swarm-view restoration after a Herdr restart, see [Herdr setup and upgrades](docs/herdr.md).

To verify your setup at any time:

```sh
python3 ~/.agents/skills/orchestrate/scripts/run_agent.py doctor --check-messaging
```

## Development

Use a current Corepack release with pnpm 12 support. If Corepack reports a missing
`pnpm.cjs`, update Corepack on a supported Node.js version. CI pins Corepack 0.36.0.

```sh
corepack pnpm install
ork gate --heavy -- ./scripts/check.sh
ork gate --heavy -- ./scripts/test.sh
node scripts/release.js plan
```

Run focused tests while editing (`./node_modules/.bin/vitest run <test-file>` or
`python3 -m unittest <test-file>`), and use `ork gate --heavy` once at the end. See
[CLAUDE.md](CLAUDE.md) for repository conventions and [docs/releases.md](docs/releases.md) for
conventional-commit release automation.
