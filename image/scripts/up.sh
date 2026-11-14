#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES_DIR="$(cd -- "$ROOT_DIR/../fixtures" 2>/dev/null && pwd || true)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
SCENARIO_NAME="${BROOD_SCENARIO:-dirty-business}"
SCENARIO_RUNTIME_DIR="$RUNTIME_DIR/scenario"
OPERATOR_DIR="$RUNTIME_DIR/operator"
AUTHORIZED_KEYS_DIR="$RUNTIME_DIR/authorized_keys"
HOST_KEYS_DIR="$RUNTIME_DIR/host_keys"
PROJECT_NAME="brood-image"
IMAGE_NAME="brood-image:local"
NETWORK_NAME="${PROJECT_NAME}_default"

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

command -v docker >/dev/null 2>&1 || fail "Docker CLI not found. Install Docker Engine with the Compose v2 plugin."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (run: docker compose version)."

if [[ "$(uname -m)" != "x86_64" && "$(uname -m)" != "amd64" ]]; then
    printf 'NOTE: this image targets linux/amd64; Docker may require x86-64 emulation on this host.\n' >&2
fi

# When invoked with sudo, preserve the invoking user's UID/GID for the brood
# account and the authorized_keys bind mount. The daemon host key is generated as container root.
BROOD_UID="${SUDO_UID:-$(id -u)}"
BROOD_GID="${SUDO_GID:-$(id -g)}"
[[ "$BROOD_UID" =~ ^[0-9]+$ && "$BROOD_GID" =~ ^[0-9]+$ ]] || fail "Could not determine a numeric host UID/GID."
(( BROOD_UID > 0 )) || fail "Run as an unprivileged host user (or through sudo from one), not as root directly."
export BROOD_UID BROOD_GID

cd "$ROOT_DIR"
mkdir -p "$OPERATOR_DIR" "$AUTHORIZED_KEYS_DIR" "$HOST_KEYS_DIR"
chmod 0700 "$RUNTIME_DIR" "$OPERATOR_DIR" "$AUTHORIZED_KEYS_DIR" "$HOST_KEYS_DIR"

# The delivered machine mounts a materialised COPY of one scenario, never the repository's
# fixtures tree: an approved change through the machine must not be able to rewrite the
# evidence set. `materialize.sh` re-applies what a git checkout loses (`.git.fixture` ->
# `.git`, and the `hostile` permission faults) — `cp -a` alone would deliver a machine with
# no repositories and readable "unreadable" directories.
[ -n "$FIXTURES_DIR" ] || fail "The fixtures tree is required to populate the machine (expected at $ROOT_DIR/../fixtures)."
[ -d "$FIXTURES_DIR/$SCENARIO_NAME" ] || fail "BROOD_SCENARIO must name a scenario under $FIXTURES_DIR: $SCENARIO_NAME"
printf 'Materialising scenario %s into %s...\n' "$SCENARIO_NAME" "$SCENARIO_RUNTIME_DIR/$SCENARIO_NAME"
chmod -R u+rwX "$SCENARIO_RUNTIME_DIR" 2>/dev/null || true
rm -rf -- "$SCENARIO_RUNTIME_DIR"
mkdir -p "$SCENARIO_RUNTIME_DIR"
cp -a "$FIXTURES_DIR/$SCENARIO_NAME" "$SCENARIO_RUNTIME_DIR/$SCENARIO_NAME"
bash "$FIXTURES_DIR/materialize.sh" --root "$SCENARIO_RUNTIME_DIR" "$SCENARIO_NAME"
# Compose substitutes this variable into the bind-mount source.
export BROOD_SCENARIO="$SCENARIO_NAME"

if [[ "$(id -u)" -eq 0 ]]; then
    chown "$BROOD_UID:$BROOD_GID" "$RUNTIME_DIR" "$OPERATOR_DIR" "$AUTHORIZED_KEYS_DIR" "$HOST_KEYS_DIR"
    # A copy made by root must still be writable by the container's `brood` account.
    chown -R "$BROOD_UID:$BROOD_GID" "$SCENARIO_RUNTIME_DIR"
fi

printf 'Building the Debian 13 x86-64 machine image...\n'
docker compose -p "$PROJECT_NAME" -f "$ROOT_DIR/compose.yaml" build brood

# Generate keys inside the built image so up.sh only requires Docker on the host.
# The operator private key is owned by the host user; the sshd host key is root-owned.
if [[ ! -s "$OPERATOR_DIR/id_ed25519" ]]; then
    rm -f "$OPERATOR_DIR/id_ed25519.pub"
    docker run --rm \
        --user "$BROOD_UID:$BROOD_GID" \
        --mount "type=bind,src=$OPERATOR_DIR,dst=/keys" \
        --entrypoint /usr/bin/ssh-keygen \
        "$IMAGE_NAME" \
        -q -t ed25519 -N '' -C 'brood-operator@localhost' -f /keys/id_ed25519
elif [[ ! -s "$OPERATOR_DIR/id_ed25519.pub" ]]; then
    docker run --rm \
        --user "$BROOD_UID:$BROOD_GID" \
        --mount "type=bind,src=$OPERATOR_DIR,dst=/keys" \
        --entrypoint /usr/bin/ssh-keygen \
        "$IMAGE_NAME" \
        -y -f /keys/id_ed25519 > "$OPERATOR_DIR/id_ed25519.pub"
fi
chmod 0600 "$OPERATOR_DIR/id_ed25519"
chmod 0644 "$OPERATOR_DIR/id_ed25519.pub"
if [[ "$(id -u)" -eq 0 ]]; then
    chown "$BROOD_UID:$BROOD_GID" "$OPERATOR_DIR/id_ed25519" "$OPERATOR_DIR/id_ed25519.pub"
fi

if [[ ! -s "$HOST_KEYS_DIR/ssh_host_ed25519_key" ]]; then
    rm -f "$HOST_KEYS_DIR/ssh_host_ed25519_key.pub"
    docker run --rm \
        --mount "type=bind,src=$HOST_KEYS_DIR,dst=/keys" \
        --entrypoint /usr/bin/ssh-keygen \
        "$IMAGE_NAME" \
        -q -t ed25519 -N '' -C 'brood-machine-host' -f /keys/ssh_host_ed25519_key
elif [[ ! -s "$HOST_KEYS_DIR/ssh_host_ed25519_key.pub" ]]; then
    docker run --rm \
        --mount "type=bind,src=$HOST_KEYS_DIR,dst=/keys" \
        --entrypoint /usr/bin/ssh-keygen \
        "$IMAGE_NAME" \
        -y -f /keys/ssh_host_ed25519_key > "$HOST_KEYS_DIR/ssh_host_ed25519_key.pub"
fi
# ssh-keygen creates the host private/public files with restrictive/default key modes.
# Do not chmod the private key from the host: rootful Docker creates it root-owned.

# Pin the generated host key for both the in-network readiness probe and the
# operator's host-side command. No trust-on-first-use prompt is required.
read -r HOST_KEY_TYPE HOST_KEY_DATA _ < "$HOST_KEYS_DIR/ssh_host_ed25519_key.pub"
printf 'brood %s %s\n[localhost]:2222 %s %s\n' \
    "$HOST_KEY_TYPE" "$HOST_KEY_DATA" "$HOST_KEY_TYPE" "$HOST_KEY_DATA" \
    > "$OPERATOR_DIR/known_hosts"
chmod 0600 "$OPERATOR_DIR/known_hosts"
if [[ "$(id -u)" -eq 0 ]]; then
    chown "$BROOD_UID:$BROOD_GID" "$OPERATOR_DIR/known_hosts"
fi

printf 'Starting the simulated machine...\n'
docker compose -p "$PROJECT_NAME" -f "$ROOT_DIR/compose.yaml" up -d --remove-orphans brood

# Inject the public operator key after the service starts, through the mounted
# authorized_keys directory. sshd reads this file when an authentication is made.
install -m 0600 "$OPERATOR_DIR/id_ed25519.pub" "$AUTHORIZED_KEYS_DIR/authorized_keys"
if [[ "$(id -u)" -eq 0 ]]; then
    chown "$BROOD_UID:$BROOD_GID" "$AUTHORIZED_KEYS_DIR/authorized_keys"
fi

# Poll an authenticated SSH command over the Compose bridge network. A port-open
# check alone would not prove that sshd accepts the injected public key.
ready=0
for attempt in {1..60}; do
    if docker run --rm \
        --network "$NETWORK_NAME" \
        --mount "type=bind,src=$OPERATOR_DIR,dst=/run/operator,readonly" \
        --entrypoint /usr/bin/ssh \
        "$IMAGE_NAME" \
        -i /run/operator/id_ed25519 \
        -o BatchMode=yes \
        -o IdentitiesOnly=yes \
        -o StrictHostKeyChecking=yes \
        -o CheckHostIP=no \
        -o UserKnownHostsFile=/run/operator/known_hosts \
        -o ConnectTimeout=2 \
        -o LogLevel=ERROR \
        -p 22 brood@brood true >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 1
done

if [[ "$ready" -ne 1 ]]; then
    printf 'ERROR: SSH did not become ready within 60 seconds. Recent container logs follow:\n' >&2
    docker compose -p "$PROJECT_NAME" -f "$ROOT_DIR/compose.yaml" logs --tail=40 brood >&2 || true
    fail "The machine is running but key-authenticated SSH readiness could not be confirmed. Inspect logs, then run bash scripts/down.sh before retrying."
fi

printf '\nBrood machine is ready. Connect with:\n'
printf '  bash scripts/ssh.sh\n'
printf 'Host endpoint: ssh -p 2222 brood@localhost\n'
