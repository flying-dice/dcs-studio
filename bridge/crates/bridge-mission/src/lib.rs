//! The mission bridge DLL: `require("dcs_studio_mission")` inside the mission
//! scripting state, dispatched there by the GUI hook's boot snippet at mission
//! start. Bootstraps the shared core for [`BridgeKind::Mission`], then runs
//! the embedded mission init (router, method registration, timer pump).
//!
//! The mission Lua state is destroyed and recreated per mission, and this DLL
//! image persists in the process from the first load until DCS exits — so
//! anything per-mission belongs to the STATE, not to the DLL. The server the
//! embedded init binds is userdata that state owns (card 18, iteration 3): it
//! serves for exactly as long as the mission's state holds it, and stops when
//! that state does — including from `__gc` inside DCS's own `lua_close`. What
//! genuinely spans the process is only what should: the debugger registry, the
//! console ring, the logger.
//!
//! The init is also written to be torn down per mission (issue #69): it registers
//! a release on `S_EVENT_MISSION_END` that drops every mlua handle this bridge
//! holds in the mission state, answers its stranded callers and stops its server
//! *before* DCS closes that state. See `dcs_bridge_core`'s `jsonrpc::teardown`.

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

    /// One turnstile for every test that runs the real `luaopen`, because each
    /// one binds 127.0.0.1:25570 — the real port, as a real mission does. Since
    /// card 18 each state owns its own server there, so two overlapping tests
    /// would have the second's bind refused by the first's live listener.
    fn serially() -> std::sync::MutexGuard<'static, ()> {
        static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
        SERIAL
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

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
        let _serial = serially();
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

    /// What the init must and must NOT have left in the mission state: the
    /// mission-end handler that is the primary trigger, and no globals.
    ///
    /// The second half is a regression test for two audit findings. Iteration 2's
    /// `lua_close` sentinel global is gone because the server userdata's own
    /// `Drop` is the backstop now (card 18, iteration 3). And neither the teardown
    /// nor the server may be published: a global would hand any mission script or
    /// co-installed mod a call that ends the bridge for the rest of the mission,
    /// and nothing legitimate needs one — the pump closures hold the server, which
    /// is exactly the lifetime wanted.
    fn assert_teardown_wiring(lua: &Lua) {
        assert!(
            lua.load("return HANDLER ~= nil")
                .eval::<bool>()
                .expect("the init registered its teardown"),
            "the mission-end handler must be in place — it is the trigger that \
             runs while the state is still whole"
        );
        assert!(
            lua.load(
                "return __DCS_STUDIO_MISSION_GUARD == nil and \
                 __DCS_STUDIO_MISSION_TEARDOWN == nil and \
                 __DCS_STUDIO_MISSION_SERVER == nil"
            )
            .eval::<bool>()
            .expect("check the state's globals"),
            "the retired sentinel, the teardown and the server must all be absent \
             from the globals"
        );
    }

    /// The teardown the init wires up (card 18 / issue #69), driven through the
    /// mission state's own end-of-life event.
    ///
    /// This is the trigger that has to work, because it is the only one that
    /// fires while the state is still whole: the sentinel backstop runs inside
    /// `lua_close`, by which point the router's handlers have already been
    /// dropped from `__gc` — the thing being avoided. So the wiring is pinned
    /// here: the handler is registered, an unrelated event does nothing, the
    /// mission-end event releases, and the model-time pump stops rather than
    /// dispatching into a state DCS is unloading.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_mission_init_releases_the_state_when_the_mission_ends() {
        let _serial = serially();
        let lua = Lua::new();
        // The mission state's `env`, `timer` and `world`, as the init uses them.
        lua.load(
            r"
            REPORTED = {}
            env = {
              info = function(msg) table.insert(REPORTED, msg) end,
              error = function(msg) table.insert(REPORTED, msg) end,
            }
            timer = {
              getTime = function() return 0 end,
              scheduleFunction = function(fn, arg, at) SCHEDULED = { fn = fn } end,
            }
            world = {
              event = { S_EVENT_MISSION_END = 27 },
              addEventHandler = function(handler) HANDLER = handler end,
            }
            ",
        )
        .exec()
        .expect("stub the mission state");

        super::dcs_studio_mission(&lua).expect("luaopen_dcs_studio_mission");

        assert_teardown_wiring(&lua);

        // An unrelated event must not tear the bridge down mid-mission: this
        // handler sees every event the mission raises.
        lua.load("HANDLER:onEvent({ id = 1 })")
            .exec()
            .expect("an unrelated event is ignored");
        let pumped: f64 = lua
            .load("return SCHEDULED.fn()")
            .eval()
            .expect("the pump still runs");
        assert!(pumped > 0.0, "the pump reschedules itself mid-mission");

        // A raise inside the handler body must not escape: DCS calls this from
        // its C++ event dispatcher, for every event the mission raises, and
        // there is nothing above it to catch a Lua error.
        lua.load(
            r#"
            HANDLER:onEvent(setmetatable({}, {
              __index = function() error("this event cannot be read", 0) end,
            }))
            "#,
        )
        .exec()
        .expect("a raising event must be contained, not propagated");
        let reported: String = lua
            .load("return table.concat(REPORTED, ' | ')")
            .eval()
            .expect("reported");
        assert!(
            reported.contains("teardown handler error"),
            "the contained raise must still be reported: {reported}"
        );
        assert!(
            lua.load("return SCHEDULED.fn() ~= nil")
                .eval::<bool>()
                .expect("the pump still runs"),
            "a bad event must not have torn the bridge down"
        );

        // Mission end: the release runs while the state is still usable.
        lua.load("HANDLER:onEvent({ id = world.event.S_EVENT_MISSION_END })")
            .exec()
            .expect("the mission-end event releases the state");
        let reported: String = lua
            .load("return table.concat(REPORTED, ' | ')")
            .eval()
            .expect("reported");
        assert!(
            reported.contains("released") && reported.contains("Lua handler(s)"),
            "the release must say what it let go of: {reported}"
        );
        // Card 18's second iteration: the release also stops this DLL's HTTP
        // server, and it must SAY SO through env.info. The Rust-side log line is
        // at info level and the shipped logger level is `warn`, so this dcs.log
        // line is the only diagnostic a live unload gets — and which of the two
        // branches it prints is what tells the next live session whether the
        // server stop actually ran.
        assert!(
            reported.contains("stopped its HTTP server on port 25570"),
            "the release must report the server it stopped: {reported}"
        );
        assert!(
            !reported.contains("teardown failed"),
            "the release must not have raised: {reported}"
        );

        // The pump unschedules itself: a released router answers nothing, and
        // re-entering a state DCS is unloading is the bug being removed.
        assert!(
            lua.load("return SCHEDULED.fn() == nil")
                .eval::<bool>()
                .expect("the pump must decline after teardown"),
            "returning nil is how a DCS scheduled function unschedules itself"
        );

        // Idempotent: a mission that fires its end event twice (or fires it and
        // is then collected) must not report a second release.
        let before = reported.len();
        lua.load("HANDLER:onEvent({ id = world.event.S_EVENT_MISSION_END })")
            .exec()
            .expect("a second mission-end event is a no-op");
        let after: String = lua
            .load("return table.concat(REPORTED, ' | ')")
            .eval()
            .expect("reported");
        assert_eq!(after.len(), before, "nothing more was reported: {after}");
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
        let _serial = serially();
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
