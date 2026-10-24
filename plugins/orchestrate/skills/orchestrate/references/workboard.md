# Shared workboard

Start with `board` for shared work. It shows interactive work, coordinator-managed tasks and older
session recovery notes in one place. Each entry names its source and available action; agents never
maintain the same status in two ledgers. The board does not dispatch agents or run a supervisor loop.

Read `board` when joining the task, finishing a piece or handling an explicit handoff. Choose a ready
item within your assigned scope, then claim its current revision before working. A failed claim means
another agent may own it: reread before deciding what to do. Do not poll an empty board or invent work
to stay busy. Native tools still handle communication and child-agent execution inside a harness;
they do not require a duplicate shared work record.

Interactive items use `work` for claims and checkpoints. Coordinator entries read their existing
`task.json` directly and give the exact command for the next action. Their execution, evidence checks
and acceptance remain with that backend; `work` cannot bypass them. New coordinator tasks register
automatically. Historical tasks in arbitrary directories become visible when next opened with a
coordinator command, including `show`; the board does not crawl the filesystem to guess their locations.

Older session notes appear as read-only `legacy-note` entries. Create an interactive item only when
continuing that work. `tasks` and the progress fields on `focus` remain for older clients; do not use
them for new work. Plain `focus` sets only the session caption and channels, without creating a
parallel task card.

## Small records, explicit transitions

Use `work` with an `action`. The CLI is `mailbox work ACTION`; read with `mailbox board`.
All calls use the caller's registered session and current project. Creation requires a stable `key`;
every later mutation requires the `item` ID and its exact `revision` from the latest response.

| Action                               | Meaning                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`                             | Record a short `title`, `scope`, `acceptance` criteria and optional existing `dependencies`. The creator is the default integrator; an existing project peer can be named instead. |
| `claim`                              | Claim an unowned item whose dependencies have been accepted.                                                                                                                       |
| `checkpoint`                         | Save a short `next`, `blocker` or `evidence` update. Blocking retains ownership.                                                                                                   |
| `submit`                             | Supply artifact `evidence` and a `verification` summary for review. This is not acceptance.                                                                                        |
| `accept`                             | The integrator accepts the exact submitted revision.                                                                                                                               |
| `request_changes`                    | The integrator returns the submitted work to its owner with a `note`.                                                                                                              |
| `release`                            | The owner gives up the claim while preserving the checkpoint.                                                                                                                      |
| `recover`                            | The integrator explicitly reconciles an absent owner's work and reopens the item with a `note`.                                                                                    |
| `offer_transfer` / `accept_transfer` | The current integrator names a `successor`; that peer explicitly accepts the handoff.                                                                                              |

Creation retries with the same key and identical fields return the existing item. Reusing a key with
different fields fails. Revision conflicts never silently overwrite work: read the returned/current
item and decide again. Scope, acceptance criteria and dependencies are immutable. Accepted items are
terminal; corrections belong in a new follow-up item. Dependencies must already be interactive items
in this project. Dependencies on coordinator or legacy entries are not supported.

```text
work(action="create", key="export-parser-v1", title="Repair export parser",
     scope="Parser and its focused tests", acceptance="Empty exports parse without failure")
board()
work(action="claim", item="<returned-id>", revision=1)
work(action="checkpoint", item="<returned-id>", revision=2,
     next="Check empty-input regression", evidence="branch fix/export-parser")
```

Use the actual returned revision for every next call. The integrator checks the result against the
acceptance criteria and arranges any shared integration check once. Being named integrator grants no
extra permission to merge, deploy, spend quota or widen the user's request.

Updates send no messages and wake nobody. Send a separate, substantive handoff or review request
through the appropriate native or cross-harness route when another agent needs to act. Ordinary
checkpoint edits need no announcement. A session's `focus` caption can name its item ID; progress
belongs on the item, without a second independently maintained status.

## Recovery and limits

A claim is a coordination agreement, not a filesystem lock. Different items can still overlap in
files, and an old process can continue writing after its mailbox presence disappears. Before
`recover`, inspect the checkout, dirty changes, surviving children and any coordinator lease. Record
what was reconciled. Recovery refuses a currently present owner and fences old mailbox revisions;
it cannot stop arbitrary shell commands.

The board shows when an owner or integrator is absent. No timeout automatically releases claims or
transfers responsibility. Arrange an integrator transfer before leaving. Reassignment after the
integrator has already disappeared is deliberately unsupported in this version; a trusted user
authorization mechanism remains separate work. Session names and reconciliation notes are local
coordination metadata, not tamper-resistant proof of user approval.

Reads share one 12 KiB page budget across all sources. Interactive storage retains at most 1,024 items
and 4 MiB. The coordinator index holds at most 1,024 pointers and 1 MiB, without copying task state.
Capacity errors refuse growth rather than deleting work. A failed index update leaves the coordinator's
saved task intact, reports a warning, and retries registration when that task is next opened.
Unfinished interactive work and accepted prerequisites never silently expire. Legacy notes keep their
existing 30-day retention. This first version has no automatic archival or cleanup command.
