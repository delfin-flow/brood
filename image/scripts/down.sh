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

# `--rmi local` scopes image removal to this Compose project's own locally built
# image (`brood-image:local`). The derived test image (`brood-test:local`) is not part
# of the project and must survive a teardown.
docker compose -p "$PROJECT_NAME" -f "$ROOT_DIR/compose.yaml" \
    down --volumes --remove-orphans --rmi local

# All generated client/host keys and the materialised scenario copy are disposable
# runtime state; the fixtures in the repository are never touched. A `hostile` copy
# holds mode-000 directories, so make the tree traversable before removing it.
chmod -R u+rwX "$ROOT_DIR/.runtime" 2>/dev/null || true
rm -rf -- "$ROOT_DIR/.runtime"
printf 'Brood machine, Compose network, volumes, local image, and runtime state removed.\n'
