# orchestrate

Cross-harness consultation, bounded task delegation, project-scoped peer messaging, team leadership, and multi-agent swarm rooms across Claude Code (`claude`), Codex (`codex`), Antigravity/Gemini (`agy`), and OpenCode (`opencode`).

- **Native-first routing:** Every hosted frontier model runs through its vendor's own CLI (`codex` for GPT, `agy` for Gemini, `claude` for Claude Code); `opencode` is used only for open-weight models on OpenRouter (sending a hosted model to `opencode` exits 17). Within the same harness and account, agents use their host's built-in subagent and messaging tools; `orchestrate` and `peer-mailbox` cross harness or account/billing boundaries.
- **Bounded execution:** Delegated runs hold a POSIX worktree lease, enforce allowed file scopes, verify that Git history (`HEAD`, branch, reflog, stash) is untouched by the worker, check live quota via [`monitor`](../monitor/README.md), and run deterministic verification gates outside the model after handoff.

Requires Python 3.11+, Node.js 22+ (for `ork` and `stooges`), `git`, and at least one installed and authenticated harness CLI.

## Install

Pick one way for Claude Code to load the skill so it does not appear twice:

```sh
# Option A: link the skill into every installed harness from a checkout
<checkout>/plugins/orchestrate/install.sh            # links ~/.agents/skills/orchestrate, writes config, installs mailbox hooks, runs doctor
<checkout>/plugins/orchestrate/install.sh --dry-run  # preview what would change

# Option B: use the Claude Code plugin for Claude, and link the remaining harnesses
claude plugin marketplace add <checkout>
claude plugin install orchestrate@orkest --scope user
<checkout>/plugins/orchestrate/install.sh --no-claude
```

`install.sh` points `~/.agents/skills/orchestrate` (and `~/.agents/skills/agent-executor` for compatibility) at `<checkout>`, links each detected harness's `skills/` directory to that hub, initializes `~/.config/agent-executor/config.json` if missing, installs the `peer-mailbox` MCP registration and turn hooks, and runs `doctor`.

Codex requires one-time approval for command hooks: review them in Codex `/hooks`, or pass `--trust-codex-hooks` to `install.sh` (which trusts only the four reviewed mailbox hook commands).

`<checkout>/plugins/orchestrate/uninstall.sh` removes the skill symlinks while leaving `~/.config/agent-executor`, `~/.cache/agent-executor`, and backups in `~/.local/share/agent-executor/backups` untouched.

## Agent status in terminal footers

Orkest can show each registered session's agent name, model, reasoning effort, task stage, team goal,
and individual task in its terminal footer. Text is left-aligned on the terminal's normal background,
with three spaces of padding and a colored band filling the remaining space to its right. The color
is stable for that session; `NO_COLOR` turns color off. Long fields are shortened to fit. Missing work
details say `not set`.
Codex model and effort are read from its local session database when available; harness-provided
values and mailbox records supply the other displays.

At the start of substantive work, agents can report all three work fields in one command:

```sh
ork progress --session SESSION_ID --goal 'Ship the feature' --task 'Fix the parser' --stage working
ork progress --session SESSION_ID --stage testing
```

Stages are `planning`, `working`, `testing`, `review`, `blocked` and `complete`. Later updates preserve
omitted fields; passing only the session confirms unchanged work. Update when the assignment or stage
changes and before the final response. Reports older than 30 minutes are marked stale unless explicitly
complete. An idle agent is never automatically marked complete. Turn hooks remind Claude Code, Codex
and Antigravity at session entry and about missing, mismatched or stale reports, at most once every five
minutes during user turns. They do not extend turns or wake agents. OpenCode uses the same command but
currently needs the agent to update it without those turn-hook reminders.

Reports describe the display; they do not claim work, verify completion or change the workboard.
An explicitly bound room supplies the goal, and workboard or coordinator records supply the task and
state when present. A matching report can show `planning`, `working` or `testing` while an item is claimed;
it cannot override blocked or review state. Otherwise the report supplies the work fields, with legacy
focus notes as a fallback. Multiple assignments remain explicit. Context from another checkout or
account is ignored. Changed assignments require a fresh report of all three fields, even if a new
work item has the same title. A session without a matching mailbox record has no label.

For example, after creating a room with a descriptive `--title`, bind the interactive conductor:

```sh
ork rooms bind --room ROOM_ID --member conductor --engine codex --session SESSION_ID
```

Bind other members using their member IDs and engines. See [rooms](skills/orchestrate/references/rooms.md)
and the [workboard](skills/orchestrate/references/workboard.md) for creating rooms, binding sessions,
and recording work. The footer only reads these records; it does not create assignments or advance
task stages.

### Claude Code and Antigravity

Both harnesses can run a status-line command with their session JSON on standard input. If Claude
does not already have a status line, add this field to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "python3 ~/.agents/skills/orchestrate/scripts/agent_statusline.py --harness claude"
  }
}
```

If a status-line command already exists, keep it and pipe the same input to the Orkest command from
that script. Include the returned label in its existing output. Apply the same change to any other
Claude profile you use.

For Antigravity, add this field to `~/.gemini/antigravity-cli/settings.json`. The built-in status
line stays visible above the label:

```json
{
  "statusLine": {
    "type": "command",
    "command": "python3 ~/.agents/skills/orchestrate/scripts/agent_statusline.py --harness gemini",
    "stack_with_default": true
  }
}
```

### OpenCode

For OpenCode v2, link the TUI plugin from the repository root and restart the TUI:

```sh
mkdir -p ~/.config/opencode/plugins
ln -s "$PWD/plugins/orchestrate/opencode/agent-statusline" ~/.config/opencode/plugins/orkest-agent-statusline
```

The label appears once the session has registered with the peer mailbox. OpenCode does not currently
register sessions through this footer; a session must register with Orkest separately. The footer
does not change an agent's presence. Updates can take up to three seconds. OpenCode places the line
immediately above the prompt, leaving its existing footer intact.

### Codex

Launch Codex in an isolated tmux session with a left-aligned label and color in the unused space to its right:

```sh
node plugins/orchestrate/bin/ork.mjs label -- codex
```

The wrapper needs `tmux` on `PATH` and uses a private server with default tmux bindings. It sets
that pane's terminal title to Codex's native thread ID and matches it to the registered session,
including when several agents share Codex's background server. Thread names and Codex's own status
line stay unchanged. A fresh session shows its agent identity after registering with the mailbox.
Updates can take three seconds. If you detach, it prints the command to reattach.

## Inspect routes, models, and health

In the examples below, `<scripts>` stands for `<checkout>/plugins/orchestrate/skills/orchestrate/scripts` (or `~/.agents/skills/orchestrate/scripts` after running `install.sh`):

```sh
python3 <scripts>/run_agent.py doctor --check-messaging       # host, CLI versions, routes, skill links, and model-free MCP/hook check
python3 <scripts>/run_agent.py routes                         # effective role -> engine/model/effort table
python3 <scripts>/run_agent.py families                       # live resolution of family selectors (gpt:sol, gemini:fast, claude:best, …)
python3 <scripts>/run_agent.py models --engine codex --match sol  # query cached/live CLI model catalog (always filter with --match)
python3 <scripts>/run_agent.py quota                          # live quota per route from monitor, plus OpenRouter credit balance
node <checkout>/plugins/orchestrate/bin/ork.mjs --help        # rooms, stooges TUI, routes, quota, telemetry, and session naming
```

Routes are configured in `~/.config/agent-executor/config.json` (`run_agent.py init` writes a starter file) overlaid on [`routes.default.json`](skills/orchestrate/references/routes.default.json). Model selectors (`family` or `family:tier` from [`families.json`](skills/orchestrate/references/families.json)) resolve against the live catalog so model upgrades do not require config edits. For task archetypes and route tiers, see [`archetype-rationale.md`](skills/orchestrate/references/archetype-rationale.md).

## Ask one question (`consult`)

When an agent or developer needs a second opinion, root-cause investigation, or code review without handing off file ownership, `consult` runs the target model in its engine's no-write mode (Codex read-only sandbox, Claude Code with no tools or `Read,Grep,Glob` only, Antigravity plan mode, OpenCode standalone with write tools disabled):

```sh
# Focused question in an empty workspace (returns ANSWER and UNCERTAINTY)
python3 <scripts>/run_agent.py consult \
  --question 'Is unlinking a flock file after close safe on macOS?' \
  --attach src/lock.py --model gpt:sol

# Read-only repository review or investigation (returns FINDINGS, EVIDENCE, and UNCERTAINTY)
python3 <scripts>/run_agent.py consult --intent review \
  --read <repo> --diff origin/main \
  --question 'Any race conditions or missed edge cases?' --model claude:best

# Follow up in the same consultant session with context preserved
python3 <scripts>/run_agent.py consult \
  --question 'What if the file descriptor is inherited across fork+exec?' \
  --follow-up <result.json>
```

Details: [`skills/orchestrate/references/consult.md`](skills/orchestrate/references/consult.md).

## Delegate a bounded task (`run_agent.py`, `steer`, `probe`)

Implementation runs take a JSON `--task-spec` (or `--brief` with `--allow-path`/`--track-path`), acquire a worktree lease, verify that only allowed paths changed and Git refs/stash were not touched, and run repeatable `--verify-command` gates after the worker exits:

```sh
python3 <scripts>/run_agent.py \
  --cwd <repo> --task-spec /tmp/spec.json --route implementation \
  --verify-command 'yarn check' --verify-command 'yarn test' --expect-changes
```

- **Mid-run steering (`steer`):** Redirect a detached running job without killing its context or releasing its worktree lease. The runner interrupts the CLI with `SIGINT`, records the partial segment, and resumes the same session with the new instruction:

  ```sh
  python3 <scripts>/run_agent.py steer <event-id> --cwd <repo> --message @lead.md
  ```

- **Isolated patch testing (`probe`):** Copy selected files into a temporary `/tmp` overlay, apply a candidate patch, and run a test command without touching the checkout:

  ```sh
  python3 <scripts>/run_agent.py probe \
    --copy src/module.py --patch /tmp/candidate.patch \
    -- python3 -m unittest tests.test_module
  ```

Details: [`skills/orchestrate/references/runner.md`](skills/orchestrate/references/runner.md), [`skills/orchestrate/references/brief-template.md`](skills/orchestrate/references/brief-template.md), [`skills/orchestrate/references/completion.md`](skills/orchestrate/references/completion.md).

## Multi-agent coordination

### Peer mailbox (`peer-mailbox`)

Live sessions across harnesses (or across separate accounts of the same harness, such as `~/.claude` and `~/.claude-personal`) discover each other and exchange messages within a project through one authenticated loopback HTTP MCP daemon (`mailbox_daemon.py`), backed by `~/.cache/agent-executor/mailbox-v1/`:

```sh
python3 <scripts>/run_agent.py mailbox focus --session <id> --harness codex --text 'Working on API validation'
python3 <scripts>/run_agent.py mailbox peers
python3 <scripts>/run_agent.py mailbox send --to <peer-session-id> --body 'Question with evidence'
python3 <scripts>/run_agent.py mailbox wait --reply-to <message-id> --timeout 300
python3 <scripts>/mailbox_daemon.py status
```

For persistent headless Claude or Antigravity workers that should wake automatically when mail arrives, run `python3 <scripts>/run_agent.py listen --engine claude|agy --prompt 'Task'`. Details: [`skills/orchestrate/references/mailbox.md`](skills/orchestrate/references/mailbox.md).

### Coordinator, team authority, and deputy succession

`coordinator.py` manages multi-step task directories with invocation allowances, wall-clock deadlines, native-bridge guards, and captures evidence before review (`capture`, `verify-evidence`).

`authority.py` gives a multi-agent team one accountable lead with a compare-and-swap generation fence (`appoint`, `offer`, `takeover`, `accept`, `show`). `authority.py propose --session <id> --harness <harness>` inspects `monitor`'s quota pools (`accountId:poolId`) and account `billing` contexts (`work` or `personal`) to propose a deputy on an independent account and reserve both pools from worker routing. When appointed with `--standing-takeover STATUSES:SECONDS` (for example `blocked,credits:900`), the deputy can run `takeover --standing` once fresh `monitor` data shows the lead's pool is in one of those statuses, the lead has been inactive for that duration, no team task has a recently updated live run, no handover is already offered, and—on `credits`—the lead's process is gone.

Details: [`skills/orchestrate/references/coordinator.md`](skills/orchestrate/references/coordinator.md).

### Swarm rooms and Stooges TUI (`ork`)

`bin/ork.mjs` (`ork`) manages multi-agent rooms over a repository (`ork rooms`) and renders the live Stooges terminal dashboard (`ork stooges`) with preset teams (`scout-swarm`, `bug-court`, `patch-race`, `heavy-trifecta`):

```sh
node <checkout>/plugins/orchestrate/bin/ork.mjs stooges --preset bug-court
node <checkout>/plugins/orchestrate/bin/ork.mjs stooges --attach-room <room-id>
```

Details: [`skills/orchestrate/references/rooms.md`](skills/orchestrate/references/rooms.md). Full agent instructions: [`skills/orchestrate/SKILL.md`](skills/orchestrate/SKILL.md).

### Heavy-run gate (`ork gate`)

When several agents share one machine, `ork gate` keeps their test suites, builds and project-wide checks from running all at once. A focused run takes one of two slots. A `--heavy` run (whole suite, production build, project-wide typecheck or lint) waits for every slot, and waiters are told who holds the gate. Inside the gate, Vitest and Jest are capped at two workers, the command runs at nice 10, every completed run is recorded in a shared ledger with an advisory source-metadata digest, and a heavy or failed run's full output is saved to a log, so nobody reruns a suite to get back output that scrolled away.

```sh
ork gate --heavy -- yarn test                       # a whole suite, as the final check
ork gate -- ./node_modules/.bin/vitest run src/a.test.ts
ork gate status [--all] [--json]
ork gate install                                    # PreToolUse hook for Claude Code, Codex and Antigravity
```

The hook refuses a heavy run started outside the gate and suggests the focused alternative. It leaves every other command to the harness's own permission checks. The gate runs only test, build, typecheck and lint commands, so allowing `ork gate` in a harness does not allow everything. Codex runs the new hook only after you trust it with `/hooks`. `AGENT_GATE_SLOTS` and `AGENT_GATE_DIR` override the slot count and lock directory (default `/tmp/agent-gate-<uid>`).

## Troubleshooting

- **`HTTP mailbox is running old code; use mailbox daemon restart after upgrade`:** Restart the background loopback daemon after pulling changes:

  ```sh
  python3 <scripts>/mailbox_daemon.py restart
  ```

- **Missing MCP registration or untrusted hooks:** Run `python3 <scripts>/run_agent.py doctor --check-messaging`. Repair with `python3 <scripts>/run_agent.py doctor --repair-messaging` (add `--trust-codex-hooks` after reviewing the four Codex mailbox hooks).
- **Duplicate `orchestrate` skill in Claude Code:** If `orchestrate@orkest` is installed as a Claude Code plugin and `~/.claude/skills/orchestrate` is also linked, run `<checkout>/plugins/orchestrate/uninstall.sh` followed by `<checkout>/plugins/orchestrate/install.sh --no-claude`.
- **Exit 15, 18, or 19 (quota or credits):** Exit 15 means the target quota pool is blocked; exit 18 means the pool is on paid credits at launch; exit 19 (`stopped_credits`) means a Codex run began spending credits mid-run and was stopped with partial work preserved. Check `run_agent.py quota` and pass `--allow-credits` only when the user explicitly authorizes credit spend.
- **Exit 17 (hosted model sent to OpenCode):** Hosted Claude, GPT, and Gemini models are refused on `--engine opencode`; use `--engine claude`, `--engine codex`, or `--engine agy`.
- **Exit 27 (worktree lease held):** Another writer (or reader when starting a writer) holds the repository's worktree lease. Wait for the active job (`run_agent.py events --cwd <repo>`) before launching another mutating run.
