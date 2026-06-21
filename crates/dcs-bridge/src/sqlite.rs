//! The `sqlite` sub-namespace: an embedded SQLite database (bundled, no
//! external DLL) reachable from sim-side Lua. `sqlite.open(path)` returns a
//! `Db` handle whose file is confined to the guarded DCS write root
//! (`lfs.writedir()`); `:memory:` opens an ephemeral in-memory DB.
//!
//! **Per-frame safety.** Queries run inside an RPC handler on the sim's main
//! loop, so a long query or a lock wait stutters the frame. The handle opens
//! with `journal_mode=WAL` and a **zero** busy timeout, so lock contention
//! returns `SQLITE_BUSY` (a retryable error) immediately instead of blocking
//! the sim. Keep queries small and indexed — this is a dev tool, not OLAP.

use crate::facade::{p, p_opt, r_named, Sub};
use crate::get_lfs_writedir;
use dcs_studio_project::install::stays_under;
use mlua::prelude::{LuaTable, LuaValue};
use mlua::{Function, IntoLuaMulti, Lua, Result, UserData, UserDataMethods};
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use std::cell::RefCell;
use std::path::PathBuf;
use std::time::Duration;

/// An open SQLite database handle. The connection is held in a `RefCell<Option>`
/// so `close()` can drop it and every method briefly borrows it (and releases
/// before any Lua re-entry, so a `transaction` callback can call back in).
struct Db {
    conn: RefCell<Option<Connection>>,
}

/// Open (creating if needed) a database at `path` under `lfs.writedir()`, or an
/// in-memory DB for `":memory:"`. Applies the per-frame-safety pragmas.
fn open_db(lua: &Lua, path: &str) -> std::result::Result<Db, String> {
    let conn = if path == ":memory:" {
        Connection::open_in_memory().map_err(|e| e.to_string())?
    } else {
        if !stays_under(path) {
            return Err(format!("path escapes the write root: {path}"));
        }
        let writedir =
            get_lfs_writedir(lua).map_err(|e| format!("lfs.writedir() unavailable: {e}"))?;
        let full = PathBuf::from(writedir).join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        Connection::open(&full).map_err(|e| e.to_string())?
    };
    // Return SQLITE_BUSY immediately rather than blocking the sim thread; WAL
    // lets a reader and a writer coexist without a long lock (a no-op for
    // :memory:, whose error is ignored).
    let _ = conn.busy_timeout(Duration::from_millis(0));
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    Ok(Db {
        conn: RefCell::new(Some(conn)),
    })
}

/// Convert a Lua array of scalars to positional SQL bind values.
fn to_sql_params(t: &LuaTable) -> std::result::Result<Vec<SqlValue>, String> {
    let mut out = Vec::new();
    for v in t.clone().sequence_values::<LuaValue>() {
        let v = v.map_err(|e| e.to_string())?;
        out.push(match v {
            LuaValue::Nil => SqlValue::Null,
            LuaValue::Boolean(b) => SqlValue::Integer(i64::from(b)),
            LuaValue::Integer(i) => SqlValue::Integer(i),
            LuaValue::Number(n) => SqlValue::Real(n),
            LuaValue::String(s) => SqlValue::Text(s.to_string_lossy()),
            other => return Err(format!("unsupported bind type: {}", other.type_name())),
        });
    }
    Ok(out)
}

/// Convert one SQL value back to a Lua value.
fn sql_to_lua(lua: &Lua, v: SqlValue) -> Result<LuaValue> {
    Ok(match v {
        SqlValue::Null => LuaValue::Nil,
        SqlValue::Integer(i) => LuaValue::Integer(i),
        SqlValue::Real(f) => LuaValue::Number(f),
        SqlValue::Text(s) => LuaValue::String(lua.create_string(&s)?),
        SqlValue::Blob(b) => LuaValue::String(lua.create_string(&b)?),
    })
}

/// Run a bare statement (BEGIN/COMMIT/ROLLBACK), borrowing the connection only
/// for the call so a re-entrant Lua callback can borrow it again.
fn exec_simple(db: &Db, sql: &str) -> std::result::Result<(), String> {
    let guard = db.conn.borrow();
    let conn = guard.as_ref().ok_or("database is closed")?;
    conn.execute_batch(sql).map_err(|e| e.to_string())
}

impl UserData for Db {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        // `exec(sql[, params])` — with params, one parameterised statement
        // returning rows-affected; without, an `execute_batch` (multiple
        // statements, e.g. a schema), returning 0.
        methods.add_method("exec", |lua, this, (sql, params): (String, Option<LuaTable>)| {
            let result = (|| -> std::result::Result<i64, String> {
                let guard = this.conn.borrow();
                let conn = guard.as_ref().ok_or("database is closed")?;
                match params {
                    Some(t) => {
                        let vals = to_sql_params(&t)?;
                        let n = conn
                            .execute(&sql, rusqlite::params_from_iter(vals))
                            .map_err(|e| e.to_string())?;
                        i64::try_from(n).map_err(|_| "rows-affected exceeds i64".to_string())
                    }
                    None => conn.execute_batch(&sql).map(|()| 0).map_err(|e| e.to_string()),
                }
            })();
            match result {
                Ok(changes) => changes.into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, format!("sqlite.exec: {e}")).into_lua_multi(lua),
            }
        });

        // `query(sql[, params])` — an array of row tables keyed by column name.
        methods.add_method("query", |lua, this, (sql, params): (String, Option<LuaTable>)| {
            let result = (|| -> std::result::Result<(Vec<String>, Vec<Vec<SqlValue>>), String> {
                let guard = this.conn.borrow();
                let conn = guard.as_ref().ok_or("database is closed")?;
                let mut stmt = conn.prepare_cached(&sql).map_err(|e| e.to_string())?;
                let cols: Vec<String> =
                    stmt.column_names().iter().map(|s| (*s).to_string()).collect();
                let ncols = cols.len();
                let vals = match params {
                    Some(t) => to_sql_params(&t)?,
                    None => Vec::new(),
                };
                let mut rows = stmt
                    .query(rusqlite::params_from_iter(vals))
                    .map_err(|e| e.to_string())?;
                let mut out = Vec::new();
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let mut cells = Vec::with_capacity(ncols);
                    for i in 0..ncols {
                        cells.push(row.get::<_, SqlValue>(i).map_err(|e| e.to_string())?);
                    }
                    out.push(cells);
                }
                Ok((cols, out))
            })();
            // Build the row array fallibly so a table-allocation failure surfaces
            // as the same (nil, err) tuple as every other arm, not a bare error.
            let built = result.and_then(|(cols, rows)| {
                let arr = lua.create_table().map_err(|e| e.to_string())?;
                for (ri, row) in rows.into_iter().enumerate() {
                    let t = lua.create_table().map_err(|e| e.to_string())?;
                    for (ci, v) in row.into_iter().enumerate() {
                        if let Some(name) = cols.get(ci) {
                            let cell = sql_to_lua(lua, v).map_err(|e| e.to_string())?;
                            t.set(name.as_str(), cell).map_err(|e| e.to_string())?;
                        }
                    }
                    arr.set(ri + 1, t).map_err(|e| e.to_string())?;
                }
                Ok(arr)
            });
            match built {
                Ok(arr) => arr.into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, format!("sqlite.query: {e}")).into_lua_multi(lua),
            }
        });

        // `transaction(fn)` — BEGIN, run `fn` (which uses the captured handle),
        // COMMIT on success or ROLLBACK on a Lua error. Each BEGIN/COMMIT/
        // ROLLBACK borrows the connection only briefly, so `fn` can re-enter
        // `exec`/`query` without a double borrow.
        methods.add_method("transaction", |lua, this, f: Function| {
            if let Err(e) = exec_simple(this, "BEGIN") {
                return (LuaValue::Nil, format!("sqlite.transaction: {e}")).into_lua_multi(lua);
            }
            match f.call::<mlua::MultiValue>(()) {
                Ok(_) => match exec_simple(this, "COMMIT") {
                    Ok(()) => true.into_lua_multi(lua),
                    Err(e) => {
                        (LuaValue::Nil, format!("sqlite.transaction commit: {e}")).into_lua_multi(lua)
                    }
                },
                Err(e) => {
                    let _ = exec_simple(this, "ROLLBACK");
                    (LuaValue::Nil, format!("sqlite.transaction: {e}")).into_lua_multi(lua)
                }
            }
        });

        // `close()` — drop the connection now (also dropped on GC).
        methods.add_method("close", |_lua, this, ()| {
            this.conn.borrow_mut().take();
            Ok(())
        });
    }
}

/// Register `sqlite.open` and record the `Db` handle type.
pub fn register(sub: &mut Sub) -> Result<()> {
    sub.func(
        "open",
        &[p("path", "string")],
        &[
            r_named("dcs_studio.sqlite.Db?", "db"),
            r_named("string?", "err"),
        ],
        "Open (creating if needed) a SQLite database at `path` under \
         lfs.writedir(), or \":memory:\" for an ephemeral in-memory DB. Returns \
         (nil, err) on a path escape or open failure.",
        |lua: &Lua, path: String| match open_db(lua, &path) {
            Ok(db) => db.into_lua_multi(lua),
            Err(e) => (LuaValue::Nil, e).into_lua_multi(lua),
        },
    )?;

    sub.record_userdata("Db", "An open SQLite database handle.", |ud| {
        ud.method(
            "exec",
            &[p("sql", "string"), p_opt("params", "any[]")],
            &[r_named("number?", "changes"), r_named("string?", "err")],
            "Execute SQL. With `params` (an array of scalars) runs one \
             parameterised statement and returns rows-affected; without, runs a \
             statement batch (e.g. a schema) and returns 0.",
        )
        .method(
            "query",
            &[p("sql", "string"), p_opt("params", "any[]")],
            &[r_named("table[]?", "rows"), r_named("string?", "err")],
            "Run a query and return an array of row tables keyed by column name.",
        )
        .method(
            "transaction",
            &[p("fn", "fun(): any")],
            &[r_named("boolean?", "ok"), r_named("string?", "err")],
            "Run `fn` inside BEGIN/COMMIT, rolling back if it raises. `fn` uses \
             the captured database handle.",
        )
        .method(
            "close",
            &[],
            &[],
            "Close the database now (also closed when garbage-collected).",
        );
    });

    Ok(())
}
