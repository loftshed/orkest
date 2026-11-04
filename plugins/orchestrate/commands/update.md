---
description: Check for and apply fast-forward Orkest updates, refresh mailbox hooks, and migrate legacy agent-executor state
argument-hint: "[run|check|status|enable|disable] [--auto] [--force] [--quiet] [--json]"
allowed-tools: Bash
---

Run the Orkest updater directly and display its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ork.mjs" update $ARGUMENTS
```
