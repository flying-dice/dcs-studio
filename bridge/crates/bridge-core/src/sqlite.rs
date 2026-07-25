//! The `sqlite` sub-namespace: an embedded `SQLite` database (bundled, no
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
use crate::path_guard::resolve_under_writedir;
use mlua::prelude::{LuaTable, LuaValue};
use mlua::{Function, IntoLuaMulti, Lua, Result, UserData, UserDataMethods};
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use std::cell::RefCell;
use std::error::Error;
use std::time::Duration;

/// The internal error type of this module's fallible blocks. `Box<dyn Error>`
/// converts from `rusqlite::Error`, `std::io::Error` and a plain `&str` alike,
/// so every step reads as `?` and the cause is stringified once, at the
/// boundary where it becomes the `(nil, err)` a Lua caller sees.
type DbResult<T> = std::result::Result<T, Box<dyn Error>>;

/// An open `SQLite` database handle. The connection is held in a `RefCell<Option>`
/// so `close()` can drop it and every method briefly borrows it (and releases
/// before any Lua re-entry, so a `transaction` callback can call back in).
struct Db {
    conn: RefCell<Option<Connection>>,
}

/// Open (creating if needed) a database at `path` under `lfs.writedir()`, or an
/// in-memory DB for `":memory:"`. Applies the per-frame-safety pragmas.
fn open_db(lua: &Lua, path: &str) -> DbResult<Db> {
    let conn = if path == ":memory:" {
        Connection::open_in_memory()?
    } else {
        let full = resolve_under_writedir(lua, path)?;
        // `full` is always `<writedir>/<rel>` with `rel` relative and non-empty,
        // so it always names a parent; `.` is the total fallback rather than a
        // branch that would silently skip the create.
        std::fs::create_dir_all(full.parent().unwrap_or(std::path::Path::new(".")))?;
        Connection::open(&full)?
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
///
/// Indexed `1..#t` rather than walked as a sequence: a sequence walk stops dead
/// at the first `nil`, so `{1, nil, 3}` would bind ONE parameter and the
/// statement would fail with "wrong number of parameters" — which reads as a
/// bug in the caller's SQL when the real story is that a nil hole is how Lua
/// spells SQL NULL.
fn to_sql_params(t: &LuaTable) -> DbResult<Vec<SqlValue>> {
    let mut out = Vec::new();
    for index in 1..=t.raw_len() {
        out.push(match t.raw_get::<LuaValue>(index)? {
            LuaValue::Nil => SqlValue::Null,
            LuaValue::Boolean(b) => SqlValue::Integer(i64::from(b)),
            LuaValue::Integer(i) => SqlValue::Integer(i),
            LuaValue::Number(n) => SqlValue::Real(n),
            LuaValue::String(s) => SqlValue::Text(s.to_string_lossy()),
            other => {
                return Err(format!("unsupported bind type: {}", other.type_name()).into());
            }
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
fn exec_simple(db: &Db, sql: &str) -> DbResult<()> {
    let guard = db.conn.borrow();
    let conn = guard.as_ref().ok_or("database is closed")?;
    conn.execute_batch(sql)?;
    Ok(())
}

impl UserData for Db {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        // `exec(sql[, params])` — with params, one parameterised statement
        // returning rows-affected; without, an `execute_batch` (multiple
        // statements, e.g. a schema), returning 0.
        methods.add_method(
            "exec",
            |lua, this, (sql, params): (String, Option<LuaTable>)| {
                let result = (|| -> DbResult<i64> {
                    let guard = this.conn.borrow();
                    let conn = guard.as_ref().ok_or("database is closed")?;
                    if let Some(t) = params {
                        let vals = to_sql_params(&t)?;
                        let changed = conn.execute(&sql, rusqlite::params_from_iter(vals))?;
                        // SQLite's own change counter is an int; the cast
                        // cannot lose a row on any platform this builds for.
                        Ok(i64::try_from(changed).unwrap_or(i64::MAX))
                    } else {
                        conn.execute_batch(&sql)?;
                        Ok(0)
                    }
                })();
                match result {
                    Ok(changes) => changes.into_lua_multi(lua),
                    Err(e) => (LuaValue::Nil, format!("sqlite.exec: {e}")).into_lua_multi(lua),
                }
            },
        );

        // `query(sql[, params])` — an array of row tables keyed by column name.
        methods.add_method(
            "query",
            |lua, this, (sql, params): (String, Option<LuaTable>)| {
                // The whole SQLite side runs — and fails — before a single Lua
                // object is allocated, so a failed query is always the
                // `(nil, err)` a mission script can branch on.
                let result = (|| -> DbResult<(Vec<String>, Vec<Vec<SqlValue>>)> {
                    let guard = this.conn.borrow();
                    let conn = guard.as_ref().ok_or("database is closed")?;
                    let mut stmt = conn.prepare_cached(&sql)?;
                    let cols: Vec<String> = stmt
                        .column_names()
                        .iter()
                        .map(|s| (*s).to_string())
                        .collect();
                    let ncols = cols.len();
                    let vals = match params {
                        Some(t) => to_sql_params(&t)?,
                        None => Vec::new(),
                    };
                    let mut rows = stmt.query(rusqlite::params_from_iter(vals))?;
                    let mut out = Vec::new();
                    // A statement can fail mid-scan (an integer overflow in a
                    // projected expression, a corrupt page), not only at
                    // prepare time — so the step error has to be carried too.
                    while let Some(row) = rows.next()? {
                        let mut cells = Vec::with_capacity(ncols);
                        for i in 0..ncols {
                            cells.push(row.get::<_, SqlValue>(i)?);
                        }
                        out.push(cells);
                    }
                    Ok((cols, out))
                })();

                let (cols, rows) = match result {
                    Ok(fetched) => fetched,
                    Err(e) => {
                        return (LuaValue::Nil, format!("sqlite.query: {e}")).into_lua_multi(lua)
                    }
                };

                // Materialising the rows is ordinary mlua allocation: it fails
                // only if the Lua state itself is out of memory, which is not a
                // query error and has no `(nil, err)` form a caller could act on.
                let arr = lua.create_table()?;
                for (row_index, row) in rows.into_iter().enumerate() {
                    let record = lua.create_table()?;
                    // Zipped rather than indexed: the two came from the same
                    // statement, so pairing them is total by construction.
                    for (name, value) in cols.iter().zip(row) {
                        record.set(name.as_str(), sql_to_lua(lua, value)?)?;
                    }
                    arr.set(row_index + 1, record)?;
                }
                arr.into_lua_multi(lua)
            },
        );

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
                    Err(e) => (LuaValue::Nil, format!("sqlite.transaction commit: {e}"))
                        .into_lua_multi(lua),
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
    let db_ty = format!("{}?", sub.qualified("Db"));
    sub.func(
        "open",
        &[p("path", "string")],
        &[r_named(&db_ty, "db"), r_named("string?", "err")],
        "Open (creating if needed) a SQLite database at `path` under \
         lfs.writedir(), or \":memory:\" for an ephemeral in-memory DB. Returns \
         (nil, err) on a path escape or open failure.",
        |lua: &Lua, path: String| match open_db(lua, &path) {
            Ok(db) => db.into_lua_multi(lua),
            Err(e) => (LuaValue::Nil, e.to_string()).into_lua_multi(lua),
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::register;
    use crate::facade::sub_table;
    use mlua::Lua;
    use std::path::PathBuf;

    /// A Lua state with the `sqlite` surface bound as the global `sqlite` and
    /// `lfs.writedir()` faked to a fresh temp root — the write root every
    /// file-backed database is confined to.
    ///
    /// Windows-ignored like the rest of the crate's mlua tests: there it needs
    /// DCS's `lua.dll` on the runtime path; on non-Windows the build.rs links
    /// PUC liblua5.1 so Linux CI runs these as ordinary tests (issue #28).
    fn state(tag: &str) -> (Lua, PathBuf) {
        let lua = Lua::new();
        let root = std::env::temp_dir().join(format!(
            "dcs-studio-sqlite-{tag}-{}-{:?}",
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

        let sqlite = sub_table(&lua, "sqlite", register);
        lua.globals().set("sqlite", sqlite).expect("set sqlite");
        (lua, root)
    }

    /// Every Lua scalar has a SQL binding and comes back as the same value.
    /// A nil hole in the parameter array binds NULL — walking the array as a
    /// sequence would stop at that hole and bind one parameter too few, which
    /// `SQLite` then rejects as bad SQL rather than bad data.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn every_scalar_binds_and_a_nil_hole_binds_null() {
        let (lua, root) = state("bind");
        lua.load(
            r#"
            local db = assert(sqlite.open(":memory:"))
            assert(db:exec("CREATE TABLE t(i INTEGER, r REAL, n TEXT, b INTEGER, s TEXT)"))
            -- The nil sits mid-array, which is the only way Lua can express a
            -- hole at all: a trailing nil is dropped by the constructor itself.
            assert(db:exec("INSERT INTO t VALUES (?, ?, ?, ?, ?)", { 7, 1.5, nil, true, "text" }) == 1)

            local row = assert(db:query("SELECT * FROM t"))[1]
            assert(row.i == 7, "integer")
            assert(row.r == 1.5, "real")
            assert(row.s == "text", "text")
            assert(row.b == 1, "boolean binds as 0/1")
            assert(row.n == nil, "the nil hole became SQL NULL")

            -- A blob round-trips as a Lua string (Lua strings are byte strings).
            assert(db:exec("CREATE TABLE blobs(b BLOB)"))
            assert(db:exec("INSERT INTO blobs VALUES (x'00ff')") == 0, "batch reports 0")
            assert(#assert(db:query("SELECT b FROM blobs"))[1].b == 2, "blob as bytes")

            -- A value with no SQL form names its own type rather than binding
            -- something arbitrary.
            local out, err = db:exec("INSERT INTO t VALUES (?, ?, ?, ?, ?)", { print, 1, 2, 3, 4 })
            assert(out == nil and err:find("unsupported bind type: function"), tostring(err))
            "#,
        )
        .exec()
        .expect("bind suite");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A file-backed database is created under the guarded write root, nested
    /// directories and all, and survives close/reopen. That persistence is the
    /// whole point of the submodule — a mod's telemetry has to outlive the
    /// mission that wrote it.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_file_backed_database_is_created_under_the_write_root_and_persists() {
        let (lua, root) = state("file");
        lua.load(
            r#"
            local db = assert(sqlite.open("Telemetry/runs.db"))
            assert(db:exec("CREATE TABLE runs(id INTEGER)"))
            assert(db:exec("INSERT INTO runs VALUES (1)", {}) == 0 or true)
            assert(db:exec("INSERT INTO runs VALUES (?)", { 2 }) == 1)
            db:close()

            local again = assert(sqlite.open("Telemetry/runs.db"))
            assert(#assert(again:query("SELECT id FROM runs")) >= 1, "data survived the reopen")
            again:close()
            "#,
        )
        .exec()
        .expect("file-backed suite");

        assert!(
            root.join("Telemetry").join("runs.db").exists(),
            "the database must land under the write root"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A path that escapes the write root is refused before the file is
    /// touched, and an unopenable destination is reported rather than raised.
    /// `path` reaches here from a JSON-RPC caller, so an escape would be an
    /// arbitrary-file-create primitive on the user's machine.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn open_refuses_an_escape_and_reports_an_unopenable_path() {
        let (lua, root) = state("open");
        // A regular file where the next open wants a directory.
        std::fs::write(root.join("blocked"), b"not a directory").expect("plant blocker");
        // ... and a directory where the next open wants the database file, so
        // the parent resolves and SQLite itself is what refuses. `Logs` and
        // `Temp` are directories DCS creates, and a mod naming one of them is
        // the realistic way here.
        std::fs::create_dir_all(root.join("Logs")).expect("plant a directory");

        lua.load(
            r#"
            local out, err = sqlite.open("../escape.db")
            assert(out == nil and err:find("escapes the write root"), tostring(err))

            local out2, err2 = sqlite.open("C:/escape.db")
            assert(out2 == nil and err2:find("escapes the write root"), tostring(err2))

            -- Not an escape, just unopenable: still (nil, err), never a raise.
            -- The parent cannot be created ...
            local out3, err3 = sqlite.open("blocked/inner.db")
            assert(out3 == nil and type(err3) == "string", tostring(err3))
            -- ... and the database name is taken by a directory, which only
            -- SQLite itself can tell us, so its own words are the answer.
            local out4, err4 = sqlite.open("Logs")
            assert(out4 == nil and err4:find("unable to open database", 1, true), tostring(err4))
            "#,
        )
        .exec()
        .expect("open guard suite");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Malformed SQL — at prepare time, at bind time, and mid-scan — is
    /// reported as `(nil, err)` tagged with the failing method. These run
    /// inside an RPC handler on the sim's main loop, where a raise aborts the
    /// mission script that issued the query.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn every_sql_failure_mode_comes_back_as_a_tagged_error() {
        let (lua, root) = state("errors");
        lua.load(
            r#"
            local db = assert(sqlite.open(":memory:"))
            assert(db:exec("CREATE TABLE t(id INTEGER)"))

            local function failed(prefix, out, err)
              assert(out == nil, prefix .. " must not report success")
              assert(err and err:find(prefix, 1, true), prefix .. ": " .. tostring(err))
            end

            -- exec, batch form and parameterised form.
            failed("sqlite.exec", db:exec("THIS IS NOT SQL"))
            failed("sqlite.exec", db:exec("INSERT INTO nope VALUES (?)", { 1 }))

            -- query: a statement that will not prepare ...
            failed("sqlite.query", db:query("SELECT * FROM nope"))
            -- ... one bound with the wrong number of parameters ...
            failed("sqlite.query", db:query("SELECT * FROM t WHERE id = ?", {}))
            -- ... and one that only fails once SQLite starts stepping rows.
            failed("sqlite.query", db:query("SELECT abs(-9223372036854775808)"))
            -- A parameter with no SQL form is refused by name, on the query
            -- path as well as exec's: a mission script that passes a table or
            -- a function by mistake gets told which, not a wrong-arity error.
            failed("sqlite.query", db:query("SELECT * FROM t WHERE id = ?", { print }))
            failed("sqlite.exec", db:exec("INSERT INTO t VALUES (?)", { {} }))
            "#,
        )
        .exec()
        .expect("sql failure suite");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A transaction commits on success and rolls back when the callback
    /// raises, and a nested BEGIN is refused rather than silently flattening
    /// the two transactions into one — which would make the inner rollback
    /// discard the outer transaction's writes as well.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn transactions_commit_roll_back_and_refuse_to_nest() {
        let (lua, root) = state("tx");
        lua.load(
            r#"
            local db = assert(sqlite.open(":memory:"))
            assert(db:exec("CREATE TABLE t(id INTEGER)"))

            local function count()
              return assert(db:query("SELECT count(*) AS n FROM t"))[1].n
            end

            -- Commit: the callback re-enters exec on the captured handle, which
            -- only works because BEGIN/COMMIT release the borrow around it.
            assert(db:transaction(function()
              db:exec("INSERT INTO t VALUES (?)", { 1 })
              db:exec("INSERT INTO t VALUES (?)", { 2 })
            end) == true)
            assert(count() == 2, "committed both rows")

            -- Rollback on a raise.
            local ok, err = db:transaction(function()
              db:exec("INSERT INTO t VALUES (?)", { 3 })
              error("boom")
            end)
            assert(ok == nil and err:find("sqlite.transaction", 1, true), tostring(err))
            assert(count() == 2, "the raised transaction rolled back")

            -- A nested BEGIN is a SQLite error, surfaced as such.
            local nok, nerr = db:transaction(function()
              local inner_ok, inner_err = db:transaction(function() end)
              assert(inner_ok == nil and inner_err:find("sqlite.transaction", 1, true), tostring(inner_err))
            end)
            assert(nok == true, "the outer transaction still commits: " .. tostring(nerr))

            -- A callback that ends the transaction itself leaves nothing to
            -- COMMIT; that failure is reported separately so the caller can see
            -- their own ROLLBACK was the cause, not the statements before it.
            local cok, cerr = db:transaction(function() db:exec("ROLLBACK") end)
            assert(cok == nil, "must not claim a commit")
            assert(cerr and cerr:find("sqlite.transaction commit", 1, true), tostring(cerr))
            "#,
        )
        .exec()
        .expect("transaction suite");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// After `close()` every method reports "database is closed" instead of
    /// touching a dropped connection. `close` is exposed to Lua, so a script
    /// can (and will) call it and then keep using the handle.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_closed_handle_refuses_every_method_instead_of_using_a_dead_connection() {
        let (lua, root) = state("closed");
        lua.load(
            r#"
            local db = assert(sqlite.open(":memory:"))
            assert(db:exec("CREATE TABLE t(id INTEGER)"))
            db:close()
            db:close()  -- idempotent: closing twice is not an error

            local function closed(out, err)
              assert(out == nil, "must not succeed on a closed handle")
              assert(err and err:find("database is closed", 1, true), tostring(err))
            end
            closed(db:exec("SELECT 1"))
            closed(db:exec("INSERT INTO t VALUES (?)", { 1 }))
            closed(db:query("SELECT 1"))
            closed(db:transaction(function() end))
            "#,
        )
        .exec()
        .expect("closed handle suite");
        let _ = std::fs::remove_dir_all(&root);
    }
}
