//! Kerf application shell: wires the engine crates to the Tauri window.

mod commands;
mod export_jobs;
mod media_jobs;
mod recovery;
mod versions;
mod state;

use std::sync::Mutex;

use kerf_core::model::Project;
use tauri::{Emitter, Manager};

use crate::export_jobs::ExportService;
use crate::media_jobs::MediaService;
use crate::state::{now_ms, project_arg, AppPaths, AppState, Session};

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
        .setup(|app| {
            let cache_root = app.path().app_cache_dir()?;
            let data_root = app.path().app_data_dir()?;
            let paths = AppPaths {
                cache: cache_root.join("media"),
                recovery: data_root.join("recovery"),
                versions: data_root.join("versions"),
                stills: data_root.join("stills"),
                work: cache_root.join("work"),
            };
            for dir in [&paths.cache, &paths.recovery, &paths.versions, &paths.stills, &paths.work] {
                std::fs::create_dir_all(dir)?;
            }
            // Thumbnails, waveforms and proxies are read by the webview.
            app.asset_protocol_scope().allow_directory(&paths.cache, true)?;

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
            };
            app.manage(state);
            let handle = app.handle();
            let state = handle.state::<AppState>();
            state.media.start(handle);
            state.exports.start(handle);
            recovery::start(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            commands::set_preferences,
            commands::version_list,
            commands::version_restore,
            commands::freeze_frame,
            commands::measure_clips,
            commands::reversed_audio,
            commands::sync_angles,
            commands::take_launch_file,
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
