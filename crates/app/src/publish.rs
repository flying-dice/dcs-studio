// Publish commands (model/studio/publish.pds, issue #12): thin Tauri wrappers
// over studio-services::publish. Sharing + releasing hit the GitHub REST API and
// shell out to git (both blocking), so they run on a blocking thread. The
// scope-escalation re-auth itself is `github::github_authorize_publish`.

use studio_services::publish::{ReleaseInfo, RepoInfo};

/// Whether the cached token already carries the publishing scope (`public_repo`).
/// The UI escalates when this is false; see `github::github_authorize_publish`.
#[tauri::command]
pub async fn publish_can() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(studio_services::github::can_publish)
        .await
        .map_err(|e| format!("scope check task failed: {e}"))
}

/// Share the project at `root` to GitHub (create repo, tag `dcs-studio`, push).
#[tauri::command]
pub async fn publish_share(root: String) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || studio_services::publish::share(&root))
        .await
        .map_err(|e| format!("share task failed: {e}"))?
}

/// Publish a release for the shared project at `root` (uploads `dcs-studio.toml`).
#[tauri::command]
pub async fn publish_release(root: String, tag: String) -> Result<ReleaseInfo, String> {
    tauri::async_runtime::spawn_blocking(move || studio_services::publish::publish_release(&root, &tag))
        .await
        .map_err(|e| format!("release task failed: {e}"))?
}
