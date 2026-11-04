// Noise reduction helpers without UI (kerf-core Denoise).

import { sourceAt } from "./keys";
import { fpsOf } from "./time";
import type { Clip, Denoise, Sequence } from "./types";

/** FFmpeg's defaults (Denoise::default in kerf-core). */
export const DEFAULT_DENOISE: Denoise = { enabled: true, reductionDb: 12, floorDb: -50, track: false };

/** Identity of a setting: one cache file each. */
export const denoiseKey = (d: Denoise) => `${d.reductionDb}|${d.floorDb}|${d.track ? 1 : 0}|${(d.profile ?? []).join(",")}`;

/** Shortest part a noise profile is learned from (kerf-media MIN_PROFILE_S). */
export const MIN_PROFILE_S = 0.25;

/**
 * Source seconds of the media under the sequence's in/out range inside clip
 * `c`, or null when the range covers less than a quarter second of it.
 */
export function learnRange(seq: Sequence, c: Clip): [number, number] | null {
  if (seq.inPoint == null || seq.outPoint == null) return null;
  const a = Math.max(seq.inPoint, c.start);
  const b = Math.min(seq.outPoint, c.start + c.duration);
  if (b <= a) return null;
  const fps = fpsOf(seq.settings.fps);
  const [s0, s1] = [sourceAt(c, a - c.start), sourceAt(c, b - c.start)].map((s) => s / fps);
  const [from, to] = [Math.max(0, Math.min(s0, s1)), Math.max(s0, s1)];
  return to - from >= MIN_PROFILE_S ? [from, to] : null;
}
