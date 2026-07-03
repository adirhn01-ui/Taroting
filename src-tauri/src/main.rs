#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod debug;
mod error;
mod export;
mod hw;
mod jobs;
mod media;
mod os;
mod paths;
mod project;
mod settings;

use std::sync::Arc;

use tauri::{Emitter, Manager};

fn main() {
    // Server-side open-path queue. Capture a double-click launch argument
    // (argv[1]) into it before anything else, so the frontend can drain it once
    // the settings are ready. The same queue also receives second-launch paths.
    let open_paths = os::OpenPathQueue::default();
    os::capture_launch_arg(&open_paths);

    let cache = Arc::new(cache::Cache::new().expect("failed to initialize cache directory"));
    let jobs = Arc::new(jobs::Jobs::default());

    tauri::Builder::default()
        // Single-instance MUST be registered first: a second launch is routed to
        // the running window (focus + push path + emit "open-path" as a wake-up)
        // instead of starting a new process. `argv[0]` is the exe; a file path
        // (if any) is argv[1..]. The emit carries no payload the frontend trusts:
        // it drains the queue via `take_pending_open_paths`, so a launch during
        // the boot window (before the listener attaches) is still delivered.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
                let _ = win.unminimize();
            }
            if let Some(path) = argv
                .iter()
                .skip(1)
                .find(|a| std::path::Path::new(a).is_file())
            {
                app.state::<os::OpenPathQueue>().push_if_file(path);
                let _ = app.emit("open-path", ());
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(cache)
        .manage(jobs)
        .manage(open_paths)
        .manage(media::playability::Inflight::default())
        .invoke_handler(tauri::generate_handler![
            media::probe::probe_media,
            media::playability::plan_playback,
            media::waveform::ensure_waveform,
            media::normalize::normalize_scan,
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
            project::store::rename_project,
            project::store::duplicate_project,
            project::store::delete_project,
            settings::get_settings,
            settings::save_settings,
            hw::detect_encoders,
            export::estimate::estimate_export,
            export::start_export,
            debug::debug_info,
            debug::debug_write_report,
            os::take_pending_open_paths,
            os::uninstall_app,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Taroting");
}
