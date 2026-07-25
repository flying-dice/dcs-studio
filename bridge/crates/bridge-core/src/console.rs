//! The `console` sub-namespace: a sim→IDE output pipe. Lua running inside DCS
//! calls `dcs_studio.console.print(...)` (and the hook redirects `print`
//! during editor-driven runs), lines land in a ring buffer here, and the IDE
//! tails them over the bridge (`console_read`) into the DCS Console panel —
//! print output that streams into the editor like a terminal, not buried in
//! dcs.log.
//!
//! The buffer is a capped ring with a MONOTONIC sequence: the IDE polls
//! `read_after(last_seen)` and appends only what is new; a reader that lags
//! past the cap simply misses the overwritten lines (the sequence gap says
//! so). Bounded by construction — a print-heavy mission can never grow the
//! DLL's memory unbounded.

use crate::facade::{p, p_opt, r_named, Sub};
use mlua::{Function, IntoLuaMulti, Lua, MultiValue, Result};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Ring capacity: plenty of scrollback for the panel, bounded for the sim.
const MAX_LINES: usize = 2000;

/// The line ring: `(seq, text)`, oldest first. `seq` starts at 1 and never
/// repeats within a DLL load.
static LINES: Mutex<VecDeque<(u64, String)>> = Mutex::new(VecDeque::new());
static NEXT_SEQ: AtomicU64 = AtomicU64::new(1);

fn with_lines<T>(f: impl FnOnce(&mut VecDeque<(u64, String)>) -> T) -> T {
    crate::locks::with_lock(&LINES, f)
}

/// Append one line, evicting the oldest past the cap. Returns its sequence.
pub(crate) fn push(text: String) -> u64 {
    // Read-and-increment in one atomic step (fetch_add returns the pre-increment
    // value), so the monotonic sequence stays gap-free without a lock.
    let seq = NEXT_SEQ.fetch_add(1, Ordering::Relaxed);
    with_lines(|lines| {
        lines.push_back((seq, text));
        while lines.len() > MAX_LINES {
            lines.pop_front();
        }
    });
    seq
}

/// Every buffered line with a sequence past `after`, oldest first, plus the
/// newest sequence overall (the reader's next `after`). An empty buffer (or
/// an up-to-date reader) yields no lines and echoes `after` back.
pub(crate) fn read_after(after: u64) -> (Vec<(u64, String)>, u64) {
    with_lines(|lines| {
        let latest = lines.back().map_or(after, |(seq, _)| *seq).max(after);
        let out = lines
            .iter()
            .filter(|(seq, _)| *seq > after)
            .cloned()
            .collect();
        (out, latest)
    })
}

/// Drop every buffered line (the panel's Clear, mirrored sim-side).
pub(crate) fn clear() {
    with_lines(VecDeque::clear);
}

/// Register the `console.*` surface on `sub`.
pub fn register(sub: &mut Sub) -> Result<()> {
    sub.func(
        "print",
        &[p("...", "any")],
        &[],
        "Print a line to the DCS Studio Console panel: arguments are \
         tostring-ed and tab-joined, exactly like Lua's print. During \
         editor-driven runs the global `print` is redirected here too.",
        |lua: &Lua, args: MultiValue| {
            // Lua's own tostring, so __tostring metamethods are honored.
            let tostring: Function = lua.globals().get("tostring")?;
            let mut parts: Vec<String> = Vec::with_capacity(args.len());
            for value in args {
                parts.push(tostring.call::<String>(value)?);
            }
            push(parts.join("\t"));
            ().into_lua_multi(lua)
        },
    )?;

    sub.func(
        "read",
        &[p_opt("after", "number")],
        &[r_named("table", "batch")],
        "Lines printed since sequence `after` (0/nil = from the start), as \
         { lines = { { seq, text }, ... }, latest } — the IDE's console tail \
         polls this.",
        |lua: &Lua, after: Option<u64>| {
            let (lines, latest) = read_after(after.unwrap_or(0));
            let batch = lua.create_table()?;
            let arr = lua.create_table()?;
            for (index, (seq, text)) in lines.into_iter().enumerate() {
                let row = lua.create_table()?;
                row.set("seq", seq)?;
                row.set("text", text)?;
                arr.set(index + 1, row)?;
            }
            batch.set("lines", arr)?;
            batch.set("latest", latest)?;
            batch.into_lua_multi(lua)
        },
    )?;

    sub.func(
        "clear",
        &[],
        &[],
        "Drop the buffered console lines.",
        |lua: &Lua, ()| {
            clear();
            ().into_lua_multi(lua)
        },
    )?;

    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::*;
    use mlua::Lua;

    /// Every test here mutates the process-wide line ring (and `clear()` wipes
    /// it), so they must not run concurrently.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    // Pure-logic, but on Windows the dcs-bridge test binary links DCS's
    // lua.dll, so it is gated like the rest (put a lua.dll on PATH and run
    // with `-- --include-ignored`). On non-Windows the build.rs links PUC
    // liblua5.1 and it runs as an ordinary test (issue #28).
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn ring_sequences_reads_and_caps() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        clear();
        let first = push("one".into());
        let second = push("two".into());
        assert!(second > first, "monotonic sequence");

        // A fresh reader gets everything; an up-to-date one gets nothing new.
        let (lines, latest) = read_after(0);
        let texts: Vec<&str> = lines.iter().map(|(_, t)| t.as_str()).collect();
        assert!(texts.ends_with(&["one", "two"]), "{texts:?}");
        assert_eq!(latest, second);
        let (empty, echoed) = read_after(latest);
        assert!(empty.is_empty());
        assert_eq!(echoed, latest);

        // Past the cap the oldest lines evict; the sequence never rewinds.
        for i in 0..(MAX_LINES + 10) {
            push(format!("line {i}"));
        }
        let (capped, newest) = read_after(0);
        assert_eq!(capped.len(), MAX_LINES, "ring holds exactly the cap");
        assert!(newest > second);
        assert_eq!(capped.last().map(|(s, _)| *s), Some(newest));

        clear();
        let (after_clear, _) = read_after(0);
        assert!(after_clear.is_empty());
    }

    /// `console.print` is Lua's `print`: arguments tostring-ed and tab-joined,
    /// honouring `__tostring`. The hook redirects the global `print` here during
    /// editor-driven runs, so anything `print` accepts this must too — a raise
    /// here would abort the very script the user is debugging.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn print_joins_arguments_with_tabs_and_honours_tostring() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let lua = Lua::new();
        let console = crate::facade::sub_table(&lua, "console", register);
        lua.globals().set("console", console).expect("set console");

        clear();
        lua.load(
            r#"
            console.print("a", 1, true, nil)
            console.print()                       -- no arguments: an empty line
            console.print(setmetatable({}, { __tostring = function() return "UNIT#1" end }))
            "#,
        )
        .exec()
        .expect("print");

        let (lines, _) = read_after(0);
        let texts: Vec<&str> = lines.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(texts, vec!["a\t1\ttrue\tnil", "", "UNIT#1"]);
        clear();
    }

    /// `print` stringifies through the STATE's `tostring`, so a state that has
    /// lost it — `tostring = nil` typed into the very console this serves, or a
    /// mod that replaced it with something that returns a table — must come
    /// back as an ordinary Lua error the caller can see, never a panic (which
    /// would take the sim down) and never a half-formed line in the panel.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn print_reports_a_state_whose_tostring_is_gone_or_lying() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let lua = Lua::new();
        let console = crate::facade::sub_table(&lua, "console", register);
        lua.globals().set("console", console).expect("set console");
        clear();

        lua.load("tostring = nil").exec().expect("drop tostring");
        let gone = lua
            .load(r#"console.print("x")"#)
            .exec()
            .expect_err("a state with no tostring cannot print");
        assert!(
            gone.to_string().contains("function"),
            "the error names what was missing: {gone}"
        );

        lua.load("tostring = function() return {} end")
            .exec()
            .expect("install a lying tostring");
        let lying = lua
            .load(r#"console.print("x")"#)
            .exec()
            .expect_err("a tostring that returns a table cannot print");
        assert!(
            lying.to_string().contains("string"),
            "the error names the conversion that failed: {lying}"
        );

        assert!(
            read_after(0).0.is_empty(),
            "neither attempt left a line in the panel"
        );
        clear();
    }

    /// `read` builds its batch of Lua tables inside the sim's state, and that
    /// state can genuinely be out of memory — the panel polls this while a
    /// mission is holding every byte it has. mlua reports exhaustion as an
    /// ordinary error on each `create_table`/`set`, and the requirement is that
    /// it stays an error the caller sees (the RPC answers `LuaError`, the panel
    /// retries on the next poll) rather than a panic, which inside the DLL
    /// takes the sim down with it.
    ///
    /// Driven by squeezing the state's memory ceiling upwards from nothing, so
    /// the failure lands on a different allocation each pass — the batch table,
    /// the array, a row, each field — and the pass that finally succeeds proves
    /// the squeeze was what stopped the earlier ones.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn read_under_an_exhausted_state_errors_instead_of_panicking() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        clear();
        push("one".into());
        push("two".into());

        let mut relaxed_enough_to_answer = false;
        for headroom in (0..64_000).step_by(8) {
            let lua = Lua::new();
            let console = crate::facade::sub_table(&lua, "console", register);
            let read: Function = console.get("read").expect("read binding");
            // Measure against a settled heap: the registration above leaves
            // garbage, and un-collected garbage moves the pass's failure point.
            lua.gc_collect().expect("collect");
            let ceiling = lua.used_memory() + headroom;
            lua.set_memory_limit(ceiling)
                .expect("mlua owns this state's allocator");
            match read.call::<mlua::Table>(0) {
                Ok(batch) => {
                    // The successful pass is a real batch, not a husk.
                    let lines: mlua::Table = batch.get("lines").expect("lines");
                    assert_eq!(lines.len().expect("len"), 2);
                    relaxed_enough_to_answer = true;
                    break;
                }
                Err(e) => assert!(
                    e.to_string().contains("memory"),
                    "the read must fail on the squeeze, and say so: {e}"
                ),
            }
        }
        assert!(
            relaxed_enough_to_answer,
            "the squeeze never relaxed enough to answer — the test proves nothing"
        );
        clear();
    }

    /// The IDE's Console panel tails with `read(after)` and clears with
    /// `clear()`. `read` must hand back `{ lines = { { seq, text }, … }, latest }`
    /// with `latest` usable as the next `after`, or the panel either loses lines
    /// or replays them forever.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn read_returns_a_resumable_batch_and_clear_empties_it() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let lua = Lua::new();
        let console = crate::facade::sub_table(&lua, "console", register);
        lua.globals().set("console", console).expect("set console");

        clear();
        lua.load(
            r#"
            console.print("one")
            console.print("two")

            -- A fresh reader (nil `after`) starts from the beginning.
            local first = console.read()
            assert(#first.lines == 2, "fresh reader gets everything")
            assert(first.lines[1].text == "one" and first.lines[2].text == "two")
            assert(first.latest == first.lines[2].seq, "latest is the newest sequence")

            -- Resuming from `latest` yields only what arrived since.
            assert(#console.read(first.latest).lines == 0, "caught-up reader gets nothing")
            console.print("three")
            local next_batch = console.read(first.latest)
            assert(#next_batch.lines == 1 and next_batch.lines[1].text == "three")

            -- Clear is the panel's Clear button, mirrored sim-side.
            console.clear()
            assert(#console.read(0).lines == 0, "cleared")
            "#,
        )
        .exec()
        .expect("read/clear");
        clear();
    }
}
