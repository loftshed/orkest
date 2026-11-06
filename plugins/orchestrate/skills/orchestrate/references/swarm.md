# Conversational swarms

`ork horde "objective"` opens a normal coordinator harness next
to its live swarm tree.
`ork agy`, `ork codex`, `ork claude` and `ork opencode` are shortcuts that let the user enter their
goal in the coordinator conversation after launch.
With no objective, ask the user what they want, then record it with `ork hall objective --room ID
--objective TEXT` (`ork rooms` is a supported alias). The default harness is Codex; `--engine claude|agy|opencode` chooses another.
Existing authentication, permissions and model defaults remain in effect. Starting the conversation
sends its brief to that harness. `--print`, `--json`, `--view` and fixture views never start models.

The coordinator owns the outcome, assignments, conflict resolution and final verification. Stay
available to the user while children work. Use native supervision for agents in your harness and
the orchestrate runner for other harnesses. Do not silently change accounts or billing contexts.

## Route each action

Your context holds the user's intent and architectural decisions; spend it on that rather than
raw file reads, tracing, or test output:

1. **Follow-up on existing work: continue with the owning worker session.** When a worker
   leaves a gap, failing check, or review follow-up, send it back to the session that holds the file
   context. Native subagent: message or resume it. Audited executor run: dispatch at most one
   `coordinator.py dispatch --kind correction` with reviewed evidence; a second gap or a scope/history
   violation requires a new bounded task or explicit conductor takeover. Do not repair worker output
   in-session while a worker session can continue, and do not spawn a cold worker for the same slice.
2. **Sustained exploration, edits you cannot state upfront, or test/build runs: delegate and yield.**
   When your next read depends on a previous read that itself depended on a read, you are tracing:
   stop and dispatch a `@scout` or `@debugger`. After attaching and establishing supervision or
   background execution, give the user a concise status and end your turn.
3. **Bounded decisions and inspections: handle in-session.** Read to decide, never to
   produce: inspect a worker's `result.json` or diff, run `git status` or `git diff`, read a file the
   user named, or apply a surgical fix only when you can state the diff before opening the file and no
   worker session or lease owns that path. If opening the file turns into figuring out what to change,
   stop and delegate.

Never edit the checkout while a worker holds its writer lease. Do not list, grep, tail, `wc`, or
`stat` subagent transcripts, scratch files, or task directories to check whether a worker is alive:
rely on completion notifications, native status tools, the "Swarm next step" advisor at your next
turn, or `ork rooms show --room ID`.

## Appoint the current conversation

When the user appoints this conversation as coordinator, run `ork hall promote --session NATIVE_ID`.
Add `--objective TEXT` when they supplied a goal. This adopts the running conversation without
restarting it or losing its chat. The command writes and returns the coordinator brief, returns the
room ID, and refreshes its terminal label.
Use `--room ID` to adopt a specific room; a different bound coordinator must use the leadership
handoff workflow instead. Repeating promotion preserves the room's members and existing objective.

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
   When implementation files are not yet localized, dispatch a read-only `@scout` (`--kind investigation`)
   on that task directory first and recover its finished run before dispatching the builder (`--kind implementation`)
   on the same task directory—finished investigation results are automatically appended to the builder's
   `context_packet.evidence`—or grant `scope_owner: "worker"` when repository-wide write scope is authorized.
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

Click another agent's card for a read-only live screen preview. Clicking **This chat** or the
coordinator card returns to the current session's interactive chat. In Herdr,
the view temporarily expands to show the preview on the left and agents on the right. **Agents**
returns to the original split; **Open terminal** opens the real chat for typing. A preview shows
the current screen, not guaranteed full chat history. Agents without a terminal show recorded activity.

Quota starts with compact meters grouped into Work and Personal rows, each with its own accent.
Unassigned accounts stay separate. Each pool shows its lowest remaining percentage; Antigravity's
Claude/GPT and Gemini pools remain separate. Icons identify the provider: Claude is orange,
Antigravity uses blue Google icons for both pools, and Codex is light gray. Icon mode omits AG and CX, and single-pool meters need no pool label.
Click the quota chevron to expand or collapse the details. The bottom buttons open the log, **Shortcuts**,
and other actions. Nerd Font icons are the default; `ORK_GLYPHS=unicode` or `ascii` selects a fallback.
The **Shortcuts** menu lists keyboard controls, including `m` to toggle mouse capture for text selection.

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
`ork horde --attach-room ID` to reconnect. `--view` opens only the live tree. Closing a view does not
cancel workers. If the coordinator terminal has ended, `--view` still inspects the recorded work;
the launcher does not silently start a replacement coordinator.
