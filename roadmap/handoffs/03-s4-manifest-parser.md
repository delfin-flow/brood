# S4 — manifest ↔ parser agreement

Reconstructed 2026-11-14 from commit `665e42b` and `suite/NOTES.md`; not written at delivery time.

## Delivered

- `parseScenarioFaults` reads the fixtures' own schema: `id`, `expect_as`, `evidence`,
  `discoverable_by` (non-empty list of commands) and optional `note`.
- An **undeclared field fails loudly** (`faults[0] has undeclared field(s): expect; declared fields
  are …`). The tolerances for `kind`/`type`/`check`, `name`/`key`, `title`, `path`/`target`/`file` and
  the `planted_faults` alias are gone.
- `faults: []` is still an explicit, accepted empty list; an absent or non-array declaration fails
  loudly and never becomes "zero findings".
- `DeclaredFault` exposes `id`, `expectAs`, `evidence`, `discoverableBy`, `note`; L1 covers the accepted
  shape, every required field, the wrong-field-name failure and the empty list.

## Decisions & deviations

- **A silently discarded field is a declaration bug, not a wart to tolerate.** Tolerating
  `expect_as` while declaring by `id` meant the field the detector registry keys on was never read —
  the suite worked by accident.
- **The parser does not accept top-level aliases.** Only the fixture schema is supported; the failure
  message names the declared fields so a fixture author can fix the manifest.

## Known issues

- The parser is strict about **fault entries**, not about other top-level manifest keys (`name`,
  `extends`, `materialization`, `collector_contracts`, …), which are read where needed and otherwise
  ignored. That gap is deliberate: those keys describe the scenario, they do not change whether a fault
  is declared.
- `extends` was still unread at this point; a derived scenario's inherited declarations were only in the
  parent's manifest. Recorded as a seam and closed by S8 (declared-chain honesty).

## Hand-off to next story

S2 keyed its detector registry on the now-read `expect_as`, and S8 later read `extends` from the same
manifest parse.
