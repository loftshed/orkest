"""Room persistence through the qualified Node SQLite runtime, never Python SQLite."""

from __future__ import annotations

import copy
import functools
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

_CACHE: dict[Path, dict[str, Any]] = {}
_MIN_NODE = (26, 8, 0)
_ROOM_ID_RE = re.compile(r"[\w-]{1,80}", flags=re.ASCII)
_SYSTEM_NODE_DIRS = frozenset({"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"})


@functools.cache
def _node_binary() -> str:
    override = os.environ.get("ORKEST_NODE_BIN", "").strip()
    if override:
        return override
    found = shutil.which("node")
    if found:
        match = re.search(r"/v(\d+)\.(\d+)\.(\d+)/", found)
        if match and (int(match[1]), int(match[2]), int(match[3])) >= _MIN_NODE:
            return found
        if str(Path(found).parent) not in _SYSTEM_NODE_DIRS:
            return found
    nvm_dir = Path.home() / ".nvm/versions/node"
    if nvm_dir.is_dir():
        best: tuple[tuple[int, int, int], Path] | None = None
        for child in nvm_dir.iterdir():
            match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", child.name)
            binary = child / "bin/node"
            if not match or not binary.is_file():
                continue
            version = (int(match[1]), int(match[2]), int(match[3]))
            if version >= _MIN_NODE and (best is None or version > best[0]):
                best = (version, binary)
        if best is not None:
            return str(best[1])
    return found or "node"


def _bridge() -> Path:
    source = Path(__file__).resolve()
    for parent in (source.parents[1], source.parents[3]):
        candidate = parent / "bin" / "room-store.mjs"
        if candidate.is_file():
            return candidate
    raise OSError("Node room-store bridge is missing from this runtime")


def _header_tokens(path: Path, size: int) -> tuple[bytes, ...]:
    if path.name not in {"rooms.db", "rooms.db-wal"} or size <= 0:
        return ()
    with path.open("rb") as handle:
        if path.name == "rooms.db":
            return (handle.read(min(100, size)),)
        head = handle.read(min(32, size))
        if size <= 32:
            return (head,)
        tail_len = min(64, size)
        handle.seek(size - tail_len)
        return (head, handle.read(tail_len))


def _signature(base: Path) -> tuple | None:
    if not (base / "rooms.db").exists() and not (base / "rooms").exists():
        return None
    paths = [base / "rooms.db", base / "rooms.db-wal", *sorted((base / "rooms").glob("*.json"))]
    signature = []
    for path in paths:
        try:
            info = path.stat()
            if path.name == "rooms.db-wal" and info.st_size == 0:
                signature.append((path.name, 0))
                continue
            tokens = _header_tokens(path, info.st_size)
            signature.append((path.name, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, *tokens))
        except FileNotFoundError:
            signature.append((path.name, 0 if path.name == "rooms.db-wal" else None))
    return tuple(signature)


def _invoke(base: Path, command: str, room_id: str | None = None, payload: Any = None) -> Any:
    args = [_node_binary(), str(_bridge()), command, "--root", str(base)]
    if room_id is not None:
        if not _ROOM_ID_RE.fullmatch(room_id):
            raise ValueError("Invalid swarm room ID")
        args.append(room_id)
    result = subprocess.run(
        args,
        input=json.dumps(payload) if payload is not None else "",
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if result.returncode:
        raise OSError(result.stderr.strip() or "Node room-store bridge failed")
    return json.loads(result.stdout)


def list_rooms(base: Path) -> list[dict[str, Any]]:
    base = Path(base).resolve()
    signature = _signature(base)
    if signature is None:
        _CACHE.pop(base, None)
        return []
    cached = _CACHE.get(base)
    if cached is not None and cached["signature"] == signature and cached["all"] is not None:
        return copy.deepcopy(cached["all"])
    rooms = _invoke(base, "list")
    after = _signature(base)
    if after == signature:
        _CACHE[base] = {
            "signature": after,
            "all": copy.deepcopy(rooms),
            "by_id": {room["id"]: copy.deepcopy(room) for room in rooms if isinstance(room.get("id"), str)},
        }
    else:
        _CACHE.pop(base, None)
    return rooms


def read_room(base: Path, room_id: str) -> dict[str, Any] | None:
    if not isinstance(room_id, str) or not _ROOM_ID_RE.fullmatch(room_id):
        return None
    base = Path(base).resolve()
    signature = _signature(base)
    if signature is None:
        _CACHE.pop(base, None)
        return None
    cached = _CACHE.get(base)
    if cached is not None and cached["signature"] == signature:
        if room_id in cached["by_id"]:
            hit = cached["by_id"][room_id]
            return copy.deepcopy(hit) if hit is not None else None
        if cached["all"] is not None:
            return None
    room = _invoke(base, "get", room_id)
    after = _signature(base)
    if after == signature:
        entry = _CACHE.get(base)
        if entry is None or entry["signature"] != after:
            entry = {"signature": after, "all": None, "by_id": {}}
            _CACHE[base] = entry
        entry["by_id"][room_id] = copy.deepcopy(room) if room is not None else None
    else:
        _CACHE.pop(base, None)
    return room


def _mutate(base: Path, command: str, room_id: str, payload: Any = None) -> Any:
    base = Path(base).resolve()
    _CACHE.pop(base, None)
    try:
        return _invoke(base, command, room_id, payload)
    finally:
        _CACHE.pop(base, None)


def put_room(base: Path, room: dict[str, Any]) -> dict[str, Any]:
    return _mutate(base, "put", room["id"], room)


def set_metadata(base: Path, room_id: str, **fields: Any) -> dict[str, Any] | None:
    return _mutate(base, "set-meta", room_id, fields)


def rebind(base: Path, room_id: str, member_id: str, session_id: str) -> dict[str, Any] | None:
    return _mutate(base, "rebind", room_id, {"member": member_id, "session": session_id})


def delete_room(base: Path, room_id: str, expected: dict[str, Any] | None = None) -> bool:
    return bool(_mutate(base, "delete", room_id, expected))
