---
column: blocked
labels: [bridge]
priority: low
agent: claude
live: false
status: blocked — parked until the #62 log line appears in the wild, and now for a second reason (see the 2026-08-01 journal entries)
updatedAt: 2026-08-01T00:00:00.000Z
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

It was picked up once, on 2026-08-01, under an explicit owner override, and
stopped without a code change. Two findings from that attempt narrow what the
trigger has to decide — read the journal before starting, they are the reason
the card is still here:

- Registration is **already** under a protected frame this repo installs
  itself: `pcall(require, …)` at `bridge/hook/DcsStudio.lua:37` and
  `bridge/crates/bridge-core/lua/gui_methods.lua:252`. The frame #63 asks for
  exists at the seam #63 names.
- A frame spanning all of `bootstrap` would be unsound regardless: the throw
  would longjmp over Rust frames holding `Drop` values, against mlua's own
  documented contract. The sound fix (`lua_cpcall` in mlua's protection setup)
  lives in mlua, not here.

So the #62 log line now decides *where* as well as *whether*: a `Phase::Ready`
line points at the serving path, not at registration, and this card would be
aimed at the wrong seam.

## Comments

- **claude** (2026-07-29T05:52:00.000Z): Not started, on purpose. This is the one card on the board whose correct action is to leave it alone: #63 and #68 §3 both record the same decision, that the trigger is the #62 log line appearing in a real user's `dcs_studio_*.log`. Starting it now would override a documented decision on work whose scope the issue itself calls genuinely unknown, and would touch every allocating call in bootstrap — inside the DLL whose failure mode is a crashed flight sim.
- **claude** (2026-07-29T05:52:00.000Z): Filed under blocked rather than backlog so the distinction is visible: this is not "not yet prioritised", it is "waiting on a specific external signal". Nothing about the analysis has decayed — the unprotected `lua_pushcfunction` and the `#[ignore]`d probe in bridge/crates/bridge-core/src/lua_panic.rs are both still there and still describe the shape a fix would need.
- **opus-protframe** (2026-08-01T00:00:00.000Z): Picked this up under an explicit owner override of the "wait for the #62 log line" decision, with instructions to stop and say why if the scope turned out to be unbounded or the fix unsound. It is unsound, and for a reason that had not been written down. Re-deriving where the unprotected calls are NOW, as instructed, turned up the thing that settles it: **registration already runs under a protected frame, and it is one this repo puts there itself.** Both bridges are `require`d inside an explicit `pcall` — the GUI at `bridge/hook/DcsStudio.lua:37` (`local ok, bridge = pcall(require, "dcs_studio_gui")`) and the mission at `bridge/crates/bridge-core/lua/gui_methods.lua:252` (`local ok2, err2 = pcall(require, "dcs_studio_mission")`, inside the boot snippet dispatched into the mission state). `luaopen` → `bootstrap` (`bridge/crates/bridge-core/src/lib.rs:173-234`) therefore executes with `L->errorJmp` non-null for its entire duration, so `luaD_throw` has a frame to unwind to and does not reach `G(L)->panic`/`exit`. #63's fix — "make the allocating registration work happen under a frame Lua can unwind to" — describes a frame that is already there. Adding a second one changes nothing.
- **opus-protframe** (2026-08-01T00:00:00.000Z): The fix as sketched would also be actively unsound, which is worth recording separately because it survives the point above. mlua wraps every API call in its own tiny `lua_pcall` precisely so a longjmp never crosses a Rust frame — its own contract, at `mlua-0.10.5/src/util/error.rs:151-155`: the protected closure "must *not* panic, and since it will generally be longjmping, should not contain any values that implements Drop". An outer frame spanning all of `bootstrap` inverts that: the throw from the unprotected `lua_pushcfunction` would unwind over hundreds of Rust frames holding `String`s, `Vec`s, live `LuaTable`/`LuaFunction` refs, mlua's own `StackGuard` and its state lock — skipping every destructor. That trades a clean `exit(EXIT_FAILURE)` for a Lua state whose Rust-side bookkeeping was jumped over: leaked registry entries, and a state lock never released. A hung or quietly corrupt sim is worse than a sim that closes with a log line, and unlike the exit it leaves no evidence at all.
- **opus-protframe** (2026-08-01T00:00:00.000Z): There is a sound fix, and it is not in this repo. The root cause is that Lua 5.1 protection is established by `lua_pushcfunction` + `lua_pcall`, and the push allocates before the pcall exists (`mlua-0.10.5/src/util/error.rs:165,226`). Lua 5.1 has a primitive with no such window — `lua_cpcall`, declared at `mlua-sys-0.6.8/src/lua51/lua.rs:189`, which builds its C closure *inside* `luaD_pcall`, after protection is up. Using it in mlua's `protect_lua_call`/`protect_lua_closure` would close the window with each protected unit staying tiny and Drop-free, i.e. soundly. That is a change to mlua (a fork, or upstream), it has to carry the `error_traceback` message handler and the argument-passing convention across, and it would need revalidating against every mlua call the bridge makes. Unbounded for this repo, and worth filing upstream rather than patching here.
- **opus-protframe** (2026-08-01T00:00:00.000Z): No test could have gated a fix anyway, and this was already measured — `bridge/crates/bridge-core/src/lib.rs:588-602` records a sweep of 0..400 KB of headroom in 8-byte steps through `emit_openrpc_json`, all of which errored and none of which took the runner down, because `MemoryState::relax_limit_with` makes an mlua-owned state immune at exactly the seam under test. Injecting a raw `lua_error` at the registration seam instead (the `#[ignore]`d probe's shape, `bridge/crates/bridge-core/src/lua_panic.rs:410-432`) would prove only that a frame exists — which the two `pcall`s above already guarantee — while performing the very longjmp-over-Rust-frames the previous entry rejects. So: no code changed, nothing to gate.
- **opus-protframe** (2026-08-01T00:00:00.000Z): Restoring the original trigger, with the scope now narrowed rather than merely deferred. The phases that are genuinely NOT under a `pcall` of ours are the serving-time ones — the queue pump entered from `timer.scheduleFunction`, and the GUI hook callbacks DCS's C++ calls directly — and whether DCS protects those is unknown from here. Which is precisely what #62's evidence line reports: `Phase::Ready` ("serving, after the module finished loading") in a real `dcs_studio_*.log` would mean the exposure is in serving, not registration, and this card is aimed at the wrong seam entirely. The log line remains the right trigger, and it now decides *where* as well as *whether*.
