//! Undo/redo.
//!
//! History stores snapshots of the editable document (media, bins, sequences).
//! Snapshots make undo exact by construction. To keep memory proportional to
//! what changed (not to project size x undo depth), unchanged tracks, media and
//! bins are shared between consecutive snapshots via `Arc`.
//! Background analysis results (probe data, thumbnails, proxies) are patched
//! into every snapshot via [`History::patch_media`], so undo never reverts them.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use uuid::Uuid;

use crate::model::{Bin, MediaAsset, Multicam, Project, Sequence, Track, WatchFolder};
use crate::ops::{self, EditCommand, EditOutcome};
use crate::Result;

#[derive(Clone, Debug)]
struct SeqSnap {
    meta: Arc<Sequence>,
    tracks: Vec<Arc<Track>>,
}

#[derive(Clone, Debug)]
struct Snapshot {
    label: String,
    /// When the edit was made (ms since the Unix epoch).
    time: u64,
    media: Arc<Vec<MediaAsset>>,
    bins: Arc<Vec<Bin>>,
    multicams: Arc<Vec<Multicam>>,
    watch_folders: Arc<Vec<WatchFolder>>,
    sequences: Vec<SeqSnap>,
    active_sequence: Uuid,
}

fn share<T: PartialEq + Clone>(value: &T, prev: Option<&Arc<T>>) -> Arc<T> {
    match prev {
        Some(p) if **p == *value => p.clone(),
        _ => Arc::new(value.clone()),
    }
}

impl Snapshot {
    /// Captures `p`, reusing the unchanged parts of `prev`.
    fn capture(label: &str, time: u64, p: &Project, prev: Option<&Snapshot>) -> Self {
        let sequences = p
            .sequences
            .iter()
            .map(|s| {
                let ps = prev.and_then(|ps| ps.sequences.iter().find(|x| x.meta.id == s.id));
                let tracks = s
                    .tracks
                    .iter()
                    .map(|t| share(t, ps.and_then(|ps| ps.tracks.iter().find(|x| x.id == t.id))))
                    .collect();
                let meta = s.clone_without_tracks();
                let meta = match ps {
                    Some(ps) if *ps.meta == meta => ps.meta.clone(),
                    _ => Arc::new(meta),
                };
                SeqSnap { meta, tracks }
            })
            .collect();
        Self {
            label: label.to_string(),
            time,
            media: share(&p.media, prev.map(|s| &s.media)),
            bins: share(&p.bins, prev.map(|s| &s.bins)),
            multicams: share(&p.multicams, prev.map(|s| &s.multicams)),
            watch_folders: share(&p.watch_folders, prev.map(|s| &s.watch_folders)),
            sequences,
            active_sequence: p.active_sequence,
        }
    }

    fn restore(&self, p: &mut Project) {
        p.media = (*self.media).clone();
        p.bins = (*self.bins).clone();
        p.multicams = (*self.multicams).clone();
        p.watch_folders = (*self.watch_folders).clone();
        p.sequences = self
            .sequences
            .iter()
            .map(|s| {
                let mut seq = (*s.meta).clone();
                seq.tracks = s.tracks.iter().map(|t| (**t).clone()).collect();
                seq
            })
            .collect();
        p.active_sequence = self.active_sequence;
        if p.sequence(p.active_sequence).is_none() {
            p.active_sequence = p.sequences[0].id;
        }
    }
}

/// One named step for the history panel.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HistoryEntry {
    pub label: String,
    pub time: u64,
}

/// All steps, oldest first. Steps before `position` are applied; the rest can be redone.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HistoryList {
    pub entries: Vec<HistoryEntry>,
    pub position: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Undo,
    Redo,
}

/// Clip-level changes of one track. `track.clips` is always empty; the UI
/// rebuilds the list from its previous copy, `removed` and `upserted`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackDelta {
    pub track: Track,
    /// The track did not exist before: start from an empty clip list.
    pub new: bool,
    pub removed: Vec<Uuid>,
    pub upserted: Vec<crate::model::Clip>,
}

/// A changed sequence: properties plus every track in order. `sequence.tracks` is empty.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceDelta {
    pub sequence: Sequence,
    pub tracks: Vec<TrackDelta>,
}

/// Minimal description of a document change, proportional to what changed.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiff {
    pub media: Option<Vec<MediaAsset>>,
    pub bins: Option<Vec<Bin>>,
    pub multicams: Option<Vec<Multicam>>,
    pub watch_folders: Option<Vec<WatchFolder>>,
    /// Set when sequences were added, removed or reordered (then `patches` is empty).
    pub sequences: Option<Vec<Sequence>>,
    pub patches: Vec<SequenceDelta>,
}

fn diff(before: &Snapshot, after: &Project) -> ProjectDiff {
    let mut d = ProjectDiff {
        media: (*before.media != after.media).then(|| after.media.clone()),
        bins: (*before.bins != after.bins).then(|| after.bins.clone()),
        multicams: (*before.multicams != after.multicams).then(|| after.multicams.clone()),
        watch_folders: (*before.watch_folders != after.watch_folders).then(|| after.watch_folders.clone()),
        ..Default::default()
    };
    let same_list = before.sequences.len() == after.sequences.len()
        && before.sequences.iter().zip(&after.sequences).all(|(b, a)| b.meta.id == a.id);
    if !same_list {
        d.sequences = Some(after.sequences.clone());
        return d;
    }
    for (b, a) in before.sequences.iter().zip(&after.sequences) {
        let meta = a.clone_without_tracks();
        let tracks_same = b.tracks.len() == a.tracks.len() && b.tracks.iter().zip(&a.tracks).all(|(bt, at)| **bt == *at);
        if *b.meta == meta && tracks_same {
            continue;
        }
        let tracks = a
            .tracks
            .iter()
            .map(|at| {
                let shell = at.clone_without_clips();
                match b.tracks.iter().find(|bt| bt.id == at.id) {
                    None => TrackDelta { track: shell, new: true, removed: Vec::new(), upserted: at.clips.clone() },
                    Some(bt) if bt.clips == at.clips => TrackDelta { track: shell, new: false, removed: Vec::new(), upserted: Vec::new() },
                    Some(bt) => {
                        let old: HashMap<Uuid, &crate::model::Clip> = bt.clips.iter().map(|c| (c.id, c)).collect();
                        let now: std::collections::HashSet<Uuid> = at.clips.iter().map(|c| c.id).collect();
                        TrackDelta {
                            track: shell,
                            new: false,
                            removed: bt.clips.iter().filter(|c| !now.contains(&c.id)).map(|c| c.id).collect(),
                            upserted: at.clips.iter().filter(|c| old.get(&c.id).is_none_or(|o| **o != **c)).cloned().collect(),
                        }
                    }
                }
            })
            .collect();
        d.patches.push(SequenceDelta { sequence: meta, tracks });
    }
    d
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug)]
pub struct History {
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    limit: usize,
}

impl Default for History {
    fn default() -> Self {
        Self::new(200)
    }
}

impl History {
    pub fn new(limit: usize) -> Self {
        Self { undo: Vec::new(), redo: Vec::new(), limit: limit.max(1) }
    }

    /// Applies `cmd` and records an undo step if it changed anything.
    pub fn apply(&mut self, project: &mut Project, cmd: &EditCommand) -> Result<EditOutcome> {
        let before = Snapshot::capture(cmd.label(), now_ms(), project, self.undo.last());
        let outcome = ops::apply(project, cmd)?;
        if outcome.changed {
            self.undo.push(before);
            if self.undo.len() > self.limit {
                self.undo.remove(0);
            }
            self.redo.clear();
        }
        Ok(outcome)
    }

    /// Restores the previous state; returns the label of the undone edit.
    pub fn undo(&mut self, project: &mut Project) -> Option<String> {
        let snap = self.undo.pop()?;
        self.redo.push(Snapshot::capture(&snap.label, snap.time, project, Some(&snap)));
        snap.restore(project);
        Some(snap.label)
    }

    pub fn redo(&mut self, project: &mut Project) -> Option<String> {
        let snap = self.redo.pop()?;
        self.undo.push(Snapshot::capture(&snap.label, snap.time, project, Some(&snap)));
        snap.restore(project);
        Some(snap.label)
    }

    pub fn undo_label(&self) -> Option<&str> {
        self.undo.last().map(|s| s.label.as_str())
    }

    pub fn redo_label(&self) -> Option<&str> {
        self.redo.last().map(|s| s.label.as_str())
    }

    pub fn list(&self) -> HistoryList {
        let entry = |s: &Snapshot| HistoryEntry { label: s.label.clone(), time: s.time };
        HistoryList {
            entries: self.undo.iter().map(entry).chain(self.redo.iter().rev().map(entry)).collect(),
            position: self.undo.len(),
        }
    }

    /// Undoes or redoes until exactly `position` steps are applied.
    /// Returns whether the document changed.
    pub fn goto(&mut self, project: &mut Project, position: usize) -> bool {
        let mut changed = false;
        while self.undo.len() > position && self.undo(project).is_some() {
            changed = true;
        }
        while self.undo.len() < position && self.redo(project).is_some() {
            changed = true;
        }
        changed
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }

    /// Propagates a non-undoable media update (analysis results) into all
    /// snapshots. Snapshots that shared a media list share the patched one.
    pub fn patch_media(&mut self, asset: &MediaAsset) {
        let mut patched: HashMap<*const Vec<MediaAsset>, Arc<Vec<MediaAsset>>> = HashMap::new();
        for snap in self.undo.iter_mut().chain(self.redo.iter_mut()) {
            let key = Arc::as_ptr(&snap.media);
            if let Some(done) = patched.get(&key) {
                snap.media = done.clone();
                continue;
            }
            if snap.media.iter().any(|m| m.id == asset.id) {
                let mut list = (*snap.media).clone();
                if let Some(m) = list.iter_mut().find(|m| m.id == asset.id) {
                    m.status = asset.status.clone();
                    m.info = asset.info.clone();
                    m.kind = asset.kind;
                    m.derived = asset.derived.clone();
                }
                snap.media = Arc::new(list);
            }
            patched.insert(key, snap.media.clone());
        }
    }

    /// What changed between the snapshot pushed last on `side` and `after`.
    /// After `apply` and `redo` the pre-change state is on the undo side,
    /// after `undo` it is on the redo side.
    pub fn diff(&self, side: Side, after: &Project) -> Option<ProjectDiff> {
        let before = match side {
            Side::Undo => self.undo.last(),
            Side::Redo => self.redo.last(),
        }?;
        Some(diff(before, after))
    }

    /// Distinct track allocations held by the history (diagnostics and tests).
    pub fn distinct_tracks(&self) -> usize {
        let mut seen = std::collections::HashSet::new();
        for s in self.undo.iter().chain(self.redo.iter()) {
            for q in &s.sequences {
                for t in &q.tracks {
                    seen.insert(Arc::as_ptr(t));
                }
            }
        }
        seen.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use crate::ops::{PlaceMode, TrackPatch};

    fn asset() -> MediaAsset {
        MediaAsset {
            id: Uuid::new_v4(),
            path: "a.wav".into(),
            name: "a".into(),
            kind: MediaKind::Audio,
            status: MediaStatus::Analyzing,
            info: None,
            bin: None,
            favorite: false,
            label: Default::default(),
            tags: Vec::new(),
            note: String::new(),
            imported_at: 0,
            derived: Derived::default(),
            marks: Default::default(),
            matrix: Default::default(),
            title: None,
        }
    }

    #[test]
    fn undo_redo_roundtrip() {
        let mut p = Project::new("t", 0);
        let mut h = History::default();
        let a = asset();
        let id = a.id;
        h.apply(&mut p, &EditCommand::ImportMedia { assets: vec![a] }).unwrap();
        let seq = p.active_sequence;
        h.apply(&mut p, &EditCommand::AddMarker { sequence: seq, frame: 5, name: "m".into(), color: MarkerColor::Signal })
            .unwrap();
        assert_eq!(h.undo_label(), Some("addMarker"));
        assert_eq!(h.undo(&mut p).as_deref(), Some("addMarker"));
        assert!(p.sequence(seq).unwrap().markers.is_empty());
        assert_eq!(h.redo(&mut p).as_deref(), Some("addMarker"));
        assert_eq!(p.sequence(seq).unwrap().markers.len(), 1);
        h.undo(&mut p);
        h.undo(&mut p);
        assert!(p.media(id).is_none());
        assert!(h.undo(&mut p).is_none());
    }

    #[test]
    fn no_op_edits_are_not_recorded() {
        let mut p = Project::new("t", 0);
        let mut h = History::default();
        let seq = p.active_sequence;
        h.apply(&mut p, &EditCommand::SplitAt { sequence: seq, frame: 10, clips: None }).unwrap();
        assert!(h.undo_label().is_none());
    }

    #[test]
    fn analysis_results_survive_undo() {
        let mut p = Project::new("t", 0);
        let mut h = History::default();
        let a = asset();
        let id = a.id;
        h.apply(&mut p, &EditCommand::ImportMedia { assets: vec![a] }).unwrap();
        let seq = p.active_sequence;
        h.apply(&mut p, &EditCommand::AddMarker { sequence: seq, frame: 1, name: String::new(), color: MarkerColor::Red })
            .unwrap();

        // Analysis finishes in the background.
        let m = p.media_mut(id).unwrap();
        m.status = MediaStatus::Ready;
        m.info = Some(MediaInfo {
            duration: 2.0,
            size_bytes: 10,
            container: "wav".into(),
            bit_rate: None,
            video: None,
            audio: Some(AudioInfo { codec: "pcm_s16le".into(), channels: 2, sample_rate: 48_000, channel_layout: None, bit_rate: None }),
        });
        let updated = m.clone();
        h.patch_media(&updated);

        h.undo(&mut p);
        assert_eq!(p.media(id).unwrap().status, MediaStatus::Ready);
        // The media can be placed after undo, i.e. the restored state is consistent.
        h.apply(
            &mut p,
            &EditCommand::PlaceMedia {
                sequence: seq,
                media: id,
                video_track: None,
                audio_track: None,
                at: 0,
                mode: PlaceMode::Overwrite,
                source_in: None,
                source_out: None,
                match_sequence: false,
            },
        )
        .unwrap();
    }

    #[test]
    fn limit_drops_oldest_steps() {
        let mut p = Project::new("t", 0);
        let mut h = History::new(3);
        let seq = p.active_sequence;
        for f in 0..5 {
            h.apply(&mut p, &EditCommand::AddMarker { sequence: seq, frame: f, name: String::new(), color: MarkerColor::Blue })
                .unwrap();
        }
        let mut steps = 0;
        while h.undo(&mut p).is_some() {
            steps += 1;
        }
        assert_eq!(steps, 3);
        assert_eq!(p.sequence(seq).unwrap().markers.len(), 2);
    }

    #[test]
    fn unchanged_tracks_are_shared_between_snapshots() {
        let mut p = Project::new("t", 0);
        let mut h = History::default();
        let seq = p.active_sequence;
        let tracks = p.sequence(seq).unwrap().tracks.len();
        // Marker edits never touch tracks: every snapshot shares the same tracks.
        for f in 0..50 {
            h.apply(&mut p, &EditCommand::AddMarker { sequence: seq, frame: f, name: String::new(), color: MarkerColor::Blue })
                .unwrap();
        }
        assert_eq!(h.distinct_tracks(), tracks);
        // An edit to one track allocates exactly one new track.
        h.apply(&mut p, &EditCommand::AddTrack { sequence: seq, kind: TrackKind::Video }).unwrap();
        let v1 = p.sequence(seq).unwrap().tracks[0].id;
        h.apply(&mut p, &EditCommand::UpdateTrack { sequence: seq, track: v1, patch: TrackPatch { name: Some("Haupt".into()), ..Default::default() } })
            .unwrap();
        // Snapshots hold the 4 shared tracks plus the new one; the renamed V1 lives only in the document.
        assert_eq!(h.distinct_tracks(), tracks + 1);
        // Undo/redo round trips keep sharing and restore exact state.
        let after = p.clone();
        while h.undo(&mut p).is_some() {}
        assert!(p.sequence(seq).unwrap().markers.is_empty());
        while h.redo(&mut p).is_some() {}
        assert_eq!(p.sequences, after.sequences);
        assert!(h.distinct_tracks() <= tracks + 3);
    }

    #[test]
    fn diff_contains_only_changed_clips() {
        let mut p = Project::new("t", 0);
        let mut h = History::default();
        let a = asset();
        let id = a.id;
        h.apply(&mut p, &EditCommand::ImportMedia { assets: vec![a] }).unwrap();
        let m = p.media_mut(id).unwrap();
        m.status = MediaStatus::Ready;
        m.info = Some(MediaInfo {
            duration: 60.0,
            size_bytes: 10,
            container: "wav".into(),
            bit_rate: None,
            video: None,
            audio: Some(AudioInfo { codec: "pcm_s16le".into(), channels: 2, sample_rate: 48_000, channel_layout: None, bit_rate: None }),
        });
        let seq = p.active_sequence;
        for i in 0..20 {
            h.apply(
                &mut p,
                &EditCommand::PlaceMedia {
                    sequence: seq,
                    media: id,
                    video_track: None,
                    audio_track: None,
                    at: i * 30,
                    mode: PlaceMode::Overwrite,
                    source_in: Some(0),
                    source_out: Some(25),
                    match_sequence: false,
                },
            )
            .unwrap();
        }
        let a1 = p.sequence(seq).unwrap().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().id;
        let target = p.sequence(seq).unwrap().track(a1).unwrap().clips[7].id;
        h.apply(&mut p, &EditCommand::MoveClips { sequence: seq, clips: vec![target], delta: 2, track_delta: 0, track_kind: None })
            .unwrap();

        let d = h.diff(Side::Undo, &p).unwrap();
        assert!(d.media.is_none() && d.bins.is_none() && d.sequences.is_none());
        assert_eq!(d.patches.len(), 1);
        let changed: Vec<_> = d.patches[0].tracks.iter().filter(|t| !t.upserted.is_empty() || !t.removed.is_empty()).collect();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].upserted.len(), 1, "only the moved clip is sent");
        assert_eq!(changed[0].upserted[0].id, target);
        assert!(d.patches[0].tracks.iter().all(|t| t.track.clips.is_empty() && !t.new));

        // Undo: the diff against the redo side describes the reverse change.
        h.undo(&mut p);
        let d = h.diff(Side::Redo, &p).unwrap();
        let t = d.patches[0].tracks.iter().find(|t| t.track.id == a1).unwrap();
        assert_eq!(t.upserted.len(), 1);
        assert_eq!(t.upserted[0].start, 7 * 30);

        // Deleting reports removed ids; adding a track reports it as new with all clips.
        h.apply(&mut p, &EditCommand::DeleteClips { sequence: seq, clips: vec![target], ripple: false }).unwrap();
        let d = h.diff(Side::Undo, &p).unwrap();
        assert!(d.patches[0].tracks.iter().any(|t| t.removed == vec![target]));
        h.apply(&mut p, &EditCommand::AddTrack { sequence: seq, kind: TrackKind::Audio }).unwrap();
        let d = h.diff(Side::Undo, &p).unwrap();
        assert_eq!(d.patches[0].tracks.iter().filter(|t| t.new).count(), 1);
    }

    #[test]
    fn list_and_goto_jump_to_any_step() {
        let mut p = Project::new("t", 0);
        let mut h = History::default();
        let seq = p.active_sequence;
        for f in 0..5 {
            h.apply(&mut p, &EditCommand::AddMarker { sequence: seq, frame: f, name: String::new(), color: MarkerColor::Red })
                .unwrap();
        }
        let l = h.list();
        assert_eq!(l.entries.len(), 5);
        assert_eq!(l.position, 5);
        assert!(l.entries.iter().all(|e| e.label == "addMarker" && e.time > 0));

        assert!(h.goto(&mut p, 2));
        assert_eq!(p.sequence(seq).unwrap().markers.len(), 2);
        assert_eq!(h.list().position, 2);
        assert_eq!(h.list().entries.len(), 5, "redo steps stay listed");

        assert!(h.goto(&mut p, 4));
        assert_eq!(p.sequence(seq).unwrap().markers.len(), 4);
        assert!(!h.goto(&mut p, 4));
        assert!(h.goto(&mut p, 0));
        assert!(p.sequence(seq).unwrap().markers.is_empty());
        // Clamped to the available range.
        h.goto(&mut p, 99);
        assert_eq!(p.sequence(seq).unwrap().markers.len(), 5);
    }
}
