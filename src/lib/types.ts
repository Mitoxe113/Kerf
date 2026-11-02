// Mirrors of the Rust engine types (crates/kerf-core/src/model.rs, ops.rs).
// Keep in sync with serde's camelCase output.

export type Uuid = string;
export type Frame = number;

export interface Rational {
  num: number;
  den: number;
}

export type MediaKind = "video" | "audio" | "image";
export type MediaStatus =
  | { state: "analyzing" }
  | { state: "ready" }
  | { state: "missing" }
  | { state: "error"; message: string };

export interface VideoInfo {
  codec: string;
  profile: string | null;
  width: number;
  height: number;
  fps: Rational;
  pixFmt: string | null;
  bitRate: number | null;
  rotation: number;
  /** Colour tags of the file (ffprobe names); null = untagged. */
  color?: ColorTags;
}

export interface ColorTags {
  space: string | null;
  range: string | null;
  transfer: string | null;
  primaries: string | null;
}

/** Source monitor In/Out, seconds of media time. */
export interface SourceMarks {
  in: number | null;
  out: number | null;
}

export interface AudioInfo {
  codec: string;
  channels: number;
  sampleRate: number;
  channelLayout: string | null;
  bitRate: number | null;
}

export interface MediaInfo {
  duration: number;
  sizeBytes: number;
  container: string;
  bitRate: number | null;
  video: VideoInfo | null;
  audio: AudioInfo | null;
}

export interface Filmstrip {
  path: string;
  tiles: number;
  tileWidth: number;
  tileHeight: number;
  interval: number;
}

export interface Derived {
  poster: string | null;
  filmstrip: Filmstrip | null;
  peaks: { path: string; rate: number } | null;
  proxy: string | null;
  previewNative: boolean;
}

export interface MediaAsset {
  id: Uuid;
  path: string;
  name: string;
  kind: MediaKind;
  status: MediaStatus;
  info: MediaInfo | null;
  bin: Uuid | null;
  favorite: boolean;
  label: LabelColor;
  tags: string[];
  note: string;
  importedAt: number;
  derived: Derived;
  marks?: SourceMarks;
  /** Generated title; `path` is its rendered PNG. */
  title?: TitleSpec;
}

// --- text ----------------------------------------------------------------------

export type TextAlign = "left" | "center" | "right";

/** Look of a text block; sizes are pixels at 1080 lines (kerf_core::text::TextStyle). */
export interface TextStyle {
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  color: Rgb;
  align: TextAlign;
  lineHeight: number;
  outline: number;
  outlineColor: Rgb;
  shadow: number;
  boxOpacity: number;
  boxColor: Rgb;
  boxPadding: number;
  /** Lines wrap at this fraction of the frame width. */
  wrap: number;
}

export interface TitleSpec {
  text: string;
  style: TextStyle;
  /** Anchor of the text block, 0..1 of the frame: x is its left edge, centre or right edge by the alignment. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Cue {
  id: Uuid;
  start: Frame;
  /** Exclusive. */
  end: Frame;
  text: string;
}

export interface Subtitles {
  cues: Cue[];
  style: TextStyle;
  /** Bottom margin, 0..1 of the height. */
  margin: number;
  visible: boolean;
}

/** A cue in seconds as read from a subtitle file. */
export interface TimedText {
  start: number;
  end: number;
  text: string;
}

export interface Bin {
  id: Uuid;
  name: string;
  parent: Uuid | null;
}

export interface SequenceSettings {
  fps: Rational;
  width: number;
  height: number;
  sampleRate: number;
}

export type TrackKind = "video" | "audio";

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  anchorX: number;
  anchorY: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
}

export interface ColorAdjust {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
}

export interface Clip {
  id: Uuid;
  mediaId: Uuid;
  name: string;
  start: Frame;
  duration: Frame;
  sourceIn: Frame;
  speed: number;
  link: Uuid | null;
  enabled: boolean;
  transform: Transform;
  opacity: number;
  volumeDb: number;
  pan: number;
  fadeIn: Frame;
  fadeOut: Frame;
  color: ColorAdjust;
  label: LabelColor;
  /** Animated properties; a property with keys ignores its static value. */
  keys: Partial<Record<KeyParam, Keyframe[]>>;
  effects?: Effect[];
  /** Transition from the previous clip on the track into this one. */
  transition?: Transition | null;
  /** Audio clips: effects before the clip volume. */
  audioEffects?: AudioEffect[];
  /** Audio clips: routing of the source channels (default stereo). */
  channels?: ChannelMap;
}

export type EqShape = "highPass" | "lowShelf" | "peak" | "highShelf" | "lowPass";
export interface EqBand {
  shape: EqShape;
  freq: number;
  gainDb: number;
  /** Peak bandwidth / pass-filter resonance; shelves use slope 1. */
  q: number;
  enabled: boolean;
}
export type AudioEffectKind =
  | { type: "eq"; bands: EqBand[] }
  | { type: "compressor"; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; kneeDb: number; makeupDb: number }
  | { type: "gate"; thresholdDb: number; rangeDb: number; ratio: number; attackMs: number; releaseMs: number }
  | { type: "limiter"; ceilingDb: number; releaseMs: number };
export type AudioEffect = { id: Uuid; enabled: boolean } & AudioEffectKind;
export type ChannelMap = "stereo" | "mono" | "left" | "right" | "swap";

/** Wipes name the direction the edge moves; crossfade is the audio kind. */
export type TransitionKind = "dissolve" | "dipBlack" | "dipWhite" | "wipeLeft" | "wipeRight" | "wipeUp" | "wipeDown" | "crossfade";
export type TransitionAlign = "center" | "start" | "end";
export interface Transition {
  kind: TransitionKind;
  duration: Frame;
  align: TransitionAlign;
}

export type CurvePoint = [number, number];
export type Rgb = [number, number, number];
export type EffectKind =
  | { type: "blur"; radius: number }
  | { type: "sharpen"; amount: number; radius: number }
  | { type: "vignette"; amount: number }
  | { type: "lut"; path: string; intensity: number }
  | { type: "chromaKey"; color: Rgb; similarity: number; blend: number; spill: number }
  | { type: "colorWheels"; lift: Rgb; gamma: Rgb; gain: Rgb }
  | { type: "curves"; master: CurvePoint[]; red: CurvePoint[]; green: CurvePoint[]; blue: CurvePoint[] };
export type Effect = { id: Uuid; enabled: boolean } & EffectKind;

export type ColorParam = "exposure" | "contrast" | "saturation" | "temperature" | "tint";
export type KeyParam = "x" | "y" | "scale" | "rotation" | "opacity" | "volume" | ColorParam;
export interface BezierEase {
  bezier: { x1: number; y1: number; x2: number; y2: number };
}
export type Ease = "linear" | "easeIn" | "easeOut" | "easeInOut" | "hold" | BezierEase;
export interface Keyframe {
  /** Source position in sequence frames at speed 1 (like `sourceIn`). */
  at: Frame;
  value: number;
  ease: Ease;
}

export interface Track {
  id: Uuid;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  muted: boolean;
  solo: boolean;
  locked: boolean;
  hidden: boolean;
  volumeDb: number;
  color: LabelColor;
  /** Row height in px; 0 = timeline default. */
  height: number;
  /** Audio tracks: effects on the track mix, before the track volume. */
  effects?: AudioEffect[];
  /** Audio tracks: mix folded to mono. */
  mono?: boolean;
}

export type MarkerColor = "signal" | "red" | "amber" | "blue" | "violet";
export type LabelColor = "none" | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "violet" | "pink";

export interface Marker {
  id: Uuid;
  frame: Frame;
  name: string;
  note: string;
  color: MarkerColor;
}

export interface Sequence {
  id: Uuid;
  name: string;
  settings: SequenceSettings;
  tracks: Track[];
  markers: Marker[];
  inPoint: Frame | null;
  outPoint: Frame | null;
  subtitles: Subtitles;
}

export interface Project {
  schemaVersion: number;
  id: Uuid;
  name: string;
  createdAt: number;
  modifiedAt: number;
  media: MediaAsset[];
  bins: Bin[];
  sequences: Sequence[];
  activeSequence: Uuid;
}

export interface HistoryState {
  undo: string | null;
  redo: string | null;
}

export interface ProjectState {
  project: Project;
  path: string | null;
  dirty: boolean;
  revision: number;
  history: HistoryState;
}

export interface EditOutcome {
  label: string;
  changed: boolean;
  sequence: Uuid | null;
  mediaChanged: boolean;
  sequencesChanged: boolean;
  created: Uuid[];
}

export interface Delta {
  outcome: EditOutcome;
  revision: number;
  dirty: boolean;
  history: HistoryState;
  activeSequence: Uuid;
  /** Set when sequences were added, removed or reordered (then `patches` is empty). */
  sequences: Sequence[] | null;
  patches: SequenceDelta[];
  media: MediaAsset[] | null;
  bins: Bin[] | null;
}

/** Clip-level change of one track; `track.clips` is empty. */
export interface TrackDelta {
  track: Track;
  new: boolean;
  removed: Uuid[];
  upserted: Clip[];
}

/** A changed sequence; `sequence.tracks` is empty, `tracks` lists every track in order. */
export interface SequenceDelta {
  sequence: Sequence;
  tracks: TrackDelta[];
}

export interface HistoryList {
  entries: { label: string; time: number }[];
  position: number;
}

export type Edge = "start" | "end";
export type PlaceMode = "overwrite" | "insert";

export type ClipPatch = Partial<
  Pick<Clip, "name" | "enabled" | "transform" | "opacity" | "volumeDb" | "pan" | "speed" | "fadeIn" | "fadeOut" | "color" | "label" | "channels">
>;
export type TrackPatch = Partial<Pick<Track, "name" | "muted" | "solo" | "locked" | "hidden" | "volumeDb" | "color" | "height" | "effects" | "mono">>;
export type MediaPatch = Partial<Pick<MediaAsset, "favorite" | "label" | "tags" | "note">>;

export interface PasteItem {
  clip: Clip;
  track: Uuid;
  kind: TrackKind;
}

/** Every document mutation. Serialised with serde's `tag = "type"`. */
export type EditCommand =
  | { type: "removeMedia"; media: Uuid[] }
  | { type: "renameMedia"; media: Uuid; name: string }
  | { type: "setMediaFavorite"; media: Uuid[]; favorite: boolean }
  | { type: "updateMedia"; media: Uuid[]; patch: MediaPatch }
  | { type: "setSourceMarks"; media: Uuid; marks: SourceMarks }
  | { type: "setEffects"; sequence: Uuid; clips: Uuid[]; effects: Effect[] }
  | { type: "setTransitions"; sequence: Uuid; items: { clip: Uuid; transition: Transition | null }[] }
  | { type: "setAudioEffects"; sequence: Uuid; items: { clip: Uuid; effects: AudioEffect[] }[] }
  | { type: "moveMediaToBin"; media: Uuid[]; bin: Uuid | null }
  | { type: "relinkMedia"; media: Uuid; path: string }
  | { type: "createBin"; name: string; parent: Uuid | null }
  | { type: "renameBin"; bin: Uuid; name: string }
  | { type: "removeBin"; bin: Uuid }
  | { type: "addSequence"; name: string; settings: SequenceSettings }
  | { type: "removeSequence"; sequence: Uuid }
  | { type: "renameSequence"; sequence: Uuid; name: string }
  | { type: "updateSequenceSettings"; sequence: Uuid; settings: SequenceSettings }
  | { type: "addTrack"; sequence: Uuid; kind: TrackKind }
  | { type: "removeTrack"; sequence: Uuid; track: Uuid }
  | { type: "updateTrack"; sequence: Uuid; track: Uuid; patch: TrackPatch }
  | {
      type: "placeMedia";
      sequence: Uuid;
      media: Uuid;
      videoTrack?: Uuid | null;
      audioTrack?: Uuid | null;
      at: Frame;
      mode: PlaceMode;
      sourceIn?: Frame | null;
      sourceOut?: Frame | null;
      matchSequence?: boolean;
    }
  | { type: "moveClips"; sequence: Uuid; clips: Uuid[]; delta: Frame; trackDelta?: number; trackKind?: TrackKind | null }
  | { type: "trimClip"; sequence: Uuid; clip: Uuid; edge: Edge; delta: Frame; ripple: boolean; linked?: boolean }
  | { type: "rollEdit"; sequence: Uuid; clip: Uuid; delta: Frame; linked?: boolean }
  | { type: "slipClip"; sequence: Uuid; clip: Uuid; delta: Frame; linked?: boolean }
  | { type: "slideClip"; sequence: Uuid; clip: Uuid; delta: Frame; linked?: boolean }
  | { type: "splitAt"; sequence: Uuid; frame: Frame; clips?: Uuid[] | null }
  | { type: "deleteClips"; sequence: Uuid; clips: Uuid[]; ripple: boolean }
  | { type: "closeGap"; sequence: Uuid; track: Uuid; frame: Frame }
  | { type: "pasteClips"; sequence: Uuid; items: PasteItem[]; at: Frame }
  | { type: "duplicateClips"; sequence: Uuid; clips: Uuid[] }
  | { type: "updateClips"; sequence: Uuid; clips: Uuid[]; patch: ClipPatch }
  | { type: "linkClips"; sequence: Uuid; clips: Uuid[] }
  | { type: "unlinkClips"; sequence: Uuid; clips: Uuid[] }
  | { type: "addMarker"; sequence: Uuid; frame: Frame; name: string; color: MarkerColor }
  | { type: "updateMarker"; sequence: Uuid; marker: Uuid; patch: Partial<Pick<Marker, "frame" | "name" | "note" | "color">> }
  | { type: "removeMarker"; sequence: Uuid; marker: Uuid }
  | { type: "setKeyframes"; sequence: Uuid; clip: Uuid; param: KeyParam; keys: Keyframe[] }
  | { type: "setClipGain"; sequence: Uuid; gains: ClipGain[] }
  | { type: "removeRange"; sequence: Uuid; start: Frame; end: Frame; ripple: boolean; tracks?: Uuid[] | null }
  | { type: "replaceMedia"; sequence: Uuid; clip: Uuid; media: Uuid }
  | { type: "setInOut"; sequence: Uuid; inPoint: Frame | null; outPoint: Frame | null }
  | { type: "addTitle"; sequence: Uuid; asset: MediaAsset; track: Uuid; at: Frame; duration: Frame }
  | { type: "updateTitle"; media: Uuid; title: TitleSpec; path: string }
  | { type: "setSubtitles"; sequence: Uuid; cues: Cue[] }
  | { type: "setSubtitleStyle"; sequence: Uuid; style: TextStyle; margin: number; visible: boolean };

// --- export ------------------------------------------------------------------

export type VideoCodec = "h264" | "hevc" | "proRes422" | "proRes422Hq";
export type AudioCodec = "aac" | "pcm";
/** quality = CRF/CQ; bitrate = VBR around kbps; constant = CBR. */
export type RateControl = { mode: "quality"; crf: number } | { mode: "bitrate"; kbps: number } | { mode: "constant"; kbps: number };

export interface ExportSettings {
  output: string;
  videoCodec: VideoCodec;
  hardware: boolean;
  width: number;
  height: number;
  fps: Rational;
  rate: RateControl;
  audioCodec: AudioCodec;
  audioBitrateKbps: number;
  sampleRate: number;
  /** 1 = mono, 2 = stereo. */
  audioChannels: 1 | 2;
  useInOut: boolean;
  subtitles?: SubtitleOutput;
  /** Freshly drawn title PNGs by media id (see engine/text.ts titleFiles). */
  titleFiles?: Record<Uuid, string>;
  /** Normalise the mix to this loudness (two passes). */
  loudness?: LoudnessTarget | null;
}

export interface LoudnessTarget {
  /** LUFS, -70..-5. */
  integrated: number;
  /** dBTP, -9..0. */
  truePeak: number;
}

export interface SubtitleOutput {
  /** Cue images (sequence size) to burn in. */
  burn: { start: Frame; end: Frame; path: string }[];
  blank: string | null;
  sidecar: "srt" | "vtt" | null;
  embed: boolean;
}

export interface RenderProgress {
  fraction: number;
  frame: number;
  elapsed: number;
  eta: number | null;
  speed: number | null;
  /** Pass 1 of a loudness normalisation (measuring the mix). */
  measuring: boolean;
}

export type ExportStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ExportJob {
  id: Uuid;
  sequenceName: string;
  output: string;
  status: ExportStatus;
  progress: RenderProgress;
  encoder: string;
  duration: number;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
  width: number;
  height: number;
  fps: number;
  channels: number;
  /** Post-render check of the file; null while running. */
  qc: ExportQc | null;
}

export interface ExportQc {
  duration: number;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  channels: number | null;
  sampleRate: number | null;
  loudness: Loudness | null;
  error: string | null;
}

export interface AppInfo {
  version: string;
  ffmpeg: string | null;
  hwEncoders: string[] | null;
  cacheDir: string;
}

/** EBU R128 measurement; null = silent. */
export interface Loudness {
  integrated: number | null;
  range: number | null;
  samplePeak: number | null;
  truePeak: number | null;
}

export interface ClipLoudness {
  clip: Uuid;
  loudness: Loudness | null;
}

export interface ClipGain {
  clip: Uuid;
  volumeDb: number;
  /** Also end the clip's effects with a limiter holding the clip's output at this ceiling (dBFS). */
  limitDb?: number | null;
}

export interface VersionInfo {
  file: string;
  savedAt: number;
  size: number;
}

export interface RecoveryInfo {
  projectId: Uuid;
  name: string;
  path: string | null;
  savedAt: number;
}

export interface CommandError {
  code: string;
  message: string;
}
