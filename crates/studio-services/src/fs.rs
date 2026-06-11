// Filesystem service backing the project/file explorer and the MCP
// workspace tools (model/studio/files.pds). Custom logic (rather than the
// Tauri fs plugin) so the IDE can open arbitrary folders without per-path
// scope configuration.
use std::path::Path;

#[derive(serde::Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// List the immediate children of `path`, directories first then files,
/// each group sorted case-insensitively by name. Used for lazy tree expansion.
pub fn read_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = std::fs::read_dir(path)
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
pub fn read_text_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("Failed to read '{}': {}", path, e))
}

/// Write `contents` to a text file, creating or truncating it.
pub fn write_text_file(path: &str, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("Failed to write '{}': {}", path, e))
}

/// The final path component (folder/file name), used to label the workspace root.
pub fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Whether a path currently exists on disk. Used to flag stale recent projects.
pub fn path_exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// Scaffold `<parent>/<name>` from a named template (`blank`, `lua-script`,
/// `rust-dll`) via the shared project kit (model/studio/cli.pds `Init`,
/// issue #6 R1): refuses an existing root, renders the files in Rust.
/// Returns the new root path.
pub fn create_project_from_template(
    parent: &str,
    name: &str,
    template: &str,
) -> Result<String, String> {
    dcs_studio_project::scaffold::init(template, Path::new(parent), name)
        .map(|root| root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("studio-services-fs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn read_dir_lists_directories_first_then_files_case_insensitively() {
        let root = temp_dir("read-dir");
        std::fs::create_dir(root.join("zeta")).expect("dir");
        std::fs::create_dir(root.join("Alpha")).expect("dir");
        std::fs::write(root.join("b.lua"), "").expect("file");
        std::fs::write(root.join("A.lua"), "").expect("file");

        let entries = read_dir(&root.to_string_lossy()).expect("listing");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "zeta", "A.lua", "b.lua"]);
        assert!(entries[0].is_dir && entries[1].is_dir);
        assert!(!entries[2].is_dir && !entries[3].is_dir);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_dir_on_a_missing_path_reports_the_path() {
        let Err(err) = read_dir(r"Z:\definitely\not\here") else {
            panic!("a missing path must not list");
        };
        assert!(err.contains("Failed to read"), "err was: {err}");
    }

    #[test]
    fn text_round_trip_and_existence() {
        let root = temp_dir("round-trip");
        let file = root.join("note.txt");
        let path = file.to_string_lossy();
        assert!(!path_exists(&path));
        write_text_file(&path, "hello agent").expect("write");
        assert!(path_exists(&path));
        assert_eq!(read_text_file(&path).expect("read"), "hello agent");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn basename_takes_the_final_component_or_echoes_the_input() {
        assert_eq!(basename(r"C:\projects\My Mod"), "My Mod");
        assert_eq!(basename(""), "");
    }
}
