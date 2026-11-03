// Effect thumbnails: the real preview EffectPipeline applied to a built-in
// test picture, rendered once per effect and parameter set and cached as a
// data URL. Nothing here is a canned image; a broken shader shows as a
// missing thumbnail.

import type { EffectKind } from "../lib/types";
import { link, VS } from "./compositor";
import { EffectPipeline } from "./effects";

export const THUMB_W = 128;
export const THUMB_H = 72;
/** Thumbnail pixels per sequence pixel: the picture stands for a 640 px wide frame. */
const SCALE = THUMB_W / 640;

let ctx: { gl: WebGL2RenderingContext; fx: EffectPipeline } | null | undefined;
const cache = new Map<string, string>();

/** Sky, sun, hills, a red and a blue block and a white bar: colour, edges and highlights for every effect to act on. */
function testPicture(): Uint8Array {
  const px = new Uint8Array(THUMB_W * THUMB_H * 4);
  for (let y = 0; y < THUMB_H; y++)
    for (let x = 0; x < THUMB_W; x++) {
      const i = (y * THUMB_W + x) * 4;
      const t = y / THUMB_H;
      let r = 60 + 120 * t,
        g = 120 + 70 * t,
        b = 220 - 60 * t;
      const hill = THUMB_H * 0.62 + Math.sin(x / 14) * 6;
      if (y > hill) [r, g, b] = [46 + (x % 9), 120 - (y - hill), 52];
      const dx = x - THUMB_W * 0.72,
        dy = y - THUMB_H * 0.3;
      if (dx * dx + dy * dy < 110) [r, g, b] = [255, 228, 120];
      if (x > 16 && x < 40 && y > 30 && y < 58) [r, g, b] = [214, 48, 40];
      if (x > 44 && x < 60 && y > 38 && y < 62) [r, g, b] = [36, 70, 200];
      if (y > 64 && y < 67 && x > 70 && x < 118) [r, g, b] = [250, 250, 250];
      px.set([r, g, b, 255], i);
    }
  return px;
}

let picture: Uint8Array | null = null;

function init() {
  if (ctx !== undefined) return ctx;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_W;
    canvas.height = THUMB_H;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return (ctx = null);
    gl.bindVertexArray(gl.createVertexArray());
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // LUT effects read their file through the app; thumbnails skip them.
    const fx = new EffectPipeline(gl, VS, (v, f) => link(gl, v, f), () => Promise.reject(new Error("no files in thumbnails")), () => {});
    ctx = { gl, fx };
  } catch {
    ctx = null;
  }
  return ctx;
}

/** A data URL of the test picture with `effects` applied, or null without WebGL2. */
export function effectThumb(effects: EffectKind[]): string | null {
  const key = JSON.stringify(effects);
  const hit = cache.get(key);
  if (hit) return hit;
  const c = init();
  if (!c) return null;
  const { gl, fx } = c;
  picture ??= testPicture();
  try {
    const t = fx.acquire(THUMB_W, THUMB_H);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, THUMB_W, THUMB_H, gl.RGBA, gl.UNSIGNED_BYTE, picture);
    const out = fx.apply(t, effects, SCALE, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    const px = new Uint8ClampedArray(THUMB_W * THUMB_H * 4);
    gl.readPixels(0, 0, THUMB_W, THUMB_H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    fx.release(out);
    // Transparent parts (keys, masks) over a checkerboard.
    for (let y = 0; y < THUMB_H; y++)
      for (let x = 0; x < THUMB_W; x++) {
        const i = (y * THUMB_W + x) * 4;
        const a = px[i + 3] / 255;
        const bg = ((x >> 3) + (y >> 3)) % 2 ? 90 : 60;
        for (let k = 0; k < 3; k++) px[i + k] = px[i + k] * a + bg * (1 - a);
        px[i + 3] = 255;
      }
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_W;
    canvas.height = THUMB_H;
    canvas.getContext("2d")!.putImageData(new ImageData(px, THUMB_W, THUMB_H), 0, 0);
    const url = canvas.toDataURL("image/png");
    if (cache.size > 400) cache.clear();
    cache.set(key, url);
    return url;
  } catch {
    return null;
  }
}
