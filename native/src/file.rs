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
use crate::get_lfs_writedir;
use crate::lua_utils::{opt_bool, opt_str, serialize_lua_to_json, to_json_string};
use crate::path_guard::stays_under;
use mlua::prelude::{LuaTable, LuaValue};
use mlua::{IntoLuaMulti, Lua, Result};
use std::path::{Path, PathBuf};

/// Resolve `rel` under `lfs.writedir()`, refusing any path that escapes the root.
fn resolve(lua: &Lua, rel: &str) -> std::result::Result<PathBuf, String> {
    if !stays_under(rel) {
        return Err(format!("path escapes the write root: {rel}"));
    }
    let writedir =
        get_lfs_writedir(lua).map_err(|e| format!("lfs.writedir() unavailable: {e}"))?;
    Ok(PathBuf::from(writedir).join(rel))
}

/// Create parent dirs, then truncate-write or append `bytes`.
fn write_bytes(path: &Path, bytes: &[u8], append: bool) -> std::io::Result<()> {
    use std::io::Write as _;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
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
            .filter_map(|c| c.ok())
            .map(|c| csv_field(&cell_to_string(&c)))
            .collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    Ok(out)
}

/// Sim-safe JSON encode of a Lua value (NaN/Inf → null, non-UTF-8 lossy).
fn encode_json(value: &LuaValue, pretty: bool) -> std::result::Result<String, String> {
    let json = serialize_lua_to_json(value).ok_or("value is not JSON-serializable")?;
    to_json_string(&json, pretty).map_err(|e| e.to_string())
}

/// Infer the dump format from a path's extension (.json / .csv / else text).
fn infer_format(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".json") {
        "json"
    } else if lower.ends_with(".csv") {
        "csv"
    } else {
        "text"
    }
}

/// Register the `file.*` write helpers on `sub`.
pub fn register(sub: &mut Sub) -> Result<()> {
    sub.func(
        "write_text",
        &[p("path", "string"), p("content", "string"), p_opt("opts", "table")],
        &[r_named("boolean?", "ok"), r_named("string?", "err")],
        "Write `content` to `path` under lfs.writedir(), truncating. \
         `opts.append = true` appends instead. Refuses a path that escapes the \
         write root.",
        |lua: &Lua, (path, content, opts): (String, String, Option<LuaTable>)| {
            let append = opt_bool(&opts, "append");
            match resolve(lua, &path).and_then(|p| {
                write_bytes(&p, content.as_bytes(), append).map_err(|e| format!("file.write_text: {e}"))
            }) {
                Ok(()) => true.into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, e).into_lua_multi(lua),
            }
        },
    )?;

    sub.func(
        "write_json",
        &[p("path", "string"), p("value", "any"), p_opt("opts", "table")],
        &[r_named("boolean?", "ok"), r_named("string?", "err")],
        "Encode `value` to JSON (sim-safe) and write it to `path` under \
         lfs.writedir(). `opts.pretty = true` indents.",
        |lua: &Lua, (path, value, opts): (String, LuaValue, Option<LuaTable>)| {
            let pretty = opt_bool(&opts, "pretty");
            match encode_json(&value, pretty)
                .and_then(|text| resolve(lua, &path).map(|p| (p, text)))
                .and_then(|(p, text)| {
                    write_bytes(&p, text.as_bytes(), false).map_err(|e| format!("file.write_json: {e}"))
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
        |lua: &Lua, (path, rows): (String, LuaTable)| {
            match encode_csv(&rows)
                .and_then(|text| resolve(lua, &path).map(|p| (p, text)))
                .and_then(|(p, text)| {
                    write_bytes(&p, text.as_bytes(), false).map_err(|e| format!("file.write_csv: {e}"))
                }) {
                Ok(()) => true.into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, e).into_lua_multi(lua),
            }
        },
    )?;

    sub.func(
        "dump",
        &[p("path", "string"), p("value", "any"), p_opt("opts", "table")],
        &[r_named("boolean?", "ok"), r_named("string?", "err")],
        "Write `value` to `path` under lfs.writedir(), inferring the format from \
         the extension (.json / .csv / anything else = text), or `opts.format` \
         (\"json\" | \"csv\" | \"text\").",
        |lua: &Lua, (path, value, opts): (String, LuaValue, Option<LuaTable>)| {
            let format = opt_str(&opts, "format").unwrap_or_else(|| infer_format(&path).to_string());
            let encoded = match format.as_str() {
                "json" => encode_json(&value, opt_bool(&opts, "pretty")),
                "csv" => match value {
                    LuaValue::Table(ref rows) => encode_csv(rows),
                    _ => Err("dump: csv format needs an array-of-arrays table".to_string()),
                },
                _ => Ok(cell_to_string(&value)),
            };
            match encoded
                .and_then(|text| resolve(lua, &path).map(|p| (p, text)))
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
