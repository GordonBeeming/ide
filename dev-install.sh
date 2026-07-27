#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "dev-install.sh currently installs the packaged macOS development app only." >&2
  echo "Use ./build.sh to build the local package on this platform." >&2
  exit 1
fi

exec "$ROOT_DIR/build.sh"
