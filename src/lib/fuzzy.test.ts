import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches substrings, subsequences and every word", () => {
    expect(fuzzyScore("", "Speichern")).toBe(0);
    expect(fuzzyScore("speich", "Speichern unter …")).not.toBeNull();
    expect(fuzzyScore("spun", "Speichern unter …")).not.toBeNull();
    expect(fuzzyScore("unter speich", "Speichern unter …")).not.toBeNull();
    expect(fuzzyScore("xyz", "Speichern")).toBeNull();
    expect(fuzzyScore("speich xyz", "Speichern")).toBeNull();
  });

  it("ranks word starts and substrings above scattered letters", () => {
    const start = fuzzyScore("norm", "Audio normalisieren …")!;
    const middle = fuzzyScore("norm", "Abnormal")!;
    const scattered = fuzzyScore("norm", "Neues Objekt rendern mit")!;
    expect(start).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(scattered);
  });
});
