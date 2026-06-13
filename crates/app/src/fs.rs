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

// ── classify-and-read (model studio::files ReadFile) ────────────────────────

/// How many leading bytes the NUL sniff inspects (model `LooksBinary`).
const SNIFF_BYTES: usize = 8192;

/// Outcome of classifying a file by content (model studio::files FileLoad):
/// valid UTF-8 comes back as `Text`; a NUL byte in the leading `SNIFF_BYTES`,
/// or any non-UTF-8 byte, makes it `Binary`, reported by size only — those
/// bytes never reach the editor.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileLoad {
    Text { text: String },
    Binary { size: u64 },
}

/// Classify already-read bytes (model `LooksBinary`): a NUL byte in the leading
/// `SNIFF_BYTES`, or any non-UTF-8 byte, means binary; otherwise the decoded
/// text. Takes ownership so the UTF-8 decode reuses the buffer (no copy).
fn classify(bytes: Vec<u8>) -> FileLoad {
    let size = bytes.len() as u64;
    if bytes.iter().take(SNIFF_BYTES).any(|&b| b == 0) {
        return FileLoad::Binary { size };
    }
    match String::from_utf8(bytes) {
        Ok(text) => FileLoad::Text { text },
        Err(_) => FileLoad::Binary { size },
    }
}

/// Read a file for the editor, classifying it by CONTENT not extension
/// (model studio::files ReadFile): one read, then `classify`. Replaces the
/// open path's `read_text_file`; `read_text_file` stays for saves and
/// strict-UTF-8 callers.
#[tauri::command]
pub fn read_file(path: String) -> Result<FileLoad, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read '{}': {}", path, e))?;
    Ok(classify(bytes))
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

#[cfg(test)]
mod tests {
    use super::{classify, FileLoad};

    #[test]
    fn nul_byte_in_leading_chunk_is_binary() {
        // A NUL anywhere in the sniff window means binary, size reported.
        match classify(b"\x89PNG\x00\x00data".to_vec()) {
            FileLoad::Binary { size } => assert_eq!(size, 10),
            FileLoad::Text { .. } => panic!("NUL buffer classified as text"),
        }
    }

    #[test]
    fn non_utf8_without_nul_is_binary() {
        // 0xFF 0xFE is not valid UTF-8 and carries no NUL byte.
        match classify(vec![0xFF, 0xFE, 0x41]) {
            FileLoad::Binary { size } => assert_eq!(size, 3),
            FileLoad::Text { .. } => panic!("non-UTF-8 buffer classified as text"),
        }
    }

    #[test]
    fn valid_utf8_is_text_returned_verbatim() {
        let src = "print(\"hello\")\nlocal x = 1\n";
        match classify(src.as_bytes().to_vec()) {
            FileLoad::Text { text } => assert_eq!(text, src),
            FileLoad::Binary { .. } => panic!("UTF-8 source classified as binary"),
        }
    }
}
