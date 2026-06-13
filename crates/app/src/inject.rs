// Injection manager commands: thin Tauri wrappers over studio-services
// (the logic moved there for the headless MCP server, issue #8 —
// model/studio/inject.pds).

pub use studio_services::inject::{default_write_dir, DcsInstall, InjectionStatus};

/// Scan `%USERPROFILE%\Saved Games` for DCS write dirs (`DCS` or `DCS.*`).
/// `valid` = the dir contains a `Config` subdir (DCS write-dir marker).
/// Returns `DCS` first, then the variants; empty vec when nothing is found.
#[tauri::command]
pub fn dcs_detect_installs() -> Vec<DcsInstall> {
    studio_services::inject::detect_installs()
}

/// Snapshot of what's installed in `write_dir` vs what this build would install.
#[tauri::command]
pub fn dcs_injection_status(write_dir: String) -> InjectionStatus {
    studio_services::inject::injection_status(&write_dir)
}

/// Install (or update) the bridge DLL + hook into `write_dir`.
#[tauri::command]
pub fn dcs_inject(write_dir: String) -> Result<InjectionStatus, String> {
    studio_services::inject::inject(&write_dir)
}

/// Remove the bridge DLL + hook from `write_dir` (missing files are fine).
#[tauri::command]
pub fn dcs_eject(write_dir: String) -> Result<InjectionStatus, String> {
    studio_services::inject::eject(&write_dir)
}
