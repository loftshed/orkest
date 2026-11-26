# Changelog

## 0.101.2

- fix(steer): resume a finished job and report a refused resume (#284)

## 0.101.1

- fix: name Orkest commands with each harness's prefix (#283)
- fix(codex): keep the agent bar's spacing in Codex and center its icon (#282)
- fix(setup): load the zsh-only shell setup only from zsh

## 0.101.0

- feat(codex): show the Orkest agent bar in Codex's custom status line (#279)
- fix(rooms): keep room identity stable across reboots and let close skip the check (#278)

## 0.100.0

- feat(handoff): spend expiring quota to zero instead of handing off early
- feat(rooms): send corrections from ork hall dispatch and extend task deadlines
- fix(swarm): keep a Swarm View closed with Herdr's own close-pane closed
- fix(tests): keep the live agent session out of every test suite

## 0.99.2

- fix(monitor): keep owner-only MCP configs owner-only and skip identical registrations
- fix(update): give the post-install step minutes and record the update when it fails

## 0.99.1

- fix(quota): label the quota line, refresh it per turn, and guard low pools (#262)

## 0.99.0

- feat(orchestrate): hand off before quota runs out to a visible successor (#261)
- fix: open Swarm View only on request and keep closed views closed (#260)

## 0.98.2

- fix(orchestrate): render handoff notices from the event at delivery
- fix: point coordinator and lead briefs at the adapter swarm.md
- fix(tests): delete test fixtures by default so runs stop filling /tmp

## 0.98.1

- refactor: finish harness adapters and retire transitional Python paths (#254)

## 0.98.0

- feat: coordinate local state, recovery and scoped peer replication (#253)

## 0.97.1

- refactor: move Python runtime and shared registries out of the skill (#251)

## 0.97.0

- feat(monitor): adapt account probe deadlines and back off repeated failures (#252)

## 0.96.1

- refactor: move Monitor and Orkest into a shared Node runtime (#250)

## 0.96.0

- feat: provision worktrees and reconcile their pull requests (#249)

## 0.95.0

- feat: add workspace-aware Orca panels and Herdr actions (#248)

## 0.94.1

- refactor: install commands and skills from canonical adapter files (#241)

## 0.94.0

- feat: retire the Claude marketplace and release Orkest as one product (#240)

## History

Orkest continues the Orchestrate version series. Earlier releases are recorded in
[the Orchestrate changelog](plugins/orchestrate/CHANGELOG.md) and
[the Monitor changelog](plugins/monitor/CHANGELOG.md). Their `orchestrate--vX.Y.Z` and
`monitor--vX.Y.Z` tags still resolve.
