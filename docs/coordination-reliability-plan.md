# Coordination reliability implementation plan

## Architecture decision

Keep native execution and conversations. Extend Orkest's existing room, task coordinator,
workboard, routing and completion machinery to own cross-harness coordination, evidence and
acceptance. Fix shared state before adding automatic continuation. Do not introduce a general
scheduler, another acceptance ledger, an always-on model judge, a retrieval service or an
automatic benchmark platform.

This plan incorporates the completed research and architectural critiques. Moving from research
to planning or implementation does not require repeating those critiques. New implementation
outcomes still need verification, and material changes to reviewed assumptions need targeted
review. Model strength alone never exempts substantive work from review.

The existing [mailbox daemon plan](mailbox-daemon-plan.md) remains the transport contract. Its
threaded HTTP service is not the sole state writer: CLI commands, hooks, progress writers and
Node room commands also write files. Keep standalone operation and use the same domain logic
through HTTP and CLI. Do not build a second implementation behind the daemon.

## State and authority

| Concern                  | Authority and contract                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Membership and hierarchy | Room records own explicit member, parent and session bindings. Shared checkout or PID is insufficient evidence of parentage.                                                                    |
| Execution                | Native handle plus terminal event, or executor receipt plus process identity, establishes runtime activity. A room phase or a live shared parent PID does not.                                  |
| Reported phase           | Progress describes planning, work, testing or review. It cannot override an observed idle or terminal executor.                                                                                 |
| Acceptance               | The existing task coordinator owns leaf verification and verdicts. The existing workboard owns native lead assignments and acceptance. Never represent one assignment in both.                  |
| Current authority        | Mutations check task revision and current room/subtree authority generation under the owning lock or transaction. Pause, cancellation and leadership replacement invalidate dispatch authority. |
| Completion and delivery  | Completion, notification attempt, acknowledgement and accepted result remain distinct. Notification failure cannot erase a completion or acknowledgement.                                       |
| Display                  | Horde View and Herdr consume projections. Their caches, selection and labels cannot authorize dispatch, acceptance, recovery or cancellation.                                                   |
| Artifacts                | Task/run artifacts hold reports and evidence. Persist immutable artifacts before committing references; acceptance checks the relevant source revision or fingerprint.                          |

Keep membership, observed activity, reported phase and verdict as separate fields, with source and
observation time. Render unknown when evidence is unavailable. A completed executor awaiting
acceptance may display that phrase, but it must not spin or count as executing. A live reviewer
can count as executing through its own runtime evidence. Idle never means accepted.

For native settings, retain requested, resolved and observed model/effort separately, including
source and observation time. An inherited or requested value is not an observation. A resolved
alias is not proof that the host used it. Show the observed value when available and label a
request or inheritance explicitly when it is the only information available.

## Evidence already covered

These findings justify the work below. Preserve their reproductions as isolated regression tests,
not machine-specific paths in product behavior.

| Finding                        | Evidence and limit                                                                                                                                                                                       | Disposition                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| False activity                 | `rooms.mjs` maps finished runs to review; `horde-view.mjs` counts review as active. An idle peer with saved review progress reproduced review/fresh output.                                              | Separate phase from runtime activity in issue 2.                                                                          |
| Native defaults and provenance | Executor fast routing selects a fast tier. `coordinator.native` prefers same-engine transport independently of requested model. Historical native spawn arguments were not established.                  | Test current capabilities and preserve provenance in issue 3; do not claim that routing caused the historical screenshot. |
| Continuation gap               | `_swarm_next_advisor` runs at turn start. A Stop hook with queued work and no eligible incoming mail produced no continuation. `next.mjs` has a separate explicit loop.                                  | Reuse the coordinator and existing loop rather than another scheduler in issue 5.                                         |
| Lost room updates              | Two pre-read side-registration snapshots both allocated `side-1`; the last replace discarded the first member in a scratch reproduction.                                                                 | Fresh-read allocation and mutation under the shared lock in issue 1. No historical production loss was proved.            |
| Live lock reaping              | Python's room lock replaced an aged lock held by a live process in a scratch reproduction.                                                                                                               | Repair ownership and release rules before migrating writers. Existing metadata writers already take both lock types.      |
| Lost acknowledgement           | A notifier write after an intervening acknowledgement restored `acknowledged_at` to null in a controlled interleave.                                                                                     | Serialize completion updates, keep acknowledgement monotonic and external notification outside the lock.                  |
| Side dispatch failure          | Real `ork side --investigate` failed before dispatch: `scope_owner=coordinator` is rejected by the conductor/worker schema.                                                                              | Repair the producer and test the real command boundary in issue 1.                                                        |
| Herdr wake response            | Installed Herdr returns `result.agent.agent_status`; the wake adapter reads different fields and its fixture hides the mismatch. A read-only probe returned idle while the adapter parser returned null. | Normalize actual responses and verify the target conversation before enabling Herdr continuation in issue 6.              |
| Herdr view ownership           | Manual split/run has no rollback on launch failure; close discards ownership even if both close attempts fail. Coordinator/view exit does not pair with view-pane retirement.                            | Repair owned-resource lifetime in issue 6; never classify arbitrary idle shells as disposable.                            |
| Herdr visibility               | Installed CLI/schema supports display-only metadata. Default rows display agent text, not arbitrary custom tokens. Rendered output and TTL behavior were not tested.                                     | Qualify the display path in issue 6 without changing semantic agent state.                                                |

The prune/unregister lock-target unlink hazard is a source-level concern, not a reproduced failure.
Audit it in issue 1. The native child planning this document bound a real session successfully,
but progress rejected the unregistered peer. Include that binding-without-presence case in issue 2.

## Ordered delivery

Create one self-contained board issue per numbered item, with the contracts and acceptance checks
below. Split a large item into focused PRs at its stated boundaries. One integration owner accepts
results and owns final checks. Paths below are relative to `plugins/orchestrate/` unless stated
otherwise; Python modules are in `skills/orchestrate/scripts/`.

### 1. Repair concurrent writes and the side command boundary

Ready to start. No routing, database or Herdr research blocks this issue.

Modules: `lib/horde-room.mjs`, `lib/side.mjs`, `agent_statusline_tmux.py`, `mailbox_store.py`,
`events_bus.py`, and the relevant prune/unregister paths in `peer_mailbox.py`.

First establish one cross-language room-lock ownership protocol. Include a unique acquisition
identity, process birth identity where available, consistent lock ordering, and release only by
the holder of that acquisition. Never evict a known live owner solely because its lock is old.
Handle an incomplete owner record conservatively and test the acquisition crash window. Avoid
unlinking a lock target while another participant can still hold its inode. Preserve compatible
legacy PID records conservatively during upgrade; mixed clients must not silently regain the old
unsafe stale-reaping behavior. Document the minimum compatible writer version and require old
writers to stop before enabling a protocol they cannot honor.

Then move side-member allocation and mutation into a fresh read under that protocol. Inventory
all room writers and convert the remaining bypasses. Add revisions where needed for stale callers;
an atomic rename alone does not protect read-modify-write. Fix the read-only side task to emit the
existing valid `conductor` scope owner without weakening the parser.

For completion events, lock the fresh update, preserve existing acknowledgement and notification
fields, and commit intent before performing notification. Persist the notification result through
another locked merge. Repeated acknowledgement must be harmless. Audit prune/unregister against
concurrent registration, acknowledgement and reads; add a reproduction before claiming the
suspected unlink schedule is fixed.

Acceptance: deterministic process/barrier tests reproduce two simultaneous side registrations,
an aged live lock, crash during acquisition, stale-owner release and notifier/ack interleaving.
Both members survive with distinct IDs; no second holder enters; acknowledgement never regresses.
Run an isolated real `ork side --investigate` through task creation and coordinator validation,
using a controlled executor at the external launch boundary. The test must not mock away the
producer/consumer schema boundary that failed. Existing room and mailbox compatibility tests pass.

Roll out the lock repair before the converted writers. Keep schema compatibility fixtures and
operator recovery instructions; never repair live user stores as part of the test run.

### 2. Make lifecycle and native identity truthful

Depends on issue 1 for shared record mutations.

Modules: `lib/rooms.mjs`, `lib/horde-room.mjs`, `lib/horde-view.mjs`, `mailbox_hooks.py`,
`agent_progress.py`, `mailbox_presence.py`, `mailbox_store.py`, and `native_bridge.py`.

Implement the state distinctions above and a single projection contract for consumers. Align
Node and Python process-birth/liveness interpretation. A shared PID does not establish child
activity; require child events or explicitly qualified host observations with freshness. Preserve
an ended child's evidence while expiring unsupported activity claims. Repair SubagentStart/Stop
progress output to the schema `readProgressRecord` actually accepts.

Represent a bound native session with missing mailbox presence or missing runtime observation as
unknown or awaiting observation, with a diagnostic. Do not guess registration or parentage. Native
handle binding and mailbox registration remain distinct operations with explicit recovery steps.

Acceptance: finished-awaiting-review, idle-with-saved-review, genuinely active reviewer, missing
presence, reused PID, stale shared-process child, abrupt child exit and late terminal event each
produce the correct activity count and verdict. Hook-generated progress passes the real reader.
Use room fixtures and focused hook/bridge tests, including out-of-order observations.

Rollout: additive fields with conservative legacy projection. Old phase-only records render
unknown activity. Preserve the concurrent renderer cleanup that removes duplicate repository
labels and connects the glyph spine; rebase these changes onto it rather than replacing its tests.

### 3. Choose model and context before native or executor handoff

Depends on issue 2's provenance contract. Policy and adapter tests may be developed in an isolated
worktree after that contract is agreed.

Modules: `conductor_policy.py`, `routes.py`, `families.py`, `model_routing.py`, `coordinator.py`,
`native_bridge.py`, `render_brief.py`, `lib/rooms.mjs`, and the native guidance in
`skills/orchestrate/references/swarm.md`.

Extend existing decision records and routing. Evaluate portability, independently checkable
acceptance, handoff value, task difficulty, available quota and context needs before selecting a
worker. Unknown classification means keep the task or ask a bounded question. It is not permission
to delegate. Include native workers in this choice; matching the host engine must not silently
substitute inherited settings for the selected model.

Describe capabilities per host separately: can request model/effort/context, can intercept launch,
can observe actual settings, and can interrupt. Record unsupported and unverified capabilities.
The native host still calls its own tool. Orkest validates the reservation and records what the host
supplies; do not promise enforcement where it cannot intercept a direct native launch. For a
capability gap, explain the gap and offer a supported route within existing account authorization.
Do not switch billing context automatically.

Link standalone consultations to their owning room and supervising session using the actual job
identity. Display the supervisor and consultant as different actors, with separate model provenance
and lifecycle. A supervisor's task description naming another model must not stand in for a worker
entry, and its own model must not be relabeled as the consultant. Discovery of an interactive
session is not evidence that a separately launched consultation has been registered in the room.

The minimum brief carries the objective, allowed scope, mandatory constraints, acceptance criteria,
source revision and evidence references. Put large logs and prior discussions in retrievable
artifacts. Use a fresh worker when that bounded brief suffices. Use a full-history fork when the
worker needs conversational dependencies; record that reason. Neither cheap models nor fresh
context is a universal optimization. Where the host disallows model overrides on a full-history
fork, expose that tradeoff before launch instead of claiming both were applied.

Acceptance: native supported override reaches actual tool arguments; unsupported override stays
explicit; inherited/requested values never appear observed; observation mismatch is visible.
Fixtures cover fresh and full-history choices, unavailable quota and unknown task classification.
Measure total accepted-outcome cost, including retries, context transfer and parent review, on a
small existing workload before making economic claims. Missing telemetry stays missing.

Rollout: preserve explicit user choices and existing route files. Add provenance without rewriting
historical requests into observations. Qualify each host separately rather than advertising parity.

### 4. Separate current swarm, history and cancellation

Depends on issues 1 and 2.

Modules: `lib/rooms.mjs`, `lib/horde-room.mjs`, `lib/hall.mjs`, `bin/rooms.mjs`, `bin/horde-tui.mjs`,
`lib/horde-view.mjs`, and room discovery in `mailbox_hooks.py`.

Provide clear/archive-current, start-fresh, list/search-history and reopen-view operations. Store
archive state and stable room identity rather than deleting membership or receipts. Archive closes
new dispatch authority for that room; existing workers remain owned and observable until terminal.
A fresh room does not adopt them through account/workspace auto-discovery. Recovery routes a late
result to its original assignment. Explicit adoption requires a checked authority transition.

Opening or reopening a view performs no resume or model launch. Resume is explicit and checks
current authority and pending work. Cancel is separate, uses supported native interruption or
coordinator cancellation for owned runs, and records uncertain interruption honestly. Clearing the
current selection must explain any still-running workers and keep a route back to them.

Acceptance: archive with active children, fresh-room discovery, late completion, reopen-view,
explicit resume, repeated archive and cancel-with-uncertain-host all preserve ownership/evidence.
Read-only list/history/view operations make no model calls. Legacy unarchived rooms remain readable;
do not silently infer archive or acceptance from age.

### 5. Connect bounded continuation to real events

Depends on issues 1 through 4. The Herdr path also requires issue 6's response and qualified-target
repairs before its continuation adapter can be enabled. Share coordinator ownership with issue 3
or integrate serially.

Modules: `mailbox_hooks.py`, `mailbox_wake.py`, `coordinator.py`, `conductor_policy.py`,
`native_bridge.py`, `events_bus.py`, `room_tasks.py`, and `lib/next.mjs`.

Turn-start advice remains useful guidance. Add a durable continuation request when authorized work
is queued at Stop or a worker becomes terminal. The request identifies task, authority generation,
input revision and idempotency key. Route it through existing task reservation and next-action
logic. Reuse the existing listener/wake delivery path to ask the owning host to process it; do not
create a second scheduler or put a model invocation inside every polling tick.

Before reservation and again before launch, re-read authoritative pause/cancel state, task inputs,
lease and current authority. Deduplicate concurrent Stop, completion and reconciliation requests.
Use existing task deadlines and invocation accounting to bound attempts, elapsed time and retries.
Persist a next-attempt time and stop reason. Notifications are hints; reconciliation recovers missed
events without replaying accepted work. Show requested, reserved, awaiting attachment, running,
awaiting acceptance, paused, exhausted and recovery-needed distinctly.

Native dispatch reserves once, then attaches the exact host handle. An uncertain launch is recovery
work, never evidence that nothing started. Recover the same reservation through host observation or
require operator resolution when observation is unavailable. Completion requires the exact attached
handle and terminal event. Keep external launch outside a state transaction. Do not promise
exactly-once external execution. A pause allows read-only recovery of an existing result, never a
new launch hidden inside a retry. Cancellation never silently turns back into a pending task.

Acceptance: reproduce the Stop-with-queued-work gap, then prove the real event path reaches one
reservation. Crash before launch, after launch before attachment, after completion before ack, and
during retry scheduling. Pause or replace authority before retry and assert no new dispatch. Two
hosts attempting the same request cannot both reserve it. A stale input revision cannot be accepted.
If a host has no qualified wake/launch adapter, report continuation unavailable with a manual resume
path instead of displaying an enabled automation claim.

Rollout: opt in per qualified host initially. Expose pending request, last attempt, deduplication
identity and stop reason in status. Disable new continuation requests without dropping existing
receipts or uncertain reservations.

### 6. Cooperate with Herdr lifecycle and show child activity

Depends on issues 2 and 3. May run in an isolated worktree alongside issues 4 and 5, with explicit
ownership of shared hook edits.

Modules: `agent_terminal.py`, `agent_statusline_tmux.py`, `mailbox_hooks.py`, and focused terminal
adapter tests, plus `mailbox_wake.py`, `bin/horde-tui.mjs`, and `herdr-plugin.toml`. Correct
`docs/ARCHITECTURE.md`'s overstated metadata behavior when this ships.

Use Herdr's terminal lifecycle, native session references, readiness, persistence and event
interfaces. Keep Orkest task acceptance, native/headless worker supervision and swarm hierarchy.
Current Herdr mode already bypasses nested tmux; preserve that behavior. Do not replace a valid
direct coordinator launch solely to use another launch primitive.

First normalize Herdr CLI response envelopes against installed-schema fixtures. `agent get`
returns the status at `result.agent.agent_status`; a top-level state fixture is not sufficient.
Before prompting, focusing or closing a resource, resolve its Herdr server/session endpoint and
stable terminal identity, then verify the expected native conversation where applicable. Bare
pane IDs are server-scoped and can change on a move. Use the owning `HERDR_BIN_PATH` rather than
assuming the binary and endpoint from the caller's PATH identify the target. A timeout does not
prove a prompt was not sent; recover its outcome before retrying.

Unify swarm-view creation around an explicitly owned resource, using the existing manifest pane
entrypoint where qualified. A failed launch must roll back only the new split; if rollback fails,
retain its identity and report recovery-needed. A failed close must preserve ownership until an
authoritative read confirms absence. Define the view command's exit policy so `q`, launch failure
and coordinator exit cannot silently accumulate shell-backed views. Closing a view must not
terminate its coordinator, workers or unrelated user panes. Qualify manifest-pane exit and restore
behavior rather than assuming plugin ownership guarantees automatic deletion.

Add a read-only owned-resource report that reconciles Orkest bindings with Herdr inventory.
Distinguish pane existence, available shell, live agent conversation, executing worker and accepted
task. Metadata pruning does not close a pane; a retained idle shell is not evidence of an orphan.
Do not remove the only ownership record before resource retirement or explicit archival. Stop or
delete a whole Herdr server session only through a separately authorized operation.

Aggregate observed children by explicit parent session, account and checkout. Publish a display-only
child count plus model/effort provenance on the parent pane. Prefer the existing display-agent field
for the default layout. A custom token layout is optional user configuration, not a hidden migration.
Include effort and provenance in the synchronization key.

Guard presentation metadata against an occupant/source change, sequence updates, and expire or
clear stale labels. Include Herdr endpoint and runtime generation in resynchronization decisions;
persisted `herdrSyncedTitle` alone cannot establish that a restarted server still has the label.
Use supported custom tokens when configurable rows warrant them. Limit the UUID-only Codex title
override to the tmux fallback; Herdr already supplies native session identity and can preserve
descriptive terminal titles.

Trigger updates on child events and reconcile expiry while the parent is idle. Bound adapter calls,
expire stale observations, and restore ordinary display text when the count clears. Never report
that the parent is working merely because its children are: mailbox wake prompts depend on the
parent's real idle/done state.

Acceptance: isolated Herdr server/config verifies rendered default rows, metadata expiry, restart,
zero-child clearing and completion wake while the parent stays idle. Programmatic schema/metadata
checks come first; graphical inspection is only for the actual rendering requirement. Do not alter
live user configuration. Qualify native host event coverage individually and label missing coverage.

Also test failed split/run rollback, both close attempts failing, view `q`, coordinator exit,
reconnect, pane movement and two Herdr servers with colliding public pane IDs. Verify the wrong
conversation never receives a wake prompt. Use passive reads for inventory, not transcript-history
reads that scroll an agent's interface.

For repeated runtime observation, use supported lifecycle subscriptions to invalidate cached
snapshots. Events are not durable and have no shared snapshot sequence boundary. On reconnect or
`events_lost`, subscribe again and reconcile through authoritative reads; never replay old event
payloads blindly onto a newer snapshot. Plugin startup hooks restore plugin state and exit; they
are not supervised daemons.

Documentation checked against installed Herdr 0.9.5:
[agent automation](https://herdr.dev/tui/docs/agent-automation/),
[session state and restore](https://herdr.dev/tui/docs/session-state/),
[plugin panes](https://herdr.dev/tui/docs/plugins/#panes), and
[socket API](https://herdr.dev/tui/docs/socket-api/). Actual multi-server routing, view exit/restore,
metadata expiry and sidebar rendering still require isolated qualification.

### 7. Bound read costs and close the storage decision

Instrumentation may start after issue 1 in an isolated worktree. Finish the storage checkpoint
before extending continuation persistence across additional records.

Modules: `lib/rooms.mjs`, `lib/horde-room.mjs`, `bin/horde-tui.mjs`, `mailbox_status.py`,
`mailbox_store.py`, `mailbox_daemon.py`, and the completion/coordinator modules if migration is chosen.

Measure file opens, bytes, subprocess count, projection latency, CPU and memory for 12 active members
with 10, 100 and 1,000 archived rooms, with one and three concurrent views. Record cold and warm
results. Observation already batches compact task JSON in Node, and the view already guards refresh
overlap. Preserve existing quota, service and update caches. Target repeated archive/peer discovery
and unchanged progress reads before adding infrastructure.

Cache display reads with explicit generation/mtime invalidation and periodic reconciliation.
Notifications can invalidate a cache but cannot be its only correctness mechanism. Dispatch,
archive, acceptance and continuation always re-read authoritative records under lock or transaction
with expected revisions, even when the display cache says unchanged.

Use a bounded checkpoint: one baseline, one display-cache implementation and one repeat of the
same matrix. Proposed acceptance budget is warm projection p95 below 100 ms on the reference
machine, no overlapping one-second refreshes, and no per-tick archive-body scan after warm-up.
Record actual hardware and I/O counts. A changed budget needs a reason; these are design targets,
not claims about current performance.

At that checkpoint, record either retain-files with evidence that budgets and invariants hold, or
select one named migration domain. A concrete transactional candidate is completion consumption:
commit acknowledgement and the unique continuation reservation/outbox entry together, so a crash
cannot consume the event without recording its next action. An alternative performance-only domain
is a rebuildable room-history index. Do not conflate an index with coordination authority. Select
SQLite only if a named invariant is otherwise awkward to recover safely or measured scans still
miss the budget; a miss does not authorize a whole-store rewrite. Attach the decision to this issue
and close the research, with a separate bounded migration issue if needed.

For any authoritative migration, inventory every reader/writer, freeze old writers, import and
validate records, then make one authoritative cutover. Use a version marker that older clients
refuse. Keep read-only backups and generated exports outside live discovery. No live JSON/SQLite
dual writes. Daemon and standalone CLI call the same domain implementation; Node uses that boundary
rather than implementing the rules again. Large prompts, logs, transcripts and evidence stay in
artifact files. Write immutable artifacts first, then metadata; recover orphan artifacts explicitly.
External effects use a committed outbox and the existing uncertain-launch recovery contract.

Qualify the actual linked SQLite runtime before choosing journal mode. The investigation found
Python linked to 3.42.0. SQLite documents a rare WAL-reset corruption bug through 3.51.2, with fixes
in 3.51.3 and backports 3.44.6 and 3.50.7. Use a qualified patched runtime or rollback journaling;
do not assume bundled WAL is safe. WAL also requires a same-host store and permits one writer at a
time. See the [official WAL documentation](https://www.sqlite.org/wal.html). No runtime installation
is required for this plan. Any later dependency change needs release, license and vulnerability
verification against official sources.

Migration acceptance includes crash/restart, concurrent clients, schema refusal, artifact-orphan
recovery and a rehearsed rollback with all writers stopped. Never restore an old snapshot over new
accepted work. Keep files if the chosen domain does not justify migration.

## Workflow instructions that stop when their purpose is met

Update the affected skill/reference instructions with their owning implementation issues. Each
instruction must name its trigger, required evidence, reuse conditions, invalidation conditions and
stop condition. A new stage name is never an implicit veto or a reason to repeat a completed action.
When evidence is missing, request the smallest missing fact instead of restarting the whole workflow.

| Action                   | Trigger and evidence to reuse                                                                                                                             | Targeted invalidation and stop condition                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critique                 | Substantive unreviewed scope or assumptions; reuse covered findings and dispositions.                                                                     | Review material new assumptions or changed outcomes only. Stop when findings have reasoned dispositions. This plan gets no further critic round.                                      |
| Research                 | A specific unresolved decision lacks evidence; reuse source-backed findings within their known limits.                                                    | Refresh changed sources or a concrete contradiction. Stop when the named decision can be made; record remaining uncertainty without opening another general investigation.            |
| Catalog and quota checks | Selecting or changing a worker needs supported settings and current capacity. Reuse the existing cache within its documented freshness and account scope. | Refresh on expiry, account/model change, launch rejection or capacity evidence. Stop once the bounded choice is supported; never poll a model or quota service on every view refresh. |
| Tests                    | Changed behavior needs proof; reuse passing evidence for the same relevant inputs and contract.                                                           | Rerun affected cases for changed code, dependencies or a demonstrated failure. Stop after applicable checks pass. A stage transition does not require another full suite.             |
| Approvals                | An action exceeds current authorization or an explicit rule requires approval; retain the exact approved scope.                                           | Ask again only for a material change outside that scope. Stop asking once authorized; prepare the concrete result before a required final approval.                                   |

Make instruction compliance testable at the output boundary: decision records reference reused
evidence or explain the specific invalidation, and completed prerequisites do not dispatch another
researcher, critic or test run automatically. Test representative repeated-stage inputs without
model calls. These rules preserve required verification and authorization; they remove repetition
that adds no new evidence.

## Review coverage and acceptance

Carry the existing architecture findings and dispositions into each issue's evidence. A review
record names the covered scope, assumptions, source revision, evidence, findings and disposition.
Reuse existing task evidence and workboard handoff fields, extending their schema only as needed.
Do not create a parallel review database.

A critic of substantive work checks architecture, duplicate mechanisms, conflicting authorities and
failure behavior before code, using existing coverage where applicable. Findings identify concrete
failure evidence and distinguish blockers from preferences. The lead can disagree with a reason
and evidence; do not silently discard the finding or impose an objection quota. There is no
recursive critic-of-critic loop. Status, list, history and reversible display operations need none.
Re-review the affected assumptions only when scope, authority, behavior or outcomes materially
change. Routine stage transitions do not invalidate coverage. New implementation evidence must
still demonstrate the reviewed contract.

The final integration proof uses a disposable room, checkout and artifact store with an actual
supported native tool, not only mocked adapters:

1. Select a suitable lower-cost native model with fresh context deliberately. Provide mandatory
   constraints and one retrievable source artifact; record requested/resolved/observed settings.
2. Stop the parent turn with authorized queued work. Observe the continuation request and one
   reservation, then the exact attached native handle and the worker's artifact-based result.
3. Change the source revision before acceptance. Reject stale evidence and retain its provenance;
   issue a new bounded input revision rather than relabeling the old result as current.
4. Deliver the terminal event twice. Preserve one completion and acknowledgement, with no duplicate
   accepted outcome or extra reservation for the same inputs.
5. Inject uncertainty after launch but before attachment. Recover the original handle or expose
   recovery-needed. Pause before a retry and prove that no replacement launches.
6. Archive the room, start a fresh one and reopen the old view. Old workers and evidence stay with
   their original room; reopening does not resume. Verify Herdr's idle-parent completion wake on
   its separately qualified adapter.

Save commands, revisions, event identities, receipts and expected/actual observations as acceptance
artifacts. Report unobservable settings or unsupported host paths explicitly. Qualification of one
native host is not evidence of parity across all hosts.

## Integration and rollout

Keep shared-state protocol and coordinator edits serial under one integration owner. Lifecycle,
model/context policy, history UI, Herdr and display instrumentation can use isolated worktrees once
their shared contracts are agreed. Assign overlapping files explicitly before starting workers.
Preserve the current package/lock edits and renderer work; do not stage or format unrelated files.

Use focused tests under `tests/plugins/orchestrate/`, matching the modules above. JavaScript runs use
`./node_modules/.bin/vitest run <test-file> --maxWorkers=2`; Python uses the relevant unittest file
or case. Add subprocess concurrency tests only for the actual races and native boundary contracts.
After failures rerun only failing cases. Use project-local formatting and lint binaries on touched
files. The integration owner runs required broader checks once at the final checkpoint through
`ork gate --heavy -- <command>`, avoiding duplication with imminent CI or hooks.

Ship additive readers before newly required fields, qualify writer compatibility for shared locks,
and gate continuation per host. Keep history/view available during rollback. Update command help,
architecture documentation and the documentation index with the corresponding implementation PRs.
No plugin versions are edited manually.

Remaining bounded decisions are the per-host capability matrix, Herdr rendering/expiry behavior,
and the measured retain-files versus named-domain SQLite choice. They block their own rollout,
not issue 1. Existing research and critique are sufficient to begin that first implementation slice.
