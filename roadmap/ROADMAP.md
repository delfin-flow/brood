# Brood — roadmap

> Single source of truth for what is done and what is next. Story cards follow the ICM/MWP loop:
> accept → process → hand off. Status: ⬜ todo · 🔄 in progress · ✅ done. Model handoff notes live in
> the author's private handoff queue; this file carries only the stem.

**Scope — v0 simulation:** a disposable Debian 13 machine, the `broodctl` operator, and the proof
suite that keeps the agent honest. Design contract: the ICM/MWP methodology (private, referenced by name). The published promise this
serves: the "business operations workspace" offer (agentic operations).

**Maturity path:** markdown → optimisation → scripts → binaries → app. Story status: ⬜ todo ·
🔄 in progress · ✅ done.

## Current state (2026-11-13)

- **The three zips landed and are assembled** under the repository root: `image/` (the machine),
  `fixtures/` (five dirty scenarios), `suite/` (`broodctl` + Vitest). Committed.
- **Verified on this machine, not claimed from the model:** image builds (310 MB), key-only SSH
  works, **L0+L1 = 18 tests pass offline**, `tsc --noEmit` clean, **blast radius passes**.
- **Three defects, one design-level**, recorded in `FINDINGS.md`:
  1. a planted fault (broken symlink) is **classified as a scan failure** → `coverage: partial` with
     no reason field, and the fault itself never appears in `facts` — this blocks L2 and violates the
     honest-coverage rule;
  2. **L3 echoes the scenario manifest** instead of detecting — "finds every declared fault" is true
     by construction, so acceptance currently proves nothing;
  3. the **L4 kill helper aborts** before testing recovery.
- **No unattended cycle yet.** Nothing here proves a cycle can run without a human in the loop; that
  is the point of the roadmap below, not a current fact.

## Owner decisions (operator, 2026-11-13)

- **D1** — Brood is **open source**; the methodology is the **private moat**, Continuity the client asset
  (see the methodology's product model).
- **D2** — the path leads to the **unattended ambient cycle**, gated on the evidence discipline: a
  planted fault must never read as a scan failure before any autonomy is allowed.
- **D3** — sub-projects already exist that Brood will target as its optimisation step: **Guild** (the
  compiled loop), **Engram** (the deterministic reasoning kernel), **Iterifact** and **Weave** (goal →
  capability → artifact runtimes), **Hippocampus** (deterministic retrieval). Brood does not rebuild
  them; once it proves a *need*, it references and adopts them rather than rebuilding.

## Stories

| # | Story | Stage | Status | Acceptance |
|---|-------|-------|--------|------------|
| S1 | **Fix coverage honesty** — record a broken symlink as a fact (`kind: filesystem.symlink`, `target_exists: false`), keep `complete-within-scope`, and always emit the coverage *reason* list (`errors`/`skipped`/`problems`) whenever a scan is not complete | optimisation | 🔄 | L2 goes green; `dirty-business` reports `complete-within-scope`; a removed collector still reports `unsupported` with a reason |
| S2 | **One real detector** — implement storage-headroom detection (compare `df` facts against the declared threshold) and re-point L3's evidence at the observed *fact*, not the manifest | optimisation | ⬜ | L3 finds `storage.near_full` by citing a packet fact; the "declared-fault echo" path is removed or gated behind a real check |
| S3 | **Fix the L4 interruption test** — repair the kill helper so the signal reaches the right pid, then make recovery actually pass | optimisation | ⬜ | L4 green: interrupted observe leaves a recoverable journal; expired/altered approval refused; revert exercised |
| S4 | **Manifest ↔ parser agreement** — read `expect_as` and `discoverable_by` (the fixtures already declare them), and drop the tolerance for unknown fields | optimisation | ⬜ | A `scenario.yaml` with a wrong field name fails loudly, not silently |
| S5 | **Fixture materialisation** — `materialize.sh` re-applies `.git.fixture`→`.git` and the `hostile` permissions; make it part of `just test:int` so a fresh checkout is hostile without a manual step | scripts | ⬜ | A fresh clone + `just test:int` reproduces the same fault set as the zip |
| S6 | **The ambient cycle (unattended), gated** — a bounded loop: observe → assess → propose → (approve) → apply → verify → report, running with **no human per step**, inside the standing requirements | app | ⬜ | Ten acceptance gates (A1–A10) pass; the cycle runs a full round without a human decision except approval; cost and blast radius recorded |
| S7 | **Adopt a sub-project** — when S6 reveals a real need (event loop, deterministic reasoning, retrieval), reference **Guild / Engram / Iterifact / Weave / Hippocampus** instead of rebuilding; promote Brood's loop toward the compiled form | binary | ⬜ | The adopted component is referenced by contract; Brood carries no re-implementation of it |

## Distribution & stations

- **Open source** (`D1`): the repo is the public artefact. Nothing private may land in it — the KB's
  reasoning is referenced by *name* (methodology), never by path or content.
- **CLI first.** `broodctl` is the operator; a daemon/GUI is a later rung, not the first.
- **Simulation only** until A1–A10 pass. Brood does not touch a real machine before that.

## Hand-offs

Model handoff notes (the private queue) and project handovers (`roadmap/handoffs/`) are **referenced,
not copied**. A story's hand-off names the stem; the body lives in the queue.
