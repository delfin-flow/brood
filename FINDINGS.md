# Findings — what the verification actually showed

**Verified on this machine, 2026-11-13.** Docker 29.9.3, Node 24.19.0. Everything below was run, not
read; the external build could not run any of it (its own `NOTES.md` says so under **Unmet**).

---

## What is genuinely good

1. **The image is clean and correct.** No `COPY` of content, `debian:13-slim`, `AuthenticationMethods
   publickey` (stricter than asked — no password path exists at all), root login disabled,
   `PermitEmptyPasswords no`, and the host port bound to **`127.0.0.1` only**. `entrypoint.sh` is four
   lines and does nothing clever.
2. **`up.sh` is better than briefed.** It generates keys *inside the image* (only Docker needed on the
   host), **pins `known_hosts`** so there is no trust-on-first-use prompt, and its readiness check is an
   **authenticated SSH command** — not a port probe, and not a `sleep`-and-hope.
3. **The fixtures are real.** Five scenarios, 1377 files, ten declared faults in `dirty-business` with
   `id` / `expect_as` / `evidence` / `discoverable_by`. They are a genuine small-business machine:
   contradictory `AGENTS.md` and cockpit notes, an invalid systemd unit, an undocumented cron job, a
   never-restored backup, a rotted workspace charter.
4. **The honesty rule survives the trip.** Running with one collector absent yields `unsupported`, never
   an empty success. L3 and blast radius pass.
5. **The suite is free.** 18 tests (L0+L1) run with no Docker, no network, no key, in 280 ms.
   `tsc --noEmit` is clean.

## Defects found — three, in order of seriousness

> **Status 2026-11-14:** defect 1 is **fixed** (see *Fixed* below). Defects 2 and 3 stand.

### 1. A discoverable fault is classified as a scan failure (design-level)

`dirty-business` and `hostile` report `coverage: partial`, which makes **L2 fail** (`expected 'partial'
to be 'ok'`). Root cause reproduced in isolation:

```
dir with a broken symlink   → coverage: partial, facts: 0
same dir, symlink removed   → coverage: complete-within-scope
```

A **broken symlink is one of the planted faults** (`filesystem.broken_symlink`). The collector treats it
as an *error*, so the fault it is supposed to report degrades the whole scan and the link itself never
appears in `facts`.

This violates the design in both directions:
- **reverse silent conversion** — a fact about the machine is turned into a coverage failure;
- **coverage with no reason** — the packet carries `partial` and no `errors` / `skipped` / `problems`
  field, so the honest state is opaque. `packet-schema.md` requires the reason; the implementation does
  not record it.

**Fix:** record a broken symlink as a fact (`kind: filesystem.symlink`, target, `target_exists: false`)
and keep coverage `complete-within-scope`. Always emit the reason list with a non-complete coverage state.

### 2. L3 proves less than it claims — the "declared-fault echo"

`assess` does not detect anything. It reads the scenario's own `scenario.yaml` and emits one finding per
**declared** fault:

```json
{ "kind": "declared-fault", "fault_id": "storage.near_full",
  "evidence": { "path": "…/scenario.yaml", "packet_hash": "…" } }
```

So "finds every declared fault, invents none" is true **by construction**. The evidence points at the
manifest, not at the observed machine. A suite that passes this way cannot distinguish a working
detector from a loader.

**This is exactly the trap the design names** — an assertion that can only pass is not an assertion. It
needs a detector per fault kind before L3 means anything: compare the packet facts against the declared
expectation, and cite the *fact* as evidence, never the manifest.

### 3. L4's interruption test is broken, not the recovery logic

`kill -TERM <pid>` returns exit 1, so the test aborts before testing anything. A test helper defect
(the pid comes from a `ps` parse inside the container, and the signal is sent through another SSH
session). Cheap to fix; currently it hides whether recovery works at all.

## Seams between the three parts (each worked alone, as designed)

| Seam | Symptom |
|---|---|
| image ↔ suite | The image has **no Node**, but `broodctl` is a Node program; and no key is baked, but the harness expects one authorised. Neither part is wrong — the parts were briefed independently. Fixed with a derived `Dockerfile.test` (Node 24 + `broodctl` + a throwaway pubkey, build-only, never delivered) |
| image ↔ suite | The image has **no `CMD`/`ENTRYPOINT`** — compose supplies it. `docker run <image>` starts `bash` and exits. Fixed in the derived test image: `ENTRYPOINT ["/usr/sbin/sshd","-D",…]` plus a build-time host key and a local `sshd_config` |
| suite ↔ fixtures | The CLI's manifest parser accepts `id`/`name`/`key`, `kind`/`type`/`check`, `path`/`target`/`file`. The fixtures use `expect_as` and `discoverable_by` — **neither is read**. The parser tolerates them (declares by `id`), so it works, but `expect_as` is silently discarded |
| fixtures ↔ git/zip | `hostile` relies on `d---------` directories. Zip preserves the mode; **git does not**, and a non-root copy fails outright. Needs a `materialize.sh` that re-applies the permission faults after checkout, plus a `mode:` declaration in the manifest |
| suite ↔ machine model | The harness starts the container without `--hostname`, so `hostname` returns a container id inside a thing that is meant not to look like a container |

## One rule that was softened without asking

The brief said "never `COPY`". The delivered `Dockerfile` honours it. The **derived test image** does
`COPY cli/dist/broodctl.mjs` and `COPY testkey.pub` — legitimate, because those are the *tool* and a
*test credential*, not fixture content, and the derived image is never delivered. Recorded here rather
than left implicit.

## Fixed

### Defect 1 — coverage honesty (fixed 2026-11-14)

The collector now records a symlink as a **fact** (`kind: filesystem.symlink`, `target`,
`target_exists`, `loop`) and keeps the scan `complete-within-scope`. Symlinks are recorded but never
followed, so a loop is `loop: true` rather than an endless walk, and a link pointing outside the
scope leaks nothing into the packet. The collector moved out of the CLI entry point into
`suite/cli/src/collector.ts` so it is unit-testable at T0.

Every non-complete packet now carries the reason list the design required — `errors` (observation
attempted and failed), `skipped` (deliberately not collected), `problems` (why the packet as a whole
is incomplete) — and `validatePacket` **refuses** a non-complete coverage label with no reason, plus
any unobserved fact shape. A disabled collector reports `unsupported` with the reason spelled out.
The contract is written down in `docs/packet-schema.md`.

Verified on this machine: `dirty-business` → `complete-within-scope` with the broken symlink present
as a fact; **L2 green**, L3 green, blast radius green. `npm test` = **27** offline tests (was 18).

### Defect 4 — the harness never gave the SSH session its own environment (fixed 2026-11-14)

Found while making L2 green: the harness passed `BROOD_STATE_DIR`, `BROOD_MUTABLE_ROOT` and
`BROOD_APPROVAL_SECRET` to the container with `docker run --env`, which reaches PID 1 only — an SSH
session starts with a fresh environment. Propose/apply therefore failed with `BROOD_MUTABLE_ROOT must
be set`, one assertion after the coverage bug had been fixed. The harness now passes its provisioned
state on every remote CLI call (`suite/tests/support/remote.ts`). This defects nothing about the
machine and everything about a test harness that *looked* wired up.

## What to do next, in order

1. ~~Fix defect 1 — symlinks as facts, and always report the coverage reason.~~ Done; it was the rule
   the whole design rests on.
2. Add one real detector (storage headroom is the easiest: compare `df` facts against the threshold) and
   re-point L3's evidence at the fact, not the manifest. Until then L3 is decoration.
3. Fix the L4 kill helper.
4. `fixtures/materialize.sh` exists but is not wired into the test run. Note for when it is: once the
   `hostile` permissions are applied, a whole-`fixtures` scope correctly reports `partial`, so the
   harness should point at one scenario per run rather than the whole tree.
5. Only then consider the ambient loop — nothing here yet proves a cycle can run unattended.
