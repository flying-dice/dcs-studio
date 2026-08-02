---
status: Accepted
date: 2026-07-26
---
# Decision 05 — Four test layers with disjoint include sets, each gated at 100%

## Context

The testing audit found the suite was an hourglass, not a pyramid: a strong pure
core, a strong DOM-level UI layer, and almost nothing verifying the band between
them. Coverage was scoped to `src/core/**` and one `media/*-core.js`, so
everything else was not merely uncovered but **unmeasured** — no gate could
regress and nobody would see it drift
(`docs/04-quality/02-testing-audit-2026-07.md:62-79`).

Two more findings shaped the answer. The Rust bridge's tests never ran in CI at
all. And one coverage run over everything would have hidden the real problem:
a line executed by the wrong layer reports green.

Dated from `dcd419a`, the merge that landed the four layers.

## Decision

Four layers, each with its own command, its own config, and an include set that
**does not overlap the others'**:

| Layer | Command | Gates |
|---|---|---|
| Unit | `npm run coverage:unit` | `src/core/**`, `media/*-core.js` |
| Integration | `npm run coverage:integration` | `src/**` minus the hexagon |
| E2E | `npm run coverage:e2e` | `media/*.js` in real Chromium |
| Rust | `cargo llvm-cov --workspace` | the bridge workspace |

The three vitest/Playwright layers gate at **100% per file**. Rust gates lines and
functions at 100 and regions at 99.5 — a floor that is measured rather than
aspirational, because regions split on panic edges the compiler inserts.

`.github/workflows/ci.yml` runs one job per layer plus a Windows job that re-runs
the headless layers on the shipping OS, and `release.yml` *calls* that workflow
so a release cannot publish past a red pipeline.

Two operational rules ride along, both in `ARCHITECTURE.md:133-147`: run the
gates serially, and never run two `cargo llvm-cov` invocations at once.

## Consequences

- A gap in one layer can never be masked by another layer happening to execute
  the same line. This is what made everything else measurable.
- 2,022 tests, up from 905 — and the work found eleven defects, none of which a
  coverage percentage would have revealed on its own
  (`docs/04-quality/02-testing-audit-2026-07.md:322-357`).
- `vitest run --coverage` at the repo root is actively wrong: the root config is a
  `projects` config and vitest treats `coverage` as root-only, so every per-layer
  threshold is silently ignored. Use the per-layer commands.
- 100% per file is a hard constraint on new code, not a target. Adding a file
  means covering it in the right layer or the build goes red at 0%.
- Coverage-ignore comments are forbidden except for provably unreachable
  defensive lines, each with a justification.
- A coverage gate is only ever as complete as the file list it was given — a
  script added to a panel but not to its preview page is never executed, never
  measured, and still green. `test/integration/webview/previewAssets.test.ts`
  asserts that list.
- Lua is outside all four gates: ~2,050 in-sim lines execute under the Rust tests
  but nothing measures them. Tracked as #66.
