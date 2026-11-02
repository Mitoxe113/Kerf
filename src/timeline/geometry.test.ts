import { describe, expect, it } from "vitest";
import { IDENTITY_COLOR, IDENTITY_TRANSFORM } from "../engine/math";
import { clipAt, fadeGain } from "../engine/playback";
import type { Clip, Sequence, Track } from "../lib/types";
import { clampRoll, clampSlide, clampSlip, clampTrim, editPoints, expandLinks, snap, snapTargets } from "./geometry";

let n = 0;
function clip(start: number, duration: number, sourceIn = 0, extra: Partial<Clip> = {}): Clip {
  return {
    id: `c${++n}`,
    mediaId: "m",
    name: "clip",
    start,
    duration,
    sourceIn,
    speed: 1,
    link: null,
    enabled: true,
    transform: IDENTITY_TRANSFORM,
    opacity: 1,
    volumeDb: 0,
    pan: 0,
    fadeIn: 0,
    fadeOut: 0,
    color: IDENTITY_COLOR,
    label: "none",
    keys: {},
    ...extra,
  };
}

function track(clips: Clip[], kind: "video" | "audio" = "video"): Track {
  return { id: `t${++n}`, kind, name: "T", clips, muted: false, solo: false, locked: false, hidden: false, volumeDb: 0, color: "none", height: 0 };
}

function sequence(tracks: Track[]): Sequence {
  return {
    id: "s",
    name: "S",
    settings: { fps: { num: 25, den: 1 }, width: 1920, height: 1080, sampleRate: 48000 },
    tracks,
    markers: [{ id: "mk", frame: 77, name: "", note: "", color: "signal" }],
    inPoint: 10,
    outPoint: null,
  };
}

describe("clipAt", () => {
  const t = track([clip(0, 10), clip(10, 5), clip(20, 10)]);
  it("finds clips with half-open ranges", () => {
    expect(clipAt(t, 0)?.start).toBe(0);
    expect(clipAt(t, 9)?.start).toBe(0);
    expect(clipAt(t, 10)?.start).toBe(10);
    expect(clipAt(t, 14)?.start).toBe(10);
    expect(clipAt(t, 15)).toBeNull();
    expect(clipAt(t, 29)?.start).toBe(20);
    expect(clipAt(t, 30)).toBeNull();
    expect(clipAt(t, -1)).toBeNull();
  });
});

describe("fadeGain", () => {
  const c = clip(100, 50, 0, { fadeIn: 10, fadeOut: 20 });
  it("ramps in and out linearly", () => {
    expect(fadeGain(c, 100)).toBe(0);
    expect(fadeGain(c, 105)).toBeCloseTo(0.5);
    expect(fadeGain(c, 110)).toBe(1);
    expect(fadeGain(c, 140)).toBeCloseTo(0.5);
    expect(fadeGain(c, 149)).toBeCloseTo(0.05);
  });
  it("is 1 without fades", () => expect(fadeGain(clip(0, 10), 0)).toBe(1));
});

describe("snap", () => {
  it("picks the nearest target within the threshold", () => {
    expect(snap([100], [96, 103, 200], 5)).toEqual({ delta: 3, at: 103 });
    expect(snap([100, 150], [152], 5)).toEqual({ delta: 2, at: 152 });
    expect(snap([100], [110], 5)).toBeNull();
  });
  it("collects edit points, playhead, markers and in/out", () => {
    const a = clip(0, 50);
    const s = sequence([track([a, clip(60, 40)])]);
    expect(editPoints(s)).toEqual([0, 50, 60, 100]);
    expect(editPoints(s, new Set([a.id]))).toEqual([0, 60, 100]);
    expect(snapTargets(s, 33.4)).toEqual(expect.arrayContaining([0, 50, 60, 100, 33, 77, 10]));
  });
});

describe("expandLinks", () => {
  it("adds linked partners across tracks", () => {
    const v = clip(0, 10, 0, { link: "L" });
    const a = clip(0, 10, 0, { link: "L" });
    const other = clip(20, 10);
    const s = sequence([track([v, other]), track([a], "audio")]);
    expect(expandLinks(s, [v.id]).sort()).toEqual([v.id, a.id].sort());
    expect(expandLinks(s, [other.id])).toEqual([other.id]);
  });
});

describe("clampTrim", () => {
  // [20,50) src 10..40 | gap | [70,100) src 0..30, media 100 frames long
  const t = track([clip(20, 30, 10), clip(70, 30, 0)]);
  it("keeps the head inside the source and after the previous clip", () => {
    expect(clampTrim(t, 0, "start", -30, false, 100)).toBe(-10); // only 10 frames of handle
    expect(clampTrim(t, 1, "start", -30, false, 100)).toBe(0); // starts at source frame 0
    expect(clampTrim(t, 1, "start", 50, false, 100)).toBe(29); // at least one frame remains
    expect(clampTrim(track([clip(0, 30, 10)]), 0, "start", -5, false, 100)).toBe(0); // timeline starts at 0
  });
  it("stops the tail at the next clip unless rippling", () => {
    expect(clampTrim(t, 0, "end", 40, false, 100)).toBe(20);
    expect(clampTrim(t, 0, "end", 40, true, 100)).toBe(40);
    expect(clampTrim(t, 0, "end", 99, true, 100)).toBe(60); // source tail is 60 frames
    expect(clampTrim(t, 0, "end", -80, false, 100)).toBe(-29);
  });
  it("lets stills grow freely", () => {
    expect(clampTrim(t, 0, "end", 500, true, null)).toBe(500);
  });
  it("respects speed when converting source handles", () => {
    const fast = track([clip(0, 50, 0, { speed: 2 })]); // uses source 0..100 of 150
    expect(clampTrim(fast, 0, "end", 100, true, 150)).toBe(25);
  });
});

describe("clampRoll", () => {
  const t = track([clip(0, 50, 0), clip(50, 50, 20), clip(120, 10)]);
  it("needs adjacent clips", () => {
    expect(clampRoll(t, 1, 10, 200, 200)).toBe(0);
  });
  it("is bounded by both media handles and minimum length", () => {
    expect(clampRoll(t, 0, -30, 200, 200)).toBe(-20); // right clip can only reveal 20 frames
    expect(clampRoll(t, 0, 80, 60, 200)).toBe(10); // left clip has 10 frames of tail
    expect(clampRoll(t, 0, 80, null, null)).toBe(49);
  });
});

describe("clampSlip", () => {
  it("keeps the source window inside the media", () => {
    const c = clip(0, 50, 20);
    expect(clampSlip(c, -100, 100)).toBe(-20);
    expect(clampSlip(c, 100, 100)).toBe(30);
    expect(clampSlip(c, 5, null)).toBe(0); // stills cannot slip
  });
});

describe("clampSlide", () => {
  it("trades frames between the neighbours", () => {
    const t = track([clip(0, 50, 0), clip(50, 20, 0), clip(70, 30, 10)]);
    expect(clampSlide(t, 1, 100, 100, 100)).toBe(29); // next keeps one frame
    expect(clampSlide(t, 1, 5, 52, 100)).toBe(2); // previous has 2 frames of tail
    expect(clampSlide(t, 1, -30, 100, 100)).toBe(-10); // next can only reveal 10
  });
  it("is bounded by gaps when not adjacent", () => {
    const t = track([clip(0, 10), clip(20, 10), clip(40, 10)]);
    expect(clampSlide(t, 1, -50, 100, 100)).toBe(-10);
    expect(clampSlide(t, 1, 50, 100, 100)).toBe(10);
  });
});
