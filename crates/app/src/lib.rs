// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod build;
mod dcs;
mod format;
mod fs;
mod inject;
mod install_cmd;
mod lsp;
// Exposed for the host-IPC integration test - exactly one item wide.
pub use lsp::read_frame;
mod mcp;
mod mission;
mod packages_cmd;
mod startup;
mod term;
mod todos_cmd;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logs to stderr (visible in the `tauri dev` terminal) AND to a file on
    // disk so traces survive the session; tune with `DCS_LOG=debug`. Hosted
    // language servers' stderr is folded into these events too, so one file
    // holds the whole picture.
    let log_path = dcs_studio_project::logging::default_log_path();
    dcs_studio_project::logging::init_to_file("info", &log_path);
    tracing::info!(log = %log_path.display(), "dcs-studio app starting");
    // `--open <path>` launches with a project already open (the frontend reads
    // it on boot via `startup_open`). The e2e suite uses it to point the real
    // app at a fixture project on disk.
    let startup_args = startup::StartupArgs::parse(std::env::args());
    tauri::Builder::default()
        // Single instance first (Tauri requires it before other plugins): a
        // second launch focuses the running window instead of starting a rival
        // that would collide on the one DCS link and the MCP loopback (#33).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager as _;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(dcs::DcsState::default())
        .manage(lsp::LspHosts::default())
        .manage(build::BuildState::default())
        .manage(term::TermRegistry::default())
        .manage(startup_args)
        .setup(|app| {
            dcs::start(app.handle().clone());
            // Host the agent MCP surface over loopback, sharing the live DCS
            // link (issue #33) — replaces the dcs-studio-cli sidecar.
            mcp::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // No orphan language servers: Windows has no SIGTERM.
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                use tauri::Manager as _;
                lsp::stop_all(window.app_handle());
                // Same reason: no orphan terminal children outlive the window.
                term::kill_all(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            fs::read_dir,
            fs::read_text_file,
            fs::read_file,
            fs::write_text_file,
            fs::basename,
            fs::path_exists,
            fs::create_project_from_template,
            fs::rename_path,
            fs::duplicate_path,
            fs::create_file,
            fs::create_dir,
            fs::delete_to_trash,
            build::build_project,
            build::toolchain_status,
            build::rust_analyzer_path,
            install_cmd::install_project,
            format::format_source,
            install_cmd::install_status,
            install_cmd::uninstall_project,
            packages_cmd::pack_project,
            packages_cmd::discover_packages,
            packages_cmd::installed_package_list,
            packages_cmd::install_package,
            packages_cmd::uninstall_package,
            packages_cmd::revalidate_packages,
            dcs::dcs_call,
            dcs::dcs_status,
            inject::dcs_detect_installs,
            inject::dcs_injection_status,
            inject::dcs_inject,
            inject::dcs_eject,
            lsp::lua_analyzer_path,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            term::term_spawn,
            term::term_write,
            term::term_resize,
            term::term_kill,
            term::term_replay,
            term::term_list,
            term::term_default_shell,
            todos_cmd::scan_todos,
            todos_cmd::scan_file_todos,
            mission::dcs_detect_mission_scripts,
            mission::dcs_mission_script_status,
            mission::dcs_mission_script_set,
            mission::dcs_mission_script_restore,
            startup::startup_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
