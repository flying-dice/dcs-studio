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
    use dcs_bridge_core::{emit_openrpc_json, emit_surface_dlua, BridgeKind};

    /// The checked-in golden: regenerated from the live surface. mlua tests
    /// need a real Lua 5.1 at runtime: on Windows that is DCS's own `lua.dll`
    /// (put it on PATH and run with `-- --include-ignored`); on non-Windows,
    /// core's build.rs links PUC liblua5.1 so Linux CI runs them ordinarily.
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
        emit_surface_dlua(BridgeKind::Mission, env!("CARGO_PKG_VERSION")).expect("surface")
    }

    fn live_openrpc() -> String {
        emit_openrpc_json(BridgeKind::Mission, env!("CARGO_PKG_VERSION")).expect("openrpc")
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

    #[test]
    #[ignore = "regeneration tool — rewrites the checked-in golden; run explicitly"]
    fn regenerate_openrpc_golden() {
        let tmp = format!("{OPENRPC_GOLDEN}.tmp");
        std::fs::write(&tmp, live_openrpc()).expect("write openrpc golden tmp");
        std::fs::rename(&tmp, OPENRPC_GOLDEN).expect("swap openrpc golden into place");
    }

    /// The checked-in `OpenRPC` document matches what `rpc.discover` generates
    /// from the live method registration. On an intentional method-set change,
    /// regenerate with [`regenerate_openrpc_golden`].
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn golden_matches_live_openrpc() {
        let want = live_openrpc().replace("\r\n", "\n");
        let got = std::fs::read_to_string(OPENRPC_GOLDEN)
            .expect("read openrpc golden")
            .replace("\r\n", "\n");
        assert_eq!(
            got, want,
            "openrpc/dcs_studio_mission.openrpc.json drifted from rpc.discover — rerun regenerate_openrpc_golden"
        );
    }
}
