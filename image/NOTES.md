# Brood machine image — Part 1 notes

## Machine and scope

- Target: Debian 13 slim userspace, `linux/amd64` (x86-64) only.
- This is a simulated machine for the Part 1 environment, not a production host.
- The image contains no fixtures, user content, assistant logic, scheduler, broker,
  agent loop, or `broodctl` implementation.
- `Dockerfile` contains no `COPY` instruction. `.dockerignore` excludes every build
  context entry except the Dockerfile, so runtime files and generated keys are not
  sent as build inputs.
- `entrypoint.sh`, `sshd_config`, the authorized-keys directory, the host-key
  directory, and the scenario are supplied through Compose bind mounts at runtime.
  `up.sh` materialises a **copy** of one fixture scenario (`BROOD_SCENARIO`, default
  `dirty-business`) under `.runtime/scenario/` and that copy is mounted, so the mount
  is intentionally writable while the repository's `fixtures/` evidence set never is.
  The SSH config, entrypoint, authorized-keys directory, and host-key directory are
  read-only inside the machine.

## Package choices

- `openssh-server`: the only long-running service and the SSH boundary. Any default host keys created by package installation are removed in that same build layer; the running daemon uses only the runtime-mounted host key.
- `bash`: the `brood` login shell and the small entrypoint wrapper.
- `procps`: process and memory inspection (`ps`, `top`, `free`).
- `iproute2`: interface, address, route, and socket inspection (`ip`, `ss`).
- `less`: inspect longer command output without adding a larger tool suite.
- `curl` and `ca-certificates`: make deliberate HTTPS requests and validate TLS
  using the system trust store.
- `git`: inspect tracked state and diffs in scenario content.
- `passwd`: remove the account password so the `brood` account has an empty
  password field. SSH still requires a public key; password and keyboard-
  interactive authentication are disabled.

`sudo`, `systemd`, ping utilities, compilers, package-development toolchains,
cron, and other daemons are deliberately absent. `sshd` runs as root so it can
bind port 22 and switch to the unprivileged `brood` account; the account itself
has no sudo path.

The Compose build passes the invoking host user's UID/GID to the image so the
bind-mounted `authorized_keys` file is owned by `brood` and passes OpenSSH
`StrictModes` checks. The host SSH client key is generated under `.runtime/`;
the independent SSH host key is root-owned in the container and also exists only
under `.runtime/`. Neither key is included in the archive or image layers.

## Network decision

The service uses Compose's ordinary default bridge network and does not use
`network_mode: host`. Port 22 is published only on host loopback as
`127.0.0.1:2222:22`, so the SSH endpoint is not exposed on the host's external
interfaces. The default Docker bridge can provide outbound connectivity where
Docker/host policy permits it; this is the Docker default, not an application
provider integration or a custom egress grant.

A future model-provider call should be enabled only by an explicit operator
approval: route it through a dedicated egress proxy or separately controlled
network, allowlist the required provider endpoints, and provide narrowly scoped
credentials at runtime. Do not add provider credentials to this image or grant
unrestricted outbound access merely to make a call work.

## Commands

Run from the extracted `brood-image/` directory on a host with Docker Engine,
Docker Compose v2, and Bash:

```bash
bash scripts/up.sh
bash scripts/ssh.sh
bash scripts/ssh.sh --exec
bash scripts/down.sh
```

`up.sh` builds the image, generates throwaway Ed25519 operator and host keys if
absent, starts the service, writes the operator public key into the bind-mounted
`authorized_keys` file, then polls an authenticated SSH command over the Compose
network for up to 60 seconds. The readiness probe uses the SSH client in a
throwaway container, so `up.sh` does not require an OpenSSH client installed on
the host. To make the printed SSH command work on the host, install/use the host
OpenSSH client. Run `down.sh` to remove the service, Compose network, named
volumes, the locally built service image (`--rmi local`, so the derived test image
survives), and all generated `.runtime/` state — the materialised scenario copy
included. The repository's `fixtures/` tree is never touched.

The scripts use the fixed Compose project name `brood-image`; do not run a second
independent copy under the same project name concurrently.

## Deliberately absent

- No content is copied into an image layer.
- No pre-seeding, first-run setup, init system, or service manager.
- No password, keyboard-interactive, or root SSH login.
- No sudo access for `brood`.
- No scheduled work, daemon other than `sshd`, agent loop, model client, or
  application-level control interface.
- No host networking or custom provider egress rule.
- No fixtures or tests; those belong to Parts 2 and 3.

## Hardest constraint and compromise

**Constraint 1 (make it behave like a dedicated Debian machine) was the hardest
one to honour, and it is not perfectly achievable in Docker.** The image presents
a Debian 13 server userspace, a normal unprivileged login, a conventional
filesystem layout, and an SSH-only operator boundary. However, it still shares
the host kernel and runs in container namespaces. A sufficiently observant
operator can distinguish it by inspecting `/proc`, cgroups, namespaces, process
1, or container-related mount/network details. There is no attempt to spoof
those facts, emulate a full boot, or install `systemd`; doing so would be a
misleading and brittle compromise. The deliberate compromise is therefore to
provide a conventional Debian userspace and SSH workflow while remaining honest
that this is a containerized simulation, not an independently booted machine.
