// Preview side of the catalogue effects (kerf_core::fx, export: kerf_media::fx).
//
// Three kinds, each computing what the export's FFmpeg filter computes:
//   tone tables  per-channel y = f(x) evaluated into 256 entries (lutrgb)
//   matrices     3×3 colour matrix, each product rounded like colorchannelmixer
//   expressions  GLSL ports of the geq expressions, sampling with geq's
//                bilinear rule (coordinates clamped to [0, size − 2]) and
//                rounding like `clip(v + 0.5, 0, 255)` truncated
// plus multi-pass effects (glow, tilt-shift, matte, stroke, shadow) built from
// the same pieces. Shaders work in 0..255 and pixel indices from the top left.

import catalogJson from "../../fixtures/effects/catalog.json";

export type FxParamKind = "float" | "int" | "angle" | "toggle" | "choice" | "color" | "point";
export interface FxParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  kind: FxParamKind;
  unit?: string;
  scale?: number;
  options?: string[];
}
export type FxCategory = "color" | "blur" | "light" | "distort" | "stylize" | "keying" | "transform";
export interface FxDef {
  id: string;
  version: number;
  category: FxCategory;
  label: string;
  description: string;
  params: FxParamDef[];
  heavy: boolean;
  /** Parameter keys that can be animated with keyframes. */
  animated: string[];
}

/** Generated from the Rust catalogue (crates/kerf-core/src/fx.rs). */
export const FX_CATALOG = catalogJson as FxDef[];
export const fxDef = (id: string) => FX_CATALOG.find((d) => d.id === id);

export type FxParams = Record<string, number>;

export function fxKeys(p: FxParamDef): string[] {
  if (p.kind === "color") return ["R", "G", "B"].map((c) => p.id + c);
  if (p.kind === "point") return ["X", "Y"].map((c) => p.id + c);
  return [p.id];
}

export function fxDefaults(d: FxDef): FxParams {
  const out: FxParams = {};
  for (const p of d.params) for (const k of fxKeys(p)) out[k] = p.default;
  return out;
}

/** Same as kerf_core::fx::sanitize (without the NaN rejection). */
export function fxSanitize(d: FxDef, params: FxParams): FxParams {
  const out: FxParams = {};
  for (const p of d.params)
    for (const k of fxKeys(p)) {
      let v = params[k];
      if (typeof v !== "number" || !Number.isFinite(v)) v = p.default;
      v = Math.min(p.max, Math.max(p.min, v));
      if (p.kind === "int" || p.kind === "toggle" || p.kind === "choice") v = Math.round(v);
      out[k] = v;
    }
  return out;
}

/** Reader with catalogue defaults, as kerf_core::fx::Params. */
export function fxReader(id: string, params: FxParams) {
  const d = fxDef(id);
  const get = (k: string): number => {
    if (k in params) return params[k];
    const p = d?.params.find((x) => fxKeys(x).includes(k));
    return p ? p.default : 0;
  };
  return { get, on: (k: string) => get(k) >= 0.5, rgb: (k: string) => [get(k + "R"), get(k + "G"), get(k + "B")] as [number, number, number] };
}

/** Same as kerf_core::fx::is_identity. */
export function fxIsIdentity(id: string, params: FxParams): boolean {
  if (!fxDef(id)) return true;
  const v = fxReader(id, params);
  const zero = (...k: string[]) => k.every((x) => v.get(x) === 0);
  switch (id) {
    case "brightnessContrast":
      return zero("brightness", "contrast");
    case "levels":
      return v.get("inBlack") === 0 && v.get("inWhite") === 1 && v.get("gamma") === 1 && v.get("outBlack") === 0 && v.get("outWhite") === 1;
    case "tone":
      return zero("shadows", "highlights", "blacks", "whites");
    case "colorBalance":
      return zero("shadowsR", "shadowsG", "shadowsB", "midR", "midG", "midB", "highR", "highG", "highB");
    case "vibrance":
    case "blackWhite":
    case "sepia":
    case "colorize":
    case "invert":
    case "softFocus":
      return zero("amount");
    case "hueShift":
      return zero("angle");
    case "hslSecondary":
      return zero("shift", "saturation", "lightness");
    case "boxBlur":
      return zero("radius");
    case "directionalBlur":
      return zero("length");
    case "radialBlur":
    case "twirl":
      return zero("angle");
    case "zoomBlur":
    case "bulge":
    case "lensDistortion":
    case "filmGrain":
      return zero("amount");
    case "tiltShift":
      return zero("radius");
    case "glow":
      return zero("intensity");
    case "chromaticAberration":
      return zero("amount");
    case "wave":
      return zero("amplitude");
    case "scanlines":
      return zero("darkness");
    case "glitch":
      return zero("amount") || zero("shift", "split");
    case "matte":
      return zero("choke", "feather");
    case "flip":
      return zero("horizontal", "vertical");
    case "border":
      return zero("width");
    case "dropShadow":
      return zero("opacity");
    default:
      return false;
  }
}

// --- tone tables (mirror kerf_media::fx::tone_bodies) ---------------------------------

type Tone = (x: number) => number;

/** Per-channel functions of a tone effect, or null. Same operation order as the Rust expressions. */
export function toneFns(id: string, params: FxParams): [Tone, Tone, Tone] | null {
  const p = fxReader(id, params);
  const same = (f: Tone): [Tone, Tone, Tone] => [f, f, f];
  const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  switch (id) {
    case "brightnessContrast": {
      const b = p.get("brightness");
      const c = 1 + p.get("contrast");
      return same((x) => (x + b - 0.5) * c + 0.5);
    }
    case "levels": {
      const span = Math.max(p.get("inWhite") - p.get("inBlack"), 0.001);
      const [ib, ob, d, g] = [p.get("inBlack"), p.get("outBlack"), p.get("outWhite") - p.get("outBlack"), 1 / p.get("gamma")];
      return same((x) => ob + d * Math.pow(clip((x - ib) / span, 0, 1), g));
    }
    case "tone": {
      const [s, h, k, w] = ["shadows", "highlights", "blacks", "whites"].map(p.get);
      return same((x) => x + 1.6875 * (s * x * (1 - x) * (1 - x) + h * x * x * (1 - x)) + 0.25 * (k * Math.pow(1 - x, 4) + w * Math.pow(x, 4)));
    }
    case "colorBalance": {
      const ch = (c: string): Tone => {
        const [s, m, h] = [p.get("shadows" + c), p.get("mid" + c), p.get("high" + c)];
        return (x) => x + 0.25 * (s * (1 - x) * (1 - x) + m * 4 * x * (1 - x) + h * x * x);
      };
      return [ch("R"), ch("G"), ch("B")];
    }
    case "invert": {
      const a = p.get("amount");
      return same((x) => x + a * (1 - 2 * x));
    }
    case "posterize": {
      const k = p.get("levels") - 1;
      return same((x) => Math.floor(x * k + 0.5) / k);
    }
    case "solarize": {
      const t = p.get("threshold");
      return same((x) => (x > t ? 1 - x : x));
    }
    default:
      return null;
  }
}

export const glowFn =
  (threshold: number): Tone =>
  (x) => {
    const t = Math.min(threshold, 0.999);
    return Math.max(x - t, 0) / (1 - t);
  };

/** 256 entries of `f` as lutrgb stores them: (f(val/255)·255 + 0.5) truncated, clamped. */
export function toneTable(f: Tone): Uint8Array {
  const out = new Uint8Array(256);
  for (let v = 0; v < 256; v++) out[v] = Math.min(255, Math.max(0, Math.trunc(f(v / 255) * 255 + 0.5)));
  return out;
}

/** RGBA 256×1 texture of three channel tables. */
export function toneTexture(t: [Uint8Array, Uint8Array, Uint8Array]): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    out[i * 4] = t[0][i];
    out[i * 4 + 1] = t[1][i];
    out[i * 4 + 2] = t[2][i];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// --- matrices (mirror kerf_media::fx::matrix) -----------------------------------------

type M3 = [[number, number, number], [number, number, number], [number, number, number]];
const L709: [number, number, number] = [0.2126, 0.7152, 0.0722];

export function hsv(hue: number, sat: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 60;
  const f = (k: number) => {
    const kk = (k + h) % 6;
    return 1 - sat * Math.min(1, Math.max(0, Math.min(kk, 4 - kk)));
  };
  return [f(5), f(3), f(1)];
}

export function hueRotation(theta: number): M3 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = (1 - c) / 3;
  const q = Math.sqrt(1 / 3) * s;
  return [
    [c + t, t - q, t + q],
    [t + q, c + t, t - q],
    [t - q, t + q, c + t],
  ];
}

export function fxMatrix(id: string, params: FxParams): M3 | null {
  const p = fxReader(id, params);
  const mix = (m: M3, a: number): M3 => m.map((row, r) => row.map((v, c) => (1 - a) * (r === c ? 1 : 0) + a * v)) as M3;
  switch (id) {
    case "blackWhite":
      return mix([L709, L709, L709], p.get("amount"));
    case "sepia":
      return mix(
        [
          [0.393, 0.769, 0.189],
          [0.349, 0.686, 0.168],
          [0.272, 0.534, 0.131],
        ],
        p.get("amount"),
      );
    case "colorize": {
      const c = hsv(p.get("hue"), p.get("saturation"));
      const lc = Math.max(L709[0] * c[0] + L709[1] * c[1] + L709[2] * c[2], 1e-6);
      return mix([0, 1, 2].map((r) => L709.map((l) => (c[r] / lc) * l)) as M3, p.get("amount"));
    }
    case "hueShift":
      return hueRotation((p.get("angle") * Math.PI) / 180);
    default:
      return null;
  }
}

// --- shaders ------------------------------------------------------------------------

const HEAD = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_size;
uniform float u_scale;
out vec4 outColor;
// Pixel index of this fragment (x from the left, y from the top row of the texture).
vec2 P() { return floor(gl_FragCoord.xy); }
// geq's bilinear sample at pixel coordinates, 0..255.
vec4 px(vec2 p) {
  vec2 q = clamp(p, vec2(0.0), u_size - 2.0);
  vec2 i = floor(q);
  vec2 f = q - i;
  ivec2 ii = ivec2(i);
  vec4 a = texelFetch(u_tex, ii, 0);
  vec4 b = texelFetch(u_tex, ii + ivec2(1, 0), 0);
  vec4 c = texelFetch(u_tex, ii + ivec2(0, 1), 0);
  vec4 d = texelFetch(u_tex, ii + ivec2(1, 1), 0);
  return ((1.0 - f.y) * ((1.0 - f.x) * a + f.x * b) + f.y * ((1.0 - f.x) * c + f.x * d)) * 255.0;
}
// Exact texel, edges repeated.
vec4 at(ivec2 p) { return texelFetch(u_tex, clamp(p, ivec2(0), ivec2(u_size) - 1), 0) * 255.0; }
float R(float v) { return clamp(floor(v + 0.5), 0.0, 255.0); }
vec4 R4(vec4 v) { return clamp(floor(v + 0.5), 0.0, 255.0); }
float luma(vec4 c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
float hash(uint s) {
  uint h = s % 65521u;
  h = (h * h + 31337u) % 65521u;
  h = (h * h + 7u) % 65521u;
  return float(h) / 65521.0;
}
`;

/** A single-pass effect that remaps coordinates: `body` sets vec2 S (source) from vec2 X (this pixel). */
const remap = (uniforms: string, body: string) => `${HEAD}${uniforms}
void main() {
  vec2 X = P();
  vec2 S;
  ${body}
  outColor = px(S) / 255.0;
}`;

const FS: Record<string, string> = {
  table: `${HEAD}
uniform sampler2D u_table;
void main() {
  vec4 a = texture(u_tex, (P() + 0.5) / u_size);
  ivec3 i = ivec3(floor(a.rgb * 255.0 + 0.5));
  outColor = vec4(texelFetch(u_table, ivec2(i.r, 0), 0).r, texelFetch(u_table, ivec2(i.g, 0), 0).g, texelFetch(u_table, ivec2(i.b, 0), 0).b, a.a);
}`,
  // colorchannelmixer (8 bit): every product rounded half to even, then summed and clipped.
  matrix: `${HEAD}
uniform mat3 u_m;
void main() {
  vec4 a = at(ivec2(P()));
  vec3 o;
  for (int r = 0; r < 3; r++) o[r] = clamp(roundEven(a.r * u_m[0][r]) + roundEven(a.g * u_m[1][r]) + roundEven(a.b * u_m[2][r]), 0.0, 255.0);
  outColor = vec4(o, a.a) / 255.0;
}`,
  vibrance: `${HEAD}
uniform float u_amount;
void main() {
  vec4 c = px(P());
  float l = luma(c);
  float k = 1.0 + u_amount * (1.0 - (max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b))) / 255.0);
  outColor = vec4(R(l + (c.r - l) * k), R(l + (c.g - l) * k), R(l + (c.b - l) * k), c.a) / 255.0;
}`,
  hslSecondary: `${HEAD}
uniform float u_hue, u_range, u_soft, u_shift, u_sat, u_light;
void main() {
  vec4 c = px(P());
  float d = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float h = atan(1.7320508 * (c.g - c.b), 2.0 * c.r - c.g - c.b) * 57.2957795;
  float w = 1.0 - clamp((abs(mod(h - u_hue + 180.0, 360.0) - 180.0) - u_range) / u_soft, 0.0, 1.0);
  w = w * w * (3.0 - 2.0 * w) * clamp(d / 25.5, 0.0, 1.0);
  float th = w * u_shift;
  float co = cos(th);
  float q = 0.57735027 * sin(th);
  float t = (1.0 - co) / 3.0;
  vec3 n = vec3((co + t) * c.r + (t - q) * c.g + (t + q) * c.b, (t + q) * c.r + (co + t) * c.g + (t - q) * c.b, (t - q) * c.r + (t + q) * c.g + (co + t) * c.b);
  float l = 0.2126 * n.r + 0.7152 * n.g + 0.0722 * n.b;
  vec3 v = l + (n - l) * (1.0 + w * u_sat);
  v = u_light > 0.0 ? v + (255.0 - v) * w * u_light : v * (1.0 + w * u_light);
  outColor = vec4(R(v.r), R(v.g), R(v.b), c.a) / 255.0;
}`,
  lumaKey: `${HEAD}
uniform float u_threshold, u_softness, u_invert;
void main() {
  vec4 c = px(P());
  float l = luma(c) / 255.0;
  float m = u_softness > 0.0 ? clamp((u_invert > 0.5 ? u_threshold - l : l - u_threshold) / u_softness, 0.0, 1.0) : (u_invert > 0.5 ? float(l <= u_threshold) : float(l > u_threshold));
  outColor = vec4(c.rgb, R(c.a * m)) / 255.0;
}`,
  // avgblur: box of 2r+1 with repeated edges, one direction per pass.
  box: `${HEAD}
uniform vec2 u_dir;
uniform int u_r;
uniform float u_last;
void main() {
  ivec2 p = ivec2(P());
  vec4 acc = vec4(0.0);
  for (int i = -60; i <= 60; i++) {
    if (abs(i) > u_r) continue;
    acc += at(p + ivec2(u_dir) * i);
  }
  vec4 v = acc / float(2 * u_r + 1);
  outColor = (u_last > 0.5 ? floor(v) : v) / 255.0;
}`,
  taps: `${HEAD}
uniform int u_mode;
uniform vec2 u_a;
uniform vec2 u_c;
void main() {
  vec2 X = P();
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 13; i++) {
    float f = float(i - 6) / 12.0;
    vec2 S;
    if (u_mode == 0) S = X + u_a * f;
    else if (u_mode == 1) {
      float th = u_a.x * f;
      vec2 d = X - u_c;
      S = u_c + vec2(d.x * cos(th) - d.y * sin(th), d.x * sin(th) + d.y * cos(th));
    } else S = u_c + (X - u_c) * (1.0 - u_a.x * float(i) / 12.0);
    acc += px(S);
  }
  outColor = R4(acc / 13.0) / 255.0;
}`,
  wave: remap(
    "uniform float u_amp, u_k, u_phase, u_vertical;",
    "S = u_vertical > 0.5 ? vec2(X.x, X.y + u_amp * sin(X.x * u_k + u_phase)) : vec2(X.x + u_amp * sin(X.y * u_k + u_phase), X.y);",
  ),
  twirl: remap(
    "uniform vec2 u_c; uniform float u_radius, u_angle;",
    `vec2 d = X - u_c;
  float t = 1.0 - clamp(length(d) / (u_radius * min(u_size.x, u_size.y)), 0.0, 1.0);
  float th = u_angle * t * t;
  S = u_c + vec2(d.x * cos(th) - d.y * sin(th), d.x * sin(th) + d.y * cos(th));`,
  ),
  bulge: remap(
    "uniform vec2 u_c; uniform float u_radius, u_e;",
    `vec2 d = X - u_c;
  float rr = u_radius * min(u_size.x, u_size.y);
  float r = length(d);
  float f = (r < rr && r > 0.0) ? rr * pow(r / rr, u_e) / r : 1.0;
  S = u_c + d * f;`,
  ),
  lens: remap(
    "uniform float u_k;",
    `vec2 d = X - u_size / 2.0;
  S = u_size / 2.0 + d * ((1.0 + u_k * dot(d, d) / (0.25 * dot(u_size, u_size))) / (1.0 + u_k));`,
  ),
  kaleidoscope: remap(
    "uniform float u_seg, u_rot;",
    `vec2 d = X - u_size / 2.0;
  float r = length(d);
  float a = mod(atan(d.y, d.x) - u_rot, u_seg);
  a = (a > u_seg / 2.0 ? u_seg - a : a) + u_rot;
  S = u_size / 2.0 + r * vec2(cos(a), sin(a));`,
  ),
  mirror: remap(
    "uniform int u_mode;",
    `vec2 m = (u_size - 1.0) / 2.0;
  S = X;
  if (u_mode == 0 && X.x > m.x) S.x = u_size.x - 1.0 - X.x;
  if (u_mode == 1 && X.x < m.x) S.x = u_size.x - 1.0 - X.x;
  if (u_mode == 2 && X.y > m.y) S.y = u_size.y - 1.0 - X.y;
  if (u_mode == 3 && X.y < m.y) S.y = u_size.y - 1.0 - X.y;`,
  ),
  pixelate: remap("uniform float u_s;", "S = floor(X / u_s) * u_s + (u_s - 1.0) / 2.0;"),
  scanlines: `${HEAD}
uniform float u_spacing, u_dark;
void main() {
  vec2 X = P();
  vec4 c = px(X);
  float f = 1.0 - u_dark * float(mod(X.y, u_spacing) < u_spacing / 2.0);
  outColor = vec4(R(c.r * f), R(c.g * f), R(c.b * f), c.a) / 255.0;
}`,
  grain: `${HEAD}
uniform float u_amount, u_s, u_color;
uniform uint u_frame;
void main() {
  vec2 X = P();
  vec4 c = px(X);
  uint base = uint(floor(X.x / u_s)) * 1103u + uint(floor(X.y / u_s)) * 2903u + u_frame * 3851u;
  vec3 o;
  for (int i = 0; i < 3; i++) {
    uint ci = u_color > 0.5 ? uint(i) : 0u;
    o[i] = R(c[i] + (hash(base + ci * 7919u + 12345u) - 0.5) * u_amount);
  }
  outColor = vec4(o, c.a) / 255.0;
}`,
  glitch: `${HEAD}
uniform float u_amount, u_shift, u_block, u_split;
uniform uint u_frame, u_seed;
void main() {
  vec2 X = P();
  uint s = uint(floor(X.y / u_block)) * 2903u + u_frame * 3851u + u_seed;
  float on = float(hash(s) < u_amount);
  float sh = on * floor((hash(s + 17u) - 0.5) * 2.0 * u_shift + 0.5);
  float sp = on * u_split;
  vec4 m = px(vec2(X.x + sh, X.y));
  outColor = vec4(px(vec2(X.x + sh - sp, X.y)).r, m.g, px(vec2(X.x + sh + sp, X.y)).b, m.a) / 255.0;
}`,
  edges: `${HEAD}
uniform float u_amount, u_invert;
float L(vec2 p) { return luma(px(p)); }
void main() {
  vec2 X = P();
  float gx = L(X + vec2(1, -1)) + 2.0 * L(X + vec2(1, 0)) + L(X + vec2(1, 1)) - L(X + vec2(-1, -1)) - 2.0 * L(X + vec2(-1, 0)) - L(X + vec2(-1, 1));
  float gy = L(X + vec2(-1, 1)) + 2.0 * L(X + vec2(0, 1)) + L(X + vec2(1, 1)) - L(X + vec2(-1, -1)) - 2.0 * L(X + vec2(0, -1)) - L(X + vec2(1, -1));
  float m = clamp(sqrt(gx * gx + gy * gy) * u_amount / 4.0, 0.0, 255.0);
  float v = R(u_invert > 0.5 ? 255.0 - m : m);
  outColor = vec4(v, v, v, px(X).a) / 255.0;
}`,
  // Freeform mask: the image maskPixels rasterises (as kerf_media::mask),
  // moved by whole pixels, and alpha·M/255 truncated like blend=all_mode=multiply.
  polygonMask: `${HEAD}
uniform sampler2D u_mask;
uniform ivec2 u_shift;
uniform int u_outside;
void main() {
  ivec2 p = ivec2(P());
  vec4 c = at(p);
  ivec2 q = p - u_shift;
  ivec2 size = textureSize(u_mask, 0);
  int v = any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, size)) ? u_outside : int(floor(texelFetch(u_mask, q, 0).r * 255.0 + 0.5));
  int alpha = int(floor(c.a + 0.5));
  outColor = vec4(c.rgb, float(alpha * v / 255)) / 255.0;
}`,
  shapeMask: `${HEAD}
uniform vec2 u_c, u_half;
uniform float u_ellipse, u_feather, u_invert;
void main() {
  vec2 X = P();
  vec4 c = px(X);
  vec2 d = X - u_c;
  float dist = u_ellipse > 0.5 ? (1.0 - length(d / u_half)) * min(u_half.x, u_half.y) : min(u_half.x - abs(d.x), u_half.y - abs(d.y));
  float m = u_feather > 0.0 ? clamp(dist / u_feather, 0.0, 1.0) : float(dist > 0.0);
  if (u_invert > 0.5) m = 1.0 - m;
  outColor = vec4(c.rgb, R(c.a * m)) / 255.0;
}`,
  border: `${HEAD}
uniform float u_width;
uniform vec3 u_color;
void main() {
  vec2 X = P();
  vec4 c = px(X);
  bool inside = min(min(X.x, X.y), min(u_size.x - 1.0 - X.x, u_size.y - 1.0 - X.y)) < u_width;
  outColor = inside ? vec4(u_color, 255.0) / 255.0 : c / 255.0;
}`,
  // rgbashift: red from x − d, blue from x + d (edges repeated).
  rgbShift: `${HEAD}
uniform ivec2 u_d;
void main() {
  ivec2 p = ivec2(P());
  vec4 m = at(p);
  outColor = vec4(at(p - u_d).r, m.g, at(p + u_d).b, m.a) / 255.0;
}`,
  flip: `${HEAD}
uniform vec2 u_flip;
void main() {
  vec2 X = P();
  vec2 S = mix(X, u_size - 1.0 - X, u_flip);
  outColor = at(ivec2(S)) / 255.0;
}`,
  // erosion / dilation of the alpha channel over 3×3 (edges repeated).
  morph: `${HEAD}
uniform float u_max;
void main() {
  ivec2 p = ivec2(P());
  vec4 c = at(p);
  float a = c.a;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      float v = at(p + ivec2(x, y)).a;
      a = u_max > 0.5 ? max(a, v) : min(a, v);
    }
  outColor = vec4(c.rgb, a) / 255.0;
}`,
  // Separable Gaussian of the alpha channel only (gblur planes=8).
  alphaBlur: `${HEAD}
uniform vec2 u_dir;
uniform float u_sigma;
void main() {
  vec2 uv = (P() + 0.5) / u_size;
  float s = max(u_sigma, 0.01);
  float reach = ceil(3.0 * s);
  float stepPx = max(1.0, reach / 48.0);
  float acc = 0.0;
  float wsum = 0.0;
  for (int i = -48; i <= 48; i++) {
    float x = float(i) * stepPx;
    if (abs(x) > reach) continue;
    float w = exp(-0.5 * x * x / (s * s));
    acc += texture(u_tex, uv + u_dir * x).a * w;
    wsum += w;
  }
  outColor = vec4(texture(u_tex, uv).rgb, acc / wsum);
}`,
  // Shadow / stroke base: the alpha (moved by u_d, transparent outside), times u_op, in one colour.
  // The stroke's lutrgb reads each pixel itself (u_exact); the shadow's geq samples like geq.
  solid: `${HEAD}
uniform vec3 u_color;
uniform vec2 u_d;
uniform float u_op;
uniform float u_exact;
void main() {
  vec2 S = P() - u_d;
  float a = (S.x >= 0.0 && S.y >= 0.0 && S.x <= u_size.x - 1.0 && S.y <= u_size.y - 1.0) ? (u_exact > 0.5 ? at(ivec2(S)).a : px(S).a) : 0.0;
  outColor = vec4(u_color, R(a * u_op)) / 255.0;
}`,
  // overlay=format=rgb of u_top (straight alpha) over u_tex (straight alpha).
  over: `${HEAD}
uniform sampler2D u_top;
void main() {
  ivec2 p = ivec2(P());
  vec4 d = texelFetch(u_tex, p, 0);
  vec4 s = texelFetch(u_top, p, 0);
  float a = s.a + d.a * (1.0 - s.a);
  float w = s.a > 0.0 ? s.a / (s.a + d.a - s.a * d.a) : 0.0;
  outColor = vec4(mix(d.rgb, s.rgb, w), a);
}`,
  // blend of the input (A) with a processed copy (B) per mode.
  blend2: `${HEAD}
uniform sampler2D u_b;
uniform int u_mode;
uniform float u_k, u_focus, u_width, u_feather;
void main() {
  ivec2 p = ivec2(P());
  vec4 A = texelFetch(u_tex, p, 0) * 255.0;
  vec4 B = texelFetch(u_b, p, 0) * 255.0;
  vec4 o;
  if (u_mode == 0) {
    // glow: add, alpha from A
    o = vec4(clamp(floor(A.rgb + B.rgb * u_k + 0.5), 0.0, 255.0), A.a);
  } else if (u_mode == 1) {
    // soft focus: towards the lighter of the two
    o = vec4(floor(A.rgb + (max(A.rgb, B.rgb) - A.rgb) * u_k + 0.5), A.a);
  } else {
    // tilt-shift: blurred outside the band, all channels
    float m = clamp((abs(P().y / u_size.y - u_focus) - u_width / 2.0) / u_feather, 0.0, 1.0);
    o = floor(A + (B - A) * m + 0.5);
  }
  outColor = o / 255.0;
}`,
};

export const FX_SHADERS = FS;

/** Ids that have a preview implementation (checked against the catalogue in fx.test.ts). */
export const FX_IMPLEMENTED = new Set([
  "brightnessContrast",
  "levels",
  "tone",
  "colorBalance",
  "invert",
  "posterize",
  "solarize",
  "blackWhite",
  "sepia",
  "colorize",
  "hueShift",
  "vibrance",
  "hslSecondary",
  "lumaKey",
  "boxBlur",
  "directionalBlur",
  "radialBlur",
  "zoomBlur",
  "tiltShift",
  "softFocus",
  "glow",
  "chromaticAberration",
  "wave",
  "twirl",
  "bulge",
  "lensDistortion",
  "kaleidoscope",
  "mirror",
  "pixelate",
  "scanlines",
  "filmGrain",
  "glitch",
  "edgeDetect",
  "matte",
  "flip",
  "shapeMask",
  "border",
  "stroke",
  "dropShadow",
]);
