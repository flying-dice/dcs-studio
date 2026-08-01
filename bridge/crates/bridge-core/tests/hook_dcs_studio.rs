#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
// idiomatic in tests

//! `bridge/hook/DcsStudio.lua`, the file DCS itself loads at startup.
//!
//! It had no test of any kind — not this suite, not the extension's. The only
//! other mention of it in the workspace is `debug_ws_latency.rs`, which writes
//! a minimal hook of its own rather than loading this one, so every line here
//! shipped unexercised: the `pcall` around `onSimulationFrame`, the
//! `FRAME_ERROR_INTERVAL` throttle, and the `logger_level` this branch turned
//! down from `info`.
//!
//! Nothing about it needs DCS. Its whole surface is five globals the sim
//! provides (`lfs`, `log`, `DCS`, `package.cpath`, and the module it requires),
//! so the sim is stubbed and the real chunk runs — which is the point: the
//! thing under test is the file that ships, not a paraphrase of it.
//!
//! What is deliberately NOT covered here is anything the stubs stand in for:
//! that a real `JsonRpcServer` binds 25569, that `DCS.setUserCallbacks` is the
//! right callback name, that `onSimulationFrame` fires at the menu. Those are
//! claims about DCS and only a live sim can settle them (issue #65).

mod support;

use dcs_bridge_core::{bootstrap, BridgeKind};
use mlua::{Lua, Table};
use support::lua_cov::CoveredLua;

/// The shipped hook, verbatim. `include_str!` rather than a path read so a
/// moved or renamed file fails the build instead of the test.
const HOOK: &str = include_str!("../../../hook/DcsStudio.lua");

/// Enough of DCS to load the hook: the globals it touches, plus a fake module
/// standing in for the DLL, all recording into a `SPY` table.
///
/// `os.clock` is replaced rather than the whole `os` table, because the hook's
/// error throttle reads it and the test has to be able to move it.
const SIM: &str = r#"
SPY = { logs = {}, callbacks = nil, pumped = 0, boot_ticks = 0, boot_dispatches = 0 }
CLOCK = 0
FAIL_PUMP = nil
FAIL_BOOT = nil

os.clock = function() return CLOCK end

lfs = { writedir = function() return "C:\\SG\\DCS\\" end }

log = {
  ERROR = "ERROR",
  INFO = "INFO",
  write = function(tag, level, msg)
    SPY.logs[#SPY.logs + 1] = { tag = tag, level = level, msg = msg }
  end,
}

DCS = { setUserCallbacks = function(cb) SPY.callbacks = cb end }

package.preload["dcs_studio_gui"] = function()
  return {
    jsonrpc = {
      -- `serve` hands back userdata that owns the server; the hook parks it in
      -- its frame callbacks, which is what this stub stands in for.
      serve = function(cfg)
        SPY.server_cfg = cfg
        return {
          process_rpc = function(_self, _router)
            SPY.pumped = SPY.pumped + 1
            if FAIL_PUMP then error(FAIL_PUMP, 0) end
          end,
        }
      end,
      JsonRpcRouter = { new = function() return { is_router = true } end },
    },
    register_methods = function(_router, ctx)
      SPY.ctx = ctx
      return {
        mission_boot_tick = function() SPY.boot_ticks = SPY.boot_ticks + 1 end,
        dispatch_mission_boot = function()
          SPY.boot_dispatches = SPY.boot_dispatches + 1
          if FAIL_BOOT then error(FAIL_BOOT, 0) end
        end,
      }
    end,
  }
end
"#;

/// A Lua state with the sim stubbed and the real hook loaded.
fn hooked() -> Lua {
    // SAFETY: test harness, not the DLL. The hook runs in DCS's own GameGUI
    // state, which has the full standard library.
    let lua = unsafe { Lua::unsafe_new() };
    lua.load(SIM).exec().expect("stub the sim");
    lua.load(HOOK).exec().expect("load the hook");
    lua
}

/// Every `log.write` the hook has made so far, as `LEVEL: message`.
fn logs(lua: &Lua) -> Vec<String> {
    lua.load(
        r"
        local out = {}
        for _, e in ipairs(SPY.logs) do out[#out + 1] = e.level .. ': ' .. e.msg end
        return out
        ",
    )
    .eval()
    .expect("read the log spy")
}

/// Just the error lines — the hook also logs one INFO line on a good start.
fn errors(lua: &Lua) -> Vec<String> {
    logs(lua)
        .into_iter()
        .filter(|l| l.starts_with("ERROR"))
        .collect()
}

/// Run the registered `onSimulationFrame` once, as DCS would.
fn frame(lua: &Lua) {
    lua.load("SPY.callbacks.onSimulationFrame()")
        .exec()
        .expect("the frame callback must never raise into DCS's dispatcher");
}

/// Run the registered `onSimulationStart` once, as DCS would at mission start.
fn sim_start(lua: &Lua) {
    lua.load("SPY.callbacks.onSimulationStart()")
        .exec()
        .expect("the start callback must never raise into DCS's dispatcher");
}

#[test]
fn the_hook_keeps_the_log_level_that_keeps_the_sim_thread_quiet() {
    // At `info` the DLL writes every RPC response body — including the whole
    // pause snapshot, four times a second while a debug session is held — to a
    // non-rolling file, synchronously, on the sim thread.
    let lua = hooked();
    let level: String = lua
        .load("DCS_STUDIO.logger_level")
        .eval()
        .expect("the level");
    assert_eq!(level, "warn");
}

/// The bug card 16 exists for. DCS does not run a hook chunk with `_G` as its
/// environment: it hands each `Scripts/Hooks` file its own table (reads fall
/// through to `_G`, writes do not come back). A bare `DCS_STUDIO = ...` in the
/// hook therefore set a key nobody reads — `lua_getglobal` in the DLL saw nil,
/// `bootstrap` defaulted, and the bridge shipped at TRACE. Loading the hook
/// under exactly that environment is the only place this can be caught without
/// a sim, so it is asserted against `_G`, not against the chunk's own env.
#[test]
fn the_level_reaches_real_globals_even_when_dcs_sandboxes_the_hook() {
    let lua = unsafe { Lua::unsafe_new() };
    lua.load(SIM).exec().expect("stub the sim");
    lua.globals()
        .set("HOOK_SRC", HOOK)
        .expect("hand over the hook source");
    lua.load(
        r"
        local env = setmetatable({}, { __index = _G })
        local chunk = assert(loadstring(HOOK_SRC, 'DcsStudio.lua'))
        setfenv(chunk, env)
        chunk()
        SANDBOX = env
        ",
    )
    .exec()
    .expect("load the hook in a hook environment");

    let level: String = lua
        .load("rawget(_G, 'DCS_STUDIO').logger_level")
        .eval()
        .expect("the level must be in the globals the DLL reads");
    assert_eq!(level, "warn");
    // And the rest of the hook still ran in that environment — a sandbox that
    // broke `require` would make the assertion above meaningless.
    let bound: bool = lua
        .load("SPY.callbacks ~= nil")
        .eval()
        .expect("callback spy");
    assert!(bound, "the sandboxed hook still starts the bridge");
}

#[test]
fn a_failed_module_load_says_so_and_registers_nothing() {
    let lua = unsafe { Lua::unsafe_new() };
    lua.load(SIM).exec().expect("stub the sim");
    lua.load(r#"package.preload["dcs_studio_gui"] = function() error("no such DLL", 0) end"#)
        .exec()
        .expect("break the module");
    lua.load(HOOK).exec().expect("the hook must not raise");

    assert_eq!(logs(&lua), vec!["ERROR: load failed: no such DLL"]);
    // Registering callbacks that close over a module that failed to load would
    // turn one bad load into an error on every frame for the rest of the session.
    let registered: bool = lua
        .load("SPY.callbacks ~= nil")
        .eval()
        .expect("callback spy");
    assert!(
        !registered,
        "no callbacks may be registered after a failed load"
    );
}

#[test]
fn the_frame_callback_drains_the_queue_and_ticks_the_mission_boot() {
    let lua = hooked();
    frame(&lua);
    frame(&lua);

    let (pumped, ticks): (u32, u32) = lua
        .load("SPY.pumped, SPY.boot_ticks")
        .eval()
        .expect("frame spies");
    assert_eq!((pumped, ticks), (2, 2));
    assert_eq!(errors(&lua), Vec::<String>::new(), "a good frame is quiet");
}

#[test]
fn a_raise_inside_the_frame_callback_is_reported_instead_of_escaping() {
    // Without the pcall the raise disappears into DCS's callback dispatcher
    // with nothing on the bridge side, AND the RPC drain is skipped — so the
    // editor sees a bridge that is up and answering nothing.
    let lua = hooked();
    lua.load(r#"FAIL_PUMP = "attempt to index a nil value (global 'net')""#)
        .exec()
        .expect("arm the fault");

    frame(&lua);

    assert_eq!(
        errors(&lua),
        vec![
            "ERROR: simulation frame error: attempt to index a nil value (global 'net')"
                .to_string()
        ]
    );
}

#[test]
fn a_persistent_frame_fault_is_throttled_rather_than_repeated_every_frame() {
    // The callback runs ~60 times a second forever. An unthrottled report of a
    // persistent fault writes roughly 200,000 lines a minute into dcs.log —
    // which is both the diagnostic and the disk.
    let lua = hooked();
    lua.load(r#"FAIL_PUMP = "still broken""#)
        .exec()
        .expect("arm the fault");

    for _ in 0..600 {
        frame(&lua);
    }
    assert_eq!(errors(&lua).len(), 1, "one line for the first fault");

    // Under the interval: still nothing new.
    lua.load("CLOCK = 9.5").exec().expect("advance the clock");
    frame(&lua);
    assert_eq!(errors(&lua).len(), 1, "9.5s is inside the 10s interval");

    // Past it: one more, so a fault that outlives the window is still visible.
    lua.load("CLOCK = 10.5").exec().expect("advance the clock");
    frame(&lua);
    assert_eq!(
        errors(&lua).len(),
        2,
        "past 10s the fault is reported again"
    );
}

#[test]
fn the_mission_boot_is_dispatched_when_a_mission_starts() {
    let lua = hooked();
    sim_start(&lua);

    let dispatches: u32 = lua.load("SPY.boot_dispatches").eval().expect("boot spy");
    assert_eq!(dispatches, 1);
    assert_eq!(errors(&lua), Vec::<String>::new(), "a good start is quiet");
}

#[test]
fn a_raise_inside_the_start_callback_is_reported_instead_of_escaping() {
    // `onSimulationStart` is a DCS C++ entry point exactly like the frame
    // callback, and what it calls reaches live globals in a state shared with
    // every other mod — `lfs.writedir` and `net.dostring_in`, inside
    // dispatch_mission_boot. Unprotected, a raise from either went straight into
    // DCS's dispatcher: the mission bridge never booted, and nothing on the
    // bridge side said so.
    let lua = hooked();
    lua.load(r#"FAIL_BOOT = "attempt to call a nil value (field 'writedir')""#)
        .exec()
        .expect("arm the fault");

    sim_start(&lua); // the `expect` inside is the assertion: it must not raise

    assert_eq!(
        errors(&lua),
        vec![
            "ERROR: simulation start error: attempt to call a nil value (field 'writedir')"
                .to_string()
        ]
    );
}

/// The two callbacks throttle independently. A frame fault fires 60 times a
/// second and would otherwise consume the throttle window that the once-per-
/// mission start report has to fit into — hiding the one line that explains why
/// the mission bridge is not there.
#[test]
fn a_frame_fault_does_not_swallow_the_report_a_mission_start_gets() {
    let lua = hooked();
    lua.load(r#"FAIL_PUMP = "still broken"; FAIL_BOOT = "no writedir""#)
        .exec()
        .expect("arm both faults");

    frame(&lua);
    sim_start(&lua);

    assert_eq!(
        errors(&lua),
        vec![
            "ERROR: simulation frame error: still broken".to_string(),
            "ERROR: simulation start error: no writedir".to_string(),
        ],
        "each callback reports its own first fault"
    );
}

/// A mission started, then restarted, inside one throttle window: the start
/// callback throttles too, since a persistent fault will report on every
/// mission load for the rest of the session.
#[test]
fn a_repeated_start_fault_is_throttled_like_the_frame_one() {
    let lua = hooked();
    lua.load(r#"FAIL_BOOT = "no writedir""#)
        .exec()
        .expect("arm the fault");

    sim_start(&lua);
    sim_start(&lua);
    assert_eq!(errors(&lua).len(), 1, "one line inside the window");

    lua.load("CLOCK = 10.5").exec().expect("advance the clock");
    sim_start(&lua);
    assert_eq!(errors(&lua).len(), 2, "past 10s it is reported again");
}

#[test]
fn a_debug_engine_that_installed_gets_its_pump_wired() {
    let lua = unsafe { Lua::unsafe_new() };
    lua.load(SIM).exec().expect("stub the sim");
    lua.load("__DCS_STUDIO_DBG = {}")
        .exec()
        .expect("an installed engine");
    lua.load(HOOK).exec().expect("load the hook");

    // The pump is how a paused chunk keeps answering the editor: while it holds
    // the sim thread, onSimulationFrame cannot fire, so the engine drains the
    // queue through this closure instead.
    lua.load("__DCS_STUDIO_DBG.pump()")
        .exec()
        .expect("the engine's pump");
    let pumped: u32 = lua.load("SPY.pumped").eval().expect("pump spy");
    assert_eq!(pumped, 1);

    let ctx: Table = lua.load("SPY.ctx").eval().expect("registration context");
    assert!(
        ctx.get::<Option<Table>>("DBG").expect("DBG key").is_some(),
        "the methods are registered against the engine that installed"
    );
}

#[test]
fn a_debug_engine_that_declined_costs_breakpoints_and_nothing_else() {
    // debug_engine.lua is DESIGNED to decline in a state without debug or
    // coroutine, and the DLL only warns. An `assert` here used to turn that
    // into no server, no methods and no GUI bridge at all — the whole product
    // lost to a feature declining exactly as intended.
    let lua = hooked(); // __DCS_STUDIO_DBG is nil
    let registered: bool = lua
        .load("SPY.callbacks ~= nil")
        .eval()
        .expect("callback spy");
    assert!(registered, "the bridge must still serve without a debugger");

    frame(&lua);
    let pumped: u32 = lua.load("SPY.pumped").eval().expect("pump spy");
    assert_eq!(pumped, 1, "RPCs are still drained");

    let ctx: Table = lua.load("SPY.ctx").eval().expect("registration context");
    assert!(
        ctx.get::<Option<Table>>("DBG").expect("DBG key").is_none(),
        "methods that need the debugger answer for themselves"
    );
    assert_eq!(
        errors(&lua),
        Vec::<String>::new(),
        "declining is not an error"
    );
}

#[test]
fn the_server_is_bound_to_loopback_with_a_timeout_under_the_default() {
    // 30s rather than the 300s default: a stalled editor request must not be
    // able to wedge the WS read loop for minutes. Long enough for the console
    // calls that serialize big tables on the sim thread.
    let lua = hooked();
    let cfg: Table = lua.load("SPY.server_cfg").eval().expect("server config");
    assert_eq!(cfg.get::<String>("host").expect("host"), "127.0.0.1");
    assert_eq!(cfg.get::<u16>("port").expect("port"), 25569);
    assert_eq!(cfg.get::<u32>("timeout").expect("timeout"), 30);
    assert_eq!(cfg.get::<String>("env").expect("env"), "gui");
}

#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn the_stubbed_module_has_the_shape_the_real_one_does() {
    // The weakness of every test above: they drive the hook against a stub, so
    // they would all still pass if the DLL stopped exporting what the hook
    // reaches for. This is the one test that looks at the real thing — every
    // path through `bridge` that DcsStudio.lua names, on a genuinely
    // bootstrapped state, so the stub cannot quietly become fiction.
    let lua = unsafe { Lua::unsafe_new() };
    // Lua line coverage (#66); inert unless `LUA_COV_DIR` is set.
    let lua = CoveredLua::new(lua);
    let exports = bootstrap(&lua, BridgeKind::Gui, "test").expect("bootstrap");
    lua.globals().set("bridge", exports).expect("bind bridge");

    for path in [
        "bridge.register_methods",
        "bridge.jsonrpc.serve",
        "bridge.jsonrpc.JsonRpcRouter.new",
    ] {
        let kind: String = lua
            .load(format!("return type({path})"))
            .eval()
            .unwrap_or_else(|e| panic!("{path} is not reachable at all: {e}"));
        assert_eq!(kind, "function", "{path}");
    }
}

#[test]
fn the_module_is_looked_for_where_the_extension_installs_it() {
    // The hook is installed to <writedir>\Scripts\Hooks and the DLLs to
    // <writedir>\Mods\tech\DcsStudio\bin — if this path and the extension's
    // inject disagree, `require` fails and the bridge never starts.
    let lua = hooked();
    let cpath: String = lua.load("package.cpath").eval().expect("cpath");
    assert!(
        cpath.ends_with(r"C:\SG\DCS\Mods\tech\DcsStudio\bin\?.dll"),
        "{cpath}"
    );
}
