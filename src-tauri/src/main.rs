#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod debug;
mod diagnostics;
mod error;
mod export;
mod hw;
mod jobs;
mod media;
mod os;
mod paths;
mod project;
mod screen_pick;
mod settings;

use std::sync::Arc;

use tauri::{Emitter, Manager, PhysicalPosition};

/* ---------------- in-app E2E harness (TAROTING_AUTOTEST=1) ---------------- */

/// True when this process was launched to run the in-app E2E suite. The
/// environment variable is read exactly the way `debug::debug_info` reads it,
/// and is additionally pinned to a debug build — a shipped Taroting can never
/// take any of the autotest paths below, whatever the environment says.
fn autotest_mode() -> bool {
    cfg!(debug_assertions) && std::env::var("TAROTING_AUTOTEST").is_ok_and(|v| v == "1")
}

/// Autotest only: stamp a synchronous flag on `window` before ANY frontend
/// script runs, so frontend code that must behave differently under test can
/// check it with a property read instead of an IPC round-trip.
///
/// Its one consumer today is the preview audio graph
/// (`src/editor/playback/audio-graph.ts`), which uses it to skip connecting its
/// master bus to `AudioContext.destination` — an E2E run then makes no sound on
/// the developer's speakers. That is lossless for the audio assertions because
/// the harness measures the graph through an AnalyserNode tapped off `master`,
/// a separate fan-out that never went through `destination`.
///
/// Registered ONLY under autotest, so a normal or shipped run never sees this
/// plugin, never runs the script, and never defines the flag. The plugin has no
/// commands and no setup hook, so it needs no ACL/capability entry and its
/// config is never deserialized.
fn autotest_flag_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("taroting-autotest")
        .js_init_script("window.__tarotingAutotest = true;")
        .build()
}

/// **The one part of the autotest concealment that could plausibly affect
/// rendering.** Parking the window outside every monitor can make Chromium's
/// native occlusion tracker classify it as fully occluded, and an occluded
/// window gets its rendering throttled — which is exactly what the geometry and
/// canvas-paint assertions depend on.
///
/// If `timeline-canvas-painted`, the paint-order blocks, or any computed-
/// geometry assertion starts flaking, **flip this to `false` FIRST**. The other
/// two measures (no taskbar/alt-tab entry, not focusable) are independent of it
/// and keep working on their own.
const AUTOTEST_MOVE_OFFSCREEN: bool = true;
const AUTOTEST_OFFSCREEN_X: i32 = -32_000;
const AUTOTEST_OFFSCREEN_Y: i32 = -32_000;

/// Autotest only: keep the E2E window out of the owner's way while they work.
///
/// `hide()` is deliberately NOT used: a hidden window is precisely what Chromium
/// throttles, and several blocks assert real rendered geometry and canvas
/// painting. Everything here leaves the window mapped and painting, and none of
/// it affects the synthesized DOM events the harness dispatches.
///
/// Idempotent — safe to re-apply on a second launch.
fn conceal_autotest_window<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) {
    // no taskbar button AND no alt-tab entry
    let _ = win.set_skip_taskbar(true);
    // cannot take the keyboard by ANY route — stronger than merely not calling
    // set_focus(), which leaves the window one stray click away from stealing it
    let _ = win.set_focusable(false);
    if AUTOTEST_MOVE_OFFSCREEN {
        let _ = win.set_position(PhysicalPosition::new(
            AUTOTEST_OFFSCREEN_X,
            AUTOTEST_OFFSCREEN_Y,
        ));
    }
}

fn main() {
    // Server-side open-path queue. Capture a double-click launch argument
    // (argv[1]) into it before anything else, so the frontend can drain it once
    // the settings are ready. The same queue also receives second-launch paths.
    let open_paths = os::OpenPathQueue::default();
    os::capture_launch_arg(&open_paths);

    // A blocked or missing %LOCALAPPDATA% must NOT abort before a window
    // exists — that is a double-click that does nothing, forever, with no
    // message. Degrade instead: the app launches and only the cache-backed
    // features (thumbnails, waveforms, proxies) report an error when used.
    let cache = match cache::Cache::new() {
        Ok(c) => Some(Arc::new(c)),
        Err(e) => {
            eprintln!("Taroting: derived-file cache disabled ({e})");
            None
        }
    };
    let jobs = Arc::new(jobs::Jobs::default());

    // Wipe leftover quick-view (open-with) scratch projects from a prior run.
    // Runs before the webview starts — no live session can race the wipe, and it
    // only ever touches the app's own tmp-projects dir.
    project::store::cleanup_temp_projects();

    let mut builder = tauri::Builder::default()
        // Single-instance MUST be registered first: a second launch is routed to
        // the running window (focus + push path + emit "open-path" as a wake-up)
        // instead of starting a new process. `argv[0]` is the exe; a file path
        // (if any) is argv[1..]. The emit carries no payload the frontend trusts:
        // it drains the queue via `take_pending_open_paths`, so a launch during
        // the boot window (before the listener attaches) is still delivered.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                if autotest_mode() {
                    // Under the E2E harness a second launch must not yank the
                    // window in front of whatever the owner is doing. Re-assert
                    // the concealment instead; the open-path queue + wake-up
                    // emit below are untouched, so nothing the suite exercises
                    // changes.
                    conceal_autotest_window(&win);
                } else {
                    let _ = win.set_focus();
                    let _ = win.unminimize();
                }
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
        // Autotest only: conceal the window as soon as it exists. Config-defined
        // windows are created before this hook runs, so "main" is always here.
        // A normal run never enters the branch and launches exactly as before.
        .setup(|app| {
            if autotest_mode() {
                if let Some(win) = app.get_webview_window("main") {
                    conceal_autotest_window(&win);
                }
            }
            Ok(())
        })
        .manage(jobs)
        .manage(open_paths)
        .manage(media::playability::Inflight::default())
        .manage(export::LastExportFailure::default())
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
            project::store::refresh_recent_thumb,
            project::store::refresh_recent_thumbs,
            project::store::path_exists,
            project::store::new_project_path,
            project::store::temp_project_path,
            project::store::temp_projects_dir,
            project::store::rename_project,
            project::store::duplicate_project,
            project::store::delete_project,
            settings::get_settings,
            settings::save_settings,
            hw::detect_encoders,
            export::estimate::estimate_export,
            export::start_export,
            export::export_failure_report,
            diagnostics::save_diagnostic_report,
            debug::debug_info,
            debug::debug_write_report,
            os::take_pending_open_paths,
            os::uninstall_app,
            screen_pick::screen_pick_color,
        ]);

    // Autotest only: the `window.__tarotingAutotest` init script. Not registered
    // at all in a normal or shipped run, so it is zero code and zero cost there.
    if autotest_mode() {
        builder = builder.plugin(autotest_flag_plugin());
    }

    if let Some(cache) = cache {
        builder = builder.manage(cache);
    }

    builder
        .run(tauri::generate_context!())
        .expect("failed to run Taroting");
}
