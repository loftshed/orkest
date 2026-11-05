#!/bin/sh
# Remove this checkout's Herdr registration and the orchestrate links install.sh created.
# Real directories, foreign links, route config, job state and backups stay.
set -eu

repo="$(cd "$(dirname "$0")" && pwd -P)"
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
python3 "$repo/skills/orchestrate/scripts/install_mailbox.py" --remove-herdr

hub="$HOME/.agents/skills/orchestrate"
legacy_hub="$HOME/.agents/skills/agent-executor"
remove_link() {
  place="$1"
  if [ -L "$place" ]; then
    if python3 - "$place" "$repo/skills/orchestrate" <<'PY'
import sys
from pathlib import Path

raise SystemExit(0 if Path(sys.argv[1]).resolve() == Path(sys.argv[2]).resolve() else 1)
PY
    then
      rm "$place"
      echo "✓ removed $place"
    else
      echo "• $place belongs to another installation; left alone" >&2
    fi
  elif [ -e "$place" ]; then
    echo "• $place is not a link; left alone" >&2
  fi
}

for place in \
  "$HOME/.claude/skills/orchestrate" \
  "$HOME/.claude/skills/agent-executor" \
  "$HOME/.claude-personal/skills/orchestrate" \
  "$HOME/.claude-personal/skills/agent-executor" \
  "$HOME/.codex/skills/orchestrate" \
  "$HOME/.codex/skills/agent-executor" \
  "$HOME/.config/opencode/skills/orchestrate" \
  "$HOME/.config/opencode/skills/agent-executor" \
  "$HOME/.gemini/config/skills/orchestrate" \
  "$HOME/.gemini/config/skills/agent-executor" \
  "$HOME/.gemini/antigravity/skills/orchestrate" \
  "$HOME/.gemini/antigravity/skills/agent-executor"; do
  remove_link "$place"
done

for claude_dir in "$HOME"/.claude-*; do
  [ -d "$claude_dir" ] || continue
  remove_link "$claude_dir/skills/orchestrate"
  remove_link "$claude_dir/skills/agent-executor"
done

# Harness links can point through these hubs; inspect them before removing the hubs.
remove_link "$legacy_hub"
remove_link "$hub"
