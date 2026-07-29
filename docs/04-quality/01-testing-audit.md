# Testing pyramid audit

Audit of the test suite and the structural seams that make code testable, taken
against `main` @ `8c45b98` (v0.16.0). Measurements are reproducible — every
number below came from running the suites, not from reading them.

> **Status note.** Everything below is the original audit, kept as the record of
> what was true at `8c45b98`. **All of it has since been addressed** — see
> [Remediation status](#remediation-status) at the end for the measured numbers,
> the defects the work uncovered, and the few things deliberately left undone.

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

**Complete.** All four layers gate at 100% and pass. Numbers below were measured
by running each layer on its own — parallel runs share `coverage/**/.tmp` and
corrupt each other's shards, so every reading here is from a serial run.

| Layer | Command | Tests | Coverage | Gate |
|---|---|---|---|---|
| Unit | `npm run test:unit` | 806 | 100% stmts / branches / funcs / lines | green |
| Integration | `npm run test:integration` | 879 | 100% (2270 stmts, 925 br, 604 fn, 2026 lines) | green |
| E2E | `npm run test:e2e` | 221 | 100% across all 14 webview scripts | green |
| Rust bridge | `cargo llvm-cov --workspace` | 116 | 100% lines (3832), 100% functions (444) | green |

**2,022 tests**, up from 905 (790 unit + 91 e2e + 24 Rust) at the start. No
coverage-ignore was added to reach any of it beyond the two documented in the
unit layer, and no gate was weakened.

Rust *region* coverage is 98.75% and is deliberately not gated: regions split on
panic edges the compiler inserts, which cannot all be driven from a test.

## Every gap from the audit above

| Gap | Status |
|---|---|
| G1 — Rust tests never run in CI | Fixed: one CI job per layer, incl. a Linux `cargo llvm-cov` job |
| G2 — sandbox-escape guard untested | Fixed, and the guard was rewritten (it was host-dependent) |
| G3 — webview/panel seam unverified | Fixed by construction: both halves now execute under their own gate |
| G4 — three webviews with no harness | Fixed: publish, setup and newproject harnesses added |
| G5 — panels ~90% logic, 0% tested | Fixed: every panel at 100%; marketplace extracted to a presenter |
| G6 — CLI argv untested | Fixed: extracted to `core/domain/cliArgs.ts` under the unit gate |
| G7 — host-dependent path logic | Fixed across core, adapters and panels |
| G8 — no extension-host integration | Fixed: `activate()` is really called and every handler driven |

## Defects found while writing the tests

Eleven, none of which a coverage percentage would have revealed on its own. They
came out of asking what happens when a user acts at the wrong moment.

**Data loss / corruption**
- `path_guard` accepted drive-prefixed and backslash-climbing input off-Windows,
  and accepted NTFS alternate-data-stream writes (`notes.txt:hidden`) *on*
  Windows. This is the containment check for every file and SQLite write the
  bridge exposes over its local JSON-RPC surface.
- `restoreMission` had no unsaved-buffer guard, so restore-from-backup could be
  silently undone by the very editor buffer that mangled the file.
- `setup.js` routed a browsed `7z.exe` into the DCS *installation path* field,
  overwriting it — on the first-run screen everything else depends on.
- `sqlite` could not bind SQL NULL: params were walked as a sequence, which
  stops at the first `nil`, so `{1, nil, 3}` bound one parameter and the
  statement was rejected.

**Availability**
- A poisoned `AppData` mutex bricked the bridge for the rest of the DCS session
  — every request 500ing, `/health` dead.
- `logPanel` could create its tailer *after* dispose, orphaning a 500 ms poll of
  `dcs.log` that posted to a dead webview for the rest of the session.
- `tailer` left `open`/`read`/`close` outside its catch, so a log deleted between
  stat and open threw an unhandled rejection and the tail silently stopped.
- `stop_on_thread` was fallible with a `Drop` caller — a failure there becomes a
  panic, and a panic while unwinding aborts the process.

**Correctness**
- `debug` applied in-flight `debug_state` answers after the session ended,
  re-emitting `stopped` and reopening the debug UI on a dead session.
- `deploy.ts` mixed native and win32 paths, so `dirname` returned `"."` and the
  pre-copy `mkdir` targeted the wrong directory.
- `marketplace.js` never restored the persisted product page: `render()` reset
  the view before the re-open check could read it, making the feature dead code
  since it was written.

## Structural changes

- **Three layers, disjoint include sets** — a gap in one can never be masked by
  another layer executing the same line. This is what made the rest measurable.
- **Presenter extraction (S1)** — piloted on the marketplace: 255 lines of panel
  became a 129-line VS Code shell plus a presenter that knows nothing about the
  editor and describes side effects as values. Remaining panels were covered in
  place, which is the right shape for shells that only translate messages.
- **`SchedulerPort` (S2)** — poll loops, backoff and the 30-second held-breakpoint
  auto-continue are now deterministic. That auto-continue is a safety mechanism:
  if it regresses, a crashed editor freezes the user's sim.
- **`core/domain/cliArgs.ts` (S3)** — the flags that create repos, delete tags and
  split release archives are now pure values under the unit gate.
- **Port contract suites (S5)** — the marketplace product invariants run against
  both implementations. `FileSystemPort`'s suite ran against the real adapter
  only until the clean-code round, when the four hand-written fakes were
  replaced by one `MemFileSystem` put through the same contract; the claim above
  was aspirational when first written, and is now true.
- **The `vscode` test double** (`test/integration/support/vscode.ts`) — a small
  real implementation, not a bag of spies. Two of its own bugs were worth more
  than the tests that found them: it dropped VS Code's third `disposables`
  argument (making every panel's teardown loop unreachable — exactly the code
  that prevents listener leaks), and it leaked listeners between specs.

## What is deliberately not done

- **G3's declared message-contract table.** Both halves of every webview protocol
  now execute under a gate, so a dropped handler fails a test. A typed contract
  table would still be worth adding alongside a wider presenter rollout; deriving
  it by regex is not, because the webviews use several dispatch shapes and an
  inferred contract produces false failures.
- **Presenter extraction beyond the marketplace pilot.** `consolePanel` still
  carries enough decision logic to deserve it (`myModsPanel` was done in the
  clean-code round, issue #40).
- ~~**`console.js` history recall needs a double tap.**~~ **Since fixed**
  (board card `10-console-history-recall-double-tap`). The parked reasoning was
  half right: it does need a history-navigation mode flag, but the ergonomics
  cost was avoidable. The guard changed from "the caret is at offset 0" to "the
  caret is on the input's first line" (and the mirror for ↓), which a one-line
  recalled entry satisfies with the caret at its end — so each direction is one
  tap, while multi-line snippets keep ↑/↓ for the caret. The mode flag pays for
  restoring the draft on the way out and for resetting the walk when the user
  types. It was *not* documented in the spec, as this bullet claimed; the
  History scenario in `spec/stories/017-lua-console.story.md` now states the
  behaviour, and `tests/console-repl.spec.ts` covers both directions.

## The one area still unmeasured: Lua

Stated plainly because the headline finding of this audit was that unmeasured
code cannot be noticed drifting, and that argument does not stop at the language
boundary.

The four gates cover `src/core/**` plus two `media/*-core.js` (unit), `src/**`
minus the hexagon (integration), `media/*.js` minus `*-core.js` (e2e), and the
Rust workspace via `cargo llvm-cov`. **Nothing in that set is Lua** — and about
2,050 lines of Lua run inside the sim, on the sim thread:

| File | LOC | Executed by a test? | Measured? |
|---|---|---|---|
| `bridge-core/lua/debug_engine.lua` | 763 | yes | no |
| `bridge-core/lua/gui_methods.lua` | 580 | yes | no |
| `bridge-core/lua/rt.lua` | 450 | yes | no |
| `bridge-core/lua/mission_methods.lua` | 195 | yes | no |
| `bridge-core/lua/gui_db.lua` | 194 | yes | no |
| `bridge-mission/lua/mission_init.lua` | 91 | yes | no |
| `bridge-core/lua/methods_shared.lua` | 62 | yes | no |
| `bridge/hook/DcsStudio.lua` | 111 | **now** — `tests/hook_dcs_studio.rs` | no |

The distinction matters. The seven `bridge-*/lua/*.lua` chunks are loaded into
real Lua states by the Rust integration tests and are genuinely exercised — but
`cargo llvm-cov` measures Rust regions, and a Lua chunk is opaque to it. So
"`call_bounded`'s yield branch is covered", "the `gethook` refusal in
`RT.signature_json` is covered", "`hold_pause`'s drain throttle is covered" are
claims, not measurements. A branch that stopped being reached would not fail
anything.

`DcsStudio.lua` was worse and is the reason this section exists: it is the file
DCS loads at startup, and until `tests/hook_dcs_studio.rs` **no test loaded it at
all**. `debug_ws_latency.rs` mentions it only to build a minimal hook of its own.
The `pcall` around `onSimulationFrame`, the `FRAME_ERROR_INTERVAL` throttle and
the `logger_level` change from `info` to `warn` all shipped unexercised. That
test stubs the five sim globals and runs the real chunk; both the `pcall` and the
throttle are mutation-checked.

What is left is measurement, not execution: a Lua coverage hook (`debug.sethook`
with a `line` mask, or LuaCov) over the chunks the Rust tests already load, and a
fifth gate to hold the result. That is deliberately not in this branch — it is a
new toolchain in the one part of the workspace whose failure mode is a crashed
flight sim, and it deserves its own change rather than a corner of this one.
**Tracked as #66.**

## Addendum: what the clean-code round changed about the gates themselves

The pyramid work above was audited afterwards by ten parallel principle-specific
reviews (issues #33–#61). Three findings are about the gates rather than about
the code they measure, and belong in this record:

- **The release workflow gated nothing.** It ran `vitest run --coverage`, which
  resolves the root `projects` config — and vitest treats `coverage` as a
  root-only option, so both layers' thresholds were ignored. Coverage was
  computed and discarded. Worse, CI's triggers matched no tag push, so a release
  ran neither lint, nor e2e, nor clippy. The DLLs it ships load inside a running
  flight sim, where the panic-restriction lints are the whole defence.

- **`coverage.all` is a no-op in vitest 4.** Both per-layer configs passed it.
  The include globs alone still fail an unimported file at 0% — verified by
  adding one and watching the gate reject it, with and without the flag — so the
  gate was sound, but it was sound by accident.

- **The e2e layer measures the previews, not the panels.** A script added to a
  panel and not to its preview page is never executed, never measured, and the
  100%-per-file gate still reports green. That is the one gap a coverage gate
  cannot see: it is only ever as complete as the file list it was given. Now
  asserted by `test/integration/webview/previewAssets.test.ts`.

The same round found that `tsc` covered `src/` only — 113 test files, 16
Playwright specs, the shared `vscode` double and every config were never
typechecked, because vitest and Playwright transpile through esbuild and Biome
does not typecheck. `tsconfig.test.json` closes that.
