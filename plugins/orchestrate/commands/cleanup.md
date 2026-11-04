---
description: Audit, prune, and migrate legacy Orkest / agent-executor state, worktrees, and backups
argument-hint: "[status|run] [--dry-run] [--migrate-legacy]"
---

[orkest-cleanup-command: $ARGUMENTS]
Run `ork cleanup $ARGUMENTS` (use `ork cleanup status --json` first if you want to preview before mutating, or `ork cleanup run --migrate-legacy` when the user asks to clean up and migrate legacy paths) and report the reclaimed artifacts, worktrees, backups, and legacy path migration status concisely.
