// Text drawing for titles and subtitles. The same Canvas2D code draws the
// preview and the PNGs the export overlays (kerf_media::render), so both show
// identical glyphs, wrapping and outlines.

import { api } from "../lib/ipc";
import { ease } from "../lib/keys";
import type { AnimKind, AnimPhase, AnimUnit, Cue, MediaAsset, Rgb, Sequence, Subtitles, TextAnimation, TextStyle, TitleSpec, Uuid } from "../lib/types";

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
  const weight = style.weight || (style.bold ? 700 : 400);
  return `${style.italic ? "italic " : ""}${weight} ${(style.size * scale).toFixed(2)}px ${family}, "Inter Variable", sans-serif`;
}

const chars = (t: string) => Array.from(t);

export function applyCase(text: string, c: TextStyle["case"]): string {
  return c === "upper" ? text.toLocaleUpperCase("de") : c === "lower" ? text.toLocaleLowerCase("de") : text;
}

/** Width of `t` with `tr` extra pixels after every character but the last. */
function widthOf(ctx: CanvasRenderingContext2D, t: string, tr: number): number {
  const n = chars(t).length;
  return ctx.measureText(t).width + (n > 1 ? tr * (n - 1) : 0);
}

/** Breaks `text` into lines no wider than `max` (long words are split). */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, max: number, tr = 0): string[] {
  const out: string[] = [];
  const w = (t: string) => widthOf(ctx, t, tr);
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const next = line ? `${line} ${word}` : word;
      if (w(next) <= max || !line) {
        line = next;
      } else {
        out.push(line);
        line = word;
      }
      // A single word wider than the line: cut it by characters.
      while (w(line) > max && chars(line).length > 1) {
        const cs = chars(line);
        let n = cs.length - 1;
        while (n > 1 && w(cs.slice(0, n).join("")) > max) n--;
        out.push(cs.slice(0, n).join(""));
        line = cs.slice(n).join("");
      }
    }
    out.push(line);
  }
  return out;
}

/** Where a title animation stands: clip-local frame and clip length. */
export interface AnimTime {
  frame: number;
  duration: number;
}

/** A piece of text that moves as one (character, word or line). */
interface Piece {
  line: number;
  /** Characters with their x offsets from the line start. */
  glyphs: { t: string; x: number }[];
  /** Left edge and width relative to the line start. */
  x: number;
  w: number;
}

function pieces(ctx: CanvasRenderingContext2D, lines: string[], unit: AnimUnit, tr: number): Piece[] {
  const out: Piece[] = [];
  lines.forEach((l, li) => {
    const cs = chars(l);
    const xs = cs.map((_, i) => ctx.measureText(cs.slice(0, i).join("")).width + tr * i);
    const glyph = (i: number) => ({ t: cs[i], x: xs[i] });
    const span = (from: number, to: number): Piece => {
      const x = xs[from] ?? 0;
      const w = to > from ? widthOf(ctx, cs.slice(from, to).join(""), tr) : 0;
      return { line: li, glyphs: Array.from({ length: to - from }, (_, k) => glyph(from + k)), x, w };
    };
    if (unit === "line") out.push(span(0, cs.length));
    else if (unit === "char") cs.forEach((c, i) => c.trim() && out.push(span(i, i + 1)));
    else {
      let i = 0;
      while (i < cs.length) {
        while (i < cs.length && !cs[i].trim()) i++;
        let j = i;
        while (j < cs.length && cs[j].trim()) j++;
        if (j > i) out.push(span(i, j));
        i = j;
      }
    }
  });
  return out;
}

/** Visibility 0..1 of piece `i` of `n` from one phase (intro: 0 before, 1 after). */
function phaseK(p: AnimPhase, f: number, start: number): number {
  if (p.kind === "typewriter") return f >= start ? 1 : 0;
  return ease(p.ease, (f - start) / Math.max(1, p.frames));
}

/** Opacity, offset and scale of piece `i` of `n` at `t`. */
export function pieceState(a: TextAnimation, i: number, n: number, t: AnimTime, size: number, center: number) {
  let alpha = 1,
    dx = 0,
    dy = 0,
    scale = 1;
  const apply = (kind: AnimKind, k: number) => {
    if (kind === "none") return;
    alpha *= k;
    const d = 1 - k;
    if (kind === "slideUp") dy += d * 0.5 * size;
    else if (kind === "slideDown") dy -= d * 0.5 * size;
    else if (kind === "slideLeft") dx += d * 0.6 * size;
    else if (kind === "slideRight") dx -= d * 0.6 * size;
    else if (kind === "scale") scale *= k;
    else if (kind === "spread") dx += d * (i - center) * 0.3 * size;
  };
  if (a.intro.kind !== "none") apply(a.intro.kind, phaseK(a.intro, t.frame, i * a.intro.stagger));
  if (a.outro.kind !== "none") {
    const start = t.duration - a.outro.frames - (n - 1 - i) * a.outro.stagger;
    // Played backwards: fully shown before its start, gone at the end.
    const k = a.outro.kind === "typewriter" ? (t.frame >= start + a.outro.frames ? 0 : 1) : 1 - ease(a.outro.ease, (t.frame - start) / Math.max(1, a.outro.frames));
    apply(a.outro.kind, k);
  }
  return { alpha: Math.max(0, Math.min(1, alpha)), dx, dy, scale };
}

/**
 * Draws a text block on a W × H canvas. `at` places the block (0..1 of the
 * frame): x is its left edge, centre or right edge by the alignment, y its
 * vertical centre. Subtitles give the distance of the bottom edge from the
 * frame bottom (0..1 of the height) and are centred. With `anim` and an
 * animation, pieces are drawn one by one in their state at that frame.
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  s: TextStyle,
  W: number,
  H: number,
  at: { x: number; y: number } | { bottom: number },
  animation?: TextAnimation,
  anim?: AnimTime,
) {
  const k = H / 1080;
  const text = applyCase(rawText, s.case);
  const tr = (s.tracking ?? 0) * k;
  ctx.font = fontOf(s, k);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const lines = wrapLines(ctx, text, s.wrap * W, tr);
  const lineH = s.size * k * s.lineHeight;
  const widths = lines.map((l) => widthOf(ctx, l, tr));
  const blockW = Math.max(0, ...widths);
  const blockH = lines.length * lineH;
  const ax = "x" in at ? at.x * W : W / 2;
  const top = "x" in at ? at.y * H - blockH / 2 : H * (1 - at.bottom) - blockH;
  const left = !("x" in at) || s.align === "center" ? ax - blockW / 2 : s.align === "left" ? ax : ax - blockW;
  const cx = left + blockW / 2;
  const xs = widths.map((w) => (s.align === "left" ? left : s.align === "right" ? left + blockW - w : cx - w / 2));
  const ys = lines.map((_, i) => top + (i + 0.5) * lineH);
  const animated = !!animation && !!anim && (animation.intro.kind !== "none" || animation.outro.kind !== "none");
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
  let fill: string | CanvasGradient = css(s.color);
  if (s.gradient) {
    const a = ((s.gradientAngle ?? 90) * Math.PI) / 180;
    const [hx, hy] = [(Math.cos(a) * blockW) / 2, (Math.sin(a) * blockH) / 2];
    const cy = top + blockH / 2;
    const g = ctx.createLinearGradient(cx - hx, cy - hy, cx + hx, cy + hy);
    g.addColorStop(0, css(s.color));
    g.addColorStop(1, css(s.gradient));
    fill = g;
  }
  // Everything drawn for one run of text (a line, a piece or a glyph) in the right order.
  const passes = (draw: (mode: "stroke" | "fill") => void) => {
    if ((s.glow ?? 0) > 0) {
      ctx.save();
      ctx.shadowColor = css(s.glowColor ?? [1, 1, 1], 1);
      ctx.shadowBlur = (s.glow ?? 0) * k;
      ctx.fillStyle = fill;
      draw("fill");
      ctx.restore();
    }
    ctx.save();
    if (s.shadow > 0 || (s.shadowOffset && (s.shadowOffset[0] || s.shadowOffset[1]))) {
      ctx.shadowColor = css(s.shadowColor ?? [0, 0, 0], s.shadowOpacity ?? 0.75);
      ctx.shadowBlur = s.shadow * k;
      const off = s.shadowOffset;
      ctx.shadowOffsetX = off ? off[0] * k : 0;
      ctx.shadowOffsetY = off ? off[1] * k : s.shadow * k * 0.4;
    }
    if (s.outline > 0) {
      ctx.lineJoin = "round";
      ctx.lineWidth = s.outline * 2 * k;
      ctx.strokeStyle = css(s.outlineColor);
      draw("stroke");
      // The outline already casts the shadow.
      ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = fill;
    draw("fill");
    ctx.restore();
  };
  const run = (mode: "stroke" | "fill", t: string, x: number, y: number) => (mode === "stroke" ? ctx.strokeText(t, x, y) : ctx.fillText(t, x, y));

  if (!animated) {
    if (!tr) passes((m) => lines.forEach((l, i) => run(m, l, xs[i], ys[i])));
    else {
      const ps = pieces(ctx, lines, "char", tr);
      passes((m) => ps.forEach((p) => p.glyphs.forEach((g) => run(m, g.t, xs[p.line] + g.x, ys[p.line]))));
    }
    return;
  }
  const ps = pieces(ctx, lines, animation!.unit, tr);
  const n = ps.length;
  ps.forEach((p, i) => {
    const st = pieceState(animation!, i, n, anim!, s.size * k, (n - 1) / 2);
    if (st.alpha <= 0 || st.scale <= 0) return;
    const ox = xs[p.line] + p.x + p.w / 2;
    const oy = ys[p.line];
    ctx.save();
    ctx.globalAlpha = st.alpha;
    ctx.translate(ox + st.dx, oy + st.dy);
    ctx.scale(st.scale, st.scale);
    passes((m) => (tr || p.glyphs.length === 1 ? p.glyphs.forEach((g) => run(m, g.t, g.x - p.x - p.w / 2, 0)) : run(m, p.glyphs.map((g) => g.t).join(""), -p.w / 2, 0)));
    ctx.restore();
  });
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

/** Drops every cached drawing (a font was added or removed) and redraws. */
export function invalidateText() {
  cache.clear();
  onFontLoaded?.();
}

/** Starts loading the font of `style` if needed; redraws once it arrived. */
function ensureFont(style: TextStyle) {
  const font = fontOf(style, 1);
  if (!document.fonts.check(font) && !waiting.has(font)) {
    waiting.add(font);
    void document.fonts.load(font).then(() => {
      waiting.delete(font);
      for (const k of [...cache.keys()]) if (k.includes(style.font)) cache.delete(k);
      onFontLoaded?.();
    });
  }
}

/** Draws with `draw` once per key; redraws when a missing font arrives. */
function cached(key: string, style: TextStyle, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  let c = cache.get(key);
  if (c) {
    cache.delete(key);
    cache.set(key, c); // most recently used last
    return c;
  }
  ensureFont(style);
  c = canvas(w, h);
  draw(c.getContext("2d")!);
  cache.set(key, c);
  while (cache.size > 24) cache.delete(cache.keys().next().value!);
  return c;
}

export const isAnimated = (spec: TitleSpec) => !!spec.animation && (spec.animation.intro.kind !== "none" || spec.animation.outro.kind !== "none");

/** One canvas per animated title clip, redrawn every frame. */
const animCanvases = new Map<string, HTMLCanvasElement>();

/** The title as a transparent canvas of its own size; animated titles at `t` (drawn into the canvas of `key`). */
export function titleCanvas(spec: TitleSpec, t?: AnimTime, key = ""): HTMLCanvasElement {
  if (t && isAnimated(spec)) {
    ensureFont(spec.style);
    let c = animCanvases.get(key);
    if (!c || c.width !== spec.width || c.height !== spec.height) {
      c = canvas(spec.width, spec.height);
      animCanvases.set(key, c);
      while (animCanvases.size > 32) animCanvases.delete(animCanvases.keys().next().value!);
    }
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    drawText(ctx, spec.text, spec.style, spec.width, spec.height, spec, spec.animation, t);
    return c;
  }
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

/**
 * Frames of every animated title clip in `seq` (source frames 0 to the clip's
 * end), drawn with the preview's code. Between the intro's end and the
 * outro's start the picture does not change and is drawn once.
 */
export async function titleSequences(seq: Sequence, media: Map<Uuid, MediaAsset>, onProgress?: (done: number, total: number) => void): Promise<Record<Uuid, string[]>> {
  const jobs = seq.tracks.flatMap((t) => t.clips.map((c) => ({ c, spec: media.get(c.mediaId)?.title })).filter((x): x is { c: typeof x.c; spec: TitleSpec } => !!x.spec && isAnimated(x.spec)));
  const total = jobs.reduce((n, j) => n + j.c.sourceIn + j.c.duration, 0);
  const out: Record<Uuid, string[]> = {};
  let done = 0;
  for (const { c, spec } of jobs) {
    const count = c.sourceIn + c.duration;
    const a = spec.animation!;
    const n = Math.max(1, chars(spec.text).length);
    const introEnd = a.intro.kind === "none" ? 0 : (n - 1) * a.intro.stagger + a.intro.frames + 1;
    const outroStart = a.outro.kind === "none" ? count : count - a.outro.frames - (n - 1) * a.outro.stagger - 1;
    const frames: string[] = [];
    let still: string | null = null;
    for (let i = 0; i < count; i++) {
      if (i > introEnd && i < outroStart && still) frames.push(still);
      else {
        const path = await storePng((ctx) => drawText(ctx, spec.text, spec.style, spec.width, spec.height, spec, a, { frame: i, duration: count }), spec.width, spec.height, spec.style);
        if (i > introEnd && i < outroStart) still = path;
        frames.push(path);
      }
      onProgress?.(++done, total);
    }
    out[c.id] = frames;
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

