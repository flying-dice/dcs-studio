# Running the tests

Four layers, each with its own command and its own coverage gate over an include
set that does not overlap the others'. The rationale is
[decision 05](../../decisions/05-four-disjoint-test-layers-each-at-100.md); the
full spec is the "Testing & coverage" section of
[ARCHITECTURE.md](../../ARCHITECTURE.md). This page is the operational version.

## The commands

| Layer | Tests | Coverage | Lives in | Gates |
|---|---|---|---|---|
| Unit | `npm run test:unit` | `npm run coverage:unit` | `test/unit/**` | `src/core/**`, `media/*-core.js` |
| Integration | `npm run test:integration` | `npm run coverage:integration` | `test/integration/**` | `src/**` minus the hexagon |
| E2E | `npm run test:e2e` | `npm run coverage:e2e` | `tests/**` | `media/*.js` in real Chromium |
| Rust | `cargo test --workspace` | `cargo llvm-cov --workspace` | `bridge/crates/**` | the bridge workspace |

`npm test` runs the three JavaScript layers in sequence. `npm run coverage` does
the same with each gate enforced.

The three JavaScript layers gate at **100% per file**. Rust gates lines and
functions at 100 and regions at 99.5 — see the comment in
`.github/workflows/ci.yml` for why that floor is 99.5 and why it should not be
lowered.

## Environment prerequisites

Three of the four layers need nothing but `npm ci`. The **e2e** layer drives real
Chromium, so it needs a browser binary present:

```bash
npx playwright install chromium
```

Without it the layer fails at launch rather than at an assertion, which reads as a
broken test rather than a missing dependency — a preflight check is being added to
the coverage script this sprint so the message says which one it is.

If Chromium is already on the machine and you would rather not have Playwright
download its own, point at the existing binary instead:

```bash
PW_CHROMIUM_PATH=/path/to/chromium npm run test:e2e
```

`playwright.config.ts` reads `PW_CHROMIUM_PATH` and, when set, passes it through as
the launch `executablePath`. It is an escape hatch, not the supported path: the
managed download is the version the suite is verified against.

## Two rules that are not optional

**Run the gates serially.** The include sets are disjoint by design, so running
them into one process defeats the point — a line covered by the wrong layer
reports green. Parallel runs also share `coverage/**/.tmp` and corrupt each
other's shards.

**Never run `vitest run --coverage` at the repo root.** The root config is a
`projects` config, and vitest treats `coverage` as a root-only option, so every
per-layer threshold is silently ignored. Coverage gets computed and discarded.
This is not hypothetical: it is how the release workflow gated nothing for a
while. Use the per-layer commands.

**Never run two `cargo llvm-cov` invocations at once.** They share
`bridge/target/llvm-cov-target`, and the second's rebuild deletes the first's
test binaries. The first then dies with
`could not execute process … (never executed)` on whichever test is late in the
run order — which looks exactly like a flaky test and is not one. Cargo's file
lock does not cover it. If you genuinely need a second measurement, give it its
own `--target-dir`.

## Running the Rust tests off-Windows

`bridge/crates/bridge-core/build.rs` links Debian's PUC liblua5.1 on non-Windows,
so the tests — which create real Lua states — run as ordinary executables:

```bash
sudo apt-get install -y liblua5.1-0-dev
cd bridge && cargo test --workspace
```

Same 5.1 ABI DCS ships. DCS's own `lua.dll` is not redistributable, which is why
the link target differs.

## Which layer does a new test belong in?

- **Unit** is pure logic: no filesystem, no child processes, no `vscode`.
  Anything needing a seam belongs in integration.
- **Integration** means the seams are real code, not that the OS is. `vscode` is
  a shared test double (`test/integration/support/vscode.ts`) and process and
  socket seams are injected, so the layer stays headless — no VS Code, no
  display, no DCS.
- **E2E** drives the real `media/*.js` in Chromium against the `previews/`
  harness.

Two standing conventions:

- A port with more than one implementation carries a **shared contract suite**
  under `test/support/`, run against each one. `MarketplacePort` and
  `FileSystemPort` are the worked examples. A core service must not be able to
  pass against a fake more permissive than the adapter it stands in for.
- **Coverage-ignore comments are forbidden**, except for provably unreachable
  defensive lines with a justification comment. Prefer restructuring so the line
  is reachable.

## What the gates cannot see

A coverage gate is only ever as complete as the file list it was given. A script
added to a panel but not to its preview page is never executed, never measured,
and the gate still reports green —
`test/integration/webview/previewAssets.test.ts` exists to assert that list.

And nothing gates Lua. About 2,050 in-sim lines are loaded and executed by the
Rust tests, but `cargo llvm-cov` measures Rust regions and a Lua chunk is opaque
to it. A working line-coverage prototype now lives in-tree
(`bridge/crates/bridge-core/tests/support/lua_cov.rs` + `coverage.lua`, inert
unless `LUA_COV_DIR` is set), and the investigation on board card
`05-choose-lua-coverage-route` disproved the blocker #66 was framed around —
but deliberately added **no fifth gate**: only a handful of the suite's Lua
states are instrumentable at all (the shim needs `debug`, which mlua's
`Lua::new()` omits), so a threshold over the resulting ~12% would gate a number
that mostly cannot move. The open decision is recorded in
[decision 07](../../decisions/07-no-lua-coverage-gate-yet.md) and on issue #66.
