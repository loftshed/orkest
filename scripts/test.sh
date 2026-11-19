#!/usr/bin/env sh
# Every test suite, all under tests/ (mirroring the repository layout, so
# nothing test-only ships inside a plugin): Vitest for JavaScript, unittest for
# the orchestrate Python. Keeps going after a failing suite.
set -u

cd "$(dirname "$0")/.." || exit 1

run_phase() {
  case "$1" in
    rust-build|rust-test)
      if ! command -v cargo > /dev/null 2>&1; then
        echo "test: cargo is not installed; skipping $1 (CI still runs it)." >&2
        return 0
      fi
      cargo "${1#rust-}" --manifest-path crates/ork-fast/Cargo.toml --release
      ;;
    javascript|python)
      if [ -z "${ORK_FAST_BIN:-}" ] && command -v cargo > /dev/null 2>&1 && [ -x crates/ork-fast/target/release/ork-fast ]; then
        ORK_FAST_BIN="$(pwd)/crates/ork-fast/target/release/ork-fast"
        export ORK_FAST_BIN
      fi
      if [ "$1" = javascript ]; then
        ./node_modules/.bin/vitest run
      else
        python3 -B scripts/run_py_tests.py
      fi
      ;;
    *)
      echo "usage: $0 [rust-build|rust-test|javascript|python]" >&2
      return 2
      ;;
  esac
}

if [ "$#" -eq 0 ]; then
  set -- rust-build rust-test javascript python
elif [ "$#" -gt 1 ]; then
  echo "usage: $0 [rust-build|rust-test|javascript|python]" >&2
  exit 2
else
  run_phase "$1"
  exit $?
fi

failed=0
for phase do
  run_phase "$phase" || failed=1
done
exit "$failed"
