# Verification — Brood v0, clean-room run 2026-11-14

**What this is:** every layer of Brood v0 rebuilt and re-run from a **fresh clone of the repository
alone** (no untracked host files, no pre-built images), with the observed output recorded here. It is
the evidence behind the owner's review gate — not a new story and not a claim of done.

**Commit under test:** `83241cb` (`test(suite): materialise one scenario per run, never the checkout`)
— the state after S2 (`2026-11-14-01`) and S5 (`2026-11-14-02`).

**Environment:** Docker 29.9.3 (build 5457199), Node v24.19.0, npm 12.2.2, Debian 13 host, x86-64.
Container OS: Debian 13.7. Full run duration: about 12 minutes including three image builds.

---

## Method

1. Untracked artefacts removed from the working checkout (`suite/cli/dist`, `suite/testkey.pub`,
   `suite/sshd_config.test`), every `brood-*` container and image removed.
2. `git clone /development/brood /tmp/brood-clean` — only tracked files. This is the clean room; the
   whole run below happened there, except reading files for this report.
3. Each command run exactly as documented, output captured under `/tmp/brood-verify-2026-11-14/`
   (scratch, reproducible). Every verdict below quotes the command and the count it printed.

The clone is a stronger test than "delete the artefacts": it proves the repository alone is sufficient.
It was not sufficient in two places — see [Defects found](#defects-found-by-this-run).

---

## Layer verdicts

### Offline layers (T0 — no Docker, no network, no provider, no spend)

| Layer | Command | Observed |
|---|---|---|
| L0 unit | `npm test` → `vitest run tests/l0 tests/l1` | **24 passed** in 4 files |
| L1 contract | (same run) | **15 passed** in 1 file |
| Type check | `npx tsc --noEmit` | **clean**, no output |
| Bundle | `npm run build` | `cli/dist/broodctl.mjs 299.3kb` |

`npm test` total: **39 passed (5 files), 508 ms**.

Test files and counts as Vitest reported them:

```
✓ tests/l0/core.test.ts (5 tests)
✓ tests/l0/collector.test.ts (9 tests)
✓ tests/l0/detectors.test.ts (9 tests)
✓ tests/l0/failpoint.test.ts (1 test)
✓ tests/l1/contracts.test.ts (15 tests)
```

**Network really absent:** the same suite run inside `unshare -rn` (new network namespace, loopback
down) — `curl` in that namespace exits 6 (cannot resolve), and the suite still prints
**39 passed**. So L0/L1 assert facts, not connectivity.

### The machine

| Step | Command | Observed |
|---|---|---|
| Compose build + start | `image/scripts/up.sh` | `Image brood-image:local Built`, `Brood machine is ready.`, `ssh -p 2222 brood@localhost` |
| Clean rebuild | `docker build --no-cache -t brood-image:nocache image/` | success, **310 MB**; one warning: `FromPlatformFlagConstDisallowed` (constant `--platform` in `FROM`) |
| SSH in | `scripts/ssh.sh --exec '<cmd>'` | `uid=1000(brood) gid=1000(brood)`, hostname `brood`, `/etc/debian_version` = `13.7` |
| Key-only policy | inspect `/etc/ssh/sshd_config` in the container | `AuthenticationMethods publickey`, `PasswordAuthentication no`, `AllowUsers brood` |
| Teardown | `scripts/down.sh` | container, network, image and `.runtime/` removed; `docker ps -a` shows no brood container afterwards |

### Test image and integration layers

`suite/Dockerfile.test` derives from `brood-image:local` and adds Node 24, `broodctl` and a throwaway
public key. Per-run smoke (`BROOD_SCENARIO` default `dirty-business`, fixture copy materialised under
`/tmp`, mounted read-only):

| Layer | Command | Observed (default scenario) |
|---|---|---|
| L2 | `npm run test:l2` | **1 passed** (8 skipped by name filter) |
| L3 | `npm run test:l3` | **4 passed** (5 skipped) |
| L4 | `npm run test:l4` | **1 passed** (8 skipped) |
| Blast radius | `npm run test:blast` | **1 passed** (8 skipped) |
| Full suite | `npx vitest run tests/integration --maxWorkers=1 --reporter=verbose` | **8 passed, 1 skipped (9)** |

Test names, as printed:

```
✓ L2 — SSH command integration > executes observe, assess, propose, apply, verify and report over SSH
✓ L3 — detection from observed facts > cites an observed packet fact for every finding, never the scenario manifest
✓ L3 — detection from observed facts > detects storage headroom over the threshold and stays silent below it
✓ L3 — detection from observed facts > reports every declared fault without a finding as undetected, with a reason
✓ L3 — detection from observed facts > does not emit healthy findings for an incomplete/unsupported scan
✓ L4 — interruption, approval and recovery > recovers from an interrupted observe, rejects expired/altered approvals, reverts, and reports a removed collector
✓ fixture materialisation > mounts real git repositories, not `.git.fixture` placeholders
↓ fixture materialisation > applies the hostile permission faults in the mounted copy   (hostile only)
✓ blast radius — scenario state equality > leaves the mounted scenario byte-for-byte and mode-for-mode unchanged
```

All five scenarios, one mount each (`BROOD_SCENARIO=<name>`):

| Scenario | Result | Note |
|---|---|---|
| `clean` | 8 passed, 1 skipped | no declared faults, no findings |
| `dirty-dev` | 8 passed, 1 skipped | |
| `dirty-business` | 8 passed, 1 skipped | |
| `hostile` | **9 passed** | the hostile-permissions guard runs only here |
| `partial` | 8 passed, 1 skipped | |

After the five runs, `git status --short` in the clone is **clean** — the suite never writes the
checkout (S5 acceptance).

### What the key assertions actually say

- **L3 evidence traceability** (the S2 acceptance): every finding's `evidence.path` must be a fact in
  the input packets, its `sha256` must equal the observed fact's hash, its `packet_hash` must equal the
  packet's `canonical_hash`, and `evidencePath.endsWith("/scenario.yaml")` must be **false** — the
  declared-fault echo cannot pass.
- **L3 negative control**: with `BROOD_STORAGE_THRESHOLD_PERCENT=95` the same capture yields **no**
  storage finding, and the declaration reappears as `undetected` with
  `reason: "detector ran, threshold not crossed"`.
- **L3 honesty**: a finding kind that the scenario tree does not declare fails the test
  (`expect(declaredKinds.has(finding.kind)).toBe(true)`), and every declared fault is either detected or
  listed in `undetected` with a non-empty reason — `expect(accounted).toBe(true)` per declaration.
- **L3 incomplete scan**: disabling the filesystem collector yields `coverage: unsupported`,
  `problems.length > 0` and **zero findings** — an incomplete scan is never "healthy".
- **L4**: interrupt a paused `observe` with `SIGTERM` (process exits non-zero), re-observe, expect the
  recovered packet hashes to **equal** the pre-interruption set; expired approval → `status: denied`;
  altered arguments → `status: denied`; valid apply → `verified` → `reverted` with the file back to
  `before\n`.
- **Blast radius**: directory snapshot (path, type, mode, sha256) before and after the whole run must
  be identical.
- **Materialisation guard**: the mounted tree contains real `.git` directories, no `.git.fixture`, and
  on `hostile` the mode-000 directories actually deny `brood`.

### Observed assessments (manual, outside the suite)

Same test image, one materialised copy per scenario, mounted read-only; `broodctl observe --scope
/srv/scenario` then `BROOD_PROVIDER=fake broodctl assess`:

| Scenario | Packet coverage | Assessment | Findings | Undetected |
|---|---|---|---|---|
| `clean` | `complete-within-scope` | `ok` | 0 | 0 |
| `partial` | `complete-within-scope` | `ok` | 0 | 1 — `collector.packages_tool_missing` |
| `dirty-business` | `complete-within-scope` | `ok` | 1 — `storage.headroom_low`, `/srv/scenario/etc/brood/packets/df-h.txt`, `mount=/srv/data`, `use_percent=93`, `threshold=80` | 9 |
| `hostile` | `partial` (2 `errors`: `home/keeper/locked (EACCES)`, `srv/isolated/unreadable (EACCES)`) | `partial` | 1 — same storage finding | 4 |

`dirty-business` undetected list, verbatim reasons:

```
service.unit_invalid            -> no detector for kind 'service.unit_invalid' (implemented detectors: storage.headroom_low)
service.undocumented_running    -> no detector for kind 'service.running_undocumented' (…)
cron.undocumented_job           -> no detector for kind 'cron.job_undocumented' (…)
docs.contradictory_agents_md    -> no detector for kind 'docs.contradiction' (…)
workspace.charter_rotted        -> no detector for kind 'workspace.charter_stale' (…)
filesystem.broken_symlink       -> no detector for kind 'filesystem.broken_symlink' (…)
filesystem.unexpected_owner     -> no detector for kind 'filesystem.unexpected_ownership' (…)
filesystem.orphan_directory     -> no detector for kind 'filesystem.orphaned_directory' (…)
backup.restore_unverified       -> no detector for kind 'backup.restore_unverified' (…)
```

---

## Honest limits — what this run does **not** prove

1. **One detector exists.** The registry (`suite/cli/src/detectors.ts` → `DETECTORS`) has exactly one
   entry, `storage.headroom_low`. Every other declared fault is returned as `undetected` with the gap
   named. S2's acceptance ("L3 finds `storage.near_full` by citing a packet fact") is met; "the suite
   detects the planted faults" is **not** what the suite claims.
2. **The detector reads evidence, not the machine.** `storage.headroom_low` parses a captured
   `df -h` text file that lives inside the scenario (`etc/brood/packets/df-h.txt`). It does **not** run
   `df` on the running container. The traceability chain (fact → sha256 → packet hash) is real; the
   measurement is as real as the fixture's capture.
3. **Only a filesystem collector is implemented.** The manifests declare ten collectors
   (`host_facts`, `storage`, `packages`, `services`, `projects`, `docs`, `cron`, `backups`,
   `permissions`, `environment`); the packet this build emits is a single `filesystem.snapshot`
   packet. Consequently `partial`'s intent — "the packages collector reports `unsupported`" — is
   **not observed**: its packet is `complete-within-scope` and the gap surfaces only through the
   declared cross-check, as `undetected` with
   `reason: "no detector for kind 'collector.unsupported'"`. L2 passes on `partial` through the
   `partial-by-design` branch, not through a collector status.
4. **Inherited declarations are not cross-checked.** `hostile` declares 4 faults and inherits 16 more
   through `extends:`; `assess` reports `undetected: 4` because it cross-checks only the manifest
   embedded in the packet. (The S5 seam, already recorded in `roadmap/ROADMAP.md`.)
5. **The blast-radius snapshot cannot read below a mode-000 directory** — by design it records the
   barrier (`directory-unreadable`, with its mode). A change *inside* one is invisible.
6. **No unattended cycle.** Nothing here runs a loop without a human per step; that is S6 and it has
   not started.
7. **No A1–A10 acceptance gates exist in this repository.** `roadmap/ROADMAP.md` names "ten
   acceptance gates (A1–A10)" as S6's acceptance; there is **no document defining A1–A10** anywhere in
   the tree (`grep -rn 'A1' --include='*.md'` matches only the two roadmap lines). This run does not
   invent them. Owner decision: write the gates before S6, or replace the wording.
8. **The live provider path was not run.** `tests/live/provider.live.test.ts` (`npm run test:live`) needs a
   real provider endpoint and key, and spends money; only the `fake` provider was exercised. The
   default CI claim is provider-free, and that is what was proven.

---

## Defects found by this run

Each is reproducible from the clone; none was fixed by this run except the one workaround noted.

### V1 — a fresh clone cannot build the test image (documented recipe incomplete)

`suite/Dockerfile.test` does `COPY sshd_config.test /etc/ssh/sshd_config`, but no documented command
creates that file and `.gitignore` excludes it. Reproduced in the clone:

```sh
cd /tmp/brood-clean/suite          # npm install && npm run build already done
ssh-keygen -q -t ed25519 -N '' -f /tmp/brood-keys/id_ed25519 && cp /tmp/brood-keys/id_ed25519.pub testkey.pub
docker build -f Dockerfile.test -t brood-test:local .
# ERROR: failed to compute cache key: "/sshd_config.test": not found
```

The fixture tree's `image/sshd_config` **is** the configuration the test image needs (host key at
`/etc/ssh/host_keys/ssh_host_ed25519_key`, key-only). Continuing the run required the workaround below;
`README.md` now documents it as a build step:

```sh
cp image/sshd_config suite/sshd_config.test   # from the repository root
```

**Owner decision:** either add this line to the recipe (done, as a workaround) or commit a distinct
`sshd_config.test` and un-ignore it.

### V2 — `up.sh` on a fresh clone delivers a machine with an empty `/srv/scenario`

`image/scenario/` is git-ignored and is the compose bind-mount source. In a fresh clone the directory
does not exist; Docker creates it root-owned and empty at `up.sh` time:

```sh
ls -la /tmp/brood-clean/image/scenario   # drwxr-xr-x root root, empty
ssh … 'ls -la /srv/scenario'             # total 4  (empty)
```

In the author's working checkout this is hidden by a hand-made, ignored symlink
`image/scenario/dirty-business -> ../fixtures/dirty-business` (observed: `/srv/scenario` showing
`dirty-business -> ../fixtures/dirty-business`). A fresh clone therefore gets a machine with **nothing
to pamper**, which is a poor first impression but is *not* a violation of "never `COPY` content".
Not fixed: a fix means either a documented populate step or a scenario-selection script — an owner
decision, because it touches how the delivered machine is meant to be handed over.

### V3 — `down.sh` also removes the derived test image

`docker compose down --rmi all` removes `brood-test:local` along with `brood-image:local` (observed:
`Image brood-test:local Removed`), so the documented order matters: build the test image **after**
`down.sh`, or rebuild it. Recorded in `README.md`.

---

## Verdict

Every layer that exists passes on a fresh clone, offline where it claims to be offline, and the
honesty rules hold in what they assert: incomplete scans are labelled, findings cite observed facts,
declared faults are never silently dropped, and the checkout is never written.

What that buys is narrower than "v0 works": one collector, one detector, no unattended cycle, no
A1–A10 gates. S1–S5 acceptance is **met and verified here**; each stays 🔄 in the roadmap until the
owner confirms it. S6 stays ⬜, and this run deliberately did not start it.
