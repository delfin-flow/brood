# S5 — fixture materialisation

Reconstructed 2026-11-14 from the closed note
`2026-11-14-02-flash-brood-s5-fixture-materialisation` and commit `83241cb`; not written at delivery
time.

## Delivered

- `fixtures/materialize.sh` takes `--root <dir>` (default: the script's own directory, so the
  documented command is unchanged). The `hostile` `chmod 000` applies only when `hostile` is among the
  selected scenarios.
- The integration harness mounts **one materialised scenario per run**: `startBroodEnvironment()` reads
  `BROOD_SCENARIO` (default `dirty-business`), copies that scenario from the fixtures root
  (`BROOD_SCENARIO_DIR`) into `/tmp/brood-vitest-scenario-<mkdtemp>`, runs `materialize.sh --root <copy>
  <scenario>`, snapshots the copy and mounts **the copy** at `/srv/scenario:ro`.
- Teardown removes the container *and* the copy (`chmod -R u+rwX` first, since the copy can hold
  mode-000 directories) and fails the run on a leftover, exactly as it does for a container.
- Every hardcoded `/srv/scenario/...` in the integration suite is gone; the scope is the mount root and
  expectations come from the mounted scenario's own manifest (`expected_coverage`, declared evidence,
  the `extends:` chain).
- Guard tests: real `.git` directories, no `.git.fixture` left, and — only when `hostile` is mounted —
  both mode-000 directories are `0` and actually deny `brood`.
- A mode-000 directory is a recorded **barrier** in the blast-radius snapshot (`directory-unreadable`,
  mode included) instead of an exception.

## Decisions & deviations

- **A throwaway copy, not the checkout.** Running the materialiser in place would have mutated the
  working tree the developer was using. The copy also makes the blast-radius claim meaningful: the
  repository's tree is never the thing being pampered.
- **One scenario per mount.** `hostile` is `partial` by design once its unreadable directories exist;
  a whole-tree mount could not tell a planted fault from a broken scan.
- **`partial` is `partial-by-design` at the collector-contract level**, so its filesystem scan is
  legitimately `complete-within-scope` and `assess` returns `ok` with the declared gap in `undetected`.
  That corrected a first assumption that `partial` would report `partial`.
- **Teardown failures are leaks.** A leftover scenario copy fails the run like a leftover container.

## Known issues

- **Blast radius cannot see inside a mode-000 directory.** The barrier and its mode are compared; its
  contents are not hashable by a non-root harness. That is a property of the planted fault.
- **The CLI still cross-checked only the embedded manifest**, so an inherited declaration was not
  listed as declared. **Closed by S8**: `assess`/`report` now carry a `declarations` block naming an
  unresolved `extends:` parent (`docs/packet-schema.md`).

## Hand-off to next story

S8 closed the inherited-declaration seam this story left open. S9 (delivery recipe) closed the
delivery-side gaps the clean-room run found: the test image's uncommitted `sshd_config.test`, `down.sh`
removing `brood-test:local`, and the delivered machine mounting a checkout instead of a materialised
runtime copy.
