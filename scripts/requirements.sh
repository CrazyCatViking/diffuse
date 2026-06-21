#!/usr/bin/env bash
set -euo pipefail

mode="${1:-build}"

missing=()

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    missing+=("$1")
  fi
}

need git
need just

case "$mode" in
  build|install)
    need zig
    need node
    need pnpm
    need curl
    need tar
    ;;
  publish)
    need git
    need sed
    ;;
  *)
    echo "Unknown requirements mode: $mode" >&2
    exit 2
    ;;
esac

if ((${#missing[@]} > 0)); then
  echo "Missing required command(s) for $mode: ${missing[*]}" >&2
  echo "Install the missing tools and run the command again." >&2
  exit 1
fi
