//! The `debug` sub-namespace: the breakpoint registry the IDE debugger drives
//! over the bridge (model/dcs/debug.pds). The IDE (and the MCP debug tools)
//! call `debug.set_breakpoints(source, lines)` over the JSON-RPC bridge, and
//! the sim-side line hook consults `debug.should_pause(source, line)`.
//!
//! This is the Rust side of the debugger state shared between the line hook
//! and the RPC handlers: the breakpoint registry, per-line conditions, the
//! pause snapshot, the resume mode, and a break-all request. The hook itself
//! (`debug.sethook`), the snapshot, lazy variable expansion, and
//! evaluate-in-frame are Lua in `lua/debug_engine.lua`, installed per state
//! by [`crate::bootstrap`].
//!
//! These statics are PER DLL (each cdylib compiles its own copy), which is
//! exactly right: each bridge debugs only its own Lua state, so breakpoints
//! must be sent to the bridge whose state runs the code.

use crate::facade::{p, p_opt, r_named, Sub};
use mlua::prelude::LuaValue;
use mlua::{IntoLuaMulti, Lua, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Source path → set of 1-based breakpoint lines. Global so the line hook and
/// the RPC handlers share one registry.
static REGISTRY: Mutex<BTreeMap<String, BTreeSet<u32>>> = Mutex::new(BTreeMap::new());

/// `(source, line)` → a condition expression. A conditional breakpoint pauses
/// only when its expression evaluates truthy in the stopped frame.
static CONDITIONS: Mutex<BTreeMap<(String, u32), String>> = Mutex::new(BTreeMap::new());

/// A break-all request: when set, the line hook pauses at the very next line of
/// debugged code (a manual "Pause"), then clears the flag.
static PAUSE_REQ: AtomicBool = AtomicBool::new(false);

/// A stop request: when set, the line hook unwinds the running chunk (Stop), so
/// a runaway/infinite-loop run can be terminated. Cleared on consumption.
static STOP_REQ: AtomicBool = AtomicBool::new(false);

/// The current pause: a JSON snapshot string (source/line/locals) while stopped
/// at a breakpoint, or `None` when running. The line hook sets it; the editor /
/// MCP reads it via `paused()`.
static PAUSE: Mutex<Option<String>> = Mutex::new(None);

/// The requested resume mode while paused — `"continue"`, `"step_over"`,
/// `"step_into"`, or `"step_out"` — set by the editor/MCP and consumed by the
/// line hook's pump loop via `take_resume`. `None` means stay paused.
static RESUME: Mutex<Option<String>> = Mutex::new(None);

/// The instant the monotonic clock counts from — the first time anything asks,
/// which is the DLL's load in practice.
static CLOCK_ORIGIN: OnceLock<Instant> = OnceLock::new();

/// Seconds elapsed on a monotonic wall clock.
///
/// The engine's two pause-safety budgets — the idle auto-continue and the
/// evaluation timeout — are measured with this rather than with anything Lua
/// offers, because neither Lua clock can carry the guarantee: `os` is one of
/// the libraries `MissionScripting.lua` removes, and DCS's `timer.getTime` is
/// model time, which stops advancing for exactly as long as a paused chunk
/// holds the sim thread — the one interval the idle release has to measure.
/// [`Instant`] is immune to both, and to a wall-clock change under the sim.
pub(crate) fn monotonic() -> f64 {
    CLOCK_ORIGIN
        .get_or_init(Instant::now)
        .elapsed()
        .as_secs_f64()
}

fn with_registry<T>(f: impl FnOnce(&mut BTreeMap<String, BTreeSet<u32>>) -> T) -> T {
    crate::locks::with_lock(&REGISTRY, f)
}

/// Canonical source key: chunkname prefixes stripped (`@` = loaded from file,
/// `=` = custom name — the IDE registers `=<abs path>`, but a file the chunk
/// `dofile`s runs as `@<path>`), separators unified, case folded (Windows
/// paths). One authority for registration and lookup, so the same file meets
/// itself regardless of how it was loaded.
fn normalize_source(source: &str) -> String {
    source
        .trim_start_matches(['@', '='])
        .replace('\\', "/")
        .to_lowercase()
}

/// Whether two NORMALIZED sources name the same file: exact, or one is a
/// path-boundary suffix of the other — a loader-relative `scripts/util.lua`
/// matches the registered absolute `e:/proj/scripts/util.lua`, but never
/// `…/otherscripts/util.lua`.
fn source_matches(key: &str, query: &str) -> bool {
    if key == query {
        return true;
    }
    let boundary_suffix = |longer: &str, shorter: &str| {
        !shorter.is_empty()
            && longer.len() > shorter.len()
            && longer.ends_with(shorter)
            && longer.as_bytes().get(longer.len() - shorter.len() - 1) == Some(&b'/')
    };
    boundary_suffix(key, query) || boundary_suffix(query, key)
}

/// Replace the breakpoints for `source` with `lines`; returns the count set.
/// An empty `lines` clears that source (the editor sends the full set per source).
pub(crate) fn set_breakpoints(source: &str, lines: &[u32]) -> usize {
    let key = normalize_source(source);
    let set: BTreeSet<u32> = lines.iter().copied().collect();
    let n = set.len();
    with_registry(|r| {
        if set.is_empty() {
            r.remove(&key);
        } else {
            r.insert(key, set);
        }
    });
    n
}

/// Whether a breakpoint is set at `source:line`. Exact normalized match first
/// (the hot path — this runs per line event on a breakpoint-carrying source),
/// then the path-boundary suffix scan so files loaded under a different
/// spelling (dofile/require) still hit the IDE's absolute-path registrations.
pub(crate) fn should_pause(source: &str, line: u32) -> bool {
    let query = normalize_source(source);
    with_registry(|r| {
        if r.get(&query).is_some_and(|s| s.contains(&line)) {
            return true;
        }
        r.iter()
            .any(|(key, lines)| lines.contains(&line) && source_matches(key, &query))
    })
}

/// Clear every breakpoint and condition.
pub(crate) fn clear() {
    with_registry(BTreeMap::clear);
    conditions_slot(BTreeMap::clear);
}

fn conditions_slot<T>(f: impl FnOnce(&mut BTreeMap<(String, u32), String>) -> T) -> T {
    crate::locks::with_lock(&CONDITIONS, f)
}

/// Set (or, for an empty `cond`, clear) the condition on `source:line`.
pub(crate) fn set_condition(source: &str, line: u32, cond: Option<String>) {
    let key = normalize_source(source);
    conditions_slot(|c| match cond {
        Some(expr) if !expr.trim().is_empty() => {
            c.insert((key, line), expr);
        }
        _ => {
            c.remove(&(key, line));
        }
    });
}

/// The condition expression on `source:line`, if any — same matching rule as
/// [`should_pause`] (exact normalized, then path-boundary suffix).
pub(crate) fn condition_at(source: &str, line: u32) -> Option<String> {
    let query = normalize_source(source);
    conditions_slot(|c| {
        if let Some(cond) = c.get(&(query.clone(), line)) {
            return Some(cond.clone());
        }
        c.iter()
            .find(|((key, l), _)| *l == line && source_matches(key, &query))
            .map(|(_, cond)| cond.clone())
    })
}

/// Request a break at the next line of debugged code (manual Pause).
pub(crate) fn request_pause() {
    PAUSE_REQ.store(true, Ordering::Relaxed);
}

/// Whether a break-all was requested since the last call (consumed).
pub(crate) fn take_pause() -> bool {
    PAUSE_REQ.swap(false, Ordering::Relaxed)
}

/// Request that the running chunk be terminated (Stop kills a runaway/looping
/// run, which has no natural end).
pub(crate) fn request_stop() {
    STOP_REQ.store(true, Ordering::Relaxed);
}

/// Whether a stop was requested since the last call (consumed by the hook,
/// which then unwinds the chunk).
pub(crate) fn take_stop() -> bool {
    STOP_REQ.swap(false, Ordering::Relaxed)
}

fn pause_slot<T>(f: impl FnOnce(&mut Option<String>) -> T) -> T {
    crate::locks::with_lock(&PAUSE, f)
}

fn resume_slot<T>(f: impl FnOnce(&mut Option<String>) -> T) -> T {
    crate::locks::with_lock(&RESUME, f)
}

/// Reset all pause/resume/break-all state. Called at the start of a `debug_run` so
/// a stale manual-pause (`PAUSE_REQ`), resume request, or pause snapshot from a
/// prior session can't bleed into the new one (a phantom break on line 1).
pub(crate) fn reset_session() {
    PAUSE_REQ.store(false, Ordering::Relaxed);
    STOP_REQ.store(false, Ordering::Relaxed);
    resume_slot(|r| *r = None);
    pause_slot(|p| *p = None);
}

/// Record that execution is paused at a breakpoint, with `snapshot` (a JSON
/// string of source/line/locals). Clears any stale resume request.
pub(crate) fn set_paused(snapshot: String) {
    resume_slot(|r| *r = None);
    pause_slot(|p| *p = Some(snapshot));
}

/// Clear the pause (execution resumed).
pub(crate) fn clear_paused() {
    pause_slot(|p| *p = None);
}

/// The current pause snapshot, or `None` when running.
pub(crate) fn paused_snapshot() -> Option<String> {
    pause_slot(|p| p.clone())
}

/// Ask the paused line hook to resume in `mode` (continue / step_*).
pub(crate) fn request_resume(mode: String) {
    resume_slot(|r| *r = Some(mode));
}

/// The requested resume mode since the last call (consumed), or `None` to stay
/// paused.
pub(crate) fn take_resume() -> Option<String> {
    resume_slot(Option::take)
}

/// Register the `debug.*` breakpoint-registry surface on `sub`.
// A linear registration manifest: one `sub.func` block per RPC method, where
// splitting by count would scatter one cohesive surface listing.
#[allow(clippy::too_many_lines)]
pub fn register(sub: &mut Sub) -> Result<()> {
    sub.func(
        "set_breakpoints",
        &[p("source", "string"), p("lines", "number[]")],
        &[r_named("number", "count")],
        "Replace the breakpoints for `source` with `lines` (1-based; an empty \
         list clears the source). Returns the number set. Called by the IDE \
         debugger when breakpoints change.",
        |lua: &Lua, (source, lines): (String, Vec<u32>)| {
            // usize → Lua integer; mlua errors (never panics) if it somehow
            // exceeded i64, which a breakpoint count never will.
            set_breakpoints(&source, &lines).into_lua_multi(lua)
        },
    )?;

    sub.func(
        "should_pause",
        &[p("source", "string"), p("line", "number")],
        &[r_named("boolean", "paused")],
        "Whether a breakpoint is set at `source:line` — consulted by the sim's \
         line hook.",
        |lua: &Lua, (source, line): (String, u32)| should_pause(&source, line).into_lua_multi(lua),
    )?;

    sub.func(
        "clear_breakpoints",
        &[],
        &[],
        "Remove every breakpoint.",
        |lua: &Lua, ()| {
            clear();
            ().into_lua_multi(lua)
        },
    )?;

    sub.func(
        "breakpoints",
        &[],
        &[r_named("table", "bySource")],
        "Return the current breakpoints as a table: source → array of 1-based lines.",
        |lua: &Lua, ()| {
            // Snapshot under the lock, then build the Lua tables outside it:
            // allocating in the Lua state can raise, and raising while holding
            // a process-wide mutex would leave the registry locked for the rest
            // of the session. The registry is a handful of breakpoints.
            let snapshot = with_registry(|r| r.clone());
            let t = lua.create_table()?;
            for (src, lines) in snapshot {
                let arr = lua.create_table()?;
                for (i, line) in lines.iter().enumerate() {
                    arr.set(i + 1, *line)?;
                }
                t.set(src.as_str(), arr)?;
            }
            t.into_lua_multi(lua)
        },
    )?;

    sub.func(
        "monotonic",
        &[],
        &[r_named("number", "seconds")],
        "Seconds elapsed on the DLL's own monotonic wall clock. The debug \
         engine measures its pause-safety budgets with this — the idle \
         auto-continue that releases a pause no editor is polling, and the \
         ceiling on one evaluation — because it is the only clock that both \
         survives MissionScripting.lua's sanitization (which removes `os`) and \
         keeps advancing while a paused chunk holds the sim thread (which \
         freezes `timer.getTime`).",
        |lua: &Lua, ()| monotonic().into_lua_multi(lua),
    )?;

    // --- pause control: driven by the sim's line hook (debug_run) and the
    // editor/MCP (debug_state / debug_continue). ---

    sub.func(
        "set_paused",
        &[p("snapshot", "string")],
        &[],
        "Record that execution is paused at a breakpoint, with a JSON snapshot \
         of source/line/locals. Called by the line hook.",
        |lua: &Lua, snapshot: String| {
            set_paused(snapshot);
            ().into_lua_multi(lua)
        },
    )?;

    sub.func(
        "clear_paused",
        &[],
        &[],
        "Clear the pause (execution resumed). Called by the line hook.",
        |lua: &Lua, ()| {
            clear_paused();
            ().into_lua_multi(lua)
        },
    )?;

    sub.func(
        "paused",
        &[],
        &[r_named("string?", "snapshot")],
        "The current pause snapshot (a JSON string), or nil when running.",
        |lua: &Lua, ()| match paused_snapshot() {
            Some(s) => s.into_lua_multi(lua),
            None => LuaValue::Nil.into_lua_multi(lua),
        },
    )?;

    sub.func(
        "request_resume",
        &[p("mode", "string")],
        &[],
        "Ask the paused line hook to resume: \"continue\", \"step_over\", \
         \"step_into\", or \"step_out\". Set by the editor/MCP.",
        |lua: &Lua, mode: String| {
            request_resume(mode);
            ().into_lua_multi(lua)
        },
    )?;

    sub.func(
        "take_resume",
        &[],
        &[r_named("string?", "mode")],
        "The resume mode requested since the last call (consumed by the line \
         hook's pump loop), or nil to stay paused.",
        |lua: &Lua, ()| match take_resume() {
            Some(mode) => mode.into_lua_multi(lua),
            None => LuaValue::Nil.into_lua_multi(lua),
        },
    )?;

    sub.func(
        "set_condition",
        &[
            p("source", "string"),
            p("line", "number"),
            p_opt("cond", "string"),
        ],
        &[],
        "Set (or, with an empty/nil cond, clear) a conditional breakpoint: the \
         hook pauses at `source:line` only when `cond` evaluates truthy in the \
         stopped frame.",
        |lua: &Lua, (source, line, cond): (String, u32, Option<String>)| {
            set_condition(&source, line, cond);
            ().into_lua_multi(lua)
        },
    )?;

    sub.func(
        "condition_at",
        &[p("source", "string"), p("line", "number")],
        &[r_named("string?", "cond")],
        "The condition expression on `source:line`, if any (consulted by the hook).",
        |lua: &Lua, (source, line): (String, u32)| match condition_at(&source, line) {
            Some(cond) => cond.into_lua_multi(lua),
            None => LuaValue::Nil.into_lua_multi(lua),
        },
    )?;

    sub.func(
        "request_pause",
        &[],
        &[],
        "Request a break at the next line of debugged code (manual Pause).",
        |lua: &Lua, ()| {
            request_pause();
            ().into_lua_multi(lua)
        },
    )?;

    sub.func(
        "take_pause",
        &[],
        &[r_named("boolean", "pause")],
        "Whether a break-all was requested since the last call (consumed by the hook).",
        |lua: &Lua, ()| take_pause().into_lua_multi(lua),
    )?;

    sub.func(
        "request_stop",
        &[],
        &[],
        "Request that the running chunk be terminated (Stop unwinds a runaway \
         or looping run, which has no natural end).",
        |lua: &Lua, ()| {
            request_stop();
            ().into_lua_multi(lua)
        },
    )?;

    sub.func(
        "take_stop",
        &[],
        &[r_named("boolean", "stop")],
        "Whether a stop was requested since the last call (consumed by the hook).",
        |lua: &Lua, ()| take_stop().into_lua_multi(lua),
    )?;

    sub.func(
        "reset_session",
        &[],
        &[],
        "Clear all pause/resume/break-all/stop state. Called by the hook at the \
         start of a debug_run so a stale request from a prior session can't bleed in.",
        |lua: &Lua, ()| {
            reset_session();
            ().into_lua_multi(lua)
        },
    )?;

    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::*;

    /// Both tests mutate the process-wide REGISTRY/CONDITIONS statics (and
    /// `clear()` wipes them all), so they must not run concurrently.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    // Pure-logic, but on Windows the dcs-bridge test binary links DCS's
    // lua.dll, so it is gated like the rest (put a lua.dll on PATH and run
    // with `-- --include-ignored`). On non-Windows the build.rs links PUC
    // liblua5.1 and it runs as an ordinary test (issue #28).
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn registry_sets_queries_and_clears() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        clear();
        assert_eq!(set_breakpoints("a.lua", &[10, 20, 20]), 2, "dedups lines");
        assert!(should_pause("a.lua", 10));
        assert!(should_pause("a.lua", 20));
        assert!(!should_pause("a.lua", 11));
        assert!(!should_pause("b.lua", 10));
        // An empty set clears the source.
        assert_eq!(set_breakpoints("a.lua", &[]), 0);
        assert!(!should_pause("a.lua", 10));
        clear();
    }

    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn sources_match_across_loader_spellings() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        clear();
        // The IDE registers "=<abs Windows path>"; the same file dofile'd runs
        // as "@<path>" in either case/separator spelling — all must meet.
        set_breakpoints("=E:\\proj\\Scripts\\util.lua", &[7]);
        assert!(
            should_pause("@e:/proj/scripts/UTIL.LUA", 7),
            "prefix/case/sep normalize"
        );
        assert!(should_pause("=E:\\proj\\Scripts\\util.lua", 7), "verbatim");
        // A loader-relative spelling matches at a path boundary only.
        assert!(should_pause("@Scripts/util.lua", 7), "relative suffix");
        assert!(
            !should_pause("@herscripts/util.lua", 7),
            "no mid-segment match"
        );
        assert!(!should_pause("@util.lua", 8), "wrong line");
        // Conditions follow the same rule.
        set_condition("=E:\\proj\\Scripts\\util.lua", 7, Some("i == 3".into()));
        assert_eq!(
            condition_at("@scripts/util.lua", 7).as_deref(),
            Some("i == 3")
        );
        clear();
        assert!(
            condition_at("@scripts/util.lua", 7).is_none(),
            "clear drops conditions"
        );
    }

    /// The source-matching rule itself, in isolation: identical keys match, a
    /// loader-relative spelling matches at a path boundary, and a name that
    /// merely ends with the same characters does not. `should_pause` reaches it
    /// only on its slow scan, so testing the predicate directly is what pins
    /// the boundary rule that keeps `.../otherscripts/util.lua` from stealing
    /// `.../scripts/util.lua`'s breakpoints.
    #[test]
    fn source_matching_is_exact_or_bounded_at_a_path_separator() {
        assert!(source_matches("e:/p/a.lua", "e:/p/a.lua"), "identical");
        assert!(source_matches("e:/p/scripts/util.lua", "scripts/util.lua"));
        assert!(source_matches("scripts/util.lua", "e:/p/scripts/util.lua"));

        assert!(!source_matches(
            "e:/p/otherscripts/util.lua",
            "scripts/util.lua"
        ));
        assert!(!source_matches("e:/p/a.lua", "e:/p/b.lua"));
        // An empty query would otherwise suffix-match every registered source.
        assert!(!source_matches("e:/p/a.lua", ""));
    }

    /// A condition is per `(source, line)` and an empty or whitespace-only
    /// expression clears it rather than installing a breakpoint that can never
    /// evaluate. The editor sends `""` when the user empties the condition box,
    /// and a stale `" "` left behind would silently stop pausing.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_blank_condition_clears_rather_than_installs() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        clear();

        set_condition("a.lua", 3, Some("i > 2".into()));
        assert_eq!(condition_at("a.lua", 3).as_deref(), Some("i > 2"));

        set_condition("a.lua", 3, Some("   ".into()));
        assert!(condition_at("a.lua", 3).is_none(), "whitespace clears");

        set_condition("a.lua", 3, Some("i > 2".into()));
        set_condition("a.lua", 3, None);
        assert!(condition_at("a.lua", 3).is_none(), "nil clears");

        // A condition on another line of the same source is untouched, and a
        // line with no condition at all reports none rather than the neighbour's.
        set_condition("a.lua", 9, Some("hp < 10".into()));
        assert!(condition_at("a.lua", 3).is_none());
        assert_eq!(condition_at("a.lua", 9).as_deref(), Some("hp < 10"));
        clear();
    }

    /// The pause/resume/stop flags are the handshake between the editor and the
    /// sim's line hook. Each request is *consumed* by the hook: a flag that
    /// stayed set would re-pause (or re-kill) the next run, and one that never
    /// arrived would leave the editor's Pause button dead.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn pause_stop_and_resume_requests_are_consumed_once() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_session();

        assert!(!take_pause(), "no request, no pause");
        request_pause();
        assert!(take_pause(), "the hook sees the request");
        assert!(!take_pause(), "and only once");

        assert!(!take_stop());
        request_stop();
        assert!(take_stop());
        assert!(!take_stop());

        assert!(take_resume().is_none(), "no request means stay paused");
        request_resume("step_over".into());
        assert_eq!(take_resume().as_deref(), Some("step_over"));
        assert!(take_resume().is_none());
        reset_session();
    }

    /// `set_paused` publishes the snapshot the editor renders, and drops any
    /// resume request that arrived while the chunk was still running — without
    /// that, a Continue clicked a frame before the stop would skip straight
    /// past the breakpoint the user was waiting for.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn pausing_publishes_the_snapshot_and_drops_a_stale_resume() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        reset_session();

        assert!(paused_snapshot().is_none(), "running: no snapshot");
        request_resume("continue".into());
        set_paused(r#"{"source":"a.lua","line":3}"#.into());
        assert!(take_resume().is_none(), "the stale resume was dropped");
        assert_eq!(
            paused_snapshot().as_deref(),
            Some(r#"{"source":"a.lua","line":3}"#)
        );

        clear_paused();
        assert!(paused_snapshot().is_none(), "resumed: no snapshot");
        reset_session();
    }

    /// `reset_session` runs at the start of every `debug_run`. A manual Pause,
    /// a Stop, a resume mode or a snapshot left over from the previous session
    /// must all be gone, or the new run breaks on its first line (or dies
    /// instantly) for no reason the user can see.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn reset_session_clears_every_leftover_from_the_previous_run() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        request_pause();
        request_stop();
        request_resume("step_into".into());
        set_paused("{}".into());

        reset_session();

        assert!(!take_pause(), "stale break-all");
        assert!(!take_stop(), "stale stop");
        assert!(take_resume().is_none(), "stale resume mode");
        assert!(paused_snapshot().is_none(), "stale snapshot");
    }

    /// The clock the engine's idle release and evaluation timeout are measured
    /// with. Only two properties matter, and both are load-bearing: it never
    /// goes backwards (a countdown that can be un-wound never expires) and it
    /// advances with real time even when nothing in the Lua state does.
    #[test]
    fn the_monotonic_clock_advances_and_never_rewinds() {
        let first = monotonic();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let second = monotonic();
        let slept = second - first;
        assert!(slept >= 0.015, "20ms of sleep read as {slept}s");
        assert!(monotonic() >= second, "the clock went backwards");
    }

    /// The whole `debug.*` surface as the engine and the editor drive it, from
    /// Lua. `breakpoints()` is what the IDE reads back to render the gutter, so
    /// its shape (source → sorted array of 1-based lines) is part of the
    /// contract, not an implementation detail.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_lua_surface_drives_the_registry_and_the_pause_handshake() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        clear();
        reset_session();

        let lua = mlua::Lua::new();
        let dbg = crate::facade::sub_table(&lua, "debug", register);
        lua.globals().set("dbg", dbg).expect("set dbg");

        lua.load(
            r#"
            assert(dbg.set_breakpoints("=e:\\p\\a.lua", { 30, 10, 10 }) == 2, "dedups and counts")
            assert(dbg.should_pause("@e:/p/a.lua", 10), "normalized lookup")
            assert(not dbg.should_pause("@e:/p/a.lua", 11))

            local bp = dbg.breakpoints()
            local lines = bp["e:/p/a.lua"]
            assert(lines and #lines == 2 and lines[1] == 10 and lines[2] == 30, "sorted lines")

            dbg.set_condition("=e:\\p\\a.lua", 10, "i == 3")
            assert(dbg.condition_at("@e:/p/a.lua", 10) == "i == 3")
            dbg.set_condition("=e:\\p\\a.lua", 10, nil)
            assert(dbg.condition_at("@e:/p/a.lua", 10) == nil)

            -- The pause handshake, end to end.
            assert(dbg.paused() == nil, "running")
            dbg.set_paused('{"line":10}')
            assert(dbg.paused() == '{"line":10}')
            assert(dbg.take_resume() == nil, "no resume requested yet")
            dbg.request_resume("step_out")
            assert(dbg.take_resume() == "step_out")
            dbg.clear_paused()
            assert(dbg.paused() == nil, "resumed")

            dbg.request_pause();  assert(dbg.take_pause() == true)
            assert(dbg.take_pause() == false)
            dbg.request_stop();   assert(dbg.take_stop() == true)
            assert(dbg.take_stop() == false)

            -- The engine reads its safety budgets off this clock, so it has to
            -- be there under the same name the engine captures at install time.
            local t = dbg.monotonic()
            assert(type(t) == "number" and t >= 0, "monotonic seconds")
            assert(dbg.monotonic() >= t, "never rewinds")

            dbg.request_pause()
            dbg.reset_session()
            assert(dbg.take_pause() == false, "reset drops the stale request")

            dbg.clear_breakpoints()
            assert(next(dbg.breakpoints()) == nil, "cleared")
            assert(not dbg.should_pause("@e:/p/a.lua", 10))
            "#,
        )
        .exec()
        .expect("debug surface suite");

        clear();
        reset_session();
    }
}
