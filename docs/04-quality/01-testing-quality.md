# Testing & quality: the current state

What the gates are, what they cover, and the rules that hold them honest. This
page is the **state of the tree**, not a how-to and not a rationale:

- **How to run them** — [Running the tests](../02-guides/01-running-the-tests.md).
- **Why four disjoint layers** —
  [decision 05](../../decisions/05-four-disjoint-test-layers-each-at-100.md);
  the specification lives in the "Testing & coverage" section of
  [ARCHITECTURE.md](../../ARCHITECTURE.md).
- **How it got here** —
  [the July 2026 audit and its remediation trail](02-testing-audit-2026-07.md),
  a historical record whose measurements are period artifacts.

Those three own the detail. Nothing here is repeated from them, because the one
lesson the sprint paid for twice was that a table copied into a fourth place
drifts in three of them.

## The four gates

Each layer runs on its own command and gates coverage over an include set that
does not overlap the others', so a gap in one can never be masked by another
layer happening to execute the same line.

| Layer | Gates coverage of | Threshold |
|---|---|---|
| Unit | `src/core/**`, `media/*-core.js` | 100% per file — statements, branches, functions, lines |
| Integration | `src/**` minus the hexagon | 100% per file — same four |
| E2E | `media/*.js` minus `*-core.js`, in real Chromium | 100% per file |
| Rust | the `bridge/` workspace | **uncovered lines = 0**, functions 100%, regions ≥ 99.5% |

The Rust row is the one that does not read like the others, and deliberately:

- Its line gate is a **count, not a percentage**. `--fail-under-lines 100` reads
  the percentage off `llvm-cov report`'s own table, which counts a function
  record's whole span — blank lines, comments, braces — and reports missed lines
  that no other view agrees exist. `--fail-uncovered-lines 0` counts actual
  uncovered lines instead, and that number is zero.
- **Regions floor at 99.5, not 100.** Regions split on panic edges the compiler
  inserts, which cannot all be driven from a test. The reasoning is written
  beside the CI step in `.github/workflows/ci.yml`. Raise the floor when the
  number rises; do not lower it.
- **`cargo llvm-cov` is never invoked directly.** `scripts/llvm-cov.mjs` takes an
  exclusive lock on the target directory it is about to build into, because two
  concurrent runs delete each other's test binaries and the survivor reports what
  looks exactly like a flaky test. CI goes through the script too, so CI and a
  developer's box run the identical command. A second run fails immediately and
  names the holding pid; `--target-dir` is the escape hatch.

The root `vitest.config.ts` is a `projects` config for IDE convenience and
**refuses to load when coverage is requested** — vitest treats `coverage` as a
root-only option, so a root `--coverage` run silently discards every per-layer
threshold. That refusal is the enforcement of the serial-runs rule; the rest of
it (disjoint include sets, shared `coverage/**/.tmp`) is in the guide.

## Where the numbers stand

Measured on this tree, each layer run on its own — `main`-line `develop`,
extension v0.16.0.

| Layer | Tests | Result |
|---|---|---|
| Unit | 1,429 over 53 files | 100% (2,078 stmts / 1,214 branches / 488 funcs / 1,799 lines) |
| Integration | 917 passed, 2 skipped, over 51 files | 100% (2,068 / 752 / 622 / 1,885) |
| E2E | 266 | 100% across all 14 webview scripts |
| Rust bridge | `node scripts/llvm-cov.mjs --workspace` | gate as above; enforced every push by the `rust` CI job |

The two skips are host-capability skips, not gaps, and both are visible in the
reporter with the reason attached:

- **One symlink case.** `test/support/linkCapability.ts` probes for
  `SeCreateSymbolicLinkPrivilege` by trying it once. The single test that is
  genuinely *about* creating a symlink skips without it; everything else uses
  junctions and hard links, which need no privilege, so the rest of the suite
  runs on an ordinary unprivileged Windows box. **Under `CI` a missing privilege
  throws instead** — `windows-latest` runs elevated and does hold it, so a
  missing privilege there means the runner image changed, and skipping would
  hide that.
- **One tailer case** that only means anything off Windows.

Rerunning the three JavaScript layers needs no DCS, no display and no VS Code
instance. Two host facts are worth knowing before reading a local failure as a
regression:

- The integration layer wants `npm run compile` first — the packaging test reads
  the real `out/` to prove nothing in it has lost its source file, and without a
  build it fails on a missing directory.
- The Rust tests create real Lua states, so they need a Lua to link against. On
  Windows that is DCS's own `lua.dll` (`<DCS>\bin` on `PATH`); without it the
  test binary dies with `STATUS_DLL_NOT_FOUND` before running anything. On Linux
  `build.rs` links Debian's PUC `liblua5.1-0-dev`, which is what CI installs.

## What is covered, and what that is worth

Every panel, presenter, adapter and the `extension.ts` composition root are
inside a gate. So is `activate()` — it is really called, and every handler
driven. The `vscode` module is a shared test double
(`test/integration/support/vscode.ts`): a small real implementation, not a bag
of spies, which is why its own bugs were findable.

**All eleven webviews** have a presenter and a declared message contract in
`src/core/app/webviewContract.ts` — typed `HostMessage`/`WebviewMessage` unions
checked from three directions: the compiler (an undeclared push does not build),
the unit layer (every declared inbound message is asserted to be acted on, every
declared outbound to be produced), and the e2e layer (the real `media/*.js` is
driven in Chromium and the set it posts and consumes is asserted equal to the
declaration). `UNCOVERED_WEBVIEWS` is **empty**, which is what makes the census
in `test/integration/webview/webviewContract.test.ts` a total assertion: the
declared set equals the `previews/` directory, so a twelfth webview fails the
suite until someone either declares it or says out loud that it is not declared.

Three structural checks sit alongside the coverage gates and answer questions a
percentage cannot:

- `test/integration/architecture/boundaries.test.ts` walks `src/core` and fails
  on any forbidden import.
- `test/integration/webview/previewAssets.test.ts` asserts the preview file list.
  This is the one gap a coverage gate structurally cannot see: a script added to
  a panel but not to its preview page is never executed, never measured, and the
  100%-per-file gate still reports green.
- `test/integration/architecture/packaging.test.ts` checks the compiled output
  against its sources.

**Coverage says a line ran. It never says a test would notice it being wrong.**
`npm run mutate` answers the second question: a table of ten deliberate
breakages, each paired with the gate that must go red, applied as exact string
replacements with the file restored from a copy aside. Every gate is checked
green first (a red baseline is an `ERROR`, never a kill), a `find` that stopped
matching is a loud `ROTTED` rather than a silent pass, and the restore never
reaches for git. It is **not** in CI's per-push path by design — it edits tracked
files and runs a gate per mutation. Run it after refactoring any gated area:
contract tables, panel lifecycle, presenters, bridge teardown, embedded Lua.

## Standing rules

- **Run the gates serially**, one layer at a time.
- **Coverage-ignore comments are forbidden**, except for provably unreachable
  defensive lines carrying a justification comment. Prefer restructuring so the
  line is reachable.
- **A port with more than one implementation carries a shared contract suite**
  under `test/support/`, run against each one. `MarketplacePort` and
  `FileSystemPort` are the worked examples. A core service must not be able to
  pass against a fake more permissive than the adapter it stands in for.
- **The domain layer resolves paths with explicit Windows semantics**
  (`import { win32 as path }`) regardless of host, because DCS is Windows-only
  and bare `node:path` changes shape with the developer's OS. Code handing a
  path straight to a real `node:fs` syscall keeps native paths.
- **Typecheck the tests too.** `tsc -p ./` covers `src/` only; vitest and
  Playwright transpile through esbuild and Biome does not typecheck, so
  `npm run typecheck:tests` (`tsconfig.test.json`) is the only thing that
  notices a test double drifting from the API it doubles.

## CI

Six jobs, one per layer plus two: `static` (compile, `typecheck:tests`, Biome
check), `unit`, `integration`, `e2e`, `rust` (which also runs `cargo audit`),
and `windows` — the shipping target, re-running the headless layers, `cargo fmt`,
clippy under the workspace's pedantic panic-restriction policy, and the release
build of both bridge DLLs.

The panic-restriction lints are not style. The DLLs load **in-process inside a
running flight sim**, where a panic takes the user's sim with it, and CI is the
only thing that runs them.

## The one thing still unmeasured: Lua

About 2,050 in-sim Lua lines are **loaded and executed** by the Rust tests, but
`cargo llvm-cov` measures Rust regions and a Lua chunk is opaque to it — so
"this branch is covered" is a claim there, not a measurement, and a branch that
stopped being reached would fail nothing.

A working line-coverage prototype is in-tree
(`bridge/crates/bridge-core/tests/support/`, inert unless `LUA_COV_DIR` is set).
It deliberately added **no fifth gate**: only a handful of the suite's Lua states
are instrumentable at all — the shim needs `debug`, which mlua's `Lua::new()`
omits — so a threshold over the resulting ~12% would gate a number that mostly
cannot move, which is the same false-green shape these gates exist to prevent.
Recorded in
[decision 07](../../decisions/07-no-lua-coverage-gate-yet.md) and on issue #66.
