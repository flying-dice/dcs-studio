// Marketplace commands (model/studio/market.pds, issue #10): thin Tauri wrappers
// over studio-services::market. Discovery hits the GitHub REST API (ureq,
// blocking), so it runs on a blocking thread; it authenticates with the
// logged-in user's token Rust-side when signed in. `force` (the panel's Refresh)
// bypasses the fresh-cache shortcut.

use tauri::{AppHandle, Emitter, State};

use studio_services::market::{InstallOutcome, MarketListing, ProductDetail, UninstallOutcome};
use studio_services::progress::InstallProgress;

use crate::cancel::CancelSlot;

/// The install run's cancellation slot (issue #62 phase 2b), a distinct state
/// type from the publish slot so the two operations never share a token.
#[derive(Default)]
pub struct InstallCancel(CancelSlot);

/// Discover dcs-studio mods on GitHub by topic; see `market::discover`.
#[tauri::command]
pub async fn market_discover(force: bool) -> Result<Vec<MarketListing>, String> {
    tauri::async_runtime::spawn_blocking(move || studio_services::market::discover(force))
        .await
        .map_err(|e| format!("discovery task failed: {e}"))?
}

/// Load one mod's product page (README + install plan + size); see
/// `market::load_product`.
#[tauri::command]
pub async fn market_product(owner: String, name: String) -> Result<ProductDetail, String> {
    tauri::async_runtime::spawn_blocking(move || studio_services::market::load_product(&owner, &name))
        .await
        .map_err(|e| format!("product task failed: {e}"))?
}

/// Install a mod and its transitive Marketplace dependencies: resolve the
/// `[[dependencies]]` graph, then download + link each into the DCS roots.
#[tauri::command]
pub async fn market_install(owner: String, name: String) -> Result<InstallOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || studio_services::market::install(&owner, &name))
        .await
        .map_err(|e| format!("install task failed: {e}"))?
}

/// Install a mod with per-node progress and cancellation (issue #62 phase 2b).
/// Each plan node emits a `download` then a `link` `install://progress` event
/// ("installing k of N"); `market_install_cancel` flips the armed token so a
/// mid-install cancel aborts promptly and rolls back every link + content store
/// placed this pass, recording nothing (model `CancellingAnInstallLeavesNothing`).
/// The bare `market_install` stays for callers that want neither.
#[tauri::command]
pub async fn market_install_with_progress(
    app: AppHandle,
    cancel: State<'_, InstallCancel>,
    owner: String,
    name: String,
) -> Result<InstallOutcome, String> {
    let token = cancel.0.arm();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let on = move |progress: InstallProgress| {
            let _ = app.emit("install://progress", progress);
        };
        studio_services::market::install_with_progress(&owner, &name, &on, &token)
    })
    .await;
    cancel.0.disarm();
    result.map_err(|e| format!("install task failed: {e}"))?
}

/// Cancel an in-progress install (issue #62 phase 2b): flip the armed token so
/// the worker aborts at its next checkpoint and rolls back this pass. A no-op
/// when no install is running.
#[tauri::command]
pub fn market_install_cancel(cancel: State<'_, InstallCancel>) {
    cancel.0.cancel();
}

/// Uninstall a mod by id (`owner/name`): remove its links + content store, and
/// garbage-collect any dependency orphaned by its removal.
#[tauri::command]
pub async fn market_uninstall(id: String) -> Result<UninstallOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || studio_services::market::uninstall(&id))
        .await
        .map_err(|e| format!("uninstall task failed: {e}"))?
}

/// The ids (`owner/name`) of installed mods (drives Install/Installed state).
#[tauri::command]
pub async fn market_installed() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(studio_services::market::installed_ids)
        .await
        .map_err(|e| format!("installed-list task failed: {e}"))
}
