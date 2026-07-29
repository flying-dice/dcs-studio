---
column: todo
labels: [bug, bridge, extension]
priority: high
updatedAt: 2026-07-29T05:22:16.000Z
---
# Mission liveness is inferred from a socket that outlives the mission

[Issue #32](https://github.com/flying-dice/dcs-studio/issues/32), and the
in-source marker at `src/bridge/clients.ts:14-20`.

"A mission is running" is derived from `mission.connected` — a TCP socket's state
— by `combinedState`, `statusBarView` and `missionStartFailure` in
`src/core/domain/bridgeProtocol.ts:18-22`. But the mission bridge's server is a
process-wide Rust static that deliberately outlives the mission Lua state, so
after the user exits to the menu the socket stays open and `connected` stays
`true`.

The predicted symptom: the status bar reads "DCS: mission 843s" frozen at the
last mission's time, and F5 on a mission script is offered — queueing a
`debug_state` into a queue no pump will drain, so the user sees
`Mission bridge call 'debug_state' timed out` rather than "no mission running".

**Derived by reading both sides of the seam, not observed.** #32 asks for a
two-mission run to confirm before anything changes. Do it in the same live
session as card 03.

## Checklist

- [ ] Confirm against a live DCS: load a mission, exit to the menu, check the status bar and F5
- [ ] If confirmed, pick a fix — close the server per mission, or gate on a fresh `dcsTime` rather than on connectivity
- [ ] Remove the TODO at `src/bridge/clients.ts:14` when the inference changes
