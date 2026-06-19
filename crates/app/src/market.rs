// Marketplace commands (model/studio/market.pds, issue #10): thin Tauri wrappers
// over studio-services::market. Discovery hits the GitHub REST API (ureq,
// blocking), so it runs on a blocking thread; it authenticates with the
// logged-in user's token Rust-side when signed in. `force` (the panel's Refresh)
// bypasses the fresh-cache shortcut.

use dcs_studio_project::InstallReport;
use studio_services::market::{MarketListing, ProductDetail};

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

/// Install a mod: download the release payload + link it into the DCS roots.
#[tauri::command]
pub async fn market_install(owner: String, name: String) -> Result<InstallReport, String> {
    tauri::async_runtime::spawn_blocking(move || studio_services::market::install(&owner, &name))
        .await
        .map_err(|e| format!("install task failed: {e}"))?
}

/// Uninstall a mod by id (`owner/name`): remove its links + content store.
#[tauri::command]
pub async fn market_uninstall(id: String) -> Result<(), String> {
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
