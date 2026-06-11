// Manifest-driven install (model/studio/installer.pds `Installer.InstallProject`,
// issue #6 R1): apply the project's dcs-studio.toml [[install]] rules to this
// machine's named roots. Rule reading, the no-rules guard, and rule-by-rule
// copying live in dcs-studio-project::install; this command resolves the
// roots (model `ResolveRoots`) from the same detection the Injection Manager
// and Mission Scripting manager use.

use std::path::Path;

use dcs_studio_project::{install, InstallReport, RootMap};

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
    let saved_games = crate::inject::default_write_dir().ok_or_else(|| {
        "No DCS Saved Games write dir found — run DCS once so it creates \
         Saved Games\\DCS, then try again"
            .to_string()
    })?;
    let roots = RootMap {
        saved_games,
        game_install: crate::mission::default_game_install(),
    };
    install::install(Path::new(&root), &roots)
}
