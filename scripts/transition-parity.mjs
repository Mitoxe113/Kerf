// Mask transitions and blend modes: compares the preview compositor (WebGL2 in headless
// Chromium) with the export's FFmpeg geq mask, pixel by pixel.
//   node scripts/transition-parity.mjs
// Needs ffmpeg on PATH (or KERF_FFMPEG_DIR), cargo, and Playwright's Chromium.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const W = 160;
const H = 96;
const PS = [0.1, 0.25, 0.5, 0.8];
const ffmpeg = process.env.KERF_FFMPEG_DIR ? path.join(process.env.KERF_FFMPEG_DIR, "ffmpeg") : "ffmpeg";
const masks = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "kerf-media", "--example", "transition_masks"], { cwd: root, encoding: "utf8" }));

function exportMask(cond, p) {
  const expr = cond.replaceAll("PRG", `(${p})`);
  return execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=1,format=gray,geq=lum='255*(${expr})'`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "kerf-tr-"));
const entry = path.join(tmp, "entry.ts");
writeFileSync(
  entry,
  `import { Compositor } from ${JSON.stringify(path.join(root, "src/engine/compositor.ts"))};
import { IDENTITY_COLOR } from ${JSON.stringify(path.join(root, "src/engine/math.ts"))};
const grad = (w, h, vertical) => { const s = document.createElement("canvas"); s.width = w; s.height = h; const x = s.getContext("2d"); const d = x.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) { const v = vertical ? Math.floor((y * 255) / (h - 1)) : Math.floor((i * 255) / (w - 1)); d.data.set([v, v, v, 255], (y * w + i) * 4); }
  x.putImageData(d, 0, 0); return s; };
window.blend = (mode, w, h) => {
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const c = new Compositor(canvas);
  const FULL = new Float32Array([2, 0, 0, 0, -2, 0, -1, 1, 1]);
  const layer = (key, src, blend) => ({ key, source: src, matrix: FULL, crop: [0, 0, 0, 0], opacity: 1, color: IDENTITY_COLOR, blend });
  c.render([layer("a", grad(w, h, false)), layer("b", grad(w, h, true), mode)]);
  const gl = c.gl; const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = [];
  for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) out.push(px[(y * w + x) * 4]);
  return out;
};
window.motion = (kind, p, edge, w, h) => {
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const c = new Compositor(canvas);
  const FULL = new Float32Array([2, 0, 0, 0, -2, 0, -1, 1, 1]);
  const layer = (key, src) => ({ key, source: src, matrix: FULL, crop: [0, 0, 0, 0], opacity: 1, color: IDENTITY_COLOR });
  const vertical = kind.endsWith("Up") || kind.endsWith("Down");
  c.render([{ key: "t", kind, p, edge, a: layer("a", grad(w, h, vertical)), b: layer("b", grad(w, h, !vertical)) }]);
  const gl = c.gl; const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = [];
  for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) out.push(px[(y * w + x) * 4]);
  return out;
};
window.run = (kind, p, w, h) => {
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const c = new Compositor(canvas);
  const solid = (v) => { const s = document.createElement("canvas"); s.width = w; s.height = h; const x = s.getContext("2d"); x.fillStyle = v; x.fillRect(0, 0, w, h); return s; };
  const FULL = new Float32Array([2, 0, 0, 0, -2, 0, -1, 1, 1]);
  const layer = (key, src) => ({ key, source: src, matrix: FULL, crop: [0, 0, 0, 0], opacity: 1, color: IDENTITY_COLOR });
  c.render([{ key: "t", kind, p, edge: 0, a: layer("a", solid("#000")), b: layer("b", solid("#fff")) }]);
  const gl = c.gl; const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = [];
  for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) out.push(px[(y * w + x) * 4]);
  return out;
};`,
);
const esbuild = require(path.join(root, "node_modules/esbuild"));
const bundle = esbuild.buildSync({ entryPoints: [entry], bundle: true, write: false, format: "iife", loader: { ".json": "json" } }).outputFiles[0].text;
const { chromium } = require("playwright");
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");
await page.addScriptTag({ content: bundle });
let failed = false;
for (const [kind, cond] of Object.entries(masks))
  for (const p of PS) {
    const want = exportMask(cond, p);
    const got = await page.evaluate(([k, pp, w, h]) => window.run(k, pp, w, h), [kind, p, W, H]);
    let off = 0;
    for (let i = 0; i < want.length; i++) if (Math.abs(want[i] - got[i]) > 2) off++;
    // Pixels exactly on a mask edge may round either way in float32 vs double.
    const ok = off <= Math.ceil(W * H * 0.002);
    if (!ok) failed = true;
    const shown = want.reduce((s, v) => s + (v > 127 ? 1 : 0), 0) / want.length;
    console.log(`${ok ? "ok  " : "FAIL"} ${kind.padEnd(13)} p=${p}  incoming ${(shown * 100).toFixed(1)} %, ${off} of ${want.length} pixels differ`);
  }
// Push and slide against their definition (TransitionKind::motion, render.rs):
// edge e = floor(size * p); the incoming clip shows up to the wipe's edge, moved
// so that its far side sits on it; a push moves the outgoing clip by e. The
// outgoing clip is a gradient along the motion, the incoming one across it.
for (const dir of ["Left", "Right", "Up", "Down"])
  for (const push of [true, false]) {
    const kind = (push ? "push" : "slide") + dir;
    const vertical = dir === "Up" || dir === "Down";
    for (const p of PS) {
      const size = vertical ? H : W;
      const e = Math.floor(size * p + 1e-4);
      const got = await page.evaluate(([k, pp, edge, w, h]) => window.motion(k, pp, edge, w, h), [kind, p, e / size, W, H]);
      const ga = (x, y) => (vertical ? Math.floor((y * 255) / (H - 1)) : Math.floor((x * 255) / (W - 1)));
      const gb = (x, y) => (vertical ? Math.floor((x * 255) / (W - 1)) : Math.floor((y * 255) / (H - 1)));
      const [inc, out] = { Left: [[W - e, 0], [-e, 0]], Right: [[e - W, 0], [e, 0]], Up: [[0, H - e], [0, -e]], Down: [[0, e - H], [0, e]] }[dir];
      const incoming = (x, y) => ({ Left: x >= W - e, Right: x < e, Up: y >= H - e, Down: y < e })[dir];
      const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
      let max = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          let want;
          if (incoming(x, y)) want = inside(x - inc[0], y - inc[1]) ? gb(x - inc[0], y - inc[1]) : 0;
          else if (push) want = inside(x - out[0], y - out[1]) ? ga(x - out[0], y - out[1]) : 0;
          else want = ga(x, y);
          max = Math.max(max, Math.abs(want - got[y * W + x]));
        }
      const ok = max <= 1;
      if (!ok) failed = true;
      console.log(`${ok ? "ok  " : "FAIL"} ${kind.padEnd(13)} p=${p}  edge ${e} px, max difference ${max}`);
    }
  }
const FF_BLEND = { multiply: "multiply", screen: "screen", overlay: "overlay", add: "addition", lighten: "lighten", darken: "darken", difference: "difference" };
for (const [mode, ff] of Object.entries(FF_BLEND)) {
  const g = (e) => `color=c=black:s=${W}x${H}:d=1,format=gray,geq=lum='floor(${e}*255/${e === "X" ? W - 1 : H - 1})',format=gbrp`;
  const want = execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", g("X"), "-f", "lavfi", "-i", g("Y"), "-filter_complex", `[0][1]blend=all_mode=${ff},format=gray`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
  const got = await page.evaluate(([m, w, h]) => window.blend(m, w, h), [mode, W, H]);
  let max = 0;
  for (let i = 0; i < want.length; i++) max = Math.max(max, Math.abs(want[i] - got[i]));
  const ok = max <= 1;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} blend ${mode.padEnd(11)} max difference ${max}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
