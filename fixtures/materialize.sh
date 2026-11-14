#!/usr/bin/env bash
# Purpose: turn a checked-out fixture tree into the state the scenarios declare.
# Usage:   bash fixtures/materialize.sh [--root <dir>] [scenario ...]
#            --root       tree that holds the scenarios (default: this script's directory)
#            scenario     one of clean dirty-dev dirty-business hostile partial (default: all)
# Notes:   Two things cannot survive a git checkout, so they are re-applied here:
#            1. real git repositories — committed as `.git.fixture`, renamed back to `.git`
#            2. the `hostile` permission faults — unreadable directories and files
#          `--root` lets the same script materialise a copy: the integration harness copies
#          one scenario to /tmp and materialises it there, so a test run never mutates the
#          checkout. Run it after checkout; without it, `hostile` is not hostile and the
#          project fixtures are plain directories.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$here"

while [ $# -gt 0 ]; do
  case "$1" in
    --root) root="${2:?--root needs a directory}"; shift 2 ;;
    --root=*) root="${1#--root=}"; shift ;;
    *) break ;;
  esac
done

scenarios=("$@"); [ ${#scenarios[@]} -eq 0 ] && scenarios=(clean dirty-dev dirty-business hostile partial)

for s in "${scenarios[@]}"; do
  [ -d "$root/$s" ] || { echo "no such scenario: $s (under $root)" >&2; exit 1; }
  # 1. restore git repositories
  while IFS= read -r -d '' g; do mv "$g" "${g%.fixture}"; done \
    < <(find "$root/$s" -type d -name '.git.fixture' -print0)
  # 2. the hostile scenario's permission faults (declared in its scenario.yaml)
  if [ "$s" = hostile ]; then
    chmod 000 "$root/hostile/home/keeper/locked" 2>/dev/null || true
    chmod 000 "$root/hostile/srv/isolated/unreadable" 2>/dev/null || true
  fi
done

echo "materialised: ${scenarios[*]} (root: $root)"
