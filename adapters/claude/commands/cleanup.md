---
description: Audit, prune, and migrate legacy Orkest / agent-executor state, worktrees, and backups; quarantine merged worktrees recoverably
argument-hint: "[status|run] [--dry-run] [--migrate-legacy] [--merged [--target <branch>]]"
---

[orkest-cleanup-command: $ARGUMENTS]
Run `ork cleanup $ARGUMENTS` (use `ork cleanup status --json` first if you want to preview before mutating, or `ork cleanup run --migrate-legacy` when the user asks to clean up and migrate legacy paths) and report the reclaimed artifacts, worktrees, backups, and legacy path migration status concisely.

For merged branches use `ork cleanup status --merged --json` to preview, then `ork cleanup run --merged`. It never deletes: each clean, disposable, merged worktree is moved to a private quarantine with its branch, contents and registration intact, and nothing is reclaimed. `--merged` does not run the legacy pruning and cannot be combined with `--migrate-legacy`. Report each kept worktree's reason and give the restore command printed for every quarantined one (`git worktree move` back after checking the original path is vacant). Never remove a quarantined worktree yourself.
