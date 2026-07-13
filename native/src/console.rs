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
use std::sync::Mutex;

/// Ring capacity: plenty of scrollback for the panel, bounded for the sim.
const MAX_LINES: usize = 2000;

/// The line ring: `(seq, text)`, oldest first. `seq` starts at 1 and never
/// repeats within a DLL load.
static LINES: Mutex<VecDeque<(u64, String)>> = Mutex::new(VecDeque::new());
static NEXT_SEQ: Mutex<u64> = Mutex::new(1);

fn with_lines<T>(f: impl FnOnce(&mut VecDeque<(u64, String)>) -> T) -> T {
    let mut guard = LINES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    f(&mut guard)
}

/// Append one line, evicting the oldest past the cap. Returns its sequence.
pub(crate) fn push(text: String) -> u64 {
    let seq = {
        let mut next = NEXT_SEQ.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let seq = *next;
        *next += 1;
        seq
    };
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
        let out = lines.iter().filter(|(seq, _)| *seq > after).cloned().collect();
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
mod tests {
    use super::*;

    // Pure-logic, but on Windows the dcs-bridge test binary links DCS's
    // lua.dll, so it is gated like the rest (put a lua.dll on PATH and run
    // with `-- --include-ignored`). On non-Windows the build.rs links PUC
    // liblua5.1 and it runs as an ordinary test (issue #28).
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn ring_sequences_reads_and_caps() {
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
}
