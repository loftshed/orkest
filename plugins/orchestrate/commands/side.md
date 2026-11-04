---
description: Launch or park a side mission from the current tab without derailing your main task (/side [--later|--issue|--investigate] <idea>)
argument-hint: "[--later|--issue|--investigate] <idea>"
---

[orkest-side-command: $ARGUMENTS]

When the `/side` turn hook has already dispatched or parked this side mission (shown in the `[orkest-side-dispatched]` hook context above), reply with a single short confirmation line and **do not call any tools** so the main conversation context stays clean.

If the turn hook did not run (for example, in a harness without `UserPromptSubmit` / `PreInvocation` hooks), run:

```bash
node "${CLAUDE_PLUGIN_ROOT:-plugins/orchestrate}/lib/side.mjs" $ARGUMENTS --cwd "$PWD" --json
```

and report the result in one concise line.
