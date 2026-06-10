// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod dcs;
mod fs;
mod inject;
mod mission;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(dcs::DcsState::default())
        .setup(|app| {
            dcs::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs::read_dir,
            fs::read_text_file,
            fs::write_text_file,
            fs::basename,
            fs::path_exists,
            fs::create_project,
            dcs::dcs_call,
            dcs::dcs_status,
            inject::dcs_detect_installs,
            inject::dcs_injection_status,
            inject::dcs_inject,
            inject::dcs_eject,
            mission::dcs_detect_mission_scripts,
            mission::dcs_mission_script_status,
            mission::dcs_mission_script_set,
            mission::dcs_mission_script_restore,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
