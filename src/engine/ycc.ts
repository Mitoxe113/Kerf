// Y'CbCr matrix of a video in the preview (kerf_core VideoInfo::tagged_ycc,
// webview_ycc, read_ycc). The WebView does not always decode with the matrix
// of the tag (measured in Chromium, see webviewYcc). When the picture is read
// with another matrix (the user's choice, or what the original shows while
// its proxy plays), the decoded R'G'B' is converted back to Y'PbPr with the
// WebView's matrix and forward with the one read: a 3x3 matrix, because both
// sides use the same range.

import type { MatrixChoice, MediaAsset, VideoInfo } from "../lib/types";
import type { Mat3 } from "./math";

export type Ycc = "bt601" | "bt709";

const KR_KB: Record<Ycc, [number, number]> = { bt601: [0.299, 0.114], bt709: [0.2126, 0.0722] };

/** Matrix of the tag as FFmpeg reads it: null = untagged, undefined = another matrix (e.g. BT.2020). */
export function taggedYcc(v: VideoInfo): Ycc | null | undefined {
  const s = v.color?.space;
  if (!s) return null;
  if (s === "bt709") return "bt709";
  if (s === "smpte170m" || s === "bt470bg") return "bt601";
  return undefined;
}

/**
 * Matrix the WebView decodes with, undefined for another matrix. `original`:
 * it decodes the original file, else its H.264 proxy (same tags, at most 720
 * lines). Measured in Chromium: VP9 honours a matrix tag on its own, H.264,
 * VP8 and AV1 only with primaries and transfer tagged too. Without a valid
 * tag VP9 and AV1 decode as BT.601, H.264 and VP8 as BT.709 from 720 lines up.
 */
export function webviewYcc(v: VideoInfo, original: boolean): Ycc | undefined {
  const codec = original ? v.codec : "h264";
  const c = v.color;
  if (c?.space && (codec === "vp9" || (c.primaries && c.transfer))) return taggedYcc(v) ?? undefined;
  const lines = original ? v.height : Math.min(720, ((v.rotation % 180) + 180) % 180 === 90 ? v.width : v.height);
  if (codec === "vp9" || codec === "av1") return "bt601";
  return lines >= 720 ? "bt709" : "bt601";
}

/** Matrix the picture is read with: the user's choice where the tag allows one, else what the preview shows by default. */
export function readYcc(v: VideoInfo, choice: MatrixChoice | undefined, previewNative: boolean): Ycc | undefined {
  if (taggedYcc(v) === undefined || !choice || choice === "auto") return webviewYcc(v, previewNative);
  return choice;
}

/** WebView matrix and matrix read for a video asset, or null when they agree. */
function fixPair(asset: MediaAsset | null | undefined, playsOriginal: boolean): [Ycc, Ycc] | null {
  const v = asset?.kind === "video" && !asset.title ? asset.info?.video : null;
  if (!v) return null;
  const [from, to] = [webviewYcc(v, playsOriginal), readYcc(v, asset!.matrix, asset!.derived.previewNative)];
  return from && to && from !== to ? [from, to] : null;
}

type M = number[]; // row-major 3x3
const mul = (a: M, b: M): M =>
  Array.from({ length: 9 }, (_, i) => {
    const [r, c] = [Math.floor(i / 3), i % 3];
    return a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
  });

/** R'G'B' -> Y'PbPr. */
function toYpbpr([kr, kb]: [number, number]): M {
  const kg = 1 - kr - kb;
  return [kr, kg, kb, -kr / (2 * (1 - kb)), -kg / (2 * (1 - kb)), 0.5, 0.5, -kg / (2 * (1 - kr)), -kb / (2 * (1 - kr))];
}

/** Y'PbPr -> R'G'B'. */
function fromYpbpr([kr, kb]: [number, number]): M {
  const kg = 1 - kr - kb;
  return [1, 0, 2 * (1 - kr), 1, (-2 * kb * (1 - kb)) / kg, (-2 * kr * (1 - kr)) / kg, 1, 2 * (1 - kb), 0];
}

/** Row-major matrix taking R'G'B' decoded with `from` to R'G'B' decoded with `to`. */
export function yccFixRows(from: Ycc, to: Ycc): number[] {
  return mul(fromYpbpr(KR_KB[to]), toYpbpr(KR_KB[from]));
}

/**
 * Column-major correction for the compositor, or null when the WebView
 * already decodes with the matrix read. `playsOriginal`: the original file
 * plays, not its proxy (lib/media playsOriginal).
 */
export function yccFix(asset: MediaAsset | null | undefined, playsOriginal: boolean): Mat3 | null {
  const pair = fixPair(asset, playsOriginal);
  if (!pair) return null;
  const r = yccFixRows(...pair);
  return Float32Array.from([r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]]);
}

/**
 * The same correction for a plain <video> (source monitor, multicam angles):
 * an SVG colour matrix on the gamma-encoded values (sRGB interpolation),
 * clipped to 0..1 like the shader. Null when no correction is needed.
 */
export function yccFilterValues(asset: MediaAsset | null | undefined, playsOriginal: boolean): string | null {
  const pair = fixPair(asset, playsOriginal);
  if (!pair) return null;
  const r = yccFixRows(...pair).map((x) => +x.toFixed(6));
  return `${r[0]} ${r[1]} ${r[2]} 0 0 ${r[3]} ${r[4]} ${r[5]} 0 0 ${r[6]} ${r[7]} ${r[8]} 0 0 0 0 0 1 0`;
}
