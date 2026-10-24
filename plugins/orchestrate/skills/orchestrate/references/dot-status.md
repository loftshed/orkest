# Ask Dot for agent updates

Dot can use its local executor to read Orkest's existing workboard. No separate agent registry,
mailbox, credential or listener is needed. The status view does not send messages, register the
observer, acknowledge mail or change ownership. Run it from the Git project you want to observe:

```sh
python3 ~/.agents/skills/orchestrate/scripts/run_agent.py mailbox board \
  --view status --format json
```

Dot should summarize the reported focus, presence, work state, blockers, next actions and verification
evidence. Include uncertainty and the recorded timestamps. A busy process is not proof of progress;
an absent agent is not proof of completion. A checkpoint can be stale. The returned `observedAt` is
when the snapshot was read, while `lastSeenAt` and item `updatedAt` describe the underlying records.

For a selected agent, pass `--agent` with its stable session ID or full displayed name. Prefer the
session ID for later calls because names can change. Use `--channel` to follow a task channel's
members and their associated work. This covers teams or swarms using mailbox channels, not every
arbitrary host grouping. Keep the working directory and filters unchanged while following updates.

```sh
python3 ~/.agents/skills/orchestrate/scripts/run_agent.py mailbox board \
  --view status --channel export --format json
```

Pages share a 12 KiB budget and default to 10 combined agent/work records. Follow `next_offset` while
`has_more` is true; up to 50 records can be requested with `--limit`. Summaries shorten long text.
Use the ordinary `board --item ID` view for full work details. Coordinator records with no agent or
channel assignment appear in the project-wide view; filtered views cannot invent that association.
Do not broaden project scope merely because a selected agent has no matching record.

## Wait for a change

Use the returned `cursor` to wait locally for one update:

```sh
python3 ~/.agents/skills/orchestrate/scripts/run_agent.py mailbox board \
  --view status --channel export --since RETURNED_CURSOR --timeout 300 --format json
```

The command compares local snapshots every two seconds, without model calls. It returns once with
`status: changed`, or `timed_out` after the requested wait. The maximum wait is 600 seconds. It keeps
no subscription or observation log. Heartbeats and timestamp-only changes do not trigger an update;
selected changes outside the displayed page do. Read the remaining pages when a change occurs.
Short transitions between observations can be missed; this is a status observer, not an event archive.

Dot can report that result while servicing the user's monitoring request. This does not install a
background push service or make an inactive Dot session deliver notifications. Longer-lived delivery
requires a supported Dot scheduling or completion mechanism. A timeout alone does not request another
model turn. Cancellation stops the local wait without consuming mail or altering work.

## Existing MCP clients

Clients that already expose `peer-mailbox` can call `board(view="status", agent="SESSION")` or
`board(view="status", channel="export")`. HTTP uses the client's existing registered session; the
CLI observer requires no registration. Local change waits are available through the CLI only.
The normal board/work tools still own interactive coordination. Status observation grants no role,
delegation, merge permission or authority to send a message.

The CLI reads the local store directly. It does not require a running HTTP daemon for a status read.
HTTP MCP clients do require the daemon and a refreshed tool catalog after an upgrade. Credentials stay
local. This path is for Dot's local executor; it does not expose the mailbox to a cloud worker.
