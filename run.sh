#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

export PATH="$HOME/.local/bin:$HOME/Library/pnpm:$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
if ! command -v npm >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell bash)"
fi

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

ensure_dev_port_available() {
  local port="1420"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi

  local pid command cwd
  for pid in $pids; do
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
    if [ "$cwd" = "$ROOT_DIR" ] && [[ "$command" == *"/node_modules/.bin/vite"* ]]; then
      echo "Stopping stale Ide dev server on port $port (pid $pid)."
      kill "$pid"
    else
      echo "Port $port is already in use by another process:" >&2
      echo "  pid: ${pid:-unknown}" >&2
      echo "  command: ${command:-unknown}" >&2
      exit 1
    fi
  done

  local attempt
  for attempt in {1..40}; do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  echo "Port $port is still in use after stopping the stale Ide dev server." >&2
  exit 1
}

ensure_dev_port_available

exec npm run tauri:dev
