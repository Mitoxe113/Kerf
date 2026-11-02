// Playback engine.
//
// The timeline is evaluated every animation frame against the AudioContext
// clock. Each visible clip gets a pooled media element that is kept in sync
// with the clock (hard re-seek on large drift, gentle rate nudging on small
// drift). Paused, every move of the playhead becomes a coalesced, frame-
// accurate seek; the composite is redrawn when the decoder delivers the frame.

import { fpsOf } from "../lib/time";
import { animate } from "../lib/keys";
import { previewSource } from "../lib/media";
import type { Clip, ClipPatch, MediaAsset, Sequence, Track, Uuid } from "../lib/types";
import { AudioMixer } from "./audio";
import { Compositor, type Layer, type LayerSource } from "./compositor";
import { dbToGain, place, quadMatrix } from "./math";

const PREROLL_S = 1.2;
const RELEASE_S = 6;
const HARD_RESYNC_S = 0.12;
const SOFT_DRIFT_S = 0.02;

interface Voice {
  key: string;
  clipId: Uuid;
  src: string;
  el: HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
  seeking: boolean;
  pending: number | null;
  lastUsed: number;
  // audio only
  gain?: GainNode;
  pan?: StereoPannerNode;
  track?: Uuid;
}

type Listener = () => void;

export interface EngineOptions {
  useProxies: boolean;
  /** Preview resolution scale (1, 0.5, 0.25). */
  quality: number;
}

/** Clip at `frame` on `track` (clips are sorted and non-overlapping). */
export function clipAt(track: Track, frame: number): Clip | null {
  const clips = track.clips;
  let lo = 0;
  let hi = clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = clips[mid];
    if (frame < c.start) hi = mid - 1;
    else if (frame >= c.start + c.duration) lo = mid + 1;
    else return c;
  }
  return null;
}

function nextClipAfter(track: Track, frame: number): Clip | null {
  for (const c of track.clips) if (c.start > frame) return c;
  return null;
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

  private seq: Sequence | null = null;
  private media = new Map<Uuid, MediaAsset>();
  private opts: EngineOptions = { useProxies: false, quality: 1 };
  private overrides = new Map<Uuid, Partial<Clip>>();
  private voices = new Map<string, Voice>();
  private compositor: Compositor | null = null;
  private listeners = new Set<Listener>();
  private raf = 0;
  private renderQueued = false;
  private startFrame = 0;
  private startClock = 0;
  private range: [number, number] | null = null;
  private lastLayers: Layer[] = [];
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
    this.compositor?.dispose();
    try {
      this.compositor = new Compositor(canvas);
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

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  update(seq: Sequence | null, media: Map<Uuid, MediaAsset>, opts: EngineOptions) {
    const seqChanged = seq?.id !== this.seq?.id;
    this.seq = seq;
    this.media = media;
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

  /** Live, uncommitted property changes (inspector drags, monitor handles). */
  setOverride(clip: Uuid, patch: Partial<Clip> | ClipPatch | null) {
    if (patch) this.overrides.set(clip, { ...this.overrides.get(clip), ...patch });
    else this.overrides.delete(clip);
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

  private sourceTime(c: Clip, frame: number): number {
    const fps = this.fps;
    return (c.sourceIn + (frame - c.start) * c.speed) / fps;
  }

  private voice(clip: Clip, kind: "video" | "audio"): Voice | null {
    const asset = this.media.get(clip.mediaId);
    if (!asset || asset.status.state !== "ready") return null;
    const src = previewSource(asset, this.opts.useProxies);
    if (!src) {
      this.pendingMedia.add(asset.id);
      return null;
    }
    this.pendingMedia.delete(asset.id);
    const key = `${kind}:${clip.id}`;
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
      v = { key, clipId: clip.id, src, el, seeking: false, pending: null, lastUsed: performance.now() };
      if (!(el instanceof HTMLImageElement)) {
        const voice = v;
        el.addEventListener("seeked", () => this.onSeeked(voice));
        el.addEventListener("loadeddata", () => this.requestRender());
        if (kind === "audio") {
          const ctx = this.mixer.context();
          const node = ctx.createMediaElementSource(el);
          v.gain = ctx.createGain();
          v.pan = ctx.createStereoPanner();
          node.connect(v.gain).connect(v.pan);
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

  private syncVoice(v: Voice, c: Clip, frame: number, hard: boolean, audible: boolean) {
    if (v.el instanceof HTMLImageElement) return;
    const el = v.el;
    const fps = this.fps;
    // Aim inside the frame so rounding never shows the previous one.
    const t = Math.max(0, this.sourceTime(c, frame) + (this.playing ? 0 : 0.35 / fps));
    const rate = this.rate * c.speed;
    const canPlay = this.playing && rate > 0 && rate <= 8;
    if (!canPlay) {
      if (!el.paused) el.pause();
      this.seekVoice(v, t);
      return;
    }
    if (el instanceof HTMLAudioElement) el.muted = !audible || rate > 4;
    const drift = el.currentTime - t;
    if (hard || el.paused || Math.abs(drift) > HARD_RESYNC_S) {
      if (!v.seeking) {
        el.currentTime = t;
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
  private preroll(v: Voice, c: Clip) {
    if (v.el instanceof HTMLImageElement) return;
    const el = v.el;
    if (!el.paused) el.pause();
    this.seekVoice(v, this.sourceTime(c, c.start));
  }

  private syncAll(hard: boolean) {
    const seq = this.seq;
    if (!seq) return;
    const frame = this.previewFrame ?? this.frame;
    const used = new Set<string>();
    const ahead = this.playing && this.rate > 0 ? PREROLL_S * this.fps * this.rate : 0;
    const anySolo = seq.tracks.some((t) => t.kind === "audio" && t.solo);

    for (const track of seq.tracks) {
      const kind = track.kind;
      if (kind === "video" && track.hidden) continue;
      const raw = clipAt(track, frame);
      const c = raw ? this.effectiveClip(raw) : null;
      if (c && c.enabled) {
        const v = this.voice(c, kind);
        if (v) {
          used.add(v.key);
          const audible = kind === "audio" && !track.muted && (!anySolo || track.solo);
          if (kind === "audio" && v.gain && v.pan) {
            const ctx = this.mixer.context();
            const g = dbToGain(animate(c, frame).volumeDb) * fadeGain(c, frame);
            v.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
            v.pan.pan.setTargetAtTime(c.pan, ctx.currentTime, 0.01);
            if (v.track !== track.id) {
              v.pan.disconnect();
              v.pan.connect(this.mixer.bus(track.id));
              v.track = track.id;
            }
          }
          this.syncVoice(v, c, frame, hard, audible);
        }
      }
      if (kind === "audio") {
        const audible = !track.muted && (!anySolo || track.solo);
        this.mixer.setBusGain(track.id, audible ? dbToGain(track.volumeDb) : 0);
      }
      if (ahead > 0) {
        const next = nextClipAfter(track, frame);
        if (next && next.enabled && next.start - frame < ahead) {
          const v = this.voice(this.effectiveClip(next), kind);
          if (v && !used.has(v.key)) {
            used.add(v.key);
            this.preroll(v, this.effectiveClip(next));
          }
        }
      }
    }
    // Pause idle voices; release ones not used for a while.
    const now = performance.now();
    for (const v of this.voices.values()) {
      if (used.has(v.key)) continue;
      if (!(v.el instanceof HTMLImageElement) && !v.el.paused) v.el.pause();
      if (now - v.lastUsed > RELEASE_S * 1000) this.releaseVoice(v);
    }
  }

  private releaseVoice(v: Voice) {
    this.voices.delete(v.key);
    this.compositor?.release(v.key);
    if (!(v.el instanceof HTMLImageElement)) {
      v.el.pause();
      v.el.removeAttribute("src");
      v.el.load();
    }
    v.gain?.disconnect();
    v.pan?.disconnect();
  }

  private releaseAll() {
    for (const v of [...this.voices.values()]) this.releaseVoice(v);
  }

  // --- compositing ----------------------------------------------------------------

  private layers(): Layer[] {
    const seq = this.seq;
    if (!seq) return [];
    const frame = this.previewFrame ?? this.frame;
    const { width: W, height: H } = seq.settings;
    const out: Layer[] = [];
    for (const track of seq.tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      const raw = clipAt(track, frame);
      if (!raw) continue;
      const c = this.effectiveClip(raw);
      if (!c.enabled) continue;
      const v = this.voices.get(`video:${c.id}`);
      if (!v) continue;
      const src = v.el as LayerSource;
      const [sw, sh] =
        src instanceof HTMLVideoElement ? [src.videoWidth, src.videoHeight] : [src.naturalWidth, src.naturalHeight];
      if (!sw || !sh) continue;
      if (src instanceof HTMLVideoElement && src.readyState < 2) continue;
      const a = animate(c, frame);
      const t = a.transform;
      if (t.scale <= 0 || a.opacity <= 0) continue;
      const p = place(t, sw, sh, W, H);
      out.push({
        key: v.key,
        source: src,
        matrix: quadMatrix(p, W, H),
        crop: [t.cropLeft, t.cropTop, t.cropRight, t.cropBottom],
        opacity: a.opacity * fadeGain(c, frame),
        color: c.color,
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
    if (this.scopesEnabled && this.scopesListener) {
      const now = performance.now();
      if (now - this.lastScope > 90) {
        this.lastScope = now;
        this.scopesListener(comp.readScopes(layers));
      }
    }
  }

  /** Decoded pixel size of a clip's video source, if it is loaded. */
  sourceSize(clipId: Uuid): [number, number] | null {
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
