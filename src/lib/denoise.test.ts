import { describe, expect, it } from "vitest";
import { DEFAULT_DENOISE, denoiseKey, learnRange } from "./denoise";
import type { Clip, Sequence } from "./types";

const clip = (over: Partial<Clip>) => ({ start: 100, sourceIn: 50, speed: 1, duration: 200, keys: {}, ...over }) as unknown as Clip;
const seq = (inPoint: number | null, outPoint: number | null) => ({ inPoint, outPoint, settings: { fps: { num: 25, den: 1 } } }) as unknown as Sequence;

describe("noise reduction", () => {
  it("learns from the in/out range inside the clip, in media seconds", () => {
    // Timeline 120..170 is source 70..120 frames: 2.8..4.8 s.
    expect(learnRange(seq(120, 170), clip({}))).toEqual([2.8, 4.8]);
    // Cut to the clip: 80..130 covers timeline 100..130 = source 50..80.
    expect(learnRange(seq(80, 130), clip({}))).toEqual([2, 3.2]);
    // At double speed the same timeline range covers twice the media.
    expect(learnRange(seq(120, 170), clip({ speed: 2 }))).toEqual([3.6, 7.6]);
    // Reversed: still the lower and the upper end.
    const [a, b] = learnRange(seq(120, 170), clip({ reverse: true }))!;
    expect(a).toBeLessThan(b);
    expect(b - a).toBeCloseTo(2, 9);
  });

  it("needs a range of at least a quarter second inside the clip", () => {
    expect(learnRange(seq(null, 170), clip({}))).toBeNull();
    expect(learnRange(seq(0, 90), clip({}))).toBeNull();
    expect(learnRange(seq(120, 125), clip({}))).toBeNull();
    expect(learnRange(seq(120, 127), clip({}))).not.toBeNull();
  });

  it("tells settings apart", () => {
    const a = denoiseKey(DEFAULT_DENOISE);
    expect(denoiseKey({ ...DEFAULT_DENOISE, enabled: false })).toBe(a);
    expect(denoiseKey({ ...DEFAULT_DENOISE, track: true })).not.toBe(a);
    expect(denoiseKey({ ...DEFAULT_DENOISE, profile: [1, 2] })).not.toBe(a);
  });
});
