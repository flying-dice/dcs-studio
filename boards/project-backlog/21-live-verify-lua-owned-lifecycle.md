---
column: todo
labels: [bridge, tests]
priority: high
updatedAt: 2026-07-30T10:05:00.000Z
---
# Live re-verify the Lua-owned server lifecycle (card 18 iteration 3)

Card 18 closed with the crash fix live-verified (2/2 clean under the kill
condition). Iteration 3 then landed the owner's architectural directive —
`jsonrpc.serve` returns userdata that owns the server; both bridges park it in
their state; `Drop` stops it even from `__gc` inside `lua_close`; both jsonrpc
DLL statics are gone — fully gated (fmt/clippy/tests green, mutation-checked)
but not yet run inside DCS.

This card is that run. It re-verifies the verified behaviour did not regress
under the new ownership, and tests the one arm no session has reached: a
mission whose `S_EVENT_MISSION_END` never fires, where the userdata's GC is
now the only thing standing between the listener and the unload.

## Checklist

- [ ] Deploy from the tree; one mission, bridge genuinely serving + editor connected, ESC→QUIT — clean unload through the menu rebuild, teardown diagnostic line present
- [ ] Second mission in the same process — fresh bind on 25570 serves; quit clean again
- [ ] The missed-event arm if achievable (e.g. end the mission by a path that skips S_EVENT_MISSION_END, or force-skip the handler): confirm the GC backstop stops the listener and the process survives
- [ ] GUI bridge untouched at the menu throughout
- [ ] Card 04's status-bar behaviour unchanged (`DCS: at menu` after unload)
