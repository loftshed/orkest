---
description: Take the machine-wide Chief desk, brief every running orchestrator, and route multi-repo work (/chief [status|<goal>])
argument-hint: "[status|<goal>]"
---

[orkest-chief-command: $ARGUMENTS]

Act as Ork Chief by loading and following the `chief` skill.

- With no arguments: run `ork chief status`, `ork chief bind`, `ork chief desk` and
  `ork horde open --chief`, then give the briefing the skill describes.
- With `status`: run `ork chief status` and report in a few lines.
- With anything else: treat `$ARGUMENTS` (and follow-up turns) as work or codebase/design
  questions to route. Bind the desk if this session does not hold it, answer `status` questions
  directly, send read-only `--kind question` prompts straight to the owning room orchestrator (or
  run a read-only `consult`) without asking permission first, and plan, spawn or steer rooms as the
  skill describes.

Stay thin: do not read source files, diffs or transcripts in this session; route code questions to
the owning orchestrator or a read-only consult instead.
