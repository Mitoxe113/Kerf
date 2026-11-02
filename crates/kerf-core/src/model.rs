//! Project data model.
//!
//! The model is plain data. Invariants (e.g. clips on a track are sorted and
//! never overlap) are maintained by [`crate::ops`]; [`Project::normalize`]
//! re-establishes them after loading foreign or damaged files.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::time::{Frame, Rational};

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
        }
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
        }
    }

    pub fn end(&self) -> Frame {
        self.start + self.duration
    }

    /// Source frames consumed by `frames` timeline frames.
    pub fn source_span(&self, frames: Frame) -> Frame {
        (frames as f64 * self.speed).round() as Frame
    }

    pub fn source_out(&self) -> Frame {
        self.source_in + self.source_span(self.duration)
    }

    /// Keys of `param`, empty when it is not animated.
    pub fn keys_of(&self, param: Param) -> &[Keyframe] {
        self.keys.get(&param).map_or(&[], Vec::as_slice)
    }

    /// Source position (sequence frames at speed 1) of clip-local timeline frame `local`.
    pub fn source_at(&self, local: f64) -> f64 {
        self.source_in as f64 + local * self.speed
    }

    /// Clip-local timeline frame of source position `at` (inverse of [`Clip::source_at`]).
    pub fn local_of(&self, at: Frame) -> f64 {
        (at - self.source_in) as f64 / self.speed
    }

    /// Value of `param` at clip-local timeline frame `local`.
    pub fn param_at(&self, param: Param, local: f64) -> f32 {
        let keys = self.keys_of(param);
        if keys.is_empty() {
            return self.base_value(param);
        }
        eval_keys(keys, self.source_at(local))
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
        }
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: Uuid,
    pub frame: Frame,
    pub name: String,
    #[serde(default)]
    pub note: String,
    pub color: MarkerColor,
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
}

impl Param {
    pub const ALL: [Param; 6] = [Param::X, Param::Y, Param::Scale, Param::Rotation, Param::Opacity, Param::Volume];

    /// Allowed value range.
    pub fn range(self) -> (f32, f32) {
        match self {
            Param::X | Param::Y => (-100_000.0, 100_000.0),
            Param::Scale => (0.0, 100.0),
            Param::Rotation => (-36_000.0, 36_000.0),
            Param::Opacity => (0.0, 1.0),
            Param::Volume => (-96.0, 24.0),
        }
    }
}

/// Interpolation from a key to the next one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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
        }
    }
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
