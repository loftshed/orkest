"""Run the canonical counterpart of a shipped legacy script in the caller's module."""

import sys
from pathlib import Path


def dispatch(namespace: dict) -> None:
    previous = Path(namespace["__file__"]).resolve()
    directory = Path(__file__).resolve().parent
    if previous.parent != directory or previous == Path(__file__).resolve():
        raise ImportError("Unknown Orkest compatibility entry")
    target = directory.parents[4] / "src/py" / previous.name
    print(f"The Orkest script {previous.name} moved to {target}. Update the old path.", file=sys.stderr)
    sys.path.insert(0, str(target.parent))
    namespace["__file__"] = str(target)
    if namespace["__name__"] == "__main__":
        sys.argv[0] = str(target)
    exec(compile(target.read_bytes(), str(target), "exec"), namespace)
