---
status: Accepted
date: 2026-07-29
---
# Decision 07 — No Lua coverage gate on the number we can currently measure

## Context

Issue #66 asked for a fifth gate over the ~2,050 lines of in-sim Lua the Rust
tests execute but nothing measures, and #68 §1 framed the work as a four-way
route choice around one blocker: that instrumenting perturbs the timing suites
that produce the number.

Board card `05-choose-lua-coverage-route` took the measurement #68 asked for and
found the premise false. The 3/4 `debug_engine_safety` failure under
instrumentation was never a slowdown — failures land at normal speed and assert
a breakpoint held a pause that never fired, because `debug.getinfo(2, ...)`
inside the engine's hook reads the coverage shim when the shim *calls* the
guest. Handing line-mask guests the thread fixes it: the whole workspace passes
fully instrumented, 150 tests, same wall time. The full evidence is on issue
#66 (comment `5113952117`) and the card.

What the investigation surfaced instead is a reach limit: the shim needs the
`debug` library, which mlua's `Lua::new()` omits, so only 5 of the suite's Lua
states are instrumentable at all. Measured reach is `debug_engine.lua` 11.7%,
`rt.lua` 9.3%, `gui_methods.lua` 0.2%. Separately, Lua 5.1 clears `allowhook`
during a hook, so anything called from the engine's own hook — `call_bounded`
and its timeout path included — contributes no lines under any route.

## Decision

Keep the prototype in-tree and inert
(`bridge/crates/bridge-core/tests/support/lua_cov.rs` + `coverage.lua`,
activated only by `LUA_COV_DIR`), and add **no fifth gate** on the number it
currently produces.

A ratchet over ~12%, where most of the remainder is invisible by construction
rather than by choice, is the false-green class this repo keeps finding — the
same shape as the release workflow that computed coverage and discarded it
(gates addendum in the testing audit) and the boundary ratchet that became
unfalsifiable when it was emptied (#67).

## Consequences

- The claim in the docs stays "executed but not gated", which is honest; a
  branch that stops being reached still fails nothing. #66 stays open.
- The decision that would change this is named, not vague: move the Rust
  harness states to `mlua::Lua::unsafe_new()` so they carry `debug` and become
  instrumentable — which changes what several tests assert about a debug-less
  state, and that decline path exists precisely because DCS strips parts of
  `debug`. That trade-off is a human call; it lives on board card 05, which
  stays blocked on it.
- If that call is made and reach becomes meaningful, the threshold should be
  set from a fresh measurement, not from this record.
- This record was `Proposed` until 2026-08-01, when it was accepted under the
  owner's full delegated authority for the session close-down. The measurement
  stood unchallenged: the perturbation the four routes addressed does not
  exist, only 5 states are instrumentable without the `unsafe_new()` trade-off,
  and a ratchet over a ~12% number would not inform anyone. The re-opener is
  unchanged: if harness states ever move to `unsafe_new()`, retake the
  measurement before revisiting a gate.
