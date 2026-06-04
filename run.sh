#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

OPEN_PATH="${1:-}"
if [ -n "$OPEN_PATH" ]; then
  if [ ! -e "$OPEN_PATH" ]; then
    echo "Open target does not exist: $OPEN_PATH" >&2
    exit 1
  fi
  export IDE_OPEN_PATH="$OPEN_PATH"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js 24 or newer." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required. Install Rust 1.95 or newer." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install
fi

exec npm run tauri:dev
