#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="Open in ide"
SERVICE_ROOT="${IDE_SERVICE_ROOT:-$HOME/Library/Services/$SERVICE_NAME.workflow}"
SERVICE_DIR="$SERVICE_ROOT/Contents"
SUPPORT_DIR="${IDE_SUPPORT_DIR:-$HOME/Library/Application Support/ide}"
RUNNER="$SUPPORT_DIR/open-from-finder.sh"
SERVICES_DIR="$(dirname "$SERVICE_ROOT")"

mkdir -p "$SERVICE_DIR" "$SUPPORT_DIR"

cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail

TARGET="\${1:-}"
APP_BUNDLE="/Applications/ide.app"
API_BASE="http://127.0.0.1:17877"

LOG_DIR="\$HOME/Library/Logs/ide"
mkdir -p "\$LOG_DIR"
exec >> "\$LOG_DIR/finder-open.log" 2>&1
echo
echo "=== \$(date '+%Y-%m-%dT%H:%M:%S%z') Open in ide ==="

if [ -z "\$TARGET" ] || [ ! -e "\$TARGET" ]; then
  echo "Invalid Finder target: \${TARGET:-<empty>}"
  osascript -e 'display alert "ide" message "The selected file or folder could not be opened." as critical' >/dev/null 2>&1 || true
  exit 1
fi
echo "Target: \$TARGET"

json_escape() {
  sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'
}

handoff_to_running_app() {
  local status token escaped_target
  if ! status="\$(curl -fsS --max-time 1 "\$API_BASE/api/codex-mcp" 2>/dev/null)"; then
    return 1
  fi

  token="\$(printf '%s' "\$status" | sed -n 's/.*"bearerToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -z "\$token" ]; then
    echo "Running app did not return a bearer token."
    return 1
  fi

  escaped_target="\$(printf '%s' "\$TARGET" | json_escape)"
  if curl -fsS --max-time 2 \\
    -H "Authorization: Bearer \$token" \\
    -H "Content-Type: application/json" \\
    -X POST \\
    --data "{\\"path\\":\\"\$escaped_target\\"}" \\
    "\$API_BASE/api/open-path" >/dev/null; then
    echo "Handed target to running ide at \$API_BASE."
    return 0
  fi

  echo "Running app rejected /api/open-path handoff."
  return 1
}

if handoff_to_running_app; then
  exit 0
fi

if [ ! -x "\$APP_BUNDLE/Contents/MacOS/ide" ]; then
  echo "Production ide app was not found: \$APP_BUNDLE"
  osascript -e 'display alert "ide" message "Install ide with Homebrew before using Open in ide." as critical' >/dev/null 2>&1 || true
  exit 1
fi

echo "Opening target with production ide."
if ! open "\$APP_BUNDLE" --args "\$TARGET" >/dev/null 2>&1; then
  echo "Unable to open production ide at \$APP_BUNDLE."
  osascript -e 'display alert "ide" message "The production ide app could not be opened." as critical' >/dev/null 2>&1 || true
  exit 1
fi
EOF
chmod 755 "$RUNNER"

cat > "$SERVICE_DIR/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSBackgroundColorName</key>
      <string>background</string>
      <key>NSMenuItem</key>
      <dict>
        <key>default</key>
        <string>Open in ide</string>
      </dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      <key>NSRequiredContext</key>
      <dict>
        <key>NSApplicationIdentifier</key>
        <string>com.apple.finder</string>
      </dict>
      <key>NSSendFileTypes</key>
      <array>
        <string>public.item</string>
        <string>public.folder</string>
        <string>public.data</string>
        <string>public.content</string>
      </array>
      <key>NSSendTypes</key>
      <array>
        <string>NSFilenamesPboardType</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
EOF

cat > "$SERVICE_DIR/document.wflow" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key>
  <string>521</string>
  <key>AMApplicationVersion</key>
  <string>2.10</string>
  <key>AMDocumentVersion</key>
  <string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Optional</key>
          <false/>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.path</string>
          </array>
        </dict>
        <key>AMActionVersion</key>
        <string>2.0.3</string>
        <key>AMApplication</key>
        <array>
          <string>Finder</string>
        </array>
        <key>AMParameterProperties</key>
        <dict/>
        <key>AMProvides</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.path</string>
          </array>
        </dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key>
        <string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key>
          <string>if [ "$#" -gt 0 ]; then
  for target in "$@"; do
    "$HOME/Library/Application Support/ide/open-from-finder.sh" "$target"
    exit 0
  done
fi

while IFS= read -r target; do
  if [ -n "$target" ]; then
    "$HOME/Library/Application Support/ide/open-from-finder.sh" "$target"
    exit 0
  fi
done

osascript -e 'display alert "ide" message "Finder did not pass a file or folder to Open in ide." as critical' >/dev/null 2&gt;&amp;1 || true
exit 1</string>
          <key>CheckedForUserDefaultShell</key>
          <true/>
          <key>inputMethod</key>
          <integer>1</integer>
          <key>shell</key>
          <string>/bin/zsh</string>
          <key>source</key>
          <string></string>
        </dict>
        <key>BundleIdentifier</key>
        <string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key>
        <string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key>
        <true/>
        <key>CanShowWhenRun</key>
        <true/>
        <key>Category</key>
        <array>
          <string>AMCategoryFilesAndFolders</string>
        </array>
        <key>Class Name</key>
        <string>RunShellScriptAction</string>
        <key>InputUUID</key>
        <string>4C7CFD7A-BE53-4F32-9077-8DB19A57D2AD</string>
        <key>Keywords</key>
        <array>
          <string>Shell</string>
          <string>Script</string>
          <string>Command</string>
          <string>Run</string>
          <string>Unix</string>
        </array>
        <key>OutputUUID</key>
        <string>B56E6F52-9CE2-49E9-A25C-19D85E94E43A</string>
        <key>UUID</key>
        <string>80C521D8-1FA7-46C1-937F-0C7D1EA43F08</string>
        <key>UnlocalizedApplications</key>
        <array>
          <string>Finder</string>
        </array>
        <key>arguments</key>
        <dict>
          <key>0</key>
          <dict>
            <key>default value</key>
            <integer>0</integer>
            <key>name</key>
            <string>inputMethod</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>0</string>
          </dict>
          <key>1</key>
          <dict>
            <key>default value</key>
            <string></string>
            <key>name</key>
            <string>source</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>1</string>
          </dict>
        </dict>
        <key>isViewVisible</key>
        <true/>
        <key>location</key>
        <string>309.000000:367.000000</string>
        <key>nibPath</key>
        <string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/English.lproj/main.nib</string>
      </dict>
    </dict>
  </array>
  <key>connectors</key>
  <dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>applicationBundleID</key>
    <string>com.apple.finder</string>
    <key>applicationBundleIDsByPath</key>
    <dict>
      <key>/System/Library/CoreServices/Finder.app</key>
      <string>com.apple.finder</string>
    </dict>
    <key>applicationPath</key>
    <string>/System/Library/CoreServices/Finder.app</string>
    <key>applicationPaths</key>
    <array>
      <string>/System/Library/CoreServices/Finder.app</string>
    </array>
    <key>inputTypeIdentifier</key>
    <string>com.apple.Automator.fileSystemObject</string>
    <key>outputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>presentationMode</key>
    <integer>15</integer>
    <key>processesInput</key>
    <true/>
    <key>serviceApplicationBundleID</key>
    <string>com.apple.finder</string>
    <key>serviceApplicationPath</key>
    <string>/System/Library/CoreServices/Finder.app</string>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.fileSystemObject</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key>
    <true/>
    <key>useAutomaticInputType</key>
    <false/>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
EOF

touch "$SERVICE_ROOT"
if [ -z "${IDE_SKIP_SERVICE_REFRESH:-}" ]; then
  touch "$SERVICES_DIR"
  /System/Library/CoreServices/pbs -flush >/dev/null 2>&1 || true
fi

echo "Installed Finder Quick Action: $SERVICE_NAME"
echo "Use Finder > right-click a file or folder > Quick Actions > $SERVICE_NAME."
