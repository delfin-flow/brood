#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="brood-image"

command -v docker >/dev/null 2>&1 || {
    printf 'ERROR: Docker CLI not found; runtime files were not removed.\n' >&2
    exit 1
}
docker compose version >/dev/null 2>&1 || {
    printf 'ERROR: Docker Compose v2 is required; runtime files were not removed.\n' >&2
    exit 1
}

docker compose -p "$PROJECT_NAME" -f "$ROOT_DIR/compose.yaml" \
    down --volumes --remove-orphans --rmi all

# All generated client/host keys and the injected authorized_keys file are
# disposable runtime state. The source scenario directory is deliberately kept.
rm -rf -- "$ROOT_DIR/.runtime"
printf 'Brood machine, Compose network, volumes, local image, and runtime keys removed.\n'
