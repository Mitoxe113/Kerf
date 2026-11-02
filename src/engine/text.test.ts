import { describe, expect, it } from "vitest";
import { cueAt, fontOf, NO_SUBTITLES, TITLE_STYLE } from "./text";

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
