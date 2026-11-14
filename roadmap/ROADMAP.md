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
- **Verified on this machine** (Docker 29.9.3, Node 24.19.0): `npm test` = **30 tests** offline, `tsc
  --noEmit` clean, **all five integration tests pass** — L2, L3 (both cases), L4 and blast radius —
  and the image builds with key-only SSH.
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
- **The one defect that stands** — L3 is still a declared-fault echo: `assess` reads each scenario's
  `scenario.yaml` and emits one finding per declaration, so "finds every declared fault" is true by
  construction. S2 is the story that makes it mean something.
- **S1/S3/S4 acceptance is met and verified here; each stays 🔄 until the owner confirms it.**
- **No unattended cycle yet.** Nothing here proves a cycle can run without a human in the loop; that is
  the point of S6, not a current fact.

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
| S2 | **One real detector** — implement storage-headroom detection (compare `df` facts against the declared threshold) and re-point L3's evidence at the observed *fact*, not the manifest | optimisation | ⬜ | L3 finds `storage.near_full` by citing a packet fact; the "declared-fault echo" path is removed or gated behind a real check |
| S3 | **Fix the L4 interruption test** — repair the kill helper so the signal reaches the right pid, then make recovery actually pass | optimisation | 🔄 | L4 green: interrupted observe leaves a recoverable journal; expired/altered approval refused; revert exercised |
| S4 | **Manifest ↔ parser agreement** — read `expect_as` and `discoverable_by` (the fixtures already declare them), and drop the tolerance for unknown fields | optimisation | 🔄 | A `scenario.yaml` with a wrong field name fails loudly, not silently |
| S5 | **Fixture materialisation** — `materialize.sh` re-applies `.git.fixture`→`.git` and the `hostile` permissions; make it part of `just test:int` so a fresh checkout is hostile without a manual step | scripts | ⬜ | A fresh clone + `just test:int` reproduces the same fault set as the zip |
| S6 | **The ambient cycle (unattended), gated** — a bounded loop: observe → assess → propose → (approve) → apply → verify → report, running with **no human per step**, inside the standing requirements | app | ⬜ | Ten acceptance gates (A1–A10) pass; the cycle runs a full round without a human decision except approval; cost and blast radius recorded |
| S7 | **Adopt a sub-project** — when S6 reveals a real need (event loop, deterministic reasoning, retrieval), reference **Guild / Engram / Iterifact / Hippocampus** instead of rebuilding; promote Brood's loop toward the compiled form | binary | ⬜ | The adopted component is referenced by contract; Brood carries no re-implementation of it |

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
| S2 storage-headroom detector | `2026-11-14-01-flash-brood-s2-storage-headroom-detector` | open |
| S5 fixture materialisation | `2026-11-14-02-flash-brood-s5-fixture-materialisation` | open |
| v0 acceptance run (not a story — the review gate) | `2026-11-14-03-flash-brood-v0-verification-gate` | open |

S1, S3 and S4 were done in-session (`3397d3d`, `665e42b`); their acceptance is met and verified, and
each stays 🔄 until the owner confirms it.
