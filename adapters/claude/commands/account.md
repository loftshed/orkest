---
description: Add, list, tag, remove and sync Claude, Codex, Antigravity and OpenCode accounts
argument-hint: "[add <provider> --profile <slug>|list|tag|remove|sync] [--json]"
---

[orkest-account-command: $ARGUMENTS]
Run `ork account $ARGUMENTS` (start with `ork account list --json` to see what exists, and `ork account sync --dry-run --json` to preview federation). Report the account IDs, aliases, profile homes and sync status concisely. After `add`, show the exact sign-in command the CLI prints so the user can sign in themselves.
Never read credential files. Pass the purge flag only when the user asks for it; it moves the profile to quarantine, and only after the user confirms in a terminal.
