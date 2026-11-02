// Source monitor: one media item at a time, played by a plain <video>/<audio>
// element (no compositing needed), with its own In/Out marks per media item.
// Marks live for the session, in seconds of source time.

import { create } from "zustand";
import { placeMedia, seq } from "../actions/editing";
import { engine } from "../engine/playback";
import { fpsOf } from "../lib/time";
import type { MediaAsset, Uuid } from "../lib/types";
import { useEditor } from "./editor";
import { edit, useProject } from "./project";
import { toast } from "./toasts";

export interface SourceMarks {
  in: number | null;
  out: number | null;
}

interface SourceStore {
  media: Uuid | null;
  marks: Record<Uuid, SourceMarks>;
  /** Current position in seconds. */
  time: number;
  /** 0 = paused; negative = reverse shuttle. */
  rate: number;
  /** Recently opened media, newest first. */
  recent: Uuid[];
}

export const useSource = create<SourceStore>(() => ({ media: null, marks: {}, time: 0, rate: 0, recent: [] }));

let player: HTMLMediaElement | null = null;
let reverseRaf = 0;

/** The panel registers its media element; null when it unmounts. */
export function attachPlayer(el: HTMLMediaElement | null) {
  player = el;
  if (el) el.currentTime = useSource.getState().time;
}

export const sourceAsset = (): MediaAsset | null => {
  const id = useSource.getState().media;
  return id ? (useProject.getState().mediaById.get(id) ?? null) : null;
};

/** Frame rate used for stepping and timecode: the media's own, else the sequence's. */
export function sourceFps(a: MediaAsset | null = sourceAsset()): number {
  const v = a?.info?.video?.fps;
  if (v && v.num > 0 && v.den > 0 && a?.kind === "video") return v.num / v.den;
  const s = seq();
  return s ? fpsOf(s.settings.fps) : 25;
}

export const sourceDuration = (a: MediaAsset | null = sourceAsset()): number => (a && a.kind !== "image" ? (a.info?.duration ?? 0) : 0);

export const marksOf = (id: Uuid | null): SourceMarks => (id && useSource.getState().marks[id]) || { in: null, out: null };

function setMarks(m: SourceMarks) {
  const id = useSource.getState().media;
  if (id) useSource.setState((s) => ({ marks: { ...s.marks, [id]: m } }));
}

function stopReverse() {
  cancelAnimationFrame(reverseRaf);
  reverseRaf = 0;
}

export const source = {
  /** Loads media (keeping its marks), optionally at a time and with new marks. */
  open(id: Uuid, opts: { at?: number; marks?: SourceMarks } = {}) {
    const a = useProject.getState().mediaById.get(id);
    if (!a) return;
    source.pause();
    useSource.setState((s) => ({
      media: id,
      time: opts.at ?? (s.media === id ? s.time : (marksOf(id).in ?? 0)),
      marks: opts.marks ? { ...s.marks, [id]: opts.marks } : s.marks,
      recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, 12),
    }));
    useEditor.getState().focusPanel("source");
    // Monitor shortcuts (Space, I/O, J/K/L) now act on the source.
    useEditor.getState().set({ focusedPanel: "source" });
  },

  close() {
    source.pause();
    useSource.setState({ media: null, time: 0 });
  },

  seek(t: number) {
    const d = sourceDuration();
    const time = Math.max(0, d ? Math.min(t, d) : t);
    if (player) player.currentTime = time;
    useSource.setState({ time });
  },

  step(frames: number) {
    source.pause();
    source.seek(useSource.getState().time + frames / sourceFps());
  },

  /** Space: play from the current position (from In when at Out or the end). */
  toggle() {
    if (useSource.getState().rate !== 0) return source.pause();
    source.play(1);
  },

  play(rate: number) {
    if (!player) return;
    stopReverse();
    const { time } = useSource.getState();
    const out = marksOf(useSource.getState().media).out;
    const end = out ?? sourceDuration();
    if (rate > 0 && end && time >= end - 1 / sourceFps()) source.seek(marksOf(useSource.getState().media).in ?? 0);
    if (rate > 0) {
      player.playbackRate = rate;
      void player.play().catch(() => undefined);
    } else {
      // Media elements cannot play backwards: step the position per animation frame.
      player.pause();
      let last = performance.now();
      const tick = (now: number) => {
        const t = useSource.getState().time + ((now - last) / 1000) * rate;
        last = now;
        source.seek(t);
        if (t <= 0) return source.pause();
        reverseRaf = requestAnimationFrame(tick);
      };
      reverseRaf = requestAnimationFrame(tick);
    }
    useSource.setState({ rate });
  },

  pause() {
    stopReverse();
    player?.pause();
    useSource.setState({ rate: 0 });
  },

  /** J/K/L shuttle. */
  shuttle(dir: 1 | -1) {
    const cur = useSource.getState().rate;
    const rate = dir > 0 ? (cur > 0 ? Math.min(cur * 2, 8) : 1) : cur < 0 ? Math.max(cur * 2, -8) : -1;
    source.play(rate);
  },

  /** Called by the panel while the element plays. */
  sync(t: number) {
    useSource.setState({ time: t });
    const out = marksOf(useSource.getState().media).out;
    if (out !== null && useSource.getState().rate > 0 && t >= out) {
      source.pause();
      source.seek(out);
    }
  },

  setIn(t = useSource.getState().time) {
    const m = marksOf(useSource.getState().media);
    setMarks({ in: t, out: m.out !== null && m.out <= t ? null : m.out });
  },

  setOut(t = useSource.getState().time) {
    const m = marksOf(useSource.getState().media);
    // Out is exclusive: the frame under the playhead is included.
    const out = Math.min(t + 1 / sourceFps(), sourceDuration() || Infinity);
    setMarks({ in: m.in !== null && m.in >= out ? null : m.in, out });
  },

  clearMarks() {
    setMarks({ in: null, out: null });
  },

  gotoIn() {
    source.pause();
    source.seek(marksOf(useSource.getState().media).in ?? 0);
  },

  gotoOut() {
    source.pause();
    const out = marksOf(useSource.getState().media).out;
    source.seek(out !== null ? out - 1 / sourceFps() : sourceDuration());
  },

  /** Source range in sequence frames, or null for stills (default length). */
  range(): { sourceIn: number; sourceOut: number | null } | null {
    const a = sourceAsset();
    const s = seq();
    if (!a || !s || a.kind === "image") return null;
    const fps = fpsOf(s.settings.fps);
    const m = marksOf(a.id);
    const sourceIn = Math.round((m.in ?? 0) * fps);
    const sourceOut = m.out !== null ? Math.max(sourceIn + 1, Math.round(m.out * fps)) : null;
    return { sourceIn, sourceOut };
  },

  /**
   * Three-point edit: the source In/Out goes to the sequence In point, or
   * ends at the sequence Out point (backtimed), or starts at the playhead.
   */
  async place(mode: "insert" | "overwrite") {
    const a = sourceAsset();
    const s = seq();
    if (!a || !s) return;
    if (a.status.state !== "ready") {
      toast.info(`„${a.name}“ ist noch nicht bereit`);
      return;
    }
    const r = source.range();
    const len = r ? (r.sourceOut ?? Math.round(sourceDuration(a) * fpsOf(s.settings.fps))) - r.sourceIn : null;
    let at = Math.round(engine.frame);
    if (s.inPoint !== null) at = s.inPoint;
    else if (s.outPoint !== null && len !== null) at = s.outPoint - len;
    const end = await placeMedia([a.id], mode, Math.max(0, at), undefined, r ?? undefined);
    if (end === null) return;
    const after = seq();
    if (after && (after.inPoint !== null || after.outPoint !== null)) await edit({ type: "setInOut", sequence: after.id, inPoint: null, outPoint: null });
    engine.seek(end);
  },
};

/**
 * Match frame: opens the media of the clip under the playhead (selected one
 * first, else the topmost visible video, else audio) in the source monitor
 * at the same frame, with the clip's source range as In/Out.
 */
export function matchFrame() {
  const s = seq();
  if (!s) return;
  const f = Math.round(engine.frame);
  const under = (t: (typeof s.tracks)[number]) => t.clips.filter((c) => c.start <= f && f < c.start + c.duration);
  const video = [...s.tracks].reverse().filter((t) => t.kind === "video" && !t.hidden).flatMap(under);
  const audio = s.tracks.filter((t) => t.kind === "audio").flatMap(under);
  const selected = new Set(useEditor.getState().selection);
  const all = [...video, ...audio];
  const c = all.find((x) => selected.has(x.id)) ?? all[0];
  if (!c) {
    toast.info("Kein Clip am Playhead");
    return;
  }
  const fps = fpsOf(s.settings.fps);
  const at = (c.sourceIn + (f - c.start) * c.speed) / fps;
  source.open(c.mediaId, { at, marks: { in: c.sourceIn / fps, out: (c.sourceIn + c.duration * c.speed) / fps } });
}
