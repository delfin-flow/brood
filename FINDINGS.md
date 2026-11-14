# Findings — what the verification actually showed

**Verified on this machine, 2026-11-13; re-verified from a fresh clone on 2026-11-14.** Docker 29.9.3,
Node 24.19.0. Everything below was run, not read; the external build could not run any of it (its own
`NOTES.md` says so under **Unmet**). The clean-room run, its commands and its counts are recorded in
`docs/verification-2026-11-14.md`.

---

## What is genuinely good

1. **The image is clean and correct.** No `COPY` of content, `debian:13-slim`, `AuthenticationMethods
   publickey` (stricter than asked — no password path exists at all), root login disabled,
   `PermitEmptyPasswords no`, and the host port bound to **`127.0.0.1` only**. `entrypoint.sh` is four
   lines and does nothing clever.
2. **`up.sh` is better than briefed.** It generates keys *inside the image* (only Docker needed on the
   host), **pins `known_hosts`** so there is no trust-on-first-use prompt, and its readiness check is an
   **authenticated SSH command** — not a port probe, and not a `sleep`-and-hope.
3. **The fixtures are real.** Five scenarios, 836 tracked entries (832 files + 4 symlinks), ten
   declared faults in `dirty-business` with `id` / `expect_as` / `evidence` / `discoverable_by`. They
   are a genuine small-business machine: contradictory `AGENTS.md` and cockpit notes, an invalid
   systemd unit, an undocumented cron job, a never-restored backup, a rotted workspace charter.
4. **The honesty rule survives the trip.** Running with one collector absent yields `unsupported`, never
   an empty success. L3 and blast radius pass.
5. **The suite is free.** 39 tests (L0 24 + L1 15) run with no Docker, no network, no key, in about
   500 ms — re-run inside `unshare -rn` with the same result. `tsc --noEmit` is clean.

## Defects found — five, in order of seriousness

> **Status 2026-11-14:** all five defects are **fixed** (see *Fixed* below).

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

### 2. L3 proves less than it claims — the "declared-fault echo" ✅ fixed 2026-11-14

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
| fixtures ↔ suite | `hostile` relies on `d---------` directories. Zip preserves the mode; **git does not**, and a non-root copy fails outright. `.git.fixture` directories have the mirror-image problem: a checkout has no repositories. **Fixed** — `materialize.sh` re-applies both and the integration harness now runs it on a throwaway copy of the one scenario it mounts (S5) |
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
as a fact; **L2 green**, L3 green, blast radius green. `npm test` = **39** offline tests today
(27 at that point, 18 before S2 and S5).

### Defect 2 — the declared-fault echo (fixed 2026-11-14)

`assess` no longer reads `scenario.yaml` to manufacture findings. It runs a detector registry
(`suite/cli/src/detectors.ts`) over the packet facts; the only registered detector is
`storage.headroom_low`, which parses a captured `df -h` by header and reports one
`storage.near_full` finding per persistent filesystem whose `Use%` reaches
`BROOD_STORAGE_THRESHOLD_PERCENT` (default 80). The finding cites the **fact** — `path`, `sha256`,
packet `canonical_hash` — and the detector re-hashes the bytes, refusing a file that changed after
observation. The threshold is explicit and recorded in `measured` because the machine's own
notes contradict each other on 80 % vs 85 %; that contradiction is a separate planted fault the
detector must not resolve.

The suite's own assertion is now falsifiable: L3 requires every finding's evidence path to be an
observed fact with a matching hash and explicitly forbids `scenario.yaml` as evidence. `storage.near_full`
is found on `dirty-business` and `hostile` (93 % on `/srv/data`, each on its own mount) and **absent**
for `clean`, `dirty-dev` and `partial` (57 %) — the negative control is a separate mount, not a scoped
sub-walk of one shared tree.

**Honest limit:** only storage headroom is detected. Every other declared fault is returned in
`undetected` with the gap named (`no detector for kind 'service.unit_invalid' (…)`), and a detector
that ran without crossing its threshold says `detector ran, threshold not crossed`. L3 still proves
the traceability and the negative control — not that the remaining planted faults are detectable.

### Defect 3 — the failpoint never held the process (fixed 2026-11-14)

The recorded diagnosis — "the pid comes from a `ps` parse and the signal is sent through another SSH
session" — was **wrong**, and the wrong diagnosis is itself the finding. The marker pid is correct and
`kill` reaches it; the process was already gone.

Root cause: the failpoint waited on `await new Promise((resolve) => process.once("SIGTERM", …))` with
nothing else in the queue. **A signal listener does not keep Node's event loop alive**, so the process
exited **13** ("unsettled top-level await") the instant it wrote the marker — reproducibly:

```sh
node -e 'await new Promise((r) => process.once("SIGTERM", () => r()));' ; echo $?   # 13, immediately
```

The fix is a ref'd keep-alive timer held for the duration of the pause (cleared in `finally`). L4 now
goes **all the way through** — interruption, expired approval, altered arguments, apply, verify, revert,
removed collector — and the interrupted run fails loudly (`status: failed`, exit 2) instead of dying
silently. A new L0 test spawns the CLI, waits for the marker, asserts the process is still alive, sends
`SIGTERM` and expects the JSON failure — the regression that would have caught this without Docker.

**Honest limit:** the story spoke of an "interrupted observe leaving a recoverable journal". There is no
journal. What L4 actually proves is that the state stays consistent with no partial write, recovery is
re-observation, and the recovered packet set hashes identically to the pre-interruption set.

### Defect 4 — the harness never gave the SSH session its own environment (fixed 2026-11-14)

Found while making L2 green: the harness passed `BROOD_STATE_DIR`, `BROOD_MUTABLE_ROOT` and
`BROOD_APPROVAL_SECRET` to the container with `docker run --env`, which reaches PID 1 only — an SSH
session starts with a fresh environment. Propose/apply therefore failed with `BROOD_MUTABLE_ROOT must
be set`, one assertion after the coverage bug had been fixed. The harness now passes its provisioned
state on every remote CLI call (`suite/tests/support/remote.ts`). This defects nothing about the
machine and everything about a test harness that *looked* wired up.

### Defect 5 — the harness mounted a checkout, not the delivered machine (fixed 2026-11-14)

`fixtures/materialize.sh` re-applies the two things a git checkout loses (`.git.fixture` → `.git`, and
`hostile`'s `chmod 000` directories), but nothing ran it. The harness mounted `fixtures/` as checked
out, so `hostile` was not hostile and the project probes saw plain directories. Worse, the script
resolved its root from its own location, so wiring it in as-is would have mutated the working tree.

`materialize.sh` now takes `--root <dir>` (default: its own directory, so the documented command is
unchanged). The harness copies one scenario (`BROOD_SCENARIO`, default `dirty-business`) from the
fixtures root into `/tmp/brood-vitest-scenario-<rand>`, materialises **the copy**, mounts that at
`/srv/scenario:ro`, and deletes it at teardown (a leftover copy fails the run like a leftover
container). A guard test asserts the mounted tree really is materialised — real `.git` directories, no
`.git.fixture` left, and for `hostile` the mode-000 directories actually deny `brood`.

**Honest limits:** a snapshot cannot read below a mode-000 directory, so the blast-radius walk records
that barrier (with its mode) as `directory-unreadable` instead of pretending it is empty — a mode change
on the barrier is still detected, its contents are simply unobservable by design. And `partial` is
`partial-by-design` at the *collector-contract* level (its packages tool is missing), so its filesystem
scan is legitimately `complete-within-scope` and `assess` returns `ok` with the declared gap in
`undetected`; only `hostile`, whose partiality is a real unreadable directory, reports `partial`.

## Defects found by the 2026-11-14 clean-room run

Found by rebuilding everything from a **fresh clone** rather than from the working checkout; all three
are delivery/recipe defects, not behaviour defects. Detail and reproduction in
`docs/verification-2026-11-14.md`.

> **Status 2026-11-14:** all three are **fixed** (S9 / the delivery recipe). `suite/sshd_config.test` is
> committed (the derived image's own config, so a clone builds it with no `cp`); `down.sh` runs
> `docker compose down --rmi local`, scoped to the project's own image, so `brood-test:local` survives;
> and `up.sh` materialises a runtime **copy** of one scenario under `image/.runtime/scenario/` and
> mounts that, so a fresh clone's machine has the planted faults and the repository's `fixtures/` tree
> is never the mount source. The three items below are kept as the record of what the clone run found.

1. **A fresh clone cannot build the test image.** `suite/Dockerfile.test` does
   `COPY sshd_config.test`, which nothing generates and `.gitignore` excludes; the build fails with
   `failed to compute cache key: "/sshd_config.test": not found`. Workaround now in `README.md`:
   `cp image/sshd_config suite/sshd_config.test`. Owner decision: keep the copy step, or commit a
   distinct file and un-ignore it.
2. **`up.sh` from a fresh clone delivers an empty `/srv/scenario`.** `image/scenario/` is the compose
   bind-mount source, git-ignored and absent in a clone; Docker creates it root-owned and empty. The
   author's working checkout hides this with an ignored symlink to `../fixtures/dirty-business`. Not
   fixed — populating the delivered machine is a handover decision, and baking fixtures in would break
   the no-`COPY` rule.
3. **`down.sh` also removes the derived test image.** `docker compose down --rmi all` removed
   `brood-test:local` alongside `brood-image:local`; the documented order now says to build the test
   image after a teardown.

## What to do next, in order

1. ~~Fix defect 1 — symlinks as facts, and always report the coverage reason.~~ Done; it was the rule
   the whole design rests on.
2. ~~Add one real detector (storage headroom is the easiest: compare `df` facts against the threshold) and re-point L3's evidence at the fact, not the manifest. Until then L3 is decoration.~~ Done — one detector, traceable evidence, a working negative control, and the rest honestly `undetected`.
3. ~~Fix the L4 kill helper.~~ Done — it was never the helper; see defect 3.
4. ~~`fixtures/materialize.sh` exists but is not wired into the test run.~~ Done — the harness copies one
   scenario per run (`BROOD_SCENARIO`, default `dirty-business`), materialises the copy and mounts that,
   so a fresh clone is as hostile as the zip and the checkout is never written. A guard test asserts the
   materialised state (real `.git` directories; `hostile`'s mode-000 directories deny `brood`). Remaining
   seam: the CLI cross-checks only the manifest inside the packet, so a fault a scenario *inherits*
   (`extends:`) is detected but not listed as declared.
5. Only then consider the ambient loop — nothing here yet proves a cycle can run unattended.
