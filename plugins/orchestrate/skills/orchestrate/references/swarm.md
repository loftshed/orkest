# Conversational swarms

`ork horde "objective"` opens a normal coordinator harness next
to its live swarm tree.
`ork agy`, `ork codex`, `ork claude` and `ork opencode` are shortcuts that let the user enter their
goal in the coordinator conversation after launch.
With no objective, ask the user what they want, then record it with `ork hall objective --room ID
--objective TEXT` (`ork rooms` is a supported alias). The default harness is Codex; `--engine claude|agy|opencode` chooses another.
Existing authentication, permissions and model defaults remain in effect. Starting the conversation
sends its brief to that harness. `--print`, `--json`, `--view` and fixture views never start models.

A room shows its own checkout, its conductor's subagents and workers recorded on its members. Other
worktrees in the repository are separate from that room. The peer mailbox's `peers` and
`board --view status` commands show every session in the repository.

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

Native resume options (`ork claude --resume ID`, `ork codex resume ID`, `ork agy --resume ID`)
reattach to the recorded room, including after the old process exits. Hooks bind the new mailbox
identity using the resume target or inherited room and retain prior session IDs in the room.
A live coordinator still requires the leadership handoff workflow. A closed or missing room falls
back to promotion into a live room. Native session IDs recorded by hooks resolve to the mailbox
peer; display names and free-form aliases do not establish ownership.

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
   Do not guess a session ID from a handle or nickname. A Claude Code subagent can't see its own
   session ID, so put the returned brief path in its prompt: the room matches the subagent to this
   member by that path instead of listing it as an extra member.
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
Recorded activity shows actions before the final response and opens at the response when it spans
multiple screens. Page Up, Page Down and the mouse wheel scroll the history; **Follow** restores
automatic positioning. Retention limits show an omission notice.
Press `d` on a focused agent with a recorded worker result to open its read-only diff.

Quota starts with compact meters grouped into Work and Personal rows, each with its own accent.
Unassigned accounts stay separate. Click `5h`/`wk` or press `w` to switch the compact meters between
five-hour and weekly windows. Pools without that window show their available usage, and an exhausted
window always keeps its pool at zero. Antigravity's
Claude/GPT and Gemini pools remain separate. Icons identify the provider: Claude is orange,
Antigravity uses blue Google icons for both pools, and Codex is light gray. Icon mode omits AG and CX, and single-pool meters need no pool label.
Click the meters or quota chevron, or press `u`, to expand or collapse the details. The bottom buttons open the log, **Shortcuts**,
and other actions. Nerd Font icons are the default; `ORK_GLYPHS=unicode` or `ascii` selects a fallback.
The **Shortcuts** menu lists keyboard controls, including `m` to toggle mouse capture for text selection.

Talk to the root coordinator to change direction. It sends focused updates through native messaging
to its leads. Each lead owns communication and review within its branch. Keep full agent identifiers
in messages. Use `ork progress` for meaningful task and stage changes; the tree reads the same status
as the terminal footer. The outcome vocabulary is:

| Display state              | Recorded basis                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reported (awaiting review) | A dispatched or room-bound member (including leads and briefed workers), or a peer holding claimed, blocked or review workboard items, reports completion, including legacy `completed`, or an executor finishes without a decision. |
| Finished                   | A discovered subagent or peer session ended with no dispatch, so nothing is waiting on a decision.                                                                                                                                   |
| Answered                   | A standalone `consult` returned an answer; there is no task to accept.                                                                                                                                                               |
| Supported                  | The conductor records `supported` for consultation advice.                                                                                                                                                                           |
| Accepted                   | The conductor records `accept` for the current candidate.                                                                                                                                                                            |
| Stale (needs revalidation) | A recorded result hash or candidate fingerprint no longer matches, or verification lacks a bound candidate identity.                                                                                                                 |
| Failed / rejected          | The runner fails, or the conductor records `reject`.                                                                                                                                                                                 |

`rooms show --json` keeps `accepted` and `supported` separate and retains the recorded `verdict`
when evidence becomes stale. An unreadable task clears the projected verdict to `pending`.
Cancellation and conductor takeover remain terminal. Later progress updates activity details but
cannot replace a terminal outcome. Idle runtime alone supplies no acceptance decision.

Herdr's inventory keeps `accepted_task` separate from worker execution: `accepted` follows an
`accept` decision or an explicit `accepted` status; `supported` follows a `supported` decision
or status. Legacy `completed`, `complete`, `reported complete`, and `stale` statuses remain
`awaiting_verification`, as does a finished run without a decision. Other task values remain
`in_progress`, `unaccepted`, and `untracked`. A member recorded with `completion: untracked` or
`answered` projects as `finished` with `untracked`. Python projects recorded task decisions without
probing the workspace; Swarm View derives stale evidence separately.

Finished and answered are neutral: they are not counted as reported, are listed as inactive, and a
later progress update replaces them. They apply only where nothing could be reviewed. A member that
has a `dispatch`, is room-bound, holds a reserved slot or holds workboard items stays "reported
(awaiting review)" until a decision is recorded. The marker is computed when a room is observed and
is not stored with it, so Herdr's Python inventory shows it only for a room it was given with the
marker.

The view uses separate glyphs, labels and semantic colours for these outcomes, including counts
and inactive history. A step fraction appears only from a recorded member `checklist` (or
`progress.checklist`) with integer `completed` and `total` counts, where
`0 <= completed <= total` and `total > 0`. A stage name supplies no checklist.

Recorded acceptance and support are snapshots: subsequent workspace edits or commits do not
invalidate them. A decided run becomes stale only if a bound result file changes or verification
has no candidate identity. Finished, undecided verified results are compared with the live candidate.

Live comparisons reuse the runner's read-only workspace audit in the background. Results are cached
per repository and result hash for at least 30 seconds, with one probe in flight per repository.
A five-second timeout or a probe error yields an unknown comparison and leaves work reported
(awaiting review). While a refresh runs, the last cached comparison remains visible. Host verification
binds to its parent result path and SHA-256; unbound legacy verification needs revalidation.
Notifications use the same outcomes and never announce reported work as complete.

`ork rooms pause --room ID [--member MEMBER]` blocks new leads and worker dispatch in that subtree.
`resume` reopens it. Pausing does not interrupt existing work. For that, use native interruption for
your native handles or coordinator cancellation for your executor runs, then collect the results.
Never stop unrelated terminals or processes. Retrying a recorded dispatch remains possible while
paused so its existing result can be recovered without launching another run.

Use **Ctrl-b Tab** to switch between conversation and tree, **Ctrl-b d** to detach, and
`ork horde --attach-room ID` to reconnect. `--view` opens only the live tree. Closing a view does not
cancel workers. If the coordinator terminal has ended, `--view` still inspects the recorded work;
the launcher does not silently start a replacement coordinator.
