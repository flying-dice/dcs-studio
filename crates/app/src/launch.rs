// Launcher commands: thin Tauri wrappers over studio-services::launcher
// (model/studio/launcher.pds, issue #41). The managed launch backs up + low-specs
// the graphics config, asserts the bridge, and starts DCS.exe; on exit the
// service watcher ejects the bridge and restores the config. The command spawns
// a poll thread that emits `launch://done` once the launched DCS has exited, so
// the UI can clear its running state.

use std::time::Duration;

use tauri::{AppHandle, Emitter};

pub use studio_services::launcher::{LaunchOutcome, LaunchStatus};

/// Managed launch: assert injection, back up + low-spec options.lua, spawn
/// DCS.exe. Returns once DCS is spawned; `launch://done` arrives when it exits.
#[tauri::command]
pub fn dcs_launch(app: AppHandle, write_dir: String) -> Result<LaunchOutcome, String> {
    let outcome = studio_services::launcher::launch(&write_dir)?;
    // Observe the session for the UI; the service's own watcher owns teardown.
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if !studio_services::launcher::launch_status().is_running() {
                let _ = app.emit("launch://done", ());
                return;
            }
        }
    });
    Ok(outcome)
}

/// Whether a launched DCS is still running and the config is still patched.
#[tauri::command]
pub fn dcs_launch_status() -> LaunchStatus {
    studio_services::launcher::launch_status()
}

/// Stop the launched DCS, eject the bridge, and restore the user's options.lua.
#[tauri::command]
pub fn dcs_stop(write_dir: String) -> Result<LaunchStatus, String> {
    studio_services::launcher::stop(&write_dir)
}
