// Canvas renderer for the timeline. Only clips intersecting the viewport are
// drawn, so cost scales with what is visible, not with sequence length.

import { cachedImage, cachedPeaks } from "../lib/media";
import { formatTimecode, fpsOf, timecodeBase } from "../lib/time";
import { isAnimated, localOf, paramAt } from "../lib/keys";
import { labelColor } from "../lib/labels";
import type { Clip, MediaAsset, Sequence, Track, Uuid } from "../lib/types";
import { dbToGain } from "../engine/math";
import { TRANSITIONS } from "../actions/transitions";
import { DIVIDER_H, RULER_H, subLane, transitionInto, type TrackLayout, type TransitionSpan } from "./geometry";

export const COLORS = {
  bg: "#0f0f12",
  laneVideo: "#141418",
  laneAudio: "#121517",
  laneLine: "#1c1c22",
  divider: "#0a0a0c",
  ruler: "#121215",
  rulerText: "#7a7a85",
  tick: "#2c2c34",
  tickMajor: "#44444e",
  signal: "#c8f542",
  video: "#2a3447",
  videoHead: "#222a3a",
  audio: "#1f3836",
  audioHead: "#192e2c",
  still: "#372f45",
  stillHead: "#2d263a",
  wave: "#6cc4b9",
  waveClip: "#ff5a4d",
  text: "#e6e6ea",
  textDim: "#9a9aa4",
  offline: "#ff6b5e",
  inout: "rgba(200,245,66,0.10)",
  marker: { signal: "#c8f542", red: "#ff6b5e", amber: "#f5b544", blue: "#6fb6ff", violet: "#b18cff" },
} as const;

export interface View {
  width: number;
  height: number;
  zoom: number;
  scrollX: number;
  scrollY: number;
}

const NICE_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Tick spacing in frames for the current zoom. `base` is the nominal timecode rate. */
export function tickStep(zoom: number, base: number): { major: number; minor: number } {
  const minPx = 96;
  const subdivide = (major: number) => major / ([10, 5, 4, 2].find((n) => major % n === 0 && (major / n) * zoom >= 8) ?? 1);
  for (const f of [1, 2, 5, 10]) if (f < base && f * zoom >= minPx) return { major: f, minor: subdivide(f) };
  for (const s of NICE_STEPS_S) {
    const frames = s * base;
    if (frames * zoom >= minPx) return { major: frames, minor: subdivide(frames) };
  }
  return { major: 7200 * base, minor: 600 * base };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function drawRuler(ctx: CanvasRenderingContext2D, seq: Sequence, v: View) {
  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(0, 0, v.width, RULER_H);
  // In/out range
  if (seq.inPoint !== null || seq.outPoint !== null) {
    const a = (seq.inPoint ?? 0) * v.zoom - v.scrollX;
    const b = (seq.outPoint ?? Number.MAX_SAFE_INTEGER / 4) * v.zoom - v.scrollX;
    ctx.fillStyle = "rgba(200,245,66,0.16)";
    ctx.fillRect(Math.max(0, a), RULER_H - 8, Math.min(v.width, b) - Math.max(0, a), 8);
    ctx.fillStyle = COLORS.signal;
    if (seq.inPoint !== null && a >= -2 && a <= v.width) ctx.fillRect(a, RULER_H - 8, 2, 8);
    if (seq.outPoint !== null && b >= -2 && b <= v.width) ctx.fillRect(b - 2, RULER_H - 8, 2, 8);
  }
  const { major, minor } = tickStep(v.zoom, timecodeBase(seq.settings.fps));
  const first = Math.floor(v.scrollX / v.zoom / minor) * minor;
  const last = (v.scrollX + v.width) / v.zoom;
  ctx.font = "10px 'JetBrains Mono Variable', monospace";
  ctx.textBaseline = "top";
  for (let f = first; f <= last; f += minor) {
    const x = Math.round(f * v.zoom - v.scrollX) + 0.5;
    const isMajor = Math.abs(f / major - Math.round(f / major)) < 1e-6;
    ctx.fillStyle = isMajor ? COLORS.tickMajor : COLORS.tick;
    ctx.fillRect(x, isMajor ? RULER_H - 12 : RULER_H - 6, 1, isMajor ? 12 : 6);
    if (isMajor) {
      ctx.fillStyle = COLORS.rulerText;
      // A label at the very left edge starts after the playhead head (±6 px), which parks there at frame 0.
      ctx.fillText(formatTimecode(Math.round(f), seq.settings.fps), x >= -1 && x < 6 ? 9 : x + 4, 5);
    }
  }
  // Markers
  for (const m of seq.markers) {
    const x = m.frame * v.zoom - v.scrollX;
    if (x < -8 || x > v.width + 8) continue;
    ctx.fillStyle = COLORS.marker[m.color];
    ctx.beginPath();
    ctx.moveTo(x - 5, RULER_H - 15);
    ctx.lineTo(x + 5, RULER_H - 15);
    ctx.lineTo(x + 5, RULER_H - 8);
    ctx.lineTo(x, RULER_H - 3);
    ctx.lineTo(x - 5, RULER_H - 8);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = COLORS.laneLine;
  ctx.fillRect(0, RULER_H - 1, v.width, 1);
}

/** Subtitle cues in a lane that stays under the ruler while the tracks scroll. */
export function drawSubtitleLane(ctx: CanvasRenderingContext2D, seq: Sequence, v: View, active: Uuid | null) {
  const h = subLane(seq);
  if (!h) return;
  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(0, RULER_H, v.width, h);
  ctx.font = "11px 'Inter Variable', sans-serif";
  ctx.textBaseline = "middle";
  for (const c of seq.subtitles.cues) {
    const x = c.start * v.zoom - v.scrollX;
    const w = (c.end - c.start) * v.zoom;
    if (x + w < 0 || x > v.width) continue;
    const on = c.id === active;
    ctx.fillStyle = on ? "rgba(200,245,66,0.28)" : "rgba(255,255,255,0.09)";
    ctx.fillRect(x + 0.5, RULER_H + 3, Math.max(1, w - 1), h - 6);
    ctx.fillStyle = on ? COLORS.signal : "rgba(255,255,255,0.35)";
    ctx.fillRect(x + 0.5, RULER_H + 3, 1.5, h - 6);
    if (w > 24) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 4, RULER_H, w - 8, h);
      ctx.clip();
      ctx.fillStyle = on ? "#f2f2f4" : "rgba(242,242,244,0.75)";
      ctx.fillText(c.text.replace(/\s*\n\s*/g, " / ") || "…", Math.max(x + 6, 4), RULER_H + h / 2);
      ctx.restore();
    }
  }
  ctx.fillStyle = COLORS.laneLine;
  ctx.fillRect(0, RULER_H + h - 1, v.width, 1);
}

interface DrawContext {
  seq: Sequence;
  media: Map<Uuid, MediaAsset>;
  selection: Set<Uuid>;
  /** Highlighted transition (the clip it leads into). */
  activeTransition: Uuid | null;
  redraw: () => void;
}

export function drawTracks(ctx: CanvasRenderingContext2D, layout: TrackLayout, v: View, d: DrawContext) {
  const { seq } = d;
  const top = RULER_H - v.scrollY;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_H, v.width, v.height - RULER_H);
  ctx.clip();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, RULER_H, v.width, v.height - RULER_H);

  // In/out shading across tracks
  if (seq.inPoint !== null || seq.outPoint !== null) {
    const a = (seq.inPoint ?? 0) * v.zoom - v.scrollX;
    const b = seq.outPoint !== null ? seq.outPoint * v.zoom - v.scrollX : v.width;
    ctx.fillStyle = "rgba(200,245,66,0.025)";
    ctx.fillRect(Math.max(0, a), RULER_H, Math.min(v.width, b) - Math.max(0, a), v.height - RULER_H);
  }

  for (const row of layout.rows) {
    const y = top + row.y;
    if (y > v.height || y + row.h < RULER_H) continue;
    ctx.fillStyle = row.track.kind === "video" ? COLORS.laneVideo : COLORS.laneAudio;
    ctx.fillRect(0, y, v.width, row.h);
    ctx.fillStyle = COLORS.laneLine;
    ctx.fillRect(0, y + row.h - 1, v.width, 1);
    if (row.track.locked) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, v.width, row.h - 1);
      ctx.clip();
      ctx.strokeStyle = "rgba(255,255,255,0.035)";
      ctx.lineWidth = 6;
      for (let x = -row.h; x < v.width; x += 18) {
        ctx.beginPath();
        ctx.moveTo(x, y + row.h);
        ctx.lineTo(x + row.h, y);
        ctx.stroke();
      }
      ctx.restore();
    }
    const f0 = v.scrollX / v.zoom;
    const f1 = (v.scrollX + v.width) / v.zoom;
    const dim = row.track.kind === "video" ? row.track.hidden : row.track.muted;
    const clips = row.track.clips;
    // Clips are sorted and disjoint, so their ends are sorted too: binary-search the first visible one.
    let lo = 0;
    let hi = clips.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (clips[mid].start + clips[mid].duration < f0) lo = mid + 1;
      else hi = mid;
    }
    let i = lo;
    for (; i < clips.length; i++) {
      const c = clips[i];
      if (c.start > f1) break;
      drawClip(ctx, c, row.track, c.start * v.zoom - v.scrollX, y, c.duration * v.zoom, row.h, v, d, dim);
    }
    // Transitions over the cuts, on top of both clips (one more: it can reach back into view).
    for (let j = Math.max(1, lo); j <= Math.min(i, clips.length - 1); j++) {
      const s = transitionInto(row.track, j);
      if (s) drawTransition(ctx, s, y, row.h, v, d.activeTransition === clips[j].id);
    }
  }
  ctx.fillStyle = COLORS.divider;
  ctx.fillRect(0, top + layout.dividerY, v.width, DIVIDER_H);
  ctx.restore();
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  c: Clip,
  track: Track,
  x: number,
  rowY: number,
  w: number,
  rowH: number,
  v: View,
  d: DrawContext,
  dim: boolean,
) {
  const kind = track.kind;
  const asset = d.media.get(c.mediaId);
  const selected = d.selection.has(c.id);
  const still = asset?.kind === "image";
  const y = rowY + 1;
  const h = rowH - 3;
  // Clamp to viewport (keeps huge clips cheap and labels visible).
  const vx = Math.max(x, -4);
  const vw = Math.min(x + w, v.width + 4) - vx;
  if (vw <= 0) return;
  const body = kind === "audio" ? COLORS.audio : still ? COLORS.still : COLORS.video;
  const head = kind === "audio" ? COLORS.audioHead : still ? COLORS.stillHead : COLORS.videoHead;
  // A clip label wins over the track colour.
  const label = labelColor(c.label) ?? labelColor(track.color);
  // Level of detail: sub-pixel clips are one flat rect (no path, clip or images).
  if (w < 3) {
    ctx.globalAlpha = !c.enabled || dim ? 0.45 : 1;
    ctx.fillStyle = selected ? COLORS.signal : (label ?? head);
    ctx.fillRect(vx, y, Math.max(1, vw), h);
    ctx.globalAlpha = 1;
    return;
  }
  const detail = w >= 24;
  ctx.save();
  ctx.globalAlpha = !c.enabled || dim ? 0.45 : 1;
  roundRect(ctx, x + 0.5, y + 0.5, Math.max(1, w - 1), h, 4);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.save();
  ctx.clip();
  const labelH = h >= 30 ? 16 : 0;
  const offline = asset?.status.state === "missing" || asset?.status.state === "error";
  if (offline) {
    ctx.strokeStyle = "rgba(255,107,94,0.35)";
    ctx.lineWidth = 2;
    for (let k = Math.floor(vx / 10) * 10 - h; k < vx + vw; k += 10) {
      ctx.beginPath();
      ctx.moveTo(k, y + h);
      ctx.lineTo(k + h, y);
      ctx.stroke();
    }
  } else if (detail && kind === "video" && asset && h - labelH >= 18) {
    drawFilmstrip(ctx, c, asset, x, vx, vw, y + labelH, h - labelH, v, d);
  } else if (detail && kind === "audio" && asset) {
    drawWave(ctx, c, asset, x, vx, vw, y + labelH, h - labelH, v, d);
  }
  if (labelH) {
    ctx.fillStyle = label ?? head;
    ctx.fillRect(vx, y, vw, labelH);
  }
  // Fades
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  if (c.fadeIn > 0) {
    const fx = x + c.fadeIn * v.zoom;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(fx, y + labelH);
    ctx.lineTo(x, y + labelH);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(fx, y + labelH);
    ctx.stroke();
  }
  if (c.fadeOut > 0) {
    const fx = x + w - c.fadeOut * v.zoom;
    ctx.beginPath();
    ctx.moveTo(x + w, y + h);
    ctx.lineTo(fx, y + labelH);
    ctx.lineTo(x + w, y + labelH);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(fx, y + labelH);
    ctx.lineTo(x + w, y + h);
    ctx.stroke();
  }
  // Keyframes: one diamond per keyed source position along the bottom edge.
  if (detail && h >= 20 && c.keys) {
    const seen = new Set<number>();
    const ky = y + h - 6;
    ctx.fillStyle = "#e7e7ec";
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    for (const list of Object.values(c.keys)) {
      for (const k of list ?? []) {
        if (seen.has(k.at)) continue;
        seen.add(k.at);
        const kx = x + localOf(c, k.at) * v.zoom;
        if (kx < x - 1 || kx > x + w + 1 || kx < vx - 4 || kx > vx + vw + 4) continue;
        ctx.beginPath();
        ctx.moveTo(kx, ky - 3.5);
        ctx.lineTo(kx + 3.5, ky);
        ctx.lineTo(kx, ky + 3.5);
        ctx.lineTo(kx - 3.5, ky);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  // Label
  if (w > 18) {
    ctx.font = "500 11px 'Inter Variable', sans-serif";
    ctx.textBaseline = "middle";
    const tx = Math.max(x + 6, 6);
    let label = c.name;
    if (c.speed !== 1) label += `  ${Math.round(c.speed * 100)} %`;
    if (offline) label = `⚠ ${label} (offline)`;
    ctx.fillStyle = offline ? COLORS.offline : selected ? COLORS.text : "#cfd0d6";
    const maxW = x + w - tx - 6;
    if (maxW > 8) ctx.fillText(fit(ctx, label, maxW), tx, y + (labelH ? labelH / 2 : Math.min(h / 2, 9)) + 0.5);
  }
  ctx.restore();
  // Border
  roundRect(ctx, x + 0.5, y + 0.5, Math.max(1, w - 1), h, 4);
  if (selected) {
    ctx.strokeStyle = COLORS.signal;
    ctx.lineWidth = 1.5;
  } else {
    ctx.strokeStyle = "rgba(255,255,255,0.09)";
    ctx.lineWidth = 1;
  }
  ctx.stroke();
  ctx.restore();
}

/** Box over the frames a transition plays, with a diagonal like a blend. */
function drawTransition(ctx: CanvasRenderingContext2D, s: TransitionSpan, rowY: number, rowH: number, v: View, selected: boolean) {
  const x0 = s.t0 * v.zoom - v.scrollX;
  const x1 = s.t1 * v.zoom - v.scrollX;
  if (x1 < -4 || x0 > v.width + 4) return;
  const w = Math.max(5, x1 - x0);
  const x = x1 - x0 < 5 ? (x0 + x1) / 2 - 2.5 : x0;
  const y = rowY + 1;
  const h = rowH - 3;
  ctx.save();
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h, 3);
  ctx.fillStyle = selected ? "rgba(200,245,66,0.22)" : "rgba(14,14,18,0.55)";
  ctx.fill();
  ctx.strokeStyle = selected ? COLORS.signal : "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + w, y);
  ctx.strokeStyle = selected ? "rgba(200,245,66,0.7)" : "rgba(255,255,255,0.35)";
  ctx.stroke();
  if (w > 44 && h >= 16) {
    ctx.font = "500 10px 'Inter Variable', sans-serif";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#e6e6ea";
    ctx.fillText(fit(ctx, TRANSITIONS.find((t) => t.value === s.kind)?.short ?? "", w - 8), x + 4, y + 3);
  }
  ctx.restore();
}

function fit(ctx: CanvasRenderingContext2D, s: string, w: number): string {
  if (ctx.measureText(s).width <= w) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + "…").width <= w) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + "…" : "";
}

function drawFilmstrip(
  ctx: CanvasRenderingContext2D,
  c: Clip,
  a: MediaAsset,
  x: number,
  vx: number,
  vw: number,
  y: number,
  h: number,
  v: View,
  d: DrawContext,
) {
  const fps = fpsOf(d.seq.settings.fps);
  if (a.kind === "image") {
    const img = a.derived.poster ? cachedImage(a.derived.poster, d.redraw) : null;
    if (!img) return;
    const tw = (h * img.naturalWidth) / img.naturalHeight;
    for (let px = Math.max(x, vx - ((vx - x) % tw)); px < vx + vw; px += tw) ctx.drawImage(img, px, y, tw, h);
    return;
  }
  const strip = a.derived.filmstrip;
  if (!strip) return;
  const img = cachedImage(strip.path, d.redraw);
  if (!img) return;
  const tw = (h * strip.tileWidth) / strip.tileHeight;
  const startSlot = Math.floor((vx - x) / tw);
  for (let i = Math.max(0, startSlot); ; i++) {
    const px = x + i * tw;
    if (px > vx + vw) break;
    const frame = c.start + ((i + 0.5) * tw) / v.zoom;
    const t = (c.sourceIn + (frame - c.start) * c.speed) / fps;
    const tile = Math.max(0, Math.min(strip.tiles - 1, Math.floor(t / strip.interval)));
    const sx = (tile * img.naturalWidth) / strip.tiles;
    ctx.drawImage(img, sx, 0, img.naturalWidth / strip.tiles, img.naturalHeight, px, y, tw, h);
  }
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(vx, y, vw, h);
}

function drawWave(
  ctx: CanvasRenderingContext2D,
  c: Clip,
  a: MediaAsset,
  x: number,
  vx: number,
  vw: number,
  y: number,
  h: number,
  v: View,
  d: DrawContext,
) {
  const p = a.derived.peaks;
  if (!p || h < 6) return;
  const data = cachedPeaks(p.path, d.redraw);
  if (!data) return;
  const fps = fpsOf(d.seq.settings.fps);
  const gain = dbToGain(c.volumeDb);
  const animated = isAnimated(c, "volume");
  const mid = y + h / 2;
  // Columns whose peak exceeds full scale after clip gain: drawn red on top.
  const over: number[] = [];
  ctx.fillStyle = COLORS.wave;
  ctx.globalAlpha *= 0.9;
  const x0 = Math.max(Math.floor(vx), Math.floor(x));
  const x1 = Math.min(Math.ceil(vx + vw), Math.ceil(x + c.duration * v.zoom));
  const perFrame = p.rate / fps;
  for (let px = x0; px < x1; px++) {
    // Source position (in sequence frames) covered by this pixel column.
    const fA = (px - x) / v.zoom;
    const fB = (px + 1 - x) / v.zoom;
    let i0 = Math.floor((c.sourceIn + fA * c.speed) * perFrame);
    let i1 = Math.ceil((c.sourceIn + fB * c.speed) * perFrame);
    i0 = Math.max(0, i0);
    i1 = Math.min(data.length, Math.max(i1, i0 + 1));
    let m = 0;
    const stride = i1 - i0 > 64 ? Math.ceil((i1 - i0) / 64) : 1;
    for (let i = i0; i < i1; i += stride) if (data[i] > m) m = data[i];
    const lin = (m / 255) * (animated ? dbToGain(paramAt(c, "volume", fA)) : gain);
    if (lin > 1) {
      over.push(px);
      continue;
    }
    // Perceptual scale so quiet passages stay visible.
    const amp = Math.sqrt(lin) * (h / 2 - 1);
    if (amp > 0.3) ctx.fillRect(px, mid - amp, 1, amp * 2);
  }
  if (over.length) {
    ctx.fillStyle = COLORS.waveClip;
    for (const px of over) ctx.fillRect(px, y + 1, 1, h - 2);
  }
}
