// Playback engine.
//
// The timeline is evaluated every animation frame against the AudioContext
// clock. Each visible clip gets a pooled media element that is kept in sync
// with the clock (hard re-seek on large drift, gentle rate nudging on small
// drift). Paused, every move of the playhead becomes a coalesced, frame-
// accurate seek; the composite is redrawn when the decoder delivers the frame.
//
// A clip showing another sequence (nested sequence) is evaluated in a scope
// of its own: the inner sequence at the frame the clip shows, with its own
// frame rate and the clip's speed. Its pictures are composited as a group
// layer, its sound runs through buses of its own into the clip's volume,
// pan and effects. Inside a reversed clip pictures are stepped by seeking
// and the sound is silent (the export renders it properly).

import { fpsOf } from "../lib/time";
import { api } from "../lib/ipc";
import { animate, isWarped, sourceAt, speedAt } from "../lib/keys";
import { fileUrl, previewSource } from "../lib/media";
import type { Clip, ClipPatch, MediaAsset, Sequence, Subtitles, TitleSpec, Track, TrackKind, Uuid } from "../lib/types";
import { AudioMixer, effectsMessage } from "./audio";
import { transitionInto, type TransitionSpan } from "../timeline/geometry";
import { Compositor, type DrawItem, type Layer, type LayerSource } from "./compositor";
import { activeEffects } from "./effects";
import { dbToGain, IDENTITY_COLOR, IDENTITY_TRANSFORM, place, quadMatrix } from "./math";
import { cueAt, cueCanvas, setFontListener, titleCanvas } from "./text";

const PREROLL_S = 1.2;
const RELEASE_S = 6;
const HARD_RESYNC_S = 0.12;
const SOFT_DRIFT_S = 0.02;
/** Deepest nesting evaluated (sequences cannot contain themselves; this guards damaged files). */
const MAX_DEPTH = 8;

interface Voice {
  key: string;
  clipId: Uuid;
  src: string;
  el: HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
  seeking: boolean;
  pending: number | null;
  lastUsed: number;
  /** Plays the media's reversed sound (reversed audio clip): source time s is at duration - s. */
  reversed?: boolean;
  /** Seconds a seek during playback takes (smoothed), and when the running one started. */
  lag?: number;
  seekStart?: number;
  // audio only
  source?: MediaElementAudioSourceNode;
  /** Clip effects and channel map, between the source and the gain. */
  fx?: AudioWorkletNode;
  fxSent?: string;
  gain?: GainNode;
  pan?: StereoPannerNode;
  track?: Uuid;
}

/** Sound of a nested clip: its sequence's buses meet at `source`. */
interface NestVoice {
  key: string;
  source: GainNode;
  fx?: AudioWorkletNode;
  fxSent?: string;
  gain: GainNode;
  pan: StereoPannerNode;
  track?: string;
  lastUsed: number;
}

/** A sequence being evaluated: the edited one, or one nested in a clip. */
interface Scope {
  seq: Sequence;
  fps: number;
  /** Frame of `seq` (fractional while playing). */
  frame: number;
  /** Real-time speed of its frames; 0 when paused (frames are sought). */
  rate: number;
  /** Prefix of voice and bus keys: the nested clips on the way here. */
  path: string;
  depth: number;
  /** Inside a reversed clip: pictures run backwards, sound is silent. */
  backwards: boolean;
  /** Where the track buses go (null = the master). */
  out: AudioNode | null;
  /** Only tracks of this kind (a nested clip shows its sequence's pictures or sound). */
  kind: TrackKind | null;
  /** Canvas pixels per sequence pixel. */
  px: number;
}

type Listener = () => void;

export interface EngineOptions {
  useProxies: boolean;
  /** Preview resolution scale (1, 0.5, 0.25). */
  quality: number;
}

/** Index of the clip at `frame` on `track` (clips are sorted and non-overlapping), or -1. */
function clipIndexAt(track: Track, frame: number): number {
  const clips = track.clips;
  let lo = 0;
  let hi = clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = clips[mid];
    if (frame < c.start) hi = mid - 1;
    else if (frame >= c.start + c.duration) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Clip at `frame` on `track`. */
export function clipAt(track: Track, frame: number): Clip | null {
  return track.clips[clipIndexAt(track, frame)] ?? null;
}

/** The transition playing at `frame` on `track`: its clips and progress. */
export function transitionAt(track: Track, frame: number): { a: Clip; b: Clip; span: TransitionSpan; p: number } | null {
  const i = clipIndexAt(track, frame);
  if (i < 0) return null;
  // Into the clip at the frame, or out of it into the next one.
  for (const j of [i, i + 1]) {
    const s = j < track.clips.length ? transitionInto(track, j) : null;
    if (s && frame >= s.t0 && frame < s.t1) return { a: track.clips[j - 1], b: track.clips[j], span: s, p: (frame - s.t0) / (s.t1 - s.t0) };
  }
  return null;
}

/** Next clip after `frame` and the frame it starts playing (earlier with a transition into it). */
function nextClipAfter(track: Track, frame: number): { clip: Clip; from: number } | null {
  const i = track.clips.findIndex((c) => c.start > frame);
  if (i < 0) return null;
  return { clip: track.clips[i], from: transitionInto(track, i)?.t0 ?? track.clips[i].start };
}

/** Fade envelope 0..1 at timeline `frame`. */
export function fadeGain(c: Clip, frame: number): number {
  const into = frame - c.start;
  const left = c.start + c.duration - frame;
  let g = 1;
  if (c.fadeIn > 0 && into < c.fadeIn) g *= Math.max(0, into / c.fadeIn);
  if (c.fadeOut > 0 && left < c.fadeOut) g *= Math.max(0, left / c.fadeOut);
  return g;
}

export class PlaybackEngine {
  frame = 0;
  playing = false;
  rate = 1;
  loop = false;
  readonly mixer = new AudioMixer();

  constructor() {
    this.mixer.onEffectsReady = () => this.requestRender();
  }

  private seq: Sequence | null = null;
  private media = new Map<Uuid, MediaAsset>();
  /** All sequences of the project (nested clips show them). */
  private sequences = new Map<Uuid, Sequence>();
  private nests = new Map<string, NestVoice>();
  private opts: EngineOptions = { useProxies: false, quality: 1 };
  private overrides = new Map<Uuid, Partial<Clip>>();
  /** Reversed sound per media: URL, null while it is made, "" when it cannot be. */
  private reversedSound = new Map<Uuid, string | null>();
  /** Live track changes (mixer fader, track effects) until the edit is committed. */
  private trackOverrides = new Map<Uuid, Partial<Track>>();
  /** Live title and subtitle-style edits (inspector), keyed by media id. */
  private titleOverrides = new Map<Uuid, TitleSpec>();
  private subtitleOverride: Subtitles | null = null;
  private voices = new Map<string, Voice>();
  private compositor: Compositor | null = null;
  private listeners = new Set<Listener>();
  private frameListeners = new Set<(canvas: HTMLCanvasElement) => void>();
  private raf = 0;
  private renderQueued = false;
  private startFrame = 0;
  private startClock = 0;
  private range: [number, number] | null = null;
  private lastLayers: DrawItem[] = [];
  /** Frame shown instead of the playhead (trim preview), or null. */
  private previewFrame: number | null = null;
  scopesEnabled = false;
  scopesListener: ((px: Uint8Array) => void) | null = null;
  private lastScope = 0;
  /** Media currently waiting for a proxy (shown as placeholder). */
  pendingMedia = new Set<Uuid>();
  private stat = { shown: null as number | null, times: [] as number[], skipped: 0, decoder: 0, polled: 0, base: new WeakMap<HTMLVideoElement, number>() };

  // --- wiring -----------------------------------------------------------------

  attach(canvas: HTMLCanvasElement) {
    setFontListener(() => this.requestRender());
    this.compositor?.dispose();
    try {
      this.compositor = new Compositor(canvas, () => this.requestRender());
    } catch (e) {
      console.error(e);
      this.compositor = null;
    }
    this.requestRender();
  }

  detach(canvas: HTMLCanvasElement) {
    if (this.compositor?.canvas === canvas) {
      this.compositor.dispose();
      this.compositor = null;
    }
  }

  get canvas() {
    return this.compositor?.canvas ?? null;
  }

  /** Calls `f` with the program canvas right after each frame is drawn (to copy it elsewhere). */
  onFrame(f: (canvas: HTMLCanvasElement) => void): () => void {
    this.frameListeners.add(f);
    this.requestRender();
    return () => this.frameListeners.delete(f);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  update(seq: Sequence | null, media: Map<Uuid, MediaAsset>, opts: EngineOptions, sequences: Sequence[] = seq ? [seq] : []) {
    const seqChanged = seq?.id !== this.seq?.id;
    this.seq = seq;
    this.media = media;
    this.sequences = new Map(sequences.map((s) => [s.id, s]));
    this.opts = opts;
    if (seqChanged) {
      this.pause();
      this.frame = 0;
      this.releaseAll();
    }
    // Drop overrides once the engine confirmed the edit.
    this.requestRender();
    this.emit();
  }

  get sequence() {
    return this.seq;
  }

  get fps() {
    return this.seq ? fpsOf(this.seq.settings.fps) : 25;
  }

  get duration() {
    return this.seq ? sequenceDuration(this.seq) : 0;
  }

  /** Before/after: shows every clip without its effects while true (preview only). */
  compareBypass = false;

  setCompareBypass(on: boolean) {
    this.compareBypass = on;
    this.requestRender();
  }

  /** Live, uncommitted property changes (inspector drags, monitor handles). */
  setOverride(clip: Uuid, patch: Partial<Clip> | ClipPatch | null) {
    if (patch) this.overrides.set(clip, { ...this.overrides.get(clip), ...patch });
    else this.overrides.delete(clip);
    this.requestRender();
  }

  /** Live, uncommitted track changes (null = stored). */
  setTrackOverride(track: Uuid, patch: Partial<Track> | null) {
    if (patch) this.trackOverrides.set(track, { ...this.trackOverrides.get(track), ...patch });
    else this.trackOverrides.delete(track);
    this.requestRender();
  }

  /** Shows `spec` instead of the stored title of `media` (null = stored). */
  setTitleOverride(media: Uuid, spec: TitleSpec | null) {
    if (spec) this.titleOverrides.set(media, spec);
    else this.titleOverrides.delete(media);
    this.requestRender();
  }

  /** Shows `subs` instead of the sequence's subtitle look (null = stored). */
  setSubtitleOverride(subs: Subtitles | null) {
    this.subtitleOverride = subs;
    this.requestRender();
  }

  clearOverrides() {
    if (this.overrides.size) {
      this.overrides.clear();
      this.requestRender();
    }
  }

  effectiveClip(c: Clip): Clip {
    const o = this.overrides.get(c.id);
    return o ? { ...c, ...o } : c;
  }

  setPreviewFrame(frame: number | null) {
    this.previewFrame = frame;
    this.requestRender();
  }

  // --- transport ----------------------------------------------------------------

  async play(rate = 1, range: [number, number] | null = null) {
    if (!this.seq) return;
    await this.mixer.resume().catch(() => undefined);
    this.range = range;
    const end = range ? range[1] : this.duration;
    const start = range ? range[0] : 0;
    if (rate > 0 && this.frame >= end - 1) this.frame = start;
    if (range && (this.frame < range[0] || this.frame >= range[1])) this.frame = range[0];
    this.rate = rate;
    this.startFrame = this.frame;
    this.startClock = this.mixer.now();
    this.stat.shown = null;
    if (!this.playing) {
      this.stat = { shown: null, times: [], skipped: 0, decoder: 0, polled: 0, base: new WeakMap() };
      this.playing = true;
      this.raf = requestAnimationFrame(this.tick);
    }
    this.syncAll(true);
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const v of this.voices.values()) if ("pause" in v.el) v.el.pause();
    this.frame = Math.round(this.frame);
    this.range = null;
    this.requestRender();
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else void this.play(1);
  }

  seek(frame: number) {
    const f = Math.max(0, Math.round(frame));
    this.frame = f;
    if (this.playing) {
      this.startFrame = f;
      this.startClock = this.mixer.now();
      this.stat.shown = null;
      this.syncAll(true);
    } else {
      this.requestRender();
    }
    this.emit();
  }

  step(frames: number) {
    this.pause();
    this.seek(this.frame + frames);
  }

  // --- loop -------------------------------------------------------------------------

  private tick = () => {
    if (!this.playing) return;
    const now = this.mixer.now();
    let f = this.startFrame + (now - this.startClock) * this.fps * this.rate;
    const [lo, hi] = this.range ?? [0, this.duration];
    if (f >= hi) {
      if (this.loop || this.range) {
        f = lo;
        this.startFrame = lo;
        this.startClock = now;
        this.stat.shown = null;
        this.syncAll(true);
      } else {
        this.frame = Math.max(0, hi - 1);
        this.pause();
        return;
      }
    }
    if (f < 0) {
      this.frame = 0;
      this.pause();
      return;
    }
    this.frame = f;
    this.syncAll(false);
    this.draw();
    this.countFrame(f);
    this.emit();
    this.raf = requestAnimationFrame(this.tick);
  };

  // --- statistics -------------------------------------------------------------------

  /**
   * Counts sequence frames that reached the screen. At normal speed every
   * frame should be drawn; a jump of more than one is a dropped frame.
   */
  private countFrame(f: number) {
    const st = this.stat;
    const shown = Math.floor(f);
    if (shown === st.shown) return;
    if (st.shown !== null && this.rate === 1 && shown > st.shown + 1) st.skipped += shown - st.shown - 1;
    st.shown = shown;
    const now = performance.now();
    st.times.push(now);
    while (now - st.times[0] > 1000) st.times.shift();
    // Frames the video decoders gave up on, polled a few times a second.
    if (now - st.polled > 250) {
      st.polled = now;
      for (const v of this.voices.values()) {
        if (!(v.el instanceof HTMLVideoElement) || v.el.paused) continue;
        const n = v.el.getVideoPlaybackQuality().droppedVideoFrames;
        st.decoder += n - (st.base.get(v.el) ?? n);
        st.base.set(v.el, n);
      }
    }
  }

  /** Frame rate reached and frames dropped in the current (or last) playback. */
  stats(): PlaybackStats {
    const now = performance.now();
    const fps = this.playing ? this.stat.times.filter((t) => now - t <= 1000).length : 0;
    return { fps, target: this.fps * Math.abs(this.rate), skipped: this.stat.skipped, decoder: this.stat.decoder };
  }

  requestRender() {
    if (this.playing || this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.playing) {
        this.syncAll(false);
        this.draw();
      }
    });
  }

  // --- voices -----------------------------------------------------------------------

  private sourceTime(c: Clip, frame: number, fps: number): number {
    return sourceAt(c, frame - c.start) / fps;
  }

  /** The edited sequence as a scope at the playhead. */
  private rootScope(): Scope | null {
    const seq = this.seq;
    if (!seq) return null;
    const px = this.compositor ? this.compositor.canvas.width / seq.settings.width : 1;
    return { seq, fps: this.fps, frame: this.previewFrame ?? this.frame, rate: this.playing ? this.rate : 0, path: "", depth: 0, backwards: false, out: null, kind: null, px };
  }

  /** The sequence clip `c` shows, if it is a nested clip. */
  private nestedOf(c: Clip, s: Scope): Sequence | null {
    return s.depth < MAX_DEPTH ? (this.sequences.get(c.mediaId) ?? null) : null;
  }

  /** Scope of nested clip `c` of `s`: its sequence at the frame the clip shows. */
  private innerScope(s: Scope, c: Clip, seq: Sequence, kind: TrackKind, out: AudioNode | null): Scope {
    const fps = fpsOf(seq.settings.fps);
    const local = s.frame - c.start;
    const x = (sourceAt(c, local) / s.fps) * fps;
    // Paused: the whole frame shown (the one below when reversed, as the export).
    const frame = s.rate !== 0 ? (c.reverse ? x - 1e-3 : x) : c.reverse ? Math.ceil(x - 1e-6) - 1 : Math.floor(x + 1e-6);
    return {
      seq,
      fps,
      frame,
      rate: s.rate * speedAt(c, local),
      path: `${s.path}${c.id}/`,
      depth: s.depth + 1,
      backwards: s.backwards !== !!c.reverse,
      out,
      kind,
      px: s.px,
    };
  }

  private nestVoice(key: string): NestVoice {
    let n = this.nests.get(key);
    if (!n) {
      const ctx = this.mixer.context();
      const source = ctx.createGain();
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      source.connect(gain).connect(pan);
      n = { key, source, gain, pan, lastUsed: 0 };
      this.nests.set(key, n);
    }
    n.lastUsed = performance.now();
    return n;
  }

  /** URL of the media's reversed sound, requested on first use (null until ready). */
  private reversedUrl(media: Uuid): string | null {
    const known = this.reversedSound.get(media);
    if (known !== undefined) return known || null;
    this.reversedSound.set(media, null);
    api
      .reversedAudio(media)
      .then((path) => this.reversedSound.set(media, fileUrl(path)))
      .catch((e) => {
        console.warn("reversed audio", e);
        this.reversedSound.set(media, "");
      })
      .finally(() => this.requestRender());
    return null;
  }

  private voice(clip: Clip, kind: "video" | "audio", path = ""): Voice | null {
    const asset = this.media.get(clip.mediaId);
    // Titles are drawn from their definition (layers()), not loaded.
    if (!asset || asset.status.state !== "ready" || asset.title) return null;
    // A reversed audio clip plays the reversed sound forwards; silent until it exists.
    const reversed = kind === "audio" && !!clip.reverse;
    const src = reversed ? this.reversedUrl(asset.id) : previewSource(asset, this.opts.useProxies);
    if (!src) {
      if (!reversed) this.pendingMedia.add(asset.id);
      return null;
    }
    this.pendingMedia.delete(asset.id);
    const key = `${kind}:${path}${clip.id}`;
    let v = this.voices.get(key);
    if (v && v.src !== src) {
      this.releaseVoice(v);
      v = undefined;
    }
    if (!v) {
      let el: Voice["el"];
      if (kind === "video" && asset.kind === "image") {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        img.onload = () => this.requestRender();
        img.src = src;
        el = img;
      } else {
        const m = kind === "video" ? document.createElement("video") : new Audio();
        m.crossOrigin = "anonymous";
        m.preload = "auto";
        m.muted = kind === "video";
        if (m instanceof HTMLVideoElement) m.playsInline = true;
        m.src = src;
        el = m;
      }
      v = { key, clipId: clip.id, src, el, seeking: false, pending: null, lastUsed: performance.now(), reversed };
      if (!(el instanceof HTMLImageElement)) {
        const voice = v;
        el.addEventListener("seeked", () => this.onSeeked(voice));
        el.addEventListener("loadeddata", () => this.requestRender());
        if (kind === "audio") {
          const ctx = this.mixer.context();
          v.source = ctx.createMediaElementSource(el);
          v.gain = ctx.createGain();
          // Mono media plays on both sides at full level, as in the export.
          v.gain.channelCount = 2;
          v.gain.channelCountMode = "explicit";
          v.gain.channelInterpretation = "speakers";
          v.pan = ctx.createStereoPanner();
          v.source.connect(v.gain).connect(v.pan);
        }
      }
      this.voices.set(key, v);
    }
    v.lastUsed = performance.now();
    return v;
  }

  private onSeeked(v: Voice) {
    v.seeking = false;
    const el = v.el as HTMLMediaElement;
    if (v.seekStart !== undefined) {
      const took = (performance.now() - v.seekStart) / 1000;
      v.lag = Math.min(0.6, (v.lag ?? took) * 0.5 + took * 0.5);
      v.seekStart = undefined;
    }
    if (v.pending !== null && Math.abs(v.pending - el.currentTime) > 0.004) {
      const t = v.pending;
      v.pending = null;
      this.seekVoice(v, t);
      return;
    }
    v.pending = null;
    this.requestRender();
  }

  private seekVoice(v: Voice, t: number) {
    const el = v.el as HTMLMediaElement;
    if (v.seeking) {
      v.pending = t;
      return;
    }
    if (Math.abs(el.currentTime - t) < 0.004) return;
    v.seeking = true;
    el.currentTime = t;
  }

  /** Time in the voice's media for frame `frame` (of scope `s`) of clip `c`. */
  private mediaTime(v: Voice, c: Clip, frame: number, s: Scope): number {
    const el = v.el as HTMLMediaElement;
    const at = this.sourceTime(c, frame, s.fps);
    if (v.reversed) return (el.duration > 0 ? el.duration : (this.media.get(c.mediaId)?.info?.duration ?? 0)) - at;
    // The frame under the clip's position, or just below it when reversed (as the export).
    if (isWarped(c)) return at + (c.reverse ? -0.001 : 0.001);
    // Aim inside the frame so rounding never shows the previous one.
    return at + (s.rate !== 0 ? 0 : 0.35 / s.fps);
  }

  private syncVoice(v: Voice, c: Clip, frame: number, hard: boolean, audible: boolean, s: Scope) {
    if (v.el instanceof HTMLImageElement) return;
    const el = v.el;
    const local = frame - c.start;
    const want = this.mediaTime(v, c, frame, s);
    // Outside the media (transition handles) the first or last frame holds.
    const last = el.duration > 0 ? el.duration - 0.001 : Infinity;
    const t = Math.min(Math.max(0, want), last);
    const rate = s.rate * speedAt(c, local);
    // Reversed pictures are stepped by seeking; their sound plays the reversed file.
    const backwards = s.backwards !== !!c.reverse && !v.reversed;
    const canPlay = s.rate !== 0 && !backwards && rate > 0 && rate <= 8 && want >= 0 && want <= last;
    if (!canPlay) {
      if (!el.paused) el.pause();
      this.seekVoice(v, t);
      return;
    }
    if (el instanceof HTMLAudioElement) el.muted = !audible || rate > 4;
    const drift = el.currentTime - t;
    if (hard || el.paused || Math.abs(drift) > HARD_RESYNC_S) {
      if (!v.seeking) {
        // The element plays on (or starts) once the seek is done: aim that far ahead,
        // or it lags behind by the seek time and is sought again and again.
        el.currentTime = Math.min(last, t + (v.lag ?? 0.05) * rate);
        v.seekStart = performance.now();
        v.seeking = true;
      }
      el.playbackRate = rate;
      if (el.paused) void el.play().catch(() => undefined);
    } else if (Math.abs(drift) > SOFT_DRIFT_S) {
      el.playbackRate = rate * (1 - Math.max(-0.05, Math.min(0.05, drift * 1.5)));
    } else if (el.playbackRate !== rate) {
      el.playbackRate = rate;
    }
  }

  /** Prepares an upcoming clip so the cut plays without a decode gap. */
  private preroll(v: Voice, c: Clip, from: number, s: Scope) {
    if (v.el instanceof HTMLImageElement) return;
    const el = v.el;
    if (!el.paused) el.pause();
    this.seekVoice(v, Math.max(0, this.mediaTime(v, c, from, s)));
  }

  /** Prerolls the clips a nested sequence starts with. */
  private prerollScope(s: Scope, used: Set<string>) {
    for (const track of s.seq.tracks) {
      if ((s.kind && track.kind !== s.kind) || (track.kind === "video" && track.hidden)) continue;
      const raw = clipAt(track, s.frame);
      if (!raw?.enabled) continue;
      const c = this.effectiveClip(raw);
      const inner = this.nestedOf(c, s);
      if (inner) {
        this.prerollScope(this.innerScope(s, c, inner, track.kind, null), used);
        continue;
      }
      const v = this.voice(c, track.kind, s.path);
      if (v && !used.has(v.key)) {
        used.add(v.key);
        this.preroll(v, c, s.frame, s);
      }
    }
  }

  /** Clips playing at `frame` on `track` with their mix weight (two in a transition). */
  private activeClips(track: Track, frame: number): { c: Clip; weight: number }[] {
    const tr = transitionAt(track, frame);
    if (tr) {
      return [
        { c: this.effectiveClip(tr.a), weight: 1 - tr.p },
        { c: this.effectiveClip(tr.b), weight: tr.p },
      ];
    }
    const raw = clipAt(track, frame);
    return raw ? [{ c: this.effectiveClip(raw), weight: 1 }] : [];
  }

  private syncAll(hard: boolean) {
    const root = this.rootScope();
    if (!root) return;
    const used = new Set<string>();
    this.syncScope(root, hard, used);
    // Pause idle voices; release ones not used for a while.
    const now = performance.now();
    for (const v of this.voices.values()) {
      if (used.has(v.key)) continue;
      if (!(v.el instanceof HTMLImageElement) && !v.el.paused) v.el.pause();
      if (now - v.lastUsed > RELEASE_S * 1000) this.releaseVoice(v);
    }
    for (const n of this.nests.values()) {
      if (used.has(n.key) || now - n.lastUsed <= RELEASE_S * 1000) continue;
      for (const node of [n.source, n.fx, n.gain, n.pan]) node?.disconnect();
      this.nests.delete(n.key);
    }
  }

  /** Volume, pan and effects of an audio clip (or nested clip), into its track's bus. */
  private syncGain(v: { gain: GainNode; pan: StereoPannerNode; track?: string; source?: AudioNode; fx?: AudioWorkletNode; fxSent?: string }, c: Clip, frame: number, weight: number, bus: string, s: Scope) {
    const ctx = this.mixer.context();
    // A crossfade weighs both clips linearly, like the export's afade.
    const g = dbToGain(animate(c, frame).volumeDb) * fadeGain(c, frame) * weight;
    v.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
    v.pan.pan.setTargetAtTime(c.pan, ctx.currentTime, 0.01);
    this.syncEffects(v, c);
    if (v.track !== bus) {
      v.pan.disconnect();
      v.pan.connect(this.mixer.bus(bus, s.out));
      v.track = bus;
    }
  }

  /** Syncs the voices of scope `s`, and of the sequences nested in it. */
  private syncScope(s: Scope, hard: boolean, used: Set<string>) {
    const { seq, frame } = s;
    const ahead = s.rate > 0 ? PREROLL_S * s.fps * s.rate : 0;
    const anySolo = seq.tracks.some((t) => t.kind === "audio" && t.solo);

    for (const track of seq.tracks) {
      const kind = track.kind;
      if (s.kind && kind !== s.kind) continue;
      if (kind === "video" && track.hidden) continue;
      const on = !track.muted && (!anySolo || track.solo);
      const audible = kind === "audio" && on && !s.backwards;
      const bus = s.path + track.id;
      for (const { c, weight } of this.activeClips(track, frame)) {
        if (!c.enabled) continue;
        const inner = this.nestedOf(c, s);
        if (inner) {
          let out: AudioNode | null = null;
          if (kind === "audio") {
            const n = this.nestVoice(`nest:${s.path}${c.id}`);
            used.add(n.key);
            this.syncGain(n, c, frame, weight, bus, s);
            out = n.source;
          }
          this.syncScope(this.innerScope(s, c, inner, kind, out), hard, used);
          continue;
        }
        const v = this.voice(c, kind, s.path);
        if (!v) continue;
        used.add(v.key);
        if (kind === "audio" && v.gain && v.pan) this.syncGain(v as Voice & { gain: GainNode; pan: StereoPannerNode }, c, frame, weight, bus, s);
        this.syncVoice(v, c, frame, hard, audible, s);
      }
      if (kind === "audio") {
        const t = { ...track, ...this.trackOverrides.get(track.id) };
        this.mixer.setBusGain(bus, on ? dbToGain(t.volumeDb) : 0, s.out);
        this.mixer.setBusEffects(bus, t.effects, !!t.mono, s.out);
      }
      if (ahead > 0) {
        const next = nextClipAfter(track, frame);
        if (next && next.clip.enabled && next.from > frame && next.from - frame < ahead) {
          const c = this.effectiveClip(next.clip);
          const inner = this.nestedOf(c, s);
          if (inner) {
            this.prerollScope(this.innerScope({ ...s, frame: next.from }, c, inner, kind, null), used);
            continue;
          }
          const v = this.voice(c, kind, s.path);
          if (v && !used.has(v.key)) {
            used.add(v.key);
            this.preroll(v, c, next.from, s);
          }
        }
      }
    }
  }

  /** Puts the clip's effects node in or out and sends it changed settings. */
  private syncEffects(v: { source?: AudioNode; gain?: GainNode; fx?: AudioWorkletNode; fxSent?: string }, c: Clip) {
    if (!v.source || !v.gain) return;
    const msg = effectsMessage(c.audioEffects, c.channels);
    const key = msg ? JSON.stringify(msg) : "";
    if (key === (v.fxSent ?? "")) return;
    if (msg && !v.fx) {
      const fx = this.mixer.effectsNode();
      if (!fx) return; // still loading; onEffectsReady syncs again
      v.source.disconnect();
      v.source.connect(fx).connect(v.gain);
      v.fx = fx;
    } else if (!msg && v.fx) {
      v.source.disconnect();
      v.fx.disconnect();
      v.fx = undefined;
      v.source.connect(v.gain);
    }
    if (msg) v.fx!.port.postMessage(msg);
    v.fxSent = key;
  }

  private releaseVoice(v: Voice) {
    this.voices.delete(v.key);
    this.compositor?.release(v.key);
    if (!(v.el instanceof HTMLImageElement)) {
      v.el.pause();
      v.el.removeAttribute("src");
      v.el.load();
    }
    v.fx?.disconnect();
    v.gain?.disconnect();
    v.pan?.disconnect();
  }

  private releaseAll() {
    for (const v of [...this.voices.values()]) this.releaseVoice(v);
    for (const n of this.nests.values()) for (const node of [n.source, n.fx, n.gain, n.pan]) node?.disconnect();
    this.nests.clear();
  }

  // --- compositing ----------------------------------------------------------------

  /** Layer of video clip `c` in scope `s`, null when it shows nothing. */
  private layerOf(c: Clip, s: Scope): Layer | null {
    if (!c.enabled) return null;
    const frame = s.frame;
    const { width: W, height: H } = s.seq.settings;
    const inner = this.nestedOf(c, s);
    let src: LayerSource | undefined;
    let group: Layer["group"];
    let key: string;
    let sw: number;
    let sh: number;
    if (inner) {
      // The nested sequence composited at the preview's pixel density (bounded).
      [sw, sh] = [inner.settings.width, inner.settings.height];
      const k = Math.min(s.px, 4096 / Math.max(sw, sh));
      group = { items: this.layersOf({ ...this.innerScope(s, c, inner, "video", null), px: k }), width: Math.max(1, Math.round(sw * k)), height: Math.max(1, Math.round(sh * k)) };
      key = `group:${s.path}${c.id}`;
    } else {
      const title = this.media.get(c.mediaId)?.title;
      const v = title ? undefined : this.voices.get(`video:${s.path}${c.id}`);
      src = title ? titleCanvas(this.titleOverrides.get(c.mediaId) ?? title) : (v?.el as LayerSource | undefined);
      if (!src) return null;
      [sw, sh] =
        src instanceof HTMLVideoElement ? [src.videoWidth, src.videoHeight] : src instanceof HTMLImageElement ? [src.naturalWidth, src.naturalHeight] : [src.width, src.height];
      if (!sw || !sh) return null;
      if (src instanceof HTMLVideoElement && src.readyState < 2) return null;
      key = v?.key ?? `title:${s.path}${c.id}`;
    }
    const a = animate(c, frame);
    const t = a.transform;
    const opacity = a.opacity * fadeGain(c, frame);
    if (t.scale <= 0 || opacity <= 0) return null;
    const p = place(t, sw, sh, W, H);
    const effects = activeEffects(c.effects, c.fxBypass || this.compareBypass);
    // Effects run at the fitted size (scale 1) in canvas pixels.
    const fxScale = s.px;
    return {
      key,
      source: src,
      group,
      matrix: quadMatrix(p, W, H),
      crop: [t.cropLeft, t.cropTop, t.cropRight, t.cropBottom],
      opacity,
      color: a.color,
      effects,
      work: t.scale > 0 ? [(p.width / t.scale) * fxScale, (p.height / t.scale) * fxScale] : undefined,
      fxScale,
      fxFrame: frame - c.start,
    };
  }

  /** Layers of the video tracks of scope `s`, bottom first. */
  private layersOf(s: Scope): DrawItem[] {
    const { width: W, height: H } = s.seq.settings;
    const out: DrawItem[] = [];
    for (const track of s.seq.tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      const tr = transitionAt(track, s.frame);
      if (tr) {
        const [a, b] = [this.layerOf(this.effectiveClip(tr.a), s), this.layerOf(this.effectiveClip(tr.b), s)];
        const vertical = tr.span.kind === "wipeUp" || tr.span.kind === "wipeDown";
        const size = vertical ? H : W;
        if (a || b) out.push({ key: `tr:${s.path}${tr.b.id}`, kind: tr.span.kind, p: tr.p, edge: Math.floor(size * tr.p + 1e-4) / size, a, b });
        continue;
      }
      const raw = clipAt(track, s.frame);
      const l = raw && this.layerOf(this.effectiveClip(raw), s);
      if (l) out.push(l);
    }
    return out;
  }

  private layers(): DrawItem[] {
    const root = this.rootScope();
    if (!root) return [];
    const { seq, frame } = root;
    const { width: W, height: H } = seq.settings;
    const out = this.layersOf(root);
    // Subtitles on top of everything, as the export burns them in.
    const subs = this.subtitleOverride ?? seq.subtitles;
    const cue = subs?.visible ? cueAt(subs, frame) : null;
    if (cue && cue.text.trim()) {
      out.push({
        key: "subtitles",
        source: cueCanvas(cue, subs, W, H),
        matrix: quadMatrix(place(IDENTITY_TRANSFORM, W, H, W, H), W, H),
        crop: [0, 0, 0, 0],
        opacity: 1,
        color: IDENTITY_COLOR,
      });
    }
    return out;
  }

  private draw() {
    const comp = this.compositor;
    if (!comp) return;
    const layers = this.layers();
    this.lastLayers = layers;
    comp.render(layers);
    for (const f of this.frameListeners) f(comp.canvas);
    if (this.scopesEnabled && this.scopesListener) {
      const now = performance.now();
      if (now - this.lastScope > 90) {
        this.lastScope = now;
        this.scopesListener(comp.readScopes(layers));
      }
    }
  }

  /** Colour of the composited frame at x, y (0..1 from the top left). */
  pickColor(x: number, y: number): [number, number, number] | null {
    if (!this.compositor) return null;
    this.syncAll(false);
    return this.compositor.pick(this.layers(), x, y);
  }

  /** Decoded pixel size of a clip's video source, if it is loaded. */
  sourceSize(clipId: Uuid): [number, number] | null {
    for (const t of this.seq?.tracks ?? []) {
      const c = t.clips.find((x) => x.id === clipId);
      const title = c && this.media.get(c.mediaId)?.title;
      if (title) return [title.width, title.height];
      const inner = c && this.sequences.get(c.mediaId);
      if (inner) return [inner.settings.width, inner.settings.height];
    }
    const el = this.voices.get(`video:${clipId}`)?.el;
    if (el instanceof HTMLVideoElement) return el.videoWidth ? [el.videoWidth, el.videoHeight] : null;
    if (el instanceof HTMLImageElement) return el.naturalWidth ? [el.naturalWidth, el.naturalHeight] : null;
    return null;
  }

  /** Number of layers drawn in the last frame (diagnostics/tests). */
  get layerCount() {
    return this.lastLayers.length;
  }
}

export interface PlaybackStats {
  /** Distinct sequence frames drawn in the last second. */
  fps: number;
  target: number;
  /** Frames the render loop skipped at normal speed. */
  skipped: number;
  /** Frames the video decoders dropped. */
  decoder: number;
}

export function sequenceDuration(seq: Sequence): number {
  let end = 0;
  for (const t of seq.tracks) {
    const last = t.clips[t.clips.length - 1];
    if (last) end = Math.max(end, last.start + last.duration);
  }
  return end;
}

export const engine = new PlaybackEngine();
// Exposed for diagnostics in the devtools console.
(globalThis as unknown as { kerfEngine: PlaybackEngine }).kerfEngine = engine;
