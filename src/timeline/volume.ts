// Volume rubber band on audio clips: the clip's level as a line over the
// waveform, dragged up and down, with keyframes as handles.
//
// The line's height is the square root of the gain, the scale the waveform
// uses, so 0 dB sits at half height, +12 dB at the top and silence at the
// bottom. Values are dB (KeyParam "volume", Clip.volumeDb).

import { dbToGain } from "../engine/math";
import { keysOf, localOf, paramAt } from "../lib/keys";
import type { Clip, Keyframe } from "../lib/types";

/** Level at the top of the band. kerf_core allows up to +24 dB; higher values sit at the top. */
export const VOLUME_TOP_DB = 12;
/** kerf_core's floor for clip volume (silence). */
export const VOLUME_MIN_DB = -96;
const TOP_ROOT = Math.sqrt(dbToGain(VOLUME_TOP_DB));

/** Height of `db` in the band, 0 (bottom, silence) to 1 (top, +12 dB). */
export function volumeToPos(db: number): number {
  return Math.min(1, Math.sqrt(dbToGain(db)) / TOP_ROOT);
}

/** Inverse of {@link volumeToPos}, rounded to 0.1 dB and limited to -96..+12 dB. */
export function posToVolume(pos: number): number {
  const p = Math.min(1, Math.max(0, pos));
  const root = p * TOP_ROOT;
  if (root <= 0) return VOLUME_MIN_DB;
  const db = 40 * Math.log10(root);
  return Math.round(Math.min(VOLUME_TOP_DB, Math.max(VOLUME_MIN_DB, db)) * 10) / 10;
}

/** Moves `db` by `dpos` band heights on the band's scale. */
export const shiftVolume = (db: number, dpos: number) => posToVolume(volumeToPos(db) + dpos);

/** Vertical extent of the band inside a clip drawn at row `rowY` with height `rowH` (as drawClip lays it out). */
export function volumeBand(rowY: number, rowH: number): { top: number; height: number } {
  const y = rowY + 1;
  const h = rowH - 3;
  const labelH = h >= 30 ? 16 : 0;
  return { top: y + labelH + 3, height: Math.max(0, h - labelH - 6) };
}

/** The band is drawn and editable where it has room (clips at least 24 px wide). */
export const hasBand = (rowH: number, widthPx: number) => widthPx >= 24 && volumeBand(0, rowH).height >= 10;

/** Screen y of level `db` in a band. */
export const bandY = (band: { top: number; height: number }, db: number) => band.top + (1 - volumeToPos(db)) * band.height;

export type VolumeHit = { kind: "key"; at: number } | { kind: "line"; local: number };

/**
 * What of clip `c`'s band is at (`x`, `y`): a volume key (within 5 px) or
 * the line (within 4 px vertically). `x0` is the clip's left edge on screen.
 */
export function volumeHitAt(c: Clip, x0: number, zoom: number, band: { top: number; height: number }, x: number, y: number): VolumeHit | null {
  const local = Math.min(Math.max((x - x0) / zoom, 0), c.duration);
  for (const k of keysOf(c, "volume")) {
    const kx = x0 + localOf(c, k.at) * zoom;
    if (Math.abs(kx - x) <= 5 && Math.abs(bandY(band, k.value) - y) <= 5) return { kind: "key", at: k.at };
  }
  const ly = bandY(band, paramAt(c, "volume", Math.min(local, c.duration - 1e-6)));
  return Math.abs(ly - y) <= 4 ? { kind: "line", local } : null;
}

/**
 * Keys a drag of the line at clip-local position `local` moves: the two
 * around it, or the first or last one outside them. Empty without keys
 * (the drag changes the clip's static volume).
 */
export function segmentKeys(c: Clip, local: number): number[] {
  const keys = keysOf(c, "volume");
  if (!keys.length) return [];
  // Reversed clips run backwards through the source: compare positions on screen.
  const pos = keys.map((k) => ({ at: k.at, l: localOf(c, k.at) })).sort((a, b) => a.l - b.l);
  if (local <= pos[0].l) return [pos[0].at];
  for (let i = 0; i + 1 < pos.length; i++) if (local < pos[i + 1].l) return [pos[i].at, pos[i + 1].at];
  return [pos[pos.length - 1].at];
}

/** `keys` with the values of the keys at `ats` moved by `dpos` band heights. */
export function shiftKeys(keys: Keyframe[], ats: number[], dpos: number): Keyframe[] {
  return keys.map((k) => (ats.includes(k.at) ? { ...k, value: shiftVolume(k.value, dpos) } : k));
}
