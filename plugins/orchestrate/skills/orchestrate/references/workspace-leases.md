# Workspace leases and Foundry state

These POSIX `flock` locks are advisory. They coordinate cooperating Orkest
processes; they do not constrain editors, people or processes that do not take them.
All acquisitions are non-blocking: a conflicting holder means busy.

## Identity and roots

The identity is the canonical workspace path (`Path.resolve()` in Python,
resolving symlinks and trailing slashes). Its SHA-256 digest is the unchanged key:
`<cache>/worktree-locks-v1/<digest>.lock`. Lock files are never unlinked: removing
one would let another process lock a different inode while an owner still holds
the original. Shared readers coexist and exclude an exclusive writer.

The selected cache follows `ORCHESTRATE_HOME`, then `AGENT_EXECUTOR_HOME`, then
`XDG_CACHE_HOME` (default `~/.cache`), preferring an existing `orchestrate` root
before `agent-executor`. Without an explicit home override, acquisitions also
cover the other well-known root under the same parent when that root already has
a `worktree-locks-v1` directory. Explicit home overrides select only that root.
The selected cache environment is passed to launched workers and reviewers too.
Roots are canonicalized, deduplicated and acquired in sorted path order. Any
failure closes every descriptor acquired so far.

A namespace inserts a directory below each root, for example
`<cache>/next-locks/worktree-locks-v1/<digest>.lock`. The existing Python
`cache / "coordinator-locks"` calling convention uses the same rule. Next uses
`next-locks`, keyed on the canonical repository root, for its scheduling lock;
it never reclaims locks by removing directories or owner files. Old directory
locks may remain on disk; they are not removed or consulted by this protocol.

Lock order across critical sections:

1. Coordinator task lease.
2. Next scheduling lock.
3. Candidate worktree workspace lease.
4. Target checkout workspace lease.
5. Ledger lock.

## Python and Node ownership

Python callers keep using `workspace_lease(repository, cache, read_only=False)`.
The yielded value is an integer descriptor with a `.descriptors` tuple containing
all descriptors, in acquisition order. Close releases ownership; no explicit
unlock or file removal is needed.

The runner passes all `.descriptors` through `Popen(pass_fds=...)` to its executor.
A reading consultation does the same for its consultant. Killing the runner leaves
the child's lease held until the child closes its descriptors or exits. A stray
inheriting descendant can keep the worktree leased after its executor exits; this
fails closed and is visible with `lslocks` on Linux. Normal release closes each
descriptor without explicitly unlocking the shared open file description.

Node calls `acquireWorkspaceLease(path, { readOnly, namespace, env, pythonCommand })`
(the interpreter defaults to `python3`) and awaits
`{ acquired, busy, detail, held, lost, release }`. `held` is a getter that becomes
false when the holder exits or release is called. `lost` resolves with the exit
code and signal if an acquired holder exits before release is called; it stays
pending after normal release. A pending promise alone keeps no process handles open.
`withWorkspaceLease(path, options, callback)`
releases in `finally` and throws on contention. Node spawns the bundled Python
`lease_holder.py` with private piped stdio. The holder runs the same Python lease
code, prints exactly one JSON status line (`acquired` or `busy`), then holds until
stdin EOF. Node releases by ending stdin and waiting for holder exit. Owner death
closes the pipe; holder death closes the lock descriptors. Other Node children do
not inherit the holder pipe ends. Losing the holder also loses ownership: callers
must monitor `lost` and stop their critical section after an unexpected holder
failure. A busy status is processed before considering an exit an infrastructure
failure; missing-status errors wait for `close`, after stdout has drained. Spawn
errors reject acquisition and the holder pipes are closed before rejection returns.

## Strict state and recovery

`loadFoundryState` reports `missing`, `ok`, `corrupt` or `unsupported`, with the
path, state and error. Schema-less objects and `ork.foundry.state.v1` are readable
legacy states; normal writes produce `ork.foundry.state.v2`. The v1 writer is
present in commit `5356fd2` and writes the same status, branch and verification
fields consumers still read. Non-object JSON and unknown schemas are unsupported.
`readFoundryState` returns null only for missing state, otherwise returning a
readable state or throwing `FoundryStateError` with its problem kind.

Writing first loads strictly. Corrupt or unsupported canonical files remain
byte-for-byte in place. A content-addressed sibling backup is written as
`foundry-state.json.<kind>-<sha256 prefix>` and the write throws. Repeated attempts
reuse an identical backup and remain blocked; the canonical file alone decides
readability. A person must resolve the condition, for example by moving the
canonical file away themselves after reviewing the preserved bytes. Nothing
clears it automatically. Marker-only worktrees with missing state are unmanaged:
Next lists them but never verifies, commits, repairs, smelts or prunes them.
Smelter refuses a marker-bearing worktree whose state is missing.

Normal writes use an exclusive temporary file in the same directory, fsync the
file, rename over canonical state, then fsync the directory. Failed writes may
leave temporary files for inspection; they are never automatically removed.
Atomic replacement prevents partial reads; it does not serialize multiple
writers. Cooperating callers hold the exclusive workspace lease across state
read/modify/write critical sections and re-read state, HEAD and dirtiness before
host actions.
`attemptCount` is never lowered by a normal write or reset over unreadable state.

`createFoundryAttempt` and `updateFoundryAttempt` return patches for durable attempt
records without starting a worker. Records include the attempt ID and number,
launch/repair intent, lifecycle status, timestamps, route, error and launcher
identity. `processIdentity` returns Linux `/proc/<pid>/stat` start ticks prefixed
with `proc-start-ticks:`. Without `/proc`, it uses `ps -p <pid> -o lstart=` with
`TZ=UTC` and `LC_ALL=C`, matching `native_bridge.process_identity`. An absent process
returns null; an unavailable identity throws. Recovery treats an unknown launcher
identity or a different host as busy and never signals the recorded launcher.

Next reports unreadable state as a tier-3 `state_unreadable` gate and excludes that
worktree from automated actions. Smelter lists the problem even with no commits
ahead of the target, and refuses both discovered and direct worktree runs before
its pipeline starts.

## Launch and recovery

Foundry provisions a worktree, then holds its exclusive lease while it writes the
task spec and a durable `launching` attempt, before publishing `orkest.json`.
The attempt records an ID, number, launcher PID and process identity, and route.
Repair likewise records its next attempt under the exclusive lease before launch.
Both release the host lease so the runner can acquire its own workspace lease.
Neither Node launcher imposes a shorter timeout than the runner's own limit.

The default launchers parse the runner's `AGENT_*` summary on stdout, including
stdout carried by a nonzero exit. A readable `AGENT_RESULT` file supplies the
status, task outcome and session; JSON stdout objects remain supported. Parsing
stops before the final report so model-authored text cannot replace runner status.
A completed run with a successful task outcome proceeds to verification. Other
reported statuses are audited failures, including an executor timeout reported by
the runner, and record a failed attempt with the original status in `lastRun`.

A definite spawn failure before start, `native_handoff`, or a preflight exit
(4, 11, 13, 15, 17, 18 or 28) records failure with a reason that nothing was launched.
Exit 27 means another runner holds the lease: return busy without altering the
launching attempt. Only a signalled, killed or timed-out runner process, or output
without a usable status, becomes `launch_uncertain`. An unreadable result file can
fall back to a status line; without either source the outcome remains uncertain.
A missing status never means completed.

Verification, host commit and final state writes require exclusive ownership
again. If a surviving executor prevents reacquisition, the launcher returns busy
with a nonzero exit and names the worktree; the durable `launching` attempt stays
untouched. No unleased state write or automatic relaunch occurs. Tests select a
stub with the `runnerScriptPath` option while exercising the real default launchers.

Next reports `launching` or `running` as busy while the lease is held or the recorded
launcher lives. Once both are gone it settles the attempt to `launch_uncertain`
under the exclusive lease, preserving the allowance. This is a tier-3 human gate,
never a repair candidate. `ork next --approve <slug>` resolves it to `worker_failed`
only under a free lease with a known-dead launcher. Approval does not increment or
reset `attemptCount`; a later repair consumes the next number from the same allowance.

## Next scheduling and ledger

The `next-locks` scheduling lease covers evaluation, tier-0 settlement and claiming
the primary action. It is released before a repair worker, Foundry dispatch or
Smelter pipeline runs. Repair claims use the durable attempt; a Smelter claim
transfers the candidate lease into its pipeline. Foundry dispatch claims use
`next-dispatch`, keyed on `<repository>/issue-<number>`, while dispatch runs; those
claims do not prevent another Next process from acting on other worktrees.

Every Next host action reacquires the candidate's exclusive lease and re-reads
state, HEAD and dirtiness before acting. Contention produces an explicit busy
outcome. Ledger updates independently acquire the short `next-ledger` lease, read
the latest ledger, write and fsync a sibling temporary file, atomically rename it,
and fsync the directory. A busy ledger fails the update rather than overwriting
another writer. Lock files and failed temporary files are retained.

## Smelter phases

The worktree lease is exclusive for state checks, the clean-worktree check and
rebase. Smelter records the post-rebase HEAD SHA, releases the exclusive lease,
and acquires a shared lease for the heavy gate and cold review. The shared lease
excludes cooperating writers and coexists with the reviewer's own shared lease.
After acquisition it checks that HEAD still matches and the worktree is clean.
It repeats both checks after review, then releases the shared lease and reacquires
exclusive ownership before state writes, merge and existing disposable pruning.
That final acquisition rechecks HEAD and clean status too. Local merge additionally
holds the target checkout's exclusive lease.

These handovers are not atomic. A writer can acquire between modes; HEAD and clean
status checks detect its changes and return `stale` without merging or writing
state. A failed acquisition returns busy. Launching, running, launch_uncertain and
unreadable state are refused before the first Git command, for both discovery and
direct `--worktree` calls. These checks pin only the worktree HEAD across the lease
handovers. Full candidate and target pinning remains issue #157.
