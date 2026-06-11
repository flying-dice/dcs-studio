// Mission Scripting manager commands: thin Tauri wrappers over
// studio-services (the logic moved there for the headless MCP server,
// issue #8 — model/studio/mission.pds).

pub use studio_services::mission::{default_game_install, MissionScriptFile, MissionScriptStatus};

/// Find candidate MissionScripting.lua files: registry installs first, then
/// fixed-drive probes; deduped by resolved path. Never errors — a machine with
/// no DCS just yields an empty list.
#[tauri::command]
pub fn dcs_detect_mission_scripts() -> Vec<MissionScriptFile> {
    studio_services::mission::detect_mission_scripts()
}

/// Snapshot of a MissionScripting.lua's sanitization state.
#[tauri::command]
pub fn dcs_mission_script_status(path: String) -> MissionScriptStatus {
    studio_services::mission::mission_script_status(&path)
}

/// Set the desired sanitized state for the items named in `items`
/// (`{ "lfs": false }` = desanitize lfs). Other lines are untouched; the first
/// modification snapshots a pristine backup at `<path>.dcsstudio.bak`.
#[tauri::command]
pub fn dcs_mission_script_set(
    path: String,
    items: serde_json::Value,
) -> Result<MissionScriptStatus, String> {
    let desired: std::collections::HashMap<String, bool> =
        serde_json::from_value(items).map_err(|e| format!("Bad items map: {e}"))?;
    studio_services::mission::set_items(&path, &desired)
}

/// Copy the pristine `<path>.dcsstudio.bak` back over the live file.
#[tauri::command]
pub fn dcs_mission_script_restore(path: String) -> Result<MissionScriptStatus, String> {
    studio_services::mission::restore(&path)
}
