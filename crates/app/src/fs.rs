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

/// One file to materialise inside a freshly created project. `path` is relative
/// to the project root and may include nested directories (created on demand).
#[derive(serde::Deserialize)]
pub struct NewFile {
    path: String,
    contents: String,
}

/// A template path must stay under the project root: relative, with plain
/// components only — no absolute paths, no `..` traversal, no drive prefixes.
fn stays_under_root(path: &str) -> bool {
    let p = Path::new(path);
    !p.as_os_str().is_empty()
        && p.components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// Scaffold a new project: create `<parent>/<name>` (erroring if it already
/// exists) and write every templated file beneath it. Returns the absolute path
/// of the new project root so the caller can open it immediately.
#[tauri::command]
pub fn create_project(parent: String, name: String, files: Vec<NewFile>) -> Result<String, String> {
    let root = Path::new(&parent).join(&name);
    if root.exists() {
        return Err(format!("'{}' already exists", root.display()));
    }
    if let Some(file) = files.iter().find(|f| !stays_under_root(&f.path)) {
        return Err(format!(
            "Template path '{}' would escape the project root",
            file.path
        ));
    }
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create '{}': {}", root.display(), e))?;

    for file in &files {
        let target = root.join(&file.path);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create '{}': {}", dir.display(), e))?;
        }
        std::fs::write(&target, &file.contents)
            .map_err(|e| format!("Failed to write '{}': {}", target.display(), e))?;
    }

    Ok(root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::stays_under_root;

    #[test]
    fn plain_relative_paths_are_allowed() {
        assert!(stays_under_root("README.md"));
        assert!(stays_under_root("scripts/init.lua"));
        assert!(stays_under_root("a/b/c.txt"));
    }

    #[test]
    fn escaping_paths_are_rejected() {
        assert!(!stays_under_root(""));
        assert!(!stays_under_root("../outside.txt"));
        assert!(!stays_under_root("a/../../outside.txt"));
        assert!(!stays_under_root("/etc/passwd"));
        assert!(!stays_under_root(r"C:\Windows\system32\evil.dll"));
        assert!(!stays_under_root(r"\\server\share\evil"));
    }
}
