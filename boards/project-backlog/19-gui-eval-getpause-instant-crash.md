---
column: todo
labels: [bug, bridge]
priority: high
updatedAt: 2026-07-29T22:10:00.000Z
---
# `DCS.getPause()` / `DCS.getMissionLoaded()` via GUI-bridge eval crash DCS instantly

Incidental find from card 18's discriminator session (journalled there):
evaluating `DCS.getPause()` or `DCS.getMissionLoaded()` through the GUI
bridge's `eval` kills DCS on the spot — `C0000005 ACCESS_VIOLATION` in
`lua_pushnil` under a deeply recursive `ED_lua_copyindex` chain. Unlike the
card-18 unload crash, this one *does* write a `.crash`/`.dmp` pair
(`Logs\dcs.20260729-193806.crash` on this machine; sim log archived in the
session scratchpad as `dcs-D0-probecrash.log`).

Any user with the Lua console open can type these — they are obvious,
documented-looking DCS control API getters — and take their sim down with one
Enter. The bridge should deny or wrap them before a user finds this the hard
way.

Open questions for whoever picks this up:

- Is the fault in ED's serialization of those getters' return values across
  the GameGUI state (the `ED_lua_copyindex` recursion suggests the result
  table is cyclic or huge), and are other `DCS.*` getters affected?
- Deny-list vs safe-wrap: a pcall inside the eval chunk will NOT help if the
  fault is a hard access violation in the C layer — test whether any Lua-side
  guard survives it before choosing a shape.
- The eval path is `bridge/crates/bridge-core/lua/gui_methods.lua:99`
  (`loadstring`); the fix likely belongs where results are serialized back.

## Checklist

- [ ] Reproduce in a throwaway sim session; capture whether pcall contains it
- [ ] Survey which other `DCS.*` getters trigger the same recursion
- [ ] Implement deny/wrap with a truthful error message to the console user
- [ ] Cover the guard in the Rust suite; live-verify the console no longer crashes the sim
