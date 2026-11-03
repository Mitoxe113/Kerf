// Mask transitions: compares the preview compositor (WebGL2 in headless
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
await browser.close();
process.exit(failed ? 1 : 0);
