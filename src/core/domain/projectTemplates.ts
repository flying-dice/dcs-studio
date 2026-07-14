// Project templates scaffolded by the New Project flow (originally a port of
// the real app's `crates/dcs-studio-project/src/templates.rs`, since diverged:
// no lua-cargo build step here — plain scripts ship as-is, and the lua
// template is split per DCS environment). Content is generated
// programmatically (string interpolation), not copied from a template dir.
//
// Pure domain logic (no I/O): the adapter at src/project/scaffold.ts loads the
// binary assets and writes the rendered files; everything here is string math.

/** UI metadata for the New Project panel's template tiles. */
export interface TemplateMeta {
  id: string;
  label: string;
  description: string;
}

export const TEMPLATES: TemplateMeta[] = [
  {
    id: "blank",
    label: "Blank Project",
    description: "Just a dcs-studio.toml manifest — bring your own structure.",
  },
  {
    id: "lua-mission",
    label: "Lua Mission Script",
    description: "Runs in the mission scripting environment — loaded by a mission trigger.",
  },
  {
    id: "lua-hook",
    label: "Lua GameGUI Hook",
    description: "Runs in the GUI environment — auto-loaded from Scripts/Hooks at DCS start.",
  },
  {
    id: "rust-dll",
    label: "Rust DLL Mod",
    description: "Native mod: cargo project building a DLL, bundled and symlinked into DCS.",
  },
  {
    id: "mission",
    label: "Share a Mission",
    description: "Package a .miz and link it into your DCS user Missions folder.",
  },
];

/** One file to materialise, relative to the new project root. */
export interface TemplateFile {
  path: string;
  contents: string | Uint8Array;
}

/** Binary/golden assets baked into templates (loaded from bridge/ at render time). */
export interface TemplateAssets {
  /** Import library for DCS's own lua.dll (bridge/prebuilt/lua.lib, staged from bridge/lua5.1/lua.lib). */
  luaLib: Uint8Array;
}

/** Folder-safe slug: lowercase, runs of non-alphanumerics become hyphens. */
export function slugify(name: string): string {
  const collapsed = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return collapsed || "untitled";
}

// Rust keywords, strict and reserved (the rendered templates use the ident as
// a Cargo package/lib name and a `pub fn` name), plus Lua 5.1 keywords.
const KEYWORDS = new Set([
  // Rust
  "as",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "async",
  "await",
  "abstract",
  "become",
  "box",
  "do",
  "final",
  "macro",
  "override",
  "priv",
  "try",
  "typeof",
  "unsized",
  "virtual",
  "yield",
  "gen",
  // Lua 5.1
  "and",
  "elseif",
  "end",
  "function",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "then",
  "until",
]);

/**
 * Valid Rust *and* Lua identifier derived from the project name; keywords in
 * either language get the same `mod_` prefix as bad leading characters.
 */
export function luaIdent(name: string): string {
  const ident = slugify(name).replace(/-/g, "_");
  if (/^[a-z_]/.test(ident) && !KEYWORDS.has(ident)) return ident;
  return `mod_${ident}`;
}

/** Escape a value for a TOML basic (double-quoted) string. */
export function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function manifestHeader(name: string): string {
  return `# dcs-studio.toml — DCS Studio project manifest
# Generated for "${name}". Describes the mod, its files, where each installs
# to, and what it depends on. Install destinations use named roots, resolved
# per-machine at install time:
#   {SavedGames}  → your DCS "Saved Games" folder
#   {GameInstall} → your DCS game install directory
`;
}

function projectBlock(name: string, template: string): string {
  return `
[project]
name = "${tomlEscape(name)}"
version = "0.1.0"
author = ""
description = ""
template = "${template}"
dcs_min_version = "2.9.0"
`;
}

/** Render a template's files, or `undefined` for an unknown id. */
export function render(
  template: string,
  name: string,
  assets: TemplateAssets,
): TemplateFile[] | undefined {
  switch (template) {
    case "blank":
      return blank(name);
    case "lua-mission":
      return luaMission(name);
    case "lua-hook":
      return luaHook(name);
    case "rust-dll":
      return rustDll(name, assets);
    case "mission":
      return mission(name);
    default:
      return undefined;
  }
}

function blank(name: string): TemplateFile[] {
  const slug = slugify(name);
  return [
    {
      path: "dcs-studio.toml",
      contents: `${manifestHeader(name)}${projectBlock(name, "blank")}
# [[bundle]] declares what gets packed into the release archive (paths are
# relative to the project root). [[symlink]] declares which links are created
# when a user enables the mod — each source is a path inside the bundle.
# [[bundle]]
# path = "Mods/${slug}"
#
# [[symlink]]
# source = "Mods/${slug}"
# dest = "{SavedGames}/Mods/${slug}"
`,
    },
  ];
}

function luaMission(name: string): TemplateFile[] {
  const slug = slugify(name);
  const ident = luaIdent(name);
  return [
    {
      path: "dcs-studio.toml",
      contents: `${manifestHeader(name)}${projectBlock(name, "lua-mission")}
# Bundle the script into the release, then link it into Saved Games on enable.
[[bundle]]
path = "Scripts/${slug}.lua"

[[symlink]]
source = "Scripts/${slug}.lua"
dest = "{SavedGames}/Scripts/${slug}.lua"
`,
    },
    {
      path: `Scripts/${slug}.lua`,
      contents: `-- ${name}
-- DCS Studio — Lua Mission Script
--
-- Runs inside DCS's mission scripting environment, loaded from a mission
-- trigger (DO SCRIPT FILE, or DO SCRIPT with dofile). env, timer, trigger
-- and world are available; os, io and lfs are sanitized away by default.

local ${ident} = {}

${ident}.name    = "${name}"
${ident}.version = "0.1.0"

local function info(msg)
    env.info(string.format("[%s] %s", ${ident}.name, msg))
end

function ${ident}.start()
    info("loaded v" .. ${ident}.version)
    -- Repeating work goes through the timer API — return the next
    -- wake-up time to keep the schedule alive:
    -- timer.scheduleFunction(function(_, time)
    --     info("tick")
    --     return time + 60
    -- end, nil, timer.getTime() + 60)
end

${ident}.start()

return ${ident}
`,
    },
    luaMissionReadme(name, slug),
  ];
}

function luaMissionReadme(name: string, slug: string): TemplateFile {
  return {
    path: "README.md",
    contents: `# ${name}

A DCS (Digital Combat Simulator) mission script mod, scaffolded by DCS Studio.

## Layout

- \`Scripts/${slug}.lua\` — the script that ships. The manifest's [[bundle]]
  entry packs this file and the [[symlink]] entry links it as-is, so keep
  the mod self-contained in it (add more [[bundle]]/[[symlink]] entries if
  you split into more files).
- \`dcs-studio.toml\` — project manifest (metadata, bundle + symlink rules).

## Install

The manifest's [[bundle]] entries declare what ships in the release; its
[[symlink]] entries map bundled files to your DCS folders via named roots
(\`{SavedGames}\`, \`{GameInstall}\`), resolved per-machine. The scaffolded
rule links \`Scripts/${slug}.lua\` to \`Saved Games/Scripts/${slug}.lua\`.

## Where the script runs

Mission scripts run inside DCS's mission scripting environment: \`env\`,
\`timer\`, \`trigger\`, and \`world\` are available; \`os\`, \`io\`, and \`lfs\` are
sanitized away by default. Load the installed script from a mission trigger:
\`DO SCRIPT FILE\`, or \`DO SCRIPT\` with \`dofile(...)\`.

## MissionScripting.lua sanitization

DCS strips \`os\`/\`io\`/\`lfs\` from mission scripts via \`MissionScripting.lua\`.
DCS Studio's MissionScripting panel can de-sanitize it to restore them —
convenient for development, but any mission you then run can touch your
filesystem. Re-sanitize when you are done.

## Logs

\`env.info\` output lands in \`Saved Games/DCS/Logs/dcs.log\`, tagged with the
script name.
`,
  };
}

function luaHook(name: string): TemplateFile[] {
  const slug = slugify(name);
  const ident = luaIdent(name);
  return [
    {
      path: "dcs-studio.toml",
      contents: `${manifestHeader(name)}${projectBlock(name, "lua-hook")}
# Bundle the hook, then link it into Scripts/Hooks, where DCS auto-loads
# every .lua at start.
[[bundle]]
path = "Scripts/Hooks/${ident}_hook.lua"

[[symlink]]
source = "Scripts/Hooks/${ident}_hook.lua"
dest = "{SavedGames}/Scripts/Hooks"
`,
    },
    {
      path: `Scripts/Hooks/${ident}_hook.lua`,
      contents: `-- ${name} GameGUI hook.
-- Auto-loaded at DCS start from Saved Games/Scripts/Hooks into the GUI
-- environment, where DCS.*, net and log are available. Output lands in
-- your DCS log (Saved Games/DCS/Logs/dcs.log).

local ${ident} = {}

${ident}.name    = "${name}"
${ident}.version = "0.1.0"

local function info(msg)
    log.write("${slug}", log.INFO, msg)
end

local cb = {}

function cb.onMissionLoadEnd()
    -- pcall callbacks: an error in one must never break the GUI loop.
    local ok, err = pcall(function()
        info("mission loaded: " .. tostring(DCS.getMissionName()))
    end)
    if not ok then
        log.write("${slug}", log.ERROR, "onMissionLoadEnd: " .. tostring(err))
    end
end

DCS.setUserCallbacks(cb)
info("loaded v" .. ${ident}.version)
`,
    },
    luaHookReadme(name, slug, ident),
  ];
}

function luaHookReadme(name: string, slug: string, ident: string): TemplateFile {
  return {
    path: "README.md",
    contents: `# ${name}

A DCS (Digital Combat Simulator) GameGUI hook mod, scaffolded by DCS Studio.

## Layout

- \`Scripts/Hooks/${ident}_hook.lua\` — the hook that ships. The manifest's
  [[bundle]] entry packs this file and the [[symlink]] entry links it as-is,
  so keep the mod self-contained in it (add more [[bundle]]/[[symlink]]
  entries if you split into more files).
- \`dcs-studio.toml\` — project manifest (metadata, bundle + symlink rules).

## Install

The manifest's [[bundle]] entries declare what ships; its [[symlink]] entries
map bundled files to your DCS folders via named roots (\`{SavedGames}\`,
\`{GameInstall}\`), resolved per-machine. The scaffolded rule links the hook
into \`Saved Games/Scripts/Hooks\`, where DCS auto-loads every .lua at
start — no mission trigger needed.

## Where the hook runs

Hooks run in DCS's GUI environment, outside missions: \`DCS.*\`, \`net\`, and
\`log\` are available, and \`DCS.setUserCallbacks\` wires you into simulation
events (\`onMissionLoadEnd\`, \`onSimulationFrame\`, ...). Keep per-frame work
tiny — a slow callback is a visible stutter.

## Logs

The hook logs under the \`${slug}\` tag via \`log.write\` into
\`Saved Games/DCS/Logs/dcs.log\`.
`,
  };
}

// A standalone mlua cdylib mod, generalising the DCS Studio bridge: the Lua
// module name equals the crate lib name — Lua's require "<ident>" loads
// <ident>.dll and calls luaopen_<ident>.

// The literal require-with-parens snippet quoted inside generated file
// content. Assembled by concatenation so the architecture boundary test's
// import-regex never mistakes this template text for a real require() in core.
function requireExpr(mod: string): string {
  // biome-ignore lint/style/useTemplate: concatenation is load-bearing — see the comment above
  return 'require("' + mod + '")';
}
function rustDll(name: string, assets: TemplateAssets): TemplateFile[] {
  const slug = slugify(name);
  const ident = luaIdent(name);
  return [
    rustDllManifest(name, slug, ident),
    rustDllCargoToml(ident),
    {
      path: ".cargo/config.toml",
      contents: `# Link against the import library for DCS's own lua.dll (lua5.1/lua.lib).
# Without this, mlua's lua51 feature links lua51.dll — the build still
# succeeds, but require() fails silently inside DCS, which ships lua.dll.
[env]
LUA_LIB_NAME = "lua"
LUA_LIB = { value = "lua5.1", relative = true }
`,
    },
    { path: "lua5.1/lua.lib", contents: assets.luaLib },
    rustDllLibRs(name, ident),
    rustDllHook(name, slug, ident),
    rustDllReadme(name, slug, ident),
  ];
}

function rustDllManifest(name: string, slug: string, ident: string): TemplateFile {
  return {
    path: "dcs-studio.toml",
    contents: `${manifestHeader(name)}${projectBlock(name, "rust-dll")}
# Bundle the built DLL + the GameGUI hook, then link each into place — the
# DLL under Mods/tech, the hook under Scripts/Hooks (the DCS Studio bridge
# layout).
[[bundle]]
path = "target/release/${ident}.dll"

[[bundle]]
path = "Scripts/Hooks/${ident}_hook.lua"

[[symlink]]
source = "target/release/${ident}.dll"
dest = "{SavedGames}/Mods/tech/${slug}/bin"

[[symlink]]
source = "Scripts/Hooks/${ident}_hook.lua"
dest = "{SavedGames}/Scripts/Hooks"
`,
  };
}

function rustDllCargoToml(ident: string): TemplateFile {
  return {
    path: "Cargo.toml",
    contents: `# The package name reuses the lib ident: a slug like "123" is not a
# valid Cargo package name (leading digit), but the ident always is.
[package]
name = "${ident}"
version = "0.1.0"
edition = "2021"

# The lib name is the Lua module name: ${requireExpr(ident)} looks for
# ${ident}.dll exporting luaopen_${ident} — keep it in sync with the hook.
[lib]
name = "${ident}"
crate-type = ["cdylib"]

[dependencies]
mlua = { version = "0.10", features = ["lua51", "module", "serialize", "macros"] }

# Do NOT set panic = "abort" for release: mlua converts Rust unwinds
# into Lua errors; aborting would take DCS down with the mod.
`,
  };
}

function rustDllLibRs(name: string, ident: string): TemplateFile {
  const identUpper = ident.toUpperCase();
  return {
    path: "src/lib.rs",
    contents: `// ${name} — DCS native Lua module (mlua cdylib).
//
// #[mlua::lua_module] generates the luaopen_${ident} entry point that
// Lua's ${requireExpr(ident)} resolves inside ${ident}.dll. The function
// name below IS the module name — it must match the [lib] name.
//
// FFI rules: mlua wraps callbacks so Rust panics become Lua errors,
// but don't lean on it — no unwrap/expect in callbacks; return
// LuaResult and let errors raise in Lua, never unwind across FFI.
use mlua::prelude::*;
use std::sync::atomic::{AtomicU64, Ordering};

// Frames pumped so far. Atomic, not a Mutex: on_frame runs on DCS's
// main loop every simulation frame and must never block.
static FRAMES: AtomicU64 = AtomicU64::new(0);

#[mlua::lua_module]
pub fn ${ident}(lua: &Lua) -> LuaResult<LuaTable> {
    // The hook sets the ${identUpper} global BEFORE require() — the same
    // plain-global config pattern the DCS Studio bridge reads (DCS_BRIDGE).
    let config: Option<LuaTable> = lua.globals().get("${identUpper}").ok();
    let log_level: String = config
        .and_then(|t| t.get("log_level").ok())
        .unwrap_or_else(|| "info".to_string());
    let verbose = log_level == "debug";

    let exports = lua.create_table()?;
    // Prove the load from Lua: print(${requireExpr(ident)}.version)
    exports.set("version", env!("CARGO_PKG_VERSION"))?;
    // The effective level, so Lua can confirm what was honoured.
    exports.set("log_level", log_level)?;

    // Lua-callable Rust. Returning Err raises a Lua error the caller
    // can pcall — error conversion stays on mlua's side of the line.
    // Verbose (log_level = "debug") appends the live frame count.
    let greet = lua.create_function(move |_, who: String| {
        if who.is_empty() {
            return Err(LuaError::runtime("greet: name must not be empty"));
        }
        if verbose {
            return Ok(format!(
                "Hello, {who} — from Rust (frame {})",
                FRAMES.load(Ordering::Relaxed)
            ));
        }
        Ok(format!("Hello, {who} — from Rust"))
    })?;
    exports.set("greet", greet)?;

    // Pumped by the hook's onSimulationFrame; returns the frame count.
    // Keep per-frame work tiny: a slow frame here is a visible stutter.
    let on_frame =
        lua.create_function(|_, ()| Ok(FRAMES.fetch_add(1, Ordering::Relaxed) + 1))?;
    exports.set("on_frame", on_frame)?;

    Ok(exports)
}
`,
  };
}

function rustDllHook(name: string, slug: string, ident: string): TemplateFile {
  const identUpper = ident.toUpperCase();
  return {
    path: `Scripts/Hooks/${ident}_hook.lua`,
    contents: `-- ${name} GameGUI hook.
-- Appends the mod's bin folder to package.cpath, then loads the native
-- module (modelled on the DCS Studio bridge hook). Output lands in your
-- DCS log (Saved Games/DCS/Logs/dcs.log).

package.cpath = package.cpath .. ";" .. lfs.writedir() .. "Mods\\\\tech\\\\${slug}\\\\bin\\\\?.dll"

-- Read by the Rust side on require() for configuration — the same
-- plain-global pattern the DCS Studio bridge uses (DCS_BRIDGE).
${identUpper} = { log_level = "info" }

local ok, ${ident} = pcall(require, "${ident}")
if not ok then
  log.write("${slug}", log.ERROR, "load failed: " .. tostring(${ident}))
  return
end
log.write("${slug}", log.INFO, "loaded v" .. tostring(${ident}.version))

-- Load-time demo of a Lua-callable Rust function; errors stay in pcall.
local greeted, greeting = pcall(${ident}.greet, "${slug}")
if greeted then
  log.write("${slug}", log.INFO, tostring(greeting))
else
  log.write("${slug}", log.ERROR, "greet failed: " .. tostring(greeting))
end

local cb = {}
function cb.onSimulationFrame()
  -- pcall per frame: a Lua error in one frame must never break the next.
  local fine, err = pcall(${ident}.on_frame)
  if not fine then
    log.write("${slug}", log.ERROR, "on_frame: " .. tostring(err))
  end
end
DCS.setUserCallbacks(cb)
`,
  };
}

function rustDllReadme(name: string, slug: string, ident: string): TemplateFile {
  return {
    path: "README.md",
    contents: `# ${name}

A DCS native Lua module (Rust cdylib via mlua), scaffolded by DCS Studio.

## Prerequisites

- Rust via <https://rustup.rs> — no extra \`rustup target\` needed; the
  host x86_64 Windows target builds the DLL DCS loads.
- On Windows, the MSVC toolchain (Visual Studio Build Tools with the
  "Desktop development with C++" workload).

## Build

\`\`\`
cargo build --release
\`\`\`

Produces \`target/release/${ident}.dll\`.

## Install

DCS Studio's install action applies the manifest's [[symlink]] rules over the
bundled content: the DLL links to \`{SavedGames}/Mods/tech/${slug}/bin\`, the
GameGUI hook to \`{SavedGames}/Scripts/Hooks\`.

## How loading works

At DCS start the hook appends the bin folder to \`package.cpath\`, then
\`${requireExpr(ident)}\` finds \`${ident}.dll\` and calls its exported
\`luaopen_${ident}\` — generated by \`#[mlua::lua_module]\` from the \`[lib]\`
name. Keep the lib name, the require string, and the DLL filename in
sync, or the chain breaks at require.

One footgun: \`.cargo/config.toml\` pins \`LUA_LIB\` / \`LUA_LIB_NAME\` so the
DLL links against DCS's own \`lua.dll\` (import library bundled in
\`lua5.1/\`). Without it, cargo silently links \`lua51.dll\`: the build
succeeds, but \`${requireExpr(ident)}\` fails inside DCS, which ships
\`lua.dll\`.

## Logs

The hook logs under the \`${slug}\` tag via \`log.write\` into
\`Saved Games/DCS/Logs/dcs.log\`: a load line, the greet demo, and any
per-frame errors.

## Next steps

- The hook already pumps \`${ident}.on_frame()\` every simulation frame —
  grow it from there, but keep per-frame work tiny.
- Expose more Rust to Lua in \`src/lib.rs\` with \`lua.create_function\`;
  return \`LuaResult\` so errors raise in Lua instead of unwinding
  across the FFI line.
`,
  };
}

// No baked .miz: a mission worth sharing can't be string-interpolated, so
// this template scaffolds the folder + manifest + README only. The README
// lives INSIDE Missions/ rather than at the project root — the scaffolder
// only ever creates a directory as a side effect of writing a file into it
// (see src/project/scaffold.ts's write()), so the README doubles as the
// placeholder that brings the empty folder into existence. That also means
// the in-place flow "just works" for a folder that already has a .miz in
// it: the existing mission is reported skipped, and only the manifest and
// this README get added around it.
function mission(name: string): TemplateFile[] {
  const slug = slugify(name);
  return [missionManifest(name, slug), missionReadme(name, slug)];
}

function missionManifest(name: string, slug: string): TemplateFile {
  return {
    path: "dcs-studio.toml",
    contents: `${manifestHeader(name)}${projectBlock(name, "mission")}
# The mission ships as-is: packaged into the release archive on publish,
# and symlinked into your DCS user Missions folder on install. Save your
# .miz into Missions/ — if its filename isn't "${slug}.miz", rename the
# path/source/dest below to match instead of renaming the mission.
[[bundle]]
path = "Missions/${slug}.miz"

[[symlink]]
source = "Missions/${slug}.miz"
dest = "{SavedGames}/Missions/${slug}.miz"
`,
  };
}

function missionReadme(name: string, slug: string): TemplateFile {
  return {
    path: "Missions/README.md",
    contents: `# ${name}

A DCS (Digital Combat Simulator) mission, scaffolded by DCS Studio.

## Add your mission

This folder is where the mission you're sharing lives. Save or copy your
\`.miz\` file in here. The scaffolded \`dcs-studio.toml\` assumes a filename
of \`${slug}.miz\` in its [[bundle]]/[[symlink]] rule — if your mission's
real filename differs, rename the rule's \`path\`, \`source\` and \`dest\` to
match instead of renaming the mission file.

Already have a folder with a \`.miz\` in it? Scaffolding in place keeps the
existing file (it comes back reported as skipped) and only adds the
manifest and this README around it — just point the manifest at the
mission's real name.

## What's a .miz?

A \`.miz\` is a single mission archive: DCS's own zip format, bundling the
terrain, triggers, units and briefing for one mission into one file. It's
the smallest unit you can publish and subscribe to.

## Where it lands

The manifest's [[bundle]] entry packs the \`.miz\` into the release archive
on publish; its [[symlink]] entry links it into your DCS user Missions
folder (\`Saved Games/DCS/Missions\`) on install — subscribers see it
straight in the Mission Editor's mission list, no unzip step required.

## Publish → subscribe

Publishing runs preflight checks, packs [[bundle]] paths into a release
archive, and walks you through **Create a release** on GitHub. A
subscriber installs your repo from the Marketplace, and the [[symlink]]
rule above links the .miz into their Missions folder automatically.
`,
  };
}
