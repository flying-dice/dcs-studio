// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod build;
mod dcs;
mod fs;
mod inject;
mod install_cmd;
mod lsp;
// Exposed for the host-IPC integration test - exactly one item wide.
pub use lsp::read_frame;
mod mission;
mod todos_cmd;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(dcs::DcsState::default())
        .manage(lsp::LspHosts::default())
        .manage(build::BuildState::default())
        .setup(|app| {
            dcs::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // No orphan language servers: Windows has no SIGTERM.
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                use tauri::Manager as _;
                lsp::stop_all(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            fs::read_dir,
            fs::read_text_file,
            fs::write_text_file,
            fs::basename,
            fs::path_exists,
            fs::create_project_from_template,
            build::build_project,
            build::toolchain_status,
            build::rust_analyzer_path,
            install_cmd::install_project,
            install_cmd::install_status,
            install_cmd::uninstall_project,
            dcs::dcs_call,
            dcs::dcs_status,
            inject::dcs_detect_installs,
            inject::dcs_injection_status,
            inject::dcs_inject,
            inject::dcs_eject,
            lsp::lsp_server_path,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            todos_cmd::scan_todos,
            todos_cmd::scan_file_todos,
            mission::dcs_detect_mission_scripts,
            mission::dcs_mission_script_status,
            mission::dcs_mission_script_set,
            mission::dcs_mission_script_restore,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
