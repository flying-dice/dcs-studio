//! Workspace source collection shared by `check`, the MCP `check` tool,
//! and the LSP initialize walk.

use std::fs;
use std::path::Path;

use walkdir::WalkDir;

/// Folders never analysed.
const SKIPPED_DIRS: &[&str] = &[".git", "node_modules", "target", "build"];

/// Every readable `.lua` / `.d.lua` file under `root` as `(path, text)`,
/// paths rendered platform-native. Unreadable files are skipped — one
/// locked file never takes analysis down.
#[must_use]
pub fn collect(root: &Path) -> Vec<(String, String)> {
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            // The root itself always walks — `fmt .` / `check .` must not
            // trip over the literal `.` (or a dot-named root) being given.
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !(entry.file_type().is_dir()
                && (SKIPPED_DIRS.contains(&name.as_ref()) || name.starts_with('.')))
        })
        .filter_map(std::result::Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("lua"))
        })
        .filter_map(|entry| {
            let text = fs::read_to_string(entry.path()).ok()?;
            Some((entry.path().display().to_string(), text))
        })
        .collect()
}
