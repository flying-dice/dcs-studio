# DCS Studio (VS Code extension) — preview

A bootstrap of the DCS Studio toolchain as a VS Code extension, focused on the
**mod-consumer experience**: browsing and installing community mods from the
Marketplace. It ships with sample data so the full UX runs offline, with no DCS
install, no GitHub sign-in and no Rust backend.

## Run it

```
npm install
npm run compile
```

Then press **F5** ("Run Extension") to launch an Extension Development Host. In
the new window:

- Click the **DCS Studio** icon in the activity bar → **Browse the Marketplace**,
  or
- Run **DCS Studio: Open Marketplace** from the Command Palette, or
- Click **DCS Marketplace** in the status bar.

### What you can try

- **Storefront** — search, filter by tag (click a card tag or use the dropdown),
  sort by stars/name, refresh.
- **Product page** — click any card. Rendered README, install plan (source →
  DCS folder), required stock modules (with owned/missing
  verdicts), download size and release assets.
- **Install flow** — click **Install** to watch the simulated per-node
  download → link progress, then the card flips to **Installed** with an
  Uninstall action.
- **MissionScripting.lua** — a stub preview of the file the sanitization manager
  will edit (a planned port).
- **My Mods shortcut** — in My Mods, click **Add shortcut** (or run **DCS
  Studio: Add My Mods Shortcut**) to put a Desktop / Start Menu shortcut down
  that launches straight into My Mods in its own window — no project, no folder
  picker. Under the hood it's a `vscode://dcs-studio.dcs-studio/mymods` deep
  link opened with `--new-window`.

## Debug Lua inside DCS

Full VS Code debugging (breakpoints, stepping, variables, watch, debug
console) for scripts running **inside the sim**, in both Lua environments:

- **Mission** — the mission scripting sandbox (`trigger.action`, `coalition`,
  `world`, …). Needs a running mission and a desanitized
  `MissionScripting.lua` (command: **DCS Studio: Desanitize
  MissionScripting.lua**, then restart DCS).
- **GUI (hooks)** — the GameGUI state (`DCS.*`, `net.*`) where GUI hooks live.

### Use it

1. **DCS Studio: Launch DCS (with bridge)** (or Inject + start DCS yourself)
   and wait for the status bar to show the bridge online.
2. Open a `.lua` file, set breakpoints in the gutter.
3. Click the **run/debug dropdown** in the editor title (▷) and pick **Debug
   Lua in DCS Mission** / **Run Lua in DCS Mission** (or the GUI variants) —
   or press **F5** (defaults to the mission environment; add a `dcs-lua`
   launch configuration to customize).

While paused you get the call stack, Locals/Upvalues/Globals scopes with lazy
table expansion, conditional breakpoints, watches, hover evaluation, and real
assignment from the Debug Console (`x = 42` writes through `debug.setlocal`).
`print(...)` output streams to the Debug Console. Step Over/Into/Out, Pause
(break-all) and Stop (kills a runaway loop) all work; an uncaught error pauses
with the crash frames inspectable (`pauseOnError: false` disables that).

### How it works

Each environment is served by its own bridge DLL with its own JSON-RPC
server: `dcs_studio_gui.dll` in the GameGUI hook state (port 25569) and
`dcs_studio_mission.dll` in the mission scripting state (port 25570, booted
into the mission by the GUI hook at mission start — which is why
MissionScripting.lua must be desanitized). Each DLL holds its own breakpoint
registry and pause/resume flags, and its WebSocket server keeps accepting
editor requests on a background thread even while the sim thread is frozen at
a breakpoint. The debug engine (Lua, embedded in the DLLs) runs your chunk
under a scoped `debug.sethook` line hook and pumps its own RPC queue
(`jsonrpc.process_queue`) while paused. The VS Code side is an inline Debug
Adapter (`src/debug/adapter.ts`) that picks the bridge for the session's env,
maps DAP onto its `debug_*` JSON-RPC and polls `debug_state` (250 ms) for
stop/termination — a held breakpoint auto-continues after 30 s if the editor
vanishes, so a crashed editor can never freeze the sim forever. Both servers
also expose `POST /rpc` and `rpc.discover`, so scripts and LLM agents can
drive the sim with plain HTTP (see `skills/dcs-studio/SKILL.md`).

After changing the hook or DLL, re-run **DCS Studio: Inject Bridge into DCS**
(or Launch, which injects) and restart DCS to pick it up.

## How this maps to the real port

| Preview piece | Real extension |
| --- | --- |
| `media/marketplace.js` mock data | JSON-RPC to a headless Rust sidecar wrapping `studio-services` |
| Simulated install progress | `market_install_with_progress` over the sidecar; real junction/symlink linking |
| Webview storefront | Same webview shell; data comes from the sidecar instead of `__BOOTSTRAP__` |
| MissionScripting stub | CodeLens/editor-title sanitize toggle over the real file |

The storefront layout and states are a faithful reproduction of the current
SvelteKit `/marketplace` route and product page, retimed to VS Code theme tokens
so it feels native in light and dark.

## Layout

```
src/extension.ts              activation, launcher view, commands, status bar
src/marketplace/panel.ts      webview host: CSP shell, data bootstrap, host messages
src/mission/missionPanel.ts   MissionScripting.lua stub (planned port)
media/marketplace.{css,js}    storefront SPA (grid, product page, install sim)
```

## Webview previews & tests

`src/core/**` is unit-tested with Vitest (`npm test`, 100% per-file coverage —
see `vitest.config.ts`). The webviews (`media/*.js`) are vanilla JS running in
a VS Code webview with no host process, so they're covered separately with
**Playwright against standalone browser harnesses** — no VS Code, Electron or
Rust sidecar involved:

```
previews/<name>.html      loads the real media/<name>.js unmodified, stubs
                           acquireVsCodeApi via previews/harness.js, and
                           seeds fixture data from previews/fixtures/<name>.js
tests/<name>.spec.ts      Playwright specs against those harnesses, driven by
                           data-testid attributes (see the convention comment
                           atop tests/helpers.ts)
```

```
npm run preview      # serves previews/ at http://127.0.0.1:4173 for manual
                      # click-through (toasts show every posted message)
npm run test:e2e      # runs the full Playwright suite headless
npm run test:ui       # Playwright's interactive UI mode, for debugging
```

`npm test` (Vitest) and `npm run test:e2e` (Playwright) are fully isolated —
Vitest only looks under `test/**/*.test.ts`, Playwright only under
`tests/**/*.spec.ts` — so neither run picks up the other's specs.
