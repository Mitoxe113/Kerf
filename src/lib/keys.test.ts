import { describe, expect, it } from "vitest";
import { animate, bezier, ease, evalKeys, paramAt, upsertKey } from "./keys";
import type { Clip, Keyframe } from "./types";

const key = (at: number, value: number, e: Keyframe["ease"] = "linear"): Keyframe => ({ at, value, ease: e });

describe("keyframes", () => {
  it("matches the engine's easing polynomials", () => {
    expect(ease("easeIn", 0.25)).toBeCloseTo(1 / 16);
    expect(ease("easeOut", 0.5)).toBeCloseTo(0.75);
    expect(ease("easeInOut", 0.5)).toBeCloseTo(0.5);
    expect(ease("hold", 0.9)).toBe(0);
  });

  it("is constant outside the keys and interpolates inside", () => {
    const k = [key(20, 10, "easeIn"), key(60, 100)];
    expect(evalKeys(k, 0)).toBe(10);
    expect(evalKeys(k, 90)).toBe(100);
    // Same case as the Rust test: a quarter of the way with ease-in.
    expect(evalKeys(k, 30)).toBeCloseTo(10 + 90 / 16);
  });

  it("evaluates on the source position (speed and trims)", () => {
    const c = { start: 100, sourceIn: 20, speed: 2, duration: 50, transform: { x: 5 }, opacity: 1, volumeDb: 0, keys: { x: [key(20, 0), key(60, 40)] } } as unknown as Clip;
    // Local frame 10 at 2x speed is source 40: halfway.
    expect(paramAt(c, "x", 10)).toBeCloseTo(20);
    expect(animate(c, 110).transform.x).toBeCloseTo(20);
    expect(paramAt(c, "y", 10)).toBeUndefined();
  });

  it("evaluates custom curves like the engine", () => {
    // Same reference points as kerf_core::model::tests (sampled from WebView2).
    expect(bezier(0.25, 0.1, 0.25, 1, 0.25)).toBeCloseTo(0.408511, 5);
    expect(bezier(0.25, 0.1, 0.25, 1, 0.5)).toBeCloseTo(0.802403, 5);
    expect(bezier(0.25, 0.1, 0.25, 1, 0.75)).toBeCloseTo(0.960459, 5);
    expect(bezier(0.42, 0, 0.58, 1, 0.37)).toBeCloseTo(0.285158, 5);
    expect(bezier(0.3, 0.3, 0.7, 0.7, 0.37)).toBeCloseTo(0.37, 6);
    expect(ease({ bezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } }, 0.6)).toBeGreaterThan(1);
  });

  it("animates colour", () => {
    const color = { exposure: 0, contrast: 0, saturation: 1, temperature: 0, tint: 0 };
    const c = { start: 0, sourceIn: 0, speed: 1, duration: 50, transform: {}, opacity: 1, volumeDb: 0, color, keys: { saturation: [key(0, 0), key(40, 2)] } } as unknown as Clip;
    expect(animate(c, 10).color.saturation).toBeCloseTo(0.5);
    expect(animate(c, 10).color.exposure).toBe(0);
  });

  it("keeps keys sorted and unique", () => {
    const k = upsertKey(upsertKey([key(10, 1)], 5, 2), 10, 3, "hold");
    expect(k).toEqual([key(5, 2), key(10, 3, "hold")]);
  });
});
