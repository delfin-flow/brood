#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime/operator"
EXECUTE=0

if [[ "${1:-}" == "--exec" ]]; then
    EXECUTE=1
    shift
fi

if [[ ! -s "$RUNTIME_DIR/id_ed25519" || ! -s "$RUNTIME_DIR/known_hosts" ]]; then
    printf 'ERROR: Brood runtime keys are missing. Start the machine first with: bash scripts/up.sh\n' >&2
    exit 1
fi

ssh_command=(
    ssh
    -i "$RUNTIME_DIR/id_ed25519"
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes
    -o CheckHostIP=no
    -o "UserKnownHostsFile=$RUNTIME_DIR/known_hosts"
    -p 2222
    brood@localhost
)

if [[ "$EXECUTE" -eq 1 ]]; then
    command -v ssh >/dev/null 2>&1 || {
        printf 'ERROR: OpenSSH client (ssh) is required on the host for an interactive connection.\n' >&2
        exit 1
    }
    exec "${ssh_command[@]}" "$@"
fi

printf 'Connect using:\n  '
printf '%q ' "${ssh_command[@]}" "$@"
printf '\n'
printf 'To execute it now: bash scripts/ssh.sh --exec\n'
