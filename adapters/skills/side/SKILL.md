---
name: side
description: Dispatch or park a side mission from the current tab without derailing the active task or cluttering the main conversation context. Triggers on "/side", "ork side", "side:", or "!side".
---

[orkest-side-command]
When the `/side` turn hook has already dispatched or parked this side mission, confirm the result in one short line and do not call any tools. Otherwise run `ork side <idea>` (`--execute`, `--investigate`, `--later`, or `--issue`) and report the result in one short line.
