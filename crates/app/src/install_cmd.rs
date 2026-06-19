// Manifest-driven install (model/studio/installer.pds `Installer.InstallProject`,
// issue #6 R1): apply the project's dcs-studio.toml [[install]] rules to this
// machine's named roots. Rule reading, the no-rules guard, and rule-by-rule
// copying live in dcs-studio-project::install; this command resolves the
// roots (model `ResolveRoots`) from the same detection the Injection Manager
// and Mission Scripting manager use.

use std::path::Path;

use dcs_studio_project::{install, InstallReport, InstallStatus, RootMap, UninstallReport};

/// The DCS roots for a project install: the shared resolver (model `ResolveRoots`)
/// with the detected `{GameInstall}` root.
fn resolve_roots() -> Result<RootMap, String> {
    dcs_studio_project::detect::resolve_roots(crate::mission::default_game_install())
}

/// Install the project at `root` per its manifest's `[[install]]` rules.
#[tauri::command]
pub fn install_project(root: String) -> Result<InstallReport, String> {
    // Model order (installer.pds): the no-rules guard comes BEFORE root
    // resolution, so a rule-less project reports "nothing to install"
    // even on a machine with no DCS.
    let manifest = dcs_studio_project::manifest::load(Path::new(&root))?;
    if manifest.install.is_empty() {
        return Err("nothing to install: the manifest declares no [[install]] rules".to_string());
    }
    install::install(Path::new(&root), &resolve_roots()?)
}

/// Check whether the project's deployed files are present and current.
#[tauri::command]
pub fn install_status(root: String) -> Result<InstallStatus, String> {
    install::status(Path::new(&root), &resolve_roots()?)
}

/// Remove every file the project's `[[install]]` rules deployed.
#[tauri::command]
pub fn uninstall_project(root: String) -> Result<UninstallReport, String> {
    install::uninstall(Path::new(&root), &resolve_roots()?)
}
