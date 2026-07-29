---
column: backlog
labels: [bridge]
priority: low
updatedAt: 2026-07-29T05:22:16.000Z
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
