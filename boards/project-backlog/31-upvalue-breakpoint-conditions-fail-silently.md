---
column: todo
labels: [bug, bridge, lua]
priority: low
updatedAt: 2026-08-01T20:40:00.000Z
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

- [ ] Guard the lazy "f" fetch behind capability
- [ ] Decide silent-false vs loud-report vs fail-open; implement with tests
- [ ] Off-sim test with a getupvalue-less state; live confirm the report line
