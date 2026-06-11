// Filesystem commands backing the project/file explorer: thin Tauri wrappers
// over studio-services (the logic moved there for the headless MCP server,
// issue #8 — model/studio/files.pds).

pub use studio_services::fs::DirEntry;

/// List the immediate children of `path`, directories first then files,
/// each group sorted case-insensitively by name. Used for lazy tree expansion.
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    studio_services::fs::read_dir(&path)
}

/// Read a UTF-8 text file's contents.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    studio_services::fs::read_text_file(&path)
}

/// Write `contents` to a text file, creating or truncating it.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    studio_services::fs::write_text_file(&path, &contents)
}

/// The final path component (folder/file name), used to label the workspace root.
#[tauri::command]
pub fn basename(path: String) -> String {
    studio_services::fs::basename(&path)
}

/// Whether a path currently exists on disk. Used to flag stale recent projects.
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    studio_services::fs::path_exists(&path)
}

/// Scaffold `<parent>/<name>` from a named template (`blank`, `lua-script`,
/// `rust-dll`) via the shared project kit (model/studio/cli.pds `Init`,
/// issue #6 R1): refuses an existing root, renders the files in Rust.
/// Returns the new root path.
#[tauri::command]
pub fn create_project_from_template(
    parent: String,
    name: String,
    template: String,
) -> Result<String, String> {
    studio_services::fs::create_project_from_template(&parent, &name, &template)
}
