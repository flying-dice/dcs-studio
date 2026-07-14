//! The bridge module's whole Lua surface, assembled through the binding
//! facade so registration and `.d.lua` type recording share one declaration.
//!
//! [`build`] returns the populated exports table's [`ModuleDoc`]; the caller
//! ([`crate::bootstrap`]) then wires `emit_dlua` (which needs the finished
//! doc) and `dump_globals` onto the exports table.

use crate::facade::{r, Surface};
use crate::luadef::ModuleDoc;
use crate::BridgeKind;
use mlua::prelude::{LuaResult, LuaTable};
use mlua::Lua;

/// Register every binding on `exports` and return the recorded type surface.
/// `kind` names the module (`dcs_studio_gui` / `dcs_studio_mission`);
/// `version` is the crate version exposed as `<module>.version`.
pub fn build(
    lua: &Lua,
    exports: &LuaTable,
    kind: BridgeKind,
    version: &str,
) -> LuaResult<ModuleDoc> {
    let module_name = kind.module_name();
    let mut s = Surface::new(
        lua,
        exports,
        module_name,
        &format!(
            "The in-DCS DCS Studio native runtime for the {} environment — \
             loaded via require(\"{}\").",
            kind.env_name(),
            module_name
        ),
    );

    s.constant(
        "name",
        "The service name (\"dcs-studio-gui\" / \"dcs-studio-mission\").",
        kind.service_name(),
    )?;
    s.constant(
        "version",
        "The bridge workspace version this DLL was built from.",
        version.to_string(),
    )?;
    s.constant(
        "rt_source",
        "The console/REPL runtime source (__DCS_STUDIO_RT), for injecting into \
         remote states via net.dostring_in.",
        crate::RT_SOURCE,
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
        "console",
        "Sim→IDE console pipe: printed lines stream into the DCS Studio Console panel.",
        crate::console::register,
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
    // closure in bootstrap().
    s.record_root_fn(
        "emit_dlua",
        &[],
        &[r("string")],
        "Return the generated EmmyLua (.d.lua) type definitions for this module.",
    );

    // `dump_globals` is wired up in bootstrap() (it introspects the live `_G`
    // at call time); record its type here so the module self-describes it.
    s.record_root_fn(
        "dump_globals",
        &[],
        &[r("string")],
        "Introspect the live DCS API in `_G` (this bridge's curated roots) and return it as dotted .d.lua statements the editor indexes.",
    );

    // `register_methods` is the shared method-registration chunk, loaded and
    // set on the exports table in bootstrap(). It is the single source of truth
    // behind `rpc.discover`'s OpenRPC document (live and golden). Record its
    // type here so the module self-describes it.
    s.record_root_fn(
        "register_methods",
        &[
            crate::facade::p("router", &format!("{module_name}.jsonrpc.JsonRpcRouter")),
            crate::facade::p("deps", "table"),
        ],
        &[r("table")],
        "Register this bridge's JSON-RPC method set on `router`. `deps` injects \
         the runtime touchpoints (bridge exports, debug engine, console runtime); \
         the hook/mission init pass live values, the OpenRPC golden test passes \
         stubs. The single source of truth behind rpc.discover.",
    );

    Ok(s.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mlua::prelude::LuaValue;
    use mlua::Lua;
    use std::collections::BTreeSet;

    /// These mlua tests need a real Lua 5.1 at runtime: on Windows that is
    /// DCS's own `lua.dll` (put it on PATH and run with `-- --include-ignored`);
    /// on non-Windows, build.rs links PUC liblua5.1 into the test binary so the
    /// Linux CI rust job runs them as ordinary tests (issue #28).
    fn built() -> (Lua, LuaTable, ModuleDoc) {
        let lua = Lua::new();
        let exports = lua.create_table().expect("exports");
        let doc =
            build(&lua, &exports, BridgeKind::Gui, env!("CARGO_PKG_VERSION")).expect("surface");
        (lua, exports, doc)
    }

    /// The serde codecs actually round-trip through the live mlua surface:
    /// `json` and `toml` encode a Lua table and decode it back. Exercises the
    /// `(value, err)` idiom and the TOML⇄JSON value bridge (which has real
    /// failure modes — top-level must be a table, no nulls).
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn serde_codecs_round_trip() {
        let (lua, exports, _doc) = built();

        let json: LuaTable = exports.get("json").expect("json sub");
        let encode: mlua::Function = json.get("encode").expect("json.encode");
        let decode: mlua::Function = json.get("decode").expect("json.decode");
        let tbl = lua.create_table().expect("t");
        tbl.set("n", 3).expect("set");
        let (text, err): (Option<String>, Option<String>) = encode.call(&tbl).expect("encode call");
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

    /// `json.safe_encode` coerces sim-unsafe values (NaN → null, non-UTF-8
    /// lossy) to a JSON string instead of erroring or panicking — the
    /// `SafeEncodeNeverPanics` guarantee. Pins the None / coercion arms in
    /// `lua_utils::serialize_lua_to_json` (neutering either changes this output).
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn safe_encode_coerces_unsafe_values() {
        let (lua, exports, _doc) = built();
        let json: LuaTable = exports.get("json").expect("json sub");
        let safe: mlua::Function = json.get("safe_encode").expect("json.safe_encode");

        // NaN → null: serde_json::Number::from_f64 returns None for NaN, which
        // must fall back to null rather than unwrap-panic the serializer.
        let t = lua.create_table().expect("t");
        t.set("x", f64::NAN).expect("set nan");
        let (text, err): (Option<String>, Option<String>) = safe.call(&t).expect("safe_encode nan");
        assert!(err.is_none(), "safe_encode nan err: {err:?}");
        assert_eq!(text.expect("json"), "{\"x\":null}");

        // A non-UTF-8 byte string is decoded lossily — still a string, no error.
        let bytes = lua.create_string(b"\xff\xfe").expect("bytes");
        let (text, err): (Option<String>, Option<String>) =
            safe.call(bytes).expect("safe_encode bytes");
        assert!(err.is_none(), "safe_encode bytes err: {err:?}");
        assert!(text.is_some(), "expected a lossy JSON string");
    }

    /// `file.write_text` writes under a faked `lfs.writedir()` and refuses a
    /// path that climbs out of the write root.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn file_writes_under_guarded_root_and_refuses_escape() {
        let lua = Lua::new();
        let root =
            std::env::temp_dir().join(format!("dcs-studio-file-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("mk root");
        // Fake `lfs.writedir()` returning our temp root.
        let lfs = lua.create_table().expect("lfs");
        let root_str = format!("{}/", root.display());
        lfs.set(
            "writedir",
            lua.create_function(move |_, ()| Ok(root_str.clone()))
                .expect("fn"),
        )
        .expect("set writedir");
        lua.globals().set("lfs", lfs).expect("set lfs");

        let exports = lua.create_table().expect("exports");
        build(&lua, &exports, BridgeKind::Gui, env!("CARGO_PKG_VERSION")).expect("surface");
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
        assert!(
            err.unwrap_or_default().contains("escape"),
            "expected escape error"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The sqlite handle round-trips CRUD + parameters, rolls a failed
    /// transaction back, and refuses a path that escapes the write root —
    /// driven from Lua against the live surface.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn sqlite_round_trips_and_guards() {
        let (lua, exports, _doc) = built();
        lua.globals()
            .set("dcs_studio", &exports)
            .expect("set global");
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

    /// The console/REPL runtime (`RT_SOURCE`, injected into remote states)
    /// drives its explorer entry points against a live Lua state: tables AND
    /// functions get refs; the arity preview falls back cleanly on PUC 5.1
    /// (no `nparams`); `signature_json` resolves real parameter names without
    /// running the body, returns 0-arg cleanly, flags C functions as native
    /// without hanging, and errors on a stale ref.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn rt_explorer_and_signatures() {
        // SAFETY: test-only state; `unsafe_new` loads the debug stdlib, which
        // the signature/arity paths need (DCS states expose `debug` too).
        let lua = unsafe { Lua::unsafe_new() };
        lua.load(crate::RT_SOURCE).exec().expect("install RT");
        lua.load(
            r#"
            local RT = assert(__DCS_STUDIO_RT, "RT installed")
            assert(RT.version == 2, "RT is v2")

            G = {
              tbl = { a = 1, b = 2 },
              fn3 = function(text, displayTime, clearView) return 1 end,
              fn0 = function() end,
              prnt = print,
            }

            -- A function inspection registers a ref and types as a function.
            local r = RT.inspect_json("G.fn3")
            local fref = tonumber(r:match('"ref"%s*:%s*(%d+)'))
            assert(r:find('"type":"function"'), "fn3 typed function")
            assert(fref and fref > 0, "fn3 got a ref")

            -- Real parameter names, resolved without running the body.
            local s = RT.signature_json(fref)
            assert(s:find('"ok":true'), "sig ok")
            assert(s:find('"params":"text, displayTime, clearView"'), "resolved names: " .. s)

            -- A 0-arg function terminates the capture loop cleanly.
            local r0 = RT.inspect_json("G.fn0")
            local f0 = tonumber(r0:match('"ref"%s*:%s*(%d+)'))
            assert(RT.signature_json(f0):find('"params":""'), "0-arg empty params")

            -- A C function (print) is flagged native and never hangs the loop.
            local rp = RT.inspect_json("G.prnt")
            assert(rp:find('function %(native%)'), "print native preview: " .. rp)
            local fp = tonumber(rp:match('"ref"%s*:%s*(%d+)'))
            assert(RT.signature_json(fp):find('"native":true'), "print native sig")

            -- A stale ref errors rather than crashing.
            local st = RT.signature_json(999999)
            assert(st:find('"ok":false') and st:find('stale ref'), "stale ref err: " .. st)

            -- Expanding a table lists function children with their type + ref.
            local gref = tonumber(RT.inspect_json("G"):match('"ref"%s*:%s*(%d+)'))
            local ex = RT.expand_json(gref)
            assert(ex:find('"name":"fn3"') and ex:find('"type":"function"'), "expand types functions")

            -- clear releases every ref.
            RT.clear_json()
            assert(RT.signature_json(fref):find("stale ref"), "cleared refs are stale")
            "#,
        )
        .exec()
        .expect("rt explorer/signature suite");
    }

    /// Without the debug library (`Lua::new()` omits it, as do sanitized DCS
    /// states), the RT degrades instead of raising: function previews drop the
    /// arity suffix and `signature_json` reports unavailability.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn rt_explorer_degrades_without_debug_library() {
        let lua = Lua::new();
        lua.load(crate::RT_SOURCE).exec().expect("install RT");
        lua.load(
            r#"
            local RT = assert(__DCS_STUDIO_RT, "RT installed")
            assert(debug == nil, "harness state really has no debug library")

            G = { fn3 = function(a, b, c) return 1 end }

            -- Preview degrades to a bare "function" (no arity, no error).
            local r = RT.inspect_json("G.fn3")
            assert(r:find('"value":"function"') and not r:find("args"), "bare function preview: " .. r)

            -- Signature resolution reports unavailability rather than raising.
            local fref = tonumber(r:match('"ref"%s*:%s*(%d+)'))
            local s = RT.signature_json(fref)
            assert(s:find('"ok":false') and s:find("debug library not present"), "sig unavailable: " .. s)
            "#,
        )
        .exec()
        .expect("rt degraded (no debug) suite");
    }

    /// Every key registered on the live module table (and each sub-namespace
    /// table) has a recorded `.d.lua` type — the facade can't register a
    /// binding without documenting it.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn every_registered_key_is_documented() {
        let (_lua, exports, doc) = built();
        let root = BridgeKind::Gui.module_name();

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
                documented(root).contains(&key),
                "root key `{key}` is registered but not documented in the .d.lua"
            );
            // Each sub-namespace table's keys must be documented on its class.
            if let Ok(sub) = exports.get::<LuaTable>(key.as_str()) {
                let class = format!("{root}.{key}");
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
