#!/usr/bin/env sh
# Every test suite, all under tests/ (mirroring the repository layout, so
# nothing test-only ships inside a plugin): Vitest for JavaScript, unittest for
# the orchestrate Python. Keeps going after a failing suite.
set -u

cd "$(dirname "$0")/.." || exit 1

failed=0
if command -v cargo > /dev/null 2>&1; then
  cargo build --manifest-path crates/ork-fast/Cargo.toml --release || failed=1
  cargo test --manifest-path crates/ork-fast/Cargo.toml --release || failed=1
  if [ -z "${ORK_FAST_BIN:-}" ] && [ -x "crates/ork-fast/target/release/ork-fast" ]; then
    ORK_FAST_BIN="$(pwd)/crates/ork-fast/target/release/ork-fast"
    export ORK_FAST_BIN
  fi
else
  echo "test: cargo is not installed; skipping Rust tests (CI still runs it)." >&2
fi
./node_modules/.bin/vitest run || failed=1
python3 -B scripts/run_py_tests.py || failed=1
exit $failed
