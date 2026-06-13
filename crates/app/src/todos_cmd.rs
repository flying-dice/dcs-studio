// Todos panel commands (model/studio/todos.pds TodoScanner): thin wrappers
// over the shared project kit's comment-tag scanner. Async so a large
// workspace walk never blocks the main thread; a scan never fails — skipped
// files just contribute no entries.
use std::path::Path;

use dcs_studio_project::todos::{self, TodoEntry};

/// Full workspace scan: every non-ignored file under `root`, sorted by
/// path then line.
#[tauri::command]
pub async fn scan_todos(root: String, tags: Vec<String>) -> Vec<TodoEntry> {
    todos::scan(Path::new(&root), &tags)
}

/// Per-file rescan (after a save): just that file's entries.
#[tauri::command]
pub async fn scan_file_todos(path: String, tags: Vec<String>) -> Vec<TodoEntry> {
    todos::scan_file(Path::new(&path), &tags)
}
