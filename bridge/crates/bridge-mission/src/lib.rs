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

#[mlua::lua_module]
pub fn dcs_studio_mission(lua: &Lua) -> LuaResult<LuaTable> {
    let exports = dcs_bridge_core::bootstrap(lua, BridgeKind::Mission, env!("CARGO_PKG_VERSION"))?;
    lua.load(MISSION_INIT_SOURCE)
        .set_name("=dcs_studio_mission_init")
        .call::<()>(&exports)?;
    Ok(exports)
}

#[cfg(test)]
mod tests {
    use dcs_bridge_core::{emit_surface_dlua, BridgeKind};

    /// The checked-in golden: regenerated from the live surface. mlua tests
    /// need a real Lua 5.1 at runtime: on Windows that is DCS's own `lua.dll`
    /// (put it on PATH and run with `-- --include-ignored`); on non-Windows,
    /// core's build.rs links PUC liblua5.1 so Linux CI runs them ordinarily.
    const GOLDEN: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/types/dcs_studio_mission.d.lua"
    );

    fn live() -> String {
        emit_surface_dlua(BridgeKind::Mission, env!("CARGO_PKG_VERSION")).expect("surface")
    }

    #[test]
    #[ignore = "regeneration tool — rewrites the checked-in golden; run explicitly"]
    fn regenerate_dlua_golden() {
        // Temp-write + rename: under `--include-ignored` this runs in parallel
        // with [`golden_matches_live_surface`]'s read of the same file — the
        // swap must be atomic so that read can never tear.
        let tmp = format!("{GOLDEN}.tmp");
        std::fs::write(&tmp, live()).expect("write golden tmp");
        std::fs::rename(&tmp, GOLDEN).expect("swap golden into place");
    }

    /// The checked-in golden matches the live surface — the `.d.lua` facade
    /// cannot drift from what the DLL actually registers. On an intentional
    /// surface change, regenerate with [`regenerate_dlua_golden`].
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn golden_matches_live_surface() {
        let want = live().replace("\r\n", "\n");
        let got = std::fs::read_to_string(GOLDEN)
            .expect("read golden")
            .replace("\r\n", "\n");
        assert_eq!(
            got, want,
            "types/dcs_studio_mission.d.lua drifted from the live surface — rerun regenerate_dlua_golden"
        );
    }
}
