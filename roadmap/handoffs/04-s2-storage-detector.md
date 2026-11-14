# S2 — one real detector (storage headroom)

Reconstructed 2026-11-14 from the closed note
`2026-11-14-01-flash-brood-s2-storage-headroom-detector` and commit `ba04ecf`; not written at delivery
time.

## Delivered

- `assess` no longer echoes `scenario.yaml`. A **detector registry** (`suite/cli/src/detectors.ts`)
  runs over packet facts; the only registered detector is `storage.headroom_low`.
- It parses a captured `df -h` **by header** (skipping `tmpfs`/`devtmpfs` and rows that do not parse),
  and emits one `storage.near_full` finding per persistent filesystem whose `Use%` reaches
  `BROOD_STORAGE_THRESHOLD_PERCENT` (default 80).
- A finding cites the **observed fact**: `path`, file `sha256`, packet `canonical_hash`, plus
  `measured: { mount, use_percent, threshold }`. The detector re-reads and re-hashes the file and
  refuses one that changed after observation.
- `assess` returns `undetected`: every declared fault is either backed by a detection or listed with a
  reason — `no detector for kind '<expect_as>' (implemented detectors: …)` or `detector ran, threshold
  not crossed`. `report` lists the same set.
- L3 was rewritten so it can fail: every finding must trace to an input fact with a matching hash and
  may never cite `scenario.yaml`; storage is found for `dirty-business` and `hostile` (93 % on
  `/srv/data`), absent for `clean`/`dirty-dev`/`partial` (57 %), and the 95 % override turns the finding
  into `undetected`.
- The threshold is explicit and recorded in `measured` because the machine's own notes contradict each
  other (80 % in `home/brood/AGENTS.md` and `cockpit/policies.md`, 85 % in `cockpit/runbook.md`); that
  contradiction is a planted fault the detector must not resolve.

## Decisions & deviations

- **Only one detector.** `storage.headroom_low` was chosen because the fault is decidable from a
  captured fact and has a clean negative control. No other kind gets a detector in this story.
- **Declarations are a cross-check list, never a finding source.** The registry is keyed by
  `expect_as`, so a manifest alone can never produce a finding.
- **The threshold is not resolved.** Choosing 80 or 85 would silently take a side in a planted
  contradiction; writing the number into every finding lets a reader disagree with it.

## Known issues

- **Honest limit: one detector, reading one captured `df -h`, citing that fact.** Every other declared
  fault (`service.unit_invalid`, `filesystem.broken_symlink`, `backup.restore_unverified`, …) is
  reported as `undetected` with the gap named. L3 proves traceability and the negative control, not
  that the other planted faults are detectable.
- The CLI cross-checks only the manifest embedded in the packet, so an inherited declaration
  (`hostile extends dirty-business`) was detected but not listed as declared. **That seam is closed by
  S8** (`declarations` block, `docs/packet-schema.md`).

## Hand-off to next story

S8 (declared-chain honesty) and S9 (delivery recipe). The detector itself needs no further work before
the ambient cycle: it is the only one, and the suite says so.
