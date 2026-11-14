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

failures=()

for s in "${scenarios[@]}"; do
  [ -d "$root/$s" ] || { echo "no such scenario: $s (under $root)" >&2; exit 1; }
  # 1. restore git repositories
  while IFS= read -r -d '' g; do mv "$g" "${g%.fixture}"; done \
    < <(find "$root/$s" -type d -name '.git.fixture' -print0)
  # 2. the hostile scenario's permission faults (declared in its scenario.yaml)
  #    A chmod that silently fails leaves the fault readable, which only the hostile-only
  #    guard test would ever notice — so verify the mode instead of trusting the exit code.
  if [ "$s" = hostile ]; then
    for target in "$root/hostile/home/keeper/locked" "$root/hostile/srv/isolated/unreadable"; do
      if [ ! -e "$target" ]; then
        failures+=("$target (missing)")
        continue
      fi
      if ! chmod 000 "$target" 2>/dev/null; then
        failures+=("$target (chmod 000 failed)")
        continue
      fi
      mode=$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || echo unknown)
      case "$mode" in
        0|00|000|0000) ;;
        *) failures+=("$target (mode is $mode, expected 000)") ;;
      esac
    done
  fi
done

if [ ${#failures[@]} -gt 0 ]; then
  printf 'ERROR: could not materialise the declared faults:\n' >&2
  printf '  %s\n' "${failures[@]}" >&2
  exit 1
fi

echo "materialised: ${scenarios[*]} (root: $root)"
