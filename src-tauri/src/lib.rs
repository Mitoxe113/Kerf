//! Kerf application shell: wires the engine crates to the Tauri window.

mod assist;
mod commands;
mod export_jobs;
mod library;
mod media_library;
mod media_jobs;
mod project_tools;
mod recovery;
mod versions;
mod state;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use kerf_core::model::Project;
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::export_jobs::ExportService;
use crate::media_jobs::MediaService;
use crate::state::{now_ms, project_arg, AppPaths, AppState, Session};

/// Answers `window.open("about:blank")` from the main window with a window of
/// its own that shares the page's script context: the program output for a
/// second display, drawn by the main window's playback engine. Nothing else
/// may open windows.
fn output_window(app: &AppHandle, url: Url, features: NewWindowFeatures) -> NewWindowResponse<tauri::Wry> {
    static COUNT: AtomicU32 = AtomicU32::new(0);
    if url.as_str() != "about:blank" {
        log::warn!("blocked window.open({url})");
        return NewWindowResponse::Deny;
    }
    let label = format!("output-{}", COUNT.fetch_add(1, Ordering::Relaxed) + 1);
    let built = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Kerf – Programm")
        .inner_size(1280.0, 720.0)
        .min_inner_size(320.0, 180.0)
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .window_features(features)
        // It shows only what the main page draws into it; it never loads anything.
        .on_navigation(|url| url.as_str() == "about:blank")
        .build();
    match built {
        Ok(window) => NewWindowResponse::Create { window },
        Err(e) => {
            log::error!("output window: {e}");
            NewWindowResponse::Deny
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        // One instance per user: a second instance would share the autosave
        // folder and offer the running session as a crash to recover.
        // Launching again focuses the existing window instead.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            // Double-clicking a project while Kerf runs opens it here.
            if let Some(path) = project_arg(argv, std::path::Path::new(&cwd)) {
                let _ = app.emit("open-project", path);
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("kerf".into()) }))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .max_file_size(5_000_000)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let cache_root = app.path().app_cache_dir()?;
            let data_root = app.path().app_data_dir()?;
            let paths = AppPaths {
                cache: cache_root.join("media"),
                recovery: data_root.join("recovery"),
                versions: data_root.join("versions"),
                stills: data_root.join("stills"),
                work: cache_root.join("work"),
                fonts: data_root.join("fonts"),
                assets: data_root.join("assets"),
            };
            for dir in [&paths.cache, &paths.recovery, &paths.versions, &paths.stills, &paths.work, &paths.fonts, &paths.assets] {
                std::fs::create_dir_all(dir)?;
            }
            // Thumbnails, waveforms and proxies are read by the webview, and so
            // are imported fonts and downloaded assets (previews, @font-face).
            app.asset_protocol_scope().allow_directory(&paths.cache, true)?;
            app.asset_protocol_scope().allow_directory(&paths.fonts, false)?;
            app.asset_protocol_scope().allow_directory(&paths.assets, true)?;

            let tools = match kerf_media::Tools::discover() {
                Ok(t) => {
                    log::info!("ffmpeg: {}", t.ffmpeg.display());
                    Some(t)
                }
                Err(e) => {
                    log::error!("{e}");
                    None
                }
            };
            let state = AppState {
                session: Mutex::new(Session::new(Project::new("Unbenanntes Projekt", now_ms()), None)),
                paths,
                prefs: Default::default(),
                media: MediaService::new(tools),
                exports: ExportService::new(),
                launch_file: Mutex::new(project_arg(std::env::args(), &std::env::current_dir().unwrap_or_default())),
                library: Mutex::new(match kerf_library::Library::open(&data_root.join("library.db")) {
                    Ok(l) => Some(l),
                    Err(e) => {
                        log::error!("library: {e}");
                        None
                    }
                }),
            };
            app.manage(state);
            app.manage(media_library::MediaHub::new());
            let handle = app.handle();
            let state = handle.state::<AppState>();
            state.media.start(handle);
            state.exports.start(handle);
            recovery::start(handle);

            // Built here rather than from the config alone, so the page can open
            // the program output window (see output_window).
            let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("main window missing from the config")?;
            let opener = handle.clone();
            WebviewWindowBuilder::from_config(handle, &config)?.on_new_window(move |url, features| output_window(&opener, url, features)).build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Output windows go with the main window (the app ends with it).
            if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
                for (label, w) in window.app_handle().webview_windows() {
                    if label != "main" {
                        let _ = w.destroy();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            assist::analyze,
            assist::analyze_cancel,
            assist::duck_plan,
            project_tools::archive_plan,
            project_tools::archive_write,
            project_tools::relink_search,
            project_tools::cache_info,
            project_tools::cache_clear,
            project_tools::media_metadata,
            commands::app_info,
            commands::project_state,
            commands::project_new,
            commands::project_open,
            commands::project_save,
            commands::edit,
            commands::undo,
            commands::redo,
            commands::history_list,
            commands::history_goto,
            commands::set_active_sequence,
            commands::media_import,
            commands::media_analyze,
            commands::media_proxy,
            commands::export_start,
            commands::export_cancel,
            commands::export_jobs,
            commands::export_retry,
            commands::export_log,
            commands::disk_free,
            commands::open_path,
            commands::json_read,
            commands::json_write,
            commands::text_read,
            commands::subtitles_parse,
            commands::subtitles_write,
            commands::title_png,
            commands::export_clear,
            commands::recovery_list,
            commands::recovery_restore,
            commands::recovery_discard,
            commands::session_end,
            commands::reveal_path,
            commands::log_frontend,
            commands::set_preferences,
            commands::version_list,
            commands::version_restore,
            commands::freeze_frame,
            commands::measure_clips,
            commands::reversed_audio,
            commands::sync_angles,
            commands::take_launch_file,
            library::preset_list,
            library::preset_save,
            library::preset_rename,
            library::preset_favorite,
            library::preset_delete,
            library::preset_export,
            library::preset_import,
            library::favorite_list,
            library::favorite_set,
            library::recent_list,
            library::recent_touch,
            media_library::media_providers,
            media_library::media_set_key,
            media_library::media_clear_key,
            media_library::media_search,
            media_library::media_thumb,
            media_library::media_download,
            media_library::media_download_cancel,
            media_library::media_downloads,
            media_library::media_downloads_clear,
            media_library::media_open_link,
            media_library::asset_list,
            media_library::asset_favorite,
            media_library::asset_delete,
            media_library::collection_list,
            media_library::collection_create,
            media_library::collection_delete,
            media_library::collection_set,
            media_library::license_entries,
            media_library::license_report,
            library::font_list,
            library::font_import,
            library::font_remove,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kerf")
        .run(|_app, _event| {
            // macOS hands documents over as an event instead of arguments.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                if let Some(path) = urls.iter().filter_map(|u| u.to_file_path().ok()).find(|p| p.extension().is_some_and(|e| e == "kerf")) {
                    let state = _app.state::<AppState>();
                    *crate::state::lock(&state.launch_file) = Some(path.clone());
                    let _ = _app.emit("open-project", path);
                }
            }
        });
}
