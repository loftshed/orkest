"""Plain, bounded Herdr presentation and conservative Codex title matching."""

import os
import re
import unicodedata
from typing import Any

_ANSI = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_PREFIX = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5}"
_ICONS = {
    "nerd": {"codex": "", "claude": "", "gemini": "", "opencode": ""},
    "unicode": {"codex": "⚙", "claude": "✳", "gemini": "✦", "opencode": "◇"},
    "ascii": {"codex": "[C]", "claude": "[A]", "gemini": "[G]", "opencode": "[O]"},
}


def plain(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(
        "".join(c for c in _ANSI.sub("", value) if unicodedata.category(c) not in {"Cc", "Cf", "Cs"}).split()
    )


def bounded(value: str, limit: int = 80) -> str:
    """Keep the distinguishing four-character suffix, as in the terminal footer."""
    value = plain(value)
    return value if len(value) <= limit else value[: limit - 5] + "…" + value[-4:]


def agent_harness(kind: str | None) -> str | None:
    """Herdr uses agy for Antigravity; the other agent kinds match Orkest harnesses."""
    return "gemini" if kind == "agy" else kind


def display_label(peer: dict) -> str:
    tier = os.environ.get("ORK_GLYPHS", "nerd").strip().lower()
    icons = _ICONS.get(tier, _ICONS["unicode"])
    harness = peer.get("harness")
    icon = icons.get(agent_harness(harness), "")
    return bounded(" ".join(part for part in (icon, plain(peer.get("name") or peer.get("person"))) if part))


def work_title(progress: dict) -> str:
    return bounded(" · ".join(part for part in (plain(progress.get("stage")), plain(progress.get("task"))) if part))


def codex_title_session(title: Any, sessions: set[str]) -> str | None:
    # Only the final title component is authoritative; a thread title may itself contain pipes or UUIDs.
    tail = plain(title).rsplit(" | ", 1)[-1]
    if re.fullmatch(_UUID, tail):
        return tail if tail in sessions else None
    if not re.fullmatch(_PREFIX + r"(?:\.\.\.|…)", tail):
        return None
    prefix = tail.removesuffix("...").removesuffix("…")
    matches = [session for session in sessions if session.startswith(prefix) and re.fullmatch(_UUID, session)]
    return matches[0] if len(matches) == 1 else None
