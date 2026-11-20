"""One bounded JSON request and response per authenticated SSH session."""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import select
import signal
import time
from contextlib import suppress
from pathlib import Path
from typing import Any, BinaryIO

MAX_FRAME_BYTES = 2 * 1024 * 1024
SSH_ALIAS = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
DEFAULT_TIMEOUT_SECONDS = 20.0


class ReplicationError(ValueError):
    """The peer or transport did not return a complete valid response."""


def encode_frame(message: dict[str, Any]) -> bytes:
    if not isinstance(message, dict):
        raise ReplicationError("expected a JSON object")
    frame = json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(frame) > MAX_FRAME_BYTES:
        raise ReplicationError("replication frame exceeds the size limit")
    return frame


def _unique_fields(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ReplicationError("duplicate field in replication frame")
        result[key] = value
    return result


def _invalid_number(value: str) -> None:
    raise ReplicationError("invalid JSON number in replication frame")


def _finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ReplicationError("invalid JSON number in replication frame")
    return number


def decode_frame(frame: bytes) -> dict[str, Any]:
    if not frame.endswith(b"\n") or len(frame) > MAX_FRAME_BYTES or b"\n" in frame[:-1]:
        raise ReplicationError("expected one complete bounded replication frame")
    try:
        value = json.loads(
            frame.decode("utf-8"),
            object_pairs_hook=_unique_fields,
            parse_float=_finite_float,
            parse_constant=_invalid_number,
        )
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ReplicationError("invalid JSON replication frame") from exc
    if not isinstance(value, dict):
        raise ReplicationError("expected a JSON object")
    return value


def read_request(stream: BinaryIO) -> dict[str, Any]:
    frame = stream.readline(MAX_FRAME_BYTES + 1)
    request = decode_frame(frame)
    if stream.read(1):
        raise ReplicationError("unexpected bytes after replication request")
    return request


def read_ssh_request(fd: int, *, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Bound both total bytes and elapsed time, including the final SSH channel EOF."""
    deadline = time.monotonic() + timeout
    frame = bytearray()
    while len(frame) <= MAX_FRAME_BYTES:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise ReplicationError("SSH replication request deadline exceeded")
        part = os.read(fd, min(65536, MAX_FRAME_BYTES + 1 - len(frame)))
        if not part:
            return decode_frame(bytes(frame))
        frame.extend(part)
    raise ReplicationError("replication frame exceeds the size limit")


async def exchange(
    alias: str,
    request: dict[str, Any],
    *,
    config: Path | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Use the paired host's forced command. Request values never enter the remote command line."""
    if not SSH_ALIAS.fullmatch(alias):
        raise ReplicationError("invalid paired SSH host alias")
    if not 0 < timeout <= 120:
        raise ReplicationError("invalid replication timeout")
    frame = encode_frame(request)
    args = ["ssh"]
    if config is not None:
        args.extend(["-F", str(config)])
    args.extend(
        [
            "-T",
            "-oBatchMode=yes",
            "-oIdentitiesOnly=yes",
            "-oStrictHostKeyChecking=yes",
            "-oForwardAgent=no",
            "-oClearAllForwardings=yes",
            "-oControlPath=none",
            "--",
            alias,
            "ork sync serve",
        ]
    )
    child = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        limit=MAX_FRAME_BYTES,
        start_new_session=True,
    )
    assert child.stdin is not None and child.stdout is not None

    async def send() -> None:
        assert child.stdin is not None
        try:
            child.stdin.write(frame)
            await child.stdin.drain()
        finally:
            child.stdin.close()

    async def receive() -> dict[str, Any]:
        assert child.stdout is not None
        response = decode_frame(await child.stdout.readline())
        if await child.stdout.read(1):
            raise ReplicationError("unexpected bytes after replication response")
        return response

    try:
        async with asyncio.timeout(timeout):
            async with asyncio.TaskGroup() as group:
                group.create_task(send())
                response_task = group.create_task(receive())
            status = await child.wait()
            if status:
                raise ReplicationError(f"SSH replication command exited with status {status}")
            return response_task.result()
    except TimeoutError as exc:
        raise ReplicationError("SSH replication deadline exceeded") from exc
    except ExceptionGroup as exc:
        raise ReplicationError("SSH replication exchange failed") from exc
    finally:
        if child.returncode is None:
            with suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGKILL)
            # Drain buffered output after termination so a full pipe cannot block wait().
            await child.communicate()
