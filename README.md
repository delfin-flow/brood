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
cd image && bash scripts/up.sh          # the delivered machine (compose, key injection, readiness)
cd suite && npm install && npm test      # L0 + L1, free and offline
```

The delivered machine mounts `image/scenario/` (git-ignored) at `/srv/scenario`. A fresh clone has no
scenario there, so populate it first if you want something to pamper:

```sh
cp -a fixtures/dirty-business image/scenario/    # or symlink it, as the author does locally
```

The integration layers need a **test image** — the delivered image deliberately has no Node and no
baked key, while the harness needs both. `suite/Dockerfile.test` builds it:

```sh
cd image && docker build -t brood-image:local .
cd ../suite && npm run build && ssh-keygen -q -t ed25519 -N '' -f /tmp/brood-keys/id_ed25519
cp /tmp/brood-keys/id_ed25519.pub testkey.pub
cp ../image/sshd_config sshd_config.test     # required by Dockerfile.test, not tracked

docker build -f Dockerfile.test -t brood-test:local .
```

Both `testkey.pub` and `sshd_config.test` are throwaway, git-ignored build inputs of the derived test
image. Note that `image/scripts/down.sh` removes `brood-test:local` together with the delivered image
(`docker compose down --rmi all`), so build the test image **after** a teardown, or rebuild it.

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
