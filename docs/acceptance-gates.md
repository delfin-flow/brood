# Brood — acceptance gates for the unattended cycle (A1–A10)

> **Status: PROPOSED — not ratified. S6 stays ⬜ until the owner ratifies this set.**
>
> These gates were drafted from the design contract, not from a passing implementation. Every gate is a
> testable statement plus the observable that proves it at **T0** (no provider spend, no network, no
> real machine) unless it says otherwise. A gate whose proof does not exist yet says
> `Proof: none — required before S6`; nothing here claims a capability the repository does not have.
>
> Ratification means: the owner accepts the set as the definition of "S6 done", may amend a gate, and
> only then does S6 start. Amending a gate after S6 starts is a finding, not a convenience.

| Gate | Statement | Observable | Proof |
|---|---|---|---|
| **A1 — no-provider baseline** | A full round runs with `BROOD_PROVIDER=fake`, no network and no spend; the fake provider is the default and no code path selects a real one implicitly. | The round completes with `status` values from the packet set alone; `BROOD_PROVIDER=provider-must-not-be-called` still succeeds for `observe`. | `cd suite && npm test` (L0/L1, offline) and `npm run test:int` with no `BROOD_PROVIDER_API_KEY`, no `BROOD_PROVIDER_URL`; L2 runs `observe` under `BROOD_PROVIDER=provider-must-not-be-called`. |
| **A2 — bounded loop** | The cycle has declared step and time budgets; exceeding either stops the cycle and reports, never continues. | A cycle that would exceed its step or time budget exits with a reported budget breach; no step starts after the breach. | `Proof: none — required before S6`. There is no cycle yet; the only bounded thing is `BROOD_PROPOSAL_TTL_SECONDS` on a proposal. |
| **A3 — approval gating** | No mutation without a valid, unexpired, argument-bound approval; missing, expired, altered and malformed tokens are all denied with distinct reasons. | Four denials with distinguishable reasons, and no file write for any of them. | `suite/tests/integration/brood.integration.test.ts` (L4) denies an **expired** and an **altered** token. **Partial:** missing and malformed tokens are guarded in `suite/cli/src/index.ts` but not asserted; `Proof: partial — add the two missing denials before S6`. |
| **A4 — revert first** | Every applied change carries a receipt; revert restores byte-identical prior state (or removes a newly created file), and is exercised in the cycle, not only manually. | Receipt exists for every apply; `revert` reproduces the pre-apply bytes and mode; a created file is removed. | `suite/tests/integration/brood.integration.test.ts` (L4: apply → verify → revert) and the blast-radius test. **Partial:** exercised as explicit commands, not inside a cycle — `Proof: partial — cycle exercise required before S6`. |
| **A5 — honesty** | An incomplete scan is never reported as healthy, and every declared-but-undetected fault is named, including an unresolved `extends:` chain. | A degraded packet carries `errors`/`skipped`/`problems`; `undetected` lists every declaration the CLI saw; the `declarations` block names an out-of-scope parent with `resolved: false`. | `suite/tests/l0/collector.test.ts`, `suite/tests/l1/contracts.test.ts` ("declared-chain honesty"), and L2's coverage/`undetected` assertions. |
| **A6 — idempotence** | A second cycle on unchanged state produces identical packet hashes and zero new proposals. | Two observes of unchanged state yield the same `canonical_hash` set; the second cycle emits no proposal for an already-proposed finding. | Canonical-hash equality is proven in `suite/tests/l0/core.test.ts`; **no cycle-proposal set exists** — `Proof: partial — the zero-new-proposals half is required before S6`. |
| **A7 — interruption safety** | Interrupting any step leaves no partial write; re-observation converges; the next cycle proceeds. | After a signal at any failpoint, no partial file is left; the next observe yields the same packet hashes as an uninterrupted run. | Offline: `suite/tests/l0/failpoint.test.ts`. Over SSH: L4's interrupted `observe` + converged re-observation. **Partial:** only `observe` has a failpoint — `Proof: partial — other steps required before S6`. |
| **A8 — blast radius** | Nothing outside `BROOD_MUTABLE_ROOT` changes, and the mounted scenario is byte-for-byte, mode-for-mode identical after the round. | A relative-path/mode/sha256 snapshot of the mount before and after is identical; the repository's `fixtures/` tree is never the mount source. | `suite/tests/integration/brood.integration.test.ts` ("blast radius — scenario state equality") on a materialised copy; `image/compose.yaml` mounts `.runtime/scenario/<name>`, and `up.sh` copies it there. |
| **A9 — cost accounting** | Per-cycle command count and provider cost are recorded, and a declared ceiling breach fails loudly instead of continuing. | A cycle result carries a command count and a provider cost; a breach of the declared ceiling produces a non-zero result with the breach named. | `Proof: none — required before S6`. Only a per-proposal `cost_estimate` exists today; no cycle, no ceiling. |
| **A10 — report fidelity** | The operator-facing report cites facts only (no manifest echo), and carries coverage, the undetected/gap list and the declared-set statement through to the artifact. | Every finding in the report traces to an observed fact; the Markdown carries coverage, `undetected` and `declarations`; no finding cites `scenario.yaml`. | L2's `report` assertions and L3's evidence-traceability assertions (a finding may never cite `scenario.yaml`); `declarationLine` covers the declared set. |

## What ratification does not change

- Simulation only: no gate requires a real machine, and passing A1–A10 still does not authorise one.
- The gates do not add collectors or detectors. A5 is an honesty gate, not a coverage target.
- "Proof: none/partial" is a finding about the current repository, recorded rather than softened. A gate
  may only flip to proven when its observable is demonstrated at T0, and the test is committed.
