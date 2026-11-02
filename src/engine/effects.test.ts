import { describe, expect, it } from "vitest";
import parity from "../../fixtures/parity/curves.json";
import type { CurvePoint } from "../lib/types";
import { bt601Limited, curvesTexture, curveTable, parseCube } from "./effects";

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
