#!/usr/bin/env sh
# Every test suite, all under tests/ (mirroring the repository layout, so
# nothing test-only ships inside a plugin): Vitest for JavaScript, unittest for
# the orchestrate Python. Keeps going after a failing suite.
set -u

cd "$(dirname "$0")/.." || exit 1

failed=0
./node_modules/.bin/vitest run || failed=1
python3 -B -m unittest discover -s tests/plugins/orchestrate/skills/orchestrate -p "test_*.py" || failed=1
if command -v cargo > /dev/null 2>&1; then
  cargo test --manifest-path crates/ork-fast/Cargo.toml --release || failed=1
else
  echo "test: cargo is not installed; skipping Rust tests (CI still runs it)." >&2
fi
exit $failed
