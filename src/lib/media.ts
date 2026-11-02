// Media access for the webview: URLs, preview source selection, and caches
// for filmstrip images and waveform peaks.

import { convertFileSrc } from "@tauri-apps/api/core";
import type { MediaAsset } from "./types";

export const fileUrl = (path: string) => convertFileSrc(path);

/** Source the preview engine should decode, or null while a proxy is pending. */
export function previewSource(asset: MediaAsset, useProxies: boolean): string | null {
  // Titles are generated PNGs; the browser decodes them directly.
  if (asset.title) return fileUrl(asset.path);
  const { proxy, previewNative } = asset.derived;
  if (proxy && (useProxies || !previewNative)) return fileUrl(proxy);
  if (previewNative) return fileUrl(asset.path);
  return null;
}

const images = new Map<string, HTMLImageElement>();

/** Decoded image (filmstrips, posters) shared by every canvas that draws it. */
export function cachedImage(path: string, onLoad: () => void): HTMLImageElement | null {
  let img = images.get(path);
  if (!img) {
    img = new Image();
    img.decoding = "async";
    img.src = fileUrl(path);
    img.addEventListener("load", onLoad, { once: true });
    images.set(path, img);
    return null;
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

const peaks = new Map<string, Uint8Array | "loading">();

/** Waveform envelope (one byte per 1/rate s), fetched once per file. */
export function cachedPeaks(path: string, onLoad: () => void): Uint8Array | null {
  const hit = peaks.get(path);
  if (hit instanceof Uint8Array) return hit;
  if (!hit) {
    peaks.set(path, "loading");
    fetch(fileUrl(path))
      .then((r) => r.arrayBuffer())
      .then((b) => {
        peaks.set(path, new Uint8Array(b));
        onLoad();
      })
      .catch(() => peaks.delete(path));
  }
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0).replace(".", ",")} ${units[i]}`;
}

export function formatBitrate(bps: number | null | undefined): string {
  if (!bps) return "–";
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1).replace(".", ",")} Mbit/s` : `${Math.round(bps / 1000)} kbit/s`;
}

export function codecLabel(codec: string | undefined): string {
  if (!codec) return "–";
  const map: Record<string, string> = {
    h264: "H.264",
    hevc: "HEVC",
    prores: "ProRes",
    vp9: "VP9",
    vp8: "VP8",
    av1: "AV1",
    aac: "AAC",
    mp3: "MP3",
    opus: "Opus",
    flac: "FLAC",
    mjpeg: "MJPEG",
    png: "PNG",
    dnxhd: "DNxHD",
  };
  if (codec.startsWith("pcm_")) return "PCM";
  return map[codec] ?? codec.toUpperCase();
}

/** Upright pixel size of a visual asset (rotation metadata applied). */
export function displaySize(m: { info: { video: { width: number; height: number; rotation: number } | null } | null } | undefined): [number, number] | null {
  const v = m?.info?.video;
  if (!v) return null;
  return Math.abs(v.rotation) % 180 === 90 ? [v.height, v.width] : [v.width, v.height];
}
