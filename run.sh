#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$SOURCE_DIR/$SOURCE"
done
ROOT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
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

json_escape() {
  sed 's/\\/\\\\/g; s/"/\\"/g'
}

handoff_to_running_app() {
  local target="$1"
  local api_base="http://localhost:17877"
  local status token escaped_target
  if ! status="$(curl -fsS --max-time 1 "$api_base/api/codex-mcp" 2>/dev/null)"; then
    return 1
  fi

  token="$(printf '%s' "$status" | sed -n 's/.*"bearerToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -z "$token" ]; then
    return 1
  fi

  escaped_target="$(printf '%s' "$target" | json_escape)"
  if curl -fsS --max-time 2 \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -X POST \
    --data "{\"path\":\"$escaped_target\"}" \
    "$api_base/api/open-path" >/dev/null; then
    echo "Handed target to running ide: $target"
    return 0
  fi

  return 1
}

running_app_reachable() {
  curl -fsS --max-time 1 "http://localhost:17877/api/codex-mcp" >/dev/null 2>&1
}

# Plain `./run.sh` means "give me a dev instance running this working copy".
# The single-instance plugin makes any running app (usually the installed
# release build) block the dev launch, so quit it first — gracefully, then
# force-killed if it lingers — instead of bailing out.
stop_running_app() {
  echo "Stopping the running ide instance so the dev build can start."
  if command -v osascript >/dev/null 2>&1; then
    osascript -e 'tell application id "com.gordonbeeming.ide" to quit' >/dev/null 2>&1 || true
  fi

  local attempt
  for attempt in {1..20}; do
    if ! running_app_reachable; then
      return 0
    fi
    sleep 0.5
  done

  echo "Graceful quit timed out; force-killing the running ide instance."
  pkill -f "/Applications/ide.app/Contents/MacOS/ide" 2>/dev/null || true
  pkill -f "$ROOT_DIR/src-tauri/target/debug/ide" 2>/dev/null || true
  for attempt in {1..10}; do
    if ! running_app_reachable; then
      return 0
    fi
    sleep 0.5
  done

  echo "An ide instance is still holding the app port after force-kill." >&2
  exit 1
}

if [ -n "$OPEN_PATH" ] && handoff_to_running_app "$OPEN_PATH"; then
  exit 0
fi

if [ -z "$OPEN_PATH" ] && running_app_reachable; then
  stop_running_app
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

# 14717 is ide's own dev port (not Tauri's shared 1420 default), so anything
# still listening on it is a stale ide process — kill it rather than bail.
ensure_dev_port_available() {
  local port="14717"

  # Leftover dev binaries from a crashed run can linger without holding the
  # port; sweep them before checking the listener.
  pkill -f "$ROOT_DIR/src-tauri/target/debug/ide" 2>/dev/null || true

  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi

  local pid command
  for pid in $pids; do
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    echo "Killing stale process on port $port (pid $pid): ${command:-unknown}"
    kill "$pid" 2>/dev/null || true
  done

  local attempt
  for attempt in {1..40}; do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  echo "Port $port still in use after SIGTERM; force-killing."
  for pid in $pids; do
    kill -9 "$pid" 2>/dev/null || true
  done
  for attempt in {1..20}; do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  echo "Port $port is still in use after force-kill." >&2
  exit 1
}

ensure_dev_port_available

exec npm run tauri:dev
