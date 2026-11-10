"""Hold a POSIX workspace lease until the owning process closes stdin."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from execution_support import ContractError, workspace_lease
from runtime_paths import cache_home


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--read-only", action="store_true")
    parser.add_argument("--namespace")
    args = parser.parse_args()
    cache = cache_home()
    if args.namespace:
        if args.namespace in {".", ".."} or Path(args.namespace).name != args.namespace:
            parser.error("namespace must be a single directory name")
        cache /= args.namespace
    try:
        with workspace_lease(args.path, cache, read_only=args.read_only):
            print(json.dumps({"status": "acquired", "pid": os.getpid()}), flush=True)
            while sys.stdin.buffer.read(65536):
                pass
    except ContractError as exc:
        print(json.dumps({"status": "busy", "detail": str(exc)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
