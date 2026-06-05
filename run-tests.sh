#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

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

npm test
npm run build
npm audit --audit-level=moderate

(
  cd src-tauri
  cargo test
  cargo check
  if command -v cargo-audit >/dev/null 2>&1; then
    cargo audit --deny warnings
  else
    echo "cargo-audit is not installed; Rust advisory scan skipped. Install with: cargo install cargo-audit" >&2
  fi
)
