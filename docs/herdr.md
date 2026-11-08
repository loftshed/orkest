# Herdr integration

Inside Herdr, `ork codex`, `ork claude`, `ork agy`, `ork opencode`, and `ork label` launch the agent
directly in its pane. Herdr detects the agent, tracks its native session, and restores its terminal
layout. Orkest keeps the swarm's room, tasks, and mailbox. Attaching to a swarm from inside Herdr
focuses its live Herdr coordinator pane rather than attaching to a private tmux session. Outside
Herdr the same launch commands use a private tmux session for the footer and reattachment.

## Install and open

Run `./plugins/orchestrate/install.sh` from the checkout. With Herdr 0.9.5 or newer, the installer
links the plugin, installs the `herdr` skill across local agent harnesses (`.agents/skills/herdr`,
Claude Code, Codex, Antigravity, and OpenCode), and registers `Ctrl+Alt+S` when the shortcut is
available. `ork update` refreshes the same registration and respects custom shortcuts, disabled
plugins, and installations owned by another checkout. A running client may need a config reload for a
new shortcut. The Claude plugin cache alone does not include the repository's Herdr manifest.

Use `ork swarm open`, `ork swarm close`, or the toggle shortcut from the coordinator. Orkest opens
Herdr's `orkest.swarms` plugin pane with the room ID. Open reuses the existing display, including
after it moves to another workspace. Selecting the pane entrypoint directly uses the room of the
invoking coordinator. In a shared or ambiguous context, open the desired room explicitly.

Preview, focus, and mailbox delivery verify the native conversation at its Herdr endpoint. A
mailbox wake goes to an idle or done agent. If Herdr cannot confirm a submission, the message
stays queued. Orkest reports `<harness icon> <full agent name>` and `<stage> · <task>` as display metadata
guarded by the pane's agent kind, without an expiry. Idle agents keep their labels; Herdr clears the
metadata when the agent exits or changes. Native harness status lines keep drawing their own bar inside Herdr panes; Herdr's labels add to it.
Set `ORK_GLYPHS=nerd` (default), `unicode`, or `ascii` to choose icons. While running inside Herdr, Horde View subscribes to Herdr lifecycle events over the
server socket to invalidate cached state and reconcile on reconnect or `events_lost`.

To inspect Orkest bindings against live Herdr panes without mutating state, run
`python3 plugins/orchestrate/skills/orchestrate/scripts/herdr_swarm_restore.py --inventory`
(optionally `--room <ROOM_ID>`), which reports `pane_existence`, `available_shell`,
`live_agent_conversation`, `executing_worker`, and `accepted_task` for each resource.

## Agent labels and focused status

Inside Herdr, Codex launches with `tui.terminal_title=["thread-title","session-id"]`. Its shared
app-server hooks can find the pane using the final session ID in that title, even without Herdr
environment variables. Discovery checks the configured/default XDG socket file before invoking
Herdr. Missing matches are cached until the next SessionStart; duplicate matches and ambiguous
truncated IDs are rejected. Outside Herdr, Codex keeps its session-only title and tmux footer.

The installer offers these optional settings only on a terminal and preserves explicit settings:

```toml
[ui]
show_agent_labels_on_pane_borders = true
tab_bar_right = [
  { type = "command", command = "ork herdr-status", interval_seconds = 1, timeout_seconds = 1 },
]
```

`ork herdr-status` prints a plain line with the focused pane's icon, agent name, stage, and task.
It uses `HERDR_ACTIVE_PANE_ID` and returns an empty line with exit 0 when no agent matches or Herdr
is slow. Its Herdr lookup times out after 100 ms to keep the command within 300 ms. Labels and work
metadata are capped at 80 characters, retaining the distinguishing suffix. See Herdr's
[tab bar configuration](https://herdr.dev/tui/docs/configuration/) for other status entries.

## Restart and close

Herdr restores the layout on startup. Orkest's startup hook can then restart the display in its
restored pane. Orkest tracks the live terminal ID and the pane label separately. When a cold restart
assigns a new terminal ID, the hook requires a unique saved label and an idle shell or the exact
running view. Busy, missing, renamed, and ambiguous panes are skipped. The hook creates no splits.

Pressing `q`, keyboard Ctrl-C, or `ork swarm close` closes the display and records that choice for
the next restart. The coordinator and workers keep running. Closing a pane through Herdr removes it
from the saved layout. If an older installation has an open view, updating from inside Herdr adopts
it after checking its foreground command. Use `ork swarm close` for a view still running old code.

Herdr can accept a restore command before it starts. Orkest checks the foreground process before
confirming the launch. If Open reports an unconfirmed previous launch, close and reopen the view.

See Herdr's [plugin panes and startup hooks](https://herdr.dev/tui/docs/plugins/) and
[session restore documentation](https://herdr.dev/tui/docs/session-state/).

## Uninstall

`./plugins/orchestrate/uninstall.sh` removes this checkout's plugin registration, managed shortcut,
and its skill links. Swarm records and custom Herdr configuration remain available.
