---
column: blocked
labels: [bug, bridge, extension]
priority: high
agent: opus-live-dcs
live: false
status: inconclusive live 2026-07-29 — DCS crashes on mission unload here, so the at-menu state is unreachable
updatedAt: 2026-07-29T18:25:00.000Z
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
- **opus-live-dcs** (2026-07-29T18:25:00.000Z): Attempted the two-mission run live, in the same session as card 03, and the verdict is **inconclusive — neither confirmed nor refuted.** The blocker is environmental, not analytical: **this DCS install reliably dies when a mission is unloaded back to the main menu.** Reproduced three times, three different ways — `DCS.stopMission()` via the GUI bridge, and twice by clicking QUIT in the in-sim pause menu. `dcs.log` shows the unload proceeding normally (`Dispatcher: Stop`, Tacview closing, `lSystem::CleanScenes()`, then the menu terrain starting to load) and then the process is simply gone, with no `.dmp` written today and no `lua_atpanic` line in either bridge log. So the state #32 is about — DCS alive, sitting at the main menu, previous mission gone — was never reachable on this machine, and a second mission could never be started to complete the experiment.
- **opus-live-dcs** (2026-07-29T18:26:00.000Z): What I *did* observe, at 500 ms sampling from the moment QUIT was clicked, mission running and both bridges healthy beforehand (`:25569` OK, `:25570` OK, `DCS.getModelTime()` = 30.1, `debug_state` answering in 103 ms, and `netstat` showing 25570 both `Listen` and one `Established` connection from the extension): `t+0.0s proc=alive gui=OK mission=OK` → `t+1.6s proc=alive gui=OK mission=down` → `t+4.1s proc=alive gui=down mission=down` → `t+10.9s proc=GONE`. The mission bridge stopped accepting **2.5 s before** the GUI bridge did, while the process was still alive — the ordering you would expect if the mission listener really does go away with the mission. That points *against* #32's premise. But I will not call it a refutation: the GUI bridge going down too proves this was a crashing teardown, not a clean return to menu, so I cannot separate "the mission listener closed because the mission ended" from "everything died at once". Screenshots of each step are in the session scratchpad.
- **opus-live-dcs** (2026-07-29T18:27:00.000Z): One piece of genuinely new evidence that is *not* confounded, and it sharpens the issue. The predicted user-visible symptom — `mission.connected` true while a mission call times out instead of failing fast — **does occur live, just via a different trigger than #32 assumed.** Whenever the mission Lua state exists but no model-time pump is running (mission loaded and sitting on the briefing screen, or the sim paused), `GET :25570/health` returns a healthy `{"name":"dcs-studio-mission","env":"mission","status":"OK"}` while `eval` and `rpc.discover` on the same port **time out at the full 30 s**. Observed repeatedly. The mission bridge pumps per 0.1 s of *model* time (`bridge/crates/bridge-mission/lua/mission_init.lua`), and model time is frozen while paused. So the seam `src/core/domain/bridgeProtocol.ts:18-22` describes is real and reachable today — reachability is not liveness — but the trigger to reproduce it is "paused / on the briefing screen", which is far easier to hit than an exit to menu and does not need a mission unload at all. Whoever picks the fix up should reproduce it that way rather than fighting the unload crash. Keeping the card in `blocked` and the TODO at `src/bridge/clients.ts:14` in place, and **not** proposing #32 be closed — the diagnosis is looking more right than wrong, just not proven the way #32 asked for.
