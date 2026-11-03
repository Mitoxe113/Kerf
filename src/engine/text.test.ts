import { describe, expect, it } from "vitest";
import type { AnimPhase, TextAnimation } from "../lib/types";
import { applyCase, cueAt, fontOf, NO_SUBTITLES, pieceState, TITLE_STYLE } from "./text";

describe("cueAt", () => {
  const subs = { ...NO_SUBTITLES, cues: [10, 30, 50].map((s, i) => ({ id: `c${i}`, start: s, end: s + 10, text: `${i}` })) };
  it("finds the cue shown at a frame (end exclusive)", () => {
    expect([9, 10, 19, 20, 35, 59, 60].map((f) => cueAt(subs, f)?.id ?? null)).toEqual([null, "c0", "c0", null, "c1", "c2", null]);
    expect(cueAt(undefined, 10)).toBeNull();
  });
});

describe("fontOf", () => {
  it("quotes families with spaces and scales the size", () => {
    expect(fontOf({ ...TITLE_STYLE, italic: true }, 0.5)).toBe('italic 700 48.00px "Inter Variable", "Inter Variable", sans-serif');
    expect(fontOf({ ...TITLE_STYLE, font: "Arial", bold: false })).toBe('400 96.00px Arial, "Inter Variable", sans-serif');
  });
});

describe("text animation", () => {
  const anim = (intro: Partial<AnimPhase>, outro: Partial<AnimPhase> = {}): TextAnimation => ({
    unit: "char",
    intro: { kind: "none", frames: 10, stagger: 2, ease: "linear", ...intro },
    outro: { kind: "none", frames: 10, stagger: 2, ease: "linear", ...outro },
  });

  it("fades pieces in one after another", () => {
    const a = anim({ kind: "fade" });
    const t = { frame: 5, duration: 100 };
    expect(pieceState(a, 0, 3, t, 100, 1).alpha).toBeCloseTo(0.5);
    expect(pieceState(a, 1, 3, t, 100, 1).alpha).toBeCloseTo(0.3);
    expect(pieceState(a, 2, 3, { frame: 0, duration: 100 }, 100, 1).alpha).toBe(0);
    expect(pieceState(a, 2, 3, { frame: 50, duration: 100 }, 100, 1).alpha).toBe(1);
  });

  it("slides up from below and ends in place", () => {
    const a = anim({ kind: "slideUp" });
    expect(pieceState(a, 0, 1, { frame: 0, duration: 50 }, 100, 0).dy).toBeCloseTo(50);
    expect(pieceState(a, 0, 1, { frame: 10, duration: 50 }, 100, 0).dy).toBeCloseTo(0);
  });

  it("the outro ends at the clip end, first piece first", () => {
    const a = anim({}, { kind: "fade" });
    // 3 pieces, 10 frames each, stagger 2: piece 0 leaves 76..86, piece 2 leaves 80..90 of 90.
    expect(pieceState(a, 0, 3, { frame: 86, duration: 90 }, 100, 1).alpha).toBe(0);
    expect(pieceState(a, 2, 3, { frame: 85, duration: 90 }, 100, 1).alpha).toBeCloseTo(0.5);
    expect(pieceState(a, 2, 3, { frame: 40, duration: 90 }, 100, 1).alpha).toBe(1);
  });

  it("typewriter shows each piece at its start", () => {
    const a = anim({ kind: "typewriter", stagger: 3 });
    expect(pieceState(a, 2, 4, { frame: 5, duration: 90 }, 100, 1).alpha).toBe(0);
    expect(pieceState(a, 2, 4, { frame: 6, duration: 90 }, 100, 1).alpha).toBe(1);
  });

  it("case conversion", () => {
    expect(applyCase("Straße", "upper")).toBe("STRASSE");
    expect(applyCase("ABC", "lower")).toBe("abc");
  });
});
