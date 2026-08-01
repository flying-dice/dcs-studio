---
column: done
labels: [bug, bridge, lua]
priority: low
agent: claude-wave3
live: false
updatedAt: 2026-08-02T00:30:00.000Z
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
- [ ] Live confirm the report line — queued for a future live session (see the
      journal); nothing off-sim can stand in for DCS's own stripped state

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
