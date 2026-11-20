#!/usr/bin/env python3
"""Compatibility entry for the relocated Orkest Python runtime."""

from pathlib import Path
from runpy import run_path

run_path(str(Path(__file__).resolve().with_name("_compat.py")))["dispatch"](globals())
