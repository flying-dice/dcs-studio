//! The GUI bridge DLL: `require("dcs_studio_gui")` from the `GameGUI` hook. A
//! thin entry point — everything lives in `dcs-bridge-core`, parametrized by
//! [`BridgeKind::Gui`].

use dcs_bridge_core::BridgeKind;
use mlua::prelude::{LuaResult, LuaTable};
use mlua::Lua;

/// The `luaopen_dcs_studio_gui` entry point DCS's `require` calls.
///
/// # Errors
///
/// Returns any `mlua` error from [`dcs_bridge_core::bootstrap`].
#[mlua::lua_module]
pub fn dcs_studio_gui(lua: &Lua) -> LuaResult<LuaTable> {
    dcs_bridge_core::bootstrap(lua, BridgeKind::Gui, env!("CARGO_PKG_VERSION"))
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
    const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/types/dcs_studio_gui.d.lua");

    /// The checked-in `OpenRPC` document `rpc.discover` returns for this bridge.
    const OPENRPC_GOLDEN: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openrpc/dcs_studio_gui.openrpc.json"
    );

    fn live() -> String {
        emit_surface_dlua(&Lua::new(), BridgeKind::Gui, env!("CARGO_PKG_VERSION")).expect("surface")
    }

    fn live_openrpc() -> String {
        emit_openrpc_json(&Lua::new(), BridgeKind::Gui, env!("CARGO_PKG_VERSION")).expect("openrpc")
    }

    /// The checked-in golden matches the live surface — the `.d.lua` facade
    /// cannot drift from what the DLL actually registers, which is what makes
    /// the editor's completion on `require("dcs_studio_gui")` trustworthy.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn golden_matches_live_surface() {
        check_or_regenerate(Path::new(GOLDEN), &live(), regenerating()).expect(
            "types/dcs_studio_gui.d.lua drifted from the live surface \
             — rerun with DCS_STUDIO_REGENERATE_GOLDENS=1 to accept the change",
        );
    }

    /// The checked-in `OpenRPC` document matches what `rpc.discover` generates
    /// from the live method registration.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn golden_matches_live_openrpc() {
        check_or_regenerate(Path::new(OPENRPC_GOLDEN), &live_openrpc(), regenerating()).expect(
            "openrpc/dcs_studio_gui.openrpc.json drifted from rpc.discover \
             — rerun with DCS_STUDIO_REGENERATE_GOLDENS=1 to accept the change",
        );
    }

    /// The `luaopen` entry point DCS's `require` calls. Everything else in this
    /// crate is tested through `dcs-bridge-core`, but the one line that names
    /// this DLL's [`BridgeKind`] is only exercised here — and getting it wrong
    /// would have the GUI hook load a module that reports itself as the mission
    /// bridge and dumps the wrong `_G` roots.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_module_entry_point_builds_the_gui_bridge() {
        let lua = Lua::new();
        let exports = super::dcs_studio_gui(&lua).expect("luaopen_dcs_studio_gui");

        assert_eq!(
            exports.get::<String>("name").expect("name"),
            "dcs-studio-gui"
        );
        assert_eq!(
            exports.get::<String>("version").expect("version"),
            env!("CARGO_PKG_VERSION")
        );
        exports
            .get::<LuaTable>("jsonrpc")
            .expect("jsonrpc namespace");
    }
}
