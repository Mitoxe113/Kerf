//! Application state shared by commands and background workers.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::{Mutex, MutexGuard};

use kerf_core::history::{History, ProjectDiff, Side};
use kerf_core::model::Project;
use kerf_core::ops::EditOutcome;
use serde::Serialize;
use uuid::Uuid;

use crate::export_jobs::ExportService;
use crate::media_jobs::MediaService;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Locks a mutex, recovering the data if a worker panicked while holding it.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Session {
    pub project: Project,
    pub history: History,
    pub path: Option<PathBuf>,
    /// Bumped on every document change.
    pub revision: u64,
    pub saved_revision: u64,
    pub autosaved_revision: u64,
}

impl Session {
    pub fn new(project: Project, path: Option<PathBuf>) -> Self {
        Self { project, history: History::default(), path, revision: 0, saved_revision: 0, autosaved_revision: 0 }
    }

    pub fn dirty(&self) -> bool {
        self.revision != self.saved_revision
    }

    pub fn touch(&mut self) {
        self.revision += 1;
        self.project.modified_at = now_ms();
    }

    pub fn history_state(&self) -> HistoryState {
        HistoryState {
            undo: self.history.undo_label().map(str::to_string),
            redo: self.history.redo_label().map(str::to_string),
        }
    }

    pub fn state(&self) -> ProjectState {
        ProjectState {
            project: self.project.clone(),
            path: self.path.clone(),
            dirty: self.dirty(),
            revision: self.revision,
            history: self.history_state(),
        }
    }
}

pub struct AppPaths {
    pub cache: PathBuf,
    pub recovery: PathBuf,
    pub versions: PathBuf,
    /// Freeze frames of projects that have not been saved yet.
    pub stills: PathBuf,
    pub work: PathBuf,
}

/// User preferences the engine needs (sent by the UI at startup and on change).
pub struct Prefs {
    pub autosave_secs: AtomicU64,
    pub keep_versions: AtomicUsize,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { autosave_secs: AtomicU64::new(30), keep_versions: AtomicUsize::new(20) }
    }
}

pub struct AppState {
    pub session: Mutex<Session>,
    pub paths: AppPaths,
    pub prefs: Prefs,
    pub media: MediaService,
    pub exports: ExportService,
    /// Project passed on the command line (double-click on a .kerf file),
    /// taken once by the frontend after it has started.
    pub launch_file: Mutex<Option<std::path::PathBuf>>,
    /// Presets, favourites, recents and assets; `None` when the database
    /// could not be opened (the error is logged and commands report it).
    pub library: Mutex<Option<kerf_library::Library>>,
}

/// The first existing `.kerf` file among command-line arguments
/// (relative paths resolved against `cwd`).
pub fn project_arg<I: IntoIterator<Item = String>>(args: I, cwd: &std::path::Path) -> Option<std::path::PathBuf> {
    args.into_iter()
        .skip(1)
        .map(std::path::PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { cwd.join(p) })
        .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("kerf")) && p.is_file())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryState {
    pub undo: Option<String>,
    pub redo: Option<String>,
}

/// Full project snapshot (open, new, undo/redo).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub project: Project,
    pub path: Option<PathBuf>,
    pub dirty: bool,
    pub revision: u64,
    pub history: HistoryState,
}

/// Minimal update after a change: proportional to what changed, not to the
/// size of the project (see `kerf_core::history::ProjectDiff`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub outcome: EditOutcome,
    pub revision: u64,
    pub dirty: bool,
    pub history: HistoryState,
    pub active_sequence: Uuid,
    #[serde(flatten)]
    pub diff: ProjectDiff,
}

impl Delta {
    /// After `apply`/`redo` the previous state is on the undo side, after `undo` on the redo side.
    pub fn after(s: &Session, outcome: EditOutcome, side: Side) -> Self {
        let diff = if outcome.changed { s.history.diff(side, &s.project).unwrap_or_default() } else { ProjectDiff::default() };
        Self {
            outcome,
            revision: s.revision,
            dirty: s.dirty(),
            history: s.history_state(),
            active_sequence: s.project.active_sequence,
            diff,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_project_argument() {
        let dir = std::env::temp_dir().join(format!("kerf-args-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Film.KERF"), "{}").unwrap();
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // argv[0] is the executable; relative paths are resolved against the caller's folder.
        assert_eq!(project_arg(args(&["kerf.exe", "--flag", "Film.KERF"]), &dir), Some(dir.join("Film.KERF")));
        assert_eq!(project_arg(args(&["Film.KERF"]), &dir), None, "the executable itself is skipped");
        assert_eq!(project_arg(args(&["kerf.exe", "missing.kerf", "clip.mp4"]), &dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
