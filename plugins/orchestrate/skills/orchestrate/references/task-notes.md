# Legacy session work notes

New work uses the [workboard](workboard.md). These cards remain for older clients and appear as
read-only legacy entries in `board`. Do not maintain a card alongside an interactive item. A plain
`focus` call changes the session caption without creating a card; explicit legacy progress fields
still save one for compatibility. A card is context, not permission to take over or proof that the
previous agent stopped writing.

Older clients save a card through `focus` with these fields:

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

Older clients should save their note before a likely interruption; new work uses board checkpoints. A sudden timeout can leave the
last checkpoint stale; no system can reconstruct work that was never saved.
