"""Mailbox peer and inbox records in the shared rooms.db, for roots that carry the SQLite marker.

A root with the committed private marker `mailbox-sqlite-v1` keeps presence (`peer`, owner "") and mail
(`inbox`, owner = recipient session key) as rows keyed by the legacy file stem. Writes and authority go through
the Node bridge `bin/mailbox-records.mjs` (one local transaction, privacy-safe outbox included). Reads may use
the table directly, read-only and deadline-bound, on a qualified sqlite3 build. A root without the marker keeps
the legacy JSON files until `mailbox migrate --quiesced` moves it; an active root never falls back to them.

At cutover the bridge parks `peers/` and `inbox/` and puts regular fence files at those names, so a legacy writer
fails instead of writing where nobody reads. Record locks therefore live under `mailbox-locks/`. While
`mailbox-sqlite-pending-v1` exists without the active marker, every record read and write fails closed.
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import stat
import subprocess
import time
import zlib
from pathlib import Path
from typing import Any, NamedTuple

import room_store

MARKER = "mailbox-sqlite-v1"
PENDING = "mailbox-sqlite-pending-v1"
DATABASE = "rooms.db"
COLLECTIONS = ("peer", "inbox")
# Must match FENCE in lib/mailbox-migration.mjs: the marker and both fences hold exactly this text.
FENCE = b"Orkest mailbox SQLite v1. Upgrade this writer; the original records are in mailbox-legacy-v1.\n"
FENCED = ("peers", "inbox")
# Direct reads need the foundation schema (v4) or later with exactly this mailbox_records layout; any other
# store goes through the bridge, which knows its own version.
MAILBOX_MIN_SCHEMA = 4
MAILBOX_COLUMNS = ("collection", "owner", "key", "body", "updated_ms")
LOCK_DIRECTORY = "mailbox-locks"
_BRIDGE_TIMEOUT = 30
_READ_DEADLINE = 2.0
_RACY_NS = 2_000_000_000


class RecordsUnavailable(OSError):
    """The active record store could not answer; callers must not read the legacy files instead."""

    code = "storage_error"


class Location(NamedTuple):
    base: Path
    collection: str
    owner: str
    key: str


_VERIFIED: dict[Path, tuple[Any, ...]] = {}


def _lstat(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except FileNotFoundError:
        return None
    except NotADirectoryError:
        return None


def _fence_token(base: Path) -> tuple[Any, ...] | None:
    """Identity of the marker and both fences, or None when any is not an exact regular fence file."""
    token = []
    for name in (MARKER, *FENCED):
        info = _lstat(base / name)
        if info is None or not stat.S_ISREG(info.st_mode) or info.st_size != len(FENCE):
            return None
        token.append((name, info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
    return tuple(token)


def _fences_intact(base: Path) -> bool:
    token = _fence_token(base)
    if token is None:
        return False
    if _VERIFIED.get(base) == token:
        return True
    for name in (MARKER, *FENCED):
        try:
            descriptor = os.open(base / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            return False
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode) or os.read(descriptor, len(FENCE) + 1) != FENCE:
                return False
        finally:
            os.close(descriptor)
    if _fence_token(base) != token:
        return False
    if len(_VERIFIED) > 64:
        _VERIFIED.clear()
    _VERIFIED[base] = token
    return True


def state(base: Path) -> str:
    """ "active", "legacy", "pending" (a migration started and has not committed) or "broken" (a fence is gone)."""
    base = Path(base)
    if _lstat(base / MARKER) is not None:
        return "active" if _fences_intact(base) else "broken"
    return "pending" if _lstat(base / PENDING) is not None else "legacy"


def active(base: Path) -> bool:
    """Whether this root keeps its records in SQLite. A pending migration or a broken fence fails closed."""
    current = state(base)
    if current == "pending":
        raise RecordsUnavailable("mailbox migration is pending; finish it with: mailbox migrate --quiesced")
    if current == "broken":
        raise RecordsUnavailable(
            "mailbox writer fence is broken (a legacy writer recreated peers or inbox); inspect the root"
        )
    return current == "active"


def locate(path: Path) -> Location | None:
    """The record a legacy-shaped path names under an active root, or None for an ordinary file."""
    path = Path(path)
    if path.suffix != ".json" or path.name.startswith("."):
        return None
    parent = path.parent
    if parent.name == "peers":
        location = Location(parent.parent, "peer", "", path.stem)
    elif parent.parent.name == "inbox" and parent.name:
        location = Location(parent.parent.parent, "inbox", parent.name, path.stem)
    else:
        return None
    return location if active(location.base) else None


def lock_path(location: Location) -> Path:
    """Where a record's lock lives: the legacy directories are fence files once the root is active."""
    directory = location.base / LOCK_DIRECTORY / location.collection
    if location.collection == "inbox":
        directory = directory / location.owner
    return directory / f"{location.key}.lock"


def lock_files(base: Path) -> list[tuple[Path, Path]]:
    """Every record lock file with the legacy-shaped path of the record it guards, for idle-lock pruning."""
    directory = Path(base) / LOCK_DIRECTORY
    found = []
    for lock in sorted(directory.glob("**/*.lock")):
        parts = lock.relative_to(directory).parts
        if len(parts) == 2 and parts[0] == "peer":
            found.append((lock, record_path(base, "peer", "", lock.stem)))
        elif len(parts) == 3 and parts[0] == "inbox":
            found.append((lock, record_path(base, "inbox", parts[1], lock.stem)))
    return found


def record_path(base: Path, collection: str, owner: str, key: str) -> Path:
    """The legacy-shaped path callers use to address a record; nothing is created there."""
    if collection == "peer":
        return Path(base) / "peers" / f"{key}.json"
    return Path(base) / "inbox" / owner / f"{key}.json"


def _bridge() -> Path:
    override = os.environ.get("ORKEST_MAILBOX_RECORDS_BRIDGE", "").strip()
    if override:
        return Path(override)
    try:
        return room_store._bridge("mailbox-records.mjs")
    except OSError as error:
        raise RecordsUnavailable("mailbox records bridge is missing from this runtime") from error


def _node_binary() -> str:
    return os.environ.get("ORKEST_MAILBOX_RECORDS_NODE", "").strip() or room_store._node_binary()


def call(base: Path, operation: str, request: dict[str, Any]) -> Any:
    """One bridge operation: `<operation> <root>`, JSON request on stdin, JSON response on stdout."""
    try:
        result = subprocess.run(
            [_node_binary(), str(_bridge()), operation, str(Path(base))],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            timeout=_BRIDGE_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RecordsUnavailable(f"mailbox records bridge did not run: {type(error).__name__}") from error
    if result.returncode:
        # Only the first line: the bridge reports a code, never record contents.
        detail = (result.stderr.strip().splitlines() or ["failed"])[0][:200]
        raise RecordsUnavailable(f"mailbox records {operation} failed: {detail}")
    try:
        return json.loads(result.stdout)
    except ValueError as error:
        raise RecordsUnavailable(f"mailbox records {operation} returned invalid JSON") from error


def _body(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    return value if isinstance(value, dict) else None


def _row(owner: str, key: Any, body: Any, updated: Any) -> dict[str, Any] | None:
    if not isinstance(key, str) or not key:
        return None
    return {
        "owner": owner,
        "key": key,
        "body": _body(body),
        "updated_ms": updated if isinstance(updated, int) else 0,
    }


def _native(base: Path, query: str, parameters: tuple[Any, ...]) -> list[tuple[Any, ...]] | None:
    """Committed rows read-only within a short deadline, or None when the bridge must answer instead."""
    if os.environ.get("ORKEST_ROOM_STORE_BRIDGE") == "1" or not room_store.sqlite_qualified():
        return None
    database = Path(base) / DATABASE
    try:
        if not database.is_file() or any(Path(str(database) + suffix).is_symlink() for suffix in ("", "-shm", "-wal")):
            return None
        connection = sqlite3.connect(
            f"{database.resolve().as_uri()}?mode=ro", uri=True, timeout=_READ_DEADLINE, isolation_level=None
        )
    except (OSError, sqlite3.Error):
        return None
    deadline = time.monotonic() + _READ_DEADLINE
    connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    try:
        if (
            connection.execute("PRAGMA application_id").fetchone()[0] != room_store.ROOMS_APPLICATION_ID
            or not MAILBOX_MIN_SCHEMA
            <= connection.execute("PRAGMA user_version").fetchone()[0]
            <= room_store.ROOMS_SCHEMA_VERSION
        ):
            return None
        columns = tuple(row[1] for row in connection.execute("PRAGMA table_info(mailbox_records)"))
        if columns != MAILBOX_COLUMNS:
            return None
        cutover = "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mailbox_cutover'"
        if not connection.execute(cutover).fetchone():
            return None
        # One read transaction: the cutover check and the rows come from the same snapshot.
        connection.execute("BEGIN")
        if not connection.execute("SELECT 1 FROM mailbox_cutover WHERE singleton = 1").fetchone():
            return None
        return connection.execute(query, parameters).fetchall()
    except (sqlite3.Error, TypeError, IndexError):
        return None
    finally:
        connection.close()


def get(base: Path, collection: str, owner: str, key: str) -> dict[str, Any] | None:
    rows = _native(
        base,
        "SELECT body FROM mailbox_records WHERE collection = ? AND owner = ? AND key = ?",
        (collection, owner, key),
    )
    if rows is not None:
        return _body(rows[0][0]) if rows else None
    return _body(call(base, "get", {"collection": collection, "owner": owner, "key": key}))


def get_row(base: Path, collection: str, owner: str, key: str) -> dict[str, Any] | None:
    rows = _native(
        base,
        "SELECT key, body, updated_ms FROM mailbox_records WHERE collection = ? AND owner = ? AND key = ?",
        (collection, owner, key),
    )
    if rows is not None:
        return _row(owner, *rows[0]) if rows else None
    return next((row for row in list_rows(base, collection, owner) if row["key"] == key), None)


def list_rows(base: Path, collection: str, owner: str) -> list[dict[str, Any]]:
    """One owner's rows in key order (message ids sort in delivery order)."""
    rows = _native(
        base,
        "SELECT key, body, updated_ms FROM mailbox_records WHERE collection = ? AND owner = ? ORDER BY key",
        (collection, owner),
    )
    if rows is None:
        answer = call(base, "list", {"collection": collection, "owner": owner})
        rows = [
            (item.get("key"), item.get("body"), item.get("updated_ms"))
            for item in (answer if isinstance(answer, list) else [])
            if isinstance(item, dict)
        ]
    found = [row for item in rows if (row := _row(owner, *item))]
    return sorted(found, key=lambda row: row["key"])


def list_collection(base: Path, collection: str, key: str | None = None) -> list[dict[str, Any]]:
    """Every owner's rows, optionally of one key, ordered by owner then key."""
    if key is None:
        query, parameters = (
            "SELECT owner, key, body, updated_ms FROM mailbox_records WHERE collection = ?",
            (collection,),
        )
    else:
        query = "SELECT owner, key, body, updated_ms FROM mailbox_records WHERE collection = ? AND key = ?"
        parameters = (collection, key)
    rows = _native(base, query + " ORDER BY owner, key", parameters)
    if rows is not None:
        return [row for owner, *item in rows if isinstance(owner, str) and (row := _row(owner, *item))]
    if collection == "peer":
        found = list_rows(base, "peer", "")
        return [row for row in found if key is None or row["key"] == key]
    # Without direct reads the bridge lists one owner at a time.
    owners = call(base, "owners", {})
    found = []
    for owner in sorted(owner for owner in (owners if isinstance(owners, list) else []) if isinstance(owner, str)):
        found.extend(row for row in list_rows(base, collection, owner) if key is None or row["key"] == key)
    return found


def put(base: Path, collection: str, owner: str, key: str, body: dict[str, Any]) -> dict[str, Any]:
    stored = call(base, "put", {"collection": collection, "owner": owner, "key": key, "body": body})
    return _body(stored) or body


def delete(base: Path, collection: str, owner: str, key: str) -> bool:
    return bool(call(base, "delete", {"collection": collection, "owner": owner, "key": key}))


def _occupied(base: Path) -> bool:
    try:
        return any(base.iterdir())
    except FileNotFoundError:
        return False
    except OSError:
        return True


def ensure(base: Path) -> bool:
    """At a public entry point: let the bridge commit a genuinely empty or new root to the records.

    An active root, and an existing nonempty root that may belong to a legacy writer, are left as they are
    without starting Node (the bridge would refuse the latter too). A pending fresh-root intent is handed back to
    the bridge to finish. A failed bridge leaves an unmarked, unfenced root on the legacy files, its committed
    state; a pending or broken root then fails closed on its first record access.
    """
    base = Path(base)
    current = state(base)
    if current == "active":
        return True
    if current == "broken" or (current == "legacy" and _occupied(base)):
        return False
    with contextlib.suppress(RecordsUnavailable):
        call(base, "ensure", {})
    # The committed marker and its fences, not the response, decide: they are what every later process checks.
    return state(base) == "active"


def migrate(base: Path) -> dict[str, Any]:
    """Move a quiesced legacy root into the records; the bridge writes the marker and returns its report."""
    report = call(Path(base), "migrate", {"quiesced": True})
    return report if isinstance(report, dict) else {"report": report}


def export(base: Path, destination: Path) -> dict[str, Any]:
    """Copy this root's records to a new root through the bridge; reads only, never activates `base`."""
    report = call(Path(base), "export", {"destination": str(destination)})
    return report if isinstance(report, dict) else {"report": report}


def fingerprint(base: Path) -> tuple[Any, ...] | None:
    """A static change token for the record store: marker plus database and WAL identity, size and times.

    Equal tokens outside the racy window mean no committed record changed, so pollers can skip a re-read.
    None means the root is not active.
    """
    base = Path(base)
    if not active(base):
        return None
    token: list[Any] = []
    for name in (MARKER, DATABASE, f"{DATABASE}-wal"):
        try:
            info = (base / name).stat()
        except OSError:
            token.append((name, None))
            continue
        token.append((name, info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
    return tuple(token)


def racy(token: tuple[Any, ...] | None) -> bool:
    """Within two seconds of the newest timestamp a same-size rewrite could keep the token unchanged."""
    stamps = [max(item[4], item[5]) for item in token or () if len(item) == 6]
    return not stamps or abs(time.time_ns() - max(stamps)) < _RACY_NS


def row_state(row: dict[str, Any]) -> tuple[Any, ...]:
    """A per-record change token for read caches: update time plus a checksum of the stored body."""
    body = json.dumps(row.get("body"), sort_keys=True, ensure_ascii=True).encode()
    return ("record", row.get("updated_ms"), len(body), zlib.crc32(body))
