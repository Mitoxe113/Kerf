//! Project files.
//!
//! Projects are stored as UTF-8 JSON (`.kerf`). Media is referenced by
//! absolute path, never embedded. Writes are atomic (temp file + fsync +
//! rename) and the previous version is kept as `<name>.kerf.bak`, which
//! [`load_with_fallback`] uses when the main file is damaged.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;
use thiserror::Error;

use crate::model::{MediaStatus, Project, SCHEMA_VERSION};

pub const EXTENSION: &str = "kerf";

#[derive(Debug, Error)]
pub enum ProjectIoError {
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("project file is damaged: {0}")]
    Corrupt(String),
    #[error("project was created by a newer version of Kerf (schema {0})")]
    TooNew(u32),
}

pub fn backup_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".bak");
    PathBuf::from(s)
}

/// Serialises and atomically writes `project` to `path`.
pub fn save(project: &Project, path: &Path) -> Result<(), ProjectIoError> {
    let json = serde_json::to_vec_pretty(project).map_err(|e| ProjectIoError::Corrupt(e.to_string()))?;
    write_atomic(path, &json, true)
}

/// Writes `bytes` to `path` via a temp file; optionally keeps the old file as backup.
pub fn write_atomic(path: &Path, bytes: &[u8], keep_backup: bool) -> Result<(), ProjectIoError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    if keep_backup && path.exists() {
        // Best effort: a failed backup must not prevent saving.
        let _ = fs::copy(path, backup_path(path));
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Parses project JSON, migrating older schemas and restoring invariants.
pub fn from_json(bytes: &[u8]) -> Result<Project, ProjectIoError> {
    let mut value: Value = serde_json::from_slice(bytes).map_err(|e| ProjectIoError::Corrupt(e.to_string()))?;
    let version = value.get("schemaVersion").and_then(Value::as_u64).unwrap_or(0) as u32;
    if version > SCHEMA_VERSION {
        return Err(ProjectIoError::TooNew(version));
    }
    migrate(&mut value, version);
    let mut project: Project = serde_json::from_value(value).map_err(|e| ProjectIoError::Corrupt(e.to_string()))?;
    project.schema_version = SCHEMA_VERSION;
    project.normalize();
    Ok(project)
}

/// Upgrades raw JSON from `from` to the current schema. Each schema bump adds
/// one step here so files from every released version stay loadable.
fn migrate(_value: &mut Value, _from: u32) {}

pub fn load(path: &Path) -> Result<Project, ProjectIoError> {
    let bytes = fs::read(path)?;
    let mut project = from_json(&bytes)?;
    refresh_media_status(&mut project);
    Ok(project)
}

/// Loads `path`; if it is damaged, falls back to its backup.
/// Returns the project and whether the backup was used.
pub fn load_with_fallback(path: &Path) -> Result<(Project, bool), ProjectIoError> {
    match load(path) {
        Ok(p) => Ok((p, false)),
        Err(ProjectIoError::Corrupt(msg)) => {
            let bak = backup_path(path);
            if bak.exists() {
                load(&bak).map(|p| (p, true)).map_err(|_| ProjectIoError::Corrupt(msg))
            } else {
                Err(ProjectIoError::Corrupt(msg))
            }
        }
        Err(e) => Err(e),
    }
}

/// Marks media whose file disappeared as missing and re-queues reappeared files.
/// Titles stay ready: the UI renders their PNG again from the definition.
pub fn refresh_media_status(project: &mut Project) {
    for m in project.media.iter_mut().filter(|m| m.title.is_none()) {
        let exists = m.path.is_file();
        match (&m.status, exists) {
            (_, false) => m.status = MediaStatus::Missing,
            (MediaStatus::Missing, true) | (MediaStatus::Analyzing, true) => m.status = MediaStatus::Analyzing,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use uuid::Uuid;

    #[test]
    fn save_and_load_roundtrip_with_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.kerf");
        let mut p = Project::new("Roundtrip", 42);
        save(&p, &path).unwrap();
        p.name = "Second".into();
        save(&p, &path).unwrap();
        assert!(backup_path(&path).exists());
        let loaded = load(&path).unwrap();
        assert_eq!(loaded, p);
    }

    #[test]
    fn damaged_file_falls_back_to_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.kerf");
        let p = Project::new("Good", 1);
        save(&p, &path).unwrap();
        save(&p, &path).unwrap();
        fs::write(&path, b"{ not json").unwrap();
        let (loaded, used_backup) = load_with_fallback(&path).unwrap();
        assert!(used_backup);
        assert_eq!(loaded.name, "Good");
    }

    #[test]
    fn newer_schema_is_rejected() {
        let mut v = serde_json::to_value(Project::new("x", 0)).unwrap();
        v["schemaVersion"] = (SCHEMA_VERSION + 1).into();
        let err = from_json(&serde_json::to_vec(&v).unwrap()).unwrap_err();
        assert!(matches!(err, ProjectIoError::TooNew(_)));
    }

    #[test]
    fn missing_media_is_detected_and_overlaps_are_repaired() {
        let mut p = Project::new("x", 0);
        p.media.push(MediaAsset {
            id: Uuid::new_v4(),
            path: "Z:/definitely/not/here.mp4".into(),
            name: "gone".into(),
            kind: MediaKind::Video,
            status: MediaStatus::Ready,
            info: None,
            bin: None,
            favorite: false,
            label: Default::default(),
            tags: Vec::new(),
            note: String::new(),
            imported_at: 0,
            derived: Derived::default(),
            marks: Default::default(),
            title: None,
        });
        let mid = p.media[0].id;
        let seq = &mut p.sequences[0];
        seq.tracks[0].clips.push(Clip::new(mid, "b", 10, 10, 0));
        seq.tracks[0].clips.push(Clip::new(mid, "a", 0, 15, 0));
        let mut loaded = from_json(&serde_json::to_vec(&p).unwrap()).unwrap();
        refresh_media_status(&mut loaded);
        assert_eq!(loaded.media[0].status, MediaStatus::Missing);
        let clips = &loaded.sequences[0].tracks[0].clips;
        assert_eq!(clips.len(), 1, "overlapping clip dropped");
        assert_eq!(clips[0].name, "a");
    }
}
