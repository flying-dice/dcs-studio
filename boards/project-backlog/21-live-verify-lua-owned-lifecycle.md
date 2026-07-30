---
column: review
labels: [bridge, tests]
priority: high
agent: opus-live4
live: false
updatedAt: 2026-07-30T02:10:00.000Z
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

- [x] Deploy from the tree; one mission, bridge genuinely serving + editor connected, ESC→QUIT — clean unload through the menu rebuild, teardown diagnostic line present
- [x] Second mission in the same process — fresh bind on 25570 serves; quit clean again
- [x] The missed-event arm if achievable (e.g. end the mission by a path that skips S_EVENT_MISSION_END, or force-skip the handler): confirm the GC backstop stops the listener and the process survives — **not achievable: every exit path tried fires the event (see journal); the arm stays unobserved, not failed**
- [x] GUI bridge untouched at the menu throughout
- [x] Card 04's status-bar behaviour unchanged (`DCS: at menu` after unload)

## Comments

- **opus-live4** (2026-07-30T02:05:00.000Z): **VERDICT: the Lua-owned lifecycle passes live — 4/4 clean unloads in one DCS process at the shipped `warn`, three via ESC→QUIT and one via `DCS.stopMission()` over GUI eval, all with the mission bridge genuinely serving.** Deployed from this tree on `live-verification-4` (`bridge/deploy/deploy.ps1`, both DLLs + hook), launched `--no-launcher`, GUI bridge OK at 02:44:08 local (~29 s boot). Stock A-10A IA Caucasus Free flight loaded via `DCS.startMission`, FLY clicked from the briefing each run. **Mission 1:** 13/13 mixed requests (`ping`/`eval`/`debug_state`/`console_read` across BOTH ports, editor's 2 s poll + WS live throughout), QUIT clicked 02:48:32.51 local, `Dispatcher (Main): Stop` 01:48:32.158Z, diagnostic `DCS Studio: mission bridge released 20 Lua handler(s), failed 3 queued request(s) and stopped its HTTP server on port 25570 on mission end` at 01:48:32.851Z (0.69 s after Stop, from bridge/crates/bridge-mission/lua/mission_init.lua:103-126), then `DCSSceneRenderer initialized` → `Created boot pool: n:24` → `enterToState_:3`, **alive at t+107 s** with `gui=OK mission=down` sampled every ~7 s from t+8 s. **Mission 2 (same process, the fresh-bind arm):** `mission bridge serving JSON-RPC on 127.0.0.1:25570` fresh at 01:51:14.123Z, no `failed to start` anywhere, 12/12 mixed requests on the new server, QUIT → Stop 01:52:16.966Z → same diagnostic (3 queued failed) 0.62 s later → full menu rebuild, alive past t+64 s. **Mission 4 (the last one):** QUIT → Stop 02:00:58.898Z → diagnostic 0.75 s later → `Created boot pool`, alive at t+36 s and through final probing. Logs archived in the session scratchpad as `s4-CLEAN-dcs.log`, `s4-{gui,mission}.log`, exercise traces `s4-run{1,2}-exercise.txt`.
- **opus-live4** (2026-07-30T02:06:00.000Z): **The missed-event arm was pursued honestly and is NOT reachable from any exit path this machine offers — journalled as unobserved, not failed.** Route 1, `DCS.stopMission()` via GUI-bridge eval (mission 3, served requests first): the event **still fires** — the diagnostic line reads `…stopped its HTTP server on port 25570 on mission end` at 01:54:34.865Z, 0.62 s after Stop, clean unload, alive past t+63 s. Route 2, a direct mission→mission transition (`DCS.startMission` evaluated while a mission was running, hoping the old state dies without its end event): **it is a no-op** — the eval returned `null` at 7 ms, no new `loadMission Done`, no Stop, mission A kept running and pumping; DCS apparently ignores `startMission` from within a running mission on this build. With those exhausted, the tally is now **12/12 live unloads across four sessions firing `S_EVENT_MISSION_END`** (this session's 4, session 3's 2, plus the 6 in card 18's history), and the `lua_close` GC backstop (`Drop` from `__gc`, bridge/crates/bridge-core/src/jsonrpc/server.rs:515-534) has never once been exercised inside DCS. It remains covered by the mutation-checked in-process tests (`dropping_the_server_stops_it_even_though_nobody_asked`, and assertion 0b of the lifecycle test in bridge/crates/bridge-core/src/jsonrpc/teardown.rs:283-410), which is the best evidence available until someone finds a real DCS path that skips the event.
- **opus-live4** (2026-07-30T02:07:00.000Z): **Items D and the card-04 regression check both pass.** The GUI bridge on :25569 was probed at the menu after every unload — `eval` of `DCS.getModelTime()` → `0` in 67 ms, `ping` 7 ms, `/health` `pump_idle_ms` 2 / `pump_stalled: false` — and its liveness sampler read `gui=OK` unbroken across all four unloads while `mission=down` within seconds of each Stop, i.e. the mission listener died on schedule and the GUI listener was provably never collateral (the identity check at bridge/crates/bridge-core/src/jsonrpc/teardown.rs:124-127 holding under the userdata surface). The VS Code status bar read **`DCS: mission Ns`** in-mission and **`DCS: at menu`** after each unload (screenshots `s4-05-atmenu.png`, `s4-08-final-menu.png` in the session scratchpad). Incidentally this session also live-verified the new `/health` pump fields and the `-32002` fast-fail on BOTH bridges — that evidence is journalled on card 17. Environmental note unchanged from prior sessions: `Config\options.lua` is still ReadOnly, every run logs the `CreateFile(REWRITE): Access is denied.` pair — not ours. Teardown clean: DCS exited via `DCS.exitProcess()`, process confirmed gone; deployment left in place as instructed. Moving to review: A + B + D all pass, C honestly unobservable.
