"""Lexical repository-relative path rules shared by Orchestrate scripts.

Paths are trimmed and normalized with :class:`pathlib.Path`, duplicate normalized
paths are removed, and repository-root spellings are accepted only when
``allow_root`` is true. Absolute paths, parent segments, blank values, and paths
whose first component is ``.git`` are rejected. Prefix coverage is lexical:
``.`` covers all paths, otherwise a prefix covers itself and descendants; callers
can exclude ``.git`` and its descendants.
"""

from __future__ import annotations

from pathlib import Path


def normalize_repo_paths(values: list[str], *, allow_root: bool = False) -> list[str]:
    """Normalize repository-relative paths or raise ``ValueError(raw_value)``."""
    normalized: list[str] = []
    for value in values:
        stripped = value.strip()
        candidate = Path(stripped)
        # pathlib reduces `./`, `.//` and an empty string to `.`, so an empty value is refused first.
        clean = candidate.as_posix().rstrip("/")
        if stripped and allow_root and clean == ".":
            if "." not in normalized:
                normalized.append(".")
            continue
        if (
            not stripped
            or candidate.is_absolute()
            or clean == "."
            or ".." in candidate.parts
            or (candidate.parts and candidate.parts[0] == ".git")
        ):
            raise ValueError(value)
        if clean not in normalized:
            normalized.append(clean)
    return normalized


def path_covered_by_prefixes(path: str, prefixes: list[str], *, exclude_git: bool = True) -> bool:
    """Return whether a lexical prefix covers ``path``, optionally excluding ``.git``."""
    if exclude_git and (path == ".git" or path.startswith(".git/")):
        return False
    return any(prefix == "." or path == prefix or path.startswith(f"{prefix}/") for prefix in prefixes)
