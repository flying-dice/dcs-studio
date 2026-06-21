//! The `dcs_studio` module's whole Lua surface, assembled through the binding
//! facade so registration and `.d.lua` type recording share one declaration.
//!
//! [`build`] returns the populated exports table's [`ModuleDoc`]; the caller
//! ([`crate::dcs_studio`]) then wires `emit_dlua` (which needs the finished
//! doc) onto the exports table.

use crate::facade::{r, Surface};
use dcs_studio_project::luadef::ModuleDoc;
use mlua::prelude::{LuaResult, LuaTable};
use mlua::Lua;

/// Register every binding on `exports` and return the recorded type surface.
/// `version` is the crate version exposed as `dcs_studio.version`.
pub fn build(lua: &Lua, exports: &LuaTable, version: &str) -> LuaResult<ModuleDoc> {
    let mut s = Surface::new(
        lua,
        exports,
        "dcs_studio",
        "The in-DCS DCS Studio native runtime — loaded by the GameGUI hook via \
         require(\"dcs_studio\").",
    );

    s.constant("name", "The module name (\"dcs-studio\").", "dcs-studio")?;
    s.constant(
        "version",
        "The dcs-bridge crate version this DLL was built from.",
        version.to_string(),
    )?;

    s.submodule("json", "JSON encode/decode helpers.", crate::json::register)?;
    s.submodule(
        "toml",
        "TOML encode/decode helpers (bridged through JSON).",
        crate::toml_codec::register,
    )?;
    s.submodule(
        "file",
        "Write sim data to disk under the guarded DCS write root (lfs.writedir()).",
        crate::file::register,
    )?;
    s.submodule(
        "sqlite",
        "Embedded SQLite — open/query a database under the guarded write root.",
        crate::sqlite::register,
    )?;
    s.submodule(
        "debug",
        "Breakpoint registry the IDE debugger drives over the bridge.",
        crate::debug::register,
    )?;
    s.submodule(
        "logger",
        "Namespaced logging into the DCS Studio log file.",
        crate::logger::register,
    )?;
    s.submodule(
        "jsonrpc",
        "The WebSocket/HTTP JSON-RPC server and router.",
        crate::jsonrpc::register,
    )?;

    // `emit_dlua` is wired up after the doc is finished (it returns this very
    // surface as a `.d.lua` string), so record its type here and set the
    // closure in lib.rs.
    s.record_root_fn(
        "emit_dlua",
        &[],
        &[r("string")],
        "Return the generated EmmyLua (.d.lua) type definitions for this module.",
    );

    Ok(s.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dcs_studio_project::luadef::emit_dlua;
    use mlua::prelude::LuaValue;
    use mlua::Lua;
    use std::collections::BTreeSet;

    /// The checked-in golden: regenerated from the live surface. Both this and
    /// [`every_registered_key_is_documented`] are `#[ignore]` because the
    /// dcs-bridge crate links DCS's `lua.dll`, so `Lua::new()` needs it on the
    /// runtime path — present where DCS is installed, absent on Linux CI (the
    /// lua-free emitter is tested in `dcs-studio-project` instead). Run with
    /// `cargo test -p dcs-bridge -- --ignored` next to a `lua.dll`.
    const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/types/dcs_studio.d.lua");

    fn built() -> (Lua, LuaTable, ModuleDoc) {
        let lua = Lua::new();
        let exports = lua.create_table().expect("exports");
        let doc = build(&lua, &exports, env!("CARGO_PKG_VERSION")).expect("surface");
        (lua, exports, doc)
    }

    #[test]
    #[ignore = "needs lua.dll on the runtime path"]
    fn regenerate_dlua_golden() {
        let (_lua, _exports, doc) = built();
        std::fs::write(GOLDEN, emit_dlua(&doc)).expect("write golden");
    }

    /// The serde codecs actually round-trip through the live mlua surface:
    /// `json` and `toml` encode a Lua table and decode it back. Exercises the
    /// `(value, err)` idiom and the TOML⇄JSON value bridge (which has real
    /// failure modes — top-level must be a table, no nulls).
    #[test]
    #[ignore = "needs lua.dll on the runtime path"]
    fn serde_codecs_round_trip() {
        let (lua, exports, _doc) = built();

        let json: LuaTable = exports.get("json").expect("json sub");
        let encode: mlua::Function = json.get("encode").expect("json.encode");
        let decode: mlua::Function = json.get("decode").expect("json.decode");
        let tbl = lua.create_table().expect("t");
        tbl.set("n", 3).expect("set");
        let (text, err): (Option<String>, Option<String>) =
            encode.call(&tbl).expect("encode call");
        assert!(err.is_none(), "json.encode err: {err:?}");
        let text = text.expect("json string");
        assert!(text.contains("\"n\""), "json: {text}");
        let (back, err): (Option<LuaTable>, Option<String>) =
            decode.call(text).expect("decode call");
        assert!(err.is_none());
        assert_eq!(back.expect("table").get::<i64>("n").expect("n"), 3);

        let toml: LuaTable = exports.get("toml").expect("toml sub");
        let t_encode: mlua::Function = toml.get("encode").expect("toml.encode");
        let t_decode: mlua::Function = toml.get("decode").expect("toml.decode");
        let cfg = lua.create_table().expect("cfg");
        cfg.set("title", "hi").expect("set");
        let (text, err): (Option<String>, Option<String>) =
            t_encode.call(&cfg).expect("toml encode");
        assert!(err.is_none(), "toml.encode err: {err:?}");
        let text = text.expect("toml string");
        assert!(text.contains("title"), "toml: {text}");
        let (back, err): (Option<LuaTable>, Option<String>) =
            t_decode.call(text).expect("toml decode");
        assert!(err.is_none());
        assert_eq!(
            back.expect("table").get::<String>("title").expect("title"),
            "hi"
        );
    }

    /// `file.write_text` writes under a faked `lfs.writedir()` and refuses a
    /// path that climbs out of the write root.
    #[test]
    #[ignore = "needs lua.dll on the runtime path"]
    fn file_writes_under_guarded_root_and_refuses_escape() {
        let lua = Lua::new();
        let root = std::env::temp_dir().join(format!("dcs-studio-file-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("mk root");
        // Fake `lfs.writedir()` returning our temp root.
        let lfs = lua.create_table().expect("lfs");
        let root_str = format!("{}/", root.display());
        lfs.set(
            "writedir",
            lua.create_function(move |_, ()| Ok(root_str.clone())).expect("fn"),
        )
        .expect("set writedir");
        lua.globals().set("lfs", lfs).expect("set lfs");

        let exports = lua.create_table().expect("exports");
        build(&lua, &exports, env!("CARGO_PKG_VERSION")).expect("surface");
        let file: LuaTable = exports.get("file").expect("file sub");
        let write_text: mlua::Function = file.get("write_text").expect("write_text");

        // A contained path writes; the bytes land under the root.
        let (ok, err): (Option<bool>, Option<String>) = write_text
            .call(("logs/out.txt", "hello", LuaValue::Nil))
            .expect("call");
        assert_eq!(ok, Some(true), "write err: {err:?}");
        assert_eq!(
            std::fs::read_to_string(root.join("logs").join("out.txt")).expect("read"),
            "hello"
        );

        // A `..` escape is refused with no write.
        let (ok, err): (Option<bool>, Option<String>) = write_text
            .call(("../escape.txt", "x", LuaValue::Nil))
            .expect("call");
        assert!(ok.is_none());
        assert!(err.unwrap_or_default().contains("escape"), "expected escape error");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The sqlite handle round-trips CRUD + parameters, rolls a failed
    /// transaction back, and refuses a path that escapes the write root —
    /// driven from Lua against the live surface.
    #[test]
    #[ignore = "needs lua.dll on the runtime path"]
    fn sqlite_round_trips_and_guards() {
        let (lua, exports, _doc) = built();
        lua.globals().set("dcs_studio", &exports).expect("set global");
        lua.load(
            r#"
            local db = assert(dcs_studio.sqlite.open(":memory:"))
            assert(db:exec("CREATE TABLE t(id INTEGER, name TEXT)"))
            assert(db:exec("INSERT INTO t VALUES (?, ?)", {1, "a"}) == 1)
            local rows = assert(db:query("SELECT name FROM t WHERE id = ?", {1}))
            assert(rows[1].name == "a", "query round-trip")

            -- A failed transaction rolls its insert back.
            local ok = db:transaction(function()
                db:exec("INSERT INTO t VALUES (?, ?)", {2, "b"})
                error("boom")
            end)
            assert(ok == nil, "transaction returns nil on error")
            local counted = assert(db:query("SELECT count(*) AS n FROM t"))
            assert(counted[1].n == 1, "rollback discarded the insert")

            -- A path escape is refused.
            local bad, err = dcs_studio.sqlite.open("../escape.db")
            assert(bad == nil and err ~= nil, "path escape refused")
            "#,
        )
        .exec()
        .expect("sqlite lua suite");
    }

    /// Every key registered on the live module table (and each sub-namespace
    /// table) has a recorded `.d.lua` type — the facade can't register a
    /// binding without documenting it.
    #[test]
    #[ignore = "needs lua.dll on the runtime path"]
    fn every_registered_key_is_documented() {
        let (_lua, exports, doc) = built();

        let documented = |class_name: &str| -> BTreeSet<String> {
            doc.classes
                .iter()
                .find(|c| c.name == class_name)
                .map(|c| {
                    c.fields
                        .iter()
                        .map(|f| f.name.clone())
                        .chain(c.functions.iter().map(|f| f.name.clone()))
                        .collect()
                })
                .unwrap_or_default()
        };

        let table_keys = |t: &LuaTable| -> BTreeSet<String> {
            t.clone()
                .pairs::<String, mlua::Value>()
                .filter_map(|kv| kv.ok().map(|(k, _)| k))
                .collect()
        };

        // Root table.
        for key in table_keys(&exports) {
            assert!(
                documented("dcs_studio").contains(&key),
                "root key `{key}` is registered but not documented in the .d.lua"
            );
            // Each sub-namespace table's keys must be documented on its class.
            if let Ok(sub) = exports.get::<LuaTable>(key.as_str()) {
                let class = format!("dcs_studio.{key}");
                let doc_keys = documented(&class);
                for sub_key in table_keys(&sub) {
                    assert!(
                        doc_keys.contains(&sub_key),
                        "`{key}.{sub_key}` is registered but not documented"
                    );
                }
            }
        }
    }
}
