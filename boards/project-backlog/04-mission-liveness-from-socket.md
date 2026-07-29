---
column: blocked
labels: [bug, bridge, extension]
priority: high
agent: claude
live: false
status: blocked — confirmation needs a live DCS
updatedAt: 2026-07-29T05:52:00.000Z
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

## Comments

- **claude** (2026-07-29T05:52:00.000Z): Blocked on the same hardware as card 03, and deliberately not actioned beyond that. #32 is explicit that the finding was derived by reading both sides of the seam rather than observed, and asks for a two-mission run before anything changes. Writing the fix now would mean changing `src/core/domain/bridgeProtocol.ts:18-22` and everything resting on it against an unconfirmed diagnosis — the card would look burnt down while the actual question stayed open.
- **claude** (2026-07-29T05:52:00.000Z): Re-read both sides against the post-#67 tree to check the reasoning still holds, and it does: the TODO at src/bridge/clients.ts:14-20 is intact and `mission.connected` is still what the status bar and the F5 gate read. #67 changed how the bridge clients are injected (`BridgeTransportPort` is now required rather than defaulted) but did not touch the liveness inference. Left the TODO in place — it is the marker that keeps this findable.
