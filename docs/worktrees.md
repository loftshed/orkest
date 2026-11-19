# Worktree provisioning

Every disposable worktree Orkest creates (rooms, Chief missions, Foundry runs and `ork side`) finishes
through one function, `prepareWorktree`. A repository can opt in to extra setup with
`.orkest/worktree.json`; without it nothing changes, and no helper process starts.

## Configuration

`.orkest/worktree.json` lives in the main checkout (at most 64 KiB, a regular file, never a symlink):

```json
{
  "version": 1,
  "symlinkDirs": ["node_modules"],
  "copyFiles": ["config/local.json"],
  "setupCommand": ["node", "scripts/setup.mjs"],
  "ports": { "names": ["WEB_PORT", "API_PORT"], "rangeStart": 31000, "rangeEnd": 49151 }
}
```

- Unknown keys, malformed JSON and unsafe values are rejected before anything is created.
- Paths are normalized relative literals: no absolute paths, globs, `..`, `.git`, `.worktrees` or `.orkest`.
- `copyFiles` adds to `.worktreeinclude` and the default `.env*` copy; `!` exclusions in `.worktreeinclude` still win.
  Existing files are never overwritten.
- `symlinkDirs` links a directory from the main checkout (for example `node_modules`). Tracked paths are refused.
  The generated link must be ignored by Git: a `name/` pattern does **not** match a symlink, so add the
  repo-local pattern `/name` yourself. Orkest never edits your ignore files. An existing link is reused only if it
  points at the same directory; anything else is left untouched and reported.
- `ports.names` are environment variable names (`[A-Z][A-Z0-9_]*`). Reserved names (`PATH`, `HOME`, loader,
  runtime and credential-like names) are refused.

This repository uses `{"version":1,"symlinkDirs":["node_modules"]}`.

## Ports

Each name gets one loopback port, kept in `worktree-ports.sqlite` under the Orkest cache directory. The
identity is the canonical repository plus the canonical worktree path, so the same worktree always gets the
same ports and two worktrees never share one. A reservation stops Orkest conflicts; it cannot stop an unrelated
program from taking the port later.

The ports reach the setup command and every harness Orkest launches in that worktree (Foundry runs and
`ork side`) as environment variables of the same name, plus `ORKEST_WORKTREE_PORTS` (JSON). For a shell you open
yourself in the worktree, read them with the API or a helper:

```sh
repo="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
node --input-type=module -e 'import { listWorktreePorts } from "<orkest>/plugins/orchestrate/lib/worktree-ports.mjs"; console.log(listWorktreePorts({ repoRoot: process.argv[1], worktreePath: process.cwd() }))' "$repo"
```

Failures carry a code: `ORK_PORTS_EXHAUSTED` (range full), `ORK_PORTS_BUSY` (database locked or probe
timed out), `ORK_PORTS_FENCED` (a quarantine is unfinished), `ORK_PORTS_FENCE_UNSAFE` (a foreign fence entry is left
untouched), `ORK_PORTS_DB_INCOMPATIBLE` and `ORK_PORTS_DB_CORRUPT` (the file is left untouched). Release is idempotent: `releaseWorktreePorts`. A quarantine owner calls `fenceWorktreePorts` before moving a
worktree: the fence is written under the database write lock and allocation re-checks it inside its own
transaction, so a racing allocation either commits first (and is then released) or rolls back. Call
`clearWorktreePortFence` once the ports are released.

## Setup command and trust

`setupCommand` is an argv array, run without a shell inside the new worktree, with a time limit (120 s by
default, `ORKEST_WORKTREE_SETUP_TIMEOUT_MS` up to 600 s) and bounded output. Its environment holds only `PATH`,
`HOME`, `TMPDIR`, locale, the ports and `ORKEST_REPO_ROOT`, `ORKEST_WORKTREE_PATH`, `ORKEST_WORKTREE_SLUG`.
Tokens and other credentials are not inherited. `PATH` keeps only absolute directories outside the repository
and the worktree, so checkout files cannot shadow system tools. `${NAME}` in an argument is replaced by that port.

It runs only after you approve it:

```sh
ork setup --trust-worktree --cwd <repo>
```

The approval shows the canonical repository, argv, config hash, reviewed commit and the untracked or ignored
files setup will be able to read (`.env*`, `.worktreeinclude` and `copyFiles` entries). It records their
SHA-256 digests under `<config home>/worktree-trust/` (directory `0700`, file `0600`) and refuses a dirty
checkout. A grant stops applying when any of these changes:

- a config byte or the argv;
- the new worktree's commit, or any tracked file in it (so the same config text cannot authorize different
  repository scripts);
- the content of a copied-in file, or the set of files copied in;
- on the first run, any other ignored or untracked file already present in the worktree.

Without a valid grant the setup is skipped (`skipped-untrusted`, with the reason) and a warning is printed;
everything else still happens.

Boundary: the grant does not attest what a `symlinkDirs` link points at (for example the contents of
`node_modules`), or system tools found on the scoped `PATH`. Treat those as part of your own machine's trust.

## Failure, retry and recovery

A failed preparation keeps the worktree and throws an error with `stage: "bootstrap"`, a `substage`
(`config`, `copy`, `link`, `ports` or `setup`) and a `code`. Fix the cause and prepare again: copies, links and
ports are idempotent, and a successful setup is not repeated (`orkest-setup.json` in the worktree's Git
directory records it).

Foundry resumes its own unstarted worktree on the next run. Rooms keep the member's worktree reservation, and
`ork side` keeps the worktree, so the failure can be retried against the same path.

Setup is claimed through `orkest-setup.lock` in the worktree's Git directory, created atomically with the
owner's process identity (including the helper and the setup process it starts). Concurrent prepares wait for
a live owner and then see `already-done`, so a non-idempotent setup runs once. If the owner is gone, the
marker still says `running`, or the claim cannot be read, the next attempt stops with
`ORK_WORKTREE_SETUP_INTERRUPTED` (or `ORK_WORKTREE_SETUP_ACTIVE` while an owner lives). Setup may have partly
run, so inspect the worktree first, then call `recoverInterruptedSetup(worktreePath)` from
`worktree-provision.mjs`. It refuses while any owner is alive, and otherwise moves the stale claim and marker
aside under timestamped names (nothing is deleted). Claims, results and recoveries are appended to
`orkest-setup.history.jsonl` and kept.

## Launch environment

`worktreePortEnv({ repoRoot, worktreePath, env })` returns only the validated port variables plus
`ORKEST_WORKTREE_PORTS`; `worktreeLaunchEnv` merges the same object into a base environment. Anything that
assembles a harness environment for a worktree should use one of them.
