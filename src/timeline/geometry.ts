// Timeline layout, hit testing helpers, snapping and the local constraint
// mirrors used to draw drag previews. The engine re-validates every edit; the
// mirrors only make the ghost stop where the engine will stop.

import type { Clip, MediaAsset, Sequence, Track, TrackKind, TransitionKind, Uuid } from "../lib/types";
import { framesBetween, sourceOut } from "../lib/keys";
import { fpsOf } from "../lib/time";
import { TRACK_HEIGHTS, type TrackSize } from "../state/editor";

export const RULER_H = 30;
/** Subtitle lane under the ruler (only while the sequence has cues). */
export const SUB_LANE_H = 24;
export const subLane = (seq: Sequence) => (seq.subtitles?.cues.length ? SUB_LANE_H : 0);
export const DIVIDER_H = 6;
export const HEADER_W = 184;
export const EDGE_PX = 7;

export interface TrackRow {
  track: Track;
  index: number;
  y: number;
  h: number;
}

export interface TrackLayout {
  rows: TrackRow[];
  dividerY: number;
  height: number;
}

/** Video tracks top-down from the highest, a divider, then audio tracks A1 down. */
/** `resize` previews a track height while its header edge is dragged. */
export function layoutTracks(seq: Sequence, size: TrackSize, resize?: { track: Uuid; h: number } | null): TrackLayout {
  const hs = TRACK_HEIGHTS[size];
  const height = (t: Track) => (resize?.track === t.id ? resize.h : t.height || hs[t.kind]);
  const rows: TrackRow[] = [];
  let y = subLane(seq);
  const video = seq.tracks.map((t, i) => ({ t, i })).filter((x) => x.t.kind === "video").reverse();
  for (const { t, i } of video) {
    const h = height(t);
    rows.push({ track: t, index: i, y, h });
    y += h;
  }
  const dividerY = y;
  y += DIVIDER_H;
  for (const [i, t] of seq.tracks.entries()) {
    if (t.kind !== "audio") continue;
    const h = height(t);
    rows.push({ track: t, index: i, y, h });
    y += h;
  }
  return { rows, dividerY, height: y };
}

/** Frames `[t0, t1)` a transition plays around the cut at `cut`. */
export interface TransitionSpan {
  kind: TransitionKind;
  t0: number;
  t1: number;
  cut: number;
}

/**
 * The transition into clip `b` (an index) when it is valid: the clip before
 * ends where `b` starts and the kind fits the track; each side takes at most
 * half of its clip. Mirror of `Track::transition_into` (kerf-core).
 */
export function transitionInto(track: Track, b: number): TransitionSpan | null {
  const clip = track.clips[b];
  const t = clip?.transition;
  const a = b > 0 ? track.clips[b - 1] : undefined;
  if (!t || !a || a.start + a.duration !== clip.start || (t.kind === "crossfade") !== (track.kind === "audio") || t.duration <= 0) return null;
  const half = Math.floor(t.duration / 2);
  let [left, right] = t.align === "start" ? [0, t.duration] : t.align === "end" ? [t.duration, 0] : [half, t.duration - half];
  left = Math.min(left, Math.floor(a.duration / 2));
  right = Math.min(right, Math.floor(clip.duration / 2));
  return left + right > 0 ? { kind: t.kind, t0: clip.start - left, t1: clip.start + right, cut: clip.start } : null;
}

export function rowAt(layout: TrackLayout, y: number): TrackRow | null {
  return layout.rows.find((r) => y >= r.y && y < r.y + r.h) ?? null;
}

/** Position of a track among tracks of its kind (V1 = 0, A1 = 0). */
export function kindPosition(seq: Sequence, trackIndex: number): number {
  const kind = seq.tracks[trackIndex].kind;
  return seq.tracks.slice(0, trackIndex).filter((t) => t.kind === kind).length;
}

export function tracksOfKind(seq: Sequence, kind: TrackKind): number[] {
  return seq.tracks.flatMap((t, i) => (t.kind === kind ? [i] : []));
}

export function locate(seq: Sequence, id: Uuid): { track: number; clip: number } | null {
  for (let t = 0; t < seq.tracks.length; t++) {
    const c = seq.tracks[t].clips.findIndex((x) => x.id === id);
    if (c >= 0) return { track: t, clip: c };
  }
  return null;
}

export function findClip(seq: Sequence, id: Uuid): Clip | null {
  const l = locate(seq, id);
  return l ? seq.tracks[l.track].clips[l.clip] : null;
}

/** Adds linked partners of `ids`. */
export function expandLinks(seq: Sequence, ids: Uuid[]): Uuid[] {
  const links = new Set<string>();
  for (const id of ids) {
    const c = findClip(seq, id);
    if (c?.link) links.add(c.link);
  }
  const out = new Set(ids);
  if (links.size)
    for (const t of seq.tracks) for (const c of t.clips) if (c.link && links.has(c.link)) out.add(c.id);
  return [...out];
}

/** Sorted, de-duplicated clip boundaries (for prev/next edit and snapping). */
export function editPoints(seq: Sequence, exclude?: Set<Uuid>): number[] {
  const s = new Set<number>([0]);
  for (const t of seq.tracks)
    for (const c of t.clips) {
      if (exclude?.has(c.id)) continue;
      s.add(c.start);
      s.add(c.start + c.duration);
    }
  return [...s].sort((a, b) => a - b);
}

export function snapTargets(seq: Sequence, playhead: number, exclude?: Set<Uuid>): number[] {
  const pts = editPoints(seq, exclude);
  pts.push(Math.round(playhead));
  for (const m of seq.markers) pts.push(m.frame);
  if (seq.inPoint !== null) pts.push(seq.inPoint);
  if (seq.outPoint !== null) pts.push(seq.outPoint);
  return pts;
}

/** Nearest target within `thresholdFrames` of any of `candidates` (offsets from `frame`). */
export function snap(
  candidates: number[],
  targets: number[],
  thresholdFrames: number,
): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const c of candidates)
    for (const t of targets) {
      const d = t - c;
      if (Math.abs(d) <= thresholdFrames && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: t };
    }
  return best;
}

// --- constraint mirrors --------------------------------------------------------

/** Media length in sequence frames, or null for unbounded (stills). */
export function mediaLength(asset: MediaAsset | undefined, seq: Sequence): number | null {
  if (!asset || asset.kind === "image" || !asset.info) return null;
  return Math.max(1, Math.floor(asset.info.duration * fpsOf(seq.settings.fps) + 1e-6));
}

/** Frames the clip's start can move earlier (kerf_core Clip::room_before). */
const roomBefore = (c: Clip, len: number) => (c.reverse ? framesBetween(c, sourceOut(c), len) : framesBetween(c, 0, c.sourceIn));
/** Frames the clip's end can move later (Clip::room_after). */
const roomAfter = (c: Clip, len: number) => (c.reverse ? framesBetween(c, 0, c.sourceIn) : framesBetween(c, sourceOut(c), len));
/** `delta` limited to [lo, hi]; 0 when the range is empty (never -0). */
const clampDelta = (lo: number, hi: number, delta: number) => (lo > hi ? 0 : Math.max(lo, Math.min(hi, delta)) + 0);

export function clampTrim(
  track: Track,
  ci: number,
  edge: "start" | "end",
  delta: number,
  ripple: boolean,
  len: number | null,
): number {
  const c = track.clips[ci];
  let lo = -Infinity;
  let hi = Infinity;
  if (edge === "start") {
    hi = Math.min(hi, c.duration - 1);
    if (len !== null) lo = Math.max(lo, -roomBefore(c, len));
    if (!ripple) lo = Math.max(lo, (ci > 0 ? track.clips[ci - 1].start + track.clips[ci - 1].duration : 0) - c.start);
  } else {
    lo = Math.max(lo, 1 - c.duration);
    if (len !== null) hi = Math.min(hi, roomAfter(c, len));
    const next = track.clips[ci + 1];
    if (!ripple && next) hi = Math.min(hi, next.start - (c.start + c.duration));
  }
  return clampDelta(lo, hi, delta);
}

export function clampRoll(track: Track, ci: number, delta: number, lenL: number | null, lenR: number | null): number {
  const l = track.clips[ci];
  const r = track.clips[ci + 1];
  if (!r || r.start !== l.start + l.duration) return 0;
  let lo = 1 - l.duration;
  let hi = r.duration - 1;
  if (lenL !== null) hi = Math.min(hi, roomAfter(l, lenL));
  if (lenR !== null) lo = Math.max(lo, -roomBefore(r, lenR));
  return clampDelta(lo, hi, delta);
}

export function clampSlip(c: Clip, delta: number, len: number | null): number {
  if (len === null) return 0;
  const lo = -framesBetween(c, 0, c.sourceIn);
  const hi = framesBetween(c, sourceOut(c), len);
  return clampDelta(lo, hi, delta);
}

export function clampSlide(
  track: Track,
  ci: number,
  delta: number,
  lenPrev: number | null,
  lenNext: number | null,
): number {
  const c = track.clips[ci];
  const p = ci > 0 ? track.clips[ci - 1] : null;
  const n = track.clips[ci + 1] ?? null;
  let lo = -Infinity;
  let hi = Infinity;
  if (p && p.start + p.duration === c.start) {
    lo = Math.max(lo, 1 - p.duration);
    if (lenPrev !== null) hi = Math.min(hi, roomAfter(p, lenPrev));
  } else lo = Math.max(lo, (p ? p.start + p.duration : 0) - c.start);
  if (n && n.start === c.start + c.duration) {
    hi = Math.min(hi, n.duration - 1);
    if (lenNext !== null) lo = Math.max(lo, -roomBefore(n, lenNext));
  } else if (n) hi = Math.min(hi, n.start - (c.start + c.duration));
  return clampDelta(lo, hi, delta);
}
