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
DEV_API_PORT="17878"
DEV_VITE_PORT="14717"
DEV_BINARY="$ROOT_DIR/src-tauri/target/debug/ide"
export IDE_LOOPBACK_PORT="$DEV_API_PORT"
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

process_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

process_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

process_is_checkout_dev_binary() {
  local command="$1"
  case "$command" in
    "$DEV_BINARY" | "$DEV_BINARY "*) return 0 ;;
    *) return 1 ;;
  esac
}

process_is_checkout_port_owner() {
  local pid="$1"
  local port="$2"
  local command="$3"

  if [ "$port" = "$DEV_API_PORT" ]; then
    process_is_checkout_dev_binary "$command"
    return
  fi

  if [ "$port" = "$DEV_VITE_PORT" ]; then
    local cwd
    cwd="$(process_cwd "$pid")"
    if [ "$cwd" != "$ROOT_DIR" ]; then
      return 1
    fi
    case "$command" in
      *"$ROOT_DIR/node_modules/"*"vite"*) return 0 ;;
      *) return 1 ;;
    esac
  fi

  return 1
}

port_listener_pids() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

checkout_dev_binary_pids() {
  local pid command
  for pid in $(ps -axo pid=); do
    command="$(process_command "$pid")"
    if process_is_checkout_dev_binary "$command"; then
      printf '%s\n' "$pid"
    fi
  done
}

verify_dev_port_ownership() {
  local port="$1"
  local pids
  pids="$(port_listener_pids "$port")"
  if [ -z "$pids" ]; then
    return 0
  fi

  local pid command
  for pid in $pids; do
    command="$(process_command "$pid")"
    if ! process_is_checkout_port_owner "$pid" "$port" "$command"; then
      echo "Port $port is owned by an unrelated process (pid $pid): ${command:-unknown}" >&2
      return 1
    fi
  done
}

clear_dev_port() {
  local port="$1"
  verify_dev_port_ownership "$port" || return 1

  local pids
  pids="$(port_listener_pids "$port")"
  if [ -z "$pids" ]; then
    return 0
  fi

  local pid command
  for pid in $pids; do
    command="$(process_command "$pid")"
    echo "Killing stale process on port $port (pid $pid): ${command:-unknown}"
    kill "$pid" 2>/dev/null || true
  done

  local attempt
  for attempt in {1..40}; do
    if [ -z "$(port_listener_pids "$port")" ]; then
      return 0
    fi
    sleep 0.25
  done

  echo "Port $port still in use after SIGTERM; force-killing."
  verify_dev_port_ownership "$port" || return 1
  pids="$(port_listener_pids "$port")"
  for pid in $pids; do
    kill -9 "$pid" 2>/dev/null || true
  done
  for attempt in {1..20}; do
    if [ -z "$(port_listener_pids "$port")" ]; then
      return 0
    fi
    sleep 0.25
  done

  echo "Port $port is still in use after force-kill." >&2
  exit 1
}

stop_checkout_dev_binaries() {
  local pids
  pids="$(checkout_dev_binary_pids)"
  if [ -z "$pids" ]; then
    return 0
  fi

  local pid command
  for pid in $pids; do
    command="$(process_command "$pid")"
    if process_is_checkout_dev_binary "$command"; then
      echo "Stopping stale checkout ide-dev process (pid $pid): $command"
      kill "$pid" 2>/dev/null || true
    fi
  done

  local attempt
  for attempt in {1..20}; do
    local running=0
    for pid in $pids; do
      command="$(process_command "$pid")"
      if process_is_checkout_dev_binary "$command"; then
        running=1
        break
      fi
    done
    if [ "$running" -eq 0 ]; then
      return 0
    fi
    sleep 0.25
  done

  for pid in $pids; do
    command="$(process_command "$pid")"
    if process_is_checkout_dev_binary "$command"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

ensure_dev_port_available() {
  # Verify both ports before stopping anything, so an unrelated listener leaves
  # every process untouched and gets reported to the caller.
  verify_dev_port_ownership "$DEV_VITE_PORT" || exit 1
  verify_dev_port_ownership "$DEV_API_PORT" || exit 1
  stop_checkout_dev_binaries
  clear_dev_port "$DEV_VITE_PORT"
  clear_dev_port "$DEV_API_PORT"
}

handoff_to_running_dev_app() {
  local target="$1"
  local api_base="http://127.0.0.1:${DEV_API_PORT}"
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
    echo "Handed target to running ide-dev: $target"
    return 0
  fi

  return 1
}

running_dev_app_reachable() {
  curl -fsS --max-time 1 "http://127.0.0.1:${DEV_API_PORT}/api/codex-mcp" >/dev/null 2>&1
}

# Plain `./run.sh` owns only the development channel. Its distinct bundle
# identifier lets the installed production app continue running untouched.
stop_running_dev_app() {
  verify_dev_port_ownership "$DEV_API_PORT" || return 1
  echo "Stopping the running ide-dev instance so the dev build can start."
  if command -v osascript >/dev/null 2>&1; then
    osascript -e 'tell application id "com.gordonbeeming.ide.dev" to quit' >/dev/null 2>&1 || true
  fi

  local attempt
  for attempt in {1..20}; do
    if ! running_dev_app_reachable; then
      return 0
    fi
    sleep 0.5
  done

  echo "Graceful quit timed out; clearing the ide-dev listener."
  clear_dev_port "$DEV_API_PORT"
  for attempt in {1..10}; do
    if ! running_dev_app_reachable; then
      return 0
    fi
    sleep 0.5
  done

  echo "An ide-dev instance is still holding the development API port after cleanup." >&2
  exit 1
}

if [ -n "$OPEN_PATH" ] && handoff_to_running_dev_app "$OPEN_PATH"; then
  exit 0
fi

if [ -z "$OPEN_PATH" ] && running_dev_app_reachable; then
  stop_running_dev_app || exit 1
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

ensure_dev_port_available

exec npm run tauri:dev -- --config src-tauri/tauri.dev.conf.json
