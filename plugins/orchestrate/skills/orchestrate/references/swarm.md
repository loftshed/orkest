# Conversational swarms

`ork stooges "objective"` opens a normal coordinator harness next to its live swarm tree.
`ork agy`, `ork codex`, `ork claude` and `ork opencode` are shortcuts that let the user enter their
goal in the coordinator conversation after launch.
With no objective, ask the user what they want, then record it with `ork rooms objective --room ID
--objective TEXT`. The default harness is Codex; `--engine claude|agy|opencode` chooses another.
Existing authentication, permissions and model defaults remain in effect. Starting the conversation
sends its brief to that harness. `--print`, `--json`, `--view` and fixture views never start models.

The coordinator owns the outcome, assignments, conflict resolution and final verification. Stay
available to the user while children work. Use native supervision for agents in your harness and
the orchestrate runner for other harnesses. Do not silently change accounts or billing contexts.

## Assign work

1. Read repository instructions and the orchestrate skill. Inspect native tools, live model catalogs,
   quota and peer work before choosing a useful split. Existing idle peers are not automatically
   available. Prefer new bounded workers over interrupting unrelated sessions.
2. Add members to the current room with `ork rooms add --room ID --parent conductor --team TEAM`.
   `--parent` is your own member ID when you are a subswarm lead. Model selectors are resolved by
   the runner at dispatch. All branches share the room's member and depth limits.
3. For a leaf task, create the normal [task spec](brief-template.md) outside the repository, then
   use [rooms init-task and dispatch](rooms.md). Native models use `--transport native`: spawn once,
   attach the exact native handle, supervise it, and complete the receipt through the coordinator.
   Cross-harness dispatch runs in the background. Recover finished runs and review their evidence.
4. For a substantial branch, add a member in your own harness and run `ork rooms lead --room ID
--member MEMBER --objective TEXT`. Read its returned brief and use your native subagent tool once.
   Inherit model settings unless a supported explicit choice is authorized. Immediately bind the
   returned native session using `ork rooms bind --room ID --member MEMBER --engine ENGINE --session ID`.
   If the tool returns only a handle, supervise that handle and let the child bind its own session.
   Do not guess a session ID from a handle or nickname.
   Spawn only for `native_handoff`. A repeated reservation returns `attached` with the existing
   binding or `pending_attachment`. Recover an uncertain spawn through native tools; never assume it
   did not launch and start another copy.
5. Native leads can create more leads and workers in the same room. Use the workboard for each lead's
   assignment and acceptance. The room records hierarchy and session bindings, not a second task
   ledger. Never duplicate a coordinator task on the interactive workboard.

A lead runs as a native subagent, outside the audited leaf-job runner. It must not hold a checkout's
writer lease while waiting for workers to edit it. Worker scope, invocation allowances, deadlines,
leases, evidence checks and review remain the existing coordinator's responsibility. A room supports
one checkout and serializes mutating worker runs. Concurrent implementation across worktrees is not
part of this first workflow. Cross-harness workers are supported; subswarm leads stay in their
parent's native harness.

The default room has 12 member slots and 3 levels below its root. `--max-agents` and `--max-depth`
choose those limits at creation. Slots include queued members and leads, remain allocated after
completion, and cannot be replenished by creating another room. They bound the roster, not tokens,
model turns or spending. Native tools and shell access remain a cooperative execution contract.

## Steer and inspect

Talk to the root coordinator to change direction. It sends focused updates through native messaging
to its leads. Each lead owns communication and review within its branch. Keep full agent identifiers
in messages. Use `ork progress` for meaningful task and stage changes; the tree reads the same status
as the terminal footer. A reported completion or idle session is not verified acceptance.

`ork rooms pause --room ID [--member MEMBER]` blocks new leads and worker dispatch in that subtree.
`resume` reopens it. Pausing does not interrupt existing work. For that, use native interruption for
your native handles or coordinator cancellation for your executor runs, then collect the results.
Never stop unrelated terminals or processes. Retrying a recorded dispatch remains possible while
paused so its existing result can be recovered without launching another run.

Use **Ctrl-b Tab** to switch between conversation and tree, **Ctrl-b d** to detach, and
`ork stooges --attach-room ID` to reconnect. `--view` opens only the live tree. Closing a view does not
cancel workers. If the coordinator terminal has ended, `--view` still inspects the recorded work;
the launcher does not silently start a replacement coordinator.
