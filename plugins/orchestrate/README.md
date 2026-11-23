# orchestrate

Cross-harness consultation, bounded task delegation, project-scoped peer messaging, team leadership, and multi-agent swarm rooms across Claude Code (`claude`), Codex (`codex`), Antigravity/Gemini (`agy`), and OpenCode (`opencode`).

- **Invocable at will or on request:** Agents across every installed harness can invoke `orchestrate` autonomously—such as calling `consult` for an independent cross-vendor diff review, second opinion, or root-cause investigation, or delegating bounded parallel work across harnesses when spare quota or another model's strengths help—as well as whenever the user explicitly asks for another model or swarm.
- **Native-first routing:** Every hosted frontier model runs through its vendor's own CLI (`codex` for GPT, `agy` for Gemini, `claude` for Claude Code); `opencode` is used only for open-weight models on OpenRouter (sending a hosted model to `opencode` exits 17). Within the same harness and account, agents use their host's built-in subagent and messaging tools; `orchestrate` and `peer-mailbox` cross harness or account/billing boundaries.
- **Bounded execution:** Delegated runs hold a POSIX worktree lease, enforce allowed file scopes, verify that Git history (`HEAD`, branch, reflog, stash) is untouched by the worker, check live quota via [`monitor`](../monitor/README.md), and run deterministic verification gates outside the model after handoff.

Requires Python 3.11+, Node.js 26.13+ (Active LTS; for `ork` and `horde`), `git`, and at least one installed and authenticated harness CLI.

## Install

```sh
<checkout>/install.sh
```

Orkest is not a Claude Code plugin. Claude Code gets the same linked skills, `~/.claude*/commands` and monitor MCP server as every other harness, and the commands call `ork` on `PATH`. The root `install.sh` also installs the `ork` and monitor CLIs, registers monitor's MCP server, and runs the messaging doctor. Use `--dry-run` to preview or `--trust-codex-hooks` to trust the four reviewed Codex mailbox hooks. For orchestrate alone, run `plugins/orchestrate/install.sh`; it points `~/.agents/skills/orchestrate` at the checkout, links detected harnesses, initializes config, installs mailbox hooks, and runs `doctor`. To migrate existing `~/.config/agent-executor` and `~/.cache/agent-executor` directories into `~/.config/orchestrate` and `~/.cache/orchestrate` with compatibility symlinks, run `ork cleanup run --migrate-legacy`.

Codex requires one-time approval for command hooks: review them in Codex `/hooks`, or pass `--trust-codex-hooks` to either installer (which trusts only the four reviewed mailbox hook commands).

### Shell wrappers and your own aliases

`ork setup` writes `~/.config/orchestrate/orkest.sh` and sources it from `~/.zshrc` inside a managed block. The wrappers for `codex`, `claude`, `agy` and your monitor account aliases replace a same-named shell alias, so the alias is set aside, not discarded: its plain command line (`alias claude='claude --my-flag'`, `alias codex='FOO=1 codex'`, an alias that names another command) is put back in front of every launch, with or without the footer. An alias that is not a plain command line (pipes, redirects, substitutions) is not replayed. Define an alias before the managed block; one defined after it wins as usual. Setup never edits lines it did not write: an older Orkest block in `~/.zshrc` whose lines were edited stays exactly as written and the managed block is added after it, so delete that block by hand when you no longer need it.

### Approve Orkest commands for every agent

By default each harness asks before an agent runs `ork` or an Orkest script. To stop those prompts for every future agent, opt in once with `--trust-orkest-commands` on either installer (or `ork setup --trust-orkest-commands`); `--dry-run` previews each file it would change. Later setup refreshes (`ork update`, `ork setup`, `doctor --repair-messaging`) keep the approval current; `--untrust-orkest-commands` removes only the rules it added.

It approves these commands, and nothing else:

- `ork` with one of `chief`, `cleanup`, `factory`, `foundry`, `hall`, `herdr-status`, `name`, `next`, `policy show`, `progress`, `quota`, `radar`, `rooms`, `routes`, `setup --dry-run`, `side`, `side-mission`, `smelter`, `swarm`, `telemetry`, `update`, `gate status`, or non-launching `horde` subcommands/flags (`toggle`, `open`, `close`, `spawn`, `--attach-room`, `--view`, `--chief`, `--print`, `--json`, `--fixture`); also through the `ork` link's absolute path and `node <checkout>/src/bin/ork.mjs`.
- `python3` (or the installing interpreter) with `coordinator.py`, `agent_progress.py`, `peer_mailbox.py`, `context_handoff.py`, `continuation_requests.py`, `telemetry.py`, safe `run_agent.py` coordination/consultation subcommands and flags (excluding `probe`, `horde`, and `listen`), `authority.py show|accept|offer`, and `handoff.py status|show` at their absolute paths in the checkout's `src/py/` directory.

`ork gate -- COMMAND`, `gate.py`, `ork label`, `ork policy allow|deny|reset`, `ork setup` without `--dry-run` (such as `--fast-bin` or `--trust-codex-hooks`), interactive `ork horde --engine` / `ork codex|claude|agy|opencode` launchers, `run_agent.py probe|horde|listen`, mutating `authority.py` (`appoint`, `takeover`, `withdraw`, `set-billing`), and `handoff.py enable|disable` still ask, as do generic `python3`, `node` and shell commands. Sandbox and other tool settings are untouched. `run_agent.py` still enforces `credits.allow=false` in `config.json` across all harnesses, while Claude Code (`permissions.ask`) and OpenCode (`permission.bash` trailing `"ask"` rules) also re-prompt on `--allow-credits`, `--ignore-quota`, and `--trust-codex-hooks`. Account selection, worker scopes, repository policy and deletion confirmations still apply. Dispatch does launch workers and run the verification commands it is given.

| Harness     | Where the rules go                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `~/.codex/rules/orkest-commands.rules` (`prefix_rule`, managed whole)                                                                         |
| Claude Code | `permissions.allow` `Bash(<prefix>:*)` and `permissions.ask` flag guards in `settings.json` of `~/.claude` and each `~/.claude-*` profile     |
| Antigravity | `permissions.allow` `command(<prefix>)` in `~/.gemini/antigravity-cli/settings.json`                                                          |
| OpenCode    | `permission.bash` `"<prefix> *": "allow"` in `opencode.jsonc`/`opencode.json`, followed by `"ask"` flag guards (preserving any user `"deny"`) |

Changed files get an adjacent `.orkest-approval-bak.*` copy, symlinked settings are edited at their target, and the opt-in and the rules it added are recorded in `~/.config/orchestrate/command-approval.json`.

`<checkout>/plugins/orchestrate/uninstall.sh` removes this checkout's skill symlinks and Herdr
registration while leaving configuration, saved state, backups, and other installations untouched.
See [Herdr setup, upgrades, and swarm restoration](../../docs/herdr.md). For the Orca IDE, see
[Orca integration](../../docs/orca.md).

## Agent status in terminal footers

Orkest can display each session's agent name, model, reasoning effort, repository, task stage, team goal,
and current task in a persistent terminal footer (`NO_COLOR` disables color).

Outside Herdr, use the same outer tmux footer for every harness:

```sh
ork label -- codex
ork label -- claude
ork label -- agy
ork label -- opencode
```

Pass `--lines 2` before `--` to split identity and repository from task progress across two rows.
Arguments after `--` pass through to the harness. Detaching (`Ctrl-b d`) leaves the tmux session
running and prints the reattach command. In Herdr, `ork label` runs the harness directly in the
current pane. Herdr owns the terminal display and session lifecycle there.

Agents update their displayed goal, task, and stage (`planning`, `working`, `testing`, `review`, `blocked`, `complete`) with:

```sh
ork progress --session SESSION_ID --goal 'Ship the feature' --task 'Fix the parser' --stage working
ork progress --session SESSION_ID --stage testing
```

Reporting for another live session of your own harness is refused, so a wrong ID can't overwrite
another agent's progress. Anything Orkest can't positively identify is allowed.

To bind an interactive coordinator or worker session to a swarm room:

```sh
ork hall bind --room ROOM_ID --member conductor --engine codex --session SESSION_ID
```

See [rooms](../../adapters/skills/orchestrate/references/rooms.md) and [workboard](../../adapters/skills/orchestrate/references/workboard.md)
for creating rooms, binding sessions, and tracking shared work.

### Claude Code and Antigravity

Both harnesses can run a status-line command with their session JSON on standard input. If Claude
does not already have a status line, add this field to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.cache/orchestrate/bin/ork-fast statusline --harness claude --native-status"
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
    "command": "~/.cache/orchestrate/bin/ork-fast statusline --harness gemini --native-status",
    "stack_with_default": false
  }
}
```

### OpenCode

For OpenCode v2, link the TUI plugin from the repository root and restart the TUI:

```sh
mkdir -p ~/.config/opencode/plugins
ln -s "$PWD/adapters/opencode/agent-statusline" ~/.config/opencode/plugins/orkest-agent-statusline
```

The label appears once the OpenCode session registers with the peer mailbox.

### Codex

No adapter setup is needed for Codex; `ork label -- codex` reads the active thread automatically.

## Inspect routes, models, and health

In the examples below, `<scripts>` stands for `<checkout>/src/py`:

```sh
python3 <scripts>/run_agent.py doctor --check-messaging       # host, CLI versions, routes, skill links, and model-free MCP/hook check
python3 <scripts>/run_agent.py routes                         # effective role -> engine/model/effort table
python3 <scripts>/run_agent.py families                       # live resolution of family selectors (gpt:sol, gemini:fast, claude:best, …)
python3 <scripts>/run_agent.py models --engine codex --match sol  # query cached/live CLI model catalog (always filter with --match)
python3 <scripts>/run_agent.py quota                          # live quota per route from monitor, plus OpenRouter credit balance
node <checkout>/src/bin/ork.mjs --help        # hall/rooms, horde TUI, foundry, smelter, radar, routes, quota, telemetry, and session naming
```

Routes are configured in `~/.config/orchestrate/config.json` (`run_agent.py init` writes a starter file) overlaid on [`routes.default.json`](../../references/routes.default.json). Model selectors (`family` or `family:tier` from [`families.json`](../../references/families.json)) resolve against the live catalog so model upgrades do not require config edits. For task archetypes and route tiers, see [`archetype-rationale.md`](../../adapters/skills/orchestrate/references/archetype-rationale.md).

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

# Ask several models and compare their separate answers
python3 <scripts>/run_agent.py consult \
  --question 'Any race conditions or missed edge cases?' \
  --model gpt:sol --model claude:best --transport executor
```

Repeat `--model` or pass comma-separated model preferences for a concurrent panel. Results retain the supplied
order and each consultant has its own preflight, quota check and `result.json`. Pass `--transport executor` if a model
would otherwise use native handoff. Panels cannot use `--follow-up` or `--detach`; they exit 0 if any consultant
answered, otherwise with the first consultant's exit code.

Details: [`skills/orchestrate/references/consult.md`](../../adapters/skills/orchestrate/references/consult.md).

## Delegate a bounded task (`run_agent.py`, `steer`, `probe`)

Implementation runs take a JSON `--task-spec` (or `--brief` with `--allow-path`/`--track-path`), acquire a worktree lease, verify that only allowed paths changed and Git refs/stash were not touched, and run repeatable `--verify-command` gates after the worker exits:

```sh
python3 <scripts>/run_agent.py \
  --cwd <repo> --task-spec /tmp/spec.json --route implementation \
  --verify-command 'pnpm check' --verify-command 'pnpm test' --expect-changes
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

Details: [`skills/orchestrate/references/runner.md`](../../adapters/skills/orchestrate/references/runner.md), [`skills/orchestrate/references/brief-template.md`](../../adapters/skills/orchestrate/references/brief-template.md), [`skills/orchestrate/references/completion.md`](../../adapters/skills/orchestrate/references/completion.md).

## Multi-agent coordination

### Peer mailbox (`peer-mailbox`)

Live sessions across harnesses (or across separate accounts of the same harness, such as `~/.claude` and `~/.claude-personal`) discover each other and exchange messages within a project through one authenticated loopback HTTP MCP daemon (`mailbox_daemon.py`), backed by `~/.cache/orchestrate/mailbox-v1/`:

```sh
python3 <scripts>/run_agent.py mailbox focus --session <id> --harness codex --text 'Working on API validation'
python3 <scripts>/run_agent.py mailbox peers
python3 <scripts>/run_agent.py mailbox send --to <peer-session-id> --body 'Question with evidence'
python3 <scripts>/run_agent.py mailbox wait --reply-to <message-id> --timeout 300
python3 <scripts>/mailbox_daemon.py status
```

For persistent headless Claude or Antigravity workers that should wake automatically when mail arrives, run `python3 <scripts>/run_agent.py listen --engine claude|agy --prompt 'Task'`. Details: [`skills/orchestrate/references/mailbox.md`](../../adapters/skills/orchestrate/references/mailbox.md).

### Coordinator, team authority, and deputy succession

`coordinator.py` manages multi-step task directories with invocation allowances, wall-clock deadlines, native-bridge guards, and captures evidence before review (`capture`, `verify-evidence`).

`authority.py` gives a multi-agent team one accountable lead with a compare-and-swap generation fence (`appoint`, `offer`, `takeover`, `accept`, `show`) and can propose a deputy on an independent quota pool (`authority.py propose`) so leadership can hand over cleanly if the lead's account hits a quota window limit.

Details: [`skills/orchestrate/references/coordinator.md`](../../adapters/skills/orchestrate/references/coordinator.md).

### Swarm rooms and Horde TUI (`ork`)

`ork horde` opens a coordinator conversation beside a live
swarm tree. Give it an objective; the coordinator assigns workers and can appoint native subswarm
leads (`ork hall`, alias `ork rooms`). All branches share the room's agent and depth limits.
Workers use the existing dispatch, evidence and review workflow.

```sh
ork agy      # open Antigravity, then describe your goal in the conversation
ork codex    # open Codex
ork claude   # open Claude Code
ork horde "Investigate the cache failure and prepare a tested fix"
ork horde --engine claude --max-agents 8
ork horde --attach-room <room-id>
ork horde --attach-room <room-id> --view
```

Codex is the default coordinator. Claude, Antigravity and OpenCode retain their configured accounts,
models and permissions. **Ctrl-b Tab** switches panes; **Ctrl-b d** detaches. `--view`, `--print` and
`--json` never launch models. Subswarm leads use their parent's native harness; workers can use other
harnesses. Writers in one checkout take turns; `ork hall worktree` gives a member its own checkout so
several can implement at once.

Details: [conversational swarms](../../adapters/skills/orchestrate/references/swarm.md),
[room commands](../../adapters/skills/orchestrate/references/rooms.md) and
[agent instructions](skills/orchestrate/SKILL.md).

### Machine-wide Chief (`ork chief`, `/chief`)

`/chief` turns one conversation into the machine's Master Orchestrator. It holds the Chief desk,
sees every room, orchestrator and standalone agent across repositories, and routes a stream of
multi-repo work to autonomous room orchestrators in their own worktrees. The Chief session never
reads code itself, so it stays fast through an overnight run.

```sh
ork chief status [--room <id>] [--json]       # every repo, room, worker count and attention item
ork chief bind [--clear]                      # take (or release) the machine-wide Chief desk
ork horde open --chief                        # Chief View split pane; `ork chief view` draws it in this terminal
ork chief spawn --cwd <repo> --worktree --goal "<outcome and done criteria>" [--dry-run]
ork chief send --to <room|branch|repo|agent|session> "Decision: …"
```

Spawned orchestrators report back with `ork chief send --to chief`, which reaches whoever holds
the desk when the message is sent. Details: [`/chief` skill](../../adapters/skills/chief/SKILL.md) and
[architecture](../../docs/chief-architecture.md).

#### Worktree badges

A room that runs in a worktree shows `:31042 (+1)` (its first allocated port and how many more) and
`● #231 open` (the saved pull request: glyph, number and state word) beside its name. Both come from
saved local state, read once per status snapshot; drawing never calls GitHub, and a worktree with no
ports or pull request shows neither. At 48 columns the room name is shortened first, then the port
badge is dropped; the pull request state stays.

#### Chief event bridge (optional, off by default)

Opt in to forward six committed transitions (`done`, `failed`, `escalation`, `question`, `pr_opened`,
`pr_merged`) to one HTTPS webhook and/or one local executable. Without the file below nothing is sent
and nothing runs. Create `~/.config/orchestrate/chief-bridge.json` (mode `0600`, in a `0700`
directory you own, not a symlink; `ORK_CHIEF_BRIDGE_CONFIG=<absolute path>` relocates it,
`ORK_CHIEF_BRIDGE=0` forces it off):

```json
{
  "version": 1,
  "enabled": true,
  "events": ["done", "failed"],
  "webhook": { "url": "https://hooks.example.com/chief", "bearerToken": "…" },
  "command": { "path": "/home/you/bin/chief-hook", "args": [] }
}
```

The body is only `{"schema":"ork.chief.event.v1","id","event","at","roomId","prNumber"?}`: no
conversation text, paths or credentials. The `id` is derived from the room and the saved record, so a
repeat after a restart carries the same `id`; delivery is at least once, so de-duplicate on it. The
webhook must be HTTPS, every resolved address must be public (private, loopback, link-local and
IPv4-mapped forms are refused), the connection is pinned to the checked address with the host name as
the TLS name, and redirects are failures. The executable must be an absolute path owned by you or
root, not writable by others, run without a shell with a minimal environment and the payload on
stdin. Each delivery is bounded (size, queue, two attempts of 3 seconds, a circuit breaker) and a
failure never changes the room or the pull request.

#### Approve a repository's worktree setup

`ork setup --trust-worktree --cwd <repo>` shows the repository, the setup command and its hash from
`.orkest/worktree.json`, then records your approval. Any change to the file, or to the code it runs,
asks again. It installs nothing else.

### Universal accounts (`ork account`, `/account`)

Every account lives in Monitor's `accounts[]`; there are no work/personal slots. Each mutation takes the
same lock as Monitor's repository-policy writer (`<config target>.lock`, following a symlinked config).

```sh
ork account add <claude|codex|agy|opencode> --profile <slug> [--id <id>] [--alias <cmd>] [--tag <tag> ...]
                [--label <text>] [--short <2ch>] [--config-dir <path>] [--no-sync] [--json]
ork account list [--json]                     # provider, id, alias, tags, home, syncStatus, loginStatus
ork account tag <id-or-alias> <add|remove|set> <tag...>
ork account remove <id-or-alias> [--purge-profile] [--json]
ork account sync [--dry-run] [--json]         # federate mailbox, hooks and Monitor into every profile
```

- Default profile homes are `~/.claude-<slug>`, `~/.codex-<slug>`, `~/.antigravity-<slug>` and
  `~/.opencode-<slug>` (OpenCode gets isolated `config`, `data`, `state` and `cache` roots; independent
  OpenCode logins are not yet verified end to end). Custom `--config-dir` paths must sit under your home.
- `--alias` installs `~/.local/bin/<alias>`, an Orkest-managed wrapper that clears API-key variables, sets the
  profile variables and runs the real provider. Orkest replaces only a wrapper it wrote for the same account.
- `add` prints the exact sign-in command. `loginStatus` is `unknown` unless a credential file exists, since
  keyring-backed logins leave none; credential contents are never read.
- If federation fails, the account stays configured, `syncStatus` is `pending`, the exit code is nonzero and
  rerunning `ork account sync` converges. `remove` keeps the profile; `--purge-profile` only moves an
  Orkest-created profile to quarantine, and only after you confirm in a terminal.

### Heavy-run gate (`ork gate`)

When several agents share one machine, `ork gate` keeps their test suites, builds and project-wide checks from running all at once. A focused run takes one of two slots. A `--heavy` run (whole suite, production build, project-wide typecheck or lint) waits for every slot, and waiters are told who holds the gate. Inside the gate, Vitest and Jest are capped at two workers, the command runs at nice 10, every completed run is recorded in a shared ledger with an advisory source-metadata digest, and a heavy or failed run's full output is saved to a log, so nobody reruns a suite to get back output that scrolled away.

```sh
ork gate --heavy -- pnpm test                       # a whole suite, as the final check
ork gate -- ./node_modules/.bin/vitest run src/a.test.ts
ork gate status [--all] [--json]
ork gate install                                    # PreToolUse hook for Claude Code, Codex and Antigravity
```

The hook refuses a heavy run started outside the gate and suggests the focused alternative. It leaves every other command to the harness's own permission checks. The gate runs only test, build, typecheck and lint commands, so allowing `ork gate` in a harness does not allow everything. Codex runs the new hook only after you trust it with `/hooks`. `AGENT_GATE_SLOTS` and `AGENT_GATE_DIR` override the slot count and lock directory (default `/tmp/agent-gate-<uid>`).

### Quota handoff

At a completed turn, Claude Code, Codex and Antigravity leads can checkpoint their work and offer authority to a successor with available included quota in the same billing context. The lead stays active until the successor accepts. Orkest prefers an eligible idle peer. When it opens a new successor in a sibling Herdr, Orca or tmux pane, the native harness starts interactively with the handoff brief as its first prompt. If no pane is available, the successor runs headless.

In the Orkest config, `handoff.early` and `handoff.visible` default to `true`. `handoff.earlyPercentLeft` defaults to Monitor's 10% rule. Orkest requests one checkpoint per low-quota episode. The checkpoint wait is 90 seconds and an outstanding automatic offer expires after 10 minutes. If the lead runs out before acceptance, the exhaustion handoff can still proceed. `handoff.py status` shows the checkpoint and offer status.

Quota that is lost at its reset anyway is spent to zero, not handed off early. That applies when a day-or-longer limit is in the last 20% of its window (Monitor's use-it-or-lose-it rule) and every other window of the pool resets no later than that limit. A 5-hour window that resets later can stop the lead first, whatever its percentage, so it still hands off early, as does a low weekly limit with days left. The turn-start quota line names the pools being spent this way. `ork rooms` passes a low pool with a note instead of asking for `--confirm-low-quota` only when Monitor itself marks it use-it-or-lose-it, with at least 5% left.

After acceptance, automated wakes, continuation notices and Chief delivery pause for the previous lead until its pool resets or fresh Monitor data shows recovery, whichever comes first. You can still type directly into that session.

## Troubleshooting

- **Orkest commands still prompt after `--trust-orkest-commands`:** the approval covers only the listed `ork` subcommands and coordination scripts at their absolute install paths, so a relative script path, mutating `policy`/`setup`/`authority.py`/`handoff.py` commands, `--allow-credits` / `--ignore-quota` / `--trust-codex-hooks` prompts (in Claude Code and OpenCode), or an unlisted interpreter still asks. After moving the checkout or changing Python, run `ork setup` to refresh the rules. Antigravity may read `command(...)` tokens as patterns, so paths containing characters other than letters, digits and `_./@:=~-` are left out there, and setup reports how many. In OpenCode, a rule of yours added after Orkest's wins.

- **`HTTP mailbox is running old code; use mailbox daemon restart after upgrade`:** Restart the background loopback daemon after pulling changes:

  ```sh
  python3 <scripts>/mailbox_daemon.py restart
  ```

- **Missing MCP registration or untrusted hooks:** Run `python3 <scripts>/run_agent.py doctor --check-messaging`. Repair with `python3 <scripts>/run_agent.py doctor --repair-messaging` (add `--trust-codex-hooks` after reviewing the four Codex mailbox hooks).
- **Duplicate commands or skills in Claude Code (`orchestrate:chief` next to `chief`):** A retired `orchestrate@orkest` or `monitor@orkest` plugin install is still present. `ork doctor` lists it, and `ork update` prints the removal commands: `claude plugin uninstall orchestrate@orkest`, `claude plugin uninstall monitor@orkest` and `claude plugin marketplace remove orkest` (prefix each with `CLAUDE_CONFIG_DIR=<profile>` for a non-default profile). Orkest never runs them itself. The old `orchestrate--vX.Y.Z` and `monitor--vX.Y.Z` release tags still resolve.
- **Claude Code holds a "peer mailbox notification" (`Held peer message … did not attest its permission mode`):** Claude Code holds cross-session messages that do not declare a permission mode while a session bypasses permission prompts, and Orkest's wake-up nudge is one of them. The mail itself is unaffected; only the "check your inbox" nudge waits. Approve the held message, or set `"crossSessionInbound": "accept"` in `~/.claude/settings.json` to deliver them without asking. That applies to every cross-session message in every session; `"hold"` restores the prompt.
- **Automatic handoff never starts in Claude Code:** Check the `Stop` and `StopFailure` mailbox hooks with `run_agent.py doctor --check-messaging`. `--repair-messaging` adds missing hooks.
- **Exit 15, 18, or 19 (quota or credits):** Exit 15 means the target quota pool is blocked; exit 18 means the pool is on paid credits at launch; exit 19 (`stopped_credits`) means a Codex run began spending credits mid-run and was stopped with partial work preserved. Check `run_agent.py quota` and pass `--allow-credits` only when the user explicitly authorizes credit spend.
- **Exit 17 (hosted model sent to OpenCode):** Hosted Claude, GPT, and Gemini models are refused on `--engine opencode`; use `--engine claude`, `--engine codex`, or `--engine agy`.
- **Exit 27 (worktree lease held):** Another writer (or reader when starting a writer) holds the repository's worktree lease. Wait for the active job (`run_agent.py events --cwd <repo>`) before launching another mutating run.
