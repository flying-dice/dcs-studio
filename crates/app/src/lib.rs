#![cfg_attr(test, allow(clippy::indexing_slicing, clippy::panic, clippy::print_stderr, clippy::unwrap_used, clippy::expect_used))] // test code exempt (clippy.toml's allow-*-in-tests misses cfg'd free helpers like throwaway_child)

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod build;
mod dcs;
mod format;
mod fs;
mod github;
mod inject;
mod install_cmd;
mod launch;
mod logs;
mod lsp;
mod market;
mod publish;
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
    // Launch seam: `--open <path>` (the e2e suite) or the `DCS_OPEN` env (the
    // test harness) opens a project on boot without the native folder picker
    // automation can't click. Resolution lives in `StartupArgs::resolve` so the
    // env fallback is unit-tested.
    let startup_args =
        startup::StartupArgs::resolve(std::env::args(), std::env::var("DCS_OPEN").ok());
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
        // Single-flight + cancel guard for the GitHub device-flow poll loop
        // (issue #11): lets the sign-in modal's Cancel/reopen actually stop the
        // fire-and-forget loop so it never persists or emits after cancel.
        .manage(std::sync::Arc::new(github::LoginGen::default()))
        .manage(startup_args)
        .setup(|app| {
            dcs::start(app.handle().clone());
            // Host the agent MCP surface over loopback, sharing the live DCS
            // link (issue #33) — hosted in-process, not a separate sidecar.
            mcp::start(app.handle());
            // Crash recovery (issue #41 AC#5): if a previous session died with
            // DCS still up, restore any options.lua left on the low-spec launch
            // profile from its orphaned backup.
            let recovered = studio_services::launcher::recover_orphaned();
            if !recovered.is_empty() {
                tracing::info!(?recovered, "restored launch-clobbered options.lua on startup");
            }
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
            mcp::mcp_status,
            inject::dcs_detect_installs,
            inject::dcs_injection_status,
            inject::dcs_inject,
            inject::dcs_eject,
            logs::dcs_log_tail,
            launch::dcs_launch,
            launch::dcs_launch_status,
            launch::dcs_stop,
            github::github_login_start,
            github::github_login_cancel,
            github::github_authorize_publish,
            github::github_session,
            github::github_sign_out,
            market::market_discover,
            market::market_product,
            market::market_install,
            market::market_uninstall,
            market::market_installed,
            publish::publish_can,
            publish::publish_share,
            publish::publish_release,
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
        .unwrap_or_else(|e| {
            // A failed boot (missing WebView2, asset/IPC/plugin init) has nowhere
            // to recover to — log it to the on-disk tracing sink instead of
            // unwinding, then exit non-zero.
            tracing::error!(error = %e, "tauri application failed to start");
            std::process::exit(1);
        });
}
