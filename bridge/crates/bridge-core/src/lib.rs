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

/// The GUI bridge's JSON-RPC method registration chunk — a
/// `function(router, deps)` exposed as `bridge.register_methods`. The GameGUI
/// hook and the OpenRPC golden test load the SAME source, so the checked-in
/// document can't drift from what the DLL registers.
const GUI_METHODS_SOURCE: &str = include_str!("../lua/gui_methods.lua");

/// The mission bridge's JSON-RPC method registration chunk (see
/// [`GUI_METHODS_SOURCE`]); loaded by the embedded mission init and the golden
/// test alike.
const MISSION_METHODS_SOURCE: &str = include_str!("../lua/mission_methods.lua");

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

    /// The loopback port this bridge's JSON-RPC server binds by convention —
    /// used to populate the OpenRPC `servers` block in the golden document.
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

/// Load this bridge's `register_methods(router, deps)` chunk into `lua`.
fn load_register_methods(lua: &Lua, kind: BridgeKind) -> LuaResult<LuaFunction> {
    lua.load(kind.methods_source())
        .set_name(match kind {
            BridgeKind::Gui => "=dcs_studio_gui_methods",
            BridgeKind::Mission => "=dcs_studio_mission_methods",
        })
        .eval::<LuaFunction>()
}

/// Render the `.d.lua` for `kind`'s surface on a fresh Lua state — the
/// per-cdylib golden tests pin their checked-in `types/<module>.d.lua` to this.
pub fn emit_surface_dlua(kind: BridgeKind, version: &str) -> LuaResult<String> {
    let lua = Lua::new();
    let exports = lua.create_table()?;
    let doc = surface::build(&lua, &exports, kind, version)?;
    Ok(luadef::emit_dlua(&doc))
}

/// Render the OpenRPC document for `kind`'s bridge as pretty JSON on a fresh
/// Lua state — the per-cdylib golden tests pin their checked-in
/// `openrpc/<module>.openrpc.json` to this, and the meta-schema test validates
/// it. Runs the SAME `register_methods` chunk the live DLL registers, against a
/// stub router with an empty `deps` (handlers are created, never called, so no
/// DCS API is needed to enumerate the method set).
pub fn emit_openrpc_json(kind: BridgeKind, version: &str) -> LuaResult<String> {
    let lua = Lua::new();
    let register = load_register_methods(&lua, kind)?;
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
mod db_method_tests {
    use super::GUI_METHODS_SOURCE;
    use mlua::prelude::{LuaFunction, LuaResult};
    use mlua::Lua;

    // The GUI bridge's db_* handlers, driven against a SYNTHETIC `db` global
    // shaped from the verified live data (array categories with singular entry
    // keys; Pylons→Launchers→CLSID; a GT_t whose inner .type is numeric and a
    // Skills list, both of which shape-detection must exclude; db.Weapons.ByCLSID).
    // register_methods runs against a fake router that captures the handlers into
    // the global `H`, so we can invoke them directly and assert on the returned
    // plain-data tables. Gated like the rest of the mlua suite.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn db_methods_over_synthetic_db() -> LuaResult<()> {
        let lua = Lua::new();
        let register: LuaFunction = lua.load(GUI_METHODS_SOURCE).eval()?;
        lua.globals().set("register_methods", register)?;
        lua.load(SUITE).exec()?;
        Ok(())
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
