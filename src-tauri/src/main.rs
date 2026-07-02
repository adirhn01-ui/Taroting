#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod error;
mod jobs;
mod media;
mod paths;
mod project;
mod settings;

use std::sync::Arc;

fn main() {
    let cache = Arc::new(cache::Cache::new().expect("failed to initialize cache directory"));
    let jobs = Arc::new(jobs::Jobs::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(cache)
        .manage(jobs)
        .manage(media::playability::Inflight::default())
        .invoke_handler(tauri::generate_handler![
            media::probe::probe_media,
            media::playability::plan_playback,
            media::waveform::ensure_waveform,
            media::thumbs::get_thumbnail,
            media::thumbs::ensure_filmstrip,
            jobs::cancel_job,
            cache::cache_stats,
            cache::clear_cache,
            cache::enforce_cache_limit,
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
