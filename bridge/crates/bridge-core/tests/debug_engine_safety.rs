#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
// idiomatic in tests

//! The debug engine's two sim-safety guarantees, driven through the real engine
//! in a real Lua state (issue #17).
//!
//! Both defend the same thing: a breakpoint must never be able to hold the sim
//! thread forever. A pause is held only while an editor keeps polling, and is
//! released after `idle_seconds` of silence — but that promise is only as good
//! as the clock it is measured on and the evaluations that run inside it.
//!
//! - The clock now comes from the DLL (`bridge.debug.monotonic`). The mission
//!   state's own clocks cannot carry it: `os` is removed by
//!   `MissionScripting.lua`'s sanitization, and `timer.getTime` is model time,
//!   which is frozen for precisely as long as the pause holds the sim thread.
//!   The first test therefore runs on a state with neither.
//! - Every evaluation — watch, hover, console, breakpoint condition — is run on
//!   its own coroutine under an instruction-count hook, so `while true do end`
//!   comes back as a failed evaluation instead of eating the idle window.
//!
//! The budgets are turned down from their 30s/2s defaults so the tests exercise
//! the real code paths at test speed; nothing else is stubbed.
//!
//! Windows-gated like the rest of the suite: the test binary links DCS's own
//! lua.dll, so put it on PATH and run with `-- --include-ignored`.

use dcs_bridge_core::{bootstrap, BridgeKind};
use mlua::{Lua, Value};
use std::sync::Mutex;

/// The breakpoint registry and the pause slot are process-wide statics shared
/// by every state in this binary, so the scenarios must not overlap.
static TEST_LOCK: Mutex<()> = Mutex::new(());

/// A bootstrapped bridge state with the engine installed and the exports table
/// bound as `bridge`, exactly as the DCS hook leaves it.
///
/// `sanitized` drops `os` and `timer` BEFORE bootstrap, which is what a mission
/// state desanitized just far enough to load the bridge looks like — the engine
/// captures its clock at install time, so removing them afterwards would prove
/// nothing.
fn engine_state(sanitized: bool) -> Lua {
    // SAFETY: test harness, not the DLL. `unsafe_new` loads all standard
    // libraries including `debug`, which the engine needs and which both DCS
    // Lua states provide.
    let lua = unsafe { Lua::unsafe_new() };
    if sanitized {
        lua.globals().set("os", Value::Nil).expect("drop os");
        lua.globals().set("timer", Value::Nil).expect("drop timer");
    }
    let exports = bootstrap(&lua, BridgeKind::Gui, "test").expect("bootstrap");
    lua.globals().set("bridge", exports).expect("bind bridge");
    lua
}

/// A vanished editor's pause is released on time in a state that has no Lua
/// clock at all. This is the guarantee in issue #17: before the fix the engine
/// fell back to `timer.getTime` (frozen while the pause holds the sim thread)
/// and then to a constant, under either of which the countdown never advanced
/// and the pause could only be ended by killing DCS.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn an_abandoned_pause_is_released_in_a_state_with_no_lua_clock() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let lua = engine_state(true);

    lua.load(
        r#"
        local DBG = assert(__DCS_STUDIO_DBG, "the engine installed")
        assert(os == nil and timer == nil, "the state really has no Lua clock")

        DBG.idle_seconds = 0.1
        -- The pump stands in for the RPC drain. It never answers: this IS the
        -- vanished editor, so nothing ever refreshes the liveness stamp.
        local held, pumps = false, 0
        DBG.pump = function()
          pumps = pumps + 1
          if bridge.debug.paused() ~= nil then held = true end
        end

        bridge.debug.clear_breakpoints()
        DBG.set_breakpoints({ source = "=idle.lua", breakpoints = { { line = 1 } } })

        local started = bridge.debug.monotonic()
        local outcome = DBG.run("reached_the_end = true\n", "=idle.lua", false)
        local elapsed = bridge.debug.monotonic() - started

        assert(outcome.ran == true, "the run finished cleanly")
        assert(held, "the breakpoint really did hold a pause")
        assert(pumps > 0, "the pause pumped RPC while it held")
        assert(reached_the_end == true, "the chunk ran on past the released pause")
        assert(elapsed >= 0.1, "the countdown measured real elapsed time: " .. elapsed)
        assert(elapsed < 10, "and released as soon as it expired: " .. elapsed)
        assert(bridge.debug.paused() == nil, "the pause was cleared on release")
        bridge.debug.clear_breakpoints()
        "#,
    )
    .exec()
    .expect("idle release suite");
}

/// A watch expression that never returns is cut off and reported, rather than
/// holding the sim thread. It runs on the sim thread inside the pause's own
/// pump, so an unbounded one defeats the idle release itself: the pump that
/// would deliver a Stop is the pump it is blocking.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn a_runaway_evaluation_is_cut_off_and_the_pause_survives_it() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let lua = engine_state(false);

    lua.load(
        r#"
        local DBG = assert(__DCS_STUDIO_DBG, "the engine installed")
        DBG.idle_seconds = 30 -- the release must NOT be what saves this one
        DBG.eval_timeout_seconds = 0.05

        local runaway, ordinary, yielded
        DBG.pump = function()
          if bridge.debug.paused() == nil or runaway then return end
          runaway = DBG.eval(0, "while true do end")
          -- The frame is still usable afterwards: one bad watch does not
          -- poison the pause it was evaluated in.
          ordinary = DBG.eval(0, "answer * 2")
          yielded = DBG.eval(0, "coroutine.yield()")
          bridge.debug.request_resume("continue")
        end

        bridge.debug.clear_breakpoints()
        DBG.set_breakpoints({ source = "=watch.lua", breakpoints = { { line = 2 } } })

        local started = bridge.debug.monotonic()
        local outcome = DBG.run("local answer = 21\nlocal done = true\n", "=watch.lua", false)
        local elapsed = bridge.debug.monotonic() - started

        assert(outcome.ran == true, "the run finished cleanly")
        assert(runaway and runaway.ok == false, "the loop was refused, not awaited")
        assert(string.find(runaway.err, "timed out", 1, true), runaway.err)
        assert(ordinary and ordinary.ok == true and ordinary.value == "42", "the frame still evaluates")
        assert(yielded and yielded.ok == false, "a yield is not a value")
        assert(string.find(yielded.err, "yielded", 1, true), yielded.err)
        assert(elapsed < 5, "the pause ended on the resume, not the idle timer: " .. elapsed)
        bridge.debug.clear_breakpoints()
        "#,
    )
    .exec()
    .expect("bounded evaluation suite");
}

/// A breakpoint condition is evaluated in the line hook itself, before any
/// pause exists — the worst place for an unbounded loop, because there is not
/// even a held pause to time out. It is bounded by the same ceiling, and its
/// failure surfaces through the existing fail-open path: the breakpoint stops
/// and the snapshot carries the reason, rather than silently never stopping.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn a_runaway_breakpoint_condition_is_cut_off_and_surfaced() {
    let _guard = TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let lua = engine_state(false);

    lua.load(
        r#"
        local DBG = assert(__DCS_STUDIO_DBG, "the engine installed")
        DBG.idle_seconds = 30
        DBG.eval_timeout_seconds = 0.05

        local snapshot
        DBG.pump = function()
          local snap = bridge.debug.paused()
          if snap and not snapshot then
            snapshot = snap
            bridge.debug.request_resume("continue")
          end
        end

        bridge.debug.clear_breakpoints()
        DBG.set_breakpoints({
          source = "=cond.lua",
          breakpoints = { { line = 1, condition = "while true do end" } },
        })

        local started = bridge.debug.monotonic()
        local outcome = DBG.run("reached_the_end = true\n", "=cond.lua", false)
        local elapsed = bridge.debug.monotonic() - started

        assert(outcome.ran == true, "the run finished cleanly")
        assert(snapshot, "the broken condition still stopped, as it fails open")
        assert(string.find(snapshot, "timed out", 1, true), snapshot)
        assert(elapsed < 5, "the condition did not hold the sim: " .. elapsed)
        bridge.debug.clear_breakpoints()
        "#,
    )
    .exec()
    .expect("bounded condition suite");
}
