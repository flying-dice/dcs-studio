// Find-in-files command (model/studio/search.pds FindInFiles): a thin wrapper
// over the shared project kit's project-wide search. Async so a large
// workspace walk never blocks the main thread; only a malformed regex fails —
// returned to the overlay as an inline invalid-pattern hint, never a crash.
use std::path::Path;

use dcs_studio_project::find::{self, SearchError, SearchOutcome, SearchQuery};

/// Project-wide search: every non-ignored file under `root` matched against
/// `query`, in path-then-line order and capped (model `RunSearch` → `Search`).
///
/// # Errors
/// Returns [`SearchError`] when `query` is a malformed regex in regex mode.
#[tauri::command]
pub async fn search_in_files(
    root: String,
    query: SearchQuery,
) -> Result<SearchOutcome, SearchError> {
    find::search(Path::new(&root), &query)
}
