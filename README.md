# Orkest

Orkest is a local toolkit for working with AI coding agents. It tracks the quota available on your
accounts, helps route work to the right harness, and gives agents a way to coordinate across
sessions.

It works with Claude Code, Codex, Antigravity and OpenCode. Each harness still runs its own models
and keeps its own account settings; Orkest connects the pieces on your machine.

| Plugin                                         | Version | What it does                                                                          |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| [`monitor`](plugins/monitor/README.md)         | 0.15.0  | Shows account quota and reset times in a terminal, MCP server and desktop interfaces. |
| [`orchestrate`](plugins/orchestrate/README.md) | 0.40.0  | Routes bounded work, connects agents through a mailbox and coordinates teams.         |

## What you can do

- **See available capacity.** Monitor reads usage from your provider CLIs and displays quota,
  rollover times, credit balances and suggested places to spend the remaining allowance. It has a
  terminal view, MCP tools, a macOS menu bar app and an optional KDE Plasma widget.
- **Ask or delegate across harnesses.** Orchestrate can request a read-only second opinion or run a
  bounded implementation task with an allowed file scope and checks. It uses each hosted model's
  own CLI and keeps account and billing choices explicit.
- **Coordinate active agents.** The project-scoped peer mailbox supports direct messages, channels,
  shared work and recovery notes. Rooms and the Stooges terminal view show a team and its progress.
- **Identify a terminal session.** An optional [agent status line](plugins/orchestrate/README.md#agent-status-in-terminal-footers)
  shows its name, model, effort and recorded work alongside its team's goal.
- **Keep expensive checks from competing.** `ork gate` coordinates test, lint and build runs on the
  same machine, with a shared ledger and saved logs for heavy or failed runs.

Monitor's cached snapshot is also used by Orchestrate when it checks quota and suggests a deputy.
Quota rankings are advice; they do not authorize switching accounts or spending credits.

## Install

You need Git, Node.js 22.18 or later, Python 3.11 or later, and an installed, authenticated CLI for
each provider you want to use. The menu bar app requires macOS; the terminal tools also work on
other supported platforms.

Clone the repository outside macOS's protected Documents, Desktop and Downloads folders to avoid
repeated permission prompts:

```sh
mkdir -p ~/src
git clone https://github.com/loftshed/orkest.git ~/src/orkest
cd ~/src/orkest

# Install the quota monitor and register its MCP tools.
./plugins/monitor/install.sh
~/.local/bin/monitor mcp-install

# Link Orchestrate into the installed harnesses and set up the peer mailbox.
./plugins/orchestrate/install.sh
```

Add `~/.local/bin` to your `PATH` if it is not already there.

The Orchestrate installer has a `--dry-run` option. Codex asks you to trust its command hooks once;
review them with `/hooks`. See the [Orchestrate installation guide](plugins/orchestrate/README.md#install)
for details and the [Monitor guide](plugins/monitor/README.md#install) for profile and desktop setup.

### Install the Monitor skill as a plugin

For Claude Code and Codex, add this checkout as a marketplace and install Monitor's skill:

```sh
claude plugin marketplace add ~/src/orkest
claude plugin install monitor@orkest --scope user

codex plugin marketplace add ~/src/orkest
codex plugin add monitor@orkest
```

Orchestrate's installer already links its skill. If you install `orchestrate@orkest` as a Claude
Code plugin instead, run its installer with `--no-claude` to avoid a duplicate skill.

## Get started

```sh
# View quota, watch it, or get a machine-readable snapshot.
monitor
monitor watch
monitor json

# Check routes and verify the mailbox without invoking a model.
python3 ~/.agents/skills/orchestrate/scripts/run_agent.py routes
python3 ~/.agents/skills/orchestrate/scripts/run_agent.py doctor --check-messaging

# Explore rooms and the shared test/build gate from the checkout.
node plugins/orchestrate/bin/ork.mjs rooms --help
node plugins/orchestrate/bin/ork.mjs gate status
```

Monitor discovers available accounts by default. Run `monitor init --dry-run` to preview its
configuration, or `monitor init` to create `~/.config/monitor/config.json`. Orchestrate's routes
are configured in `~/.config/agent-executor/config.json`; see the
[Orchestrate guide](plugins/orchestrate/README.md) for consultation, delegation and mailbox examples.

## Development

```sh
yarn install                  # development tools and Git hooks
yarn check                    # repository lint and validation gate
yarn test                     # JavaScript and Python tests
node scripts/release.js plan  # preview the next automated plugin release
```

Tests live under `tests/`, mirroring the code they cover. See [CLAUDE.md](CLAUDE.md) for repository
conventions and [docs/README.md](docs/README.md) for release automation and design records.
