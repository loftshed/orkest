"""MACs for hook-observed native IDs; peer-file hints alone never establish ownership."""

import hashlib
import hmac
import json
import re
from pathlib import Path
from typing import Any

from mailbox_store import SESSION_ID


def identity_message(peer: dict[str, Any]) -> bytes:
    return json.dumps(
        [
            "orkest.native-identity.v1",
            *[peer.get(key) for key in ("session", "harness", "machine", "cwd", "checkout", "accountHome")],
            peer.get("nativeSession"),
            peer.get("nativeSessions"),
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def verified_native_ids(base: Path, peer: dict[str, Any]) -> list[str]:
    signature = peer.get("nativeSessionAttestation")
    if not isinstance(signature, str) or not re.fullmatch(r"[0-9a-f]{64}", signature):
        return []
    # Import lazily: the daemon also imports the mailbox facade.
    import mailbox_daemon

    try:
        token = mailbox_daemon.read_token(base)
        if not token or not hmac.compare_digest(
            signature, hmac.new(token.encode("ascii"), identity_message(peer), hashlib.sha256).hexdigest()
        ):
            return []
    except (OSError, ValueError, TypeError, UnicodeError):
        return []
    history = peer.get("nativeSessions")
    return [
        value
        for value in [peer.get("nativeSession"), *(history if isinstance(history, list) else [])]
        if isinstance(value, str) and re.fullmatch(SESSION_ID, value)
    ]


def sign_native_ids(base: Path, peer: dict[str, Any]) -> str:
    import mailbox_daemon

    mailbox_daemon.private_directory(mailbox_daemon.daemon_base(base))
    token = mailbox_daemon.generate_token(base)
    return hmac.new(token.encode("ascii"), identity_message(peer), hashlib.sha256).hexdigest()
