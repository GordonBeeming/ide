#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

export PATH="$HOME/.local/bin:$HOME/Library/pnpm:$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
if ! command -v npm >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell bash)"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js 24 or newer." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required. Install Rust 1.95 or newer." >&2
  exit 1
fi

APP_BUNDLE="$ROOT_DIR/src-tauri/target/release/bundle/macos/ide.app"
INSTALLED_APP="${IDE_INSTALLED_APP_PATH:-/Applications/ide.app}"
INSTALLED_APP_UPDATED=0

npm run tauri -- build --bundles app

if [[ -d "$(dirname "$INSTALLED_APP")" && -w "$(dirname "$INSTALLED_APP")" ]]; then
  ditto "$APP_BUNDLE" "$INSTALLED_APP"
  touch "$INSTALLED_APP"
  if command -v mdimport >/dev/null 2>&1; then
    mdimport "$INSTALLED_APP" >/dev/null 2>&1 || true
  fi
  INSTALLED_APP_UPDATED=1
else
  echo
  echo "WARNING: /Applications app was not updated."
  echo "Skipped app install because $(dirname "$INSTALLED_APP") is not writable:"
  echo "  $INSTALLED_APP"
  echo "Run ./dev-install.sh to install the rebuilt app with a macOS admin prompt."
fi

CLI_APP_BUNDLE="$APP_BUNDLE"
if [[ "$INSTALLED_APP_UPDATED" -eq 1 ]]; then
  CLI_APP_BUNDLE="$INSTALLED_APP"
fi
IDE_CLI_APP_BUNDLE_PATH="$CLI_APP_BUNDLE" "$ROOT_DIR/scripts/install-cli-command.sh"

echo
echo "Packaged app:"
echo "  $APP_BUNDLE"
if [[ "$INSTALLED_APP_UPDATED" -eq 1 ]]; then
  echo "Installed app:"
  echo "  $INSTALLED_APP"
else
  echo "Installed app:"
  echo "  not updated"
fi
