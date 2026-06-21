// Database panel commands (model/studio/database.pds DatabaseBrowser): thin
// wrappers over the studio-services read-only SQLite reader. Async so a
// discovery walk or a per-table COUNT(*) runs off the UI thread. The service
// opens every database read-only and guards every path to stay under the DCS
// write root, so these commands carry no logic of their own.
pub use studio_services::database::{DatabaseFile, DbError, QueryResult, TableInfo};

/// The resolved DCS write root, if detectable — the panel labels what it is
/// browsing, and its empty state deep-links the Recipes SQLite category.
#[tauri::command]
pub async fn db_write_dir() -> Option<String> {
    studio_services::database::write_dir()
}

/// Discover every SQLite file the DLL has written under the write root.
#[tauri::command]
pub async fn db_discover() -> Result<Vec<DatabaseFile>, DbError> {
    studio_services::database::discover()
}

/// List a database's tables with column and row counts (read-only open).
#[tauri::command]
pub async fn db_tables(path: String) -> Result<Vec<TableInfo>, DbError> {
    studio_services::database::tables(&path)
}

/// Run a read-only query against a database, capped at `ROW_CAP` rows.
#[tauri::command]
pub async fn db_query(path: String, sql: String) -> Result<QueryResult, DbError> {
    studio_services::database::query(&path, &sql)
}
