---
column: blocked
labels: [bridge]
priority: low
agent: claude
live: false
status: blocked — parked until the #62 log line appears in the wild
updatedAt: 2026-07-29T05:52:00.000Z
---
# Run bridge registration under a protected frame so an OOM cannot end the process

[Issue #63](https://github.com/flying-dice/dcs-studio/issues/63) — the prevention
half of #62, whose evidence half has landed
(`bridge/crates/bridge-core/src/lua_panic.rs`).

Lua 5.1 answers an error raised with no protected frame by handing the state to
`G(L)->panic` and calling `exit(EXIT_FAILURE)`. The bridge now writes a line
naming itself and the phase before that happens — but the process still dies, and
the DCS session with it. The fix is to make the allocating registration work
happen under a frame Lua can unwind to.

The unprotected call was located by experiment: mlua's `lua_pushcfunction`
allocates a C closure before any `lua_pcall` exists to catch it, and mlua's own
`relax_limit_with` guard does nothing in a DCS module state where the allocator
is DCS's. Which also means it cannot be test-driven through `set_memory_limit`;
the `#[ignore]`d probe in `lua_panic.rs` shows the shape any test of a fix needs.

**Do not start this.** #63 and #68 §3 both record the same decision: the trigger
is the #62 log line appearing in a real user's `dcs_studio_*.log`. Picking it up
now overrides a documented decision on work of genuinely unknown scope.

## Comments

- **claude** (2026-07-29T05:52:00.000Z): Not started, on purpose. This is the one card on the board whose correct action is to leave it alone: #63 and #68 §3 both record the same decision, that the trigger is the #62 log line appearing in a real user's `dcs_studio_*.log`. Starting it now would override a documented decision on work whose scope the issue itself calls genuinely unknown, and would touch every allocating call in bootstrap — inside the DLL whose failure mode is a crashed flight sim.
- **claude** (2026-07-29T05:52:00.000Z): Filed under blocked rather than backlog so the distinction is visible: this is not "not yet prioritised", it is "waiting on a specific external signal". Nothing about the analysis has decayed — the unprotected `lua_pushcfunction` and the `#[ignore]`d probe in bridge/crates/bridge-core/src/lua_panic.rs are both still there and still describe the shape a fix would need.
