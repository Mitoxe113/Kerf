//! Editing engine.
//!
//! Every mutation of a project is expressed as an [`EditCommand`] and applied
//! through [`apply`]. Commands are atomic: sequence edits run on a copy that
//! is only committed when the whole command succeeded.
//!
//! Interactive edits (trim, roll, slip, slide) clamp the requested delta to
//! what the media and neighbouring clips allow instead of failing, so a drag
//! that overshoots simply stops at the limit, as editors expect.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{EditError, Result};
use crate::model::*;
use crate::text::clean_cues;
use crate::time::{Frame, Rational};
use crate::timemap::{MAX_SPEED, MIN_SPEED};

/// Default timeline length of a still image.
pub const DEFAULT_STILL_SECONDS: f64 = 5.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Edge {
    Start,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaceMode {
    /// Replace whatever is under the new clip.
    Overwrite,
    /// Push everything at and after the insert point to the right on all unlocked tracks.
    Insert,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackPatch {
    pub name: Option<String>,
    pub muted: Option<bool>,
    pub solo: Option<bool>,
    pub locked: Option<bool>,
    pub hidden: Option<bool>,
    pub volume_db: Option<f32>,
    pub color: Option<LabelColor>,
    /// Row height in px; 0 resets to the timeline default.
    pub height: Option<u16>,
    /// Audio tracks: effects on the track mix.
    pub effects: Option<Vec<AudioEffect>>,
    pub mono: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaPatch {
    pub favorite: Option<bool>,
    pub label: Option<LabelColor>,
    pub tags: Option<Vec<String>>,
    pub note: Option<String>,
    /// Only for videos whose tag is BT.601, BT.709 or missing (see [`VideoInfo::tagged_ycc`]).
    pub matrix: Option<MatrixChoice>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClipPatch {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub transform: Option<Transform>,
    pub opacity: Option<f32>,
    pub volume_db: Option<f32>,
    pub pan: Option<f32>,
    pub speed: Option<f64>,
    pub fade_in: Option<Frame>,
    pub fade_out: Option<Frame>,
    pub color: Option<ColorAdjust>,
    pub label: Option<LabelColor>,
    pub channels: Option<ChannelMap>,
    pub reverse: Option<bool>,
    /// Skips the effect stack without changing it.
    pub fx_bypass: Option<bool>,
    pub blend_mode: Option<BlendMode>,
    /// Noise reduction (audio clips); `enabled: false` turns it off and keeps the settings.
    pub denoise: Option<Denoise>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MarkerPatch {
    pub frame: Option<Frame>,
    pub name: Option<String>,
    pub note: Option<String>,
    pub color: Option<MarkerColor>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub duration: Option<Frame>,
    #[serde(default)]
    pub chapter: Option<bool>,
}

/// One marker of [`EditCommand::AddMarkers`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMarker {
    pub frame: Frame,
    pub name: String,
    #[serde(default)]
    pub note: String,
    pub color: MarkerColor,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub duration: Frame,
    #[serde(default)]
    pub chapter: bool,
}

/// Undo label of a [`EditCommand::Batch`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchLabel {
    SceneCuts,
    RemoveSilence,
    Ducking,
    AnalysisMarkers,
    RelinkMedia,
    /// Tags added to or removed from several media.
    MediaTags,
}

impl BatchLabel {
    pub fn as_str(self) -> &'static str {
        match self {
            BatchLabel::SceneCuts => "sceneCuts",
            BatchLabel::RemoveSilence => "removeSilence",
            BatchLabel::Ducking => "ducking",
            BatchLabel::AnalysisMarkers => "analysisMarkers",
            BatchLabel::RelinkMedia => "relinkMedia",
            BatchLabel::MediaTags => "mediaTags",
        }
    }
}

/// Longest marker category.
const MAX_CATEGORY: usize = 40;
/// Longest tag, most tags and longest note of a medium.
pub const MAX_TAG: usize = 60;
pub const MAX_TAGS: usize = 64;
pub const MAX_NOTE: usize = 10_000;

/// Trimmed, one line, at most `max` characters.
fn clean_line(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(max).collect::<String>().trim_end().to_string()
}

fn category(s: &str) -> String {
    s.trim().chars().filter(|c| !c.is_control()).take(MAX_CATEGORY).collect()
}

/// New static gain of one audio clip (see [`EditCommand::SetClipGain`]).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipGain {
    pub clip: Uuid,
    pub volume_db: f32,
    /// Also ends the clip's effects with a limiter holding the clip's output
    /// at this ceiling (dBFS), replacing a limiter that already ends them.
    /// The effects run before the clip volume, so the limiter's own ceiling
    /// is this minus the new volume.
    #[serde(default)]
    pub limit_db: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEffectsEdit {
    pub clip: Uuid,
    pub effects: Vec<AudioEffect>,
}

/// A clip on the clipboard together with where it came from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteItem {
    pub clip: Clip,
    pub track: Uuid,
    pub kind: TrackKind,
    /// Frame rate the clip's frames are counted in (the sequence it was
    /// copied from); pasting into another rate converts them. None: the
    /// target's rate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<Rational>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionEdit {
    pub clip: Uuid,
    pub transition: Option<Transition>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EditCommand {
    // --- media & bins -----------------------------------------------------
    ImportMedia { assets: Vec<MediaAsset> },
    RemoveMedia { media: Vec<Uuid> },
    RenameMedia { media: Uuid, name: String },
    SetMediaFavorite { media: Vec<Uuid>, favorite: bool },
    UpdateMedia { media: Vec<Uuid>, patch: MediaPatch },
    /// In/Out of the source monitor (seconds of media time), saved with the project.
    SetSourceMarks { media: Uuid, marks: SourceMarks },
    MoveMediaToBin { media: Vec<Uuid>, bin: Option<Uuid> },
    RelinkMedia { media: Uuid, path: PathBuf },
    /// Changes a title's definition and its rendered PNG.
    UpdateTitle { media: Uuid, title: TitleSpec, path: PathBuf },
    /// With `smart` rules the bin is a smart bin (see [`Bin::smart`]).
    CreateBin {
        name: String,
        parent: Option<Uuid>,
        #[serde(default)]
        smart: Option<SmartRules>,
    },
    /// Replaces the rules of a smart bin.
    SetSmartRules { bin: Uuid, rules: SmartRules },
    RenameBin { bin: Uuid, name: String },
    RemoveBin { bin: Uuid },
    /// Watches `path` for new media files that go into `bin` (the app scans
    /// it). `created` = [the watch folder's id].
    AddWatchFolder {
        path: PathBuf,
        bin: Option<Uuid>,
        #[serde(default)]
        subfolders: bool,
    },
    RemoveWatchFolder { id: Uuid },

    // --- sequences --------------------------------------------------------
    AddSequence { name: String, settings: SequenceSettings },
    RemoveSequence { sequence: Uuid },
    RenameSequence { sequence: Uuid, name: String },
    /// Moves `clips` (with their linked partners) of `sequence` into a new
    /// sequence named `name` and puts one clip of it where they were (video
    /// and audio, linked). `created` = [new sequence, its clips].
    NestClips { sequence: Uuid, clips: Vec<Uuid>, name: String },
    UpdateSequenceSettings { sequence: Uuid, settings: SequenceSettings },

    // --- tracks -----------------------------------------------------------
    AddTrack { sequence: Uuid, kind: TrackKind },
    RemoveTrack { sequence: Uuid, track: Uuid },
    UpdateTrack { sequence: Uuid, track: Uuid, patch: TrackPatch },

    // --- clips ------------------------------------------------------------
    PlaceMedia {
        sequence: Uuid,
        media: Uuid,
        #[serde(default)]
        video_track: Option<Uuid>,
        #[serde(default)]
        audio_track: Option<Uuid>,
        at: Frame,
        mode: PlaceMode,
        #[serde(default)]
        source_in: Option<Frame>,
        #[serde(default)]
        source_out: Option<Frame>,
        /// Adopt the media's resolution and frame rate if the sequence is empty.
        #[serde(default)]
        match_sequence: bool,
    },
    MoveClips {
        sequence: Uuid,
        clips: Vec<Uuid>,
        delta: Frame,
        #[serde(default)]
        track_delta: i32,
        /// Track kind `track_delta` applies to; clips of the other kind keep their track.
        #[serde(default)]
        track_kind: Option<TrackKind>,
    },
    TrimClip { sequence: Uuid, clip: Uuid, edge: Edge, delta: Frame, ripple: bool, #[serde(default = "yes")] linked: bool },
    /// Moves the edit point at the end of `clip` and the start of its right neighbour.
    RollEdit { sequence: Uuid, clip: Uuid, delta: Frame, #[serde(default = "yes")] linked: bool },
    SlipClip { sequence: Uuid, clip: Uuid, delta: Frame, #[serde(default = "yes")] linked: bool },
    SlideClip { sequence: Uuid, clip: Uuid, delta: Frame, #[serde(default = "yes")] linked: bool },
    /// Razor at `frame`; `clips: None` cuts through every unlocked track.
    SplitAt { sequence: Uuid, frame: Frame, #[serde(default)] clips: Option<Vec<Uuid>> },
    DeleteClips { sequence: Uuid, clips: Vec<Uuid>, ripple: bool },
    /// Lift (`ripple: false`, the gap stays) or extract (`ripple: true`) the
    /// range `start..end` on every unlocked track, or only on `tracks`.
    RemoveRange { sequence: Uuid, start: Frame, end: Frame, ripple: bool, #[serde(default)] tracks: Option<Vec<Uuid>> },
    /// Adds a still (e.g. a freeze frame) to the project and inserts it at `at`
    /// on `track`, rippling all unlocked tracks. One undo step.
    InsertStill { sequence: Uuid, asset: Box<MediaAsset>, track: Uuid, at: Frame, duration: Frame },
    /// Adds a title asset to the project and places it at `at` on `track`
    /// (overwriting what is there). One undo step.
    AddTitle { sequence: Uuid, asset: Box<MediaAsset>, track: Uuid, at: Frame, duration: Frame },
    /// Swaps the media of a clip (and its linked partners) keeping position and length.
    ReplaceMedia { sequence: Uuid, clip: Uuid, media: Uuid },
    CloseGap { sequence: Uuid, track: Uuid, frame: Frame },
    PasteClips { sequence: Uuid, items: Vec<PasteItem>, at: Frame },
    DuplicateClips { sequence: Uuid, clips: Vec<Uuid> },
    UpdateClips { sequence: Uuid, clips: Vec<Uuid>, patch: ClipPatch },
    /// Replaces the keys of one animated property (empty = not animated).
    SetKeyframes { sequence: Uuid, clip: Uuid, param: Param, keys: Vec<Keyframe> },
    /// Replaces the effect stack of video clips (each gets its own copy).
    SetEffects { sequence: Uuid, clips: Vec<Uuid>, effects: Vec<Effect> },
    /// Appends effects to the stack of each video clip (each clip keeps its
    /// own stack; every appended effect gets a fresh id per clip).
    AddEffects { sequence: Uuid, clips: Vec<Uuid>, effects: Vec<Effect> },
    /// Sets or removes the transition into each clip from its left neighbour.
    SetTransitions { sequence: Uuid, items: Vec<TransitionEdit> },
    /// Replaces the audio effects of audio clips, each with its own list.
    SetAudioEffects { sequence: Uuid, items: Vec<AudioEffectsEdit> },
    /// Sets the gain of several audio clips in one step (normalizing); volume
    /// keyframes move by the same amount.
    SetClipGain { sequence: Uuid, gains: Vec<ClipGain> },
    LinkClips { sequence: Uuid, clips: Vec<Uuid> },
    UnlinkClips { sequence: Uuid, clips: Vec<Uuid> },

    // --- multicam ------------------------------------------------------------
    /// Adds a group of synced angles (offsets are made relative to the earliest).
    CreateMulticam { multicam: Multicam },
    /// Places the time all chosen angles cover: the picture of `video_angle`
    /// and the sound of `audio_angle` (none = no sound), linked.
    PlaceMulticam {
        sequence: Uuid,
        multicam: Uuid,
        at: Frame,
        mode: PlaceMode,
        video_angle: usize,
        #[serde(default)]
        audio_angle: Option<usize>,
        #[serde(default)]
        video_track: Option<Uuid>,
        #[serde(default)]
        audio_track: Option<Uuid>,
    },
    /// Shows `angle` in a multicam clip, from `at` on (the clip is cut there)
    /// or in all of it when `at` is not inside it.
    SwitchAngle { sequence: Uuid, clip: Uuid, angle: usize, #[serde(default)] at: Option<Frame> },

    // --- markers & range ---------------------------------------------------
    AddMarker { sequence: Uuid, frame: Frame, name: String, color: MarkerColor },
    UpdateMarker { sequence: Uuid, marker: Uuid, patch: MarkerPatch },
    RemoveMarker { sequence: Uuid, marker: Uuid },
    /// Adds several markers in one step (analysis results).
    AddMarkers { sequence: Uuid, markers: Vec<NewMarker> },
    /// Removes several markers in one step; unknown ids are an error.
    RemoveMarkers { sequence: Uuid, markers: Vec<Uuid> },
    SetInOut { sequence: Uuid, in_point: Option<Frame>, out_point: Option<Frame> },

    // --- subtitles -----------------------------------------------------------
    /// Replaces all cues (sorted and de-overlapped).
    SetSubtitles { sequence: Uuid, cues: Vec<Cue> },
    SetSubtitleStyle { sequence: Uuid, style: TextStyle, margin: f32, visible: bool },

    // --- grouped ---------------------------------------------------------------
    /// Applies `commands` in order as one undo step; all or nothing. Batches do not nest.
    Batch { label: BatchLabel, commands: Vec<EditCommand> },
}

impl EditCommand {
    /// Stable key describing the command (used for undo/redo labels).
    pub fn label(&self) -> &'static str {
        use EditCommand as C;
        match self {
            C::ImportMedia { .. } => "importMedia",
            C::RemoveMedia { .. } => "removeMedia",
            C::RenameMedia { .. } => "renameMedia",
            C::SetMediaFavorite { .. } => "setMediaFavorite",
            C::UpdateMedia { .. } => "updateMedia",
            C::SetSourceMarks { .. } => "setSourceMarks",
            C::MoveMediaToBin { .. } => "moveMediaToBin",
            C::RelinkMedia { .. } => "relinkMedia",
            C::UpdateTitle { .. } => "editTitle",
            C::CreateBin { .. } => "createBin",
            C::RenameBin { .. } => "renameBin",
            C::RemoveBin { .. } => "removeBin",
            C::SetSmartRules { .. } => "setSmartRules",
            C::AddWatchFolder { .. } => "addWatchFolder",
            C::RemoveWatchFolder { .. } => "removeWatchFolder",
            C::AddSequence { .. } => "addSequence",
            C::NestClips { .. } => "nestClips",
            C::CreateMulticam { .. } => "createMulticam",
            C::PlaceMulticam { .. } => "placeMulticam",
            C::SwitchAngle { .. } => "switchAngle",
            C::RemoveSequence { .. } => "removeSequence",
            C::RenameSequence { .. } => "renameSequence",
            C::UpdateSequenceSettings { .. } => "updateSequenceSettings",
            C::AddTrack { .. } => "addTrack",
            C::RemoveTrack { .. } => "removeTrack",
            C::UpdateTrack { .. } => "updateTrack",
            C::PlaceMedia { .. } => "placeMedia",
            C::MoveClips { .. } => "moveClips",
            C::TrimClip { .. } => "trimClip",
            C::RollEdit { .. } => "rollEdit",
            C::SlipClip { .. } => "slipClip",
            C::SlideClip { .. } => "slideClip",
            C::SplitAt { .. } => "splitAt",
            C::DeleteClips { .. } => "deleteClips",
            C::RemoveRange { ripple: false, .. } => "liftRange",
            C::RemoveRange { ripple: true, .. } => "extractRange",
            C::ReplaceMedia { .. } => "replaceMedia",
            C::InsertStill { .. } => "insertStill",
            C::AddTitle { .. } => "addTitle",
            C::CloseGap { .. } => "closeGap",
            C::PasteClips { .. } => "pasteClips",
            C::DuplicateClips { .. } => "duplicateClips",
            C::UpdateClips { .. } => "updateClips",
            C::SetKeyframes { .. } => "setKeyframes",
            C::SetEffects { .. } => "setEffects",
            C::AddEffects { .. } => "addEffects",
            C::SetTransitions { .. } => "setTransition",
            C::SetAudioEffects { .. } => "setAudioEffects",
            C::SetClipGain { .. } => "normalizeAudio",
            C::LinkClips { .. } => "linkClips",
            C::UnlinkClips { .. } => "unlinkClips",
            C::AddMarker { .. } => "addMarker",
            C::UpdateMarker { .. } => "updateMarker",
            C::RemoveMarker { .. } => "removeMarker",
            C::AddMarkers { .. } => "addMarkers",
            C::RemoveMarkers { .. } => "removeMarkers",
            C::Batch { label, .. } => label.as_str(),
            C::SetInOut { .. } => "setInOut",
            C::SetSubtitles { .. } => "editSubtitles",
            C::SetSubtitleStyle { .. } => "subtitleStyle",
        }
    }

    /// The sequence a sequence-scoped command edits.
    fn sequence_id(&self) -> Option<Uuid> {
        use EditCommand as C;
        match self {
            C::AddTrack { sequence, .. }
            | C::RemoveTrack { sequence, .. }
            | C::UpdateTrack { sequence, .. }
            | C::PlaceMedia { sequence, .. }
            | C::MoveClips { sequence, .. }
            | C::TrimClip { sequence, .. }
            | C::RollEdit { sequence, .. }
            | C::SlipClip { sequence, .. }
            | C::SlideClip { sequence, .. }
            | C::SplitAt { sequence, .. }
            | C::DeleteClips { sequence, .. }
            | C::RemoveRange { sequence, .. }
            | C::ReplaceMedia { sequence, .. }
            | C::CloseGap { sequence, .. }
            | C::PasteClips { sequence, .. }
            | C::DuplicateClips { sequence, .. }
            | C::UpdateClips { sequence, .. }
            | C::SetKeyframes { sequence, .. }
            | C::SetEffects { sequence, .. }
            | C::AddEffects { sequence, .. }
            | C::SetTransitions { sequence, .. }
            | C::SetAudioEffects { sequence, .. }
            | C::SetClipGain { sequence, .. }
            | C::LinkClips { sequence, .. }
            | C::UnlinkClips { sequence, .. }
            | C::AddMarker { sequence, .. }
            | C::UpdateMarker { sequence, .. }
            | C::RemoveMarker { sequence, .. }
            | C::AddMarkers { sequence, .. }
            | C::RemoveMarkers { sequence, .. }
            | C::SetInOut { sequence, .. }
            | C::SetSubtitles { sequence, .. }
            | C::SetSubtitleStyle { sequence, .. }
            | C::UpdateSequenceSettings { sequence, .. } => Some(*sequence),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub label: String,
    /// False when the command was valid but had no effect (e.g. a clamped trim).
    pub changed: bool,
    /// Sequence whose content changed.
    pub sequence: Option<Uuid>,
    /// True when the media list, bins or watch folders changed.
    pub media_changed: bool,
    /// True when sequences were added, removed or renamed.
    pub sequences_changed: bool,
    /// Ids created by the edit (clips, tracks, markers, bins, sequences).
    pub created: Vec<Uuid>,
}

/// Absolute on this or another system (`/x`, `C:\x`, `C:/x`, `\\server\x`): a
/// project saved on Windows keeps its paths when it is opened elsewhere.
fn absolute_path(p: &std::path::Path) -> bool {
    let s = p.to_string_lossy();
    let b = s.as_bytes();
    p.is_absolute() || s.starts_with('/') || s.starts_with("\\\\") || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
}

/// Applies `cmd` to `project`. On error the project is left untouched.
pub fn apply(project: &mut Project, cmd: &EditCommand) -> Result<EditOutcome> {
    use EditCommand as C;
    let mut out = EditOutcome { label: cmd.label().to_string(), ..Default::default() };

    if let C::Batch { commands, .. } = cmd {
        if commands.iter().any(|c| matches!(c, C::Batch { .. })) {
            return Err(EditError::Invalid("batches do not nest".into()));
        }
        // Work on a copy so a failing step leaves the project untouched.
        let mut work = project.clone();
        for c in commands {
            let o = apply(&mut work, c)?;
            out.changed |= o.changed;
            out.media_changed |= o.media_changed;
            out.sequences_changed |= o.sequences_changed;
            out.sequence = out.sequence.or(o.sequence);
            out.created.extend(o.created);
        }
        if out.changed {
            *project = work;
        }
        return Ok(out);
    }

    if let C::PlaceMulticam { sequence, .. } | C::SwitchAngle { sequence, .. } = cmd {
        return multicam_edit(project, *sequence, cmd, out);
    }
    if let Some(seq_id) = cmd.sequence_id() {
        if let C::PlaceMedia { media, .. } | C::ReplaceMedia { media, .. } = cmd {
            if project.sequence(*media).is_some() && project.nests(*media, seq_id) {
                return Err(EditError::NestCycle);
            }
        }
        let mut seq = project.sequence(seq_id).ok_or(EditError::SequenceNotFound)?.clone();
        // Other sequences can be placed like media (nested sequences).
        let sources = if project.sequences.len() > 1 { std::borrow::Cow::Owned(project.sources_for(seq_id)) } else { std::borrow::Cow::Borrowed(&project.media[..]) };
        let changed = edit_sequence(&mut seq, &sources, cmd, &mut out)?;
        if changed {
            // Moves, trims and deletes can separate the clips of a transition.
            seq.tracks.iter_mut().for_each(|t| {
                t.tidy_transitions();
            });
            *project.sequence_mut(seq_id).expect("sequence exists") = seq;
            out.sequence = Some(seq_id);
            out.changed = true;
        }
        return Ok(out);
    }

    match cmd {
        C::ImportMedia { assets } => {
            if assets.iter().any(|a| project.media(a.id).is_some()) {
                return Err(EditError::Invalid("duplicate media id".into()));
            }
            let held: Vec<MediaAsset> = assets.iter().map(|a| MediaAsset { bin: holding_bin(project, a.bin), ..a.clone() }).collect();
            project.media.extend(held);
            out.created = assets.iter().map(|a| a.id).collect();
            out.changed = !assets.is_empty();
            out.media_changed = out.changed;
        }
        C::InsertStill { sequence, asset, track, at, duration } => {
            add_still(project, *sequence, asset, *track, *at, *duration, PlaceMode::Insert, &mut out)?;
        }
        C::AddTitle { sequence, asset, track, at, duration } => {
            let title = asset.title.as_ref().and_then(TitleSpec::sanitized).ok_or_else(|| EditError::Invalid("title".into()))?;
            if asset.kind != MediaKind::Image || asset.info.is_none() {
                return Err(EditError::Invalid("title".into()));
            }
            let asset = MediaAsset { title: Some(title), ..(**asset).clone() };
            add_still(project, *sequence, &asset, *track, *at, *duration, PlaceMode::Overwrite, &mut out)?;
        }
        C::RemoveMedia { media } => {
            for id in media {
                project.media(*id).ok_or(EditError::MediaNotFound)?;
                let angles = project.multicams.iter().flat_map(|m| &m.angles).filter(|a| a.media == *id).count();
                let used = project.media_usage(*id) + angles;
                if used > 0 {
                    return Err(EditError::MediaInUse(used));
                }
            }
            project.media.retain(|m| !media.contains(&m.id));
            out.changed = !media.is_empty();
            out.media_changed = out.changed;
        }
        C::RenameMedia { media, name } => {
            let name = non_empty(name)?;
            let asset = project.media_mut(*media).ok_or(EditError::MediaNotFound)?;
            out.changed = asset.name != name;
            asset.name = name;
            out.media_changed = out.changed;
        }
        C::SetMediaFavorite { media, favorite } => {
            all_media(project, media)?;
            for id in media {
                let asset = project.media_mut(*id).ok_or(EditError::MediaNotFound)?;
                out.changed |= asset.favorite != *favorite;
                asset.favorite = *favorite;
            }
            out.media_changed = out.changed;
        }
        C::UpdateMedia { media, patch } => {
            all_media(project, media)?;
            if let Some(m) = patch.matrix.filter(|m| !m.is_auto()) {
                let video = |id: &Uuid| project.media(*id).filter(|a| a.kind == MediaKind::Video).and_then(|a| a.info.as_ref()?.video.as_ref());
                if !media.iter().all(|id| video(id).is_some_and(|v| v.tagged_ycc().is_ok())) {
                    return Err(EditError::Invalid(format!("matrix {m:?} needs a video tagged BT.601, BT.709 or not at all")));
                }
            }
            for id in media {
                let asset = project.media_mut(*id).ok_or(EditError::MediaNotFound)?;
                let before = (asset.favorite, asset.label, asset.tags.clone(), asset.note.clone(), asset.matrix);
                if let Some(v) = patch.favorite {
                    asset.favorite = v;
                }
                if let Some(v) = patch.label {
                    asset.label = v;
                }
                if let Some(v) = &patch.tags {
                    let mut tags: Vec<String> = v.iter().map(|t| clean_line(t, MAX_TAG)).filter(|t| !t.is_empty()).collect();
                    tags.sort();
                    tags.dedup();
                    tags.truncate(MAX_TAGS);
                    asset.tags = tags;
                }
                if let Some(v) = &patch.note {
                    asset.note = v.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).take(MAX_NOTE).collect();
                }
                if let Some(m) = patch.matrix {
                    asset.matrix = m;
                }
                out.changed |= before != (asset.favorite, asset.label, asset.tags.clone(), asset.note.clone(), asset.matrix);
            }
            out.media_changed = out.changed;
        }
        C::SetSourceMarks { media, marks } => {
            let asset = project.media_mut(*media).ok_or(EditError::MediaNotFound)?;
            let len = asset.info.as_ref().map_or(f64::INFINITY, |i| i.duration);
            let clean = |v: Option<f64>| v.filter(|t| t.is_finite()).map(|t| t.clamp(0.0, len));
            let mut m = SourceMarks { in_point: clean(marks.in_point), out_point: clean(marks.out_point) };
            if let (Some(i), Some(o)) = (m.in_point, m.out_point) {
                if o <= i {
                    m.out_point = None;
                }
            }
            out.changed = asset.marks != m;
            asset.marks = m;
            out.media_changed = out.changed;
        }
        C::MoveMediaToBin { media, bin } => {
            if let Some(b) = bin {
                let target = project.bins.iter().find(|x| x.id == *b).ok_or(EditError::BinNotFound)?;
                if target.smart.is_some() {
                    return Err(EditError::Invalid("a smart bin holds no media".into()));
                }
            }
            for id in media {
                project.media(*id).ok_or(EditError::MediaNotFound)?;
            }
            for id in media {
                let asset = project.media_mut(*id).expect("checked");
                out.changed |= asset.bin != *bin;
                asset.bin = *bin;
            }
            out.media_changed = out.changed;
        }
        C::UpdateTitle { media, title, path } => {
            let title = title.sanitized().ok_or_else(|| EditError::Invalid("title".into()))?;
            let asset = project.media_mut(*media).ok_or(EditError::MediaNotFound)?;
            if asset.title.is_none() || path.as_os_str().is_empty() {
                return Err(EditError::Invalid("not a title".into()));
            }
            if asset.title.as_ref() == Some(&title) && asset.path == *path {
                return Ok(out);
            }
            if let Some(v) = asset.info.as_mut().and_then(|i| i.video.as_mut()) {
                (v.width, v.height) = (title.width, title.height);
            }
            asset.title = Some(title);
            asset.path = path.clone();
            asset.status = MediaStatus::Ready;
            out.changed = true;
            out.media_changed = true;
        }
        C::RelinkMedia { media, path } => {
            let asset = project.media_mut(*media).ok_or(EditError::MediaNotFound)?;
            asset.path = path.clone();
            asset.status = MediaStatus::Analyzing;
            asset.derived = Derived::default();
            out.changed = true;
            out.media_changed = true;
        }
        C::CreateBin { name, parent, smart } => {
            if let Some(p) = parent {
                let p = project.bins.iter().find(|b| b.id == *p).ok_or(EditError::BinNotFound)?;
                if p.smart.is_some() {
                    return Err(EditError::Invalid("a smart bin holds no bins".into()));
                }
            }
            let bin = Bin { id: Uuid::new_v4(), name: non_empty(name)?, parent: *parent, smart: smart.as_ref().map(SmartRules::sanitized) };
            out.created.push(bin.id);
            project.bins.push(bin);
            out.changed = true;
            out.media_changed = true;
        }
        C::RenameBin { bin, name } => {
            let name = non_empty(name)?;
            let b = project.bins.iter_mut().find(|b| b.id == *bin).ok_or(EditError::BinNotFound)?;
            out.changed = b.name != name;
            b.name = name;
            out.media_changed = out.changed;
        }
        C::SetSmartRules { bin, rules } => {
            let b = project.bins.iter_mut().find(|b| b.id == *bin).ok_or(EditError::BinNotFound)?;
            let Some(old) = b.smart.as_mut() else {
                return Err(EditError::Invalid("not a smart bin".into()));
            };
            let rules = rules.sanitized();
            out.changed = *old != rules;
            *old = rules;
            out.media_changed = out.changed;
        }
        C::RemoveBin { bin } => {
            let parent = project.bins.iter().find(|b| b.id == *bin).ok_or(EditError::BinNotFound)?.parent;
            for b in &mut project.bins {
                if b.parent == Some(*bin) {
                    b.parent = parent;
                }
            }
            for m in &mut project.media {
                if m.bin == Some(*bin) {
                    m.bin = parent;
                }
            }
            for w in &mut project.watch_folders {
                if w.bin == Some(*bin) {
                    w.bin = parent;
                }
            }
            project.bins.retain(|b| b.id != *bin);
            out.changed = true;
            out.media_changed = true;
        }
        C::AddWatchFolder { path, bin, subfolders } => {
            if !absolute_path(path) {
                return Err(EditError::Invalid("watch folder path".into()));
            }
            if let Some(b) = bin {
                let target = project.bins.iter().find(|x| x.id == *b).ok_or(EditError::BinNotFound)?;
                if target.smart.is_some() {
                    return Err(EditError::Invalid("a smart bin holds no media".into()));
                }
            }
            let key = WatchFolder::key(path);
            if project.watch_folders.iter().any(|w| WatchFolder::key(&w.path) == key) {
                return Err(EditError::Invalid("the folder is watched already".into()));
            }
            if project.watch_folders.len() >= MAX_WATCH_FOLDERS {
                return Err(EditError::Invalid(format!("at most {MAX_WATCH_FOLDERS} watch folders")));
            }
            let w = WatchFolder { id: Uuid::new_v4(), path: path.clone(), bin: *bin, subfolders: *subfolders };
            out.created.push(w.id);
            project.watch_folders.push(w);
            out.changed = true;
            out.media_changed = true;
        }
        C::RemoveWatchFolder { id } => {
            let n = project.watch_folders.len();
            project.watch_folders.retain(|w| w.id != *id);
            if project.watch_folders.len() == n {
                return Err(EditError::Invalid("watch folder not found".into()));
            }
            out.changed = true;
            out.media_changed = true;
        }
        C::AddSequence { name, settings } => {
            validate_settings(settings)?;
            let seq = Sequence::new(non_empty(name)?, *settings);
            out.created.push(seq.id);
            project.sequences.push(seq);
            out.changed = true;
            out.sequences_changed = true;
        }
        C::RemoveSequence { sequence } => {
            if project.sequences.len() <= 1 {
                return Err(EditError::LastSequence);
            }
            project.sequence(*sequence).ok_or(EditError::SequenceNotFound)?;
            let used = project.media_usage(*sequence);
            if used > 0 {
                return Err(EditError::SequenceInUse(used));
            }
            project.sequences.retain(|s| s.id != *sequence);
            if project.active_sequence == *sequence {
                project.active_sequence = project.sequences[0].id;
            }
            out.changed = true;
            out.sequences_changed = true;
        }
        C::NestClips { sequence, clips, name } => nest_clips(project, *sequence, clips, name, &mut out)?,
        C::CreateMulticam { multicam } => {
            let mut m = multicam.clone();
            m.name = non_empty(&m.name)?;
            if !(2..=16).contains(&m.angles.len()) {
                return Err(EditError::Invalid("a multicam group needs 2 to 16 angles".into()));
            }
            if project.multicam(m.id).is_some() {
                return Err(EditError::Invalid("duplicate multicam id".into()));
            }
            for a in &m.angles {
                let asset = project.media(a.media).ok_or(EditError::MediaNotFound)?;
                if !asset.has_video() || !a.offset.is_finite() {
                    return Err(EditError::Invalid("angle".into()));
                }
            }
            let first = m.angles.iter().map(|a| a.offset).fold(f64::INFINITY, f64::min);
            for a in &mut m.angles {
                a.offset -= first;
                if a.name.trim().is_empty() {
                    a.name = project.media(a.media).map(|x| x.name.clone()).unwrap_or_default();
                }
            }
            out.created.push(m.id);
            project.multicams.push(m);
            out.changed = true;
        }
        C::RenameSequence { sequence, name } => {
            let name = non_empty(name)?;
            let seq = project.sequence_mut(*sequence).ok_or(EditError::SequenceNotFound)?;
            out.changed = seq.name != name;
            seq.name = name;
            out.sequences_changed = out.changed;
        }
        _ => unreachable!("sequence-scoped commands are handled above"),
    }
    Ok(out)
}

/// Multicam edits: they read the project's groups and media, and change one sequence.
fn multicam_edit(project: &mut Project, seq_id: Uuid, cmd: &EditCommand, mut out: EditOutcome) -> Result<EditOutcome> {
    use EditCommand as C;
    let mut seq = project.sequence(seq_id).ok_or(EditError::SequenceNotFound)?.clone();
    let changed = match cmd {
        C::PlaceMulticam { multicam, at, mode, video_angle, audio_angle, video_track, audio_track, .. } => {
            let g = project.multicam(*multicam).ok_or_else(|| EditError::Invalid("multicam".into()))?;
            out.created = place_multicam(&mut seq, project, g, (*at, *mode), (*video_angle, *audio_angle), (*video_track, *audio_track))?;
            true
        }
        C::SwitchAngle { clip, angle, at, .. } => switch_angle(&mut seq, project, *clip, *angle, *at)?,
        _ => unreachable!("only multicam commands"),
    };
    if changed {
        seq.tracks.iter_mut().for_each(|t| {
            t.tidy_transitions();
        });
        *project.sequence_mut(seq_id).expect("sequence exists") = seq;
        out.sequence = Some(seq_id);
        out.changed = true;
    }
    Ok(out)
}

fn place_multicam(
    seq: &mut Sequence,
    project: &Project,
    g: &Multicam,
    (at, mode): (Frame, PlaceMode),
    (video_angle, audio_angle): (usize, Option<usize>),
    (video_track, audio_track): (Option<Uuid>, Option<Uuid>),
) -> Result<Vec<Uuid>> {
    let angle = |i: usize| g.angles.get(i).ok_or_else(|| EditError::Invalid("angle".into()));
    let ready = |a: &Angle| -> Result<MediaAsset> {
        let m = project.media(a.media).ok_or(EditError::MediaNotFound)?;
        if m.status != MediaStatus::Ready || m.info.is_none() {
            return Err(EditError::MediaNotReady);
        }
        Ok(m.clone())
    };
    let v = angle(video_angle)?;
    let vm = ready(v)?;
    let sound = audio_angle.map(|i| angle(i).and_then(|a| Ok((a, ready(a)?)))).transpose()?;
    if !vm.has_video() || sound.as_ref().is_some_and(|(_, m)| !m.has_audio()) {
        return Err(EditError::NoFootage);
    }
    // The stretch of the group's clock both angles cover.
    let length = |m: &MediaAsset| m.info.as_ref().map_or(0.0, |i| i.duration);
    let (mut s0, mut s1) = (v.offset, v.offset + length(&vm));
    if let Some((a, am)) = &sound {
        s0 = s0.max(a.offset);
        s1 = s1.min(a.offset + length(am));
    }
    let rate = seq.settings.fps;
    let len = rate.seconds_to_frames_floor(s1 - s0);
    if len <= 0 {
        return Err(EditError::NoFootage);
    }
    let mut scratch = EditOutcome::default();
    let v_in = rate.seconds_to_frames_round(s0 - v.offset);
    let picture = MediaAsset { info: vm.info.clone().map(|i| MediaInfo { audio: None, ..i }), ..vm.clone() };
    let args = PlaceArgs { media: vm.id, video_track, audio_track: None, at, mode, source_in: Some(v_in), source_out: Some(v_in + len), match_sequence: false };
    let mut created = place_media(seq, std::slice::from_ref(&picture), args, &mut scratch)?;
    let (t, c) = seq.locate(created[0]).expect("placed");
    let len = seq.tracks[t].clips[c].duration;
    seq.tracks[t].clips[c].name = v.name.clone();
    if let Some((a, am)) = &sound {
        let a_in = rate.seconds_to_frames_round(s0 - a.offset);
        let sound_only = MediaAsset { info: am.info.clone().map(|i| MediaInfo { video: None, ..i }), ..am.clone() };
        // An insert already opened the gap on every track.
        let args = PlaceArgs { media: am.id, video_track: None, audio_track, at, mode: PlaceMode::Overwrite, source_in: Some(a_in), source_out: Some(a_in + len), match_sequence: false };
        let ids = place_media(seq, std::slice::from_ref(&sound_only), args, &mut scratch)?;
        if let Some((t, c)) = ids.first().and_then(|id| seq.locate(*id)) {
            seq.tracks[t].clips[c].name = a.name.clone();
        }
        created.extend(ids);
    }
    let link = (created.len() > 1).then(Uuid::new_v4);
    for id in &created {
        let (t, c) = seq.locate(*id).expect("placed");
        let clip = &mut seq.tracks[t].clips[c];
        clip.link = link;
        clip.multicam = Some(g.id);
    }
    Ok(created)
}

fn switch_angle(seq: &mut Sequence, project: &Project, clip: Uuid, angle: usize, at: Option<Frame>) -> Result<bool> {
    let (ti, mut ci) = seq.locate(clip).ok_or(EditError::ClipNotFound)?;
    if seq.tracks[ti].locked {
        return Err(EditError::TrackLocked);
    }
    let c = &seq.tracks[ti].clips[ci];
    let g = c.multicam.and_then(|id| project.multicam(id)).ok_or_else(|| EditError::Invalid("not a multicam clip".into()))?;
    let to = g.angles.get(angle).ok_or_else(|| EditError::Invalid("angle".into()))?;
    if to.media == c.media_id {
        return Ok(false);
    }
    let from = g.angles.iter().find(|a| a.media == c.media_id).ok_or_else(|| EditError::Invalid("angle".into()))?;
    let target = project.media(to.media).ok_or(EditError::MediaNotFound)?;
    let usable = match seq.tracks[ti].kind {
        TrackKind::Video => target.has_video(),
        TrackKind::Audio => target.has_audio(),
    };
    if !usable {
        return Err(EditError::NoFootage);
    }
    // From `at` on: the clip is cut there, the right part keeps the link.
    if let Some(at) = at.filter(|&a| a > c.start && a < c.end()) {
        let (left, mut right) = split_clip(c, at, &mut HashMap::new());
        right.link = c.link;
        let t = &mut seq.tracks[ti];
        t.clips[ci] = left;
        t.clips.insert(ci + 1, right);
        ci += 1;
    }
    let rate = seq.settings.fps;
    let shift = rate.seconds_to_frames_round(from.offset - to.offset);
    let c = &mut seq.tracks[ti].clips[ci];
    let (new_in, new_out) = (c.source_in + shift, c.source_out() + shift);
    if new_in < 0 || target.length_frames(rate).is_some_and(|l| new_out > l) {
        return Err(EditError::NoFootage);
    }
    c.media_id = to.media;
    c.source_in = new_in;
    c.name = to.name.clone();
    // Keys sit on source positions: they move with the picture.
    for k in c.keys.values_mut().chain(c.effects.iter_mut().flat_map(|e| e.keys.values_mut())).flatten() {
        k.at += shift;
    }
    Ok(true)
}

fn nest_clips(project: &mut Project, seq_id: Uuid, ids: &[Uuid], name: &str, out: &mut EditOutcome) -> Result<()> {
    let name = non_empty(name)?;
    let mut outer = project.sequence(seq_id).ok_or(EditError::SequenceNotFound)?.clone();
    // The selection with its linked partners.
    let mut take = HashSet::new();
    let mut links = HashSet::new();
    for id in ids {
        let (t, c) = outer.locate(*id).ok_or(EditError::ClipNotFound)?;
        take.insert(*id);
        links.extend(outer.tracks[t].clips[c].link);
    }
    take.extend(outer.tracks.iter().flat_map(|t| &t.clips).filter(|c| c.link.is_some_and(|l| links.contains(&l))).map(|c| c.id));
    if take.is_empty() {
        return Err(EditError::Invalid("nothing to nest".into()));
    }

    // The new sequence mirrors the tracks; its clips start at 0.
    let mut inner = Sequence::new(name.clone(), outer.settings);
    inner.tracks = outer.tracks.iter().map(|t| Track { color: t.color, ..Track::new(t.kind, t.name.clone()) }).collect();
    let (mut lo, mut hi) = (Frame::MAX, Frame::MIN);
    // Lowest video and audio track the clips came from.
    let mut from: [Option<usize>; 2] = [None, None];
    for (ti, t) in outer.tracks.iter_mut().enumerate() {
        if !t.clips.iter().any(|c| take.contains(&c.id)) {
            continue;
        }
        if t.locked {
            return Err(EditError::TrackLocked);
        }
        from[(t.kind == TrackKind::Audio) as usize].get_or_insert(ti);
        let (moved, kept): (Vec<Clip>, Vec<Clip>) = t.clips.drain(..).partition(|c| take.contains(&c.id));
        t.clips = kept;
        for c in &moved {
            lo = lo.min(c.start);
            hi = hi.max(c.end());
        }
        inner.tracks[ti].clips = moved;
    }
    for c in inner.tracks.iter_mut().flat_map(|t| t.clips.iter_mut()) {
        c.start -= lo;
    }
    for t in inner.tracks.iter_mut().chain(outer.tracks.iter_mut()) {
        t.tidy_transitions();
    }

    // One clip of the new sequence per kind, on the track the clips came from when it is free.
    let src = inner.as_source();
    let link = (src.has_video() && src.has_audio()).then(Uuid::new_v4);
    for (kind, has) in [(TrackKind::Video, src.has_video()), (TrackKind::Audio, src.has_audio())] {
        if !has {
            continue;
        }
        let free = |t: &Track| !t.locked && t.clips.iter().all(|c| c.end() <= lo || c.start >= hi);
        let found = from[(kind == TrackKind::Audio) as usize]
            .filter(|&i| free(&outer.tracks[i]))
            .or_else(|| outer.tracks_of(kind).into_iter().find(|&i| free(&outer.tracks[i])));
        let ti = match found {
            Some(i) => i,
            None => {
                let id = add_track(&mut outer, kind);
                outer.track_index(id).expect("just added")
            }
        };
        let mut clip = Clip::new(inner.id, name.clone(), lo, hi - lo, 0);
        clip.link = link;
        out.created.push(clip.id);
        insert_sorted(&mut outer.tracks[ti], clip);
    }
    out.created.insert(0, inner.id);
    *project.sequence_mut(seq_id).expect("exists") = outer;
    project.sequences.push(inner);
    out.sequence = Some(seq_id);
    out.changed = true;
    out.sequences_changed = true;
    Ok(())
}

fn edit_sequence(seq: &mut Sequence, media: &[MediaAsset], cmd: &EditCommand, out: &mut EditOutcome) -> Result<bool> {
    use EditCommand as C;
    match cmd {
        C::UpdateSequenceSettings { settings, .. } => {
            validate_settings(settings)?;
            if seq.settings == *settings {
                return Ok(false);
            }
            if seq.settings.fps != settings.fps {
                convert_rate(seq, media, seq.settings.fps, settings.fps);
            }
            seq.settings = *settings;
            out.sequences_changed = true;
            Ok(true)
        }
        C::AddTrack { kind, .. } => {
            let id = add_track(seq, *kind);
            out.created.push(id);
            Ok(true)
        }
        C::RemoveTrack { track, .. } => {
            let idx = seq.track_index(*track).ok_or(EditError::TrackNotFound)?;
            seq.tracks.remove(idx);
            Ok(true)
        }
        C::UpdateTrack { track, patch, .. } => {
            let t = seq.track_mut(*track).ok_or(EditError::TrackNotFound)?;
            let before = t.clone();
            if let Some(n) = &patch.name {
                t.name = non_empty(n)?;
            }
            if let Some(v) = patch.muted {
                t.muted = v;
            }
            if let Some(v) = patch.solo {
                t.solo = v;
            }
            if let Some(v) = patch.locked {
                t.locked = v;
            }
            if let Some(v) = patch.hidden {
                t.hidden = v;
            }
            if let Some(v) = patch.volume_db {
                t.volume_db = v.clamp(-96.0, 12.0);
            }
            if let Some(v) = patch.color {
                t.color = v;
            }
            if let Some(v) = patch.height {
                t.height = if v == 0 { 0 } else { v.clamp(24, 320) };
            }
            if patch.effects.is_some() || patch.mono.is_some() {
                if t.kind != TrackKind::Audio {
                    return Err(EditError::Invalid("track effects apply to audio tracks".into()));
                }
                if let Some(e) = &patch.effects {
                    t.effects = crate::audio::sanitize_effects(e).ok_or_else(|| EditError::Invalid("audio effect parameter".into()))?;
                }
                if let Some(v) = patch.mono {
                    t.mono = v;
                }
            }
            Ok(*t != before)
        }
        C::PlaceMedia { media: media_id, video_track, audio_track, at, mode, source_in, source_out, match_sequence, .. } => {
            let created = place_media(
                seq,
                media,
                PlaceArgs {
                    media: *media_id,
                    video_track: *video_track,
                    audio_track: *audio_track,
                    at: *at,
                    mode: *mode,
                    source_in: *source_in,
                    source_out: *source_out,
                    match_sequence: *match_sequence,
                },
                out,
            )?;
            out.created = created;
            Ok(true)
        }
        C::MoveClips { clips, delta, track_delta, track_kind, .. } => move_clips(seq, clips, *delta, *track_delta, *track_kind),
        C::TrimClip { clip, edge, delta, ripple, linked, .. } => trim_clip(seq, media, *clip, *edge, *delta, *ripple, *linked),
        C::RollEdit { clip, delta, linked, .. } => roll_edit(seq, media, *clip, *delta, *linked),
        C::SlipClip { clip, delta, linked, .. } => slip_clip(seq, media, *clip, *delta, *linked),
        C::SlideClip { clip, delta, linked, .. } => slide_clip(seq, media, *clip, *delta, *linked),
        C::SplitAt { frame, clips, .. } => {
            let created = split_at(seq, *frame, clips.as_deref())?;
            let changed = !created.is_empty();
            out.created = created;
            Ok(changed)
        }
        C::DeleteClips { clips, ripple, .. } => delete_clips(seq, clips, *ripple),
        C::SetKeyframes { clip, param, keys, .. } => set_keyframes(seq, media, *clip, *param, keys),
        C::SetEffects { clips, effects, .. } => set_effects(seq, clips, effects),
        C::AddEffects { clips, effects, .. } => add_effects(seq, clips, effects),
        C::SetTransitions { items, .. } => set_transitions(seq, items),
        C::SetAudioEffects { items, .. } => set_audio_effects(seq, items),
        C::SetClipGain { gains, .. } => set_clip_gain(seq, gains),
        C::RemoveRange { start, end, ripple, tracks, .. } => remove_range(seq, *start, *end, *ripple, tracks.as_deref()),
        C::ReplaceMedia { clip, media: id, .. } => replace_media(seq, media, *clip, *id),
        C::CloseGap { track, frame, .. } => close_gap(seq, *track, *frame),
        C::PasteClips { items, at, .. } => {
            let created = paste(seq, media, items, *at)?;
            let changed = !created.is_empty();
            out.created = created;
            Ok(changed)
        }
        C::DuplicateClips { clips, .. } => {
            let mut items = Vec::new();
            for id in clips {
                let (ti, ci) = seq.locate(*id).ok_or(EditError::ClipNotFound)?;
                let t = &seq.tracks[ti];
                items.push(PasteItem { clip: t.clips[ci].clone(), track: t.id, kind: t.kind, rate: None });
            }
            let at = items.iter().map(|i| i.clip.end()).max().unwrap_or(0);
            let created = paste(seq, media, &items, at)?;
            let changed = !created.is_empty();
            out.created = created;
            Ok(changed)
        }
        C::UpdateClips { clips, patch, .. } => update_clips(seq, media, clips, patch),
        C::LinkClips { clips, .. } => {
            if clips.len() < 2 {
                return Err(EditError::Invalid("linking needs at least two clips".into()));
            }
            let link = Uuid::new_v4();
            for id in clips {
                let (ti, ci) = seq.locate(*id).ok_or(EditError::ClipNotFound)?;
                seq.tracks[ti].clips[ci].link = Some(link);
            }
            Ok(true)
        }
        C::UnlinkClips { clips, .. } => {
            let mut links = HashSet::new();
            for id in clips {
                let c = seq.clip(*id).ok_or(EditError::ClipNotFound)?;
                if let Some(l) = c.link {
                    links.insert(l);
                }
            }
            let mut changed = false;
            for c in seq.tracks.iter_mut().flat_map(|t| t.clips.iter_mut()) {
                if c.link.is_some_and(|l| links.contains(&l)) {
                    c.link = None;
                    changed = true;
                }
            }
            Ok(changed)
        }
        C::AddMarker { frame, name, color, .. } => {
            let m = Marker { id: Uuid::new_v4(), frame: (*frame).max(0), name: name.trim().to_string(), note: String::new(), color: *color, category: String::new(), duration: 0, chapter: false };
            out.created.push(m.id);
            seq.markers.push(m);
            seq.markers.sort_by_key(|m| m.frame);
            Ok(true)
        }
        C::UpdateMarker { marker, patch, .. } => {
            let m = seq.markers.iter_mut().find(|m| m.id == *marker).ok_or(EditError::MarkerNotFound)?;
            let before = m.clone();
            if let Some(f) = patch.frame {
                m.frame = f.max(0);
            }
            if let Some(n) = &patch.name {
                m.name = n.trim().to_string();
            }
            if let Some(n) = &patch.note {
                m.note = n.clone();
            }
            if let Some(c) = patch.color {
                m.color = c;
            }
            if let Some(c) = &patch.category {
                m.category = category(c);
            }
            if let Some(d) = patch.duration {
                m.duration = d.max(0);
            }
            if let Some(c) = patch.chapter {
                m.chapter = c;
            }
            let changed = *m != before;
            seq.markers.sort_by_key(|m| m.frame);
            Ok(changed)
        }
        C::AddMarkers { markers, .. } => {
            for n in markers {
                let m = Marker {
                    id: Uuid::new_v4(),
                    frame: n.frame.max(0),
                    name: n.name.trim().to_string(),
                    note: n.note.clone(),
                    color: n.color,
                    category: category(&n.category),
                    duration: n.duration.max(0),
                    chapter: n.chapter,
                };
                out.created.push(m.id);
                seq.markers.push(m);
            }
            seq.markers.sort_by_key(|m| m.frame);
            Ok(!markers.is_empty())
        }
        C::RemoveMarkers { markers, .. } => {
            if markers.iter().any(|id| !seq.markers.iter().any(|m| m.id == *id)) {
                return Err(EditError::MarkerNotFound);
            }
            seq.markers.retain(|m| !markers.contains(&m.id));
            Ok(!markers.is_empty())
        }
        C::RemoveMarker { marker, .. } => {
            let before = seq.markers.len();
            seq.markers.retain(|m| m.id != *marker);
            if seq.markers.len() == before {
                return Err(EditError::MarkerNotFound);
            }
            Ok(true)
        }
        C::SetInOut { in_point, out_point, .. } => {
            if let (Some(i), Some(o)) = (in_point, out_point) {
                if o <= i {
                    return Err(EditError::Invalid("out point must be after in point".into()));
                }
            }
            let (i, o) = (in_point.map(|f| f.max(0)), out_point.map(|f| f.max(1)));
            let changed = seq.in_point != i || seq.out_point != o;
            seq.in_point = i;
            seq.out_point = o;
            Ok(changed)
        }
        C::SetSubtitles { cues, .. } => {
            let cues = clean_cues(cues);
            let changed = seq.subtitles.cues != cues;
            seq.subtitles.cues = cues;
            Ok(changed)
        }
        C::SetSubtitleStyle { style, margin, visible, .. } => {
            let style = style.sanitized().ok_or_else(|| EditError::Invalid("subtitle style".into()))?;
            if !margin.is_finite() {
                return Err(EditError::Invalid("subtitle margin".into()));
            }
            let s = &mut seq.subtitles;
            let margin = margin.clamp(0.0, 0.5);
            let changed = s.style != style || s.margin != margin || s.visible != *visible;
            (s.style, s.margin, s.visible) = (style, margin, *visible);
            Ok(changed)
        }
        _ => unreachable!("not a sequence-scoped command"),
    }
}

/// Fails unless every id names a medium, so a command checks before it changes anything.
fn all_media(project: &Project, media: &[Uuid]) -> Result<()> {
    match media.iter().all(|id| project.media(*id).is_some()) {
        true => Ok(()),
        false => Err(EditError::MediaNotFound),
    }
}

/// `bin` if it is an existing bin that holds media, else the project root. A
/// bin can be gone when the browser still shows it after an undo.
fn holding_bin(project: &Project, bin: Option<Uuid>) -> Option<Uuid> {
    bin.filter(|b| project.bins.iter().any(|x| x.id == *b && x.smart.is_none()))
}

/// Adds `asset` to the project and places it on `track` for `duration` frames.
#[allow(clippy::too_many_arguments)]
fn add_still(project: &mut Project, sequence: Uuid, asset: &MediaAsset, track: Uuid, at: Frame, duration: Frame, mode: PlaceMode, out: &mut EditOutcome) -> Result<()> {
    if project.media(asset.id).is_some() {
        return Err(EditError::Invalid("duplicate media id".into()));
    }
    if duration <= 0 {
        return Err(EditError::Invalid("duration".into()));
    }
    let mut seq = project.sequence(sequence).ok_or(EditError::SequenceNotFound)?.clone();
    let args = PlaceArgs {
        media: asset.id,
        video_track: Some(track),
        audio_track: None,
        at,
        mode,
        source_in: Some(0),
        source_out: Some(duration),
        match_sequence: false,
    };
    out.created = place_media(&mut seq, std::slice::from_ref(asset), args, out)?;
    seq.tracks.iter_mut().for_each(|t| {
        t.tidy_transitions();
    });
    project.media.push(MediaAsset { bin: holding_bin(project, asset.bin), ..asset.clone() });
    *project.sequence_mut(sequence).expect("sequence exists") = seq;
    out.sequence = Some(sequence);
    out.changed = true;
    out.media_changed = true;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn yes() -> bool {
    true
}

fn non_empty(s: &str) -> Result<String> {
    let s = s.trim();
    if s.is_empty() {
        Err(EditError::Invalid("name must not be empty".into()))
    } else {
        Ok(s.to_string())
    }
}

fn validate_settings(s: &SequenceSettings) -> Result<()> {
    let fps = s.fps.as_f64();
    if !s.fps.is_valid() || !(1.0..=240.0).contains(&fps) {
        return Err(EditError::Invalid("frame rate".into()));
    }
    if s.width < 16 || s.height < 16 || s.width > 16384 || s.height > 16384 {
        return Err(EditError::Invalid("resolution".into()));
    }
    if !(8_000..=192_000).contains(&s.sample_rate) {
        return Err(EditError::Invalid("sample rate".into()));
    }
    Ok(())
}

/// Media length in sequence frames; `None` for stills or unknown media (unbounded).
fn media_len(media: &[MediaAsset], clip: &Clip, rate: Rational) -> Option<Frame> {
    media.iter().find(|m| m.id == clip.media_id).and_then(|m| m.length_frames(rate))
}

fn clamp_fades(c: &mut Clip) {
    c.fade_in = c.fade_in.clamp(0, c.duration);
    c.fade_out = c.fade_out.clamp(0, c.duration - c.fade_in);
}

fn add_track(seq: &mut Sequence, kind: TrackKind) -> Uuid {
    let n = seq.tracks.iter().filter(|t| t.kind == kind).count() + 1;
    let name = match kind {
        TrackKind::Video => format!("V{n}"),
        TrackKind::Audio => format!("A{n}"),
    };
    let track = Track::new(kind, name);
    let id = track.id;
    match kind {
        TrackKind::Video => {
            let pos = seq.tracks.iter().rposition(|t| t.kind == TrackKind::Video).map_or(0, |p| p + 1);
            seq.tracks.insert(pos, track);
        }
        TrackKind::Audio => seq.tracks.push(track),
    }
    id
}

fn first_track(seq: &mut Sequence, kind: TrackKind) -> usize {
    match seq.tracks.iter().position(|t| t.kind == kind) {
        Some(i) => i,
        None => {
            let id = add_track(seq, kind);
            seq.track_index(id).expect("just added")
        }
    }
}

/// Re-expresses everything a sequence stores in frames (clips, keys,
/// transitions, fades, markers, subtitles, in/out) in the new rate, so it
/// stays at the same time; clips stay inside their media.
fn convert_rate(seq: &mut Sequence, media: &[MediaAsset], from: Rational, to: Rational) {
    let conv = |f: Frame| to.seconds_to_frames_round(from.frames_to_seconds(f));
    for c in seq.tracks.iter_mut().flat_map(|t| t.clips.iter_mut()) {
        convert_clip(c, from, to);
    }
    for t in &mut seq.tracks {
        // Rounding can make neighbours overlap; the earlier clip gives way,
        // or, when it is too short for that, the later one (its head, else
        // its position).
        for i in 1..t.clips.len() {
            let prev_end = t.clips[i - 1].end();
            let cut = prev_end - t.clips[i].start;
            if cut <= 0 {
                continue;
            }
            if t.clips[i - 1].duration > cut {
                let p = &mut t.clips[i - 1];
                p.set_range(p.start, prev_end - cut);
            } else if t.clips[i].duration > cut {
                let c = &mut t.clips[i];
                c.set_range(prev_end, c.end());
            } else {
                t.clips[i].start = prev_end;
            }
        }
        for c in &mut t.clips {
            // The rounded range can end a frame past the media.
            if let Some(len) = media_len(media, c, to) {
                fit_into_media(c, len);
            }
            clamp_fades(c);
        }
    }
    for m in &mut seq.markers {
        m.frame = conv(m.frame);
        m.duration = conv(m.duration);
    }
    for cue in &mut seq.subtitles.cues {
        cue.start = conv(cue.start);
        cue.end = conv(cue.end).max(cue.start + 1);
    }
    // Neighbouring cues may touch differently after rounding.
    seq.subtitles.cues = clean_cues(&seq.subtitles.cues);
    seq.in_point = seq.in_point.map(conv);
    seq.out_point = seq.out_point.map(conv);
    // A range shorter than a frame of the new rate keeps one frame.
    if let (Some(i), Some(o)) = (seq.in_point, seq.out_point) {
        if o <= i {
            seq.out_point = Some(i + 1);
        }
    }
}

/// Re-expresses a clip's frames (position, source, fades, keys, transition)
/// in another rate. Fades are clamped by the caller.
fn convert_clip(c: &mut Clip, from: Rational, to: Rational) {
    let conv = |f: Frame| to.seconds_to_frames_round(from.frames_to_seconds(f));
    let start = conv(c.start);
    let end = conv(c.end()).max(start + 1);
    c.start = start;
    c.duration = end - start;
    c.source_in = conv(c.source_in);
    c.fade_in = conv(c.fade_in);
    c.fade_out = conv(c.fade_out);
    for keys in c.keys.values_mut().chain(c.effects.iter_mut().flat_map(|e| e.keys.values_mut())) {
        for k in keys.iter_mut() {
            k.at = conv(k.at);
        }
        // Keys closer than a frame of the new rate collapse (the later one stays).
        keys.reverse();
        keys.dedup_by_key(|k| k.at);
        keys.reverse();
    }
    if let Some(t) = &mut c.transition {
        t.duration = conv(t.duration).max(1);
    }
}

/// Splits `clip` at timeline frame `at` (strictly inside the clip).
/// Right halves of linked clips share a new link id via `link_map`.
fn split_clip(clip: &Clip, at: Frame, link_map: &mut HashMap<Uuid, Uuid>) -> (Clip, Clip) {
    debug_assert!(clip.start < at && at < clip.end());
    let mut left = clip.clone();
    let mut right = clip.clone();
    left.set_range(clip.start, at);
    left.fade_out = 0;
    clamp_fades(&mut left);
    right.id = Uuid::new_v4();
    right.set_range(at, clip.end());
    right.fade_in = 0;
    right.transition = None;
    right.link = clip.link.map(|l| *link_map.entry(l).or_insert_with(Uuid::new_v4));
    clamp_fades(&mut right);
    (left, right)
}

/// Removes everything inside `[from, to)`, trimming or splitting straddling clips.
fn clear_range(track: &mut Track, from: Frame, to: Frame) {
    if to <= from {
        return;
    }
    let mut out = Vec::with_capacity(track.clips.len() + 1);
    for c in track.clips.drain(..) {
        if c.end() <= from || c.start >= to {
            out.push(c);
            continue;
        }
        if c.start < from {
            let mut left = c.clone();
            left.set_range(c.start, from);
            left.fade_out = 0;
            clamp_fades(&mut left);
            out.push(left);
        }
        if c.end() > to {
            let mut right = c.clone();
            if c.start < from {
                right.id = Uuid::new_v4();
                right.link = None;
            }
            right.set_range(to, c.end());
            right.fade_in = 0;
            right.transition = None;
            clamp_fades(&mut right);
            out.push(right);
        }
    }
    track.clips = out;
}

fn insert_sorted(track: &mut Track, clip: Clip) {
    let pos = track.clips.partition_point(|c| c.start < clip.start);
    track.clips.insert(pos, clip);
}

/// Opens a gap of `amount` frames at `at` on every unlocked track.
fn insert_gap(seq: &mut Sequence, at: Frame, amount: Frame) {
    let mut link_map = HashMap::new();
    for track in seq.tracks.iter_mut().filter(|t| !t.locked) {
        if let Some(i) = track.clips.iter().position(|c| c.start < at && at < c.end()) {
            let (l, r) = split_clip(&track.clips[i], at, &mut link_map);
            track.clips[i] = l;
            track.clips.insert(i + 1, r);
        }
        for c in track.clips.iter_mut().filter(|c| c.start >= at) {
            c.start += amount;
        }
    }
}

/// Linked partners (other tracks) of the clip at `(ti, ci)` that satisfy `pred`.
fn partners(seq: &Sequence, ti: usize, ci: usize, pred: impl Fn(&Clip, &Clip) -> bool) -> Vec<(usize, usize)> {
    let anchor = &seq.tracks[ti].clips[ci];
    let Some(link) = anchor.link else { return Vec::new() };
    let mut out = Vec::new();
    for (t, track) in seq.tracks.iter().enumerate() {
        if t == ti {
            continue;
        }
        for (c, clip) in track.clips.iter().enumerate() {
            if clip.link == Some(link) && pred(anchor, clip) {
                out.push((t, c));
            }
        }
    }
    out
}

fn check_unlocked(seq: &Sequence, targets: &[(usize, usize)]) -> Result<()> {
    if targets.iter().any(|(t, _)| seq.tracks[*t].locked) {
        Err(EditError::TrackLocked)
    } else {
        Ok(())
    }
}

/// Intersection of allowed deltas.
struct Bounds {
    lo: Frame,
    hi: Frame,
}

impl Bounds {
    fn new() -> Self {
        Self { lo: Frame::MIN, hi: Frame::MAX }
    }
    fn min(&mut self, v: Frame) {
        self.lo = self.lo.max(v);
    }
    fn max(&mut self, v: Frame) {
        self.hi = self.hi.min(v);
    }
    fn clamp(&self, d: Frame) -> Frame {
        if self.lo > self.hi {
            0
        } else {
            d.clamp(self.lo, self.hi)
        }
    }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

struct PlaceArgs {
    media: Uuid,
    video_track: Option<Uuid>,
    audio_track: Option<Uuid>,
    at: Frame,
    mode: PlaceMode,
    source_in: Option<Frame>,
    source_out: Option<Frame>,
    match_sequence: bool,
}

fn place_media(seq: &mut Sequence, media: &[MediaAsset], mut a: PlaceArgs, out: &mut EditOutcome) -> Result<Vec<Uuid>> {
    let asset = media.iter().find(|m| m.id == a.media).ok_or(EditError::MediaNotFound)?;
    if asset.status != MediaStatus::Ready || asset.info.is_none() {
        return Err(EditError::MediaNotReady);
    }
    let info = asset.info.as_ref().expect("checked");

    if a.match_sequence && !seq.has_clips() {
        if let Some(v) = info.video.as_ref().filter(|_| asset.kind == MediaKind::Video) {
            let mut settings = seq.settings;
            let (w, h) = if v.rotation.rem_euclid(180) == 90 { (v.height, v.width) } else { (v.width, v.height) };
            settings.width = w.max(16);
            settings.height = h.max(16);
            if v.fps.is_valid() && (1.0..=240.0).contains(&v.fps.as_f64()) {
                settings.fps = v.fps;
            }
            if settings != seq.settings {
                let (from, to) = (seq.settings.fps, settings.fps);
                let conv = move |f: Frame| to.seconds_to_frames_round(from.frames_to_seconds(f));
                a.source_in = a.source_in.map(conv);
                a.source_out = a.source_out.map(conv);
                a.at = conv(a.at);
                convert_rate(seq, media, from, to);
                seq.settings = settings;
                out.sequences_changed = true;
            }
        }
    }

    let rate = seq.settings.fps;
    let len = asset
        .length_frames(rate)
        .unwrap_or_else(|| rate.seconds_to_frames_round(DEFAULT_STILL_SECONDS).max(1));
    let bounded = asset.length_frames(rate).is_some();
    let sin = a.source_in.unwrap_or(0).clamp(0, (len - 1).max(0));
    let sout = match a.source_out {
        Some(o) if bounded => o.clamp(sin + 1, len),
        Some(o) => o.max(sin + 1),
        None => len,
    };
    let dur = sout - sin;
    let at = a.at.max(0);

    let wants_video = asset.has_video();
    let wants_audio = asset.has_audio();
    if !wants_video && !wants_audio {
        return Err(EditError::Invalid("media has no usable streams".into()));
    }

    let resolve = |seq: &mut Sequence, wanted: Option<Uuid>, kind: TrackKind| -> Result<usize> {
        let idx = match wanted {
            Some(id) => seq.track_index(id).ok_or(EditError::TrackNotFound)?,
            None => first_track(seq, kind),
        };
        if seq.tracks[idx].kind != kind {
            return Err(EditError::TrackKindMismatch);
        }
        if seq.tracks[idx].locked {
            return Err(EditError::TrackLocked);
        }
        Ok(idx)
    };
    let v_idx = if wants_video { Some(resolve(seq, a.video_track, TrackKind::Video)?) } else { None };
    let a_id = if wants_audio {
        let idx = resolve(seq, a.audio_track, TrackKind::Audio)?;
        Some(seq.tracks[idx].id)
    } else {
        None
    };
    let v_id = v_idx.map(|i| seq.tracks[i].id);

    match a.mode {
        PlaceMode::Insert => insert_gap(seq, at, dur),
        PlaceMode::Overwrite => {
            for id in [v_id, a_id].into_iter().flatten() {
                let t = seq.track_mut(id).expect("resolved");
                clear_range(t, at, at + dur);
            }
        }
    }

    let link = (wants_video && wants_audio).then(Uuid::new_v4);
    let mut created = Vec::new();
    for id in [v_id, a_id].into_iter().flatten() {
        let mut clip = Clip::new(asset.id, asset.name.clone(), at, dur, sin);
        clip.link = link;
        created.push(clip.id);
        insert_sorted(seq.track_mut(id).expect("resolved"), clip);
    }
    Ok(created)
}

fn move_clips(seq: &mut Sequence, ids: &[Uuid], delta: Frame, track_delta: i32, track_kind: Option<TrackKind>) -> Result<bool> {
    let ids: Vec<Uuid> = {
        let mut seen = HashSet::new();
        ids.iter().copied().filter(|id| seen.insert(*id)).collect()
    };
    if ids.is_empty() {
        return Ok(false);
    }
    let mut moving = Vec::with_capacity(ids.len());
    for id in &ids {
        let (ti, ci) = seq.locate(*id).ok_or(EditError::ClipNotFound)?;
        if seq.tracks[ti].locked {
            return Err(EditError::TrackLocked);
        }
        moving.push((ti, seq.tracks[ti].clips[ci].start));
    }
    let min_start = moving.iter().map(|(_, s)| *s).min().unwrap_or(0);
    let delta = delta.max(-min_start);

    // Map each source track to its destination.
    let mut dest = HashMap::new();
    for (ti, _) in &moving {
        let kind = seq.tracks[*ti].kind;
        let target = if track_delta != 0 && track_kind.is_none_or(|k| k == kind) {
            let of_kind = seq.tracks_of(kind);
            let pos = of_kind.iter().position(|i| i == ti).expect("track of kind") as i64;
            let new_pos = pos + track_delta as i64;
            if new_pos < 0 || new_pos >= of_kind.len() as i64 {
                return Err(EditError::TrackOutOfRange);
            }
            of_kind[new_pos as usize]
        } else {
            *ti
        };
        if seq.tracks[target].locked {
            return Err(EditError::TrackLocked);
        }
        dest.insert(*ti, target);
    }
    if delta == 0 && dest.iter().all(|(a, b)| a == b) {
        return Ok(false);
    }

    let idset: HashSet<Uuid> = ids.iter().copied().collect();
    let mut lifted = Vec::with_capacity(ids.len());
    for (ti, track) in seq.tracks.iter_mut().enumerate() {
        let mut i = 0;
        while i < track.clips.len() {
            if idset.contains(&track.clips[i].id) {
                let mut c = track.clips.remove(i);
                c.start += delta;
                lifted.push((dest[&ti], c));
            } else {
                i += 1;
            }
        }
    }
    for (t, c) in &lifted {
        clear_range(&mut seq.tracks[*t], c.start, c.end());
    }
    for (t, c) in lifted {
        insert_sorted(&mut seq.tracks[t], c);
    }
    Ok(true)
}

fn trim_clip(seq: &mut Sequence, media: &[MediaAsset], clip: Uuid, edge: Edge, delta: Frame, ripple: bool, linked: bool) -> Result<bool> {
    let rate = seq.settings.fps;
    let (ti, ci) = seq.locate(clip).ok_or(EditError::ClipNotFound)?;
    let edge_of = move |c: &Clip| match edge {
        Edge::Start => c.start,
        Edge::End => c.end(),
    };
    let mut targets = vec![(ti, ci)];
    if linked {
        targets.extend(partners(seq, ti, ci, |a, b| edge_of(a) == edge_of(b)));
    }
    check_unlocked(seq, &targets)?;

    let mut b = Bounds::new();
    for &(t, c) in &targets {
        let track = &seq.tracks[t];
        let cl = &track.clips[c];
        let len = media_len(media, cl, rate);
        match edge {
            Edge::Start => {
                b.max(cl.duration - 1);
                if let Some(len) = len {
                    b.min(-cl.room_before(len));
                }
                if !ripple {
                    let prev_end = if c > 0 { track.clips[c - 1].end() } else { 0 };
                    b.min(prev_end - cl.start);
                }
            }
            Edge::End => {
                b.min(1 - cl.duration);
                if let Some(len) = len {
                    b.max(cl.room_after(len));
                }
                if !ripple {
                    if let Some(next) = track.clips.get(c + 1) {
                        b.max(next.start - cl.end());
                    }
                }
            }
        }
    }
    let d = b.clamp(delta);
    if d == 0 {
        return Ok(false);
    }
    for &(t, c) in &targets {
        let track = &mut seq.tracks[t];
        let cl = &mut track.clips[c];
        match (edge, ripple) {
            (Edge::Start, false) => cl.set_range(cl.start + d, cl.end()),
            (Edge::Start, true) => {
                // The rest of the clip keeps its frames and moves back by d.
                let start = cl.start;
                cl.set_range(start + d, cl.end());
                cl.start = start;
                for f in &mut track.clips[c + 1..] {
                    f.start -= d;
                }
            }
            (Edge::End, false) => cl.set_range(cl.start, cl.end() + d),
            (Edge::End, true) => {
                cl.set_range(cl.start, cl.end() + d);
                for f in &mut track.clips[c + 1..] {
                    f.start += d;
                }
            }
        }
        clamp_fades(&mut track.clips[c]);
    }
    Ok(true)
}

fn roll_edit(seq: &mut Sequence, media: &[MediaAsset], clip: Uuid, delta: Frame, linked: bool) -> Result<bool> {
    let rate = seq.settings.fps;
    let (ti, ci) = seq.locate(clip).ok_or(EditError::ClipNotFound)?;
    let has_right = |seq: &Sequence, t: usize, c: usize| {
        let track = &seq.tracks[t];
        track.clips.get(c + 1).is_some_and(|r| r.start == track.clips[c].end())
    };
    if !has_right(seq, ti, ci) {
        return Err(EditError::NoNeighbor);
    }
    let mut pairs = vec![(ti, ci)];
    if linked {
        for (t, c) in partners(seq, ti, ci, |a, b| a.end() == b.end()) {
            if has_right(seq, t, c) {
                pairs.push((t, c));
            }
        }
    }
    check_unlocked(seq, &pairs)?;

    let mut b = Bounds::new();
    for &(t, c) in &pairs {
        let (l, r) = (&seq.tracks[t].clips[c], &seq.tracks[t].clips[c + 1]);
        b.min(1 - l.duration);
        b.max(r.duration - 1);
        if let Some(len) = media_len(media, l, rate) {
            b.max(l.room_after(len));
        }
        if let Some(len) = media_len(media, r, rate) {
            b.min(-r.room_before(len));
        }
    }
    let d = b.clamp(delta);
    if d == 0 {
        return Ok(false);
    }
    for &(t, c) in &pairs {
        let clips = &mut seq.tracks[t].clips;
        let l = &mut clips[c];
        l.set_range(l.start, l.end() + d);
        clamp_fades(l);
        let r = &mut clips[c + 1];
        r.set_range(r.start + d, r.end());
        clamp_fades(r);
    }
    Ok(true)
}

fn slip_clip(seq: &mut Sequence, media: &[MediaAsset], clip: Uuid, delta: Frame, linked: bool) -> Result<bool> {
    let rate = seq.settings.fps;
    let (ti, ci) = seq.locate(clip).ok_or(EditError::ClipNotFound)?;
    let mut targets = vec![(ti, ci)];
    if linked {
        targets.extend(partners(seq, ti, ci, |a, b| a.start == b.start && a.duration == b.duration));
    }
    check_unlocked(seq, &targets)?;
    let mut b = Bounds::new();
    for &(t, c) in &targets {
        let cl = &seq.tracks[t].clips[c];
        match media_len(media, cl, rate) {
            Some(len) => {
                b.min(-cl.frames_between(0.0, cl.source_in as f64));
                b.max(cl.frames_after_end(len));
            }
            // Slipping a still has no visible effect.
            None => b.max(0),
        }
    }
    let d = b.clamp(delta);
    if d == 0 {
        return Ok(false);
    }
    for &(t, c) in &targets {
        seq.tracks[t].clips[c].slip(d);
    }
    Ok(true)
}

fn slide_clip(seq: &mut Sequence, media: &[MediaAsset], clip: Uuid, delta: Frame, linked: bool) -> Result<bool> {
    let rate = seq.settings.fps;
    let (ti, ci) = seq.locate(clip).ok_or(EditError::ClipNotFound)?;
    let mut targets = vec![(ti, ci)];
    if linked {
        targets.extend(partners(seq, ti, ci, |a, b| a.start == b.start && a.duration == b.duration));
    }
    check_unlocked(seq, &targets)?;

    let mut b = Bounds::new();
    let mut adjacency = Vec::with_capacity(targets.len());
    for &(t, c) in &targets {
        let clips = &seq.tracks[t].clips;
        let cl = &clips[c];
        let prev = c.checked_sub(1).map(|p| &clips[p]);
        let next = clips.get(c + 1);
        let prev_adj = prev.is_some_and(|p| p.end() == cl.start);
        let next_adj = next.is_some_and(|n| n.start == cl.end());
        match prev {
            Some(p) if prev_adj => {
                b.min(1 - p.duration);
                if let Some(len) = media_len(media, p, rate) {
                    b.max(p.room_after(len));
                }
            }
            Some(p) => b.min(p.end() - cl.start),
            None => b.min(-cl.start),
        }
        match next {
            Some(n) if next_adj => {
                b.max(n.duration - 1);
                if let Some(len) = media_len(media, n, rate) {
                    b.min(-n.room_before(len));
                }
            }
            Some(n) => b.max(n.start - cl.end()),
            None => {}
        }
        adjacency.push((prev_adj, next_adj));
    }
    let d = b.clamp(delta);
    if d == 0 {
        return Ok(false);
    }
    for (&(t, c), &(prev_adj, next_adj)) in targets.iter().zip(&adjacency) {
        let clips = &mut seq.tracks[t].clips;
        clips[c].start += d;
        if prev_adj {
            let p = &mut clips[c - 1];
            p.set_range(p.start, p.end() + d);
            clamp_fades(p);
        }
        if next_adj {
            let n = &mut clips[c + 1];
            n.set_range(n.start + d, n.end());
            clamp_fades(n);
        }
    }
    Ok(true)
}

fn split_at(seq: &mut Sequence, frame: Frame, clips: Option<&[Uuid]>) -> Result<Vec<Uuid>> {
    let filter: Option<HashSet<Uuid>> = clips.map(|c| c.iter().copied().collect());
    // Validate first so the edit is all-or-nothing.
    if let Some(f) = &filter {
        for id in f {
            let (ti, _) = seq.locate(*id).ok_or(EditError::ClipNotFound)?;
            if seq.tracks[ti].locked {
                return Err(EditError::TrackLocked);
            }
        }
    }
    let mut link_map = HashMap::new();
    let mut created = Vec::new();
    for track in &mut seq.tracks {
        if track.locked {
            continue;
        }
        let Some(i) = track.clips.iter().position(|c| {
            c.start < frame && frame < c.end() && filter.as_ref().is_none_or(|f| f.contains(&c.id))
        }) else {
            continue;
        };
        let (l, r) = split_clip(&track.clips[i], frame, &mut link_map);
        created.push(r.id);
        track.clips[i] = l;
        track.clips.insert(i + 1, r);
    }
    Ok(created)
}

fn delete_clips(seq: &mut Sequence, ids: &[Uuid], ripple: bool) -> Result<bool> {
    let set: HashSet<Uuid> = ids.iter().copied().collect();
    for id in &set {
        let (ti, _) = seq.locate(*id).ok_or(EditError::ClipNotFound)?;
        if seq.tracks[ti].locked {
            return Err(EditError::TrackLocked);
        }
    }
    if set.is_empty() {
        return Ok(false);
    }
    for track in &mut seq.tracks {
        let mut removed: Vec<(Frame, Frame)> =
            track.clips.iter().filter(|c| set.contains(&c.id)).map(|c| (c.start, c.end())).collect();
        if removed.is_empty() {
            continue;
        }
        track.clips.retain(|c| !set.contains(&c.id));
        if ripple {
            removed.sort_by_key(|r| std::cmp::Reverse(r.0));
            for (s, e) in removed {
                for c in track.clips.iter_mut().filter(|c| c.start >= e) {
                    c.start -= e - s;
                }
            }
        }
    }
    Ok(true)
}

fn close_gap(seq: &mut Sequence, track: Uuid, frame: Frame) -> Result<bool> {
    let t = seq.track_mut(track).ok_or(EditError::TrackNotFound)?;
    if t.locked {
        return Err(EditError::TrackLocked);
    }
    if t.clips.iter().any(|c| c.start <= frame && frame < c.end()) {
        return Err(EditError::Invalid("no gap at this position".into()));
    }
    let prev_end = t.clips.iter().filter(|c| c.end() <= frame).map(Clip::end).max().unwrap_or(0);
    let Some(next) = t.clips.iter().position(|c| c.start > frame) else { return Ok(false) };
    let gap = t.clips[next].start - prev_end;
    if gap <= 0 {
        return Ok(false);
    }
    for c in &mut t.clips[next..] {
        c.start -= gap;
    }
    Ok(true)
}

/// Sorted, de-duplicated (last wins) and clamped keys for `param`.
fn set_keyframes(seq: &mut Sequence, media: &[MediaAsset], clip: Uuid, param: Param, keys: &[Keyframe]) -> Result<bool> {
    let (ti, ci) = seq.locate(clip).ok_or(EditError::ClipNotFound)?;
    if seq.tracks[ti].locked {
        return Err(EditError::TrackLocked);
    }
    let audio = seq.tracks[ti].kind == TrackKind::Audio;
    if param != Param::Speed && audio != param.is_audio() {
        return Err(EditError::Invalid("property does not apply to this clip".into()));
    }
    let (lo, hi) = param.range();
    let mut clean: Vec<Keyframe> = Vec::with_capacity(keys.len());
    for k in keys {
        if !k.value.is_finite() {
            return Err(EditError::Invalid("keyframe value".into()));
        }
        let mut k = Keyframe { value: k.value.clamp(lo, hi), ease: k.ease.sanitized(), ..*k };
        // Speed ramps are linear (constant acceleration) or held.
        if param == Param::Speed && k.ease != Ease::Hold {
            k.ease = Ease::Linear;
        }
        match clean.iter_mut().find(|x| x.at == k.at) {
            Some(x) => *x = k,
            None => clean.push(k),
        }
    }
    clean.sort_by_key(|k| k.at);
    if param == Param::Speed {
        return set_speed_keys(seq, media, ti, ci, clean);
    }
    let c = &mut seq.tracks[ti].clips[ci];
    if c.keys_of(param) == clean.as_slice() {
        return Ok(false);
    }
    if clean.is_empty() {
        c.keys.remove(&param);
    } else {
        c.keys.insert(param, clean);
    }
    Ok(true)
}

/// Speed keys of a clip and its linked partners (same position and length):
/// each keeps its source range, so its length follows the new timing.
fn set_speed_keys(seq: &mut Sequence, media: &[MediaAsset], ti: usize, ci: usize, keys: Vec<Keyframe>) -> Result<bool> {
    let rate = seq.settings.fps;
    let mut targets = vec![(ti, ci)];
    targets.extend(partners(seq, ti, ci, |a, b| a.start == b.start && a.duration == b.duration && a.source_in == b.source_in));
    check_unlocked(seq, &targets)?;
    let mut changed = false;
    for (t, c) in targets {
        let next_start = seq.tracks[t].clips.get(c + 1).map(|n| n.start);
        let len = media_len(media, &seq.tracks[t].clips[c], rate);
        let cl = &mut seq.tracks[t].clips[c];
        if cl.keys_of(Param::Speed) == keys.as_slice() {
            continue;
        }
        let out = cl.source_out();
        if keys.is_empty() {
            cl.keys.remove(&Param::Speed);
        } else {
            cl.keys.insert(Param::Speed, keys.clone());
        }
        retime(cl, out, next_start, len);
        clamp_fades(cl);
        changed = true;
    }
    Ok(changed)
}

/// After a speed change: the clip shows `source_in..out` again, without
/// running into the next clip or past the end of its media.
fn retime(c: &mut Clip, out: Frame, next_start: Option<Frame>, len: Option<Frame>) {
    c.duration = c.duration_for(out);
    if let Some(n) = next_start {
        if c.end() > n {
            c.set_range(c.start, n.max(c.start + 1));
        }
    }
    if let Some(len) = len {
        fit_into_media(c, len);
    }
}

/// Keeps every frame the clip shows inside a media of `len` frames: shorter
/// first, and when even one frame reaches past the end (high speed, or a
/// range that starts at the end), the range starts earlier so it ends at `len`.
fn fit_into_media(c: &mut Clip, len: Frame) {
    if c.shows_only_media(len) {
        return;
    }
    c.duration = c.duration.min(c.max_duration_in(len));
    if !c.shows_only_media(len) {
        let w = c.warp();
        c.source_in = ((w.s(w.w(len as f64) - c.duration as f64) + 1e-9).floor() as Frame).max(0);
    }
}

fn clean_effects(effects: &[Effect]) -> Result<Vec<Effect>> {
    let mut clean = Vec::with_capacity(effects.len());
    for e in effects {
        let kind = e.kind.sanitized().ok_or_else(|| EditError::Invalid("effect parameter".into()))?;
        let mut x = Effect { id: e.id, enabled: e.enabled, name: e.name.chars().filter(|c| !c.is_control()).take(80).collect(), kind, keys: e.keys.clone() };
        x.keys = x.clean_keys().ok_or_else(|| EditError::Invalid("effect keyframe".into()))?;
        clean.push(x);
    }
    Ok(clean)
}

fn effect_targets(seq: &Sequence, clips: &[Uuid]) -> Result<Vec<(usize, usize)>> {
    let mut at = Vec::with_capacity(clips.len());
    for id in clips {
        let (ti, ci) = seq.locate(*id).ok_or(EditError::ClipNotFound)?;
        let t = &seq.tracks[ti];
        if t.locked {
            return Err(EditError::TrackLocked);
        }
        if t.kind != TrackKind::Video {
            return Err(EditError::Invalid("effects apply to video clips".into()));
        }
        at.push((ti, ci));
    }
    Ok(at)
}

/// Longest effect stack a clip may have.
const MAX_EFFECTS: usize = 64;

fn add_effects(seq: &mut Sequence, clips: &[Uuid], effects: &[Effect]) -> Result<bool> {
    let clean = clean_effects(effects)?;
    let at = effect_targets(seq, clips)?;
    if clean.is_empty() {
        return Ok(false);
    }
    for &(ti, ci) in &at {
        if seq.tracks[ti].clips[ci].effects.len() + clean.len() > MAX_EFFECTS {
            return Err(EditError::Invalid("too many effects on one clip".into()));
        }
    }
    for (ti, ci) in at {
        let c = &mut seq.tracks[ti].clips[ci];
        c.effects.extend(clean.iter().map(|e| Effect { id: Uuid::new_v4(), ..e.clone() }));
    }
    Ok(true)
}

fn set_effects(seq: &mut Sequence, clips: &[Uuid], effects: &[Effect]) -> Result<bool> {
    let clean = clean_effects(effects)?;
    if clean.len() > MAX_EFFECTS {
        return Err(EditError::Invalid("too many effects on one clip".into()));
    }
    let at = effect_targets(seq, clips)?;
    let mut changed = false;
    for (ti, ci) in at {
        let c = &mut seq.tracks[ti].clips[ci];
        if c.effects != clean {
            c.effects = clean.clone();
            changed = true;
        }
    }
    Ok(changed)
}

fn set_transitions(seq: &mut Sequence, items: &[TransitionEdit]) -> Result<bool> {
    let mut at = Vec::with_capacity(items.len());
    for item in items {
        let (ti, ci) = seq.locate(item.clip).ok_or(EditError::ClipNotFound)?;
        let t = &seq.tracks[ti];
        if t.locked {
            return Err(EditError::TrackLocked);
        }
        if let Some(tr) = item.transition {
            let adjacent = ci > 0 && t.clips[ci - 1].end() == t.clips[ci].start;
            if !adjacent {
                return Err(EditError::Invalid("transitions need a clip directly before".into()));
            }
            if tr.kind.is_audio() != (t.kind == TrackKind::Audio) || !(1..=MAX_TRANSITION).contains(&tr.duration) {
                return Err(EditError::Invalid("transition".into()));
            }
        }
        at.push((ti, ci, item.transition));
    }
    let mut changed = false;
    for (ti, ci, tr) in at {
        let c = &mut seq.tracks[ti].clips[ci];
        changed |= c.transition != tr;
        c.transition = tr;
    }
    Ok(changed)
}

fn set_audio_effects(seq: &mut Sequence, items: &[AudioEffectsEdit]) -> Result<bool> {
    let mut at = Vec::with_capacity(items.len());
    for item in items {
        let (ti, ci) = seq.locate(item.clip).ok_or(EditError::ClipNotFound)?;
        let t = &seq.tracks[ti];
        if t.locked {
            return Err(EditError::TrackLocked);
        }
        if t.kind != TrackKind::Audio {
            return Err(EditError::Invalid("audio effects apply to audio clips".into()));
        }
        let clean = crate::audio::sanitize_effects(&item.effects).ok_or_else(|| EditError::Invalid("audio effect parameter".into()))?;
        at.push((ti, ci, clean));
    }
    let mut changed = false;
    for (ti, ci, effects) in at {
        let c = &mut seq.tracks[ti].clips[ci];
        changed |= c.audio_effects != effects;
        c.audio_effects = effects;
    }
    Ok(changed)
}

fn set_clip_gain(seq: &mut Sequence, gains: &[ClipGain]) -> Result<bool> {
    // Validate everything first so a bad entry leaves the sequence untouched.
    let mut at = Vec::with_capacity(gains.len());
    for g in gains {
        let (ti, ci) = seq.locate(g.clip).ok_or(EditError::ClipNotFound)?;
        let t = &seq.tracks[ti];
        if t.locked {
            return Err(EditError::TrackLocked);
        }
        if t.kind != TrackKind::Audio || !g.volume_db.is_finite() || g.limit_db.is_some_and(|v| !v.is_finite()) {
            return Err(EditError::Invalid("gain applies to audio clips".into()));
        }
        at.push((ti, ci));
    }
    let (lo, hi) = Param::Volume.range();
    let mut changed = false;
    for (g, (ti, ci)) in gains.iter().zip(at) {
        let c = &mut seq.tracks[ti].clips[ci];
        let target = g.volume_db.clamp(lo, hi);
        if let Some(ceiling) = g.limit_db {
            let limiter = AudioEffectKind::Limiter { ceiling_db: ceiling - target, release_ms: 50.0 }.sanitized().expect("finite");
            match c.audio_effects.last_mut() {
                Some(e) if matches!(e.kind, AudioEffectKind::Limiter { .. }) => {
                    changed |= e.kind != limiter || !e.enabled;
                    e.kind = limiter;
                    e.enabled = true;
                }
                _ => {
                    c.audio_effects.push(AudioEffect { id: Uuid::new_v4(), enabled: true, kind: limiter });
                    changed = true;
                }
            }
        }
        let delta = target - c.volume_db;
        if delta == 0.0 {
            continue;
        }
        c.volume_db = target;
        if let Some(keys) = c.keys.get_mut(&Param::Volume) {
            for k in keys {
                k.value = (k.value + delta).clamp(lo, hi);
            }
        }
        changed = true;
    }
    Ok(changed)
}

/// Lift or extract `start..end`. Straddling clips are split (linked halves
/// stay linked), the inside is removed and, with `ripple`, everything after
/// the range moves left on the affected tracks. Clears In/Out afterwards.
fn remove_range(seq: &mut Sequence, start: Frame, end: Frame, ripple: bool, tracks: Option<&[Uuid]>) -> Result<bool> {
    if start < 0 || end <= start {
        return Err(EditError::Invalid("empty range".into()));
    }
    let mut changed = false;
    let mut links_at_start = HashMap::new();
    let mut links_at_end = HashMap::new();
    for track in &mut seq.tracks {
        if track.locked || tracks.is_some_and(|t| !t.contains(&track.id)) {
            continue;
        }
        for (frame, links) in [(start, &mut links_at_start), (end, &mut links_at_end)] {
            if let Some(i) = track.clips.iter().position(|c| c.start < frame && frame < c.end()) {
                let (l, r) = split_clip(&track.clips[i], frame, links);
                track.clips[i] = l;
                track.clips.insert(i + 1, r);
            }
        }
        let before = track.clips.len();
        track.clips.retain(|c| c.end() <= start || c.start >= end);
        changed |= track.clips.len() != before;
        if ripple {
            for c in track.clips.iter_mut().filter(|c| c.start >= end) {
                c.start -= end - start;
                changed = true;
            }
        }
    }
    if changed {
        seq.in_point = None;
        seq.out_point = None;
    }
    Ok(changed)
}

/// Puts `id` into the clip and its linked partners (those the media has a
/// stream for), keeping start and length. The source starts at 0; the clip
/// gets shorter if the new media is.
fn replace_media(seq: &mut Sequence, media: &[MediaAsset], clip: Uuid, id: Uuid) -> Result<bool> {
    let asset = media.iter().find(|m| m.id == id).ok_or(EditError::MediaNotFound)?;
    if asset.status != MediaStatus::Ready || asset.info.is_none() {
        return Err(EditError::MediaNotReady);
    }
    let serves = |kind: TrackKind| match kind {
        TrackKind::Video => asset.has_video(),
        TrackKind::Audio => asset.has_audio(),
    };
    let (ti, ci) = seq.locate(clip).ok_or(EditError::ClipNotFound)?;
    if !serves(seq.tracks[ti].kind) {
        return Err(EditError::TrackKindMismatch);
    }
    let mut targets = vec![(ti, ci)];
    targets.extend(partners(seq, ti, ci, |_, _| true).into_iter().filter(|(t, _)| serves(seq.tracks[*t].kind)));
    check_unlocked(seq, &targets)?;
    let len = asset.length_frames(seq.settings.fps);
    for (t, c) in targets {
        let cl = &mut seq.tracks[t].clips[c];
        cl.media_id = id;
        cl.name = asset.name.clone();
        cl.source_in = 0;
        if let Some(len) = len {
            cl.duration = cl.duration.min(cl.frames_between(0.0, len as f64)).max(1);
        }
        clamp_fades(cl);
    }
    Ok(true)
}

/// Pastes clips (from the clipboard or a duplicate). Their sources must be
/// in `media` (the sequence's sources): clips copied from another project,
/// or from a nested sequence that was removed since, are refused, and so is
/// a nested sequence pasted into itself.
fn paste(seq: &mut Sequence, media: &[MediaAsset], items: &[PasteItem], at: Frame) -> Result<Vec<Uuid>> {
    let rate = seq.settings.fps;
    // Clips copied from a sequence with another frame rate, in this one's frames.
    let items: Vec<PasteItem> = items
        .iter()
        .map(|i| {
            let mut i = i.clone();
            if let Some(from) = i.rate.filter(|r| *r != rate && r.is_valid()) {
                convert_clip(&mut i.clip, from, rate);
                i.rate = Some(rate);
            }
            i
        })
        .collect();
    let items = &items[..];
    let Some(min_start) = items.iter().map(|i| i.clip.start).min() else { return Ok(Vec::new()) };
    let offset = at.max(0) - min_start;
    let mut targets = Vec::with_capacity(items.len());
    for item in items {
        let source = media.iter().find(|m| m.id == item.clip.media_id);
        let Some(source) = source else {
            return Err(if item.clip.media_id == seq.id { EditError::NestCycle } else { EditError::MediaNotFound });
        };
        let fits = match item.kind {
            TrackKind::Video => source.has_video(),
            TrackKind::Audio => source.has_audio(),
        };
        if !fits {
            return Err(EditError::NoFootage);
        }
        let idx = match seq.track_index(item.track).filter(|&i| seq.tracks[i].kind == item.kind) {
            Some(i) => i,
            None => first_track(seq, item.kind),
        };
        if seq.tracks[idx].locked {
            return Err(EditError::TrackLocked);
        }
        targets.push(seq.tracks[idx].id);
    }
    let mut link_map: HashMap<Uuid, Uuid> = HashMap::new();
    let mut created = Vec::with_capacity(items.len());
    for (item, track_id) in items.iter().zip(targets) {
        let mut c = item.clip.clone();
        c.id = Uuid::new_v4();
        c.start += offset;
        c.transition = None;
        c.link = c.link.map(|l| *link_map.entry(l).or_insert_with(Uuid::new_v4));
        if let Some(len) = media_len(media, &c, rate) {
            fit_into_media(&mut c, len);
        }
        clamp_fades(&mut c);
        let t = seq.track_mut(track_id).expect("resolved");
        clear_range(t, c.start, c.end());
        created.push(c.id);
        insert_sorted(t, c);
    }
    Ok(created)
}

fn update_clips(seq: &mut Sequence, media: &[MediaAsset], ids: &[Uuid], p: &ClipPatch) -> Result<bool> {
    let rate = seq.settings.fps;
    let mut located = Vec::with_capacity(ids.len());
    for id in ids {
        let (ti, ci) = seq.locate(*id).ok_or(EditError::ClipNotFound)?;
        if seq.tracks[ti].locked {
            return Err(EditError::TrackLocked);
        }
        located.push((ti, ci));
    }
    // Timing changes keep linked picture and sound together.
    if p.speed.is_some() || p.reverse.is_some() {
        for (ti, ci) in located.clone() {
            for pc in partners(seq, ti, ci, |a, b| a.start == b.start && a.duration == b.duration && a.source_in == b.source_in) {
                if !located.contains(&pc) {
                    check_unlocked(seq, &[pc])?;
                    located.push(pc);
                }
            }
        }
    }
    let name = p.name.as_deref().map(non_empty).transpose()?;
    let mut changed = false;
    for (ti, ci) in located {
        let next_start = seq.tracks[ti].clips.get(ci + 1).map(|n| n.start);
        let len = media_len(media, &seq.tracks[ti].clips[ci], rate);
        let c = &mut seq.tracks[ti].clips[ci];
        let before = c.clone();
        if let Some(n) = &name {
            c.name = n.clone();
        }
        if let Some(v) = p.enabled {
            c.enabled = v;
        }
        if let Some(t) = p.transform {
            c.transform = sanitize_transform(t);
        }
        if let Some(v) = p.opacity {
            c.opacity = v.clamp(0.0, 1.0);
        }
        if let Some(v) = p.volume_db {
            c.volume_db = v.clamp(-96.0, 24.0);
        }
        if let Some(v) = p.pan {
            c.pan = v.clamp(-1.0, 1.0);
        }
        if let Some(col) = p.color {
            c.color = ColorAdjust {
                exposure: col.exposure.clamp(-4.0, 4.0),
                contrast: col.contrast.clamp(-1.0, 1.0),
                saturation: col.saturation.clamp(0.0, 2.0),
                temperature: col.temperature.clamp(-1.0, 1.0),
                tint: col.tint.clamp(-1.0, 1.0),
            };
        }
        if let Some(l) = p.label {
            c.label = l;
        }
        if let Some(m) = p.channels {
            c.channels = m;
        }
        if let Some(s) = p.speed {
            if !s.is_finite() {
                return Err(EditError::Invalid("speed".into()));
            }
            let s = s.clamp(MIN_SPEED, MAX_SPEED);
            if (s - c.speed).abs() > 1e-9 {
                let out = c.source_out();
                c.speed = s;
                retime(c, out, next_start, len);
            }
        }
        if let Some(r) = p.reverse {
            // Same source range and length, played the other way. Forward the
            // range may end up to half a frame past the media (only the start of
            // the last frame must lie in it); reversed that frame comes first.
            c.reverse = r;
            if let Some(len) = len {
                fit_into_media(c, len);
            }
        }
        if let Some(b) = p.fx_bypass {
            c.fx_bypass = b;
        }
        if let Some(m) = p.blend_mode {
            c.blend_mode = m;
        }
        if let Some(d) = &p.denoise {
            if seq.tracks[ti].kind != TrackKind::Audio {
                return Err(EditError::Invalid("noise reduction needs an audio clip".into()));
            }
            let d = d.sanitized().ok_or_else(|| EditError::Invalid("noise reduction".into()))?;
            seq.tracks[ti].clips[ci].denoise = Some(d);
        }
        let c = &mut seq.tracks[ti].clips[ci];
        if let Some(v) = p.fade_in {
            c.fade_in = v;
        }
        if let Some(v) = p.fade_out {
            c.fade_out = v;
        }
        clamp_fades(c);
        changed |= *c != before;
    }
    Ok(changed)
}

fn sanitize_transform(t: Transform) -> Transform {
    let f = |v: f32, lo: f32, hi: f32, def: f32| if v.is_finite() { v.clamp(lo, hi) } else { def };
    let mut t = Transform {
        x: f(t.x, -100_000.0, 100_000.0, 0.0),
        y: f(t.y, -100_000.0, 100_000.0, 0.0),
        scale: f(t.scale, 0.0, 100.0, 1.0),
        rotation: f(t.rotation, -36_000.0, 36_000.0, 0.0),
        anchor_x: f(t.anchor_x, -10.0, 10.0, 0.5),
        anchor_y: f(t.anchor_y, -10.0, 10.0, 0.5),
        crop_left: f(t.crop_left, 0.0, 0.99, 0.0),
        crop_right: f(t.crop_right, 0.0, 0.99, 0.0),
        crop_top: f(t.crop_top, 0.0, 0.99, 0.0),
        crop_bottom: f(t.crop_bottom, 0.0, 0.99, 0.0),
    };
    if t.crop_left + t.crop_right > 0.99 {
        t.crop_right = 0.99 - t.crop_left;
    }
    if t.crop_top + t.crop_bottom > 0.99 {
        t.crop_bottom = 0.99 - t.crop_top;
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    const FPS: Rational = Rational::new(25, 1);

    fn video_asset(seconds: f64, audio: bool) -> MediaAsset {
        MediaAsset {
            id: Uuid::new_v4(),
            path: "clip.mp4".into(),
            name: "clip".into(),
            kind: MediaKind::Video,
            status: MediaStatus::Ready,
            info: Some(MediaInfo {
                duration: seconds,
                size_bytes: 1,
                container: "mp4".into(),
                bit_rate: None,
                video: Some(VideoInfo {
                    codec: "h264".into(),
                    profile: None,
                    width: 1280,
                    height: 720,
                    fps: FPS,
                    pix_fmt: None,
                    bit_rate: None,
                    rotation: 0,
                    color: Default::default(),
                }),
                audio: audio.then(|| AudioInfo {
                    codec: "aac".into(),
                    channels: 2,
                    sample_rate: 48_000,
                    channel_layout: None,
                    bit_rate: None,
                }),
            }),
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

    struct Fx {
        p: Project,
        seq: Uuid,
        media: Uuid,
    }

    impl Fx {
        fn new(seconds: f64, audio: bool) -> Self {
            let mut p = Project::new("t", 0);
            let asset = video_asset(seconds, audio);
            let media = asset.id;
            p.media.push(asset);
            let seq = p.active_sequence;
            Self { p, seq, media }
        }
        fn run(&mut self, cmd: EditCommand) -> EditOutcome {
            apply(&mut self.p, &cmd).expect("edit succeeds")
        }
        fn place(&mut self, at: Frame, sin: Option<Frame>, sout: Option<Frame>, mode: PlaceMode) -> Vec<Uuid> {
            self.run(EditCommand::PlaceMedia {
                sequence: self.seq,
                media: self.media,
                video_track: None,
                audio_track: None,
                at,
                mode,
                source_in: sin,
                source_out: sout,
                match_sequence: false,
            })
            .created
        }
        fn clone_project(&self) -> Project {
            self.p.clone()
        }
        fn s(&self) -> &Sequence {
            self.p.sequence(self.seq).unwrap()
        }
        fn v1(&self) -> &Track {
            &self.s().tracks[0]
        }
        fn a1(&self) -> &Track {
            self.s().tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap()
        }
        fn spans(t: &Track) -> Vec<(Frame, Frame, Frame)> {
            t.clips.iter().map(|c| (c.start, c.duration, c.source_in)).collect()
        }
    }

    #[test]
    fn place_creates_linked_av_pair() {
        let mut fx = Fx::new(4.0, true);
        let ids = fx.place(10, None, None, PlaceMode::Overwrite);
        assert_eq!(ids.len(), 2);
        let v = &fx.v1().clips[0];
        let a = &fx.a1().clips[0];
        assert_eq!((v.start, v.duration), (10, 100));
        assert_eq!(v.link, a.link);
        assert!(v.link.is_some());
    }

    #[test]
    fn place_overwrite_cuts_underlying_clip() {
        let mut fx = Fx::new(10.0, false);
        fx.place(0, None, None, PlaceMode::Overwrite); // 0..250
        fx.place(50, Some(0), Some(25), PlaceMode::Overwrite); // 50..75
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 50, 0), (50, 25, 0), (75, 175, 75)]);
    }

    #[test]
    fn place_insert_ripples_all_unlocked_tracks() {
        let mut fx = Fx::new(10.0, true);
        fx.place(0, None, None, PlaceMode::Overwrite);
        fx.place(100, Some(0), Some(50), PlaceMode::Insert);
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 100, 0), (100, 50, 0), (150, 150, 100)]);
        assert_eq!(Fx::spans(fx.a1()), vec![(0, 100, 0), (100, 50, 0), (150, 150, 100)]);
    }

    #[test]
    fn place_matches_empty_sequence_to_media() {
        let mut fx = Fx::new(2.0, false);
        let out = fx.run(EditCommand::PlaceMedia {
            sequence: fx.seq,
            media: fx.media,
            video_track: None,
            audio_track: None,
            at: 0,
            mode: PlaceMode::Overwrite,
            source_in: None,
            source_out: None,
            match_sequence: true,
        });
        assert!(out.sequences_changed);
        assert_eq!((fx.s().settings.width, fx.s().settings.height), (1280, 720));
    }

    #[test]
    fn place_rejects_unready_media() {
        let mut fx = Fx::new(2.0, false);
        fx.p.media[0].status = MediaStatus::Analyzing;
        let err = apply(
            &mut fx.p,
            &EditCommand::PlaceMedia {
                sequence: fx.seq,
                media: fx.media,
                video_track: None,
                audio_track: None,
                at: 0,
                mode: PlaceMode::Overwrite,
                source_in: None,
                source_out: None,
                match_sequence: false,
            },
        );
        assert_eq!(err, Err(EditError::MediaNotReady));
    }

    #[test]
    fn move_overwrites_destination_and_clamps_at_zero() {
        let mut fx = Fx::new(10.0, false);
        let a = fx.place(0, Some(0), Some(50), PlaceMode::Overwrite)[0];
        fx.place(100, Some(0), Some(50), PlaceMode::Overwrite);
        // Move first clip onto the middle of the second.
        fx.run(EditCommand::MoveClips { sequence: fx.seq, clips: vec![a], delta: 125, track_delta: 0, track_kind: None });
        assert_eq!(Fx::spans(fx.v1()), vec![(100, 25, 0), (125, 50, 0)]);
        // Moving left past zero clamps.
        fx.run(EditCommand::MoveClips { sequence: fx.seq, clips: vec![a], delta: -1000, track_delta: 0, track_kind: None });
        assert_eq!(fx.v1().clips[0].start, 0);
    }

    #[test]
    fn move_across_video_tracks_keeps_audio_track() {
        let mut fx = Fx::new(4.0, true);
        let ids = fx.place(0, None, None, PlaceMode::Overwrite);
        fx.run(EditCommand::MoveClips {
            sequence: fx.seq,
            clips: ids.clone(),
            delta: 10,
            track_delta: 1,
            track_kind: Some(TrackKind::Video),
        });
        let s = fx.s();
        assert!(s.tracks[0].clips.is_empty());
        assert_eq!(s.tracks[1].clips[0].start, 10);
        assert_eq!(fx.a1().clips[0].start, 10);
        let err = apply(
            &mut fx.p,
            &EditCommand::MoveClips { sequence: fx.seq, clips: ids, delta: 0, track_delta: 5, track_kind: Some(TrackKind::Video) },
        );
        assert_eq!(err, Err(EditError::TrackOutOfRange));
    }

    #[test]
    fn trim_is_clamped_by_neighbours_and_media() {
        let mut fx = Fx::new(4.0, false); // 100 frames of media
        let a = fx.place(0, Some(10), Some(60), PlaceMode::Overwrite)[0]; // 0..50 src 10..60
        fx.place(80, Some(0), Some(20), PlaceMode::Overwrite);
        // End trim limited by neighbour at 80.
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: a, edge: Edge::End, delta: 100, ripple: false, linked: true });
        assert_eq!(fx.v1().clips[0].duration, 80);
        // Start trim outward limited by source_in (10 frames) and timeline zero.
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: a, edge: Edge::Start, delta: -50, ripple: false, linked: true });
        assert_eq!(Fx::spans(fx.v1())[0], (0, 80, 10));
        // Trimming in from the start shifts source.
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: a, edge: Edge::Start, delta: 5, ripple: false, linked: true });
        assert_eq!(Fx::spans(fx.v1())[0], (5, 75, 15));
        // Never shorter than one frame.
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: a, edge: Edge::End, delta: -1000, ripple: false, linked: true });
        assert_eq!(fx.v1().clips[0].duration, 1);
    }

    #[test]
    fn ripple_trim_shifts_followers() {
        let mut fx = Fx::new(10.0, true);
        let a = fx.place(0, Some(0), Some(50), PlaceMode::Overwrite)[0];
        fx.place(50, Some(0), Some(50), PlaceMode::Overwrite);
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: a, edge: Edge::End, delta: -20, ripple: true, linked: true });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 30, 0), (30, 50, 0)]);
        // Linked audio followed along.
        assert_eq!(Fx::spans(fx.a1()), vec![(0, 30, 0), (30, 50, 0)]);
        // Ripple head trim keeps the clip start.
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: a, edge: Edge::Start, delta: 10, ripple: true, linked: true });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 20, 10), (20, 50, 0)]);
    }

    #[test]
    fn roll_edit_moves_cut_point() {
        let mut fx = Fx::new(10.0, false);
        let a = fx.place(0, Some(0), Some(50), PlaceMode::Overwrite)[0];
        fx.place(50, Some(20), Some(70), PlaceMode::Overwrite);
        fx.run(EditCommand::RollEdit { sequence: fx.seq, clip: a, delta: -10, linked: true });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 40, 0), (40, 60, 10)]);
        // Right clip's source_in (10) limits rolling further left than -10.
        fx.run(EditCommand::RollEdit { sequence: fx.seq, clip: a, delta: -30, linked: true });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 30, 0), (30, 70, 0)]);
        let lone = fx.v1().clips[1].id;
        assert_eq!(
            apply(&mut fx.p, &EditCommand::RollEdit { sequence: fx.seq, clip: lone, delta: 1, linked: true }),
            Err(EditError::NoNeighbor)
        );
    }

    #[test]
    fn slip_respects_source_bounds() {
        let mut fx = Fx::new(4.0, false); // 100 frames
        let a = fx.place(0, Some(20), Some(60), PlaceMode::Overwrite)[0];
        fx.run(EditCommand::SlipClip { sequence: fx.seq, clip: a, delta: 1000, linked: true });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 40, 60)]);
        fx.run(EditCommand::SlipClip { sequence: fx.seq, clip: a, delta: -1000, linked: true });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 40, 0)]);
    }

    #[test]
    fn slide_adjusts_neighbours() {
        let mut fx = Fx::new(10.0, false);
        fx.place(0, Some(0), Some(50), PlaceMode::Overwrite);
        let b = fx.place(50, Some(100), Some(130), PlaceMode::Overwrite)[0];
        fx.place(80, Some(50), Some(100), PlaceMode::Overwrite);
        fx.run(EditCommand::SlideClip { sequence: fx.seq, clip: b, delta: 10, linked: true });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 60, 0), (60, 30, 100), (90, 40, 60)]);
    }

    #[test]
    fn split_remaps_links_of_right_halves() {
        let mut fx = Fx::new(4.0, true);
        fx.place(0, None, None, PlaceMode::Overwrite);
        let created = fx.run(EditCommand::SplitAt { sequence: fx.seq, frame: 40, clips: None }).created;
        assert_eq!(created.len(), 2);
        let (v, a) = (fx.v1(), fx.a1());
        assert_eq!(Fx::spans(v), vec![(0, 40, 0), (40, 60, 40)]);
        assert_eq!(v.clips[0].link, a.clips[0].link);
        assert_eq!(v.clips[1].link, a.clips[1].link);
        assert_ne!(v.clips[0].link, v.clips[1].link);
        // Splitting at a clip boundary is a no-op.
        assert!(!fx.run(EditCommand::SplitAt { sequence: fx.seq, frame: 40, clips: None }).changed);
    }

    #[test]
    fn lift_keeps_the_gap_and_extract_closes_it() {
        let mut fx = Fx::new(10.0, true);
        fx.place(0, Some(0), Some(100), PlaceMode::Overwrite);
        fx.run(EditCommand::SetInOut { sequence: fx.seq, in_point: Some(20), out_point: Some(30) });
        let mut lifted = fx.clone_project();
        apply(&mut lifted, &EditCommand::RemoveRange { sequence: fx.seq, start: 20, end: 30, ripple: false, tracks: None }).unwrap();
        let v1 = &lifted.sequence(fx.seq).unwrap().tracks[0];
        assert_eq!(Fx::spans(v1), vec![(0, 20, 0), (30, 70, 30)]);

        fx.run(EditCommand::RemoveRange { sequence: fx.seq, start: 20, end: 30, ripple: true, tracks: None });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 20, 0), (20, 70, 30)]);
        assert_eq!(Fx::spans(fx.a1()), vec![(0, 20, 0), (20, 70, 30)]);
        // Right halves of the A/V pair are still linked to each other.
        let (v, a) = (&fx.v1().clips[1], &fx.a1().clips[1]);
        assert!(v.link.is_some() && v.link == a.link && v.link != fx.v1().clips[0].link);
        assert_eq!((fx.s().in_point, fx.s().out_point), (None, None));
    }

    #[test]
    fn extract_skips_locked_and_untargeted_tracks() {
        let mut fx = Fx::new(10.0, true);
        fx.place(0, Some(0), Some(100), PlaceMode::Overwrite);
        let (v, a) = (fx.v1().id, fx.a1().id);
        fx.run(EditCommand::UpdateTrack { sequence: fx.seq, track: a, patch: TrackPatch { locked: Some(true), ..Default::default() } });
        fx.run(EditCommand::RemoveRange { sequence: fx.seq, start: 10, end: 20, ripple: true, tracks: Some(vec![v, a]) });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 10, 0), (10, 80, 20)]);
        assert_eq!(Fx::spans(fx.a1()), vec![(0, 100, 0)]);
        assert!(apply(&mut fx.p, &EditCommand::RemoveRange { sequence: fx.seq, start: 5, end: 5, ripple: true, tracks: None }).is_err());
    }

    #[test]
    fn replace_media_keeps_position_and_shortens_to_new_length() {
        let mut fx = Fx::new(10.0, true);
        let c = fx.place(40, Some(50), Some(150), PlaceMode::Overwrite)[0];
        let short = video_asset(2.0, true);
        let id = short.id;
        fx.p.media.push(short);
        fx.run(EditCommand::ReplaceMedia { sequence: fx.seq, clip: c, media: id });
        assert_eq!(Fx::spans(fx.v1()), vec![(40, 50, 0)]);
        assert_eq!(Fx::spans(fx.a1()), vec![(40, 50, 0)]);
        assert!(fx.s().tracks.iter().flat_map(|t| &t.clips).all(|cl| cl.media_id == id));
    }

    #[test]
    fn insert_still_imports_and_ripples_in_one_step() {
        let mut fx = Fx::new(10.0, true);
        fx.place(0, Some(0), Some(100), PlaceMode::Overwrite);
        let mut still = video_asset(0.04, false);
        still.kind = MediaKind::Image;
        let id = still.id;
        let v1 = fx.v1().id;
        let out = fx.run(EditCommand::InsertStill { sequence: fx.seq, asset: Box::new(still), track: v1, at: 40, duration: 50 });
        assert!(out.media_changed && out.created.len() == 1);
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 40, 0), (40, 50, 0), (90, 60, 40)]);
        assert_eq!(fx.v1().clips[1].media_id, id);
        // Audio keeps sync: a gap opens at the same place.
        assert_eq!(Fx::spans(fx.a1()), vec![(0, 40, 0), (90, 60, 40)]);
        assert!(fx.p.media(id).is_some());
    }

    #[test]
    fn keyframes_interpolate_with_easing_and_follow_the_source() {
        let mut fx = Fx::new(10.0, true);
        let v = fx.place(0, Some(0), Some(100), PlaceMode::Overwrite)[0];
        let k = |at, value, ease| Keyframe { at, value, ease };
        fx.run(EditCommand::SetKeyframes {
            sequence: fx.seq,
            clip: v,
            param: Param::X,
            // Unsorted on purpose, with a duplicate (last wins).
            keys: vec![k(60, 100.0, Ease::Linear), k(20, 0.0, Ease::Linear), k(20, 10.0, Ease::EaseIn)],
        });
        let c = fx.v1().clips[0].clone();
        assert_eq!(c.keys_of(Param::X).iter().map(|k| k.at).collect::<Vec<_>>(), vec![20, 60]);
        assert_eq!(c.param_at(Param::X, 0.0), 10.0);
        assert_eq!(c.param_at(Param::X, 90.0), 100.0);
        // Ease-in: a quarter of the way in time is 1/16 of the way in value.
        assert!((c.param_at(Param::X, 30.0) - (10.0 + 90.0 / 16.0)).abs() < 1e-4);
        assert_eq!(c.param_at(Param::Y, 30.0), 0.0, "unanimated params keep their static value");

        // Trimming the head keeps keys on the same source frames.
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: v, edge: Edge::Start, delta: 20, ripple: false, linked: true });
        let c = fx.v1().clips[0].clone();
        assert_eq!((c.start, c.source_in), (20, 20));
        assert_eq!(c.param_at(Param::X, 40.0), 100.0);
        // Split halves both carry the keys.
        fx.run(EditCommand::SplitAt { sequence: fx.seq, frame: 50, clips: None });
        assert!(fx.v1().clips.iter().all(|c| c.keys_of(Param::X).len() == 2));
    }

    #[test]
    fn clip_gain_moves_volume_keys_and_is_one_step() {
        let mut fx = Fx::new(10.0, true);
        let created = fx.place(0, Some(0), Some(100), PlaceMode::Overwrite);
        let (v, a) = (created[0], created[1]);
        let b = fx.place(100, Some(0), Some(50), PlaceMode::Overwrite)[1];
        let k = |at, value| Keyframe { at, value, ease: Ease::Linear };
        fx.run(EditCommand::SetKeyframes { sequence: fx.seq, clip: a, param: Param::Volume, keys: vec![k(0, -6.0), k(50, 0.0)] });
        let gains = vec![ClipGain { clip: a, volume_db: 4.5, limit_db: None }, ClipGain { clip: b, volume_db: -200.0, limit_db: None }];
        let out = fx.run(EditCommand::SetClipGain { sequence: fx.seq, gains });
        assert_eq!(out.label, "normalizeAudio");
        let clips = &fx.a1().clips;
        assert_eq!(clips[0].volume_db, 4.5);
        assert_eq!(clips[0].keys_of(Param::Volume).iter().map(|k| k.value).collect::<Vec<_>>(), vec![-1.5, 4.5]);
        assert_eq!(clips[1].volume_db, Param::Volume.range().0, "clamped");
        // Video clips have no gain; nothing changes when one is included.
        let before = fx.clone_project();
        assert!(apply(&mut fx.p, &EditCommand::SetClipGain { sequence: fx.seq, gains: vec![ClipGain { clip: b, volume_db: 0.0, limit_db: None }, ClipGain { clip: v, volume_db: 1.0, limit_db: None }] }).is_err());
        assert_eq!(fx.p, before);
    }

    #[test]
    fn audio_effects_channels_and_track_mix() {
        let mut fx = Fx::new(10.0, true);
        let created = fx.place(0, Some(0), Some(100), PlaceMode::Overwrite);
        let (v, a) = (created[0], created[1]);
        let comp = AudioEffect {
            id: Uuid::new_v4(),
            enabled: true,
            kind: AudioEffectKind::Compressor { threshold_db: -100.0, ratio: 4.0, attack_ms: 10.0, release_ms: 100.0, knee_db: 6.0, makeup_db: 2.0 },
        };
        let set = |clip, effects: Vec<AudioEffect>| EditCommand::SetAudioEffects { sequence: fx.seq, items: vec![AudioEffectsEdit { clip, effects }] };
        assert!(apply(&mut fx.p, &set(v, vec![comp.clone()])).is_err(), "video clips have no audio effects");
        let out = fx.run(set(a, vec![comp.clone()]));
        assert_eq!(out.label, "setAudioEffects");
        assert!(matches!(fx.a1().clips[0].audio_effects[0].kind, AudioEffectKind::Compressor { threshold_db, .. } if threshold_db == -60.0));
        // Normalising with a limiter appends one, a second time replaces it.
        for ceiling in [-1.0, -2.0] {
            fx.run(EditCommand::SetClipGain { sequence: fx.seq, gains: vec![ClipGain { clip: a, volume_db: 3.0, limit_db: Some(ceiling) }] });
        }
        let kinds: Vec<_> = fx.a1().clips[0].audio_effects.iter().map(|e| e.kind.clone()).collect();
        assert_eq!(kinds.len(), 2);
        // Ahead of the +3 dB clip volume: 3 dB lower.
        assert_eq!(kinds[1], AudioEffectKind::Limiter { ceiling_db: -5.0, release_ms: 50.0 });
        fx.run(EditCommand::UpdateClips { sequence: fx.seq, clips: vec![a], patch: ClipPatch { channels: Some(ChannelMap::Left), ..Default::default() } });
        assert_eq!(fx.a1().clips[0].channels, ChannelMap::Left);
        // Track mix: effects and mono only on audio tracks.
        let (vt, at) = (fx.v1().id, fx.a1().id);
        let patch = TrackPatch { effects: Some(vec![comp]), mono: Some(true), ..Default::default() };
        assert!(apply(&mut fx.p, &EditCommand::UpdateTrack { sequence: fx.seq, track: vt, patch: patch.clone() }).is_err());
        fx.run(EditCommand::UpdateTrack { sequence: fx.seq, track: at, patch });
        assert!(fx.a1().mono && fx.a1().effects.len() == 1);
    }

    #[test]
    fn keyframes_are_validated() {
        let mut fx = Fx::new(10.0, true);
        let ids = fx.place(0, Some(0), Some(100), PlaceMode::Overwrite);
        let (v, a) = (ids[0], ids[1]);
        let one = |value| vec![Keyframe { at: 0, value, ease: Ease::Hold }];
        assert!(apply(&mut fx.p, &EditCommand::SetKeyframes { sequence: fx.seq, clip: v, param: Param::Volume, keys: one(0.0) }).is_err());
        assert!(apply(&mut fx.p, &EditCommand::SetKeyframes { sequence: fx.seq, clip: a, param: Param::Scale, keys: one(1.0) }).is_err());
        fx.run(EditCommand::SetKeyframes { sequence: fx.seq, clip: v, param: Param::Opacity, keys: one(4.0) });
        assert_eq!(fx.v1().clips[0].keys_of(Param::Opacity)[0].value, 1.0, "clamped");
        let out = fx.run(EditCommand::SetKeyframes { sequence: fx.seq, clip: v, param: Param::Opacity, keys: vec![] });
        assert!(out.changed && fx.v1().clips[0].keys.is_empty());
    }

    #[test]
    fn colour_keys_and_custom_curves() {
        let mut fx = Fx::new(10.0, true);
        let ids = fx.place(0, Some(0), Some(100), PlaceMode::Overwrite);
        let (v, a) = (ids[0], ids[1]);
        let curve = Ease::Bezier { x1: 3.0, y1: 5.0, x2: f32::NAN, y2: 0.5 };
        let keys = vec![Keyframe { at: 0, value: -9.0, ease: curve }, Keyframe { at: 50, value: 1.0, ease: Ease::Linear }];
        fx.run(EditCommand::SetKeyframes { sequence: fx.seq, clip: v, param: Param::Exposure, keys: keys.clone() });
        let c = &fx.v1().clips[0];
        let k = c.keys_of(Param::Exposure);
        assert_eq!(k[0].value, -4.0, "clamped to the exposure range");
        assert_eq!(k[0].ease, Ease::Bezier { x1: 1.0, y1: 2.0, x2: 0.0, y2: 0.5 }, "control points clamped, NaN dropped");
        assert!(c.color_animated());
        assert_eq!(c.color_at(0.0).exposure, -4.0);
        assert_eq!(c.color_at(80.0).exposure, 1.0);
        // Colour is a picture property: audio clips reject it.
        assert!(apply(&mut fx.p, &EditCommand::SetKeyframes { sequence: fx.seq, clip: a, param: Param::Saturation, keys }).is_err());
    }

    #[test]
    fn source_marks_are_saved_and_clamped() {
        let mut fx = Fx::new(10.0, false);
        let m = fx.media;
        let out = fx.run(EditCommand::SetSourceMarks { media: m, marks: SourceMarks { in_point: Some(-3.0), out_point: Some(42.0) } });
        assert_eq!(out.label, "setSourceMarks");
        assert_eq!(fx.p.media(m).unwrap().marks, SourceMarks { in_point: Some(0.0), out_point: Some(10.0) });
        // Out before In is dropped; the same marks again are no change.
        fx.run(EditCommand::SetSourceMarks { media: m, marks: SourceMarks { in_point: Some(6.0), out_point: Some(2.0) } });
        assert_eq!(fx.p.media(m).unwrap().marks, SourceMarks { in_point: Some(6.0), out_point: None });
        let same = apply(&mut fx.p, &EditCommand::SetSourceMarks { media: m, marks: SourceMarks { in_point: Some(6.0), out_point: None } }).unwrap();
        assert!(!same.changed);
        let json = serde_json::to_string(&fx.p.media(m).unwrap().marks).unwrap();
        assert_eq!(json, r#"{"in":6.0,"out":null}"#);
    }

    #[test]
    fn ripple_delete_closes_the_hole() {
        let mut fx = Fx::new(10.0, false);
        fx.place(0, Some(0), Some(20), PlaceMode::Overwrite);
        let b = fx.place(30, Some(0), Some(20), PlaceMode::Overwrite)[0];
        fx.place(50, Some(0), Some(20), PlaceMode::Overwrite);
        fx.run(EditCommand::DeleteClips { sequence: fx.seq, clips: vec![b], ripple: true });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 20, 0), (30, 20, 0)]);
        let t = fx.v1().id;
        fx.run(EditCommand::CloseGap { sequence: fx.seq, track: t, frame: 25 });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 20, 0), (20, 20, 0)]);
    }

    #[test]
    fn locked_tracks_reject_edits() {
        let mut fx = Fx::new(4.0, false);
        let a = fx.place(0, None, None, PlaceMode::Overwrite)[0];
        let t = fx.v1().id;
        fx.run(EditCommand::UpdateTrack { sequence: fx.seq, track: t, patch: TrackPatch { locked: Some(true), ..Default::default() } });
        assert_eq!(
            apply(&mut fx.p, &EditCommand::DeleteClips { sequence: fx.seq, clips: vec![a], ripple: false }),
            Err(EditError::TrackLocked)
        );
        // Razor across all tracks silently skips locked ones.
        assert!(!fx.run(EditCommand::SplitAt { sequence: fx.seq, frame: 10, clips: None }).changed);
    }

    #[test]
    fn duplicate_places_copy_after_selection() {
        let mut fx = Fx::new(4.0, true);
        let ids = fx.place(0, Some(0), Some(40), PlaceMode::Overwrite);
        let created = fx.run(EditCommand::DuplicateClips { sequence: fx.seq, clips: ids }).created;
        assert_eq!(created.len(), 2);
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 40, 0), (40, 40, 0)]);
        let (v, a) = (fx.v1(), fx.a1());
        assert_eq!(v.clips[1].link, a.clips[1].link);
        assert_ne!(v.clips[0].link, v.clips[1].link);
    }

    #[test]
    fn reversed_clips_trim_split_and_slip_by_content() {
        let mut fx = Fx::new(10.0, true);
        // 10 s media = 250 frames; clip shows source 50..150 at 0..100.
        let ids = fx.place(0, Some(50), Some(150), PlaceMode::Overwrite);
        let (v, a) = (ids[0], ids[1]);
        fx.run(EditCommand::UpdateClips { sequence: fx.seq, clips: vec![v], patch: ClipPatch { reverse: Some(true), ..Default::default() } });
        // The linked audio follows.
        assert!(fx.a1().clips[0].reverse);
        let c = fx.v1().clips[0].clone();
        assert_eq!((c.source_in, c.source_out(), c.duration), (50, 150, 100));
        // Frame 0 shows the source frame just below 150, the last one 50.
        assert_eq!(c.source_at(0.0), 150.0);
        assert_eq!(c.source_at(100.0), 50.0);
        // Trimming the start in drops the latest content: source_in stays.
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: v, edge: Edge::Start, delta: 10, ripple: false, linked: true });
        let c = fx.v1().clips[0].clone();
        assert_eq!((c.start, c.source_in, c.source_out()), (10, 50, 140));
        // Extending the end reaches earlier content, down to source 0 (50 frames).
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: v, edge: Edge::End, delta: 80, ripple: false, linked: true });
        let c = fx.v1().clips[0].clone();
        assert_eq!((c.end(), c.source_in, c.source_out()), (150, 0, 140));
        // The start can grow back up to the media end (250): 110 frames (ripple: in place).
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: v, edge: Edge::Start, delta: -500, ripple: true, linked: true });
        let c = fx.v1().clips[0].clone();
        assert_eq!((c.start, c.duration, c.source_in, c.source_out()), (10, 250, 0, 250));
        // A split keeps every frame where it was: 90 frames in, the source is at 160.
        fx.run(EditCommand::SplitAt { sequence: fx.seq, frame: 100, clips: Some(vec![v]) });
        let (l, r) = (fx.v1().clips[0].clone(), fx.v1().clips[1].clone());
        assert_eq!((l.source_in, l.source_out(), r.source_in, r.source_out()), (160, 250, 0, 160));
        assert!(l.reverse && r.reverse);
        let _ = a;
    }

    #[test]
    fn reversing_keeps_every_shown_frame_inside_the_media() {
        let mut fx = Fx::new(10.0, true);
        // 250 frames at 3.1x: 80.6 timeline frames, rounded to 81. The range
        // reaches 251.1, past the media; the last forward frame (248) exists.
        let ids = fx.place(0, Some(0), Some(250), PlaceMode::Overwrite);
        let v = ids[0];
        fx.run(EditCommand::UpdateClips { sequence: fx.seq, clips: vec![v], patch: ClipPatch { speed: Some(3.1), ..Default::default() } });
        let c = fx.v1().clips[0].clone();
        assert_eq!((c.duration, c.shown_frame(80)), (81, 248));
        assert!(c.shows_only_media(250));
        // Reversed, frame 0 would show frame 251: the clip loses a frame.
        fx.run(EditCommand::UpdateClips { sequence: fx.seq, clips: vec![v], patch: ClipPatch { reverse: Some(true), ..Default::default() } });
        let c = fx.v1().clips[0].clone();
        assert_eq!((c.duration, c.shown_frame(0), c.shown_frame(79)), (80, 247, 3));
        assert!(c.shows_only_media(250) && fx.a1().clips[0].shows_only_media(250));
    }

    #[test]
    fn noise_reduction_is_for_audio_clips_and_sanitized() {
        let mut fx = Fx::new(10.0, true);
        let ids = fx.place(0, Some(0), Some(100), PlaceMode::Overwrite);
        let (v, a) = (ids[0], ids[1]);
        let d = Denoise { reduction_db: 200.0, floor_db: -10.0, profile: vec![30.0; 15], ..Default::default() };
        let patch = |d: Denoise| ClipPatch { denoise: Some(d), ..Default::default() };
        let before = fx.p.clone();
        assert!(apply(&mut fx.p, &EditCommand::UpdateClips { sequence: fx.seq, clips: vec![v], patch: patch(d.clone()) }).is_err(), "not on a video clip");
        assert_eq!(fx.p, before);
        let bad = Denoise { profile: vec![1.0; 3], ..d.clone() };
        assert!(apply(&mut fx.p, &EditCommand::UpdateClips { sequence: fx.seq, clips: vec![a], patch: patch(bad) }).is_err(), "profile of the wrong length");
        fx.run(EditCommand::UpdateClips { sequence: fx.seq, clips: vec![a], patch: patch(d) });
        let got = fx.a1().clips[0].denoise.clone().unwrap();
        assert_eq!((got.reduction_db, got.floor_db, got.profile[0]), (97.0, -20.0, 24.0), "clamped to afftdn's ranges");
        // Turning it off keeps the settings; the JSON round trip keeps them too.
        fx.run(EditCommand::UpdateClips { sequence: fx.seq, clips: vec![a], patch: patch(Denoise { enabled: false, ..got.clone() }) });
        let off = fx.a1().clips[0].clone();
        assert_eq!(off.denoise, Some(Denoise { enabled: false, ..got }));
        let json = serde_json::to_string(&off).unwrap();
        assert_eq!(serde_json::from_str::<Clip>(&json).unwrap(), off);
        assert!(!serde_json::to_string(&fx.v1().clips[0]).unwrap().contains("denoise"), "absent where unused");
    }

    #[test]
    fn speed_keys_retime_the_clip_and_its_partner() {
        let mut fx = Fx::new(10.0, true);
        let ids = fx.place(0, Some(0), Some(200), PlaceMode::Overwrite);
        let (v, a) = (ids[0], ids[1]);
        // 1x up to source 100, then ramping to 3x at 200: 100 + 2 * 100 / 4 = 150 frames.
        let k = |at, value| Keyframe { at, value, ease: Ease::EaseInOut };
        fx.run(EditCommand::SetKeyframes { sequence: fx.seq, clip: v, param: Param::Speed, keys: vec![k(100, 1.0), k(200, 3.0)] });
        let (cv, ca) = (fx.v1().clips[0].clone(), fx.a1().clips[0].clone());
        assert_eq!(cv.keys_of(Param::Speed)[0].ease, Ease::Linear);
        assert_eq!((cv.duration, cv.source_out()), (150, 200));
        assert_eq!(ca.keys_of(Param::Speed), cv.keys_of(Param::Speed));
        assert_eq!(ca.duration, 150);
        assert!((cv.speed_at(125.0) - 2.0).abs() < 1e-9);
        // Other curves run over timeline time between their keys.
        fx.run(EditCommand::SetKeyframes {
            sequence: fx.seq,
            clip: v,
            param: Param::Opacity,
            keys: vec![Keyframe { at: 100, value: 0.0, ease: Ease::Linear }, Keyframe { at: 200, value: 1.0, ease: Ease::Linear }],
        });
        let cv = fx.v1().clips[0].clone();
        assert!((cv.param_at(Param::Opacity, 125.0) - 0.5).abs() < 1e-6);
        // Slip and split work in timeline frames through the ramp.
        fx.run(EditCommand::SplitAt { sequence: fx.seq, frame: 125, clips: Some(vec![v]) });
        // 25 frames into the ramp: 100 + 25 + 0.5 * 0.04 * 25² = 137.5, the
        // frame shown there is 137. Starting half a frame early, the part
        // ends just before 200 (at 3x a third of a timeline frame), never past it.
        let r = fx.v1().clips[1].clone();
        assert_eq!((r.source_in, r.duration, r.source_out()), (137, 25, 199));
        // Without keys the rest of the range plays at 1x.
        fx.run(EditCommand::SetKeyframes { sequence: fx.seq, clip: r.id, param: Param::Speed, keys: vec![] });
        assert_eq!((fx.v1().clips[1].duration, fx.v1().clips[1].source_out()), (62, 199));
        assert!(fx.a1().clips[0].keys_of(Param::Speed).len() == 2 && a != r.id);
    }

    #[test]
    fn speed_change_rescales_duration() {
        let mut fx = Fx::new(10.0, false);
        let a = fx.place(0, Some(0), Some(100), PlaceMode::Overwrite)[0];
        fx.run(EditCommand::UpdateClips {
            sequence: fx.seq,
            clips: vec![a],
            patch: ClipPatch { speed: Some(2.0), ..Default::default() },
        });
        let c = &fx.v1().clips[0];
        assert_eq!((c.duration, c.source_out()), (50, 100));
    }

    #[test]
    fn changing_frame_rate_converts_positions() {
        let mut fx = Fx::new(10.0, false);
        fx.place(50, Some(25), Some(75), PlaceMode::Overwrite); // 2s..4s
        let mut settings = fx.s().settings;
        settings.fps = Rational::new(50, 1);
        fx.run(EditCommand::UpdateSequenceSettings { sequence: fx.seq, settings });
        assert_eq!(Fx::spans(fx.v1()), vec![(100, 100, 50)]);
    }

    #[test]
    fn changing_frame_rate_converts_keys_transitions_markers_and_subtitles() {
        let mut fx = Fx::new(10.0, false);
        let a = fx.place(0, Some(0), Some(50), PlaceMode::Overwrite)[0];
        let b = fx.place(50, Some(50), Some(100), PlaceMode::Overwrite)[0];
        let k = |at, value| Keyframe { at, value, ease: Ease::Linear };
        fx.run(EditCommand::SetKeyframes { sequence: fx.seq, clip: a, param: Param::Opacity, keys: vec![k(10, 0.0), k(40, 1.0)] });
        fx.run(EditCommand::SetTransitions { sequence: fx.seq, items: vec![TransitionEdit { clip: b, transition: Some(Transition { kind: TransitionKind::Dissolve, duration: 10, align: TransitionAlign::Center }) }] });
        fx.run(EditCommand::AddMarkers { sequence: fx.seq, markers: vec![NewMarker { frame: 25, name: "m".into(), note: String::new(), color: MarkerColor::Blue, category: String::new(), duration: 25, chapter: false }] });
        let cue = |start, end| Cue { id: Uuid::new_v4(), start, end, text: "x".into() };
        fx.run(EditCommand::SetSubtitles { sequence: fx.seq, cues: vec![cue(0, 25), cue(25, 50)] });
        let mut settings = fx.s().settings;
        settings.fps = Rational::new(50, 1);
        fx.run(EditCommand::UpdateSequenceSettings { sequence: fx.seq, settings });
        let s = fx.s();
        let ca = &s.tracks[0].clips[0];
        assert_eq!(ca.keys_of(Param::Opacity).iter().map(|k| k.at).collect::<Vec<_>>(), vec![20, 80]);
        assert_eq!(s.tracks[0].clips[1].transition.map(|t| t.duration), Some(20));
        assert_eq!((s.markers[0].frame, s.markers[0].duration), (50, 50));
        assert_eq!(s.subtitles.cues.iter().map(|c| (c.start, c.end)).collect::<Vec<_>>(), vec![(0, 50), (50, 100)]);
        // Down to 24 fps: keys a frame apart collapse, ranges stay inside the media.
        let mut fx = Fx::new(1.0, false);
        let c = fx.place(0, None, None, PlaceMode::Overwrite)[0];
        fx.run(EditCommand::SetKeyframes { sequence: fx.seq, clip: c, param: Param::Opacity, keys: vec![k(12, 0.0), k(13, 1.0)] });
        settings.fps = Rational::new(24, 1);
        fx.run(EditCommand::UpdateSequenceSettings { sequence: fx.seq, settings });
        let c = &fx.s().tracks[0].clips[0];
        assert_eq!(c.keys_of(Param::Opacity).len(), 1);
        assert!(c.source_out() <= 24);
    }

    #[test]
    fn removing_used_media_is_refused() {
        let mut fx = Fx::new(4.0, false);
        fx.place(0, None, None, PlaceMode::Overwrite);
        assert_eq!(apply(&mut fx.p, &EditCommand::RemoveMedia { media: vec![fx.media] }), Err(EditError::MediaInUse(1)));
    }

    #[test]
    fn commands_roundtrip_through_json() {
        let cmd: EditCommand = serde_json::from_str(
            r#"{"type":"trimClip","sequence":"00000000-0000-0000-0000-000000000001","clip":"00000000-0000-0000-0000-000000000002","edge":"end","delta":-3,"ripple":true}"#,
        )
        .unwrap();
        assert!(matches!(cmd, EditCommand::TrimClip { delta: -3, ripple: true, linked: true, .. }));
    }
    #[test]
    fn effects_are_sanitised_and_video_only() {
        let mut fx = Fx::new(4.0, true);
        let ids = fx.place(0, None, None, PlaceMode::Overwrite);
        let (v, a) = (ids[0], ids[1]);
        let effect = Effect::new;
        let stack = vec![
            effect(EffectKind::Blur { radius: 900.0 }),
            effect(EffectKind::Curves { master: vec![[0.7, 0.9], [0.2, 0.1], [0.2, 0.15], [1.0, 1.0]], red: vec![[0.0, 0.0], [1.0, 1.0]], green: vec![], blue: vec![] }),
        ];
        assert!(fx.run(EditCommand::SetEffects { sequence: fx.seq, clips: vec![v], effects: stack }).changed);
        let got = &fx.v1().clips[0].effects;
        assert_eq!(got[0].kind, EffectKind::Blur { radius: 250.0 });
        // Sorted, one point per input, and the diagonal red curve collapses to identity.
        assert_eq!(got[1].kind, EffectKind::Curves { master: vec![[0.2, 0.1], [0.7, 0.9], [1.0, 1.0]], red: vec![], green: vec![], blue: vec![] });
        assert_eq!(
            apply(&mut fx.p, &EditCommand::SetEffects { sequence: fx.seq, clips: vec![a], effects: vec![] }),
            Err(EditError::Invalid("effects apply to video clips".into()))
        );
        let nan = vec![effect(EffectKind::Vignette { amount: f32::NAN })];
        assert!(apply(&mut fx.p, &EditCommand::SetEffects { sequence: fx.seq, clips: vec![v], effects: nan }).is_err());
    }

    #[test]
    fn smart_bins_hold_rules_but_no_media_or_bins() {
        let mut fx = Fx::new(2.0, false);
        let rules = SmartRules {
            kinds: vec![SmartKind::Video, SmartKind::Video, SmartKind::Title],
            text: "  interview ".into(),
            tags: vec![" A ".into(), "a".into(), "".into(), "b".into()],
            labels: vec![LabelColor::Red, LabelColor::Red],
            ..Default::default()
        };
        let smart = fx.run(EditCommand::CreateBin { name: "Smart".into(), parent: None, smart: Some(rules) }).created[0];
        let r = fx.p.bins[0].smart.clone().expect("smart bin");
        assert_eq!(r.kinds, vec![SmartKind::Video, SmartKind::Title]);
        assert_eq!(r.text, "interview");
        assert_eq!(r.tags, vec!["A".to_string(), "b".to_string()]);
        assert_eq!(r.labels, vec![LabelColor::Red]);

        // Neither media nor bins go into a smart bin.
        let media = fx.media;
        assert!(apply(&mut fx.p, &EditCommand::MoveMediaToBin { media: vec![media], bin: Some(smart) }).is_err());
        assert!(apply(&mut fx.p, &EditCommand::CreateBin { name: "x".into(), parent: Some(smart), smart: None }).is_err());

        // Rules change only on a smart bin; the same rules are no change.
        let plain = fx.run(EditCommand::CreateBin { name: "Ordner".into(), parent: None, smart: None }).created[0];
        assert!(apply(&mut fx.p, &EditCommand::SetSmartRules { bin: plain, rules: SmartRules::default() }).is_err());
        let o = fx.run(EditCommand::SetSmartRules { bin: smart, rules: SmartRules { favorites: true, usage: SmartUsage::Unused, ..Default::default() } });
        assert!(o.changed && o.media_changed);
        let o = fx.run(EditCommand::SetSmartRules { bin: smart, rules: SmartRules { favorites: true, usage: SmartUsage::Unused, ..Default::default() } });
        assert!(!o.changed);
        let long = SmartRules { text: "x".repeat(SMART_TEXT_MAX + 50), tags: (0..40).map(|i| format!("t{i}")).collect(), ..Default::default() };
        fx.run(EditCommand::SetSmartRules { bin: smart, rules: long });
        let r = fx.p.bins.iter().find(|b| b.id == smart).and_then(|b| b.smart.clone()).unwrap();
        assert_eq!((r.text.chars().count(), r.tags.len()), (SMART_TEXT_MAX, SMART_TAGS_MAX));

        // A list with an unknown medium changes nothing (the edit is not in the history).
        let ghost = Uuid::new_v4();
        let patch = MediaPatch { note: Some("x".into()), ..Default::default() };
        assert!(apply(&mut fx.p, &EditCommand::UpdateMedia { media: vec![media, ghost], patch }).is_err());
        assert!(apply(&mut fx.p, &EditCommand::SetMediaFavorite { media: vec![media, ghost], favorite: true }).is_err());
        let m = fx.p.media(media).unwrap();
        assert_eq!((m.note.as_str(), m.favorite), ("", false));
        let tags: Vec<String> = [" b ", "a", "b", "", "x\ny", &"t".repeat(MAX_TAG + 9)].iter().map(|t| t.to_string()).chain((0..80).map(|i| format!("z{i:02}"))).collect();
        let note = format!("Zeile 1\nZeile 2\u{7}{}", "n".repeat(MAX_NOTE));
        fx.run(EditCommand::UpdateMedia { media: vec![media], patch: MediaPatch { tags: Some(tags), note: Some(note), ..Default::default() } });
        let m = fx.p.media(media).unwrap();
        assert_eq!(m.tags.len(), MAX_TAGS);
        assert_eq!(&m.tags[..3], &["a".to_string(), "b".to_string(), "t".repeat(MAX_TAG)]);
        assert!(m.tags.contains(&"xy".to_string()));
        assert!(m.note.starts_with("Zeile 1\nZeile 2n") && m.note.chars().count() == MAX_NOTE);

        // Imports into a smart or a missing bin land in the project root.
        let mut a = video_asset(1.0, false);
        a.bin = Some(smart);
        let mut b = video_asset(1.0, false);
        b.bin = Some(Uuid::new_v4());
        let mut c = video_asset(1.0, false);
        c.bin = Some(plain);
        let ids = [a.id, b.id, c.id];
        fx.run(EditCommand::ImportMedia { assets: vec![a, b, c] });
        let bins: Vec<_> = ids.iter().map(|id| fx.p.media(*id).unwrap().bin).collect();
        assert_eq!(bins, vec![None, None, Some(plain)]);

        // Plain bins stay plain in the file; old files without the field load.
        let json = serde_json::to_string(&fx.p.bins).unwrap();
        assert_eq!(json.matches("\"smart\"").count(), 1);
        let old: Bin = serde_json::from_str(r#"{"id":"00000000-0000-0000-0000-000000000001","name":"a","parent":null}"#).unwrap();
        assert!(old.smart.is_none());
        let partial: SmartRules = serde_json::from_str(r#"{"kinds":["audio"]}"#).unwrap();
        assert_eq!((partial.kinds, partial.usage), (vec![SmartKind::Audio], SmartUsage::Any));
    }

    #[test]
    fn matrix_choice_only_for_videos_with_a_601_709_or_missing_tag() {
        let mut fx = Fx::new(2.0, false);
        let video = fx.media;
        let mut still = video_asset(1.0, false);
        still.kind = MediaKind::Image;
        let still = {
            let id = still.id;
            fx.p.media.push(still);
            id
        };
        let patch = |m| MediaPatch { matrix: Some(m), ..Default::default() };
        let o = fx.run(EditCommand::UpdateMedia { media: vec![video], patch: patch(MatrixChoice::Bt601) });
        assert!(o.changed);
        assert_eq!(fx.p.media(video).unwrap().matrix, MatrixChoice::Bt601);
        let v = fx.p.media(video).unwrap().info.as_ref().unwrap().video.as_ref().unwrap();
        assert_eq!((v.webview_ycc(false), v.read_ycc(MatrixChoice::Bt601, false)), (Some(Ycc::Bt709), Some(Ycc::Bt601)));
        // Not for images, and not for other tags; nothing changes then.
        assert!(apply(&mut fx.p, &EditCommand::UpdateMedia { media: vec![video, still], patch: patch(MatrixChoice::Bt709) }).is_err());
        fx.p.media_mut(video).unwrap().info.as_mut().unwrap().video.as_mut().unwrap().color.space = Some("bt2020nc".into());
        assert!(apply(&mut fx.p, &EditCommand::UpdateMedia { media: vec![video], patch: patch(MatrixChoice::Bt709) }).is_err());
        assert_eq!(fx.p.media(video).unwrap().matrix, MatrixChoice::Bt601);
        // Back to automatic is always allowed; the file then stores nothing.
        fx.run(EditCommand::UpdateMedia { media: vec![video, still], patch: patch(MatrixChoice::Auto) });
        assert_eq!(fx.p.media(video).unwrap().matrix, MatrixChoice::Auto);
        assert!(!serde_json::to_string(fx.p.media(video).unwrap()).unwrap().contains("matrix"));
    }

    #[test]
    fn loading_repairs_broken_bin_references() {
        let mut p = Project::new("t", 0);
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let s = Uuid::new_v4();
        p.bins = vec![
            Bin { id: a, name: "a".into(), parent: Some(b), smart: None },
            Bin { id: b, name: "b".into(), parent: Some(a), smart: None },
            Bin { id: s, name: "s".into(), parent: None, smart: Some(SmartRules::default()) },
            Bin { id: Uuid::new_v4(), name: "c".into(), parent: Some(s), smart: None },
            Bin { id: Uuid::new_v4(), name: "d".into(), parent: Some(Uuid::new_v4()), smart: None },
            Bin { id: a, name: "dup".into(), parent: None, smart: None },
        ];
        let mut m1 = video_asset(1.0, false);
        m1.bin = Some(s);
        let mut m2 = video_asset(1.0, false);
        m2.bin = Some(Uuid::new_v4());
        let mut m3 = video_asset(1.0, false);
        m3.bin = Some(b);
        p.media = vec![m1, m2, m3];
        p.normalize();
        assert_eq!(p.bins.len(), 5);
        // The loop a -> b -> a is broken; every walk up ends at the root.
        for bin in &p.bins {
            let mut at = bin.parent;
            for _ in 0..=p.bins.len() {
                at = at.and_then(|id| p.bins.iter().find(|x| x.id == id).and_then(|x| x.parent));
            }
            assert!(at.is_none(), "{}", bin.name);
        }
        assert!(p.bins.iter().filter(|x| x.name == "c" || x.name == "d").all(|x| x.parent.is_none()));
        assert_eq!(p.media.iter().map(|m| m.bin).collect::<Vec<_>>(), vec![None, None, Some(b)]);
    }

    #[test]
    fn watch_folders_are_checked_undone_and_repaired() {
        let mut p = Project::new("t", 0);
        let mut h = crate::history::History::new(10);
        let bin = h.apply(&mut p, &EditCommand::CreateBin { name: "Kamera".into(), parent: None, smart: None }).unwrap().created[0];
        let smart = h.apply(&mut p, &EditCommand::CreateBin { name: "s".into(), parent: None, smart: Some(SmartRules::default()) }).unwrap().created[0];
        let add = |path: &str, bin: Option<Uuid>| EditCommand::AddWatchFolder { path: path.into(), bin, subfolders: true };
        let o = h.apply(&mut p, &add("C:\\Footage\\Tag 1", Some(bin))).unwrap();
        assert!(o.changed && o.media_changed && o.created.len() == 1);
        let id = o.created[0];
        // Same folder in another spelling, relative paths, smart or missing bins: rejected, nothing changes.
        let before = p.clone();
        for cmd in [add("c:/footage/tag 1/", None), add("Footage", None), add("", None), add("D:\\x", Some(smart)), add("D:\\x", Some(Uuid::new_v4()))] {
            assert!(apply(&mut p, &cmd).is_err(), "{cmd:?}");
        }
        assert!(apply(&mut p, &EditCommand::RemoveWatchFolder { id: Uuid::new_v4() }).is_err());
        assert_eq!(p, before);
        for path in ["/media/card", "\\\\nas\\share", "E:/clips"] {
            apply(&mut p, &add(path, None)).unwrap();
        }
        for i in p.watch_folders.len()..MAX_WATCH_FOLDERS {
            apply(&mut p, &add(&format!("/w/{i}"), None)).unwrap();
        }
        assert!(apply(&mut p, &add("/w/one-too-many", None)).is_err());
        p.watch_folders.truncate(1);
        // Removing the bin moves the folder's imports to the parent (root); undo brings both back.
        h.apply(&mut p, &EditCommand::RemoveBin { bin }).unwrap();
        assert_eq!(p.watch_folders[0].bin, None);
        h.undo(&mut p);
        assert_eq!(p.watch_folders[0].bin, Some(bin));
        h.apply(&mut p, &EditCommand::RemoveWatchFolder { id }).unwrap();
        assert!(p.watch_folders.is_empty());
        assert!(h.diff(crate::history::Side::Undo, &p).unwrap().watch_folders.is_some());
        h.undo(&mut p);
        assert_eq!(p.watch_folders[0].id, id);
        // Loading drops duplicates and references to missing or smart bins.
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"watchFolders\"") && json.contains("\"subfolders\":true"));
        let w = |path: &str, bin| WatchFolder { id: Uuid::new_v4(), path: path.into(), bin, subfolders: false };
        p.watch_folders = vec![w("/a", Some(smart)), w("/A/", None), w("/b", Some(Uuid::new_v4())), w("", None), w("/c", Some(bin))];
        p.normalize();
        assert_eq!(p.watch_folders.iter().map(|w| (w.path.to_string_lossy().into_owned(), w.bin)).collect::<Vec<_>>(), vec![("/a".into(), None), ("/b".into(), None), ("/c".into(), Some(bin))]);
        assert!(!serde_json::to_string(&Project::new("e", 0)).unwrap().contains("watchFolders"));
    }

    #[test]
    fn effect_keys_are_cleaned_and_evaluated_on_the_source() {
        let mut fx = Fx::new(4.0, true);
        let v = fx.place(0, None, None, PlaceMode::Overwrite)[0];
        let src = fx.v1().clips[0].source_in;
        let k = |at: i64, value: f32| Keyframe { at: src + at, value, ease: Ease::Linear };
        let keyed = |kind: EffectKind, key: &str, keys: Vec<Keyframe>| Effect { keys: [(key.to_string(), keys)].into(), ..Effect::new(kind) };
        // Duplicates: the last wins; values are clamped to the parameter's range; keys are sorted.
        let blur = keyed(EffectKind::Blur { radius: 0.0 }, "radius", vec![k(10, 300.0), k(0, 2.0), k(10, 4.0), k(20, 900.0)]);
        assert!(fx.run(EditCommand::SetEffects { sequence: fx.seq, clips: vec![v], effects: vec![blur] }).changed);
        let c = fx.v1().clips[0].clone();
        assert_eq!(c.effects[0].keys["radius"], vec![k(0, 2.0), k(10, 4.0), k(20, 250.0)]);
        // An identity static value stays active while it has keys.
        assert_eq!(c.active_effects().count(), 1);
        assert_eq!(c.effect_at(&c.effects[0], 5.0), EffectKind::Blur { radius: 3.0 });
        assert_eq!(c.effect_at(&c.effects[0], 40.0), EffectKind::Blur { radius: 250.0 });
        let bad = |e: Effect| apply(&mut fx.p.clone(), &EditCommand::SetEffects { sequence: fx.seq, clips: vec![v], effects: vec![e] }).is_err();
        // Not animatable, unknown key, non-finite value.
        assert!(bad(keyed(EffectKind::Sharpen { amount: 1.0, radius: 1.0 }, "amount", vec![k(0, 1.0)])));
        assert!(bad(keyed(EffectKind::Blur { radius: 1.0 }, "sigma", vec![k(0, 1.0)])));
        assert!(bad(keyed(EffectKind::Vignette { amount: 0.2 }, "amount", vec![k(0, f32::NAN)])));
        let twirl = EffectKind::Fx { fx: "twirl".into(), params: Default::default() };
        assert!(!bad(keyed(twirl.clone(), "angle", vec![k(0, 30.0)])));
        assert!(bad(keyed(EffectKind::Fx { fx: "posterize".into(), params: Default::default() }, "levels", vec![k(0, 3.0)])));
        // Freeform masks: 3 to 32 points, clamped to the frame.
        let mask = |n: usize| EffectKind::PolygonMask { points: (0..n).map(|i| [i as f32 * 0.1 - 0.2, 1.5]).collect(), feather: 900.0, invert: false, x: 3.0, y: 0.0 };
        assert!(bad(Effect::new(mask(2))));
        assert!(bad(Effect::new(mask(MAX_MASK_POINTS + 1))));
        assert!(fx.run(EditCommand::SetEffects { sequence: fx.seq, clips: vec![v], effects: vec![keyed(mask(3), "y", vec![k(0, -2.0)])] }).changed);
        let e = &fx.v1().clips[0].effects[0];
        assert_eq!(e.kind, EffectKind::PolygonMask { points: vec![[0.0, 1.0], [0.0, 1.0], [0.0, 1.0]], feather: 400.0, invert: false, x: 1.0, y: 0.0 });
        assert_eq!(e.keys["y"], vec![k(0, -1.0)]);
    }

    #[test]
    fn add_effects_appends_with_fresh_ids() {
        let mut fx = Fx::new(4.0, true);
        let v = fx.place(0, None, None, PlaceMode::Overwrite)[0];
        let e = Effect { name: "Warm".into(), ..Effect::new(EffectKind::Vignette { amount: 0.3 }) };
        assert!(fx.run(EditCommand::AddEffects { sequence: fx.seq, clips: vec![v], effects: vec![e.clone()] }).changed);
        assert!(fx.run(EditCommand::AddEffects { sequence: fx.seq, clips: vec![v], effects: vec![e.clone()] }).changed);
        let got = &fx.v1().clips[0].effects;
        assert_eq!(got.len(), 2);
        assert_ne!(got[0].id, got[1].id);
        assert_ne!(got[0].id, e.id);
        assert_eq!(got[1].name, "Warm");
        let many = vec![e; 63];
        assert!(apply(&mut fx.p, &EditCommand::AddEffects { sequence: fx.seq, clips: vec![v], effects: many }).is_err());
    }

    #[test]
    fn effects_roundtrip_through_json() {
        let json = r#"{"id":"00000000-0000-0000-0000-000000000003","type":"colorWheels","lift":[0.1,0,0],"gamma":[1,1,1],"gain":[1,1,1.2]}"#;
        let e: Effect = serde_json::from_str(json).unwrap();
        assert!(e.enabled);
        assert!(matches!(e.kind, EffectKind::ColorWheels { .. }));
        let back: Effect = serde_json::from_value(serde_json::to_value(&e).unwrap()).unwrap();
        assert_eq!(back, e);
    }
    fn title_asset() -> MediaAsset {
        let mut a = video_asset(0.04, false);
        a.kind = MediaKind::Image;
        a.path = "titles/a.png".into();
        a.title = Some(TitleSpec { text: "Hallo".into(), style: TextStyle::default(), x: 0.5, y: 0.5, width: 1280, height: 720, animation: Default::default() });
        a
    }

    #[test]
    fn titles_overwrite_and_update_in_place() {
        let mut fx = Fx::new(10.0, false);
        fx.place(0, Some(0), Some(100), PlaceMode::Overwrite);
        let v1 = fx.v1().id;
        let asset = title_asset();
        let id = asset.id;
        let out = fx.run(EditCommand::AddTitle { sequence: fx.seq, asset: Box::new(asset.clone()), track: v1, at: 20, duration: 30 });
        assert!(out.media_changed && out.created.len() == 1);
        // Overwrite, not insert: the sequence keeps its length.
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 20, 0), (20, 30, 0), (50, 50, 50)]);

        let mut spec = asset.title.clone().unwrap();
        spec.text = "Neu\r\nZeile".into();
        spec.width = 1920;
        spec.height = 1080;
        assert!(fx.run(EditCommand::UpdateTitle { media: id, title: spec.clone(), path: "titles/b.png".into() }).changed);
        let a = fx.p.media(id).unwrap();
        assert_eq!(a.title.as_ref().unwrap().text, "Neu\nZeile");
        assert_eq!(a.info.as_ref().unwrap().video.as_ref().map(|v| (v.width, v.height)), Some((1920, 1080)));
        // Same definition and file: nothing to undo.
        spec.text = "Neu\nZeile".into();
        assert!(!fx.run(EditCommand::UpdateTitle { media: id, title: spec, path: "titles/b.png".into() }).changed);
        // Only titles can be edited as titles.
        let other = fx.media;
        let t = fx.p.media(id).unwrap().title.clone().unwrap();
        assert!(apply(&mut fx.p, &EditCommand::UpdateTitle { media: other, title: t, path: "x.png".into() }).is_err());
    }

    #[test]
    fn subtitles_are_cleaned_and_styled() {
        let mut fx = Fx::new(4.0, false);
        let cue = |start, end, text: &str| Cue { id: Uuid::new_v4(), start, end, text: text.into() };
        let out = fx.run(EditCommand::SetSubtitles { sequence: fx.seq, cues: vec![cue(30, 60, "b"), cue(0, 40, "a"), cue(-5, -1, "gone")] });
        assert!(out.changed);
        let spans: Vec<_> = fx.s().subtitles.cues.iter().map(|c| (c.start, c.end)).collect();
        assert_eq!(spans, vec![(0, 30), (30, 60)]);
        let style = TextStyle { size: 2000.0, ..TextStyle::subtitles() };
        fx.run(EditCommand::SetSubtitleStyle { sequence: fx.seq, style, margin: 0.9, visible: false });
        let s = &fx.s().subtitles;
        assert_eq!((s.style.size, s.margin, s.visible), (1000.0, 0.5, false));
        // Survives a JSON round trip of the project.
        let back: Project = serde_json::from_str(&serde_json::to_string(&fx.p).unwrap()).unwrap();
        assert_eq!(back.sequence(fx.seq).unwrap().subtitles, *s);
    }
    #[test]
    fn transitions_need_adjacent_clips_and_fit_both() {
        let mut fx = Fx::new(10.0, true);
        let a = fx.place(0, Some(0), Some(40), PlaceMode::Overwrite);
        let b = fx.place(40, Some(100), Some(200), PlaceMode::Overwrite);
        let t = |kind, duration, align| Some(Transition { kind, duration, align });
        let set = |fx: &mut Fx, clip, transition| apply(&mut fx.p, &EditCommand::SetTransitions { sequence: fx.seq, items: vec![TransitionEdit { clip, transition }] });
        // Into the first clip of a track there is nothing to transition from.
        assert!(set(&mut fx, a[0], t(TransitionKind::Dissolve, 10, TransitionAlign::Center)).is_err());
        // Audio kinds only on audio tracks and the other way round.
        assert!(set(&mut fx, b[0], t(TransitionKind::Crossfade, 10, TransitionAlign::Center)).is_err());
        assert!(set(&mut fx, b[1], t(TransitionKind::Dissolve, 10, TransitionAlign::Center)).is_err());
        assert!(set(&mut fx, b[0], t(TransitionKind::Dissolve, 25, TransitionAlign::Center)).unwrap().changed);
        assert!(set(&mut fx, b[1], t(TransitionKind::Crossfade, 25, TransitionAlign::Center)).unwrap().changed);
        let span = fx.v1().transition_into(1).unwrap();
        assert_eq!((span.t0, span.cut, span.t1), (28, 40, 53));
        // Each side takes at most half of its clip: A is 40 frames long.
        set(&mut fx, b[0], t(TransitionKind::DipBlack, 60, TransitionAlign::End)).unwrap();
        assert_eq!(fx.v1().transition_into(1).map(|s| (s.t0, s.t1)), Some((20, 40)));
        set(&mut fx, b[0], t(TransitionKind::WipeLeft, 60, TransitionAlign::Start)).unwrap();
        assert_eq!(fx.v1().transition_into(1).map(|s| (s.t0, s.t1)), Some((40, 90)));
    }

    #[test]
    fn transitions_go_when_their_clips_part() {
        let mut fx = Fx::new(10.0, false);
        fx.place(0, Some(0), Some(50), PlaceMode::Overwrite);
        let b = fx.place(50, Some(100), Some(200), PlaceMode::Overwrite)[0];
        let dissolve = Some(Transition { kind: TransitionKind::Dissolve, duration: 20, align: TransitionAlign::Center });
        fx.run(EditCommand::SetTransitions { sequence: fx.seq, items: vec![TransitionEdit { clip: b, transition: dissolve }] });
        // Splitting the incoming clip keeps the transition on its left part only.
        fx.run(EditCommand::SplitAt { sequence: fx.seq, frame: 100, clips: None });
        let v = fx.v1();
        assert!(v.clips[1].transition.is_some() && v.clips[2].transition.is_none());
        // Moving it away leaves a gap: the transition is dropped in the same step.
        fx.run(EditCommand::MoveClips { sequence: fx.seq, clips: vec![b], delta: 5, track_delta: 0, track_kind: None });
        assert!(fx.v1().clips.iter().all(|c| c.transition.is_none()));
    }

    #[test]
    fn nesting_moves_clips_into_a_new_sequence() {
        let mut fx = Fx::new(4.0, true);
        fx.place(0, None, None, PlaceMode::Overwrite);
        let ids = fx.place(150, Some(0), Some(50), PlaceMode::Overwrite);
        let (keep, nest) = (fx.v1().clips[0].id, ids[0]);
        // The video clip is selected; its linked audio goes along.
        let out = fx.run(EditCommand::NestClips { sequence: fx.seq, clips: vec![nest], name: "Nest".into() });
        let inner_id = out.created[0];
        assert_eq!(out.created.len(), 3);
        let inner = fx.p.sequence(inner_id).unwrap();
        assert_eq!(inner.duration(), 50);
        assert_eq!(inner.tracks.iter().map(|t| t.clips.len()).sum::<usize>(), 2);
        assert!(inner.tracks.iter().flat_map(|t| &t.clips).all(|c| c.start == 0 && c.media_id == fx.media));
        // In its place: a linked pair showing the new sequence.
        let v = &fx.v1().clips[1];
        let a = &fx.a1().clips[1];
        assert_eq!((v.media_id, v.start, v.duration, v.source_in), (inner_id, 150, 50, 0));
        assert_eq!((a.media_id, a.start, a.duration), (inner_id, 150, 50));
        assert!(v.link.is_some() && v.link == a.link);
        assert_eq!(fx.v1().clips[0].id, keep);

        // The nested clip trims like media: no further than the sequence is long.
        let vid = v.id;
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: vid, edge: Edge::End, delta: 30, ripple: false, linked: true });
        assert_eq!(fx.v1().clips[1].duration, 50);
        fx.run(EditCommand::TrimClip { sequence: fx.seq, clip: vid, edge: Edge::Start, delta: 10, ripple: false, linked: true });
        assert_eq!((fx.v1().clips[1].start, fx.v1().clips[1].source_in), (160, 10));
    }

    #[test]
    fn sequences_cannot_contain_themselves() {
        let mut fx = Fx::new(4.0, false);
        let ids = fx.place(0, None, None, PlaceMode::Overwrite);
        let inner = fx.run(EditCommand::NestClips { sequence: fx.seq, clips: ids, name: "Innen".into() }).created[0];
        // The outer sequence cannot go into the inner one, nor a sequence into itself.
        let place = |media: Uuid, sequence: Uuid| EditCommand::PlaceMedia {
            sequence,
            media,
            video_track: None,
            audio_track: None,
            at: 0,
            mode: PlaceMode::Overwrite,
            source_in: None,
            source_out: None,
            match_sequence: false,
        };
        assert_eq!(apply(&mut fx.p, &place(fx.seq, inner)), Err(EditError::NestCycle));
        assert_eq!(apply(&mut fx.p, &place(inner, inner)), Err(EditError::NestCycle));
        // A sequence still nested elsewhere cannot be removed.
        assert_eq!(apply(&mut fx.p, &EditCommand::RemoveSequence { sequence: inner }), Err(EditError::SequenceInUse(1)));
        // Placing it again elsewhere works; a third sequence can hold the outer one.
        fx.run(place(inner, fx.seq));
        let third = fx.run(EditCommand::AddSequence { name: "Drei".into(), settings: SequenceSettings::default() }).created[0];
        fx.run(place(fx.seq, third));
        assert!(fx.p.nests(third, inner) && !fx.p.nests(inner, third));
        assert_eq!(apply(&mut fx.p, &place(third, inner)), Err(EditError::NestCycle));
    }

    #[test]
    fn multicam_places_the_common_stretch_and_switches_in_sync() {
        let mut fx = Fx::new(10.0, true);
        let b = video_asset(10.0, true);
        let (a_id, b_id) = (fx.media, b.id);
        fx.p.media.push(b);
        // Camera B started recording 2 s after camera A.
        let group = Multicam {
            id: Uuid::new_v4(),
            name: "Interview".into(),
            angles: vec![
                Angle { media: a_id, name: "A".into(), offset: 5.0 },
                Angle { media: b_id, name: "".into(), offset: 7.0 },
            ],
        };
        let g = fx.run(EditCommand::CreateMulticam { multicam: group }).created[0];
        let stored = fx.p.multicam(g).unwrap();
        assert_eq!((stored.angles[0].offset, stored.angles[1].offset), (0.0, 2.0));
        assert_eq!(stored.angles[1].name, "clip");

        // Picture of B with the sound of A: the 8 s both cover.
        let sequence = fx.seq;
        let place = |video_angle, audio_angle| EditCommand::PlaceMulticam {
            sequence, multicam: g, at: 0, mode: PlaceMode::Overwrite, video_angle, audio_angle, video_track: None, audio_track: None,
        };
        let ids = fx.run(place(1, Some(0))).created;
        let (v, a) = (&fx.v1().clips[0], &fx.a1().clips[0]);
        assert_eq!((v.media_id, v.source_in, v.duration, v.name.as_str()), (b_id, 0, 200, "clip"));
        assert_eq!((a.media_id, a.source_in, a.duration), (a_id, 50, 200));
        assert!(v.link.is_some() && v.link == a.link && v.multicam == Some(g) && a.multicam == Some(g));

        // Switching to A from frame 100 on: cut there, the right part moves by 2 s of source.
        fx.run(EditCommand::SwitchAngle { sequence: fx.seq, clip: ids[0], angle: 0, at: Some(100) });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 100, 0), (100, 100, 150)]);
        let (l, r) = (&fx.v1().clips[0], &fx.v1().clips[1]);
        assert_eq!((l.media_id, r.media_id, r.name.as_str()), (b_id, a_id, "A"));
        assert_eq!(r.link, l.link, "the parts stay linked to the sound");
        // Back to B on the right part as a whole.
        let right = r.id;
        fx.run(EditCommand::SwitchAngle { sequence: fx.seq, clip: right, angle: 1, at: None });
        assert_eq!(Fx::spans(fx.v1()), vec![(0, 100, 0), (100, 100, 100)]);

        // A starts before B: the first 50 frames of a clip of A have no picture of B.
        let mut fx2 = fx.clone_project();
        let ids = apply(&mut fx2, &place(0, None)).unwrap().created;
        assert_eq!(ids.len(), 1);
        let seq = fx2.sequence(fx.seq).unwrap();
        let c = seq.tracks[0].clips.iter().find(|c| c.id == ids[0]).unwrap();
        assert_eq!((c.source_in, c.duration), (0, 250));
        assert_eq!(apply(&mut fx2, &EditCommand::SwitchAngle { sequence: fx.seq, clip: ids[0], angle: 1, at: Some(20) }), Err(EditError::NoFootage));
        apply(&mut fx2, &EditCommand::SwitchAngle { sequence: fx.seq, clip: ids[0], angle: 1, at: Some(50) }).unwrap();
        let seq = fx2.sequence(fx.seq).unwrap();
        assert_eq!(Fx::spans(&seq.tracks[0]), vec![(0, 50, 0), (50, 200, 0)]);
        // Media used by a group cannot be removed.
        assert_eq!(apply(&mut fx2, &EditCommand::RemoveMedia { media: vec![b_id] }), Err(EditError::MediaInUse(2)));
    }

    #[test]
    fn batches_apply_as_one_step_or_not_at_all() {
        let mut fx = Fx::new(10.0, false);
        fx.place(0, None, None, PlaceMode::Overwrite);
        let seq = fx.seq;
        let ok = EditCommand::Batch {
            label: BatchLabel::SceneCuts,
            commands: vec![
                EditCommand::SplitAt { sequence: seq, frame: 40, clips: None },
                EditCommand::SplitAt { sequence: seq, frame: 80, clips: None },
            ],
        };
        let out = fx.run(ok.clone());
        assert_eq!(out.label, "sceneCuts");
        assert_eq!(fx.p.sequence(seq).unwrap().tracks[0].clips.len(), 3);
        // A failing step leaves everything as it was.
        let before = fx.p.clone();
        let bad = EditCommand::Batch {
            label: BatchLabel::SceneCuts,
            commands: vec![
                EditCommand::SplitAt { sequence: seq, frame: 120, clips: None },
                EditCommand::RemoveMarker { sequence: seq, marker: Uuid::new_v4() },
            ],
        };
        assert_eq!(apply(&mut fx.p, &bad), Err(EditError::MarkerNotFound));
        assert_eq!(fx.p, before);
        let nested = EditCommand::Batch { label: BatchLabel::Ducking, commands: vec![ok] };
        assert!(apply(&mut fx.p, &nested).is_err());
        // Through the history it is a single undo step.
        let mut p = before.clone();
        let mut h = crate::history::History::new(10);
        h.apply(&mut p, &EditCommand::Batch { label: BatchLabel::SceneCuts, commands: vec![
            EditCommand::SplitAt { sequence: seq, frame: 10, clips: None },
            EditCommand::SplitAt { sequence: seq, frame: 20, clips: None },
        ] }).unwrap();
        assert_eq!(p.sequence(seq).unwrap().tracks[0].clips.len(), 5);
        h.undo(&mut p);
        assert_eq!(p, before);
    }

    #[test]
    fn markers_carry_categories_ranges_and_chapters() {
        let mut fx = Fx::new(10.0, false);
        let seq = fx.seq;
        let nm = |frame, cat: &str| NewMarker { frame, name: format!("m{frame}"), note: String::new(), color: MarkerColor::Blue, category: cat.into(), duration: -3, chapter: frame == 0 };
        let out = fx.run(EditCommand::AddMarkers { sequence: seq, markers: vec![nm(50, " beat\u{7} "), nm(0, "scene")] });
        assert_eq!(out.created.len(), 2);
        let m = &fx.p.sequence(seq).unwrap().markers;
        assert_eq!((m[0].frame, m[0].chapter, m[0].category.as_str()), (0, true, "scene"));
        assert_eq!((m[1].category.as_str(), m[1].duration), ("beat", 0));
        let id = m[1].id;
        fx.run(EditCommand::UpdateMarker { sequence: seq, marker: id, patch: MarkerPatch { duration: Some(12), category: Some("x".into()), ..Default::default() } });
        assert_eq!(fx.p.sequence(seq).unwrap().markers[1].duration, 12);
        let ids: Vec<Uuid> = fx.p.sequence(seq).unwrap().markers.iter().map(|m| m.id).collect();
        assert!(apply(&mut fx.p, &EditCommand::RemoveMarkers { sequence: seq, markers: vec![ids[0], Uuid::new_v4()] }).is_err());
        fx.run(EditCommand::RemoveMarkers { sequence: seq, markers: ids });
        assert!(fx.p.sequence(seq).unwrap().markers.is_empty());
        // Old project files without the new fields still load.
        let old: Marker = serde_json::from_str(r#"{"id":"00000000-0000-0000-0000-000000000001","frame":3,"name":"a","color":"red"}"#).unwrap();
        assert_eq!((old.category.as_str(), old.duration, old.chapter), ("", 0, false));
    }
}
