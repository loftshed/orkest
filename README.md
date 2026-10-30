# Orkest

Orkest is a local tool for coordinating coding agents. You talk to one coordinator, tell it what
you want done, and let it organize the work across a team. It can assign individual workers or
give a larger piece to a lead that puts together its own subswarm.

The coordinator runs in Codex, Claude Code, Antigravity or OpenCode. You keep using that harness's
conversation and tools, with a live view of the swarm beside it. Orkest adds shared work tracking,
cross-harness delegation, terminal status and quota monitoring.

## Start a swarm

After [installing](#install), run one of these from the repository you want to work in:

```sh
ork agy
ork codex
ork claude
ork opencode
```

Enter your goal in the conversation when it opens. The coordinator asks what you want done before
starting workers. Keep talking to it as the work progresses, including when you want to change
direction or stop a branch of the work.

You can also pass a goal or set team limits at launch:

```sh
ork stooges "Find out why the cache goes stale and prepare a tested fix"
ork claude --max-agents 8 --max-depth 2
```

`ork stooges` uses Codex by default. The short commands choose the coordinator's harness; they don't
require every worker to use the same one. Existing CLI accounts, model defaults and permissions
stay in effect.

### The conversation and the tree

Stooges is the terminal workspace for the conversation and swarm view. A team might look like this:

```text
Coordinator: fix the stale cache
├─ Investigation lead
│  ├─ Trace invalidation
│  └─ Reproduce the failure
├─ Implementation worker
└─ Reviewer
```

The tree shows who's working on each part, the model and effort, and the recorded task and stage.
The coordinator collects results, resolves conflicts and checks the combined work. An agent going
idle doesn't mean its task passed review.

- **Ctrl-b, then Tab** switches between the conversation and tree.
- **Ctrl-b, then d** detaches and prints the command to reconnect.
- `ork stooges --attach-room ROOM_ID` reconnects to the same coordinator.
- Add `--view` to inspect the tree without joining the conversation. Closing a view leaves work running.

See [the swarm guide](plugins/orchestrate/skills/orchestrate/references/swarm.md) for assignment,
supervision and recovery, and [room commands](plugins/orchestrate/skills/orchestrate/references/rooms.md)
for the controls behind the conversation.

## The rest of the toolkit

- **Delegate across harnesses.** Ask another model a question, get an independent review, or hand
  off a task with a defined scope and checks. Agents in the same harness use its native tools;
  Orkest's runner handles work across harnesses.
- **Share the work.** A project-scoped mailbox and workboard record messages, ownership, blockers,
  evidence and acceptance. Existing sessions can coordinate without relying on you to carry
  messages between terminals.
- **See what each terminal is doing.** The optional footer shows the agent's name, model, effort,
  stage, overall goal and current task. `ork label -- codex` opens a single agent with the same
  footer used by a swarm. [Footer setup](plugins/orchestrate/README.md#agent-status-in-terminal-footers)
  covers all four harnesses.
- **Keep track of quota.** Monitor shows remaining allowance, reset times and credit balances across
  configured accounts. Run `monitor` for the terminal view or use its MCP tools and desktop interfaces.
- **Keep heavy checks from competing.** `ork gate` coordinates test, lint and build runs on the
  same machine and saves logs for heavy or failed runs.

The repository ships two plugins. Their guides cover the detailed commands and configuration:

| Plugin                                         | Version | What it does                                                       |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------ |
| [`orchestrate`](plugins/orchestrate/README.md) | 0.40.0  | Coordinator conversations, swarms, delegation and shared work.     |
| [`monitor`](plugins/monitor/README.md)         | 0.15.0  | Account quota, reset times, credit balances and spending guidance. |

## Install

You need Git, Node.js 22.18+, Python 3.11+, tmux, and an installed, authenticated CLI for each
harness you want to use. The orchestration scripts require a POSIX environment. Monitor's menu bar
app is macOS-specific.

For a fresh install:

```sh
mkdir -p ~/src
git clone https://github.com/loftshed/orkest.git ~/src/orkest
cd ~/src/orkest

./plugins/orchestrate/install.sh

# Add the ork launcher. Skip the ln command if you already have one.
mkdir -p ~/.local/bin
ln -s "$PWD/plugins/orchestrate/bin/ork.mjs" ~/.local/bin/ork
export PATH="$HOME/.local/bin:$PATH"
```

Keep `~/.local/bin` on your shell's `PATH`. The installer links the Orchestrate skill into detected
harnesses, sets up the peer mailbox and runs a health check. It doesn't create the `ork` launcher yet,
which is why the symlink is a separate step. No npm installation is needed to run the tools.

The installer supports `--dry-run`. Codex asks you to review its mailbox hooks once through `/hooks`.
Claude Code, Antigravity and OpenCode also need their
[status-line adapters](plugins/orchestrate/README.md#agent-status-in-terminal-footers) configured
for the outer footer. See the [installation guide](plugins/orchestrate/README.md#install) for details.

To add quota monitoring from the same checkout:

```sh
./plugins/monitor/install.sh
monitor mcp-install
monitor
```

On macOS, this also installs the menu bar app; use `--no-app` for the CLI only. The
[Monitor guide](plugins/monitor/README.md#install) covers account profiles, plugin installation and
desktop setup.

## Where things stand

The conversational swarm workflow is experimental. Launching, status updates and reconnection have
been tested with fixture agents. A complete model-driven swarm still needs end-to-end validation.

- A room currently uses one checkout and serializes worker edits. Read-only workers can run together.
- Subswarm leads use their parent's native harness. Workers can use other supported harnesses.
- The default limits are 12 member slots and 3 levels below the root coordinator. These limit the
  team's size and depth, not tokens or spending.
- Pausing a branch blocks new launches. Active work needs a separate interruption or cancellation
  through its coordinator.

### Troubleshooting

If `ork` isn't found, check the launcher and `PATH` from the install steps. You can also run it
directly with `node ~/src/orkest/plugins/orchestrate/bin/ork.mjs codex`.

For missing agents or mailbox setup problems, run:

```sh
python3 ~/.agents/skills/orchestrate/scripts/run_agent.py doctor --check-messaging
```

Footer fields marked `not set` mean the session hasn't recorded that context yet. The footer reads
work records and progress reports; it doesn't guess a task or declare it complete.

## Development

```sh
yarn install
ork gate --heavy -- ./scripts/check.sh
ork gate --heavy -- ./scripts/test.sh
node scripts/release.js plan
```

Use focused tests while editing. Tests live under `tests/`, mirroring the code they cover. The full
checks above use the shared gate so they don't compete with another agent's heavy run.

See [CLAUDE.md](CLAUDE.md) for repository conventions and [docs/README.md](docs/README.md) for design
records. [Release automation](docs/releases.md) writes plugin versions from conventional commits;
don't update versions by hand.
