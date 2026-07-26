//! The `file` sub-namespace: write sim data to disk under the **guarded** DCS
//! write root (`lfs.writedir()`). Every destination is resolved under the write
//! dir and a path that is absolute, drive-prefixed, or climbs out with `..` is
//! refused before any IO — the same lexical guard the installer uses
//! (`crate::path_guard::stays_under`). Registered + type-recorded
//! through the binding facade.
//!
//! These writes run inside an RPC handler on the sim's main loop, so a large
//! dump stutters the frame: keep dumps small/periodic, and prefer the `sqlite`
//! submodule for bulk persistence.

use crate::facade::{p, p_opt, r_named, Sub};
use crate::lua_utils::{opt_bool, opt_str, to_safe_json_string};
use crate::path_guard::resolve_under_writedir;
use mlua::prelude::{LuaTable, LuaValue};
use mlua::{IntoLuaMulti, Lua, Result};
use std::path::Path;

/// Create parent dirs, then truncate-write or append `bytes`.
fn write_bytes(path: &Path, bytes: &[u8], append: bool) -> std::io::Result<()> {
    use std::io::Write as _;
    // `path` is always `<writedir>/<rel>` with `rel` relative and non-empty, so
    // it always names a parent; `.` is the total fallback rather than a branch
    // that would silently skip the create. Creating it is what lets a dump into
    // a not-yet-existing subdirectory work the first time.
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(path)?;
    f.write_all(bytes)
}

/// Render one CSV cell value as text (only scalars; other types become empty).
fn cell_to_string(value: &LuaValue) -> String {
    match value {
        LuaValue::String(s) => s.to_string_lossy(),
        LuaValue::Integer(i) => i.to_string(),
        LuaValue::Number(n) => n.to_string(),
        LuaValue::Boolean(b) => b.to_string(),
        _ => String::new(),
    }
}

/// Quote a CSV field per RFC-4180 when it contains a comma, quote, or newline.
fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Encode an array-of-arrays Lua table to CSV text.
fn encode_csv(rows: &LuaTable) -> std::result::Result<String, String> {
    let mut out = String::new();
    for (i, row) in rows.clone().sequence_values::<LuaTable>().enumerate() {
        let row = row.map_err(|e| format!("row {} is not a table: {e}", i + 1))?;
        let cells: Vec<String> = row
            .sequence_values::<LuaValue>()
            .filter_map(std::result::Result::ok)
            .map(|c| csv_field(&cell_to_string(&c)))
            .collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    Ok(out)
}

/// Infer the dump format from a path's extension (.json / .csv / else text).
fn infer_format(path: &str) -> &'static str {
    match std::path::Path::new(path)
        .extension()
        .map(std::ffi::OsStr::to_ascii_lowercase)
    {
        Some(ext) if ext == "json" => "json",
        Some(ext) if ext == "csv" => "csv",
        _ => "text",
    }
}

/// Register the `file.*` write helpers on `sub`.
pub fn register(sub: &mut Sub) -> Result<()> {
    sub.func(
        "write_text",
        &[
            p("path", "string"),
            p("content", "string"),
            p_opt("opts", "table"),
        ],
        &[r_named("boolean?", "ok"), r_named("string?", "err")],
        "Write `content` to `path` under lfs.writedir(), truncating. \
         `opts.append = true` appends instead. Refuses a path that escapes the \
         write root.",
        |lua: &Lua, (path, content, opts): (String, String, Option<LuaTable>)| {
            let append = opt_bool(opts.as_ref(), "append");
            match resolve_under_writedir(lua, &path).and_then(|p| {
                write_bytes(&p, content.as_bytes(), append)
                    .map_err(|e| format!("file.write_text: {e}"))
            }) {
                Ok(()) => true.into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, e).into_lua_multi(lua),
            }
        },
    )?;

    sub.func(
        "write_json",
        &[
            p("path", "string"),
            p("value", "any"),
            p_opt("opts", "table"),
        ],
        &[r_named("boolean?", "ok"), r_named("string?", "err")],
        "Encode `value` to JSON (sim-safe) and write it to `path` under \
         lfs.writedir(). `opts.pretty = true` indents.",
        |lua: &Lua, (path, value, opts): (String, LuaValue, Option<LuaTable>)| {
            let pretty = opt_bool(opts.as_ref(), "pretty");
            match to_safe_json_string(&value, pretty)
                .and_then(|text| resolve_under_writedir(lua, &path).map(|p| (p, text)))
                .and_then(|(p, text)| {
                    write_bytes(&p, text.as_bytes(), false)
                        .map_err(|e| format!("file.write_json: {e}"))
                }) {
                Ok(()) => true.into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, e).into_lua_multi(lua),
            }
        },
    )?;

    sub.func(
        "write_csv",
        &[p("path", "string"), p("rows", "any[][]")],
        &[r_named("boolean?", "ok"), r_named("string?", "err")],
        "Write `rows` (an array of arrays of scalars) as RFC-4180 CSV to `path` \
         under lfs.writedir().",
        |lua: &Lua, (path, rows): (String, LuaTable)| match encode_csv(&rows)
            .and_then(|text| resolve_under_writedir(lua, &path).map(|p| (p, text)))
            .and_then(|(p, text)| {
                write_bytes(&p, text.as_bytes(), false).map_err(|e| format!("file.write_csv: {e}"))
            }) {
            Ok(()) => true.into_lua_multi(lua),
            Err(e) => (LuaValue::Nil, e).into_lua_multi(lua),
        },
    )?;

    sub.func(
        "dump",
        &[
            p("path", "string"),
            p("value", "any"),
            p_opt("opts", "table"),
        ],
        &[r_named("boolean?", "ok"), r_named("string?", "err")],
        "Write `value` to `path` under lfs.writedir(), inferring the format from \
         the extension (.json / .csv / anything else = text), or `opts.format` \
         (\"json\" | \"csv\" | \"text\").",
        |lua: &Lua, (path, value, opts): (String, LuaValue, Option<LuaTable>)| {
            let format =
                opt_str(opts.as_ref(), "format").unwrap_or_else(|| infer_format(&path).to_string());
            let encoded = match format.as_str() {
                "json" => to_safe_json_string(&value, opt_bool(opts.as_ref(), "pretty")),
                "csv" => match value {
                    LuaValue::Table(ref rows) => encode_csv(rows),
                    _ => Err("dump: csv format needs an array-of-arrays table".to_string()),
                },
                _ => Ok(cell_to_string(&value)),
            };
            match encoded
                .and_then(|text| resolve_under_writedir(lua, &path).map(|p| (p, text)))
                .and_then(|(p, text)| {
                    write_bytes(&p, text.as_bytes(), false).map_err(|e| format!("file.dump: {e}"))
                }) {
                Ok(()) => true.into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, e).into_lua_multi(lua),
            }
        },
    )?;

    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{infer_format, register};
    use crate::facade::sub_table;
    use mlua::prelude::LuaTable;
    use mlua::Lua;
    use std::path::PathBuf;

    /// A Lua state with the `file` surface bound as the global `file` and
    /// `lfs.writedir()` faked to a fresh temp root, mirroring how DCS hands the
    /// bridge its write dir. Returns the root so tests can read what landed.
    fn state(tag: &str) -> (Lua, PathBuf) {
        let lua = Lua::new();
        let root = std::env::temp_dir().join(format!(
            "dcs-studio-file-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("mk root");

        let writedir = format!("{}/", root.display());
        let lfs = lua.create_table().expect("lfs");
        lfs.set(
            "writedir",
            lua.create_function(move |_, ()| Ok(writedir.clone()))
                .expect("writedir fn"),
        )
        .expect("set writedir");
        lua.globals().set("lfs", lfs).expect("set lfs");

        let file = sub_table(&lua, "file", register);
        lua.globals().set("file", file).expect("set file");
        (lua, root)
    }

    /// Plant a regular file where the next write wants a directory. Every write
    /// through this module creates parent dirs first, so this is the cheap,
    /// portable way to make the IO itself fail — the case that decides whether
    /// a bad `lfs.writedir()` returns `(nil, err)` to the mission script or
    /// raises out of the RPC handler.
    fn block_with_a_file(root: &std::path::Path, name: &str) {
        std::fs::write(root.join(name), b"not a directory").expect("plant blocker");
    }

    /// The extension decides the format when `opts.format` is absent, and DCS
    /// mods write `Dump.JSON` as often as `dump.json` — the match is on the
    /// lowercased extension for exactly that reason.
    #[test]
    fn the_dump_format_follows_the_extension_case_insensitively() {
        assert_eq!(infer_format("a/b/state.json"), "json");
        assert_eq!(infer_format("STATE.JSON"), "json");
        assert_eq!(infer_format("units.csv"), "csv");
        assert_eq!(infer_format("units.CSV"), "csv");
        // Anything else — including no extension at all — is plain text, never
        // a silent JSON encode of a value the caller meant to write verbatim.
        assert_eq!(infer_format("notes.txt"), "text");
        assert_eq!(infer_format("notes"), "text");
    }

    /// `write_text` truncates by default and appends under `opts.append`.
    /// A telemetry mod appending per frame must not find the file rewritten
    /// from the top each time.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn write_text_truncates_by_default_and_appends_on_request() {
        let (lua, root) = state("text");
        lua.load(
            r#"
            assert(file.write_text("Logs/t.txt", "first\n"))
            assert(file.write_text("Logs/t.txt", "second\n"))
            assert(file.write_text("Logs/t.txt", "third\n", { append = true }))
            "#,
        )
        .exec()
        .expect("write_text");

        assert_eq!(
            std::fs::read_to_string(root.join("Logs").join("t.txt")).expect("read"),
            "second\nthird\n",
            "the second write truncated, the third appended"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every writer refuses a path that escapes the write root *before* any IO,
    /// and reports the failure as `(nil, err)`. `rel` arrives from a JSON-RPC
    /// caller on the loopback HTTP surface, so an escape here is an
    /// arbitrary-file-write primitive on the user's machine.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn every_writer_refuses_a_path_that_escapes_the_write_root() {
        let (lua, root) = state("escape");
        lua.load(
            r#"
            local function refused(ok, err)
              assert(ok == nil, "must not report success")
              assert(err and err:find("escapes the write root"), "cause: " .. tostring(err))
            end
            refused(file.write_text("../pwned.txt", "x"))
            refused(file.write_json("C:/pwned.json", { a = 1 }))
            refused(file.write_csv("/etc/pwned.csv", { { 1 } }))
            refused(file.dump("..\\pwned.txt", "x"))
            "#,
        )
        .exec()
        .expect("escape suite");

        assert!(
            std::fs::read_dir(&root)
                .expect("read root")
                .next()
                .is_none(),
            "a refused write must leave nothing behind"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An IO failure — an unwritable destination — comes back as `(nil, err)`
    /// tagged with the failing binding, never as a raise. These run inside an
    /// RPC handler on the sim's main loop, where an unhandled error aborts the
    /// mission script that called them.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn an_unwritable_destination_is_reported_per_binding() {
        let (lua, root) = state("io");
        block_with_a_file(&root, "blocked");
        // The other half of the same story: the parent resolves fine and the
        // FILE is what cannot be opened, because a directory already owns that
        // name. `<writedir>Temp` and `Logs` are directories DCS itself creates,
        // so a mission script writing to a bare "Logs" reaches exactly this.
        std::fs::create_dir_all(root.join("Logs")).expect("plant a directory");

        lua.load(
            r#"
            local function failed(prefix, ok, err)
              assert(ok == nil, prefix .. " must not report success")
              assert(err and err:find(prefix, 1, true), prefix .. " cause: " .. tostring(err))
            end
            failed("file.write_text", file.write_text("blocked/a.txt", "x"))
            failed("file.write_json", file.write_json("blocked/a.json", { a = 1 }))
            failed("file.write_csv", file.write_csv("blocked/a.csv", { { 1 } }))
            failed("file.dump", file.dump("blocked/a.txt", "x"))
            -- The destination is a directory: the open fails, not the mkdir.
            failed("file.write_text", file.write_text("Logs", "x"))
            "#,
        )
        .exec()
        .expect("io failure suite");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `write_json` is the sim-safe encoder: NaN becomes null rather than
    /// aborting, `opts.pretty` indents, and a value with no JSON form at all
    /// (a function) is refused with the cause instead of writing a truncated
    /// file.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn write_json_coerces_unsafe_scalars_and_refuses_unrepresentable_values() {
        let (lua, root) = state("json");
        lua.load(
            r#"
            assert(file.write_json("compact.json", { n = 1 }))
            assert(file.write_json("pretty.json", { n = 1 }, { pretty = true }))
            assert(file.write_json("nan.json", { n = 0/0 }))

            local ok, err = file.write_json("fn.json", { f = print })
            assert(ok == nil and err and err:find("not JSON%-serializable"), tostring(err))
            "#,
        )
        .exec()
        .expect("write_json suite");

        let read = |name: &str| std::fs::read_to_string(root.join(name)).expect("read");
        assert_eq!(read("compact.json"), r#"{"n":1}"#);
        assert_eq!(
            read("pretty.json"),
            "{\n  \"n\": 1\n}",
            "pretty must indent exactly like serde_json::to_string_pretty"
        );
        assert_eq!(
            read("nan.json"),
            r#"{"n":null}"#,
            "NaN has no JSON form; null keeps the dump valid instead of failing"
        );
        assert!(
            !root.join("fn.json").exists(),
            "no file for a refused encode"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// CSV is RFC-4180: a cell containing a comma, a quote or a newline is
    /// quoted and its quotes doubled. Unit names and mission briefings contain
    /// all three, and an unquoted comma silently shifts every later column.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn write_csv_quotes_the_fields_that_need_it_and_flattens_scalars() {
        let (lua, root) = state("csv");
        lua.load(
            r#"
            assert(file.write_csv("units.csv", {
              { "name", "alive", "hp", "frac" },
              { "F-15C", true, 100, 0.5 },
              { "Ka-50, Black Shark", 'say "hi"', "line\nbreak", {} },
            }))
            "#,
        )
        .exec()
        .expect("write_csv");

        assert_eq!(
            std::fs::read_to_string(root.join("units.csv")).expect("read"),
            concat!(
                "name,alive,hp,frac\n",
                "F-15C,true,100,0.5\n",
                "\"Ka-50, Black Shark\",\"say \"\"hi\"\"\",\"line\nbreak\",\n",
            ),
            "a non-scalar cell flattens to empty rather than aborting the dump"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A row that is not a table names its own 1-based index in the error, so
    /// a mod dumping a ragged table can find the offending row without
    /// bisecting the dump.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn write_csv_names_the_row_that_is_not_a_table() {
        let (lua, root) = state("csvbad");
        lua.load(
            r#"
            local ok, err = file.write_csv("bad.csv", { { 1 }, "not a row" })
            assert(ok == nil, "must refuse")
            assert(err and err:find("row 2 is not a table"), tostring(err))
            "#,
        )
        .exec()
        .expect("ragged csv");
        assert!(!root.join("bad.csv").exists(), "nothing written");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `dump` picks its encoder from the extension, and `opts.format`
    /// overrides it — a mod writing `state.log` as JSON must not get the
    /// value's `tostring` instead.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn dump_infers_the_encoder_from_the_extension_and_honours_the_override() {
        let (lua, root) = state("dump");
        lua.load(
            r#"
            assert(file.dump("a.json", { n = 1 }))
            assert(file.dump("b.csv", { { "x", 1 } }))
            assert(file.dump("c.txt", "plain"))
            assert(file.dump("d.log", { n = 2 }, { format = "json", pretty = true }))
            assert(file.dump("e.dat", { { "y", 2 } }, { format = "csv" }))
            assert(file.dump("f.json", 42, { format = "text" }))

            -- csv without an array-of-arrays is refused rather than written as
            -- an empty file the caller would mistake for a successful dump.
            local ok, err = file.dump("g.csv", "not a table")
            assert(ok == nil and err and err:find("array%-of%-arrays"), tostring(err))
            "#,
        )
        .exec()
        .expect("dump suite");

        let read = |name: &str| std::fs::read_to_string(root.join(name)).expect("read");
        assert_eq!(read("a.json"), r#"{"n":1}"#);
        assert_eq!(read("b.csv"), "x,1\n");
        assert_eq!(read("c.txt"), "plain");
        assert_eq!(read("d.log"), "{\n  \"n\": 2\n}");
        assert_eq!(read("e.dat"), "y,2\n");
        assert_eq!(read("f.json"), "42", "the override wins over the extension");
        assert!(!root.join("g.csv").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Without `lfs`, resolution falls back to `__DCS_STUDIO_WRITEDIR` — the
    /// global the GUI hook plants in the sanitized mission state, where `lfs`
    /// has been removed. If this regressed, every `file.*` call from mission
    /// scripting would fail with "writedir unavailable".
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn writes_still_resolve_in_a_sanitized_state_without_lfs() {
        let lua = Lua::new();
        let root =
            std::env::temp_dir().join(format!("dcs-studio-file-nolfs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("mk root");
        lua.globals()
            .set("__DCS_STUDIO_WRITEDIR", format!("{}/", root.display()))
            .expect("set writedir global");

        let file: LuaTable = sub_table(&lua, "file", register);
        lua.globals().set("file", file).expect("set file");
        lua.load(r#"assert(file.write_text("m.txt", "mission"))"#)
            .exec()
            .expect("write via the global");

        assert_eq!(
            std::fs::read_to_string(root.join("m.txt")).expect("read"),
            "mission"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// With neither `lfs` nor the fallback global there is no write root at
    /// all: the write must be refused with the unavailability cause, not
    /// resolved against the process's current directory (which inside DCS is
    /// the game install).
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_missing_write_root_refuses_the_write_rather_than_guessing() {
        let lua = Lua::new();
        let file: LuaTable = sub_table(&lua, "file", register);
        lua.globals().set("file", file).expect("set file");
        lua.load(
            r#"
            local ok, err = file.write_text("x.txt", "x")
            assert(ok == nil, "must refuse")
            assert(err and err:find("writedir%(%) unavailable"), tostring(err))
            "#,
        )
        .exec()
        .expect("no writedir");
    }
}
