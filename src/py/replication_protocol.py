"""Pull one paired origin's project stream into the local transactional outbox."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from replication_transport import MAX_FRAME_BYTES, ReplicationError

PROTOCOL = "ork.sync.v1"
PAGE_LIMIT = 128
# Leave space for envelope fields and the terminating newline.
PAGE_BYTES = MAX_FRAME_BYTES - 8192
PUBLIC_ERRORS = frozenset(
    {
        "cursor_expired",
        "checkpoint_expired",
        "epoch_mismatch",
        "sequence_gap",
        "content_conflict",
        "unsupported_version",
        "stream_mismatch",
        "local_origin",
        "unauthorized",
        "invalid_request",
        "invalid_page",
        "page_too_large",
        "store_error",
        "owner_conflict",
        "private_scope",
        "unsupported_payload",
        "page_too_small",
    }
)


class SyncError(ReplicationError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Peer:
    name: str
    origin: str
    epoch: str
    scopes: frozenset[str]


def identifier(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 256:
        raise SyncError("invalid_request")
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise SyncError("invalid_request")
    return value


def public_scope(api, value: Any) -> str:
    scope = identifier(value)
    if not api.is_exportable_scope(scope):
        raise SyncError("private_scope")
    return scope


def position(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= 2**53 - 1:
        raise SyncError("invalid_request")
    return value


def serve_request(api, store: Path, peer: Peer, request: dict[str, Any]) -> dict[str, Any]:
    """The SSH key's forced command selects peer. The wire cannot select its own privileges."""
    try:
        if request.get("protocol") != PROTOCOL:
            raise SyncError("unsupported_version")
        scope = public_scope(api, request.get("scope"))
        if scope not in peer.scopes or (request.get("caller"), request.get("caller_epoch")) != (
            peer.origin,
            peer.epoch,
        ):
            raise SyncError("unauthorized")
        op = request.get("op")
        expected = {"protocol", "scope", "caller", "caller_epoch", "origin", "epoch", "op", "after"}
        if op == "checkpoint":
            expected.add("checkpoint")
        if op not in ("page", "checkpoint") or request.keys() != expected:
            raise SyncError("invalid_request")
        stream = api.local_stream(store, scope)
        if stream["origin"] == peer.origin:
            raise SyncError("local_origin")
        if stream["origin"] != request["origin"]:
            raise SyncError("stream_mismatch")
        if stream["epoch"] != request["epoch"]:
            raise SyncError("epoch_mismatch")
        args = dict(
            scope=scope,
            origin=stream["origin"],
            epoch=stream["epoch"],
            after=position(request["after"]),
            limit=PAGE_LIMIT,
            max_bytes=PAGE_BYTES,
        )
        if op == "checkpoint":
            token = request["checkpoint"]
            if token is not None:
                identifier(token)
            data = api.read_checkpoint(store, checkpoint=token, **args)
        else:
            data = api.read_page(store, **args)
        return {"protocol": PROTOCOL, "op": op, "data": data}
    except (SyncError, api.OutboxError) as error:
        code = error.code if error.code in PUBLIC_ERRORS else "store_error"
        return {"protocol": PROTOCOL, "error": code}


async def pull(
    api,
    store: Path,
    peer: Peer,
    scope: str,
    request: Callable[[dict], Awaitable[dict]],
    *,
    max_pages: int = 64,
) -> dict[str, Any]:
    if public_scope(api, scope) not in peer.scopes:
        raise SyncError("unauthorized")
    if type(max_pages) is not int or not 1 <= max_pages <= 4096:
        raise SyncError("invalid_request")
    local = api.local_stream(store, scope)
    if peer.origin == local["origin"]:
        raise SyncError("local_origin")
    source = {"scope": scope, "origin": peer.origin, "epoch": peer.epoch}
    cursor_args = dict(peer=peer.name, **source)
    cursor = position(api.read_cursor(store, **cursor_args))
    snapshot = None
    use_checkpoint = False
    reset_attempted = False
    complete = False
    pages = 0
    for _ in range(3 * max_pages + 2):
        if pages == max_pages:
            break
        op = "checkpoint" if use_checkpoint else "page"
        after = position(snapshot["through"]) if snapshot else (0 if use_checkpoint else cursor)
        query = dict(
            protocol=PROTOCOL, caller=local["origin"], caller_epoch=local["epoch"], op=op, after=after, **source
        )
        if use_checkpoint:
            query["checkpoint"] = snapshot["checkpoint"] if snapshot else None
        reply = await request(query)
        if reply.get("protocol") != PROTOCOL:
            raise SyncError("unsupported_version")
        if "error" in reply:
            error = reply["error"]
            if error == "cursor_expired" and not use_checkpoint:
                use_checkpoint = True
                snapshot = api.read_checkpoint_progress(store, **cursor_args)
                continue
            if error == "checkpoint_expired" and snapshot and not reset_attempted:
                snapshot = None
                reset_attempted = True
                continue
            raise SyncError(error if isinstance(error, str) and error in PUBLIC_ERRORS else "invalid_page")
        page = reply.get("data")
        if reply.get("op") != op or not isinstance(page, dict) or any(page.get(k) != v for k, v in source.items()):
            raise SyncError("stream_mismatch")
        if position(page.get("after")) != after or type(page.get("more")) is not bool:
            raise SyncError("invalid_page")
        through = position(page.get("through"))
        if through < after or (page["more"] and through == after):
            raise SyncError("sequence_gap")
        pages += 1
        if use_checkpoint:
            token = identifier(page.get("checkpoint"))
            if snapshot and snapshot["checkpoint"] != token:
                raise SyncError("invalid_page")
            api.apply_checkpoint(store, peer=peer.name, scope=scope, page=page)
            snapshot = {"through": through, "checkpoint": token}
            if not page["more"]:
                use_checkpoint = False
                snapshot = None
                cursor = position(api.read_cursor(store, **cursor_args))
        else:
            result = api.apply_page(store, peer=peer.name, scope=scope, page=page)
            cursor = position(result["through"])
            if not page["more"]:
                complete = True
                break
    return dict(peer=peer.name, through=cursor, caught_up=complete, **source)
