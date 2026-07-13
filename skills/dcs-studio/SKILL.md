---
name: dcs-studio
description: How to build, run, debug and publish DCS World mods in a DCS Studio project — manifest format, install roots, mission vs GUI scripting environments, the live bridge console, the Lua debugger, and the publish flow. Use when writing DCS mods, editing dcs-studio.toml, or working in a repo created by DCS Studio.
version: 1.0.0
---

# DCS Studio — writing mods for DCS World

DCS Studio is VS Code tooling for DCS World mods: project templates, a
manifest-driven installer, a GitHub-backed marketplace, a live in-sim Lua
console, and a step debugger for Lua running inside DCS. This skill teaches
the project conventions and the workflow.

## The project manifest: dcs-studio.toml

Every DCS Studio project has a `dcs-studio.toml` at its root. It is the
source of truth for metadata, dependencies, and how files install into DCS:

```toml
[project]
name = "my-mod"
version = "0.1.0"
author = ""
description = ""
dcs_min_version = "2.9.0"

# Other Marketplace mods this one needs — installed automatically.
# `id` is the dependency's GitHub `owner/name`.
# [[dependencies]]
# id = "owner/another-mod"
# version = "*"
# optional = false

# Install rules: copy matching sources to a destination under a named root.
[[install]]
source = "Scripts/my-mod.lua"
dest = "{SavedGames}/Scripts/my-mod.lua"
```

Install destinations use **named roots**, resolved per-machine at install
time — never hard-code absolute paths:

- `{SavedGames}` → the user's DCS "Saved Games" folder (e.g. `%USERPROFILE%\Saved Games\DCS`)
- `{GameInstall}` → the DCS game install directory

Keep every file the mod ships covered by an `[[install]]` rule; the
installer copies exactly what the rules name.

Opening `dcs-studio.toml` in VS Code auto-opens a two-way-bound authoring
form beside the text editor. Bump `[project] version` for every release.

## Where DCS Lua runs: two environments

DCS has two distinct Lua environments, and code written for one does not
run in the other:

1. **Mission scripting environment** — loaded by a mission trigger
   (`DO SCRIPT FILE`, or `DO SCRIPT` with `dofile`). Available: `env`,
   `timer`, `trigger`, `world`, `coalition`. Sanitized away by default:
   `os`, `io`, `lfs`. Log with `env.info("...")`. Schedule repeating work
   with `timer.scheduleFunction(fn, arg, timer.getTime() + n)` — return the
   next wake-up time from `fn` to keep the schedule alive.

2. **GameGUI hooks environment** — every `.lua` in
   `Saved Games/Scripts/Hooks` is auto-loaded at DCS start, no mission
   needed. Available: `DCS.*`, `net`, `log`, `lfs`. Wire into simulation
   events with `DCS.setUserCallbacks({ onMissionLoadEnd = ..., onSimulationFrame = ... })`.
   Log with `log.write("tag", log.INFO, msg)`. Always `pcall` inside
   callbacks — an error in one callback must never break the GUI loop —
   and keep per-frame work tiny; a slow `onSimulationFrame` is a visible
   stutter.

Both environments log to `Saved Games/DCS/Logs/dcs.log`.

### MissionScripting.lua sanitization

DCS strips `os`/`io`/`lfs` from mission scripts via `MissionScripting.lua`.
DCS Studio's MissionScripting panel (command: `dcs.mission.open`) can
de-sanitize it for development and re-sanitize it after. A de-sanitized
install lets any mission touch the filesystem — treat it as a dev-only
state and re-sanitize when done.

## Project templates

`dcs.project.new` scaffolds from these templates:

- **Blank** — just the manifest; bring your own structure.
- **Lua Mission Script** — `Scripts/<slug>.lua` targeting the mission
  environment, installed to `{SavedGames}/Scripts/`.
- **Lua GameGUI Hook** — `Scripts/Hooks/<ident>_hook.lua`, installed to
  `{SavedGames}/Scripts/Hooks` where DCS auto-loads it.
- **Rust DLL Mod** — an mlua `cdylib` crate plus a loader hook. The Lua
  module name equals the crate `[lib]` name: `require("<ident>")` loads
  `<ident>.dll` and calls its exported `luaopen_<ident>`. The DLL installs
  to `{SavedGames}/Mods/tech/<slug>/bin`; the hook appends that folder to
  `package.cpath` before `require`. Footgun: `.cargo/config.toml` must pin
  `LUA_LIB`/`LUA_LIB_NAME` to the bundled `lua5.1/lua.lib` import library
  so the DLL links DCS's own `lua.dll` — otherwise the build succeeds but
  `require` fails silently inside DCS. Never set `panic = "abort"`; mlua
  converts Rust unwinds into Lua errors, and aborting takes DCS down with
  the mod. Build with `cargo build --release`.

## Running and debugging Lua in the live sim

DCS Studio ships a bridge (injected DLL + hook) that connects VS Code to a
running DCS instance:

- `dcs.bridge.inject` deploys the bridge into DCS; `dcs.bridge.launch`
  launches DCS with it; `dcs.bridge.eject` removes it.
- `dcs.bridge.console` opens a live Lua console — pick the mission or GUI
  environment and evaluate code in the running sim. Use this to probe APIs
  before committing to code.
- The `dcs-lua` debug type runs a Lua file inside DCS with breakpoints.
  Launch config: `{ "type": "dcs-lua", "request": "launch", "program":
  "${file}", "env": "mission" | "gui" }`. Editor title bar Run/Debug
  buttons do the same for the open Lua file. `env: "mission"` needs a
  running mission (and a de-sanitized MissionScripting.lua); `env: "gui"`
  works from the main menu.

When a mod "does nothing", check `Saved Games/DCS/Logs/dcs.log` first —
load errors, sanitization failures, and `require` failures all land there.

## Marketplace and publishing

The Marketplace discovers mods as GitHub repos tagged with the
`dcs-studio` topic; a mod's identity is its `owner/name`. Users subscribe
in the extension; downloads unpack into the DCS Studio data dir and
symlink into the DCS folders per the install rules.

To publish (`dcs.publish.open`): the guided flow runs preflight checks on
the manifest, pushes the repo to GitHub, applies the `dcs-studio` topic,
and cuts a versioned release with a packaged payload (7-Zip). Before
publishing: bump `[project] version`, make sure `[[install]]` rules cover
everything the mod needs at runtime, and fill in `author`/`description` —
the Marketplace displays them.

## Key commands reference

| Command | What it does |
| --- | --- |
| `dcs.project.new` | New project from a template |
| `dcs.manifest.author` | Create/edit the project manifest (form + text) |
| `dcs.marketplace.open` | Browse community mods |
| `dcs.mymods.open` | Manage installed mods |
| `dcs.publish.open` | Guided publish to GitHub |
| `dcs.bridge.console` | Live Lua console into the running sim |
| `dcs.bridge.inject` / `dcs.bridge.launch` | Deploy the bridge / launch DCS with it |
| `dcs.mission.open` | MissionScripting.lua sanitization panel |
| `dcs.setup.open` | Configure DCS paths (Saved Games, game install) |
