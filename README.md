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
└── suite/      broodctl (the CLI) + the Vitest proof suite (L0–L4 + blast radius) + NOTES.md
```

## Status (verified here, not claimed)

| Layer | Result |
|---|---|
| L0 unit — 5 tests | ✅ pass, no Docker, no network |
| L1 contract — 13 tests | ✅ pass, no Docker, no network |
| `tsc --noEmit` | ✅ clean |
| Image builds | ✅ `brood-image:local` (310 MB) |
| SSH in (key-only, unprivileged `brood`) | ✅ works |
| L2 integration | ❌ **one real bug** — see `FINDINGS.md` |
| L3 declared-fault acceptance | ⚠️ passes, but it proves less than it claims |
| L4 recovery | ❌ kill-helper bug |
| Blast radius | ✅ fixture tree unchanged byte-for-byte and mode-for-mode |

## Run it

```sh
cd image && bash scripts/up.sh          # the delivered machine (compose, key injection, readiness)
cd suite && npm install && npm test      # L0 + L1, free and offline
```

The integration layers need a **test image** — the delivered image deliberately has no Node and no
baked key, while the harness needs both. `suite/Dockerfile.test` builds it:

```sh
cd image && docker build -t brood-image:local .
cd ../suite && npm run build && ssh-keygen -q -t ed25519 -N '' -f /tmp/brood-keys/id_ed25519
cp /tmp/brood-keys/id_ed25519.pub testkey.pub && docker build -f Dockerfile.test -t brood-test:local .
BROOD_IMAGE=brood-test:local BROOD_SCENARIO_DIR=$PWD/../fixtures \
  BROOD_SSH_KEY=/tmp/brood-keys/id_ed25519 npx vitest run tests/integration --maxWorkers=1
```

## Non-negotiables this build honours

- **No `COPY` of content** — the Dockerfile declares only the machine; fixtures arrive by bind mount.
- **Never `COPY` in the brief sense:** fixtures are mounted at `/srv/scenario` read-only by the harness.
- **Key-only SSH**, unprivileged user, no password path at all (`AuthenticationMethods publickey`).
- **Port bound to `127.0.0.1` only** on the delivered compose file.
- **No agent loop inside** — no daemon, no scheduler, no broker.
