// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            fs::read_dir,
            fs::read_text_file,
            fs::write_text_file,
            fs::basename,
            fs::path_exists,
            fs::create_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
