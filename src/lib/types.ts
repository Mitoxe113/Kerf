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
  /** Colour matrix chosen by the user (absent = automatic). */
  matrix?: MatrixChoice;
}

/** kerf_core MatrixChoice: read a video as BT.601 or BT.709 instead of its tag or the guess. */
export type MatrixChoice = "auto" | "bt601" | "bt709";

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
  /** Extra space between characters, px at 1080 lines (older projects: absent = 0). */
  tracking?: number;
  /** 100..900; 0 or absent = from `bold`. */
  weight?: number;
  case?: TextCase;
  /** Second fill colour of a linear gradient. */
  gradient?: Rgb | null;
  gradientAngle?: number;
  shadowColor?: Rgb;
  shadowOpacity?: number;
  /** Offset in px at 1080 lines; absent = straight down by 0.4 × blur. */
  shadowOffset?: [number, number] | null;
  glow?: number;
  glowColor?: Rgb;
}

export type TextCase = "asTyped" | "upper" | "lower";
export type AnimUnit = "char" | "word" | "line";
export type AnimKind = "none" | "fade" | "slideUp" | "slideDown" | "slideLeft" | "slideRight" | "scale" | "typewriter" | "spread";
export interface AnimPhase {
  kind: AnimKind;
  frames: number;
  stagger: number;
  ease: Ease;
}
export interface TextAnimation {
  unit: AnimUnit;
  intro: AnimPhase;
  outro: AnimPhase;
}

export interface TitleSpec {
  text: string;
  style: TextStyle;
  /** Anchor of the text block, 0..1 of the frame: x is its left edge, centre or right edge by the alignment. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Per character/word/line animation (absent = static). */
  animation?: TextAnimation;
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
  /** A smart bin holds nothing itself; it shows every medium matching its rules. */
  smart?: SmartRules;
}

export type SmartKind = "video" | "audio" | "image" | "title";
export type SmartUsage = "any" | "used" | "unused";

/** Rules of a smart bin (kerf_core::model::SmartRules); a medium must meet all. */
export interface SmartRules {
  /** Any of these kinds; empty = all. */
  kinds: SmartKind[];
  /** Text in name, note or a tag; empty = any. */
  text: string;
  /** Tags the medium must all have. */
  tags: string[];
  /** Any of these labels; empty = any. */
  labels: LabelColor[];
  favorites: boolean;
  usage: SmartUsage;
  missing: boolean;
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
  /** Plays the source range backwards. */
  reverse?: boolean;
  /** Multicam group whose angles the clip can switch between. */
  multicam?: Uuid | null;
  /** Skips the whole effect stack without changing it. */
  fxBypass?: boolean;
  blendMode?: BlendMode;
  /** Audio clips: noise reduction of the source sound. */
  denoise?: Denoise | null;
}

/** Noise reduction with FFmpeg afftdn (kerf-core Denoise), rendered into the cache. */
export interface Denoise {
  enabled: boolean;
  /** How far the noise is lowered, dB (0.01..97). */
  reductionDb: number;
  /** Level of the noise, dB (-80..-20). */
  floorDb: number;
  /** Follow a changing noise level. */
  track: boolean;
  /** Learned noise shape: 15 band levels in dB; absent = white noise. */
  profile?: number[];
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
export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "add" | "lighten" | "darken" | "difference";

export type TransitionKind =
  | "dissolve"
  | "dipBlack"
  | "dipWhite"
  | "wipeLeft"
  | "wipeRight"
  | "wipeUp"
  | "wipeDown"
  | "crossfade"
  | "irisRound"
  | "irisBox"
  | "clock"
  | "barnDoorH"
  | "barnDoorV"
  | "wipeDiagonal"
  | "blinds"
  | "pushLeft"
  | "pushRight"
  | "pushUp"
  | "pushDown"
  | "slideLeft"
  | "slideRight"
  | "slideUp"
  | "slideDown";
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
  | { type: "curves"; master: CurvePoint[]; red: CurvePoint[]; green: CurvePoint[]; blue: CurvePoint[] }
  | { type: "fx"; fx: string; params: Record<string, number> }
  /** Freeform mask: polygon in 0..1 of the clip's frame, moved by x, y (fractions of the frame). */
  | { type: "polygonMask"; points: [number, number][]; feather: number; invert: boolean; x: number; y: number };
export type Effect = {
  id: Uuid;
  enabled: boolean;
  name?: string;
  /** Animated parameters by key (kerf_core EffectKind::animatable), on source positions like the clip's keys. */
  keys?: Record<string, Keyframe[]>;
} & EffectKind;

export type ColorParam = "exposure" | "contrast" | "saturation" | "temperature" | "tint";
export type KeyParam = "x" | "y" | "scale" | "rotation" | "opacity" | "volume" | "speed" | ColorParam;
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
  /** Free category, e.g. "scene", "beat" (empty: none). */
  category?: string;
  /** Length in frames for range markers (0: a point). */
  duration?: Frame;
  /** Written as a chapter into exports that support chapters. */
  chapter?: boolean;
}

export interface NewMarker {
  frame: Frame;
  name: string;
  note?: string;
  color: MarkerColor;
  category?: string;
  duration?: Frame;
  chapter?: boolean;
}

export type BatchLabel = "sceneCuts" | "removeSilence" | "ducking" | "analysisMarkers" | "relinkMedia" | "mediaTags";

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

/** A camera angle of a multicam group. */
export interface Angle {
  media: Uuid;
  name: string;
  /** Where the media starts on the group's clock, seconds (the earliest is 0). */
  offset: number;
}

export interface Multicam {
  id: Uuid;
  name: string;
  angles: Angle[];
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
  multicams?: Multicam[];
  watchFolders?: WatchFolder[];
}

/** A folder whose new media files are imported while the project is open (kerf_core::model::WatchFolder). */
export interface WatchFolder {
  id: Uuid;
  path: string;
  /** Bin the files go into; null = project root. */
  bin: Uuid | null;
  subfolders: boolean;
}

/** Most watch folders a project keeps (kerf_core MAX_WATCH_FOLDERS). */
export const MAX_WATCH_FOLDERS = 16;

/** A media file in a watch folder (watch_scan). */
export interface WatchedFile {
  path: string;
  size: number;
  /** Last change, ms since the epoch (0 if unknown). */
  modified: number;
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
  multicams?: Multicam[] | null;
  watchFolders?: WatchFolder[] | null;
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
  Pick<Clip, "name" | "enabled" | "transform" | "opacity" | "volumeDb" | "pan" | "speed" | "fadeIn" | "fadeOut" | "color" | "label" | "channels" | "reverse" | "fxBypass" | "blendMode" | "denoise">
>;
export type TrackPatch = Partial<Pick<Track, "name" | "muted" | "solo" | "locked" | "hidden" | "volumeDb" | "color" | "height" | "effects" | "mono">>;
export type MediaPatch = Partial<Pick<MediaAsset, "favorite" | "label" | "tags" | "note" | "matrix">>;

export interface PasteItem {
  clip: Clip;
  track: Uuid;
  kind: TrackKind;
  /** Frame rate of the sequence the clip was copied from. */
  rate?: Rational;
}

/** Every document mutation. Serialised with serde's `tag = "type"`. */
export type EditCommand =
  | { type: "removeMedia"; media: Uuid[] }
  | { type: "renameMedia"; media: Uuid; name: string }
  | { type: "setMediaFavorite"; media: Uuid[]; favorite: boolean }
  | { type: "updateMedia"; media: Uuid[]; patch: MediaPatch }
  | { type: "setSourceMarks"; media: Uuid; marks: SourceMarks }
  | { type: "setEffects"; sequence: Uuid; clips: Uuid[]; effects: Effect[] }
  | { type: "addEffects"; sequence: Uuid; clips: Uuid[]; effects: Effect[] }
  | { type: "setTransitions"; sequence: Uuid; items: { clip: Uuid; transition: Transition | null }[] }
  | { type: "setAudioEffects"; sequence: Uuid; items: { clip: Uuid; effects: AudioEffect[] }[] }
  | { type: "moveMediaToBin"; media: Uuid[]; bin: Uuid | null }
  | { type: "relinkMedia"; media: Uuid; path: string }
  | { type: "createBin"; name: string; parent: Uuid | null; smart?: SmartRules }
  | { type: "setSmartRules"; bin: Uuid; rules: SmartRules }
  | { type: "renameBin"; bin: Uuid; name: string }
  | { type: "removeBin"; bin: Uuid }
  | { type: "addWatchFolder"; path: string; bin: Uuid | null; subfolders: boolean }
  | { type: "removeWatchFolder"; id: Uuid }
  | { type: "addSequence"; name: string; settings: SequenceSettings }
  | { type: "removeSequence"; sequence: Uuid }
  | { type: "renameSequence"; sequence: Uuid; name: string }
  | { type: "nestClips"; sequence: Uuid; clips: Uuid[]; name: string }
  | { type: "unnestClip"; sequence: Uuid; clip: Uuid }
  | { type: "createMulticam"; multicam: Multicam }
  | { type: "placeMulticam"; sequence: Uuid; multicam: Uuid; at: Frame; mode: PlaceMode; videoAngle: number; audioAngle: number | null; videoTrack: Uuid | null; audioTrack: Uuid | null }
  | { type: "switchAngle"; sequence: Uuid; clip: Uuid; angle: number; at: Frame | null }
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
  | { type: "updateMarker"; sequence: Uuid; marker: Uuid; patch: Partial<Pick<Marker, "frame" | "name" | "note" | "color" | "category" | "duration" | "chapter">> }
  | { type: "removeMarker"; sequence: Uuid; marker: Uuid }
  | { type: "addMarkers"; sequence: Uuid; markers: NewMarker[] }
  | { type: "removeMarkers"; sequence: Uuid; markers: Uuid[] }
  | { type: "batch"; label: BatchLabel; commands: EditCommand[] }
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
  /** Animated titles: one PNG per source frame, by clip id (see engine/text.ts titleSequences). */
  titleSequences?: Record<Uuid, string[]>;
  /** Normalise the mix to this loudness (two passes). */
  loudness?: LoudnessTarget | null;
  /** Encode the picture in parts side by side, joined without re-encoding. */
  segmented?: boolean;
  /** Write the sequence's chapter markers into the file. */
  chapters?: boolean;
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
  /** Nested sequences are rendered before the export itself. */
  nested: boolean;
  /** Denoised sound is rendered into the cache before the export itself. */
  denoising?: boolean;
  /** Parts of a segmented export encoding at the same time (0 = in one piece). */
  parallel: number;
  /** The parts of a segmented export are being joined. */
  joining: boolean;
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
  /** The installed FFmpeg is older than `ffmpegMin`; exports fail with it. */
  ffmpegTooOld: boolean;
  ffmpegMin: number;
  hwEncoders: string[] | null;
  cacheDir: string;
  build: string;
  debug: boolean;
  logDir: string | null;
  dataDir: string | null;
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

// --- local library (kerf-library) ---------------------------------------------------

export type PresetKind = "effects" | "transition" | "textStyle" | "titleTemplate";
export type ItemKind = "effect" | "preset" | "transition" | "font" | "template" | "asset";

export interface Preset {
  /** Empty for a new preset. */
  id: string;
  kind: PresetKind;
  name: string;
  category: string;
  favorite: boolean;
  /** "effects": Effect[]; "transition": Transition; "textStyle": TextStyle; "titleTemplate": TitleSpec. */
  data: unknown;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** A font face found on the system or imported into Kerf (kerf_library::fonts::FontFace). */
export interface FontFaceInfo {
  family: string;
  style: string;
  fullName: string;
  weight: number;
  italic: boolean;
  variable: boolean;
  axes: { tag: string; min: number; default: number; max: number }[];
  path: string;
  index: number;
  source: "system" | "imported" | "bundled";
  /** OS/2 embedding permission as stated in the file ("" = not stated). */
  embedding: "" | "installable" | "restricted" | "previewAndPrint" | "editable";
  license: string;
  licenseUrl: string;
  designer: string;
  vendorUrl: string;
}

// --- media providers and the asset library (kerf-assets, kerf-library::assets) -------

export type ProviderId = "pexels" | "giphy" | "freesound" | "openverse";
export type SearchKind = "photo" | "video" | "gif" | "audio";
/** "yes" only when the provider's license explicitly allows it. */
export type Commercial = "yes" | "no" | "unknown";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  kinds: SearchKind[];
  needsKey: boolean;
  /** Where the key is kept: OS credential store, this session only, or none. */
  keyStorage: "system" | "session" | "";
  keyUrl: string;
}

export interface RemoteFile {
  url: string;
  label: string;
  width: number;
  height: number;
  mime: string;
  size: number;
}

export interface AssetLicense {
  code: string;
  name: string;
  url: string;
  commercial: Commercial;
  modification: Commercial;
  attributionRequired: boolean;
  attribution: string;
  notes: string;
}

export interface RemoteAsset {
  provider: ProviderId;
  providerId: string;
  kind: string;
  title: string;
  creator: string;
  creatorUrl: string;
  pageUrl: string;
  thumbUrl: string;
  width: number;
  height: number;
  durationMs: number;
  tags: string[];
  files: RemoteFile[];
  license: AssetLicense;
  rating: string;
}

export interface SearchPage {
  results: RemoteAsset[];
  page: number;
  hasMore: boolean;
  total: number | null;
  notice: string;
}

export interface SearchRequest {
  provider: ProviderId;
  kind: SearchKind;
  query: string;
  page: number;
  commercialOnly: boolean;
}

export interface AssetRecord {
  id: string;
  provider: string;
  providerId: string;
  kind: string;
  title: string;
  creator: string;
  creatorUrl: string;
  pageUrl: string;
  licenseCode: string;
  licenseName: string;
  licenseUrl: string;
  commercial: Commercial;
  attributionRequired: boolean;
  attribution: string;
  filePath: string;
  sha256: string;
  size: number;
  mime: string;
  width: number;
  height: number;
  durationMs: number;
  tags: string[];
  favorite: boolean;
  addedAt: number;
  missing: boolean;
}

export interface AssetQuery {
  kind?: string | null;
  provider?: string | null;
  text?: string | null;
  favorites?: boolean;
  commercialOnly?: boolean;
  collection?: string | null;
  limit?: number | null;
}

export interface DownloadJob {
  id: string;
  provider: string;
  providerId: string;
  title: string;
  kind: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  done: number;
  total: number | null;
  error: string | null;
  asset: AssetRecord | null;
  existing: boolean;
}

export interface LicenseEntry {
  file: string;
  asset: AssetRecord | null;
}

export type ReportFormat = "txt" | "csv" | "html" | "json";

// --- editing assistants --------------------------------------------------------

export type AnalysisTarget = { type: "media"; media: Uuid } | { type: "clip"; sequence: Uuid; clip: Uuid };

export interface SceneOptions { threshold: number; gradual: boolean; minScene: number; ignoreFlashes: boolean }
export interface SilenceOptions { thresholdDb: number; relative: boolean; minSilence: number; padAfter: number; padBefore: number; ignoreBursts: number }
export interface BeatOptions { minBpm: number; maxBpm: number; preferBpm: number; peakThreshold: number; beatsPerBar: number }
export interface HighlightOptions { window: number; count: number; motion: number; loudness: number; cuts: number }
export interface DuckOptions { depthDb: number; attack: number; hold: number; release: number }

export type AnalysisRequest =
  | { type: "scenes"; options: SceneOptions }
  | { type: "silence"; options: SilenceOptions }
  | { type: "beats"; options: BeatOptions }
  | { type: "highlights"; options: HighlightOptions; scenes: SceneOptions };

export interface SceneCut { time: number; kind: "hard" | "gradual"; from: number; to: number; score: number; lumaChange: number }
export interface Silence { start: number; end: number; cutStart: number; cutEnd: number }
export interface SilenceReport { noiseFloorDb: number; thresholdDb: number; silences: Silence[] }
export interface Beat { time: number; strength: number; beatInBar: number | null }
export interface BeatReport { bpm: number | null; tempoConfidence: number; beats: Beat[]; peaks: [number, number][]; bars: boolean }
export interface Highlight { start: number; end: number; score: number; reasons: ("motion" | "loudness" | "cuts")[] }

export interface AnalysisResult {
  sourceStart: number;
  sourceEnd: number;
  scenes: SceneCut[] | null;
  silence: SilenceReport | null;
  beats: BeatReport | null;
  highlights: Highlight[] | null;
  sceneFrames: (Frame | null)[];
  beatFrames: (Frame | null)[];
  peakFrames: (Frame | null)[];
  silenceRanges: ([Frame, Frame] | null)[];
  highlightRanges: ([Frame, Frame] | null)[];
}

export interface AnalysisProgress { job: Uuid; done: number; total: number }

export interface DuckPlan {
  speech: [number, number][];
  curve: [number, number][];
  clips: { clip: Uuid; name: string; keys: Keyframe[]; replacesKeys: boolean }[];
  skipped: string[];
  unreadable: string[];
}

// --- project management ---------------------------------------------------------

export interface ArchiveOptions { includeUnused: boolean }
export interface ArchivePlan { files: { source: string; target: string; bytes: number }[]; missing: string[]; fonts: string[]; totalBytes: number; unused: number }
export interface ArchiveReport { projectFile: string; copied: number; bytes: number; missing: string[]; fonts: string[]; verified: boolean }
export interface ArchiveProgress { job: Uuid; done: number; total: number }

export type MatchKind = "nameAndSize" | "name" | "stem";
export interface RelinkCandidate { path: string; kind: MatchKind; size: number; sameDuration: boolean | null }
export interface RelinkSuggestion { media: Uuid; name: string; oldPath: string; candidates: RelinkCandidate[] }
export interface RelinkSearch { suggestions: RelinkSuggestion[]; scanned: number; truncated: boolean }

export type CacheKind = "proxies" | "thumbnails" | "waveforms" | "other";
export interface CacheInfo { root: string; kinds: { kind: CacheKind; bytes: number; files: number; unusedBytes: number }[]; totalBytes: number; freeBytes: number | null }
