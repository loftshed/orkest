#!/bin/sh
# Install Orkest from this checkout.
#
# Usage: ./install.sh [--dry-run] [--no-app] [--no-monitor]
#        [--no-claude] [--trust-codex-hooks] [--help]
#
# Options:
#   --dry-run             preview changes; only the orchestrate installer is run in dry-run mode
#   --no-app              skip the monitor macOS menu bar app
#   --no-monitor          skip monitor installation and MCP registration
#   --no-claude           skip orchestrate's Claude skill links
#   --trust-codex-hooks   trust the four reviewed Codex mailbox hooks
#   --help                show this help
#
# Test hooks (executable paths): ORKEST_INSTALL_ORCHESTRATE,
# ORKEST_INSTALL_MONITOR, and ORKEST_INSTALL_DOCTOR.
set -eu

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]

Install Orkest's orchestrate skills, ork CLI, monitor CLI, and monitor MCP server.

Options:
  --dry-run             preview changes without installing monitor or running doctor
  --no-app              skip the monitor macOS menu bar app
  --no-monitor          skip monitor installation and MCP registration
  --no-claude           skip orchestrate's Claude skill links
  --trust-codex-hooks   trust the four reviewed Codex mailbox hooks
  --help                show this help
USAGE
}

dry_run=0
no_app=0
no_monitor=0
no_claude=0
trust_codex_hooks=0
show_help=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --no-app) no_app=1 ;;
    --no-monitor) no_monitor=1 ;;
    --no-claude) no_claude=1 ;;
    --trust-codex-hooks) trust_codex_hooks=1 ;;
    -h|--help) show_help=1 ;;
    *)
      printf 'install: unknown option: %s\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$show_help" -eq 1 ]; then
  usage
  exit 0
fi

script_path=$0
case "$script_path" in
  */*) ;;
  *) script_path=$(command -v "$script_path") ;;
esac
repo_dir=$(CDPATH='' cd -P "$(dirname "$script_path")" && pwd -P)
home_dir=${HOME:-}
if [ -z "$home_dir" ]; then
  printf 'install: HOME must be set\n' >&2
  exit 1
fi

missing_prerequisites=
add_missing_prerequisite() {
  if [ -z "$missing_prerequisites" ]; then
    missing_prerequisites="  - $1"
  else
    missing_prerequisites="$missing_prerequisites
  - $1"
  fi
}

if ! command -v git >/dev/null 2>&1; then
  add_missing_prerequisite 'git'
fi

if ! command -v node >/dev/null 2>&1; then
  add_missing_prerequisite 'Node.js (required version is in package.json engines.node)'
else
  node_check_output=$(node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const requirement = pkg.engines && pkg.engines.node;
const match = typeof requirement === "string" && /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(requirement);
if (!match) {
  console.error(`cannot check package.json engines.node: ${String(requirement)}`);
  process.exit(1);
}
const required = match.slice(1).map(Number);
const current = process.versions.node.split(".").map(Number);
for (let index = 0; index < required.length; index += 1) {
  if (current[index] > required[index]) process.exit(0);
  if (current[index] < required[index]) {
    console.error(`Node.js ${requirement} required; found ${process.versions.node}`);
    process.exit(1);
  }
}
' "$repo_dir/package.json" 2>&1) || node_check_status=$?
  node_check_status=${node_check_status:-0}
  if [ "$node_check_status" -ne 0 ]; then
    add_missing_prerequisite "$node_check_output"
  fi
fi

if ! command -v python3 >/dev/null 2>&1; then
  add_missing_prerequisite 'Python 3.11 or newer'
else
  python_version=$(python3 -c 'import sys; print("%s.%s" % sys.version_info[:2])' 2>/dev/null) || python_version=
  case "$python_version" in
    ''|*[!0-9.]*|.*|*..*|*.)
      add_missing_prerequisite 'Python 3.11 or newer (could not read python3 version)'
      ;;
    *)
      python_major=${python_version%%.*}
      python_minor=${python_version#*.}
      if [ "$python_major" -lt 3 ] || { [ "$python_major" -eq 3 ] && [ "$python_minor" -lt 11 ]; }; then
        add_missing_prerequisite "Python 3.11 or newer required; found $python_version"
      fi
      ;;
  esac
fi

if ! command -v tmux >/dev/null 2>&1; then
  add_missing_prerequisite 'tmux'
fi

if [ -n "$missing_prerequisites" ]; then
  printf 'install: missing required prerequisites:\n%s\n' "$missing_prerequisites" >&2
  exit 1
fi

has_harness=0
for harness in claude codex agy opencode; do
  if command -v "$harness" >/dev/null 2>&1; then
    has_harness=1
  fi
done
if [ "$has_harness" -eq 0 ]; then
  printf 'warning: install at least one harness CLI: claude, codex, agy, or opencode\n' >&2
fi

bin_dir=${ORKEST_BIN_DIR:-$home_dir/.local/bin}
ork_target=$repo_dir/plugins/orchestrate/bin/ork.mjs
ork_link=$bin_dir/ork
orchestrate_installer=${ORKEST_INSTALL_ORCHESTRATE:-$repo_dir/plugins/orchestrate/install.sh}
monitor_installer=${ORKEST_INSTALL_MONITOR:-$repo_dir/plugins/monitor/install.sh}
doctor_override=${ORKEST_INSTALL_DOCTOR:-}
monitor_launcher=$home_dir/.local/bin/monitor

case ":${PATH-}:" in
  *":$bin_dir:"*) ;;
  *)
    printf 'warning: %s is not on PATH. Add this line to your shell profile:\n  export PATH="%s:$PATH"\n' "$bin_dir" "$bin_dir" >&2
    ;;
esac

printf '==> Installing orchestrate\n'
set --
if [ "$dry_run" -eq 1 ]; then set -- "$@" --dry-run; fi
if [ "$no_claude" -eq 1 ]; then set -- "$@" --no-claude; fi
if [ "$trust_codex_hooks" -eq 1 ]; then set -- "$@" --trust-codex-hooks; fi
if [ "$dry_run" -eq 1 ]; then
  printf '  would run: %s' "$orchestrate_installer"
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\n'
else
  printf '  run: %s' "$orchestrate_installer"
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\n'
fi
"$orchestrate_installer" "$@"

if [ "$dry_run" -eq 1 ]; then
  printf '  would run: mkdir -p %s\n' "$bin_dir"
  printf '  would run: ln -sf %s %s\n' "$ork_target" "$ork_link"
else
  mkdir -p "$bin_dir"
  if [ -L "$ork_link" ]; then
    previous_target=$(readlink "$ork_link")
    if [ "$previous_target" = "$ork_target" ]; then
      printf '• %s already linked\n' "$ork_link"
    else
      backup_link=$ork_link.orkest-backup
      backup_index=1
      while [ -e "$backup_link" ] || [ -L "$backup_link" ]; do
        backup_link=$ork_link.orkest-backup.$backup_index
        backup_index=$((backup_index + 1))
      done
      mv "$ork_link" "$backup_link"
      printf '• preserved previous ork symlink at %s\n' "$backup_link"
      ln -sf "$ork_target" "$ork_link"
      printf '✓ %s -> %s\n' "$ork_link" "$ork_target"
    fi
  elif [ -e "$ork_link" ]; then
    printf 'install: refusing to replace non-symlink path: %s\n' "$ork_link" >&2
    exit 1
  else
    ln -sf "$ork_target" "$ork_link"
    printf '✓ %s -> %s\n' "$ork_link" "$ork_target"
  fi
fi

if [ "$no_monitor" -eq 1 ]; then
  printf '==> Skipping monitor installation and MCP registration (--no-monitor)\n'
elif [ "$dry_run" -eq 1 ]; then
  printf '==> Monitor dry-run\n'
  printf '  would run: %s' "$monitor_installer"
  if [ "$no_app" -eq 1 ]; then printf ' --no-app'; fi
  printf '\n'
  printf '  would run: %s mcp-install\n' "$monitor_launcher"
else
  printf '==> Installing monitor\n'
  set --
  if [ "$no_app" -eq 1 ]; then set -- --no-app; fi
  printf '  run: %s' "$monitor_installer"
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\n'
  "$monitor_installer" "$@"
  printf '==> Registering monitor MCP server\n'
  printf '  run: %s mcp-install\n' "$monitor_launcher"
  "$monitor_launcher" mcp-install
fi

if [ "$dry_run" -eq 1 ]; then
  if [ -n "$doctor_override" ]; then
    printf '  would run: %s --check-messaging\n' "$doctor_override"
  else
    printf '  would run: python3 %s doctor --check-messaging\n' "$home_dir/.agents/skills/orchestrate/scripts/run_agent.py"
  fi
  exit 0
fi

printf '==> Checking Orkest setup\n'
if [ -n "$doctor_override" ]; then
  if "$doctor_override" --check-messaging; then
    doctor_status=0
  else
    doctor_status=$?
  fi
else
  if python3 "$home_dir/.agents/skills/orchestrate/scripts/run_agent.py" doctor --check-messaging; then
    doctor_status=0
  else
    doctor_status=$?
  fi
fi

if [ "$doctor_status" -ne 0 ]; then
  printf '✗ Orkest doctor failed (exit %s). Fix the reported checks, then re-run ./install.sh.\n' "$doctor_status" >&2
  exit "$doctor_status"
fi
printf '✓ Orkest doctor passed\n'
