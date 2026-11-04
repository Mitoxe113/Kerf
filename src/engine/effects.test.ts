import { describe, expect, it } from "vitest";
import parity from "../../fixtures/parity/curves.json";
import type { Clip, CurvePoint, Effect, Keyframe } from "../lib/types";
import { activeEffects, bt601Limited, curvesTexture, curveTable, effectAnimatable, effectAt, effectValue, maskOutline, maskPixels, maskShift, parseCube, withEffectValue } from "./effects";

// The fixture holds FFmpeg's tables for the same points, made with
//   ffmpeg -f rawvideo -pix_fmt rgb24 -s 256x1 -i ramp.raw \
//     -vf "curves=r='…':g='…':b='…':interp=pchip" -f rawvideo -pix_fmt rgb24 -
// where ramp.raw is the grey ramp 0..255.

describe("curveTable", () => {
  it("matches FFmpeg's PCHIP curves", () => {
    for (const { points, table } of parity.cases) {
      const lut = curveTable(points as CurvePoint[]);
      table.forEach((v, i) => expect(Math.abs(lut[i] - v), `input ${i}`).toBeLessThanOrEqual(1));
    }
  });

  it("is the identity for fewer than two points or the diagonal", () => {
    for (const c of [[], [[0.5, 0.2]], [[0, 0], [1, 1]]] as CurvePoint[][]) expect([...curveTable(c)]).toEqual([...Array(256).keys()]);
  });

  it("applies the master curve after each channel's curve", () => {
    const tex = curvesTexture({ type: "curves", master: [[0, 1], [1, 0]], red: [[0, 0], [1, 0.5]], green: [], blue: [] });
    // Red: 255 -> 128 -> 127 (inverted); green: 255 -> 0.
    expect([tex[255 * 4], tex[255 * 4 + 1], tex[255 * 4 + 3]]).toEqual([127, 0, 255]);
  });
});

describe("parseCube", () => {
  it("reads size, domain and red-fastest data", () => {
    const cube = parseCube(
      ["# comment", 'TITLE "x"', "LUT_3D_SIZE 2", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 2", "0 0 0", "1 0 0", "0 1 0", "1 1 0", "0 0 1", "1 0 1", "0 1 1", "1 1 1"].join("\r\n"),
    );
    expect(cube.size).toBe(2);
    expect(cube.max).toEqual([1, 1, 2]);
    expect([...cube.data.slice(3, 6)]).toEqual([1, 0, 0]);
  });

  it("rejects 1D LUTs and short data", () => {
    expect(() => parseCube("LUT_1D_SIZE 4\n0 0 0")).toThrow();
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 0")).toThrow();
  });
});

describe("bt601Limited", () => {
  it("gives FFmpeg's limited-range Y'CbCr", () => {
    expect(bt601Limited([0, 0, 0])).toEqual([16, 128, 128]);
    expect(bt601Limited([1, 1, 1])).toEqual([235, 128, 128]);
    expect(bt601Limited([0, 1, 0])).toEqual([145, 54, 34]);
  });
});

describe("animated effect parameters", () => {
  const key = (at: number, value: number): Keyframe => ({ at, value, ease: "linear" });
  const clip = { start: 100, sourceIn: 20, speed: 1, duration: 50, keys: {} } as unknown as Clip;

  it("keeps effects with keys even when their static value does nothing", () => {
    const still: Effect = { id: "a", enabled: true, type: "blur", radius: 0 };
    const animated: Effect = { ...still, id: "b", keys: { radius: [key(20, 0), key(60, 8)] } };
    expect(activeEffects([still, animated]).map((e) => e.id)).toEqual(["b"]);
    expect(activeEffects([{ ...animated, enabled: false }])).toEqual([]);
  });

  it("evaluates keys on the source position, like Clip::effect_at", () => {
    const fx: Effect = { id: "f", enabled: true, type: "fx", fx: "twirl", params: { angle: 0, radius: 0.5 }, keys: { angle: [key(20, 0), key(60, 120)] } };
    // Local frame 10 is source 30: a quarter of the way.
    expect((effectAt(clip, fx, 10) as Extract<Effect, { type: "fx" }>).params).toEqual({ angle: 30, radius: 0.5 });
    const mask: Effect = { id: "m", enabled: true, type: "polygonMask", points: [], feather: 0, invert: false, x: 0.1, y: 0, keys: { y: [key(20, -0.2)] } };
    expect(effectAt(clip, mask, 40)).toMatchObject({ x: 0.1, y: -0.2 });
  });

  it("animates the parameters kerf_core allows, within their ranges", () => {
    expect(effectAnimatable({ type: "blur", radius: 1 }, "radius")).toEqual([0, 250]);
    expect(effectAnimatable({ type: "sharpen", amount: 1, radius: 1 }, "amount")).toBeNull();
    expect(effectAnimatable({ type: "fx", fx: "twirl", params: {} }, "angle")).toEqual([-720, 720]);
    expect(effectAnimatable({ type: "fx", fx: "posterize", params: {} }, "levels")).toBeNull();
    expect(effectValue({ type: "fx", fx: "twirl", params: {} }, "radius")).toBe(0.5);
    expect(withEffectValue({ id: "v", enabled: true, type: "vignette", amount: 0.2 }, "amount", 0.7)).toMatchObject({ amount: 0.7 });
  });
});

describe("freeform mask raster", () => {
  // Same cases as kerf_media::mask::tests.
  const sq: [number, number][] = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.75, 0.75],
    [0.25, 0.75],
  ];

  it("follows the crossing rule and feathers inwards", () => {
    const hard = maskPixels(sq, 0, false, 10, 10);
    const inside = [...hard.keys()].filter((i) => hard[i] === 255);
    expect(inside.length).toBe(25);
    expect(inside.every((i) => i % 10 >= 3 && i % 10 <= 7 && Math.floor(i / 10) >= 3 && Math.floor(i / 10) <= 7)).toBe(true);
    const soft = maskPixels(sq, 2, false, 10, 10);
    expect([soft[25], soft[35], soft[45], soft[55]]).toEqual([0, 64, 191, 255]);
    const inv = maskPixels(sq, 2, true, 10, 10);
    expect(soft.every((v, i) => v + inv[i] === 255)).toBe(true);
  });

  it("decides a crossing next to a pixel exactly", () => {
    // kerf_media's case is moved by (8, −3): pixel (128, 24) there is (120, 27) here.
    const px = maskPixels([[0.1, 0.1], [0.8, 0.2], [0.45, 0.85]], 0, false, 160, 96);
    expect(px[27 * 160 + 120]).toBe(255);
    expect(px[27 * 160 + 121]).toBe(0);
    expect(maskOutline([[0.8, 0.2]], 160, 96)).toEqual([[128 * 256, 4915]]);
  });

  it("moves by whole pixels of the frame", () => {
    expect([maskShift(0.05, 160), maskShift(-0.03, 96), maskShift(0.5, 3)]).toEqual([8, -3, 2]);
  });
});
