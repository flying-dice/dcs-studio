---
column: done
labels: [lua, tests, ci]
priority: high
agent: claude
live: false
updatedAt: 2026-08-01T12:10:00.000Z
---
# Pick a route for measuring Lua coverage

[Issue #66](https://github.com/flying-dice/dcs-studio/issues/66), with the
decision framed in [#68](https://github.com/flying-dice/dcs-studio/issues/68) §1.
**Blocked on a decision, not on work** — a prototype is preserved verbatim in the
issue comments.

Four gates cover TypeScript, the webviews and Rust. None of them is Lua, and
~2,050 lines of Lua run inside the sim on the sim thread — enumerated per file in
`docs/04-quality/02-testing-audit-2026-07.md:405-418`. Those chunks are loaded into real
Lua states by the Rust tests, so they execute; `cargo llvm-cov` measures Rust
regions and a Lua chunk is opaque to it, so nothing measures them.

**The blocker in one line:** instrumenting perturbs the suite that produces the
number. With `LUA_COV_DIR` unset, `debug_engine_safety` is 4/4; set, it is 3/4,
and every failure is a sub-second timing test whose budgets *are* the safety
guarantee from #17.

> **Amended 2026-07-29 after re-running the prototype.** The blocker above is
> **false** and is now measured as such. The 3/4 failure is not a timing
> perturbation — it is a stack-depth defect in the shim. See the journal below.
> Routes 1-4 all exist to work around a perturbation that does not happen, so
> none of them is the answer. Two harder limits took its place.

#68 asks for one measurement before choosing: of the 782 distinct lines in the
three files, how many are reached **only** by the timing suites. Near zero makes
route 1 honest; material disqualifies it. Route 4 (arm per Lua state rather than
per process) is the reviewer's and looks best on paper — untried.

A ceiling applies to all four routes: `arm()` hands the thread to the guest
whenever `count > 0`, so `call_bounded`'s deadline check and its
`error("evaluation timed out …")` line are excluded by construction. Whether that
is real or self-imposed is unresolved — `combined()` already computes the union
mask a single multiplexed hook would need, and `arm()` declines to use it. One
experiment settles it.

## Checklist

- [x] Run the preserved prototype twice and diff the line sets (timing-suites-only lines)
- [x] Re-run the multiplexed-hook experiment to settle whether the `arm()` ceiling is real
- [ ] Choose a route and record it as a decision record
- [ ] If route 1: define the acceptance criterion — number and excluded set in one artifact, plus a test that fails if the set grows

## Comments

- **claude** (2026-07-29T06:05:12.000Z): Restored the preserved prototype and ran all three experiments. **Everything below is measured on this branch unless marked inferred.** (1) Installed the shim verbatim from issue #66 comment `5083253665` at `bridge/crates/bridge-core/tests/support/coverage.lua:1-205` and wrote the Rust half it only describes — `CoveredLua`, `Deref<Target = Lua>`, dump-on-drop, inert unless `LUA_COV_DIR` is set — at `bridge/crates/bridge-core/tests/support/lua_cov.rs:1-180`, wired through `bridge/crates/bridge-core/tests/support/mod.rs:18` and the four `bootstrap` call sites (`bridge/crates/bridge-core/tests/debug_engine_safety.rs:57`, `bridge/crates/bridge-core/tests/debug_ws_latency.rs:63`, `bridge/crates/bridge-core/tests/hook_dcs_studio.rs:315`, `bridge/crates/bridge-core/tests/jsonrpc_server.rs:77`). No production file is touched — `git diff --stat` over `crates/*/src`, `crates/*/lua` and `hook/` is empty, so the existing `cargo llvm-cov` gate over `src/` is unaffected.
- **claude** (2026-07-29T06:05:12.000Z): **The stated blocker is false, and this is the finding that disposes of all four routes.** The 3/4 failure reproduces exactly, but it is not a slowdown. All three failures land in 0.15–0.25s against an uninstrumented baseline of 0.22s, and they assert `the breakpoint really did hold a pause` / `the broken condition still stopped` / `the loop was refused, not awaited` — i.e. the breakpoint never fired at all, not that a deadline was missed. Cause: `bridge/crates/bridge-core/lua/debug_engine.lua:598` reads `debug.getinfo(2, "nSlf")` from inside the engine's own line hook to find the frame whose line just fired, and the shim's `multiplexed` **calls** the guest, so the guest runs one frame deeper and reads `coverage.lua` instead. `should_pause` is then asked about the wrong source. This is trap #1 from the prototype's own writeup — the `getinfo` level — applied to the guest rather than to `record`, and the author's writeup attributed it to instrumentation cost instead. Probed the levels directly on PUC 5.1.5: a bare hook sees the running code at level 2; a nested guest sees the hook wrapper; a proper tail call (`return g.fn(...)`) is worse still, giving the pseudo-frame `=(tail call)` with `currentline = -1`. There is no way in Lua 5.1 to multiplex a line hook without moving the guest's level, so `arm` at `bridge/crates/bridge-core/tests/support/coverage.lua:96-118` now hands the thread to any guest that asked for line events. **With that one change the entire workspace passes fully instrumented — `LUA_COV_DIR` set, 150 passed, exit 0, same wall time.** `LUA_COV_MULTIPLEX_LINE_GUESTS=1` reproduces the original 3/4 failure on demand.
- **claude** (2026-07-29T06:05:12.000Z): **The measurement #68 asked for: 9.** Ran the instrumented suite twice — once whole, once with the three sub-second timing tests skipped — and diffed the distinct line sets over the three chunks. 132 distinct lines reached with them, 123 without; **9 lines reached only by the timing suites, 6.8% of what is measured, all in `debug_engine.lua` and all the body of `D.set_breakpoints` at `bridge/crates/bridge-core/lua/debug_engine.lua:433-444`** — a breakpoint-registry setter with no timing role, reached only because the fourth test calls `clear_breakpoints` and not `set_breakpoints`. Nothing in `rt.lua` or `gui_methods.lua`. By #68's own criterion this is "near zero", so route 1 would have been honest — but it is moot, because there is no longer anything to exclude.
- **claude** (2026-07-29T06:05:12.000Z): **The `arm()` ceiling: the multiplexed-hook experiment does not fail, and the ceiling is real anyway for a different reason.** Re-ran it as instructed rather than trusting the comment. Dropping `arm()`'s `count > 0` early return so every guest goes through `combined()` (`LUA_COV_MULTIPLEX_COUNT=1`) keeps `debug_engine_safety` at **4/4 green**, and `while true do end` is still cut off — so the "failed three safety tests" note on `arm` **does not reproduce**, and #68 was right to record it as unreliable. But it recovers only 3 further lines (89 → 92), because `arm()` was never the cause. Probed the real one directly: Lua 5.1 clears `allowhook` for the duration of a hook, so a function invoked from inside a hook contributes **none** of its body lines. `call_bounded` (`bridge/crates/bridge-core/lua/debug_engine.lua:196-218`), its deadline check and its `error("evaluation timed out …")` line at `:200-202` all run from inside the engine's line hook via `D.pump`, as do `hold_pause` and `eval_expr`. They are invisible to a Lua line hook under **every** one of the four routes, and `combined()` cannot lift it. The ceiling stands; its stated cause was wrong.
- **claude** (2026-07-29T06:05:12.000Z): **Route 4 works but is unnecessary; a bigger limit replaces it.** Per-state arming is implemented and green (`CoveredLua::unarmed` at `bridge/crates/bridge-core/tests/support/lua_cov.rs:80-90`), so the reviewer's route is available — but no state needs to opt out any more, so it buys nothing. What it cannot fix: **only 5 Lua states in the whole 150-test suite can be instrumented at all.** `coverage.lua` needs the `debug` library, and mlua's `Lua::new()` omits it — only `unsafe_new()` states qualify. `jsonrpc_server.rs`, `openrpc_meta_schema.rs` and all 116 `src/lib.rs` unit tests use `Lua::new()`, which the existing test at `bridge/crates/bridge-core/src/lib.rs:443-452` relies on. Measured coverage over the three files is therefore **`debug_engine.lua` 89/763 (11.7%), `rt.lua` 42/450 (9.3%), `gui_methods.lua` 1/580 (0.2%)** — the last because `register_methods` is never *called* on an instrumentable state. (`gui_methods` needs an offset map: the chunk is `methods_shared` + `gui_db` + `gui_methods` concatenated by `bridge/crates/bridge-core/src/lib.rs:265-283`, so chunk lines 1-63/64-258/259+ split across the three files.)
- **claude** (2026-07-29T06:05:12.000Z): **Left in `blocked` deliberately — not choosing a route.** Routes 1, 2 and 3 are disqualified because the perturbation they work around does not exist; route 4 works but is unnecessary. Picking any of them would be picking a fix for a solved problem. The open decision is now different and belongs to whoever owns the sim-side risk: (a) whether to move harness states from `Lua::new()` to `unsafe_new()` so more than 5 states are measurable — that changes what several tests assert about a debug-less state, so it is a judgement call, not a mechanical fix; and (b) given that a large fraction of `debug_engine.lua` is unmeasurable *by construction*, whether a Lua gate is worth having at all, and if so whether a ratchet over a ~12% number tells anyone anything. No CI gate wired and no decision record written, because #66 is explicit that the threshold is a measurement and the measurement now says the number would not mean what the issue assumed. The prototype is left in the tree, working, inert by default and reproducible in both directions, so the next session re-runs rather than rebuilds. Gates on this branch: `cargo fmt --check` exit 0, `cargo clippy --all-targets -- -D warnings` exit 0, `cargo test --workspace` exit 0 with 150 passed across 8 binaries (and also 150 passed with `LUA_COV_DIR` set). `cargo llvm-cov` not run — `cargo-llvm-cov` is not installed in this environment; unaffected by inference only, since no `src/` line changed.
- **claude** (2026-07-29T07:05:00.000Z): The "record it as a decision record" half of the unticked checklist item now has a home without pretending the route question is settled: decisions/07-no-lua-coverage-gate-yet.md records the no-gate-yet position as **Proposed**, with the `unsafe_new()` trade-off named as the decision that would change it. The route item stays unticked — no route was chosen, because none was needed. Confirming or rejecting decision 07 is the same act as unblocking this card.
- **claude-lead** (2026-08-01T12:10:00.000Z): Closed under the owner's full delegated close-down authority. Decision 07 is now Accepted (decisions/07-no-lua-coverage-gate-yet.md): no Lua coverage gate on the current measurement, with the unsafe_new() re-opener named. The route question was answered by measurement — none was needed — and the prototype remains in-tree, inert and reproducible. Issue #66 closed with this record. Done.
