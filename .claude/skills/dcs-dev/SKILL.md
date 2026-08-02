---
name: dcs-dev
description: Work with DCS locally — deploy the bridge DLLs, launch/control/shut down the sim, and run live tests against the in-DCS JSON-RPC bridges. Use when asked to test the bridges in real DCS, launch the sim, eval Lua inside DCS, or verify bridge/extension changes against a live instance.
---

# DCS local development mode

There are **two bridges**, built from the cargo workspace in `bridge/`:

- **GUI bridge** — crate `dcs-bridge-gui` → `dcs_studio_gui.dll`, loaded by the `DcsStudio.lua` GameGUI hook. JSON-RPC on `127.0.0.1:25569`. Up whenever DCS runs; serves the `gui`/`server`/`config`/`export` environments. The `eval` RPC method is the control surface for driving DCS.
- **Mission bridge** — crate `dcs-bridge-mission` → `dcs_studio_mission.dll`, `require`d into the mission scripting state by a boot snippet the GUI hook dispatches at mission start (needs a **desanitized MissionScripting.lua**). JSON-RPC on `127.0.0.1:25570`. Up only while a mission runs; serves the `mission` environment directly.

Shared code (debugger, JSON-RPC server/router, Lua surface) lives in crate `dcs-bridge-core`. Statics are per-DLL — each bridge owns the debugger/console state for its own Lua state.

## Machine facts

| What | Where |
|---|---|
| DCS install | `D:\Program Files\Eagle Dynamics\DCS World OpenBeta` (registry: `HKCU:\Software\Eagle Dynamics\DCS World OpenBeta`, `Path` value) |
| Executable | `<install>\bin\DCS.exe` |
| Write dir | `C:\Users\jonat\Saved Games\DCS.openbeta` |
| Hook (deployed) | `<writedir>\Scripts\Hooks\DcsStudio.lua` |
| DLLs (deployed) | `<writedir>\Mods\tech\DcsStudio\bin\dcs_studio_gui.dll` + `dcs_studio_mission.dll` |
| Hook (source of truth) | `bridge/hook/DcsStudio.lua` (what the extension ships/injects) |
| MissionScripting.lua | `<install>\Scripts\MissionScripting.lua` (desanitize via the extension command, or toggle the sanitize block manually) |
| DCS log | `<writedir>\Logs\dcs.log` (fresh each launch; hook + boot lines tagged `DCS-STUDIO`) |
| Bridge logs | `<writedir>\Logs\dcs_studio_gui.log` and `dcs_studio_mission.log` (per-DLL, APPENDED never truncated — rolled to `.log.1` at 8 MiB, so both survive a mission change and a DCS restart) |
| Version/modules | `<install>\autoupdate.cfg` (JSON) |

## Setup: build + deploy

```powershell
.\bridge\deploy\deploy.ps1   # cargo build --release (both DLLs) + install DLLs & hook
```

The DLLs link against DCS's `lua.dll` via `bridge/.cargo/config.toml` (`LUA_LIB`/`LUA_LIB_NAME`) — do not remove that config. **The DLLs are file-locked while DCS runs** (the mission DLL from the first mission until process exit): shut DCS down (see teardown) before redeploying. Never edit the deployed hook copy — edit `bridge/hook/DcsStudio.lua` and re-run deploy.ps1.

## Launch

```powershell
Start-Process "D:\Program Files\Eagle Dynamics\DCS World OpenBeta\bin\DCS.exe" -ArgumentList '--no-launcher'
```

**`--no-launcher` is mandatory** — without it DCS opens the interactive launcher UI and waits forever for a click. Boot to main menu (hook loaded, GUI server up) takes ~30 s here; allow up to 5 min. Poll readiness:

```powershell
Invoke-RestMethod "http://127.0.0.1:25569/health"   # {"name":"dcs-studio-gui","env":"gui","status":"OK","version":...}
```

The mission bridge only answers once a mission is running (and MissionScripting.lua is desanitized):

```powershell
Invoke-RestMethod "http://127.0.0.1:25570/health"   # {"name":"dcs-studio-mission","env":"mission",...}
```

If health never comes up: check `dcs.log` for `DCS-STUDIO` lines (hook load / mission boot failure), then the per-DLL bridge log (server/port failure). Port 12080 belongs to the user's dcs-fiddle hook — unrelated.

## Driving the DCS UI

RPC alone gets stuck: DCS boots into modals that no amount of JSON-RPC clears. Expect to drive the actual window, and expect the obvious approaches not to work.

**Keyboard: DirectInput only.** DCS reads the keyboard through DirectInput, so `SendKeys`, `WM_KEYDOWN` and every other message-posting trick are **silently ignored** — the call succeeds and nothing happens. Use `SendInput` with `KEYEVENTF_SCANCODE` and send scan codes, not virtual key codes (ESC = `0x01`). Even the scancode route is unreliable for ESC when the window focus is ambiguous (2026-08-02 live session: ESC never opened the pause menu).

**Pausing the sim: use RPC, not the keyboard.** `DCS.setPause(true)` / `DCS.setPause(false)` eval'd through the GUI bridge is headless, deterministic, and verified live — it stalls/recovers the mission pump exactly like the ESC menu. Prefer it for every pump-stall or pause test; reach for keystrokes only when a modal needs dismissing.

**Mouse: make the process DPI-aware first.** The display here is 3840x2160 at 150% scaling. Without `SetProcessDPIAware()` the coordinates you pass `SetCursorPos` are interpreted in the virtualized 2560x1440 space, so every click lands 1.5x off — usually on nothing, occasionally on the wrong button. Call `SetProcessDPIAware()` **before** the first `SetCursorPos`.

**Modals that block boot**, in the order they tend to appear:

- ED's **"Authorization failed (error code 504)"** — appears at startup and blocks everything behind it. Must be dismissed or the sim never reaches the main menu.
- **Unit-type warnings** when a mission loads.
- The **briefing screen**: BRIEFING → FLY.

**Wait on the log, not on a stopwatch.** Fixed sleeps are either too short on a cold start or wasted on a warm one. Poll `dcs.log` for:

```
loadMission Done: Control passed to the player
```

That line is the mission actually being playable, which is what the mission bridge's readiness depends on.

**Mission control from the GUI eval** (port 25569 — remember `id` must be a string):

- `DCS.startMission(path)` works headless; no UI interaction needed to start one.
- `DCS.stopMission()` is safe as of card 18's fix — the crash it used to cause was the bridge's lifetime bug, not the call.
- `DCS.startMission` **while a mission is already running is a silent no-op** — no error, no result telling you so. Stop first, or you will be debugging a "mission that did not change" for a while.
- `DCS.getMissionLoaded()` is blocked by the RT guard and crashes DCS if you route around it (card 19). Use `DCS.getMissionName()` — empty string at the main menu.

## Drive it

Each bridge serves JSON-RPC on its port: `POST /rpc`, WebSocket `/ws` (what the extension uses), `GET /health`. Request `id` must be a **string or absent** (numeric ids are rejected; absent id = notification, no reply). Requests queue in the DLL and drain on the sim thread — the GUI bridge per `onSimulationFrame` (fires even at the main menu, so RPC works from boot; `DCS.getModelTime()` stays 0 until a mission runs), the mission bridge per 0.1 s of **model time** (stalls while the sim is paused). Server-side timeout is 30 s.

**Call `rpc.discover` first** — it returns the full method catalog (names, descriptions, params) of that bridge:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:25569/rpc -Method Post -ContentType application/json `
  -Body '{"jsonrpc":"2.0","method":"rpc.discover","id":"0"}'

# ping
Invoke-RestMethod -Uri http://127.0.0.1:25569/rpc -Method Post -ContentType application/json `
  -Body '{"jsonrpc":"2.0","method":"ping","id":"1"}'
# -> {"jsonrpc":"2.0","id":"1","result":{"pong":true,"dcs_time":0}}

# eval — run arbitrary Lua in the GUI/hooks environment, return value serialized back
Invoke-RestMethod -Uri http://127.0.0.1:25569/rpc -Method Post -ContentType application/json `
  -Body '{"jsonrpc":"2.0","method":"eval","id":"2","params":{"code":"return DCS.getModelTime()"}}'

# eval in the MISSION state (port 25570, mission running)
Invoke-RestMethod -Uri http://127.0.0.1:25570/rpc -Method Post -ContentType application/json `
  -Body '{"jsonrpc":"2.0","method":"eval","id":"3","params":{"code":"return timer.getTime()"}}'
```

GUI `eval` gives full hooks-API access (`DCS.*`, `net.*`, `lfs`, `log`) — start missions, inspect state, add ad-hoc probes without rebuilding. `mission_boot` (GUI bridge) re-dispatches the mission-bridge boot into a running mission. To grow the permanent RPC surface, add methods to the hook's router (GUI) or `bridge/crates/bridge-mission/lua/mission_init.lua` (mission) and redeploy.

## Live test suites (run with the sim up)

Rust unit tests are Windows-gated on a real Lua 5.1 — put DCS's own `lua.dll` on PATH first:

```powershell
$env:PATH = "D:\Program Files\Eagle Dynamics\DCS World OpenBeta\bin;$env:PATH"
cd bridge
cargo test --workspace
```

(On a non-Windows host the tests run without any of that: `bridge-core`'s
build.rs links PUC liblua5.1, which is the same 5.1 ABI DCS ships. That is how
CI runs them.)

After an intentional surface change, refresh the checked-in goldens —
`crates/bridge-{gui,mission}/types/*.d.lua` and the OpenRPC documents — by
re-running the suite with `DCS_STUDIO_REGENERATE_GOLDENS=1` set.

## Teardown

Prefer the in-process exit (clean, verified):

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:25569/rpc -Method Post -ContentType application/json `
  -Body '{"jsonrpc":"2.0","method":"eval","params":{"code":"DCS.exitProcess()"}}' | Out-Null
```

No `id` → notification, returns immediately; the process is gone within ~15 s (confirm with `Get-Process DCS`). Fall back to `Stop-Process -Name DCS -Force` only if RPC is unresponsive.

## Test checklist for bridge/DLL changes

1. `cd bridge; cargo test --workspace` (plus `--include-ignored` with lua.dll on PATH) for the Rust parts; `npm test` for the extension
2. Shut down DCS if running → `.\bridge\deploy\deploy.ps1` → launch with `--no-launcher`
3. Poll `:25569/health` until OK (≤5 min); for mission work, start a mission (desanitized MissionScripting.lua) and poll `:25570/health`
4. Exercise the changed surface via `/rpc` (and `/ws` for client changes) on the right port
5. On failure read the per-DLL bridge log first (Rust side), then `dcs.log` `DCS-STUDIO` lines (Lua side)
6. Teardown via the `DCS.exitProcess()` eval

Never leave DCS running after tests, and don't touch the user's other hooks (`dcs-fiddle-*`, `TacviewGameGUI`) or `Config\` in the write dir.
