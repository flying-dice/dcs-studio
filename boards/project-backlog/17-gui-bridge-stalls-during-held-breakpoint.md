---
column: doing
labels: [bug, bridge]
priority: high
agent: opus-verify
live: false
status: "mechanism confirmed: the socket and HTTP thread stay healthy (/health in 1-2ms) while the Lua onSimulationFrame drain stops entirely — only /rpc stalls, and it recovers in 3ms on resume"
progress: 35
updatedAt: 2026-07-30T00:55:00.000Z
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

- [x] Confirm the mechanism: does `onSimulationFrame` stop firing while a mission breakpoint is held / the sim is paused? — **yes, it stops; the transport stays fine**
- [ ] Decide the fix (pump GUI queue from a callback that survives a pause, or fail fast with a "sim paused" answer instead of a 30 s timeout)
- [ ] Live-verify: hold a breakpoint, confirm GUI-side calls either work or fail fast with a truthful message

## Comments

- **opus-verify** (2026-07-30T00:55:00.000Z): **Mechanism confirmed live, and localised more sharply than the card assumed.** Held a real mission breakpoint against a live DCS: set one via `debug_set_breakpoints` on `v_card17.lua:4` (`{"count":1}`), fired `debug_run` as a *notification* so the chunk would hold the sim thread rather than block my own request, and probed both bridges while it sat there. During the hold: the **mission** bridge answered `debug_state` in **6 ms** and **40 ms** with `paused=true, running=true` — it serves its own RPC through the engine's pump, as designed. The **GUI** bridge split cleanly in two, and that split is the finding: `GET :25569/health` answered **3/3 in 1–2 ms**, while `POST :25569/rpc` (`eval` of `return 1+1`) answered **0/3**, each attempt burning my full 5 s client timeout. So the listener, the actix worker and the accepted connection are all perfectly healthy for the whole pause — **the only thing that stops is the Lua-side drain**, `server:process_rpc(router)` on `onSimulationFrame` (`bridge/hook/DcsStudio.lua:92-96`), because the held chunk owns the sim thread and DCS therefore never calls the frame callback. The card's suspected seam is right; what is new is that it is *purely* the pump, with nothing wrong at the transport layer.
- **opus-verify** (2026-07-30T00:57:00.000Z): Resume was prompt and complete, so nothing is left damaged by a hold: `debug_clear_breakpoints` returned in **48 ms**, `debug_continue` in **49 ms**, `debug_state` then read `paused=false, running=false`, and the GUI bridge answered an `eval` **3 ms** later — i.e. the stall lifts on the very next frame. That matters for the fix decision, because it means there is nothing to repair, only something to *report*: the 30 s deadline is the whole user-visible defect. Two design notes for whoever takes checklist item 2. (1) The `/health`-answers-while-`/rpc`-hangs asymmetry is exactly what misleads the extension's liveness inference in card 04 / [#32](https://github.com/flying-dice/dcs-studio/issues/32) — a healthy `/health` is not evidence that anything can be dispatched, and both cards should share one notion of "the pump is alive", as card 17's description already argues. (2) A truthful fast-fail is cheap to source: the GUI hook knows whether its frame callback has fired recently, so a request that cannot be drained could be answered "sim paused / no frames" immediately rather than after 30 s. I did **not** attempt a fix — this card is scoped to mechanism confirmation, and the session's remaining time went to the card-18 crash. Moving to `doing` with the evidence attached; the observed cost of a hold is also visible as `deadline has elapsed` spam in `dcs_studio_gui.log`, which is the extension's own status-bar poll timing out every ~2 s.
