# Releases

Orkest is one product with one version, kept in the root `package.json`. It is never edited by
hand. Every push to `main` that passes CI runs `scripts/release.js publish`, which decides
whether anything shipped changed and, if so, releases the next `vX.Y.Z`.

## How a version is chosen

The script looks at the commits since the highest published tag that touched what a checkout
ships: `plugins/`, `crates/ork-fast`, `install.sh`, `herdr-plugin.toml`, `orca-plugin.json` and
`.opencode`, plus `src/`, `adapters/` and `references/` for the layout the later stages of issue 233
move code to, so a commit that only edits a command or skill text still releases. Changelog edits, documentation, tests and repository tooling do not count, and a
change that was later reverted releases nothing.

| Commits since the last release              | Next version                             |
| ------------------------------------------- | ---------------------------------------- |
| any `feat:`                                 | minor                                    |
| any `type!:` or a `BREAKING CHANGE:` footer | major, or minor while the version is 0.x |
| anything else                               | patch                                    |

## Tags and earlier releases

New releases are tagged `vX.Y.Z`. Earlier tags stay where they are and still resolve:
`orchestrate--vX.Y.Z` (the line the product continues from) and `agent-executor--vX.Y.Z`.
`release.json` lists those prefixes under `legacyTags`, so the highest version across all of
them is the baseline. The first product release starts from the last published Orchestrate version.
The separate `monitor--vX.Y.Z` tags are excluded from version selection. Their history stays in
`plugins/monitor/CHANGELOG.md`, next to `plugins/orchestrate/CHANGELOG.md`; new entries go in
the root `CHANGELOG.md`. A product that has never been released goes out at the version
`package.json` declares, and `release.json` names the commit that counting starts from.

`ork update` is a git fast-forward, so a checkout can sit on any release or between two. The
installer downloads the `ork-fast` binary from the release named for the checked-out version:
`vX.Y.Z`, then `orchestrate--vX.Y.Z` for checkouts from before the merge, and falls back to
compiling from source.

## Release notes

The commit subjects become the changelog entry. To write the notes yourself, add them under a
`## Unreleased` heading at the top of the root `CHANGELOG.md`; the release turns that heading
into the version.

## Merging

Release notes come from the subjects of the commits that land on `main` (merge commits are
ignored), so the merge method decides what the changelog says:

- **Squash** a pull request that is one change. Its title becomes the one changelog line.
- **Rebase** a batch of small fixes, one conventional commit per issue, each naming its issue
  (`fix(orchestrate): … (#123)`). Every commit becomes its own line. A squash here would collapse
  the batch into one line and hide the rest.

CI checks the tip of a batch, not each commit, so keep a batch to changes that are safe to revert
together.

## Trying it locally

```sh
node scripts/release.js plan    # what would be released, as JSON
node scripts/release.js check   # build it in a scratch worktree and run the lint gate on it
```

Run `git fetch --tags` first so the script sees the latest releases. CI runs `check` on every
push and pull request, so a hand-edited version fails there.

## What publishing does

1. Confirms it is running in GitHub Actions for a push to the default branch, on the exact
   commit that was tested.
2. Writes the new version into the root `package.json`, `plugins/monitor/package.json` (kept
   in step with the root; the installed monitor copy gets a `package.json` generated from the root version) and any `SKILL.md` `metadata.version`, and adds
   the changelog section.
3. Formats those files and runs the lint gate again.
4. Commits them as `chore(release): publish orkest`, with a `Release-Of:` trailer naming the
   tested commit, and pushes the commit and its tag in one atomic push.
5. Creates the GitHub release, then the `release-ork-fast` jobs build the binaries and attach
   them, with `SHA256SUMS`, to that same `vX.Y.Z` release.

If someone pushes while this runs, the push is rejected and nothing is published; the run for the
newer commit releases everything. If the tag went out but creating the GitHub release failed,
rerunning the job creates only the missing release.

## Repository settings

The job pushes with the workflow's `GITHUB_TOKEN`. Under **Settings → Actions → General →
Workflow permissions**, choose **Read and write permissions**. If `main` is protected, create a
fine-grained token with read and write access to this repository's contents, allow it to bypass
the protection, and store it as the `RELEASE_TOKEN` secret; the job uses it instead. The GitHub
repository description should describe one coding-agent orchestrator, not a plugin collection.
