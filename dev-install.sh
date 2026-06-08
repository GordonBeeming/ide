#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_BUNDLE="$ROOT_DIR/src-tauri/target/release/bundle/macos/ide.app"
INSTALLED_APP="${IDE_INSTALLED_APP_PATH:-/Applications/ide.app}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "dev-install.sh currently installs the packaged macOS app only." >&2
  echo "Use ./build.sh to build the local package on this platform." >&2
  exit 1
fi

"$ROOT_DIR/build.sh"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "Packaged app was not found after build:" >&2
  echo "  $APP_BUNDLE" >&2
  exit 1
fi

escape_applescript_string() {
  sed 's/\\/\\\\/g; s/"/\\"/g'
}

shell_quote() {
  printf "%q" "$1"
}

refresh_app_indexes() {
  local app_path="$1"
  touch "$app_path" || true
  if command -v mdimport >/dev/null 2>&1; then
    mdimport "$app_path" >/dev/null 2>&1 || true
  fi
  if [[ -x /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister ]]; then
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
      -f "$app_path" >/dev/null 2>&1 || true
  fi
}

quit_running_app() {
  osascript -e 'tell application id "com.gordonbeeming.ide" to quit' >/dev/null 2>&1 || true
}

copy_app_directly() {
  local source_app="$1"
  local installed_app="$2"
  mkdir -p "$(dirname "$installed_app")"
  rm -rf "$installed_app"
  ditto "$source_app" "$installed_app"
}

copy_app_with_admin_prompt() {
  local source_app="$1"
  local installed_app="$2"
  local command escaped_command
  command="mkdir -p $(shell_quote "$(dirname "$installed_app")") && rm -rf $(shell_quote "$installed_app") && ditto $(shell_quote "$source_app") $(shell_quote "$installed_app") && touch $(shell_quote "$installed_app")"
  escaped_command="$(printf "%s" "$command" | escape_applescript_string)"

  osascript <<OSA
display dialog "Install the freshly built ide.app into Applications? macOS will ask for permission if needed." buttons {"Cancel", "Install"} default button "Install"
do shell script "$escaped_command" with administrator privileges
OSA
}

echo "Preparing to install:"
echo "  $APP_BUNDLE"
echo "to:"
echo "  $INSTALLED_APP"

quit_running_app

if [[ -d "$(dirname "$INSTALLED_APP")" && -w "$(dirname "$INSTALLED_APP")" ]]; then
  copy_app_directly "$APP_BUNDLE" "$INSTALLED_APP"
else
  copy_app_with_admin_prompt "$APP_BUNDLE" "$INSTALLED_APP"
fi

refresh_app_indexes "$INSTALLED_APP"

open -R "$INSTALLED_APP"

echo "Installed app:"
echo "  $INSTALLED_APP"
echo "If Spotlight still shows the old icon, give Spotlight a moment or relaunch Finder/Dock; macOS caches app icons aggressively."
