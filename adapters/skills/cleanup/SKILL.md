---
name: cleanup
description: Audit, prune, and migrate legacy Orkest and agent-executor caches, disposable worktrees, staged daemon runtimes, and configuration backups, or quarantine merged worktrees, when the user types /cleanup or asks to clean up old Orkest versions.
---

[orkest-cleanup-command]
Run `ork cleanup status --json` to inspect reclaimable Orkest state, or `ork cleanup run [--migrate-legacy] --json` to prune stale runs, disposable worktrees, staged daemon runtimes, and backups (and optionally migrate legacy `~/.cache/agent-executor` and `~/.config/agent-executor` paths).

For merged worktrees run `ork cleanup status --merged --json` first, then `ork cleanup run --merged --json`. This path is recoverable: it only moves clean, disposable, proven-merged worktrees into a private quarantine (branch, contents and Git registration preserved, nothing reclaimed) and never runs the legacy pruning. Report each kept worktree with its reason and the restore command for each quarantined one; do not delete quarantined data.
