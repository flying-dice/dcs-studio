//! `dump_globals()` — introspect the live DCS API in `_G` and render it as the
//! dotted `.d.lua` statements the editor's resolver indexes (`DCS = {}` then
//! `function DCS.getModelTime() end`).
//!
//! Running inside the sim, the walk must never raise: a member that fails to
//! read is skipped and the partial dump returns. Depth is capped and a
//! per-root visited set (keyed by table identity) breaks the reference cycles
//! and pathologically deep tables (`Export`) a naive `_G` walk would choke on.
//! Only the curated modder-facing roots are walked, so the dump stays
//! authoritative and bounded (model `model/dcs/bridge.pds`, `Types.DumpGlobals`).
//!
//! This is the mlua half — it needs DCS's `lua.dll` at load. The pure-data
//! model, the emittable-key filter, and the renderer it feeds are the lua-free
//! [`dcs_studio_project::luadef`], golden-tested on any platform.

use std::collections::HashSet;
use std::ffi::c_void;

use dcs_studio_project::luadef::{
    emit_globals_dlua, is_emittable_segment, GlobalKind, GlobalNode, ScalarTy,
};
use mlua::prelude::{LuaTable, LuaValue};
use mlua::Lua;

/// The modder-facing DCS API roots walked from `_G` — not all of `_G`, so the
/// dump stays authoritative and bounded.
const CURATED_ROOTS: &[&str] = &["DCS", "Export", "net", "lfs", "log"];

/// How deep the walk recurses into nested API tables before typing the value as
/// an opaque table. Bounds output and, with the visited set, breaks reference
/// cycles and pathologically deep tables (model `MAX_INTROSPECTION_DEPTH`).
const MAX_INTROSPECTION_DEPTH: usize = 4;

/// Introspect the curated DCS API roots present in `_G` and emit them as dotted
/// `.d.lua` statements. An absent root (mission-state globals at the main menu)
/// is skipped, not errored; a read failure yields the partial dump gathered so
/// far. Never raises in the sim.
pub fn dump_globals(lua: &Lua) -> String {
    let globals = lua.globals();
    let mut roots: Vec<GlobalNode> = Vec::new();
    for &name in CURATED_ROOTS {
        match globals.get::<LuaValue>(name) {
            // Absent (nil) or unreadable (a raising `__index`): skip the root.
            Ok(LuaValue::Nil) | Err(_) => {}
            Ok(value) => {
                // A fresh visited set per root: each root is walked
                // independently, and cycles within it are still broken.
                let mut visited: HashSet<*const c_void> = HashSet::new();
                roots.push(GlobalNode::new(name, classify(&value, 0, &mut visited)));
            }
        }
    }
    emit_globals_dlua(&roots)
}

/// Type one value. A table within the depth cap and not yet visited is walked
/// (recursing into its members); past the cap, already-visited, or a
/// non-walkable handle (userdata/thread), it is an opaque table; a scalar takes
/// its primitive type. `depth` is the depth of the value's parent (a root is 0).
fn classify(value: &LuaValue, depth: usize, visited: &mut HashSet<*const c_void>) -> GlobalKind {
    match value {
        LuaValue::Function(_) => GlobalKind::Function,
        LuaValue::Table(table) => {
            let ptr = table.to_pointer();
            if depth >= MAX_INTROSPECTION_DEPTH || !visited.insert(ptr) {
                // Depth cap, or a cycle/shared table already entered: opaque.
                return GlobalKind::Opaque;
            }
            GlobalKind::Table(walk_table(table, depth + 1, visited))
        }
        LuaValue::Integer(_) | LuaValue::Number(_) => GlobalKind::Scalar(ScalarTy::Number),
        LuaValue::String(_) => GlobalKind::Scalar(ScalarTy::String),
        LuaValue::Boolean(_) => GlobalKind::Scalar(ScalarTy::Boolean),
        // userdata, thread, light userdata, error, … → an opaque handle.
        _ => GlobalKind::Opaque,
    }
}

/// Walk a table's string-keyed, emittable members into [`GlobalNode`]s, sorted
/// by name for a stable dump. `depth` is the depth of `table` itself. A pair
/// that fails to read, a non-string or non-emittable key, is skipped — the walk
/// never raises.
fn walk_table(table: &LuaTable, depth: usize, visited: &mut HashSet<*const c_void>) -> Vec<GlobalNode> {
    let mut members: Vec<GlobalNode> = Vec::new();
    for pair in table.pairs::<LuaValue, LuaValue>() {
        let Ok((key, value)) = pair else { continue };
        let LuaValue::String(key) = key else { continue };
        let Ok(name) = key.to_str() else { continue };
        let name = name.to_owned();
        if !is_emittable_segment(&name) {
            continue;
        }
        members.push(GlobalNode::new(name, classify(&value, depth, visited)));
    }
    members.sort_by(|a, b| a.name.cmp(&b.name));
    members
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a `_G` with the shapes the walk must survive — nested tables, a
    /// self-cycle, a table buried past the depth cap, userdata, a function and a
    /// scalar — then dump and assert the dotted statements + bounded walk.
    /// `#[ignore]`: like the rest of the crate's mlua tests this needs DCS's
    /// `lua.dll` on the runtime path (absent on Linux CI). Run next to a
    /// `lua.dll` with `cargo test -p dcs-bridge -- --ignored`.
    #[test]
    #[ignore = "needs lua.dll on the runtime path"]
    fn dumps_curated_roots_and_bounds_the_walk() {
        let lua = Lua::new();
        lua.load(
            r#"
            DCS = {}
            function DCS.getModelTime() end
            DCS.export = { getData = function() end }
            -- A reference cycle: the walk's visited set must break it.
            DCS.self = DCS
            -- Buried past MAX_INTROSPECTION_DEPTH (root=0, .a=1 … .e=5): opaque.
            DCS.a = { b = { c = { d = { e = { deep = function() end } } } } }
            log = { write = function() end, ERROR = 4 }
            -- A non-emittable key (not a Lua identifier) is skipped.
            log["bad-key"] = function() end
            "#,
        )
        .exec()
        .expect("seed _G");

        let out = super::dump_globals(&lua);

        // Roots present in `_G` are emitted; functions and nested tables resolve.
        assert!(out.contains("DCS = {}"), "{out}");
        assert!(out.contains("function DCS.getModelTime() end"), "{out}");
        assert!(out.contains("DCS.export = {}"), "{out}");
        assert!(out.contains("function DCS.export.getData() end"), "{out}");
        assert!(out.contains("log = {}"), "{out}");
        assert!(out.contains("function log.write() end"), "{out}");
        assert!(out.contains("log.ERROR = 0"), "{out}");

        // The cycle terminated (a finite string is itself the proof) and the
        // self-reference is typed as an opaque table, not re-walked.
        assert!(out.contains("DCS.self = {}"), "{out}");

        // The depth cap stops the walk: `DCS.a.b.c.d` is the last walked table
        // (depth 4), `.e` past it is opaque, so `.e.deep` is never emitted.
        assert!(out.contains("DCS.a.b.c.d = {}"), "{out}");
        assert!(!out.contains("deep"), "depth cap breached:\n{out}");

        // A non-identifier key is filtered, not emitted into a broken statement.
        assert!(!out.contains("bad-key"), "{out}");

        // An absent curated root (no `net`/`Export`/`lfs` here) is skipped.
        assert!(!out.contains("net"), "{out}");
    }
}
