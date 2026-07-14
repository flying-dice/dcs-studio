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
use std::sync::Mutex;

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
            let t = lua.create_table()?;
            with_registry(|r| -> Result<()> {
                for (src, lines) in r.iter() {
                    let arr = lua.create_table()?;
                    for (i, line) in lines.iter().enumerate() {
                        arr.set(i + 1, *line)?;
                    }
                    t.set(src.as_str(), arr)?;
                }
                Ok(())
            })?;
            t.into_lua_multi(lua)
        },
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
}
