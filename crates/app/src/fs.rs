// Filesystem commands backing the project/file explorer.
// We use custom commands (rather than the fs plugin) so the IDE can open
// arbitrary folders without per-path scope configuration.
use std::path::Path;

#[derive(serde::Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// List the immediate children of `path`, directories first then files,
/// each group sorted case-insensitively by name. Used for lazy tree expansion.
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = std::fs::read_dir(&path)
        .map_err(|e| format!("Failed to read '{}': {}", path, e))?
        .filter_map(|res| res.ok())
        .map(|entry| {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            DirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                is_dir,
            }
        })
        .collect();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Read a UTF-8 text file's contents.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read '{}': {}", path, e))
}

/// Write `contents` to a text file, creating or truncating it.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Failed to write '{}': {}", path, e))
}

/// The final path component (folder/file name), used to label the workspace root.
#[tauri::command]
pub fn basename(path: String) -> String {
    Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or(path)
}

/// Whether a path currently exists on disk. Used to flag stale recent projects.
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
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
    dcs_studio_project::scaffold::init(&template, Path::new(&parent), &name)
        .map(|root| root.to_string_lossy().into_owned())
}
