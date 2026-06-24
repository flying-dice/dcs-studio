//! Live type-sync Tauri commands (issue #50, model `studio::types`): the desktop
//! half of the sync + drift surface — thin wrappers over `studio_services::types`
//! driven over the app's shared DCS link. "Sync types from DCS" writes the
//! running build's authoritative `.d.lua` under the project and signals a
//! re-index; the drift command feeds the status-bar indicator.

use std::path::Path;

use tauri::{AppHandle, Emitter};

use studio_services::types::{self, DriftStatus, SyncResult};

use crate::dcs::DcsState;

/// "Sync types from DCS" — pull the running build's types over the live link and
/// write them under `root`/`types/generated/`, then signal the language layer to
/// re-index so they take effect without a project reopen. Fails closed
/// (start-DCS-first) when the link is down.
#[tauri::command]
pub async fn sync_types(
    state: tauri::State<'_, DcsState>,
    app: AppHandle,
    root: String,
) -> Result<SyncResult, String> {
    let link = state.link();
    types::sync(link.as_ref(), Path::new(&root), || {
        // The reindex signal (model `TypeSync.Reindex`): a freshly written
        // `.d.lua` takes effect without a reopen. The language layer subscribes
        // (issue #40 watcher / `lang.reindex`); the emit is a harmless no-op
        // until it does.
        let _ = app.emit("dcs://types-synced", &root);
    })
    .await
}

/// Drift verdict for the status bar (model `studio::types::TypeSync.Drift`):
/// whether the project's synced types still match the running build. Drift never
/// errors — the `Result` is Tauri's rule for an async command with a borrowed
/// input (`State`); the JS side unwraps `Ok` transparently.
#[tauri::command]
pub async fn type_drift(
    state: tauri::State<'_, DcsState>,
    root: String,
) -> Result<DriftStatus, String> {
    let link = state.link();
    Ok(types::drift(link.as_ref(), Path::new(&root)).await)
}
