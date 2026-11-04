#!/bin/sh
# Remove the orchestrate links install.sh created. Only links are removed: real directories,
# the route config (~/.config/orchestrate), job state (~/.cache/orchestrate) and backups stay.
set -eu

hub="$HOME/.agents/skills/orchestrate"
legacy_hub="$HOME/.agents/skills/agent-executor"
remove_link() {
  place="$1"
  if [ -L "$place" ]; then
    rm "$place"
    echo "✓ removed $place"
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

remove_link "$legacy_hub"
remove_link "$hub"
