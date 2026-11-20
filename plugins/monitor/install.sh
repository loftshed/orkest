#!/bin/sh
# Installs monitor: a CLI launcher in ~/.local/bin, a starter config, the menu bar app with a
# login LaunchAgent, and (with --mcp) the MCP server registration for every agent CLI.
#
#   ./install.sh            CLI + menu bar app
#   ./install.sh --mcp      also register the MCP server with Claude Code, Codex and agy
#                           (the root install.sh always does)
#   ./install.sh --no-app   CLI only
#   ./install.sh --runtime-only  refresh the installed copy, launcher and skill link only (used by `ork update`)
set -eu

repo="$(cd "$(dirname "$0")" && pwd)"
with_app=1
with_mcp=0
runtime_only=0
for arg in "$@"; do
  case "$arg" in
    --runtime-only) runtime_only=1 ;;
    --no-app) with_app=0 ;;
    --mcp) with_mcp=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Prefer a stable non-shim path over `node -p process.execPath` (which resolves Homebrew symlinks into a
# versioned Cellar directory that breaks on `brew upgrade node`, falling back to `volta-shim` and spawning
# two processes per invocation).
resolve_node() {
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  if command -v volta >/dev/null 2>&1; then
    volta_node="$(volta which node 2>/dev/null || true)"
    if [ -n "$volta_node" ] && [ -x "$volta_node" ]; then
      printf '%s\n' "$volta_node"
      return
    fi
  fi
  node -p process.execPath
}
node_bin="$(resolve_node)"
rmtree() { node -e 'require("fs").rmSync(process.argv[1], { recursive: true, force: true })' "$1"; }

# The launcher runs an installed copy, not the checkout. The menu bar app and MCP servers run monitor in
# the background, and macOS privacy protection makes background access to ~/Documents (where checkouts
# usually live) wait on a permission prompt, repeated for every rebuild of the ad-hoc-signed app.
#
# The copy mirrors the checkout's layout, so the relative imports and the version lookup resolve exactly as
# they do there: package.json, src/bin/{monitor,observe}.mjs, src/lib/monitor and skills/monitor. Only
# those paths are managed. The new copy is staged beside the live one, starting from everything already
# installed (custom files, a pre-`src/` bin/ and lib/, links you made), has its managed paths replaced, and
# is swapped in only once it reports the right version. The previous copy moves to
# ~/.local/share/monitor-backups; nothing is deleted.
runtime="$HOME/.local/share/monitor"
backups="$HOME/.local/share/monitor-backups"
root="$(cd "$repo/../.." && pwd -P)"
for needed in "$root/package.json" "$root/src/bin/monitor.mjs" "$root/src/bin/observe.mjs" "$root/src/lib/monitor" "$repo/skills/monitor/SKILL.md" "$repo/config.example.json"; do
  [ -e "$needed" ] || { echo "install: missing $needed" >&2; exit 1; }
done
# Enumerate shipped leaves so local additions beside managed modules survive upgrades.
managed="$(printf '%s\n' package.json config.example.json src/bin/monitor.mjs src/bin/observe.mjs
  (cd "$root" && find src/lib/monitor -type f -print)
  (cd "$repo" && find skills/monitor -type f -print))"
version="$(node -p "require(process.argv[1]).version" "$root/package.json")"

# A link of ours points at a known destination: a checkout's own monitor skill (where earlier installs linked it),
# this runtime's skill, or the hub. Every other link, dangling or not, was made by the user and is left alone.
owned_link() {
  [ -L "$1" ] || return 1
  case "$(readlink "$1")" in
    */plugins/monitor/skills/monitor|"$runtime/skills/monitor"|"$HOME/.agents/skills/monitor") return 0 ;;
    *) return 1 ;;
  esac
}

mkdir -p "$(dirname "$runtime")"
stage="$(mktemp -d "$runtime.new.XXXXXX")"
chmod 755 "$stage"
if [ -d "$runtime" ]; then
  cp -Rp "$runtime/." "$stage/"
fi
# Park the staged copy under the backups (never deleted) and stop, leaving the live runtime as it was.
abandon() {
  mkdir -p "$backups"
  parked="$backups/failed-$(date +%Y%m%d-%H%M%S)-$$"
  mv "$stage" "$parked"
  echo "install: $1; the existing runtime was left in place (staged copy kept at $parked)" >&2
  exit 1
}
while IFS= read -r item; do
  # A link above a managed path, ours or not, is never written through.
  parent="$(dirname "$item")"
  walked=
  for part in $(printf '%s' "$parent" | tr '/' ' '); do
    walked="${walked:+$walked/}$part"
    [ -L "$stage/$walked" ] && abandon "$runtime/$walked is a link, so $item cannot be installed through it"
  done
  if [ -L "$stage/$item" ] && ! owned_link "$stage/$item"; then
    echo "• $runtime/$item is your own link; left alone" >&2
    continue
  fi
  if [ -d "$stage/$item" ] && [ ! -L "$stage/$item" ]; then
    abandon "$runtime/$item is a directory where a managed file is needed"
  fi
  if [ -e "$stage/$item" ] || [ -L "$stage/$item" ]; then
    # Only managed leaves are replaced, inside the staged copy; the live runtime is untouched until the swap.
    rmtree "$stage/$item"
  fi
  mkdir -p "$stage/$(dirname "$item")"
  case "$item" in
    package.json)
      node -e '
const [version, file] = process.argv.slice(1);
const manifest = {
  name: "monitor",
  version,
  private: true,
  type: "module",
  bin: { monitor: "src/bin/monitor.mjs" },
  engines: { node: ">=22" },
};
require("fs").writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' "$version" "$stage/package.json" ;;
    config.example.json) cp "$repo/config.example.json" "$stage/$item" ;;
    skills/monitor/*) cp -p "$repo/$item" "$stage/$item" ;;
    *) cp -p "$root/$item" "$stage/$item" ;;
  esac
done <<EOF
$managed
EOF
staged_version="$("$node_bin" "$stage/src/bin/monitor.mjs" --version)" || staged_version=
if [ "$staged_version" != "$version" ]; then
  abandon "the staged runtime did not report version $version (got '$staged_version')"
fi

same=1
if [ -d "$runtime" ]; then
  while IFS= read -r item; do
    diff -r "$stage/$item" "$runtime/$item" >/dev/null 2>&1 || same=0
  done <<EOF
$managed
EOF
else
  same=0
fi
if [ "$same" = 1 ]; then
  rmtree "$stage"
  echo "• runtime unchanged: $runtime ($version)"
else
  previous=
  if [ -e "$runtime" ]; then
    mkdir -p "$backups"
    previous="$backups/runtime-$(date +%Y%m%d-%H%M%S)-$$"
    mv "$runtime" "$previous"
  fi
  if ! mv "$stage" "$runtime"; then
    [ -z "$previous" ] || mv "$previous" "$runtime"
    echo "install: could not move the staged runtime into place; restored the previous one" >&2
    exit 1
  fi
  [ -z "$previous" ] || echo "• previous runtime kept: $previous"
  echo "✓ runtime: $runtime ($version)"
fi

launcher="$HOME/.local/bin/monitor"
mkdir -p "$HOME/.local/bin"
launcher_tmp="$(mktemp "$launcher.XXXXXX")"
cat > "$launcher_tmp" <<EOF
#!/bin/sh
# Generated by $repo/install.sh; re-run it after pulling changes.
NODE="$node_bin"
[ -x "\$NODE" ] || NODE="\$(command -v node)" || { echo "monitor: node not found" >&2; exit 127; }
exec "\$NODE" "$runtime/src/bin/monitor.mjs" "\$@"
EOF
chmod 755 "$launcher_tmp"
mv "$launcher_tmp" "$launcher"
echo "✓ launcher: $launcher (node: $node_bin)"

config="${MONITOR_CONFIG:-$HOME/.config/monitor/config.json}"
if [ "$runtime_only" = 1 ]; then
  :
elif [ ! -f "$config" ]; then
  "$launcher" init
else
  echo "• config exists: $config"
fi

# Skill for every harness: ~/.agents/skills is the hub (Gemini CLI reads it directly); Claude Code profiles,
# Codex, agy and OpenCode get a link to it where installed.
# Point $2 at $1. Replaces an old, dangling or historical link of ours (e.g. after moving the checkout), never a
# real file or directory, and never a link the user pointed somewhere else.
link() {
  if [ ! -e "$2" ] && [ ! -L "$2" ]; then
    ln -sfn "$1" "$2"
  elif owned_link "$2"; then
    ln -sfn "$1" "$2"
  else
    echo "• $2 exists and is not a link of ours; left alone" >&2
  fi
}
skill_hub="$HOME/.agents/skills/monitor"
mkdir -p "$HOME/.agents/skills"
link "$runtime/skills/monitor" "$skill_hub"
for base in "$HOME/.claude" "$HOME"/.claude-* "$HOME/.codex" "$HOME/.gemini/config" "$HOME/.config/opencode"; do
  [ -d "$base" ] || continue
  mkdir -p "$base/skills"
  link "$skill_hub" "$base/skills/monitor"
done
echo "✓ skill linked: $skill_hub (+ Claude Code, Codex, agy and OpenCode where installed)"
[ "$runtime_only" = 0 ] || exit 0

if [ "$with_app" = 1 ] && [ "$(uname)" != Darwin ]; then
  echo "• skipping the menu bar app (macOS only); use 'monitor watch' instead"
  with_app=0
fi

if [ "$with_app" = 1 ]; then
  app="$HOME/Applications/Monitor.app"
  # Rebuild only when the app itself changes. It is ad-hoc signed, so macOS privacy settings identify it by
  # its exact code: every rebuild made macOS forget an "Allow" and ask again.
  build_hash="$(cat "$repo/macos/main.swift" "$repo/macos/build.sh" | shasum -a 256 | cut -c1-16):$launcher"
  installed_hash="$(/usr/libexec/PlistBuddy -c 'Print :MonitorBuildHash' "$app/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$build_hash" != "$installed_hash" ]; then
    MONITOR_COMMAND="$launcher" MONITOR_BUILD_HASH="$build_hash" "$repo/macos/build.sh" "$app"
  else
    echo "• menu bar app unchanged, not rebuilt (keeps its macOS privacy permissions)"
  fi
  plist="$HOME/Library/LaunchAgents/local.monitor.bar.plist"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.monitor.bar</string>
  <key>ProgramArguments</key><array><string>$app/Contents/MacOS/MonitorBar</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF
  service="gui/$(id -u)/local.monitor.bar"
  launchctl bootout "$service" 2>/dev/null || true
  # bootout returns before the old instance is gone; bootstrapping too early fails with "5: Input/output error".
  tries=0
  while launchctl print "$service" >/dev/null 2>&1 && [ "$tries" -lt 50 ]; do sleep 0.1; tries=$((tries + 1)); done
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "✓ menu bar app running and set to start at login ($plist)"
fi

if [ "$with_mcp" = 1 ]; then
  "$launcher" mcp-install
fi
