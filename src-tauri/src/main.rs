#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod asset;
mod cache;
mod crash;
mod debug;
mod diagnostics;
mod error;
mod export;
mod hw;
mod image_save;
mod jobs;
mod media;
mod os;
mod paths;
mod project;
mod screen_pick;
mod settings;

use std::sync::Arc;
use std::time::Instant;

use tauri::{Emitter, Manager, PhysicalPosition};

/* ---------------- in-app E2E harness (TAROTING_AUTOTEST=1) ---------------- */

/// True when this process was launched to run the in-app E2E suite (debug build
/// + TAROTING_AUTOTEST=1). Lives in `debug.rs` because `paths.rs` needs it too:
/// under autotest every owner-data location is redirected into a scratch root.
use debug::autotest_mode;

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

/// A launch that carries a file the app opens on its own (media or `.trt`,
/// `os::queued_known_launch`): stamp a flag before any frontend script runs,
/// so the boot (src/core/boot.ts) opens that file first instead of painting
/// Home and then replacing it.
///
/// The script is a CONSTANT. It says only "a known file is queued"; the path
/// itself still reaches the frontend through `take_pending_open_paths`, so no
/// file name or extension is ever spliced into script text. Registered only
/// for such a launch — a plain launch never sees this plugin, runs no script,
/// defines no flag, and boots exactly as before. Same shape as
/// `autotest_flag_plugin`: no commands, no setup hook, so no capability entry.
fn launch_hint_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("taroting-launch-file")
        .js_init_script("window.__tarotingLaunchFile = true;")
        .build()
}

/// Veto every top-level navigation away from the app's own page.
///
/// The CSP keeps scripts and fetches on the app's origins, but it cannot stop
/// the page itself from being navigated somewhere else — `location = "https://…"`
/// would carry anything in the URL off the machine, and a dropped file the
/// webview chose to open would replace the whole session. Neither has any use
/// here: the page never leaves its origin. A reload of the same page (crash.rs
/// after a dead page process, Vite's full reload in dev) stays allowed.
///
/// Tauri consults a plugin's hook only once the webview is registered, so the
/// first load of the page never reaches this. No commands, no setup hook, so
/// no capability entry; the hook costs one string match per navigation.
fn navigation_guard_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("taroting-navigation")
        .on_navigation(|webview, url| {
            let dev = webview.config().build.dev_url.as_ref().filter(|_| cfg!(debug_assertions));
            navigation_allowed(url, dev)
        })
        .build()
}

/// The pure rule behind [`navigation_guard_plugin`]: the app's own origin
/// (`http://tauri.localhost` on Windows, `tauri://localhost` elsewhere, either
/// scheme), `about:blank`, and — in a debug build only — the dev server's
/// origin exactly as `devUrl` names it. Hosts match whole, never by suffix.
fn navigation_allowed(url: &tauri::Url, dev_origin: Option<&tauri::Url>) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    let app_origin = matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("http" | "https", Some("tauri.localhost"), None) | ("tauri", Some("localhost"), None)
    );
    app_origin || dev_origin.is_some_and(|dev| dev.origin() == url.origin())
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

/* ------------------- the display engine failing to start ------------------- */

/// Whether the main window's page really exists. When WebView2 cannot be
/// created, tauri-runtime-wry logs the error and drops the window while
/// `build()` and the config window's creation still report success, so the
/// window is known to the app but not to the runtime — and every getter that
/// has to ask the live window answers `Err`. Nothing else notices: the process
/// shows nothing, never exits, and keeps the single-instance lock, so every
/// later double-click is forwarded into it until it is ended in Task Manager.
fn page_exists<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>) -> bool {
    #[cfg(windows)]
    {
        win.hwnd().is_ok()
    }
    #[cfg(not(windows))]
    {
        win.inner_size().is_ok()
    }
}

const ENGINE_FAILED_TITLE: &str = "Taroting";
const ENGINE_FAILED_TEXT: &str = "Taroting couldn't start its display engine (Microsoft Edge WebView2).\n\nTry opening Taroting again. If this keeps happening, reinstall the Microsoft Edge WebView2 Runtime.";

/// Whether to show our own box. Not under autotest (nothing visible, ever).
/// Not when no runtime was found in a release build either: tauri has already
/// shown its own "Could not find the WebView2 Runtime" box for that (release
/// builds only), and a second box saying the same would be noise.
fn engine_failure_box(runtime_found: bool, debug_build: bool, autotest: bool) -> bool {
    !autotest && (runtime_found || debug_build)
}

/// The page could not be created: leave a note, say so, and END — releasing
/// the single-instance lock, so the next double-click starts afresh instead of
/// vanishing into this process. No retry: a rebuilt window would fail the same
/// way in the same second, and the box tells the user what to do. While the
/// box is up this process still holds the lock, so a launch in that moment is
/// forwarded here and ends — the user is looking at the reason.
fn display_engine_failed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let runtime = tauri::webview_version();
    let found = runtime.is_ok();
    crash::write_startup_failure_note(&match &runtime {
        Ok(version) => format!("WebView2 {version}"),
        Err(e) => format!("not found ({e})"),
    });
    if engine_failure_box(found, cfg!(debug_assertions), autotest_mode()) {
        os::show_error(ENGINE_FAILED_TITLE, ENGINE_FAILED_TEXT);
    }
    // Through the event loop, so RunEvent::Exit still reaches the plugins
    // (single-instance releases its mutex there) and `on_run_event`.
    app.exit(1);
}

/* ------------------------------- the run loop ------------------------------- */

/// The app's run-loop callback. It must never prevent an exit: crash.rs's
/// restart after a dead engine asks the loop to exit and relaunches only once
/// `RunEvent::Exit` has gone by.
fn on_run_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: tauri::RunEvent) {
    flush_cache_on(&event, || app.try_state::<Arc<cache::Cache>>().map(|c| c.inner().clone()));
    // An orderly exit: the next launch must not report this run as one that
    // ended without a word (crash.rs).
    if matches!(event, tauri::RunEvent::Exit) {
        crash::disarm_exit_watch();
    }
}

/// On the way out, write the cache index's coalesced last-use stamps. Managed
/// state is never dropped — `App::run` ends in `process::exit` — so without
/// this every stamp since the last interval flush was lost on every quit. A
/// disabled cache is simply not managed.
///
/// The cache is fetched lazily: this runs for EVERY event-loop event
/// (MainEventsCleared included), and a state lookup takes the StateManager
/// lock, so nothing is looked up unless the event is `Exit`.
fn flush_cache_on(event: &tauri::RunEvent, cache: impl FnOnce() -> Option<Arc<cache::Cache>>) {
    if !matches!(event, tauri::RunEvent::Exit) {
        return;
    }
    if let Some(cache) = cache() {
        cache.flush();
    }
}

fn main() {
    // FIRST: a panic or a native fault from here on leaves a local note that
    // the next launch shows once (crash.rs). One path computed, two callbacks
    // registered; nothing else happens until something breaks.
    crash::install();

    // A second launch hands its file to the running instance and ends here,
    // before it touches the cache or builds anything. A plain first launch
    // pays one `OpenMutexW` that finds nothing (os.rs `forward_to_running`).
    let instance = os::InstanceNames::of(os::APP_IDENTIFIER);
    if os::forward_to_running(&instance, os::launch_payload, os::WINDOW_WAIT, os::SEND_TIMEOUT)
        .ends_launch()
    {
        std::process::exit(0);
    }

    // Server-side open-path queue. Capture a double-click launch argument
    // (the first file on the command line) into it before anything else, so
    // the frontend can drain it once the settings are ready.
    // The same queue also receives second-launch paths.
    let open_paths = os::OpenPathQueue::default();
    // A restart after a dead display engine (crash.rs) carries this session's
    // first command line; its file is not opened again.
    os::capture_launch_arg(&open_paths, os::take_engine_restart_marker());
    // Read now, while the queue is still ours: `.manage()` below moves it.
    let launch_file = os::queued_known_launch(&open_paths);
    // The launch's own file counts as just opened: a second double-click on
    // it while this instance starts must not open it twice.
    let recent_forward = os::RecentForward::seeded(os::first_queued(&open_paths), Instant::now());

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

    let mut builder = tauri::Builder::default()
        // Single-instance MUST be registered first: a second launch is routed to
        // the running window (focus + push path + emit "open-path" as a wake-up)
        // instead of starting a new process. `argv[0]` is the exe; a file path
        // (if any) is argv[1..]. The emit carries no payload the frontend trusts:
        // it drains the queue via `take_pending_open_paths`, so a launch during
        // the boot window (before the listener attaches) is still delivered.
        .plugin(tauri_plugin_single_instance::init(move |app, argv, cwd| {
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
            // Resolved against the SECOND launch's working directory and
            // queued absolute: a relative name is that launch's, not ours.
            if let Some(path) = os::forwarded_file_arg(&argv, &cwd) {
                // The same file again within two seconds is the same
                // double-click replayed (os.rs `RecentForward`): focus, no
                // second open.
                if recent_forward.is_repeat(&path, Instant::now()) {
                    return;
                }
                app.state::<os::OpenPathQueue>().push_if_file(&path);
                let _ = app.emit("open-path", ());
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // Reveal-in-folder is the only opener call the app makes. Its default
        // init also injects a script that hands every clicked link to the
        // system browser; the app has no links, so that is only a way out.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(navigation_guard_plugin())
        .setup(|app| {
            // FIRST, before any side effect: the plugin can make a launch
            // that raced the running instance's startup a second full
            // instance. Hand over instead (os.rs `forward_if_not_primary`;
            // for the primary this is one window lookup).
            let forward = os::forward_if_not_primary(
                &os::InstanceNames::of(os::APP_IDENTIFIER),
                std::process::id(),
                os::launch_payload,
                os::WINDOW_WAIT,
                os::SEND_TIMEOUT,
            );
            if forward.ends_launch() {
                app.cleanup_before_exit();
                std::process::exit(0);
            }

            // Config-defined windows are created before this hook runs, so
            // "main" is always known here — but its page may not exist.
            let Some(win) = app.get_webview_window("main").filter(page_exists) else {
                display_engine_failed(app.handle());
                // An Err here would panic inside tauri; the exit is queued.
                return Ok(());
            };

            // The window is created hidden (`"visible": false` in
            // tauri.conf.json) and shown only here, once this process is known
            // to be the primary instance and its page exists. Created visible,
            // a launch that lost the race above flashed an empty window — or
            // showed it "Not Responding" for up to 20 s while it waited on a
            // busy primary — before handing over. Under autotest the window is
            // concealed BEFORE it is ever shown, so it never appears on screen.
            if autotest_mode() {
                conceal_autotest_window(&win);
            }
            let _ = win.show();
            // And again once shown: the taskbar exclusion is a call on the
            // shell's taskbar list, and nothing promises it survives the
            // ShowWindow that maps the window — re-applied, it holds whatever
            // ShowWindow did. Idempotent, and autotest only.
            if autotest_mode() {
                conceal_autotest_window(&win);
            }

            // Wipe leftover quick-view scratch projects from a prior run. HERE,
            // not at the top of main(): only the primary instance reaches this
            // point (a second launch hands over in main() or just above), and
            // it does so before its event loop serves a single command, so no
            // session of its own can exist yet.
            if autotest_mode() {
                // Each E2E run starts from factory defaults in its own scratch
                // root (paths.rs redirects settings, recents, projects and temp
                // projects there), and leaves nothing in the owner's folders.
                let _ = std::fs::remove_dir_all(debug::autotest_root());
            }
            // From here on, a run that ends without a word is reported by the
            // next launch (crash.rs). After the autotest wipe above, and only
            // in the primary instance: a second launch would find this one's
            // marker and report a crash that is not one.
            crash::arm_exit_watch();
            project::store::cleanup_temp_projects();
            // Half-written cache files a dead run left behind, on a thread of
            // its own. Here for the same reason as the sweep above: in a
            // second launch every partial of the LIVE instance is older than
            // that process, and would look abandoned. A disabled cache is not
            // managed, and then there is nothing to sweep.
            if let Some(cache) = app.try_state::<Arc<cache::Cache>>() {
                cache::sweep_stale_partials_in_background(&cache);
            }
            // Export `.part`s an earlier run claimed and never released (a
            // crash, a kill, an app closed with an export queued), on a thread
            // of its own. Here for the same reason: only the primary instance,
            // and before any export of this run can exist.
            export::claims::sweep_stale_in_background();
            // Reload a page whose process died (with a notice), restart
            // the app if the whole WebView2 engine did (crash.rs).
            crash::watch_webview(&win);
            Ok(())
        })
        .manage(jobs)
        .manage(open_paths)
        .manage(media::playability::Inflight::default())
        .manage(export::LastExportFailure::default())
        .manage(os::CloseWatch::default())
        // This run's page reloads, until the reloaded page asks for them.
        .manage(crash::Notes::default())
        // An empty map until an image save begins: no thread, no timer.
        .manage(Arc::new(image_save::ImageSaves::default()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                os::on_close_requested(window, &window.state::<os::CloseWatch>());
            }
        })
        .invoke_handler(tauri::generate_handler![
            media::probe::probe_media,
            media::playability::plan_playback,
            media::waveform::ensure_waveform,
            media::normalize::normalize_scan,
            media::thumbs::get_thumbnail,
            media::siblings::list_siblings,
            media::siblings::forget_sibling_order,
            media::playability::classify_playback,
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
            project::store::list_orphan_temp_projects,
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
            crash::take_crash_notes,
            debug::debug_info,
            debug::debug_write_report,
            debug::debug_push_open_path,
            debug::debug_write_crash_note,
            project::store::debug_remove_test_file,
            os::take_pending_open_paths,
            os::uninstall_app,
            os::close_ack,
            screen_pick::screen_pick_color,
            image_save::image_save_begin,
            image_save::image_save_chunk,
            image_save::image_save_commit,
            image_save::image_save_abort,
        ]);

    // Autotest only: the `window.__tarotingAutotest` init script. Not registered
    // at all in a normal or shipped run, so it is zero code and zero cost there.
    if autotest_mode() {
        builder = builder.plugin(autotest_flag_plugin());
    }
    // A launch with a known file: the `window.__tarotingLaunchFile` script.
    // Absent on every plain launch, so Home-first boot is untouched there.
    if launch_file {
        builder = builder.plugin(launch_hint_plugin());
    }

    if let Some(cache) = cache {
        builder = builder.manage(cache);
    }

    // asset:// served off the UI thread (asset.rs): registering the scheme here
    // replaces tauri's built-in synchronous handler of the same name.
    builder = asset::register(builder);

    builder
        .build(tauri::generate_context!())
        .expect("failed to start Taroting")
        .run(on_run_event);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        tauri::Url::parse(s).unwrap()
    }

    /// Each refused row differs from an allowed one on exactly one axis —
    /// host suffix, host prefix, port, scheme, path-only lookalike — so a rule
    /// loosened along any one of them lets exactly that row through. The dev
    /// rows pin that the dev server is allowed only when handed in (a debug
    /// build), and only at its exact origin.
    #[test]
    fn navigation_stays_on_the_apps_own_page() {
        let dev = url("http://localhost:1420");
        let rows: [(&str, Option<&tauri::Url>, bool, &str); 16] = [
            ("http://tauri.localhost/", None, true, "the app's own page"),
            ("http://tauri.localhost/index.html?x=1#y", None, true, "any path on it"),
            ("https://tauri.localhost/", None, true, "the https form of it"),
            ("tauri://localhost/", None, true, "the non-Windows form of it"),
            ("about:blank", None, true, "a blank page"),
            ("http://localhost:1420/", Some(&dev), true, "the dev server, in a debug build"),
            ("http://localhost:1420/src/main.ts", Some(&dev), true, "anything on the dev server"),
            ("http://localhost:1420/", None, false, "the dev server, in a release build"),
            ("http://localhost:1421/", Some(&dev), false, "the next port over"),
            ("https://localhost:1420/", Some(&dev), false, "the dev port, other scheme"),
            ("http://tauri.localhost.evil.example/", None, false, "a host that only starts the same"),
            ("http://evil.tauri.localhost/", None, false, "a subdomain of it"),
            ("http://tauri.localhost:8080/", None, false, "the app host on another port"),
            ("https://example.com/tauri.localhost", None, false, "the app host only in the path"),
            ("file:///C:/Users/x/clip.mp4", None, false, "a dropped file"),
            ("about:srcdoc", None, false, "an about page that is not blank"),
        ];
        for (u, dev_origin, want, why) in rows {
            assert_eq!(navigation_allowed(&url(u), dev_origin), want, "{why}: {u}");
        }
    }

    /// The startup sweeps run in `.setup()`, where only the primary instance
    /// gets, and the cache's partials sweep after the temp-projects one.
    /// Pinned in the source because `.setup()` needs a running app. Only the
    /// code BEFORE the test module is searched: the needles also appear in
    /// this test, and a whole-file search would find them here.
    #[test]
    fn setup_sweeps_stale_cache_partials_in_the_primary_instance() {
        let code = include_str!("main.rs").split("#[cfg(test)]").next().unwrap();
        let setup = &code[code.find(".setup(|app| {").expect("the setup hook")..];
        let primary = setup.find("forward.ends_launch()").expect("the second-launch hand-over");
        let temp = setup.find("project::store::cleanup_temp_projects();").expect("the temp sweep");
        let partials = setup
            .find("cache::sweep_stale_partials_in_background(&cache);")
            .expect("setup must sweep the cache's stale partials");
        assert!(primary < temp && temp < partials, "the sweeps run after the hand-over, temp projects first");
        let claims = setup
            .find("export::claims::sweep_stale_in_background();")
            .expect("setup must sweep the export claims an earlier run left");
        let wipe = setup.find("debug::autotest_root()").expect("the autotest wipe");
        assert!(primary < claims && wipe < claims, "the claims sweep runs in the primary, after the autotest wipe");
        let watch = setup.find("crash::arm_exit_watch();").expect("setup must arm the unclean-exit watch");
        assert!(primary < watch && wipe < watch, "the exit watch is armed in the primary, after the autotest wipe");
        // Line endings as checked out (CRLF here) must not decide the search.
        let code = code.replace('\r', "");
        let run = &code[code.find("fn on_run_event").expect("the run-loop callback")..];
        let run = &run[..run.find("\n}\n").unwrap()];
        assert!(run.contains("crash::disarm_exit_watch();"), "an orderly exit must disarm the watch");
        assert!(
            setup[..partials].contains("app.try_state::<Arc<cache::Cache>>()"),
            "a disabled cache is not managed: look it up with try_state, never state"
        );
    }

    /// The main window starts hidden and is shown in `.setup()` only after
    /// the second-launch hand-over (a launch that hands over never shows a
    /// window) and, under autotest, only after it is concealed. Pinned in the
    /// source and the config: `.setup()` needs a running app.
    #[test]
    fn the_window_is_shown_only_by_the_primary_and_after_the_autotest_conceal() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &conf["app"]["windows"][0];
        assert_eq!(main["label"], "main");
        assert_eq!(main["visible"], false, "the window must be created hidden");
        let code = include_str!("main.rs").split("#[cfg(test)]").next().unwrap();
        let setup = &code[code.find(".setup(|app| {").expect("the setup hook")..];
        let handed_over = setup.find("forward.ends_launch()").expect("the second-launch hand-over");
        let conceal = setup.find("conceal_autotest_window(&win);").expect("the autotest conceal");
        let show = setup.find("win.show()").expect("setup must show the window");
        assert!(handed_over < show, "shown before the hand-over was decided");
        assert!(conceal < show, "shown before the autotest conceal");
        // Re-applied right after the show, still under autotest only, and
        // before anything else in setup runs.
        let after = &setup[show..];
        let again = after.find("conceal_autotest_window(&win);").expect("the conceal re-applied after show");
        let next = after.find("crash::arm_exit_watch();").expect("the rest of setup");
        assert!(again < next, "the re-conceal must come straight after the show");
        let between = &after[..again];
        assert!(between.contains("if autotest_mode() {"), "the re-conceal is autotest only");
        assert!(!between.contains("let "), "nothing runs between the show and the re-conceal");
    }

    /// Every input flips the answer on its own in at least one row.
    #[test]
    fn the_engine_failure_box_is_shown_unless_tauri_showed_one_or_nobody_may_see_it() {
        // (runtime found, debug build, autotest) -> show our box
        assert!(engine_failure_box(true, false, false), "release, runtime found: ours");
        assert!(!engine_failure_box(false, false, false), "release, no runtime: tauri's box only");
        assert!(engine_failure_box(false, true, false), "debug, no runtime: tauri showed none");
        assert!(!engine_failure_box(true, true, true), "autotest: never anything visible");
        assert!(!engine_failure_box(true, false, true), "autotest in any build");
    }

    /// The run-loop flush, with a REAL index on disk. The first `mark_used`
    /// writes at once (no flush has happened yet); the second falls inside the
    /// coalescing interval and stays in memory, which is exactly the stamp
    /// the app lost on every quit. A non-exit event must leave it unwritten,
    /// Exit must write it, and the file is read while the cache is still alive
    /// (its `Drop` would flush too, and hide a missing exit flush).
    #[test]
    fn the_exit_event_writes_the_coalesced_cache_stamps() {
        let root = std::env::temp_dir().join(format!("taroting-main-flush-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let cache = Arc::new(cache::Cache::new_at(root.clone()));
        cache.mark_used(&root.join("thumbs").join("first.jpg"));
        cache.mark_used(&root.join("thumbs").join("second.jpg"));
        let index = || std::fs::read_to_string(root.join("index.json")).unwrap_or_default();
        assert!(index().contains("first.jpg"), "fixture: the first stamp is written at once");
        assert!(!index().contains("second.jpg"), "fixture: the second must still be coalesced");

        // Every other event leaves the state alone: the getter is never called.
        let looked_up = std::cell::Cell::new(0u32);
        for event in [tauri::RunEvent::Ready, tauri::RunEvent::MainEventsCleared, tauri::RunEvent::Resumed] {
            flush_cache_on(&event, || { looked_up.set(looked_up.get() + 1); Some(cache.clone()) });
        }
        assert_eq!(looked_up.get(), 0, "a non-Exit event must not look the cache up");
        assert!(!index().contains("second.jpg"), "only Exit flushes");
        flush_cache_on(&tauri::RunEvent::Exit, || None);
        assert!(!index().contains("second.jpg"), "no cache, nothing to flush");
        flush_cache_on(&tauri::RunEvent::Exit, || { looked_up.set(looked_up.get() + 1); Some(cache.clone()) });
        assert_eq!(looked_up.get(), 1, "Exit looks the cache up exactly once");
        assert!(index().contains("second.jpg"), "Exit must write the coalesced stamp");

        drop(cache);
        let _ = std::fs::remove_dir_all(&root);
    }
}
