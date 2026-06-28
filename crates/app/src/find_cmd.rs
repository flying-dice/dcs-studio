//! Project-wide find-in-files command (model `studio::core::Workbench`
//! `SearchWorkspace`, issue #68): a thin wrapper over the shared project kit's
//! find-in-files. Async so a large workspace walk never blocks the main
//! thread; an invalid regex returns the [`FindError`] the overlay shows inline,
//! and ignored / oversized / non-UTF-8 / unreadable files simply contribute no
//! matches.
use std::path::Path;

use dcs_studio_project::find::{self, FindError, FindOptions, FindResult};

/// Search every non-ignored file under `root` for `query` with the given match
/// options (model `FindInFiles` → `SearchWorkspace`).
///
/// # Errors
/// Returns [`FindError`] when regex mode is on and `query` is not a valid
/// regular expression.
#[tauri::command]
pub async fn find_in_files(
    root: String,
    query: String,
    options: FindOptions,
) -> Result<FindResult, FindError> {
    find::find_in_files(Path::new(&root), &query, options)
}
