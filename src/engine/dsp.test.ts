import { describe, expect, it } from "vitest";
import parity from "../../fixtures/parity/audio.json";
import type { AudioEffectKind } from "../lib/types";
import { biquadCoefficients, buildChain, channelMatrix, LIMITER_ATTACK_MS, LoudnessMeter } from "./dsp";

const SR = parity.sampleRate;
const N = 24000;

// Same as testSignal() in scripts/gen-audio-parity.mjs.
function testSignal(): [Float32Array, Float32Array] {
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

/** Runs `effect` in 128-sample blocks, as the AudioWorklet does. */
function run(effect: AudioEffectKind): [Float32Array, Float32Array] {
  const [l, r] = testSignal();
  const chain = buildChain([effect], "stereo", SR);
  for (let i = 0; i < N; i += 128) {
    const [bl, br] = [l.subarray(i, i + 128), r.subarray(i, i + 128)];
    for (const s of chain) s.process(bl, br);
  }
  return [l, r];
}

describe("audio effects", () => {
  // The fixture holds FFmpeg's output (scripts/gen-audio-parity.mjs).
  for (const c of parity.cases) {
    it(`${c.effect.type} matches FFmpeg (${c.filter.split("=")[0]})`, () => {
      const [l, r] = run(c.effect as AudioEffectKind);
      let worst = 0;
      c.left.forEach((v, k) => (worst = Math.max(worst, Math.abs(l[k * parity.step] - v), Math.abs(r[k * parity.step] - c.right[k]))));
      // -100 dBFS: float rounding only.
      expect(worst).toBeLessThan(1e-5);
    });
  }

  it("the limiter holds its ceiling and lags by the look-ahead", () => {
    const [l] = run({ type: "limiter", ceilingDb: -6, releaseMs: 30 });
    expect(Math.max(...l.map(Math.abs))).toBeLessThanOrEqual(0.5011873);
    // In the quiet part (released again) the input passes unchanged, LIMITER_ATTACK_MS later.
    const [src] = testSignal();
    const lag = (SR * LIMITER_ATTACK_MS) / 1000 - 1;
    for (const i of [9600, 9601, 11000]) expect(l[i + lag]).toBe(src[i]);
  });

  it("skips bands that cannot run at the sample rate", () => {
    expect(biquadCoefficients({ shape: "peak", freq: 30000, gainDb: 3, q: 1, enabled: true }, 48000)).toBeNull();
    // 0 dB peak is a pass-through.
    const k = biquadCoefficients({ shape: "peak", freq: 1000, gainDb: 0, q: 1, enabled: true }, 48000)!;
    expect(k[0]).toBeCloseTo(1, 12);
    expect(k[1]).toBeCloseTo(k[3], 12);
  });

  it("maps channels like kerf-core", () => {
    expect(channelMatrix("left")).toEqual([[1, 0], [1, 0]]);
    expect(channelMatrix("mono")).toEqual([[0.5, 0.5], [0.5, 0.5]]);
    const [l, r] = [Float32Array.of(1, 0.5), Float32Array.of(0, -0.5)];
    for (const s of buildChain([], "swap", SR)) s.process(l, r);
    expect([...l, ...r]).toEqual([0, -0.5, 1, 0.5]);
  });
});

describe("LoudnessMeter", () => {
  it("reads a 1 kHz sine at -20 dBFS on both channels as -20 LUFS", () => {
    // BS.1770: a 0 dBFS 1 kHz sine in one channel is -3.01 LUFS; the second channel adds 3 dB.
    const m = new LoudnessMeter(SR);
    const a = Math.pow(10, -20 / 20);
    let last = null;
    for (let i = 0; i < SR * 4; i += 128) {
      const l = Float32Array.from({ length: 128 }, (_, k) => a * Math.sin((2 * Math.PI * 1000 * (i + k)) / SR));
      last = m.push(l, l) ?? last;
    }
    expect(last!.momentary).toBeCloseTo(-20, 1);
    expect(last!.shortTerm).toBeCloseTo(-20, 1);
    expect(last!.integrated).toBeCloseTo(-20, 1);
  });

  it("gates silence out of the integrated value", () => {
    const m = new LoudnessMeter(SR);
    const quiet = new Float32Array(128);
    for (let i = 0; i < SR * 2; i += 128) m.push(quiet, quiet);
    expect(m.integrated()).toBe(-Infinity);
  });
});
