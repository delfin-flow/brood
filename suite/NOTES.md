# Brood CLI and Vitest proof suite

## Choices and implementation boundaries

- **Runtime:** Node.js 24, npm, TypeScript, Vitest. `tsx` is pinned for manual/live TypeScript execution; the installed CLI is bundled with `esbuild` into one dependency-free Node ESM file. Direct dependency versions are exact in `package.json`; there is no global install.
- **CLI placement:** `cli/src/` is the source. Run `./install.sh /usr/local` from this project when preparing the part-1 image. It builds and installs `/usr/local/bin/broodctl` plus `/usr/local/lib/broodctl/broodctl.mjs`. Rebuild the image after installing. The integration harness expects that path by default; override with `BROOD_REMOTE_CLI` when needed.
- **Observation:** the only implemented deterministic collector is `filesystem` (`cli/src/collector.ts`). It recursively observes each requested scope, **records symlinks as facts and never follows them** (`kind: filesystem.symlink`, `target`, `target_exists`, `loop`; a link loop is `target_exists: false, loop: true`, a fact rather than an error), sorts paths, and records file SHA-256/size/mode, embedding `scenario.yaml` content (up to 1 MiB) so assessment can use the declared fault list. **A broken symlink does not degrade coverage** — a planted fault must never read as a scan failure. Coverage degrades only when an observation could not be made, and then the packet always carries the reason lists `errors` (attempt failed), `skipped` (deliberately not collected), `problems` (why the packet is incomplete); `validatePacket` refuses a non-complete label without a reason. A disabled collector (`BROOD_DISABLE_COLLECTORS=filesystem`) emits an explicit `unsupported` packet with its reason, not an empty successful scan; an absent scope is `unknown` with its reason; an over-size scenario manifest is `partial` and says which content was omitted. The contract is `docs/packet-schema.md`.
- **Canonical identity:** packet hashes cover canonical packet content but exclude `observed_at` and `canonical_hash`. This is deliberate: repeated scans of unchanged state have the same hash set while each packet still carries its own observation time. Findings carry evidence and packet provenance (`observed_at`, collector name/version, canonical hash).
- **Scenario manifest convention:** the parser accepts an explicit top-level `faults: [...]`, nested `scenario.faults: [...]`, or top-level `planted_faults: [...]`. Each list item must be an object. It reads `id`/`name`/`key`, `kind`/`type`/`check`, `description`/`title`, and optional `path`/`target`/`file`. A missing or malformed declaration fails loudly; it does not silently become zero findings. The part-2 fixture schema was not included in this brief, so compatibility with any other field names is **unmet** until verified against those fixtures.
- **Assessment:** findings are generated only from explicitly declared manifest entries. The fake provider is the default and is deterministic. Its operation script is supplied as JSON in `BROOD_FAKE_PROVIDER_SCRIPT`, keyed by `assess` or `propose`; supported modes are `malformed`, `timeout`, `refuse`, and `response`. Provider output is schema-checked and the assessed finding IDs must exactly equal the declared set. Malformed/refused/timed-out outputs become a non-zero command result with a JSON `status: "failed"`.
- **Real provider:** select it explicitly with `BROOD_PROVIDER=real`; it is never selected just because an API key happens to exist. The minimal adapter posts `{ operation, input }` JSON to `BROOD_PROVIDER_URL` with a Bearer `BROOD_PROVIDER_API_KEY`. A missing URL or credential fails loudly. This is a generic JSON adapter, not a vendor-specific API integration, and requires an endpoint implementing that contract.
- **Approval binding:** `broodctl approve --proposal <id>` is an explicit approval action and emits an HMAC-SHA256 token. `BROOD_APPROVAL_SECRET` is mandatory and never shipped in this archive. The token binds proposal id, argument hash, and expiry. `apply` re-computes the stored argument hash, checks expiry/signature, checks the target's precondition hash, and refuses altered `--arguments-json`.
- **Mutation boundary:** only an explicit `write-file` remediation is executable. It must be under `BROOD_MUTABLE_ROOT`, its parent must already exist, and symlinks are refused. `apply` stores a receipt and prior bytes; `verify` independently checks the applied hash; `revert --receipt <id>` restores the exact prior bytes or removes a newly created file. Other remediation types produce a manual proposal and fail loudly if an operator tries to apply them. State is kept in `BROOD_STATE_DIR`; protect this directory because proposal/receipt records contain reversible file content.
- **Report:** `report` accepts `{ packets, findings }` on stdin and returns a JSON object containing both the Markdown report and structured JSON. `--markdown-out <path>` additionally writes the Markdown artifact.
- **Container lifecycle:** integration tests start a fresh part-1 image with Docker, mount the supplied part-2 fixture tree at `/srv/scenario:ro`, wait for an actual successful SSH command on `127.0.0.1:2222`, and remove the container in `afterAll`. The harness's provisioned state (`BROOD_STATE_DIR`, `BROOD_MUTABLE_ROOT`, `BROOD_APPROVAL_SECRET`) is passed on **every** remote CLI call: `docker run --env` reaches PID 1 only, and an SSH session gets a fresh environment, so a container env alone would leave `propose`/`apply` refusing to run. Setup failures trigger immediate cleanup. Teardown verifies that `docker inspect` can no longer find the container; a leak fails the run. Readiness polling has a short retry interval, but completion is gated on the real SSH readiness condition, not an elapsed delay.
- **Blast radius:** the fixture tree is mounted read-only, and the suite also snapshots relative paths, file hashes, symlink targets, and modes before and after. Reversible-change tests operate only in a separate `/tmp` mutable root.

## Exact commands

Use Node 24 and npm 10 or newer. Install dependencies once in an environment with the pinned packages available; after installation, L0/L1 do not access the network or Docker.

```sh
node --version
npm --version
npm install --no-audit --no-fund
npm run build
```

The CLI can then be placed in the part-1 image (run this during image preparation, then rebuild the image):

```sh
./install.sh /usr/local
# equivalent entry point: ./cli/install.sh /usr/local
```

L0 and L1 are independently runnable and require no container:

```sh
npx vitest run tests/l0
npx vitest run tests/l1
npm test
```

Each live layer is independently runnable. The environment variables must point at the existing part-1 image, part-2 fixture tree, and private SSH key whose public key is authorised for user `brood` in the image:

```sh
export BROOD_IMAGE='your-part-1-image:tag'
export BROOD_SCENARIO_DIR='/absolute/path/to/part-2/fixtures'
export BROOD_SSH_KEY="$HOME/.ssh/id_ed25519"

npx vitest run tests/integration --testNamePattern='L2' --maxWorkers=1
npx vitest run tests/integration --testNamePattern='L3' --maxWorkers=1
npx vitest run tests/integration --testNamePattern='L4' --maxWorkers=1
npx vitest run tests/integration --testNamePattern='blast radius' --maxWorkers=1
npm run test:int
```

The equivalent scripts are `npm run test:l2`, `test:l3`, `test:l4`, and `test:blast`. The integration harness reserves host port 2222 and will fail if that port is already occupied. It removes the container it created, even if an assertion fails.

The live-provider suite is manual only. It requires an endpoint implementing the generic provider contract:

```sh
BROOD_PROVIDER_API_KEY='...' BROOD_PROVIDER_URL='https://provider.example/contract' npm run test:live
```

## Stubs and explicit refusals

- There is no Dockerfile, scenario fixture content, GUI, service manager, package manager, shell remediation, or model-quality scoring in this part.
- Non-filesystem collectors are not implemented. A disabled filesystem collector reports `unsupported`; unknown collector/command paths do not report success.
- The executable remediation set is deliberately limited to reversible file writes inside the configured mutable root. All other change types remain manual and `apply` returns `not implemented`.
- The real provider adapter requires the endpoint contract above. It does not guess a provider URL or silently fall back to fake output.
- `approve` and `revert` are small supporting commands added because the specified six-command interface otherwise has no safe way to create an explicit approval token or exercise a revert path.

## Unmet

- **L0 and L1 runtime pass status: not verified in this build environment.** The available runtime is Node 22.16.0, not the required Node 24, and the local npm dependency installation did not complete. TypeScript source was structurally type-checked with the available TypeScript 5.8.3 compiler and local declaration shims, but this is not a substitute for executing Vitest. Once the pinned packages are installed, `npm test` is expected to run without Docker or network; that claim remains unverified here.
- **L2, L3, L4 and blast-radius pass status: not verified.** Docker is not installed in the build environment. The part-1 image, its SSH-authorised key, and the part-2 fixture tree were assumed by the brief but were not supplied to this build session. The harness is implemented, but no claim is made that it passes against those external artifacts.
- **Fixture-schema compatibility: not verified.** The uploaded brief did not include the part-2 `scenario.yaml` examples. The supported forms are documented above. If the actual fixtures use another schema, L3 will fail loudly rather than silently treating the fault list as empty; update the parser to the actual declared schema before treating acceptance as proven.
- **Real-provider behaviour: not verified against a live endpoint.** It is a generic JSON adapter only. No provider credentials or endpoint were supplied, and no live call was made.
