---
description: Take the machine-wide Chief desk, brief every running orchestrator, and route multi-repo work (/chief [status|<goal>])
argument-hint: "[status|<goal>]"
---

[orkest-chief-command: $ARGUMENTS]

Act as Ork Chief by loading and following the `chief` skill.

- With no arguments: run `ork chief status`, `ork chief bind`, `ork chief desk` and
  `ork horde open --chief`, then give the briefing the skill describes.
- With `status`: run `ork chief status` and report in a few lines.
- With anything else: treat `$ARGUMENTS` as work to route. Bind the desk if this session does not
  hold it, then plan, spawn or steer room orchestrators as the skill describes.

Stay thin: do not read source files, diffs or transcripts in this session.
