#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod error;
mod jobs;
mod media;
mod paths;
mod project;
mod settings;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            media::probe::probe_media,
            project::store::list_recents,
            project::store::remove_recent,
            project::store::load_project,
            project::store::save_project,
            project::store::path_exists,
            project::store::new_project_path,
            settings::get_settings,
            settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Taroting");
}
