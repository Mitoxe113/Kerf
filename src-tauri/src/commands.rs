//! IPC surface between the UI and the engine.
//!
//! The UI never mutates the document itself: it sends [`EditCommand`]s and
//! receives [`Delta`]s containing only what changed.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use kerf_core::error::EditError;
use kerf_core::model::{Derived, MediaAsset, MediaKind, MediaStatus, Project, TrackKind};
use kerf_core::history::{HistoryList, Side};
use kerf_core::ops::{EditCommand, EditOutcome};
use kerf_media::{analysis, probe};
use kerf_media::render::{self, ExportSettings};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::export_jobs::ExportJob;
use crate::media_jobs::Job;
use crate::recovery::{self, RecoveryInfo};
use crate::versions::{self, VersionInfo};
use crate::state::{lock, now_ms, AppState, Delta, ProjectState, Session};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    fn new(code: &str, message: impl ToString) -> Self {
        Self { code: code.into(), message: message.to_string() }
    }
}

impl From<EditError> for CommandError {
    fn from(e: EditError) -> Self {
        let code = match &e {
            EditError::SequenceNotFound => "sequenceNotFound",
            EditError::TrackNotFound => "trackNotFound",
            EditError::ClipNotFound => "clipNotFound",
            EditError::MediaNotFound => "mediaNotFound",
            EditError::BinNotFound => "binNotFound",
            EditError::MarkerNotFound => "markerNotFound",
            EditError::TrackLocked => "trackLocked",
            EditError::MediaNotReady => "mediaNotReady",
            EditError::MediaInUse(_) => "mediaInUse",
            EditError::TrackKindMismatch => "trackKindMismatch",
            EditError::TrackOutOfRange => "trackOutOfRange",
            EditError::NoNeighbor => "noNeighbor",
            EditError::LastSequence => "lastSequence",
            EditError::Invalid(_) => "invalid",
        };
        Self::new(code, e)
    }
}

type CmdResult<T> = Result<T, CommandError>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub ffmpeg: Option<String>,
    pub hw_encoders: Option<Vec<String>>,
    pub cache_dir: PathBuf,
}

/// The project Kerf was launched with, once.
#[tauri::command]
pub fn take_launch_file(state: State<'_, AppState>) -> Option<PathBuf> {
    lock(&state.launch_file).take()
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        ffmpeg: state.media.tools.as_ref().and_then(|t| t.version().ok()),
        hw_encoders: lock(&state.media.hw_encoders).clone(),
        cache_dir: state.paths.cache.clone(),
    }
}

#[tauri::command]
pub fn project_state(state: State<'_, AppState>) -> ProjectState {
    lock(&state.session).state()
}

/// Grants the webview read access to media files and queues analysis where needed.
fn activate_media(app: &AppHandle, state: &AppState, assets: &[MediaAsset]) {
    let scope = app.asset_protocol_scope();
    for a in assets {
        let _ = scope.allow_file(&a.path);
        let derived_missing = |d: &Derived| {
            d.poster.as_ref().is_some_and(|p| !p.is_file())
                || d.filmstrip.as_ref().is_some_and(|f| !f.path.is_file())
                || d.peaks.as_ref().is_some_and(|p| !p.path.is_file())
                || d.proxy.as_ref().is_some_and(|p| !p.is_file())
        };
        let needs = match &a.status {
            MediaStatus::Analyzing => true,
            MediaStatus::Ready => a.info.is_none() || derived_missing(&a.derived),
            MediaStatus::Missing | MediaStatus::Error(_) => false,
        };
        // Titles are drawn by the UI and need no probing, posters or proxies.
        if needs && a.title.is_none() {
            state.media.submit(Job::Analyze(a.id));
        }
    }
}

fn replace_session(state: &AppState, session: Session) {
    let mut s = lock(&state.session);
    // The previous document was explicitly saved or discarded by the user.
    recovery::discard(&state.paths.recovery, s.project.id);
    *s = session;
}

#[tauri::command(async)]
pub fn project_new(state: State<'_, AppState>, name: String) -> ProjectState {
    let name = if name.trim().is_empty() { "Unbenanntes Projekt".to_string() } else { name.trim().to_string() };
    replace_session(&state, Session::new(Project::new(name, now_ms()), None));
    lock(&state.session).state()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub state: ProjectState,
    pub used_backup: bool,
}

#[tauri::command(async)]
pub fn project_open(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<OpenResult> {
    let path = PathBuf::from(path);
    let (project, used_backup) =
        kerf_core::io::load_with_fallback(&path).map_err(|e| CommandError::new("openFailed", e))?;
    log::info!("opened {} ({} media, {} sequences)", path.display(), project.media.len(), project.sequences.len());
    let media = project.media.clone();
    let mut session = Session::new(project, Some(path));
    if used_backup {
        // Content differs from the file on disk until the user saves.
        session.revision = 1;
    }
    replace_session(&state, session);
    activate_media(&app, &state, &media);
    Ok(OpenResult { state: lock(&state.session).state(), used_backup })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: PathBuf,
    pub revision: u64,
    pub dirty: bool,
    pub name: String,
}

#[tauri::command(async)]
pub fn project_save(state: State<'_, AppState>, path: Option<String>) -> CmdResult<SaveResult> {
    let (project, target, revision) = {
        let mut s = lock(&state.session);
        let target = match path {
            Some(p) => {
                let mut p = PathBuf::from(p);
                if p.extension().is_none_or(|e| e != kerf_core::io::EXTENSION) {
                    p.set_extension(kerf_core::io::EXTENSION);
                }
                if let Some(stem) = p.file_stem() {
                    s.project.name = stem.to_string_lossy().into_owned();
                }
                p
            }
            None => s.path.clone().ok_or_else(|| CommandError::new("noPath", "project has not been saved yet"))?,
        };
        (s.project.clone(), target, s.revision)
    };
    kerf_core::io::save(&project, &target).map_err(|e| CommandError::new("saveFailed", e))?;
    let mut s = lock(&state.session);
    s.saved_revision = revision;
    s.path = Some(target.clone());
    recovery::discard(&state.paths.recovery, project.id);
    let keep = state.prefs.keep_versions.load(Ordering::Relaxed);
    if let Err(e) = versions::record(&state.paths.versions, project.id, &target, now_ms(), keep) {
        // The project itself is saved; a missing version copy is not worth failing for.
        log::warn!("could not keep a version of {}: {e}", target.display());
    }
    log::info!("saved {}", target.display());
    Ok(SaveResult { path: target, revision: s.revision, dirty: s.dirty(), name: s.project.name.clone() })
}

#[tauri::command(async)]
pub fn edit(app: AppHandle, state: State<'_, AppState>, command: EditCommand) -> CmdResult<Delta> {
    let mut s = lock(&state.session);
    let session = &mut *s;
    let outcome = session.history.apply(&mut session.project, &command)?;
    if outcome.changed {
        session.touch();
    }
    if let EditCommand::RelinkMedia { media, .. } = &command {
        if let Some(a) = session.project.media(*media).cloned() {
            activate_media(&app, &state, &[a]);
        }
    }
    Ok(Delta::after(&s, outcome, Side::Undo))
}

fn step(state: &AppState, side: Side) -> Option<Delta> {
    let mut s = lock(&state.session);
    let session = &mut *s;
    let label = match side {
        Side::Redo => session.history.undo(&mut session.project)?,
        Side::Undo => session.history.redo(&mut session.project)?,
    };
    session.touch();
    let outcome = EditOutcome { label, changed: true, ..Default::default() };
    Some(Delta::after(&s, outcome, side))
}

/// Undoes the last edit. The returned delta carries only what changed.
#[tauri::command(async)]
pub fn undo(state: State<'_, AppState>) -> Option<Delta> {
    step(&state, Side::Redo)
}

#[tauri::command(async)]
pub fn redo(state: State<'_, AppState>) -> Option<Delta> {
    step(&state, Side::Undo)
}

/// Named steps for the history panel.
#[tauri::command]
pub fn history_list(state: State<'_, AppState>) -> HistoryList {
    lock(&state.session).history.list()
}

/// Jumps to the state after `position` steps (undoing or redoing as needed).
#[tauri::command(async)]
pub fn history_goto(state: State<'_, AppState>, position: usize) -> ProjectState {
    let mut s = lock(&state.session);
    let session = &mut *s;
    if session.history.goto(&mut session.project, position) {
        session.touch();
    }
    s.state()
}

#[tauri::command]
pub fn set_active_sequence(state: State<'_, AppState>, sequence: Uuid) -> CmdResult<()> {
    let mut s = lock(&state.session);
    if s.project.sequence(sequence).is_none() {
        return Err(EditError::SequenceNotFound.into());
    }
    if s.project.active_sequence != sequence {
        s.project.active_sequence = sequence;
        s.touch();
    }
    Ok(())
}

fn collect_media(path: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if path.is_dir() {
        if depth == 0 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(path) else { return };
        let mut children: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        children.sort();
        for c in children {
            collect_media(&c, depth - 1, out);
        }
    } else if path.is_file() && probe::is_media_path(path) {
        out.push(path.to_path_buf());
    }
}

#[tauri::command(async)]
pub fn media_import(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, bin: Option<Uuid>) -> CmdResult<Delta> {
    let mut files = Vec::new();
    for p in &paths {
        collect_media(Path::new(p), 8, &mut files);
    }
    let mut s = lock(&state.session);
    let known: std::collections::HashSet<String> =
        s.project.media.iter().map(|m| m.path.to_string_lossy().to_lowercase()).collect();
    let now = now_ms();
    let assets: Vec<MediaAsset> = files
        .into_iter()
        .filter(|f| !known.contains(&f.to_string_lossy().to_lowercase()))
        .map(|f| {
            let ext = f.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let kind = if probe::IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                MediaKind::Image
            } else if probe::AUDIO_EXTENSIONS.contains(&ext.as_str()) {
                MediaKind::Audio
            } else {
                MediaKind::Video
            };
            MediaAsset {
                id: Uuid::new_v4(),
                name: f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                path: f,
                kind,
                status: MediaStatus::Analyzing,
                info: None,
                bin,
                favorite: false,
                label: Default::default(),
                tags: Vec::new(),
                note: String::new(),
                imported_at: now,
                derived: Derived::default(),
                marks: Default::default(),
                title: None,
            }
        })
        .collect();
    let session = &mut *s;
    let outcome = session.history.apply(&mut session.project, &EditCommand::ImportMedia { assets: assets.clone() })?;
    if outcome.changed {
        session.touch();
    }
    let delta = Delta::after(&s, outcome, Side::Undo);
    drop(s);
    activate_media(&app, &state, &assets);
    log::info!("imported {} file(s)", assets.len());
    Ok(delta)
}

#[tauri::command]
pub fn media_analyze(state: State<'_, AppState>, ids: Vec<Uuid>) {
    {
        let mut s = lock(&state.session);
        for id in &ids {
            if let Some(a) = s.project.media_mut(*id) {
                a.status = MediaStatus::Analyzing;
            }
        }
    }
    for id in ids {
        state.media.submit(Job::Analyze(id));
    }
}

#[tauri::command]
pub fn media_proxy(state: State<'_, AppState>, ids: Vec<Uuid>) {
    for id in ids {
        state.media.submit(Job::Proxy(id));
    }
}

#[tauri::command(async)]
pub fn export_start(app: AppHandle, state: State<'_, AppState>, sequence: Uuid, settings: ExportSettings) -> CmdResult<ExportJob> {
    if let Some(dir) = settings.output.parent() {
        if !dir.is_dir() {
            return Err(CommandError::new("exportFailed", "output folder does not exist"));
        }
    }
    let hw = lock(&state.media.hw_encoders).clone().unwrap_or_default();
    let (plan, name) = {
        let s = lock(&state.session);
        let seq = s.project.sequence(sequence).ok_or(EditError::SequenceNotFound)?;
        let plan = render::plan(&s.project, seq, &settings, &state.paths.work, &hw)
            .map_err(|e| CommandError::new("exportFailed", e))?;
        (plan, seq.name.clone())
    };
    Ok(state.exports.enqueue(&app, name, plan))
}

#[tauri::command]
pub fn export_cancel(app: AppHandle, state: State<'_, AppState>, id: Uuid) {
    state.exports.cancel(&app, id);
}

#[tauri::command]
pub fn export_retry(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> CmdResult<ExportJob> {
    state.exports.retry(&app, id).ok_or_else(|| CommandError::new("exportFailed", "job cannot be retried"))
}

#[tauri::command]
pub fn export_log(state: State<'_, AppState>, id: Uuid) -> Option<String> {
    state.exports.log(id)
}

/// Free bytes on the volume holding `path` (a file or folder), if known.
#[tauri::command]
pub fn disk_free(path: String) -> Option<u64> {
    let p = PathBuf::from(path);
    let dir = p.ancestors().find(|a| a.is_dir())?;
    free_space(dir)
}

#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, available: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0u64;
    // SAFETY: `wide` is NUL-terminated and outlives the call; null outputs are allowed.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(available)
}

#[cfg(not(windows))]
fn free_space(dir: &Path) -> Option<u64> {
    let out = std::process::Command::new("df").arg("-Pk").arg(dir).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let kb: u64 = text.lines().nth(1)?.split_whitespace().nth(3)?.parse().ok()?;
    Some(kb * 1024)
}

/// Small user files (keyboard profiles): only `.json`, at most 2 MB.
fn json_path(path: &str) -> CmdResult<PathBuf> {
    let p = PathBuf::from(path);
    if p.extension().is_none_or(|e| !e.eq_ignore_ascii_case("json")) {
        return Err(CommandError::new("ioFailed", "only .json files are supported"));
    }
    Ok(p)
}

#[tauri::command(async)]
pub fn json_read(path: String) -> CmdResult<String> {
    let p = json_path(&path)?;
    let len = std::fs::metadata(&p).map_err(|e| CommandError::new("ioFailed", e))?.len();
    if len > 2 << 20 {
        return Err(CommandError::new("ioFailed", "file too large"));
    }
    std::fs::read_to_string(&p).map_err(|e| CommandError::new("ioFailed", e))
}

/// Text files the frontend parses itself (LUTs, subtitles).
const TEXT_EXTENSIONS: [&str; 3] = ["cube", "srt", "vtt"];

#[tauri::command(async)]
pub fn text_read(path: String) -> CmdResult<String> {
    let p = PathBuf::from(&path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !TEXT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(CommandError::new("ioFailed", format!("unsupported file type: .{ext}")));
    }
    let len = std::fs::metadata(&p).map_err(|e| CommandError::new("ioFailed", e))?.len();
    if len > 64 << 20 {
        return Err(CommandError::new("ioFailed", "file too large"));
    }
    let bytes = std::fs::read(&p).map_err(|e| CommandError::new("ioFailed", e))?;
    Ok(decode_text(bytes))
}

/// UTF-8 (without BOM), or Windows-1252 when the bytes are not valid UTF-8
/// (common for subtitle files).
fn decode_text(mut bytes: Vec<u8>) -> String {
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        bytes.drain(..3);
    }
    String::from_utf8(bytes).unwrap_or_else(|e| {
        // 0x80..0x9F differ from Latin-1; the rest maps 1:1.
        const HIGH: [char; 32] = [
            '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—',
            '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
        ];
        e.into_bytes().iter().map(|&b| if (0x80..0xA0).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char }).collect()
    })
}

/// Reads an SRT or WebVTT file into cues (seconds).
#[tauri::command(async)]
pub fn subtitles_parse(path: String) -> CmdResult<Vec<kerf_core::text::TimedText>> {
    let cues = kerf_core::text::parse_subtitles(&text_read(path)?);
    if cues.is_empty() {
        return Err(CommandError::new("subtitlesEmpty", "no readable subtitles"));
    }
    Ok(cues)
}

/// Writes the sequence's subtitles as SRT or WebVTT (by the file extension).
#[tauri::command(async)]
pub fn subtitles_write(state: State<'_, AppState>, path: String, sequence: Uuid) -> CmdResult<()> {
    let p = PathBuf::from(&path);
    let format = match p.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("srt") => kerf_core::text::SubtitleFormat::Srt,
        Some("vtt") => kerf_core::text::SubtitleFormat::Vtt,
        _ => return Err(CommandError::new("ioFailed", "subtitle files end in .srt or .vtt")),
    };
    let text = {
        let s = lock(&state.session);
        let seq = s.project.sequence(sequence).ok_or(EditError::SequenceNotFound)?;
        kerf_core::text::write_subtitles(&seq.subtitles.cues, seq.settings.fps, 0, format)
    };
    kerf_core::io::write_atomic(&p, text.as_bytes(), false).map_err(|e| CommandError::new("ioFailed", e))
}

/// Stores a PNG drawn by the UI (titles, burned-in subtitles) in the cache,
/// named by its content, and returns the path. The body is the raw file.
#[tauri::command(async)]
pub fn title_png(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> CmdResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new("ioFailed", "expected PNG bytes"));
    };
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.len() > 256 << 20 {
        return Err(CommandError::new("ioFailed", "not a PNG"));
    }
    // FNV-1a over the bytes: equal pictures share a file, so re-rendering is free.
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100_0000_01b3));
    let dir = state.paths.cache.join("titles");
    let path = dir.join(format!("{hash:016x}-{}.png", bytes.len()));
    if !path.is_file() {
        std::fs::create_dir_all(&dir).map_err(|e| CommandError::new("ioFailed", e))?;
        kerf_core::io::write_atomic(&path, bytes, false).map_err(|e| CommandError::new("ioFailed", e))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn json_write(path: String, text: String) -> CmdResult<()> {
    let p = json_path(&path)?;
    kerf_core::io::write_atomic(&p, text.as_bytes(), false).map_err(|e| CommandError::new("ioFailed", e))
}

/// Opens a file with its default application.
#[tauri::command]
pub fn open_path(path: String) -> CmdResult<()> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(CommandError::new("openFileFailed", "file not found"));
    }
    #[cfg(windows)]
    std::process::Command::new("explorer").arg(&p).spawn().map_err(|e| CommandError::new("openFileFailed", e))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&p).spawn().map_err(|e| CommandError::new("openFileFailed", e))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(&p).spawn().map_err(|e| CommandError::new("openFileFailed", e))?;
    Ok(())
}

#[tauri::command]
pub fn export_jobs(state: State<'_, AppState>) -> Vec<ExportJob> {
    state.exports.jobs()
}

#[tauri::command]
pub fn export_clear(state: State<'_, AppState>) {
    state.exports.clear_finished();
}

#[tauri::command]
pub fn recovery_list(state: State<'_, AppState>) -> Vec<RecoveryInfo> {
    let current = lock(&state.session).project.id;
    recovery::list(&state.paths.recovery).into_iter().filter(|r| r.project_id != current).collect()
}

#[tauri::command(async)]
pub fn recovery_restore(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> CmdResult<ProjectState> {
    let (project, path) = recovery::load(&state.paths.recovery, id).map_err(|e| CommandError::new("recoveryFailed", e))?;
    let media = project.media.clone();
    let mut session = Session::new(project, path);
    session.revision = 1; // unsaved until the user saves
    replace_session(&state, session);
    activate_media(&app, &state, &media);
    Ok(lock(&state.session).state())
}

#[tauri::command]
pub fn recovery_discard(state: State<'_, AppState>, id: Uuid) {
    recovery::discard(&state.paths.recovery, id);
}

/// Called by the UI right before the window closes after the user resolved
/// unsaved changes: the session ended cleanly, so no recovery is needed.
#[tauri::command]
pub fn session_end(state: State<'_, AppState>) {
    let id = lock(&state.session).project.id;
    recovery::discard(&state.paths.recovery, id);
    state.media.cancel_proxies.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
pub fn reveal_path(path: String) -> CmdResult<()> {
    let p = PathBuf::from(&path);
    #[cfg(windows)]
    {
        let mut arg = std::ffi::OsString::from("/select,");
        arg.push(p.as_os_str());
        std::process::Command::new("explorer").arg(arg).spawn().map_err(|e| CommandError::new("revealFailed", e))?;
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg("-R").arg(&p).spawn().map_err(|e| CommandError::new("revealFailed", e))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(p.parent().unwrap_or(&p))
        .spawn()
        .map_err(|e| CommandError::new("revealFailed", e))?;
    Ok(())
}

/// Engine-side preferences: autosave interval (seconds) and number of kept versions.
#[tauri::command]
pub fn set_preferences(state: State<'_, AppState>, autosave_secs: u64, keep_versions: usize) {
    state.prefs.autosave_secs.store(autosave_secs.clamp(10, 3600), Ordering::Relaxed);
    state.prefs.keep_versions.store(keep_versions.min(200), Ordering::Relaxed);
}

/// Saved versions of the current project, newest first.
#[tauri::command]
pub fn version_list(state: State<'_, AppState>) -> Vec<VersionInfo> {
    let id = lock(&state.session).project.id;
    versions::list(&state.paths.versions, id)
}

/// Replaces the document with a saved version. The project keeps its path,
/// so the next save overwrites it; until then the document is unsaved.
#[tauri::command(async)]
pub fn version_restore(app: AppHandle, state: State<'_, AppState>, file: String) -> CmdResult<ProjectState> {
    let (id, path) = {
        let s = lock(&state.session);
        (s.project.id, s.path.clone())
    };
    let file = versions::find(&state.paths.versions, id, Path::new(&file)).ok_or_else(|| CommandError::new("versionNotFound", "version not found"))?;
    let project = kerf_core::io::load(&file).map_err(|e| CommandError::new("openFailed", e))?;
    log::info!("restored version {}", file.display());
    let media = project.media.clone();
    let mut session = Session::new(project, path);
    session.touch();
    replace_session(&state, session);
    activate_media(&app, &state, &media);
    Ok(lock(&state.session).state())
}

/// Freeze frame: writes the frame under the playhead of a video clip as a
/// PNG (next to the project in `Standbilder/`, or in the app data folder for
/// unsaved projects) and inserts it there for `seconds`, rippling the rest.
#[tauri::command(async)]
pub fn freeze_frame(app: AppHandle, state: State<'_, AppState>, sequence: Uuid, clip: Uuid, frame: i64, seconds: f64) -> CmdResult<Delta> {
    let tools = state.media.tools.clone().ok_or_else(|| CommandError::new("ffmpegMissing", "FFmpeg not found"))?;
    let (src, source_s, track, at, duration, file, bin) = {
        let s = lock(&state.session);
        let seq = s.project.sequence(sequence).ok_or(EditError::SequenceNotFound)?;
        let (ti, ci) = seq.locate(clip).ok_or(EditError::ClipNotFound)?;
        let (t, c) = (&seq.tracks[ti], &seq.tracks[ti].clips[ci]);
        let asset = s.project.media(c.media_id).ok_or(EditError::MediaNotFound)?;
        if t.kind != TrackKind::Video || asset.kind != MediaKind::Video {
            return Err(CommandError::new("freezeNeedsVideo", "freeze frames need a video clip"));
        }
        let at = frame.clamp(c.start, c.end() - 1);
        let rate = seq.settings.fps;
        let source_s = rate.frames_to_seconds(c.shown_frame(at - c.start));
        let dir = match s.path.as_deref().and_then(Path::parent) {
            Some(p) => p.join("Standbilder"),
            None => state.paths.stills.clone(),
        };
        let stem = Path::new(&c.name).file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|| "Standbild".into());
        let file = (0..)
            .map(|n| dir.join(if n == 0 { format!("{stem} F{at}.png") } else { format!("{stem} F{at} ({n}).png") }))
            .find(|p| !p.exists())
            .expect("unbounded");
        let duration = rate.seconds_to_frames_round(seconds.clamp(0.04, 3600.0)).max(1);
        (asset.path.clone(), source_s, t.id, at, duration, file, asset.bin)
    };
    // FFmpeg runs without holding the session lock.
    let fail = |e: kerf_media::MediaError| CommandError::new("freezeFailed", e);
    analysis::extract_frame(&tools, &src, source_s, &file).map_err(fail)?;
    let (kind, info) = probe::probe(&tools, &file).map_err(fail)?;
    let asset = MediaAsset {
        id: Uuid::new_v4(),
        name: file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: file,
        kind,
        status: MediaStatus::Ready,
        info: Some(info),
        bin,
        favorite: false,
        label: Default::default(),
        tags: Vec::new(),
        note: String::new(),
        imported_at: now_ms(),
        derived: Derived::default(),
        marks: Default::default(),
        title: None,
    };
    let id = asset.id;
    let mut s = lock(&state.session);
    let session = &mut *s;
    let outcome = session.history.apply(&mut session.project, &EditCommand::InsertStill { sequence, asset: Box::new(asset.clone()), track, at, duration })?;
    session.touch();
    let _ = app.asset_protocol_scope().allow_file(&asset.path);
    // Poster and proxy for the browser.
    state.media.submit(Job::Analyze(id));
    log::info!("freeze frame {} at source {source_s:.3}s", asset.path.display());
    Ok(Delta::after(&s, outcome, Side::Undo))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipLoudness {
    clip: Uuid,
    /// None when the media has no audio or FFmpeg failed.
    loudness: Option<analysis::Loudness>,
}

/// Measures the source range each clip plays (EBU R128), e.g. to normalize
/// clip gain. Unknown clips are skipped.
#[tauri::command(async)]
pub fn measure_clips(state: State<'_, AppState>, sequence: Uuid, clips: Vec<Uuid>) -> CmdResult<Vec<ClipLoudness>> {
    let tools = state.media.tools.clone().ok_or_else(|| CommandError::new("ffmpegMissing", "FFmpeg not found"))?;
    let jobs: Vec<(Uuid, PathBuf, f64, f64)> = {
        let s = lock(&state.session);
        let seq = s.project.sequence(sequence).ok_or(EditError::SequenceNotFound)?;
        let rate = seq.settings.fps;
        clips
            .iter()
            .filter_map(|id| {
                let (ti, ci) = seq.locate(*id)?;
                let c = &seq.tracks[ti].clips[ci];
                let asset = s.project.media(c.media_id)?;
                Some((c.id, asset.path.clone(), rate.frames_to_seconds(c.source_in), rate.frames_to_seconds(c.source_out() - c.source_in)))
            })
            .collect()
    };
    // A few FFmpeg processes at a time, without holding the session lock.
    let mut out = Vec::with_capacity(jobs.len());
    for chunk in jobs.chunks(4) {
        std::thread::scope(|s| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(id, path, start, dur)| {
                    let tools = &tools;
                    s.spawn(move || {
                        let loudness = analysis::loudness(tools, path, *start, Some(*dur)).map_err(|e| log::warn!("loudness of {}: {e}", path.display())).ok();
                        ClipLoudness { clip: *id, loudness }
                    })
                })
                .collect();
            out.extend(handles.into_iter().filter_map(|h| h.join().ok()));
        });
    }
    Ok(out)
}

/// Path of the media's sound played backwards (made on first use), for
/// reversed clips in the preview.
#[tauri::command(async)]
pub fn reversed_audio(state: State<'_, AppState>, media: Uuid) -> CmdResult<PathBuf> {
    let tools = state.media.tools.clone().ok_or_else(|| CommandError::new("ffmpegMissing", "FFmpeg not found"))?;
    let (path, info) = {
        let s = lock(&state.session);
        let a = s.project.media(media).ok_or(EditError::MediaNotFound)?;
        (a.path.clone(), a.info.clone().ok_or(EditError::MediaNotReady)?)
    };
    let dir = analysis::cache_dir(&state.paths.cache, &path);
    analysis::reversed_audio(&tools, &path, &info, &dir).map_err(|e| CommandError::new("reverseFailed", e))
}

#[cfg(test)]
mod tests {
    use super::decode_text;

    #[test]
    fn subtitle_text_decodes_utf8_and_windows_1252() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFGr\xC3\xBC\xC3\x9Fe".to_vec()), "Grüße");
        assert_eq!(decode_text(b"Gr\xFC\xDFe \x84quoted\x93 \x80".to_vec()), "Grüße „quoted“ €");
    }
}
