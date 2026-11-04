import { describe, expect, it } from "vitest";
import { fileKey, scanStep } from "./watch";

const f = (path: string, size = 10, modified = 1) => ({ path, size, modified });

describe("watch folders", () => {
  it("imports a new file once it stopped changing, and only once", () => {
    const project = new Set<string>([fileKey("C:\\W\\alt.mp4")]);
    const inProject = (k: string) => project.has(k);
    let s = scanStep(undefined, [f("C:\\W\\alt.mp4"), f("C:\\W\\offen.mp4")], inProject);
    expect(s.ready).toEqual([]);
    expect(s.state.outside).toEqual(["C:\\W\\offen.mp4"]);
    // A new file is still being copied: it grows between scans.
    s = scanStep(s.state, [f("C:\\W\\alt.mp4"), f("C:\\W\\offen.mp4"), f("C:\\W\\neu.mp4", 100, 5)], inProject);
    expect(s.ready).toEqual([]);
    s = scanStep(s.state, [f("C:\\W\\alt.mp4"), f("C:\\W\\offen.mp4"), f("C:\\W\\neu.mp4", 200, 6)], inProject);
    expect(s.ready).toEqual([]);
    s = scanStep(s.state, [f("C:\\W\\alt.mp4"), f("C:\\W\\offen.mp4"), f("C:\\W\\neu.mp4", 200, 6)], inProject);
    expect(s.ready).toEqual(["C:\\W\\neu.mp4"]);
    // Removed from the project afterwards (or the import undone): not imported again.
    s = scanStep(s.state, [f("C:\\W\\alt.mp4"), f("C:\\W\\offen.mp4"), f("C:\\W\\neu.mp4", 200, 6)], inProject);
    expect(s.ready).toEqual([]);
  });

  it("skips files the project has already and empty files", () => {
    const project = new Set<string>();
    let s = scanStep(undefined, [], (k) => project.has(k));
    s = scanStep(s.state, [f("D:/x/a.MP4"), f("D:/x/leer.wav", 0)], (k) => project.has(k));
    project.add(fileKey("d:\\X\\A.mp4"));
    s = scanStep(s.state, [f("D:/x/a.MP4"), f("D:/x/leer.wav", 0)], (k) => project.has(k));
    expect(s.ready).toEqual([]);
    expect(s.state.known.has(fileKey("D:/x/a.MP4"))).toBe(true);
  });

  it("keeps its state while the folder is missing and lists files outside the project until imported", () => {
    let s = scanStep(undefined, [f("E:/a.mp4"), f("E:/b.mp4")], () => false);
    s = scanStep(s.state, null, () => false);
    expect(s.state.missing).toBe(true);
    expect(s.state.known.size).toBe(2);
    s = scanStep(s.state, [f("E:/a.mp4"), f("E:/b.mp4")], (k) => k === fileKey("E:/a.mp4"));
    expect(s.ready).toEqual([]);
    expect(s.state.outside).toEqual(["E:/b.mp4"]);
    // Missing from the start: the first listing that arrives is the baseline.
    s = scanStep(undefined, null, () => false);
    s = scanStep(s.state, [f("F:/c.mp4")], () => false);
    expect(s.ready).toEqual([]);
    expect(s.state.outside).toEqual(["F:/c.mp4"]);
  });
});
