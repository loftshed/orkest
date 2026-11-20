"""Room persistence: writes through the qualified Node SQLite runtime; reads may use Python's sqlite3.

Python never writes rooms.db. A qualified sqlite3 build reads the current schema read-only, which skips a Node
start per read. Unqualified builds, legacy room files awaiting import, other schema versions and any SQLite
error fall back to the Node bridge, which also performs migrations and imports.
"""

from __future__ import annotations

import copy
import functools
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any

import runtime_paths

_IMPORT_PATH = os.environ.get("PATH", "")
_CACHE: dict[Path, dict[str, Any]] = {}
_RACY_NS = 2_000_000_000
_MIN_NODE = (26, 8, 0)
_ROOM_ID_RE = re.compile(r"[\w-]{1,80}", flags=re.ASCII)
_SYSTEM_NODE_DIRS = frozenset({"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"})
# Must match ROOMS_APPLICATION_ID and ROOMS_MIGRATIONS.length in horde-room.mjs.
ROOMS_APPLICATION_ID = 1_330_793_298
ROOMS_SCHEMA_VERSION = 12


def sqlite_qualified(version: tuple[int, int, int] = sqlite3.sqlite_version_info) -> bool:
    """SQLite builds with the WAL-reset fix: 3.51.3 and later, or the 3.50.7 and 3.44.6 backports."""
    return version >= (3, 51, 3) or (3, 50, 7) <= version < (3, 51, 0) or (3, 44, 6) <= version < (3, 45, 0)


def _direct_rows(base: Path, room_id: str | None = None) -> list[dict[str, Any]] | None:
    """Read committed rows read-only, or None when the Node bridge must answer instead."""
    database = base / "rooms.db"
    if os.environ.get("ORKEST_ROOM_STORE_BRIDGE") == "1" or not sqlite_qualified():
        return None
    try:
        if database.is_symlink() or not database.is_file() or any((base / "rooms").glob("*.json")):
            return None
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
    except (OSError, sqlite3.Error):
        return None
    try:
        if connection.execute("PRAGMA application_id").fetchone()[0] != ROOMS_APPLICATION_ID or connection.execute(
            "PRAGMA user_version"
        ).fetchone()[0] not in range(2, ROOMS_SCHEMA_VERSION + 1):
            return None
        if room_id is None:
            rows = connection.execute("SELECT data FROM rooms ORDER BY updated_at DESC, id ASC").fetchall()
        else:
            rows = connection.execute("SELECT data FROM rooms WHERE id = ?", (room_id,)).fetchall()
        return [json.loads(row[0]) for row in rows]
    except (sqlite3.Error, ValueError, TypeError, IndexError):
        return None
    finally:
        connection.close()


def _node_binary() -> str:
    override = os.environ.get("ORKEST_NODE_BIN", "").strip()
    if override:
        return override
    return _discover_node_binary()


@functools.cache
def _discover_node_binary() -> str:
    found = shutil.which("node") or (shutil.which("node", path=_IMPORT_PATH) if _IMPORT_PATH else None)
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


def _bridge(name: str = "room-store.mjs") -> Path:
    candidate = runtime_paths.node_runtime(__file__) / "bin" / name
    if candidate.is_file():
        return candidate
    raise OSError(f"Node bridge {name} is missing from this runtime")


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


ROOM_LIFECYCLES = ("active", "archived", "cancelled")


def room_lifecycle(room: Any) -> str:
    """A room without the field is a legacy active room; age never archives it."""
    value = room.get("lifecycle") if isinstance(room, dict) else None
    return value if value in ROOM_LIFECYCLES else "active"


def is_active_room(room: Any) -> bool:
    return room_lifecycle(room) == "active"


def _is_racy_signature(signature: tuple) -> bool:
    """Bypass cache read trust within 2s of any DB/WAL/legacy timestamp (same-tick WAL resets)."""
    stamps = [
        max(item[3], item[4])
        for item in signature
        if isinstance(item, tuple) and len(item) >= 5 and isinstance(item[3], int) and isinstance(item[4], int)
    ]
    return bool(stamps) and abs(time.time_ns() - max(stamps)) < _RACY_NS


def list_rooms(base: Path) -> list[dict[str, Any]]:
    base = Path(base).resolve()
    signature = _signature(base)
    if signature is None:
        _CACHE.pop(base, None)
        return []
    cached = _CACHE.get(base)
    if (
        cached is not None
        and cached["signature"] == signature
        and cached["all"] is not None
        and not _is_racy_signature(signature)
    ):
        return copy.deepcopy(cached["all"])
    direct = _direct_rows(base)
    rooms = direct if direct is not None else _invoke(base, "list")
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
    if cached is not None and cached["signature"] == signature and not _is_racy_signature(signature):
        if room_id in cached["by_id"]:
            hit = cached["by_id"][room_id]
            return copy.deepcopy(hit) if hit is not None else None
        if cached["all"] is not None:
            return None
    direct = _direct_rows(base, room_id)
    room = (direct[0] if direct else None) if direct is not None else _invoke(base, "get", room_id)
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
