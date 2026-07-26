//! The mission bridge DLL: `require("dcs_studio_mission")` inside the mission
//! scripting state, dispatched there by the GUI hook's boot snippet at mission
//! start. Bootstraps the shared core for [`BridgeKind::Mission`], then runs
//! the embedded mission init (router, method registration, timer pump).
//!
//! The mission Lua state is destroyed and recreated per mission, but this DLL
//! image (and its statics — the server, the debugger registry, the console
//! ring) persists in the process from the first load until DCS exits. The
//! embedded init is written to be re-run per mission: `jsonrpc.serve` reuses
//! the running server, and the debugger session state is reset.

use dcs_bridge_core::BridgeKind;
use mlua::prelude::{LuaResult, LuaTable};
use mlua::Lua;

const MISSION_INIT_SOURCE: &str = include_str!("../lua/mission_init.lua");

/// The `luaopen_dcs_studio_mission` entry point DCS's `require` calls.
///
/// # Errors
///
/// Returns any `mlua` error from [`dcs_bridge_core::bootstrap`] or the
/// embedded mission init chunk.
#[mlua::lua_module]
pub fn dcs_studio_mission(lua: &Lua) -> LuaResult<LuaTable> {
    let exports = dcs_bridge_core::bootstrap(lua, BridgeKind::Mission, env!("CARGO_PKG_VERSION"))?;
    lua.load(MISSION_INIT_SOURCE)
        .set_name("=dcs_studio_mission_init")
        .call::<()>(&exports)?;
    Ok(exports)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use dcs_bridge_core::golden::{check_or_regenerate, regenerating};
    use dcs_bridge_core::{emit_openrpc_json, emit_surface_dlua, BridgeKind};
    use mlua::prelude::LuaTable;
    use mlua::Lua;
    use std::path::Path;

    /// The checked-in `.d.lua`, regenerated from the live surface with
    /// `DCS_STUDIO_REGENERATE_GOLDENS=1 cargo test`. mlua tests need a real Lua
    /// 5.1 at runtime: on Windows that is DCS's own `lua.dll` (put it on PATH
    /// and run with `-- --include-ignored`); on non-Windows, core's build.rs
    /// links PUC liblua5.1 so Linux CI runs them ordinarily.
    const GOLDEN: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/types/dcs_studio_mission.d.lua"
    );

    /// The checked-in `OpenRPC` document `rpc.discover` returns for this bridge.
    const OPENRPC_GOLDEN: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openrpc/dcs_studio_mission.openrpc.json"
    );

    fn live() -> String {
        emit_surface_dlua(&Lua::new(), BridgeKind::Mission, env!("CARGO_PKG_VERSION"))
            .expect("surface")
    }

    fn live_openrpc() -> String {
        emit_openrpc_json(&Lua::new(), BridgeKind::Mission, env!("CARGO_PKG_VERSION"))
            .expect("openrpc")
    }

    /// The checked-in golden matches the live surface — the `.d.lua` facade
    /// cannot drift from what the DLL actually registers, which is what makes
    /// the editor's completion on `require("dcs_studio_mission")` trustworthy.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn golden_matches_live_surface() {
        check_or_regenerate(Path::new(GOLDEN), &live(), regenerating()).expect(
            "types/dcs_studio_mission.d.lua drifted from the live surface \
             — rerun with DCS_STUDIO_REGENERATE_GOLDENS=1 to accept the change",
        );
    }

    /// The checked-in `OpenRPC` document matches what `rpc.discover` generates
    /// from the live method registration.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn golden_matches_live_openrpc() {
        check_or_regenerate(Path::new(OPENRPC_GOLDEN), &live_openrpc(), regenerating()).expect(
            "openrpc/dcs_studio_mission.openrpc.json drifted from rpc.discover \
             — rerun with DCS_STUDIO_REGENERATE_GOLDENS=1 to accept the change",
        );
    }

    /// The `luaopen` entry point, run against a stub of the mission state's
    /// world: the embedded init is the only place `jsonrpc.serve`, the method
    /// registration and the model-time pump are wired together, and it re-runs
    /// on EVERY mission load. If it raised, `require` would fail inside DCS's
    /// mission scripting sandbox and the whole bridge would be silently absent
    /// for that mission.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_module_entry_point_runs_the_embedded_mission_init() {
        let lua = Lua::new();
        // The mission state's `env` and `timer`, which the init logs through
        // and schedules its queue pump on.
        lua.load(
            r"
            REPORTED = {}
            SCHEDULED = nil
            env = {
              info = function(msg) table.insert(REPORTED, msg) end,
              error = function(msg) table.insert(REPORTED, msg) end,
            }
            timer = {
              getTime = function() return 0 end,
              scheduleFunction = function(fn, arg, at) SCHEDULED = { fn = fn, at = at } end,
            }
            ",
        )
        .exec()
        .expect("stub the mission state");

        let exports = super::dcs_studio_mission(&lua).expect("luaopen_dcs_studio_mission");
        assert_eq!(
            exports.get::<String>("name").expect("name"),
            "dcs-studio-mission"
        );
        exports
            .get::<LuaTable>("jsonrpc")
            .expect("jsonrpc namespace");

        let reported: String = lua
            .load("return table.concat(REPORTED, ' | ')")
            .eval()
            .expect("reported");
        assert!(
            !reported.contains("failed to start"),
            "the mission bridge could not bind 127.0.0.1:25570 — is DCS already running? ({reported})"
        );
        assert!(reported.contains("25570"), "{reported}");

        // The pump is scheduled on model time, a tenth of a second out, and
        // returns its next due time — without it the queue only drains while a
        // debug session is holding the sim thread.
        let next: f64 = lua
            .load("return SCHEDULED.fn()")
            .eval()
            .expect("the scheduled pump must run and reschedule itself");
        assert!(next > 0.0, "the pump must reschedule itself: {next}");
    }

    /// Both halves of `luaopen` propagate rather than panic. `require` runs
    /// inside DCS's mission scripting sandbox, which catches a Lua error and
    /// logs it — the mission keeps running with no bridge, which is recoverable
    /// — whereas a panic unwinding out of the DLL takes the whole sim down.
    ///
    /// The two failures are the two calls: the shared bootstrap (reading a
    /// `debug` global whose metatable raises is beyond what the engine's guards
    /// can catch), and the embedded init (a state missing `timer`, which it
    /// schedules its queue pump on).
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_state_the_bridge_cannot_be_installed_into_fails_the_require() {
        let hostile = Lua::new();
        hostile
            .load(
                r#"
                debug = setmetatable({}, {
                  __index = function(_, k) error("no debug." .. tostring(k) .. " here", 0) end,
                })
                "#,
            )
            .exec()
            .expect("plant a hostile debug global");
        let err = super::dcs_studio_mission(&hostile).expect_err("bootstrap cannot finish");
        assert!(
            err.to_string().contains("no debug."),
            "the cause reaches the mission log: {err}"
        );

        // A state with no `timer` at all: the init gets as far as the queue
        // pump it has nowhere to schedule, and says so.
        let no_timer = Lua::new();
        let err = super::dcs_studio_mission(&no_timer).expect_err("the init cannot finish");
        assert!(
            err.to_string().contains("timer"),
            "the cause names what the mission state was missing: {err}"
        );
    }
}
