import { describe, expect, it } from "vitest";
import { framesBetween, localOf, paramAt, shownFrame, slippedIn, sourceAt, sourceOut, speedAt } from "./keys";
import type { Clip, Keyframe } from "./types";
import { Warp } from "./warp";

const key = (at: number, value: number, e: Keyframe["ease"] = "linear"): Keyframe => ({ at, value, ease: e });
const clip = (over: Partial<Clip>) =>
  ({ start: 0, sourceIn: 0, speed: 1, duration: 50, transform: {}, opacity: 1, volumeDb: 0, keys: {}, ...over }) as unknown as Clip;

describe("warp", () => {
  it("has constant acceleration between keys (same cases as kerf_core::timemap)", () => {
    // 1x -> 3x over 200 source frames: 2 * 200 / (1 + 3) = 100 timeline frames.
    const w = new Warp([key(100, 1), key(300, 3)], 1);
    expect(w.w(300)).toBeCloseTo(100, 9);
    expect(w.s(50)).toBeCloseTo(175, 9);
    expect(w.speed(50)).toBeCloseTo(2, 9);
    expect(w.w(50)).toBeCloseTo(-50, 9);
    expect(w.s(110)).toBeCloseTo(330, 9);
    for (const s of [-20, 100, 133.3, 250, 300, 512]) expect(w.s(w.w(s))).toBeCloseTo(s, 9);
  });

  it("holds the speed of a hold key; no keys is constant", () => {
    const w = new Warp([key(0, 2, "hold"), key(100, 0.5)], 1);
    expect(w.w(100)).toBeCloseTo(50, 9);
    expect(w.w(150)).toBeCloseTo(150, 9);
    const c = new Warp([], 4);
    expect(c.w(40)).toBeCloseTo(10, 12);
    expect(c.s(10)).toBeCloseTo(40, 12);
  });
});

describe("warped clips", () => {
  it("maps a ramp between timeline and source", () => {
    const c = clip({ sourceIn: 100, duration: 100, keys: { speed: [key(100, 1), key(300, 3)] } });
    expect(sourceAt(c, 50)).toBeCloseTo(175, 9);
    expect(localOf(c, 175)).toBeCloseTo(50, 9);
    expect(speedAt(c, 50)).toBeCloseTo(2, 9);
    expect(shownFrame(c, 50)).toBe(175);
    expect(sourceOut(c)).toBe(300);
    expect(framesBetween(c, 300, 400)).toBe(33);
  });

  it("runs reversed clips from their source out down to the source in", () => {
    const c = clip({ sourceIn: 20, duration: 50, reverse: true });
    expect(sourceOut(c)).toBe(70);
    expect(shownFrame(c, 0)).toBe(69);
    expect(shownFrame(c, 49)).toBe(20);
    expect(localOf(c, 70)).toBeCloseTo(0, 9);
    expect(speedAt(c, 10)).toBe(1);
    // Slipping moves the content as on a forward clip.
    expect(slippedIn(c, 5)).toBe(25);
    expect(slippedIn(c, -30)).toBe(0);
  });

  it("interpolates other keys over the clip's local time", () => {
    // Keys at source 100 and 300 sit at local 0 and 100 under the ramp, so local 50 is half way.
    const c = clip({ sourceIn: 100, duration: 100, keys: { speed: [key(100, 1), key(300, 3)], x: [key(100, 0), key(300, 100)] } });
    expect(paramAt(c, "x", 50)).toBeCloseTo(50, 6);
  });
});
