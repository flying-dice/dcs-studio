# Testing pyramid audit

Audit of the test suite and the structural seams that make code testable, taken
against `main` @ `8c45b98` (v0.16.0). Measurements are reproducible — every
number below came from running the suites, not from reading them.

> **Status note.** The findings below are the original audit and are kept as the
> record. Work against them is under way — see
> [Remediation status](#remediation-status) at the end for what has landed, the
> current measured numbers per layer, and what is still outstanding.

## Verdict

The core hexagon is genuinely well tested — not coverage theatre. Mutation
probes against `src/core/**` were all killed decisively. The problem is not
depth in the middle; it is **reach**. Three things are true at once:

1. **62% of shipped lines (9,884 of 16,048) have no test that imports them.**
2. **The Rust bridge's tests never execute in CI** — they pass in seconds on
   Linux, but CI is Windows-only and runs `cargo build`, never `cargo test`.
3. **The two well-tested layers do not meet.** Webview scripts are tested
   against a stub host; panels are not tested at all. Nothing verifies that the
   two halves of the message protocol agree.

The shape is less a pyramid than an hourglass: a strong pure core, a strong
DOM-level UI layer, and almost nothing verifying the band between them — the
panels, adapters, and process boundaries where the product actually integrates.

## The pyramid as it stands

| Layer | Tests | Runs in CI | What it actually proves |
|---|---|---|---|
| TS unit — `src/core/**` | 790 (40 files) | ✅ + 100% per-file gate | Domain rules and app services are correct |
| Webview UI (Playwright) | 91 (9 specs) | ✅ | `media/*.js` renders and posts correct messages **to a stub host** |
| Rust bridge unit | 24 (+4 regeneration-only) | ❌ **never runs** | Nothing, in CI |
| Port ↔ adapter contract | 1 partial (`productInvariants`) | ✅ | Marketplace backends are interchangeable |
| Extension-host integration | 0 | — | Nothing — activation is never exercised |
| Panels / message handlers | 0 | — | Nothing |

Local runs used for this audit:

- `npx vitest run` → 784 pass, 6 fail (host-platform artifacts, see G8)
- `npx playwright test` → 91 pass (with the environment's Chromium)
- `cargo test --workspace` on Linux → **24 pass in ~0.2s** after
  `apt-get install liblua5.1-0-dev`

## Evidence: the core suite is strong

Three mutations introduced into `src/core/**`, each reverted after measuring
(baseline is 6 pre-existing platform failures):

| Mutation | Tests failed |
|---|---|
| `linkStrategy`: swap `hardlink` ↔ `symlink-cross` | 8 |
| `subscriptions`: drop repo-key `.toLowerCase()` | 27 |
| `wsFraming`: off-by-one on the length marker | 10 |

All killed, several redundantly. The 100% gate on `src/core` is backed by real
assertions. **The recommendation is therefore not "test the core harder" — it
is "extend this rigour outward".**

## Coverage reach, measured

`vitest.config.ts` scopes coverage to `src/core/**` and `media/explorer-core.js`.
Everything else is not merely uncovered — it is **unmeasured**, so no gate can
regress and nobody sees it drift.

| Area | Files | LOC | Files with a test |
|---|---|---|---|
| `src/core/{domain,app,ports}` | 47 | 4,742 | 45 |
| `media/` (webview JS) | 16 | 4,699 | 1 unit (+13 via e2e) |
| Panels (`src/{marketplace,install,bridge,setup,publish,skills,project,log,manifest,mission,nav,docs}`) | 15 | 2,382 | **0** |
| `src/adapters/{node,vscode,github}` | 16 | 1,344 | 3 |
| `src/debug` | 2 | 625 | **0** |
| `src/extension.ts` + root | 3 | 546 | **0** |

`ARCHITECTURE.md` justifies excluding adapters as "thin, I/O-bound". That was
true when written; it has drifted. `wsTransport.ts` (172), `sevenZip.ts` (158),
`gh.ts` (133) and every panel are neither thin nor purely I/O.

## Gaps, ranked by risk

### G1 — The Rust bridge is never tested in CI *(highest value, lowest effort)*

`ci.yml` runs `fmt`, `clippy` and `cargo build --release`. There is no
`cargo test`. Its comment says the tests need DCS's non-redistributable
`lua.dll`, but that comment is **stale**: `bridge-core/build.rs` already links
Debian's PUC liblua5.1 on non-Windows precisely so "Linux CI runs them
ordinarily (issue #28)". The build.rs fix landed; the CI job never followed.

Verified in this session: with `liblua5.1-0-dev` installed, the whole workspace
suite passes on Linux in well under a second. This is ~15 lines of YAML for
5,411 lines of code that runs **in-process inside DCS, where a panic crashes the
user's sim** — which is exactly why the workspace already denies `unwrap_used`
and `expect_used`.

### G2 — The sandbox-escape guard has no tests

`bridge-core/src/path_guard.rs` (`stays_under`) is the containment check for
file and SQLite writes exposed over the bridge's local HTTP JSON-RPC API. It is
a pure 33-line function, security-relevant, and has **zero tests** — while
`luadef.rs` (a codegen helper) has seven. Table-driven cases for `..`, absolute
paths, drive prefixes, UNC paths and empty segments cost minutes.

Rust modules with no tests at all, by size:

| Module | LOC | Notes |
|---|---|---|
| `jsonrpc/server.rs` | 686 | request lifecycle, WS framing, timeouts |
| `facade.rs` | 324 | the whole method surface |
| `sqlite.rs` | 249 | writes to disk |
| `file.rs` | 187 | writes to disk |
| `path_guard.rs` | 33 | **security guard** |

### G3 — The webview ↔ panel seam is unverified

Both halves are tested, against different fictions:

- Playwright asserts `media/marketplace.js` posts `{type:"install", repo}` to a
  **stub** host (`previews/harness.js`).
- Nothing asserts `src/marketplace/panel.ts` *handles* `"install"`.

Rename a message type on one side and every test still passes. A structural
diff of all 11 webview/panel pairs found no live mismatch today — the contract
is currently correct — but it is held together by discipline alone, and the
`installProgress`/`installError` push messages are exactly the kind of detail
that drifts silently.

### G4 — Three webviews have no harness at all

`previews/` covers 8 of 11 webviews. Missing: **`publish.js` (196), `setup.js`
(183), `newproject.js` (217)** — 596 lines with neither unit nor e2e coverage.
The selection is unfortunate: **Publish performs irreversible GitHub operations**
(repo creation, tag push, release delete with `--cleanup-tag`), and **Setup gates
every other feature** — a broken path-detection UI makes the product look
dead on first run. These are the two flows where a silent regression is most
expensive and least likely to be noticed by the developer, who already has a
working setup.

### G5 — Panels are ~90% logic and 0% tested

Measured VS Code API density (lines containing `vscode.` ÷ total):

| File | LOC | `vscode.` refs | Coupling |
|---|---|---|---|
| `debug/adapter.ts` | 512 | 7 | **1%** |
| `marketplace/panel.ts` | 255 | 16 | 6% |
| `install/myModsPanel.ts` | 305 | 21 | 6% |
| `bridge/consolePanel.ts` | 309 | 22 | 7% |
| `publish/publishPanel.ts` | 134 | 11 | 8% |

Panels are classified as adapters, so the coverage gate excludes them — but
86–99% of their content is decision logic: state transitions, guard conditions
(`if (!product.release_tag)`), error→message mapping, cache lookups
(`products.get(repo.toLowerCase())`). That logic is untestable today only
because it is welded to a thin `vscode` shell.

`debug/adapter.ts` is the extreme case: 512 lines of session state machine
(polling loop, breakpoint map, sequence numbering, lifecycle) with 1% VS Code
coupling and no tests. Its *pure* decisions were correctly extracted to
`core/domain/dapTranslation.ts` (49 tests) — the orchestration that calls them
was left behind.

`test/bridge/client.test.ts` already proves the way out: `vi.mock("vscode")`
plus an injected fake transport, 21 tests against a stateful shell. It is the
only test in the repo that does this.

### G6 — External-CLI argument construction is untested

`gh` and `7z` argv arrays are built inline inside adapters:

```ts
["release", "delete", tag, "-R", repo, "--yes", "--cleanup-tag"]
["a", "-t7z", "-mx=5", "-y", `-v${limit}b`, archive, ...files]
```

A wrong flag here deletes a tag users depend on or produces unopenable split
archives, and nothing catches it before a real publish. These are pure string
functions wearing an I/O costume.

### G7 — Six tests can only pass on Windows

`src/core/domain/{linkStrategy,dapTranslation,dcsDetect,bridgeDeploy,projectForm,scaffoldPlan}.ts`
and the `core/app` services import bare `node:path`, so their behaviour changes
with the host OS. On Linux, `parse("C:\\a").root` is `""`, so
`sameVolume("C:\\a","D:\\b")` wrongly returns `true`.

`core/domain/entrypointLaunch.ts:11` already documents the correct fix and uses
`path.win32` "regardless of the host the tests run on — deterministic". Applying
that consistently makes the domain layer honestly pure, and is a **prerequisite
for G1**: a Linux CI job is much more attractive once `npm test` is green there
too.

### G8 — No extension-host integration test

Nothing ever activates the extension. `extension.ts` (435 lines) wires ~29
commands, 8 config keys and 11 panels; a wiring mistake surfaces only as a user
seeing "command not found". A generated check of `package.json` command
declarations against `registerCommand` calls found **0 mismatches today** — so
this is a regression guard, not a bug hunt, and it is a dozen lines of Vitest
that needs no VS Code at all.

## Structural changes for isolation

Each one converts an untestable region into a testable one; the test coverage
follows for free rather than being bolted on.

### S1 — A presenter layer (unlocks G3, G5)

Introduce `src/core/app/presenters/` (or `core/ui/`) holding pure functions:

```ts
(state, incomingMessage) => { state, outgoing: HostMessage[], effects: Effect[] }
```

Panels shrink to: own the `vscode.WebviewPanel`, pump messages into the
presenter, execute returned effects. The 86–99% that is logic moves under the
existing 100% gate; the ~10% that genuinely touches VS Code stays excluded and
is small enough that exclusion is honest again.

This also gives G3 its fix for free: with a typed `HostMessage`/`WebviewMessage`
union shared by presenter and `media/*.js`, one table-driven test can assert
every message type the webview emits is handled and vice versa — the seam stops
depending on discipline.

### S2 — A scheduler/timer port

`debug/adapter.ts` and `bridge/client.ts` both hold `setInterval` handles.
A `SchedulerPort` (`setInterval`/`setTimeout`/`clearInterval`) alongside the
existing `ClockPort` makes poll loops, backoff and the 30-second breakpoint
auto-continue deterministically testable instead of timing-dependent. The
auto-continue in particular is a safety mechanism — if it regresses, a crashed
editor freezes the user's sim, and today nothing tests it.

### S3 — Extract argv builders to `core/domain/cli/` (fixes G6)

Move `gh`/`7z`/`git` argument construction into pure `buildGhReleaseArgs(...)`
style functions. Adapters keep only `spawn`. Destructive flags land under the
100% gate; adapters become genuinely thin, as `ARCHITECTURE.md` claims.

### S4 — Split a Lua-free `bridge-protocol` crate (deepens G1)

Only 4 of 22 `bridge-core` modules avoid `mlua`. Everything — the JSON-RPC
server, router, protocol — is entangled with the Lua runtime, so testing any of
it requires a linked Lua. Extracting the pure protocol/router/framing layer into
a crate with no `mlua` dependency makes the highest-traffic logic testable
anywhere, with no system package and no linkage tricks.

### S5 — Generalise the port contract test (extends the `productInvariants` pattern)

`test/marketplace/contract.ts` is the right idea, applied once. Every port with
more than one implementation — or with a fake used by core tests — should have a
shared contract suite run against *both* the real adapter and the fake.
Otherwise core tests prove only that services work against fakes that may have
drifted from the adapters they stand in for. `FileSystemPort` and
`BridgeTransportPort` are the two that matter most.

## Prioritised plan

| # | Action | Effort | Confidence gained |
|---|---|---|---|
| 1 | Add a Linux `cargo test --workspace` CI job (G1) | ~15 min | **High** — 24 tests over 5.4k in-sim lines go from never-run to gating |
| 2 | Table-driven tests for `stays_under` (G2) | ~30 min | **High** — security guard, pure function |
| 3 | `path.win32` sweep across `core/**` (G7) | ~1 h | Medium + unblocks a Linux `npm test` job |
| 4 | `package.json` ↔ `registerCommand` contract test (G8) | ~30 min | Medium — cheap regression guard on wiring |
| 5 | Extract argv builders to `core/domain/cli/` (S3, G6) | ~2 h | **High** — irreversible operations, currently unguarded |
| 6 | `previews/` harnesses for publish + setup (G4) | ~3 h | **High** — riskiest and most first-impression-critical flows |
| 7 | Presenter extraction, one panel as a pilot (S1) | ~4 h | **High** — proves the pattern; marketplace or publish is the right pilot |
| 8 | Shared `test/support/vscode.ts` double + panel tests (G5) | ~1 day | High, compounding |
| 9 | `SchedulerPort` + `debug/adapter.ts` session tests (S2, G5) | ~2 days | **High** — largest untested unit in the repo |
| 10 | `bridge-protocol` crate split (S4) | ~2 days | Medium-high — structural, pays back over time |

Items 1–4 are half a day together and are pure profit. Items 5–7 are where the
confidence curve bends. Items 8–10 are the structural investment that makes the
untested band permanently testable rather than perpetually excluded.

## Note on the two suites' health

- The 6 Vitest failures on non-Windows hosts are G7, not regressions; CI is
  Windows and is green.
- `tests/console.spec.ts` asserts `errors.length === 0` over *all* console
  output, which makes it sensitive to browser-chrome noise unrelated to the app
  (a full Chrome build fails it on the `/favicon.ico` 404 that CI's
  headless-shell never requests). Filtering favicon/network noise from the
  collected errors would make the assertion portable.

---

# Remediation status

Measured after the work described below. Each layer now runs on its own command
against its own config, and gates its own coverage over an include set that does
not overlap the others'.

| Layer | Command | Tests | Coverage | Gate |
|---|---|---|---|---|
| Unit | `npm run test:unit` | 806 | **100%** stmts/branch/funcs/lines | ✅ green |
| Integration | `npm run test:integration` | 288 | 35.3% stmts / 35.6% lines | ❌ red — work outstanding |
| E2E | `npm run test:e2e` | 91 | 80.8% stmts of `media/*.js` | ❌ red — work outstanding |
| Rust | `cargo llvm-cov --workspace` | 33 | 77.3% lines / 66.9% functions | ❌ red — work outstanding |

Modules at 100% in the integration layer: `adapters/github/marketplace.ts`,
`adapters/node/{fs,clock,env,registry}.ts`, `adapters/vscode/{installRoots,manifest}.ts`,
`bridge/paths.ts`, `install/dataDir.ts`, `webview/html.ts`, `errors.ts`,
`marketplace/panel.ts`, `nav/navView.ts`, `docs/docsPanel.ts`,
`skills/skillsPanel.ts`, `publish/{publishPanel,preflight}.ts`,
`setup/panel.ts`, `manifest/formPanel.ts`, `project/newProjectPanel.ts`.

Remaining integration areas, by size: `src/debug` (0%, 625 lines),
`src/install` (2.8% — myModsPanel + shortcut), `src/mission` (0%),
`src/bridge` (25% — consolePanel, deploy, launch, dbExport, build),
`src/adapters/node` (25% — gh, git, sevenZip, downloader, wsTransport,
processLauncher), `src/log` (47% — logPanel), `src/skills` (48% — library),
`src/project` (56% — scaffold), `src/extension.ts` (0%).

`npm test` runs all three TypeScript layers in sequence; `npm run coverage` does
the same with each gate enforced.

## Landed

- **G7 — host-dependent path logic.** `core/**` now resolves with explicit
  `path.win32` semantics on every host, so the domain layer is deterministic
  off-Windows. This is what allows the TypeScript layers to gate on Linux CI.
- **Three separately-runnable layers.** `vitest.unit.config.ts`,
  `vitest.integration.config.ts` and the Playwright config each own a disjoint
  include set and an independent 100% per-file threshold. The e2e layer had no
  coverage story at all; `scripts/e2e-coverage.mjs` now collects V8 coverage
  through a Playwright fixture, merges it into one Istanbul map, and gates it.
  A webview that never loads reports 0% rather than the empty-map 100% that
  `v8-to-istanbul` yields by default — without that, a view with no harness
  passes the gate silently, which is the exact gap G4 describes.
- **G1 — Rust tests never ran in CI.** CI is now one job per layer, including a
  Linux `cargo llvm-cov` job. The stale claim that the tests need DCS's
  non-redistributable `lua.dll` is gone: `build.rs` already links PUC
  liblua5.1 off-Windows, so they run as ordinary executables.
- **G2 — the write-root guard.** `path_guard` went from no tests to 100% lines
  and functions, and the guard itself was rewritten. It delegated to
  `std::path::Component`, whose parsing follows the compilation target, so
  drive-prefixed and backslash-climbing input was accepted off-Windows. The
  rules are now explicit and host-independent, and additionally reject NTFS
  alternate-data-stream writes (`notes.txt:hidden`) that the old guard passed
  even on Windows.
- **G6 — CLI argument construction.** `gh`/`git`/7-Zip argv now lives in
  `core/domain/cliArgs.ts` under the unit gate, asserted whole rather than by
  substring. The adapters keep only the spawn call and its error mapping.
- **G8 — contribution wiring.** A static contract test asserts every
  `package.json` command has a `registerCommand`, every menu entry points at a
  declared command, no id is registered twice, and every settings key read in
  code is declared. It passes today, so it is a regression guard.
- **Unit layer to 100%.** `manifest-core.js` entered the gate at 80%; its
  scalar coercion, dest-token resolution and emit-time optional branches are now
  covered. `resolveDest`'s dead third branch was removed rather than tested
  around; the UMD preamble and a regex zero-length-match guard carry scoped
  ignores with justifications, per the rule in `ARCHITECTURE.md`.
- **S1 piloted — presenter extraction.** `MarketplacePanel` was 255 lines of
  which 16 touched `vscode`; the sign-in state machine, product cache, install
  guards and error mapping now live in `core/app/marketplacePresenter.ts`,
  unit-tested to 100%. Editor work is *described* as a typed effect the panel
  performs, so tests assert on values rather than spying on a mocked API. The
  panel is down to 129 lines and integration-tested through the double.
- **S5 generalised — port contract suites.** `productInvariants` now runs
  against the GitHub backend as well as the mock, and a new
  `FileSystemPort` contract runs the real node adapter against the clauses core
  relies on (parent-directory creation on write/copy, recursive and
  missing-path-tolerant remove). The in-memory fakes core is tested against are
  now checked claims rather than hopeful ones.
- **A shared `vscode` test double** (`test/integration/support/vscode.ts`):
  configuration resolves against a settings map, EventEmitter dispatches, and
  webview panels record what was posted and expose their message handler. This
  is what unblocks the rest of the integration layer.
- The e2e console spec no longer fails on browser-chrome noise (a full Chromium
  requests `/favicon.ico`; the headless shell does not), and the Playwright
  config accepts a `PW_CHROMIUM_PATH` override for images that ship their own
  browser.

## Outstanding

Ordered as the work should be picked up. The three red gates above are the
acceptance criteria.

1. **Integration layer to 100% (G5).** Still the largest piece, ~1,850
   statements outstanding. The double and the presenter pattern are in place;
   what remains is applying them:
   - the remaining panels: `consolePanel` (309), `myModsPanel` (305),
     `missionPanel` (187), `logPanel` (165). Panels covered so far were
     tested in place against the double rather than presenter-extracted;
     that is the right call for shells that only translate messages, but
     `myModsPanel` and `consolePanel` carry enough decision logic to be
     worth the `marketplacePresenter` treatment;
   - **S2, a `SchedulerPort`** for `setInterval`/`setTimeout`, so
     `debug/adapter.ts` (512 lines, the largest untested unit in the repo) and
     `BridgeClient` become deterministic. The 30-second breakpoint
     auto-continue is a safety mechanism — if it regresses, a crashed editor
     freezes the user's sim — and nothing tests it;
   - injected `spawn` seams for `gh.ts`, `git.ts` and `sevenZip.ts`; their argv
     is already covered in core, so only the spawn/error mapping is left;
   - `extension.ts` activation, which the contribution contract checks
     statically but nothing executes.
2. **E2E layer to 100% (G4).** Harnesses for `publish.js`, `setup.js` and
   `newproject.js`, which sit at 0% — publish performs irreversible GitHub
   operations and setup gates first-run. These three views address elements by
   `getElementById` rather than the repo's `data-testid` convention, so they
   need testids adding as part of the work. Then close the remaining gaps in
   `console.js` (76%), `shared.js` (85%) and `console-explorer.js` (90%).
3. **Rust to 100%.** Currently 77.3% lines. Largest gaps: `file.rs` (39% lines,
   4 of 29 functions executed), `jsonrpc/server.rs` (49%), `logger.rs` (56%),
   `lua_utils.rs` (74%), `sqlite.rs` (78%). The Lua-bound modules are testable
   with in-process `Lua::new()` fixtures, as `path_guard`'s tests now show;
   `server.rs` needs an actix test-server harness. **S4** — splitting a
   Lua-free protocol crate — would make the highest-traffic logic testable
   without any linkage setup, and is worth doing before chasing the last few
   percent.
4. **G3 — the webview↔panel message contract.** Deliberately not implemented
   yet. Deriving the message sets by regex is unreliable: the webviews use
   several different dispatch shapes (`postMessage` inline, helper wrappers,
   `case` blocks, `if (m.type === …)`), so an inferred contract produces false
   failures. It needs an explicit declared contract table per pair, checked
   against both sides — worth doing alongside the presenter extraction in (1),
   where a typed `HostMessage`/`WebviewMessage` union makes the table
   mechanical rather than hand-maintained.
