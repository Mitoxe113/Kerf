// Effect stack of the preview compositor. Every effect mirrors the FFmpeg
// filters the export uses (crates/kerf-media/src/render.rs, effect_filters):
//
//   blur        separable Gaussian            <-> gblur
//   sharpen     in + k·(in − blur(in))        <-> split, gblur, blend expr
//   vignette    cos⁴ of the normalised radius <-> vignette on a white copy, multiplied
//   lut         3D texture, trilinear, mixed  <-> lut3d interp=trilinear, blend
//   chromaKey   mean U/V distance in 3×3      <-> chromakey (BT.601, limited) + despill
//   colorWheels (in·(gain−lift)+lift)^(1/γ)   <-> lutrgb
//   curves      PCHIP tables, master last     <-> curves interp=pchip
//
// Passes run at the clip's fitted size (sequence pixels at scale 1, times the
// canvas scale) in RGBA8 framebuffers with straight alpha, as FFmpeg does.

import { keysValue } from "../lib/keys";
import type { Clip, CurvePoint, Effect, EffectKind } from "../lib/types";
import { FX_SHADERS, fxDef, fxIsIdentity, fxKeys, fxMatrix, fxReader, glowFn, toneFns, toneTable, toneTexture } from "./fx";

export const isIdentityEffect = (e: EffectKind): boolean => {
  switch (e.type) {
    case "blur":
      return e.radius <= 0;
    case "sharpen":
      return e.amount <= 0 || e.radius <= 0;
    case "vignette":
      return e.amount <= 0;
    case "lut":
      return e.intensity <= 0;
    case "chromaKey":
      return false;
    case "colorWheels":
      return e.lift.every((v) => v === 0) && [...e.gamma, ...e.gain].every((v) => v === 1);
    case "curves":
      return [e.master, e.red, e.green, e.blue].every(curveIsIdentity);
    case "fx":
      return fxIsIdentity(e.fx, e.params);
    case "polygonMask":
      return false;
  }
};

export const curveIsIdentity = (c: CurvePoint[]) => c.length < 2 || c.every(([x, y]) => Math.abs(x - y) < 1e-6);
/** Enabled effects that change the picture; animated ones always count (kerf_core Clip::active_effects). */
export const activeEffects = (effects: Effect[] | undefined, bypass = false) =>
  bypass ? [] : (effects ?? []).filter((e) => e.enabled && (effectHasKeys(e) || !isIdentityEffect(e)));

// --- animated parameters (kerf_core Effect::keys) -------------------------------------

/** Most points of a freeform mask (kerf_core MAX_MASK_POINTS). */
export const MAX_MASK_POINTS = 32;

export const effectHasKeys = (e: Effect) => Object.values(e.keys ?? {}).some((k) => k && k.length > 0);

/** Range of parameter `key` when it can be animated (kerf_core EffectKind::animatable). */
export function effectAnimatable(e: EffectKind, key: string): [number, number] | null {
  switch (e.type) {
    case "blur":
      return key === "radius" ? [0, 250] : null;
    case "vignette":
      return key === "amount" ? [0, 1] : null;
    case "polygonMask":
      return key === "x" || key === "y" ? [-1, 1] : null;
    case "fx": {
      const d = fxDef(e.fx);
      if (!d?.animated.includes(key)) return null;
      const p = d.params.find((x) => fxKeys(x).includes(key));
      return p ? [p.min, p.max] : null;
    }
    default:
      return null;
  }
}

/** Static value of animatable parameter `key`. */
export function effectValue(e: EffectKind, key: string): number {
  switch (e.type) {
    case "blur":
      return e.radius;
    case "vignette":
      return e.amount;
    case "polygonMask":
      return key === "x" ? e.x : key === "y" ? e.y : 0;
    case "fx":
      return fxReader(e.fx, e.params).get(key);
    default:
      return 0;
  }
}

/** `e` with animatable parameter `key` set to `v` (kerf_core EffectKind::set_value). */
export function withEffectValue(e: Effect, key: string, v: number): Effect {
  switch (e.type) {
    case "blur":
      return key === "radius" ? { ...e, radius: v } : e;
    case "vignette":
      return key === "amount" ? { ...e, amount: v } : e;
    case "polygonMask":
      return key === "x" ? { ...e, x: v } : key === "y" ? { ...e, y: v } : e;
    case "fx":
      return { ...e, params: { ...e.params, [key]: v } };
    default:
      return e;
  }
}

/** Effect `e` of clip `c` with its animated parameters at clip-local frame `local` (Clip::effect_at). */
export function effectAt(c: Clip, e: Effect, local: number): Effect {
  let out = e;
  for (const [key, keys] of Object.entries(e.keys ?? {})) if (keys && keys.length) out = withEffectValue(out, key, keysValue(c, keys, 0, local));
  return out;
}

/** Whole-pixel shift of a mask moved by `v` of a `size`-pixel frame (kerf_media::render::mask_shift). */
export const maskShift = (v: number, size: number) => Math.floor(Math.fround(v) * size + 0.5);

// Freeform mask raster, the same arithmetic as kerf_media::mask (f32 inputs
// widened to f64, integer crossing test on a 1/256 px grid), so preview and
// export produce the same image.
const GRID = 256;

/** Outline in 1/256 px of a w×h frame (kerf_media::mask::outline without a move). */
export function maskOutline(points: [number, number][], w: number, h: number): [number, number][] {
  return points.slice(0, MAX_MASK_POINTS).map(([x, y]) => [Math.floor(Math.fround(x) * w * GRID + 0.5), Math.floor(Math.fround(y) * h * GRID + 0.5)]);
}

/** Mask value 0..1 at pixel (x, y) of an outline in 1/256 px (kerf_media::mask::coverage). */
export function maskCoverage(pts: [number, number][], feather: number, x: number, y: number): number {
  const [gx, gy] = [x * GRID, y * GRID];
  const n = pts.length;
  let inside = false;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % n];
    if (ay > gy !== by > gy) {
      const l = (gx - ax) * (by - ay);
      const r = (gy - ay) * (bx - ax);
      if ((by > ay && l < r) || (by < ay && l > r)) inside = !inside;
    }
  }
  if (!inside) return 0;
  if (feather <= 0) return 1;
  let d2 = Infinity;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = [pts[i][0] / GRID, pts[i][1] / GRID];
    const [bx, by] = [pts[(i + 1) % n][0] / GRID, pts[(i + 1) % n][1] / GRID];
    const [dx, dy] = [bx - ax, by - ay];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const [ex, ey] = [x - ax - t * dx, y - ay - t * dy];
    d2 = Math.min(d2, ex * ex + ey * ey);
  }
  return Math.min(1, Math.max(0, Math.sqrt(d2) / feather));
}

/** The unmoved 8-bit mask of a w×h frame, rows from the top (kerf_media::mask::pixels). */
export function maskPixels(points: [number, number][], feather: number, invert: boolean, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h).fill(invert ? 255 : 0);
  const pts = maskOutline(points, w, h);
  if (pts.length < 3) return out;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const lo = (v: number) => Math.max(0, Math.floor(v / GRID));
  const hi = (v: number, n: number) => Math.min(n, Math.max(0, Math.floor((v + GRID - 1) / GRID)));
  const f = Math.fround(feather);
  for (let y = lo(Math.min(...ys)); y < hi(Math.max(...ys), h); y++)
    for (let x = lo(Math.min(...xs)); x < hi(Math.max(...xs), w); x++) {
      const v = Math.floor(maskCoverage(pts, f, x, y) * 255 + 0.5);
      out[y * w + x] = invert ? 255 - v : v;
    }
  return out;
}

// --- curves (same algorithm as FFmpeg's vf_curves interp=pchip) ----------------------

function pchipEdge(h0: number, h1: number, m0: number, m1: number): number {
  let d = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
  if (Math.sign(d) !== Math.sign(m0)) d = 0;
  else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(d) > 3 * Math.abs(m0)) d = 3 * m0;
  return d;
}

/** 8-bit lookup table of a tone curve; flat before the first and after the last point. */
export function curveTable(points: CurvePoint[]): Uint8Array {
  const lut = new Uint8Array(256);
  if (curveIsIdentity(points)) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const h: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(p[i + 1][0] - p[i][0]);
    m.push((p[i + 1][1] - p[i][1]) / h[i]);
  }
  const d = new Array<number>(n).fill(0);
  if (n === 2) {
    d[0] = d[1] = m[0];
  } else {
    for (let k = 1; k < n - 1; k++) {
      if (Math.sign(m[k - 1]) !== Math.sign(m[k]) || Math.abs(m[k]) < 1e-12 || Math.abs(m[k - 1]) < 1e-12) d[k] = 0;
      else {
        const w1 = 2 * h[k] + h[k - 1];
        const w2 = h[k] + 2 * h[k - 1];
        d[k] = (w1 + w2) / (w1 / m[k - 1] + w2 / m[k]);
      }
    }
    d[0] = pchipEdge(h[0], h[1], m[0], m[1]);
    d[n - 1] = pchipEdge(h[n - 2], h[n - 3], m[n - 2], m[n - 3]);
  }
  const clip = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255)));
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let y: number;
    if (x <= p[0][0]) y = p[0][1];
    else if (x >= p[n - 1][0]) y = p[n - 1][1];
    else {
      let k = 0;
      while (x > p[k + 1][0]) k++;
      const t = (x - p[k][0]) / h[k];
      const t2 = t * t;
      const t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * p[k][1] + (t3 - 2 * t2 + t) * h[k] * d[k] + (-2 * t3 + 3 * t2) * p[k + 1][1] + (t3 - t2) * h[k] * d[k + 1];
    }
    lut[i] = clip(y);
  }
  return lut;
}

/** RGBA table (256 × 1): each channel's curve followed by the master curve. */
export function curvesTexture(e: Extract<EffectKind, { type: "curves" }>): Uint8Array {
  const master = curveTable(e.master);
  const ch = [curveTable(e.red), curveTable(e.green), curveTable(e.blue)];
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = master[ch[c][i]];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// --- 3D LUTs ------------------------------------------------------------------------

export interface Cube {
  size: number;
  min: [number, number, number];
  max: [number, number, number];
  /** RGB triples, red fastest (the .cube order and the 3D texture's x axis). */
  data: Float32Array;
}

/** Parses an Adobe/Resolve `.cube` 3D LUT. */
export function parseCube(text: string): Cube {
  let size = 0;
  let min: [number, number, number] = [0, 0, 0];
  let max: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === "LUT_3D_SIZE") size = parseInt(parts[1], 10);
    else if (key === "DOMAIN_MIN") min = [+parts[1], +parts[2], +parts[3]];
    else if (key === "DOMAIN_MAX") max = [+parts[1], +parts[2], +parts[3]];
    else if (key === "LUT_1D_SIZE") throw new Error("1D-LUTs werden nicht unterstützt");
    else if (/^[-+.\d]/.test(key) && parts.length >= 3) values.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!(size >= 2 && size <= 256)) throw new Error("LUT_3D_SIZE fehlt oder ist ungültig");
  if (values.length !== size * size * size * 3 || values.some((v) => !Number.isFinite(v))) throw new Error("Die LUT-Daten passen nicht zur Größe");
  return { size, min, max, data: new Float32Array(values) };
}

/** Y'CbCr (0..255, BT.601 limited) of an RGB colour in 0..1; same as render.rs bt601_limited. */
export function bt601Limited([r, g, b]: [number, number, number]): [number, number, number] {
  const q = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  return [q(16 + 65.481 * r + 128.553 * g + 24.966 * b), q(128 - 37.797 * r - 74.203 * g + 112 * b), q(128 + 112 * r - 93.786 * g - 18.214 * b)];
}

// --- shaders -------------------------------------------------------------------------

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
`;

const FS: Record<string, string> = {
  ...FX_SHADERS,
  blur: `${HEAD}
uniform vec2 u_dir;
uniform float u_sigma;
void main() {
  float s = max(u_sigma, 0.01);
  float reach = ceil(3.0 * s);
  float stepPx = max(1.0, reach / 48.0);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -48; i <= 48; i++) {
    float x = float(i) * stepPx;
    if (abs(x) > reach) continue;
    float w = exp(-0.5 * x * x / (s * s));
    acc += texture(u_tex, v_uv + u_dir * x) * w;
    wsum += w;
  }
  outColor = acc / wsum;
}`,
  sharpen: `${HEAD}
uniform sampler2D u_blur;
uniform float u_amount;
void main() {
  vec4 a = texture(u_tex, v_uv);
  vec4 b = texture(u_blur, v_uv);
  outColor = vec4(clamp(a.rgb + (a.rgb - b.rgb) * u_amount, 0.0, 1.0), a.a);
}`,
  vignette: `${HEAD}
uniform vec2 u_size;
uniform float u_angle;
void main() {
  vec4 a = texture(u_tex, v_uv);
  vec2 half_ = 0.5 * u_size;
  float d = length(v_uv * u_size - half_) / length(half_);
  float c = cos(u_angle * d);
  float f = d > 1.0 ? 0.0 : c * c * c * c;
  outColor = vec4(a.rgb * f, a.a);
}`,
  lut: `${HEAD}
uniform highp sampler3D u_lut;
uniform float u_n;
uniform vec3 u_min;
uniform vec3 u_max;
uniform float u_mix;
void main() {
  vec4 a = texture(u_tex, v_uv);
  vec3 c = clamp((a.rgb - u_min) / (u_max - u_min), 0.0, 1.0);
  vec3 l = texture(u_lut, c * (u_n - 1.0) / u_n + 0.5 / u_n).rgb;
  outColor = vec4(mix(a.rgb, clamp(l, 0.0, 1.0), u_mix), a.a);
}`,
  chroma: `${HEAD}
uniform vec2 u_key;
uniform vec2 u_step;
uniform float u_similarity;
uniform float u_blend;
uniform float u_spill;
uniform float u_blue;
vec2 uv601(vec3 c) {
  return vec2(128.0 - 37.797 * c.r - 74.203 * c.g + 112.0 * c.b, 128.0 + 112.0 * c.r - 93.786 * c.g - 18.214 * c.b);
}
void main() {
  float diff = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 d = uv601(texture(u_tex, v_uv + vec2(x, y) * u_step).rgb) - u_key;
      diff += sqrt(dot(d, d) / (255.0 * 255.0 * 2.0));
    }
  diff /= 9.0;
  float alpha = u_blend > 0.0001 ? clamp((diff - u_similarity) / u_blend, 0.0, 1.0) : (diff > u_similarity ? 1.0 : 0.0);
  vec3 c = texture(u_tex, v_uv).rgb;
  if (u_spill > 0.0) {
    if (u_blue > 0.5) c.b = max(c.b - max(c.b - 0.5 * (c.r + c.g), 0.0) * u_spill, 0.0);
    else c.g = max(c.g - max(c.g - 0.5 * (c.r + c.b), 0.0) * u_spill, 0.0);
  }
  outColor = vec4(c, alpha);
}`,
  wheels: `${HEAD}
uniform vec3 u_lift;
uniform vec3 u_gamma;
uniform vec3 u_gain;
void main() {
  vec4 a = texture(u_tex, v_uv);
  vec3 v = clamp(a.rgb * (u_gain - u_lift) + u_lift, 0.0, 1.0);
  outColor = vec4(clamp(pow(v, 1.0 / u_gamma), 0.0, 1.0), a.a);
}`,
  curves: `${HEAD}
uniform sampler2D u_curve;
float at(float v, int ch) {
  vec4 t = texture(u_curve, vec2((floor(v * 255.0 + 0.5) + 0.5) / 256.0, 0.5));
  return ch == 0 ? t.r : ch == 1 ? t.g : t.b;
}
void main() {
  vec4 a = texture(u_tex, v_uv);
  outColor = vec4(at(a.r, 0), at(a.g, 1), at(a.b, 2), a.a);
}`,
};

// uv (0..1) -> clip space, keeping the texture orientation of uploaded frames.
const FULL_QUAD = new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]);

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

type Program = { p: WebGLProgram; loc: (name: string) => WebGLUniformLocation | null };

export class EffectPipeline {
  private programs = new Map<string, Program>();
  private pool: Target[] = [];
  private luts = new Map<string, { tex: WebGLTexture; cube: Cube } | "loading" | "failed">();
  private curves = new Map<string, WebGLTexture>();
  private tables = new Map<string, WebGLTexture>();
  private masks = new Map<string, WebGLTexture>();

  constructor(
    private gl: WebGL2RenderingContext,
    private vs: string,
    private compile: (vs: string, fs: string) => WebGLProgram,
    private readText: (path: string) => Promise<string>,
    private onLoaded: () => void,
  ) {}

  private program(name: string): Program {
    let pr = this.programs.get(name);
    if (!pr) {
      const p = this.compile(this.vs, FS[name]);
      const cache = new Map<string, WebGLUniformLocation | null>();
      pr = {
        p,
        loc: (n) => {
          if (!cache.has(n)) cache.set(n, this.gl.getUniformLocation(p, n));
          return cache.get(n)!;
        },
      };
      this.programs.set(name, pr);
    }
    return pr;
  }

  acquire(w: number, h: number): Target {
    const i = this.pool.findIndex((t) => t.w === w && t.h === h);
    if (i >= 0) return this.pool.splice(i, 1)[0];
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    for (const [k, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }

  release(t: Target) {
    this.pool.push(t);
    // Keep the pool small: sizes change when the window or quality changes.
    while (this.pool.length > 12) {
      const old = this.pool.shift()!;
      this.gl.deleteTexture(old.tex);
      this.gl.deleteFramebuffer(old.fbo);
    }
  }

  /** Draws `src` into `dst` with program `name`; `setup` sets its uniforms. */
  private pass(name: string, src: WebGLTexture, dst: Target, setup: (pr: Program) => void) {
    const gl = this.gl;
    const pr = this.program(name);
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(pr.loc("u_tex"), 0);
    gl.uniformMatrix3fv(pr.loc("u_matrix"), false, FULL_QUAD);
    gl.uniform4f(pr.loc("u_crop"), 0, 0, 0, 0);
    gl.uniform2f(pr.loc("u_size"), dst.w, dst.h);
    setup(pr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private lut(path: string) {
    const entry = this.luts.get(path);
    if (entry) return entry;
    this.luts.set(path, "loading");
    this.readText(path)
      .then((text) => {
        const cube = parseCube(text);
        const gl = this.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_3D, tex);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, cube.size, cube.size, cube.size, 0, gl.RGB, gl.FLOAT, cube.data);
        for (const [k, v] of [
          [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
          [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
          [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
          [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
          [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
        ])
          gl.texParameteri(gl.TEXTURE_3D, k, v);
        this.luts.set(path, { tex, cube });
        this.onLoaded();
      })
      .catch((e) => {
        console.warn("LUT", path, e);
        this.luts.set(path, "failed");
      });
    return "loading" as const;
  }

  /** True when a LUT could not be read (the effect is skipped). */
  lutFailed(path: string) {
    return this.luts.get(path) === "failed";
  }

  private curveTex(e: Extract<EffectKind, { type: "curves" }>): WebGLTexture {
    const key = JSON.stringify([e.master, e.red, e.green, e.blue]);
    let t = this.curves.get(key);
    if (!t) {
      const gl = this.gl;
      t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, curvesTexture(e));
      for (const [k, v] of [
        [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
        [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      ])
        gl.texParameteri(gl.TEXTURE_2D, k, v);
      if (this.curves.size > 32) {
        for (const old of this.curves.values()) gl.deleteTexture(old);
        this.curves.clear();
      }
      this.curves.set(key, t);
    }
    return t;
  }

  /** Unmoved mask image of a freeform mask (R8), cached by shape and size. */
  private maskTex(points: [number, number][], feather: number, invert: boolean, w: number, h: number): WebGLTexture {
    const key = `${w}x${h}|${feather}|${invert}|${points.join(";")}`;
    let t = this.masks.get(key);
    if (t) {
      // Most recently used last.
      this.masks.delete(key);
      this.masks.set(key, t);
      return t;
    }
    const gl = this.gl;
    t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, maskPixels(points, feather, invert, w, h));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.masks.set(key, t);
    // A dragged point makes a new shape per move: keep only the latest few.
    while (this.masks.size > 8) {
      const [old, tex] = this.masks.entries().next().value!;
      gl.deleteTexture(tex);
      this.masks.delete(old);
    }
    return t;
  }

  private tableTex(key: string, make: () => Uint8Array): WebGLTexture {
    let t = this.tables.get(key);
    if (!t) {
      const gl = this.gl;
      t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, make());
      for (const [k, v] of [
        [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
        [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      ])
        gl.texParameteri(gl.TEXTURE_2D, k, v);
      if (this.tables.size > 64) {
        for (const old of this.tables.values()) gl.deleteTexture(old);
        this.tables.clear();
      }
      this.tables.set(key, t);
    }
    return t;
  }

  /** Gaussian blur of `src` (not consumed) into a new target, as the blur effect. */
  private gauss(src: Target, sigma: number, program = "blur"): Target {
    const gl = this.gl;
    const h = this.acquire(src.w, src.h);
    this.pass(program, src.tex, h, (pr) => {
      gl.uniform2f(pr.loc("u_dir"), 1 / src.w, 0);
      gl.uniform1f(pr.loc("u_sigma"), sigma);
    });
    const v = this.acquire(src.w, src.h);
    this.pass(program, h.tex, v, (pr) => {
      gl.uniform2f(pr.loc("u_dir"), 0, 1 / src.h);
      gl.uniform1f(pr.loc("u_sigma"), sigma);
    });
    this.release(h);
    return v;
  }

  /** Runs one catalogue effect on `input` (consumed); returns the result. */
  private runFx(e: Extract<EffectKind, { type: "fx" }>, input: Target, scale: number, frame: number): Target {
    const gl = this.gl;
    const p = fxReader(e.fx, e.params);
    const { w, h } = input;
    let cur = input;
    const step = (name: string, setup: (pr: Program) => void, src: Target = cur) => {
      const out = this.acquire(w, h);
      this.pass(name, src.tex, out, (pr) => {
        gl.uniform1f(pr.loc("u_scale"), scale);
        setup(pr);
      });
      return out;
    };
    const then = (name: string, setup: (pr: Program) => void) => {
      const out = step(name, setup);
      this.release(cur);
      cur = out;
    };
    const f = (pr: Program, n: string, v: number) => gl.uniform1f(pr.loc(n), v);
    const bind = (pr: Program, n: string, unit: number, tex: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(pr.loc(n), unit);
      gl.activeTexture(gl.TEXTURE0);
    };
    const center = (pr: Program) => gl.uniform2f(pr.loc("u_c"), p.get("centerX") * w, p.get("centerY") * h);
    const tones = toneFns(e.fx, e.params);
    if (tones) {
      const t = this.tableTex(`${e.fx}:${JSON.stringify(e.params)}`, () => toneTexture(tones.map(toneTable) as [Uint8Array, Uint8Array, Uint8Array]));
      then("table", (pr) => bind(pr, "u_table", 1, t));
      return cur;
    }
    const m = fxMatrix(e.fx, e.params);
    if (m) {
      // Column-major: column c holds the coefficients of input channel c.
      const cm = new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]);
      then("matrix", (pr) => gl.uniformMatrix3fv(pr.loc("u_m"), false, cm));
      return cur;
    }
    const fr = ((Math.round(frame) % 65521) + 65521) % 65521;
    switch (e.fx) {
      case "vibrance":
        then("vibrance", (pr) => f(pr, "u_amount", p.get("amount")));
        break;
      case "hslSecondary":
        then("hslSecondary", (pr) => {
          f(pr, "u_hue", p.get("hue"));
          f(pr, "u_range", p.get("range"));
          f(pr, "u_soft", Math.max(p.get("softness"), 0.001));
          f(pr, "u_shift", (p.get("shift") * Math.PI) / 180);
          f(pr, "u_sat", p.get("saturation"));
          f(pr, "u_light", p.get("lightness"));
        });
        break;
      case "lumaKey":
        then("lumaKey", (pr) => {
          f(pr, "u_threshold", p.get("threshold"));
          f(pr, "u_softness", p.get("softness"));
          f(pr, "u_invert", p.get("invert"));
        });
        break;
      case "boxBlur": {
        const r = Math.min(60, Math.round(p.get("radius") * scale));
        then("box", (pr) => {
          gl.uniform2f(pr.loc("u_dir"), 1, 0);
          gl.uniform1i(pr.loc("u_r"), r);
          f(pr, "u_last", 0);
        });
        then("box", (pr) => {
          gl.uniform2f(pr.loc("u_dir"), 0, 1);
          gl.uniform1i(pr.loc("u_r"), r);
          f(pr, "u_last", 1);
        });
        break;
      }
      case "directionalBlur": {
        const th = (p.get("angle") * Math.PI) / 180;
        const len = p.get("length") * scale;
        then("taps", (pr) => {
          gl.uniform1i(pr.loc("u_mode"), 0);
          gl.uniform2f(pr.loc("u_a"), Math.cos(th) * len, Math.sin(th) * len);
        });
        break;
      }
      case "radialBlur":
      case "zoomBlur":
        then("taps", (pr) => {
          gl.uniform1i(pr.loc("u_mode"), e.fx === "radialBlur" ? 1 : 2);
          gl.uniform2f(pr.loc("u_a"), e.fx === "radialBlur" ? (p.get("angle") * Math.PI) / 180 : p.get("amount"), 0);
          center(pr);
        });
        break;
      case "tiltShift":
      case "softFocus":
      case "glow": {
        let src = cur;
        let bright: Target | null = null;
        if (e.fx === "glow") {
          const t = this.tableTex(`glow:${p.get("threshold")}`, () => {
            const g = toneTable(glowFn(p.get("threshold")));
            return toneTexture([g, g, g]);
          });
          bright = step("table", (pr) => bind(pr, "u_table", 1, t));
          src = bright;
        }
        const blurred = this.gauss(src, p.get("radius") * scale);
        if (bright) this.release(bright);
        then("blend2", (pr) => {
          bind(pr, "u_b", 1, blurred.tex);
          gl.uniform1i(pr.loc("u_mode"), e.fx === "glow" ? 0 : e.fx === "softFocus" ? 1 : 2);
          f(pr, "u_k", e.fx === "glow" ? p.get("intensity") : p.get("amount"));
          f(pr, "u_focus", p.get("focus"));
          f(pr, "u_width", p.get("width"));
          f(pr, "u_feather", p.get("feather"));
        });
        this.release(blurred);
        break;
      }
      case "chromaticAberration": {
        const d = Math.round(p.get("amount") * scale);
        then("rgbShift", (pr) => gl.uniform2i(pr.loc("u_d"), p.on("vertical") ? 0 : d, p.on("vertical") ? d : 0));
        break;
      }
      case "wave":
        then("wave", (pr) => {
          f(pr, "u_amp", p.get("amplitude") * scale);
          f(pr, "u_k", (2 * Math.PI) / (p.get("wavelength") * scale));
          f(pr, "u_phase", (p.get("phase") * Math.PI) / 180);
          f(pr, "u_vertical", p.get("vertical"));
        });
        break;
      case "twirl":
        then("twirl", (pr) => {
          center(pr);
          f(pr, "u_radius", p.get("radius"));
          f(pr, "u_angle", (p.get("angle") * Math.PI) / 180);
        });
        break;
      case "bulge":
        then("bulge", (pr) => {
          center(pr);
          f(pr, "u_radius", p.get("radius"));
          f(pr, "u_e", Math.pow(2, p.get("amount")));
        });
        break;
      case "lensDistortion":
        then("lens", (pr) => f(pr, "u_k", p.get("amount") * 0.5));
        break;
      case "kaleidoscope":
        then("kaleidoscope", (pr) => {
          f(pr, "u_seg", (2 * Math.PI) / p.get("segments"));
          f(pr, "u_rot", (p.get("angle") * Math.PI) / 180);
        });
        break;
      case "mirror":
        then("mirror", (pr) => gl.uniform1i(pr.loc("u_mode"), p.get("mode")));
        break;
      case "pixelate":
        then("pixelate", (pr) => f(pr, "u_s", Math.max(1, p.get("size") * scale)));
        break;
      case "scanlines":
        then("scanlines", (pr) => {
          f(pr, "u_spacing", Math.max(1, p.get("spacing") * scale));
          f(pr, "u_dark", p.get("darkness"));
        });
        break;
      case "filmGrain":
        then("grain", (pr) => {
          f(pr, "u_amount", p.get("amount") * 255);
          f(pr, "u_s", Math.max(1, p.get("size") * scale));
          f(pr, "u_color", p.get("color"));
          gl.uniform1ui(pr.loc("u_frame"), fr);
        });
        break;
      case "glitch":
        then("glitch", (pr) => {
          f(pr, "u_amount", p.get("amount"));
          f(pr, "u_shift", p.get("shift") * scale);
          f(pr, "u_block", Math.max(1, p.get("block") * scale));
          f(pr, "u_split", p.get("split") * scale);
          gl.uniform1ui(pr.loc("u_frame"), fr);
          gl.uniform1ui(pr.loc("u_seed"), Math.round(p.get("seed")) * 7 + 101);
        });
        break;
      case "edgeDetect":
        then("edges", (pr) => {
          f(pr, "u_amount", p.get("amount"));
          f(pr, "u_invert", p.get("invert"));
        });
        break;
      case "shapeMask":
        then("shapeMask", (pr) => {
          center(pr);
          gl.uniform2f(pr.loc("u_half"), (p.get("width") * w) / 2, (p.get("height") * h) / 2);
          f(pr, "u_ellipse", p.get("shape"));
          f(pr, "u_feather", p.get("feather") * scale);
          f(pr, "u_invert", p.get("invert"));
        });
        break;
      case "border":
        then("border", (pr) => {
          f(pr, "u_width", p.get("width") * scale);
          gl.uniform3f(pr.loc("u_color"), ...(p.rgb("color").map((v) => Math.round(v * 255)) as [number, number, number]));
        });
        break;
      case "flip":
        then("flip", (pr) => gl.uniform2f(pr.loc("u_flip"), p.get("horizontal"), p.get("vertical")));
        break;
      case "matte": {
        const n = Math.round(p.get("choke") * scale);
        for (let i = 0; i < Math.abs(n); i++) then("morph", (pr) => f(pr, "u_max", n < 0 ? 1 : 0));
        if (p.get("feather") > 0) {
          const b = this.gauss(cur, p.get("feather") * scale, "alphaBlur");
          this.release(cur);
          cur = b;
        }
        break;
      }
      case "stroke":
      case "dropShadow": {
        const color = p.rgb("color").map((v) => Math.round(v * 255)) as [number, number, number];
        let base: Target;
        if (e.fx === "stroke") {
          let grown = step("morph", (pr) => f(pr, "u_max", 1));
          for (let i = 1; i < Math.round(p.get("width") * scale); i++) {
            const g = step("morph", (pr) => f(pr, "u_max", 1), grown);
            this.release(grown);
            grown = g;
          }
          base = step(
            "solid",
            (pr) => {
              gl.uniform3f(pr.loc("u_color"), ...color);
              gl.uniform2f(pr.loc("u_d"), 0, 0);
              f(pr, "u_op", 1);
              f(pr, "u_exact", 1);
            },
            grown,
          );
          this.release(grown);
        } else {
          const th = (p.get("angle") * Math.PI) / 180;
          const dist = p.get("distance");
          base = step("solid", (pr) => {
            gl.uniform3f(pr.loc("u_color"), ...color);
            gl.uniform2f(pr.loc("u_d"), Math.round(dist * Math.cos(th)) * scale, Math.round(dist * Math.sin(th)) * scale);
            f(pr, "u_op", p.get("opacity"));
            f(pr, "u_exact", 0);
          });
          if (p.get("softness") > 0) {
            const b = this.gauss(base, p.get("softness") * scale, "alphaBlur");
            this.release(base);
            base = b;
          }
        }
        const out = step(
          "over",
          (pr) => bind(pr, "u_top", 1, cur.tex),
          base,
        );
        this.release(base);
        this.release(cur);
        cur = out;
        break;
      }
    }
    return cur;
  }

  /**
   * Applies `effects` to the frame in `input` (a pooled target, consumed).
   * `scale` is target pixels per sequence pixel. Returns the result target;
   * the caller releases it.
   */
  apply(input: Target, effects: EffectKind[], scale: number, frame = 0): Target {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    let cur = input;
    const next = () => this.acquire(cur.w, cur.h);
    const swap = (t: Target) => {
      this.release(cur);
      cur = t;
    };
    for (const e of effects) {
      switch (e.type) {
        case "blur":
        case "sharpen": {
          const sigma = e.radius * scale;
          const h = next();
          this.pass("blur", cur.tex, h, (pr) => {
            gl.uniform2f(pr.loc("u_dir"), 1 / cur.w, 0);
            gl.uniform1f(pr.loc("u_sigma"), sigma);
          });
          const v = next();
          this.pass("blur", h.tex, v, (pr) => {
            gl.uniform2f(pr.loc("u_dir"), 0, 1 / cur.h);
            gl.uniform1f(pr.loc("u_sigma"), sigma);
          });
          this.release(h);
          if (e.type === "blur") {
            swap(v);
            break;
          }
          const out = next();
          this.pass("sharpen", cur.tex, out, (pr) => {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, v.tex);
            gl.uniform1i(pr.loc("u_blur"), 1);
            gl.uniform1f(pr.loc("u_amount"), e.amount);
          });
          this.release(v);
          swap(out);
          break;
        }
        case "vignette": {
          const out = next();
          this.pass("vignette", cur.tex, out, (pr) => {
            gl.uniform2f(pr.loc("u_size"), cur.w, cur.h);
            gl.uniform1f(pr.loc("u_angle"), (e.amount * Math.PI) / 2);
          });
          swap(out);
          break;
        }
        case "lut": {
          const l = this.lut(e.path);
          if (typeof l === "string") break;
          const out = next();
          this.pass("lut", cur.tex, out, (pr) => {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_3D, l.tex);
            gl.uniform1i(pr.loc("u_lut"), 1);
            gl.uniform1f(pr.loc("u_n"), l.cube.size);
            gl.uniform3fv(pr.loc("u_min"), l.cube.min);
            gl.uniform3fv(pr.loc("u_max"), l.cube.max);
            gl.uniform1f(pr.loc("u_mix"), e.intensity);
          });
          swap(out);
          break;
        }
        case "chromaKey": {
          const [, u, v] = bt601Limited(e.color);
          const out = next();
          this.pass("chroma", cur.tex, out, (pr) => {
            gl.uniform2f(pr.loc("u_key"), u, v);
            gl.uniform2f(pr.loc("u_step"), scale / cur.w, scale / cur.h);
            gl.uniform1f(pr.loc("u_similarity"), e.similarity);
            gl.uniform1f(pr.loc("u_blend"), e.blend);
            gl.uniform1f(pr.loc("u_spill"), e.spill);
            gl.uniform1f(pr.loc("u_blue"), e.color[2] > e.color[1] ? 1 : 0);
          });
          swap(out);
          break;
        }
        case "colorWheels": {
          const out = next();
          this.pass("wheels", cur.tex, out, (pr) => {
            gl.uniform3fv(pr.loc("u_lift"), e.lift);
            gl.uniform3fv(pr.loc("u_gamma"), e.gamma);
            gl.uniform3fv(pr.loc("u_gain"), e.gain);
          });
          swap(out);
          break;
        }
        case "fx": {
          const out = this.runFx(e, cur, scale, frame);
          cur = out;
          break;
        }
        case "polygonMask": {
          if (e.points.length < 3) break;
          const mask = this.maskTex(e.points, e.feather * scale, e.invert, cur.w, cur.h);
          const out = next();
          this.pass("polygonMask", cur.tex, out, (pr) => {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, mask);
            gl.uniform1i(pr.loc("u_mask"), 1);
            gl.uniform2i(pr.loc("u_shift"), maskShift(e.x, cur.w), maskShift(e.y, cur.h));
            gl.uniform1i(pr.loc("u_outside"), e.invert ? 255 : 0);
          });
          swap(out);
          break;
        }
        case "curves": {
          const t = this.curveTex(e);
          const out = next();
          this.pass("curves", cur.tex, out, (pr) => {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.uniform1i(pr.loc("u_curve"), 1);
          });
          swap(out);
          break;
        }
      }
      gl.activeTexture(gl.TEXTURE0);
    }
    return cur;
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.pool) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.pool = [];
    for (const l of this.luts.values()) if (typeof l === "object") gl.deleteTexture(l.tex);
    this.luts.clear();
    for (const t of this.curves.values()) gl.deleteTexture(t);
    this.curves.clear();
    for (const t of this.tables.values()) gl.deleteTexture(t);
    this.tables.clear();
    for (const t of this.masks.values()) gl.deleteTexture(t);
    this.masks.clear();
    for (const p of this.programs.values()) gl.deleteProgram(p.p);
    this.programs.clear();
  }
}

export type { Target as EffectTarget };
