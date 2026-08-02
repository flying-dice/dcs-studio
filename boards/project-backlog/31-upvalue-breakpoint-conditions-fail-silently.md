---
column: done
labels: [bug, bridge, lua]
priority: low
agent: claude-wave3
live: false
updatedAt: 2026-08-02T19:20:00.000Z
---
# Upvalue breakpoint conditions can never work in DCS, and they fail silently

Found by card 30's live session: `debug.getupvalue`/`setupvalue` are `nil` in
BOTH DCS Lua states (verified live, both bridges). A breakpoint condition that
references an upvalue therefore resolves the name through `_G`, gets `nil`,
and the condition is quietly false — the breakpoint never fires and nothing
says why. That is the fail-closed-silently shape the debug engine otherwise
goes out of its way to avoid (its own docs favour truthful refusals).

Two halves:

- The lazy `debug.getinfo(2, "f")` fetch in the condition branch
  (`bridge/crates/bridge-core/lua/debug_engine.lua:775` era) exists to support
  upvalue resolution that can never succeed in DCS — guard it behind
  `debug.getupvalue ~= nil` and skip the fetch in-sim.
- A condition that names an unresolvable upvalue should fail LOUD: either
  report once through the engine's throttled channel ("condition references an
  upvalue; DCS strips getupvalue — condition treated as false") or fail open
  (fire the breakpoint) — decide which is the honest shape and pin it.

## Checklist

- [x] Guard the lazy "f" fetch behind capability
- [x] Decide silent-false vs loud-report vs fail-open; implement with tests
      — LOUD REPORT, fail-closed semantics kept
- [x] Off-sim test with a getupvalue-less state
- [x] Live confirm the report line — confirmed in DCS 2026-08-02 (see journal)

## Comments

- **claude-wave3** (2026-08-01T21:40:00.000Z): Claimed off `develop` @ `631856c`.
  **Decision: loud report, fail-CLOSED.** Fail-open was the alternative the card
  offered and it is the wrong shape here: a condition exists to filter a loop, so
  firing it on every iteration replaces a silent non-stop with a noisy wrong stop —
  the user would have to read the log to learn why the debugger is stopping ten
  thousand times, which is the same log line, bought at a much higher price. A
  *broken* condition still fails open (unchanged) because there the condition has no
  meaning at all; an *unresolvable* one has a meaning the host cannot compute, and
  false is the honest answer to it as long as the reason is on the record.
  Implemented as `report_unresolved_condition`
  (`bridge/crates/bridge-core/lua/debug_engine.lua:136-171`), pcall'd around
  `bridge.logger.error` for the same reason `pump_safely`'s report is — reporting a
  fault must not become one, least of all inside the line hook where a raise loses
  the session. Throttled once per `source:line`, and the registry is dropped at each
  `D.run` (`:968-972`) so it cannot accumulate across a multi-hour DCS process and
  so a new session says it again.

- **claude-wave3** (2026-08-01T21:40:00.000Z): The detection is deliberately
  *narrower* than "names an upvalue", because from inside an evaluation that is not
  knowable — only that a name was neither a local of the frame nor a global. The
  eval proxy grew an optional `on_unresolved(name)` callback
  (`debug_engine.lua:400-410`), armed ONLY on a host without `debug.getupvalue`
  (`:838-859`): elsewhere an unresolved name is an ordinary nil global, not a
  capability gap, so nothing changes for a full host. The message says the name
  "is neither a local of that frame nor a global" and names `debug.getupvalue` as
  the reason an upvalue of that name cannot be read, rather than asserting a typo'd
  global IS an upvalue.

- **claude-wave3** (2026-08-01T21:40:00.000Z): The other half — the lazy
  `debug.getinfo(2, "f")` now sits behind `if debug.getupvalue then`
  (`debug_engine.lua:838-853`), so in DCS the conditional-breakpoint branch stops
  buying a getinfo whose result `collect_upvalues` could never use. Capability tested
  at the branch rather than left to `collect_upvalues`' own guard, because skipping
  the *fetch* is the point. Also corrected three stale comments that said the hooks
  env strips `getupvalue` while the mission env keeps it — card 30 measured it absent
  in BOTH states (`debug_engine.lua:72`, `:75`, `:310`, `:698`).

- **claude-wave3** (2026-08-01T21:40:00.000Z): Test
  `an_unresolvable_condition_is_false_but_never_silent_without_getupvalue`
  (`bridge/crates/bridge-core/tests/debug_engine_safety.rs:474-562`) drives the real
  engine on a state whose `debug.getupvalue`/`setupvalue` are removed BEFORE
  bootstrap — mirroring `engine_state(true)`'s os/timer drop, and for the same
  reason: the engine captures the debug library as private copies at install time, so
  removing them afterwards would prove nothing. It runs the sibling test's exact
  upvalue fixture and pins: no stop (fail-closed preserved), the whole loop runs,
  exactly ONE report naming `=noupval.lua:3`, `'threshold'`, `debug.getupvalue` and
  "treated as false" across ten hits, a second session reporting again, and a
  locals-only condition on the same host still stopping exactly once with nothing
  reported. The getinfo guard is pinned by a counting shim installed over
  `debug.getinfo` before bootstrap (level-shifted by one so every caller's frame of
  reference survives): zero `"f"` fetches across the run. Both assertions have teeth
  — reverting the guard to `if true then` fails it with "the frame function was still
  fetched 10 times".

- **claude-wave3** (2026-08-01T21:40:00.000Z): **Live confirmation is still owed.**
  Nothing off-sim can prove DCS's own states log this line; the fixture is a
  faithful model of them, not the thing itself. Next live session should set a
  breakpoint with an upvalue condition in the mission state and read
  `dcs_studio_mission.log` for the report — and card 32 (landing in the same commit
  series) is what makes that log survive long enough to read.
- **claude-lead** (2026-08-02T00:30:00.000Z): Reviewed and approved (delegated review authority). The fail-closed-loud decision is argued correctly against fail-open, the detection honesty (cannot know it IS an upvalue, says so) is the right shape, and the counting-shim test has verified teeth. Live confirmation rides the next sim session per the card-33 pattern. Done.

- **claude-livetrio** (2026-08-02T18:05:00.000Z): **LIVE CONFIRMED in DCS — PASS.** Session on `live-trio`, develop build deployed from the tree (`bridge/deploy/deploy.ps1`), DCS OpenBeta, mission `test.miz`, mission bridge on 25570. First the premise, measured rather than assumed — `eval` in the live mission state returned
  `getupvalue=nil setupvalue=nil getinfo=function: 00000217073403C0 sethook=function: 00000217073404B0`,
  so the capability gap card 30 found is still exactly that shape: `getinfo`/`sethook` present, the upvalue pair gone. Then the card's own fixture, driven over RPC rather than in-process: `debug_set_breakpoints` on `=noupval.lua:3` with condition `i == threshold`, then `debug_run` of the same chunk the off-sim test uses (`bridge/crates/bridge-core/tests/debug_engine_safety.rs:511-516`). Result `{"ran":true}`, `hits == 6` (the loop ran untouched, i = 5..10), `debug_state` → `{"paused":false,"running":false}` — fail-CLOSED preserved live, no stop. The mission log grew 39,236 → 39,710 bytes over the run and the new bytes are exactly ONE line, verbatim:

  ```
  2026-08-02T17:43:25.301078800+01:00 [ERROR] dcs_bridge_core::logger - breakpoint condition at =noupval.lua:3 references 'threshold', which is neither a local of that frame nor a global. This Lua state provides no debug.getupvalue (DCS strips it from both of its states), so an upvalue of that name cannot be read - the condition was treated as false and the breakpoint will not fire. Rewrite the condition over the frame's locals or a global. Reported once per breakpoint.
  ```

  Every element the card asked for is in it: the `source:line` (`=noupval.lua:3`), the name (`'threshold'`), `debug.getupvalue`, and "treated as false" — one line for ten hits, through the throttled channel, at ERROR so it survives the shipped `warn` level (`bridge/crates/bridge-core/lua/debug_engine.lua:136-171`). The fixture at `debug_engine_safety.rs:474-562` is a faithful model of DCS after all; this is the thing itself agreeing with it.

- **claude-lead** (2026-08-02T19:20:00.000Z): Live item signed off (delegated review authority). The session re-measured the premise before testing the fix, drove the card's own fixture over RPC rather than a lookalike, and diffed the log bytes so the "exactly one line" claim is byte-precise. Card fully done, no follow-ups.
