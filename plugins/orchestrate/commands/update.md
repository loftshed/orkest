---
description: Check for and apply fast-forward Orkest updates, refresh mailbox hooks, and migrate legacy agent-executor state
argument-hint: "[run|check|status|enable|disable] [--check|--apply] [--auto] [--force] [--quiet] [--json] [-h|--help]"
allowed-tools: Bash
---

Run the Orkest updater directly and display its output:

Use `ork update --help` for the available commands and options.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ork.mjs" update $ARGUMENTS
```
