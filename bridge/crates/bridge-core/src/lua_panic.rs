//! Lua's last words.
//!
//! Lua 5.1 answers an error raised with no protected frame — the classic case
//! being an allocation that fails inside an unprotected API call — by handing
//! the state to `G(L)->panic` and then calling `exit(EXIT_FAILURE)`. Nothing
//! above it can intervene: `luaD_throw` has no `errorJmp` to longjmp to, so
//! there is no Lua error to catch, no `pcall` that returns false, and no
//! chance for `require` to come back at all. Inside DCS that is a sim which
//! closes itself mid-session leaving nothing in `dcs.log` and nothing here.
//!
//! This module cannot prevent that (see #62 — a protected-frame restructure is
//! the prevention, and is not what this is). It buys the one thing that turns
//! a vanished process into a bug report: a line in the bridge's own log naming
//! the bridge, what it was doing, and the fact that the process is ending.
//!
//! Where the unprotected call actually is: mlua protects every Lua API call it
//! makes, but *establishing* that protection means `lua_pushcfunction`, which
//! on 5.1 allocates a C closure before any `lua_pcall` exists to catch it.
//! mlua relaxes its own memory limit around exactly that push, which is why
//! squeezing a test state with `set_memory_limit` never reproduces this —
//! measured, not assumed (see the probe at the bottom of this file). In a DCS
//! module state the allocator is DCS's, mlua's limit is not in play, and that
//! push is a live way to die.

use crate::BridgeKind;
use log::error;
use mlua::prelude::LuaResult;
use mlua::{ffi, Lua};
use std::os::raw::c_int;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;
use std::sync::atomic::{AtomicU8, Ordering};

/// The bridge this DLL image serves, for the panic handler to name. A static
/// rather than a captured value because `lua_atpanic` takes a bare C function
/// pointer with nowhere to hang state; per-DLL like every other static here.
static KIND: AtomicU8 = AtomicU8::new(BridgeKind::Gui as u8);

/// What the bridge was doing when Lua last looked, for the panic handler to
/// name. Read from a C callback on the thread that is about to die, so it is
/// an atomic and not a lock: nothing may block or poison on this path.
static PHASE: AtomicU8 = AtomicU8::new(Phase::Load as u8);

/// The stages of a module load, coarse enough that each one names a distinct
/// suspect to whoever is reading the log of a DCS that closed itself.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Phase {
    /// Before the binding surface — config, logging, the exports table.
    Load,
    /// Registering the binding surface: the allocation-heavy stretch, hundreds
    /// of `create_function` calls into the host's allocator.
    Surface,
    /// Loading this bridge's JSON-RPC registration chunk.
    Methods,
    /// Installing the embedded console runtime and debug engine.
    Engine,
    /// Module load finished; the bridge is serving.
    Ready,
    /// The state is being released — handlers dropped, the queue failed, the
    /// listener stopped (see [`crate::jsonrpc::teardown`]). A different suspect
    /// from a panic while serving: this frame drops live mlua references into a
    /// state that is about to be closed, which is where card 18's crash lived.
    Teardown,
}

impl Phase {
    /// What the log line says the bridge was doing.
    pub(crate) fn describe(self) -> &'static str {
        match self {
            Phase::Load => "loading the module, before the binding surface",
            Phase::Surface => "registering the binding surface",
            Phase::Methods => "loading the JSON-RPC method registration chunk",
            Phase::Engine => "installing the console runtime and debug engine",
            Phase::Ready => "serving, after the module finished loading",
            Phase::Teardown => "releasing this state's handlers, queue and listener",
        }
    }

    /// The phase [`enter`] last recorded. The discriminants are written and
    /// read in two places, so `phase_round_trips_through_the_atomic` pins the
    /// pairing rather than trusting it.
    pub(crate) fn current() -> Self {
        match PHASE.load(Ordering::Relaxed) {
            0 => Phase::Load,
            1 => Phase::Surface,
            2 => Phase::Methods,
            3 => Phase::Engine,
            5 => Phase::Teardown,
            // Including 4. A value `enter` never wrote does not deserve a
            // distinct answer, and serving is where the bridge spends its life.
            _ => Phase::Ready,
        }
    }
}

/// Record what the bridge is about to do, so a panic during it can say so.
pub(crate) fn enter(phase: Phase) {
    PHASE.store(phase as u8, Ordering::Relaxed);
}

/// The bridge [`install`] was given, for the panic handler to name.
fn kind() -> BridgeKind {
    match KIND.load(Ordering::Relaxed) {
        0 => BridgeKind::Gui,
        _ => BridgeKind::Mission,
    }
}

/// Install the panic handler on `lua` and record which bridge it serves.
///
/// This replaces whatever the host installed, and that is deliberate: Lua
/// 5.1's stock handler (the one `luaL_newstate` installs) writes the same
/// information to stderr and returns, and the `exit` that follows is
/// `luaD_throw`'s either way. So the swap changes no behaviour at all — only
/// where the message lands, and stderr in a DCS GUI process lands nowhere a
/// user can read.
///
/// # Errors
///
/// Returns the `mlua` error from reaching the raw state, which is the only
/// route mlua 0.10 offers to `lua_atpanic`.
pub(crate) fn install(lua: &Lua, bridge: BridgeKind) -> LuaResult<()> {
    KIND.store(bridge as u8, Ordering::Relaxed);
    // SAFETY: `lua_atpanic` only swaps a function pointer in the global state —
    // it touches neither the Lua stack nor the allocator, so it upholds
    // `exec_raw`'s requirement that the closure not raise.
    unsafe {
        lua.exec_raw::<()>((), |state| {
            ffi::lua_atpanic(state, on_lua_panic);
        })
    }
}

/// The line the log gets. Assembled here rather than inline so its wording is
/// pinned by tests without a process having to die to produce it.
fn last_words(cause: &str) -> String {
    format!(
        "{}: Lua raised with no protected frame while {} — {cause}. \
         Lua 5.1 has no frame to unwind to and ends the process here, so DCS is \
         closing now and this is the last line anything will write.",
        kind().service_name(),
        Phase::current().describe(),
    )
}

/// The error object `luaD_throw` left on the stack for the handler.
///
/// Only read when it is *already* a string: `lua_tolstring` converts in place
/// otherwise, and the conversion allocates — which, in the case that brings us
/// here, is the thing that just failed. A string always converts without
/// allocating and never returns null, so there is no null case to handle.
unsafe fn error_object(state: *mut ffi::lua_State) -> String {
    if unsafe { ffi::lua_type(state, -1) } != ffi::LUA_TSTRING {
        return "the error object is not a string".to_string();
    }
    let mut len = 0;
    let text = unsafe { ffi::lua_tolstring(state, -1, &raw mut len) };
    String::from_utf8_lossy(unsafe { slice::from_raw_parts(text.cast(), len) }).into_owned()
}

/// `G(L)->panic`. Lua calls this, then calls `exit(EXIT_FAILURE)`; returning
/// is the only thing it may do, and the return value is ignored.
///
/// Logging allocates, which on a genuinely exhausted machine may itself fail —
/// this is best effort by construction. It is still the only effort available:
/// the alternative is a process that vanishes without a word.
///
/// Nothing may leave this frame except that return. `lua_CFunction` is
/// `extern "C-unwind"`, so the ABI *permits* a Rust panic to propagate — but
/// the frame it would propagate into is `luaD_throw`, C compiled with no
/// unwind tables, and unwinding into that is undefined behaviour. A failed
/// allocation aborts rather than unwinds and is therefore safe already; a
/// panic is not, and the whole `log`/`log4rs` stack runs here — an appender
/// lock, a `PatternEncoder`, a file write, any of which can panic. So the body
/// runs under `catch_unwind` and the discarded `Err` is the point: there is
/// nowhere to report a failure to log a failure, and this is the one path
/// where trying anyway would turn a diagnostic into undefined behaviour.
unsafe extern "C-unwind" fn on_lua_panic(state: *mut ffi::lua_State) -> c_int {
    // AssertUnwindSafe: the closure's only captured state is the raw pointer,
    // which it reads through `error_object` and never leaves partly written —
    // and nothing observes this process afterwards in any case, because Lua
    // calls `exit` the moment this returns.
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let cause = unsafe { error_object(state) };
        error!("{}", last_words(&cause));
    }));
    0
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{enter, error_object, kind, last_words, on_lua_panic, Phase};
    use crate::BridgeKind;
    use mlua::{ffi, Lua};

    /// The full name of [`the_probe_that_kills_this_process`] as libtest sees
    /// it, for the parent test to select in the child.
    const PROBE: &str = "lua_panic::tests::the_probe_that_kills_this_process";

    /// `enter` writes a discriminant and the handler reads one back, in two
    /// separate matches. Every phase must survive the round trip: a mismatch
    /// would put the wrong phase in the one log line anybody ever sees, and
    /// send whoever is diagnosing a closed sim at the wrong code.
    #[test]
    fn phase_round_trips_through_the_atomic() {
        for phase in [
            Phase::Load,
            Phase::Surface,
            Phase::Methods,
            Phase::Engine,
            Phase::Ready,
            Phase::Teardown,
        ] {
            enter(phase);
            let recorded = Phase::current().describe();
            assert_eq!(
                recorded,
                phase.describe(),
                "{phase:?} came back as {recorded}"
            );
        }

        // Every phase names something distinct. Two that read alike would let
        // the one log line anybody ever sees point at the wrong code, which is
        // the entire failure this vocabulary exists to prevent.
        let described = [
            Phase::Load,
            Phase::Surface,
            Phase::Methods,
            Phase::Engine,
            Phase::Ready,
            Phase::Teardown,
        ]
        .map(Phase::describe);
        let unique: std::collections::BTreeSet<&str> = described.iter().copied().collect();
        assert_eq!(unique.len(), described.len(), "{described:?}");
    }

    /// **The vocabulary predated the Lua-owned-userdata refactor**, so everything
    /// after the module finished loading reported "serving" — including a
    /// mission-end release, which is the frame card 18's crash actually lived
    /// in, and including the *next* mission's module load, because the phase
    /// lives in a per-DLL static and `luaopen` runs again for every mission.
    ///
    /// So the two ends are pinned here: a release says it is releasing, and a
    /// fresh bootstrap goes back to the beginning rather than inheriting the
    /// previous mission's last word.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_release_and_the_next_mission_are_named_rather_than_reported_as_serving() {
        let _serial = crate::jsonrpc::serially();
        let lua = Lua::new();
        crate::bootstrap(&lua, BridgeKind::Mission, "test").expect("bootstrap");
        assert_eq!(Phase::current().describe(), Phase::Ready.describe());

        let port = crate::jsonrpc::server::free_port();
        let mut server = crate::jsonrpc::server::JsonRpcServer::new(
            serde_json::from_str(&format!(
                r#"{{"host":"127.0.0.1","port":{port},"env":"mission"}}"#
            ))
            .unwrap(),
        )
        .expect("a free port binds");
        let mut router = crate::jsonrpc::router::JsonRpcRouter::default();
        crate::jsonrpc::teardown::release(&mut server, &mut router, "mission end");
        assert_eq!(
            Phase::current().describe(),
            Phase::Teardown.describe(),
            "the mission state's last act is what a panic there must be blamed on"
        );

        // The next mission's luaopen, into a fresh state over the same DLL
        // image. Without the reset this would still say "releasing".
        let next = Lua::new();
        crate::bootstrap(&next, BridgeKind::Mission, "test").expect("bootstrap");
        assert_eq!(
            Phase::current().describe(),
            Phase::Ready.describe(),
            "a fresh load walks Load..Ready again rather than inheriting"
        );

        // The GUI bridge's state outlives every mission, so a release evaluated
        // against it must hand the phase back rather than leave every later
        // panic misnamed for the rest of the process.
        let gui_port = crate::jsonrpc::server::free_port();
        let mut gui = crate::jsonrpc::server::JsonRpcServer::new(
            serde_json::from_str(&format!(
                r#"{{"host":"127.0.0.1","port":{gui_port},"env":"gui"}}"#
            ))
            .unwrap(),
        )
        .expect("a free port binds");
        crate::jsonrpc::teardown::release(&mut gui, &mut router, "requested");
        assert_eq!(
            Phase::current().describe(),
            Phase::Ready.describe(),
            "the GUI bridge goes straight back to serving, and says so"
        );
    }

    /// The line has to be readable by someone who is looking at a DCS that
    /// closed itself: which bridge, what it was doing, why nothing else was
    /// logged. Both bridges must name themselves — the two DLLs write to
    /// different files, but the line gets pasted into issues on its own.
    #[test]
    fn the_line_names_the_bridge_the_phase_and_the_ending() {
        for (bridge, service) in [
            (BridgeKind::Gui, "dcs-studio-gui"),
            (BridgeKind::Mission, "dcs-studio-mission"),
        ] {
            super::KIND.store(bridge as u8, std::sync::atomic::Ordering::Relaxed);
            assert_eq!(kind().service_name(), service);

            enter(Phase::Surface);
            let line = last_words("not enough memory");
            assert!(line.starts_with(service), "{line}");
            assert!(line.contains("registering the binding surface"), "{line}");
            assert!(line.contains("not enough memory"), "{line}");
            assert!(line.contains("ends the process here"), "{line}");
        }
    }

    /// The handler reads the error object Lua leaves on the stack. A string
    /// (what `LUA_ERRMEM` produces) reaches the log verbatim; anything else is
    /// reported as itself rather than converted, because converting allocates
    /// and the caller is here precisely because an allocation failed.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_error_object_reaches_the_log_only_when_reading_it_is_free() {
        let lua = Lua::new();
        let mut string_cause = String::new();
        let mut table_cause = String::new();
        let mut returned = 0;
        // SAFETY: each closure leaves the stack as it found it, and the handler
        // only reads — nothing here raises, as `exec_raw` requires.
        unsafe {
            lua.exec_raw::<()>((), |state| {
                ffi::lua_pushstring(state, c"not enough memory".as_ptr());
                string_cause = error_object(state);
                returned = on_lua_panic(state);
                ffi::lua_pop(state, 1);

                ffi::lua_createtable(state, 0, 0);
                table_cause = error_object(state);
                ffi::lua_pop(state, 1);
            })
        }
        .expect("drive the handler on a raw state");

        assert_eq!(string_cause, "not enough memory");
        assert_eq!(table_cause, "the error object is not a string");
        assert_eq!(returned, 0, "the handler must return to Lua, not unwind");
    }

    /// The whole point, proved end to end rather than reasoned about: a real
    /// `luaD_throw` with no protected frame must reach our handler, the handler
    /// must get its line onto disc, and only then may the process die.
    ///
    /// Run as a CHILD, because the process it proves things about does not
    /// survive: the child's cwd is a fresh directory, `bootstrap` falls back to
    /// logging beside the process when there is no write root, and the log it
    /// leaves behind is the evidence. `exit(EXIT_FAILURE)` is status 1 —
    /// asserted, so that a child which died some other way cannot pass.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_lua_panic_reaches_the_log_before_the_process_dies() {
        let root =
            std::env::temp_dir().join(format!("dcs-studio-lua-panic-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("child working directory");

        let child = std::process::Command::new(std::env::current_exe().expect("this test binary"))
            .args(["--exact", "--ignored", "--nocapture", PROBE])
            .current_dir(&root)
            .output()
            .expect("run the probe as a child");

        let log = std::fs::read_to_string(root.join("dcs_studio_gui.log")).unwrap_or_default();
        assert_eq!(
            child.status.code(),
            Some(1),
            "the child must die the way Lua kills DCS — exit(EXIT_FAILURE): {log}"
        );
        assert!(
            log.contains(
                "dcs-studio-gui: Lua raised with no protected frame while \
                 registering the binding surface — not enough memory."
            ),
            "the last thing the process did must be to say what it was doing: {log}"
        );

        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// A panic in the log stack must not escape the handler.
    ///
    /// `lua_CFunction` is `extern "C-unwind"`, so an escaping panic would
    /// unwind into `luaD_throw` — C with no unwind tables — which is undefined
    /// behaviour on the one path whose entire job is to leave a diagnostic
    /// behind. `error!` is not a small call: it is an appender lock, a
    /// `PatternEncoder` and a file write, and a poisoned lock alone is enough.
    ///
    /// Run as a CHILD for the same reason as the panic probe, though a
    /// different one: `log` takes exactly one logger per process and several
    /// tests here bootstrap log4rs, so a logger that panics on demand has to be
    /// installed in a process where it is the first and only one.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_panic_while_logging_does_not_escape_the_handler() {
        let child = std::process::Command::new(std::env::current_exe().expect("this test binary"))
            .args(["--exact", "--ignored", "--nocapture", LOGGER_PROBE])
            .output()
            .expect("run the logging probe as a child");

        let stderr = String::from_utf8_lossy(&child.stderr).into_owned();
        assert!(
            child.status.success(),
            "the handler must swallow the panic and return: {stderr}"
        );
    }

    /// A `log::Log` that panics the way a poisoned appender lock would.
    struct PanickingLogger;

    impl log::Log for PanickingLogger {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, _: &log::Record) {
            panic!("the appender lock was poisoned");
        }
        fn flush(&self) {}
    }

    /// The full name of [`the_probe_whose_logger_panics`] as libtest sees it.
    const LOGGER_PROBE: &str = "lua_panic::tests::the_probe_whose_logger_panics";

    /// Drives the handler with a logger that panics. `#[ignore]`d because it
    /// installs that logger process-wide, which every other test in this binary
    /// would then trip over; run as a child by
    /// `a_panic_while_logging_does_not_escape_the_handler`.
    ///
    /// The pass condition is that this test *finishes*: without `catch_unwind`
    /// in the handler the panic propagates out of `on_lua_panic` and libtest
    /// fails the child. In DCS there is no libtest — there is `luaD_throw`.
    #[test]
    #[ignore = "installs a process-wide panicking logger; driven as a child by a_panic_while_logging_does_not_escape_the_handler"]
    fn the_probe_whose_logger_panics() {
        log::set_boxed_logger(Box::new(PanickingLogger)).expect("the first logger in this process");
        log::set_max_level(log::LevelFilter::Error);
        // Guards the probe: if the logger were not actually reached, the
        // handler would have nothing to survive and this test would pass by
        // doing nothing at all.
        assert!(
            log::log_enabled!(log::Level::Error),
            "the panicking logger must be the one `error!` reaches"
        );

        let lua = Lua::new();
        let mut returned = -1;
        // SAFETY: as in the sibling test — the closure pushes a string, reads it
        // back through the handler and pops it, leaving the stack as it found it.
        unsafe {
            lua.exec_raw::<()>((), |state| {
                ffi::lua_pushstring(state, c"not enough memory".as_ptr());
                returned = on_lua_panic(state);
                ffi::lua_pop(state, 1);
            })
        }
        .expect("drive the handler on a raw state");

        assert_eq!(returned, 0, "the handler must still return 0 to Lua");
        // Whatever the appender was mid-way through, the process is about to
        // end; a real handler's last act would be this too.
        log::logger().flush();
    }

    /// The reproduction itself. **This test ends the process**, which is the
    /// behaviour under test, so it is `#[ignore]`d and driven as a child by
    /// `a_lua_panic_reaches_the_log_before_the_process_dies`. To watch it
    /// happen by hand:
    ///
    /// ```text
    /// cargo test -p dcs-bridge-core --lib -- --ignored --exact \
    ///   lua_panic::tests::the_probe_that_kills_this_process
    /// ```
    ///
    /// and expect the runner to die with no test summary — that is the pass.
    ///
    /// The bridge is bootstrapped for real, then the phase is set back to the
    /// one #62 is about (a panic *during* registration is the case that cannot
    /// be caught, and cannot be provoked from outside `bootstrap`). The kill is
    /// an allocating Lua API call made straight on the raw state with no
    /// `lua_pcall` anywhere above it, under a ceiling that guarantees the
    /// allocation fails — the exact shape of the `lua_pushcfunction` inside
    /// mlua's own protection setup, which is the call DCS's allocator can fail.
    #[test]
    #[ignore = "ends the process on purpose; driven as a child by a_lua_panic_reaches_the_log_before_the_process_dies"]
    fn the_probe_that_kills_this_process() {
        let lua = Lua::new();
        crate::bootstrap(&lua, BridgeKind::Gui, "probe").expect("bootstrap");
        enter(Phase::Surface);

        let mut state = std::ptr::null_mut();
        // SAFETY: the closure only copies the state pointer out; the pointer
        // stays valid because `lua` outlives every use of it below.
        unsafe { lua.exec_raw::<()>((), |raw| state = raw) }.expect("reach the raw state");

        lua.gc_collect()
            .expect("settle the heap before measuring it");
        lua.set_memory_limit(lua.used_memory())
            .expect("mlua owns this state's allocator");
        // SAFETY: unprotected on purpose. This is the call under test: there is
        // no `lua_pcall` above it, the table cannot fit under the ceiling, and
        // Lua 5.1 answers that by calling the panic handler and exiting.
        unsafe { ffi::lua_createtable(state, 0, 8192) };

        panic!("Lua was supposed to end the process and did not");
    }
}
