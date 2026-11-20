# Replicating project state between hosts

Each workstation keeps its own SQLite store. A pull reads a project stream from its origin over SSH and applies a bounded page in a local transaction. Run the pull in both directions to exchange each workstation’s updates. The origin and epoch identify the stream across restarts.

## Choose a scope

A room named `build` publishes its summary under `room:build`. To receive it, use `--scope room:build` on both peer records and on the pull. Monitor publishes quota observations when its configuration includes a `replicationScope` string. For example, setting it to `room:build` makes the opted-in quota observations available alongside that room. Peers can publish presence to an explicitly configured `ORKEST_PRESENCE_SCOPE`. The local mailbox and room record streams and scopes beginning with `local:` are private.

## Pair two workstations

On each workstation, run `ork sync identity --scope PROJECT`. Exchange the two origin and epoch values. Use the same project scope on both sides. Each workstation needs an SSH host alias with the other workstation’s host key already verified and a key dedicated to replication.

On the first workstation, pin the second workstation’s identity and permitted project scopes.

```sh
ork sync pair --peer laptop --host laptop-sync \
  --origin REMOTE_ORIGIN --epoch REMOTE_EPOCH --scope PROJECT
```

On the second workstation, repeat the command with the first workstation’s alias and identity. For example, give that peer the name `desktop`. Bind the desktop’s public SSH key on the laptop to the local peer record using this authorized_keys entry. Substitute the absolute installed path to `ork` and the actual public key.

```text
restrict,command="/absolute/path/to/ork sync serve --peer desktop" ssh-ed25519 PUBLIC_KEY
```

Use the reciprocal entry on the desktop to enable pulls in the other direction. The forced command selects the local peer record. The scope must appear in that record before the server reads the stream. Repeat `--scope` when pairing to allow additional scopes. Peer records must be regular files owned by the invoking user, with user-only permissions (normally 0600) inside their private sync-peers directory (normally 0700). Pairing and serving check these permissions. User-configured symlinks and writable configuration ancestors are rejected. Identical pairing commands are safe to repeat. A changed stream epoch requires deliberate verification and replacement of the peer record in the Orkest config directory under `sync-peers/`.

## Pull and inspect state

```sh
ork sync pull --peer laptop --scope PROJECT
ork sync view --peer laptop --scope PROJECT --kind room.summary --entity ROOM_ID
```

A pull returns the last committed sequence in `through`. If `caught_up` is false, run the same command again. Each invocation processes up to 64 pages by default. Use `--max-pages` to bound work more tightly. Network interruption leaves the durable cursor available for the next pull. When the cursor falls behind the source’s retained page history, the receiver stages a checkpoint and resumes event replay after its high-water mark. `view` returns a replicated entity or JSON `null` when that entity has no projection.

For example, these commands read a room summary and a Monitor observation from the same origin.

```sh
ork sync view --peer laptop --scope room:build --kind room.summary --entity build
ork sync view --peer laptop --scope room:build --kind monitor.quota --entity work-account
```

The sequence number identifies the source observation. For remote presence and quota, the receiver also reports freshness based on the observation time and its first local receipt. A repeated pull of the same event cannot extend its freshness.
