# AGENTS.md — Brood

Operating contract for the **Brood** repository. Read this first. Product 2 of the private
`agentic-os` KB (`products.md` §1): the generalised, autonomous form of the continuity pattern,
built open source, simulated only.

## What this is

A disposable Debian 13 machine (`image/`) that an assistant connects to **over SSH**, learns, and is
asked to *pamper* — observe honestly, find drift, propose safe changes with revert paths, change
nothing that was not approved. The proof is `suite/` (the `broodctl` CLI + a Vitest suite); the world
is `fixtures/` (five dirty scenarios).

**Nothing here touches a real machine.** The container is the blast radius. Until the ten gates in
`brood-v0.md` pass, autonomy is a design goal, not a fact.

## Navigation

| Need | Read |
|------|------|
| What it is, how to run it | `README.md` |
| What verification actually found | `FINDINGS.md` — the defects and the honest limits |
| What is done / next | `roadmap/ROADMAP.md` — single source of truth for status |
| The design contract | `llm_profiles/agentic-os/` → `brood-v0.md`, `testing.md`, `products.md` |
| Why the offer exists | `delfin-flow-website` → `src/pages/ai-workflow.astro` |

## Non-negotiables (project invariants)

- **The machine must not look like a container.** No docker-specific paths, no compose-only
  assumptions, no container shortcuts inside the image.
- **Never `COPY` content.** The image declares the machine; fixtures arrive by bind mount. (The
  derived `suite/Dockerfile.test` may copy the *tool* and a *test credential* — it is never delivered.)
- **SSH is the boundary.** Key-only, unprivileged user `brood`, no password path.
- **Honest coverage.** `partial` / `unsupported` / `unknown` / `stale` are answers; a scan that missed
  something never reads as healthy. Every non-complete packet carries its reason.
- **Assertions on facts, not prose.** A test that passes only because a model said something plausible
  is a demo, not a test. Every automated test passes at T0 (no provider, no network, no spend).
- **The KB is the moat; this repo is public.** Nothing private may land here. Reference the methodology
  by name, never by path or content. If a change here teaches the KB something, it goes up to
  `agentic-os/` as seed enrichment — not copied in.

## Rules

- **One story at a time** (`roadmap/ROADMAP.md`); a story is done only when its acceptance is met and
  confirmed, never on assumption.
- **Provider-free by default.** `BROOD_PROVIDER=fake` unless a real one is deliberately selected with
  an explicit key.
- **No `sleep`-based synchronisation** — wait on conditions. Time is injected, runs are seeded.
- **Follows the workspace guidelines** *project structure* (four artifacts: README, AGENTS, roadmap,
  docs) and *ICM/MWP* (accept → process → hand off). Do not duplicate them here.
- Design decisions live in `docs/` when they grow past a story card; status lives in `roadmap/`.

## Validation

```sh
cd suite && npm install && npm test            # L0 + L1, free and offline
cd suite && npm run typecheck                  # tsc --noEmit
# integration layers need the derived test image — see README.md
```

Do not commit `suite/node_modules/`, `suite/cli/dist/`, or throwaway keys (`testkey.pub`,
`sshd_config.test`).
