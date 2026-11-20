#!/bin/sh
# Builds "OrkestHUD.app", a floating Swift/AppKit HUD toast presenter for Orkest.
# Usage: macos/build.sh [app path]   (default: ~/.cache/orchestrate/macos/OrkestHUD.app)
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
app="${1:-${ORKEST_HUD_APP:-$HOME/.cache/orchestrate/macos/OrkestHUD.app}}"

mkdir -p "$app/Contents/MacOS"
xcrun swiftc -O -swift-version 5 -framework AppKit -framework QuartzCore -o "$app/Contents/MacOS/OrkestHUD" "$here/hud.swift"

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>OrkestHUD</string>
  <key>CFBundleDisplayName</key><string>OrkestHUD</string>
  <key>CFBundleIdentifier</key><string>local.orkest.hud</string>
  <key>CFBundleExecutable</key><string>OrkestHUD</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>OrkestHUDBuildHash</key><string>${ORKEST_HUD_BUILD_HASH:-}</string>
</dict>
</plist>
EOF

codesign --force --sign - "$app" >/dev/null 2>&1 || true
echo "built $app"
