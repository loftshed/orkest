"""Explicit peer pairing and one-shot changelog synchronization."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
from pathlib import Path

import outbox_store
import runtime_paths
from replication_acl import read_pair, save_pair
from replication_protocol import Peer, SyncError, identifier, public_scope, pull, serve_request
from replication_transport import SSH_ALIAS, encode_frame, exchange, read_ssh_request


def alias(value: str) -> str:
    if not SSH_ALIAS.fullmatch(value):
        raise argparse.ArgumentTypeError("expected an alphanumeric SSH alias")
    return value


def load_peer(file: Path) -> tuple[Peer, str, Path | None]:
    try:
        item = read_pair(file)
    except FileNotFoundError:
        raise SyncError(f"peer {file.stem!r} is not paired") from None
    scopes = item["scopes"]
    if not isinstance(scopes, list) or not scopes or item.get("schema") != "ork.sync.peer.v1":
        raise SyncError("invalid_peer")
    peer = Peer(
        file.stem,
        identifier(item["origin"]),
        identifier(item["epoch"]),
        frozenset(public_scope(outbox_store, scope) for scope in scopes),
    )
    return peer, alias(item["host"]), Path(item["ssh_config"]) if item.get("ssh_config") else None


async def pull_until_stopped(store, peer, scope, request, *, max_pages):
    # The terminal launcher forwards SIGTERM to Python. Let exchange reap its SSH process group.
    loop = asyncio.get_running_loop()
    current = asyncio.current_task()
    assert current is not None
    loop.add_signal_handler(signal.SIGTERM, current.cancel)
    try:
        return await pull(outbox_store, store, peer, scope, request, max_pages=max_pages)
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ork sync")
    commands = parser.add_subparsers(dest="command", required=True)
    identity = commands.add_parser("identity", help="show this host's stream identity for pairing")
    identity.add_argument("--scope", required=True)
    pair = commands.add_parser("pair", help="pin a remote host, stream identity and allowed scopes")
    pair.add_argument("--peer", type=alias, required=True)
    pair.add_argument("--host", type=alias, required=True)
    pair.add_argument("--origin", required=True)
    pair.add_argument("--epoch", required=True)
    pair.add_argument("--scope", action="append", required=True)
    pair.add_argument("--ssh-config", type=Path)
    sync = commands.add_parser("pull", help="apply one peer's changes and advance its durable cursor")
    sync.add_argument("--peer", type=alias, required=True)
    sync.add_argument("--scope", required=True)
    sync.add_argument("--max-pages", default=64, type=int)
    view = commands.add_parser("view", help="read a replicated entity from the pinned peer")
    for field in ("peer", "scope", "kind", "entity"):
        view.add_argument("--" + field, required=True, type=alias if field == "peer" else str)
    serve = commands.add_parser("serve", help="serve one scoped request for the paired SSH key")
    serve.add_argument("--peer", type=alias, required=True)
    args = parser.parse_args(argv)
    store = runtime_paths.cache_home() / "mailbox-v1"
    try:
        if args.command == "identity":
            result = outbox_store.local_stream(store, public_scope(outbox_store, args.scope))
        else:
            file = runtime_paths.config_home() / "sync-peers" / (args.peer + ".json")
            if args.command == "pair":
                scopes = sorted({public_scope(outbox_store, scope) for scope in args.scope})
                origin, epoch = identifier(args.origin), identifier(args.epoch)
                if origin == outbox_store.local_stream(store, scopes[0])["origin"]:
                    raise SyncError("local_origin")
                entry = {
                    "schema": "ork.sync.peer.v1",
                    "host": args.host,
                    "origin": origin,
                    "epoch": epoch,
                    "scopes": scopes,
                    "ssh_config": str(args.ssh_config.resolve(strict=True)) if args.ssh_config else None,
                }
                save_pair(file, entry)
                result = {"peer": args.peer, "scopes": scopes}
            else:
                peer, host, config = load_peer(file)
                if args.command == "serve":
                    if os.environ.get("SSH_ORIGINAL_COMMAND") != "ork sync serve":
                        raise SyncError("unauthorized")
                    request = read_ssh_request(sys.stdin.fileno())
                    sys.stdout.buffer.write(encode_frame(serve_request(outbox_store, store, peer, request)))
                    return 0
                if args.command == "view":
                    if public_scope(outbox_store, args.scope) not in peer.scopes:
                        raise SyncError("unauthorized")
                    row = outbox_store.read_view(
                        store,
                        origin=peer.origin,
                        epoch=peer.epoch,
                        scope=args.scope,
                        kind=identifier(args.kind),
                        entity=identifier(args.entity),
                    )
                    print(json.dumps(row, ensure_ascii=True))
                    return 0
                result = asyncio.run(
                    pull_until_stopped(
                        store,
                        peer,
                        identifier(args.scope),
                        lambda request: exchange(host, request, config=config),
                        max_pages=args.max_pages,
                    )
                )
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except asyncio.CancelledError:
        return 128 + signal.SIGTERM
    except KeyboardInterrupt:
        return 128 + signal.SIGINT
    except (OSError, KeyError, TypeError, ValueError, argparse.ArgumentTypeError) as exc:
        print(f"ork sync: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
