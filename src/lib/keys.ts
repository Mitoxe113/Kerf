// Keyframe evaluation, mirroring kerf_core::model (eval_keys, Ease::apply).
// Keys are stored on the source position so they follow the picture when a
// clip is trimmed, slipped or split.

import type { Clip, Ease, Keyframe, KeyParam, Transform } from "./types";

export const EASES: { value: Ease; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "easeIn", label: "Langsam beginnen" },
  { value: "easeOut", label: "Langsam enden" },
  { value: "easeInOut", label: "Weich" },
  { value: "hold", label: "Halten" },
];

export const VIDEO_PARAMS: KeyParam[] = ["x", "y", "scale", "rotation", "opacity"];

export function ease(e: Ease, u: number): number {
  u = Math.min(1, Math.max(0, u));
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
  }
}

/** Value of `p` at clip-local timeline frame `local`. */
export function paramAt(c: Clip, p: KeyParam, local: number): number {
  const keys = keysOf(c, p);
  return keys.length ? evalKeys(keys, sourceAt(c, local)) : baseValue(c, p);
}

/** Transform, opacity and volume of `c` at timeline frame `frame`. */
export function animate(c: Clip, frame: number): { transform: Transform; opacity: number; volumeDb: number } {
  if (!hasKeys(c)) return { transform: c.transform, opacity: c.opacity, volumeDb: c.volumeDb };
  const local = frame - c.start;
  return {
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
