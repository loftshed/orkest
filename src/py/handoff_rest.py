"""Pause automated routing after an accepted quota handoff until reset or measured recovery."""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any

import authority
import peer_mailbox as mailbox
import succession

# Without any known reset, a rest ends this long after acceptance, so stale monitor data cannot hold it forever.
REST_CAP = dt.timedelta(hours=5)


def marker_path(base: Path, session: str) -> Path:
    return base / "handoff-rest" / f"{mailbox.session_key(session)}.json"


def _resets(windows: list[dict[str, Any]]) -> list[dt.datetime]:
    return [
        reset
        for window in windows
        if (reset := succession.parse_time(window.get("resetsAt"))) is not None and reset.tzinfo is not None
    ]


def prepare(base: Path, session: str, team: str, event: str, pool: dict[str, Any], threshold: float) -> None:
    """Record the rest before the offer. It takes effect only once the offer is accepted."""
    windows = pool.get("windows") or []
    low = [
        window
        for window in windows
        if isinstance(window.get("remainingPct"), (int, float)) and window["remainingPct"] < threshold
    ]
    resets = _resets(low) or _resets(windows)
    until = max(resets) if resets else succession.parse_time(pool.get("blockedUntil"))
    path = marker_path(base, session)
    with mailbox.locked(path):
        mailbox.write(
            path,
            {
                "team": team,
                "event": event,
                "pool": pool["pool"],
                "threshold": threshold,
                "restingUntil": until.isoformat() if until is not None and until.tzinfo is not None else None,
            },
        )


def release(base: Path, session: str, event: str) -> None:
    """End the rest prepared for `event`. A later event's marker is left alone."""
    path = marker_path(base, session)
    with mailbox.locked(path):
        current = mailbox.load(path)
        if current and current.get("event") == event and not current.get("released"):
            mailbox.write(path, {**current, "released": True})


def resting(
    base: Path, session: str, *, view: dict[str, Any] | None = None, config: dict[str, Any] | None = None
) -> bool:
    path = marker_path(base, session)
    marker = mailbox.load(path)
    if not marker or marker.get("released"):
        return False
    record = authority.load(authority.team_dir(marker["team"])) or {}
    accepted = next(
        (
            entry
            for entry in record.get("log") or []
            if entry["event"] == "accept" and entry.get("automatic") == marker["event"]
        ),
        None,
    )
    if accepted is None:
        offer = record.get("offer") or {}
        if offer.get("automatic") == marker["event"] and not authority.automatic_offer_expired(offer):
            return False  # Still offered: the lead keeps working until acceptance.
        # Cancelled, superseded or expired: this rest never starts.
        release(base, session, marker["event"])
        return False
    reset = succession.parse_time(marker.get("restingUntil"))
    if reset is None or reset.tzinfo is None:
        started = succession.parse_time(accepted.get("at"))
        reset = started + REST_CAP if started is not None and started.tzinfo is not None else None
    if reset is not None and succession.now() < reset:
        config = succession.monitor_config() if config is None else config
        view = succession.cached_view() if view is None else view
        pool = next((pool for pool in succession.pools(view, config) if pool["pool"] == marker["pool"]), {})
        if (
            pool.get("status") not in succession.USABLE
            or pool["availableNowPct"] < marker["threshold"]
            or not succession.pool_fresh(pool, config)
        ):
            return True
    with mailbox.locked(path):
        current = mailbox.load(path)
        if current and current["event"] == marker["event"]:
            mailbox.write(path, {**current, "released": True})
            return False
        return bool(current and not current.get("released"))
