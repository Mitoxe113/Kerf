// Writes fixtures/parity/audio.json: FFmpeg's output for the audio effects
// on a test signal, sampled every STEP samples. src/engine/dsp.test.ts runs
// the preview's DSP on the same signal and compares; a Rust test checks that
// the export builds exactly these filter strings.
//
//   node scripts/gen-audio-parity.mjs   (needs ffmpeg on PATH)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SR = 48000;
const N = 24000;
const STEP = 61;

// Same as testSignal() in src/engine/dsp.test.ts.
function testSignal() {
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = t % 0.25 < 0.1 ? 1 : 0.1;
    l[i] = 0.8 * Math.sin(2 * Math.PI * 220 * t) * env + 0.05 * Math.sin(2 * Math.PI * 3000 * t);
    r[i] = 0.5 * Math.sin(2 * Math.PI * 330 * t + 1) * env + 0.03 * Math.sin(2 * Math.PI * 7000 * t);
  }
  return [l, r];
}

const CASES = [
  {
    effect: {
      type: "eq",
      bands: [
        { shape: "highPass", freq: 120, gainDb: 0, q: 0.7, enabled: true },
        { shape: "lowShelf", freq: 200, gainDb: 4, q: 0.7, enabled: true },
        { shape: "peak", freq: 1000, gainDb: -6, q: 2, enabled: true },
        { shape: "highShelf", freq: 6000, gainDb: 3, q: 0.7, enabled: true },
        { shape: "lowPass", freq: 12000, gainDb: 0, q: 0.7, enabled: true },
      ],
    },
    filter:
      "highpass=f=120:p=2:t=q:w=0.7:r=f64,lowshelf=f=200:t=s:w=1:g=4:r=f64,equalizer=f=1000:t=q:w=2:g=-6:r=f64,highshelf=f=6000:t=s:w=1:g=3:r=f64,lowpass=f=12000:p=2:t=q:w=0.7:r=f64",
  },
  {
    effect: { type: "compressor", thresholdDb: -20, ratio: 4, attackMs: 5, releaseMs: 80, kneeDb: 6, makeupDb: 3 },
    filter: "acompressor=threshold=0.1:ratio=4:attack=5:release=80:knee=1.995262315:makeup=1.412537545:detection=rms:link=average",
  },
  {
    effect: { type: "gate", thresholdDb: -30, rangeDb: -40, ratio: 4, attackMs: 2, releaseMs: 60 },
    filter: "agate=threshold=0.031622777:range=0.01:ratio=4:attack=2:release=60:knee=2.828427125:detection=rms:link=average",
  },
  {
    effect: { type: "limiter", ceilingDb: -6, releaseMs: 30 },
    // The export adds latency=1 (FFmpeg removes the look-ahead delay); the preview keeps it.
    filter: "alimiter=limit=0.501187234:attack=5:release=30:asc=0:level=0",
  },
];

const dir = mkdtempSync(join(tmpdir(), "kerf-audio-"));
try {
  const [l, r] = testSignal();
  const inter = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) [inter[2 * i], inter[2 * i + 1]] = [l[i], r[i]];
  const input = join(dir, "in.raw");
  writeFileSync(input, Buffer.from(inter.buffer));
  const out = CASES.map(({ effect, filter }) => {
    const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", input, "-af", filter, "-f", "f32le", "-"], {
      maxBuffer: 1 << 26,
    });
    const s = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    const pick = (ch) => Array.from({ length: Math.floor(N / STEP) }, (_, k) => Number(s[2 * k * STEP + ch].toPrecision(7)));
    return { effect, filter, left: pick(0), right: pick(1) };
  });
  writeFileSync(
    new URL("../fixtures/parity/audio.json", import.meta.url),
    JSON.stringify({ "//": "FFmpeg audio effects on testSignal(), every `step`-th sample; regenerate with scripts/gen-audio-parity.mjs", sampleRate: SR, step: STEP, cases: out }),
  );
  console.log(`wrote ${out.length} cases`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
