#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build.sh packages the macOS development app only." >&2
  echo "Use npm run tauri -- build on this platform." >&2
  exit 1
fi
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

DEV_TAURI_CONFIG="$ROOT_DIR/src-tauri/tauri.dev.conf.json"
DEV_APP_BUNDLE="$ROOT_DIR/src-tauri/target/release/bundle/macos/ide-dev.app"
DEV_INSTALLED_APP_INPUT="${IDE_DEV_INSTALLED_APP_PATH:-$HOME/Applications/ide-dev.app}"
DEV_BUNDLE_IDENTIFIER="com.gordonbeeming.ide.dev"

resolve_dev_install_parent() {
  local parent="$1"
  local suffix=""

  while [[ ! -d "$parent" ]]; do
    if [[ -e "$parent" || -L "$parent" ]]; then
      echo "Development app parent contains a non-directory component: $parent" >&2
      return 1
    fi

    local component next_parent
    component="$(basename "$parent")"
    next_parent="$(dirname "$parent")"
    if [[ "$component" == "." || "$component" == ".." || "$next_parent" == "$parent" ]]; then
      echo "Development app parent could not be resolved safely: $1" >&2
      return 1
    fi
    suffix="/$component$suffix"
    parent="$next_parent"
  done

  local resolved_parent
  resolved_parent="$(cd -P "$parent" && pwd)"
  printf '%s%s\n' "$resolved_parent" "$suffix"
}

resolve_dev_install_path() {
  local app_path="$1"

  if [[ "$app_path" != /* || "$(basename "$app_path")" != "ide-dev.app" ]]; then
    echo "Development app install path must be an absolute ide-dev.app bundle: $app_path" >&2
    return 1
  fi

  case "/${app_path#/}/" in
    */./* | */../* | *//* )
      echo "Development app install path must not contain dot or empty segments: $app_path" >&2
      return 1
      ;;
  esac

  if [[ -L "$app_path" ]]; then
    echo "Development app install path must not be a symbolic link: $app_path" >&2
    return 1
  fi

  local resolved_parent
  resolved_parent="$(resolve_dev_install_parent "$(dirname "$app_path")")" || return 1

  case "$resolved_parent" in
    / | /Applications | /Applications/* | /System/Volumes/Data/Applications | /System/Volumes/Data/Applications/*)
      echo "Refusing to install a development app under $resolved_parent" >&2
      return 1
      ;;
  esac

  printf '%s/ide-dev.app\n' "$resolved_parent"
}

resolve_dev_signing_identity() {
  if [[ -n "${IDE_DEV_SIGNING_IDENTITY:-}" ]]; then
    printf '%s\n' "$IDE_DEV_SIGNING_IDENTITY"
    return 0
  fi

  if command -v security >/dev/null 2>&1; then
    local identity
    identity="$(security find-identity -v -p codesigning 2>/dev/null | sed -nE 's/.*"([^\"]*Apple Development:[^\"]*)".*/\1/p' | sed -n '1p')"
    if [[ -n "$identity" ]]; then
      printf '%s\n' "$identity"
      return 0
    fi
  fi

  printf '%s\n' "-"
}

verify_dev_app_signature() {
  local app_path="$1"
  if ! codesign --verify --deep --strict "$app_path"; then
    echo "Development app signature verification failed: $app_path" >&2
    exit 1
  fi
}

sign_dev_app() {
  local app_path="$1"
  local signing_identity

  if ! command -v codesign >/dev/null 2>&1; then
    echo "codesign is required to package the macOS development app." >&2
    exit 1
  fi

  signing_identity="$(resolve_dev_signing_identity)"
  echo "Signing development app with: $signing_identity"

  codesign --force --deep --sign "$signing_identity" "$app_path"
  codesign --force --sign "$signing_identity" --identifier "$DEV_BUNDLE_IDENTIFIER" "$app_path"
  verify_dev_app_signature "$app_path"
}

install_dev_app() {
  local source_app="$1"
  local installed_app="$2"

  mkdir -p "$(dirname "$installed_app")"
  rm -rf "$installed_app"
  ditto "$source_app" "$installed_app"
  touch "$installed_app"
  verify_dev_app_signature "$installed_app"
  if command -v mdimport >/dev/null 2>&1; then
    mdimport "$installed_app" >/dev/null 2>&1 || true
  fi
}

if [[ ! -f "$DEV_TAURI_CONFIG" ]]; then
  echo "Development Tauri config was not found: $DEV_TAURI_CONFIG" >&2
  exit 1
fi

DEV_INSTALLED_APP="$(resolve_dev_install_path "$DEV_INSTALLED_APP_INPUT")"

npm run tauri -- build --bundles app --config "$DEV_TAURI_CONFIG"

if [[ ! -d "$DEV_APP_BUNDLE" ]]; then
  echo "Packaged development app was not found after build:" >&2
  echo "  $DEV_APP_BUNDLE" >&2
  exit 1
fi

sign_dev_app "$DEV_APP_BUNDLE"
install_dev_app "$DEV_APP_BUNDLE" "$DEV_INSTALLED_APP"

"$ROOT_DIR/scripts/install-cli-command.sh"

echo
echo "Packaged development app:"
echo "  $DEV_APP_BUNDLE"
echo "Installed development app:"
echo "  $DEV_INSTALLED_APP"
