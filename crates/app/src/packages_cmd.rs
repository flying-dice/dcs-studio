// Signed-package commands (model/studio/package.pds, issue #37): pack the open
// project, and discover / install / uninstall / revalidate downloaded packages.
// Thin Tauri wrappers over `studio-packages`; the signing server is the
// validation gate, so install/revalidate make a live HTTP call.
//
// Layout under the app-config dir: `packages/incoming/` is the auto-discovery
// watch folder (packed artifacts land here too); `packages/store/` is the
// content store the install symlinks point into.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use dcs_studio_project::RootMap;
use studio_packages::{
    build_package_with, discover, entry_for, install, installed_packages, revalidate_installed,
    uninstall, HttpSigningClient, PackageEntry, PackageInstallReport, StalePackage, StaticIdentity,
};

/// The signing-server base URL — `DCS_SIGNING_URL` or the local mock default.
fn signing_url() -> String {
    std::env::var("DCS_SIGNING_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".to_string())
}

/// The signing token presented to the server (`DCS_SIGNING_TOKEN`).
fn signing_token() -> String {
    std::env::var("DCS_SIGNING_TOKEN").unwrap_or_else(|_| "dev".to_string())
}

/// The identity provider — the signed-in GitHub user (issue #11) backs the
/// packaging identity, so a logged-in author signs and a logged-out one is
/// refused (model `BuildRequiresLogin`). `StaticIdentity` is still the carrier;
/// only its source changed from an env var to the cached GitHub session.
fn identity_provider() -> StaticIdentity {
    match studio_services::github::current_session() {
        Some(session) => StaticIdentity::new(session.login),
        None => StaticIdentity::logged_out(),
    }
}

fn client() -> HttpSigningClient {
    HttpSigningClient::new(signing_url(), signing_token())
}

/// `<base>/<sub>`, created on demand. The base is `DCS_PACKAGES_DIR` when set
/// (a per-run isolation seam the e2e uses), else `<app-config>/packages`.
fn packages_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let base = match std::env::var_os("DCS_PACKAGES_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => app
            .path()
            .app_config_dir()
            .map_err(|e| format!("no app config dir: {e}"))?
            .join("packages"),
    };
    let dir = base.join(sub);
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    Ok(dir)
}

/// The DCS roots for a package install: the shared resolver (`DCS_SAVED_GAMES`
/// override else detection) with the detected `{GameInstall}` root.
fn resolve_roots() -> Result<RootMap, String> {
    dcs_studio_project::detect::resolve_roots(crate::mission::default_game_install())
}

/// Pack the project at `root` into a signed `.dcspkg` in the incoming folder
/// (so it appears in discovery). Returns the artifact path.
#[tauri::command]
pub fn pack_project(app: AppHandle, root: String) -> Result<String, String> {
    let out = packages_dir(&app, "incoming")?;
    let path = build_package_with(
        std::path::Path::new(&root),
        &out,
        &identity_provider(),
        &client(),
    )?;
    Ok(path.to_string_lossy().into_owned())
}

/// Every `.dcspkg` in the auto-discovery watch folder.
#[tauri::command]
pub fn discover_packages(app: AppHandle) -> Result<Vec<PackageEntry>, String> {
    Ok(discover(&packages_dir(&app, "incoming")?))
}

/// Every installed package in the content store.
#[tauri::command]
pub fn installed_package_list(app: AppHandle) -> Result<Vec<PackageEntry>, String> {
    Ok(installed_packages(&packages_dir(&app, "store")?))
}

/// Install a discovered package (hash-check, server-validate, link in).
#[tauri::command]
pub fn install_package(app: AppHandle, artifact: String) -> Result<PackageInstallReport, String> {
    let entry = entry_for(std::path::Path::new(&artifact))?;
    let store = packages_dir(&app, "store")?;
    install(&entry, &resolve_roots()?, &store, &client())
}

/// Uninstall an installed package by id.
#[tauri::command]
pub fn uninstall_package(app: AppHandle, id: String) -> Result<(), String> {
    uninstall(&id, &packages_dir(&app, "store")?)
}

/// Re-validate installed packages; report those whose author is now revoked.
#[tauri::command]
pub fn revalidate_packages(app: AppHandle) -> Result<Vec<StalePackage>, String> {
    revalidate_installed(&packages_dir(&app, "store")?, &client())
}
