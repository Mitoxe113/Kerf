// Preview/export parity of the video effects.
//
// Every effect of a case list runs twice on the same RGBA test picture:
//   preview  the real EffectPipeline (src/engine/effects.ts) in headless
//            Chromium's WebGL2
//   export   the FFmpeg filters the renderer writes (cargo example fx_chain)
// and the two results are compared per channel.
//
// Usage: node scripts/fx-parity.mjs [--only id,id] [--json report.json]
// Needs FFmpeg on PATH (or KERF_FFMPEG_DIR), Playwright with Chromium and cargo.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const reportPath = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const W = 160;
const H = 96;

/** Test picture: gradients, colour patches, fine detail and a soft-edged alpha shape. */
function picture() {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let r = (x * 255) / (W - 1);
      let g = (y * 255) / (H - 1);
      let b = ((x + y) * 3) % 256;
      if (x > 100 && y < 30) [r, g, b] = [20, 200, 40]; // green screen patch
      if (x < 30 && y > 60) [r, g, b] = [220, 30, 160];
      if ((x >> 2) % 2 === (y >> 2) % 2 && x > 60 && x < 90 && y > 40 && y < 70) [r, g, b] = [250, 250, 250];
      const d = Math.hypot((x - 80) / 70, (y - 48) / 42);
      const a = Math.max(0, Math.min(255, Math.round((1.15 - d) * 600)));
      px.set([Math.round(r), Math.round(g), Math.round(b), a], i);
    }
  return px;
}

const fx = (id, params = {}) => ({ type: "fx", fx: id, params });
const CASES = [
  ["brightnessContrast", fx("brightnessContrast", { brightness: 0.1, contrast: 0.35 })],
  ["levels", fx("levels", { inBlack: 0.05, inWhite: 0.9, gamma: 1.4, outBlack: 0.02, outWhite: 0.97 })],
  ["tone", fx("tone", { shadows: 0.6, highlights: -0.4, blacks: -0.3, whites: 0.2 })],
  ["colorBalance", fx("colorBalance", { shadowsR: 0.3, midG: -0.2, highB: 0.4 })],
  ["invert", fx("invert", { amount: 0.75 })],
  ["posterize", fx("posterize", { levels: 5 })],
  ["solarize", fx("solarize", { threshold: 0.42 })],
  ["blackWhite", fx("blackWhite", { amount: 0.8 })],
  ["sepia", fx("sepia", { amount: 1 })],
  ["colorize", fx("colorize", { hue: 200, saturation: 0.7, amount: 0.9 })],
  ["hueShift", fx("hueShift", { angle: 75 })],
  ["vibrance", fx("vibrance", { amount: 0.6 })],
  ["hslSecondary", fx("hslSecondary", { hue: 120, range: 40, softness: 30, shift: 60, saturation: 0.3, lightness: 0.2 })],
  ["lumaKey", fx("lumaKey", { threshold: 0.3, softness: 0.2 })],
  ["boxBlur", fx("boxBlur", { radius: 3 })],
  ["directionalBlur", fx("directionalBlur", { angle: 30, length: 14 })],
  ["radialBlur", fx("radialBlur", { angle: 10, centerX: 0.4, centerY: 0.5 })],
  ["zoomBlur", fx("zoomBlur", { amount: 0.15, centerX: 0.5, centerY: 0.5 })],
  ["tiltShift", fx("tiltShift", { focus: 0.5, width: 0.3, feather: 0.2, radius: 3 })],
  ["softFocus", fx("softFocus", { amount: 0.6, radius: 4 })],
  ["glow", fx("glow", { threshold: 0.6, radius: 4, intensity: 1.2 })],
  ["chromaticAberration", fx("chromaticAberration", { amount: 3 })],
  ["wave", fx("wave", { amplitude: 6, wavelength: 40, phase: 30 })],
  ["twirl", fx("twirl", { angle: 140, radius: 0.6, centerX: 0.5, centerY: 0.5 })],
  ["bulge", fx("bulge", { amount: 0.6, radius: 0.5, centerX: 0.5, centerY: 0.5 })],
  ["lensDistortion", fx("lensDistortion", { amount: 0.5 })],
  ["kaleidoscope", fx("kaleidoscope", { segments: 6, angle: 15 })],
  ["mirror", fx("mirror", { mode: 0 })],
  ["pixelate", fx("pixelate", { size: 8 })],
  ["scanlines", fx("scanlines", { spacing: 4, darkness: 0.5 })],
  ["filmGrain", fx("filmGrain", { amount: 0.3, size: 2, color: 1 })],
  ["glitch", fx("glitch", { amount: 0.5, shift: 20, block: 8, split: 3, seed: 4 })],
  ["edgeDetect", fx("edgeDetect", { amount: 1.5 })],
  ["matte", fx("matte", { choke: 2, feather: 2 })],
  ["flip", fx("flip", { horizontal: 1, vertical: 1 })],
  ["shapeMask", fx("shapeMask", { shape: 1, centerX: 0.5, centerY: 0.5, width: 0.6, height: 0.7, feather: 6 })],
  ["border", fx("border", { width: 5, colorR: 1, colorG: 0.5, colorB: 0 })],
  ["stroke", fx("stroke", { width: 3, colorR: 0, colorG: 0, colorB: 1 })],
  ["dropShadow", fx("dropShadow", { distance: 6, angle: 45, softness: 3, opacity: 0.7 })],
  ["dropShadowHard", fx("dropShadow", { distance: 6, angle: 45, softness: 0, opacity: 0.7 })],
  ["polygonMask", { type: "polygonMask", points: [[0.5, 0.08], [0.93, 0.4], [0.76, 0.92], [0.22, 0.88], [0.06, 0.38]], feather: 6, invert: false, x: 0, y: 0 }],
  ["polygonMaskInvert", { type: "polygonMask", points: [[0.1, 0.1], [0.8, 0.2], [0.45, 0.85]], feather: 0, invert: true, x: 0.05, y: -0.03 }],
  // Reference: the existing Gaussian blur (gblur vs. the separable shader).
  ["blur (existing)", { type: "blur", radius: 3 }],
].filter(([id]) => !only || only.includes(id));

const tmp = mkdtempSync(path.join(tmpdir(), "kerf-fx-"));
const input = picture();
writeFileSync(path.join(tmp, "in.raw"), input);

// --- export side ---------------------------------------------------------------------
const chains = execFileSync("cargo", ["run", "-q", "-p", "kerf-media", "--example", "fx_chain", "--", String(W), String(H), tmp], { cwd: root, input: JSON.stringify(CASES.map((c) => c[1])) })
  .toString()
  .trim()
  .split("\n");
const ffmpeg = process.env.KERF_FFMPEG_DIR ? path.join(process.env.KERF_FFMPEG_DIR, "ffmpeg") : "ffmpeg";
const exported = CASES.map(([id], i) => {
  const out = path.join(tmp, `${id}.raw`);
  try {
    execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-i", path.join(tmp, "in.raw"), "-filter_complex", `[0:v]format=rgba,${chains[i]},format=rgba[o]`, "-map", "[o]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", out], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    console.error(`${id}: FFmpeg failed: ${e.stderr}`);
    return null;
  }
  return new Uint8Array(readFileSync(out));
});

// --- preview side --------------------------------------------------------------------
const esbuild = require(path.join(root, "node_modules/esbuild"));
const entry = path.join(tmp, "entry.ts");
writeFileSync(
  entry,
  `import { EffectPipeline } from ${JSON.stringify(path.join(root, "src/engine/effects.ts"))};
const VS = \`#version 300 es
layout(location = 0) in vec2 a_uv;
uniform mat3 u_matrix;
uniform vec4 u_crop;
out vec2 v_uv;
void main() {
  vec3 p = u_matrix * vec3(a_uv, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = vec2(mix(u_crop.x, 1.0 - u_crop.z, a_uv.x), mix(u_crop.y, 1.0 - u_crop.w, a_uv.y));
}\`;
function link(gl, vs, fs) {
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
window.runEffect = (w, h, data, effect) => {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const fx = new EffectPipeline(gl, VS, (v, f) => link(gl, v, f), async () => "", () => {});
  const t = fx.acquire(w, h);
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data));
  const out = fx.apply(t, [effect], 1, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return Array.from(px);
};`,
);
const bundle = esbuild.buildSync({ entryPoints: [entry], bundle: true, write: false, format: "iife", loader: { ".json": "json" } }).outputFiles[0].text;
const { chromium } = require("playwright");
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");
await page.addScriptTag({ content: bundle });
const previewed = [];
for (const [, effect] of CASES) previewed.push(new Uint8Array(await page.evaluate(([w, h, d, e]) => window.runEffect(w, h, d, e), [W, H, Array.from(input), effect])));
await browser.close();

// --- compare -------------------------------------------------------------------------
const rows = CASES.map(([id], i) => {
  const a = previewed[i];
  const b = exported[i];
  if (!b) return { id, max: NaN, mean: NaN, over2: NaN };
  let max = 0;
  let sum = 0;
  let over2 = 0;
  for (let k = 0; k < a.length; k++) {
    // Colour is meaningless where both are fully transparent.
    if (k % 4 !== 3 && a[k - (k % 4) + 3] === 0 && b[k - (k % 4) + 3] === 0) continue;
    const d = Math.abs(a[k] - b[k]);
    max = Math.max(max, d);
    sum += d;
    if (d > 2) over2++;
    if (process.env.FX_DEBUG && d > 4) {
      const pi = Math.floor(k / 4);
      console.log(id, "x", pi % W, "y", Math.floor(pi / W), "ch", k % 4, "preview", Array.from(a.slice(pi * 4, pi * 4 + 4)), "export", Array.from(b.slice(pi * 4, pi * 4 + 4)), "input", Array.from(input.slice(pi * 4, pi * 4 + 4)));
    }
  }
  return { id, max, mean: +(sum / a.length).toFixed(3), over2: +((100 * over2) / a.length).toFixed(2) };
});
for (const r of rows) console.log(`${r.id.padEnd(22)} max ${String(r.max).padStart(3)}  mean ${r.mean.toFixed(3)}  >2: ${r.over2.toFixed(2)} %`);
if (reportPath) writeFileSync(reportPath, JSON.stringify(rows, null, 2) + "\n");
