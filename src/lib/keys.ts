// Keyframe evaluation, mirroring kerf_core::model (eval_keys, Ease::apply).
// Keys are stored on the source position so they follow the picture when a
// clip is trimmed, slipped or split.

import type { Clip, ColorAdjust, ColorParam, Ease, Keyframe, KeyParam, Transform } from "./types";
import { Warp } from "./warp";

export const EASES: { value: Ease; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "easeIn", label: "Langsam beginnen" },
  { value: "easeOut", label: "Langsam enden" },
  { value: "easeInOut", label: "Weich" },
  { value: "hold", label: "Halten" },
];

export const COLOR_PARAMS: ColorParam[] = ["exposure", "contrast", "saturation", "temperature", "tint"];
export const MOTION_PARAMS: KeyParam[] = ["x", "y", "scale", "rotation", "opacity"];
export const VIDEO_PARAMS: KeyParam[] = [...MOTION_PARAMS, ...COLOR_PARAMS];

/** Default control points of a new custom curve (CSS "ease"). */
export const DEFAULT_BEZIER = { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };

export const isBezier = (e: Ease | undefined): e is Extract<Ease, { bezier: unknown }> => typeof e === "object" && e !== null && "bezier" in e;

export const sameEase = (a: Ease | undefined, b: Ease | undefined) => JSON.stringify(a ?? "linear") === JSON.stringify(b ?? "linear");

/**
 * y of the cubic Bezier (0,0) (x1,y1) (x2,y2) (1,1) at x = u; mirrors
 * kerf_core::model::bezier (Newton steps, bisection fallback).
 */
export function bezier(x1: number, y1: number, x2: number, y2: number, u: number): number {
  const curve = (a: number, b: number, t: number) => {
    const m = 1 - t;
    return 3 * m * m * t * a + 3 * m * t * t * b + t * t * t;
  };
  const slope = (a: number, b: number, t: number) => {
    const m = 1 - t;
    return 3 * m * m * a + 6 * m * t * (b - a) + 3 * t * t * (1 - b);
  };
  let t = u;
  for (let i = 0; i < 8; i++) {
    const err = curve(x1, x2, t) - u;
    if (Math.abs(err) < 1e-7) return curve(y1, y2, t);
    const d = slope(x1, x2, t);
    if (Math.abs(d) < 1e-6) break;
    t = Math.min(1, Math.max(0, t - err / d));
  }
  let lo = 0;
  let hi = 1;
  t = u;
  for (let i = 0; i < 40; i++) {
    if (curve(x1, x2, t) < u) lo = t;
    else hi = t;
    t = 0.5 * (lo + hi);
  }
  return curve(y1, y2, t);
}

export function ease(e: Ease, u: number): number {
  u = Math.min(1, Math.max(0, u));
  if (isBezier(e)) return bezier(e.bezier.x1, e.bezier.y1, e.bezier.x2, e.bezier.y2, u);
  switch (e) {
    case "easeIn":
      return u * u;
    case "easeOut":
      return u * (2 - u);
    case "easeInOut":
      return u * u * (3 - 2 * u);
    case "hold":
      return 0;
    default:
      return u;
  }
}

/** Value of sorted `keys` at source position `at` (constant outside the keys). */
export function evalKeys(keys: Keyframe[], at: number): number {
  if (!keys.length) return 0;
  if (at <= keys[0].at) return keys[0].value;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (at < b.at) return a.value + (b.value - a.value) * ease(a.ease, (at - a.at) / Math.max(1, b.at - a.at));
  }
  return keys[keys.length - 1].value;
}

export const keysOf = (c: Clip, p: KeyParam): Keyframe[] => c.keys?.[p] ?? [];
export const isAnimated = (c: Clip, p: KeyParam) => keysOf(c, p).length > 0;
export const hasKeys = (c: Clip) => Object.values(c.keys ?? {}).some((k) => k && k.length > 0);

/** Keyframed speed or reversed: timing goes through a Warp (kerf_core Clip::is_warped). */
export const isWarped = (c: Clip) => !!c.reverse || isAnimated(c, "speed");

// One Warp per keys array: built on demand, reused while the clip is unchanged.
const warps = new WeakMap<Keyframe[], Warp>();
const constant = new Map<number, Warp>();
export function warpOf(c: Clip): Warp {
  const keys = keysOf(c, "speed");
  if (!keys.length) {
    let w = constant.get(c.speed);
    if (!w) constant.set(c.speed, (w = new Warp([], c.speed)));
    return w;
  }
  let w = warps.get(keys);
  if (!w) warps.set(keys, (w = new Warp(keys, c.speed)));
  return w;
}

/**
 * Source position at clip-local timeline position `local` (a frame boundary).
 * Reversed clips run from their source out down to `sourceIn`; their frame
 * `l` shows the source frame just below `sourceAt(c, l)`.
 */
export function sourceAt(c: Clip, local: number): number {
  if (!isWarped(c)) return c.sourceIn + local * c.speed;
  const w = warpOf(c);
  const w0 = w.w(c.sourceIn);
  return w.s(c.reverse ? w0 + c.duration - local : w0 + local);
}

/** Clip-local timeline position of source position `at`. */
export function localOf(c: Clip, at: number): number {
  if (!isWarped(c)) return (at - c.sourceIn) / c.speed;
  const w = warpOf(c);
  const d = w.w(at) - w.w(c.sourceIn);
  return c.reverse ? c.duration - d : d;
}

/** Playback speed at clip-local position `local` (always positive). */
export function speedAt(c: Clip, local: number): number {
  if (!isWarped(c)) return c.speed;
  const w = warpOf(c);
  const w0 = w.w(c.sourceIn);
  return w.speed(c.reverse ? w0 + c.duration - local : w0 + local);
}

/** Source frame shown on clip-local frame `local` (kerf_core Clip::shown_frame). */
export function shownFrame(c: Clip, local: number): number {
  const q = sourceAt(c, local);
  return c.reverse ? Math.ceil(q - 1e-6) - 1 : Math.floor(q + 1e-6);
}

/** `sourceIn` after slipping `c` by `frames` timeline frames (Clip::slip, rounded down). */
export function slippedIn(c: Clip, frames: number): number {
  const w = warpOf(c);
  return Math.max(0, Math.floor(w.s(w.w(c.sourceIn) + frames) + 1e-6));
}

/** End of the used source range (exclusive), as kerf_core Clip::source_out. */
export function sourceOut(c: Clip): number {
  if (!isWarped(c)) return c.sourceIn + Math.round(c.duration * c.speed);
  const w = warpOf(c);
  return Math.round(w.s(w.w(c.sourceIn) + c.duration));
}

/**
 * Timeline frames between the exact (unrounded) end of the used source range
 * and source position `len` (Clip::frames_after_end).
 */
export function framesAfterEnd(c: Clip, len: number): number {
  const w = warpOf(c);
  const end = w.w(c.sourceIn) + c.duration;
  return Math.max(0, Math.floor(w.w(len) - end + 1e-9));
}

/** Timeline frames between source positions a <= b, rounded down (Clip::frames_between). */
export function framesBetween(c: Clip, a: number, b: number): number {
  if (b <= a) return 0;
  const w = warpOf(c);
  return Math.floor(w.w(b) - w.w(a) + 1e-9);
}

export function baseValue(c: Clip, p: KeyParam): number {
  switch (p) {
    case "x":
      return c.transform.x;
    case "y":
      return c.transform.y;
    case "scale":
      return c.transform.scale;
    case "rotation":
      return c.transform.rotation;
    case "opacity":
      return c.opacity;
    case "volume":
      return c.volumeDb;
    case "speed":
      return c.speed;
    default:
      return c.color[p];
  }
}

/**
 * Value of `p` at clip-local timeline frame `local`. On a warped clip the
 * curve between two keys runs over timeline time (kerf_core Clip::param_at).
 */
export function paramAt(c: Clip, p: KeyParam, local: number): number {
  return keysValue(c, keysOf(c, p), baseValue(c, p), local);
}

/**
 * Value of a property with `keys` (static value `base`) of clip `c` at
 * clip-local frame `local` (kerf_core Clip::keys_value); see paramAt.
 */
export function keysValue(c: Clip, keys: Keyframe[], base: number, local: number): number {
  if (!keys.length) return base;
  if (!isWarped(c)) return evalKeys(keys, sourceAt(c, local));
  const at = sourceAt(c, local);
  if (at <= keys[0].at) return keys[0].value;
  for (let i = 0; i + 1 < keys.length; i++) {
    const [a, b] = [keys[i], keys[i + 1]];
    if (at < b.at) {
      const [la, lb] = [localOf(c, a.at), localOf(c, b.at)];
      const u = Math.abs(lb - la) < 1e-9 ? 1 : Math.min(1, Math.max(0, (local - la) / (lb - la)));
      return a.value + (b.value - a.value) * ease(a.ease, u);
    }
  }
  return keys[keys.length - 1].value;
}

/** Transform, opacity, colour and volume of `c` at timeline frame `frame`. */
export function animate(c: Clip, frame: number): { transform: Transform; opacity: number; volumeDb: number; color: ColorAdjust } {
  if (!hasKeys(c)) return { transform: c.transform, opacity: c.opacity, volumeDb: c.volumeDb, color: c.color };
  const local = frame - c.start;
  const color = { ...c.color };
  for (const p of COLOR_PARAMS) if (isAnimated(c, p)) color[p] = paramAt(c, p, local);
  return {
    color,
    transform: {
      ...c.transform,
      x: paramAt(c, "x", local),
      y: paramAt(c, "y", local),
      scale: paramAt(c, "scale", local),
      rotation: paramAt(c, "rotation", local),
    },
    opacity: paramAt(c, "opacity", local),
    volumeDb: paramAt(c, "volume", local),
  };
}

/** Source position of the playhead inside `c` (clamped to the clip). */
export function playheadKeyPos(c: Clip, frame: number): number {
  const local = Math.min(Math.max(frame - c.start, 0), c.duration - 1);
  return Math.round(sourceAt(c, local));
}

/** Adds or replaces the key at `at`, keeping the list sorted. */
export function upsertKey(keys: Keyframe[], at: number, value: number, easeOf?: Ease): Keyframe[] {
  const prev = keys.find((k) => k.at === at);
  const k: Keyframe = { at, value, ease: easeOf ?? prev?.ease ?? "linear" };
  return [...keys.filter((x) => x.at !== at), k].sort((a, b) => a.at - b.at);
}

export const removeKey = (keys: Keyframe[], at: number) => keys.filter((k) => k.at !== at);
