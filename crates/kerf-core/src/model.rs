//! Project data model.
//!
//! The model is plain data. Invariants (e.g. clips on a track are sorted and
//! never overlap) are maintained by [`crate::ops`]; [`Project::normalize`]
//! re-establishes them after loading foreign or damaged files.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use crate::audio::{AudioEffect, AudioEffectKind, ChannelMap, EqBand, EqShape};
pub use crate::text::{Cue, Subtitles, TextAlign, TextStyle, TitleSpec};
use crate::time::{Frame, Rational};
use crate::timemap::{Warp, MAX_SPEED, MIN_SPEED};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub id: Uuid,
    pub name: String,
    pub created_at: i64,
    pub modified_at: i64,
    #[serde(default)]
    pub media: Vec<MediaAsset>,
    #[serde(default)]
    pub bins: Vec<Bin>,
    pub sequences: Vec<Sequence>,
    pub active_sequence: Uuid,
    /// Camera angles recorded together (multicam groups).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub multicams: Vec<Multicam>,
}

/// Camera angles of one take, in sync. Clips of the group show one angle
/// each; switching the angle swaps the media and moves the source position
/// by the difference of the offsets, so the picture stays in time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Multicam {
    pub id: Uuid,
    pub name: String,
    pub angles: Vec<Angle>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Angle {
    pub media: Uuid,
    pub name: String,
    /// Where the media starts on the group's clock, seconds (the earliest is 0).
    pub offset: f64,
}

impl Project {
    pub fn new(name: impl Into<String>, now_ms: i64) -> Self {
        let seq = Sequence::new("Sequenz 01", SequenceSettings::default());
        Self {
            schema_version: SCHEMA_VERSION,
            id: Uuid::new_v4(),
            name: name.into(),
            created_at: now_ms,
            modified_at: now_ms,
            media: Vec::new(),
            bins: Vec::new(),
            active_sequence: seq.id,
            sequences: vec![seq],
            multicams: Vec::new(),
        }
    }

    pub fn multicam(&self, id: Uuid) -> Option<&Multicam> {
        self.multicams.iter().find(|m| m.id == id)
    }

    pub fn sequence(&self, id: Uuid) -> Option<&Sequence> {
        self.sequences.iter().find(|s| s.id == id)
    }

    pub fn sequence_mut(&mut self, id: Uuid) -> Option<&mut Sequence> {
        self.sequences.iter_mut().find(|s| s.id == id)
    }

    pub fn media(&self, id: Uuid) -> Option<&MediaAsset> {
        self.media.iter().find(|m| m.id == id)
    }

    pub fn media_mut(&mut self, id: Uuid) -> Option<&mut MediaAsset> {
        self.media.iter_mut().find(|m| m.id == id)
    }

    /// True when sequence `outer` is `inner` or contains it, directly or
    /// deeper: nesting `outer` into `inner` would make a cycle.
    pub fn nests(&self, outer: Uuid, inner: Uuid) -> bool {
        let mut stack = vec![outer];
        let mut seen = HashSet::new();
        while let Some(id) = stack.pop() {
            if id == inner {
                return true;
            }
            if !seen.insert(id) {
                continue;
            }
            if let Some(s) = self.sequence(id) {
                stack.extend(s.tracks.iter().flat_map(|t| &t.clips).map(|c| c.media_id).filter(|m| self.sequence(*m).is_some()));
            }
        }
        false
    }

    /// What clips of sequence `seq` can show: the media and every sequence
    /// that does not contain `seq` (as [`Sequence::as_source`]).
    pub fn sources_for(&self, seq: Uuid) -> Vec<MediaAsset> {
        let mut out = self.media.clone();
        out.extend(self.sequences.iter().filter(|s| !self.nests(s.id, seq)).map(Sequence::as_source));
        out
    }

    /// Number of clips (in all sequences) that reference `media_id`.
    pub fn media_usage(&self, media_id: Uuid) -> usize {
        self.sequences
            .iter()
            .flat_map(|s| s.tracks.iter())
            .flat_map(|t| t.clips.iter())
            .filter(|c| c.media_id == media_id)
            .count()
    }

    /// Restores model invariants: sorted, non-overlapping clips, valid active sequence.
    pub fn normalize(&mut self) {
        if self.sequences.is_empty() {
            let seq = Sequence::new("Sequenz 01", SequenceSettings::default());
            self.active_sequence = seq.id;
            self.sequences.push(seq);
        }
        if self.sequence(self.active_sequence).is_none() {
            self.active_sequence = self.sequences[0].id;
        }
        for seq in &mut self.sequences {
            for track in &mut seq.tracks {
                track.clips.retain(|c| c.duration > 0);
                track.clips.sort_by_key(|c| c.start);
                // Drop clips that overlap their predecessor (damaged files only).
                let mut last_end = Frame::MIN;
                track.clips.retain(|c| {
                    let ok = c.start >= last_end && c.start >= 0;
                    if ok {
                        last_end = c.end();
                    }
                    ok
                });
            }
            seq.markers.sort_by_key(|m| m.frame);
        }
    }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "message")]
pub enum MediaStatus {
    Analyzing,
    Ready,
    Missing,
    Error(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: Uuid,
    pub path: PathBuf,
    pub name: String,
    pub kind: MediaKind,
    pub status: MediaStatus,
    #[serde(default)]
    pub info: Option<MediaInfo>,
    #[serde(default)]
    pub bin: Option<Uuid>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub label: LabelColor,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Free-form note (custom metadata).
    #[serde(default)]
    pub note: String,
    pub imported_at: i64,
    /// Machine-local derived data (thumbnails, peaks, proxies). Regenerable.
    #[serde(default)]
    pub derived: Derived,
    /// In/Out marks set in the source monitor, seconds of media time.
    #[serde(default)]
    pub marks: SourceMarks,
    /// Generated title; `path` is its rendered PNG (regenerated by the UI when missing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<TitleSpec>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SourceMarks {
    #[serde(rename = "in")]
    pub in_point: Option<f64>,
    #[serde(rename = "out")]
    pub out_point: Option<f64>,
}

impl MediaAsset {
    /// Length of the media in frames of `rate`. `None` for stills (unbounded).
    pub fn length_frames(&self, rate: Rational) -> Option<Frame> {
        if self.kind == MediaKind::Image {
            return None;
        }
        self.info
            .as_ref()
            .map(|i| rate.seconds_to_frames_floor(i.duration).max(1))
    }

    pub fn has_video(&self) -> bool {
        self.kind != MediaKind::Audio && self.info.as_ref().is_some_and(|i| i.video.is_some())
    }

    pub fn has_audio(&self) -> bool {
        self.kind != MediaKind::Image && self.info.as_ref().is_some_and(|i| i.audio.is_some())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration: f64,
    pub size_bytes: u64,
    pub container: String,
    pub bit_rate: Option<u64>,
    pub video: Option<VideoInfo>,
    pub audio: Option<AudioInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub codec: String,
    pub profile: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: Rational,
    pub pix_fmt: Option<String>,
    pub bit_rate: Option<u64>,
    /// Display rotation from container metadata, degrees.
    pub rotation: i32,
    #[serde(default)]
    pub color: ColorTags,
}

/// Colour description of a video stream as tagged in the file (ffprobe names,
/// e.g. `bt709`, `smpte170m`, `tv`). `None` = not tagged.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorTags {
    pub space: Option<String>,
    pub range: Option<String>,
    pub transfer: Option<String>,
    pub primaries: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub channel_layout: Option<String>,
    pub bit_rate: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Derived {
    pub poster: Option<PathBuf>,
    pub filmstrip: Option<Filmstrip>,
    pub peaks: Option<Peaks>,
    pub proxy: Option<PathBuf>,
    /// True when the webview can decode the original directly.
    #[serde(default)]
    pub preview_native: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filmstrip {
    pub path: PathBuf,
    pub tiles: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    /// Seconds between two tiles.
    pub interval: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peaks {
    pub path: PathBuf,
    /// Peak values per second of media.
    pub rate: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bin {
    pub id: Uuid,
    pub name: String,
    pub parent: Option<Uuid>,
}

// ---------------------------------------------------------------------------
// Sequences and tracks
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceSettings {
    pub fps: Rational,
    pub width: u32,
    pub height: u32,
    pub sample_rate: u32,
}

impl Default for SequenceSettings {
    fn default() -> Self {
        Self { fps: Rational::new(25, 1), width: 1920, height: 1080, sample_rate: 48_000 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub id: Uuid,
    pub name: String,
    pub settings: SequenceSettings,
    /// Video tracks first (V1 = index 0 = bottom of the stack), audio after.
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    #[serde(default)]
    pub in_point: Option<Frame>,
    #[serde(default)]
    pub out_point: Option<Frame>,
    #[serde(default)]
    pub subtitles: Subtitles,
}

impl Sequence {
    pub fn new(name: impl Into<String>, settings: SequenceSettings) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            settings,
            tracks: vec![
                Track::new(TrackKind::Video, "V1"),
                Track::new(TrackKind::Video, "V2"),
                Track::new(TrackKind::Audio, "A1"),
                Track::new(TrackKind::Audio, "A2"),
            ],
            markers: Vec::new(),
            in_point: None,
            out_point: None,
            subtitles: Subtitles::default(),
        }
    }

    /// Everything but the tracks (history shares tracks separately).
    pub fn clone_without_tracks(&self) -> Self {
        Self {
            id: self.id,
            name: self.name.clone(),
            settings: self.settings,
            tracks: Vec::new(),
            markers: self.markers.clone(),
            in_point: self.in_point,
            out_point: self.out_point,
            subtitles: self.subtitles.clone(),
        }
    }

    /// End of the last clip on any track.
    pub fn duration(&self) -> Frame {
        self.tracks
            .iter()
            .filter_map(|t| t.clips.last())
            .map(Clip::end)
            .max()
            .unwrap_or(0)
    }

    pub fn track_index(&self, id: Uuid) -> Option<usize> {
        self.tracks.iter().position(|t| t.id == id)
    }

    pub fn track(&self, id: Uuid) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    pub fn track_mut(&mut self, id: Uuid) -> Option<&mut Track> {
        self.tracks.iter_mut().find(|t| t.id == id)
    }

    /// Indices of all tracks of `kind`, bottom to top for video, top to bottom for audio.
    pub fn tracks_of(&self, kind: TrackKind) -> Vec<usize> {
        (0..self.tracks.len()).filter(|&i| self.tracks[i].kind == kind).collect()
    }

    /// Returns (track index, clip index) of a clip.
    pub fn locate(&self, clip: Uuid) -> Option<(usize, usize)> {
        self.tracks.iter().enumerate().find_map(|(ti, t)| {
            t.clips.iter().position(|c| c.id == clip).map(|ci| (ti, ci))
        })
    }

    pub fn clip(&self, id: Uuid) -> Option<&Clip> {
        self.locate(id).map(|(t, c)| &self.tracks[t].clips[c])
    }

    pub fn has_clips(&self) -> bool {
        self.tracks.iter().any(|t| !t.clips.is_empty())
    }

    /// The sequence as the source of a nested clip: a "media file" with the
    /// sequence's id, length, picture size and frame rate, and stereo sound;
    /// it has a picture or sound when the sequence has clips of that kind.
    pub fn as_source(&self) -> MediaAsset {
        let has = |k: TrackKind| self.tracks.iter().any(|t| t.kind == k && !t.clips.is_empty());
        let s = &self.settings;
        let video = has(TrackKind::Video).then(|| VideoInfo {
            codec: "sequence".into(),
            profile: None,
            width: s.width,
            height: s.height,
            fps: s.fps,
            pix_fmt: Some("rgba".into()),
            bit_rate: None,
            rotation: 0,
            color: ColorTags::default(),
        });
        let audio = has(TrackKind::Audio).then(|| AudioInfo {
            codec: "sequence".into(),
            channels: 2,
            sample_rate: s.sample_rate,
            channel_layout: Some("stereo".into()),
            bit_rate: None,
        });
        MediaAsset {
            id: self.id,
            path: PathBuf::new(),
            name: self.name.clone(),
            kind: MediaKind::Video,
            status: MediaStatus::Ready,
            info: Some(MediaInfo { duration: s.fps.frames_to_seconds(self.duration()), size_bytes: 0, container: "sequence".into(), bit_rate: None, video, audio }),
            bin: None,
            favorite: false,
            label: LabelColor::None,
            tags: Vec::new(),
            note: String::new(),
            imported_at: 0,
            derived: Derived::default(),
            marks: SourceMarks::default(),
            title: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: Uuid,
    pub kind: TrackKind,
    pub name: String,
    pub clips: Vec<Clip>,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub solo: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub volume_db: f32,
    #[serde(default)]
    pub color: LabelColor,
    /// Row height in px; 0 = the timeline default.
    #[serde(default)]
    pub height: u16,
    /// Audio tracks: effects on the track's mix, before its volume.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<AudioEffect>,
    /// Audio tracks: the mix is folded to mono (same on both sides).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mono: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionKind {
    Dissolve,
    DipBlack,
    DipWhite,
    /// Wipes name the direction the edge moves (left = from right to left).
    WipeLeft,
    WipeRight,
    WipeUp,
    WipeDown,
    /// Audio: linear fade out and in at the same time.
    Crossfade,
    // Mask transitions: the incoming side shows where the mask is set; see
    // `TransitionKind::mask` for the exact shapes (preview and export).
    /// Circle growing from the centre to the corners.
    IrisRound,
    /// Rectangle growing from the centre (frame aspect).
    IrisBox,
    /// Clock hand sweeping clockwise from 12 o'clock.
    Clock,
    /// Opens from a vertical centre line to the left and right edges.
    BarnDoorH,
    /// Opens from a horizontal centre line to the top and bottom edges.
    BarnDoorV,
    /// Diagonal edge moving from the top left to the bottom right.
    WipeDiagonal,
    /// Ten horizontal bands, each filling from its top edge.
    Blinds,
}

impl TransitionKind {
    pub fn is_audio(self) -> bool {
        self == TransitionKind::Crossfade
    }

    /// For mask transitions: the condition (FFmpeg expression over pixel
    /// `X`, `Y`, frame size `W`, `H` and progress `PRG` in 0..1) under which a
    /// pixel shows the incoming side. Pixel centres are at +0.5. Mirrored by
    /// `maskTransition` in src/engine/compositor.ts.
    pub fn mask(self) -> Option<&'static str> {
        use TransitionKind as K;
        Some(match self {
            K::IrisRound => "lte(pow(X+0.5-W/2,2)+pow(Y+0.5-H/2,2),pow(PRG*hypot(W,H)/2,2))",
            K::IrisBox => "lte(abs(X+0.5-W/2),PRG*W/2)*lte(abs(Y+0.5-H/2),PRG*H/2)",
            K::Clock => "lt(if(lt(atan2(X+0.5-W/2,H/2-Y-0.5),0),atan2(X+0.5-W/2,H/2-Y-0.5)+2*PI,atan2(X+0.5-W/2,H/2-Y-0.5)),PRG*2*PI)",
            K::BarnDoorH => "lte(abs(X+0.5-W/2),PRG*W/2)",
            K::BarnDoorV => "lte(abs(Y+0.5-H/2),PRG*H/2)",
            K::WipeDiagonal => "lte((X+0.5)/W+(Y+0.5)/H,2*PRG)",
            K::Blinds => "lt(mod(Y+0.5,H/10),PRG*H/10)",
            _ => return None,
        })
    }
}

/// Where a transition sits relative to the cut.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionAlign {
    #[default]
    Center,
    /// Begins at the cut (uses frames of the outgoing clip after its end).
    Start,
    /// Ends at the cut (uses frames of the incoming clip before its start).
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub kind: TransitionKind,
    pub duration: Frame,
    #[serde(default)]
    pub align: TransitionAlign,
}

/// Longest transition (10 minutes at 60 fps).
pub const MAX_TRANSITION: Frame = 36_000;

/// The frames `[t0, t1)` a transition plays, around the cut between two clips.
/// The outgoing clip shows until `t1`, the incoming one from `t0`; both hold
/// their last/first frame where the media ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransitionSpan {
    pub kind: TransitionKind,
    pub t0: Frame,
    pub t1: Frame,
    pub cut: Frame,
}

impl TransitionSpan {
    pub fn len(&self) -> Frame {
        self.t1 - self.t0
    }

    pub fn is_empty(&self) -> bool {
        self.t1 <= self.t0
    }
}

impl Track {
    /// The transition into clip `b` (an index), if it is valid: the previous
    /// clip ends where `b` starts and the kind fits the track. It takes at most
    /// half of each clip, so neighbouring transitions never overlap.
    /// Mirrored by `transitionInto` in `src/timeline/geometry.ts`.
    pub fn transition_into(&self, b: usize) -> Option<TransitionSpan> {
        let clip = self.clips.get(b)?;
        let t = clip.transition?;
        let a = self.clips.get(b.checked_sub(1)?)?;
        if a.end() != clip.start || t.kind.is_audio() != (self.kind == TrackKind::Audio) || t.duration <= 0 {
            return None;
        }
        let (left, right) = match t.align {
            TransitionAlign::Center => (t.duration / 2, t.duration - t.duration / 2),
            TransitionAlign::Start => (0, t.duration),
            TransitionAlign::End => (t.duration, 0),
        };
        let (left, right) = (left.min(a.duration / 2), right.min(clip.duration / 2));
        (left + right > 0).then_some(TransitionSpan { kind: t.kind, t0: clip.start - left, t1: clip.start + right, cut: clip.start })
    }

    /// Drops transitions whose clips are no longer adjacent or that do not
    /// fit the track; true when something changed.
    pub fn tidy_transitions(&mut self) -> bool {
        let mut changed = false;
        for b in 0..self.clips.len() {
            let Some(t) = self.clips[b].transition else { continue };
            let ok = b > 0 && self.clips[b - 1].end() == self.clips[b].start && t.kind.is_audio() == (self.kind == TrackKind::Audio);
            if !ok {
                self.clips[b].transition = None;
                changed = true;
            }
        }
        changed
    }
}

impl Track {
    pub fn new(kind: TrackKind, name: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            kind,
            name: name.into(),
            clips: Vec::new(),
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            volume_db: 0.0,
            color: LabelColor::None,
            height: 0,
            effects: Vec::new(),
            mono: false,
        }
    }

    /// Everything but the clips (deltas send clips separately).
    pub fn clone_without_clips(&self) -> Self {
        Self {
            id: self.id,
            kind: self.kind,
            name: self.name.clone(),
            clips: Vec::new(),
            muted: self.muted,
            solo: self.solo,
            locked: self.locked,
            hidden: self.hidden,
            volume_db: self.volume_db,
            color: self.color,
            height: self.height,
            effects: self.effects.clone(),
            mono: self.mono,
        }
    }
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: Uuid,
    pub media_id: Uuid,
    pub name: String,
    /// Position on the timeline.
    pub start: Frame,
    /// Length on the timeline.
    pub duration: Frame,
    /// Offset into the source, in sequence frames at speed 1.
    pub source_in: Frame,
    #[serde(default = "one_f64")]
    pub speed: f64,
    /// Clips sharing a link id move, trim and delete together (A/V sync).
    #[serde(default)]
    pub link: Option<Uuid>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default = "one_f32")]
    pub opacity: f32,
    #[serde(default)]
    pub volume_db: f32,
    /// -1 (left) .. 1 (right).
    #[serde(default)]
    pub pan: f32,
    #[serde(default)]
    pub fade_in: Frame,
    #[serde(default)]
    pub fade_out: Frame,
    #[serde(default)]
    pub color: ColorAdjust,
    /// Colour label shown on the clip.
    #[serde(default)]
    pub label: LabelColor,
    /// Animated properties; a property with keys ignores its static value.
    #[serde(default)]
    pub keys: BTreeMap<Param, Vec<Keyframe>>,
    /// Video effects, applied in order after the colour correction and
    /// before opacity and the transform.
    #[serde(default)]
    pub effects: Vec<Effect>,
    /// Transition from the previous clip on the track into this one (only
    /// valid while that clip ends exactly where this one starts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<Transition>,
    /// Audio effects in order, before the clip volume (audio clips).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio_effects: Vec<AudioEffect>,
    /// Routing of the source channels (audio clips).
    #[serde(default, skip_serializing_if = "ChannelMap::is_stereo")]
    pub channels: ChannelMap,
    /// Plays the source range backwards.
    #[serde(default, skip_serializing_if = "is_false")]
    pub reverse: bool,
    /// Multicam group whose angles this clip can switch between.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multicam: Option<Uuid>,
    /// Skips the whole effect stack without changing it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub fx_bypass: bool,
    /// How the clip mixes with what is below it (video tracks).
    #[serde(default, skip_serializing_if = "BlendMode::is_normal")]
    pub blend_mode: BlendMode,
}

/// Blend modes with 8-bit formulas as FFmpeg's `blend` filter computes them,
/// with the composite below as `A` (top input) and the clip's premultiplied
/// colour as `B`: multiply A*B/255, screen 255-(255-A)(255-B)/255, overlay
/// (A < 128 ? 2*(AB/255) : 255-2*((255-A)(255-B)/255)), add min(A+B, 255),
/// lighten max, darken min, difference |A-B| (integer divisions truncate).
/// The result is laid over the composite with the clip's alpha.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Add,
    Lighten,
    Darken,
    Difference,
}

impl BlendMode {
    pub fn is_normal(&self) -> bool {
        *self == BlendMode::Normal
    }

    /// Name of the mode in FFmpeg's `blend` filter.
    pub fn ffmpeg(self) -> &'static str {
        match self {
            BlendMode::Normal => "normal",
            BlendMode::Multiply => "multiply",
            BlendMode::Screen => "screen",
            BlendMode::Overlay => "overlay",
            BlendMode::Add => "addition",
            BlendMode::Lighten => "lighten",
            BlendMode::Darken => "darken",
            BlendMode::Difference => "difference",
        }
    }
}

fn is_false(v: &bool) -> bool {
    !*v
}

impl Clip {
    pub fn new(media_id: Uuid, name: impl Into<String>, start: Frame, duration: Frame, source_in: Frame) -> Self {
        Self {
            id: Uuid::new_v4(),
            media_id,
            name: name.into(),
            start,
            duration,
            source_in,
            speed: 1.0,
            link: None,
            enabled: true,
            transform: Transform::default(),
            opacity: 1.0,
            volume_db: 0.0,
            pan: 0.0,
            fade_in: 0,
            fade_out: 0,
            color: ColorAdjust::default(),
            label: LabelColor::None,
            keys: BTreeMap::new(),
            effects: Vec::new(),
            transition: None,
            audio_effects: Vec::new(),
            channels: ChannelMap::Stereo,
            reverse: false,
            multicam: None,
            fx_bypass: false,
            blend_mode: BlendMode::Normal,
        }
    }

    /// Enabled effects, in processing order.
    pub fn active_effects(&self) -> impl Iterator<Item = &Effect> {
        self.effects.iter().filter(|e| !self.fx_bypass && e.enabled && !e.kind.is_identity())
    }

    pub fn end(&self) -> Frame {
        self.start + self.duration
    }

    /// Keyframed speed or reversed: timing goes through [`Warp`] instead of a constant factor.
    pub fn is_warped(&self) -> bool {
        self.reverse || !self.keys_of(Param::Speed).is_empty()
    }

    /// Mapping between source and timeline positions (constant `speed` without keys).
    pub fn warp(&self) -> Warp {
        Warp::new(self.keys_of(Param::Speed), self.speed)
    }

    /// End of the used source range (exclusive).
    pub fn source_out(&self) -> Frame {
        if !self.is_warped() {
            return self.source_in + (self.duration as f64 * self.speed).round() as Frame;
        }
        let w = self.warp();
        w.s(w.w(self.source_in as f64) + self.duration as f64).round() as Frame
    }

    /// Timeline frames between source positions `a` and `b` (b >= a), rounded down.
    pub fn frames_between(&self, a: f64, b: f64) -> Frame {
        if b <= a {
            return 0;
        }
        let w = self.warp();
        (w.w(b) - w.w(a) + 1e-9).floor() as Frame
    }

    /// Timeline frames the clip's start can move earlier within a source of `len` frames.
    pub fn room_before(&self, len: Frame) -> Frame {
        if self.reverse {
            self.frames_between(self.source_out() as f64, len as f64)
        } else {
            self.frames_between(0.0, self.source_in as f64)
        }
    }

    /// Timeline frames the clip's end can move later within a source of `len` frames.
    pub fn room_after(&self, len: Frame) -> Frame {
        if self.reverse {
            self.frames_between(0.0, self.source_in as f64)
        } else {
            self.frames_between(self.source_out() as f64, len as f64)
        }
    }

    /// Moves the clip's edges to timeline frames `start..end`, keeping every
    /// remaining frame on the source frame it showed (trims, splits).
    pub fn set_range(&mut self, start: Frame, end: Frame) {
        let edge = if self.reverse { end } else { start };
        let at = self.source_at((edge - self.start) as f64);
        self.source_in = (at.round() as Frame).max(0);
        self.start = start;
        self.duration = (end - start).max(1);
    }

    /// Shifts the used source range by `frames` timeline frames (slip).
    pub fn slip(&mut self, frames: Frame) {
        let w = self.warp();
        let at = w.s(w.w(self.source_in as f64) + frames as f64);
        self.source_in = (at.round() as Frame).max(0);
    }

    /// Duration that shows the source range `source_in..source_out` with the current speed.
    pub fn duration_for(&self, source_out: Frame) -> Frame {
        let w = self.warp();
        ((w.w(source_out as f64) - w.w(self.source_in as f64)).round() as Frame).max(1)
    }

    /// Keys of `param`, empty when it is not animated.
    pub fn keys_of(&self, param: Param) -> &[Keyframe] {
        self.keys.get(&param).map_or(&[], Vec::as_slice)
    }

    /// Source position (sequence frames at speed 1) at clip-local timeline
    /// position `local` (a frame boundary). Reversed clips run from
    /// `source_out` down to `source_in`, so their frame `l` shows the source
    /// frame just below `source_at(l)`.
    pub fn source_at(&self, local: f64) -> f64 {
        if !self.is_warped() {
            return self.source_in as f64 + local * self.speed;
        }
        let w = self.warp();
        let w0 = w.w(self.source_in as f64);
        w.s(if self.reverse { w0 + self.duration as f64 - local } else { w0 + local })
    }

    /// Source frame shown on clip-local frame `local`: the one under the
    /// clip's position, or just below it when reversed.
    pub fn shown_frame(&self, local: Frame) -> Frame {
        let q = self.source_at(local as f64);
        if self.reverse { (q - 1e-6).ceil() as Frame - 1 } else { (q + 1e-6).floor() as Frame }
    }

    /// Clip-local timeline position of source position `at` (inverse of [`Clip::source_at`]).
    pub fn local_of(&self, at: Frame) -> f64 {
        self.local_at(at as f64)
    }

    pub fn local_at(&self, at: f64) -> f64 {
        if !self.is_warped() {
            return (at - self.source_in as f64) / self.speed;
        }
        let w = self.warp();
        let d = w.w(at) - w.w(self.source_in as f64);
        if self.reverse { self.duration as f64 - d } else { d }
    }

    /// Playback speed at clip-local position `local` (positive; see `reverse` for the direction).
    pub fn speed_at(&self, local: f64) -> f64 {
        if !self.is_warped() {
            return self.speed;
        }
        let w = self.warp();
        let w0 = w.w(self.source_in as f64);
        w.speed(if self.reverse { w0 + self.duration as f64 - local } else { w0 + local })
    }

    /// Value of `param` at clip-local timeline frame `local`. Between two
    /// keys the curve runs over timeline time (equal to source time at a
    /// constant speed), so a speed ramp does not bend the other curves.
    pub fn param_at(&self, param: Param, local: f64) -> f32 {
        let keys = self.keys_of(param);
        if keys.is_empty() {
            return self.base_value(param);
        }
        if !self.is_warped() {
            return eval_keys(keys, self.source_at(local));
        }
        let at = self.source_at(local);
        let first = keys[0];
        if at <= first.at as f64 {
            return first.value;
        }
        for w in keys.windows(2) {
            let (a, b) = (w[0], w[1]);
            if at < b.at as f64 {
                let (la, lb) = (self.local_of(a.at), self.local_of(b.at));
                let u = if (lb - la).abs() < 1e-9 { 1.0 } else { ((local - la) / (lb - la)).clamp(0.0, 1.0) };
                return (a.value as f64 + (b.value - a.value) as f64 * a.ease.apply(u)) as f32;
            }
        }
        keys[keys.len() - 1].value
    }

    /// Static (non-animated) value of `param`.
    pub fn base_value(&self, param: Param) -> f32 {
        match param {
            Param::X => self.transform.x,
            Param::Y => self.transform.y,
            Param::Scale => self.transform.scale,
            Param::Rotation => self.transform.rotation,
            Param::Opacity => self.opacity,
            Param::Volume => self.volume_db,
            Param::Exposure => self.color.exposure,
            Param::Contrast => self.color.contrast,
            Param::Saturation => self.color.saturation,
            Param::Temperature => self.color.temperature,
            Param::Tint => self.color.tint,
            Param::Speed => self.speed as f32,
        }
    }

    /// Colour correction at clip-local timeline frame `local` (animated or static).
    pub fn color_at(&self, local: f64) -> ColorAdjust {
        ColorAdjust {
            exposure: self.param_at(Param::Exposure, local),
            contrast: self.param_at(Param::Contrast, local),
            saturation: self.param_at(Param::Saturation, local),
            temperature: self.param_at(Param::Temperature, local),
            tint: self.param_at(Param::Tint, local),
        }
    }

    pub fn color_animated(&self) -> bool {
        Param::COLOR.iter().any(|p| !self.keys_of(*p).is_empty())
    }
}

/// Spatial transform, evaluated as: crop -> fit to frame -> scale/rotate about
/// anchor -> place anchor at frame centre + (x, y).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Transform {
    /// Offset of the anchor from the frame centre, in sequence pixels.
    pub x: f32,
    pub y: f32,
    /// 1.0 = fitted to the sequence frame.
    pub scale: f32,
    /// Degrees, clockwise.
    pub rotation: f32,
    /// Anchor in clip space, 0..1 (0.5/0.5 = centre).
    pub anchor_x: f32,
    pub anchor_y: f32,
    /// Crop fractions 0..1 of the source frame.
    pub crop_left: f32,
    pub crop_right: f32,
    pub crop_top: f32,
    pub crop_bottom: f32,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            anchor_x: 0.5,
            anchor_y: 0.5,
            crop_left: 0.0,
            crop_right: 0.0,
            crop_top: 0.0,
            crop_bottom: 0.0,
        }
    }
}

impl Transform {
    pub fn is_identity(&self) -> bool {
        *self == Self::default()
    }
}

/// Primary colour correction. Applied in display-referred RGB as an affine
/// channel matrix followed by contrast about mid-grey, identically in preview
/// and export.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorAdjust {
    /// Stops, -4..4.
    pub exposure: f32,
    /// -1..1.
    pub contrast: f32,
    /// 0..2, 1 = unchanged.
    pub saturation: f32,
    /// -1 (cool) .. 1 (warm).
    pub temperature: f32,
    /// -1 (green) .. 1 (magenta).
    pub tint: f32,
}

impl Default for ColorAdjust {
    fn default() -> Self {
        Self { exposure: 0.0, contrast: 0.0, saturation: 1.0, temperature: 0.0, tint: 0.0 }
    }
}

impl ColorAdjust {
    pub fn is_identity(&self) -> bool {
        *self == Self::default()
    }

    /// Row-major 3x3 RGB matrix combining exposure, white balance and saturation.
    pub fn matrix(&self) -> [[f32; 3]; 3] {
        let gain = 2f32.powf(self.exposure);
        let wb = [
            gain * (1.0 + 0.25 * self.temperature) * (1.0 + 0.1 * self.tint),
            gain * (1.0 - 0.2 * self.tint),
            gain * (1.0 - 0.25 * self.temperature) * (1.0 + 0.1 * self.tint),
        ];
        // Rec.709 luma weights.
        let (lr, lg, lb) = (0.2126f32, 0.7152f32, 0.0722f32);
        let s = self.saturation;
        let sat = [
            [lr * (1.0 - s) + s, lg * (1.0 - s), lb * (1.0 - s)],
            [lr * (1.0 - s), lg * (1.0 - s) + s, lb * (1.0 - s)],
            [lr * (1.0 - s), lg * (1.0 - s), lb * (1.0 - s) + s],
        ];
        let mut m = [[0f32; 3]; 3];
        for (r, row) in m.iter_mut().enumerate() {
            for (c, cell) in row.iter_mut().enumerate() {
                *cell = sat[r][c] * wb[c];
            }
        }
        m
    }

    /// Contrast slope applied about 0.5 after the matrix.
    pub fn contrast_slope(&self) -> f32 {
        (1.0 + self.contrast).max(0.0)
    }
}

/// One entry of a clip's effect stack. Every effect exists twice with the
/// same maths: as a WebGL pass in the preview (`src/engine/effects.ts`) and
/// as FFmpeg filters in the export (`kerf_media::render`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: Uuid,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// User-given name; empty = the effect's catalogue label.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(flatten)]
    pub kind: EffectKind,
}

/// A point of a tone curve, input and output in 0..1.
pub type CurvePoint = [f32; 2];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum EffectKind {
    /// Gaussian blur; `radius` is the standard deviation in sequence pixels.
    Blur { radius: f32 },
    /// Unsharp mask: out = in + amount * (in - blur(in, radius)).
    Sharpen { amount: f32, radius: f32 },
    /// Natural (cos⁴) vignette; `amount` 0..1 is the lens angle 0..π/2.
    Vignette { amount: f32 },
    /// 3D LUT from a `.cube` file (trilinear), mixed with the input by `intensity`.
    Lut { path: PathBuf, intensity: f32 },
    /// Key on the U/V distance to `color` (RGB 0..1, BT.601), with spill suppression.
    ChromaKey { color: [f32; 3], similarity: f32, blend: f32, spill: f32 },
    /// Per channel (R, G, B): out = (in·(gain − lift) + lift)^(1/gamma).
    ColorWheels { lift: [f32; 3], gamma: [f32; 3], gain: [f32; 3] },
    /// Monotone cubic (PCHIP) tone curves: each channel's curve, then the
    /// master curve. An empty list is the identity.
    Curves { master: Vec<CurvePoint>, red: Vec<CurvePoint>, green: Vec<CurvePoint>, blue: Vec<CurvePoint> },
    /// An effect from the catalogue (`crate::fx::CATALOG`) by id, with its
    /// parameters by key.
    Fx {
        fx: String,
        #[serde(default)]
        params: BTreeMap<String, f32>,
    },
}

impl EffectKind {
    /// True when the effect leaves every pixel unchanged.
    pub fn is_identity(&self) -> bool {
        match self {
            EffectKind::Blur { radius } => *radius <= 0.0,
            EffectKind::Sharpen { amount, radius } => *amount <= 0.0 || *radius <= 0.0,
            EffectKind::Vignette { amount } => *amount <= 0.0,
            EffectKind::Lut { intensity, .. } => *intensity <= 0.0,
            EffectKind::ChromaKey { .. } => false,
            EffectKind::ColorWheels { lift, gamma, gain } => lift.iter().all(|v| *v == 0.0) && gamma.iter().chain(gain).all(|v| *v == 1.0),
            EffectKind::Curves { master, red, green, blue } => [master, red, green, blue].iter().all(|c| curve_is_identity(c)),
            EffectKind::Fx { fx, params } => crate::fx::is_identity(fx, params),
        }
    }

    /// Clamps parameters to their valid ranges; `None` for unusable input
    /// (non-finite numbers, empty LUT path).
    pub fn sanitized(&self) -> Option<Self> {
        let ok = |v: f32| v.is_finite().then_some(v);
        let rgb = |c: [f32; 3], lo: f32, hi: f32| -> Option<[f32; 3]> { Some([ok(c[0])?.clamp(lo, hi), ok(c[1])?.clamp(lo, hi), ok(c[2])?.clamp(lo, hi)]) };
        Some(match self {
            EffectKind::Blur { radius } => EffectKind::Blur { radius: ok(*radius)?.clamp(0.0, 250.0) },
            EffectKind::Sharpen { amount, radius } => EffectKind::Sharpen { amount: ok(*amount)?.clamp(0.0, 5.0), radius: ok(*radius)?.clamp(0.1, 50.0) },
            EffectKind::Vignette { amount } => EffectKind::Vignette { amount: ok(*amount)?.clamp(0.0, 1.0) },
            EffectKind::Lut { path, intensity } => {
                if path.as_os_str().is_empty() {
                    return None;
                }
                EffectKind::Lut { path: path.clone(), intensity: ok(*intensity)?.clamp(0.0, 1.0) }
            }
            EffectKind::ChromaKey { color, similarity, blend, spill } => EffectKind::ChromaKey {
                color: rgb(*color, 0.0, 1.0)?,
                similarity: ok(*similarity)?.clamp(0.001, 1.0),
                blend: ok(*blend)?.clamp(0.0, 1.0),
                spill: ok(*spill)?.clamp(0.0, 1.0),
            },
            EffectKind::ColorWheels { lift, gamma, gain } => {
                EffectKind::ColorWheels { lift: rgb(*lift, -1.0, 1.0)?, gamma: rgb(*gamma, 0.1, 10.0)?, gain: rgb(*gain, 0.0, 8.0)? }
            }
            EffectKind::Curves { master, red, green, blue } => EffectKind::Curves {
                master: clean_curve(master)?,
                red: clean_curve(red)?,
                green: clean_curve(green)?,
                blue: clean_curve(blue)?,
            },
            EffectKind::Fx { fx, params } => {
                let def = crate::fx::def(fx)?;
                EffectKind::Fx { fx: fx.clone(), params: crate::fx::sanitize(def, params)? }
            }
        })
    }
}

/// Most points a tone curve may have.
pub const CURVE_POINTS: usize = 16;

/// Points clamped to 0..1, sorted by input, one per input value.
fn clean_curve(points: &[CurvePoint]) -> Option<Vec<CurvePoint>> {
    let mut out: Vec<CurvePoint> = Vec::with_capacity(points.len());
    for p in points {
        if !p[0].is_finite() || !p[1].is_finite() {
            return None;
        }
        out.push([p[0].clamp(0.0, 1.0), p[1].clamp(0.0, 1.0)]);
    }
    out.sort_by(|a, b| a[0].total_cmp(&b[0]));
    out.dedup_by(|b, a| (a[0] - b[0]).abs() < 1e-4);
    out.truncate(CURVE_POINTS);
    Some(if curve_is_identity(&out) { Vec::new() } else { out })
}

/// A curve with fewer than two points, or only the diagonal, changes nothing.
pub fn curve_is_identity(points: &[CurvePoint]) -> bool {
    points.len() < 2 || points.iter().all(|p| (p[0] - p[1]).abs() < 1e-6)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: Uuid,
    pub frame: Frame,
    pub name: String,
    #[serde(default)]
    pub note: String,
    pub color: MarkerColor,
    /// Free category, e.g. "scene", "beat", "silence" (empty: none).
    #[serde(default)]
    pub category: String,
    /// Length in frames for range markers (0: a point).
    #[serde(default)]
    pub duration: Frame,
    /// Written as a chapter into exported files that support chapters.
    #[serde(default)]
    pub chapter: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkerColor {
    Signal,
    Red,
    Amber,
    Blue,
    Violet,
}

/// Colour label for clips, tracks and media.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LabelColor {
    #[default]
    None,
    Red,
    Orange,
    Yellow,
    Green,
    Teal,
    Blue,
    Violet,
    Pink,
}

fn one_f64() -> f64 {
    1.0
}
fn one_f32() -> f32 {
    1.0
}
fn yes() -> bool {
    true
}

/// Animatable clip properties.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Param {
    X,
    Y,
    Scale,
    Rotation,
    Opacity,
    /// dB.
    Volume,
    Exposure,
    Contrast,
    Saturation,
    Temperature,
    Tint,
    /// Playback speed factor (time remapping); see `timemap`.
    Speed,
}

impl Param {
    pub const ALL: [Param; 12] = [
        Param::X,
        Param::Y,
        Param::Scale,
        Param::Rotation,
        Param::Opacity,
        Param::Volume,
        Param::Exposure,
        Param::Contrast,
        Param::Saturation,
        Param::Temperature,
        Param::Tint,
        Param::Speed,
    ];
    pub const COLOR: [Param; 5] = [Param::Exposure, Param::Contrast, Param::Saturation, Param::Temperature, Param::Tint];

    pub fn is_audio(self) -> bool {
        self == Param::Volume
    }

    /// Allowed value range.
    pub fn range(self) -> (f32, f32) {
        match self {
            Param::X | Param::Y => (-100_000.0, 100_000.0),
            Param::Scale => (0.0, 100.0),
            Param::Rotation => (-36_000.0, 36_000.0),
            Param::Opacity => (0.0, 1.0),
            Param::Volume => (-96.0, 24.0),
            Param::Exposure => (-4.0, 4.0),
            Param::Contrast | Param::Temperature | Param::Tint => (-1.0, 1.0),
            Param::Saturation => (0.0, 2.0),
            Param::Speed => (MIN_SPEED as f32, MAX_SPEED as f32),
        }
    }
}

/// Interpolation from a key to the next one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Ease {
    #[default]
    Linear,
    /// Starts slowly.
    EaseIn,
    /// Ends slowly.
    EaseOut,
    /// Starts and ends slowly.
    EaseInOut,
    /// Keeps the value until the next key.
    Hold,
    /// Custom curve between (0,0) and (1,1) with two control points, like CSS
    /// `cubic-bezier()`. x is time (kept in 0..1), y is progress (may overshoot).
    Bezier { x1: f32, y1: f32, x2: f32, y2: f32 },
}

impl Ease {
    /// Eased progress for linear progress `u` in 0..1. The same polynomials
    /// are used by the preview and by the export expressions.
    pub fn apply(self, u: f64) -> f64 {
        let u = u.clamp(0.0, 1.0);
        match self {
            Ease::Linear => u,
            Ease::EaseIn => u * u,
            Ease::EaseOut => u * (2.0 - u),
            Ease::EaseInOut => u * u * (3.0 - 2.0 * u),
            Ease::Hold => 0.0,
            Ease::Bezier { x1, y1, x2, y2 } => bezier(x1 as f64, y1 as f64, x2 as f64, y2 as f64, u),
        }
    }

    /// Clamps control points to the editable range.
    pub fn sanitized(self) -> Self {
        match self {
            Ease::Bezier { x1, y1, x2, y2 } => Ease::Bezier {
                x1: finite(x1).clamp(0.0, 1.0),
                y1: finite(y1).clamp(-1.0, 2.0),
                x2: finite(x2).clamp(0.0, 1.0),
                y2: finite(y2).clamp(-1.0, 2.0),
            },
            e => e,
        }
    }
}

fn finite(v: f32) -> f32 {
    if v.is_finite() { v } else { 0.0 }
}

/// y of the cubic Bezier (0,0) (x1,y1) (x2,y2) (1,1) at x = `u`. x(t) is
/// monotonic for x1, x2 in 0..1, so a few Newton steps with a bisection
/// fallback find t. Mirrored in `src/lib/keys.ts`.
pub fn bezier(x1: f64, y1: f64, x2: f64, y2: f64, u: f64) -> f64 {
    let curve = |a: f64, b: f64, t: f64| {
        let m = 1.0 - t;
        3.0 * m * m * t * a + 3.0 * m * t * t * b + t * t * t
    };
    let slope = |a: f64, b: f64, t: f64| {
        let m = 1.0 - t;
        3.0 * m * m * a + 6.0 * m * t * (b - a) + 3.0 * t * t * (1.0 - b)
    };
    let mut t = u;
    for _ in 0..8 {
        let err = curve(x1, x2, t) - u;
        if err.abs() < 1e-7 {
            return curve(y1, y2, t);
        }
        let d = slope(x1, x2, t);
        if d.abs() < 1e-6 {
            break;
        }
        t = (t - err / d).clamp(0.0, 1.0);
    }
    let (mut lo, mut hi) = (0.0, 1.0);
    t = u;
    for _ in 0..40 {
        if curve(x1, x2, t) < u {
            lo = t;
        } else {
            hi = t;
        }
        t = 0.5 * (lo + hi);
    }
    curve(y1, y2, t)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    /// Source position in sequence frames at speed 1 (like `Clip::source_in`),
    /// so keys stay on the same picture when the clip is trimmed or split.
    pub at: Frame,
    pub value: f32,
    #[serde(default)]
    pub ease: Ease,
}

/// Value of sorted `keys` at source position `at` (constant outside the keys).
pub fn eval_keys(keys: &[Keyframe], at: f64) -> f32 {
    let Some(first) = keys.first() else { return 0.0 };
    if at <= first.at as f64 {
        return first.value;
    }
    for w in keys.windows(2) {
        let (a, b) = (w[0], w[1]);
        if at < b.at as f64 {
            let u = (at - a.at as f64) / (b.at - a.at).max(1) as f64;
            return (a.value as f64 + (b.value - a.value) as f64 * a.ease.apply(u)) as f32;
        }
    }
    keys[keys.len() - 1].value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bezier_curves_match_known_points() {
        // On the diagonal the curve is linear.
        for u in [0.0, 0.2, 0.5, 0.9, 1.0] {
            assert!((bezier(0.3, 0.3, 0.7, 0.7, u) - u).abs() < 1e-6);
        }
        // CSS "ease" and "ease-in-out", sampled from WebView2 (Web Animations API).
        let e = |u| bezier(0.25, 0.1, 0.25, 1.0, u);
        for (u, want) in [(0.25, 0.408511), (0.5, 0.802403), (0.75, 0.960459)] {
            assert!((e(u) - want).abs() < 1e-5, "{u}: {}", e(u));
        }
        assert!((bezier(0.42, 0.0, 0.58, 1.0, 0.37) - 0.285158).abs() < 1e-5);
        // Overshoot goes past 1 and comes back.
        let back = |u| bezier(0.34, 1.56, 0.64, 1.0, u);
        assert!(back(0.6) > 1.0 && (back(1.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn bezier_ease_serializes_as_tagged_object() {
        let e = Ease::Bezier { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1.0 };
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#"{"bezier":{"x1":0.25,"y1":0.1,"x2":0.25,"y2":1.0}}"#);
        assert_eq!(serde_json::from_str::<Ease>(&json).unwrap(), e);
        assert_eq!(serde_json::from_str::<Ease>(r#""easeIn""#).unwrap(), Ease::EaseIn);
    }
}
