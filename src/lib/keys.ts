// Keyframe evaluation, mirroring kerf_core::model (eval_keys, Ease::apply).
// Keys are stored on the source position so they follow the picture when a
// clip is trimmed, slipped or split.

import type { Clip, ColorAdjust, ColorParam, Ease, Keyframe, KeyParam, Transform } from "./types";

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

/** Source position of clip-local timeline frame `local`. */
export const sourceAt = (c: Clip, local: number) => c.sourceIn + local * c.speed;
/** Clip-local timeline frame of source position `at`. */
export const localOf = (c: Clip, at: number) => (at - c.sourceIn) / c.speed;

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
    default:
      return c.color[p];
  }
}

/** Value of `p` at clip-local timeline frame `local`. */
export function paramAt(c: Clip, p: KeyParam, local: number): number {
  const keys = keysOf(c, p);
  return keys.length ? evalKeys(keys, sourceAt(c, local)) : baseValue(c, p);
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
