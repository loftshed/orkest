# Coordination changelog recovery

Orkest stores the local changelog in the mailbox root's `rooms.db`. Room writes, native session hints and their events commit together. A room's local record retains its full contents. A paired host receives its room ID, lifecycle, member count and removal state. The public stream scope is `room:ROOM_ID`. A remote observation in the Chief overview carries no local execution authority.

Run the migration audit before a scheduled cutover. Stop earlier writers during the maintenance window. A previous release can still write its independent mailbox files, and an existing session may retain its previously loaded binary. Keep the previous checkout and data root available during validation.

```sh
node src/bin/outbox-migrate.mjs audit "$MAILBOX_ROOT"
```

Opening a version 1 or version 2 room database with the new writer saves a consistent pre-upgrade image in a new private `rooms-before-outbox-*/rooms.db` directory under the mailbox root. The migrator holds the source writer lock during this copy. The audit counts regular, shared and unsupported legacy room inputs. The importer reads regular JSON through a verified descriptor, preserves hard-linked originals and skips symbolic links. Archived single-link files retain a digest-tracked backup. Check the old room count, post-upgrade count, inbox IDs, pending work and native session membership before directing clients to the upgraded store.

To export current room records for a previous release, use a new destination directory. The command preserves the source. Its output reports the room count and the last included local event cursor.

```sh
node src/bin/outbox-migrate.mjs export-rooms-v2 "$MAILBOX_ROOT" "$NEW_DIRECTORY"
```

The destination contains a version 2 `rooms.db` for the older room reader and `post-cutover.sqlite`, a complete snapshot of the upgraded database at the same cursor. Keep both files. The room export covers room records and the import ledger. New mailbox or Foundry records from other store extensions require the corresponding domain export before a whole-installation downgrade. Keep later activity in the original root available for reconciliation.

Pass `--expected-revision N` to `room-store.mjs put`, `set-meta` or `delete` to require the observed room summary sequence. A stale request reports the required revision, and a nonowner reports its owner origin and epoch. An operator can route the command to the owner with the observed revision. Supply a stable `--operation-id` on retried commands. The owner returns its original durable result when the request matches and rejects a conflicting reuse of the ID. A changed epoch requires separate pairing.

For a room-bound Foundry write, pass the observed `foundry.transition` view's `seq` as `expectedRevision` to `writeFoundryState`. Use zero for the first transition. Once a paired origin owns the room, run its Foundry commands on that origin. A separate checkout on a receiving host cannot claim the same room by choosing a different local worktree path. The owner checks the transition revision inside the write transaction, including for private metadata edits. Reuse the same `operationId`, patch, room, and revision to retrieve the original result after a lost response. A different request with the same ID returns `content_conflict`. Earlier development profiles that recorded only operation revisions report `legacy_operation_receipt_unavailable` for those IDs. Inspect the current state before issuing a new command.

Schema 10 installs the event projection as a SQLite trigger. Native hooks commit validated peer registrations and updates, their local event and any opted-in presence observation in one transaction. Acknowledging an existing inbox item commits its read timestamp, private event and local view together. A failed acknowledgement leaves the item available for a later hook. New mail, migration and other operations use the standard mailbox writer. Existing schema 9 roots upgrade on the next standard writer access.

Monitor publishes sanitized quota observations when its configuration provides `replicationScope`. Set the value to the scope authorized for the intended peer. Each sample contains provider, observation time, freshness and quota windows. Account directories, command-line arguments and profile labels stay local.

A host can publish opaque peer presence in an explicitly configured `ORKEST_PRESENCE_SCOPE`. A receiver expires presence after two minutes and marks quota stale after fifteen minutes. Both age from the earlier of the source observation and the first receipt of that event. Replayed data does not extend either lifetime. A backward receiver clock change marks the observation stale.

Incremental replication serves the most recent 4,096 positions per origin and scope. Older cursors use a checkpoint of the most recent event for each entity and kind, including tombstones. An active checkpoint pins its tail for 24 hours, including events appended after the checkpoint was opened. The receiver expires abandoned staging after 24 hours of inactivity on the next store access. The receiver stages chunks and switches its projection and cursor in a single transaction at completion. The source retains older events locally for audit and rollback.

For a combined rollback with earlier file-based clients stopped, run `outbox-migrate.mjs export-v2 ROOT NEW_CONTAINER`. Point the previous client at the returned `NEW_CONTAINER/ready` root. The exporter reserves a fresh private container, writes all domains under `incomplete`, and publishes `ready` after the export succeeds. An interrupted attempt leaves its partial data available for inspection. Retry with a new container.

The full SQLite image, v2 room database, mailbox peer/inbox rows, Chief desk and acknowledgement transactions, and Foundry manifest share the reported local cursor. File-only Chief or mailbox data is copied from the stopped previous writers. Unsupported file types abort publication. Foundry records are exported under `foundry-rollback`; its manifest names the original Git administration paths for a separately scheduled restoration. Retain the original root and compare `rollback.json` with the intended cutover inventory before starting previous clients.

While earlier writers are stopped, the combined export also copies file-backed mailbox aliases, delegation records, channels and their operation journals, cleared-session records, consultation and continuation requests, diff marks, presence history, progress, swarm briefs, task notes, work boards, Chief bindings and mission artifacts. The report counts these files under `retainedFiles`. Mission artifacts preserve their recorded paths. Regenerate completion hooks for the selected rollback root before resuming a mission.

Pending wake intents and notification receipts survive rollback. Live Antigravity control credentials, generated Chief hooks, top-level process locks, and the separate mailbox daemon runtime stay on the source machine. Restart the legacy client and reattach its wake routes after selecting the restored root. The previous room reader rebuilds its room index from the exported database.

## Rebuild native, Chief and room projections

Schema 12 records changes to the coordination tables in each originating SQLite transaction. Each changed row contributes a private entry to a SHA-256 chain. These entries include private peer records, message content, Chief acknowledgement journals, Foundry operation IDs, room revisions, native session hints, replication cursors and observation times. SSH continues to serve only the scoped public outbox. Store recovery material with the same access controls as the mailbox root. Schema 12 preserves the pending local Chief notification queue and starts capturing subsequent queue changes. After upgrading a schema 11 store, take a fresh private checkpoint before relying on tail recovery. Earlier checkpoints retain their own capture point.

Before cutover, stop previous clients and create a checkpoint from an intact root. This command upgrades supported older databases and copies the committed database with SQLite's online backup API. Record the returned SHA-256 separately and retain the checkpoint outside the original root. A stored checksum identifies the checkpoint the operator trusts.

```sh
node src/bin/projection-recovery.mjs checkpoint "$MAILBOX_ROOT" "$NEW_CHECKPOINT_DIRECTORY"
```

To recover after projection loss, supply the returned database and its pinned digest. The recovery command reads one committed snapshot of the remaining local history. It verifies sequence continuity, the digest chain, row preconditions, schema version, SQLite integrity and foreign keys. A complete result is published under `NEW_RECOVERY_DIRECTORY/ready/rooms.db`. Failures leave private incomplete work for inspection. Use a fresh destination for each attempt.

```sh
node src/bin/projection-recovery.mjs rebuild "$MAILBOX_ROOT" "$CHECKPOINT_DB" "$CHECKPOINT_SHA256" "$NEW_RECOVERY_DIRECTORY"
```

The result reports the local history sequence and final outbox cursor. Verify the recovered database in a private copy of the profile with the profile's mailbox cutover markers, journal and other file-backed state. Before an operational switch, quiesce the writers, repeat the rebuild at the final committed cursor, and preserve the entire original root with its database, WAL and SHM files. Use a separate restored root so sidecars from the damaged database cannot be opened against the recovered database. A v10 native hook refuses to mutate a v11 root. Return to the preserved root if validation fails.

The original history and a trusted pre-loss checkpoint are required for tail recovery. An external checkpoint still covers its own capture point if the source history is lost. The private history is append-only and consumes local storage in proportion to changed row contents. Checkpoints and recovery outputs contain sensitive data; keep them on protected storage with sufficient free space.

## Project ownership of room scopes

A room ID identifies one scope within a local store. Its private room record retains the local Git common directory identity across linked worktrees and room removal. Standalone directories use their directory identity. Recreating the same ID for a different project, or reclaiming a tombstone whose project is unknown, fails with `room_project_conflict`. Give the unrelated project a fresh room ID and pair its new scope explicitly. The existing peer grant continues to refer to its original project. Directory identities and paths stay local.

Earlier room records can contain a pathname without a verified project identity. A directory may have moved or been replaced there since the grant was issued. A first update of such a record returns `room_project_unverified`; the original room and its historical stream remain readable, and the room can be retired. Resume in a fresh room and explicitly pair its scope.

## Reconciliation of external effects

The Smelter records the target ref, previous commit and approved head before a local fast-forward. A retry confirms a landed commit from the ref's ancestry. For a PR it records separate push and create phases. Repeating the same non-forced push is safe. After a possible create, an empty GitHub listing leaves the operation unverified. Retry reconciliation after GitHub exposes the PR. Older `creating` markers follow the same conservative rule. A recorded PR number can be verified directly when the listing lags. Configure a single push endpoint for the same repository as the fetch endpoint.

Opted-in Chief mission and Foundry PR transitions record a local notification intent in the same SQLite transaction as their source change. A later `ork chief reconcile ROOM` resumes the handoff to the approved profile's existing delivery queue. The pending intent lifetime is 24 hours. The sink receives the stable ID in the payload and, for HTTPS, the `Idempotency-Key` header. A receiver that acts before its acknowledgement is lost can receive another attempt with the same ID and should persist that ID alongside its effect. Command sinks receive it in `ORK_CHIEF_EVENT_ID`.
