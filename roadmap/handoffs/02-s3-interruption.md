# S3 — the L4 interruption test

Reconstructed 2026-11-14 from commit `665e42b` and `FINDINGS.md` § "Defect 3"; not written at delivery
time.

## Delivered

- L4 runs **end to end** over SSH: interrupt `observe` at its failpoint, reject an expired approval,
  reject altered arguments, apply, verify, revert, and observe again with a collector removed.
- The failpoint holds the process with a ref'd keep-alive timer (cleared in `finally`) and fails loudly
  (`status: failed`, exit 2) when it is signalled.
- `suite/tests/l0/failpoint.test.ts` guards the behaviour **without Docker**: it spawns the CLI, waits
  for the marker, asserts the process is still alive, sends `SIGTERM`, and expects the JSON failure.
- `FINDINGS.md` records the corrected diagnosis and the honest limit (below).

## Decisions & deviations

- **The recorded diagnosis was wrong, and correcting it was the deliverable.** The story said the pid
  came from a `ps` parse and the signal crossed an SSH session. Measured: the marker pid is correct and
  `kill` reaches it — the process was already gone. A signal listener does not keep Node's event loop
  alive, so the pause exited **13** ("unsettled top-level await") the instant it wrote the marker:

  ```sh
  node -e 'await new Promise((r) => process.once("SIGTERM", () => r()));' ; echo $?   # 13, immediately
  ```

  The keeper timer is the fix; the kill helper was never the defect.
- **No journal was invented.** The story spoke of an "interrupted observe leaving a recoverable
  journal". There is none, and none was added: recovery is re-observation.
- The S4 parser work (see `03-s4-manifest-parser.md`) shares commit `665e42b` because both changes
  touched the same parse path and were verified together.

## Known issues

- **There is no recoverable journal.** What L4 proves is that an interrupted step leaves no partial
  state and that the next observation converges; the recovered packet set hashes identically to the
  pre-interruption set. Nothing more is claimed.
- Interruption is exercised through the failpoint, not by killing a real long-running collector — the
  only collector is fast by design.

## Hand-off to next story

S2's detector work had to keep `observe` interruption-safe: the failpoint lives in the observe path, and
its offline test must stay green whenever that path changes.
