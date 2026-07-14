//! Everything the two bridge DLLs share. Each cdylib (`dcs_studio_gui`,
//! `dcs_studio_mission`) is a thin `#[mlua::lua_module]` entry point that
//! calls [`bootstrap`] with its [`BridgeKind`]; the kind parametrizes the
//! module/service names, the log file, and the curated `dump_globals` roots.
//!
//! Statics in this crate (the debugger registry, the console ring, the global
//! request queue) are compiled into EACH cdylib separately — per-DLL state, by
//! design: every DLL owns the debugger/server state for exactly one Lua state.

mod console;
mod debug;
mod facade;
mod file;
mod globals;
mod json;
mod jsonrpc;
mod logger;
mod logging;
mod lua_utils;
mod luadef;
mod module_config;
mod path_guard;
pub mod protocol;
mod sqlite;
mod surface;
mod toml_codec;

use log::LevelFilter::Warn;
use log::{error, info, warn, LevelFilter};
use mlua::prelude::{LuaFunction, LuaResult, LuaTable};
use mlua::Lua;
use module_config::ModuleConfig;
use std::env;
use std::path::PathBuf;

/// The console/REPL runtime (`__DCS_STUDIO_RT`), installed into the DLL's own
/// state by [`bootstrap`] and exposed as the `rt_source` constant so the GUI
/// hook can prepend it to `net.dostring_in` payloads for remote states.
pub(crate) const RT_SOURCE: &str = include_str!("../lua/rt.lua");

/// The debug engine (`__DCS_STUDIO_DBG`), installed into the DLL's own state
/// by [`bootstrap`] with the exports table as the chunk argument.
const DEBUG_ENGINE_SOURCE: &str = include_str!("../lua/debug_engine.lua");

/// Which Lua state this DLL serves — parametrizes names, logging, and the
/// curated `dump_globals` roots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeKind {
    /// The GameGUI hooks state (`DCS.*`, `net.*`) — `dcs_studio_gui.dll`.
    Gui,
    /// The mission scripting state (`trigger`, `world`, `coalition`, …) —
    /// `dcs_studio_mission.dll`.
    Mission,
}

impl BridgeKind {
    /// The Lua module name (`require("<module_name>")` — also the DLL basename
    /// and the root class of the generated `.d.lua`).
    pub fn module_name(self) -> &'static str {
        match self {
            BridgeKind::Gui => "dcs_studio_gui",
            BridgeKind::Mission => "dcs_studio_mission",
        }
    }

    /// The service name reported by `/health` and `rpc.discover`.
    pub fn service_name(self) -> &'static str {
        match self {
            BridgeKind::Gui => "dcs-studio-gui",
            BridgeKind::Mission => "dcs-studio-mission",
        }
    }

    /// The environment name this bridge serves natively.
    pub fn env_name(self) -> &'static str {
        match self {
            BridgeKind::Gui => "gui",
            BridgeKind::Mission => "mission",
        }
    }

    /// Per-DLL log file under `<writedir>/Logs/`. Never shared between the two
    /// DLLs: each has its own log4rs instance and would clobber the other's file.
    fn log_file_name(self) -> &'static str {
        match self {
            BridgeKind::Gui => "dcs_studio_gui.log",
            BridgeKind::Mission => "dcs_studio_mission.log",
        }
    }

    /// The modder-facing API roots `dump_globals` walks in this state.
    fn globals_roots(self) -> &'static [&'static str] {
        match self {
            BridgeKind::Gui => &["DCS", "Export", "net", "lfs", "log"],
            BridgeKind::Mission => &[
                "env",
                "timer",
                "trigger",
                "world",
                "coalition",
                "missionCommands",
                "land",
                "coord",
                "atmosphere",
                "country",
                "radio",
                "Object",
                "Unit",
                "Group",
                "StaticObject",
                "Airbase",
                "Weapon",
                "Controller",
                "Spot",
                "net",
            ],
        }
    }
}

/// Build the whole bridge surface on a fresh exports table: read the
/// `DCS_STUDIO` config global, initialize logging (once per DLL — the mission
/// DLL's `luaopen` re-runs on every mission load), register every binding,
/// wire `emit_dlua`/`dump_globals`, and install the console runtime and debug
/// engine into this state.
pub fn bootstrap(lua: &Lua, kind: BridgeKind, version: &str) -> LuaResult<LuaTable> {
    let module_config: ModuleConfig = lua
        .globals()
        .get::<ModuleConfig>("DCS_STUDIO")
        .unwrap_or_default();

    let logger_level: LevelFilter = module_config.logger_level.unwrap_or(Warn);

    match logging::init(get_logger_file_path(lua, kind)?, logger_level) {
        Ok(()) => info!("Logger initialized ({})", kind.service_name()),
        Err(e) => error!("Failed to initialize logger: {}", e),
    };

    let exports = lua.create_table()?;

    // Register every binding through the facade and capture its `.d.lua` type
    // surface (name/version are set as constants inside `build`).
    let doc = surface::build(lua, &exports, kind, version)?;

    // `emit_dlua()` returns the generated EmmyLua definitions for this module,
    // so the IDE can drop a fresh `types/<module>.d.lua` into a project. The
    // text is rendered once at load and handed back verbatim.
    let dlua = crate::luadef::emit_dlua(&doc);
    exports.set(
        "emit_dlua",
        lua.create_function(move |_, ()| Ok(dlua.clone()))?,
    )?;

    // `dump_globals()` introspects the live DCS API in `_G` (the curated roots
    // for this bridge's state) and returns it as dotted `.d.lua` statements
    // the editor indexes. Unlike `emit_dlua`, it runs per call: `_G` gains
    // globals as the sim loads, so the dump must reflect the sim's CURRENT
    // surface, not a snapshot taken at module load.
    let roots = kind.globals_roots();
    exports.set(
        "dump_globals",
        lua.create_function(move |lua, ()| Ok(globals::dump_globals(lua, roots)))?,
    )?;

    // Install the console/REPL runtime into this state (idempotent via its
    // version guard).
    lua.load(RT_SOURCE).set_name("=dcs_studio_rt").exec()?;

    // Install the debug engine into this state, handing it the exports table
    // (it needs console/json/debug). Returns nil on success or an error string
    // — a state without the debug library still gets the rest of the bridge.
    let engine_err: Option<String> = lua
        .load(DEBUG_ENGINE_SOURCE)
        .set_name("=dcs_studio_debug_engine")
        .call(&exports)?;
    if let Some(e) = engine_err {
        warn!("debug engine not installed: {}", e);
    }

    Ok(exports)
}

fn get_logger_file_path(lua: &Lua, kind: BridgeKind) -> LuaResult<PathBuf> {
    if let Ok(writedir) = get_lfs_writedir(lua) {
        return Ok(PathBuf::from(writedir)
            .join("Logs")
            .join(kind.log_file_name()));
    }

    if let Ok(current_dir) = env::current_dir() {
        return Ok(current_dir.join(kind.log_file_name()));
    }

    Ok(format!("./{}", kind.log_file_name()).into())
}

/// Render the `.d.lua` for `kind`'s surface on a fresh Lua state — the
/// per-cdylib golden tests pin their checked-in `types/<module>.d.lua` to this.
pub fn emit_surface_dlua(kind: BridgeKind, version: &str) -> LuaResult<String> {
    let lua = Lua::new();
    let exports = lua.create_table()?;
    let doc = surface::build(&lua, &exports, kind, version)?;
    Ok(luadef::emit_dlua(&doc))
}

/// The DCS write dir. Prefers `lfs.writedir()`; in the mission state after
/// sanitization `lfs` is gone, so the GUI hook's boot dispatch passes the
/// write dir through the `__DCS_STUDIO_WRITEDIR` global instead.
pub(crate) fn get_lfs_writedir(lua: &Lua) -> LuaResult<String> {
    let globals = lua.globals();
    let via_lfs = globals
        .get::<LuaTable>("lfs")
        .and_then(|lfs| lfs.get::<LuaFunction>("writedir"))
        .and_then(|writedir| writedir.call::<String>(()));
    match via_lfs {
        Ok(dir) => Ok(dir),
        Err(_) => globals.get::<String>("__DCS_STUDIO_WRITEDIR"),
    }
}
