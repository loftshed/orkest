# Rooms

A room is a named team of members (`claude:haiku`, `codex:luna:max`, …) over one checkout. Each
member gets one dispatch through the [coordinator](coordinator.md), which keeps model resolution,
billing policy, deadlines, scope and verification. The examples use `ork`; without it on your PATH,
use `node <plugin-root>/bin/ork.mjs`.

For an interactive coordinator that builds and supervises its own team, use
[`ork horde "objective"`](swarm.md). The commands
below also work independently.

`ork rooms resume-status --cwd /absolute/project --json` lists live, unavailable, unbound and
closed rooms, including legacy resume rooms. It only reads the store: it does not migrate, repair
or remove records. To repair a native-ID binding once hooks have recorded its mailbox identity,
use `ork rooms bind --room ID --member conductor --session MAILBOX_ID --engine ENGINE`.
Repair checks recorded ownership and refuses to replace another live coordinator. Native ID claims
require a hook MAC tied to the mailbox identity, harness, machine and checkout, using the daemon token.
Unsigned legacy claims remain hints until the next hook records the genuine ID; display aliases and
unverified history never establish ownership. No daemon request is needed for verification.

## Create and dispatch

```sh
ork hall create --id cache-review --title "Cache review" \
  --cwd /absolute/project --team "claude:haiku,agy:flash,codex:luna:max"
ork hall init-task --task-spec /absolute/task-spec.json \
  --task-dir /absolute/tasks/cache-review --host claude
ork hall dispatch --room cache-review --member haiku-1 \
  --task-dir /absolute/tasks/cache-review --kind investigation
```

Members begin queued: creating a room never starts work. `dispatch` and `launch` may start billable
work, so dispatch only once the [task specification](brief-template.md) says what you want done.
Task directories live outside the repository. `ork horde --preset bug-court` (or `scout-swarm`,
`heavy-trifecta`) opens a coordinator with a queued preset team. Add `--json` to create the roster
without starting a conversation. `ork horde --attach-room ID --view` shows a live view.

A room works in one checkout, and the runner's writer lease is exclusive per checkout, so a room runs
one implementation at a time; other members run as investigation, consultation or challenge.
`patch-race` needs a separate worktree per candidate and cannot run in a room yet.

For a model native to the conductor, add `--transport native`: it returns a reservation for the
conductor's own agent tools instead of starting a CLI session.

An executor run stops after the runner's default 15 minutes. For a longer run, give the task enough
time with `init-task --time-budget DURATION` (default `1h`), then pass `dispatch --timeout DURATION`
(or `"timeout"` on a launch-plan member). The coordinator refuses a timeout longer than the task's
remaining time instead of shortening it. A native dispatch takes no `--timeout`; it ends at the
task deadline. See [coordinator.md](coordinator.md#initialize-and-dispatch).

```sh
ork hall init-task --task-spec /absolute/task-spec.json \
  --task-dir /absolute/tasks/long-read --host claude --time-budget 2h
ork hall dispatch --room cache-review --member flash-1 \
  --task-dir /absolute/tasks/long-read --kind investigation --timeout 25m
```

An implementation dispatch takes the runner's gates and
[auto-correct rounds](runner.md#auto-correct-rounds): `--verify-command CMD` (repeatable),
`--auto-correct N` (0 to 2) and `--protect-path PATH` (repeatable), or `"verifyCommands"`,
`"autoCorrect"` and `"protectPaths"` on a launch-plan member. When a gate fails, the runner resumes the
same worker session up to N times before it reports.

Add members with `ork rooms add --room cache-review --team "agy:flash"`. Each member has one dispatch
intent; add another member for another task. Retrying a dispatch reuses its stored request ID, even
after a lost response. Changing its task, kind, transport, timeout, gates, protect paths, rounds,
role or folder is rejected.
When the coordinator refuses a dispatch and records no run for it, nothing launched: the intent is
cleared, the error stays on the member, and the member can be dispatched again.

`ork rooms launch --room cache-review --plan /absolute/plan.json` dispatches a batch and stops at the
first error; retry the same plan to recover recorded requests:

```json
{
  "members": [
    { "id": "haiku-1", "taskDir": "/absolute/tasks/cache-review", "kind": "investigation" },
    { "id": "flash-1", "taskDir": "/absolute/tasks/long-read", "timeout": "25m" }
  ]
}
```

## Collect results

`ork rooms show --room cache-review --json` reports each member's status from coordinator records.
`ork rooms recover --room cache-review` collects results through the coordinator. Finished work shows
as `review` until the coordinator records its verdict; a worker going idle never accepts a task.

To record which interactive agent plays a member, bind its native session ID:
`ork rooms bind --room cache-review --member conductor --engine codex --session SESSION_ID`.
The binding is a label: nothing checks it, and it grants no authority.

A room created with `--authority TEAM` runs only that team's tasks (`init-task --authority TEAM`), shows
the team's lead and generation, and its `init-task`, `dispatch`, `launch` and `recover` need
`--lead-session` and `--lead-generation`. See
[coordinator.md](coordinator.md#team-lead-and-succession).

Closing a view never cancels work; the coordinator's cancellation stops workers.
