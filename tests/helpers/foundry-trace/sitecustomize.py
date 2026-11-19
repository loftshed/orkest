"""Record a stalled Foundry writer's Python stack in its isolated test fixture."""

import faulthandler
import os
import sys
from pathlib import Path

trace_root = os.environ.get("ORK_FOUNDRY_TEST_TRACE")
if trace_root and len(sys.argv) > 1 and sys.argv[1] in {"read_state", "write_state"}:
    trace = (Path(trace_root) / (sys.argv[1] + ".trace")).open("a", encoding="utf-8")
    faulthandler.dump_traceback_later(20, file=trace)
