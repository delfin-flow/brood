# Brood — roadmap

> Single source of truth for what is done and what is next. Story cards follow the ICM/MWP loop:
> accept → process → hand off. Status: ⬜ todo · 🔄 in progress · ✅ done. Model handoff notes live in
> the author's private handoff queue; this file carries only the stem.

**Scope — v0 simulation:** a disposable Debian 13 machine, the `broodctl` operator, and the proof
suite that keeps the agent honest. Design contract: the ICM/MWP methodology (private, referenced by name). The published promise this
serves: the "business operations workspace" offer (agentic operations).

**Maturity path:** markdown → optimisation → scripts → binaries → app. Story status: ⬜ todo ·
🔄 in progress · ✅ done.

## Current state (2026-11-14)

- **The three zips landed and are assembled** under the repository root: `image/` (the machine),
  `fixtures/` (five dirty scenarios), `suite/` (`broodctl` + Vitest). Committed.
- **Clean-room verified from a fresh clone** (`docs/verification-2026-11-14.md`, commit `83241cb`;
  Docker 29.9.3, Node 24.19.0): `npm test` = **39 tests** offline (also inside `unshare -rn`, no
  network), `tsc --noEmit` clean; the delivered image builds with `--no-cache` (310 MB) and serves
  key-only SSH; the derived test image builds; **all five scenarios pass the integration suite** —
  `hostile` 9/9, the other four 8 passed / 1 skipped (the hostile-only guard) — and the checkout stays
  clean. Two delivery gaps were found and recorded in `FINDINGS.md` (the test image needs a
  `sshd_config.test` that nothing generates; a fresh clone's delivered machine has an empty
  `/srv/scenario`).
- **S1 — coverage honesty.** A broken symlink is a fact (`filesystem.symlink`, `target_exists: false`),
  the scan stays `complete-within-scope`, and every non-complete packet carries
  `errors`/`skipped`/`problems` — enforced by `validatePacket`, documented in `docs/packet-schema.md`.
  A disabled collector reports `unsupported` *with its reason*.
- **S3 — interruption.** The defect was never the test helper: the failpoint never held the process
  (a signal listener does not keep Node's event loop alive — exit 13). Fixed, L4 green end to end, and
  covered by an offline regression test. There is no "recoverable journal"; recovery is re-observation.
- **S4 — manifest ↔ parser.** The parser now reads the fixtures' own fields (`id`, `expect_as`,
  `evidence`, `discoverable_by`, optional `note`) and **fails loudly on an unknown field**; the
  `kind`/`type`/`check` and `planted_faults` tolerances are gone.
- **S2 — one real detector.** `assess` runs a detector registry over packet facts; the only registered
  detector is `storage.headroom_low`, which parses a captured `df -h` by header and reports
  `storage.near_full` per persistent filesystem at or over `BROOD_STORAGE_THRESHOLD_PERCENT` (default
  80). Findings cite the **fact** (`path` + `sha256` + packet hash) and the detector re-hashes the bytes,
  refusing a file that changed after observation. Declared faults are the cross-check list: every one is
  either detected or returned in `undetected` with the gap named. Only storage is detected; the rest is
  honestly undetected.
- **S1/S2/S3/S4/S5 acceptance is met and verified here; each stays 🔄 until the owner confirms it.**
- **S5 — fixture materialisation.** `.git.fixture` → `.git` and the `hostile` permissions are re-applied
  by `fixtures/materialize.sh` on a **throwaway copy** of one scenario (`BROOD_SCENARIO`, default
  `dirty-business`) that the harness mounts at `/srv/scenario:ro`. A fresh clone therefore reproduces
  the delivered fault set with no manual step, the checkout is never written (a run leaves
  `git status --short` clean), and a guard test fails if the mount is not materialised. A scenario's
  inherited declarations are no longer dropped silently: `assess`/`report` carry a `declarations` block
  that names an `extends:` parent it cannot see (S8).
- **No unattended cycle yet.** Nothing here proves a cycle can run without a human in the loop; that is
  the point of S6, not a current fact.
- **S6's acceptance names gates that do not exist.** "Ten acceptance gates (A1–A10)" appears only in
  this roadmap; no A1–A10 document exists in the repository. Whether they get written before S6 starts
  is an owner decision, recorded here rather than invented.

## Owner decisions (operator, 2026-11-13)

- **D1** — Brood is **open source**; the methodology is the **private moat**, Continuity the client asset
  (see the methodology's product model).
- **D2** — the path leads to the **unattended ambient cycle**, gated on the evidence discipline: a
  planted fault must never read as a scan failure before any autonomy is allowed.
- **D3** — sub-projects already exist that Brood will target as its optimisation step: **Guild** (the
  compiled loop), **Engram** (the deterministic reasoning kernel), **Iterifact** — formerly Weave — (goal →
  capability → artifact runtime), **Hippocampus** (deterministic retrieval). Brood does not rebuild them;
  once it proves a *need*, it references and adopts them rather than rebuilding.
- **D4** — **Cove is Brood's interface surface.** Cove is the UI an operator works Brood through (an
  Office queue of observations, proposals, approvals and reports); Brood keeps the CLI as its only
  operator and does not grow a GUI of its own. Referenced, not built here.
- **D5** — **Homeostat and FreshPoint are Brood's future evolution and optimisation, and they are
  separate projects today.** Homeostat (local-first self-healing Linux operations) and FreshPoint
  (maintenance and recovery tooling) are the human-driven forms of the same problem Brood generalises.
  Brood references them; it does not absorb them, and it does not claim their scope. When Brood matures,
  these are what it is offered *through* rather than replaced by.

## Stories

| # | Story | Stage | Status | Acceptance |
|---|-------|-------|--------|------------|
| S1 | **Fix coverage honesty** — record a broken symlink as a fact (`kind: filesystem.symlink`, `target_exists: false`), keep `complete-within-scope`, and always emit the coverage *reason* list (`errors`/`skipped`/`problems`) whenever a scan is not complete | optimisation | 🔄 | L2 goes green; `dirty-business` reports `complete-within-scope`; a removed collector still reports `unsupported` with a reason |
| S2 | **One real detector** — implement storage-headroom detection (compare `df` facts against the declared threshold) and re-point L3's evidence at the observed *fact*, not the manifest | optimisation | 🔄 | L3 finds `storage.near_full` by citing a packet fact; the "declared-fault echo" path is removed or gated behind a real check |
| S3 | **Fix the L4 interruption test** — repair the kill helper so the signal reaches the right pid, then make recovery actually pass | optimisation | 🔄 | L4 green: interrupted observe leaves a recoverable journal; expired/altered approval refused; revert exercised |
| S4 | **Manifest ↔ parser agreement** — read `expect_as` and `discoverable_by` (the fixtures already declare them), and drop the tolerance for unknown fields | optimisation | 🔄 | A `scenario.yaml` with a wrong field name fails loudly, not silently |
| S5 | **Fixture materialisation** — `materialize.sh` re-applies `.git.fixture`→`.git` and the `hostile` permissions; the harness now runs it on a throwaway copy of one mounted scenario (`BROOD_SCENARIO`), so a fresh checkout is hostile without a manual step | scripts | 🔄 | A fresh clone + `cd suite && npm run test:int` reproduces the same fault set as the zip — and leaves the checkout untouched |
| S6 | **The ambient cycle (unattended), gated** — a bounded loop: observe → assess → propose → (approve) → apply → verify → report, running with **no human per step**, inside the standing requirements | app | ⬜ | Ten acceptance gates (A1–A10) pass; the cycle runs a full round without a human decision except approval; cost and blast radius recorded |
| S7 | **Adopt a sub-project** — when S6 reveals a real need (event loop, deterministic reasoning, retrieval), reference **Guild / Engram / Iterifact / Hippocampus** instead of rebuilding; promote Brood's loop toward the compiled form | binary | ⬜ | The adopted component is referenced by contract; Brood carries no re-implementation of it |
| S8 | **Declared-chain honesty** — `assess`/`report` read `extends:`, resolve the chain when the parent manifests are in the observed scope, and otherwise name the unresolved inheritance and say its declarations could not be verified | optimisation | 🔄 | `hostile`'s packet and report both state "4 declared, inheritance via `dirty-business` unverified"; the suite asserts the CLI's block and fails if it disappears |

## Distribution & stations

- **Open source** (`D1`): the repo is the public artefact. Nothing private may land in it — the KB's
  reasoning is referenced by *name* (methodology), never by path or content.
- **CLI first.** `broodctl` is the operator; a daemon/GUI inside Brood is never the next rung. The
  interface rung is **Cove** (D4) — an Office surface that works Brood's packets, proposals and reports,
  referenced by contract rather than reimplemented.
- **Simulation only** until A1–A10 pass. Brood does not touch a real machine before that.

## Hand-offs

Model handoff notes (the private queue) and project handovers (`roadmap/handoffs/`) are **referenced,
not copied**. A story's hand-off names the stem; the body lives in the queue.

| Story | Note stem | Status |
|---|---|---|
| S2 storage-headroom detector | `2026-11-14-01-flash-brood-s2-storage-headroom-detector` | done |
| S5 fixture materialisation | `2026-11-14-02-flash-brood-s5-fixture-materialisation` | done |
| v0 acceptance run (not a story — the review gate) | `2026-11-14-03-flash-brood-v0-verification-gate` | done — `docs/verification-2026-11-14.md` |

S1, S3 and S4 were done in-session (`3397d3d`, `665e42b`); S2 and S5 ran as flash handoffs. Their
acceptance is met and verified, and each stays 🔄 until the owner confirms it. The v0 acceptance run
(`docs/verification-2026-11-14.md`) re-verified all of them from a fresh clone; the owner's review
checklist is in that note's Result.

