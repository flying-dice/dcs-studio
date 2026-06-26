// Publish commands (model/studio/publish.pds, issue #12): thin Tauri wrappers
// over studio-services::publish. Sharing + releasing hit the GitHub REST API and
// shell out to git (both blocking), so they run on a blocking thread. The
// scope-escalation re-auth itself is `github::github_authorize_publish`.

use tauri::{AppHandle, Emitter, State};

use studio_services::progress::PublishProgress;
use studio_services::publish::{ReleaseInfo, RepoInfo};

use crate::cancel::CancelSlot;

/// The publish run's cancellation slot (issue #62 phase 2b), a distinct state
/// type from the install slot so the two operations never share a token.
#[derive(Default)]
pub struct PublishCancel(CancelSlot);

/// Whether the cached token already carries the publishing scope (`public_repo`).
/// The UI escalates when this is false; see `github::github_authorize_publish`.
#[tauri::command]
pub async fn publish_can() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(studio_services::github::can_publish)
        .await
        .map_err(|e| format!("scope check task failed: {e}"))
}

/// Share the project at `root` to GitHub (create repo, tag `dcs-studio`, push).
/// `asLibrary` additionally tags the repo `dcs-studio-library` (issue #48) — a
/// dependency-only library, not installable into DCS.
#[tauri::command]
pub async fn publish_share(root: String, as_library: bool) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || studio_services::publish::share(&root, as_library))
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

/// Publish a release with step-by-step progress and cancellation (issue #62
/// phase 2b). Each pipeline step (package → split → draft → upload → publish) is
/// emitted as a `publish://progress` event; `publish_release_cancel` flips the
/// armed token so a mid-upload cancel aborts promptly and rolls the draft back to
/// nothing (model `CancellingAPublishLeavesNothing`). The bare `publish_release`
/// stays for callers that want neither.
#[tauri::command]
pub async fn publish_release_with_progress(
    app: AppHandle,
    cancel: State<'_, PublishCancel>,
    root: String,
    tag: String,
) -> Result<ReleaseInfo, String> {
    let token = cancel.0.arm();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let on = move |progress: PublishProgress| {
            let _ = app.emit("publish://progress", progress);
        };
        studio_services::publish::publish_release_with_progress(&root, &tag, &on, &token)
    })
    .await;
    cancel.0.disarm();
    result.map_err(|e| format!("release task failed: {e}"))?
}

/// Cancel an in-progress release (issue #62 phase 2b): flip the armed token so
/// the worker aborts at its next checkpoint and rolls back the draft. A no-op
/// when no release is running.
#[tauri::command]
pub fn publish_release_cancel(cancel: State<'_, PublishCancel>) {
    cancel.0.cancel();
}
