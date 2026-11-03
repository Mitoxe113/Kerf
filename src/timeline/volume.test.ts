import { describe, expect, it } from "vitest";
import type { Clip, Keyframe } from "../lib/types";
import { bandY, hasBand, posToVolume, segmentKeys, shiftKeys, shiftVolume, volumeBand, volumeHitAt, volumeToPos } from "./volume";

const key = (at: number, value: number): Keyframe => ({ at, value, ease: "linear" });
const clip = (over: Partial<Clip>) =>
  ({ start: 0, sourceIn: 0, speed: 1, duration: 100, volumeDb: 0, transform: {}, opacity: 1, keys: {}, ...over }) as unknown as Clip;

describe("volume band scale", () => {
  it("puts 0 dB at half height, +12 dB at the top and silence at the bottom", () => {
    expect(volumeToPos(0)).toBeCloseTo(Math.sqrt(1 / Math.pow(10, 12 / 20)), 9);
    expect(volumeToPos(0)).toBeCloseTo(0.501, 3);
    expect(volumeToPos(12)).toBe(1);
    expect(volumeToPos(20)).toBe(1);
    expect(volumeToPos(-96)).toBe(0);
    expect(volumeToPos(-200)).toBe(0);
  });

  it("inverts to 0.1 dB within -96..+12", () => {
    for (const db of [-60, -24.5, -6, -0.1, 0, 3.2, 12]) expect(posToVolume(volumeToPos(db))).toBe(db);
    expect(posToVolume(0)).toBe(-96);
    expect(posToVolume(-1)).toBe(-96);
    expect(posToVolume(2)).toBe(12);
    expect(shiftVolume(0, 0)).toBe(0);
    expect(shiftVolume(0, volumeToPos(-6) - volumeToPos(0))).toBe(-6);
  });
});

describe("volume band geometry", () => {
  it("lies below the label strip like drawClip", () => {
    expect(volumeBand(100, 60)).toEqual({ top: 120, height: 35 });
    expect(volumeBand(100, 28)).toEqual({ top: 104, height: 19 });
    expect(hasBand(60, 30)).toBe(true);
    expect(hasBand(60, 20)).toBe(false);
    expect(hasBand(14, 100)).toBe(false);
  });

  it("finds keys within 5 px and the line within 4 px", () => {
    const band = volumeBand(0, 60);
    const c = clip({ keys: { volume: [key(20, 0), key(60, -12)] } });
    // Key at local 20 = x 40 at zoom 2.
    expect(volumeHitAt(c, 0, 2, band, 43, bandY(band, 0) + 4)).toEqual({ kind: "key", at: 20 });
    // Between the keys the line is interpolated in dB (linear ease): -6 dB at local 40.
    expect(volumeHitAt(c, 0, 2, band, 80, bandY(band, -6) + 3)).toEqual({ kind: "line", local: 40 });
    expect(volumeHitAt(c, 0, 2, band, 80, bandY(band, -6) + 6)).toBeNull();
    // Without keys the line is the static volume.
    const plain = clip({ volumeDb: -6 });
    expect(volumeHitAt(plain, 10, 1, band, 50, bandY(band, -6))).toEqual({ kind: "line", local: 40 });
  });
});

describe("volume band edits", () => {
  it("moves the keys around the dragged segment, or the outer one", () => {
    const c = clip({ keys: { volume: [key(20, 0), key(60, -12), key(90, -3)] } });
    expect(segmentKeys(c, 10)).toEqual([20]);
    expect(segmentKeys(c, 40)).toEqual([20, 60]);
    expect(segmentKeys(c, 75)).toEqual([60, 90]);
    expect(segmentKeys(c, 95)).toEqual([90]);
    expect(segmentKeys(clip({}), 50)).toEqual([]);
  });

  it("orders keys by screen position on reversed clips", () => {
    // Reversed 0..100: source 80 is shown at local 20, source 20 at local 80.
    const c = clip({ reverse: true, keys: { volume: [key(20, 0), key(80, -12)] } });
    expect(segmentKeys(c, 10)).toEqual([80]);
    expect(segmentKeys(c, 50)).toEqual([80, 20]);
    expect(segmentKeys(c, 90)).toEqual([20]);
  });

  it("shifts only the dragged keys on the band's scale", () => {
    const keys = [key(20, 0), key(60, -12)];
    const d = volumeToPos(-6) - volumeToPos(0);
    expect(shiftKeys(keys, [20], d)).toEqual([key(20, -6), key(60, -12)]);
    expect(shiftKeys(keys, [], d)).toEqual(keys);
  });
});
