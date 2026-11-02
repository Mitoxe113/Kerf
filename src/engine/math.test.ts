import { describe, expect, it } from "vitest";
import parity from "../../fixtures/parity/color.json";
import { colorMatrix, contrastSlope, corners, dbToGain, gainToDb, IDENTITY_TRANSFORM, place, pointInPlacement, quadMatrix } from "./math";

const close = (a: number[], b: number[], eps = 1e-4) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)));

describe("place", () => {
  it("fits the source into the frame", () => {
    const p = place(IDENTITY_TRANSFORM, 1280, 720, 1920, 1080);
    expect([p.width, p.height, p.cx, p.cy]).toEqual([1920, 1080, 960, 540]);
    const tall = place(IDENTITY_TRANSFORM, 1080, 1920, 1920, 1080);
    expect(tall.height).toBe(1080);
    expect(tall.width).toBeCloseTo(607.5);
  });

  it("applies crop before fitting", () => {
    const p = place({ ...IDENTITY_TRANSFORM, cropLeft: 0.25, cropRight: 0.25 }, 1920, 1080, 1920, 1080);
    // 960x1080 crop fills the height.
    expect(p.height).toBe(1080);
    expect(p.width).toBe(960);
  });

  it("rotates and scales about the anchor", () => {
    // Anchor at the image's top-left; it stays pinned at frame centre + offset.
    const t = { ...IDENTITY_TRANSFORM, anchorX: 0, anchorY: 0, rotation: 90, x: 100, y: -50 };
    const p = place(t, 1920, 1080, 1920, 1080);
    close(corners(p)[0], [1060, 490]);
    expect(pointInPlacement(p, 1060 - 10, 490 + 10)).toBe(true);
    expect(pointInPlacement(p, 1060 + 10, 490 + 10)).toBe(false);
  });

  it("maps the unit quad to clip space", () => {
    const p = place({ ...IDENTITY_TRANSFORM, scale: 0.5 }, 1920, 1080, 1920, 1080);
    const m = quadMatrix(p, 1920, 1080);
    const apply = (u: number, v: number) => [m[0] * u + m[3] * v + m[6], m[1] * u + m[4] * v + m[7]];
    close(apply(0, 0), [-0.5, 0.5]);
    close(apply(1, 1), [0.5, -0.5]);
  });
});

describe("colour parity with the export (fixtures/parity/color.json)", () => {
  for (const c of parity) {
    it(JSON.stringify(c.adjust), () => {
      const m = colorMatrix(c.adjust);
      // Column-major here, row-major in the fixture (kerf_core::ColorAdjust::matrix).
      for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) expect(m[col * 3 + r]).toBeCloseTo(c.matrix[r][col], 5);
      expect(contrastSlope(c.adjust)).toBeCloseTo(c.contrastSlope, 6);
    });
  }
});

describe("gain", () => {
  it("converts between dB and linear gain", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(-120)).toBe(0);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(gainToDb(0)).toBe(-Infinity);
  });
});
