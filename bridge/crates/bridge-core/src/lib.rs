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
pub mod golden;
mod json;
mod jsonrpc;
mod locks;
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
use log::{info, warn, LevelFilter};
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

/// The GUI bridge's JSON-RPC method registration chunk — a
/// `function(router, deps)` exposed as `bridge.register_methods`. The `GameGUI`
/// hook and the `OpenRPC` golden test load the SAME source, so the checked-in
/// document can't drift from what the DLL registers.
const GUI_METHODS_SOURCE: &str = include_str!("../lua/gui_methods.lua");

/// The mission bridge's JSON-RPC method registration chunk (see
/// [`GUI_METHODS_SOURCE`]); loaded by the embedded mission init and the golden
/// test alike.
const MISSION_METHODS_SOURCE: &str = include_str!("../lua/mission_methods.lua");

/// Shared JSON-RPC method metadata (`SHARED_META`) prepended to BOTH bridges'
/// registration chunks so the debug_*/repl_* description/params strings live in
/// one place; the trailing `return function(router, deps)` closes over it.
const METHODS_SHARED_SOURCE: &str = include_str!("../lua/methods_shared.lua");

/// The GUI unit-database curation library (`GUI_DB`), prepended to the GUI
/// registration chunk only, so `gui_methods.lua` stays pure registration wiring.
const GUI_DB_SOURCE: &str = include_str!("../lua/gui_db.lua");

/// Which Lua state this DLL serves — parametrizes names, logging, and the
/// curated `dump_globals` roots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeKind {
    /// The `GameGUI` hooks state (`DCS.*`, `net.*`) — `dcs_studio_gui.dll`.
    Gui,
    /// The mission scripting state (`trigger`, `world`, `coalition`, …) —
    /// `dcs_studio_mission.dll`.
    Mission,
}

impl BridgeKind {
    /// The Lua module name (`require("<module_name>")` — also the DLL basename
    /// and the root class of the generated `.d.lua`).
    #[must_use]
    pub fn module_name(self) -> &'static str {
        match self {
            BridgeKind::Gui => "dcs_studio_gui",
            BridgeKind::Mission => "dcs_studio_mission",
        }
    }

    /// The service name reported by `/health` and `rpc.discover`.
    #[must_use]
    pub fn service_name(self) -> &'static str {
        match self {
            BridgeKind::Gui => "dcs-studio-gui",
            BridgeKind::Mission => "dcs-studio-mission",
        }
    }

    /// The environment name this bridge serves natively.
    #[must_use]
    pub fn env_name(self) -> &'static str {
        match self {
            BridgeKind::Gui => "gui",
            BridgeKind::Mission => "mission",
        }
    }

    /// The loopback port this bridge's JSON-RPC server binds by convention —
    /// used to populate the `OpenRPC` `servers` block in the golden document.
    #[must_use]
    pub fn default_port(self) -> u16 {
        match self {
            BridgeKind::Gui => 25569,
            BridgeKind::Mission => 25570,
        }
    }

    /// The `register_methods(router, deps)` chunk source for this bridge.
    fn methods_source(self) -> &'static str {
        match self {
            BridgeKind::Gui => GUI_METHODS_SOURCE,
            BridgeKind::Mission => MISSION_METHODS_SOURCE,
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
///
/// # Errors
///
/// Returns any `mlua` error raised while building the binding surface or
/// loading the embedded runtime/debug-engine chunks into this state.
pub fn bootstrap(lua: &Lua, kind: BridgeKind, version: &str) -> LuaResult<LuaTable> {
    let module_config: ModuleConfig = lua
        .globals()
        .get::<ModuleConfig>("DCS_STUDIO")
        .unwrap_or_default();

    let logger_level: LevelFilter = module_config.logger_level.unwrap_or(Warn);

    // Logging is best effort and its outcome is only ever diagnostic: a bridge
    // that could not open its log file is still a working bridge, and the one
    // place a failure could be reported is the log we just failed to open.
    let logging = logging::init(get_logger_file_path(lua, kind), logger_level);
    info!("{} logging init: {logging:?}", kind.service_name());

    let exports = lua.create_table()?;

    // Register every binding through the facade and capture its `.d.lua` type
    // surface (name/version are set as constants inside `build`).
    let doc = surface::build(lua, &exports, kind, version)?;

    // `emit_dlua()` returns the generated EmmyLua definitions for this module,
    // so the IDE can drop a fresh `types/<module>.d.lua` into a project. The
    // text is rendered once at load and handed back verbatim.
    let dlua = crate::luadef::emit_dlua(&doc);
    let emit_dlua = lua.create_function(move |_, ()| Ok(dlua.clone()))?;
    exports.set("emit_dlua", emit_dlua)?;

    // `dump_globals()` introspects the live DCS API in `_G` (the curated roots
    // for this bridge's state) and returns it as dotted `.d.lua` statements
    // the editor indexes. Unlike `emit_dlua`, it runs per call: `_G` gains
    // globals as the sim loads, so the dump must reflect the sim's CURRENT
    // surface, not a snapshot taken at module load.
    let roots = kind.globals_roots();
    let dump_globals = lua.create_function(move |lua, ()| Ok(globals::dump_globals(lua, roots)))?;
    exports.set("dump_globals", dump_globals)?;

    // Expose `register_methods(router, deps)` — the single source of truth for
    // this bridge's JSON-RPC method set, shared by the live hook/init and the
    // OpenRPC golden test. Recorded in the surface as a root function.
    exports.set("register_methods", load_register_methods(lua, kind)?)?;

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
        warn!("debug engine not installed: {e}");
    }

    Ok(exports)
}

fn get_logger_file_path(lua: &Lua, kind: BridgeKind) -> PathBuf {
    if let Ok(writedir) = get_lfs_writedir(lua) {
        return PathBuf::from(writedir)
            .join("Logs")
            .join(kind.log_file_name());
    }

    // No write root — a bare state, or a sanitized mission state before the GUI
    // hook plants `__DCS_STUDIO_WRITEDIR`. Fall back to the process's current
    // directory, and to a bare relative name if even that is unavailable: a log
    // path is never worth failing the module load over.
    env::current_dir()
        .unwrap_or_default()
        .join(kind.log_file_name())
}

/// Compose the `register_methods(router, deps)` source for `kind`: the shared
/// metadata chunk (and, for the GUI bridge, the unit-db curation library)
/// PREPENDED to the bridge's own registration chunk, so the trailing
/// `return function(router, deps)` closes over `SHARED_META` (and `GUI_DB`) as
/// locals. Concatenation keeps it a single chunk — exactly what `eval` on the
/// bare registration source already relied on to hand back the function.
fn composed_methods_source(kind: BridgeKind) -> String {
    match kind {
        BridgeKind::Gui => format!(
            "{METHODS_SHARED_SOURCE}\n{GUI_DB_SOURCE}\n{}",
            kind.methods_source()
        ),
        BridgeKind::Mission => format!("{METHODS_SHARED_SOURCE}\n{}", kind.methods_source()),
    }
}

/// Load this bridge's `register_methods(router, deps)` chunk into `lua`.
fn load_register_methods(lua: &Lua, kind: BridgeKind) -> LuaResult<LuaFunction> {
    lua.load(composed_methods_source(kind))
        .set_name(match kind {
            BridgeKind::Gui => "=dcs_studio_gui_methods",
            BridgeKind::Mission => "=dcs_studio_mission_methods",
        })
        .eval::<LuaFunction>()
}

/// Render the `.d.lua` for `kind`'s surface on `lua` — the per-cdylib golden
/// tests pin their checked-in `types/<module>.d.lua` to this.
///
/// Takes the state rather than making one, like [`bootstrap`]: the caller owns
/// the Lua state everywhere else in this crate, and owning it here is also what
/// lets a test give this one a memory ceiling.
///
/// # Errors
///
/// Returns any `mlua` error raised while building the surface on `lua`.
pub fn emit_surface_dlua(lua: &Lua, kind: BridgeKind, version: &str) -> LuaResult<String> {
    let exports = lua.create_table()?;
    let doc = surface::build(lua, &exports, kind, version)?;
    Ok(luadef::emit_dlua(&doc))
}

/// Render the `OpenRPC` document for `kind`'s bridge as pretty JSON on `lua` —
/// the per-cdylib golden tests pin their checked-in
/// `openrpc/<module>.openrpc.json` to this, and the meta-schema test validates
/// it. Runs the SAME `register_methods` chunk the live DLL registers, against a
/// stub router with an empty `deps` (handlers are created, never called, so no
/// DCS API is needed to enumerate the method set).
///
/// Takes the state rather than making one, for the same reasons as
/// [`emit_surface_dlua`].
///
/// # Errors
///
/// Returns any `mlua` error raised while running the `register_methods` chunk
/// against the stub router or serializing the document.
pub fn emit_openrpc_json(lua: &Lua, kind: BridgeKind, version: &str) -> LuaResult<String> {
    let register = load_register_methods(lua, kind)?;
    let router = lua.create_userdata(crate::jsonrpc::router::JsonRpcRouter::default())?;
    let deps = lua.create_table()?;
    register.call::<mlua::Value>((&router, deps))?;

    let doc = {
        let router = router.borrow::<crate::jsonrpc::router::JsonRpcRouter>()?;
        crate::jsonrpc::openrpc::build_document(
            kind.service_name(),
            version,
            kind.env_name(),
            "127.0.0.1",
            kind.default_port(),
            &router.methods_sorted(),
        )
    };
    serde_json::to_string_pretty(&doc).map_err(mlua::Error::external)
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod bootstrap_tests {
    use super::{
        bootstrap, emit_openrpc_json, emit_surface_dlua, get_lfs_writedir, get_logger_file_path,
        BridgeKind,
    };
    use mlua::prelude::{LuaFunction, LuaTable};
    use mlua::Lua;

    /// A state whose `lfs.writedir()` returns `dir`, as DCS provides it.
    fn with_writedir(lua: &Lua, dir: &str) {
        let lfs = lua.create_table().expect("lfs");
        let dir = dir.to_string();
        lfs.set(
            "writedir",
            lua.create_function(move |_, ()| Ok(dir.clone()))
                .expect("writedir fn"),
        )
        .expect("set writedir");
        lua.globals().set("lfs", lfs).expect("set lfs");
    }

    /// `bootstrap` is `luaopen`: whatever it returns is the whole `dcs_studio`
    /// module a mission script sees. Both kinds must come back fully wired —
    /// the constants that name the bridge, the sub-namespaces, and the three
    /// root functions the hook and the editor call.
    ///
    /// Windows-ignored like the rest of the crate's mlua tests: there it needs
    /// DCS's `lua.dll` on the runtime path; on non-Windows the build.rs links
    /// PUC liblua5.1 so Linux CI runs it as an ordinary test (issue #28).
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn both_bridges_bootstrap_a_complete_module_table() {
        for (kind, name) in [
            (BridgeKind::Gui, "dcs-studio-gui"),
            (BridgeKind::Mission, "dcs-studio-mission"),
        ] {
            let lua = Lua::new();
            let root = std::env::temp_dir().join(format!(
                "dcs-studio-bootstrap-{}-{}",
                kind.env_name(),
                std::process::id()
            ));
            with_writedir(&lua, &format!("{}/", root.display()));

            let exports = bootstrap(&lua, kind, "9.9.9").expect("bootstrap");
            assert_eq!(exports.get::<String>("name").expect("name"), name);
            assert_eq!(exports.get::<String>("version").expect("version"), "9.9.9");
            let module = kind.module_name();
            let missing: Vec<&str> = [
                "json", "toml", "file", "sqlite", "console", "debug", "logger", "jsonrpc",
            ]
            .into_iter()
            .filter(|sub| exports.get::<LuaTable>(*sub).is_err())
            .collect();
            assert!(missing.is_empty(), "{module} is missing {missing:?}");

            // `emit_dlua` hands the editor this module's own type surface.
            let dlua: String = exports
                .get::<LuaFunction>("emit_dlua")
                .expect("emit_dlua")
                .call(())
                .expect("call emit_dlua");
            assert!(
                dlua.contains(&format!("---@meta {}", kind.module_name())),
                "{dlua}"
            );

            // `dump_globals` introspects `_G` at CALL time, so a root that
            // appears later in the sim's load still shows up.
            let dump: LuaFunction = exports.get("dump_globals").expect("dump_globals");
            assert!(!dump.call::<String>(()).expect("dump").contains("net = {}"));
            lua.load("net = { dostring_in = function() end }")
                .exec()
                .expect("seed a late global");
            let after: String = dump.call(()).expect("dump again");
            assert!(after.contains("net = {}"), "{after}");
            assert!(after.contains("function net.dostring_in() end"), "{after}");

            // `register_methods` is the one source of truth behind rpc.discover.
            exports
                .get::<LuaFunction>("register_methods")
                .expect("register_methods");

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    /// Without the `debug` library the engine cannot install, and the bridge
    /// must still load: a sanitized DCS state gets json/file/sqlite/console and
    /// simply no breakpoints, rather than a failed `require` that takes the
    /// hook down with it.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_state_without_the_debug_library_still_gets_the_rest_of_the_bridge() {
        let lua = Lua::new();
        assert!(
            lua.globals()
                .get::<mlua::Value>("debug")
                .expect("debug")
                .is_nil(),
            "the harness state really has no debug library"
        );

        let exports = bootstrap(&lua, BridgeKind::Gui, "test").expect("bootstrap");
        exports.get::<LuaTable>("json").expect("json survived");
        assert!(
            lua.globals()
                .get::<mlua::Value>("__DCS_STUDIO_DBG")
                .expect("dbg")
                .is_nil(),
            "the debug engine must not claim to be installed"
        );
        // The console runtime is state-local and does install.
        lua.globals()
            .get::<LuaTable>("__DCS_STUDIO_RT")
            .expect("RT installed");
    }

    /// Without coroutines the engine declines to install at all, for the same
    /// reason it declines without `debug`: it cannot do its job safely. Every
    /// expression it evaluates — a watch, a hover, a breakpoint condition —
    /// runs on its own coroutine under an instruction-count hook, because Lua
    /// 5.1 will not fire a hook inside a hook and all of them run inside the
    /// line hook. With no way to bound them, one `while true do end` in a watch
    /// would hold the sim thread with no Stop able to reach it, which is worse
    /// than having no debugger. Nothing DCS ships removes the library; this
    /// pins the refusal rather than the scenario.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_state_without_coroutines_gets_no_debug_engine_either() {
        // SAFETY: test-only state; `unsafe_new` loads the debug stdlib, so the
        // engine gets past its debug-library guard and reaches this one.
        let lua = unsafe { Lua::unsafe_new() };
        lua.globals()
            .set("coroutine", mlua::Value::Nil)
            .expect("drop coroutine");

        let exports = bootstrap(&lua, BridgeKind::Gui, "test").expect("bootstrap");
        exports.get::<LuaTable>("json").expect("json survived");
        assert!(
            lua.globals()
                .get::<mlua::Value>("__DCS_STUDIO_DBG")
                .expect("dbg")
                .is_nil(),
            "an engine that cannot bound an evaluation must not install"
        );
    }

    /// `__DCS_STUDIO_DBG` is an ordinary global in a state every other mod
    /// shares, so the engine cannot assume it owns the name. Its version check
    /// runs at CHUNK LOAD, and a raise there comes back through `bootstrap`'s
    /// `?` — the whole `require("dcs_studio_gui")` fails and the user loses the
    /// bridge entirely, over a name collision. A non-table simply means no
    /// engine of ours is installed, so ours installs over it.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn another_mod_owning_the_engine_global_does_not_fail_the_module_load() {
        // SAFETY: test-only state; `unsafe_new` loads the debug stdlib so the
        // engine gets past its library guards and reaches the version check.
        let lua = unsafe { Lua::unsafe_new() };
        lua.globals()
            .set("__DCS_STUDIO_DBG", 42)
            .expect("plant a non-table");

        let exports = bootstrap(&lua, BridgeKind::Gui, "test").expect("bootstrap");
        exports.get::<LuaTable>("json").expect("json survived");
        let engine: LuaTable = lua
            .globals()
            .get("__DCS_STUDIO_DBG")
            .expect("the engine installed over the collision");
        assert_eq!(engine.get::<i64>("version").expect("version"), 1);
    }

    /// The engine chunk is loaded with `?`, so whatever it raises fails the
    /// module load. It is written never to raise — it RETURNS a reason string
    /// when the state cannot host it — but it reads `debug` and `coroutine` out
    /// of a shared `_G` to decide, and a global whose metatable raises on access
    /// is beyond what any guard in Lua can catch. The requirement is that this
    /// stays a reported error (the hook's `pcall(require)` logs it and DCS runs
    /// on) and never a panic, which inside the DLL would take the sim with it.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_global_that_raises_when_read_fails_the_load_rather_than_the_process() {
        let lua = Lua::new();
        lua.load(
            r#"
            debug = setmetatable({}, {
              __index = function(_, k) error("this state refuses debug." .. tostring(k), 0) end,
            })
            "#,
        )
        .exec()
        .expect("plant a hostile debug global");

        let err = bootstrap(&lua, BridgeKind::Gui, "test")
            .expect_err("the engine cannot be installed into this state");
        assert!(
            err.to_string().contains("refuses debug."),
            "the real cause reaches the hook's log: {err}"
        );
    }

    /// Every allocation the module load makes can fail for real: the Lua state
    /// belongs to DCS and is shared with the whole mission, and mlua reports
    /// exhaustion as an ordinary error on every `create_table`, `create_function`
    /// and chunk load. What must NOT happen is a panic unwinding out of the
    /// DLL — inside DCS that aborts the sim. A failed load is recoverable: the
    /// hook's `pcall(require)` logs it and the game runs on without a bridge.
    ///
    /// Driven by squeezing the state's memory ceiling from no headroom at all
    /// upwards, so the failure lands on a different allocation each pass and the
    /// whole chain (exports table, binding surface, `emit_dlua`/`dump_globals`,
    /// the registration chunk, the two embedded Lua chunks) is exercised. The
    /// pass that finally succeeds is the proof that the squeeze — not something
    /// else — is what was stopping it.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_state_out_of_memory_fails_the_load_instead_of_panicking() {
        let mut relaxed_enough_to_load = false;
        for headroom in (0..2_000_000).step_by(256) {
            let lua = Lua::new();
            let ceiling = lua.used_memory() + headroom;
            lua.set_memory_limit(ceiling)
                .expect("mlua owns this state's allocator");
            match bootstrap(&lua, BridgeKind::Gui, "test") {
                Ok(exports) => {
                    // The successful pass is a real bridge, not a husk.
                    exports.get::<LuaTable>("json").expect("json namespace");
                    relaxed_enough_to_load = true;
                    break;
                }
                Err(e) => assert!(
                    e.to_string().contains("memory"),
                    "the load must fail on the squeeze, and say so: {e}"
                ),
            }
        }
        assert!(
            relaxed_enough_to_load,
            "the squeeze never relaxed enough to load — the test proves nothing"
        );
    }

    /// The golden generators build their whole surface — and, for `OpenRPC`,
    /// run the real registration chunk — inside a Lua state, so they allocate
    /// exactly like the module load does. Same requirement, same squeeze: an
    /// exhausted state gets an error, never a panic.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_golden_generators_report_an_exhausted_state_rather_than_panicking() {
        for headroom in (0..2_000_000).step_by(256) {
            let lua = Lua::new();
            let ceiling = lua.used_memory() + headroom;
            lua.set_memory_limit(ceiling)
                .expect("mlua owns this state's allocator");
            if let Ok(dlua) = emit_surface_dlua(&lua, BridgeKind::Gui, "test") {
                assert!(dlua.contains("---@meta dcs_studio_gui"), "{dlua}");
                break;
            }
        }

        let mut relaxed_enough_to_render = false;
        for headroom in (0..2_000_000).step_by(256) {
            let lua = Lua::new();
            let ceiling = lua.used_memory() + headroom;
            lua.set_memory_limit(ceiling)
                .expect("mlua owns this state's allocator");
            match emit_openrpc_json(&lua, BridgeKind::Gui, "test") {
                Ok(doc) => {
                    assert!(doc.contains("\"openrpc\""), "{doc}");
                    relaxed_enough_to_render = true;
                    break;
                }
                Err(e) => assert!(
                    e.to_string().contains("memory"),
                    "the render must fail on the squeeze, and say so: {e}"
                ),
            }
        }
        assert!(
            relaxed_enough_to_render,
            "the squeeze never relaxed enough to render — the test proves nothing"
        );
    }

    /// The log file is per DLL and lives under the write root's `Logs`. The two
    /// bridges must never share one: each has its own log4rs instance, and a
    /// shared truncating appender would have them clobber each other's file.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn each_bridge_logs_to_its_own_file_under_the_write_root() {
        let lua = Lua::new();
        with_writedir(&lua, "/tmp/dcs-writedir/");

        let gui = get_logger_file_path(&lua, BridgeKind::Gui);
        let mission = get_logger_file_path(&lua, BridgeKind::Mission);
        assert!(gui.ends_with("Logs/dcs_studio_gui.log"), "{gui:?}");
        assert!(
            mission.ends_with("Logs/dcs_studio_mission.log"),
            "{mission:?}"
        );
        assert_ne!(gui, mission);
    }

    /// With no write root at all the log falls back beside the process rather
    /// than failing the load — and the fallback is still per bridge.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_state_with_no_write_root_falls_back_to_the_working_directory() {
        let lua = Lua::new();
        assert!(
            get_lfs_writedir(&lua).is_err(),
            "no lfs, no fallback global"
        );

        let path = get_logger_file_path(&lua, BridgeKind::Mission);
        assert!(path.ends_with("dcs_studio_mission.log"), "{path:?}");
        assert!(
            !path.to_string_lossy().contains("Logs"),
            "the Logs subdirectory belongs to the write root: {path:?}"
        );
    }

    /// In the sanitized mission state `lfs` is gone, so the GUI hook's boot
    /// dispatch passes the write dir through `__DCS_STUDIO_WRITEDIR` instead.
    /// A regression here silently sends every log and every `file.*` write to
    /// the DCS install directory.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_write_root_falls_back_to_the_global_the_hook_plants() {
        let lua = Lua::new();
        lua.globals()
            .set("__DCS_STUDIO_WRITEDIR", "/tmp/planted/")
            .expect("plant");
        assert_eq!(get_lfs_writedir(&lua).expect("writedir"), "/tmp/planted/");

        // A live `lfs.writedir()` wins over the planted global.
        with_writedir(&lua, "/tmp/live/");
        assert_eq!(get_lfs_writedir(&lua).expect("writedir"), "/tmp/live/");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod gui_method_tests {
    use super::{composed_methods_source, BridgeKind};
    use mlua::prelude::LuaFunction;
    use mlua::Lua;

    /// The GUI bridge in a state where the debug engine DECLINED to install
    /// (`deps.DBG` nil — a hooks state without `debug`/`coroutine`), driven
    /// through the same fake-router harness as the db methods. The engine is
    /// designed to decline and the DLL only warns, so the cost must be
    /// breakpoints and nothing else: the debug_* methods say why, every other
    /// method works, and `repl_export` reports a write that failed instead of
    /// handing back a path to a truncated file.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn debug_methods_refuse_and_exports_are_written_through_the_guarded_writer() {
        let lua = Lua::new();
        // The console runtime repl_export calls into, installed as the DLL does.
        lua.load(crate::RT_SOURCE).exec().expect("install RT");
        let register: LuaFunction = lua
            .load(composed_methods_source(BridgeKind::Gui))
            .eval()
            .expect("load register_methods");
        lua.globals()
            .set("register_methods", register)
            .expect("bind register_methods");
        lua.load(SUITE).exec().expect("gui method suite");
    }

    const SUITE: &str = r#"
      H = {}
      local router = { add_method = function(_, name, fn, _meta) H[name] = fn end }

      local written = {}
      local deps = {
        -- DBG is absent: this is a state where the engine declined.
        bridge = {
          file = {
            write_text = function(rel, text)
              if written.refuse then return nil, "The disc is full" end
              written.rel, written.text = rel, text
              return true
            end,
          },
          -- The pause/continue/stop trio drives the DLL's registry directly, so
          -- it works with or without an engine in the state.
          debug = { request_pause = function() paused = true end },
        },
        RT = __DCS_STUDIO_RT,
      }
      lfs = { writedir = function() return "C:/wd/" end }

      register_methods(router, deps)

      -- Every debugger method answers with the reason. Before the guard they
      -- indexed a nil engine, so the editor got "attempt to index a nil value"
      -- — or, in the hook, no bridge at all, because the startup asserted.
      local debug_methods = {
        "debug_run", "debug_state", "debug_expand", "debug_eval",
        "debug_set_breakpoints", "debug_clear_breakpoints",
      }
      for _, name in ipairs(debug_methods) do
        local ok, err = pcall(H[name], { code = "x", source = "=s", ref = 0, frame = 0, expr = "1" })
        assert(not ok, name .. " must refuse without an engine")
        assert(string.find(tostring(err), "debug library is not available", 1, true),
          name .. ": " .. tostring(err))
      end
      -- The methods that only talk to the DLL's registry still answer.
      assert(H.debug_pause().ok == true and paused == true, "debug_pause needs no engine")

      -- repl_export writes through the guarded writer (which creates the
      -- directory and checks the write AND the close) and reports its path.
      local out = H.repl_export({ expr = "{ answer = 42 }" })
      assert(string.find(written.rel, "^Temp/dcs%-studio%-export%-"), written.rel)
      assert(string.find(written.text, '"answer": 42', 1, true), written.text)
      assert(out.bytes == #written.text, "bytes match the written body")
      assert(out.path == "C:/wd/" .. string.gsub(written.rel, "/", "\\"), out.path)

      -- A write that fails is an error, not a path to a truncated file. Raw
      -- io.open reported success here: the editor opened half a JSON document.
      written.refuse = true
      local ok, err = pcall(H.repl_export, { expr = "{ answer = 42 }" })
      assert(not ok, "a failed write must not report success")
      assert(string.find(tostring(err), "The disc is full", 1, true), tostring(err))
    "#;
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod db_method_tests {
    use super::{composed_methods_source, BridgeKind};
    use mlua::prelude::LuaFunction;
    use mlua::Lua;

    // The GUI bridge's db_* handlers, driven against a SYNTHETIC `db` global
    // shaped from the verified live data (array categories with singular entry
    // keys; Pylons→Launchers→CLSID; a GT_t whose inner .type is numeric and a
    // Skills list, both of which shape-detection must exclude; db.Weapons.ByCLSID).
    // register_methods runs against a fake router that captures the handlers into
    // the global `H`, so we can invoke them directly and assert on the returned
    // plain-data tables. Loads the COMPOSED GUI source (shared metadata + the
    // gui_db curation library prepended) exactly as the DLL does. Gated like the
    // rest of the mlua suite.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn db_methods_over_synthetic_db() {
        let lua = Lua::new();
        let register: LuaFunction = lua
            .load(composed_methods_source(BridgeKind::Gui))
            .eval()
            .expect("load register_methods");
        lua.globals()
            .set("register_methods", register)
            .expect("bind register_methods");
        lua.load(SUITE).exec().expect("db method suite");
    }

    const SUITE: &str = r#"
      -- ── synthetic db shaped like the live one ──
      local function plane(t, dn) return {
        type = t, DisplayName = dn, Name = t,
        attribute = { [1] = 1, [2] = 2, [5] = "Air", [6] = "Planes", [7] = "Fighters" },
        country_of_origin = "USA", crew_members = { {}, {} },
        M_max = 100, H_max = 200, Mach_max = 2.5, ignore_me = "x",
        Guns = { { name = "M61" } },
        Pylons = {
          { Number = 1, Order = 1, Type = 2, X = 1.5, Y = 2.5, Z = 3.5,
            Launchers = { { CLSID = "{AIM}" }, { CLSID = "{UNKNOWN}" } } },
        },
        nested = { a = { b = { c = 1 } } },
      } end

      db = {
        Units = {
          Planes = { DefaultTask = {}, Tasks = {},
            Plane = { plane("F-15C", "F-15C Eagle"), plane("Su-27", "Su-27 Flanker") } },
          Ships = { Ship = { { type = "speedboat", DisplayName = "Speedboat",
            Length = 10, Width = 3, MaxSpeed = 20 } } },
          -- excluded: GT_t (inner .type is numeric), Skills (no record array)
          GT_t = { WSN_t = { { type = 0, deviation_error_azimuth = 1 } } },
          Skills = { "Average", "Good", "High" },
          WWIIstructures = {},
        },
        Weapons = {
          Categories = {},
          ByCLSID = {
            ["{AIM}"] = { CLSID = "{AIM}", displayName = "AIM-120C", name = "AIM_120C", category = 1 },
            ["{MK}"]  = { CLSID = "{MK}",  displayName = "Mk-82",    name = "Mk_82",   category = 2 },
          },
        },
      }

      -- fake router: capture handlers by name
      H = {}
      local router = { add_method = function(_, name, fn, _meta) H[name] = fn end }

      -- stub deps: RT.encode + guarded file writer for db_export
      local captured = {}
      local deps = {
        bridge = { file = { write_text = function(rel, json) captured.rel = rel; captured.json = json; return true end } },
        RT = { encode = function(v, pretty) captured.encoded = v; return "ENCODED" end },
      }
      lfs = { writedir = function() return "C:/wd/" end }

      register_methods(router, deps)

      local function eq(a, b, msg) if a ~= b then error((msg or "eq") .. ": got " .. tostring(a) .. " want " .. tostring(b), 2) end end

      -- db_categories: only Planes + Ships (GT_t/Skills/WWIIstructures excluded)
      local cats = H.db_categories().categories
      eq(#cats, 2, "category count")
      local seen = {}
      for _, c in ipairs(cats) do seen[c.name] = c end
      assert(seen.Planes and seen.Planes.entry_key == "Plane" and seen.Planes.count == 2, "Planes")
      assert(seen.Ships and seen.Ships.entry_key == "Ship" and seen.Ships.count == 1, "Ships")
      assert(not seen.GT_t and not seen.Skills and not seen.WWIIstructures, "excluded non-categories")
      -- deterministic sort by name
      eq(cats[1].name, "Planes", "sorted[1]"); eq(cats[2].name, "Ships", "sorted[2]")

      -- db_unit_types: all, one category, case-insensitive filter
      local all = H.db_unit_types({})
      eq(#all.units, 3, "all units"); eq(all.truncated, false, "not truncated")
      eq(#H.db_unit_types({ category = "Planes" }).units, 2, "planes only")
      local eagle = H.db_unit_types({ filter = "EAGLE" })
      eq(#eagle.units, 1, "filter by display"); eq(eagle.units[1].type, "F-15C", "eagle is F-15C")
      local ok = pcall(function() return H.db_unit_types({ category = "Nope" }) end)
      eq(ok, false, "unknown category errors")

      -- db_unit curated (lowercase lookup)
      local u = H.db_unit({ type = "f-15c" }).unit
      eq(u.type, "F-15C", "unit type"); eq(u.category, "Planes", "unit category")
      eq(u.display_name, "F-15C Eagle", "display")
      eq(u.country_of_origin, "USA", "country"); eq(u.crew_members, 2, "crew count")
      -- attributes: string values only, sorted
      eq(#u.attributes, 3, "attr count")
      eq(u.attributes[1], "Air"); eq(u.attributes[2], "Fighters"); eq(u.attributes[3], "Planes")
      eq(u.perf.M_max, 100, "perf M_max"); eq(u.perf.H_max, 200, "perf H_max")
      assert(u.perf.ignore_me == nil, "non-perf field excluded")
      -- pylons + store resolution
      eq(#u.pylons, 1, "one pylon")
      local p = u.pylons[1]
      eq(p.number, 1); eq(p.order, 1); eq(p.type, 2)
      eq(p.position.x, 1.5); eq(p.position.y, 2.5); eq(p.position.z, 3.5)
      eq(#p.stores, 2, "two stores")
      eq(p.stores[1].clsid, "{AIM}"); eq(p.stores[1].weapon.display_name, "AIM-120C")
      assert(p.stores[2].weapon == nil, "unknown CLSID → bare clsid, nil weapon")
      eq(p.stores[2].clsid, "{UNKNOWN}")

      -- db_unit raw: whole record, sanitized (nested preserved, guns present)
      local raw = H.db_unit({ type = "F-15C", raw = true })
      eq(raw.raw, true, "raw flag"); eq(raw.unit.type, "F-15C", "raw type")
      eq(raw.unit.ignore_me, "x", "raw keeps unmapped fields")
      eq(raw.unit.nested.a.b.c, 1, "raw keeps nested")

      -- a unit without pylons/crew/country (ship)
      local s = H.db_unit({ type = "speedboat" }).unit
      assert(s.pylons == nil and s.country_of_origin == nil and s.crew_members == nil, "ship has no pylons/crew/country")

      -- db_weapons + filter
      local w = H.db_weapons({})
      eq(#w.weapons, 2, "two weapons"); eq(w.truncated, false, "weapons not truncated")
      local mk = H.db_weapons({ filter = "mk" })
      eq(#mk.weapons, 1, "weapon filter"); eq(mk.weapons[1].display_name, "Mk-82", "Mk-82")

      -- db_export: RT.encode + guarded write, path/bytes
      local ex = H.db_export({ what = "weapons" })
      eq(captured.encoded, db.Weapons, "export encodes weapons")
      eq(ex.bytes, #("ENCODED"), "export bytes")
      assert(ex.path == "C:/wd/" .. string.gsub(captured.rel, "/", "\\"), "export path")
      assert(string.find(captured.rel, "^Temp/dcs%-studio%-db%-weapons%-"), "export filename: " .. captured.rel)
      H.db_export({}) -- default "all"
      eq(captured.encoded, db, "export all encodes db")
      H.db_export({ what = "category:Planes" })
      eq(captured.encoded, db.Units.Planes.Plane, "export category")
      H.db_export({ what = "unit:F-15C" })
      eq(captured.encoded.type, "F-15C", "export unit")
      eq(pcall(function() return H.db_export({ what = "bogus" }) end), false, "bad what errors")

      -- caps/truncation + cache invalidation on db identity change: a whole new
      -- db table (fresh identity) must rebuild the category/type caches, and a
      -- category over the 2000 cap flags `truncated`.
      local cars = {}
      for i = 1, 2001 do cars[i] = { type = "car" .. i, DisplayName = "Car " .. i } end
      db = { Units = { Cars = { Car = cars } }, Weapons = db.Weapons }
      local cats2 = H.db_categories().categories
      eq(#cats2, 1, "cache invalidated on db identity change: only Cars now")
      eq(cats2[1].name, "Cars", "rebuilt category is Cars")
      local big = H.db_unit_types({ category = "Cars" })
      eq(#big.units, 2000, "capped at 2000"); eq(big.truncated, true, "truncated flag")
      assert(H.db_unit({ type = "car42" }).unit.type == "car42", "type index rebuilt for new db")

      -- absent-db guard
      db = nil
      eq(pcall(function() return H.db_categories() end), false, "absent db errors")
    "#;
}
