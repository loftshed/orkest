"""Transactional changelog access through Orkest's qualified SQLite runtime."""

import json
import subprocess

import room_store


class OutboxError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _call(store, command, **request):
    bridge = room_store._bridge().with_name("outbox-store.mjs")
    result = subprocess.run(
        [room_store._node_binary(), str(bridge), command, str(store)],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        raise OutboxError(result.stderr.strip())
    return json.loads(result.stdout)


def local_stream(store, scope):
    return _call(store, "local_stream", scope=scope)


def read_page(store, *, scope, origin, epoch, after, limit, max_bytes):
    return _call(
        store, "read_page", scope=scope, origin=origin, epoch=epoch, after=after, limit=limit, max_bytes=max_bytes
    )


def read_cursor(store, *, peer, scope, origin, epoch):
    return _call(store, "read_cursor", peer=peer, scope=scope, origin=origin, epoch=epoch)


def apply_page(store, *, peer, scope, page):
    return _call(store, "apply_page", peer=peer, scope=scope, page=page)


def read_checkpoint(store, *, scope, origin, epoch, checkpoint=None, after=0, limit, max_bytes):
    return _call(
        store,
        "read_checkpoint",
        scope=scope,
        origin=origin,
        epoch=epoch,
        checkpoint=checkpoint,
        after=after,
        limit=limit,
        max_bytes=max_bytes,
    )


def read_checkpoint_progress(store, *, peer, scope, origin, epoch):
    return _call(store, "read_checkpoint_progress", peer=peer, scope=scope, origin=origin, epoch=epoch)


def apply_checkpoint(store, *, peer, scope, page):
    return _call(store, "apply_checkpoint", peer=peer, scope=scope, page=page)


def read_view(store, *, origin, epoch, scope, kind, entity):
    return _call(store, "read_view", origin=origin, epoch=epoch, scope=scope, kind=kind, entity=entity)


def is_exportable_scope(scope):
    return _call("", "is_exportable_scope", scope=scope)
