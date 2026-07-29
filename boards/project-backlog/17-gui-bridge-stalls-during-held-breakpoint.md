---
column: todo
labels: [bug, bridge]
priority: high
updatedAt: 2026-07-29T19:20:00.000Z
---
# A held mission breakpoint stalls the GUI bridge entirely

Found by card 03's live session (journalled there, and on
[#65](https://github.com/flying-dice/dcs-studio/issues/65)): while a mission
breakpoint is held, the mission bridge stays responsive (`debug_state` in
24–108 ms) but **every call to the GUI bridge on `:25569` times out at the
30 s server deadline for the entire duration of the pause**, spamming
`deadline has elapsed` into the log. Pausing at a breakpoint makes the status
bar and every GUI-side feature look broken for as long as the user inspects
state — which is the whole point of a breakpoint.

Likely seam: the GUI bridge drains its queue per `onSimulationFrame`, and a
held mission breakpoint (or a paused sim generally — card 04's session showed
the same symptom from the briefing screen for the *mission* pump) stops the
frame callbacks the pump depends on. Confirm the mechanism before fixing.

Related: card 04 / #32 — same family of "socket state and pump liveness
disagree" problems; a fix here should be designed with that card's
`dcsTime`-freshness idea in view rather than independently.

## Checklist

- [ ] Confirm the mechanism: does `onSimulationFrame` stop firing while a mission breakpoint is held / the sim is paused?
- [ ] Decide the fix (pump GUI queue from a callback that survives a pause, or fail fast with a "sim paused" answer instead of a 30 s timeout)
- [ ] Live-verify: hold a breakpoint, confirm GUI-side calls either work or fail fast with a truthful message
