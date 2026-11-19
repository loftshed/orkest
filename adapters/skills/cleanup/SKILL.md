---
name: cleanup
description: Audit, prune, and migrate legacy Orkest and agent-executor caches, disposable worktrees, staged daemon runtimes, and configuration backups when the user types /cleanup or asks to clean up old Orkest versions.
---

[orkest-cleanup-command]
Run `ork cleanup status --json` to inspect reclaimable Orkest state, or `ork cleanup run [--migrate-legacy] --json` to prune stale runs, disposable worktrees, staged daemon runtimes, and backups (and optionally migrate legacy `~/.cache/agent-executor` and `~/.config/agent-executor` paths).
