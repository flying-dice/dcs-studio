#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
// idiomatic in tests

//! The GUI bridge's `eval` RPC refuses the DCS calls that kill the process
//! (card 19).
//!
//! `repl_eval` and friends compile inside the RT, so `surface.rs`'s guard suite
//! covers them; `eval` loads its own chunk with a bare `loadstring` and is the
//! one path that could quietly skip the guard. It is also the path the crash was
//! found on — a user typing `DCS.getMissionLoaded()` into the Lua Console with a
//! mission loaded takes the whole sim down, with no Lua error anywhere, because
//! the fault is an `ACCESS_VIOLATION` in ED's cross-state value copy that no pcall
//! can contain.
//!
//! The real getter cannot appear in a test (that is the point of the guard), so
//! `DCS.getMissionLoaded` here is a stub that records having been called. The
//! claim under test is exactly "the bridge never calls it".
//!
//! Windows-gated like the rest of the suite: the test binary links DCS's own
//! lua.dll, so put it on PATH and run with `-- --include-ignored`.

mod support;

use dcs_bridge_core::{bootstrap, BridgeKind};
use mlua::prelude::{LuaFunction, LuaTable};
use mlua::Lua;
use support::lua_cov::CoveredLua;

/// A bootstrapped GUI state with the shipped method set registered against a
/// plain-table stub router, exactly as the headless `OpenRPC` test does — but with
/// real `deps`, so the handlers can be called. Returns the state; the registered
/// handlers live in the global `HANDLERS`.
fn gui_state() -> CoveredLua {
    // SAFETY: test harness, not the DLL. `unsafe_new` loads the debug stdlib,
    // which both live DCS states also provide.
    let lua = unsafe { Lua::unsafe_new() };
    let lua = CoveredLua::new(lua);
    lua.load(
        r#"
        REACHED = false
        -- The sim, reduced to what the eval handler touches. getMissionLoaded
        -- stands in for the getter that kills DCS 2.9.27.
        DCS = {
          getMissionLoaded = function() REACHED = true return "boom" end,
          getMissionName = function() return "Free flight" end,
          getModelTime = function() return 0 end,
        }
        "#,
    )
    .exec()
    .expect("stub sim");
    // The bootstrap resolves its log path under lfs.writedir(); point that at a
    // temp dir so the run leaves no `Logs/` behind in the crate.
    let tmp = std::env::temp_dir().to_string_lossy().replace('\\', "\\\\");
    lua.load(format!(
        "lfs = {{ writedir = function() return \"{tmp}\" end }}"
    ))
    .exec()
    .expect("stub lfs");

    let exports = bootstrap(&lua, BridgeKind::Gui, "0.0.0-test").expect("bootstrap");
    lua.globals().set("bridge", &exports).expect("set bridge");
    lua.load(
        "
        HANDLERS = {}
        local router = { add_method = function(_self, name, fn) HANDLERS[name] = fn end }
        bridge.register_methods(router, { bridge = bridge, DBG = __DCS_STUDIO_DBG, RT = __DCS_STUDIO_RT })
        ",
    )
    .exec()
    .expect("register methods");
    lua
}

/// `eval` of a safe getter answers it; `eval` of the process-killing one raises
/// a truthful error and never reaches the function.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn eval_refuses_the_process_killing_getter_and_serves_the_rest() {
    let lua = gui_state();
    let handlers: LuaTable = lua.globals().get("HANDLERS").expect("handlers");
    let eval: LuaFunction = handlers.get("eval").expect("eval handler");

    let params = lua.create_table().expect("params");
    params
        .set("code", "return DCS.getMissionName()")
        .expect("set code");
    let name: String = eval.call(&params).expect("safe eval");
    assert_eq!(name, "Free flight", "a safe getter still answers");

    params
        .set("code", "return DCS.getMissionLoaded()")
        .expect("set code");
    let err = eval
        .call::<mlua::Value>(&params)
        .expect_err("the blocked getter must raise")
        .to_string();
    assert!(
        err.contains("getMissionLoaded") && err.contains("crashes DCS"),
        "the error names the getter and why: {err}"
    );
    assert!(
        err.contains("getMissionName"),
        "the error offers a safe alternative: {err}"
    );

    let reached: bool = lua.globals().get("REACHED").expect("REACHED");
    assert!(!reached, "the real getter was never called");

    // Dynamic spelling goes through the same guarded table, not a source scan.
    params
        .set("code", r#"return DCS["get" .. "MissionLoaded"]()"#)
        .expect("set code");
    assert!(
        eval.call::<mlua::Value>(&params).is_err(),
        "a computed key is blocked too"
    );
    let reached: bool = lua.globals().get("REACHED").expect("REACHED");
    assert!(!reached, "still never called");

    // Global side effects of an eval'd chunk still land in _G.
    params
        .set("code", "FROM_EVAL = 'landed' return FROM_EVAL")
        .expect("set code");
    let echoed: String = eval.call(&params).expect("global write eval");
    let landed: String = lua.globals().get("FROM_EVAL").expect("FROM_EVAL");
    assert_eq!((echoed.as_str(), landed.as_str()), ("landed", "landed"));
}
