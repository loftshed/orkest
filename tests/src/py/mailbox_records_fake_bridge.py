"""Record requests to the actual mailbox bridge and inject explicitly selected operation failures."""

import json
import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    operation, root = sys.argv[1], Path(sys.argv[2])
    raw = sys.stdin.read()
    if log := os.environ.get("FAKE_BRIDGE_LOG"):
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"operation": operation, "request": json.loads(raw or "null")}) + "\n")
    failing = os.environ.get("FAKE_BRIDGE_FAIL", "").split(",")
    if operation in failing or "all" in failing:
        sys.stderr.write("injected_failure\n")
        return 1
    forwarded = subprocess.run(
        [os.environ["FAKE_BRIDGE_NODE"], os.environ["FAKE_BRIDGE_REAL"], operation, str(root)],
        input=raw,
        text=True,
        check=False,
    )
    return forwarded.returncode


if __name__ == "__main__":
    raise SystemExit(main())
