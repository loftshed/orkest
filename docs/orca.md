# Orca integration

[Orca](https://github.com/stablyai/orca) runs Orkest's commands (`ork`, `consult`, `ork gate`, the
peer mailbox) in its terminals as they are. The root [`orca-plugin.json`](../orca-plugin.json) adds
what needs Orca's terminal API: the Swarm View as a split beside the coordinator, live preview and
focus of agent terminals, restoring the view after a restart, an **Orkest** sidebar panel, and a quota
item in the status bar.

## Install

In Orca, install the plugin from this repository's Git URL (or the checkout folder) and approve its
capabilities. It needs Orca 1.4.259 or newer and runs as a `trusted-worker` with no hooks.

- `Mod+Shift+O` or **Orkest: Toggle Swarm View** opens the room's Swarm View in a split to the right
  of the coordinator, or closes it. **Open** and **Close** are separate commands too.
- **Orkest: Open Chief View** opens the machine-wide Chief view the same way.
- The **Orkest** panel in the right sidebar lists the focused workspace's rooms and agents and has
  buttons to open, toggle or close the Swarm View and to open Chief. With several rooms, pick one
  first; only rooms bound to the focused workspace are offered. The terminal Swarm View is
  unchanged.
- The status bar shows the lowest remaining quota per account from `monitor json`, every 60 seconds,
  using Monitor's own freshness rules. `!` marks a stale figure (old data, a failed refresh or a
  rollover waiting for the provider), `?` an account with no numbers, and `☠` a limit that is used
  up. Two accounts of one provider show under their own names; the tooltip has each label and every
  window. When a refresh fails the last good figures stay, marked `stale`. Press it to refresh.
- Inside an Orca terminal, `ork swarm open`, `ork swarm close` and `/swarm` split and close through
  the Orca CLI in the same way.

Keep Orca's own `orchestration` skill and experimental orchestration setting off, so agents have one
way to delegate: `ork`. The `orca-cli` skill is fine.

## How it works

- Each agent hook records the Orca terminal the agent runs in (`ORCA_TERMINAL_HANDLE`,
  `ORCA_PANE_KEY`) on its mailbox peer. Horde View previews that terminal with
  `orca terminal read --screen` and focuses it with `orca terminal switch`.
- The worker finds `node` and the Orca CLI on a derived `PATH`: Orca's reduced one, then
  `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, and starts its children with it. It
  never changes its own environment.
- The worker records the terminals and agent sessions it sees in `orca-terminals-v1.json` and each
  open view in `orca-views-v1/` under the Orkest cache (`~/.cache/orchestrate`).
- Quitting the view with `q`, or closing its pane, marks it closed. A view still open when Orca
  stops is reopened beside its coordinator when the worker starts again, but only when its room is
  still listed, not archived, and bound to that workspace. A room that is archived or gone closes
  the record; a room lookup that fails is retried on the next start. A close that arrives while a
  view is still opening wins.

## Older hosts

The plugin needs Orca 1.4.259 or newer. Host API 1.10 is a protocol version, not an app version, and
the worker checks each optional method before it calls it:

- No `terminal.split`: the Orca CLI splits the pane; with no CLI either it opens a terminal tab with
  `terminal.create`. A host without `terminal.create` gets a message to update Orca.
- No `terminal.close`: the Orca CLI closes the pane.
- No panels API: the commands, status bar and events work without the sidebar panel.
- No `statusBar.update` (web or older clients): the quota item is skipped.

## Troubleshooting

- **Nothing happens on Linux:** `/usr/bin/orca` is the GNOME screen reader, so Orkest never runs it.
  Put Orca's `orca-ide` on `PATH`, or set `ORCA_CLI_COMMAND` to the Orca CLI.
- **"No Orkest swarm is bound to this workspace":** run `ork swarm open` once from the coordinator,
  so the room records its Orca terminal.
- **The view opens as a tab, not a split:** the worker found no Orca CLI on its `PATH`, so it used
  `terminal.create`. Orca starts plugin workers with a reduced environment.
- **A custom `ORCHESTRATE_HOME`:** the worker only sees `HOME`, so it uses the default cache. Keep
  the default when you use the plugin.
- **A second view after a restart:** Orca restored the old pane under a new terminal ID. Close the
  extra pane.
