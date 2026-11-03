//! Crash recovery.
//!
//! Every `Prefs::autosave_secs` (30 s by default) the current document is written (atomically)
//! to the recovery folder if it changed since the last snapshot. A clean
//! save, close or discard removes the snapshot. Snapshots found at startup
//! belong to sessions that did not end cleanly and are offered for restore.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use kerf_core::model::Project;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::state::{lock, now_ms, AppState};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInfo {
    pub project_id: Uuid,
    pub name: String,
    pub path: Option<PathBuf>,
    pub saved_at: i64,
}

fn files(dir: &Path, id: Uuid) -> (PathBuf, PathBuf) {
    (dir.join(format!("{id}.kerf")), dir.join(format!("{id}.json")))
}

pub fn write(dir: &Path, project: &Project, path: Option<&Path>) -> std::io::Result<()> {
    let (doc, meta) = files(dir, project.id);
    let info = RecoveryInfo { project_id: project.id, name: project.name.clone(), path: path.map(Path::to_path_buf), saved_at: now_ms() };
    let map = |e: kerf_core::io::ProjectIoError| std::io::Error::other(e.to_string());
    kerf_core::io::save(project, &doc).map_err(map)?;
    let _ = fs::remove_file(kerf_core::io::backup_path(&doc));
    kerf_core::io::write_atomic(&meta, &serde_json::to_vec(&info).unwrap_or_default(), false).map_err(map)?;
    Ok(())
}

pub fn discard(dir: &Path, id: Uuid) {
    let (doc, meta) = files(dir, id);
    let _ = fs::remove_file(doc);
    let _ = fs::remove_file(meta);
}

pub fn list(dir: &Path) -> Vec<RecoveryInfo> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<RecoveryInfo> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<RecoveryInfo>(&fs::read(e.path()).ok()?).ok())
        .filter(|i| files(dir, i.project_id).0.is_file())
        .collect();
    out.sort_by_key(|i| std::cmp::Reverse(i.saved_at));
    out
}

pub fn load(dir: &Path, id: Uuid) -> Result<(Project, Option<PathBuf>), String> {
    let (doc, meta) = files(dir, id);
    let info: RecoveryInfo = serde_json::from_slice(&fs::read(meta).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let project = kerf_core::io::load(&doc).map_err(|e| e.to_string())?;
    Ok((project, info.path))
}

/// Background autosave loop.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("kerf-autosave".into())
        .spawn(move || {
            // Ticks every second so a changed interval takes effect right away.
            let mut last = Instant::now();
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let state = app.state::<AppState>();
                if last.elapsed().as_secs() < state.prefs.autosave_secs.load(Ordering::Relaxed) {
                    continue;
                }
                last = Instant::now();
                let snapshot = {
                    let s = lock(&state.session);
                    (s.dirty() && s.revision != s.autosaved_revision).then(|| (s.project.clone(), s.path.clone(), s.revision))
                };
                let Some((project, path, revision)) = snapshot else { continue };
                match write(&state.paths.recovery, &project, path.as_deref()) {
                    Ok(()) => {
                        let mut s = lock(&state.session);
                        if s.project.id == project.id {
                            s.autosaved_revision = revision;
                        }
                        log::debug!("autosaved recovery snapshot r{revision}");
                        let _ = app.emit("autosaved", now_ms());
                    }
                    Err(e) => log::error!("autosave failed: {e}"),
                }
            }
        })
        .expect("spawn autosave");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session that ends without `discard` (a crash) leaves a snapshot that is
    /// listed and restored at the next start; a damaged one is skipped, not fatal.
    #[test]
    fn crashed_session_is_listed_and_restored() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = Project::new("Absturz", 7);
        p.name = "Geändert".into();
        let saved_at = Path::new("/projekte/film.kerf");
        write(dir.path(), &p, Some(saved_at)).unwrap();
        // A second write (next autosave) replaces the first.
        p.name = "Später".into();
        write(dir.path(), &p, Some(saved_at)).unwrap();

        // Damaged leftovers: metadata without document, and garbage metadata.
        std::fs::write(dir.path().join(format!("{}.json", Uuid::new_v4())), b"{}").unwrap();
        std::fs::write(dir.path().join("kaputt.json"), b"\0\0").unwrap();

        let list = list(dir.path());
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].project_id, list[0].name.as_str()), (p.id, "Später"));
        let (restored, path) = load(dir.path(), p.id).unwrap();
        assert_eq!(restored.name, "Später");
        assert_eq!(path.as_deref(), Some(saved_at));

        discard(dir.path(), p.id);
        assert!(super::list(dir.path()).is_empty());
        assert!(load(dir.path(), p.id).is_err());
    }
}
