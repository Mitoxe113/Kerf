//! Project management: archiving (collect files), finding moved media, the
//! cache of derived media, and raw technical metadata of a file.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use kerf_core::archive::{self, ArchiveOptions, ArchivePlan, ArchiveReport};
use kerf_core::error::EditError;
use kerf_core::model::MediaStatus;
use kerf_media::analysis;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::assist::Job;
use crate::commands::{activate_media, free_space, CmdResult, CommandError};
use crate::state::{lock, AppState};

// --- archive ----------------------------------------------------------------------------

#[tauri::command]
pub fn archive_plan(state: State<'_, AppState>, options: ArchiveOptions) -> ArchivePlan {
    archive::plan(&lock(&state.session).project, &options)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ArchiveProgress {
    job: Uuid,
    done: u64,
    total: u64,
}

/// Copies the project's media into `dest` with a portable copy of the
/// project. The open project is not changed.
#[tauri::command(async)]
pub fn archive_write(app: AppHandle, state: State<'_, AppState>, job: Uuid, dest: String, options: ArchiveOptions) -> CmdResult<ArchiveReport> {
    let dest = PathBuf::from(dest);
    if !dest.is_absolute() {
        return Err(CommandError::new("invalid", "the archive folder must be an absolute path"));
    }
    let project = lock(&state.session).project.clone();
    let plan = archive::plan(&project, &options);
    // Room for the copies plus 1 % (file system overhead).
    let probe_dir = dest.ancestors().find(|d| d.is_dir()).unwrap_or(&dest);
    if let Some(free) = free_space(probe_dir) {
        if free < plan.total_bytes + plan.total_bytes / 100 {
            return Err(CommandError::new("diskFull", format!("{} bytes needed, {free} free", plan.total_bytes)));
        }
    }
    let guard = Job::new(job);
    archive::write(&project, &plan, &dest, &project.name, &guard.1, |done, total| {
        let _ = app.emit("archive-progress", ArchiveProgress { job, done, total });
    })
    .map_err(|e| match e {
        archive::ArchiveError::Cancelled => CommandError::new("cancelled", e),
        archive::ArchiveError::NotEmpty => CommandError::new("folderNotEmpty", e),
        e => CommandError::new("archiveFailed", e),
    })
}

// --- relinking -----------------------------------------------------------------------------

/// Most files looked at in one search (a whole disk is not searched).
const MAX_ENTRIES: usize = 300_000;
const MAX_DEPTH: usize = 16;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "camelCase")]
pub enum MatchKind {
    /// Same file name and size.
    NameAndSize,
    /// Same file name, different size (another export or version).
    Name,
    /// Same name with another extension (a transcode or proxy).
    Stem,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    path: PathBuf,
    kind: MatchKind,
    size: u64,
    /// Duration within 0.1 s of the recorded one (None: not checked or not readable).
    same_duration: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkSuggestion {
    media: Uuid,
    name: String,
    old_path: PathBuf,
    candidates: Vec<Candidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkSearch {
    suggestions: Vec<RelinkSuggestion>,
    /// Files looked at; `truncated` when the limit stopped the search.
    scanned: usize,
    truncated: bool,
}

fn stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn walk(dir: &Path, depth: usize, skip: &Path, seen: &mut usize, each: &mut dyn FnMut(&Path, u64)) {
    if depth > MAX_DEPTH || *seen >= MAX_ENTRIES || dir.starts_with(skip) {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if *seen >= MAX_ENTRIES {
            return;
        }
        *seen += 1;
        let path = e.path();
        let hidden = e.file_name().to_string_lossy().starts_with('.');
        match e.file_type() {
            // Symlinked folders are not followed (loops).
            Ok(t) if t.is_dir() && !hidden => walk(&path, depth + 1, skip, seen, each),
            Ok(t) if t.is_file() => each(&path, e.metadata().map(|m| m.len()).unwrap_or(0)),
            _ => {}
        }
    }
}

/// Looks for the files of offline `media` in `dirs` by name, size and
/// duration. Proposes only; relinking is a separate, undoable edit. Kerf's own
/// cache (proxies, thumbnails) is never proposed.
#[tauri::command(async)]
pub fn relink_search(state: State<'_, AppState>, media: Vec<Uuid>, dirs: Vec<String>) -> CmdResult<RelinkSearch> {
    let wanted: Vec<_> = {
        let s = lock(&state.session);
        media
            .iter()
            .map(|id| s.project.media(*id).cloned().ok_or(EditError::MediaNotFound))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|a| a.has_file())
            .collect()
    };
    let mut found: Vec<Vec<Candidate>> = wanted.iter().map(|_| Vec::new()).collect();
    let names: Vec<(String, String, Option<u64>)> = wanted
        .iter()
        .map(|a| (a.path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default(), stem(&a.path), a.info.as_ref().map(|i| i.size_bytes)))
        .collect();
    let mut seen = 0;
    for d in dirs.iter().map(PathBuf::from).filter(|d| d.is_absolute() && d.is_dir()) {
        walk(&d, 0, &state.paths.cache, &mut seen, &mut |path, size| {
            let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            let st = stem(path);
            for (i, (want, want_stem, want_size)) in names.iter().enumerate() {
                let kind = if &name == want {
                    if *want_size == Some(size) { MatchKind::NameAndSize } else { MatchKind::Name }
                } else if !want_stem.is_empty() && &st == want_stem && kerf_media::probe::is_media_path(path) {
                    MatchKind::Stem
                } else {
                    continue;
                };
                if path != wanted[i].path && !found[i].iter().any(|c| c.path == path) {
                    found[i].push(Candidate { path: path.to_path_buf(), kind, size, same_duration: None });
                }
            }
        });
    }
    // Check the duration of the best few candidates of each file.
    let tools = state.media.tools.clone();
    for (i, list) in found.iter_mut().enumerate() {
        list.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.path.cmp(&b.path)));
        list.truncate(10);
        if let (Some(tools), Some(info)) = (&tools, &wanted[i].info) {
            for c in list.iter_mut().take(3) {
                c.same_duration = kerf_media::probe::probe(tools, &c.path).ok().map(|(_, got)| (got.duration - info.duration).abs() <= 0.1);
            }
        }
    }
    let suggestions = wanted
        .into_iter()
        .zip(found)
        .map(|(a, candidates)| RelinkSuggestion { media: a.id, name: a.name, old_path: a.path, candidates })
        .collect();
    Ok(RelinkSearch { suggestions, scanned: seen, truncated: seen >= MAX_ENTRIES })
}

// --- cache ------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "camelCase")]
pub enum CacheKind {
    Proxies,
    Thumbnails,
    Waveforms,
    Other,
}

fn kind_of(name: &str) -> CacheKind {
    if name.starts_with("proxy.") || name.starts_with("partial_proxy") {
        CacheKind::Proxies
    } else if name == "poster.jpg" || name.starts_with("strip_") {
        CacheKind::Thumbnails
    } else if name == "peaks.u8" {
        CacheKind::Waveforms
    } else {
        CacheKind::Other
    }
}

/// Cache entries are folders named by a 16-digit hex fingerprint; nothing else is touched.
fn is_entry(p: &Path) -> bool {
    p.is_dir() && p.file_name().is_some_and(|n| n.len() == 16 && n.to_string_lossy().chars().all(|c| c.is_ascii_hexdigit()))
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    kind: Option<CacheKind>,
    bytes: u64,
    files: usize,
    /// Of these, not used by the open project.
    unused_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    root: PathBuf,
    kinds: Vec<CacheUsage>,
    total_bytes: u64,
    free_bytes: Option<u64>,
}

fn open_entries(state: &AppState) -> HashSet<PathBuf> {
    let s = lock(&state.session);
    s.project.media.iter().map(|m| analysis::cache_dir(&state.paths.cache, &m.path)).collect()
}

fn scan(root: &Path, mut each: impl FnMut(&Path, &Path, CacheKind, u64)) {
    let Ok(rd) = fs::read_dir(root) else { return };
    for entry in rd.flatten().map(|e| e.path()).filter(|p| is_entry(p)) {
        let Ok(files) = fs::read_dir(&entry) else { continue };
        for f in files.flatten() {
            if f.file_type().is_ok_and(|t| t.is_file()) {
                let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                each(&entry, &f.path(), kind_of(&f.file_name().to_string_lossy()), size);
            }
        }
    }
}

/// Size of Kerf's cache of derived media (proxies, thumbnails, waveforms, reversed sound).
#[tauri::command(async)]
pub fn cache_info(state: State<'_, AppState>) -> CacheInfo {
    let open = open_entries(&state);
    let order = [CacheKind::Proxies, CacheKind::Thumbnails, CacheKind::Waveforms, CacheKind::Other];
    let mut kinds: Vec<CacheUsage> = order.iter().map(|k| CacheUsage { kind: Some(*k), ..Default::default() }).collect();
    scan(&state.paths.cache, |entry, _, kind, size| {
        let u = &mut kinds[order.iter().position(|k| *k == kind).unwrap()];
        u.bytes += size;
        u.files += 1;
        if !open.contains(entry) {
            u.unused_bytes += size;
        }
    });
    let total_bytes = kinds.iter().map(|k| k.bytes).sum();
    CacheInfo { root: state.paths.cache.clone(), kinds, total_bytes, free_bytes: free_space(&state.paths.cache) }
}

/// Deletes cache files of `kinds`. Files of the open project are kept unless
/// `include_open`; then its media is analysed again so they are made anew.
/// Only files inside Kerf's cache folder are ever deleted: never media.
#[tauri::command(async)]
pub fn cache_clear(app: AppHandle, state: State<'_, AppState>, kinds: Vec<CacheKind>, include_open: bool) -> u64 {
    let open = open_entries(&state);
    let mut freed = 0;
    let mut touched_open = false;
    scan(&state.paths.cache, |entry, file, kind, size| {
        if !kinds.contains(&kind) || (!include_open && open.contains(entry)) {
            return;
        }
        if fs::remove_file(file).is_ok() {
            freed += size;
            touched_open |= open.contains(entry);
        } else {
            log::warn!("could not delete cache file {}", file.display());
        }
    });
    // Remove emptied entries.
    if let Ok(rd) = fs::read_dir(&state.paths.cache) {
        for e in rd.flatten().map(|e| e.path()).filter(|p| is_entry(p)) {
            let _ = fs::remove_dir(e); // fails (and keeps it) unless empty
        }
    }
    if touched_open {
        let media = lock(&state.session).project.media.clone();
        let ready: Vec<_> = media.into_iter().filter(|m| m.status == MediaStatus::Ready).collect();
        activate_media(&app, &state, &ready);
    }
    freed
}

// --- metadata ---------------------------------------------------------------------------------

/// Everything ffprobe reports about a media file (format, streams, tags such
/// as timecode, camera make and model), as JSON.
#[tauri::command(async)]
pub fn media_metadata(state: State<'_, AppState>, media: Uuid) -> CmdResult<serde_json::Value> {
    let tools = state.media.tools.clone().ok_or_else(|| CommandError::new("ffmpegMissing", "FFmpeg not found"))?;
    let path = lock(&state.session).project.media(media).ok_or(EditError::MediaNotFound)?.path.clone();
    if !path.is_file() {
        return Err(CommandError::new("mediaOffline", format!("{} is offline", path.display())));
    }
    let out = tools
        .ffprobe_cmd()
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters"])
        .arg(&path)
        .output()
        .map_err(|e| CommandError::new("analysisFailed", e))?;
    if !out.status.success() {
        return Err(CommandError::new("analysisFailed", String::from_utf8_lossy(&out.stderr)));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| CommandError::new("analysisFailed", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_files_are_classified_and_only_fingerprint_folders_count() {
        assert_eq!(kind_of("proxy.mp4"), CacheKind::Proxies);
        assert_eq!(kind_of("strip_40.jpg"), CacheKind::Thumbnails);
        assert_eq!(kind_of("peaks.u8"), CacheKind::Waveforms);
        assert_eq!(kind_of("reversed.m4a"), CacheKind::Other);
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("0123456789abcdef");
        fs::create_dir_all(&entry).unwrap();
        fs::write(entry.join("poster.jpg"), b"x").unwrap();
        let other = dir.path().join("titles");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("poster.jpg"), b"x").unwrap();
        let mut seen = Vec::new();
        scan(dir.path(), |e, _, k, s| seen.push((e.to_path_buf(), k, s)));
        assert_eq!(seen, vec![(entry, CacheKind::Thumbnails, 1)]);
    }
}
