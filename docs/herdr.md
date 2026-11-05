# Herdr integration

Install from a checkout with `./plugins/orchestrate/install.sh`. When Herdr 0.9.5 or newer is
available, setup registers the source manifest through `herdr plugin link`. `ork update` runs the
same setup after updating the checkout. Existing disabled registrations and custom shortcuts stay
unchanged. An installation owned by another checkout is left alone.

Installing only the Claude plugin cache does not include the repository's Herdr manifest. Run the
checkout installer for Herdr integration. Setup reports missing Herdr or an unavailable manifest;
it does not create a shortcut to an unregistered plugin. A newly added shortcut may require Herdr's
normal config reload in a running client.

## Restart and close

Each opened swarm display receives a unique persistent pane label and a server-scoped record in
the Orkest cache. Herdr's startup hook runs after restoring its layout. Orkest finds that label and:

- Leaves an already running view alone, including during live handoff.
- Restarts a view only when its owned pane contains an idle shell.
- Skips busy, ambiguous, renamed, missing, or failed panes. Startup never adds a split.
- Preserves workers and room history; only the display is restored.

Pressing `q`, keyboard Ctrl-C, or `ork swarm close` records deliberate closure. Server shutdown and
terminal teardown preserve restore intent. Closing a pane in Herdr removes it from the restored
layout, so it stays closed too.

Updates run inside Herdr adopt older running views only when their process arguments prove the
exact Orkest executable and room. Already running old code cannot acquire the new `q` handler;
use `ork swarm close` during that transition. Subsequent launches use the new handler.

Herdr acknowledges queued command input before the command starts. Orkest checks the actual
foreground process and prevents duplicate submissions while confirmation is pending. If Open
reports an unconfirmed previous launch, close that swarm view and open it again to retry.

## Uninstall

`./plugins/orchestrate/uninstall.sh` unregisters this checkout's Herdr plugin and exact managed
shortcut, and removes only skill links resolving to this checkout. Custom shortcuts, other
installations, configuration, and saved state remain.

The integration uses Herdr's documented [startup hooks](https://herdr.dev/tui/docs/plugins/#startup-hooks)
and [pane APIs](https://herdr.dev/tui/docs/socket-api/). Cold restarts restore layout rather than
arbitrary processes; see [session restore](https://herdr.dev/tui/docs/session-state/).
