---
name: dcs-dev
description: Work with DCS locally — deploy the dcs-bridge DLL, launch/control/shut down the sim, and run live tests against the in-DCS JSON-RPC bridge. Use when asked to test the bridge in real DCS, launch the sim, eval Lua inside DCS, or verify dcs-bridge-client/app changes against a live instance.
---

# DCS local development mode

There is **one bridge**: the `dcs-bridge` crate (package name unchanged) builds `dcs_studio.dll`, loaded by the `DcsStudio.lua` GameGUI hook — the same artifacts the dcs-studio app installs for end users (`crates/app/src/inject.rs`). Claude uses this same bridge to control DCS; the `eval` RPC method is the control surface. Everything below was verified live on this machine (2026-06-10, DCS 2.9.26.23303).

## Machine facts

| What | Where |
|---|---|
| DCS install | `D:\Program Files\Eagle Dynamics\DCS World OpenBeta` (registry: `HKCU:\Software\Eagle Dynamics\DCS World OpenBeta`, `Path` value) |
| Executable | `<install>\bin\DCS.exe` |
| Write dir | `C:\Users\jonat\Saved Games\DCS.openbeta` |
| Hook (deployed) | `<writedir>\Scripts\Hooks\DcsStudio.lua` |
| DLL (deployed) | `<writedir>\Mods\tech\DcsStudio\bin\dcs_studio.dll` |
| Hook (source of truth) | `crates/dcs-bridge/deploy/Scripts/Hooks/DcsStudio.lua` (also embedded into the app via `include_str!` in `inject.rs`) |
| DCS log | `<writedir>\Logs\dcs.log` (fresh each launch; hook lines tagged `DCS-STUDIO`) |
| Bridge log | `<writedir>\Logs\dcs_studio.log` (written by the DLL, truncated each load) |
| Version/modules | `<install>\autoupdate.cfg` (JSON) |

## Setup: build + deploy

```powershell
.\crates\dcs-bridge\deploy\deploy.ps1   # cargo build -p dcs-bridge --release + install DLL & hook
```

The DLL links against DCS's `lua.dll` via the root `.cargo/config.toml` (`LUA_LIB`/`LUA_LIB_NAME`) — do not remove that config. **The DLL is file-locked while DCS runs**: shut DCS down (see teardown) before redeploying. Never edit the deployed hook copy — edit the repo source and re-run deploy.ps1.

## Launch

```powershell
Start-Process "D:\Program Files\Eagle Dynamics\DCS World OpenBeta\bin\DCS.exe" -ArgumentList '--no-launcher'
```

**`--no-launcher` is mandatory** — without it DCS opens the interactive launcher UI and waits forever for a click. Boot to main menu (hook loaded, server up) takes ~30 s here; allow up to 5 min. Poll readiness:

```powershell
Invoke-RestMethod "http://127.0.0.1:25569/health"   # {"name":"dcs-bridge","status":"OK","version":"0.1.0"}
```

If health never comes up: check `dcs.log` for `DCS-STUDIO` lines (hook load failure), then `dcs_studio.log` (server/port failure). Port 12080 belongs to the user's dcs-fiddle hook — unrelated.

## Drive it

The bridge serves JSON-RPC on `127.0.0.1:25569`: `POST /rpc`, WebSocket `/ws` (what the app/dcs-bridge-client uses), `GET /health`. Request `id` must be a **string or absent** (numeric ids are rejected; absent id = notification, no reply). Requests queue in the DLL and drain on `onSimulationFrame` — which fires **even at the main menu**, so RPC works from boot; `DCS.getModelTime()` stays 0 until a mission runs. Server-side timeout is 5 s.

Methods registered in `DcsStudio.lua`:

```powershell
# ping
Invoke-RestMethod -Uri http://127.0.0.1:25569/rpc -Method Post -ContentType application/json `
  -Body '{"jsonrpc":"2.0","method":"ping","id":"1"}'
# -> {"jsonrpc":"2.0","id":"1","result":{"pong":true,"dcs_time":0}}

# eval — run arbitrary Lua in the GUI/hooks environment, return value serialized back
Invoke-RestMethod -Uri http://127.0.0.1:25569/rpc -Method Post -ContentType application/json `
  -Body '{"jsonrpc":"2.0","method":"eval","id":"2","params":{"code":"return DCS.getModelTime()"}}'
```

`eval` gives full hooks-API access (`DCS.*`, `net.*`, `lfs`, `log`) — start missions, inspect state, add ad-hoc probes without rebuilding. To grow the permanent RPC surface, add methods to the hook's router and redeploy.

## UI paths to the same bridge

- **Lua Console** in the app: bottom tool window in the IDE, and standalone at `/console` (`src/lib/components/LuaConsole.svelte`). Executes via `dcsCall("eval", { code })`.
- `dcsCall` (`src/lib/api.ts`) routes through the Rust dcs-bridge-client under Tauri, and **falls back to a direct browser WebSocket** (`src/lib/dcs-ws.ts`) when running in plain `vite dev` — so the UI is fully usable against live DCS without the Tauri shell.

## E2E suite (Playwright)

`pnpm test:e2e` — drives the real UI at `/console` against a **real DCS instance**:

- `e2e/global-setup.ts` reuses a running bridge, else launches `DCS.exe --no-launcher` (override path with `DCS_EXE` env var) and polls `/health` for up to 5 min.
- `e2e/global-teardown.ts` shuts DCS down via the `DCS.exitProcess()` eval — only if the suite started it; a developer's running instance is left alone.
- `e2e/lua-console.spec.ts` covers: returned values, table→JSON serialization, reaching the real hooks env (`lfs.writedir()`), Lua error surfacing, and consecutive evals sharing one Lua state.
- Cold run ≈ 1 min (DCS boot); warm run (DCS already up) ≈ 15 s. One worker on purpose — all tests share the single DCS.

## Teardown

Prefer the in-process exit (clean, verified):

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:25569/rpc -Method Post -ContentType application/json `
  -Body '{"jsonrpc":"2.0","method":"eval","params":{"code":"DCS.exitProcess()"}}' | Out-Null
```

No `id` → notification, returns immediately; the process is gone within ~15 s (confirm with `Get-Process DCS`). Fall back to `Stop-Process -Name DCS -Force` only if RPC is unresponsive.

## Test checklist for bridge/DLL changes

1. `cargo test -p dcs-bridge -p dcs-bridge-client` for the pure-Rust parts
2. Shut down DCS if running → `deploy.ps1` → launch with `--no-launcher`
3. Poll `/health` until OK (≤5 min)
4. Exercise the changed surface via `/rpc` (and `/ws` for dcs-bridge-client changes)
5. On failure read `dcs_studio.log` first (Rust side), then `dcs.log` `DCS-STUDIO` lines (Lua side)
6. Teardown via the `DCS.exitProcess()` eval

Never leave DCS running after tests, and don't touch the user's other hooks (`dcs-fiddle-*`, `TacviewGameGUI`) or `Config\` in the write dir.
