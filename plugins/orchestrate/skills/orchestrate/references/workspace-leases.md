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

Currently only the acquiring Python process holds the lease: existing executor
and verification launches do not pass descriptors to their children. Parent exit
therefore releases the lease even if a child is still running. Task 156b must pass
all `.descriptors` through `Popen(pass_fds=...)` where child ownership is required.
The descriptor set is prepared here; inheritability and launch flows are unchanged.

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
clears it automatically. Removing state currently exposes marker-only worktrees
to Next's existing reconciliation behavior; task 156b makes those unmanaged.

Normal writes use an exclusive temporary file in the same directory, fsync the
file, rename over canonical state, then fsync the directory. Failed writes may
leave temporary files for inspection; they are never automatically removed.
Atomic replacement prevents partial reads; it does not serialize multiple
writers. Cooperating callers must hold the workspace lease across read/modify/write
critical sections; adopting those leases in all action flows is task 156b.
`attemptCount` is never lowered by a normal write or reset over unreadable state.

`createFoundryAttempt` and `updateFoundryAttempt` return patches for durable attempt
records without starting a worker. Records include the attempt ID and number,
launch/repair intent, lifecycle status, timestamps, route, error and launcher
identity. `processIdentity` returns Linux `/proc/<pid>/stat` start ticks prefixed
with `proc-start-ticks:`, matching `native_bridge.process_identity`; it returns
null when unavailable. This task does not change launch or repair adoption.

Next reports unreadable state as a tier-3 `state_unreadable` gate and excludes that
worktree from automated actions. Smelter lists the problem even with no commits
ahead of the target, and refuses both discovered and direct worktree runs before
its pipeline starts.
