# Brood — v0 simulation

Built from three external briefs and verified on the author's machine, 2026-11-13. Brood is the
**generalised, autonomous form** of a workspace-production pattern (workspace + store, handoff-driven,
never an authority in the runtime). The private knowledge base that produces it is referenced by name
only (the ICM/MWP methodology); this repository is the public instance.

> **What it is:** a disposable Debian 13 machine that an assistant connects to **over SSH**, learns, and
> is asked to *pamper* — observe honestly, find drift, propose safe changes with revert paths, change
> nothing that was not approved. Simulation only; it does not touch a real host.

---

## Layout

```
brood/
├── image/      the machine — Dockerfile, sshd_config (key-only), compose, scripts, NOTES.md
├── fixtures/   five assembled scenarios (clean, dirty-dev, dirty-business, hostile, partial)
│               each with scenario.yaml declaring its planted faults + evidence
├── suite/      broodctl (the CLI) + the Vitest proof suite (L0–L4 + blast radius) + NOTES.md
└── docs/       the observation packet contract + the clean-room verification record
```

## Status (verified here, not claimed)

Clean-room run 2026-11-14 (fresh clone, no untracked files): `docs/verification-2026-11-14.md`.

| Layer | Result |
|---|---|
| L0 unit — 24 tests | ✅ pass, no Docker, no network |
| L1 contract — 15 tests | ✅ pass, no Docker, no network |
| `npm test` offline, in `unshare -rn` | ✅ 39 tests pass with no network namespace |
| `tsc --noEmit` | ✅ clean |
| Image builds | ✅ `brood-image:local` (310 MB), also with `--no-cache` |
| SSH in (key-only, unprivileged `brood`) | ✅ works |
| L2 integration | ✅ pass on all five scenarios |
| L3 detection from observed facts | ✅ pass — findings cite packet facts; only storage headroom is detected, everything else is `undetected` with a reason |
| L4 recovery | ✅ pass (the failpoint, not the kill helper, was the defect) |
| Fixture materialisation guard | ✅ pass (runs the hostile case only when `BROOD_SCENARIO=hostile`) |
| Blast radius | ✅ fixture tree unchanged byte-for-byte and mode-for-mode |

Per scenario (full integration suite): `clean`, `dirty-dev`, `dirty-business`, `partial` = 8 passed /
1 skipped; `hostile` = 9 passed. What the suite does **not** prove (one detector, one collector, no
unattended cycle, no A1–A10 gates) is written down in `docs/verification-2026-11-14.md`.

## Run it

```sh
cd image && bash scripts/up.sh          # delivered machine: builds, materialises a scenario, waits for SSH
cd suite && npm install && npm test      # L0 + L1, free and offline
```

The delivered machine mounts a **materialised copy** of one fixture scenario at `/srv/scenario`
(writable, so an approved change persists on the host) — never the repository's `fixtures/` tree, so
pampering the machine cannot rewrite the evidence set. `BROOD_SCENARIO` chooses the scenario (default
`dirty-business`): `up.sh` copies it under the git-ignored `image/.runtime/scenario/` and runs
`fixtures/materialize.sh` on the copy, which restores `.git.fixture` → `.git` and the `hostile`
permission faults that a git checkout cannot carry. A fresh clone therefore delivers a machine that
already has the planted faults, and `git status --short` stays clean after `up.sh` and after an
apply/revert round trip.

The integration layers need a **test image** — the delivered image deliberately has no Node and no baked
key, while the harness needs both. `suite/Dockerfile.test` derives it; every input is committed or
generated in the same sequence:

```sh
cd image && docker build -t brood-image:local .
cd ../suite && npm run build
mkdir -p /tmp/brood-keys
ssh-keygen -q -t ed25519 -N '' -f /tmp/brood-keys/id_ed25519
cp /tmp/brood-keys/id_ed25519.pub testkey.pub       # throwaway, git-ignored
docker build -f Dockerfile.test -t brood-test:local .
```

`suite/sshd_config.test` is committed — the derived image's own self-contained config, not a copy of the
delivered machine's — so no further step is needed. `image/scripts/down.sh` removes only the delivered
image (`--rmi local`, scoped to the Compose project); `brood-test:local` survives a teardown.

Then run the integration layers against **one scenario per run** (`BROOD_SCENARIO`, default
`dirty-business`). The harness copies the scenario to a throwaway directory under `/tmp`, runs
`fixtures/materialize.sh` on the copy (`.git.fixture` → `.git`, plus the `hostile` permission faults),
and mounts *that* at `/srv/scenario` — so a fresh clone needs no manual preparation step and the test
run never mutates the checkout:

```sh
BROOD_IMAGE=brood-test:local BROOD_SCENARIO_DIR=$PWD/../fixtures \
  BROOD_SSH_KEY=/tmp/brood-keys/id_ed25519 npm run test:int

# each scenario is its own mount; the expectations come from its scenario.yaml
for s in clean dirty-dev dirty-business hostile partial; do
  BROOD_SCENARIO=$s BROOD_IMAGE=brood-test:local BROOD_SCENARIO_DIR=$PWD/../fixtures \
    BROOD_SSH_KEY=/tmp/brood-keys/id_ed25519 npm run test:int
done
```

`BROOD_SCENARIO_DIR` stays the **fixtures root**; `BROOD_SCENARIO` names the one scenario mounted.
Mounting a single scenario is deliberate: `hostile` is partial by design once its unreadable
directories exist, so a whole-tree mount could not tell a planted fault from a broken scan.

## Non-negotiables this build honours

- **No `COPY` of content** — the Dockerfile declares only the machine; fixtures arrive by bind mount.
- **Never `COPY` in the brief sense:** fixtures are mounted at `/srv/scenario` read-only by the harness.
- **Key-only SSH**, unprivileged user, no password path at all (`AuthenticationMethods publickey`).
- **Port bound to `127.0.0.1` only** on the delivered compose file.
- **No agent loop inside** — no daemon, no scheduler, no broker.
