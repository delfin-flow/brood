# S1 — coverage honesty

Reconstructed 2026-11-14 from commit `3397d3d` and `docs/packet-schema.md`; not written at delivery
time.

## Delivered

- A planted **broken symlink is a fact**, not a scan failure: the collector emits
  `kind: filesystem.symlink` with `target`, `target_exists` and `loop`, and the scan that saw it stays
  `complete-within-scope`. Symlinks are recorded, never followed, so a loop terminates and a link out of
  scope leaks nothing into the packet.
- Every non-complete packet carries its reason list — `errors` (observation attempted and failed),
  `skipped` (deliberately not collected), `problems` (why the packet as a whole is incomplete) — and
  `validatePacket` refuses a non-complete coverage label with no reason, plus any unobserved fact shape.
- A disabled collector (`BROOD_DISABLE_COLLECTORS=filesystem`) emits an explicit `unsupported` packet
  with the reason, never an empty successful scan; an absent scope is `unknown` with its reason.
- The collector moved out of the CLI entry point into `suite/cli/src/collector.ts` so it can be tested
  at T0; `suite/tests/l0/collector.test.ts` is the new offline coverage.
- The contract is written down in `docs/packet-schema.md` (rule 1: a fact is never a coverage failure;
  rule 2: never an incomplete label without a reason).
- The harness started passing `BROOD_STATE_DIR`, `BROOD_MUTABLE_ROOT` and `BROOD_APPROVAL_SECRET` on
  **every** remote CLI call, because `docker run --env` reaches PID 1 only and an SSH session gets a
  fresh environment (recorded later as Defect 4 in `FINDINGS.md`).

## Decisions & deviations

- **The fault stays visible without degrading coverage.** The alternative — classify a broken symlink
  as `partial` with a reason — was rejected: it would turn a discoverable planted fault into a scan
  failure, which is the opposite direction from the honesty rule.
- **Refusing an incomplete label without a reason is a validation failure, not a warning.** The packet
  contract is enforced in `validatePacket`, so a producer cannot emit an opaque `partial`.
- The harness fix rode in this commit rather than its own; it was found one assertion after the
  coverage bug and blocked L2.

## Known issues

- Only the filesystem collector exists. Non-filesystem collectors are unimplemented, so a scenario's
  other declarations are not observed at all yet.
- A snapshot cannot read below a mode-000 directory: that barrier is a fact with its mode, not an
  error, and its contents stay unobservable by design.

## Hand-off to next story

S2 replaced the declared-fault echo in `assess` with a real detector over observed facts; the next
story therefore had to keep the `errors`/`skipped`/`problems` reason lists flowing through `report`.
