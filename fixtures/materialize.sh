#!/usr/bin/env bash
# Purpose: turn the checked-out fixture tree into the state the scenarios declare.
# Usage:   bash fixtures/materialize.sh [scenario ...]     (default: all)
# Notes:   Two things cannot survive a git checkout, so they are re-applied here:
#            1. real git repositories — committed as `.git.fixture`, renamed back to `.git`
#            2. the `hostile` permission faults — unreadable directories and files
#          Run this after checkout. Without it, `hostile` is not hostile and the
#          project fixtures are plain directories.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
scenarios=("$@"); [ ${#scenarios[@]} -eq 0 ] && scenarios=(clean dirty-dev dirty-business hostile partial)

for s in "${scenarios[@]}"; do
  [ -d "$here/$s" ] || { echo "no such scenario: $s" >&2; exit 1; }
  # 1. restore git repositories
  while IFS= read -r -d '' g; do mv "$g" "${g%.fixture}"; done \
    < <(find "$here/$s" -type d -name '.git.fixture' -print0)
done

# 2. the hostile scenario's permission faults (declared in its scenario.yaml)
if [[ -d "$here/hostile" ]]; then
  chmod 000 "$here/hostile/home/keeper/locked" 2>/dev/null || true
  chmod 000 "$here/hostile/srv/isolated/unreadable" 2>/dev/null || true
fi
echo "materialised: ${scenarios[*]}"
