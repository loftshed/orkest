# Current work notes

Keep one short card about the work you are doing. It survives your mailbox presence ending, so another
agent can see where you stopped. This is saved context, not permission to take over or proof that the
previous agent has stopped writing.

Use `focus` at task start and update it at meaningful checkpoints with optional fields:

- `done`: last verified result, at most 160 characters.
- `next`: the next concrete action, at most 240 characters.
- `blocker`: an unresolved dependency or question, at most 160 characters.
- `refs`: a commit, PR, file or log reference, at most 240 characters.
- `status`: `active`, `blocked` or `complete`.

The task title is limited to 200 characters. Owner, checkout, branch and update time are recorded
automatically. Keep the title stable while updating progress. Changing it starts a fresh card and clears
the old details. Omitted fields stay as they were for the same title; an empty string clears a field.
A blank or whitespace-only task title is rejected, including through the CLI.

```text
focus(text="Repair export", done="Serializer fixed; 6 focused tests pass",
      next="Review PR #8", refs="PR #8, commit abc123", status="active")
tasks()
```

The CLI equivalents are `mailbox focus --text 'Repair export' --done '6 focused tests pass'
--next 'Review PR #8' --refs 'PR #8, commit abc123'` and `mailbox tasks`. Read notes on demand when
resuming or coordinating. They are not inserted into every hook or sent as messages, and updates do
not wake anyone. Lists are paginated and project-scoped unless `scope="cross-project"` is explicit.
Pages default to 10 cards and cap serialized card data at 12 KiB, so a page can contain fewer than
`limit` cards. Continue at `next_offset` while `has_more` is true. Repository matching metadata stays
in storage; results include only the owner identity and work context needed for the handoff.

Each session keeps only its latest card per project, replacing prior text. Notes expire 30 days after
their last update and are removed by `mailbox prune`. An absent owner is shown as “not present”, never automatically marked complete or
available for takeover. Before continuing, verify the checkout, commit, dirty files and current
ownership. Use the existing team handover rules when the task is managed by a coordinator.

Save notes before a likely interruption and after useful progress. A sudden timeout can leave the
last checkpoint stale; no system can reconstruct work that was never saved.

## When an agent disappears

The HTTP mailbox daemon checks presence every 15 seconds. A confirmed process exit or reused process ID
produces a different notice from expired presence, which does not prove the agent stopped. Shared-host
conversations still use the existing presence timeouts; a running host cannot prove an individual
conversation is alive or dead.

For an unfinished task, one compact notice goes to live peers in the same project and task channels.
Without channels, it goes to other channel-less peers in the same checkout. Live senders of unread
direct requests or requests read within the last 24 hours but never answered also receive a notice.
Cross-project requesters receive only the delivery status, never the saved task context. Completed
tasks do not trigger team notices.

Notices wait for the recipient's next turn or inbox read. They do not wake agents, extend a turn,
change task status or transfer ownership. They point to the saved task card, whose checkout and
progress must be checked before resuming work. Delivery survives daemon restarts and does not repeat
an acknowledged notice. Local delivery receipts expire after seven days.

Ordinary peer discovery also detects disappearance, so it cannot silently remove the evidence before
the daemon sees it. In stdio-only mode, discovery or pruning supplies that check; there is no background
timer. A normal `SessionEnd` keeps its existing unread-message notice; `/clear` keeps its successor
handoff instead of announcing a crash.
