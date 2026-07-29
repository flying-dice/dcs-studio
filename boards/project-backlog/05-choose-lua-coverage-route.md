---
column: todo
labels: [lua, tests, ci]
priority: high
updatedAt: 2026-07-29T05:22:16.000Z
---
# Pick a route for measuring Lua coverage

[Issue #66](https://github.com/flying-dice/dcs-studio/issues/66), with the
decision framed in [#68](https://github.com/flying-dice/dcs-studio/issues/68) §1.
**Blocked on a decision, not on work** — a prototype is preserved verbatim in the
issue comments.

Four gates cover TypeScript, the webviews and Rust. None of them is Lua, and
~2,050 lines of Lua run inside the sim on the sim thread — enumerated per file in
`docs/04-quality/01-testing-audit.md:405-418`. Those chunks are loaded into real
Lua states by the Rust tests, so they execute; `cargo llvm-cov` measures Rust
regions and a Lua chunk is opaque to it, so nothing measures them.

**The blocker in one line:** instrumenting perturbs the suite that produces the
number. With `LUA_COV_DIR` unset, `debug_engine_safety` is 4/4; set, it is 3/4,
and every failure is a sub-second timing test whose budgets *are* the safety
guarantee from #17.

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

- [ ] Run the preserved prototype twice and diff the line sets (timing-suites-only lines)
- [ ] Re-run the multiplexed-hook experiment to settle whether the `arm()` ceiling is real
- [ ] Choose a route and record it as a decision record
- [ ] If route 1: define the acceptance criterion — number and excluded set in one artifact, plus a test that fails if the set grows
