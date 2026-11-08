# Runner behavior

Detail behind the SKILL.md core. Read it when a result surprises you, when choosing effort or
billing, or when changing the runner.

## Engines

| Engine     | Invocation                                                                                                                                                                                                   | Brief                                                        | Permissions                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------- |
| `codex`    | `codex exec` JSONL plus `--output-last-message`                                                                                                                                                              | stdin                                                        | `--dangerously-bypass-approvals-and-sandbox`              |
| `agy`      | `agy -p` stream-json output, terminal presentation disabled                                                                                                                                                  | stdin (one stream-json message; agy ≥ 1.1.15, else argument) | `--dangerously-skip-permissions`                          |
| `claude`   | `claude -p --output-format json` (Claude Code), a fresh run named with `--session-id <uuid>`; the report is the last `result` message, read from one object, a verbose JSON array, JSON lines or stream-json | stdin                                                        | `--permission-mode bypassPermissions`, `--add-dir <repo>` |
| `opencode` | `opencode run --pure --auto`, all-allow agent overrides, no sharing or auto-update                                                                                                                           | file attachment                                              | inline overrides                                          |

Every executor gets an environment scrubbed of the host session (`CLAUDECODE`, `CLAUDE_CODE_*`,
`CLAUDE_CONFIG_DIR`, `AI_AGENT`), so a Claude host's tokens and profile never leak into a child.
`--engine claude` runs Claude Code's default profile unless `--claude-config-dir` names another; the
profile decides the billing account, so follow the user's rules.

OpenCode cannot add workspace roots faithfully; use Codex, agy or claude when a task needs `--add-dir`.

## Model catalogs

`models` reads a private cache at `<cache>/models-v1.json`. A cached entry is valid for 24 hours
while its CLI version is unchanged; a miss, version change, or requested model missing from the entry
triggers a refresh. `--refresh` / `--refresh-models` force it. Codex is listed through `app-server`
`model/list`, agy through `agy models`, OpenCode through `opencode models --pure`. Claude Code has no
listing command, so its catalog is the aliases `opus`, `sonnet`, `haiku`, `fable`; a full `claude-*`
ID is accepted unverified. None of these prompt a model. Always filter:
`models --engine agy --match gemini-3.8`; an unfiltered listing costs thousands of tokens.

For example, when asked to consult a versioned Claude Opus and only `opus` is catalog-verified,
launch with `--engine claude --model opus` on the authorized profile. Report: "Using Claude Code's
current `opus` alias; the requested version is unverified." A version number in the request alone
does not require another confirmation. An explicit instruction such as "exact version only" does:
if that pin cannot be verified, explain the gap and ask before using an alias. Acceptance of an
unverified full ID does not prove availability. Never replace Opus with Sonnet or switch accounts
to resolve a catalog gap. Record any provider-observed model separately from the requested version
and dispatched alias; if no resolved version is available, leave it unresolved in the final report.

`--model` also takes a family selector (`gpt:sol`, `gemini:fast`, `deepseek`) from
[families.json](families.json), resolved against the live catalog to the newest matching ID; a selector
alone infers its engine. The result records the resolved ID with `model_preflight:
live_family_resolved`, `families` prints every resolution, and `AGENT_NOTE=model_advanced` on stderr
marks a selector that now resolves to a newer model. A coordinator dispatch records the resolved ID,
and `--resume-result` keeps a selector on the model the session ran.

## Effort and variants

Pass `--effort` for reproducible runs. Codex effort is validated against the model's catalog and bound
as `model_reasoning_effort`; claude takes `low|medium|high|xhigh|max`; agy effort must match the
catalog slug (`gemini-3.8-flash-high`); agy rejects `--effort` alongside a slug, and no current
agy model offers `max`. OpenCode keeps its provider `--variant`; never translate
effort names across providers. Results keep requested, command-bound, and provider-observed settings
separately; unknown observed settings stay null.

## Usage and reference cost

`usage` keeps raw counters and exclusive normalized buckets. Codex snapshots are cumulative, so a
resumed run without a matching prior result has unknown incremental usage. OpenCode records reasoning
separately and deduplicates steps. agy keeps cumulative and step counters; its billing semantics are
unknown. claude reports input, cache read/creation and output tokens plus Claude Code's own cost
estimate (`native_cost_usd`). Unknown is never zero.

`--billing-mode api|subscription|unknown` declares the billing context without inspecting credentials.
[The dated registry](model-registry.json) holds verified public API tariffs; a reference estimate is
emitted only when usage, rate freshness (30 days, or an entry's `revalidate_on`) and tariff tier permit.
agy slugs use their base model's tariff. It is not an invoice. See
[verification findings](research-verification-2026-09-18.md).

## Bounded session continuation

Coordinator `--kind continue` uses `--session`, `--resume-result` and `--resume-new-task` to run a
new task spec in the recorded session. Executor identity, prior workspace and history checks remain;
the new scope, tracking and verification commands get a fresh audit baseline. Earlier gate protection
and scope releases belong to the earlier task. Usage still carries the session baseline. The native
bridge likewise reserves the same handle and audits the new task without launching a peer CLI.
The coordinator enforces review and the per-member cap; see [coordinator.md](coordinator.md).

## Audit and classification

- The runner holds a POSIX worktree lease through execution and verification. Empty-scope runs
  share reader leases; a writer excludes other readers and writers (exit 27). Stdin task inputs
  conservatively retain an exclusive lease. The lease does not stop editors.
- History is judged on this worktree only: branch, HEAD, HEAD reflog, stash. A change there is a
  `history_violation` (21). Commits, branches or worktrees created elsewhere in the repository are
  reported in `concurrent_activity` and do not fail the job.
- Scope compares the final-state path delta with the allowed prefixes (22). `--allow-path .` (or
  `allow_paths: ["."]` / `scope_owner: "worker"` in a task spec) grants worker-owned repository
  scope covering any repository-relative path outside `.git`. When a lower-tier conductor dispatches
  a mutating run to a higher-tier worker (`--conductor-model`, `AGENT_EXECUTOR_CONDUCTOR_MODEL`, or
  detected from the active project session in the peer mailbox), the runner automatically widens
  `allowed_paths` to `["."]`, preserves the original narrow paths in `scope_hints`, and emits
  `AGENT_NOTE=worker_owned_scope` on stderr. Read-only runs (empty scope) are never widened.
- Verification commands run through `/bin/sh` after a clean handoff, one `--verify-timeout` each,
  fail fast, keep bounded tails and private logs. The repository is re-audited afterwards (25/26).
- The report needs the five headings in order. Markdown decoration is tolerated (`**STATUS**`,
  `## STATUS:`, `` `COMPLETE` ``, `COMPLETE.`); a qualified `COMPLETE - except …` is malformed.
- A provider terminal error is surfaced in `provider_error` even when the CLI exits 0: agy's result
  `error`, Claude Code's `is_error` result, Codex's `error`/`turn.failed` event, OpenCode's `error` event.
- A failed, empty or malformed run becomes `provider_quota_exhausted` (16) only on provider evidence:
  an anchored quota, credit or rate-limit message (`RESOURCE_EXHAUSTED`, `429 Too Many Requests`,
  `insufficient_quota`, `usage limit reached`, …) in stderr or that terminal error, or a structured
  signal (Claude `rate_limit_event` with `status: rejected`, an assistant `error` of `rate_limit` or
  `billing_error`, `api_error_status: 429`; OpenCode `statusCode: 429`). Stdout content and tool output
  are never searched, so a task about quotas or rate limits cannot trip it. The same evidence decides
  `--retry-read-only` eligibility.
- `--timeout` (default `15m`) bounds each executor attempt: the runner stops the executor 60 s after
  it (`timed_out`, 12), and agy gets `--print-timeout` 90 s after it. `--deadline` only shortens that
  wait. [Auto-correct rounds](#auto-correct-rounds) share one `--timeout`. A coordinator dispatch
  passes `--timeout` only when given one; see [coordinator.md](coordinator.md#initialize-and-dispatch).
- After a nonzero executor exit the catalog is refreshed to record whether the model still exists.
  A possibly mutating run is never retried; `--retry-read-only <1-3>` retries only unchanged,
  empty-scope transient failures and keeps every attempt.

Final-state checks cannot prove that no transient or external side effect occurred.

Every new run also has dedicated [mailbox sessions](mailbox.md#runs-conductor-and-worker) for conductor
and worker messages. Questions and replies use ordinary CLI tool calls inside the existing executor
session; provider text streaming is not required. This does not expose internal reasoning or automatically
record every native host message.

## Auto-correct rounds

`--auto-correct N` (0 to 2, default 0) lets the runner fix a failed `--verify-command` gate itself.
A task spec's `auto_correct` sets the default; the flag overrides it, and it needs a gate. When a gate
fails after a clean handoff, the runner resumes the same session, as `--session` does, with a
correction turn: the failing command, its exit code and output tails, and "Fix exactly these problems;
change nothing else", inside the unchanged scope, checks and report contract. It then runs every gate
again, up to N rounds, and reports once. Fresh runs with 0 or no option keep their original output.

- `result.auto_correct` records each round: its prompt (`round-<n>-brief.txt`), session, timing,
  delta and gate results. Earlier logs are kept as `round-<n>-verification-*` and `attempt-<n>-*`.
  `outcome` is `passed`, `exhausted` (the run stays `verification_failed`), `refused` with
  `refused_reason`, `stopped` with `stop_reason`, or `not_needed`.
- History, scope and `--expect-changes` are judged from the snapshot before the first handoff, so
  the audit covers every round. A round's status stands when it is a violation, `blocked` (its own
  report and any consultation request) or `no_changes` (the round undid the work). A round that broke
  down (`failed`, `timed_out`, an empty or malformed report, a credits stop) leaves the run as its last
  handoff did: `verification_failed` with that handoff's report and gate results, and
  `converted_from` naming the round's status. That report predates the round's changes, so
  `coordinator.py reverify` refuses the result; the bounded `correction` is the way on.
- `--expect-task-changes` (with `--expect-changes` and `--resume-result`) judges the net change from
  where the resumed task began: the resumed result's `task_git_before`, else its `git_before`. The
  result carries `task_git_before` through every resume, even without this flag, and records
  `task_workspace_changed`. A coordinator correction always passes it, so undoing the implementation's work ends `no_changes`, and a correction after a
  converted round whose fix is already in place completes once the gates pass.
- Rounds share `--timeout`: a round gets the executor time earlier attempts left. It is refused when
  under 60 s remain (`timeout`), when `--deadline` leaves under 60 s plus the last gate run
  (`deadline`), or when the executor exposed no session (`no_session`). A round's wait keeps the
  runner's 60 s grace past its timeout, but with `--deadline` it always ends early enough for the
  gates to run again.
- A round may not change the gate's own files, listed per round as `gate_files`. Changing one fails
  the run as `scope_violation` with `gate-edit:<path>`. Exactly three kinds are protected:
  - the program a verify command runs, when it is a path: `./gate.sh`, `.venv/bin/pytest`,
    `node_modules/.bin/vitest`;
  - the script handed to `sh`, `bash`, `zsh`, `dash`, `python`, `python3`, `node`, `ruby`, `perl`,
    `deno`, `bun`, `pwsh`, `.` or `source`: its first operand after the options, so
    `python3 tools/gen.py apply x` protects `tools/gen.py`. `-m`, `-c` and `-e` run no script file;
    a shell's `-c` string is read as commands. Syntax-check inputs (`node --check`/`-c`, `ruby -c`,
    `perl -c`) stay editable;
  - every `protect_paths` entry (task spec) and `--protect-path`: files or directories, protected in
    every correction whether or not they exist, Git ignores them or the run changed them. Their
    fingerprints come from before the first handoff; executor runs reject an explicit protected edit
    before verification, including on the initial turn.
- Programs and scripts count as they stood before the first handoff, Git-ignored or not, minus files
  the run itself has changed, which are the work under test. They are found after `cd`/`pushd`/`popd`
  (a subshell's `cd` is undone), behind `env`, `exec`, `command`, `time`, `nohup`, `nice`, `timeout`
  and `{ ...; }`, on every line of a multi-line command, inside `sh -c '...'`, `$(...)` and process
  substitutions (`<(...)`, `>(...)`). A symlinked directory on the way and every hop of a symlink chain are protected too.
- Gate detection is best effort. Nothing else is protected automatically. Arguments are not: test files named to a test runner
  (`pytest tests/test_x.py`), data, config, redirections (`> build/gate.log`), directories and globs
  stay fixable in a round. Programs a command starts indirectly (`make test`, `npx vitest`,
  `uv run pytest`, a script calling a script) are not found. Keep a gate outside the worker's
  allowed paths, where scope protects it in every turn, or list it in `protect_paths`.
- Accepted parser limitations: `eval`, `find -exec`, `xargs`, `builtin .`, here-strings (`<<<`),
  PowerShell stdin/inline commands, `case` patterns inside subshells, and extensionless `bun` scripts.
  Interpreter option handling covers a subset: extra value-taking options (such as `--ext`,
  `--env-file`, `--env-file-if-exists`, `--disable-warning`, `bun -c`) and working-directory options
  (`--cwd`, Ruby `-C`, PowerShell `-wd`/`-WorkingDirectory`) can hide scripts. So can `env -S`
  strings containing env flags (`-i`, `-u`, `-C`) or `#`, repository wrapper links to `/usr/bin`,
  and nested `$(...)` inside double quotes inside `$(...)`. Use `--protect-path`
  for each gate reached through these forms; write scope remains the boundary.
- The correction turn also says that a check which is itself wrong must not be changed: the worker
  stops and reports `BLOCKED` with the evidence, and the run ends `blocked` with that report and any
  consultation request for review.
- A user steer that interrupts a mechanical round records that round as `steered` (with any gate files
  changed so far) and starts the continuation with fresh segment budgets and handoff state; already
  opened rounds still count toward the global cap. The interrupted round's gate files stay protected and
  are judged on the workspace the steered turn leaves, so restoring one is not a violation. A path a
  steer names with `--allow-path`, live or interrupting, stops being protected with everything under
  it, even inside a protected directory or when scope already covered it (`.` or a parent directory).
  Siblings retain their original protection. A release never follows symlinks: to let a worker edit
  a gate through a link or a symlinked directory, also release the real path the `gate-edit:`
  violation names. `auto_correct.released_paths`
  records those paths, and a run resumed from that result keeps them released. A resumed correction
  protects its first turn too, merges saved gate candidates with new verification commands (including
  `reverify` gates), and excludes files the task has changed. Protection baselines and releases survive
  intermediate resumes with `--auto-correct 0`; fresh zero-round runs keep their original output.
- Native transport never loops. A native handoff passes the round limit to the host in its
  instructions; a coordinator native guard returns the failed gate as `suggested_correction`. As on the
  executor correction, a native correction enforces gate files from its first turn. Native implementation
  captures `protect_paths` fingerprints before its worker starts and carries them into correction, so an
  implementation edit cannot become the protected baseline. The guard checks gate files before running
  verification, so a changed gate program never executes in correction. A native correction
  is judged with its implementation, as `--expect-task-changes` would.
- A correction resumed from a `reverify` result takes its usage cost baseline from the run that was
  rechecked, since a host recheck records no cost of its own.
- Rounds are not a coordinator `correction` and do not use its allowance.

## Steering a running job

`steer <job-or-event> [--message <text|@file>] [--allow-path <path>] [--no-interrupt] [--cwd <repo>] [--wait-timeout 2m] [--format json]`
redirects a detached job or widens its allowed scope mid-run. The job is named by its directory, its
`job.json`, or any of its event IDs or `AGENT_EVENT` paths.

When `--allow-path <path>` (repeatable; accepts `.` for full repository scope) is passed without
`--message` (or with `--no-interrupt`), the runner widens `allowed_paths` in-place (`mode:
live_scope_update`) and updates `job.json` without interrupting the running executor process. When
`--allow-path` is combined with `--message`, the runner widens `allowed_paths`, interrupts the
executor, and resumes the same session with the widened scope noted in the steering brief. A
read-only job (empty `allowed_paths`) holds a shared reader lease and cannot have its scope widened
mid-run.

The handoff happens inside the job's own runner, the process that holds the worktree lease, so the
lease never changes hands. `steer` writes the message to `<job>/steers/<n>/message.txt` and a request
to `<job>/steer-request.json`. While the executor runs, the runner polls for the request every 0.5 s
and claims it with an atomic rename, so a request is either claimed or withdrawn by `steer`, never
both. It answers in `response.json` before it touches the executor. When it accepts, it:

1. Sends SIGINT to the executor's process group, then SIGTERM after 10 s, then SIGKILL after another
   10 s, and waits for the executor to exit. SIGINT is what a user's Ctrl-C sends, so each CLI saves
   its session as it would for a person.
2. Closes the interrupted segment. Its `result.json` gets `status: steered` along with the delta at
   the interrupt. Its event is published already acknowledged, with `superseded_by`, so the inbox
   shows one result to review and `events wait`/`follow` on the old ID follow the job.
3. Resumes the same session, with a new turn made of the message plus the unchanged scope and checks
   and the full report contract. It keeps the engine, model, effort, variant, billing, timeouts,
   deadline, notification and completion hook. Artifacts go to `<job>/steers/<n>/run/` and the new
   event ID is returned.

The final result is judged against the snapshot taken before the first segment, so history, scope,
`--expect-changes` and the verification gates cover the combined run. `result.steering` lists every
accepted steer. `<job>/steering.json` records the runner's phase and every request, rejected ones
included. Each segment gets the full `--timeout`, the same as a retry or a `--session` correction;
steering during an auto-correct round also resets that segment's executor budget and mechanical-round
state while retaining the global round count. `--deadline` still bounds the whole job. The completion
hook and desktop notification fire only for the final result.

| Engine     | Session ID source while running                                                  | Resume                        |
| ---------- | -------------------------------------------------------------------------------- | ----------------------------- |
| `codex`    | `thread.started` (first JSONL line)                                              | `codex exec resume <id>`      |
| `claude`   | assigned up front with `--session-id` (json output prints nothing until the end) | `claude -p --resume <id>`     |
| `agy`      | stream-json `init.conversation_id`, or the log's "Created conversation"          | `agy --conversation <id>`     |
| `opencode` | `sessionID` on the first event                                                   | `opencode run --session <id>` |

Refusals come before any request is written:

- Exit 30: the job finished, or its executor already handed off to verification. The message gives
  the exact `--session <id> --resume-result <result.json>` correction.
- Exit 31: `--cwd` names another worktree.
- Exit 32: the runner PID is gone, or it belongs to another command, which is checked against the
  job's event path in `ps` output so a reused PID is refused.
- Exit 33: the job predates 0.11.0, or another steer is in progress.

Two runtime rejections also exit 33, and in both the executor keeps running untouched:

- The engine has not printed a session ID yet. Retry shortly. If none ever appears, the only fallback
  is to stop the job and relaunch with the instruction in the brief, and the executor's context is lost.
- The runner did not take the request within `--wait-timeout`, for example between retry attempts.
  The request is withdrawn.

Usage accounting across segments follows the resume rules above. An interrupted segment may have no
usage record, and in that case it is reported unknown, not zero. For auto-correct Claude rounds, the
native dollar cost is reduced by the same cumulative baseline as the token totals; the ordinary resumed
path remains unchanged.

## State and retention

Foreground artifacts go to `<cache>/runs-v1`, detached ones to `<cache>/jobs-v1`. `prune` removes old
runs, jobs and acknowledged events (`--older-than 14d`, `--dry-run`); it never removes an
unacknowledged event or the job it points to. Normal launches prune anything older than 30 days at
most once a day.

## Routes and setup

`routes` prints the effective role → engine/model/effort table: the bundled
[defaults](routes.default.json) overlaid by `~/.config/orchestrate/config.json`
(`$AGENT_EXECUTOR_CONFIG`, or under `$XDG_CONFIG_HOME`). `init` writes a starter config. `doctor`
reports the host, installed CLI versions, skill installs, and stale copies.
