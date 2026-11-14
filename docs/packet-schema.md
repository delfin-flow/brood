# Observation packet schema (v1)

An **observation packet** is what a collector reports about the machine. It is the only
channel through which Brood's later stages see the world, so its honesty rules are the
load-bearing part of the design.

```json
{
  "schema_version": 1,
  "kind": "filesystem.snapshot",
  "scope": "/srv/scenario",
  "coverage": "complete-within-scope",
  "observed_at": "2026-11-14T05:53:41.889Z",
  "collector": { "name": "filesystem", "version": "1.0.0" },
  "facts": [],
  "errors": [],
  "skipped": [],
  "problems": [],
  "canonical_hash": "<sha256>"
}
```

## Coverage states

`complete-within-scope` · `partial` · `unsupported` · `unknown` · `stale`

Aggregation over packets takes the worst state present (`unsupported` alone stays
`unsupported`; anything else mixed with it collapses to `partial`).

## Rule 1 — a fact is never a coverage failure

If something is a *property of the machine worth reporting*, it is a **fact**. Only an
observation that could not be made at all degrades coverage.

The planted faults are the test of this rule. A broken symlink is a fault, not a scan
error:

```json
{
  "path": "/srv/scenario/home/keeper/bin/legacy-import",
  "kind": "filesystem.symlink",
  "sha256": "<sha256 of the link target string>",
  "size": 0,
  "mode": 511,
  "target": "../../../srv/projects/archived-import/bin/import.py",
  "target_exists": false,
  "loop": false
}
```

The scan that produced it is `complete-within-scope` with no reasons: it observed
everything in scope. Turning the fault into `partial` would have hidden the very thing
the operator asked to be told about.

Two consequences worth stating:

- symlinks are **recorded, never followed** — a link out of the scope leaks nothing into
  the packet, and a loop terminates;
- a link loop is `target_exists: false, loop: true` — a fact, not an error.

Fact kinds: `filesystem.file` (path, sha256, size, mode, optional inline `content` for
`scenario.yaml`) and `filesystem.symlink` (the same identity fields plus `target`,
`target_exists`, `loop`; `size` is 0 and `sha256` covers the target string).

## Rule 2 — never an incomplete label without a reason

Every non-`complete-within-scope` packet must carry at least one entry across:

| field | meaning |
|---|---|
| `errors` | an observation was attempted and failed (unreadable directory, unreadable file, unverifiable link target) |
| `skipped` | an in-scope item was deliberately not collected (special file, over-size inline content) |
| `problems` | why the packet as a whole is not complete (scope absent, collector unavailable) |

`validatePacket` refuses the label without the reason, and refuses a reason list that is
not a list of non-empty strings. A disabled collector therefore reports:

```json
{ "coverage": "unsupported", "facts": [],
  "problems": ["collector 'filesystem' is unavailable: disabled by BROOD_DISABLE_COLLECTORS for scope /srv/scenario"] }
```

An empty scan is never a successful scan: `assess` rejects an empty packet list outright.

## Identity

`canonical_hash` is SHA-256 over the canonical (key-sorted) packet with `observed_at` and
`canonical_hash` removed. Two scans of unchanged state produce the same hash even though
each carries its own observation time, so a gap between runs can be detected without
noise. `sha256` of a file fact is over the file bytes; `size` and `mode` are part of the
fact, not decoration.

## Detection and the `undetected` contract

A finding comes from a **detector**, never from the scenario manifest. `assess` reads the
declared faults only as a cross-check list; every finding cites the **observed fact** it
measured — the fact's `path`, its `sha256`, and the packet's `canonical_hash`. A detector
re-reads and re-hashes the file before using it and refuses a fact whose bytes changed
since it was observed (`fact changed since it was observed: <path>`).

Implemented detectors (registry keyed by the manifest's `expect_as`):

| kind | detector |
|---|---|
| `storage.headroom_low` | parses a captured `df -h` and reports one `storage.near_full` finding per persistent filesystem whose `Use%` reaches the threshold |

`tmpfs` and `devtmpfs` are skipped — volatile, not the persistent filesystems the cockpit
documents talk about — and rows that do not parse are dropped rather than guessed at. The
parse follows the header, not fixed columns.

```json
{ "id": "detected-…", "fault_id": "storage.near_full", "kind": "storage.headroom_low",
  "evidence": { "path": "/srv/scenario/dirty-business/etc/brood/packets/df-h.txt",
                "sha256": "<file sha256>", "packet_hash": "<packet canonical_hash>" },
  "measured": { "mount": "/srv/data", "use_percent": 93, "threshold": 80 },
  "coverage": "complete-within-scope", "provenance": { "…": "…" },
  "source": "/srv/scenario/dirty-business/etc/brood/packets/df-h.txt" }
```

### The storage threshold is explicit

The machine's own notes disagree — `home/brood/AGENTS.md` and `cockpit/policies.md` say
80 %, `cockpit/runbook.md` says 85 %. That contradiction is a planted fault of its own, so
the detector does **not** resolve it. The threshold is read from
`BROOD_STORAGE_THRESHOLD_PERCENT` (default **80**) and written into `measured.threshold` so
a reader can disagree with it.

### `undetected` — silence is not a clean bill of health

`assess` returns `undetected` alongside `findings`. Every declared fault is either backed by
a detection or listed here with a reason:

| situation | `reason` |
|---|---|
| no detector is registered for the kind | `no detector for kind '<expect_as>' (implemented detectors: …)` |
| the detector ran but produced nothing for it | `detector ran, threshold not crossed` |

This is where the honest limits live: **only storage headroom is detected**. Every other
planted fault (`service.unit_invalid`, `filesystem.broken_symlink`, `backup.restore_unverified`,
…) appears as `undetected` with the gap named. A scan that finds nothing is still only a
claim about the detectors that ran.

The `report` command lists the same `undetected` set, so the operator-facing artifact never
reads as "all clear" when a kind was never checked.

### `declarations` — what the declared set could verify

The manifest embedded in the packet is the only manifest the CLI can see. A scenario that
inherits (`extends:`) keeps the inherited faults in its **parent's** manifest, so a scan of
one mounted scenario sees a subset of the declared set. `assess` therefore always returns a
`declarations` block next to `findings` and `undetected`:

```json
{ "source": "observed manifests", "resolved": false, "extends": "dirty-business",
  "reason": "parent scenario manifest 'dirty-business' is not in the observed scope",
  "declared_count": 4, "unverified_inheritance": "dirty-business", "unverified_count": null }
```

- `resolved` is true only when every manifest the chain needs is among the observed facts.
  When an operator scans a tree that holds child **and** parent manifests, the whole chain is
  walked (child → parent → grandparent) and `declared_count` is the full sum.
- `unverified_inheritance` names the unresolved parent; `unverified_count` is `null` when the
  parent manifest is out of scope — the CLI does not invent a number for declarations it has
  not seen. `reason` says why.
- `extends` is the direct parent (or the unresolved one); `declared_count` counts only the
  faults of manifests the walk could read, so it is a **lower bound** while `resolved` is false.
- A scenario with no `extends` reports `resolved: true`, `unverified_inheritance: null`,
  `unverified_count: 0` and claims nothing else.

`report` carries the same block in its JSON and states it in the Markdown artifact, e.g.
`- Declared set: 4 faults from the observed manifests; inheritance via 'dirty-business' not
verifiable in scope (inherited declarations unverified; count unknown)`. An empty or
unsupported scan reports `resolved: false` with the reason instead of an empty success.
