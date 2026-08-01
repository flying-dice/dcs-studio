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
| Rust | `cargo test --workspace` | `node scripts/llvm-cov.mjs --workspace` | `bridge/crates/**` | the bridge workspace |

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

`npm run coverage:e2e` runs that for you. `scripts/e2e-coverage.mjs` installs
Chromium up front — a no-op costing under a second when the browser is already
there — so the coverage command works on a fresh clone with nothing else done
first, and a box that cannot download browsers gets a one-line message naming
`PW_CHROMIUM_PATH` instead of Playwright's launch-time wall of text. Run the
command above by hand only if you are driving `npm run test:e2e` directly, which
does not preflight.

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
while. Use the per-layer commands. `vitest.config.ts` now refuses to load when
coverage is requested, so this one is enforced rather than remembered.

**Never run two `cargo llvm-cov` invocations at once.** They share
`bridge/target/llvm-cov-target`, and the second's rebuild deletes the first's
test binaries. The first then dies with
`could not execute process … (never executed)` on whichever test is late in the
run order — which looks exactly like a flaky test and is not one. Cargo's file
lock does not cover it.

`scripts/llvm-cov.mjs` enforces this. Run llvm-cov through it — CI does too —
and a second run fails immediately with an explanation instead of corrupting
the first:

```bash
node scripts/llvm-cov.mjs --workspace   # everything after the script goes to cargo llvm-cov
```

It holds `.llvm-cov.lock` inside the target directory for the duration. If you
genuinely need a second measurement, give it its own `--target-dir`: the lock
follows the target directory, so runs that do not share artefacts do not
contend.

If a run is killed in a way that skips its cleanup, the lock can outlive it.
The refusal message says so — it reports the holding pid and whether that
process still exists — and prints the `rm` for the stale file. Nothing removes
it automatically, because "the pid is gone" and "the pid was reused" look the
same from here.

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

## Mutation testing: `npm run mutate`

Coverage says a line RAN. It never says a test would notice if that line were
wrong. This repo's board journals are full of the missing half — dozens of
hand-run entries reading "breaking X failed exactly test Y" — each recorded once
by whoever wrote the code and then unmaintained, so the next refactor could
quietly hollow out a guard and leave every gate green.

`scripts/mutate.mjs` is that practice made repeatable. It holds a table of
deliberate breakages, each paired with the gate that must NOTICE it. For each
one it copies the target file aside, applies an **exact** string replacement,
runs that gate, demands a non-zero exit, and restores the file from the copy.

```sh
npm run mutate                      # every mutation
npm run mutate -- --list            # the table, no runs
npm run mutate -- --only nav-ready-case   # one (repeatable)
```

Four properties worth knowing before you trust or extend it:

- **Every gate is checked GREEN first.** A gate that is already red cannot
  testify that a mutation broke anything, so a red baseline is reported as an
  `ERROR` rather than counted as a kill. This is also why the gates are scoped
  to the files that witness each mutation and not to whole layers: an
  unprivileged Windows box has pre-existing `test:integration` failures that
  would mark every mutation KILLED without ever running the mutated code.
- **A `find` that no longer matches is a loud `ROTTED`, never a silent pass.**
  The same goes for one that matches twice. If you reflow a guarded line, the
  script tells you the table needs updating instead of quietly measuring
  nothing. Anchor new entries on a decision's own words, not on punctuation.
- **The restore never touches git.** It restores from the copy aside, in a
  `finally` and on every fatal signal, and the run refuses to start if a target
  file is already dirty — so a crash mid-run can never be confused with, or
  overwrite, an edit in progress. Do not "improve" this into a `git checkout`.
- **Rust/Lua entries SKIP without DCS's `lua.dll` on PATH**, with the reason
  printed. Put `<DCS>\bin` on PATH to run them; a box without DCS gets an honest
  partial run rather than a fraudulent green one.

**When to run it: on demand, and after any refactor of a gated area** — the
webview contract tables, the panel lifecycle helpers, the presenters, the
bridge's teardown path, the embedded Lua. That is the moment the recorded
evidence stops being true and the moment this script is worth its runtime.

**It is deliberately NOT in CI's per-push path.** It applies ten mutations and
runs a gate for each, including e2e and cargo, and it edits tracked files while
it works — neither is something to put in front of every push. The suite it
checks is already gated per push; this checks the gate itself, which is a
question worth asking on a cadence rather than continuously.

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
