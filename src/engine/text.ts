// Text drawing for titles and subtitles. The same Canvas2D code draws the
// preview and the PNGs the export overlays (kerf_media::render), so both show
// identical glyphs, wrapping and outlines.

import { api } from "../lib/ipc";
import type { Cue, MediaAsset, Rgb, Sequence, Subtitles, TextStyle, TitleSpec, Uuid } from "../lib/types";

/** Families offered in the editor (CSS names; the first two ship with Kerf). */
export const FONTS: { label: string; css: string }[] = [
  { label: "Inter", css: "Inter Variable" },
  { label: "JetBrains Mono", css: "JetBrains Mono Variable" },
  { label: "Arial", css: "Arial" },
  { label: "Verdana", css: "Verdana" },
  { label: "Georgia", css: "Georgia" },
  { label: "Times New Roman", css: "Times New Roman" },
  { label: "Impact", css: "Impact" },
  { label: "Courier New", css: "Courier New" },
];

/** Same values as kerf_core::text::TextStyle::default(). */
export const TITLE_STYLE: TextStyle = {
  font: "Inter Variable",
  size: 96,
  bold: true,
  italic: false,
  color: [1, 1, 1],
  align: "center",
  lineHeight: 1.2,
  outline: 0,
  outlineColor: [0, 0, 0],
  shadow: 0,
  boxOpacity: 0,
  boxColor: [0, 0, 0],
  boxPadding: 16,
  wrap: 0.9,
};

/** Same values as kerf_core::text::Subtitles::default(). */
export const NO_SUBTITLES: Subtitles = {
  cues: [],
  style: { ...TITLE_STYLE, size: 48, bold: false, outline: 3, shadow: 4, wrap: 0.8 },
  margin: 0.08,
  visible: true,
};

const css = (c: Rgb, a = 1) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;

/** CSS font shorthand for `style` at `scale` (frame height / 1080). */
export function fontOf(style: TextStyle, scale = 1): string {
  const family = style.font.includes(" ") ? `"${style.font.replace(/"/g, "")}"` : style.font;
  return `${style.italic ? "italic " : ""}${style.bold ? 700 : 400} ${(style.size * scale).toFixed(2)}px ${family}, "Inter Variable", sans-serif`;
}

/** Breaks `text` into lines no wider than `max` (long words are split). */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= max || !line) {
        line = next;
      } else {
        out.push(line);
        line = word;
      }
      // A single word wider than the line: cut it by characters.
      while (ctx.measureText(line).width > max && line.length > 1) {
        let n = line.length - 1;
        while (n > 1 && ctx.measureText(line.slice(0, n)).width > max) n--;
        out.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Draws a text block on a W × H canvas. `at` places the block (0..1 of the
 * frame): x is its left edge, centre or right edge by the alignment, y its
 * vertical centre. Subtitles give the distance of the bottom edge from the
 * frame bottom (0..1 of the height) and are centred.
 */
export function drawText(ctx: CanvasRenderingContext2D, text: string, s: TextStyle, W: number, H: number, at: { x: number; y: number } | { bottom: number }) {
  const k = H / 1080;
  ctx.font = fontOf(s, k);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const lines = wrapLines(ctx, text, s.wrap * W);
  const lineH = s.size * k * s.lineHeight;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(0, ...widths);
  const blockH = lines.length * lineH;
  const ax = "x" in at ? at.x * W : W / 2;
  const top = "x" in at ? at.y * H - blockH / 2 : H * (1 - at.bottom) - blockH;
  const left = !("x" in at) || s.align === "center" ? ax - blockW / 2 : s.align === "left" ? ax : ax - blockW;
  const cx = left + blockW / 2;
  const xs = widths.map((w) => (s.align === "left" ? left : s.align === "right" ? left + blockW - w : cx - w / 2));
  if (s.boxOpacity > 0) {
    // One path for all line boxes: overlaps are filled once.
    const p = s.boxPadding * k;
    ctx.beginPath();
    lines.forEach((l, i) => {
      if (l.trim()) ctx.rect(xs[i] - p, top + i * lineH - p / 2, widths[i] + 2 * p, lineH + p);
    });
    ctx.fillStyle = css(s.boxColor, s.boxOpacity);
    ctx.fill();
  }
  ctx.save();
  if (s.shadow > 0) {
    ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
    ctx.shadowBlur = s.shadow * k;
    ctx.shadowOffsetY = s.shadow * k * 0.4;
  }
  const ys = lines.map((_, i) => top + (i + 0.5) * lineH);
  if (s.outline > 0) {
    ctx.lineJoin = "round";
    ctx.lineWidth = s.outline * 2 * k;
    ctx.strokeStyle = css(s.outlineColor);
    lines.forEach((l, i) => ctx.strokeText(l, xs[i], ys[i]));
    // The outline already casts the shadow.
    ctx.shadowColor = "transparent";
  }
  ctx.fillStyle = css(s.color);
  lines.forEach((l, i) => ctx.fillText(l, xs[i], ys[i]));
  ctx.restore();
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// --- preview canvases ------------------------------------------------------------

const cache = new Map<string, HTMLCanvasElement>();
const waiting = new Set<string>();
let onFontLoaded: (() => void) | null = null;

/** Called when a font used by a cached drawing finished loading (redraw). */
export function setFontListener(fn: () => void) {
  onFontLoaded = fn;
}

/** Draws with `draw` once per key; redraws when a missing font arrives. */
function cached(key: string, style: TextStyle, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  let c = cache.get(key);
  if (c) {
    cache.delete(key);
    cache.set(key, c); // most recently used last
    return c;
  }
  const font = fontOf(style, 1);
  if (!document.fonts.check(font) && !waiting.has(font)) {
    waiting.add(font);
    void document.fonts.load(font).then(() => {
      waiting.delete(font);
      for (const k of [...cache.keys()]) if (k.includes(style.font)) cache.delete(k);
      onFontLoaded?.();
    });
  }
  c = canvas(w, h);
  draw(c.getContext("2d")!);
  cache.set(key, c);
  while (cache.size > 24) cache.delete(cache.keys().next().value!);
  return c;
}

/** The title as a transparent canvas of its own size. */
export function titleCanvas(spec: TitleSpec): HTMLCanvasElement {
  return cached(`t:${JSON.stringify(spec)}`, spec.style, spec.width, spec.height, (ctx) => drawText(ctx, spec.text, spec.style, spec.width, spec.height, spec));
}

/** One subtitle cue as a transparent canvas of the sequence size. */
export function cueCanvas(cue: Cue, subs: Subtitles, W: number, H: number): HTMLCanvasElement {
  return cached(`c:${W}x${H}:${cue.text}:${JSON.stringify(subs.style)}:${subs.margin}`, subs.style, W, H, (ctx) =>
    drawText(ctx, cue.text, subs.style, W, H, { bottom: subs.margin }),
  );
}

/** The cue shown at `frame`, if any (cues are sorted and do not overlap). */
export function cueAt(subs: Subtitles | undefined, frame: number): Cue | null {
  const cues = subs?.cues ?? [];
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid];
    if (frame < c.start) hi = mid - 1;
    else if (frame >= c.end) lo = mid + 1;
    else return c;
  }
  return null;
}

// --- files for the export -----------------------------------------------------------

async function storePng(draw: (ctx: CanvasRenderingContext2D) => void, w: number, h: number, style: TextStyle | null): Promise<string> {
  if (style) await document.fonts.load(fontOf(style, 1));
  const c = canvas(w, h);
  draw(c.getContext("2d")!);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("PNG konnte nicht erzeugt werden");
  return api.titlePng(new Uint8Array(await blob.arrayBuffer()));
}

/** Renders a title to its PNG in the cache and returns the path. */
export const storeTitle = (spec: TitleSpec) => storePng((ctx) => drawText(ctx, spec.text, spec.style, spec.width, spec.height, spec), spec.width, spec.height, spec.style);

/**
 * Draws every title used in `seq` for the export. Files are named by content,
 * so unchanged titles cost one draw; a stored PNG that is missing or came from
 * older drawing code is never used.
 */
export async function titleFiles(seq: Sequence, media: Map<Uuid, MediaAsset>): Promise<Record<Uuid, string>> {
  const out: Record<Uuid, string> = {};
  for (const t of seq.tracks) {
    for (const c of t.clips) {
      const a = media.get(c.mediaId);
      if (a?.title && !(a.id in out)) out[a.id] = await storeTitle(a.title);
    }
  }
  return out;
}

/** Cue images and the blank frame for burning the subtitles of `seq` in. */
export async function burnInFiles(seq: Sequence, range: [number, number]): Promise<{ burn: { start: number; end: number; path: string }[]; blank: string }> {
  const { width: W, height: H } = seq.settings;
  const subs = seq.subtitles;
  const burn = [];
  for (const c of subs.cues) {
    if (c.end <= range[0] || c.start >= range[1] || !c.text.trim()) continue;
    const path = await storePng((ctx) => drawText(ctx, c.text, subs.style, W, H, { bottom: subs.margin }), W, H, subs.style);
    burn.push({ start: c.start, end: c.end, path });
  }
  const blank = await storePng(() => {}, W, H, null);
  return { burn, blank };
}

