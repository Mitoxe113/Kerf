//! Project archiving ("collect files"): copies the media and LUTs a project
//! uses into one folder next to a copy of the project whose paths are relative
//! to it, so the folder can be moved or handed on as a whole.
//!
//! Fonts are listed, never copied: whether a font may be passed on depends on
//! its license, which Kerf cannot decide.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::io::{self, ProjectIoError};
use crate::model::{Derived, EffectKind, MediaStatus, Project};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArchiveOptions {
    /// Also copy media that no sequence uses.
    pub include_unused: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveFile {
    pub source: PathBuf,
    /// Path inside the archive folder, `/`-separated.
    pub target: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePlan {
    pub files: Vec<ArchiveFile>,
    /// Referenced files that do not exist (offline media, moved LUTs).
    pub missing: Vec<PathBuf>,
    /// Font families used by titles and subtitles.
    pub fonts: Vec<String>,
    pub total_bytes: u64,
    /// Media left out because no sequence uses it.
    pub unused: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReport {
    pub project_file: PathBuf,
    pub copied: usize,
    pub bytes: u64,
    pub missing: Vec<PathBuf>,
    pub fonts: Vec<String>,
    /// The archived project was read back and every copied file was found with its size.
    pub verified: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("the target folder is not empty")]
    NotEmpty,
    #[error("cancelled")]
    Cancelled,
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Project(#[from] ProjectIoError),
    #[error("{0} was not copied completely")]
    Incomplete(String),
}

/// Ids of media some sequence or multicam group uses.
fn used_media(p: &Project) -> HashSet<uuid::Uuid> {
    let mut used: HashSet<_> = p.sequences.iter().flat_map(|s| s.tracks.iter().flat_map(|t| t.clips.iter().map(|c| c.media_id))).collect();
    used.extend(p.multicams.iter().flat_map(|m| m.angles.iter().map(|a| a.media)));
    used
}

fn file_name(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "datei".into());
    // Keep names portable across Windows, macOS and Linux.
    name.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect()
}

/// A name in `folder` not taken yet (case-insensitively): "a.mp4", "a (2).mp4", …
fn unique(folder: &str, name: &str, taken: &mut HashSet<String>) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut k = 1;
    loop {
        let candidate = if k == 1 { format!("{folder}/{stem}{ext}") } else { format!("{folder}/{stem} ({k}){ext}") };
        if taken.insert(candidate.to_lowercase()) {
            return candidate;
        }
        k += 1;
    }
}

/// What archiving `project` would copy.
pub fn plan(project: &Project, o: &ArchiveOptions) -> ArchivePlan {
    let used = used_media(project);
    let mut out = ArchivePlan::default();
    let mut taken = HashSet::new();
    let mut seen: HashMap<PathBuf, ()> = HashMap::new();
    let mut add = |path: &Path, folder: &str, out: &mut ArchivePlan| {
        if seen.insert(path.to_path_buf(), ()).is_some() {
            return;
        }
        match fs::metadata(path) {
            Ok(m) if m.is_file() => {
                out.total_bytes += m.len();
                out.files.push(ArchiveFile { source: path.to_path_buf(), target: unique(folder, &file_name(path), &mut taken), bytes: m.len() });
            }
            _ => out.missing.push(path.to_path_buf()),
        }
    };
    for m in project.media.iter().filter(|m| m.title.is_none()) {
        if o.include_unused || used.contains(&m.id) {
            add(&m.path, "Media", &mut out);
        } else {
            out.unused += 1;
        }
    }
    for seq in &project.sequences {
        for clip in seq.tracks.iter().flat_map(|t| &t.clips) {
            for e in &clip.effects {
                if let EffectKind::Lut { path, .. } = &e.kind {
                    add(path, "LUTs", &mut out);
                }
            }
        }
    }
    let mut fonts = BTreeSet::new();
    for m in &project.media {
        if let Some(t) = &m.title {
            fonts.insert(t.style.font.clone());
        }
    }
    for s in &project.sequences {
        if !s.subtitles.cues.is_empty() {
            fonts.insert(s.subtitles.style.font.clone());
        }
    }
    out.fonts = fonts.into_iter().filter(|f| !f.trim().is_empty()).collect();
    out
}

/// Copies the planned files into `dest` (new or empty) and writes
/// `<name>.kerf` with paths relative to it. Each file is copied to a `.part`
/// file and renamed once its size matches, so an interrupted archive never
/// shows complete-looking files.
pub fn write(project: &Project, plan: &ArchivePlan, dest: &Path, name: &str, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<ArchiveReport, ArchiveError> {
    if dest.exists() && fs::read_dir(dest)?.next().is_some() {
        return Err(ArchiveError::NotEmpty);
    }
    fs::create_dir_all(dest)?;
    let mut map: HashMap<PathBuf, PathBuf> = HashMap::new();
    let mut done = 0u64;
    for f in &plan.files {
        if cancel.load(Ordering::Relaxed) {
            return Err(ArchiveError::Cancelled);
        }
        let target = dest.join(&f.target);
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir)?;
        }
        let part = target.with_extension(format!("{}.part", target.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()));
        let n = fs::copy(&f.source, &part)?;
        if n != f.bytes || fs::metadata(&part)?.len() != f.bytes {
            let _ = fs::remove_file(&part);
            return Err(ArchiveError::Incomplete(f.source.display().to_string()));
        }
        fs::rename(&part, &target)?;
        map.insert(f.source.clone(), target);
        done += f.bytes;
        progress(done, plan.total_bytes);
    }

    let mut copy = project.clone();
    copy.portable_paths = true;
    io::for_each_path(&mut copy, |p| {
        if let Some(t) = map.get(p) {
            *p = t.clone();
        }
    });
    // Thumbnails, waveforms and proxies are machine-local caches: made again on open.
    for m in copy.media.iter_mut().filter(|m| m.title.is_none()) {
        m.derived = Derived::default();
        m.status = MediaStatus::Analyzing;
    }
    let project_file = dest.join(format!("{}.kerf", file_name(Path::new(name)).trim_end_matches(".kerf")));
    io::save(&copy, &project_file)?;
    fs::write(dest.join("ARCHIV.txt"), readme(project, plan))?;

    // Read the archive back: every copied file must resolve and have its size.
    let back = io::load(&project_file)?;
    let mut verified = true;
    io::for_each_path(&mut back.clone(), |p| {
        if p.starts_with(dest) && !p.is_file() {
            verified = false;
        }
    });
    for f in &plan.files {
        if fs::metadata(dest.join(&f.target)).map(|m| m.len()).ok() != Some(f.bytes) {
            verified = false;
        }
    }
    Ok(ArchiveReport { project_file, copied: plan.files.len(), bytes: done, missing: plan.missing.clone(), fonts: plan.fonts.clone(), verified })
}

fn readme(project: &Project, plan: &ArchivePlan) -> String {
    let mut s = format!("Kerf-Projektarchiv „{}“\n\nDie Projektdatei verweist relativ auf Media/ und LUTs/. Der Ordner kann als Ganzes verschoben werden.\n", project.name);
    s.push_str(&format!("\nKopierte Dateien: {}\n", plan.files.len()));
    if !plan.missing.is_empty() {
        s.push_str("\nNICHT kopiert, weil nicht vorhanden (im Projekt weiter mit dem alten Pfad):\n");
        for m in &plan.missing {
            s.push_str(&format!("  {}\n", m.display()));
        }
    }
    if plan.unused > 0 {
        s.push_str(&format!("\n{} nicht verwendete Medien wurden nicht kopiert.\n", plan.unused));
    }
    if !plan.fonts.is_empty() {
        s.push_str("\nVerwendete Schriften (nicht mitkopiert; ob sie weitergegeben werden dürfen, regelt ihre Lizenz):\n");
        for f in &plan.fonts {
            s.push_str(&format!("  {f}\n"));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use uuid::Uuid;

    fn asset(path: &Path) -> MediaAsset {
        let mut a: MediaAsset = serde_json::from_value(serde_json::json!({
            "id": Uuid::new_v4(), "path": path, "name": "x", "kind": "video", "status": {"state": "ready"}, "importedAt": 0
        }))
        .unwrap();
        a.derived.poster = Some(PathBuf::from("/cache/poster.jpg"));
        a
    }

    #[test]
    fn archives_used_media_and_luts_with_relative_paths() {
        let src = tempfile::tempdir().unwrap();
        let (a, b, gone) = (src.path().join("shot.mp4"), src.path().join("sub").join("shot.mp4"), src.path().join("gone.mp4"));
        fs::create_dir_all(b.parent().unwrap()).unwrap();
        fs::write(&a, b"aaaa").unwrap();
        fs::write(&b, b"bbbbbb").unwrap();
        let lut = src.path().join("look.cube");
        fs::write(&lut, b"LUT_3D_SIZE 2\n").unwrap();
        let unused = src.path().join("unused.mp4");
        fs::write(&unused, b"u").unwrap();

        let mut p = Project::new("Film", 0);
        let (ma, mb, mg, mu) = (asset(&a), asset(&b), asset(&gone), asset(&unused));
        let seq = p.active_sequence;
        let mut v = Track::new(TrackKind::Video, "V1");
        let mut c1 = Clip::new(ma.id, "a", 0, 10, 0);
        c1.effects.push(Effect::new(EffectKind::Lut { path: lut.clone(), intensity: 1.0 }));
        v.clips = vec![c1, Clip::new(mb.id, "b", 10, 10, 0), Clip::new(mg.id, "g", 20, 10, 0)];
        p.sequence_mut(seq).unwrap().tracks = vec![v];
        p.media = vec![ma.clone(), mb.clone(), mg, mu];

        let plan = plan(&p, &ArchiveOptions::default());
        let targets: Vec<&str> = plan.files.iter().map(|f| f.target.as_str()).collect();
        assert_eq!(targets, vec!["Media/shot.mp4", "Media/shot (2).mp4", "LUTs/look.cube"]);
        assert_eq!(plan.missing, vec![gone.clone()]);
        assert_eq!((plan.unused, plan.total_bytes), (1, 4 + 6 + 14));
        assert_eq!(super::plan(&p, &ArchiveOptions { include_unused: true }).files.len(), 4);

        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("Archiv");
        let report = write(&p, &plan, &dest, "Film", &AtomicBool::new(false), |_, _| {}).unwrap();
        assert!(report.verified);
        assert_eq!(fs::read(dest.join("Media/shot (2).mp4")).unwrap(), b"bbbbbb");
        assert!(dest.join("ARCHIV.txt").is_file());
        // Paths are stored relative, the archive moves as a whole.
        let raw = fs::read_to_string(&report.project_file).unwrap();
        assert!(raw.contains("\"Media/shot.mp4\"") && raw.contains("\"LUTs/look.cube\""), "{raw}");
        let moved = out.path().join("Woanders");
        fs::rename(&dest, &moved).unwrap();
        let back = io::load(&moved.join("Film.kerf")).unwrap();
        let paths: Vec<&Path> = back.media.iter().map(|m| m.path.as_path()).collect();
        assert_eq!(paths[0], moved.join("Media/shot.mp4"));
        assert_eq!(paths[2], gone.as_path(), "missing media keeps its old path");
        assert_eq!(back.media[0].status, MediaStatus::Analyzing);
        assert_eq!(back.media[0].derived.poster, None, "caches are made again");
        let lut_back = match &back.sequences[0].tracks[0].clips[0].effects[0].kind {
            EffectKind::Lut { path, .. } => path.clone(),
            _ => unreachable!(),
        };
        assert_eq!(lut_back, moved.join("LUTs/look.cube"));
        // The source project is untouched; a non-empty target is refused.
        assert_eq!(p.media[0].path, a);
        assert!(matches!(write(&p, &plan, &moved, "Film", &AtomicBool::new(false), |_, _| {}), Err(ArchiveError::NotEmpty)));
        assert!(matches!(write(&p, &plan, &out.path().join("neu"), "Film", &AtomicBool::new(true), |_, _| {}), Err(ArchiveError::Cancelled)));
    }
}
