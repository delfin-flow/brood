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

## What this does not do

Findings in this version are still derived from each scenario's declared fault list
(`scenario.yaml`), not measured against the facts. The packet contract above is the
substrate for real detection — see the roadmap story that re-points finding evidence from
the manifest to the observed fact. Until then, "finds every declared fault" is true by
construction, and the packet is the part you can trust.
