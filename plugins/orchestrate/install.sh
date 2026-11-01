#!/bin/sh
# Install orchestrate from this checkout for every agent harness on the machine.
#
#   ./install.sh            link skills and install peer messaging for each installed harness
#   ./install.sh --dry-run  show what would change
#   ./install.sh --trust-codex-hooks  trust only the four reviewed mailbox hooks
#
# ~/.agents/skills/orchestrate points at this checkout; each harness's skills directory points at the
# hub, so moving the checkout means re-running
# this script once. A real directory where a link belongs (an old hand-copied install) is moved to
# ~/.local/share/agent-executor/backups, never deleted. Harnesses that load skills from a Claude plugin
# instead can skip the links with --no-claude.
set -eu

repo="$(cd "$(dirname "$0")" && pwd -P)"
skill="$repo/skills/orchestrate"
hub="$HOME/.agents/skills/orchestrate"
legacy_hub="$HOME/.agents/skills/agent-executor"
backups="${XDG_DATA_HOME:-$HOME/.local/share}/agent-executor/backups"
dry_run=0
with_claude=1
trust_hooks=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --no-claude) with_claude=0 ;;
    --trust-codex-hooks) trust_hooks=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
[ -f "$skill/SKILL.md" ] || { echo "no skill at $skill" >&2; exit 1; }

run() {
  if [ "$dry_run" = 1 ]; then echo "  would: $*"; else "$@"; fi
}

# Point $2 at $1. A link is replaced; a real directory is moved aside first.
link() {
  target="$1" place="$2"
  if [ -L "$place" ]; then
    [ "$(readlink "$place")" = "$target" ] && { echo "• $place already linked"; return; }
  fi
  if [ -L "$place" ] || [ -e "$place" ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    dest="$backups/$stamp$(dirname "$place" | tr / _)"
    run mkdir -p "$dest"
    run mv "$place" "$dest/"
    echo "• moved the old copy at $place to $dest/"
  fi
  run mkdir -p "$(dirname "$place")"
  run ln -s "$target" "$place"
  echo "✓ $place -> $target"
}

retire_legacy() {
  place="$1"
  if [ -L "$place" ] || [ -e "$place" ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    dest="$backups/$stamp$(dirname "$place" | tr / _)"
    run mkdir -p "$dest"
    run mv "$place" "$dest/"
    echo "• preserved the old skill at $place in $dest/"
  fi
}

retire_legacy_skills() {
  for place in \
    "$legacy_hub" \
    "$HOME/.claude/skills/agent-executor" \
    "$HOME/.claude-personal/skills/agent-executor" \
    "$HOME/.codex/skills/agent-executor" \
    "$HOME/.config/opencode/skills/agent-executor" \
    "$HOME/.gemini/config/skills/agent-executor" \
    "$HOME/.gemini/antigravity/skills/agent-executor"; do
    case "$place" in
      "$HOME/.claude/skills/"*|"$HOME/.claude-personal/skills/"*) [ "$with_claude" = 1 ] || continue ;;
    esac
    retire_legacy "$place"
  done
}

link "$skill" "$hub"

# Harness skill directories, linked only when that harness is installed (its config dir exists).
for entry in \
  "$HOME/.claude:skills:claude" \
  "$HOME/.claude-personal:skills:claude" \
  "$HOME/.codex:skills:codex" \
  "$HOME/.config/opencode:skills:opencode" \
  "$HOME/.gemini/config:skills:gemini" \
  "$HOME/.gemini/antigravity:skills:gemini"; do
  base="${entry%%:*}" rest="${entry#*:}"
  sub="${rest%%:*}" kind="${rest#*:}"
  [ -d "$base" ] || continue
  if [ "$kind" = claude ] && [ "$with_claude" = 0 ]; then continue; fi
  link "$hub" "$base/$sub/orchestrate"
done

set --
[ "$trust_hooks" = 0 ] || set -- --trust-codex-hooks
if [ "$dry_run" = 1 ]; then
  python3 "$skill/scripts/install_mailbox.py" --dry-run "$@"
  retire_legacy_skills
  exit 0
fi

config="${AGENT_EXECUTOR_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-executor/config.json}"
if [ -f "$config" ]; then
  echo "• route config exists: $config"
else
  python3 "$skill/scripts/run_agent.py" init
fi
python3 "$skill/scripts/install_mailbox.py" "$@"
retire_legacy_skills
echo
python3 "$skill/scripts/run_agent.py" doctor
