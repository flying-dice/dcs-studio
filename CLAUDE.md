# CLAUDE.md

Pointers, not prose. Everything here is the short form of a document that owns
the detail — follow the link before acting on a summary.

## Tests: four layers, run serially

| Layer | Tests | Coverage |
|---|---|---|
| Unit | `npm run test:unit` | `npm run coverage:unit` |
| Integration | `npm run test:integration` | `npm run coverage:integration` |
| E2E | `npm run test:e2e` | `npm run coverage:e2e` |
| Rust | `cd bridge && cargo test --workspace` | `node scripts/llvm-cov.mjs --workspace --fail-uncovered-lines 0 --fail-under-functions 100 --fail-under-regions 99.5` |

The three JavaScript layers gate 100% per file. **The Rust layer does not gate
regions at 100** — it gates uncovered lines at a count of zero, functions at
100%, and regions at 99.5%, and those flags are not defaults: the bare
`node scripts/llvm-cov.mjs --workspace` in the cell above measures without
gating anything. The 99.5 floor is deliberate and its reasoning lives in
`.github/workflows/ci.yml` beside the CI step; raise it when the number rises,
do not lower it.

Each layer gates against its own include set, and the sets are disjoint —
so **run them one at a time**. Concurrent runs share `coverage/**/.tmp` and
corrupt each other's shards, and a line covered by the wrong layer reports
green. Full guide: [docs/02-guides/01-running-the-tests.md](docs/02-guides/01-running-the-tests.md).

Three things that will otherwise cost you an afternoon:

- **Never `vitest run --coverage` at the repo root.** It silently discards every
  per-layer threshold. `vitest.config.ts` now refuses to load rather than let
  you; use the per-layer commands it names.
- **Never run two `cargo llvm-cov` at once** — they delete each other's test
  binaries and the survivor reports what looks like a flaky test. Go through
  `scripts/llvm-cov.mjs`, which locks. A second run fails immediately and tells
  you who holds it; `--target-dir` is the escape hatch.
- **One symlink test skips on an unprivileged Windows box.** `linkerStrategies`
  has a single case that genuinely needs SeCreateSymbolicLinkPrivilege
  (Developer Mode or elevation); it skips without it, and everything else uses
  junctions and hard links so it runs anyway — `test/support/linkCapability.ts`.
  Under `CI` a missing privilege throws instead, so this can never hide a real
  failure on the runner.

## Architecture

`src/core` is pure and gated per file; `extension.ts` is the sole composition
root. Read [ARCHITECTURE.md](ARCHITECTURE.md) before any structural change, and
`decisions/` for why a thing is the way it is.

## Where the machine facts live

DCS paths, the two bridge ports, deploying the DLLs, launching and driving a
live sim: `.claude/skills/dcs-dev/SKILL.md`. Do not re-derive any of it — that
skill is the source of truth for this box.

## Planning

`boards/` is a [RepoDoc](docs/02-guides/02-planning-with-repodoc.md) kanban.
Pick up and report progress on cards with the `repodoc-workflow` skill rather
than by editing the board freehand.
