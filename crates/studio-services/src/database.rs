//! studio::database — read-only SQLite browser (issue #49 Part A, model
//! `model/studio/database.pds`).
//!
//! Opens the SQLite files the in-DCS `dcs_studio.dll` writes under
//! `lfs.writedir()` with `SQLITE_OPEN_READ_ONLY`, so the IDE can browse them
//! while DCS still holds the file (WAL) and when DCS is off — and never
//! mutates them. Three guards are load-bearing (each has a model `feature`
//! and a red test below):
//!
//!   1. **containment** — every path crosses [`within_root`] before any file
//!      is touched: lexical `..`/absolute/drive-escape rejection (reusing the
//!      workspace guard) plus a canonical-prefix check;
//!   2. **read-only** — the connection is opened read-only with no `file:` URI
//!      parsing, so a write statement (or a `?mode=rwc` smuggled in a path)
//!      fails and changes nothing;
//!   3. **row cap** — a result over `cap` rows is truncated and flagged, so a
//!      runaway `SELECT` can't flood the panel.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

/// Max rows a single query returns to the panel (model `ROW_CAP`). A larger
/// result is truncated to this many rows and flagged `capped`.
pub const ROW_CAP: usize = 1000;

/// SQLite file extensions discovery looks for under the write root.
const DB_EXTENSIONS: [&str; 3] = ["sqlite", "sqlite3", "db"];

/// How deep discovery walks below the write root — the DLL's DBs sit a few
/// levels down at most; this bounds a pathological tree.
const MAX_DISCOVERY_DEPTH: usize = 8;

/// One discovered SQLite file under the write root (model `DatabaseFile`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
}

/// One table in an opened database, with its shape (model `TableInfo`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub column_count: u32,
    pub row_count: i64,
}

/// One result row — cells as display strings, aligned to
/// `QueryResult.columns` (model `Row`).
#[derive(Debug, Serialize)]
pub struct Row {
    pub cells: Vec<String>,
}

/// The outcome of a query (model `QueryResult`): headers, rows, the number of
/// rows returned, and whether the result was capped.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Row>,
    pub row_count: usize,
    pub capped: bool,
}

/// A database error surfaced to the panel (model `DbError`): a guard refusal,
/// a failed read-only open, or a SQL/engine error.
#[derive(Debug, Serialize)]
pub struct DbError {
    pub message: String,
}

fn db_err(message: impl Into<String>) -> DbError {
    DbError {
        message: message.into(),
    }
}

fn map_sql(e: rusqlite::Error) -> DbError {
    db_err(e.to_string())
}

// ---- command-facing entry points (resolve the live DCS write root) --------

/// The resolved DCS write root as a string, if one is detectable — backs the
/// `db_write_dir` command and the panel's "where am I looking" label.
#[must_use]
pub fn write_dir() -> Option<String> {
    dcs_studio_project::detect::write_dir().map(|p| p.to_string_lossy().into_owned())
}

/// Discover every SQLite file under the live write root (model
/// `RefreshDatabases` → `DiscoverUnder`).
pub fn discover() -> Result<Vec<DatabaseFile>, DbError> {
    discover_under(&resolve_write_dir()?)
}

/// List the tables of a database under the live write root (model
/// `OpenDatabase`).
pub fn tables(path: &str) -> Result<Vec<TableInfo>, DbError> {
    tables_under(&resolve_write_dir()?, path)
}

/// Run a read-only query against a database under the live write root,
/// capped at [`ROW_CAP`] rows (model `RunQuery`).
pub fn query(path: &str, sql: &str) -> Result<QueryResult, DbError> {
    query_under(&resolve_write_dir()?, path, sql, ROW_CAP)
}

fn resolve_write_dir() -> Result<PathBuf, DbError> {
    dcs_studio_project::detect::write_dir().ok_or_else(|| {
        db_err(
            "no DCS Saved Games write dir found — run DCS once so it creates \
             Saved Games\\DCS, then try again",
        )
    })
}

// ---- guards + adapters (model black boxes) --------------------------------

/// Whether `path` stays under `root`: lexical containment (rejects `..`,
/// absolute escapes, and drive changes — reuses [`crate::fs::stays_under_root`])
/// plus a canonical-prefix check when both resolve on disk (collapses
/// symlinks). Never looser than the lexical guard. (model `StaysUnderWriteRoot`)
fn within_root(root: &Path, path: &str) -> bool {
    let root_str = root.to_string_lossy();
    if !crate::fs::stays_under_root(&root_str, path) {
        return false;
    }
    match (std::fs::canonicalize(root), std::fs::canonicalize(path)) {
        (Ok(real_root), Ok(real_path)) => real_path.starts_with(&real_root),
        // The path doesn't resolve yet (e.g. a missing file): it already cleared
        // the lexical guard — let the read-only open report it.
        (Ok(_), Err(_)) => true,
        // The root itself won't canonicalise: refuse rather than trust the
        // lexical guard alone (a vanished write root means no databases anyway).
        (Err(_), _) => false,
    }
}

fn escape_error(path: &str) -> DbError {
    db_err(format!("path escapes the DCS write root: {path}"))
}

/// Open the database read-only. No `file:` URI parsing, so a path cannot
/// smuggle `?mode=rwc` to escalate past the read-only flag. (model `OpenReadOnly`)
fn open_read_only(path: &str) -> Result<Connection, DbError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| db_err(format!("cannot open database read-only: {e}")))?;
    // Don't hang the UI if DCS holds the write lock — surface BUSY promptly.
    let _ = conn.busy_timeout(Duration::from_millis(3000));
    // Defence in depth on top of the read-only open flag: `query_only` rejects
    // every write opcode — including a write through an `ATTACH`ed database —
    // regardless of how the connection was opened, so the read-only guarantee
    // never rests on the open flag alone.
    let _ = conn.pragma_update(None, "query_only", true);
    Ok(conn)
}

fn discover_under(root: &Path) -> Result<Vec<DatabaseFile>, DbError> {
    if !root.is_dir() {
        return Err(db_err(format!(
            "write root is not a directory: {}",
            root.display()
        )));
    }
    let mut found = Vec::new();
    walk(root, 0, &mut found);
    found.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    Ok(found)
}

/// Best-effort recursive walk — an unreadable directory or entry is skipped,
/// never fatal (the panel must always render). Symlinks are not followed, so
/// the walk can't be lured outside the root.
fn walk(dir: &Path, depth: usize, out: &mut Vec<DatabaseFile>) {
    if depth > MAX_DISCOVERY_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            walk(&path, depth + 1, out);
        } else if file_type.is_file() && has_db_extension(&path) {
            if let Some(file) = describe(&path) {
                out.push(file);
            }
        }
    }
}

fn has_db_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| DB_EXTENSIONS.iter().any(|known| ext.eq_ignore_ascii_case(known)))
}

fn describe(path: &Path) -> Option<DatabaseFile> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let size_bytes = std::fs::metadata(path).ok()?.len();
    Some(DatabaseFile {
        path: path.to_string_lossy().into_owned(),
        name,
        size_bytes,
    })
}

fn tables_under(root: &Path, path: &str) -> Result<Vec<TableInfo>, DbError> {
    if !within_root(root, path) {
        return Err(escape_error(path));
    }
    let conn = open_read_only(path)?;
    read_tables(&conn)
}

fn query_under(root: &Path, path: &str, sql: &str, cap: usize) -> Result<QueryResult, DbError> {
    if !within_root(root, path) {
        return Err(escape_error(path));
    }
    let conn = open_read_only(path)?;
    run_query(&conn, sql, cap)
}

/// Read the user table list with column and row counts (model `ReadTables`).
/// `sqlite_*` internal tables are hidden.
fn read_tables(conn: &Connection) -> Result<Vec<TableInfo>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY name",
        )
        .map_err(map_sql)?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(map_sql)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(map_sql)?;

    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let table = quote_ident(&name);
        let column_count = conn
            .prepare(&format!("SELECT * FROM {table} LIMIT 0"))
            .map_err(map_sql)?
            .column_count() as u32;
        let row_count = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .map_err(map_sql)?;
        out.push(TableInfo {
            name,
            column_count,
            row_count,
        });
    }
    Ok(out)
}

/// Execute `sql` on the read-only connection and collect up to `cap` rows.
/// Stops one past the cap to flag truncation without materialising the rest —
/// the realisation of the model's row-cap arm. Only the first statement of
/// `sql` is compiled (SQLite's prepare contract): a trailing statement after a
/// `;` is ignored, and a write can't land regardless — the connection is
/// read-only + `query_only`. A write or malformed first statement surfaces
/// here as an `Err` (model `RunReadOnlySql`).
fn run_query(conn: &Connection, sql: &str, cap: usize) -> Result<QueryResult, DbError> {
    let mut stmt = conn.prepare(sql).map_err(map_sql)?;
    let column_count = stmt.column_count();
    let columns = stmt
        .column_names()
        .into_iter()
        .map(ToString::to_string)
        .collect();

    let mut cursor = stmt.query([]).map_err(map_sql)?;
    let mut rows: Vec<Row> = Vec::new();
    let mut capped = false;
    while let Some(row) = cursor.next().map_err(map_sql)? {
        if rows.len() == cap {
            capped = true;
            break;
        }
        let mut cells = Vec::with_capacity(column_count);
        for i in 0..column_count {
            cells.push(cell_to_string(row.get_ref(i).map_err(map_sql)?));
        }
        rows.push(Row { cells });
    }

    let row_count = rows.len();
    Ok(QueryResult {
        columns,
        rows,
        row_count,
        capped,
    })
}

/// Render a cell for the grid: nulls become empty strings and blobs are
/// elided to a size summary, so no binary crosses the IPC boundary.
fn cell_to_string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(b) => format!("<blob {} bytes>", b.len()),
    }
}

/// Double-quote a SQL identifier, escaping embedded quotes — table names come
/// from `sqlite_master`, but they are still quoted defensively.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::{discover_under, query_under, tables_under, ROW_CAP};
    use rusqlite::Connection;
    use std::path::{Path, PathBuf};

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "studio-services-db-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp root");
        dir
    }

    fn seed(path: &Path, sql: &str) {
        let conn = Connection::open(path).expect("open rw to seed");
        conn.execute_batch(sql).expect("seed sql");
    }

    #[test]
    fn lists_tables_with_column_and_row_counts() {
        let root = temp_root("tables");
        let db = root.join("game.sqlite");
        seed(
            &db,
            "CREATE TABLE events (id INTEGER, name TEXT, t REAL);
             INSERT INTO events VALUES (1,'a',0.1),(2,'b',0.2);
             CREATE TABLE units (id INTEGER);
             INSERT INTO units VALUES (7);",
        );

        let tables = tables_under(&root, &db.to_string_lossy()).expect("tables");
        let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["events", "units"], "sorted, sqlite_* hidden");
        assert_eq!(tables[0].column_count, 3);
        assert_eq!(tables[0].row_count, 2);
        assert_eq!(tables[1].column_count, 1);
        assert_eq!(tables[1].row_count, 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn query_returns_columns_and_rows() {
        let root = temp_root("query");
        let db = root.join("game.db");
        seed(
            &db,
            "CREATE TABLE t (id INTEGER, name TEXT);
             INSERT INTO t VALUES (1,'alice'),(2,'bob');",
        );

        let result =
            query_under(&root, &db.to_string_lossy(), "SELECT id, name FROM t ORDER BY id", 100)
                .expect("query");
        assert_eq!(result.columns, ["id", "name"]);
        assert_eq!(result.row_count, 2);
        assert!(!result.capped);
        // Oracle: rows match exactly what was written.
        assert_eq!(result.rows[0].cells, ["1", "alice"]);
        assert_eq!(result.rows[1].cells, ["2", "bob"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn null_is_empty_and_blob_is_elided() {
        let root = temp_root("cells");
        let db = root.join("game.db");
        seed(
            &db,
            "CREATE TABLE t (a, b);
             INSERT INTO t VALUES (NULL, x'00010203');",
        );

        let result =
            query_under(&root, &db.to_string_lossy(), "SELECT a, b FROM t", 100).expect("query");
        assert_eq!(result.rows[0].cells[0], "");
        assert_eq!(result.rows[0].cells[1], "<blob 4 bytes>");

        let _ = std::fs::remove_dir_all(&root);
    }

    // --- mutation audit: each guard is its own red test ---

    #[test]
    fn rows_are_capped() {
        let root = temp_root("cap");
        let db = root.join("game.db");
        seed(
            &db,
            "CREATE TABLE t (id INTEGER);
             INSERT INTO t VALUES (1),(2),(3),(4),(5);",
        );

        let result =
            query_under(&root, &db.to_string_lossy(), "SELECT id FROM t ORDER BY id", 2)
                .expect("query");
        assert_eq!(result.row_count, 2, "truncated to the cap");
        assert!(result.capped, "flagged when more rows exist");
        assert_eq!(result.rows.len(), 2);

        // A result exactly at the cap is NOT flagged.
        let exact = query_under(&root, &db.to_string_lossy(), "SELECT id FROM t ORDER BY id", 5)
            .expect("query");
        assert_eq!(exact.row_count, 5);
        assert!(!exact.capped);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_statements_fail_and_change_nothing() {
        let root = temp_root("readonly");
        let db = root.join("game.db");
        seed(
            &db,
            "CREATE TABLE t (id INTEGER);
             INSERT INTO t VALUES (1);",
        );
        let db_path = db.to_string_lossy().into_owned();

        for write in [
            "INSERT INTO t VALUES (2)",
            "UPDATE t SET id = 9 WHERE id = 1",
            "DELETE FROM t",
            "CREATE TABLE u (x INTEGER)",
            "DROP TABLE t",
        ] {
            assert!(
                query_under(&root, &db_path, write, 100).is_err(),
                "read-only connection must reject: {write}"
            );
        }

        // Oracle: re-read shows the seeded row untouched.
        let after = query_under(&root, &db_path, "SELECT COUNT(*) FROM t", 100).expect("count");
        assert_eq!(after.rows[0].cells[0], "1");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_trailing_write_after_a_select_cannot_mutate() {
        let root = temp_root("multistmt");
        let db = root.join("game.db");
        seed(&db, "CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);");
        let db_path = db.to_string_lossy().into_owned();

        // SQLite compiles only the first statement; the trailing DROP is never
        // seen, and could not run anyway (read-only + query_only).
        let result = query_under(&root, &db_path, "SELECT id FROM t; DROP TABLE t", 100)
            .expect("the leading SELECT runs");
        assert_eq!(result.rows[0].cells[0], "1");

        // Oracle: the table and its row are untouched.
        let after = query_under(&root, &db_path, "SELECT COUNT(*) FROM t", 100).expect("count");
        assert_eq!(after.rows[0].cells[0], "1");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn paths_escaping_the_write_root_are_refused() {
        let root = temp_root("escape");
        let db_path = root.join("real.db").to_string_lossy().into_owned();
        seed(Path::new(&db_path), "CREATE TABLE t (id INTEGER);");

        // `..` traversal out of the root.
        let climb = format!("{}/../escape.db", root.to_string_lossy());
        assert!(tables_under(&root, &climb).is_err(), "rejects .. climb");
        assert!(
            query_under(&root, &climb, "SELECT 1", 100).is_err(),
            "rejects .. climb on query"
        );

        // An absolute path to a different root.
        assert!(
            tables_under(&root, "/etc/hosts").is_err(),
            "rejects absolute escape"
        );

        // The legitimate in-root path still works (guard is not over-tight).
        assert!(tables_under(&root, &db_path).is_ok());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_file_is_an_error_not_a_panic() {
        let root = temp_root("missing");
        let gone = root.join("nope.sqlite").to_string_lossy().into_owned();
        assert!(tables_under(&root, &gone).is_err());
        assert!(query_under(&root, &gone, "SELECT 1", 100).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discovery_lists_only_databases_under_the_root() {
        let root = temp_root("discover");
        std::fs::create_dir_all(root.join("sub")).expect("subdir");
        seed(&root.join("b.db"), "CREATE TABLE t (x);");
        seed(&root.join("sub/a.sqlite"), "CREATE TABLE t (x);");
        std::fs::write(root.join("notes.txt"), "ignored").expect("txt");
        // A database OUTSIDE the root — must never be discovered.
        let outside = root.parent().expect("parent").join("outside.sqlite");
        seed(&outside, "CREATE TABLE t (x);");

        let found = discover_under(&root).expect("discover");
        let names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["a.sqlite", "b.db"], "sorted, under-root only");

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn row_cap_constant_is_bounded() {
        assert_eq!(ROW_CAP, 1000);
    }
}
